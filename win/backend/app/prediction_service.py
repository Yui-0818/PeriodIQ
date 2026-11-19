"""预测域共享服务（v0.13.0 修 F15 新增）。文件登记见早期设计文档。

供 predictions/current、analysis/fertile-window 与 settings 的 export/preview 三个
GET 端点共用的「确保当前预测为最新」逻辑（原 predictions.py 私有实现外移，
消除各自重复的过期检测），是这些 GET 端点登记在案的 GET-时写库例外的唯一实现点。
（审计第二批修注释漂移：GET /export/preview（settings.py）此前已调
get_fresh_prediction 但未登记于此，本行补齐第三处触发点登记。）

职责：
1. 过期预测刷新（v0.8.0 F7；**v0.13.0 修 F12 契约变更**）：过期时**新增一条**
   预测行（新 created_at），永不 UPDATE 旧行的 predicted_date。旧行保留
   actual_date=None，待新记录到来照常回填验证——原始 miss 计入精度评估，
   MAE/命中率不再被过期刷新「洗白」人为改善；当前预测按既有排序自然取新行。
2. model_params 派生缓存自愈（v0.8.1 U2；**v0.13.0 修 F13**）：全字段漂移检测，
   任一字段（mean_cycle/std_cycle/ema_cycle/prior_mean/prior_std/
   prior_weight/n_records）漂移即全量刷新；容差常量在 config.py
   （MODEL_PARAMS_DRIFT_EPS / MODEL_PARAMS_DRIFT_EPS_PRIOR_WEIGHT）。
3. rebackfill_prediction_actuals（审计第二批 P2 自 cycles.py 外移的**单一实现**，
   禁止在任何路由文件保留副本）：按当前真实记录日期重推全部预测的
   actual_date/error_days。调用方：cycles 修正开始日/补录管线与 settings 导入事务
   （导入含陈年未验证预测时必须在导入事务内回填，否则下次 POST /cycles 的
   E8 全量回填会把 actual_date 盖成当天，污染精度评估）。本函数只被写路径调用，
   不属 GET-时写库例外。
   v3.0.7 修 P1：导入路径传 preserve_existing=True（actual_date 非空逐字段原样
   保留）；锚点改为「预测创建时已存在的最后一条真实记录」，支持提前来潮。

写库（刷新新增行、自愈刷新）均走 crud（routes 唯一 DB 出口，早期设计文档），
各自独立 WriteLock 事务，无嵌套持锁。
"""

import json
from datetime import date, datetime, timedelta, timezone

from app import config
from app.algo.stats import predict_core, predict_next_period, replay_ema
from app.db import crud
from app.db.database import WriteLock


def _prev_ema_from_history(cycle_lengths: list[float]) -> float:
    """从全量历史重推「不含最新一条」的 prev_ema（v0.8.1）。

    过期刷新/自愈路径只能拿到全量历史；model_params 表的 ema_cycle
    已含最新一条，直接传入 predict_core 会重复应用一次 EMA。
    replay_ema 种子 PRIOR_MEAN，与 POST 链的逐条增量严格一致。
    """
    return replay_ema(cycle_lengths, config, exclude_last=True)


def _resolve_actual_by_anchor(records: list[dict], pred_created: str) -> date | None:
    """按 3.0.7 锚点口径解析「该预测对应的实际来潮日」（迭代 8 修 P1 增加并列保护）。

    锚点 = ``cycles.created_at <= predictions.created_at`` 的记录中 period_start 最大者；
    actual = 第一条 period_start 严格大于锚点的记录。

    迭代 8（3.0.8）修 P1：created_at 只有秒级精度，两列同秒时无法确定记录与预测的
    先后顺序，锚点不唯一。此时返回 None（调用方保持原值、不猜），不再用
    「period_start 最大者」强行选锚点把未验证预测回填到错误日期。
    """
    candidates: list[dict] = []
    same_second = 0
    for r in records:
        created = str(r.get("created_at") or "")
        if not created or created > pred_created:
            continue
        candidates.append(r)
        if created == pred_created:
            same_second += 1
    if not candidates or same_second >= 2:
        return None
    anchor = max(date.fromisoformat(r["period_start"]) for r in candidates)
    successors = [
        date.fromisoformat(r["period_start"]) for r in records
        if date.fromisoformat(r["period_start"]) > anchor
    ]
    return min(successors) if successors else None


