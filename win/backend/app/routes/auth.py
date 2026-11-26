# Copyright (c) 2026 Yui_0818 (aaaj6719@gmail.com)
# Licensed under the PolyForm Noncommercial License 1.0.0.
# Commercial use is prohibited without separate written authorization.
# See LICENSE and COMMERCIAL.md in the repository root.

"""auth 路由（v0.11.0 用户管理，早期设计文档）。

端点：
- POST /auth/register: 注册（用户名+口令[+昵称]）→ 自动登录返回 token
- POST /auth/login:    登录 → token（用户名或口令错误统一 401，不泄露具体哪项）
- GET  /auth/me:       当前用户资料（含由生日推算的年龄，后端计算）
- POST /auth/logout:   登出（删除当前会话令牌）
- PUT  /auth/profile:  更新资料（昵称/头像/生日/体重）
- POST /auth/change-password:  修改口令（v0.13.1 修 G5；2026-10-31 #10：成功后全部会话（含当前）失效 + 清持久化槽）
- POST /auth/delete-account:   删除账号及全部数据（v0.13.1 修 G5；口令复核 + 单事务）
- GET/POST/DELETE /auth/persistence: 「保持登录」查询/开启/关闭（2026-10-26 两端对齐 Android）
- POST /auth/relogin:  本机恢复登录（免鉴权；用本机固化凭证换新会话，不参与登录限流）

设计约束（安全纪律）：
- 口令 PBKDF2-HMAC-SHA256（security.hash_password），绝不存明文
- 会话令牌 token_urlsafe(32)，登出即删；有效期 SESSION_TTL_DAYS=30 天 +
  每用户并存上限 10（v0.13.1 修 G4，登录时治理；旧「无自动过期」口径废止）
- 注册后 ensure_user_defaults 建立该用户的 model_params / app_settings 默认行
- 头像为 data URL（前端 canvas 缩到 256px 后上传），校验前缀与大小上限
- v0.14.0 修 EN-1（审计 M5）：login 与 register 两个免鉴权入口都有内存滑动窗口
  限流（login 按用户名、register 按客户端 IP，阈值分别取 _LOGIN_* 与
  config.REGISTER_*），共享同一套有界治理函数 _prune_login_state；
  触发后一律 429 TOO_MANY_ATTEMPTS + Retry-After 头
- 2026-10-26 登录持久化（v0.23.0，两端对齐 Android）：「保持登录」开启 ⇒
  会话 expires_at 写 NULL（永不登出，替代旧 365 天口径）+ {username, password}
  经 DPAPI 加密固化本机槽（services/persistence.py）。口令明文只存在于请求
  处理过程与加密落盘，绝不进日志/响应/导出（审计红线）；登出/改密/删号三处
  按契约联动清槽（登出/改密/删号三处均清槽；2026-10-31 #10 起改密不再重存槽）
"""

import asyncio
import logging
import re
import time
from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status

from app import config
from app.db import crud
from app.db.database import WriteLock
from app.schemas.api import (
    AuthResponse,
    AuthUserResponse,
    ChangePasswordRequest,
    DeleteAccountRequest,
    LoginRequest,
    PersistenceEnableRequest,
    PersistenceStatusResponse,
    ProfileUpdate,
    RegisterRequest,
)
from app.security import (
    dummy_stored_hash,
    generate_token,
    hash_password,
    require_user,
    verify_password,
)
from app.services import persistence

router = APIRouter(prefix="/auth", tags=["auth"])

logger = logging.getLogger(__name__)

_AVATAR_MAX_CHARS = 400_000  # 约 300KB base64（前端已 canvas 压到 256px JPEG）
_AVATAR_PREFIX_RE = re.compile(r"^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$")

