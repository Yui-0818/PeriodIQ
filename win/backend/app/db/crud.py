"""CRUD 操作层（routes 唯一 DB 出口）。

所有 DB 操作通过本模块，routes 不得直接写 SQL（架构原则）。
全部使用参数化查询（? 占位符），防 SQL 注入（致命 Bug 禁令）。

v0.11.0 用户隔离（早期设计文档）：
- 所有业务数据函数首个参数为 user_id，SQL 一律按 user_id 过滤；
- model_params / app_settings 由「单行表」改为「每用户一行」，UPSERT 维护；
- 新增 users / sessions / profile 读写。

字段名/类型按DDL（v0.11.0 修订版），日期统一 ISO 8601 YYYY-MM-DD 字符串存储。
"""

import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from app import config
from app.db.database import WriteLock, insert_row, write_query, read_one, read_query

logger = logging.getLogger(__name__)

# v0.12.0 修 E7：可选事务参数约定——所有参与「删除/修正/导入重算」链的读写函数
# 均接受 db=None 可选参数：传外层 WriteLock 连接时在同一事务内执行（读写都看
# 未提交的中间态，保证原子性）；None 时自开连接独立执行（历史行为不变）。
# v0.14.0 修 DN-2（审计 M7）：多语句写链路（会话治理 / 删号）在 db=None 时改为
# **自开 WriteLock 单事务**，不再逐表 write_query（各语句独立事务），杜绝半删状态；
# 注意 WriteLock 不可重入——调用方已持锁时必须传 db=，否则 RuntimeError 快速失败。


def _sanitize_cycle_length(cycle_length: int | None) -> int | None:
    """校验 cycle_length 是否在 DDL 合法范围 [MIN_CYCLE_DAYS, MAX_CYCLE_DAYS] 内。

    DDL 约束 chk_length: cycle_length IS NULL OR (cycle_length >= 7 AND <= 90)。
    异常周期（algo 标记 is_anomalous=True）的 cycle_length 可能超出范围（如间隔>90天），
    直接写入会触发 CHECK 约束导致 500 错误（M4 Bug1）。

    处理策略：超范围时返回 NULL，由 is_anomalous=1 标记异常状态。
    """
    if cycle_length is None:
        return None
    if cycle_length < config.MIN_CYCLE_DAYS or cycle_length > config.MAX_CYCLE_DAYS:
        return None
    return cycle_length


# ============================================================
# users / sessions / profile（v0.11.0）
# ============================================================

async def count_users() -> int:
    """用户总数（注册/迁移判定用）。"""
    row = await read_one("SELECT COUNT(*) AS cnt FROM users")
    return row["cnt"] if row else 0


async def create_user(username: str, password_hash: str, nickname: str | None = None) -> int:
    """新增用户，返回新 id（用户名唯一由 UNIQUE 约束保证，冲突抛 IntegrityError）。"""
    return await insert_row(
        "INSERT INTO users (username, password_hash, nickname) VALUES (?, ?, ?)",
        (username, password_hash, nickname),
    )


async def get_user_by_username(username: str) -> dict | None:
    row = await read_one("SELECT * FROM users WHERE username = ?", (username,))
    return dict(row) if row else None


async def get_user_by_id(user_id: int) -> dict | None:
    row = await read_one("SELECT * FROM users WHERE id = ?", (user_id,))
    return dict(row) if row else None


async def update_profile(
    user_id: int,
    nickname: str | None = None,
    avatar: str | None = None,
    birthday: str | None = None,
    weight_kg: float | None = None,
    clear_birthday: bool = False,
    clear_weight: bool = False,
) -> int:
    """更新用户资料（仅更新传入字段；clear_* 用于显式清空可空字段）。"""
    fields: list[str] = []
    params: list[Any] = []
    if nickname is not None:
        fields.append("nickname = ?")
        params.append(nickname)
    if avatar is not None:
        fields.append("avatar = ?")
        params.append(avatar)
    if birthday is not None:
        fields.append("birthday = ?")
        params.append(birthday)
    elif clear_birthday:
        fields.append("birthday = NULL")
    if weight_kg is not None:
        fields.append("weight_kg = ?")
        params.append(weight_kg)
    elif clear_weight:
        fields.append("weight_kg = NULL")
    if not fields:
        return 0
    params.append(user_id)
    return await write_query(
        f"UPDATE users SET {', '.join(fields)} WHERE id = ?", tuple(params)
    )


async def create_session(
    token: str, user_id: int, ttl_days: int | None = None,
    persistent: bool = False,
) -> None:
    """创建会话（v0.13.1 修 G4：写入 SESSION_TTL_DAYS 有效期）。

    2026-10-26 登录持久化（v0.23.0 两端对齐 Android）：persistent=true ⇒
    expires_at 写 NULL（永不登出，「保持登录」新语义，替代旧 365 天口径；
    get_session_user 已把 NULL 视为不过期）；ttl_days 既有语义不动
    （persistent=false 时生效，None → SESSION_TTL_DAYS）。登出语义不变。

    expires_at 口径：UTC「YYYY-MM-DD HH:MM:SS」（strftime），与 SQLite
    datetime('now') 同源可字符串比较（G17 时间口径登记）。
    """
    if persistent:
        expires = None
    else:
        days = config.SESSION_TTL_DAYS if ttl_days is None else ttl_days
        expires = (
            datetime.now(timezone.utc) + timedelta(days=days)
        ).strftime("%Y-%m-%d %H:%M:%S")
    await insert_row(
        "INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)",
        (token, user_id, expires),
    )


async def upgrade_session_persistent(token: str) -> int:
    """升级当前会话为永不登出（expires_at=NULL）——「保持登录」开启时用。"""
    return await write_query(
        "UPDATE sessions SET expires_at = NULL WHERE token = ?", (token,)
    )


async def downgrade_session_ttl(token: str, ttl_days: int | None = None) -> int:
    """降级当前会话为有限期（此刻 + ttl_days，缺省 SESSION_TTL_DAYS）——
    「保持登录」关闭时用；与 create_session 同一 expires_at 口径。"""
    days = config.SESSION_TTL_DAYS if ttl_days is None else ttl_days
    expires = (
        datetime.now(timezone.utc) + timedelta(days=days)
    ).strftime("%Y-%m-%d %H:%M:%S")
    return await write_query(
        "UPDATE sessions SET expires_at = ? WHERE token = ?", (expires, token)
    )


