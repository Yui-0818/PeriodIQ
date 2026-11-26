# Copyright (c) 2026 Yui_0818 (aaaj6719@gmail.com)
# Licensed under the PolyForm Noncommercial License 1.0.0.
# Commercial use is prohibited without separate written authorization.
# See LICENSE and COMMERCIAL.md in the repository root.

"""cycles 路由（早期设计文档）。

端点：
- GET /cycles: 获取所有记录（日期倒序）
- POST /cycles: 新增记录（副作用链：算cycle_length → 异常检查 → 贝叶斯更新 → 生成预测 → 保存）
- PUT /cycles/{id}: 修改记录
- DELETE /cycles/{id}: 删除记录（触发全量重算 model_params）

致命Bug禁令规避：
- 首条记录 cycle_length=NULL，不触发模型更新
- 异常周期只存不参与计算
- 预测基于最近一条已结束记录的 period_start
- 删除记录后触发全量重算 model_params
- 插入时不得与**前后邻居**记录的区间重叠（v0.14.0 修 AN-4：与 PUT 同一套全量
  邻居规则，重叠 → 400 DATE_OVERLAP；补录历史合法）
- predictions 表 model_params_json 必填

v0.14.0（审计 H4/H5）本模块两处数据保真修复：
- 修 AN-3：修正 period_start 后按新记录日期重推所有预测的 actual_date / error_days
  （见 prediction_service.rebackfill_prediction_actuals，审计第二批 P2 起为跨模块
  共用的单一实现），否则 /analysis/accuracy 的 MAE/hit_rate/
  bias/trend 长期带脏数据。
- 修 AN-4：POST 的重叠校验改为「全量前后邻居」规则并支持补录历史；补录时模型侧
  走全量重算管线，预测锚点取「全部记录中 period_start 最大那条」。
"""

import json
from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException, status

from app import config
from app.algo.bayesian import on_new_cycle_added
from app.algo.stats import predict_next_period, replay_ema
from app.db import crud
from app.db.crud import _sanitize_cycle_length
from app.db.database import WriteLock
from app.prediction_service import rebackfill_prediction_actuals
from app.security import require_user
from app.schemas.api import (
    CycleCreate,
    CycleCreateResponse,
    CycleResponse,
    CycleUpdate,
)

router = APIRouter(prefix="/cycles", tags=["cycles"])


# ============================================================
# 辅助函数
# ============================================================

def _to_iso(d: date | None) -> str | None:
    """date 转 ISO 字符串。"""
    return d.isoformat() if d else None