# ============================================================
# v0.13.0 修 F2：登录限流——内存滑动窗口（按用户名）
# 15 分钟 5 次失败 → 锁定 5 分钟；锁定期内一律 429 TOO_MANY_ATTEMPTS
# + Retry-After 头；成功登录清零；锁定到期自动解禁。
# v0.13.0 修 B+1：两个模块级字典有界治理（上限常量），防攻击者用海量随机
# 用户名各失败 1-4 次造成无界增长（内存耗尽向量），见 _prune_login_state。
# v0.14.0 修 EN-1（审计 M5）：注册端点复用**同一套**机制与治理函数
# （_register_* 两个字典，键为客户端 IP，阈值/窗口/锁定时长取自
# config.REGISTER_*），不另造一套可能不一致的限流实现。
# ============================================================
_LOGIN_MAX_FAILURES = 5
_LOGIN_WINDOW_SECONDS = 15 * 60
_LOGIN_LOCK_SECONDS = 5 * 60
_LOGIN_STATE_MAX_ENTRIES = 1000      # 限流状态字典治理上限（v0.13.0 修 B+1；
                                     # v0.14.0 修 EN-1：登录/注册四字典共用同一上限）
_login_failures: dict[str, list[float]] = {}      # 用户名 -> 窗口内失败时间戳(monotonic)
_login_locked_until: dict[str, float] = {}        # 用户名 -> 锁到期时间戳(monotonic)
# v0.14.0 修 EN-1：注册限流状态（与登录同款结构；注册无稳定用户标识，键=客户端 IP）
_register_failures: dict[str, list[float]] = {}   # 客户端 IP -> 窗口内失败时间戳(monotonic)
_register_locked_until: dict[str, float] = {}     # 客户端 IP -> 锁到期时间戳(monotonic)


def reset_login_rate_limit() -> None:
    """清空登录**与注册**限流状态（测试隔离用；v0.13.0 修 F2；v0.14.0 修 EN-1 扩展）。

    函数名保持不变（backend/tests/conftest.py 的每用例清库路径调用它），行为
    扩展为同时清空注册的两个字典：两者都是模块级内存状态，若不同步清空，
    前一个用例残留的注册失败计数/锁定会污染后一个用例（跨用例假 429）。
    """
    _login_failures.clear()
    _login_locked_until.clear()
    _register_failures.clear()
    _register_locked_until.clear()


def _prune_rate_limit_state(
    failures: dict[str, list[float]],
    locked_until: dict[str, float],
    now: float,
    window_seconds: float,
) -> None:
    """限流状态通用治理：过期清理 + 超上限淘汰（v0.13.0 修 B+1；v0.14.0 修 EN-1 抽通用）。

    /auth/login 与 /auth/register 均免鉴权：攻击者可对海量随机用户名（登录）
    或海量伪造来源（注册）各失败 1 次（永不触发锁定、永不成功），若仅靠
    成功/锁定/到期清理，模块级字典将无界增长（内存耗尽向量）。仅在失败路径调用：
    a) 先删「窗口内已无失败时间戳」的过期条目与已到期锁定；
    b) 仍超上限（_LOGIN_STATE_MAX_ENTRIES，登录/注册四字典共用）则按
       「最近失败时间」淘汰最旧条目；
    c) 锁定字典同样治理，按到期时间淘汰最早的锁。
    调用方传入的键（刚追加的失败时间戳最新 / 刚设置的锁到期最晚）不可能被选中。
    """
    window_cutoff = now - window_seconds

    # a) 过期条目：失败窗口外 / 锁定已到期
    for key in [k for k, fails in failures.items()
                if not any(t > window_cutoff for t in fails)]:
        failures.pop(key, None)
    for key in [k for k, until in locked_until.items() if until <= now]:
        locked_until.pop(key, None)

    # 上限常量按调用时读取模块全局（测试用 monkeypatch 压小以快速验证治理）
    max_entries = _LOGIN_STATE_MAX_ENTRIES

    # b/c) 仍超上限才排序淘汰（正常量级下零开销；排序以「最近失败时间」为键）
    def _latest_fail(key: str) -> float:
        fails = failures[key]
        return max(fails) if fails else 0.0

    if len(failures) > max_entries:
        overflow = len(failures) - max_entries
        for key in sorted(failures, key=_latest_fail)[:overflow]:
            failures.pop(key, None)
    if len(locked_until) > max_entries:
        overflow = len(locked_until) - max_entries
        for key in sorted(locked_until, key=locked_until.__getitem__)[:overflow]:
            locked_until.pop(key, None)