async def get_session_user(token: str) -> dict | None:
    """按令牌取会话用户（JOIN users；令牌不存在/已登出/**已过期** → None）。

    v0.13.1 修 G4：会话 TTL——expires_at <= 当前 UTC 时间的会话视为过期（401）。
    expires_at 为 NULL 的行按不过期处理（fail-open：v3 迁移已为存量行回填，
    NULL 仅可能来自手工改库，不应因此锁死用户）。
    """
    row = await read_one(
        "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id "
        "WHERE s.token = ? AND (s.expires_at IS NULL OR s.expires_at > datetime('now'))",
        (token,),
    )
    return dict(row) if row else None


async def delete_session(token: str) -> int:
    """登出：删除会话，返回受影响行数。"""
    return await write_query("DELETE FROM sessions WHERE token = ?", (token,))


# v0.14.0 修 DN-2：会话治理两条 DELETE 的单一来源（顺序不可交换：先清过期，
# 再保留最新 N 个）。提为模块常量同时作为测试故障注入点（DN-4：替换第二条以
# 验证「第一条已执行的删除随整体事务回滚」）。
_PRUNE_EXPIRED_SQL = (
    "DELETE FROM sessions WHERE user_id = ? AND expires_at <= datetime('now')"
)
_PRUNE_KEEP_NEWEST_SQL = (
    "DELETE FROM sessions WHERE user_id = ? AND token NOT IN ("
    "SELECT token FROM sessions WHERE user_id = ? "
    "ORDER BY created_at DESC, rowid DESC LIMIT ?)"
)


async def prune_user_sessions(user_id: int, max_sessions: int | None = None, db=None) -> None:
    """会话治理（v0.13.1 修 G4）：清过期会话 + 每用户只保留最新 N 个。

    登录成功后调用：刚创建的会话 created_at 最新，必在保留集内。
    保留集按 created_at DESC, rowid DESC 取前 N（rowid 兜底同秒创建的稳定排序）。

    v0.14.0 修 DN-2（审计 M7）：两条 DELETE 由「两次各自开事务、各自加锁的
    write_query」改为**单一事务**——同一连接内先清过期、再保留最新 N 个，任一步
    失败整体回滚，不留「过期已清而超额未清」的中间态。幂等：重复调用结果不变
    （保留集稳定，第二次进来第一条已无过期行、第二条无超额行可删）。

    db 参数见文件头 E7 约定：db=None 时本函数自开 ``WriteLock`` 单事务；调用方
    若已持有写锁必须传 db=（WriteLock 不可重入，否则 RuntimeError 快速失败）。
    """
    if max_sessions is None:
        max_sessions = config.SESSION_MAX_PER_USER
    if db is not None:
        await _prune_user_sessions_on(db, user_id, max_sessions)
        return
    # v0.14.0 修 DN-2：db=None 时自开单事务（routes/auth.py 登录路径未持锁，不嵌套）
    async with WriteLock() as own:
        await _prune_user_sessions_on(own, user_id, max_sessions)


async def _prune_user_sessions_on(db, user_id: int, max_sessions: int) -> None:
    """在既有连接/事务上执行会话治理的两条 DELETE（v0.14.0 修 DN-2 抽出）。

    顺序不可交换：先清过期（过期会话不占保留名额），再按 created_at DESC,
    rowid DESC 保留最新 max_sessions 个。同一事务内第二条 DELETE 能看到第一条的
    未提交删除结果，故两步语义与旧实现一致，但整体具备原子性。
    不 commit/rollback：事务收尾由持有该连接的 WriteLock 统一负责。
    """
    await db.execute(_PRUNE_EXPIRED_SQL, (user_id,))
    await db.execute(_PRUNE_KEEP_NEWEST_SQL, (user_id, user_id, max_sessions))


async def update_user_password(user_id: int, password_hash: str) -> int:
    """更新口令哈希（v0.13.1 修 G5 改密端点用）。"""
    return await write_query(
        "UPDATE users SET password_hash = ? WHERE id = ?", (password_hash, user_id)
    )


async def delete_all_sessions(user_id: int) -> int:
    """删除该用户全部会话（#10：改密后立即登出，含当前会话）。单语句自成事务。"""
    return await write_query("DELETE FROM sessions WHERE user_id = ?", (user_id,))


async def delete_other_sessions(user_id: int, keep_token: str) -> int:
    """删除该用户除 keep_token 外的全部会话（v0.13.1 修 G5：改密后其他设备强制下线）。

    v0.14.0 修 DN-2：单条 DELETE 保持现状（单语句自成事务，无需外层包裹）。
    注意**不清理过期会话**——「清过期 + 每用户保留最新 N 个」是
    prune_user_sessions 的职责（登出/改密路径不做也不应顺带做会话治理）。
    """
    return await write_query(
        "DELETE FROM sessions WHERE user_id = ? AND token != ?", (user_id, keep_token)
    )


# v0.14.0 修 DN-2：删号 6 条 DELETE 的单一来源（子表先删、users 行最后删）。
# 提为模块常量，同时作为测试故障注入点（DN-4：替换第 4 条 SQL 以验证单事务整体回滚）。
# 2026-10-26：daily_records 加入显式删除（新表恒带 FK，CASCADE 本可兜底，显式为主与全表口径一致）。
_DELETE_USER_ACCOUNT_SQLS: tuple[str, ...] = (
    "DELETE FROM cycles WHERE user_id = ?",
    "DELETE FROM predictions WHERE user_id = ?",
    "DELETE FROM daily_records WHERE user_id = ?",
    "DELETE FROM daily_journal WHERE user_id = ?",
    "DELETE FROM model_params WHERE user_id = ?",
    "DELETE FROM app_settings WHERE user_id = ?",
    "DELETE FROM sessions WHERE user_id = ?",
    "DELETE FROM users WHERE id = ?",
)


async def delete_user_account(user_id: int, db=None) -> None:
    """彻底删除用户及其全部数据（v0.13.1 修 G5 删号端点用）。

    子表先删、users 行最后删；FK ON DELETE CASCADE（v3 迁移起）为二道防线，
    显式删除为主（不带 FK 的旧库同样正确）。

    v0.14.0 修 DN-2（审计 M7）：**db=None 时自开单事务**（``async with WriteLock()``）
    把 6 条 DELETE 收进同一事务，任一步失败整体回滚——旧实现在 db=None 时逐表调用
    write_query（每条各自事务、各自加锁），中途失败会留下半删的不可恢复状态。
    **传入外层连接时并入外层事务**（routes/auth.py 删号端点已在 ``WriteLock`` 内调用
    并传 db=）。两条路径都不会 WriteLock 嵌套：db 非 None 分支不再取锁，db=None
    分支由本函数独占取锁；反过来，调用方持锁时必须传 db=（否则 RuntimeError）。
    """
    if db is not None:
        await _delete_user_account_on(db, user_id)
        return
    async with WriteLock() as own:  # v0.14.0 修 DN-2：裸路径必须原子
        await _delete_user_account_on(own, user_id)


