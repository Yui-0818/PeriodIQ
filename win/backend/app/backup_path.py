# Copyright (c) 2026 Yui_0818 (aaaj6719@gmail.com)
# Licensed under the PolyForm Noncommercial License 1.0.0.
# Commercial use is prohibited without separate written authorization.
# See LICENSE and COMMERCIAL.md in the repository root.

"""备份目录解析与持久化（R29）。

解析优先级（为何是 env > custom > default）：
1. 环境变量 MENSTRUAL_BACKUP_DIR —— 运维/调试/CI 的强制覆盖，必须最高优先，
   否则容器化部署无法脱离用户自定义设置；
2. 持久化自定义目录（backup_dir.txt）—— 用户在 UI 设置，跨启动保留；
3. 默认 <db父目录>/backups —— 零配置兼容，与历史行为一致。

持久化放在 <db父目录>/backup_dir.txt（纯 UTF-8 绝对路径一行），
**不写进 app.db 业务表**（多用户/迁移会脏）。
"""

from __future__ import annotations

import os
from pathlib import Path

# 环境变量名：强制覆盖备份落点（最高优先级）
ENV_BACKUP_DIR_VAR = "MENSTRUAL_BACKUP_DIR"

# 自定义目录持久化文件名（与库文件同目录，纯文本一行绝对路径）
CUSTOM_DIR_FILENAME = "backup_dir.txt"

# Windows 系统敏感根：拒绝将备份写入这些目录（误操作防护）
_SYSTEM_SENSITIVE_ROOTS = (
    r"C:\Windows",
    r"C:\Program Files",
    r"C:\Program Files (x86)",
    r"C:\ProgramData",
)


def default_backup_dir(db_path: Path) -> Path:
    """默认备份目录 = <db父目录>/backups（与历史行为一致）。"""
    return Path(db_path).resolve().parent / "backups"


def custom_backup_dir_file(db_path: Path) -> Path:
    """自定义目录持久化文件路径（backup_dir.txt，与库同目录）。"""
    return Path(db_path).resolve().parent / CUSTOM_DIR_FILENAME


def load_custom_backup_dir(db_path: Path) -> Path | None:
    """读取持久化的自定义备份目录；无文件或内容非法时返回 None。"""
    f = custom_backup_dir_file(db_path)
    try:
        text = f.read_text(encoding="utf-8").strip()
    except (OSError, UnicodeDecodeError):
        return None
    if not text:
        return None
    p = Path(text)
    if not p.is_absolute():
        return None
    return p.resolve()


def save_custom_backup_dir(db_path: Path, custom_dir: Path) -> None:
    """持久化自定义备份目录（覆盖写入 backup_dir.txt，一行绝对路径）。"""
    f = custom_backup_dir_file(db_path)
    f.write_text(str(Path(custom_dir).resolve()), encoding="utf-8")


def clear_custom_backup_dir(db_path: Path) -> None:
    """删除自定义目录持久化文件（reset 语义）。"""
    f = custom_backup_dir_file(db_path)
    try:
        f.unlink()
    except FileNotFoundError:
        pass


def resolve_backup_dir_with_source(db_path: Path) -> tuple[Path, str]:
    """解析备份目录，返回 (绝对路径, 来源)。

    来源取值：``env`` | ``custom`` | ``default``。
    优先级见模块 docstring。
    """
    env_val = os.environ.get(ENV_BACKUP_DIR_VAR, "").strip()
    if env_val:
        return Path(env_val).resolve(), "env"
    custom = load_custom_backup_dir(db_path)
    if custom is not None:
        return custom, "custom"
    return default_backup_dir(db_path), "default"


def resolve_backup_dir(db_path: Path) -> Path:
    """解析备份目录（只取路径，不取来源）。"""
    return resolve_backup_dir_with_source(db_path)[0]


def _is_under_system_root(path: Path) -> bool:
    """判断路径是否位于系统敏感根下（Windows 口径，大小写不敏感）。"""
    try:
        resolved = path.resolve()
    except OSError:
        resolved = path
    for root in _SYSTEM_SENSITIVE_ROOTS:
        root_low = root.lower()
        if str(resolved).lower() == root_low or str(resolved).lower().startswith(root_low + os.sep):
            return True
    return False


def validate_custom_backup_dir(raw: str, db_path: Path) -> Path:
    """校验用户输入的备份目录，合法则返回 resolve 后的绝对路径。

    拒绝：空串 / 相对路径 / 数据库文件本身 / 系统敏感根 / 已存在的普通文件。
    抛 ValueError，消息为中文（供 API 400 直接透传）。
    """
    text = (raw or "").strip()
    if not text:
        raise ValueError("备份目录不能为空")
    p = Path(text)
    if not p.is_absolute():
        raise ValueError("备份目录必须是绝对路径")
    resolved = p.resolve()
    db_resolved = Path(db_path).resolve()
    if resolved == db_resolved:
        raise ValueError("备份目录不能是数据库文件本身")
    if _is_under_system_root(resolved):
        raise ValueError("备份目录不能设在系统敏感目录（如 C:\\Windows）")
    if resolved.exists() and resolved.is_file():
        raise ValueError("备份目录不能指向已存在的普通文件")
    return resolved