async def rebackfill_prediction_actuals(
    user_id: int,
    db=None,
    preserve_existing: bool = False,
    edited_old_start: str | None = None,
    edited_new_start: str | None = None,
) -> int:
    """按当前真实记录日期重推所有预测的 actual_date / error_days（v0.14.0 修 AN-3；
    审计第二批 P2 自 cycles.py 外移的**单一实现**，禁止在任何路由文件重写副本）。

    背景（审计 H4）：PUT 修正 period_start 后，已回填的 actual_date / error_days
    不会重推——被改掉的旧日期永远留在预测行里，/analysis/accuracy 的 MAE /
    hit_rate / interval_coverage / bias / trend 全部带脏数据（实测：记录 B
    04-01→04-05 后，「B 到来时」回填的 actual_date=04-01 / error_days=3 仍是旧值）。

    审计第二批 P2（导入不重推 actual）：导入含陈年未验证预测时若不在导入事务内
    回填，下次 POST /cycles 的 E8 全量回填（cycles.py 的 _run_post_cycle_chain）
    会把这些预测的 actual_date 一律盖成**新记录当天**——精度评估被污染。
    settings.import_data 在导入事务内、regenerate_current_prediction 之前调用本函数
    （与 cycles 补录/修正分支的调用时序一致：先重推 actual 再决定补生成）。

    迭代 7（3.0.7）修 P1：导入是「还原精度历史」语义，导入文件里 actual_date 已非空
    的预测必须**逐字段原样保留**（旧实现按导入后的记录集合无条件重推，把提前来潮
    的 actual 从 B 改到下一周期 C，error 1→27）。故新增 preserve_existing：
    - True（仅导入路径）：actual_date 非空 → 跳过该条，不写 actual_date/error_days；
      actual_date 为空 → 按下述锚点口径回填。
    - False（默认；PUT 修正开始日等全量重推路径）：保持既有全量重推语义。
    未新增「清空 actual_date」的语义。

    口径（v3.0.7 修 P1：提前来潮可用）：
    - **锚点** = 该预测创建时已存在的最后一条真实记录：候选为
      ``cycles.created_at <= predictions.created_at`` 的记录，取其中 period_start
      最大者。两列同为 SQLite CURRENT_TIMESTAMP 文本（``YYYY-MM-DD HH:MM:SS``），
      可直接按字符串比较（导入路径同样还原该时间戳）。
    - **实际来潮日** = 第一条 period_start **严格大于锚点**的记录。
      旧口径「第一条 start >= predicted_date」在提前来潮（actual < predicted）时
      会跳过 B 落到 C，把误差从 1 天改成 27 天；锚点口径不再依赖预测日。
    - error_days = |actual_date - predicted_date|（与 POST 回填同式）。
    - 锚点不可判定（无 created_at 早于预测的候选）或无后继记录 → **保持原值**，
      不猜、不写。
    - PUT 提前来潮：A 为锚点、B 提前来潮后把 B 的 start 改为 B'（仍 > A 且
      < predicted），actual 跟随 B'，不会跳到 C。

    迭代 8（3.0.8）修 P1（确定性锚点）：PUT 修正开始日时由调用方传入
    ``edited_old_start`` / ``edited_new_start``，已验证预测**不再**用秒级
    created_at 选锚点——只有 ``actual_date == edited_old_start`` 的预测跟随到
    ``edited_new_start`` 并重算 error_days，其余已验证预测保持原值。未验证预测
    仍走上述 3.0.7 锚点口径，但 created_at 同秒并列（候选记录与预测创建时间
    同秒 ≥2 条）时无法唯一确定锚点 → 保持原值、不猜。无这两个参数时
    POST/导入路径语义不变。

    幂等：输出只取决于（当前记录集合, 预测行 predicted_date/created_at）；第二次
    调用各字段相等即跳过写，返回 0。

    Called from:
    - cycles._recompute_all_records（PUT 修正开始日 / POST 补录历史分支），
      在 _recompute_after_delete_tx 之后调用一次（全量重推，preserve_existing=False）；
    - settings.import_data（导入事务内，regenerate_current_prediction 之前，
      preserve_existing=True）。删除路径不调用本函数。

    Args:
        user_id: 用户 id。
        db: WriteLock 事务连接（写入同一事务）；None 时各 crud 读走独立连接。
        preserve_existing: True 时 actual_date 非空的预测原样保留（导入还原语义）。
        edited_old_start: PUT 修正周期开始日时的**旧**开始日（ISO）；提供时已知验证
            预测不再用 created_at 选锚点（迭代 8 修 P1）。
        edited_new_start: PUT 修正周期开始日时的**新**开始日（ISO）。

    Returns:
        实际改写的预测行数（审计用；幂等重复调用返回 0）。
    """
    records = await crud.get_all_cycles_asc(user_id, db=db)
    if not records:
        return 0
    predictions = await crud.get_all_predictions(user_id, db=db)
    edit_old = date.fromisoformat(edited_old_start) if edited_old_start else None
    edit_new = date.fromisoformat(edited_new_start) if edited_new_start else None
    edit_mode = edit_old is not None and edit_new is not None
    updated = 0
    for pred in predictions:
        if preserve_existing and pred.get("actual_date"):
            continue
        predicted = date.fromisoformat(pred["predicted_date"])
        existing_actual = pred.get("actual_date")
        if edit_mode and existing_actual:
            # 迭代 8 修 P1：已验证预测禁止再用秒级 created_at 选锚点。只有
            # actual_date 等于被修正周期**旧**开始日的预测跟随到新开始日并重算
            # error_days；其余已验证预测逐字段保持原值。
            if existing_actual != edit_old.isoformat():
                continue
            actual = edit_new
        else:
            # 未验证预测（或非 PUT 修正的全量重推路径）：沿用 3.0.7 锚点口径；
            # created_at 并列无法唯一确定锚点时保持原值不猜。
            actual = _resolve_actual_by_anchor(records, str(pred.get("created_at") or ""))
            if actual is None:
                continue
        error_days = abs((actual - predicted).days)
        if (
            pred.get("actual_date") == actual.isoformat()
            and pred.get("error_days") == error_days
        ):
            continue  # 幂等：值未变则不产生写
        await crud.backfill_prediction_actual(
            pred["id"], actual.isoformat(), error_days, db=db
        )
        updated += 1
    return updated