def _prune_login_state(now: float) -> None:
    """失败路径上的 opportunistic 治理入口（v0.13.0 修 B+1）。

    v0.14.0 修 EN-1：注册限流的两个字典与登录的一并治理（同一实现，仅窗口
    常量不同）——攻击者用海量不同 IP/伪造来源刷注册同样不能让内存无界增长。
    """
    _prune_rate_limit_state(
        _login_failures, _login_locked_until, now, _LOGIN_WINDOW_SECONDS
    )
    _prune_rate_limit_state(
        _register_failures, _register_locked_until, now, config.REGISTER_WINDOW_SECONDS
    )


def _client_key(request: Request) -> str:
    """注册限流键：客户端 IP（v0.14.0 修 EN-1）。

    注册没有稳定的用户标识（用户名正是可被枚举/伪造的输入），故用「客户端 IP」
    作键，等价于本地单机应用下的**全局注册频率上限**——本地直连时所有请求 IP
    基本一致（不会按用户隔离），这正是本次想收敛的写入面：注册免鉴权且会写
    users 表，可被本地进程刷量写入。

    局限（如实登记）：
    - 反的是「刷量写库」，不是「按用户暴力破解」；同机多用户共享一个配额。
    - request.client 可能为 None（测试传输/非 HTTP 直连未提供 client 字段）
      → 兜底 "unknown"，同一兜底键仍受限（不放行）。
    - **不信任 X-Forwarded-For / X-Real-IP**：本地直连场景没有中间代理，
      信任客户端可控的请求头等于给攻击者一个「换个头就绕过限流」的开关
      （本地单机威胁模型；不引入与既有模型冲突的设计）。
    """
    client = request.client
    host = getattr(client, "host", None) if client is not None else None
    return host or "unknown"


def _record_register_failure(client_key: str, now: float) -> None:
    """记一次注册失败并推进滑动窗口（v0.14.0 修 EN-1）。

    仅保留 config.REGISTER_WINDOW_SECONDS 窗口内的时间戳；达阈值
    config.REGISTER_MAX_FAILURES → 锁定该键 config.REGISTER_LOCK_SECONDS
    （与 login 同款：达阈值那一次仍按原错误返回，下一次起 429）。
    随后做 opportunistic 治理（本键时间戳最新或已移入锁定字典，不受淘汰影响）。
    """
    cutoff = now - config.REGISTER_WINDOW_SECONDS
    fails = [t for t in _register_failures.get(client_key, []) if t > cutoff]
    fails.append(now)
    _register_failures[client_key] = fails
    if len(fails) >= config.REGISTER_MAX_FAILURES:
        _register_locked_until[client_key] = now + config.REGISTER_LOCK_SECONDS
        _register_failures.pop(client_key, None)
    _prune_login_state(now)


def _compute_age(birthday: Optional[str]) -> Optional[int]:
    """由生日推算年龄（后端计算，前端只展示——前端不算指标）。"""
    if not birthday:
        return None
    try:
        b = date.fromisoformat(birthday)
    except ValueError:
        return None
    today = date.today()
    return today.year - b.year - ((today.month, today.day) < (b.month, b.day))


def _user_payload(user: dict) -> dict:
    """users 行 → 对外 user 对象（不含 password_hash）。"""
    return {
        "id": user["id"],
        "username": user["username"],
        "nickname": user.get("nickname"),
        "avatar": user.get("avatar"),
        "birthday": user.get("birthday"),
        "weight_kg": user.get("weight_kg"),
        "age": _compute_age(user.get("birthday")),
        "created_at": user.get("created_at"),
    }


