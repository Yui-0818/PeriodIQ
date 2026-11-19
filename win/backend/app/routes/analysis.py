"""analysis 路由（早期设计文档）。

端点：
- GET /analysis/accuracy: 精度评估报告（既有 API 契约）
- GET /analysis/cycle-stats: 周期统计（**纯只读端点**，v0.14.0 修 EN-3 登记：
  不调用 prediction_service.get_fresh_prediction()，不做任何 GET-时写库；
  逾期提示基于库内最新一条预测，可能与首页/日历页刷新后的预测日相差一次刷新）
- GET /analysis/fertile-window: 排卵日/易孕期/相对不易受孕期（v0.8.0 新增；
  v0.13.0 修 F15：复用 prediction_service 确保预测新鲜，过期时随刷新落库——
  继 /predictions/current 后第二个登记在案的 GET-时写库例外）
"""

import statistics
from datetime import date

from fastapi import APIRouter, Depends

from app import config
from app.algo import fertility
from app.algo.eval import evaluate_predictions
from app.db import crud
from app.prediction_service import get_fresh_prediction
from app.security import require_user
from app.schemas.api import (
    AccuracyResponse,
    CycleStatsResponse,
    FertileWindowResponse,
)

router = APIRouter(prefix="/analysis", tags=["analysis"])


# ============================================================
# 状态机判定（早期设计文档）
# ============================================================

def _determine_status(total_records: int, recent_anomalous_count: int) -> tuple[str, str]:
    """根据记录数和**近期**异常数判定状态机状态（早期设计文档）。

    v0.9.0 修 P12：ANOMALY_ALERT 回归「连续 3 条异常」的**近期窗口**语义
    （最近 ANOMALY_CONSECUTIVE_THRESHOLD 条中异常数达阈值即进入；
    新增正常记录后自然回退）。旧实现用全期累计异常数，一次波动后永久 ALERT，
    且与提示文案「近期周期波动较大」相悖。

    Returns:
        (status, status_message)
    """
    if total_records == 0:
        return "EMPTY", "暂无月经记录，请先记录首次月经开始日期"
    if recent_anomalous_count >= config.ANOMALY_CONSECUTIVE_THRESHOLD:
        return "ANOMALY_ALERT", "近期周期波动较大，建议检查记录或咨询医生"
    if total_records <= 2:
        return "COLD", "记录更多周期可提升精度"
    if total_records <= 5:
        return "WARMING", "模型正在学习你的周期"
    if total_records <= 10:
        return "STABLE", "正常展示"
    return "MATURE", "正常展示"


@router.get("/accuracy", response_model=AccuracyResponse)
async def get_accuracy(user: dict = Depends(require_user)) -> dict:
    """精度评估报告（既有 API 契约）。

    无已验证预测时返回 error 字段。
    """
    predictions = await crud.get_all_predictions(user["id"])
    result = evaluate_predictions(predictions)
    return result


