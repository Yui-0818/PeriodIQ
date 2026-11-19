"""debug 路由 — 算法透视镜（早期设计文档）。

端点（全部为 GET，只读不写，不触发算法更新）：
- GET /api/v1/debug/model: 当前模型快照（算法阶段 + 权重分布 + 参数）
- GET /api/v1/debug/model_history: 模型参数演化轨迹（取自 predictions 表 model_params_json）
- GET /api/v1/debug/prediction_trace: 当前预测的逐步计算踪（调用 algo/trace.py）

============================================================
口径登记表（v0.14.0 修 BN-1，对应审计 H1/H2 —— 三端点必须同口径）
============================================================

本项目存在两个**互不相等**的"数量"，任何返回字段都必须能一眼看出属于哪一个：

1. **记录数口径**（字段：`n_records_total`，兼容旧名 `n_total_cycles`）
   = `cycles` 表的**月经记录总条数**：含硬无效记录（cycle_length 落库置 NULL 且
   is_anomalous=1）、含只有开始日的锚点记录（首条记录、以及最新未结束的记录）。
   用途：判定 `algorithm_stage`（empty/cold_1/cold_2/bayesian，早期设计文档；
   与前端阶段徽章、POST 链 previous 口径一致）。三端点的 `algorithm_stage` 一律用本口径，
   并带 `algorithm_stage_caliber="n_records"` 自证。

2. **参与集口径**（字段：`model_input_n`，兼容旧名 `n_valid_cycles`）
   = `cycle_length IS NOT NULL` 的记录条数（DDL CHECK 已保证落在 [7,90]）
   = `crud.get_all_valid_cycle_lengths()` 的长度
   = `stats.predict_core` 的真实输入规模 `core["n"]`（= `model_params.n_records`
   = `crud.model_params.n_records` 的算法口径）。
   用途：`model_params.n_records`、权重分布（prior_weight / data_weight / n_eff）、
   置信度。**"模型真实输入规模"只有本口径**，不得与记录数口径混用。

3. **贝叶斯是否真的生效**：只看 `bayes_applied`（取自 `stats.predict_core` 的真实输出，
   判据 = 有效周期数 ≥ COLD_START_THRESHOLD）。`model_version` 只是算法版本标签
   （n=0→cold_start_1、n=1→cold_start_2、n≥2→bayesian_v1），**禁止**据它推断或暗示
   "贝叶斯已生效"——3 条记录（2 个有效周期）时 model_version 已是 bayesian_v1，
   而 bayes_applied 仍为 False（审计 H2 的诱因）。

**快照 ↔ 记录对应关系（BN-1 核实结论：不成立，故不做序号推断）**：
`predictions` 表并非只由 POST /cycles 写入（每条记录恰好写 1 条快照），另有：
- 过期刷新新增行：`app/prediction_service.get_fresh_prediction`（GET 时写库例外，
  不新增任何记录即新增快照）；
- 删除/修正重算：`routes/cycles._recompute_after_delete_tx` →
  `crud.delete_unverified_predictions`（删行）+ `crud.regenerate_current_prediction`
  （增行），记录数减少而快照数不减；
- 导入：`routes/settings.import_data` → `crud.create_import_prediction` 一次请求写
  **多行**并还原文件里的 `created_at`，之后还可能补一条
  `crud.regenerate_current_prediction`。
任一路径都会让"第 k 个快照 = 第 k 条月经记录"失效（例如删掉 1 条记录后，快照条数
仍可能等于或大于记录数）。因此 /debug/model_history 逐快照的月经记录条数
（`n_records_recorded`）与其记录数口径阶段**无法可靠确定 → 一律返回 null，绝不伪造**；
每快照可确定的是模型输入口径（`n_records_at_time` / `model_input_n`）以及落库的
`model_version` / `bayes_applied`。当前记录数见 GET /debug/model 的 `n_records_total`。

只读约束（致命 Bug 禁令）：
- 本模块不写数据库、不触发算法更新，仅查询 crud + 调用纯函数：
  `crud.get_all_valid_cycle_lengths` 与 `stats.predict_core` / `algo.trace.prediction_trace`
  使用**同一入参**（同一 cycle_lengths 与同一 prev_ema），两次调用结果逐值相同，
  不引入第二套口径。
"""

