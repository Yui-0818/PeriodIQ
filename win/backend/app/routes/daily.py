# Copyright (c) 2026 Yui_0818 (aaaj6719@gmail.com)
# Licensed under the PolyForm Noncommercial License 1.0.0.
# Commercial use is prohibited without separate written authorization.
# See LICENSE and COMMERCIAL.md in the repository root.

"""daily-records 路由（经期每日详情记录，2026-10-26 用户立项）。

端点：
- PUT /daily-records/{record_date}: upsert 当日经期四件套（疼痛/血量/心情等级/心情标签）
- GET /daily-records?from=&to=: 区间查询（响应含 mood_tags）。单日读取就是 from=to 的
  区间查询（#28 裁决：不新增单日 GET，UNIQUE(user_id, record_date) 自带索引覆盖该谓词）

2026-10-31 #14/#15：日记文本拆到独立渠道 /daily-journal（routes/journal.py）；本路由不再读写
mood_note（旧文本已一次性迁入 daily_journal），新增 mood_tags（受控词表 ID）。
#16：四件套只在经期日写入——非经期日只能写日记，不会建 daily_records 行。

校验链（顺序固定）：
1. schema 层（422 VALIDATION_ERROR）：pain_present 与 pain_level 联动、
   flow/mood∈[1,10]、mood_tags（≤8 个、每个≤24 字符、词表内、不重复）；
2. 日期不得晚于今天（422 VALIDATION_ERROR，见 _reject_future_daily_date；
   2026-10-26 修 B1：路径参数不走 pydantic body 校验，必须路由内抛 HTTPException——
   原裸 ValueError 无 handler 接收会变 500；Android 同场景 422 同 code）；
3. 补填窗口：仅「今天 + 昨天」共 DAILY_BACKFILL_WINDOW_DAYS 天，更早拒绝
   （400 DAILY_WINDOW——失真的数据比没有数据更危险，用户裁定）；
4. 来潮日校验（查库判，400 NOT_PERIOD_DAY）：必须存在
   period_start ≤ 日 ≤ period_end 的周期（period_end 空视为进行中）。

mood_tags 仅本地存储：GET/PUT 响应携带，导出/预览永不携带（隐私裁定，同旧 mood_note）。
"""

from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app import config
from app.db import crud
from app.schemas.api import DailyRecordOut, DailyRecordUpsert
from app.security import require_user

router = APIRouter(prefix="/daily-records", tags=["daily"])


def _reject_future_daily_date(record_date: date) -> None:
    """每日详情日期上限校验：不得晚于今天（违规 → 422 VALIDATION_ERROR 扁平契约）。

    2026-10-26 修 B1（审查员）：record_date 是路径参数，不走 pydantic body 校验链，
    校验必须在这里显式抛 HTTPException——此前抛裸 ValueError 落不到任何全局
    handler，实测 500。文案/状态码与 Android 的 validationError("record_date", …)
    同构（422 + VALIDATION_ERROR）。补填下限由调用方的窗口判定负责。
    """
    today = date.today()
    if record_date > today:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "detail": f"请求参数校验失败（record_date: 每日详情日期不能晚于今天（{today.isoformat()}））",
                "code": "VALIDATION_ERROR",
            },
        )


@router.put("/{record_date}", response_model=DailyRecordOut)
async def upsert_daily_record(
    record_date: date,
    body: DailyRecordUpsert,
    user: dict = Depends(require_user),
) -> dict:
    """upsert 指定日的经期四件套（同日重复保存整行覆盖，updated_at 刷新）。"""
    _reject_future_daily_date(record_date)
    today = date.today()
    earliest = today - timedelta(days=config.DAILY_BACKFILL_WINDOW_DAYS - 1)
    if record_date < earliest:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "detail": (
                    f"仅可记录今天与昨天（{config.DAILY_BACKFILL_WINDOW_DAYS} 天补填窗口），"
                    f"{record_date.isoformat()} 超出窗口"
                ),
                "code": config.DAILY_WINDOW_CODE,
            },
        )
    iso = record_date.isoformat()
    if not await crud.is_period_day(user["id"], iso):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "detail": f"{iso} 不是来潮日（无覆盖该日的周期记录）",
                "code": config.NOT_PERIOD_DAY_CODE,
            },
        )
    await crud.upsert_daily_record(
        user["id"], iso,
        pain_present=body.pain_present,
        pain_level=body.pain_level,
        flow_level=body.flow_level,
        mood_level=body.mood_level,
        mood_tags=body.mood_tags,
    )
    row = await crud.get_daily_record(user["id"], iso)
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"detail": "写入后读取每日详情失败", "code": "INTERNAL_ERROR"},
        )
    return row


@router.get("", response_model=list[DailyRecordOut])
async def list_daily_records(
    date_from: date = Query(..., alias="from", description="区间起点（含）"),
    date_to: date = Query(..., alias="to", description="区间终点（含）"),
    user: dict = Depends(require_user),
) -> list[dict]:
    """区间查询（闭区间，record_date 升序；响应行含 mood_tags）。from=to 即单日读取。"""
    if date_from > date_to:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"detail": "from 不得晚于 to", "code": config.INVALID_DAILY_CODE},
        )
    return await crud.get_daily_records_range(
        user["id"], date_from.isoformat(), date_to.isoformat()
    )