async def _check_date_overlap(user_id: int, period_start: date, period_end: date | None, db=None) -> None:
    """检查新记录与**前后邻居**记录的区间重叠（v0.14.0 修 AN-4）。

    致命 Bug 禁令：插入记录不得与已有记录日期重叠 → 400 DATE_OVERLAP。
    v0.13.0 修 F7：db 参数（见 E7 约定）传入外层 WriteLock 连接时，重叠校验
    在锁内读取未提交态，与插入同事务串行，杜绝并发同日期 double-insert。

    v0.14.0 修 AN-4（审计 H5）——旧实现只与「最新一条记录」（period_start 最大）
    比较并要求 new.start > latest.end，有三个缺陷：
    (a) 与 PUT /cycles/{id} 的校验严格度不同（PUT 取合并后的前后邻居），同一份
        数据 POST 能写进去而 PUT 会拒；
    (b) 完全不校验 new.period_end 与已有记录的冲突，也不校验「插入到中间」的情形
        → 可造出区间重叠的记录；
    (c) 一切补录历史都被 400 拒绝（前端日历页承诺「过往经期日期可修正」，属用户
        可感知的功能缺失）。

    新口径（与 PUT 同源）：
    - 取该用户全部记录（锁内同一连接，升序），按 period_start 找出新记录应处的
      前一条（start < new_start 中最大者）与后一条（start > new_start 中最小者）；
    - 占用区间口径（沿用 PUT 既有实现的登记口径）：无 period_end 的
      记录占用 `[start, start]`；
    - 违规一：new_start <= 前邻居占用末 → 「与前一条记录重叠」；
    - 违规二：new_end_or_start >= 后邻居.start → 「与下一条记录重叠」；
    - 补录历史（插入到两条记录之间、或早于首条）只要不压到邻居即合法。

    **已知边界（v0.14.0 验收实测登记，判定为设计取舍而非缺陷）**：两条**都未填
    period_end** 的相邻记录（如 03-01 与 03-02）可被写入——因为「未填结束日」的
    占用口径就是当天，两者不构成区间重叠。这在稀疏录入数据下是**必要的**：
    用户常常只记开始日、事后再补结束日或补录中间记录，若把「未填结束日」视为
    「持续占用到下一次记录前」，一切中间补录都会被拒（v0.14.0 曾试改此口径，
    实测导致 6 条既有补录/修正用例失败，已回退）。相邻同日经期记录的区分由前端
    日历交互（点今天记录、点过往修正）与「一次经期一条记录」的使用约定保证。
    """
    records = await crud.get_all_cycles_asc(user_id, db=db)
    new_start_iso = period_start.isoformat()
    prev_rec: dict | None = None
    next_rec: dict | None = None
    for r in records:
        # get_all_cycles_asc 已按 period_start 升序：start < new_start 的最后一条
        # 即前邻居，start >= new_start 的第一条即后邻居
        if r["period_start"] < new_start_iso:
            if prev_rec is None or r["period_start"] > prev_rec["period_start"]:
                prev_rec = r
        elif next_rec is None or r["period_start"] < next_rec["period_start"]:
            next_rec = r

    if prev_rec is not None:
        prev_end = prev_rec["period_end"] or prev_rec["period_start"]
        if new_start_iso <= prev_end:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={
                    "detail": (
                        f"开始日期与前一条记录（{prev_rec['period_start']}~{prev_end}）重叠："
                        "period_start 不能早于或等于上一条记录的 period_end"
                    ),
                    "code": "DATE_OVERLAP",
                },
            )
    if next_rec is not None:
        occupied_until = (period_end or period_start).isoformat()
        if occupied_until >= next_rec["period_start"]:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={
                    "detail": (
                        f"记录区间与下一条记录（{next_rec['period_start']}）重叠："
                        "period_end 不能晚于或等于下一条记录的 period_start"
                    ),
                    "code": "DATE_OVERLAP",
                },
            )


async def _current_prediction_payload(user_id: int, db) -> dict:
    """重算后读取「当前预测」快照（v0.14.0 修 AN-4 补录历史分支的响应用）。

    与 crud.regenerate_current_prediction 严格同源同参：同一条 db 连接、
    同一批合法周期长度（升序全量）、同一最新记录锚点、同一 replay_ema 口径，
    且调用同一个纯函数 predict_next_period——因此返回值与该方法刚落库的预测行
    逐值一致。本函数**只读不写**（不新增第二个预测来源，也不重复落库）。
    """
    cycle_lengths = await crud.get_all_valid_cycle_lengths(user_id, db=db)
    latest = await crud.get_latest_cycle(user_id, db=db)
    if latest is None:
        # 防御性兜底（调用点刚插入过记录，理论不可达）：返回空预测契约
        return predict_next_period(None, [], None, config)
    return predict_next_period(
        date.fromisoformat(latest["period_start"]),
        cycle_lengths,
        replay_ema(cycle_lengths, config, exclude_last=True),
        config,
    )


