# Copyright (c) 2026 Yui_0818 (aaaj6719@gmail.com)
# Licensed under the PolyForm Noncommercial License 1.0.0.
# Commercial use is prohibited without separate written authorization.
# See LICENSE and COMMERCIAL.md in the repository root.

"""predictions 路由（早期设计文档）。

端点：
- GET /predictions/current: 获取当前预测（既有 API 契约）
- GET /predictions/history: 获取历史预测列表

current 响应：
- 有记录：完整预测 + days_until_predicted（计算字段）
- 无记录：predicted_date=null, message 引导首次记录

v0.8.0（修 F7）：检测到库内预测已过期（预测日早于今天且尚未回填 actual_date）时，
用当前真实数据重算并落库；**v0.13.0 修 F12（契约变更）**：过期刷新改为**新增一行**
（新 created_at，永不 UPDATE 旧行 predicted_date）——旧行保留，实际来潮照常回填
验证，原始 miss 不再被洗白，MAE/命中率口径恢复诚实。
v0.8.1（例外表第 7 项）+ **v0.13.0 修 F13**：model_params 派生缓存全字段漂移自愈。
过期刷新与自愈逻辑统一在 app/prediction_service.py（F15 起 analysis/fertile-window 共用）。
本端点与 fertile-window 的 GET-时写库例外均已登记于早期设计文档。
"""

from datetime import date

from fastapi import APIRouter, Depends

from app.db import crud
from app.prediction_service import get_fresh_prediction
from app.security import require_user
from app.schemas.api import PredictionCurrentResponse, PredictionHistoryItem

router = APIRouter(prefix="/predictions", tags=["predictions"])


@router.get("/current", response_model=PredictionCurrentResponse)
async def get_current_prediction(user: dict = Depends(require_user)) -> dict:
    """获取当前预测（既有 API 契约）。

    有记录 → 完整预测（含 days_until_predicted 计算字段）。
    无记录 → predicted_date=null, message 引导。
    预测已过期 → 重算并新增行落库（v0.8.0 F7；v0.13.0 F12 契约），响应带 is_corrected=true。
    过期刷新与派生缓存自愈逻辑统一见 app/prediction_service.get_fresh_prediction。
    """
    user_id = user["id"]
    resolved = await get_fresh_prediction(user_id)
    latest_cycle = resolved["latest_cycle"]
    if latest_cycle is None:
        # 无记录：返回空预测 + 引导消息
        return {
            "predicted_date": None,
            "confidence": 0.0,
            "model_version": "none",
            "message": "尚无月经记录，请先记录至少一次月经开始日期",
        }

    latest_pred = resolved["latest_pred"]
    if latest_pred is None:
        # 有月经记录但无预测（不应发生，兜底）
        return {
            "predicted_date": None,
            "confidence": 0.0,
            "model_version": "none",
            "message": "暂无预测，请稍后重试",
        }

    predicted_date = date.fromisoformat(latest_pred["predicted_date"])
    today = date.today()

    return {
        "predicted_date": latest_pred["predicted_date"],
        "predicted_start_lower": latest_pred["predicted_start_lower"],
        "predicted_start_upper": latest_pred["predicted_start_upper"],
        "confidence": latest_pred["confidence"],
        "model_version": latest_pred["model_version"],
        "days_until_predicted": (predicted_date - today).days,
        "model_params": resolved["model_params"],
        "is_corrected": resolved["is_corrected"],
        "corrected_from": resolved["corrected_from"],
    }


@router.get("/history", response_model=list[PredictionHistoryItem])
async def get_prediction_history(user: dict = Depends(require_user)) -> list[dict]:
    """获取历史预测列表（created_at 倒序）。"""
    return await crud.get_prediction_history(user["id"], limit=50)