import json
from typing import Any

from fastapi import APIRouter, Depends

from app import config
from app.algo import stats, trace
from app.algo.stats import replay_ema
from app.db import crud
from app.security import require_user

router = APIRouter(prefix="/debug", tags=["debug"])


# ============================================================
# 展示映射（早期设计文档）
# ============================================================

_STAGE_META: dict[str, dict[str, str]] = {
    "empty": {
        "label": "空白",
        "description": "尚无记录，请先记录至少一次月经开始日期",
    },
    "cold_1": {
        "label": "冷启动（1条）",
        "description": "仅1条记录，使用先验默认值28天",
    },
    "cold_2": {
        "label": "冷启动（2条）",
        # v0.12.0 死代码清理：旧文案「使用简单均值」与实际算法不符——
        # n==1 个合法周期时 fused = 最近一次周期长度（predict_core Step 3）
        "description": "2条记录，使用最近一次周期长度",
    },
    "bayesian": {
        "label": "贝叶斯自学习",
        # v0.14.0 修 BN-1（审计 H2）：本描述含「贝叶斯后验生效」，只在该阶段
        # bayes_applied=True（= 有效周期数 ≥ COLD_START_THRESHOLD）时才允许返回，
        # 否则由 _stage_description 给出如实表述（3 条记录时有效周期仅 2 个）。
        "description": "已有3+条记录，贝叶斯后验生效，先验权重随数据增加而衰减",
    },
}


def _stage_by_record_count(n_records: int) -> str:
    """按月经记录数判定算法阶段（记录数口径，早期设计文档）。

    入参必须是 **记录数口径** 的值（`n_records_total`）。旧 /debug/model_history
    曾把模型输入规模（`model_params_json.n_records`）喂进本函数，导致同一快照
    被贴上偏乐观的阶段标签（v0.14.0 修 BN-1）。
    """
    if n_records == 0:
        return "empty"
    if n_records == 1:
        return "cold_1"
    if n_records == 2:
        return "cold_2"
    return "bayesian"


def _stage_by_model_input(n_valid: int) -> str:
    """按模型输入规模（有效周期数）判定阶段 —— 参与集口径，仅供 model_history 使用。

    映射与 `stats.predict_core` 返回的 `stage` 逐字一致（n=0 empty / 1 cold_1 /
    2 cold_2 / n≥3 bayesian）。/debug/model_history 的**记录数口径阶段不可确定**
    （见模块顶部「快照 ↔ 记录对应关系」），故逐快照只能给出本口径阶段；
    本字段**不是阶段徽章口径**（`algorithm_stage`），不得与 /debug/model 的
    `algorithm_stage` 直接比较（两者尺子不同，v0.14.0 修 BN-1）。
    """
    if n_valid <= 0:
        return "empty"
    if n_valid == 1:
        return "cold_1"
    if n_valid == 2:
        return "cold_2"
    return "bayesian"


def _stage_description(stage: str, n_valid: int, bayes_applied: bool) -> str:
    """阶段描述（v0.14.0 修 BN-1，审计 H2）。

    bayesian 阶段在 bayes_applied=False 时（3 条记录 → 有效周期 2 个）必须如实
    说明贝叶斯尚未参与预测，不得复用「贝叶斯后验生效」文案制造虚假确定感。
    """
    if stage == "bayesian" and not bayes_applied:
        return (
            f"已有3+条记录，进入自学习阶段；当前有效周期数 {n_valid} 个（< "
            f"{config.COLD_START_THRESHOLD}），贝叶斯后验尚未参与预测"
        )
    return _STAGE_META[stage]["description"]


def _confidence_label(confidence: float) -> str:
    """置信度等级映射（早期设计文档）。"""
    if confidence < 0.4:
        return "低"
    if confidence < 0.6:
        return "中低"
    if confidence < 0.75:
        return "中"
    if confidence < 0.85:
        return "中高"
    return "高"