async def _run_post_cycle_chain(
    db,
    user_id: int,
    new_cycle_id: int,
    period_start: date,
    period_end: date | None,
    note: str,
) -> dict:
    """执行 POST /cycles 副作用链（既有 API 契约）。

    M5 Bug2 修复：所有写操作使用传入的 db 连接，与 create_cycle 同属一个事务，
    任一步骤失败则整体回滚（WriteLock 上下文异常时自动 ROLLBACK）。

    流程（**追加为最新记录**路径，本条 period_start 是全部记录中最大者）：
    1. 算 cycle_length（首条=None）→ 调用 algo.on_new_cycle_added
    2. 异常检查（在 algo 内完成）
    3. 贝叶斯更新（在 algo 内完成）
    4. 持久化 model_params（用 db.execute）
    5. 生成预测（algo 返回，锚点=本条记录）
    6. 保存预测快照（model_params_json 必填，用 db.execute）
    7. 回填**全部**未验证预测的 actual_date（v0.12.0 修 E8，用 db.execute）

    补录历史分支（v0.14.0 修 AN-4：本条并非最新记录）：
    - 模型侧交给「全量重算」单一管线 _recompute_all_records（与 PUT 修正开始日、
      导入共用）：按 period_start 升序重推 cycle_length → 全量重算 model_params
      → 清理未验证预测 → **以「全部记录中 period_start 最大那条」为锚点**重新生成
      当前预测（含 AN-3 的 actual 重推）。
    - 不在此分支做「把未验证预测回填为本条历史日期」：补录的历史日期不是
      「下一次来潮」这一目标；验证归属由 rebackfill_prediction_actuals 的
      锚点口径统一判定。
    - 也不落 algo 返回的 model_params/预测：on_new_cycle_added 的周期长度序列是
      「历史长度 + 本条长度追加在末尾」，补录时中间记录的周期会被错放到序列末尾
      （窗口/EMA/latest_cycle 取错），必须用升序全量序列重算（n_records 等同源）。

    读操作（get_previous_cycle_before/get_model_params/get_all_valid_cycle_lengths/
    get_prediction_history）保持用 crud（独立连接，不加锁，不影响事务）。

    Args:
        db: WriteLock 持有的数据库连接，所有写操作通过它执行以保证事务原子性。
        new_cycle_id: 新插入记录的 id。
        period_start: 新记录开始日期。
        period_end: 新记录结束日期（可选）。
        note: 备注。

    Returns:
        prediction dict（用于响应）。
    """
    # 读操作：获取上一条记录（用于算 cycle_length）
    prev_cycle = await crud.get_previous_cycle_before(user_id, period_start.isoformat())
    prev_period_start = None
    if prev_cycle is not None:
        prev_period_start = date.fromisoformat(prev_cycle["period_start"])

    # 读操作：获取当前 model_params + 历史有效周期长度
    current_params = await crud.get_model_params(user_id)
    historical_cycles = await crud.get_all_valid_cycle_lengths(user_id)
    current_params["cycle_lengths"] = historical_cycles

    # 调用算法层（纯函数，不操作DB；v0.13.0 修 F26：on_new_cycle_added 去伪 async，同步调用）
    algo_result = on_new_cycle_added(
        new_period_start=period_start,
        prev_period_start=prev_period_start,
        current_params=current_params,
        config_obj=config,
    )

    cycle_length = algo_result["cycle_length"]
    is_anomalous = algo_result["is_anomalous"]
    # v0.9.0 修 P1：持久化判定用 is_hard_invalid（<7/>90 不参与计算），
    # 不得用 is_anomalous——偏离型异常周期（[7,90] 内偏离中位数>14 天）在算法层
    # 已被鲁棒降权纳入计算，按 is_anomalous 跳过落库会让 model_params 表
    # 与 predict_core 口径分叉（U1「单一来源」的漏网之鱼，靠 U2 自愈兜底不彻底）。
    is_hard_invalid = algo_result["is_hard_invalid"]
    new_model_params = algo_result["model_params"]
    prediction = algo_result["prediction"]

    # 计算 period_days（结束日期存在时）
    period_days = None
    if period_end is not None:
        period_days = (period_end - period_start).days + 1

    # 写操作：持久化 cycle 记录的 cycle_length/period_days/is_anomalous/note
    # Bug1 修复：异常周期 cycle_length 经 _sanitize_cycle_length 超范围转 NULL
    # v0.13.0 修 F8：改用 crud.finalize_cycle_derived（总是显式写入，与 update_cycle 语义不同）
    safe_cycle_length = _sanitize_cycle_length(cycle_length)
    await crud.finalize_cycle_derived(
        new_cycle_id,
        safe_cycle_length,
        period_days,
        is_anomalous,
        note,
        db=db,
    )

    # v0.14.0 修 AN-4：判定本条是否为「最新记录」（period_start 最大者）。
    # get_all_cycles_asc 按 (period_start ASC, id ASC)，末条即最新记录；
    # 同日重复已被 _check_date_overlap 拒绝，不存在并列。
    all_records = await crud.get_all_cycles_asc(user_id, db=db)
    latest_start_iso = (
        all_records[-1]["period_start"] if all_records else period_start.isoformat()
    )
    if latest_start_iso != period_start.isoformat():
        # 补录历史：模型侧走全量重算单一管线（顺序正确的升序周期序列），
        # 预测锚点为「全部记录中 period_start 最大那条」，不是本条历史日期。
        await _recompute_all_records(user_id, db=db)
        return await _current_prediction_payload(user_id, db=db)

    # 写操作：持久化 model_params（首条或硬无效时不更新，algo 已处理）
    if cycle_length is not None and not is_hard_invalid:
        # v0.13.0 修 F8：改用 crud.update_model_params（UPSERT）；该用户行由
        # ensure_user_defaults 保证存在，与旧纯 UPDATE 行为等价
        await crud.update_model_params(
            user_id,
            mean_cycle=new_model_params["mean_cycle"],
            std_cycle=new_model_params["std_cycle"],
            n_records=new_model_params["n_records"],
            ema_cycle=new_model_params["ema_cycle"],
            prior_mean=new_model_params["prior_mean"],
            prior_std=new_model_params["prior_std"],
            prior_weight=new_model_params["prior_weight"],
            db=db,
        )

    # 写操作：回填所有未验证预测的 actual_date（必须在创建新预测之前，避免回填本次预测）
    # v0.12.0 修 E8：每条未验证预测针对的都是「下一次来潮」这一目标，新记录到来
    # 时应全部回填——旧逻辑只回填最近一条，import 多条未验证预测时其余永久挂起，
    # 精度评估 total_predictions 虚高、evaluated 比例偏低（临床判别口径：同一目标
    # 周期的所有预测都应被实际来潮日验证）。
    # 读操作用 crud，写操作用传入的 db
    history = await crud.get_all_predictions(user_id)
    for pred in history:
        if pred.get("actual_date") is None:
            predicted_date = date.fromisoformat(pred["predicted_date"])
            error_days = abs((period_start - predicted_date).days)
            # v0.13.0 修 F8：改用 crud.backfill_prediction_actual
            await crud.backfill_prediction_actual(
                pred["id"], period_start.isoformat(), error_days, db=db
            )

    # 写操作：保存预测快照（model_params_json 必填，致命 Bug 禁令）
    if prediction["predicted_date"] is not None:
        # v0.13.0 修 F8：改用 crud.create_prediction
        await crud.create_prediction(
            user_id,
            predicted_date=prediction["predicted_date"],
            predicted_start_upper=prediction["predicted_start_upper"],
            predicted_start_lower=prediction["predicted_start_lower"],
            confidence=prediction["confidence"],
            model_version=prediction["model_version"],
            model_params_json=json.dumps(prediction["model_params"], ensure_ascii=False),
            db=db,
        )

    return prediction