async def _register_session(user: dict, persistent: bool = False) -> AuthResponse:
    """为用户创建会话并构造 AuthResponse。

    2026-10-26 登录持久化：persistent=true（仅 login 的「保持登录」路径传入；
    注册恒为缺省 false）⇒ 会话 expires_at 写 NULL（永不登出）；否则 30 天。
    槽固化在 login 端点内完成（需要本次口令），本层只管会话生命周期。
    """
    token = generate_token()
    await crud.create_session(token, user["id"], persistent=persistent)
    return AuthResponse(token=token, user=AuthUserResponse(**_user_payload(user)))


@router.post("/register", response_model=AuthResponse, status_code=status.HTTP_201_CREATED)
async def register(body: RegisterRequest, request: Request) -> AuthResponse:
    """注册新用户（用户名唯一）并自动登录。

    v0.11.1：并发注册同名用户时 UNIQUE 约束兜底——先查后插存在竞态窗口，
    IntegrityError 一律转 409 USERNAME_TAKEN（不允许 500 泄露为服务器错误）。

    v0.14.0 修 EN-1（审计 M5）：本端点免鉴权且会写 users 表，属可被本地进程
    刷量写入的入口，现补上与 /auth/login **同款**的内存滑动窗口限流（复用同一
    治理函数 _prune_login_state/_prune_rate_limit_state，不另造机制）：
    - 键：客户端 IP（request.client.host；None → "unknown"，见 _client_key）。
      注册没有稳定用户标识，故作此选择；局限是本地单机应用下所有请求 IP 基本
      一致，因此实际等价于**全局注册频率上限**（不按用户隔离）——这正是本次
      要收敛的写入面，而非按用户反暴力破解。
    - 计失败的路径：**用户名已占用**（先查命中，以及插入撞 UNIQUE 的竞态兜底）
      都计入——已占用是刷量的主路径；若不计入，攻击者可枚举已存在用户名无限
      绕过限流。口令/用户名的 422 校验失败（pydantic 层）不进入本函数，不计入。
    - 成功注册清零该键的失败计数与锁定；达 config.REGISTER_MAX_FAILURES →
      锁定 config.REGISTER_LOCK_SECONDS，锁定期内一律 429 TOO_MANY_ATTEMPTS
      + Retry-After 头（与 login 同一错误契约）。
    - 阈值口径权衡（config.REGISTER_* 注释同步登记）：审计工具
      （早期前端测试脚本）每次运行都用同一 IP 注册一次
      s7user 且不重启后端，限流状态跨运行累积；阈值留足余量（10 分钟内 20 次
      失败才锁 5 分钟）以保证审计可重复运行，同时仍收敛刷量写入面。
    """
    import sqlite3

    now = time.monotonic()
    client_key = _client_key(request)

    # 锁定期检查：未到期一律 429（即便用户名可用），并带 Retry-After 秒数
    until = _register_locked_until.get(client_key)
    if until is not None:
        if now < until:
            retry_after = max(1, int(until - now) + 1)
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail={"detail": "注册尝试次数过多，请稍后再试", "code": "TOO_MANY_ATTEMPTS"},
                headers={"Retry-After": str(retry_after)},
            )
        # 锁定到期：解禁并重置该键状态
        _register_locked_until.pop(client_key, None)
        _register_failures.pop(client_key, None)

    existing = await crud.get_user_by_username(body.username)
    if existing is not None:
        # 已占用计入失败（刷量主路径）；达阈值后本次仍按 409 语义返回
        _record_register_failure(client_key, now)
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"detail": "用户名已被占用", "code": "USERNAME_TAKEN"},
        )
    try:
        # v0.13.0 修 F4：hash 移出事件循环（asyncio.to_thread，防阻塞）
        hashed = await asyncio.to_thread(hash_password, body.password)
        user_id = await crud.create_user(
            body.username, hashed, body.nickname or body.username
        )
    except sqlite3.IntegrityError:
        # 竞态兜底：与「先查命中」同计一次失败（v0.14.0 修 EN-1）
        _record_register_failure(client_key, now)
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"detail": "用户名已被占用", "code": "USERNAME_TAKEN"},
        )
    # 成功注册：清零该键的失败计数与锁定（v0.14.0 修 EN-1）
    _register_failures.pop(client_key, None)
    _register_locked_until.pop(client_key, None)
    await crud.ensure_user_defaults(user_id)
    user = await crud.get_user_by_id(user_id)
    return await _register_session(user)