def _weight_label(prior_weight: float) -> str:
    """权重分布 label 映射（早期设计文档，区间左开右闭）。

    v0.14.0 修 BN-2（审计 H3）：边界与文档严格对齐。旧实现用 `>= 0.5` / `>= 0.3`，
    把 0.7、0.5、0.3、0.15 四个断点的归属整体错位一档（如 0.71 被判为"先验主导"，
    而文档规定 `> 0.7` 为"纯先验"；cold_2 阶段的展示值 0.7143 正落在此例）。

    | prior_weight 区间 | label |
    |---|---|
    | > 0.7            | 纯先验 |
    | 0.5 < x <= 0.7   | 先验主导 |
    | 0.3 < x <= 0.5   | 过渡期 |
    | 0.15 < x <= 0.3  | 数据主导 |
    | x <= 0.15        | 强数据 |
    """
    if prior_weight > 0.7:
        return "纯先验"
    if prior_weight > 0.5:
        return "先验主导"
    if prior_weight > 0.3:
        return "过渡期"
    if prior_weight > 0.15:
        return "数据主导"
    return "强数据"


def _display_prior_weight(stage: str, table_prior_weight: float) -> float:
    """v0.5.0 展示档位先验权重。

    v0.14.0 修 BN-3（审计 H3）：本函数**不再作为 `weight_distribution.prior_weight`
    的取值来源**（该字段已改为算法真实值），仅在 `display_note` 中作为对照，让面板与
    验证脚本能看出展示档位与真实值的差异来源。

    档位定义（v0.5.0 展示决策，见早期设计文档）：
    - empty / cold_1: 1.0（无个人数据）
    - cold_2: 1/(1+2/PRIOR_DECAY_K) ≈ 0.7143 —— 此处的 "2" 是**记录数**；
      而算法真实输入只有 1 个有效周期（`predict_core`: pw = 1/(1+n_eff/k)，
      n_eff=1 → 0.8333），两者不一致正是 BN-3 要如实化的对象
    - bayesian: 表内权重（= predict_core 输出，与真实值一致）

    v0.13.0 修 F26：删除从未被使用的 n_total 形参（函数体仅依赖 stage 与表内权重）。
    """
    if stage in ("empty", "cold_1"):
        return 1.0
    if stage == "cold_2":
        return round(1.0 / (1.0 + 2 / config.PRIOR_DECAY_K), 4)
    return table_prior_weight


def _weight_description(prior_weight: float, n_eff: float) -> str:
    """权重分布 description：如实标注口径（v0.14.0 修 BN-3）。

    n_eff=0（无有效周期，纯先验）时说明原因，不留下"权重从何而来"的疑问。
    """
    data_weight = 1.0 - prior_weight
    if n_eff <= 0:
        return (
            f"数据权重 {data_weight * 100:.1f}%，先验权重 {prior_weight * 100:.1f}%"
            "（算法真实值：有效周期数 0，n_eff=0，完全依赖先验）"
        )
    return (
        f"数据权重 {data_weight * 100:.1f}%，先验权重 {prior_weight * 100:.1f}%"
        f"（算法真实值：n_eff={n_eff:g}，先验衰减常数 k={config.PRIOR_DECAY_K:g}，"
        f"公式 1/(1+n_eff/k)）"
    )


def _display_note(
    display_prior_weight: float, prior_weight: float, n_records_total: int, n_valid: int, n_eff: float
) -> str:
    """展示档位与算法真实值的差异说明（v0.14.0 修 BN-3）。

    两者相等时明说一致，避免用户误以为面板还停留在旧展示口径。
    """
    if abs(display_prior_weight - prior_weight) < 1e-9:
        return "展示值与算法真实值一致（v0.14.0 起展示档位不再覆盖真实值）"
    return (
        f"展示档位 {display_prior_weight:.4f} 来自 v0.5.0 展示决策"
        f"（按记录数 {n_records_total} 计算），算法真实先验权重为 {prior_weight:.4f}"
        f"（按有效周期数 {n_valid} 计算，n_eff={n_eff:g}）；"
        "v0.14.0 修 BN-3 起本响应与面板一律以算法真实值为准"
    )


# ============================================================
# 端点
# ============================================================