async def _delete_user_account_on(db, user_id: int) -> None:
    """在既有连接/事务上按 _DELETE_USER_ACCOUNT_SQLS 顺序删除该用户全部行。

    v0.14.0 修 DN-2：本函数不 commit/rollback（事务收尾交由 WriteLock 统一负责），
    使「传入外层连接」与「自开连接」两条路径共用同一份删除逻辑与顺序。
    """
    for sql in _DELETE_USER_ACCOUNT_SQLS:
        await db.execute(sql, (user_id,))


async def ensure_user_defaults(user_id: int, db=None) -> None:
    """确保新用户的 model_params / app_settings 默认行存在（注册/迁移后调用）。

    幂等：INSERT OR IGNORE。默认值与新装用户语义一致（先验 28±7、权重 0.5）。

    P3 修复（两条 INSERT 非原子）：唯一调用点 routes/auth.py 注册链不在任何
    WriteLock 事务内（不传 db），旧实现两条 write_query 各自成事务——第一条
    成功后第二条失败会留下「有 model_params 无 app_settings」的半初始化用户。
    现两条 INSERT 收进**单事务**：db=None 时自开 WriteLock（注册路径未持锁，
    不触发不可重入防护）；传入外层连接时并入外层事务（文件头 E7 约定）。
    """
    sqls = (
        "INSERT OR IGNORE INTO model_params (user_id) VALUES (?)",
        "INSERT OR IGNORE INTO app_settings (user_id) VALUES (?)",
    )
    if db is not None:
        for sql in sqls:
            await db.execute(sql, (user_id,))
        return
    async with WriteLock() as own:
        for sql in sqls:
            await own.execute(sql, (user_id,))


# ============================================================
# cycles 表 CRUD（按用户隔离）
# ============================================================

async def get_all_cycles(user_id: int) -> list[dict]:
    """获取该用户所有月经记录（日期倒序）。"""
    rows = await read_query(
        "SELECT * FROM cycles WHERE user_id = ? ORDER BY period_start DESC, id DESC",
        (user_id,),
    )
    return [dict(r) for r in rows]


async def get_cycle_by_id(user_id: int, cycle_id: int, db=None) -> dict | None:
    """按 id 获取单条记录（跨用户访问返回 None，由路由转 404）。

    db 参数见文件头 E7 约定（v0.13.1 修 G2：PUT 校验链锁内读取用）。
    """
    sql = "SELECT * FROM cycles WHERE id = ? AND user_id = ?"
    if db is not None:
        async with db.execute(sql, (cycle_id, user_id)) as cur:
            row = await cur.fetchone()
    else:
        row = await read_one(sql, (cycle_id, user_id))
    return dict(row) if row else None


async def get_latest_cycle(user_id: int, db=None) -> dict | None:
    """获取该用户最近一条记录（period_start 最大）。db 参数见文件头 E7 约定。"""
    sql = (
        "SELECT * FROM cycles WHERE user_id = ? "
        "ORDER BY period_start DESC, id DESC LIMIT 1"
    )
    if db is not None:
        async with db.execute(sql, (user_id,)) as cur:
            row = await cur.fetchone()
    else:
        row = await read_one(sql, (user_id,))
    return dict(row) if row else None


async def get_previous_cycle_before(user_id: int, period_start: str) -> dict | None:
    """获取 period_start 早于指定日期的最近一条记录（用于算 cycle_length）。"""
    row = await read_one(
        "SELECT * FROM cycles WHERE user_id = ? AND period_start < ? "
        "ORDER BY period_start DESC LIMIT 1",
        (user_id, period_start),
    )
    return dict(row) if row else None


async def get_all_cycles_asc(user_id: int, db=None) -> list[dict]:
    """获取该用户所有月经记录（period_start ASC, id ASC；全量重算、/export 与
    /export/preview 导出共用）。

    db 参数见文件头 E7 约定（v0.13.1 修 G2：PUT 邻接重叠校验锁内读取用）。
    """
    sql = "SELECT * FROM cycles WHERE user_id = ? ORDER BY period_start ASC, id ASC"
    if db is not None:
        async with db.execute(sql, (user_id,)) as cur:
            rows = await cur.fetchall()
    else:
        rows = await read_query(sql, (user_id,))
    return [dict(r) for r in rows]


async def create_cycle(
    user_id: int,
    period_start: str,
    period_end: str | None = None,
    cycle_length: int | None = None,
    period_days: int | None = None,
    note: str = "",
    is_anomalous: bool = False,
    created_at: str | None = None,
    db=None,
) -> int:
    """新增月经记录，返回新 id。db 参数见文件头 E7 约定。

    created_at（2026-10-31 修 #35）：导入还原备份时间戳用。None ⇒ 走 SQL 默认
    CURRENT_TIMESTAMP（手动录入/补录路径零改动，语义与修复前完全一致）；
    非 None ⇒ 按传入字符串落库（调用方 settings.py 已按 _validate_created_at 校验过
    长度与控制字符）。用 COALESCE(?, CURRENT_TIMESTAMP) 而非在 Python 侧取时刻，
    保证 None 分支与 DDL DEFAULT 的 UTC 口径同源（config.py G17）。
    调用点一律关键字传参（本次新增参数不得靠位置）。
    """
    # Bug1 修复：异常周期 cycle_length 超范围时存 NULL，避免触发 chk_length 约束
    cycle_length = _sanitize_cycle_length(cycle_length)
    sql = (
        "INSERT INTO cycles "
        "(user_id, period_start, period_end, cycle_length, period_days, note, "
        "is_anomalous, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))"
    )
    params = (
        user_id, period_start, period_end, cycle_length, period_days,
        note, 1 if is_anomalous else 0, created_at,
    )
    if db is not None:
        cursor = await db.execute(sql, params)
        row_id = cursor.lastrowid
        await cursor.close()
        return row_id if row_id is not None else 0
    return await insert_row(sql, params)


