"""登录持久化槽（2026-10-26 两端对齐 Android；v0.23.0）。

「保持登录」的本机固化存储：把 {username, password} 经 Windows DPAPI（用户域）
加密后落盘到数据目录 ``login_persistence.json``（与 app.db 同目录，路径派生自
config.DB_ABS_PATH.parent）。/auth/relogin 用它免输口令恢复登录。

安全口径（审计红线）：
- 口令明文只存在于请求处理过程与 DPAPI 加密前的内存字节串；落盘的只有 base64
  密文；本模块所有日志只记长度与状态，绝不含明文/密文。
- DPAPI 用户域：只有同一 Windows 账户能解密；换系统用户/换机即解密失败，
  按无槽处理（fail-closed，不降级放行）。
- DPAPI 或文件读写失败 → 各函数返回失败值（None/False）并记 warning，
  绝不抛出、绝不阻塞登录（调用方按契约降级为普通 30 天会话）。

文件纪律镜像 routes/device.py：线程锁串行化「读-改-写」+ tmp + os.replace 原子替换；
文件是运行时生成物，不是用户数据备份形态（永不进 /export 与备份目录）。
"""

import base64
import json
import logging
import os
import sys
import threading
from pathlib import Path

from app import config

logger = logging.getLogger(__name__)

# 槽文件名单一来源（数据目录内，与 desktop_settings.json 同族）
_SLOT_FILENAME = "login_persistence.json"

_slot_lock = threading.Lock()

# szDataDescr（数据描述）传 None；CRYPTPROTECT_UI_FORBIDDEN 禁止 DPAPI 弹任何 UI
_CRYPTPROTECT_UI_FORBIDDEN = 0x1

_IS_WINDOWS = sys.platform == "win32"
if _IS_WINDOWS:  # pragma: no cover（Windows 常规路径；失败分支由运行验证覆盖）
    import ctypes
    from ctypes import wintypes

    class _DATA_BLOB(ctypes.Structure):
        _fields_ = [
            ("cbData", wintypes.DWORD),
            ("pbData", ctypes.POINTER(ctypes.c_byte)),
        ]

    _crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
    _kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _crypt32.CryptProtectData.argtypes = [
        ctypes.POINTER(_DATA_BLOB),   # pDataIn
        wintypes.LPCWSTR,             # szDataDescr
        ctypes.POINTER(_DATA_BLOB),   # pOptionalEntropy
        wintypes.LPVOID,              # pvReserved
        wintypes.LPVOID,              # pPromptStruct（传 None）
        wintypes.DWORD,               # dwFlags
        ctypes.POINTER(_DATA_BLOB),   # pDataOut
    ]
    _crypt32.CryptProtectData.restype = wintypes.BOOL
    _crypt32.CryptUnprotectData.argtypes = [
        ctypes.POINTER(_DATA_BLOB),   # pDataIn
        ctypes.POINTER(wintypes.LPCWSTR),  # ppszDataDescr（不需要，传 None）
        ctypes.POINTER(_DATA_BLOB),
        wintypes.LPVOID,
        wintypes.LPVOID,
        wintypes.DWORD,
        ctypes.POINTER(_DATA_BLOB),
    ]
    _crypt32.CryptUnprotectData.restype = wintypes.BOOL
    _kernel32.LocalFree.argtypes = [wintypes.HLOCAL]
    _kernel32.LocalFree.restype = wintypes.HLOCAL
else:  # 平台护栏：非 Windows 一律按「加密存储不可用」走失败值
    _DATA_BLOB = None
    _crypt32 = None


def _slot_path() -> Path:
    """槽文件绝对路径（数据目录 = app.db 同目录）。"""
    return config.DB_ABS_PATH.parent / _SLOT_FILENAME