@router.get("/model")
async def get_debug_model(user: dict = Depends(require_user)) -> dict:
    """当前模型快照（早期设计文档）。

    数据来源（v0.14.0 修 BN-1：逐字段标注口径，见模块顶部口径登记表）：
    - `n_records_total` / `algorithm_stage`：cycles 表记录数（记录数口径）
    - `n_valid_cycles` / `model_input_n` / `model_params.n_records`：
      cycle_length IS NOT NULL 的条数 = `predict_core` 真实输入规模（参与集口径）
    - `model_params.prior_weight` 与 `n_eff` / `bayes_applied` / `model_version`：
      当前 `predict_core` 输出（与 trace、POST 链、prediction_service 同一入参口径）。
      表内 prior_weight 在 empty/cold_1 阶段仍是默认 0.5（该阶段 POST 链不更新模型行），
      故权重必须取算法真实值（BN-3）
    - `model_params.mean_cycle/std_cycle/ema_cycle/prior_mean/prior_std`：
      model_params 派生缓存（POST/重算/导入路径均同步刷新，与 core 逐值相等）

    只读，不触发任何算法更新。
    """
    model_params = await crud.get_model_params(user["id"])
    cycles = await crud.get_all_cycles(user["id"])
    valid_lengths = await crud.get_all_valid_cycle_lengths(user["id"])
    latest_pred = await crud.get_latest_prediction(user["id"])

    # 记录数口径（含硬无效记录与仅有开始日的锚点记录）
    n_records_total = len(cycles)
    stage = _stage_by_record_count(n_records_total)

    # 参与集口径 = predict_core 真实输入规模；与 /debug/model_history 的
    # n_records_at_time 同源（均为 model_params_json.n_records 的同一算法量）
    n_valid = len(valid_lengths)

    n_anomalous = sum(1 for c in cycles if c.get("is_anomalous", 0))
    # 硬无效（is_anomalous=1 且 cycle_length 落库置 NULL，不参与预测）与
    # 锚点记录（cycle_length 为 NULL 但非异常）是记录数口径中"不构成模型输入"
    # 的两类，单独计数以便面板解释 n_records_total 与 model_input_n 的差额。
    n_hard_invalid = sum(
        1 for c in cycles
        if c.get("is_anomalous", 0) and c.get("cycle_length") is None
    )
    n_anchor_records = sum(
        1 for c in cycles
        if c.get("cycle_length") is None and not c.get("is_anomalous", 0)
    )

    # 算法真实结果（与 trace/POST 链/重算路径同一入参：prev_ema 不含最新一条）
    core = stats.predict_core(
        valid_lengths, replay_ema(valid_lengths, config, exclude_last=True), config
    )
    prior_weight = round(float(core["prior_weight"]), 4)
    data_weight = round(1.0 - prior_weight, 4)
    n_eff = round(float(core["n_eff"]), 2)
    bayes_applied = bool(core["bayes_applied"])
    display_prior_weight = round(_display_prior_weight(stage, prior_weight), 4)

    # 置信度：取最新预测（冷启动阶段 prediction 已存 0.4/0.5），无预测时 empty 默认 0.3
    if stage == "empty":
        confidence = config.CONFIDENCE_COLD_0
    else:
        confidence = float(latest_pred.get("confidence", config.CONFIDENCE_COLD_0)) if latest_pred else config.CONFIDENCE_COLD_0

    # last_updated：empty 阶段无用户数据更新过模型，返回 null（早期设计文档）
    last_updated = None if n_records_total == 0 else model_params.get("updated_at")

    # 0 条记录时无任何预测，算法版本标签为 none（与 /predictions/current 的
    # 无记录分支同口径）；有记录时取 predict_core 真实输出，不自行按记录数推断。
    model_version = (
        config.MODEL_VERSION_NONE if n_records_total == 0 else core["model_version"]
    )

    stage_meta = _STAGE_META[stage]
    return {
        # 记录数口径（algorithm_stage 与 /debug/model_history、/debug/prediction_trace 同一把尺子）
        "algorithm_stage": stage,
        "algorithm_stage_caliber": "n_records",
        "stage_label": stage_meta["label"],
        "stage_description": _stage_description(stage, n_valid, bayes_applied),
        "model_params": {
            "mean_cycle": round(float(model_params.get("mean_cycle", config.PRIOR_MEAN)), 2),
            "std_cycle": round(float(model_params.get("std_cycle", config.PRIOR_STD)), 2),
            # 参与集口径：与顶层 n_valid_cycles / model_input_n 同源且必然相等
            "n_records": n_valid,
            "n_records_caliber": "model_input（cycles.cycle_length IS NOT NULL）",
            "ema_cycle": round(float(model_params.get("ema_cycle", config.PRIOR_MEAN)), 2),
            "prior_mean": round(float(model_params.get("prior_mean", config.PRIOR_MEAN)), 2),
            "prior_std": round(float(model_params.get("prior_std", config.PRIOR_STD)), 2),
            # v0.14.0 修 BN-3：算法真实先验权重（predict_core 输出），不再用展示档位覆盖
            "prior_weight": prior_weight,
        },
        "weight_distribution": {
            # v0.14.0 修 BN-3：prior_weight/data_weight/label/description 全部改为
            # 算法真实值（字段名保持不变，前端 debug.js 依赖）
            "prior_weight": prior_weight,
            "data_weight": data_weight,
            "label": _weight_label(prior_weight),
            "description": _weight_description(prior_weight, n_eff),
            # 新增：v0.5.0 展示档位对照值 + 差异来源说明
            "display_prior_weight": display_prior_weight,
            "display_note": _display_note(
                display_prior_weight, prior_weight, n_records_total, n_valid, n_eff
            ),
        },
        "confidence": round(confidence, 3),
        "confidence_label": _confidence_label(confidence),
        # 记录数口径（n_records_total 为新命名，n_total_cycles 为兼容旧名）
        "n_records_total": n_records_total,
        "n_total_cycles": n_records_total,
        # 参与集口径（model_input_n 为新命名，n_valid_cycles 为兼容旧名）
        "model_input_n": n_valid,
        "n_valid_cycles": n_valid,
        "n_anomalous": n_anomalous,
        "n_hard_invalid": n_hard_invalid,
        "n_anchor_records": n_anchor_records,
        # v0.14.0 修 BN-1（审计 H2）：贝叶斯是否真的生效只看本字段；
        # model_version 仅是版本标签，不得据此推断贝叶斯是否生效
        "bayes_applied": bayes_applied,
        "model_version": model_version,
        "n_eff": n_eff,
        "last_updated": last_updated,
    }


