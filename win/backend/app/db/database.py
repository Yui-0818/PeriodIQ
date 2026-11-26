# Copyright (c) 2026 Yui_0818 (aaaj6719@gmail.com)
# Licensed under the PolyForm Noncommercial License 1.0.0.
# Commercial use is prohibited without separate written authorization.
# See LICENSE and COMMERCIAL.md in the repository root.

"""SQLite 数据库连接管理（早期设计文档）。

特性：
- aiosqlite 异步驱动
- WAL 模式（提升并发读写）
- 写操作加锁（asyncio.Lock，防止并发写入冲突）
- 启动时执行 DDL 建表（DDL 原样）+ 单行表初始化
- 参数化查询（防 SQL 注入，致命 Bug 禁令）

DDL 严格按早期设计文档，不得修改字段名或类型。
"""

import asyncio
import logging
import os
import secrets
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import aiosqlite

from app import config

logger = logging.getLogger(__name__)

# 写操作全局锁（并发纪律：SQLite并发写入不处理 → aiosqlite + WAL + 写操作加锁）
_write_lock: asyncio.Lock = asyncio.Lock()
# v0.12.0 修 E6：当前持锁任务（重入检测用；asyncio.Lock 本身不暴露 owner）
_write_lock_holder: asyncio.Task | None = None

# DDL（v0.11.0 用户管理修订，早期设计文档；用户明确授权多用户改造）
# 变更说明（相对 v1 单用户 DDL）：
# - 新增 users / sessions 表（认证）
# - cycles / predictions 增加 user_id 列（数据按用户隔离）
# - model_params / app_settings 由「强制单行 id=1」改为「每用户一行（user_id 主键）」
#
# v0.13.1 修 G4/G7（表定义单一来源）：
# - 各业务/会话表的 CREATE 文本抽为 _TBL_* 常量——新建库 DDL 与 _migrate_v3
#   旧表重建共用同一份定义，杜绝两处手抄漂移；
# - user_id 列全部带 REFERENCES users(id) ON DELETE CASCADE（旧库无外键，
#   靠 crud 纪律兜底；v3 迁移为存量库补齐，删号链路再获二道防线）；
# - sessions 新增 expires_at（会话 30 天 TTL，G4；存量库由 v3 迁移补列并回填）。
#
# v0.15.5+ R1-A（用户 2026-09-18 裁定）：
# - 「主题」彻底删除、「通知」砍掉实现暂缓重做；app_settings 保留空壳
#   （只 user_id + updated_at）。存量库由 _migrate_v3_app_settings_shell
#   在 _migrate_v1 之后收敛；_migrate_v1 内部逻辑不改（历史步骤保真）。
_TBL_SESSIONS = """(
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP
)"""
# P3 修复（DDL 周期界双来源）：chk_length 的界必须与 crud._sanitize_cycle_length /
# recompute_derived_fields 用的 config.MIN/MAX_CYCLE_DAYS 同源——旧文本硬编码 7/90，
# 一旦调整 config 常量，DDL 约束不会跟着变（两层口径漂移）。改为 f-string 引 config
# 常量；当前拼接结果与原硬编码文本**逐字节一致**（仍为 7/90），既有库与新库 DDL 不变。
_TBL_CYCLES = f"""(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    period_start DATE NOT NULL,
    period_end DATE,
    cycle_length INTEGER,
    period_days INTEGER,
    note TEXT DEFAULT '',
    is_anomalous BOOLEAN DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_date CHECK (period_end IS NULL OR period_end >= period_start),
    CONSTRAINT chk_length CHECK (cycle_length IS NULL OR (cycle_length >= {config.MIN_CYCLE_DAYS} AND cycle_length <= {config.MAX_CYCLE_DAYS}))
)"""
_TBL_PREDICTIONS = """(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    predicted_date DATE NOT NULL,
    predicted_start_upper DATE NOT NULL,
    predicted_start_lower DATE NOT NULL,
    confidence REAL NOT NULL,
    model_version TEXT NOT NULL,
    model_params_json TEXT NOT NULL,
    actual_date DATE,
    error_days INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)"""
_TBL_MODEL_PARAMS = """(
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    mean_cycle REAL NOT NULL DEFAULT 28.0,
    std_cycle REAL NOT NULL DEFAULT 7.0,
    n_records INTEGER NOT NULL DEFAULT 0,
    ema_cycle REAL NOT NULL DEFAULT 28.0,
    prior_mean REAL NOT NULL DEFAULT 28.0,
    prior_std REAL NOT NULL DEFAULT 7.0,
    prior_weight REAL NOT NULL DEFAULT 0.5,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)"""
