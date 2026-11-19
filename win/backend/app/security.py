"""认证与安全（v0.11.0 用户管理，早期设计文档）。

- 密码哈希：PBKDF2-HMAC-SHA256（600k 迭代 + 16 字节随机盐），存储格式
  ``pbkdf2_sha256$<iterations>$<salt_hex>$<hash_hex>``（自校验格式，算法可平滑升级；
  v0.13.0 修 F4：迭代数自描述，旧哈希按存储串内迭代数仍可验证）。
- 会话令牌：``secrets.token_urlsafe(32)``（256bit 熵），明文存 sessions 表
  （本地单机应用， threat model 不含数据库泄露场景，登记在安全纪律）。
  v0.13.1 修 G4：会话带 SESSION_TTL_DAYS（30 天）有效期 + 每用户并存上限
  （SESSION_MAX_PER_USER=10，登录时治理）——过期/超额会话由
  crud.get_session_user / crud.prune_user_sessions 收敛，require_user 无需改动
  （过期判定在 SQL 内完成）。
- require_user 依赖：解析 ``Authorization: Bearer <token>`` → 401 UNAUTHORIZED
  （扁平错误契约，全局 handler 不再包一层）。

排除鉴权的端点（登记在安全纪律）：
- POST /auth/login、POST /auth/register（鉴权入口本身）
- GET /.well-known/assetlinks.json（TWA 所有权文件，公开静态语义）
- /api/v1/keepalive*（SSE 心跳不含用户数据，EventSource 无法自定义请求头，
  且按「页面是否打开」语义计数，与登录态无关）
"""

import hashlib
import secrets

from fastapi import HTTPException, Request, status
from fastapi.security.utils import get_authorization_scheme_param

from app.db import crud

# v0.13.0 修 F4：120k → 600k（OWASP PBKDF2-SHA256 建议 ≥600k）；存储串自描述迭代数，
# 旧哈希（低迭代）按存储串内迭代数仍可验证，无需迁移存量哈希。
_PBKDF2_ITERATIONS = 600_000
_SALT_BYTES = 16
# 审计第二批 P3：校验迭代数上限——存储串的 iterations 字段可被篡改（直接改库），
# 无上限时把它写成天文数字会把校验线程钉死在单次 PBKDF2 上（DoS 面）。
# 正常哈希 60 万远低于上限、不受影响；与 Android 端本轮同值。
_MAX_VERIFY_ITERATIONS = 2_000_000


def hash_password(password: str) -> str:
    """PBKDF2-HMAC-SHA256 哈希口令，返回自描述存储串。"""
    salt = secrets.token_bytes(_SALT_BYTES)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, _PBKDF2_ITERATIONS)
    return f"pbkdf2_sha256${_PBKDF2_ITERATIONS}${salt.hex()}${dk.hex()}"


def dummy_stored_hash() -> str:
    """构造与真实哈希同迭代数的垃圾存储串（盐/摘要全零）。

    v0.13.0 修 F2：登录时用户不存在也执行一次等成本校验，拉平响应时间
    （verify_password 对格式合法串会真实跑 PBKDF2，防用户名枚举侧信道）。
    """
    return f"pbkdf2_sha256${_PBKDF2_ITERATIONS}${'00' * _SALT_BYTES}${'00' * 32}"


def verify_password(password: str, stored: str) -> bool:
    """校验口令。存储串格式非法/算法不匹配一律 False（不抛异常）。"""
    try:
        algo, iters_str, salt_hex, hash_hex = stored.split("$")
        if algo != "pbkdf2_sha256":
            return False
        iterations = int(iters_str)
        # 审计第二批 P3：迭代数超上限（篡改库行形态）→ 直接 False，不执行 PBKDF2
        if iterations < 1 or iterations > _MAX_VERIFY_ITERATIONS or len(salt_hex) != _SALT_BYTES * 2:
            return False
        dk = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), bytes.fromhex(salt_hex), iterations
        )
        return secrets.compare_digest(dk.hex(), hash_hex)
    except (ValueError, AttributeError, TypeError):
        return False


def generate_token() -> str:
    """生成 256bit 会话令牌。"""
    return secrets.token_urlsafe(32)


def _unauthorized() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail={"detail": "未登录或登录已过期", "code": "UNAUTHORIZED"},
    )


async def require_user(request: Request) -> dict:
    """FastAPI 依赖：校验 Bearer 令牌，返回 users 表行（dict）。

    用法：``user = Depends(require_user)``；取 id 用 ``user["id"]``。
    """
    authorization = request.headers.get("Authorization", "")
    scheme, param = get_authorization_scheme_param(authorization)
    if scheme.lower() != "bearer" or not param:
        raise _unauthorized()
    user = await crud.get_session_user(param)
    if user is None:
        raise _unauthorized()
    request.state.session_token = param
    return user