@router.post("/login", response_model=AuthResponse)
async def login(body: LoginRequest) -> AuthResponse:
    """登录（用户名或口令错误统一 401 AUTH_FAILED，不泄露具体哪项错误）。

    v0.13.0 修 F2：按用户名内存滑动窗口限流（15 分钟 5 次失败 → 锁 5 分钟）；
    锁定期内一律 429 TOO_MANY_ATTEMPTS + Retry-After 头；成功登录清零；
    用户不存在时对固定垃圾串执行同成本哑校验（时间拉平，防用户名枚举）。
    """
    now = time.monotonic()

    # 锁定期检查：未到期一律 429（即便口令正确），并带 Retry-After 秒数
    until = _login_locked_until.get(body.username)
    if until is not None:
        if now < until:
            retry_after = max(1, int(until - now) + 1)
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail={"detail": "登录失败次数过多，请稍后再试", "code": "TOO_MANY_ATTEMPTS"},
                headers={"Retry-After": str(retry_after)},
            )
        # 锁定到期：解禁并重置该用户状态
        _login_locked_until.pop(body.username, None)
        _login_failures.pop(body.username, None)

    # v0.13.0 修 F4：verify 移出事件循环；用户不存在时对等成本垃圾串验证（时间拉平）
    user = await crud.get_user_by_username(body.username)
    stored = user["password_hash"] if user is not None else dummy_stored_hash()
    ok = await asyncio.to_thread(verify_password, body.password, stored)

    if user is not None and ok:
        # 成功登录：清零该用户的失败计数与锁定
        _login_failures.pop(body.username, None)
        _login_locked_until.pop(body.username, None)
        # 2026-10-26 登录持久化（两端对齐 Android）：keep_logged_in=true ⇒
        # 先把 {username, password} DPAPI 加密固化到本机槽，会话 expires_at=NULL
        # （永不登出）；固化失败降级普通 30 天会话并记警告，登录照常成功。
        # false ⇒ 照旧 30 天会话，不动槽。
        if body.keep_logged_in:
            saved = await asyncio.to_thread(
                persistence.save_slot, user["username"], body.password
            )
            if saved:
                session = await _register_session(user, persistent=True)
            else:
                logger.warning(
                    "登录持久化：本机固化失败，本次会话降级 %d 天（用户=%s）",
                    config.SESSION_TTL_DAYS, user["username"],
                )
                session = await _register_session(user)
        else:
            session = await _register_session(user)
        # v0.13.1 修 G4：会话治理——清除该用户过期会话 + 只保留最新
        # SESSION_MAX_PER_USER 个（刚创建的本会话 created_at 最新，必在保留集内）
        await crud.prune_user_sessions(user["id"])
        return session

    # 失败：计入滑动窗口（仅保留窗口内时间戳）
    cutoff = now - _LOGIN_WINDOW_SECONDS
    fails = [t for t in _login_failures.get(body.username, []) if t > cutoff]
    fails.append(now)
    _login_failures[body.username] = fails
    if len(fails) >= _LOGIN_MAX_FAILURES:
        _login_locked_until[body.username] = now + _LOGIN_LOCK_SECONDS
        _login_failures.pop(body.username, None)
    # v0.13.0 修 B+1：失败路径上 opportunistic 清理（本用户新失败时间戳最新，
    # 不可能被步骤 b 淘汰，行为对当前用户无影响）
    _prune_login_state(now)
    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail={"detail": "用户名或密码错误", "code": "AUTH_FAILED"},
    )