@router.get("/model_history")
async def get_debug_model_history(user: dict = Depends(require_user)) -> dict:
    """模型参数演化轨迹（早期设计文档）。

    数据来源：predictions 表的 model_params_json 字段（每次生成预测保存的快照）。
    model_params_json 解析失败时跳过该条，不报错。按 created_at ASC、predicted_date ASC
    （并列兜底）、id ASC（最后兜底）排序（老→新）。

    v0.14.0 修 BN-1（审计 H1）：predictions 表并非只由 POST /cycles 写入（过期刷新
    新增行、删除/修正重算先删后增、导入一次写多行并还原 created_at），故
    "第 k 个快照 = 第 k 条记录"**不成立**，逐快照的月经记录条数无法可靠确定：
    - `n_records_at_time` / `model_input_n`：模型输入口径（= 该快照
      model_params_json.n_records = 当时的 predict_core 真实输入规模），语义与旧字段兼容；
    - `n_records_recorded`：记录数口径，**一律 null**（不可确定，绝不伪造）；
    - `algorithm_stage`：记录数口径阶段，随 n_records_recorded 不可确定而返回 null
      （旧实现把模型输入规模喂进 `_stage_by_record_count`，属双重量纲错误）；
    - `algorithm_stage_by_model_input`：参与集口径的逐快照模型状态（映射与
      predict_core 的 stage 一致，仅供历史轨迹展示，不是徽章口径）；
    - `model_version` / `bayes_applied`：快照落库的真实结果（不重算）；旧快照或
      导入快照可能缺 bayes_applied，此时返回 null 而非猜测。
    当前月经记录条数见 GET /debug/model 的 n_records_total。
    """
    predictions = await crud.get_all_predictions(user["id"])
    # 排序口径（R34-A 内容锚纵深防御）：
    # - 本消费方（模型演化图）的语义锚是「快照何时生成」→ created_at 作主键，
    #   不得把 predicted_date 提为主键（那会让"后写入但预测目标日更早"的快照
    #   排到前面，test_api_debug 注入的 predicted_date=2020 直写快照即钉住此语义）；
    # - created_at 在历史迁移/导入数据里会并列，而并列时 id 序与时间序可能相反
    #   （0.22.4 之前导入过的账号：旧 /export 按 created_at DESC 出文件、旧
    #   /import 按文件序插入）→ 用数据自带、不依赖插入顺序的 predicted_date
    #   作并列兜底；
    # - id 只作最后兜底（同 created_at 且同 predicted_date 的极端情形）。
    # 与 crud.get_all_predictions 的 SQL 排序同键，属纵深防御：本端点的顺序
    # 不依赖 crud 层 ORDER BY 的具体形态。
    predictions = sorted(
        predictions,
        key=lambda p: (
            str(p.get("created_at") or ""),
            str(p.get("predicted_date") or ""),
            int(p.get("id") or 0),
        ),
    )
    history: list[dict] = []

    for p in predictions:
        try:
            mp: dict[str, Any] = json.loads(p.get("model_params_json") or "{}")
        except (json.JSONDecodeError, TypeError):
            continue  # 解析失败跳过该条（风险7.1缓解）

        if not isinstance(mp, dict):
            continue

        # 模型输入口径（快照落库时的 predict_core 输入规模）
        # 2026-10-31 修 #24：导入校验与 Android 同构允许 n_records/prior_weight 为 null，
        # 消费侧按缺失默认处理（0 / 1.0），避免 int(None)/float(None) 把本端点钉成永久 500。
        raw_n_records = mp.get("n_records")
        model_input_n = int(raw_n_records) if raw_n_records is not None else 0
        # 快照落库时的真实结果：旧快照/导入快照可能没有 bayes_applied → null（不猜）
        raw_bayes = mp.get("bayes_applied")
        bayes_applied = bool(raw_bayes) if isinstance(raw_bayes, (bool, int)) else None
        raw_prior_weight = mp.get("prior_weight")
        prior_weight = float(raw_prior_weight) if raw_prior_weight is not None else 1.0
        history.append({
            "prediction_id": p["id"],
            "created_at": p.get("created_at"),
            # 模型输入口径（兼容旧字段语义）
            "n_records_at_time": model_input_n,
            "model_input_n": model_input_n,
            # 记录数口径：无法按快照序号推断（依据见模块顶部口径登记表）→ null
            "n_records_recorded": None,
            # 记录数口径阶段：随 n_records_recorded 不可确定 → null（不伪造）
            "algorithm_stage": None,
            "algorithm_stage_caliber": "n_records",
            # 参与集口径阶段（与 predict_core 的 stage 映射一致）：供面板/脚本判断
            # 该快照当时的模型状态；不是徽章口径，勿与 algorithm_stage 比较
            "algorithm_stage_by_model_input": _stage_by_model_input(model_input_n),
            "model_version": p.get("model_version"),
            "bayes_applied": bayes_applied,
            "model_params": {
                "mean_cycle": round(float(mp.get("mean_cycle", config.PRIOR_MEAN)), 2),
                "std_cycle": round(float(mp.get("std_cycle", config.PRIOR_STD)), 2),
                "n_records": model_input_n,
                "ema_cycle": round(float(mp.get("ema_cycle", config.PRIOR_MEAN)), 2),
                "prior_weight": round(prior_weight, 4),
            },
        })

    return {
        "total_snapshots": len(history),
        # 机器可读的自证：逐快照记录数不可得，避免消费方误以为 null 是"数据缺失"
        "n_records_recorded_available": False,
        "caliber_note": (
            "n_records_at_time / model_input_n 为模型输入口径（该快照 model_params_json."
            "n_records，即当时 predict_core 的真实输入规模）；n_records_recorded 为记录数"
            "口径，因 predictions 表存在非 POST /cycles 写入路径（过期刷新新增行、删除/"
            "修正重算先删后增、导入一次多行），快照序号与记录条数无一一对应关系，故一律"
            "返回 null，algorithm_stage（记录数口径）随之不可确定；逐快照的模型状态请看"
            "algorithm_stage_by_model_input / bayes_applied（参与集口径）；当前记录数见 "
            "GET /debug/model 的 n_records_total。"
        ),
        "history": history,
    }