@router.get("/cycle-stats", response_model=CycleStatsResponse)
async def get_cycle_stats(user: dict = Depends(require_user)) -> dict:
    """周期统计（v0.9.0 新增 clinical_notes：临床观察提示，纯派生自用户数据）。

    v0.14.0 修 EN-3（审计 M8 调用面复核）：**本端点是纯只读端点**，不调用
    prediction_service.get_fresh_prediction()（对比 /predictions/current 与
    /analysis/fertile-window 两个登记在案的 GET-时写库例外）。
    因此 latest_pred 取的是**库内最新一条预测**，不是「确保新鲜」后的预测：
    预测已过期多日且用户未打开首页/日历页（未触发刷新）时，逾期天数基于库内
    那条预测日计算——数值口径仍正确（就是从库内预测日算起），只是它可能与
    刷新后的预测日相差一次刷新（刷新后日期通常后移，逾期天数相应变小）。
    权衡：为纯统计端点新增第三个写库例外会带来并发/性能代价（每次 GET 都可能
    进 WriteLock 重算并插行），收益不足；故不改写库，只如实登记口径差异。
    """
    cycles = await crud.get_all_cycles(user["id"])
    total_records = len(cycles)

    if total_records == 0:
        return {
            "total_records": 0,
            "total_cycles": 0,
            "avg_cycle_length": None,
            "avg_period_days": None,
            "shortest_cycle": None,
            "longest_cycle": None,
            "anomalous_count": 0,
            "status": "EMPTY",
            "status_message": "暂无数据",
            "clinical_notes": [],
        }

    # 合法周期长度（v0.8.1 例外表第 6 项修复：参与集与预测口径对齐）。
    # cycle_length 非空即合法（DDL CHECK 限 [7,90]）：偏离周期虽被鲁棒降权
    # 但仍参与预测，展示均值/最值不应把它们排除；硬无效周期（<7/>90）
    # 落库时 cycle_length 已置 NULL，天然不参与。
    valid_cycles = [
        c["cycle_length"] for c in cycles
        if c.get("cycle_length") is not None
    ]
    # period_days 统计（非空）
    period_days_list = [
        c["period_days"] for c in cycles
        if c.get("period_days") is not None
    ]
    anomalous_count = sum(1 for c in cycles if c.get("is_anomalous", 0))

    avg_cycle = sum(valid_cycles) / len(valid_cycles) if valid_cycles else None
    avg_period = sum(period_days_list) / len(period_days_list) if period_days_list else None
    shortest = min(valid_cycles) if valid_cycles else None
    longest = max(valid_cycles) if valid_cycles else None

    # 状态机判定（v0.9.0 修 P12：用最近 N 条的异常数，支持回退；全期计数仅作展示）
    recent_anomalous = await crud.get_recent_anomalous_count(
        user["id"], config.ANOMALY_CONSECUTIVE_THRESHOLD
    )
    status, status_message = _determine_status(total_records, recent_anomalous)

    # 临床观察提示（v0.9.0，纯派生自用户数据，不新增输入、不做诊断）
    latest_pred = await crud.get_latest_prediction(user["id"])
    clinical_notes = _build_clinical_notes(cycles, latest_pred)

    return {
        "total_records": total_records,
        "total_cycles": len(valid_cycles),
        "avg_cycle_length": round(avg_cycle, 2) if avg_cycle is not None else None,
        "avg_period_days": round(avg_period, 2) if avg_period is not None else None,
        "shortest_cycle": shortest,
        "longest_cycle": longest,
        "anomalous_count": anomalous_count,
        "status": status,
        "status_message": status_message,
        "clinical_notes": clinical_notes,
    }


# 典型临床范围常量已入 config.py（v0.9.0，参数表；禁止魔法数字）：
# CLINICAL_CYCLE_MIN_DAYS=21 / CLINICAL_CYCLE_MAX_DAYS=35 / CLINICAL_PERIOD_MAX_DAYS=8 /
# OVERDUE_NOTICE_DAYS=7 / CLINICAL_WINDOW=6。
# 超出仅作「建议关注」提示，不构成诊断；是否就医由用户决定。