async def _recompute_after_delete(user_id: int, db=None) -> None:
    """删除记录后触发全量重算 model_params（致命 Bug 禁令）。

    M5 新Bug D 修复：删除记录后清理 actual_date IS NULL 的未验证预测。
    问题：删除最近记录后，上一条预测（针对被删记录）永远挂留为未验证，
    导致精度评估的 total_predictions 虚高、evaluated 比例偏低。
    修复：删除未验证预测后再重新生成新预测。

    v0.12.0 修 E7：全链并入同一事务——db=None 时自开 WriteLock 包裹全部步骤；
    传入外层 WriteLock 连接时（删除/修正端点）直接在其事务内执行，任一步骤
    失败整体回滚，杜绝「删除已提交、重算半途失败」的中间态。

    v0.14.0 修 AN-3 口径说明：删除路径**不**重推已回填预测的 actual_date /
    error_days（rebackfill_prediction_actuals 不在本链内）——删除真实记录后
    被删日期可能正是某条预测的验证日，是否清空属语义决策，未获授权，
    故保持原值不动（避免「悄悄清空」的静默数据变更）。
    """
    if db is not None:
        await _recompute_after_delete_tx(db, user_id)
        return
    async with WriteLock() as tx:
        await _recompute_after_delete_tx(tx, user_id)