@router.get("/me", response_model=AuthUserResponse)
async def me(user: dict = Depends(require_user)) -> dict:
    """当前登录用户资料。"""
    return _user_payload(user)


@router.post("/logout")
async def logout(request: Request, user: dict = Depends(require_user)) -> dict:
    """登出：删除当前会话令牌（幂等）。

    2026-10-26：删会话后，本机槽属当前用户则一并清槽——用户主动登出即撤销
    本机免输口令；他账号的槽不动（clear_slot 只清匹配槽）。
    """
    token = getattr(request.state, "session_token", None)
    if token:
        await crud.delete_session(token)
    await asyncio.to_thread(persistence.clear_slot, user["username"])
    return {"message": "已登出", "username": user["username"]}


@router.put("/profile", response_model=AuthUserResponse)
async def update_profile(body: ProfileUpdate, user: dict = Depends(require_user)) -> dict:
    """更新当前用户资料（昵称/头像/生日/体重；仅更新传入字段）。"""
    if body.avatar is not None:
        if len(body.avatar) > _AVATAR_MAX_CHARS or not _AVATAR_PREFIX_RE.match(body.avatar):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={"detail": "头像格式或大小不合法", "code": "INVALID_AVATAR"},
            )
    await crud.update_profile(
        user["id"],
        nickname=body.nickname,
        avatar=body.avatar,
        birthday=body.birthday.isoformat() if body.birthday else None,
        weight_kg=body.weight_kg,
        clear_birthday=body.clear_birthday,
        clear_weight=body.clear_weight,
    )
    updated = await crud.get_user_by_id(user["id"])
    return _user_payload(updated)


@router.post("/change-password")
async def change_password(
    body: ChangePasswordRequest, user: dict = Depends(require_user)
) -> dict:
    """修改口令（v0.13.1 修 G5 新增）。

    - old_password 复核身份（错 → 400 WRONG_PASSWORD；本端点已过鉴权门，
      复核防的是「借到的屏幕/令牌被顺手改密」）
    - 新口令与注册同强度策略（schemas.validate_new_password，弱口令 → 422）
    - 2026-10-31 #10（**行为契约变更**）：成功后**立即登出**——删除该用户全部会话
      （含当前会话，响应返回后当前令牌即失效）并清除本机持久化槽（槽属当前用户才清，
      不再用新口令重存），前端收到 200 后回登录页。旧契约（保留当前会话 + 重存槽）废止。
      清槽失败不阻塞改密：残留的旧槽里是旧口令，下次 relogin 校验失败时会自清（见 /auth/relogin）。
    """
    stored = user["password_hash"]
    ok = await asyncio.to_thread(verify_password, body.old_password, stored)
    if not ok:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"detail": "原密码不正确", "code": "WRONG_PASSWORD"},
        )
    hashed = await asyncio.to_thread(hash_password, body.new_password)
    await crud.update_user_password(user["id"], hashed)
    await crud.delete_all_sessions(user["id"])
    await asyncio.to_thread(persistence.clear_slot, user["username"])
    return {"message": "密码已更新，所有设备已登出，请重新登录"}


@router.post("/delete-account")
async def delete_account(
    body: DeleteAccountRequest, user: dict = Depends(require_user)
) -> dict:
    """删除账号及全部数据（v0.13.1 修 G5 新增）。

    - 口令复核防误删/防偷跑（删除不可恢复）；错 → 400 WRONG_PASSWORD
    - 单 WriteLock 事务：cycles / predictions / model_params / app_settings /
      sessions / users 逐表删除，任一步失败整体回滚（FK CASCADE 为二道防线）
    - 成功后当前令牌随 users/sessions 删除一并失效（前端收到 200 后本地
      清理回登录页）
    - 用 POST + 请求体而非 DELETE + body：规避中间层对 DELETE body 的兼容性边角
    """
    stored = user["password_hash"]
    ok = await asyncio.to_thread(verify_password, body.password, stored)
    if not ok:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"detail": "密码不正确", "code": "WRONG_PASSWORD"},
        )
    async with WriteLock() as db:
        await crud.delete_user_account(user["id"], db=db)
    # 2026-10-26：删号后本机槽属该用户则清槽（账号已不存在，固化凭证必须消失）
    await asyncio.to_thread(persistence.clear_slot, user["username"])
    return {"message": "账号及全部数据已删除"}