async def update_cycle(
    user_id: int,
    cycle_id: int,
    period_start: str | None = None,
    period_end: str | None = None,
    cycle_length: int | None = None,
    period_days: int | None = None,
    note: str | None = None,
    is_anomalous: bool | None = None,
    clear_period_end: bool = False,
    db=None,
) -> int:
    """更新月经记录（仅更新非 None 字段），返回受影响行数。db 参数见文件头 E7 约定。

    注意：cycle_length 为 None 表示「不更新该字段」（调用方未传入）；
    若调用方传入异常值（超 7-90 范围），会通过 _sanitize_cycle_length 转为 NULL 写入，
    由 is_anomalous=1 标记异常状态（M4 Bug1 修复）。
    v0.11.5 修 B1：clear_period_end=True 时 period_end 与 period_days 显式置 NULL
    （None 只能表达「不更新」，无法表达「清空」——与 ProfileUpdate 的 clear_* 同模式）。
    """
    # Bug1 修复：区分「不更新」与「更新为 NULL（异常值）」
    has_cycle_length = cycle_length is not None
    if has_cycle_length:
        cycle_length = _sanitize_cycle_length(cycle_length)  # 异常值 → None
    fields: list[str] = []
    params: list[Any] = []
    if period_start is not None:
        fields.append("period_start = ?")
        params.append(period_start)
    if clear_period_end:
        # 清空结束日：period_days 由 (end-start)+1 派生，失去依赖一并置 NULL
        fields.append("period_end = NULL")
        fields.append("period_days = NULL")
    elif period_end is not None:
        fields.append("period_end = ?")
        params.append(period_end)
    if has_cycle_length:
        fields.append("cycle_length = ?")
        params.append(cycle_length)  # 可能是 None（异常值 sanitize 后）或正常值
    if period_days is not None:
        fields.append("period_days = ?")
        params.append(period_days)
    if note is not None:
        fields.append("note = ?")
        params.append(note)
    if is_anomalous is not None:
        fields.append("is_anomalous = ?")
        params.append(1 if is_anomalous else 0)
    if not fields:
        return 0
    params.extend([user_id, cycle_id])
    sql = f"UPDATE cycles SET {', '.join(fields)} WHERE user_id = ? AND id = ?"
    if db is not None:
        cursor = await db.execute(sql, tuple(params))
        n = cursor.rowcount
        await cursor.close()
        return n if n is not None else 0
    return await write_query(sql, tuple(params))


async def delete_cycle(user_id: int, cycle_id: int, db=None) -> int:
    """删除月经记录（仅限本人记录），返回受影响行数。db 参数见文件头 E7 约定。"""
    sql = "DELETE FROM cycles WHERE user_id = ? AND id = ?"
    if db is not None:
        cursor = await db.execute(sql, (user_id, cycle_id))
        n = cursor.rowcount
        await cursor.close()
        return n if n is not None else 0
    return await write_query(sql, (user_id, cycle_id))


async def get_recent_anomalous_count(user_id: int, limit: int = 3) -> int:
    """获取该用户最近 limit 条记录中的异常数量（用于状态机 ANOMALY_ALERT）。"""
    row = await read_one(
        "SELECT COUNT(*) AS cnt FROM (SELECT is_anomalous FROM cycles "
        "WHERE user_id = ? ORDER BY period_start DESC LIMIT ?) WHERE is_anomalous = 1",
        (user_id, limit),
    )
    return row["cnt"] if row else 0


# ============================================================
# predictions 表 CRUD（按用户隔离）
# ============================================================

async def create_prediction(
    user_id: int,
    predicted_date: str,
    predicted_start_upper: str,
    predicted_start_lower: str,
    confidence: float,
    model_version: str,
    model_params_json: str,
    db=None,
) -> int:
    """新增预测记录（model_params_json 必填，致命 Bug 禁令）。db 参数见 E7 约定。"""
    sql = (
        "INSERT INTO predictions "
        "(user_id, predicted_date, predicted_start_upper, predicted_start_lower, "
        "confidence, model_version, model_params_json) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    params = (
        user_id, predicted_date, predicted_start_upper, predicted_start_lower,
        confidence, model_version, model_params_json,
    )
    if db is not None:
        cursor = await db.execute(sql, params)
        row_id = cursor.lastrowid
        await cursor.close()
        return row_id if row_id is not None else 0
    return await insert_row(sql, params)


async def get_latest_prediction(user_id: int, db=None) -> dict | None:
    """获取该用户最近一条预测记录（created_at 最新）。

    db 参数见文件头 E7 约定（v0.13.1 修 G1：过期刷新锁内重查用）。
    """
    sql = (
        "SELECT * FROM predictions WHERE user_id = ? "
        "ORDER BY created_at DESC, id DESC LIMIT 1"
    )
    if db is not None:
        async with db.execute(sql, (user_id,)) as cur:
            row = await cur.fetchone()
    else:
        row = await read_one(sql, (user_id,))
    return dict(row) if row else None


async def get_prediction_history(user_id: int, limit: int = 50) -> list[dict]:
    """获取该用户历史预测列表（created_at 倒序）。"""
    rows = await read_query(
        "SELECT * FROM predictions WHERE user_id = ? "
        "ORDER BY created_at DESC, id DESC LIMIT ?",
        (user_id, limit),
    )
    return [dict(r) for r in rows]


def _prediction_order_key(p: dict) -> tuple[str, str, int]:
    """规范序（canonical order）——本项目「时间序」的**单一来源**。

    规范序 = ``predicted_date ASC`` → ``created_at ASC`` → ``id ASC``。
    语义：先按预测目标日，再按作出时刻，最后用行 id 兜底。

    为何主键是 ``predicted_date`` 而不是 ``created_at``（R33-fix1 事故形态）：
    - 历史迁移/导入会把多条预测的 ``created_at`` 写成**同一值**（用户库实测
      4 条已验证预测全为 ``2026-07-31 18:13:22``），此时 ``created_at`` 无法定序，
      次序退化为插入序（SQLite 并列时不保证退化为 rowid，属未定义）；
    - 本应用「为下一次月经做预测」（一次只前瞻一个周期），``predicted_date`` 的
      先后**等价于**预测作出的先后，且它是**数据自带、不依赖插入顺序**的锚。

    同一口径的 SQL 侧镜像见 ``get_all_predictions``（created_at 首键的确定性
    次序号）与 ``get_predictions_chronological``（规范序取数，供导出/调试）；
    Python 侧消费点见 ``routes/settings.py`` 的导入插入排序。
    """
    return (
        str(p.get("predicted_date") or ""),
        str(p.get("created_at") or ""),
        int(p.get("id") or 0),
    )


async def get_all_predictions(user_id: int, db=None) -> list[dict]:
    """获取该用户全部预测记录（用于精度评估/E8 全量回填）。db 参数见 E7 约定。

    v0.22.4 修 R33-fix1：``ORDER BY`` 由单列 ``created_at ASC`` 改为**确定性**
    （``created_at ASC, predicted_date ASC, id ASC``）——原单列在 ``created_at``
    并列时次序未定义，是精度 ``trend`` 翻转的共同放大器。本函数仅供精度评估 /
    E8 全量回填等**内部**消费；用户可见的「预测历史倒序」走
    ``get_prediction_history``（``created_at DESC, id DESC``），其语义未变。
    """
    sql = (
        "SELECT * FROM predictions WHERE user_id = ? "
        "ORDER BY created_at ASC, predicted_date ASC, id ASC"
    )
    if db is not None:
        async with db.execute(sql, (user_id,)) as cur:
            rows = await cur.fetchall()
    else:
        rows = await read_query(sql, (user_id,))
    return [dict(r) for r in rows]