async def _recompute_after_delete_tx(db, user_id: int) -> None:
    """_recompute_after_delete 的事务体：所有读写走传入的 db 连接（E7）。"""
    cycle_lengths = await crud.get_all_valid_cycle_lengths(user_id, db=db)
    # v0.8.1：EMA 按全量历史重放（与逐条增量链严格一致），
    # 不再直接用表中 ema_cycle（它对应删除前的记录集，已不可信）
    await crud.full_recompute_model_params(user_id, cycle_lengths, db=db)

    # M5 新Bug D：清理未验证预测（actual_date IS NULL），
    # 它们已无对应实际日期可验证，留着会污染精度评估
    await crud.delete_unverified_predictions(user_id, db=db)

    # 重新生成预测（基于最新记录；prev_ema 同样用历史重放值，不含最新一条）
    # v0.12.0：单一来源 crud.regenerate_current_prediction（修「两处重写漂移」）
    await crud.regenerate_current_prediction(user_id, db=db)


# ============================================================
# 端点
# ============================================================

@router.get("", response_model=list[CycleResponse])
async def list_cycles(user: dict = Depends(require_user)) -> list[dict]:
    """获取所有月经记录（日期倒序）。"""
    cycles = await crud.get_all_cycles(user["id"])
    return cycles


@router.post("", response_model=CycleCreateResponse, status_code=status.HTTP_201_CREATED)
async def create_cycle(body: CycleCreate, user: dict = Depends(require_user)) -> dict:
    """新增月经记录（含副作用链，既有 API 契约）。

    副作用链：算cycle_length → 异常检查 → 贝叶斯更新 → 生成预测 → 保存 → 返回含prediction

    M5 Bug2 修复：用 WriteLock 事务包裹 create_cycle + _run_post_cycle_chain，
    任一步骤失败则整体回滚（WriteLock 上下文异常时自动 ROLLBACK），
    避免脏数据（如 create_cycle 成功但 update_cycle 失败留下 cycle_length=NULL 的记录）。

    v0.14.0 修 AN-4：重叠校验为「前后邻居」全量规则（与 PUT 同一套），
    **支持补录历史**（插入到已有记录之间/之前，只要不压到邻居）；
    补录时副作用链的模型侧走全量重算，预测锚点为最新的真实记录（见
    _run_post_cycle_chain 的补录历史分支）。
    """
    # 用 WriteLock 事务包裹整个副作用链（M5 Bug2 修复）
    async with WriteLock() as db:
        # v0.13.0 修 F6：插入前校验「结束日不能早于开始日」（与 PUT 同款同错误码）
        if body.period_end is not None and body.period_end < body.period_start:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={"detail": "结束日期不能早于开始日期", "code": "INVALID_PERIOD_END"},
            )

        # v0.13.0 修 F7：重叠校验移入锁内，用传入 db 读未提交态（并发同日期 second 读到已提交首条 → 400）
        await _check_date_overlap(user["id"], body.period_start, body.period_end, db=db)

        # 插入记录（cycle_length/period_days 后续在副作用链中回填）
        # v0.13.0 修 F7：改用 crud.create_cycle 走 E7 db 分支，与锁内事务同连接串行
        new_id = await crud.create_cycle(
            user["id"],
            period_start=body.period_start.isoformat(),
            period_end=_to_iso(body.period_end),
            cycle_length=None,
            period_days=None,
            note=body.note,
            is_anomalous=False,
            db=db,
        )

        # 执行副作用链（用传入的 db，保证事务原子性）
        prediction = await _run_post_cycle_chain(
            db=db,
            user_id=user["id"],
            new_cycle_id=new_id,
            period_start=body.period_start,
            period_end=body.period_end,
            note=body.note,
        )

        # 读取最终记录返回（用同一 db，保证读到事务内的最新状态）
        async with db.execute("SELECT * FROM cycles WHERE id = ?", (new_id,)) as cursor:
            row = await cursor.fetchone()
        cycle = dict(row)

    response = dict(cycle)
    response["prediction"] = prediction if prediction["predicted_date"] is not None else None
    return response