# 空壳形：表保留，业务列全部移除
_TBL_APP_SETTINGS = """(
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)"""
# 经期每日详情（2026-10-26 用户立项；列口径与 Android PiqDb.TBL_DAILY_RECORDS 同源）：
# 无疼痛时 pain_level 存 NULL 不存 0；chk_daily_pain 双向钉死（有疼痛必须 1-10、
# 无疼痛必须 NULL）。R1 修复（2026-10-26 审查员实测）：第二子式必须前置
# `pain_level IS NOT NULL`——否则 `pain_present=1 且 pain_level=NULL` 时整个表达式
# 求值为 NULL，SQLite CHECK 对 NULL 视为通过（三值逻辑单向逃逸，有疼痛无等级漏拦）。
# 2026-10-31 #14/#15：新增 mood_tags（受控词表 ID 的 JSON 数组文本，默认 '[]'，经校验后才落库）；
# mood_note 列**已废弃但保留**（文本已按 _migrate_v4_journal 一次性复制到 daily_journal，
# API/UI 不再读写，保留仅为回滚可用），导出路径（routes/settings.py）仍显式剥除 mood_note/mood_tags。
# 全新表：不入 v3 重建清单（v3 只治理既有表的形态变更；存量库由下方 DDL 的
# IF NOT EXISTS 在下次启动时直接补建，天然带 users 外键）。
_TBL_DAILY_RECORDS = """(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    record_date DATE NOT NULL,
    pain_present BOOLEAN NOT NULL DEFAULT 0,
    pain_level INTEGER,
    flow_level INTEGER NOT NULL,
    mood_level INTEGER NOT NULL,
    mood_note TEXT,
    mood_tags TEXT NOT NULL DEFAULT '[]',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, record_date),
    CONSTRAINT chk_daily_pain CHECK (pain_present IN (0, 1) AND (pain_present = 0 OR (pain_level IS NOT NULL AND pain_level >= 1 AND pain_level <= 10)) AND (pain_present = 1 OR pain_level IS NULL)),
    CONSTRAINT chk_daily_flow CHECK (flow_level >= 1 AND flow_level <= 10),
    CONSTRAINT chk_daily_mood CHECK (mood_level >= 1 AND mood_level <= 10)
)"""
# 每日日记（#14，独立渠道，不依赖经期）：每用户每日至多一行（UNIQUE 自带 user_id+record_date 索引，
# 区间/单日查询均走该索引）；note 列可空（NULL 与空文本同义「无日记」，读取方兑底），
# 长度上限按字符（SQLite length() 按码点计）与 config.DAILY_NOTE_MAX_CHARS 同源。
# 全新表：IF NOT EXISTS 直接补建，不入 v3 重建清单；旧 mood_note 由 _migrate_v4_journal 迁入。
_TBL_DAILY_JOURNAL = f"""(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    record_date DATE NOT NULL,
    note TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, record_date),
    CONSTRAINT chk_journal_note CHECK (note IS NULL OR length(note) <= {config.DAILY_NOTE_MAX_CHARS})
)"""

DDL_STATEMENTS: list[str] = [
    # 表0a: users — 用户（v0.11.0）
    """
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        nickname TEXT,
        avatar TEXT,
        birthday TEXT,
        weight_kg REAL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
    """,
    # 表0b: sessions — 会话令牌（v0.11.0；v0.13.1 修 G4 增 expires_at）
    f"CREATE TABLE IF NOT EXISTS sessions {_TBL_SESSIONS}",
    "CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)",
    # 表1: cycles — 月经周期记录（核心表）
    f"CREATE TABLE IF NOT EXISTS cycles {_TBL_CYCLES}",
    "CREATE INDEX IF NOT EXISTS idx_cycles_start ON cycles(period_start DESC)",
    # 表2: predictions — 预测记录
    f"CREATE TABLE IF NOT EXISTS predictions {_TBL_PREDICTIONS}",
    "CREATE INDEX IF NOT EXISTS idx_pred_date ON predictions(created_at DESC)",
    # 表3: model_params — 模型参数（v0.11.0：每用户一行，user_id 主键）
    f"CREATE TABLE IF NOT EXISTS model_params {_TBL_MODEL_PARAMS}",
    # 表4: app_settings — 应用设置（v0.11.0：每用户一行，user_id 主键）
    f"CREATE TABLE IF NOT EXISTS app_settings {_TBL_APP_SETTINGS}",
    # 表5: daily_records — 经期每日详情（2026-10-26 新增；UNIQUE(user_id, record_date) 自带索引）
    f"CREATE TABLE IF NOT EXISTS daily_records {_TBL_DAILY_RECORDS}",
    # 表6: daily_journal — 每日日记（2026-10-31 #14 新增）
    f"CREATE TABLE IF NOT EXISTS daily_journal {_TBL_DAILY_JOURNAL}",
]


def _get_db_path() -> str:
    """获取数据库文件绝对路径，确保父目录存在。"""
    db_path = config.DB_ABS_PATH
    db_path.parent.mkdir(parents=True, exist_ok=True)
    return str(db_path)


# ============================================================
# v0.14.0 修 DN-3（审计 M6）：一次性迁移口令落盘
# 背景：v0.13.0 修 F1 取消了源码明文默认口令，未设置 MENSTRUAL_MIGRATION_PASSWORD
# 时生成一次性口令并只在启动日志打印一次——用户错过日志即永久失去存量数据访问权
# （无口令重置端点、无 CLI），且 INFO 级日志在 uvicorn 默认配置下可能被淹没。
# 对策：日志之外额外写入仅本机可读的口令文件（源码仍无任何明文默认口令，安全约束不变）。
# ============================================================

MIGRATION_PASSWORD_FILENAME = "MIGRATION_PASSWORD.txt"


def _migration_password_file_path() -> Path:
    """一次性迁移口令的落盘路径：``<config.BACKEND_ROOT>/data/MIGRATION_PASSWORD.txt``。

    v0.14.0 修 DN-3：路径由 config.BACKEND_ROOT 派生（绝不硬编码绝对路径），
    与默认生产库 ``backend/data/app.db`` 同目录，便于用户就近查找。
    """
    return config.BACKEND_ROOT / "data" / MIGRATION_PASSWORD_FILENAME