@router.get("/prediction_trace")
async def get_debug_prediction_trace(user: dict = Depends(require_user)) -> dict:
    """当前预测的逐步计算踪（早期设计文档）。

    无记录：steps=[], final_prediction=null, stage="empty", message。
    有记录：调用 algo/trace.prediction_trace；`algorithm_stage` 按记录数口径覆盖
    （trace 内部 stage 基于有效周期数，API 层统一为记录数口径，见口径登记表），
    并新增 `algorithm_stage_caliber` 自证。

    v0.14.0 修 BN-1（审计 H1：Step 4 是否存在与 final_prediction.std 是否为先验兜底
    必须能被前端解释）：
    - 新增顶层 `bayes_applied` / `model_version`，取自**同一入参的 predict_core 真实
      输出**（与 trace 内部调用同一纯函数、同一 cycle_lengths 与 prev_ema，逐值相同），
      供前端与验证脚本判断"贝叶斯是否真的生效"；不得用 model_version 推断。
    - 删除旧的 `if n_records == 1: 去掉 Step 4` 写法：那是"按记录数猜着删步骤"，
      与 trace 的真实行为打架。Step 4 是否存在完全由 trace 的算法规则决定
      （n=0 或 n≥COLD_START_THRESHOLD 展示；1≤n<3 时 trace 自身已跳过），
      本层不再增删任何步骤。
    - 冷启动 note 的判据改为算法真实条件（`bayes_applied=False`，即有效周期数
      < COLD_START_THRESHOLD），并如实给出两个数字，不再声称"需要3+条记录"。
    """
    latest = await crud.get_latest_cycle(user["id"])
    if latest is None:
        return {
            "steps": [],
            "final_prediction": None,
            "algorithm_stage": "empty",
            "algorithm_stage_caliber": "n_records",
            "n_records_total": 0,
            "model_input_n": 0,
            # 无记录 → 无预测：算法版本标签 none（与 /predictions/current 同口径）
            "bayes_applied": False,
            "model_version": config.MODEL_VERSION_NONE,
            "message": "尚无记录，无法计算预测",
        }

    cycle_lengths = await crud.get_all_valid_cycle_lengths(user["id"])
    model_params = await crud.get_model_params(user["id"])
    n_records = len(await crud.get_all_cycles(user["id"]))

    # v0.9.0 修 P2（U4 同族）：prev_ema 不得用表中 ema_cycle——它已含最新一条合法周期，
    # 再传入 predict_core 会把最新周期重复应用一次 EMA（v0.7.4 文档 D12 缺陷的复活）。
    # 与 POST 链/过期刷新/删除重算路径严格同源：全量历史重推「不含最新一条」的 prev_ema。
    prev_ema = replay_ema(cycle_lengths, config, exclude_last=True)
    result = trace.prediction_trace(
        last_period_start=str(latest["period_start"]),
        cycle_lengths=cycle_lengths,
        prev_ema=prev_ema,
        model_params=model_params,
        config_obj=config,
    )

    # 算法真实结果：与 trace 内部同一纯函数、同一入参（结果必然逐值相同），
    # 用于暴露"贝叶斯是否真的生效"，不自行按记录数/阈值重算（BN-1 审计 H2）
    core = stats.predict_core(cycle_lengths, prev_ema, config)
    n_valid = int(core["n"])
    bayes_applied = bool(core["bayes_applied"])

    result["algorithm_stage"] = _stage_by_record_count(n_records)
    result["algorithm_stage_caliber"] = "n_records"
    result["n_records_total"] = n_records
    result["model_input_n"] = n_valid
    result["bayes_applied"] = bayes_applied
    result["model_version"] = core["model_version"]

    # 冷启动 note：真实条件 = 有效周期数 < COLD_START_THRESHOLD（贝叶斯未参与预测）。
    # 不再声称步骤缺失（n=0 时 trace 仍展示"后验退化为先验均值"的 Step 4）。
    if not bayes_applied:
        result["note"] = (
            f"冷启动阶段：贝叶斯后验未参与预测——有效周期数 {n_valid} 个（需 ≥"
            f"{config.COLD_START_THRESHOLD} 个），当前月经记录 {n_records} 条"
        )

    return result