@router.put("/{cycle_id}", response_model=CycleResponse)
async def update_cycle(cycle_id: int, body: CycleUpdate, user: dict = Depends(require_user)) -> dict:
    """修改月经记录（v0.9.0：支持修正 period_start / period_end / note）。

    v0.9.0 放开 period_start（用户授权的「修正」功能，前端日历信息卡入口）：
    - 邻接重叠校验：新开始日必须晚于上一条记录的结束日（或开始日）；
      新结束日必须早于下一条记录的开始日（400 DATE_OVERLAP）
    - period_start 变更后触发**全量重算**：本条及其后所有记录的 cycle_length
      按「与上一条开始日的间隔」重推、异常标记按既有口径重置，
      model_params 全量重算并重新生成当前预测（与删除路径同一套重算管线）
    - 仅改 period_end / note 时维持原语义（period_days 原子更新，P4；
      M5 新Bug B 的 end >= start 校验保留）
    - v0.11.5 修 B1：clear_period_end=True 显式清空结束日（period_days 联动置 NULL）。
      cycle_length 只由 period_start 间隔决定，清空不触发模型重算。
    - v0.13.1 修 G2：全部校验（存在性/起止序/邻接重叠）移入 WriteLock 内，
      用同一事务连接读取——旧实现校验在锁外独立连接读、之后才进锁写，
      并发修正两条记录可产生日期重叠数据（F7 只修了 POST 的同类 TOCTOU）。
      锁内重读后与写入串行，校验-写入原子。
    """
    async with WriteLock() as db:
        existing = await crud.get_cycle_by_id(user["id"], cycle_id, db=db)
        if existing is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail={"detail": "记录不存在", "code": "NOT_FOUND"},
            )

        # 合并后的最终起止日（未提供的字段沿用现有值；clear_period_end 显式清空）
        final_start = (body.period_start or date.fromisoformat(existing["period_start"]))
        if body.clear_period_end:
            final_end = None
        else:
            final_end = body.period_end if body.period_end is not None else (
                date.fromisoformat(existing["period_end"]) if existing["period_end"] else None
            )

        # 校验：结束日 >= 开始日（M5 新Bug B 延续）
        if final_end is not None and final_end < final_start:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={"detail": "结束日期不能早于开始日期", "code": "INVALID_PERIOD_END"},
            )

        start_changed = (
            body.period_start is not None
            and body.period_start.isoformat() != existing["period_start"]
        )

        # 邻接重叠校验（v0.9.0）：在**其余记录**中按合并后的新起止日找前后邻居，
        # 任何重叠 → 400 DATE_OVERLAP。无结束日的记录占用区间视为 [start, start]
        # （占用口径与 POST 的 _check_date_overlap 同源，v0.14.0 修 AN-4 已统一）。
        # v0.13.1 修 G2：锁内用事务连接读取（与写入同视图串行）。
        others = [r for r in await crud.get_all_cycles_asc(user["id"], db=db) if r["id"] != cycle_id]
        prev_rec: dict | None = None
        next_rec: dict | None = None
        for r in others:
            if r["period_start"] < final_start.isoformat():
                if prev_rec is None or r["period_start"] > prev_rec["period_start"]:
                    prev_rec = r
            elif next_rec is None or r["period_start"] < next_rec["period_start"]:
                next_rec = r
        if prev_rec is not None:
            prev_end = prev_rec["period_end"] or prev_rec["period_start"]
            if final_start.isoformat() <= prev_end:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail={"detail": "开始日期与上一条记录重叠", "code": "DATE_OVERLAP"},
                )
        if next_rec is not None:
            occupied_until = final_end or final_start
            if occupied_until >= date.fromisoformat(next_rec["period_start"]):
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail={"detail": "记录区间与下一条记录重叠", "code": "DATE_OVERLAP"},
                )

        # period_days 随最终起止日计算（有结束日时）
        period_days = None
        if final_end is not None:
            period_days = (final_end - final_start).days + 1

        # v0.12.0 修 E7：修正开始日的场景（写 + 全量重算）并入同一事务——
        # 旧实现 UPDATE 与其后的逐条重推是 N 个独立事务，中途异常留下半重算状态。
        # 仅改 period_end / note（无重算）时同样在锁内单事务执行（v0.13.1 修 G2
        # 起两条路径统一；旧「单条 UPDATE 独立事务」语义等价）。
        await crud.update_cycle(
            user_id=user["id"],
            cycle_id=cycle_id,
            period_start=final_start.isoformat() if start_changed else None,
            period_end=final_end.isoformat() if final_end is not None else None,
            period_days=period_days,
            note=body.note,
            clear_period_end=body.clear_period_end,
            db=db,
        )
        if start_changed:
            await _recompute_all_records(
                user["id"],
                db=db,
                edited_old_start=existing["period_start"],
                edited_new_start=final_start.isoformat(),
            )

    updated = await crud.get_cycle_by_id(user["id"], cycle_id)
    return updated