def _write_migration_password_file(password: str) -> None:
    """把一次性迁移口令写入口令文件（v0.14.0 修 DN-3；失败只告警不阻塞迁移）。

    语义：
    - **仅当文件不存在时写入**：文件是「口令已生成」的凭据，每次启动都覆盖会让
      用户已抄走的口令瞬间失效；已存在时只提示路径与轮换建议（不覆盖、不报错）；
    - 权限收紧尽力而为（``os.chmod`` 0o600；Windows 上语义有限——只能切换只读位，
      失败仅告警），因权限收紧失败而中止迁移是不划算的；
    - 任何写盘/权限异常都不得中断迁移（口令在同一条 INFO 日志里仍可获取）。

    内容格式：首行口令；次行生成时间与用途说明；末行提示登录后改密并删除本文件。
    """
    path = _migration_password_file_path()
    try:
        if path.exists():
            logger.info(
                "v0.14.0 修 DN-3: 口令文件已存在：%s，如已轮换请删除它", path
            )
            return
        path.parent.mkdir(parents=True, exist_ok=True)
        generated_at = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
        path.write_text(
            f"{password}\n"
            f"生成时间：{generated_at}；本文件由存量库（v1→v2）迁移自动生成，"
            "内含默认用户（用户名见 config.MIGRATION_DEFAULT_USERNAME）的一次性初始口令。\n"
            "登录后请立即修改口令并删除本文件。\n",
            encoding="utf-8",
        )
        try:
            os.chmod(path, 0o600)  # 仅本机可读；Windows 上尽力而为
        except Exception as exc:  # noqa: BLE001 权限收紧失败不阻塞迁移
            logger.warning(
                "v0.14.0 修 DN-3: 口令文件权限收紧失败（不影响迁移）：%s", exc
            )
        logger.info("v0.14.0 修 DN-3: 一次性初始口令已写入口令文件：%s", path)
    except Exception as exc:  # noqa: BLE001 写盘失败只告警，绝不阻塞迁移
        logger.warning(
            "v0.14.0 修 DN-3: 写入口令文件失败（请从上方日志抄录口令并立即轮换）：%s", exc
        )


async def _table_columns(db, table: str) -> list[str]:
    """读取表的列名清单（PRAGMA table_info）。"""
    cursor = await db.execute(f"PRAGMA table_info({table})")
    rows = await cursor.fetchall()
    await cursor.close()
    return [row[1] for row in rows]