def _read_payload() -> dict | None:
    """读槽原始 JSON（文件缺失/损坏/结构非法 → None；不写回、不重建）。"""
    try:
        data = json.loads(_slot_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _atomic_write(payload: dict) -> None:
    """原子写：同目录 tmp + os.replace（同一卷上替换是原子操作，与 device.py 同款）。"""
    path = _slot_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.parent / (path.name + ".tmp")
    tmp.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    os.replace(tmp, path)


def _dpapi_protect(plaintext: bytes) -> bytes | None:
    """DPAPI 加密（用户域）。失败返回 None（含非 Windows 平台），只记状态不记内容。"""
    if not _IS_WINDOWS:
        return None
    buf = ctypes.create_string_buffer(plaintext, len(plaintext))
    in_blob = _DATA_BLOB(len(plaintext), ctypes.cast(buf, ctypes.POINTER(ctypes.c_byte)))
    out_blob = _DATA_BLOB()
    ok = _crypt32.CryptProtectData(
        ctypes.byref(in_blob), None, None, None, None,
        _CRYPTPROTECT_UI_FORBIDDEN, ctypes.byref(out_blob),
    )
    if not ok:
        logger.warning(
            "登录持久化：DPAPI 加密失败（err=%d，明文长度=%d，未落盘）",
            ctypes.get_last_error(), len(plaintext),
        )
        return None
    out = ctypes.string_at(out_blob.pbData, out_blob.cbData)
    _kernel32.LocalFree(out_blob.pbData)
    return out


def _dpapi_unprotect(ciphertext: bytes) -> bytes | None:
    """DPAPI 解密（用户域）。失败返回 None（密钥域不符/数据损坏），只记状态。"""
    if not _IS_WINDOWS:
        return None
    buf = ctypes.create_string_buffer(ciphertext, len(ciphertext))
    in_blob = _DATA_BLOB(len(ciphertext), ctypes.cast(buf, ctypes.POINTER(ctypes.c_byte)))
    out_blob = _DATA_BLOB()
    ok = _crypt32.CryptUnprotectData(
        ctypes.byref(in_blob), None, None, None, None,
        _CRYPTPROTECT_UI_FORBIDDEN, ctypes.byref(out_blob),
    )
    if not ok:
        logger.warning(
            "登录持久化：DPAPI 解密失败（err=%d，密文 %d 字节）",
            ctypes.get_last_error(), len(ciphertext),
        )
        return None
    out = ctypes.string_at(out_blob.pbData, out_blob.cbData)
    _kernel32.LocalFree(out_blob.pbData)
    return out


def save_slot(username: str, password: str) -> bool:
    """加密固化 {username, password} 到本机槽。成功 True；DPAPI/写盘失败 False（不抛）。"""
    encrypted = _dpapi_protect(password.encode("utf-8"))
    if encrypted is None:
        return False
    payload = {
        "username": username,
        "password": base64.b64encode(encrypted).decode("ascii"),
    }
    with _slot_lock:
        try:
            _atomic_write(payload)
            return True
        except OSError as exc:
            logger.warning("登录持久化：槽写入失败（%s）", type(exc).__name__)
            return False


def load_slot() -> tuple[str, str] | None:
    """读槽并解密，返回 (username, password)。

    无槽/结构损坏/密文非法/DPAPI 解密失败 → None（按「未开启持久化」处理）。
    """
    with _slot_lock:
        payload = _read_payload()
    if payload is None:
        return None
    username = payload.get("username")
    b64 = payload.get("password")
    if not isinstance(username, str) or not isinstance(b64, str):
        logger.warning("登录持久化：槽结构非法（字段缺失或类型不符），按无槽处理")
        return None
    try:
        ciphertext = base64.b64decode(b64, validate=True)
    except ValueError:
        logger.warning("登录持久化：槽密文不是合法 base64，按无槽处理")
        return None
    plaintext = _dpapi_unprotect(ciphertext)
    if plaintext is None:
        return None
    try:
        password = plaintext.decode("utf-8")
    except UnicodeDecodeError:
        logger.warning("登录持久化：解密结果不是合法 UTF-8，按无槽处理")
        return None
    return (username, password)


def clear_slot(username: str | None = None) -> bool:
    """清槽。username 给定时只清**匹配该用户**的槽（他账号的槽不动）；无槽视为已清。"""
    with _slot_lock:
        payload = _read_payload()
        if payload is None:
            return True
        if username is not None and payload.get("username") != username:
            return True
        try:
            _slot_path().unlink(missing_ok=True)
            return True
        except OSError as exc:
            logger.warning("登录持久化：清槽失败（%s）", type(exc).__name__)
            return False


def slot_username() -> str | None:
    """槽内用户名（只读文件字段，不触发 DPAPI 解密；无槽/结构非法 → None）。"""
    with _slot_lock:
        payload = _read_payload()
    if payload is None:
        return None
    username = payload.get("username")
    return username if isinstance(username, str) else None