async def _recompute_all_records(
    user_id: int,
    db=None,
    edited_old_start: str | None = None,
    edited_new_start: str | None = None,
) -> None:
    """按当前全部记录重推派生字段并重算模型（v0.9.0；v0.12.0 修 E7/E 死代码统一）。

    重推逻辑的单一来源是 crud.recompute_derived_fields（与导入路径共用，
    判定口径与 on_new_cycle_added 逐条一致，见其 docstring）；
    重算走与删除路径相同的管线（全量重算 model_params + 清理未验证预测 + 重新生成预测）。
    v0.14.0 修 AN-3：管线末尾追加 rebackfill_prediction_actuals（审计第二批 P2 起
    单一实现移驻 prediction_service，本模块只调用）——按重推后的真实记录日期重新
    计算所有预测的 actual_date / error_days（修正开始日后旧回填值必须同步，否则
    精度评估带脏数据）。调用点在 _recompute_after_delete_tx **之后**（先用新记录集
    重算/重生成，再统一重推 actual；删除路径不调用本函数）。
    db 语义：None 时自开事务；传入外层 WriteLock 连接时并入其事务（原子性）。

    迭代 8（3.0.8）修 P1：PUT 修正开始日传入 edited_old_start / edited_new_start，
    交给 rebackfill_prediction_actuals 做确定性锚点（只让 actual 等于旧开始日的
    已验证预测跟随到新开始日）；POST 补录/导入不传，保持既有语义。
    """
    if db is not None:
        await crud.recompute_derived_fields(user_id, db=db)
        await _recompute_after_delete_tx(db, user_id)
        # v0.14.0 修 AN-3：修正开始日 → 已回填预测的 actual_date/error_days 按新日期重推
        await rebackfill_prediction_actuals(
            user_id,
            db=db,
            edited_old_start=edited_old_start,
            edited_new_start=edited_new_start,
        )
        return
    async with WriteLock() as tx:
        await crud.recompute_derived_fields(user_id, db=tx)
        await _recompute_after_delete_tx(tx, user_id)
        await rebackfill_prediction_actuals(
            user_id,
            db=tx,
            edited_old_start=edited_old_start,
            edited_new_start=edited_new_start,
        )


@router.delete("/{cycle_id}")
async def delete_cycle(cycle_id: int, user: dict = Depends(require_user)) -> dict:
    """删除月经记录（触发全量重算 model_params）。"""
    existing = await crud.get_cycle_by_id(user["id"], cycle_id)
    if existing is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"detail": "记录不存在", "code": "NOT_FOUND"},
        )

    # v0.12.0 修 E7：删除 + 全量重算并入同一事务（旧实现两步独立提交，
    # 删除成功而重算失败会留下「记录没了、模型还带着旧周期」的中间态）
    # 迭代 4（3.0.4）修 P1：删除后先按剩余记录重推派生字段（cycle_length /
    # is_anomalous）再重算模型。旧实现只走 _recompute_after_delete（清缓存 + 重生成
    # 预测），后继记录的 cycle_length 仍是「相对被删记录」的旧值 ⇒ 统计/预测/导出
    # 全体带脏值。与 PUT 路径（start_changed → _recompute_all_records）同源同事务；
    # 不调用 _recompute_all_records，保持删除路径「不重推 actual」的 AN-3 口径。
    async with WriteLock() as db:
        await crud.delete_cycle(user["id"], cycle_id, db=db)
        await crud.recompute_derived_fields(user["id"], db=db)
        await _recompute_after_delete(user["id"], db=db)

    return {"message": "记录已删除", "id": cycle_id, "recomputed": True}