async def get_predictions_chronological(
    user_id: int, limit: int | None = None, db=None
) -> list[dict]:
    """按**规范序**取预测（``predicted_date ASC`` → ``created_at ASC`` → ``id ASC``）。

    v0.22.4 修 R33-fix1（治本）：
    - ``GET /export`` 用它取代 ``get_prediction_history`` ⇒ 备份文件里的预测是
      「老→新」，导入后 id 也与时间序一致（「id 序 = 时间序」不变量两账号都成立）。

    **不得**用它替换 ``get_prediction_history``——后者是**用户可见的「预测历史
    倒序」**（``created_at DESC, id DESC``），语义必须保持（早期记录）。
    ``limit=None`` 表示不截断；``db`` 参数见文件头 E7 约定。
    """
    sql = (
        "SELECT * FROM predictions WHERE user_id = ? "
        "ORDER BY predicted_date ASC, created_at ASC, id ASC"
    )
    params: tuple = (user_id,)
    if limit is not None:
        sql += " LIMIT ?"
        params = (user_id, limit)
    if db is not None:
        async with db.execute(sql, params) as cur:
            rows = await cur.fetchall()
    else:
        rows = await read_query(sql, params)
    return [dict(r) for r in rows]


async def delete_unverified_predictions(user_id: int, db=None) -> int:
    """删除该用户所有未验证预测（actual_date IS NULL）。

    M5 新Bug D 修复：DELETE /cycles 后调用。db 参数见文件头 E7 约定。
    """
    sql = "DELETE FROM predictions WHERE user_id = ? AND actual_date IS NULL"
    if db is not None:
        cursor = await db.execute(sql, (user_id,))
        n = cursor.rowcount
        await cursor.close()
        return n if n is not None else 0
    return await write_query(sql, (user_id,))


# v0.13.0 修 F8：以下函数供 routes 层收编裸写 SQL，全部遵循文件头 E7 约定。

async def finalize_cycle_derived(
    cycle_id: int,
    cycle_length: int | None,
    period_days: int | None,
    is_anomalous: int | bool,
    note: str,
    db=None,
    user_id: int | None = None,
) -> int:
    """回填 cycle 记录的派生字段（cycle_length/period_days/is_anomalous/note）。

    POST 副作用链收尾用，**总是**显式写入（cycle_length/period_days 可为 NULL），
    与 update_cycle 的「None=不更新」语义不同，故独立成函数。
    db 参数见文件头 E7 约定。

    P3 修复（UPDATE 缺 user_id 过滤）：新增**可选** user_id，传入时 SQL 追加
    ``AND user_id = ?``。可选是为零调用方破坏——唯一调用点 routes/cycles.py
    POST 链（本文件外，不可改）未传 user_id：那里的 cycle_id 由本用户刚经
    create_cycle 插入（id 已限定域），None 时退回旧行为（不加过滤）等价。
    """
    sql = (
        "UPDATE cycles SET cycle_length = ?, period_days = ?, is_anomalous = ?, note = ? "
        "WHERE id = ?"
    )
    params: tuple = (cycle_length, period_days, 1 if is_anomalous else 0, note, cycle_id)
    if user_id is not None:
        sql += " AND user_id = ?"
        params += (user_id,)
    if db is not None:
        cursor = await db.execute(sql, params)
        n = cursor.rowcount
        await cursor.close()
        return n if n is not None else 0
    return await write_query(sql, params)


async def backfill_prediction_actual(
    prediction_id: int, actual_date: str, error_days: int, db=None,
    user_id: int | None = None,
) -> int:
    """回填预测的 actual_date / error_days（v0.12.0 修 E8 全量回填用）。

    db 参数见文件头 E7 约定。

    P3 修复（UPDATE 缺 user_id 过滤）：新增**可选** user_id，传入时 SQL 追加
    ``AND user_id = ?``。可选是为零调用方破坏——两个调用点均在 routes/cycles.py
    （本文件外，不可改）且未传 user_id：prediction_id 都取自本用户的
    get_all_predictions(user_id) 结果（id 已限定域），None 时退回旧行为等价。
    """
    sql = "UPDATE predictions SET actual_date = ?, error_days = ? WHERE id = ?"
    params: tuple = (actual_date, error_days, prediction_id)
    if user_id is not None:
        sql += " AND user_id = ?"
        params += (user_id,)
    if db is not None:
        cursor = await db.execute(sql, params)
        n = cursor.rowcount
        await cursor.close()
        return n if n is not None else 0
    return await write_query(sql, params)


async def delete_user_cycles(user_id: int, db=None) -> int:
    """删除该用户全部 cycles 记录（导入前清空用）。db 参数见文件头 E7 约定。"""
    sql = "DELETE FROM cycles WHERE user_id = ?"
    if db is not None:
        cursor = await db.execute(sql, (user_id,))
        n = cursor.rowcount
        await cursor.close()
        return n if n is not None else 0
    return await write_query(sql, (user_id,))


async def delete_user_predictions(user_id: int, db=None) -> int:
    """删除该用户全部 predictions 记录（导入前清空用）。db 参数见文件头 E7 约定。"""
    sql = "DELETE FROM predictions WHERE user_id = ?"
    if db is not None:
        cursor = await db.execute(sql, (user_id,))
        n = cursor.rowcount
        await cursor.close()
        return n if n is not None else 0
    return await write_query(sql, (user_id,))


async def create_import_prediction(
    user_id: int,
    predicted_date: str,
    predicted_start_upper: str,
    predicted_start_lower: str,
    confidence: float,
    model_version: str,
    model_params_json: str,
    actual_date,
    error_days,
    created_at: str,
    db=None,
) -> int:
    """导入一条 prediction（还原精度历史：actual_date/error_days/created_at）。

    十列 INSERT（import_data 用）。db 参数见文件头 E7 约定。
    """
    sql = (
        "INSERT INTO predictions (user_id, predicted_date, predicted_start_upper, "
        "predicted_start_lower, confidence, model_version, model_params_json, "
        "actual_date, error_days, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    params = (
        user_id, predicted_date, predicted_start_upper, predicted_start_lower,
        confidence, model_version, model_params_json,
        actual_date, error_days, created_at,
    )
    if db is not None:
        cursor = await db.execute(sql, params)
        row_id = cursor.lastrowid
        await cursor.close()
        return row_id if row_id is not None else 0
    return await insert_row(sql, params)


# ============================================================
# model_params 表 CRUD（v0.11.0：每用户一行）
# ============================================================