def _build_clinical_notes(cycles: list[dict], latest_pred: dict | None) -> list[dict]:
    """从用户已有记录派生临床观察提示（v0.9.0，不新增任何输入）。

    诚实性约束：措辞用「建议关注/建议咨询医生」，不写诊断结论；
    无数据时返回空列表，前端不渲染该卡片。

    v0.14.0 修 EN-3：逾期提示（第 3 条）的口径与稳健性——
    - latest_pred 由调用方以**只读**口径传入（crud.get_latest_prediction：
      库内 created_at 最新一条），本函数不发任何查询、不写库；
      故「库内最新预测」与「首页刷新后的预测」可能相差一次刷新（已在
      get_cycle_stats docstring 登记）。
    - 稳健性：predicted_date 为 None 或非 ISO 串（手工改库/脏数据）时
      **跳过该提示**而非 500；actual_date 非空（已验证落地）时同样不提示。
    """
    notes: list[dict] = []
    recent = sorted(
        cycles, key=lambda c: (c.get("period_start") or ""), reverse=True
    )[:config.CLINICAL_WINDOW]

    # 1) 近期周期长度超出典型范围（短于 21 / 长于 35）
    recent_lengths = [c["cycle_length"] for c in recent if c.get("cycle_length") is not None]
    short = [L for L in recent_lengths if L < config.CLINICAL_CYCLE_MIN_DAYS]
    long = [L for L in recent_lengths if L > config.CLINICAL_CYCLE_MAX_DAYS]
    if short:
        notes.append({
            "code": "short_cycle",
            "severity": "info",
            "message": f"近期有周期短于 {config.CLINICAL_CYCLE_MIN_DAYS} 天（最短 {min(short)} 天）。"
                       "若持续出现，建议咨询医生。",
        })
    if long:
        notes.append({
            "code": "long_cycle",
            "severity": "info",
            "message": f"近期有周期长于 {config.CLINICAL_CYCLE_MAX_DAYS} 天（最长 {max(long)} 天）。"
                       "若持续出现，建议咨询医生。",
        })

    # 2) 经期时长超出典型范围（超过 8 天）
    recent_periods = [c["period_days"] for c in recent if c.get("period_days") is not None]
    long_period = [d for d in recent_periods if d > config.CLINICAL_PERIOD_MAX_DAYS]
    if long_period:
        notes.append({
            "code": "long_period",
            "severity": "info",
            "message": f"近期经期超过 {config.CLINICAL_PERIOD_MAX_DAYS} 天（最长 {max(long_period)} 天）。"
                       "若持续出现，建议咨询医生。",
        })

    # 3) 逾期：预测日已过 OVERDUE_NOTICE_DAYS 天且未记录新周期
    # v0.14.0 修 EN-3：只读口径 + 脏数据容错（None/非 ISO 串跳过，不 500）
    if latest_pred is not None and latest_pred.get("actual_date") is None:
        raw_predicted = latest_pred.get("predicted_date")
        try:
            predicted = date.fromisoformat(raw_predicted) if raw_predicted else None
        except (TypeError, ValueError):
            predicted = None
        if predicted is not None:
            overdue_days = (date.today() - predicted).days
            if overdue_days >= config.OVERDUE_NOTICE_DAYS:
                notes.append({
                    "code": "overdue",
                    "severity": "attention",
                    "message": f"预测日已过 {overdue_days} 天且未记录新周期。月经推迟可能与多种因素"
                               "有关；若已来潮请到日历记录，若持续未来潮，建议验孕或咨询医生。",
                })
    return notes


@router.get("/fertile-window", response_model=FertileWindowResponse)
async def get_fertile_window(user: dict = Depends(require_user)) -> dict:
    """排卵日 / 易孕期 / 相对不易受孕期推算（v0.8.0 新增；v0.13.0 修 F15）。

    仅用已有月经周期数据（标准日历法），不要求任何新增输入；全部数据来自
    最新一条记录与「确保新鲜的当前预测」——复用 app/prediction_service
    （v0.13.0 修 F15：与 predictions/current 同一「确保当前预测」逻辑，
    过期时自动刷新落库，易孕期不再基于过期预测日期推算）。

    v0.13.0 修 F15：本端点成为继 /predictions/current 之后第二个登记在案的
    GET-时写库例外（过期刷新新增行 + 派生缓存自愈），早期设计文档已登记。

    无记录/无预测时返回 available=false，前端不渲染配色（禁令 7：不显示 0/null）。
    """
    resolved = await get_fresh_prediction(user["id"])
    latest_cycle = resolved["latest_cycle"]
    latest_pred = resolved["latest_pred"]
    if latest_cycle is None or latest_pred is None:
        return fertility.compute_fertility_window(None, None, None, config.PRIOR_STD)

    # v0.13.0 修 F15：用共享服务解析的 model_params（与刷新逻辑同源；解析失败为空 dict）
    params = resolved["model_params"]
    std_val = params.get("std_cycle")
    cycle_std = config.PRIOR_STD if std_val is None else float(std_val)

    end_str = latest_cycle.get("period_end")

    # v0.8.1：预测经期时长 = 历史 period_days 非空记录的中位数（后端计算，前端只展示）。
    # 用于淡粉标注「本次/下次经期预测区间」，解决未填结束日时看不出经期何时结束。
    period_days_history = [
        c["period_days"] for c in await crud.get_all_cycles(user["id"])
        if c.get("period_days") is not None and c["period_days"] >= 1
    ]
    predicted_period_days = (
        int(round(statistics.median(period_days_history)))
        if period_days_history else None
    )

    return fertility.compute_fertility_window(
        date.fromisoformat(latest_pred["predicted_date"]),
        date.fromisoformat(latest_cycle["period_start"]),
        date.fromisoformat(end_str) if end_str else None,
        cycle_std,
        config,
        predicted_period_days=predicted_period_days,
    )