async def _migrate_v1(db) -> None:
    """v1（单用户）→ v2（多用户）迁移（幂等：无 user_id 列才执行）。

    策略（早期设计文档）：
    1. cycles/predictions：ALTER ADD COLUMN user_id（DEFAULT 0），稍后回填；
       model_params / app_settings 带 CHECK(id=1) 约束无法 ALTER，走「重建表」：
       RENAME → CREATE(新形) → 复制行（user_id 暂置 0）→ DROP 旧表。
    2. 若迁移前库中已有任何业务数据（cycles/predictions 非空，或 model_params
       n_records>0），创建默认用户 **default** 并把全部存量行 user_id 回填为该用户
       ——「现有数据保存在默认用户」。口令来源（v0.13.0 修 F1）：只取环境变量
       `MENSTRUAL_MIGRATION_PASSWORD`（config.MIGRATION_PASSWORD），源码无明文默认值；
       未配置而确需建户时用 secrets 生成一次性初始口令并在启动日志打印一次
       （v0.14.0 修 DN-3：日志之外还把该口令写入
       `config.BACKEND_ROOT/data/MIGRATION_PASSWORD.txt`——仅当文件不存在时写、
       写入/权限收紧失败只告警，保证用户错过日志仍可恢复存量数据访问权）。
    3. 全空库（全新安装）不创建默认用户，由注册流程产生第一个用户。
    """
    columns = await _table_columns(db, "cycles")
    if "user_id" in columns:
        return  # 已是 v2（或全新库），幂等返回

    from app.security import hash_password

    # 迁移前是否已有业务数据（决定是否创建默认用户）
    cur = await db.execute("SELECT COUNT(*) FROM cycles")
    n_cycles = (await cur.fetchone())[0]
    await cur.close()
    cur = await db.execute("SELECT COUNT(*) FROM predictions")
    n_preds = (await cur.fetchone())[0]
    await cur.close()
    cur = await db.execute("SELECT n_records FROM model_params WHERE id = 1")
    mp_row = await cur.fetchone()
    await cur.close()
    has_data = n_cycles > 0 or n_preds > 0 or (mp_row is not None and mp_row[0] > 0)

    # 1. 重建 model_params（去掉 CHECK(id=1)，改 user_id 主键）
    await db.execute("ALTER TABLE model_params RENAME TO model_params_v1")
    await db.execute("""
        CREATE TABLE model_params (
            user_id INTEGER PRIMARY KEY,
            mean_cycle REAL NOT NULL DEFAULT 28.0,
            std_cycle REAL NOT NULL DEFAULT 7.0,
            n_records INTEGER NOT NULL DEFAULT 0,
            ema_cycle REAL NOT NULL DEFAULT 28.0,
            prior_mean REAL NOT NULL DEFAULT 28.0,
            prior_std REAL NOT NULL DEFAULT 7.0,
            prior_weight REAL NOT NULL DEFAULT 0.5,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    await db.execute(
        "INSERT INTO model_params (user_id, mean_cycle, std_cycle, n_records, ema_cycle, "
        "prior_mean, prior_std, prior_weight, updated_at) "
        "SELECT 0, mean_cycle, std_cycle, n_records, ema_cycle, prior_mean, prior_std, "
        "prior_weight, updated_at FROM model_params_v1"
    )
    await db.execute("DROP TABLE model_params_v1")

    # 2. 重建 app_settings（同理）
    await db.execute("ALTER TABLE app_settings RENAME TO app_settings_v1")
    await db.execute("""
        CREATE TABLE app_settings (
            user_id INTEGER PRIMARY KEY,
            notify_enabled BOOLEAN NOT NULL DEFAULT 1,
            notify_days INTEGER NOT NULL DEFAULT 3,
            theme TEXT NOT NULL DEFAULT 'auto',
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    await db.execute(
        "INSERT INTO app_settings (user_id, notify_enabled, notify_days, theme, updated_at) "
        "SELECT 0, notify_enabled, notify_days, theme, updated_at FROM app_settings_v1"
    )
    await db.execute("DROP TABLE app_settings_v1")

    # 3. cycles / predictions 加 user_id 列
    await db.execute("ALTER TABLE cycles ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0")
    await db.execute("ALTER TABLE predictions ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0")

    # 4. 有数据 → 创建默认用户并回填（v0.13.0 修 F1：口令不落明文于源码——
    #    优先取配置的环境变量；未配置时生成一次性口令并打印到日志一次）
    if has_data:
        migration_password = config.MIGRATION_PASSWORD
        if migration_password is None:
            migration_password = secrets.token_urlsafe(16)
            password_file = _migration_password_file_path()
            logger.info(
                "v0.13.0 修 F1 / v0.14.0 修 DN-3: 迁移创建默认用户的"
                "一次性初始口令（未设置 MENSTRUAL_MIGRATION_PASSWORD）: %s —— "
                "请登录后立即轮换；同一口令已尝试落盘到本机口令文件: %s",
                migration_password, password_file,
            )
            # v0.14.0 修 DN-3：日志只打印一次且易被淹没 → 额外落盘（不覆盖既有文件）
            _write_migration_password_file(migration_password)
        # v0.13.0 修 B+2：600k 迭代哈希移出事件循环（asyncio.to_thread，与 auth.py F4 同款）
        hashed = await asyncio.to_thread(hash_password, migration_password)
        cursor = await db.execute(
            "INSERT INTO users (username, password_hash) VALUES (?, ?)",
            (config.MIGRATION_DEFAULT_USERNAME, hashed),
        )
        owner_id = cursor.lastrowid
        await cursor.close()  # P3 修复：游标用完即关，不把未关游标留到事务收尾
        logger.info("迁移：已创建默认用户（id=%s），存量数据归入该用户", owner_id)
    else:
        owner_id = None
        logger.info("迁移：空库，不创建默认用户")

    if owner_id is not None:
        await db.execute("UPDATE cycles SET user_id = ? WHERE user_id = 0", (owner_id,))
        await db.execute("UPDATE predictions SET user_id = ? WHERE user_id = 0", (owner_id,))
        await db.execute("UPDATE model_params SET user_id = ? WHERE user_id = 0", (owner_id,))
        await db.execute("UPDATE app_settings SET user_id = ? WHERE user_id = 0", (owner_id,))

    await db.execute(
        "CREATE INDEX IF NOT EXISTS idx_cycles_user ON cycles(user_id, period_start DESC)"
    )
    await db.execute(
        "CREATE INDEX IF NOT EXISTS idx_pred_user ON predictions(user_id, created_at DESC)"
    )


async def init_db() -> None:
    """初始化数据库：执行全部 DDL 建表 + v1→v2 迁移 + v2→v3 迁移（均幂等）。

    幂等：可重复执行，IF NOT EXISTS 保证不重建已有表；迁移分别以
    user_id 列存在性（v2）与外键/expires_at 存在性（v3）为闸门。

    P1 修复（迁移原子性）：DDL + 全部迁移 + 索引创建包进**一个显式事务**
    （``BEGIN IMMEDIATE`` … ``COMMIT``，异常 ``ROLLBACK`` 后原样上抛）。旧实现
    里 DDL 处于自动提交态、唯一 commit 在最后——中途崩溃/异常会留下半迁移状态
    （旧表已 RENAME 走、新表空，或数据滞留 ``*_v2_rebuild`` 静默不可见），重跑
    迁移即报 "already another table"，应用永久无法启动。单事务后要么全部生效、
    要么全部回退，幂等闸门保证重跑必然安全。

    两个 PRAGMA 必须留在事务外（顺序不可动）：journal_mode 在事务内不可切换；
    foreign_keys 在事务内是 no-op（开了也不生效），必须在无事务时设置。
    已核：三个迁移函数内部均无自己 commit 的语句（全靠本函数收尾）。
    """
    db_path = _get_db_path()
    async with aiosqlite.connect(db_path) as db:
        # 开启 WAL 模式（并发纪律：WAL 提升并发读写）
        await db.execute("PRAGMA journal_mode=WAL")
        # 外键约束开启
        await db.execute("PRAGMA foreign_keys=ON")
        # BEGIN IMMEDIATE：立即取保留写锁再动库，整个建表/迁移序列对外原子
        await db.execute("BEGIN IMMEDIATE")
        try:
            for stmt in DDL_STATEMENTS:
                await db.execute(stmt)
            # user_id 索引在迁移后统一创建（迁移前旧表无 user_id 列，DDL 阶段创建会失败）
            await _migrate_v1(db)
            # app_settings 空壳化（v1→v2 后 / 既有 v2 库；须在 governance 之前——
            # 后者的列清单与 _TBL_APP_SETTINGS 同源，先收敛到空壳避免 INSERT 旧列）
            await _migrate_v3_app_settings_shell(db)
            # v0.13.1 修 G4/G7：v2 → v3（业务表外键 + sessions.expires_at；幂等）
            await _migrate_v3_governance(db)
            # 2026-10-31 #14/#15：mood_tags 列 + 旧 mood_note → daily_journal（一次性）
            await _migrate_v4_journal(db)
            await db.execute(
                "CREATE INDEX IF NOT EXISTS idx_cycles_user ON cycles(user_id, period_start DESC)"
            )
            await db.execute(
                "CREATE INDEX IF NOT EXISTS idx_pred_user ON predictions(user_id, created_at DESC)"
            )
            await db.execute("COMMIT")
        except BaseException:
            # 捕 BaseException：asyncio 取消（CancelledError 继承 BaseException）同样
            # 落在这里——半迁移状态比异常本身更危险，必须先回滚再上抛
            await db.execute("ROLLBACK")
            raise
    logger.info("数据库初始化完成: %s", db_path)


async def _has_users_fk(db, table: str) -> bool:
    """探测表是否已带指向 users 的外键（PRAGMA foreign_key_list，v3 迁移闸门）。"""
    cursor = await db.execute(f"PRAGMA foreign_key_list({table})")
    rows = await cursor.fetchall()
    await cursor.close()
    return any(r[2] == "users" for r in rows)


async def _count_orphans(db, table: str) -> int:
    """统计表中 user_id 无对应 users 行的孤儿记录数（v3 迁移守卫）。"""
    cursor = await db.execute(
        f"SELECT COUNT(*) FROM {table} WHERE user_id NOT IN (SELECT id FROM users)"
    )
    row = await cursor.fetchone()
    await cursor.close()
    return int(row[0])


async def _rebuild_table_with_fk(db, table: str, create_body: str,
                                 columns: list[str], extra_select: str | None = None) -> bool:
    """以带外键的新定义重建表（RENAME → CREATE → INSERT SELECT → DROP）。

    v0.13.1 修 G7：SQLite 无法 ALTER 添加外键，走重建。索引随旧表 DROP，
    调用方（_migrate_v3_governance）在全部重建后统一补建。
    extra_select 非空时，其 SELECT 列直接替代 columns 的末列
    （sessions 重建时用它给存量行回填 expires_at）。

    Returns:
        True 表示执行了重建；False 表示无需（调用方先以 _has_users_fk 判定）。
    """
    tmp = f"{table}_v2_rebuild"
    await db.execute(f"ALTER TABLE {table} RENAME TO {tmp}")
    await db.execute(f"CREATE TABLE {table} {create_body}")
    if extra_select is not None:
        select_cols = ", ".join(columns[:-1]) + ", " + extra_select
    else:
        select_cols = ", ".join(columns)
    await db.execute(
        f"INSERT INTO {table} ({', '.join(columns)}) SELECT {select_cols} FROM {tmp}"
    )
    await db.execute(f"DROP TABLE {tmp}")
    return True


async def _migrate_v3_app_settings_shell(db) -> None:
    """app_settings → 空壳形迁移（R1-A；用户 2026-09-18 裁定）。

    闸门：表中仍存在 notify_enabled 列（v1→v2 产物 / 既有 v2 库）。
    做法：沿用既有「重建表」四步（RENAME → CREATE 新形 → INSERT 搬
    user_id/updated_at → DROP 旧表），与 _migrate_v1 处理 app_settings
    的手法一致；新表定义与 DDL 共用 _TBL_APP_SETTINGS。
    幂等：闸门不成立时直接返回，不做任何事。
    守卫：存在 user_id 孤儿行时跳过并记 error（与 _migrate_v3_governance 同款，
    跳过优于 FK 插入失败导致整次 init_db 中断）。
    """
    columns = await _table_columns(db, "app_settings")
    if "notify_enabled" not in columns:
        return  # 已是空壳形（或全新库），幂等返回

    # ⚠️ 破坏性行为登记（安全优先红线）：本迁移**会丢弃** user_id 孤儿行。
    # 旧实现在此处直接 return（整表跳过），实测后果是：空 v1 库（_migrate_v1 因
    # has_data=False 不创建默认用户）会留下 user_id=0 的孤儿行，三列永久残留——
    # 因为真实库 app_settings 已带 users 外键，_migrate_v3_governance 也会跳过它，
    # 没有任何一方能收敛到空壳。空壳表只承载 (user_id, updated_at)，user_id 指向
    # 不存在用户的行不含任何用户数据（实测该行值恒为默认 1/3/'auto'），故丢弃无信息损失。
    orphans = await _count_orphans(db, "app_settings")
    tmp = "app_settings_v3shell"
    await db.execute(f"ALTER TABLE app_settings RENAME TO {tmp}")
    await db.execute(f"CREATE TABLE app_settings {_TBL_APP_SETTINGS}")
    if orphans:
        logger.warning(
            "app_settings 空壳迁移：丢弃 %s 行 user_id 孤儿记录"
            "（无对应 users 行；空壳表不含业务数据，丢弃无信息损失）", orphans,
        )
    await db.execute(
        "INSERT INTO app_settings (user_id, updated_at) "
        f"SELECT user_id, updated_at FROM {tmp} "
        "WHERE user_id IN (SELECT id FROM users)"
    )
    await db.execute(f"DROP TABLE {tmp}")
    logger.info("app_settings 空壳迁移完成（移除 notify_enabled/notify_days/theme）")


async def _migrate_v3_governance(db) -> None:
    """v2 → v3 治理迁移（v0.13.1 修 G4/G7；幂等）。

    内容：
    1. G7：cycles / predictions / model_params / app_settings / sessions 的
       user_id 列补 REFERENCES users(id) ON DELETE CASCADE（SQLite 无法 ALTER
       加外键，逐表重建；表定义与 DDL 共用 _TBL_* 单一来源）。
    2. G4：sessions 补 expires_at 列，存量行按「迁移时刻 + SESSION_TTL_DAYS」
       回填（一次性把永久会话收敛为 30 天有效期）。

    守卫：任一表存在孤儿 user_id（无对应 users 行）时跳过该表并记 error
    （理论上不可能——v1→v2 迁移已把存量数据回填默认用户；跳过优于损坏）。
    幂等：外键已存在 / expires_at 已存在 则该表不动。
    """
    rebuilt: list[str] = []

    # ---- 业务四表：补外键 ----
    for table, create_body, columns in (
        ("cycles", _TBL_CYCLES,
         ["id", "user_id", "period_start", "period_end", "cycle_length",
          "period_days", "note", "is_anomalous", "created_at"]),
        ("predictions", _TBL_PREDICTIONS,
         ["id", "user_id", "predicted_date", "predicted_start_upper", "predicted_start_lower",
          "confidence", "model_version", "model_params_json", "actual_date", "error_days",
          "created_at"]),
        ("model_params", _TBL_MODEL_PARAMS,
         ["user_id", "mean_cycle", "std_cycle", "n_records", "ema_cycle",
          "prior_mean", "prior_std", "prior_weight", "updated_at"]),
        ("app_settings", _TBL_APP_SETTINGS,
         ["user_id", "updated_at"]),  # R1-A：空壳形（shell 迁移后才到这里）
    ):
        if await _has_users_fk(db, table):
            continue
        if await _count_orphans(db, table) > 0:
            logger.error("v3 迁移跳过 %s：存在 user_id 孤儿行（无对应 users 行）", table)
            continue
        await _rebuild_table_with_fk(db, table, create_body, columns)
        rebuilt.append(table)

    # ---- sessions：外键 + expires_at（一次重建完成两件事）----
    sessions_cols = await _table_columns(db, "sessions")
    if "expires_at" not in sessions_cols or not await _has_users_fk(db, "sessions"):
        if await _count_orphans(db, "sessions") > 0:
            logger.error("v3 迁移跳过 sessions：存在 user_id 孤儿行")
        else:
            # 存量行 expires_at = 迁移时刻 + SESSION_TTL_DAYS（SQLite 参数化修饰符）
            await _rebuild_table_with_fk(
                db, "sessions", _TBL_SESSIONS,
                ["token", "user_id", "created_at", "expires_at"],
                extra_select=f"datetime('now', '+{config.SESSION_TTL_DAYS} days')",
            )
            rebuilt.append("sessions")

    # ---- 重建的表统一补建索引（索引随旧表 DROP）----
    if "cycles" in rebuilt:
        await db.execute(
            "CREATE INDEX IF NOT EXISTS idx_cycles_start ON cycles(period_start DESC)"
        )
    if "predictions" in rebuilt:
        await db.execute(
            "CREATE INDEX IF NOT EXISTS idx_pred_date ON predictions(created_at DESC)"
        )
    if "sessions" in rebuilt:
        await db.execute(
            "CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)"
        )
    if rebuilt:
        logger.info("v3 治理迁移完成（重建表：%s）", ", ".join(rebuilt))


async def _migrate_v4_journal(db) -> None:
    """v3 → v4（#14/#15）：daily_records 补 mood_tags 列，并把旧 mood_note 一次性迁入 daily_journal。

    闸门：daily_records 已有 mood_tags 列即跳过（全新库的 DDL 已带该列；老库只走一次）。
    这样用户之后删除的日记不会在下次启动时被旧 mood_note “复活”。
    迁移规则：
    - 只迁 strip() 后非空的 mood_note；原文不 trim，超 DAILY_NOTE_MAX_CHARS 码点的残留数据截断
      （正常数据在写入时已 ≤300，截断只是防止 CHECK 失败导致整次启动中断）；
    - created_at/updated_at 沿用原行；INSERT OR IGNORE（daily_journal 刚建必为空，审计用防重）；
    - **不清空不删除 mood_note 列**（非破坏，回滚即部署旧版；列的读写口径见 _TBL_DAILY_RECORDS 注释）。
    在 init_db 的单事务内运行，失败整体回滚（列与迁移同生同灭）。
    """
    if "mood_tags" in await _table_columns(db, "daily_records"):
        return
    await db.execute("ALTER TABLE daily_records ADD COLUMN mood_tags TEXT NOT NULL DEFAULT '[]'")
    cursor = await db.execute(
        "SELECT user_id, record_date, mood_note, created_at, updated_at FROM daily_records "
        "WHERE mood_note IS NOT NULL"
    )
    rows = await cursor.fetchall()
    await cursor.close()
    moved = 0
    for user_id, record_date, note, created_at, updated_at in rows:
        if not isinstance(note, str) or not note.strip():
            continue
        await db.execute(
            "INSERT OR IGNORE INTO daily_journal (user_id, record_date, note, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (user_id, record_date, note[:config.DAILY_NOTE_MAX_CHARS], created_at, updated_at),
        )
        moved += 1
    logger.info("v4 迁移完成：mood_tags 列已补建，%d 条旧 mood_note 迁入 daily_journal", moved)


async def get_connection() -> aiosqlite.Connection:
    """获取一个数据库连接（需调用方管理生命周期，推荐用 async with）。

    返回的连接已开启 WAL、外键约束与 busy_timeout。
    """
    db_path = _get_db_path()
    db = await aiosqlite.connect(db_path)
    await db.execute("PRAGMA journal_mode=WAL")
    await db.execute("PRAGMA foreign_keys=ON")
    # P2 修复：外部工具（备份脚本/DB 浏览器）短暂持有写锁时，本应用写操作等待
    # 5s 重试而非立即 "database is locked"。写路径（WriteLock）与读池连接
    # （_open_read_connection 也走本函数）由此一处全部覆盖。
    await db.execute("PRAGMA busy_timeout=5000")
    # Row factory：按列名访问（dict 风格）
    db.row_factory = aiosqlite.Row
    return db


class WriteLock:
    """写操作上下文管理器：自动加锁 + 提交 + 关闭连接。

    使用方式：
        async with WriteLock() as db:
            await db.execute("INSERT ...", params)
            # 自动提交 + 释放锁

    v0.12.0 修 E6（重入防护）：asyncio.Lock **不可重入**。同一任务在持有写锁的
    ``async with WriteLock()`` 块内再次进入（直接嵌套或经由 crud 写函数内部的
    write_query/insert_row 间接嵌套）会永久死锁——历史上只靠「块内只用裸 SQL」
    的口头约定规避。现在显式检测同任务重入并抛 RuntimeError（快速失败），
    正确写法是把内层写操作改为使用外层传入的 db 连接（crud 写函数均支持
    ``db=`` 参数，见 E7 事务化改造）。
    """

    def __init__(self) -> None:
        self._db: aiosqlite.Connection | None = None

    async def __aenter__(self) -> aiosqlite.Connection:
        global _write_lock_holder
        task = asyncio.current_task()
        if _write_lock.locked() and _write_lock_holder is task:
            raise RuntimeError(
                "WriteLock 不可重入：同一任务在持有写锁时再次进入将永久死锁。"
                "请将内层写操作改为使用外层传入的 db 连接（crud 函数的 db 参数）。"
            )
        await _write_lock.acquire()
        _write_lock_holder = task
        try:
            self._db = await get_connection()
            return self._db
        except Exception:
            _write_lock_holder = None
            _write_lock.release()
            raise

    async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        global _write_lock_holder
        # v0.13.0 修 F9：commit/rollback 抛异常不跳过 close（连接不泄漏）。
        # 内层 try/finally 保证无论提交/回滚是否成功，close() 都必然执行，杜绝连接句柄泄漏。
        try:
            if self._db is not None:
                try:
                    if exc_type is None:
                        await self._db.commit()
                    else:
                        await self._db.rollback()
                finally:
                    await self._db.close()
        finally:
            _write_lock_holder = None
            _write_lock.release()


async def read_query(sql: str, params: tuple = ()) -> list[aiosqlite.Row]:
    """执行只读查询，返回所有行。

    v0.13.1 修 G15：经读连接池执行（成功回池复用；失败丢弃该连接并原样上抛）。
    v0.14.0 修 DN-1(2)(3)：**所有异常路径一律不回池**——包括 `cursor.close()`
    自身抛错、以及 `execute` 成功但 `fetchall` 抛错；游标在异常路径上尽力关闭
    （即便关闭也失败，连接会被 _discard_read 关闭，游标随连接一并释放）。

    Args:
        sql: SQL 查询语句（必须用 ? 占位符，防注入）。
        params: 参数元组。
    """
    path, db = await _acquire_read()
    cursor = None
    try:
        cursor = await db.execute(sql, params)
        rows = await cursor.fetchall()
        await cursor.close()
        cursor = None
    except Exception:
        if cursor is not None:
            try:
                await cursor.close()
            except Exception:  # noqa: BLE001 关闭失败不掩盖原始异常
                pass
        await _discard_read(db)
        raise
    await _release_read(path, db)
    return rows


async def read_one(sql: str, params: tuple = ()) -> aiosqlite.Row | None:
    """执行只读查询，返回单行。

    v0.13.1 修 G15：经读连接池执行（成功回池复用，返回 aiosqlite.Row，可按列名访问）。
    v0.14.0 修 DN-1(2)(3)：异常路径一律不回池、游标尽力关闭，语义同 read_query。
    """
    path, db = await _acquire_read()
    cursor = None
    try:
        cursor = await db.execute(sql, params)
        row = await cursor.fetchone()
        await cursor.close()
        cursor = None
    except Exception:
        if cursor is not None:
            try:
                await cursor.close()
            except Exception:  # noqa: BLE001 关闭失败不掩盖原始异常
                pass
        await _discard_read(db)
        raise
    await _release_read(path, db)
    return row


# ============================================================
# v0.13.1 修 G15：读连接池（路径键控）
# 旧实现每次 read_query/read_one 都「连接 → 2×PRAGMA → 查询 → 关闭」，
# 每请求数次读的连接开销纯属浪费。池化后读连接复用（上限 4 条）：
# - 键控：池项带「打开时的库路径」，与当前 config.DB_ABS_PATH 不符的陈旧连接
#   （测试/审计切换临时库）随手关闭丢弃，绝不串库；
# - 失败安全：execute 抛异常（连接损坏/库文件被换）→ 丢弃该连接并原样上抛，
#   下次调用自动新建；
# - 写路径（WriteLock）不池化：写是低频用户操作，保持每事务独立连接的
#   强隔离语义（commit 后即关，WAL checkpoint 不受长连接牵制）。
#
# v0.14.0 修 DN-1（池正确性与生命周期，审计 M1）：
# 1. 池项路径标签改为「建连前同步捕获 + 建连后复核」（见 _open_read_connection）：
#    旧实现在 _release_read 里用「回池时刻」的 config.DB_ABS_PATH 打标签——若一次读
#    期间库路径被改写（测试/审计切换临时库），旧库连接会被贴上「新库路径」标签长期
#    留在池里，后续读即跨库串读（这是 DN-1 里真实存在的窗口，见 _acquire_read docstring）；
# 2. _acquire_read / close_read_pool 一律「整池原子摘取（同步解包赋值，中间无 await）
#    再逐项处理」：旧实现边 pop 边 await 关陈旧连接虽无「同连接双协程并用」窗口，
#    但「池状态在 await 期间被其它协程改写」使正确性依赖逐点推演；原子摘取把
#    「不在 await 期间触碰仍在池中的项」变成结构性保证；
# 3. 异常路径一律 _discard_read（不回池），游标尽力关闭；
# 4. 回池前显式确认无未结束事务（发现即 rollback，只读路径**绝不 commit**——
#    不给只读路径引入写锁竞争；回滚/状态检查失败即丢弃连接）；
# 5. close_read_pool 循环「摘取 → 关闭」直至摘到空池，返回时池必为空且池内连接全关。
# ============================================================

_READ_POOL_MAX = 4
_read_pool: list[tuple[str, aiosqlite.Connection]] = []


async def _open_read_connection() -> tuple[str, aiosqlite.Connection]:
    """新建一条读连接，返回 ``(建连时的库路径, 连接)``。

    v0.14.0 修 DN-1(1)：池项标签必须与「该连接实际打开的库」一致。路径在建连前
    同步捕获、建连后复核——config.DB_ABS_PATH 在进程内不可变（只有测试/审计会用
    monkeypatch 改写），若复核发现它在 await 期间被改写，本次连接的标签即不可信，
    丢弃重试（最多 2 次），从源头杜绝「旧库连接贴上新区路径标签」的跨库串读。
    """
    for _ in range(2):
        path = str(config.DB_ABS_PATH)
        conn = await get_connection()
        if str(config.DB_ABS_PATH) == path:
            return path, conn
        await _discard_read(conn)  # 建连期间库路径被改写：本次连接弃用
    return str(config.DB_ABS_PATH), await get_connection()


async def _acquire_read() -> tuple[str, aiosqlite.Connection]:
    """从池中取「当前库路径」匹配的连接（无则新建），返回 ``(路径标签, 连接)``。

    v0.14.0 修 DN-1(1) 并发推演（单线程 asyncio：协程只在 await 处让出执行权）：
    - 旧实现 ``while _read_pool: path, conn = _read_pool.pop()`` 中「非空检查 + pop」
      之间没有 await，是不可分割的同步序列；被弹出的连接已不在池中，其它协程再
      pop 也拿不到它 —— 因此**不存在**「同一连接被两个协程同时使用」的真实窗口；
    - 但旧实现在 ``await conn.close()``（丢弃陈旧路径连接）处停留，期间其它协程的
      pop/append 会改写池内容，「谁在什么时候碰了池里的哪一项」需要逐点推理。
    v0.14.0 改为**整池原子摘取**（``pool, _read_pool = _read_pool, []``，同步、无 await
    间隙）再逐项处理：await 期间池里只可能有此后新回池的连接，绝不会被本次清理误关，
    「不在 await 期间触碰仍在池中的项」成为结构性保证（防未来改动退化）。
    复用顺序保持 LIFO（最近回池者优先），与旧 pop() 语义一致。
    """
    global _read_pool
    # 整池原子摘取：解包赋值是同步字节码序列，中间没有 await，池即刻变空
    pool, _read_pool = _read_pool, []
    current = str(config.DB_ABS_PATH)
    matched: aiosqlite.Connection | None = None
    keep: list[tuple[str, aiosqlite.Connection]] = []
    stale: list[aiosqlite.Connection] = []
    for entry in reversed(pool):  # LIFO：最近回池的连接优先复用（同旧 pop()）
        path, conn = entry
        if path != current:
            stale.append(conn)  # 陈旧路径连接：关闭丢弃，绝不串库
        elif matched is None:
            matched = conn  # 交给调用方（已不在池中，其它协程拿不到）
        else:
            keep.append(entry)
    if keep:
        keep.reverse()  # 还原池内原有顺序
        _read_pool.extend(keep)  # 此刻池必为空（摘取后到此处无 await）
    for conn in stale:
        await _discard_read(conn)  # await 期间池内只可能有新回池的连接
    if matched is not None:
        return current, matched
    return await _open_read_connection()


async def _discard_read(conn: aiosqlite.Connection) -> None:
    """关闭并丢弃连接（**绝不回池**）：读失败路径与陈旧路径连接清理共用。

    v0.14.0 修 DN-1(3)：关闭失败只吞掉异常（连接对象随引用消失，绝不复用）。
    """
    try:
        await conn.close()
    except Exception:  # noqa: BLE001
        pass


async def _release_read(path: str, conn: aiosqlite.Connection) -> None:
    """读成功路径：连接回池（超上限则关闭）。

    v0.14.0 修 DN-1(1)：入池标签用调用方传入的「建连时路径」，不再用回池时刻的
    config 路径——后者是跨库串读的根源。
    v0.14.0 修 DN-1(4)：回池前确认连接上没有未结束事务。只读 SQL（SELECT/PRAGMA）
    不产生事务，此处是防御性兜底（例如误用 read_query 执行 DML）：发现事务先
    ``rollback`` 丢弃未提交状态再回池——只读路径**绝不 commit**（不给只读路径引入
    写锁竞争），也绝不把未提交事务及其持有的写锁带进下一次读；状态检查或回滚失败
    （连接已被关闭等）则关闭连接不回池。
    """
    try:
        if conn.in_transaction:
            await conn.rollback()
    except Exception:  # noqa: BLE001 连接不可用/回滚失败：丢弃，不回池
        await _discard_read(conn)
        return
    if len(_read_pool) < _READ_POOL_MAX:
        _read_pool.append((path, conn))
    else:
        await _discard_read(conn)


async def close_read_pool() -> None:
    """关闭池内全部读连接并清空池（应用 shutdown / 测试隔离用）。

    v0.14.0 修 DN-1(5)：每轮「整池原子摘取 + 逐个关闭」，直到某一轮摘到空池才返回
    ——返回时 ``_read_pool`` 必为空、池内连接全部已关闭（await 期间由在途读回池的
    连接由下一轮摘取处理）。调用方（app/main.py lifespan shutdown / conftest 用例
    隔离）保证关池时不再发起新的读，因此循环必然收敛；此后若有在途读回池，其连接
    由下一次关池或进程退出一并回收。
    """
    global _read_pool
    while True:
        pool, _read_pool = _read_pool, []  # 整池原子摘取（同步，无 await 间隙）
        if not pool:
            return
        for _, conn in pool:
            await _discard_read(conn)


async def insert_row(sql: str, params: tuple = ()) -> int:
    """执行 INSERT，返回新行 id（lastrowid）。

    v0.12.0 修 E5：与 write_query 语义拆分——旧 write_query 对 INSERT 返回
    lastrowid、对 UPDATE/DELETE 返回 total_changes 兜底（lastrowid 在非 INSERT
    语句上是残留值，恰好新连接上通常为 None），返回值语义取决于语句类型，
    属潜伏陷阱。拆分后两个函数各只有一种返回语义：
    - insert_row：仅用于 INSERT（含 INSERT OR IGNORE 之外的插入），返回新行 id
    - write_query：仅用于 UPDATE / DELETE / UPSERT（INSERT..ON CONFLICT）/
      INSERT OR IGNORE 等行数敏感语句，返回受影响行数（cursor.rowcount）
    自动加锁、提交、关闭。防 SQL 注入（参数化）。
    """
    async with WriteLock() as db:
        cursor = await db.execute(sql, params)
        row_id = cursor.lastrowid
        await cursor.close()
        return row_id if row_id is not None else 0


async def write_query(sql: str, params: tuple = ()) -> int:
    """执行写操作（UPDATE/DELETE/UPSERT），返回受影响行数（cursor.rowcount）。

    v0.12.0 修 E5：语义单一化，详见 insert_row 的说明。
    """
    async with WriteLock() as db:
        cursor = await db.execute(sql, params)
        n = cursor.rowcount
        await cursor.close()
        return n if n is not None else 0