_DEFAULT_PARAMS = {
    "mean_cycle": 28.0,
    "std_cycle": 7.0,
    "n_records": 0,
    "ema_cycle": 28.0,
    "prior_mean": 28.0,
    "prior_std": 7.0,
    "prior_weight": 0.5,
}


async def get_model_params(user_id: int, db=None) -> dict:
    """获取该用户模型参数（行缺失时返回默认值——ensure_user_defaults 的兜底）。db 参数见 E7 约定。"""
    sql = "SELECT * FROM model_params WHERE user_id = ?"
    if db is not None:
        async with db.execute(sql, (user_id,)) as cur:
            row = await cur.fetchone()
    else:
        row = await read_one(sql, (user_id,))
    if row is None:
        return {"user_id": user_id, **_DEFAULT_PARAMS, "updated_at": None}
    return dict(row)


async def update_model_params(
    user_id: int,
    mean_cycle: float,
    std_cycle: float,
    n_records: int,
    ema_cycle: float,
    prior_mean: float,
    prior_std: float,
    prior_weight: float,
    db=None,
) -> int:
    """更新该用户模型参数（UPSERT：行不存在则插入默认底座+新值）。db 参数见 E7 约定。"""
    sql = (
        "INSERT INTO model_params (user_id, mean_cycle, std_cycle, n_records, ema_cycle, "
        "prior_mean, prior_std, prior_weight, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP) "
        "ON CONFLICT(user_id) DO UPDATE SET "
        "mean_cycle = excluded.mean_cycle, std_cycle = excluded.std_cycle, "
        "n_records = excluded.n_records, ema_cycle = excluded.ema_cycle, "
        "prior_mean = excluded.prior_mean, prior_std = excluded.prior_std, "
        "prior_weight = excluded.prior_weight, updated_at = CURRENT_TIMESTAMP"
    )
    params = (
        user_id, mean_cycle, std_cycle, n_records, ema_cycle,
        prior_mean, prior_std, prior_weight,
    )
    if db is not None:
        cursor = await db.execute(sql, params)
        n = cursor.rowcount
        await cursor.close()
        return n if n is not None else 0
    return await write_query(sql, params)


async def reset_model_params(user_id: int, db=None) -> int:
    """重置该用户模型参数为默认值（删除所有记录后回 EMPTY 状态）。db 参数见 E7 约定。"""
    sql = (
        "UPDATE model_params SET "
        "mean_cycle = 28.0, std_cycle = 7.0, n_records = 0, ema_cycle = 28.0, "
        "prior_mean = 28.0, prior_std = 7.0, prior_weight = 0.5, "
        "updated_at = CURRENT_TIMESTAMP WHERE user_id = ?"
    )
    if db is not None:
        cursor = await db.execute(sql, (user_id,))
        n = cursor.rowcount
        await cursor.close()
        return n if n is not None else 0
    return await write_query(sql, (user_id,))


# ============================================================
# app_settings 表 CRUD（v0.11.0：每用户一行）
# ============================================================

async def get_settings(user_id: int) -> dict:
    """获取该用户应用设置（空壳表；行缺失时返回 user_id + updated_at=None）。

    R1-A：notify_enabled/notify_days/theme 已移除；签名不变。
    """
    row = await read_one("SELECT * FROM app_settings WHERE user_id = ?", (user_id,))
    if row is None:
        return {"user_id": user_id, "updated_at": None}
    return dict(row)


async def update_settings(user_id: int) -> int:
    """更新该用户应用设置时间戳（UPSERT，空壳语义；R1-A 新签名：无业务参数）。"""
    return await write_query(
        "INSERT INTO app_settings (user_id, updated_at) "
        "VALUES (?, CURRENT_TIMESTAMP) "
        "ON CONFLICT(user_id) DO UPDATE SET updated_at = CURRENT_TIMESTAMP",
        (user_id,),
    )


# ============================================================
# daily_records 表 CRUD（经期每日详情，2026-10-26 用户立项）
# ============================================================

async def is_period_day(user_id: int, day: str, db=None) -> bool:
    """该日是否来潮日：存在周期记录 period_start ≤ day ≤ period_end。

    period_end 为空视为进行中（无上界）。day 为 ISO YYYY-MM-DD 字符串。
    routes/daily.py（写入口径）与 services/reminder.py（提醒口径）共用本判定。
    """
    sql = (
        "SELECT 1 FROM cycles WHERE user_id = ? AND period_start <= ? "
        "AND (period_end IS NULL OR period_end >= ?) LIMIT 1"
    )
    if db is not None:
        async with db.execute(sql, (user_id, day, day)) as cur:
            row = await cur.fetchone()
    else:
        row = await read_one(sql, (user_id, day, day))
    return row is not None


def _decode_daily_row(row: Any) -> dict:
    """daily_records 行 → dict，mood_tags 的 JSON 文本解成 list[str]。

    写入前已经词表校验，正常不会解析失败；手工改库造成的非法文本按空数组兑底并告警，
    不让单行脏数据把整个区间查询打成 500。
    """
    d = dict(row)
    raw = d.get("mood_tags")
    try:
        tags = json.loads(raw) if raw else []
    except (TypeError, ValueError):
        tags = None
    if not isinstance(tags, list) or not all(isinstance(t, str) for t in tags):
        logger.warning("daily_records.mood_tags 非法（user=%s date=%s），按空数组返回",
                       d.get("user_id"), d.get("record_date"))
        tags = []
    d["mood_tags"] = tags
    return d


async def upsert_daily_record(
    user_id: int,
    record_date: str,
    pain_present: bool,
    pain_level: int | None,
    flow_level: int,
    mood_level: int,
    mood_tags: list[str],
    db=None,
) -> int:
    """upsert 当日四件套（UNIQUE(user_id, record_date) 冲突即整行覆盖；updated_at 刷新）。

    mood_tags 由调用方（schema 校验后）传入词表 ID 列表，这里序列化为 JSON 文本。
    旧 mood_note 列不再写入（已迁入 daily_journal，见 database._migrate_v4_journal）。
    """
    sql = (
        "INSERT INTO daily_records (user_id, record_date, pain_present, pain_level, "
        "flow_level, mood_level, mood_tags, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP) "
        "ON CONFLICT(user_id, record_date) DO UPDATE SET "
        "pain_present = excluded.pain_present, pain_level = excluded.pain_level, "
        "flow_level = excluded.flow_level, mood_level = excluded.mood_level, "
        "mood_tags = excluded.mood_tags, updated_at = CURRENT_TIMESTAMP"
    )
    params = (user_id, record_date, 1 if pain_present else 0, pain_level,
              flow_level, mood_level, json.dumps(mood_tags, ensure_ascii=False))
    if db is not None:
        cursor = await db.execute(sql, params)
        n = cursor.rowcount
        await cursor.close()
        return n if n is not None else 0
    return await write_query(sql, params)


