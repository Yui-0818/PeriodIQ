"""daily-journal 路由（#14 每日日记，独立渠道；不依赖经期）。

端点：
- GET /daily-journal?from=&to=: 区间查询（record_date 升序，只返回有日记的日子）
- GET /daily-journal/{record_date}: 单日读取，恒 200——当日无日记时 id/note 均为 null
  （前端据此显示「未记录」态，不必处理 404；#28）
- PUT /daily-journal/{record_date}: 写当日日记（note 空/null/纯空白 = 清空即删行，幂等）

规则：
- 日记**只当天可写**（#14/#16）：晚于今天 → 422 VALIDATION_ERROR；早于今天 → 400
  JOURNAL_READONLY（过去只读，不设补填窗口——与四件套的「今天+昨天」窗口刻意不同）；
- 非经期日同样可写日记（日记不查 cycles）；经期四件套仍走 /daily-records；
- note ≤ DAILY_NOTE_MAX_CHARS（300）个 Unicode 码点，超出 → 422（schema 层）；
- 日记仅本地存储：导出/导入不携带也不触碰本表（导入只重建 cycles/predictions/daily_records）。
"""

from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app import config
from app.db import crud
from app.schemas.api import JournalOut, JournalUpsert
from app.security import require_user

router = APIRouter(prefix="/daily-journal", tags=["journal"])


def _absent(record_date: date) -> dict:
    """当日无日记的响应形（单日 GET / 清空后 PUT 共用）。"""
    return {"id": None, "record_date": record_date, "note": None,
            "created_at": None, "updated_at": None}


@router.get("", response_model=list[JournalOut])
async def list_journal(
    date_from: date = Query(..., alias="from", description="区间起点（含）"),
    date_to: date = Query(..., alias="to", description="区间终点（含）"),
    user: dict = Depends(require_user),
) -> list[dict]:
    """区间查询（闭区间，升序；Journal 页倒序展示由前端翻转）。"""
    if date_from > date_to:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"detail": "from 不得晚于 to", "code": config.INVALID_DAILY_CODE},
        )
    return await crud.get_journal_range(
        user["id"], date_from.isoformat(), date_to.isoformat()
    )


@router.get("/{record_date}", response_model=JournalOut)
async def get_journal(record_date: date, user: dict = Depends(require_user)) -> dict:
    """单日读取（恒 200；无日记 → note=null）。"""
    row = await crud.get_journal(user["id"], record_date.isoformat())
    return row if row is not None else _absent(record_date)


@router.put("/{record_date}", response_model=JournalOut)
async def put_journal(
    record_date: date,
    body: JournalUpsert,
    user: dict = Depends(require_user),
) -> dict:
    """写当日日记；校验链：schema（422）→ 未来日（422）→ 过去日（400 JOURNAL_READONLY）。"""
    today = date.today()
    if record_date > today:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "detail": f"请求参数校验失败（record_date: 日记日期不能晚于今天（{today.isoformat()}））",
                "code": "VALIDATION_ERROR",
            },
        )
    if record_date < today:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "detail": f"只有今天的日记可以修改，{record_date.isoformat()} 为只读",
                "code": config.JOURNAL_READONLY_CODE,
            },
        )
    iso = record_date.isoformat()
    if body.note is None or not body.note.strip():
        await crud.delete_journal(user["id"], iso)
        return _absent(record_date)
    await crud.upsert_journal(user["id"], iso, body.note)
    row = await crud.get_journal(user["id"], iso)
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"detail": "写入后读取日记失败", "code": "INTERNAL_ERROR"},
        )
    return row
