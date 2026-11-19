"""应用数据目录解析 + 首启迁移（早期记录 / C2）。

设计红线：
- **默认行为零变化**：绝不改动 ``backend/app/config.py`` 的 ``DB_PATH`` 默认值与
  相对解析口径；真实库路径只能由显式入口决定。
- 优先级：``MENSTRUAL_DB_PATH`` 环境变量 **>** 桌面入口显式参数 **>**
  ``%LOCALAPPDATA%\\PeriodIQ\\app.db``（环境变量优先级等同现状，测试红线依赖它）。
- 首启迁移只 **复制**（VACUUM INTO 快照，与 ``start.py::_backup_database`` 同口径），
  **绝不移动/删除源库**；找不到旧库则静默跳过（首次安装的正常情形）。
"""

from __future__ import annotations

import os
import sqlite3
from pathlib import Path

APP_NAME = "PeriodIQ"
DB_FILENAME = "app.db"


class AppDataDirError(RuntimeError):
    """无法确定可写的应用数据目录时抛出（携带可读中文提示）。"""


def get_app_data_dir() -> Path:
    """解析应用数据目录：``%LOCALAPPDATA%\\PeriodIQ``。

    回退顺序：``LOCALAPPDATA`` → ``APPDATA``；两者皆缺失则抛 :class:`AppDataDirError`
    （可读中文提示，供入口打印后退出）。

    Returns:
        应用数据目录的绝对 :class:`~pathlib.Path`（不保证已创建）。
    """
    base = os.environ.get("LOCALAPPDATA") or os.environ.get("APPDATA")
    if not base:
        raise AppDataDirError(
            "无法确定应用数据目录：环境变量 LOCALAPPDATA 与 APPDATA 均缺失，"
            "无法为桌面应用定位可写数据目录（%%LOCALAPPDATA%%\\PeriodIQ）。"
        )
    return Path(base) / APP_NAME


def resolve_db_path(explicit: str | os.PathLike[str] | None = None) -> Path:
    """按优先级解析数据库绝对路径（不创建文件、不启动服务）。

    Args:
        explicit: 桌面入口显式传入的库路径（可为 None）。

    Returns:
        解析出的 ``.db`` 绝对路径。环境变量 ``MENSTRUAL_DB_PATH`` 存在时最优先。
    """
    env = os.environ.get("MENSTRUAL_DB_PATH")
    if env:
        return Path(env).expanduser().resolve()
    if explicit:
        return Path(explicit).expanduser().resolve()
    return (get_app_data_dir() / DB_FILENAME).resolve()


def ensure_data_dir(explicit: str | os.PathLike[str] | None = None) -> Path:
    """确保数据目录存在并返回解析后的库路径（仅用于真要起服务的入口路径）。"""
    db = resolve_db_path(explicit)
    db.parent.mkdir(parents=True, exist_ok=True)
    return db


def migrate_from_legacy(
    target_db: Path,
    legacy_db: Path,
    *,
    verbose: bool = True,
) -> bool:
    """首启迁移：把旧库 **复制** 到目标库（VACUUM INTO 一致性快照）。

    仅当「目标库不存在」且「旧库存在」时执行；绝不移动/删除源库。

    Args:
        target_db: 应用数据目录下的目标 ``app.db``。
        legacy_db: 找到的旧库路径（如仓库 ``backend/data/app.db``）。
        verbose: 打印实际源/目标路径（默认 True）。

    Returns:
        True 表示执行了迁移；False 表示条件不满足而静默跳过。
    """
    if target_db.exists() or not legacy_db or not legacy_db.exists():
        return False  # 目标已存在（非首启）或无旧库 → 静默跳过
    target_db.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(str(legacy_db))
    try:
        con.execute("VACUUM INTO ?", (str(target_db),))
    finally:
        con.close()
    if verbose:
        print(f"[appdata] 首启迁移：已复制旧库 {legacy_db} → {target_db}（源库保持不动）")
    return True


def find_legacy_db() -> Path | None:
    """尽力寻找仓库内的既有库（``menstrual-app/backend/data/app.db``），只读定位。

    Returns:
        旧库绝对路径；找不到返回 None。
    """
    backend_root = Path(__file__).resolve().parent.parent / "backend"
    cand = backend_root / "data" / "app.db"
    return cand if cand.exists() else None