async def get_daily_record(user_id: int, record_date: str, db=None) -> dict | None:
    """取该用户指定日的四件套行（mood_tags 已解成 list；行中仍带废弃的 mood_note 列，由 Out 模型剥除）。"""
    sql = "SELECT * FROM daily_records WHERE user_id = ? AND record_date = ?"
    if db is not None:
        async with db.execute(sql, (user_id, record_date)) as cur:
            row = await cur.fetchone()
    else:
        row = await read_one(sql, (user_id, record_date))
    return _decode_daily_row(row) if row else None


async def has_daily_record(user_id: int, record_date: str, db=None) -> bool:
    """该用户该日是否已有详情行（行存在即 true）。"""
    return await get_daily_record(user_id, record_date, db=db) is not None


async def has_daily_note(user_id: int, record_date: str, db=None) -> bool:
    """该用户该日的日记是否已填（#14：今日 note = daily_journal.note）。

    判定单一来源（services/reminder.py 的每晚填写腿与 Android PiqCrud.hasDailyNote
    同口径）：行存在且 ``str(note or '').strip()`` 非空才算已填；无行、空串、
    NULL、纯空白一律视为未填。
    """
    row = await get_journal(user_id, record_date, db=db)
    if row is None:
        return False
    return bool(str(row.get("note") or "").strip())


async def get_daily_records_range(user_id: int, date_from: str, date_to: str) -> list[dict]:
    """区间查询（闭区间，record_date 升序；GET /daily-records 用）。

    #28 裁决：单日读取 = 同一个区间查询传 from=to，不新增单日 GET 端点；
    UNIQUE(user_id, record_date) 的自动索引已覆盖该谓词，无需额外索引。
    """
    rows = await read_query(
        "SELECT * FROM daily_records WHERE user_id = ? AND record_date >= ? AND record_date <= ? "
        "ORDER BY record_date ASC",
        (user_id, date_from, date_to),
    )
    return [_decode_daily_row(r) for r in rows]


async def get_all_daily_records(user_id: int, db=None) -> list[dict]:
    """全部每日详情（record_date 升序；导出总量统计与截断共用；导出路径自行剥除 mood_note/mood_tags）。"""
    sql = "SELECT * FROM daily_records WHERE user_id = ? ORDER BY record_date ASC"
    if db is not None:
        async with db.execute(sql, (user_id,)) as cur:
            rows = await cur.fetchall()
    else:
        rows = await read_query(sql, (user_id,))
    return [_decode_daily_row(r) for r in rows]


# ============================================================
# daily_journal 表 CRUD（#14 每日日记，独立渠道；不进导出/导入，导入不碰该表）
# ============================================================

async def get_journal(user_id: int, record_date: str, db=None) -> dict | None:
    """取该用户指定日的日记行（无行 None；note 可为 NULL）。"""
    sql = "SELECT * FROM daily_journal WHERE user_id = ? AND record_date = ?"
    if db is not None:
        async with db.execute(sql, (user_id, record_date)) as cur:
            row = await cur.fetchone()
    else:
        row = await read_one(sql, (user_id, record_date))
    return dict(row) if row else None


async def get_journal_range(user_id: int, date_from: str, date_to: str) -> list[dict]:
    """日记区间查询（闭区间，record_date 升序）。"""
    rows = await read_query(
        "SELECT * FROM daily_journal WHERE user_id = ? AND record_date >= ? AND record_date <= ? "
        "ORDER BY record_date ASC",
        (user_id, date_from, date_to),
    )
    return [dict(r) for r in rows]


async def upsert_journal(user_id: int, record_date: str, note: str) -> int:
    """upsert 当日日记（同日重复保存整行覆盖，updated_at 刷新，created_at 保留）。"""
    return await write_query(
        "INSERT INTO daily_journal (user_id, record_date, note, updated_at) "
        "VALUES (?, ?, ?, CURRENT_TIMESTAMP) "
        "ON CONFLICT(user_id, record_date) DO UPDATE SET "
        "note = excluded.note, updated_at = CURRENT_TIMESTAMP",
        (user_id, record_date, note),
    )


async def delete_journal(user_id: int, record_date: str) -> int:
    """删除当日日记（幂等；空文本 PUT 走这里）。"""
    return await write_query(
        "DELETE FROM daily_journal WHERE user_id = ? AND record_date = ?",
        (user_id, record_date),
    )


async def delete_user_daily_records(user_id: int, db=None) -> int:
    """清空该用户全部每日详情（导入=清空重建）。db 参数见文件头 E7 约定。"""
    sql = "DELETE FROM daily_records WHERE user_id = ?"
    if db is not None:
        cursor = await db.execute(sql, (user_id,))
        n = cursor.rowcount
        await cursor.close()
        return n if n is not None else 0
    return await write_query(sql, (user_id,))


async def create_import_daily_record(
    user_id: int,
    record_date: str,
    pain_present: bool,
    pain_level: int | None,
    flow_level: int,
    mood_level: int,
    created_at: str,
    updated_at: str,
    db=None,
) -> int:
    """导入一条每日详情（还原历史：不受补填窗口限制；ON CONFLICT 覆盖使重复日期后行胜出）。"""
    sql = (
        "INSERT INTO daily_records (user_id, record_date, pain_present, pain_level, "
        "flow_level, mood_level, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(user_id, record_date) DO UPDATE SET "
        "pain_present = excluded.pain_present, pain_level = excluded.pain_level, "
        "flow_level = excluded.flow_level, mood_level = excluded.mood_level, "
        "created_at = excluded.created_at, updated_at = excluded.updated_at"
    )
    params = (user_id, record_date, 1 if pain_present else 0, pain_level,
              flow_level, mood_level, created_at, updated_at)
    if db is not None:
        cursor = await db.execute(sql, params)
        n = cursor.rowcount
        await cursor.close()
        return n if n is not None else 0
    return await write_query(sql, params)


async def get_active_session_user_ids() -> list[int]:
    """有有效会话的用户 id 列表（每晚提醒只面向已登录用户；去重升序）。"""
    rows = await read_query(
        "SELECT DISTINCT user_id FROM sessions "
        "WHERE expires_at IS NULL OR expires_at > datetime('now') "
        "ORDER BY user_id ASC"
    )
    return [int(r["user_id"]) for r in rows]


# ============================================================
# 全量重算（DELETE/修正/导入后触发，致命 Bug 禁令）
# v0.12.0 修 E7：以下函数全部支持 db 参数（传入外层 WriteLock 连接即并入同一事务）
# ============================================================