# ============================================================
# 登录持久化（2026-10-26 两端同轮对齐 Android；服务实现 services/persistence.py）
# 槽 = 数据目录 login_persistence.json（DPAPI 用户域加密，只存 {username, base64 密文}）。
# 口令明文只存在于请求处理过程与加密落盘，绝不进日志/任何 GET 响应/导出（审计红线）。
# ============================================================

@router.get("/persistence", response_model=PersistenceStatusResponse)
async def get_persistence(user: dict = Depends(require_user)) -> dict:
    """查询本机「保持登录」状态：enabled = 槽存在且槽内用户名 == 当前登录用户名。"""
    return {"enabled": persistence.slot_username() == user["username"]}


@router.post("/persistence", response_model=PersistenceStatusResponse)
async def enable_persistence(
    body: PersistenceEnableRequest, request: Request, user: dict = Depends(require_user)
) -> dict:
    """开启「保持登录」：口令复核 → 固化本机槽 → 当前会话升级为永不登出。

    口令错 → 400 WRONG_PASSWORD（与 change-password 同码同文案）；
    固化失败（DPAPI/写盘不可用）→ 503 PERSISTENCE_UNAVAILABLE（会话不升级）。
    """
    ok = await asyncio.to_thread(verify_password, body.password, user["password_hash"])
    if not ok:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"detail": "密码不正确", "code": "WRONG_PASSWORD"},
        )
    saved = await asyncio.to_thread(persistence.save_slot, user["username"], body.password)
    if not saved:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"detail": "本机加密存储暂不可用，请稍后重试", "code": "PERSISTENCE_UNAVAILABLE"},
        )
    token = getattr(request.state, "session_token", None)
    if token:
        await crud.upgrade_session_persistent(token)
    return {"enabled": True}


@router.delete("/persistence", response_model=PersistenceStatusResponse)
async def disable_persistence(request: Request, user: dict = Depends(require_user)) -> dict:
    """关闭「保持登录」：槽属当前用户则清槽；当前会话降级为 +30 天（幂等）。"""
    await asyncio.to_thread(persistence.clear_slot, user["username"])
    token = getattr(request.state, "session_token", None)
    if token:
        await crud.downgrade_session_ttl(token)
    return {"enabled": False}


@router.post("/relogin", response_model=AuthResponse)
async def relogin() -> AuthResponse:
    """本机恢复登录（免鉴权、空请求体）：用本机固化凭证换发新会话。

    - 无槽 → 401 NO_PERSISTENCE
    - 槽内用户不存在（账号已删）或口令不匹配（他端已改密）→ 清槽 → 401 AUTH_FAILED
    - 成功 → 新发永不登出会话（expires_at=NULL）+ 会话治理（响应与 login 同形）
    - 不参与登录限流：凭证来自设备内固化槽而非请求输入，失败一次即清槽，无爆破面。
    """
    slot = await asyncio.to_thread(persistence.load_slot)
    if slot is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"detail": "本机未开启登录持久化", "code": "NO_PERSISTENCE"},
        )
    username, password = slot
    user = await crud.get_user_by_username(username)
    ok = user is not None and await asyncio.to_thread(
        verify_password, password, user["password_hash"]
    )
    if not ok:
        await asyncio.to_thread(persistence.clear_slot)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"detail": "用户名或密码错误", "code": "AUTH_FAILED"},
        )
    token = generate_token()
    await crud.create_session(token, user["id"], persistent=True)
    await crud.prune_user_sessions(user["id"])
    return AuthResponse(token=token, user=AuthUserResponse(**_user_payload(user)))