async def heal_model_params_cache(user_id: int) -> None:
    """model_params 单行表的自愈（v0.8.1 U2；v0.13.0 修 F13 全字段漂移检测）。

    该表是 predict_core 的派生缓存，旧设计只在新增加记录时重写，
    口径变更后存量行可能长期落后（实测 mean_cycle=29.633 vs 预测 31.675）。
    旧实现仅比对 mean_cycle 单字段，std/ema/prior_weight 等漂移不触发；
    F13 扩展为全字段独立容差（mean/std/ema/prior_mean/prior_std 0.01、
    prior_weight 0.001、n_records 精确），任一漂移即对整行做同口径刷新。
    幂等：刷新后各字段差值为 0；无合法周期时不动表。
    """
    mp = await crud.get_model_params(user_id)
    cycles = await crud.get_all_valid_cycle_lengths(user_id)
    if not cycles:
        return
    core = predict_core(cycles, _prev_ema_from_history(cycles), config)
    eps = config.MODEL_PARAMS_DRIFT_EPS
    eps_pw = config.MODEL_PARAMS_DRIFT_EPS_PRIOR_WEIGHT
    drifted = (
        abs(float(mp["mean_cycle"]) - core["predicted_cycle"]) > eps
        or abs(float(mp["std_cycle"]) - core["std"]) > eps
        or abs(float(mp["ema_cycle"]) - core["new_ema"]) > eps
        or abs(float(mp["prior_mean"]) - core["mu_post"]) > eps
        or abs(float(mp["prior_std"]) - core["sigma_post"]) > eps
        or abs(float(mp["prior_weight"]) - core["prior_weight"]) > eps_pw
        or int(mp["n_records"]) != int(core["n"])
    )
    if drifted:
        await crud.update_model_params(
            user_id,
            mean_cycle=core["predicted_cycle"],
            std_cycle=core["std"],
            n_records=core["n"],
            ema_cycle=core["new_ema"],
            prior_mean=core["mu_post"],
            prior_std=core["sigma_post"],
            prior_weight=core["prior_weight"],
        )