async def get_all_valid_cycle_lengths(user_id: int, db=None) -> list[float]:
    """获取该用户全部合法周期长度（cycle_length 非空，DDL CHECK 限 [7,90]），按时间升序。

    v0.8.1 口径（例外表第 6 项同源修复）：不再按 is_anomalous=0 过滤——
    偏离周期仅被鲁棒降权、仍参与预测（降权在 robust_weights 内完成），
    此处再排除它们会使模型输入与预测参与集不一致；
    硬无效周期（<7/>90）落库时 cycle_length 已置 NULL，天然排除。
    db 参数见文件头 E7 约定。
    """
    sql = (
        "SELECT cycle_length FROM cycles "
        "WHERE user_id = ? AND cycle_length IS NOT NULL "
        "ORDER BY period_start ASC"
    )
    if db is not None:
        async with db.execute(sql, (user_id,)) as cur:
            rows = await cur.fetchall()
    else:
        rows = await read_query(sql, (user_id,))
    return [float(r["cycle_length"]) for r in rows]


async def full_recompute_model_params(
    user_id: int,
    cycle_lengths: list[float],
    db=None,
) -> dict:
    """全量重算该用户 model_params（删除记录后触发）。db 参数见文件头 E7 约定。

    v0.8.1 统一口径：直接取 predict_core 输出（与预测、新增链路严格同源），
    替换旧实现「等权共轭 + (1-pw) 线性混合」的独立路径。
    EMA 按全量历史重放（replay_ema），种子 PRIOR_MEAN，与逐条增量链严格一致。
    """
    from app.algo.stats import predict_core, replay_ema

    if not cycle_lengths:
        # 无合法周期：重置为默认
        await reset_model_params(user_id, db=db)
        return await get_model_params(user_id, db=db)

    prev_ema = replay_ema(cycle_lengths, config, exclude_last=True)
    core = predict_core(cycle_lengths, prev_ema, config)
    await update_model_params(
        user_id,
        mean_cycle=core["predicted_cycle"],
        std_cycle=core["std"],
        n_records=core["n"],
        ema_cycle=core["new_ema"],
        prior_mean=core["mu_post"],
        prior_std=core["sigma_post"],
        prior_weight=core["prior_weight"],
        db=db,
    )
    return await get_model_params(user_id, db=db)


async def regenerate_current_prediction(user_id: int, db=None) -> int | None:
    """基于该用户最新记录与全量历史重新生成「当前预测」并落库（v0.9.0 新增）。

    单一来源：删除重算（cycles._recompute_after_delete）与导入补偿
    （settings.import_data，修 P3）共用本函数。db 参数见文件头 E7 约定。
    """
    from app.algo.stats import predict_next_period, replay_ema

    cycle_lengths = await get_all_valid_cycle_lengths(user_id, db=db)
    latest = await get_latest_cycle(user_id, db=db)
    if latest is None:
        return None
    prediction = predict_next_period(
        date_from_iso(latest["period_start"]),
        cycle_lengths,
        replay_ema(cycle_lengths, config, exclude_last=True),
        config,
    )
    if prediction["predicted_date"] is None:
        return None
    return await create_prediction(
        user_id,
        predicted_date=prediction["predicted_date"],
        predicted_start_upper=prediction["predicted_start_upper"],
        predicted_start_lower=prediction["predicted_start_lower"],
        confidence=prediction["confidence"],
        model_version=prediction["model_version"],
        model_params_json=json.dumps(prediction["model_params"], ensure_ascii=False),
        db=db,
    )


async def recompute_derived_fields(user_id: int, db) -> None:
    """按当前全部记录重推每条的 cycle_length / period_days / is_anomalous（v0.12.0 新增）。

    单一来源：修正开始日（cycles._recompute_all_records）与导入（settings.import_data，
    CSV 导入无派生字段、JSON 导入统一口径）共用本函数，消除两处重写漂移。

    判定口径与 on_new_cycle_added 逐条一致（既有算法口径）：
    - cycle_length = 与上一条开始日的间隔；首条为 NULL
    - 硬无效（<7/>90）→ cycle_length 置 NULL 且 is_anomalous=1（不参与计算）
    - 偏离（历史合法周期 ≥2 且偏离中位数 >14 天）→ is_anomalous=1，长度保留（降权参与）
    - prev_start 无条件前移：硬无效记录的开始日仍是后续间隔计算的真实锚点

    P3 修复（删除 db=None 裸路径，db 改必传）：全部调用点（routes/cycles.py 两处、
    routes/settings.py 导入一处，均已核）都以 ``db=`` 传入事务连接——裸路径
    （每条 UPDATE 各自独立事务，中途失败留半重算态）已无任何使用方，删除并把
    db 设为必传，防止未来新调用点退回无事务重算。既有调用均以关键字传参，零破坏。

    P3 修复（UPDATE 缺 user_id 过滤）：内层 UPDATE 补 ``AND user_id = ?``——记录
    本身按 user_id 读出，写口径与读口径一致（纵深防御，user_id 是本函数入参）。
    """
    import statistics as _stats
    from datetime import date as _date

    sql = "SELECT * FROM cycles WHERE user_id = ? ORDER BY period_start ASC, id ASC"
    async with db.execute(sql, (user_id,)) as cur:
        records = [dict(r) for r in await cur.fetchall()]

    prev_start: _date | None = None
    prev_legal_lengths: list[float] = []
    for r in records:
        start = _date.fromisoformat(r["period_start"])
        end = _date.fromisoformat(r["period_end"]) if r["period_end"] else None
        period_days = (end - start).days + 1 if end is not None else None

        cycle_length: int | None = None
        is_anomalous = 0
        if prev_start is not None:
            raw = (start - prev_start).days
            if raw < config.MIN_CYCLE_DAYS or raw > config.MAX_CYCLE_DAYS:
                is_anomalous = 1  # 硬无效：长度置 NULL，不参与计算
            else:
                cycle_length = raw
                if len(prev_legal_lengths) >= 2 and \
                        abs(raw - _stats.median(prev_legal_lengths)) > config.ANOMALY_DEVIATION_THRESHOLD:
                    is_anomalous = 1  # 偏离：仅标记，降权参与
                prev_legal_lengths.append(float(raw))
        # prev_start 无条件前移：硬无效记录的开始日仍是后续间隔计算的真实锚点
        prev_start = start

        update_sql = (
            "UPDATE cycles SET cycle_length = ?, period_days = ?, is_anomalous = ? "
            "WHERE id = ? AND user_id = ?"
        )
        await db.execute(
            update_sql, (cycle_length, period_days, is_anomalous, r["id"], user_id)
        )


def date_from_iso(s: str):
    """ISO 字符串转 date（本模块内避免顶层 import date 与参数名冲突的辅助）。"""
    from datetime import date as _date
    return _date.fromisoformat(s)
