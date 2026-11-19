"""备份列表与备份目录路由（R2-A / R29，PeriodIQ）。

端点：
- GET /backups: 只读列出备份目录下的 app-*.db
  （目录由 app.backup_path.resolve_backup_dir 解析，与启动器写入共用同一来源）。
- PUT /backups/dir: 设置/重置备份目录（只影响此后备份，不搬迁旧文件）。

约束（冻结契约）：
- 列表只读，不提供恢复、不删除任何文件。
- 鉴权与其他业务端点一致（require_user）。
"""

from fastapi import APIRouter, Depends, HTTPException, status

from app import config
from app.backup_path import (
    clear_custom_backup_dir,
    load_custom_backup_dir,
    resolve_backup_dir_with_source,
    save_custom_backup_dir,
    validate_custom_backup_dir,
)
from app.security import require_user
from app.schemas.api import (
    BackupDirUpdateRequest,
    BackupDirUpdateResponse,
    BackupsResponse,
)

router = APIRouter(tags=["backups"])


def _list_items(backup_dir) -> list[dict]:
    """列出 backup_dir 下的 app-*.db 元数据（只读）。"""
    items: list[dict] = []
    if backup_dir.is_dir():
        for p in sorted(backup_dir.glob("app-*.db"), key=lambda x: x.name):
            try:
                st = p.stat()
            except OSError:
                continue
            items.append({
                "name": p.name,
                "size": int(st.st_size),
                "mtime": float(st.st_mtime),
            })
    return items


def _dir_payload() -> dict:
    """组装 dir / dir_source / custom_dir（GET 与 PUT 响应共用）。"""
    resolved, source = resolve_backup_dir_with_source(config.DB_ABS_PATH)
    custom = load_custom_backup_dir(config.DB_ABS_PATH)
    return {
        "dir": str(resolved),
        "dir_source": source,
        "custom_dir": str(custom) if custom is not None else None,
        "items": _list_items(resolved),
    }


@router.get("/backups", response_model=BackupsResponse)
async def list_backups(user: dict = Depends(require_user)) -> dict:
    """列出备份目录中的 app-*.db 文件（name/size/mtime）。

    目录由 resolve_backup_dir 解析（env > custom > default）。
    目录不存在时返回空 items，dir 仍为解析后的绝对路径。
    本端点绝不修改备份目录中的任何文件。
    """
    return _dir_payload()


@router.put("/backups/dir", response_model=BackupDirUpdateResponse)
async def update_backup_dir(
    body: BackupDirUpdateRequest,
    user: dict = Depends(require_user),
) -> dict:
    """设置或重置备份目录。

    - body.dir 给出绝对路径 → 校验后持久化为自定义目录；
    - body.reset=true → 清除自定义，回到默认（或 env 覆盖）。
    只影响此后备份写入；不搬迁旧目录中的文件。
    """
    if body.reset:
        clear_custom_backup_dir(config.DB_ABS_PATH)
    elif body.dir is not None:
        try:
            validated = validate_custom_backup_dir(body.dir, config.DB_ABS_PATH)
        except ValueError as e:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={"detail": str(e), "code": "INVALID_BACKUP_DIR"},
            ) from e
        save_custom_backup_dir(config.DB_ABS_PATH, validated)
    else:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"detail": "请提供 dir 或 reset=true", "code": "INVALID_BACKUP_DIR"},
        )
    payload = _dir_payload()
    return {
        "dir": payload["dir"],
        "dir_source": payload["dir_source"],
        "custom_dir": payload["custom_dir"],
    }