async def get_fresh_prediction(user_id: int) -> dict:
    """确保并返回「当前预测」（过期自动刷新落库，F12 契约：新增行不改旧行）。

    Returns dict:
        latest_cycle: crud.get_latest_cycle 结果（无记录 → None）
        latest_pred:  最新预测且保证非过期（无预测 → None；过期时指向新增行）
        is_corrected / corrected_from: 本次是否发生过期刷新，及其旧预测日
        model_params: 最新预测 model_params_json 解析结果（刷新后为含
                      stale_correction 的审计快照）

    无记录时仅 latest_cycle=None（其余缺省），调用方自行兜底。
    """
    latest_cycle = await crud.get_latest_cycle(user_id)
    if latest_cycle is None:
        return {
            "latest_cycle": None,
            "latest_pred": None,
            "is_corrected": False,
            "corrected_from": None,
            "model_params": {},
        }

    latest_pred = await crud.get_latest_prediction(user_id)
    is_corrected = False
    corrected_from = None
    model_params: dict = {}

    if latest_pred is not None:
        if latest_pred.get("model_params_json"):
            try:
                model_params = json.loads(latest_pred["model_params_json"])
            except (json.JSONDecodeError, TypeError):
                model_params = {}

        predicted_date = date.fromisoformat(latest_pred["predicted_date"])
        today = date.today()
        grace = timedelta(days=config.PREDICTION_STALE_GRACE_DAYS)
        is_stale = predicted_date + grace < today and not latest_pred.get("actual_date")
        if is_stale:
            # v0.13.1 修 G1：锁外判定只作快路径（99% 非过期请求零加锁）。
            # 过期分支进入 WriteLock 后**重读最新预测再判定**——本函数被
            # /predictions/current、/analysis/fertile-window 与 /export/preview
            # 三个端点共用，前端日历页以 Promise.all 并发调用前两者；
            # 旧实现「锁外判定 +
            # 锁内直接 INSERT」在并发下会各插一行相同新预测（E8 回填重复计
            # 误差、debug 演化图重复快照）。锁内重查后，只有第一个请求看到
            # 旧值并插入，后来的请求看到新行自然跳过（与 F7 的 POST TOCTOU
            # 修法同思路）。
            async with WriteLock() as db:
                re_pred = await crud.get_latest_prediction(user_id, db=db)
                re_stale = (
                    re_pred is not None
                    and not re_pred.get("actual_date")
                    and date.fromisoformat(re_pred["predicted_date"]) + grace < today
                )
                if re_stale:
                    cycles = await crud.get_all_valid_cycle_lengths(user_id, db=db)
                    re_cycle = await crud.get_latest_cycle(user_id, db=db)
                    if re_cycle is not None:
                        # v0.8.1：prev_ema 用全量历史重推（表中 ema_cycle 已含最新一条）
                        fresh = predict_next_period(
                            date.fromisoformat(re_cycle["period_start"]),
                            cycles,
                            _prev_ema_from_history(cycles),
                            config,
                        )
                        re_pred_date = date.fromisoformat(re_pred["predicted_date"])
                        fresh_date = (
                            date.fromisoformat(fresh["predicted_date"])
                            if fresh["predicted_date"] is not None
                            else None
                        )
                        if fresh_date is not None and fresh_date != re_pred_date:
                            audit = dict(fresh["model_params"])
                            audit["stale_correction"] = {
                                "from_predicted_date": re_pred["predicted_date"],
                                "corrected_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                                "anchor_period_start": re_cycle["period_start"],
                                "n_valid_cycles": len(cycles),
                            }
                            # v0.13.0 修 F12（契约变更）：新增一行，永不 UPDATE 旧行 predicted_date。
                            await crud.create_prediction(
                                user_id,
                                predicted_date=fresh["predicted_date"],
                                predicted_start_upper=fresh["predicted_start_upper"],
                                predicted_start_lower=fresh["predicted_start_lower"],
                                confidence=fresh["confidence"],
                                model_version=fresh["model_version"],
                                model_params_json=json.dumps(audit, ensure_ascii=False),
                                db=db,
                            )
                            corrected_from = re_pred_date
                            is_corrected = True
                            latest_pred = {
                                **re_pred,
                                "predicted_date": fresh["predicted_date"],
                                "predicted_start_lower": fresh["predicted_start_lower"],
                                "predicted_start_upper": fresh["predicted_start_upper"],
                                "confidence": fresh["confidence"],
                                "model_version": fresh["model_version"],
                            }
                            model_params = audit

    # v0.13.0 修 F13：model_params 派生缓存自愈（无合法周期时不动表）
    await heal_model_params_cache(user_id)

    return {
        "latest_cycle": latest_cycle,
        "latest_pred": latest_pred,
        "is_corrected": is_corrected,
        "corrected_from": corrected_from,
        "model_params": model_params,
    }