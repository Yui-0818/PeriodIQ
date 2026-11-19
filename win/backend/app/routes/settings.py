"""settings 路由（早期设计文档）。

端点：
- GET /settings: 获取设置（R1 空壳化：响应体恒为 {}）
- PUT /settings: 更新设置（R1 空壳化：请求体可为空，响应体恒为 {}）
- GET /export: 导出全部数据 JSON（app_settings 键保留，值恒为 {}）
- POST /import: 导入数据（app_settings 内部键一律静默忽略）
- GET /export/preview: 导出预览（数据预览端点，非文件格式通道）

R1 产品决策（用户 2026-09-18）：
- 「主题」彻底删除、永不实现
- 「通知」砍掉实现、暂缓以后重做；UI 保留纯占位
- app_settings 表保留空壳（不删表、不删端点）
- notify_enabled / notify_days / theme 从 API 面彻底消失
- 2026-10-26 用户新增每晚填写提醒（services/reminder.py），通知体系其余仍暂缓

=====================================================================
导入导出规范（两端口径，用户 2026-10-26 立项统一；Android PiqRouter.kt 有同义注释，契约数字两端一致）
=====================================================================

1. 格式白名单：导入导出文件只有 `.json` 备份与 `.csv` 周期表；其他格式
   （txt/xlsx/db/zip 等）不支持、无解析端点；新增格式须用户立项。

2. JSON 导出（GET /export）：字段 cycles / predictions / model_params /
   app_settings / exported_at / cycles_total/truncated /
   predictions_total/truncated / daily_records_total/truncated；app_settings 恒 {}，
   exported_at 为当天（YYYY-MM-DD）。截断方向统一为「取最新」（2026-10-31 修 #33/#35：
   旧实现取**最早** N 条，被丢掉的反而是最近的数据，与「备份」语义相反）：
   - cycles 按 period_start ASC, id ASC（修 #25 导出排序契约；GET /cycles 仍为倒序），
     取该升序列表**末尾** MAX_EXPORT_CYCLES（1000）条，列表本身仍升序输出；
   - predictions 按规范序（predicted_date→created_at→id ASC）取**末尾**
     MAX_EXPORT_PREDICTIONS（1000）条；
   - daily_records 按 record_date 升序取**末尾** MAX_EXPORT_DAILY_RECORDS（2000）条，
     行内**不含 mood_note / mood_tags**（仅本地；#15 起 mood_tags 同样剥除，导入重建后标签为空）；
     每日日记（daily_journal，#14）不导出也不被导入触碰；
   - 三类均用 <类>_total（库内实际总数）/ <类>_truncated（total > 上限）明示截断。
   **不变量**：MAX_EXPORT_CYCLES <= MAX_IMPORT_CYCLES、MAX_EXPORT_PREDICTIONS <=
   MAX_IMPORT_PREDICTIONS、MAX_EXPORT_DAILY_RECORDS <= MAX_IMPORT_DAILY_RECORDS——
   否则导出文件自己会被 ImportRequest 的条数校验 422 拒绝（无法回灌）；调整任一侧须同查。
   **/export/preview 是数据预览通道、不是备份通道，不截断**（恒返回完整 cycles 列表）：
   cycles > MAX_IMPORT_CYCLES（1000）条时预览仍完整，但据此发起的 CSV/JSON 导入
   会被 MAX_IMPORT_CYCLES 422 拒绝——前端重建轮须提示用户或先截断。

3. JSON 导入（POST /import，单事务重建；cycles/predictions 必清空重建，daily_records 按下方键存在性规则）：请求体 {cycles,
   predictions?, model_params?, app_settings?, allow_anomalies?, daily_records?}，cycles 非空
   否则 400 EMPTY_IMPORT；前端须在导入前弹**完全覆盖警告**并经用户确认（用户
   2026-10-26 裁定）。2026-10-31 修 #23：警告文案须按下面每日详情规则写清覆盖范围：
   - 请求**未携带** daily_records 键 → 保留库内既有每日详情（不清空，
     imported_daily_records=0）；
   - 显式 daily_records: [] → 清空该用户全部每日详情（完全覆盖语义仍有效）；
   - 非空数组 → 先清空再按行重建（重复日期后行胜出）；
   - 显式 JSON null 仍由 Pydantic 422（字段类型是 list[dict]，不是 Optional）；
   - 导出文件恒含 daily_records 键；API 直接原样回灌仍是完全覆盖（Win UI 路径需前端透传该键后才成立）。
   cycles 导入顺序不敏感（门禁与派生重算均按日历序；同一开始日的记录按导入先后/
   落库 id 定序），请求无需预排序。
   上限 cycles ≤ 1000 / predictions ≤ 2000 / daily_records ≤ 4000（MAX_IMPORT_*），
   超出 422；不变量：导出 ≤ 导入（1000≤1000、1000≤2000、2000≤4000，调整任一侧须同查）；
   G1-G5 门禁单一来源 services/gate.py::evaluate_gate，命中且 allow_anomalies ≠ true →
   400 DATA_ANOMALY + anomalies。**修 #32：门禁基线只用待导入数据自身**（
   gate.import_baseline_lengths，与 evaluate_gate 内部同一取值口径），不再读库内旧
   cycles——导入是清空重建的全量替换，旧账号/旧周期的历史中位数会把合法异地备份
   （如 28 天 → 45 天）误判为 G3。G3 文案基线为「本次导入数据的中位数」（两端逐字一致）。
   cycles.created_at 还原（修 #35）：字符串且 ≤32 字符、不含控制字符 → 原样落库；
   非字符串/空串 → 导入时刻（UTC "YYYY-MM-DD HH:MM:SS"，与 SQLite CURRENT_TIMESTAMP
   同格式，时间序可比）；超长或含控制字符 → 400 INVALID_IMPORT（复用 _validate_created_at）。
   daily_records 还原历史：不受补填窗口/来潮日限制，
   但结构校验照走（同 schema 口径、日期不得晚于今天），行内 note 静默忽略；
   record_date 非法走 INVALID_IMPORT（复用既有日期解析，两端口径一致），其余结构
   违规 → 400 INVALID_DAILY；其余字段非法 → 400 INVALID_IMPORT（错误体为扁平 code）。
   数值校验口径（2026-10-31 修 #24，入口统一类型 + 范围校验，非法一律 400）：
   - predictions[].confidence 须为有限数值（排除 bool/NaN/Infinity/超 float 范围整数）
     且落在 [0,1]；
   - model_params_json 须为对象/JSON 文本/null（空串按旧兜底）。已知数值键
     mean_cycle/std_cycle/ema_cycle/prior_mean/prior_std 须有限数值；prior_weight 须为
     [0,1] 内有限数值；n_records 须非负整数；未知附加键不得含 NaN/Infinity 等无法
     序列化数值（dict 与 JSON 文本两条路径都做 allow_nan=False 序列化校验，文本里
     的 1e400 解析为 inf 同样拒绝）。n_records/prior_weight **显式 null 放行**
     （与 Android ImportModelParams 同构），由消费侧（debug.py::model_history）按缺失
     默认处理（0 / 1.0）；
   - cycles[].cycle_length 须为有限数值；有限但越 [7,90] 仍置 NULL（既有 sanitize
     语义；通过校验的入参值随后仍由导入事务 recompute_derived_fields 按日期重推，
     不在库中保留）；
   - cycles[].period_days / predictions[].error_days 须为 64 位整数（超出
     [-2^63, 2^63-1] → 400），非整数类型沿用「视为无值」（与 Android strictInt 同口径）；
   - 门禁取值对 NaN/Infinity/超 float 范围整数按「无值」处理（不再抛 OverflowError）；
     导入入口按字段口径处理：cycle_length/已知模型数值键非法 → 400，period_days 非 int → 无值。
   app_settings 只要求 dict、内部键静默忽略。
   `POST /import` 请求体在解析前有 8 MiB 体积闸门（`config.MAX_IMPORT_BYTES`，main.py
   中间件），超限 400 `IMPORT_TOO_LARGE`（两端同码）。

4. CSV（仅周期记录；CSV 解析属于重建轮的前端，后端无 CSV 端点，统一走
   POST /import；旧前端 transfer.js / data.js 已删除，以下为两端统一契约）：
   每行「开始日期,结束日期」，结束日期可空；日期形态：YYYY-M-D / YYYY/M/D
   及混合分隔（年 4 位、月/日 1-2 位，真实日历日期）；行处理：去 BOM、\r?\n、
   跳过空行；每格剥首尾空白与包裹**整格**的成对引号（非整格包裹的引号不处理）；
   第 3 列及以后忽略；首个非空行解析失败视为表头、其余行报错；行顺序任意
   （导入按日历序重算，不要求预排序；同一开始日按导入先后定序）；结束日早于
   开始日不由前端拦截，交后端处理：默认先被 G1-G5 门禁拦截（至少 G5：派生
   period_days ≤ 0）返回 400 DATA_ANOMALY；确认后（allow_anomalies=true）结构
   校验返回 400 INVALID_IMPORT；导出侧 CSV 行按开始日期升序（与 /export、
   /export/preview 的 cycles 顺序一致）；CSV 不含 model_params / predictions
   （精度历史走 JSON 备份）。

5. 通道收敛：导入通道只剩 JSON 备份 / CSV / 手动录入；原第三种文件导入
   通道已于 2026-10-26 删除。
"""

import json
import math
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status

from app import config
from app.algo import stats
from app.algo.stats import replay_ema
from app.db import crud
from app.security import require_user
from app.db.crud import _sanitize_cycle_length
from app.db.database import WriteLock
from app.prediction_service import get_fresh_prediction, rebackfill_prediction_actuals
from app.schemas.api import (
    ExportPreviewResponse,
    ExportResponse,
    ImportRequest,
    ImportResponse,
    SettingsResponse,
    SettingsUpdate,
)
from app.services.gate import evaluate_gate, import_baseline_lengths

router = APIRouter(tags=["settings"])

# v0.14.0 修 CN-2（审计 M8）：导入 model_version 白名单——只允许模型自身产出的
# 版本号（config.MODEL_VERSION_*）+ 旧导出文件缺键时的兜底值 "unknown"
# （与 import_data 内 p.get("model_version", "unknown") 的默认取值保持一致）。
# 白名单之外的任意串（含 XSS payload）一律 400 INVALID_IMPORT：该字段会被前端
# _getModelVersionLabel() 回退分支不加转义地插入 DOM，入口必须堵死。
_ALLOWED_MODEL_VERSIONS = frozenset({
    config.MODEL_VERSION_NONE,
    config.MODEL_VERSION_COLD_1,
    config.MODEL_VERSION_COLD_2,
    config.MODEL_VERSION_BAYESIAN,
    "unknown",
})

# v0.14.0 修 CN-2：created_at 宽松长度上限（SQLite CURRENT_TIMESTAMP 导出形
# "YYYY-MM-DD HH:MM:SS" 为 19 字符，ISO 带时区亦 < 32）。仅限长度与控制字符，
# 不做 datetime 解析——旧导出文件的非标准但可排序的时间戳仍须兼容导入。
_MAX_CREATED_AT_LEN = 32


@router.get("/settings", response_model=SettingsResponse)
async def get_settings(user: dict = Depends(require_user)) -> dict:
    """获取应用设置（R1 空壳化）。

    契约冻结：200，响应体恰为 {}（不得含 user_id / updated_at / 任何旧字段）。
    仍走 require_user：未登录访问业务端点一律 401（鉴权面不变）。
    前端设置页不走本端点；Win 走 /device/settings，Android 走原生桥。
    """
    # R1：表保留空壳，但不再读取/暴露任何 settings 字段
    return {}


@router.put("/settings", response_model=SettingsResponse)
async def update_settings(body: SettingsUpdate, user: dict = Depends(require_user)) -> dict:
    """更新应用设置（R1 空壳化）。

    契约冻结：
    - 请求体允许空对象 {}，不得因缺字段报 422（SettingsUpdate 无字段 + extra 忽略）
    - 仅触达 crud.update_settings(user_id)——冻结签名：只 UPSERT updated_at
    - 响应体恰为 {}
    body 参数保留：FastAPI 需要它来解析/忽略遗留客户端可能发送的旧键。
    """
    _ = body  # 遗留键由 SettingsUpdate 静默忽略，路由层不再读取任何设置字段
    await crud.update_settings(user["id"])
    return {}


@router.get("/export", response_model=ExportResponse)
async def export_data(user: dict = Depends(require_user)) -> dict:
    """导出全部数据 JSON。

    截断口径（v0.14.0 修 CN-3 收敛上限来源；2026-10-31 修 #33/#35 统一「取最新」）：
    cycles / predictions / daily_records 三类各自在**升序全量列表**上取末尾
    MAX_EXPORT_CYCLES / MAX_EXPORT_PREDICTIONS / MAX_EXPORT_DAILY_RECORDS 条
    （列表本身仍按各自升序输出；旧实现取最早 N 条，丢的恰恰是最新数据）；
    *_total 为库内实际总条数，*_truncated = total > 上限。

    predictions 取数走 get_predictions_chronological（规范序 predicted_date →
    created_at → id ASC）的全量结果再切片，total 直接用同一列表长度——不再
    额外调用 get_all_predictions（两函数的 ORDER BY 首键不同，混用会让
    「切哪 N 条」与「总量」来自不同口径）。**不改** get_prediction_history
    （它是用户可见的「预测历史倒序」，见早期记录）。

    **不变量登记**：导出上限必须 <= 对应导入上限（MAX_EXPORT_CYCLES <=
    MAX_IMPORT_CYCLES、MAX_EXPORT_PREDICTIONS <= MAX_IMPORT_PREDICTIONS、
    MAX_EXPORT_DAILY_RECORDS <= MAX_IMPORT_DAILY_RECORDS），否则「导出 → 导入」
    往返会被 ImportRequest 的条数校验 422 拒绝（导出的文件自己导不回来）。
    当前 1000 <= 1000、1000 <= 2000、2000 <= 4000 成立；调整任一侧时必须同时复核。

    cycles 按 period_start ASC, id ASC（修 #25：导出 cycles 统一升序，
    与 /export/preview 一致；GET /cycles 仍为倒序）。
    """
    # 修 #25：导出 cycles 统一升序，CSV 导出亦按此顺序
    # 修 #33/#35：先取升序全量再切末尾 N 条（「取最新」），列表本身保持升序输出
    all_cycles = await crud.get_all_cycles_asc(user["id"])
    cycles_total = len(all_cycles)
    cycles_truncated = cycles_total > config.MAX_EXPORT_CYCLES
    cycles = all_cycles[-config.MAX_EXPORT_CYCLES:]

    all_preds = await crud.get_predictions_chronological(user["id"])
    predictions_total = len(all_preds)
    predictions_truncated = predictions_total > config.MAX_EXPORT_PREDICTIONS
    predictions = all_preds[-config.MAX_EXPORT_PREDICTIONS:]

    model_params = await crud.get_model_params(user["id"])

    # R1 设置域空壳化：导出保留 app_settings 键，值恒为 {}
    #（不再调用 crud.get_settings——表虽在，API 面已不暴露任何字段）

    # 2026-10-26 daily_records：与 predictions 同款截断口径；行内剥除 mood_note（废弃列）
    # 与 mood_tags（#15，仅本地存储、绝不导出）
    all_daily = await crud.get_all_daily_records(user["id"])
    daily_records_total = len(all_daily)
    daily_records_truncated = daily_records_total > config.MAX_EXPORT_DAILY_RECORDS
    daily_records_export = [
        {k: v for k, v in r.items() if k not in ("mood_note", "mood_tags")}
        for r in all_daily[-config.MAX_EXPORT_DAILY_RECORDS:]
    ]

    return {
        "cycles": cycles,
        "predictions": predictions,
        "model_params": model_params,
        "app_settings": {},
        "exported_at": date.today().isoformat(),
        "cycles_total": cycles_total,
        "cycles_truncated": cycles_truncated,
        "predictions_total": predictions_total,
        "predictions_truncated": predictions_truncated,
        "daily_records": daily_records_export,
        "daily_records_total": daily_records_total,
        "daily_records_truncated": daily_records_truncated,
    }


@router.post("/import", response_model=ImportResponse)
async def import_data(body: ImportRequest, user: dict = Depends(require_user)) -> dict:
    """导入数据（cycles/predictions 清空重建；daily_records 按请求键存在性覆盖）。

    导入流程（v0.9.0 修 P3；v0.12.0 修 E7/E4）：
    1. 校验 cycles/predictions 字段（非法 → 400 INVALID_IMPORT，不再 500）
    2. 清空 cycles/predictions 表
    3. 插入导入的 cycles（**按导入文件顺序**逐条插入；cycle_length 等派生字段
       不在插入时计算，首条与否的 NULL 语义统一由步骤 5 的
       recompute_derived_fields 按升序全量重推兜底——审计第二批修注释漂移：
       旧文案「按 period_start 升序插入」与实现不符，实际从不排序）
       created_at 按修 #35 还原（_validate_created_at：字符串原样、非字符串/空串 →
       导入时刻、超长/含控制字符 → 400 INVALID_IMPORT）
    4. 插入导入的 predictions（**还原精度历史**：actual_date/error_days 保留；
       M2观察3「import 补导 predictions」的 M5 遗留待办至此闭环）
    5. 重推每条 cycle 的派生字段（cycle_length/period_days/is_anomalous，
       crud.recompute_derived_fields 单一来源——CSV 导入（v0.12.0 前端转换，
       只有起止两列）没有这些字段，JSON 导入的旧值也统一按当前口径重推）
    6. 触发全量重算 model_params；随后回填**未验证**预测（actual_date 为空）的
       actual_date / error_days（审计第二批 P2：单一实现
       prediction_service.rebackfill_prediction_actuals；v3.0.7 修 P1：
       preserve_existing=True，导入文件里的 actual_date 已非空预测逐字段原样
       保留，不再按导入后记录集重推覆盖精度历史）
    7. 若库中不存在任何未验证预测，则补生成当前预测
       （否则 GET /predictions/current 永久落入「暂无预测」分支）
    8. 导入 daily_records（2026-10-26 新增；2026-10-31 修 #23 改为按请求键存在性
       决策）：仅当请求体**显式携带** daily_records 键时，在同一事务内清空该用户
       每日详情并按行重建（非空数组 = 清空重建，显式 [] = 仅清空）；**缺键时保留
       库内既有每日详情**（Win 前端 JSON 导入体不带该键，旧实现无条件删除 + 空列表
       循环会删光用户每日详情）。导出文件恒含该键；API 直接回灌仍是完全覆盖，
       Win UI 路径需前端透传该键后才成立。
    9. （R1）不再写回 app_settings——表空壳保留，导入侧静默忽略内部键
    v0.12.0 修 E7：步骤 2-8 全部在同一 WriteLock 事务内，任一步骤失败整体回滚。
    v0.14.0 修 CN-1：cycles[].period_start / period_end 与 POST/PUT 同受
    「不得晚于今天 + config.MAX_FUTURE_CYCLE_DAYS」上限约束（导入文件可能是
    手改/外部构造的，API 侧拦住的未来日期不能从导入路径绕回）。
    v0.14.0 修 CN-2（审计 M8）：predictions[].confidence 排除 bool、
    model_version 走白名单、created_at 限长、is_anomalous 只接受 bool 或 0/1
    ——**宁严不宽**：导入是清空重建型单事务操作，可疑输入一律 400 INVALID_IMPORT，
    不做「静默忽略非法值」的容错（否则脏值会随重建写库并流向前端 DOM/模型）。
    2026-10-31 修 #24：上段「宁严不宽」补齐数值边界——confidence 与
    cycles[].cycle_length 须为有限数值（bool/NaN/Infinity/10**400 一律 400，不再冒
    OverflowError/TypeError → 500）；period_days / error_days 须落在 SQLite 64 位
    整数范围内（非 int 类型沿用「视为无值」）；model_params_json 的已知数值键须
    有限、prior_weight ∈ [0,1]、n_records 非负整数，未知附加键中的 NaN/Infinity
    （含 JSON 文本 1e400 解析出的 inf）→ 400；n_records/prior_weight 显式 null
    仍放行（与 Android 同构，消费侧 debug.py 按缺失处理）。
    **R1 语义反转（settings 域例外，cycles/predictions 校验不变）**：
    app_settings 从「严格校验、非法值 400」反转为「一律忽略、永不报错」。
    理由：用户手上已有的导出文件里带着 notify_enabled/notify_days/theme 三个旧键，
    若继续校验就会把自己的旧备份永久锁死（导入必 400）。
    故：app_settings 只要求是 dict（None 允许，由 Optional[dict] 保证）；
    内部出现 notify_enabled / notify_days / theme 及任何其他键一律静默忽略。
    EMPTY_IMPORT 闸门不再把「仅有 app_settings」当作有效导入（字段已删除，
    仅有 settings 键的文件不构成可导入的业务数据）。
    **审计第二批 P1（空导入清库，与 Android 端同口径同文案）**：cycles 必须非空
    ——旧闸门 `not body.cycles and not body.model_params` 允许
    {"model_params": {...}} / {"predictions": [...]} 过闸，随后步骤 2 无条件清空
    该用户全部记录且不写任何数据（一发空导入即清库）。修复后无 cycles 一律
    400 EMPTY_IMPORT（"导入数据缺少经期记录（cycles 不能为空）"）。
    """
    # R1：闸门去掉 `not body.app_settings`——仅 settings 键不足以构成导入
    # 审计第二批 P1：改为必须 cycles 非空（见上方 docstring；model_params /
    # predictions-only 与全空载荷一律拒绝，防止过闸后清空全部记录却不写数据）
    if not body.cycles:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"detail": "导入数据缺少经期记录（cycles 不能为空）", "code": "EMPTY_IMPORT"},
        )

    # ---- R2-A 异常门禁（G1-G5）：唯一写路径前置闸门（JSON 备份/CSV/手动录入共用）----
    # 判据见 services/gate.py；门禁只判定与报告，不修改数据。
    # allow_anomalies=false（默认）命中 → 400 DATA_ANOMALY + anomalies 列表；
    # =true 时放行，继续走既有导入管线（宁严不宽的结构性校验不变）。
    # 修 #32：G3/G4 基线**只用待导入数据自身**派生（gate.import_baseline_lengths 与
    # evaluate_gate 内部同一取值口径），不再读库内旧 cycles。理由：导入是清空重建的
    # 全量替换，旧账号/旧周期的历史中位数会把合法异地备份（如 28 天 → 45 天）整批
    # 误判为 G3，用户只能靠 allow_anomalies 硬闯。判据未放宽，只换基线来源。
    gate_anomalies = evaluate_gate(
        body.cycles or [],
        import_baseline_lengths(body.cycles or []),
        date.today(),
    )
    if gate_anomalies and not body.allow_anomalies:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "detail": "数据异常，需确认",
                "code": config.DATA_ANOMALY_CODE,
                "anomalies": gate_anomalies,
            },
        )

    # ---- 校验（v0.9.0：导入文件可能是用户手改的，非法输入必须 400 而非 500）----
    validated_cycles: list[dict] = []
    for c in body.cycles:
        start = _parse_iso_date(c.get("period_start"), "cycles[].period_start")
        end = _parse_iso_date(c.get("period_end"), "cycles[].period_end", required=False)
        # v0.14.0 修 CN-1（审计 H6）：与 schemas.CycleCreate 同一规则、同一 config 常量
        # （上限 = 今天 + MAX_FUTURE_CYCLE_DAYS，当前 0 = 不晚于今天）。end 同受上限约束，
        # 否则可导入「开始日在过去、结束日在 2099」的记录。
        _reject_import_future_date(start, "开始日期", start)
        if end is not None:
            _reject_import_future_date(end, "结束日期", start)
        if end is not None and end < start:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={"detail": f"记录 {start} 的结束日期早于开始日期", "code": "INVALID_IMPORT"},
            )
        note = str(c.get("note", "") or "")
        # v0.13.1 修 G3：导入 note 与 POST/PUT 同限 2000 字符（F5 的漏网路径；
        # 旧版导出受 F5 约束不会超限，此处拒绝的是手改/外部构造的文件）
        if len(note) > 2000:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={"detail": f"记录 {start} 的备注超长（>2000 字符）", "code": "INVALID_IMPORT"},
            )
        validated_cycles.append({
            "period_start": start.isoformat(),
            "period_end": end.isoformat() if end else None,
            # 2026-10-31 修 #24：先判有限数值再交 sanitize（字符串/NaN/10**400 → 400）
            "cycle_length": _parse_import_cycle_length(c.get("cycle_length"), start),
            # v0.13.0 修 F26：isinstance(x, int) 须排除 bool（bool 是 int 子类，True 会被当合法数值）
            # 2026-10-31 修 #24：非 int 视为无值，超 64 位整数 → 400（原实现直接透传，
            # 10**100 在 SQLite 绑定参数时 OverflowError → 500）
            "period_days": _parse_import_optional_int(
                c.get("period_days"), "period_days", f"记录 {start.isoformat()}"
            ),
            "note": note,
            # v0.14.0 修 CN-2（审计 M8）：原写法 `1 if c.get("is_anomalous") else 0` 把字符串
            # "false" 判为真（非空串恒真）→ 脏值入库。改为只接受 bool 或 0/1 整数；
            # 键缺失 / 显式 null 视为 0（兼容只含起止两列的 CSV 转换文件），其余一律 400。
            "is_anomalous": _parse_is_anomalous(c.get("is_anomalous"), start),
            # 2026-10-31 修 #35：还原 cycles.created_at（与 predictions/daily_records 同款
            # 校验复用 _validate_created_at）——非字符串/空串/缺键 → 导入时刻；超 32 字符
            # 或含控制字符 → 400 INVALID_IMPORT。旧实现丢弃该字段，导入后所有记录都变成
            # 「导入那一刻创建」，备份的时间戳信息永久丢失。
            "created_at": _validate_created_at(c.get("created_at"), start, label="记录"),
        })

    validated_predictions: list[dict] = []
    for p in body.predictions:
        predicted = _parse_iso_date(p.get("predicted_date"), "predictions[].predicted_date")
        upper = _parse_iso_date(p.get("predicted_start_upper"), "predictions[].predicted_start_upper")
        lower = _parse_iso_date(p.get("predicted_start_lower"), "predictions[].predicted_start_lower")
        if not (lower <= predicted <= upper):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={"detail": f"预测 {predicted} 的区间端点倒挂", "code": "INVALID_IMPORT"},
            )
        confidence = p.get("confidence")
        # v0.14.0 修 CN-2（审计 M8）：必须先排除 bool——isinstance(True, int) 为真且
        # 0.0 <= 1.0 <= 1.0 成立，修复前 `confidence: true` 会被当合法置信度入库。
        # 2026-10-31 修 #24：不再先 float(confidence)（10**400 会抛 OverflowError → 500），
        # 有限性判定排除 NaN/Infinity/超大整数；0.0 <= 10**400 本身不抛异常，range 照查。
        if not _is_finite_number(confidence) or not (0.0 <= confidence <= 1.0):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={"detail": f"预测 {predicted} 的 confidence 非法（须为 0.0-1.0 的数值）", "code": "INVALID_IMPORT"},
            )
        # v0.14.0 修 CN-2：model_version 白名单 + 长度上限（该字段会经前端
        # _getModelVersionLabel() 回退分支不加转义地插入 DOM，入口必须堵死）。
        model_version = str(p.get("model_version", "unknown"))
        if len(model_version) > 32 or model_version not in _ALLOWED_MODEL_VERSIONS:
            allowed = "/".join(sorted(_ALLOWED_MODEL_VERSIONS))
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={
                    "detail": f"预测 {predicted} 的 model_version 非法（合法取值：{allowed}）",
                    "code": "INVALID_IMPORT",
                },
            )
        actual = _parse_iso_date(p.get("actual_date"), "predictions[].actual_date", required=False)
        # 2026-10-31 修 #24：非 int 视为无值；超 64 位整数 → 400 INVALID_IMPORT
        # （修复前 10**100 在 create_import_prediction 绑定参数时 OverflowError → 500）
        error_days = _parse_import_optional_int(
            p.get("error_days"), "error_days", f"预测 {predicted.isoformat()}"
        )
        # 审计第二批 P2：model_params_json 由「透传」改为「校验后入库」
        # （旧实现 dict/str 一律放行，{"std_cycle":"x"} 使 GET /debug/model_history
        #  对其 int()/float() 永久 500——消费侧不可改，入口堵死）
        mp_json = _validate_import_model_params_json(p.get("model_params_json"), predicted)
        validated_predictions.append({
            "predicted_date": predicted.isoformat(),
            "predicted_start_upper": upper.isoformat(),
            "predicted_start_lower": lower.isoformat(),
            "confidence": float(confidence),
            "model_version": model_version,
            "model_params_json": mp_json,
            "actual_date": actual.isoformat() if actual else None,
            # 2026-10-31 修 #24：已由 _parse_import_optional_int 收敛（bool/非 int → None，
            # 超 64 位整数在解析处即 400），此处直接使用
            "error_days": error_days,
            "created_at": _validate_created_at(p.get("created_at"), predicted),
        })
    # v0.22.4 修 R33-fix1：按**规范序**（predicted_date ASC → created_at ASC →
    # id ASC）插入，使 id 顺序与预测时间序一致——「id 序 = 时间序」不再是隐藏依赖。
    # 只用内容锚 predicted_date 而非 created_at 单键：历史迁移/导入会让 created_at
    # 并列（R33 事故形态，用户库 4 条全为 2026-07-31 18:13:22），此时无法定序。
    # 单一实现见 crud._prediction_order_key（禁止在本文件重写排序口径）。
    validated_predictions.sort(key=crud._prediction_order_key)

    # ---- 2026-10-26 daily_records 校验（还原历史：不受补填窗口/来潮日限制，
    # 结构校验照走；行内 note 静默忽略；违规 → 400 INVALID_DAILY）----
    # 2026-10-31 修 #23：Win 前端 JSON 导入体不带 daily_records 键，而字段默认 []
    # （字段默认值本身无法区分「缺键」与「显式 []」；路由层用 model_fields_set 区分），
    # 旧实现无条件 delete + 空循环 →
    # 用户每日详情被删光。改为按 model_fields_set 区分：
    #   缺键 → validated_daily=None → 保留库内既有每日详情（不清空）；
    #   显式 [] → validated_daily=[] → 清空（完全覆盖语义）；
    #   非空数组 → 清空后重建。
    # 显式 JSON null 仍由 Pydantic 422（daily_records 类型 list[dict]，未改 Optional）。
    daily_records_provided = "daily_records" in body.model_fields_set
    validated_daily = _validate_daily_rows(body.daily_records) if daily_records_provided else None

    # R1 设置域空壳化 · app_settings 语义反转（v0.13.1 修 G6 的严格校验已撤销）：
    # 旧实现逐字段校验 notify_enabled/notify_days/theme，非法值 → 400 INVALID_IMPORT。
    # 现契约（用户 2026-09-18 裁定 + 冻结 HTTP 契约）：
    #   - 键类型只要求是 dict（None 允许；Optional[dict] 在 Pydantic 层已保证）
    #   - 内部出现 notify_enabled / notify_days / theme 及**任何其他键**一律静默忽略
    #   - 绝不因 app_settings 内容报错，也**不再写回**任何 settings 行
    # 为什么要放宽（不得回退）：用户手上已有的导出文件里带着这三个键，
    # 若继续严格校验就会把自己的旧备份永久锁死——导入必 400，数据永远回不来。
    # cycles / predictions / model_params 的严格校验不受本条影响（宁严不宽不变）。
    if body.app_settings is not None and not isinstance(body.app_settings, dict):
        # 防御性：Pydantic Optional[dict] 正常已拦下非 dict；此处仅作文档化边界
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"detail": "app_settings 必须是对象或 null", "code": "INVALID_IMPORT"},
        )
    # 故意不产出 validated_settings：遗留键被忽略，导入路径不再触碰 settings 表

    snapshot_path: Path | None = None
    try:
        async with WriteLock() as db:
            # ---- 迭代2（3.0.2）F1：清空重建**之前**先把「将被替换的数据」写一份快照 ----
            # 导入是清空重建型操作（cycles/predictions 必清空，daily_records 按键存在性覆盖），
            # 导入前没有任何快照 → 被覆盖的数据不可恢复（启动滚动备份只在启动时做，且无「导入前」语义）。
            # 快照落点与启动滚动备份同一目录（app.backup_path.resolve_backup_dir：env > custom > default），
            # 命名 pre-import-<stamp>.json 与滚动备份 app-<stamp>.db 可辨；内容含三类数据的实际条数与实际行。
            # 快照写失败 → 整体中止导入（不改动任何数据），不留下半覆盖状态、不污染备份目录。
            try:
                snapshot_path = await _write_pre_import_snapshot(user["id"], db)
            except Exception as e:  # noqa: BLE001
                raise HTTPException(
                    status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                    detail={
                        "detail": "导入前快照失败，已中止导入（未改动任何数据）",
                        "code": "IMPORT_BACKUP_FAILED",
                    },
                ) from e

            # 清空现有数据（v0.13.0 修 F8：改用 crud.delete_user_cycles / delete_user_predictions）
            await crud.delete_user_cycles(user["id"], db=db)
            await crud.delete_user_predictions(user["id"], db=db)

            # 插入 cycles（v0.13.0 修 F8：改用 crud.create_cycle；validated_cycles 的 cycle_length
            # 已 sanitize，create_cycle 再 sanitize 幂等）
            # 2026-10-31 修 #35：created_at 一并还原（None 时保持 SQL 默认 CURRENT_TIMESTAMP）
            for c in validated_cycles:
                await crud.create_cycle(
                    user["id"],
                    period_start=c["period_start"],
                    period_end=c["period_end"],
                    cycle_length=c["cycle_length"],
                    period_days=c["period_days"],
                    note=c["note"],
                    is_anomalous=bool(c["is_anomalous"]),
                    created_at=c["created_at"],
                    db=db,
                )
            imported_count = len(validated_cycles)

            # 插入 predictions（还原精度历史；v0.13.0 修 F8：改用 crud.create_import_prediction）
            for p in validated_predictions:
                await crud.create_import_prediction(
                    user["id"],
                    predicted_date=p["predicted_date"],
                    predicted_start_upper=p["predicted_start_upper"],
                    predicted_start_lower=p["predicted_start_lower"],
                    confidence=p["confidence"],
                    model_version=p["model_version"],
                    model_params_json=p["model_params_json"],
                    actual_date=p["actual_date"],
                    error_days=p["error_days"],
                    created_at=p["created_at"],
                    db=db,
                )
            imported_predictions = len(validated_predictions)

            # 2026-10-26：插入 daily_records（清空重建，同事务；ON CONFLICT 使重复日期后行胜出）
            # 2026-10-31 修 #23：仅在请求显式携带 daily_records 键时清空/重建；
            # 缺键（validated_daily is None）→ 保留库内既有每日详情，不删除任何行。
            imported_daily_count = 0
            if validated_daily is not None:
                await crud.delete_user_daily_records(user["id"], db=db)
                for d in validated_daily:
                    await crud.create_import_daily_record(
                        user["id"],
                        record_date=d["record_date"],
                        pain_present=d["pain_present"],
                        pain_level=d["pain_level"],
                        flow_level=d["flow_level"],
                        mood_level=d["mood_level"],
                        created_at=d["created_at"],
                        updated_at=d["updated_at"],
                        db=db,
                    )
                imported_daily_count = len(validated_daily)

            # v0.12.0 修 E4/E7：重推派生字段 + 全量重算 + 预测补偿，全部并入同一事务
            if imported_count > 0:
                # 重推 cycle_length/period_days/is_anomalous（CSV 导入无这些字段；
                # JSON 导入统一口径——导入文件可能是旧版本导出或手改的）
                await crud.recompute_derived_fields(user["id"], db=db)
                cycle_lengths = await crud.get_all_valid_cycle_lengths(user["id"], db=db)
                await crud.full_recompute_model_params(user["id"], cycle_lengths, db=db)

                # 审计第二批 P2：按导入后的真实记录日期回填未验证预测的 actual_date /
                # error_days（单一实现 prediction_service.rebackfill_prediction_actuals，
                # 与 cycles 补录/修正分支同一时序：先重推 actual 再决定补生成）。
                # 迭代 7（3.0.7）修 P1：preserve_existing=True——导入文件里 actual_date
                # 已非空的预测逐字段原样保留（导入是还原精度历史，不是按新记录集重算；
                # 旧实现把提前来潮 actual=B/error=1 改成下一周期 C/error=27）。
                await rebackfill_prediction_actuals(
                    user["id"], db=db, preserve_existing=True
                )

                # v0.9.0 修 P3：无任何未验证预测时补生成当前预测
                all_predictions = await crud.get_all_predictions(user["id"], db=db)
                has_unverified = any(p.get("actual_date") is None for p in all_predictions)
                if not has_unverified:
                    await crud.regenerate_current_prediction(user["id"], db=db)
    except Exception:
        # 迭代2（3.0.2）F1：事务失败 → 导入没有生效，刚写的快照作废（删除），
        # 备份目录回到导入前状态；数据由事务回滚保持原样（不留半覆盖状态）。
        if snapshot_path is not None:
            try:
                snapshot_path.unlink()
            except OSError:
                pass
        raise

    # R1：删除原「更新 app_settings」块——导入不再写回 settings（表空壳保留）

    message = f"成功导入 {imported_count} 条记录、{imported_predictions} 条历史预测"
    if imported_daily_count > 0:
        message += f"、{imported_daily_count} 条每日详情"
    return {
        "imported_cycles": imported_count,
        "imported_predictions": imported_predictions,
        "imported_daily_records": imported_daily_count,
        "message": message,
    }


# ============================================================================
# 迭代2（3.0.2）F1：覆盖式导入前的「被替换数据」快照
# ============================================================================
# 背景：POST /import 是清空重建型操作（cycles/predictions 必清空，daily_records 按
# 请求键存在性覆盖）。导入前系统没有任何快照 → 被覆盖的数据不可恢复（启动滚动备份
# 只在启动时做一次，且与「导入前」无关）。
# 本组 helper 的契约：
#   落点 —— 与启动滚动备份**同一目录**：app.backup_path.resolve_backup_dir(config.DB_ABS_PATH)
#          （优先级 env > custom > default，与 GET /backups 同一来源）；
#   命名 —— pre-import-<YYYYmmdd-HHMMSS>.json（与滚动备份 app-<stamp>.db 可辨）；
#   内容 —— 该用户导入前将被替换的三类数据（cycles / predictions / daily_records）的
#          **实际行** + 各自的**实际条数**（counts）；daily_records 行内剥除 mood_note /
#          mood_tags（与 GET /export 同口径：仅本地、不导出、导入侧亦忽略）；
#   失败 —— 快照写不成功 → 导入整体中止（不改动任何数据），备份目录不残留半成品；
#   回滚 —— 导入事务失败 → 删除刚写的快照（备份目录回到导入前状态）。
_PRE_IMPORT_SNAPSHOT_PREFIX = "pre-import-"
# 保留份数与启动滚动备份同口径（desktop/entry.py DESKTOP_BACKUP_KEEP = 15）
_PRE_IMPORT_SNAPSHOT_KEEP = 15


def _prune_pre_import_snapshots(backup_dir: Path, keep: int = _PRE_IMPORT_SNAPSHOT_KEEP) -> None:
    """滚动保留最近 keep 份导入前快照（文件名内嵌时间戳，字典序即时间序）。删除失败不影响导入。"""
    try:
        snaps = sorted(backup_dir.glob(f"{_PRE_IMPORT_SNAPSHOT_PREFIX}*.json"))
    except OSError:
        return
    excess = len(snaps) - keep
    for old in snaps[:excess] if excess > 0 else []:
        try:
            old.unlink()
        except OSError:
            pass


async def _write_pre_import_snapshot(user_id: int, db=None) -> Path:
    """把该用户导入前将被替换的数据写成 JSON 快照，返回落盘路径。

    在导入事务内、清空重建之前调用：此刻读到的就是**即将被替换掉的真实数据**
    （不是空库），事务回滚时调用方负责删除该文件。
    """
    from app.backup_path import resolve_backup_dir

    cycles = await crud.get_all_cycles_asc(user_id, db=db)
    predictions = await crud.get_predictions_chronological(user_id, db=db)
    daily = await crud.get_all_daily_records(user_id, db=db)
    daily_snapshot = [
        {k: v for k, v in r.items() if k not in ("mood_note", "mood_tags")}
        for r in daily
    ]

    backup_dir = resolve_backup_dir(config.DB_ABS_PATH)
    backup_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    target = backup_dir / f"{_PRE_IMPORT_SNAPSHOT_PREFIX}{stamp}.json"
    i = 0
    while target.exists() and i < 5:
        target = backup_dir / f"{_PRE_IMPORT_SNAPSHOT_PREFIX}{stamp}-{i}.json"
        i += 1

    payload = {
        "snapshot_kind": "pre-import",
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "app_version": config.APP_VERSION,
        "counts": {
            "cycles": len(cycles),
            "predictions": len(predictions),
            "daily_records": len(daily),
        },
        "cycles": cycles,
        "predictions": predictions,
        "daily_records": daily_snapshot,
    }
    target.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    _prune_pre_import_snapshots(backup_dir)
    return target


def _now_sqlite() -> str:
    """SQLite CURRENT_TIMESTAMP 同格式的「导入时刻」（UTC，F10：导入预测缺失 created_at 时的兜底）。

    保持与既有导出行同格式（%Y-%m-%d %H:%M:%S），字符串比较顺序即时间顺序。
    """
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def _reject_import_future_date(
    value: date, label: str, record_start: date, code: str = "INVALID_IMPORT"
) -> None:
    """v0.14.0 修 CN-1（审计 H6）：导入业务日期的未来上限校验，违规 → 400。

    上限 = date.today() + config.MAX_FUTURE_CYCLE_DAYS（当前 0 = 不晚于今天），
    与 schemas.CycleCreate/_reject_beyond_future_limit 同一规则、同一 config 常量
    （M8 同类漏洞：POST/PUT 拦住的输入不能从导入路径绕回）。
    时区口径同 config.py v0.13.1 G17：业务日期用 date.today()（本地时区），不用 UTC。
    record_start 仅用于在错误消息里定位到具体记录。
    2026-10-26：加 code 参数供 daily_records 走 INVALID_DAILY（默认值保持既有调用零改动）。
    """
    limit = date.today() + timedelta(days=config.MAX_FUTURE_CYCLE_DAYS)
    if value > limit:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "detail": f"记录 {record_start.isoformat()} 的{label} {value.isoformat()} "
                          f"晚于允许上限（最晚 {limit.isoformat()}）",
                "code": code,
            },
        )


def _parse_is_anomalous(value: Any, record_start: date) -> int:
    """v0.14.0 修 CN-2（审计 M8）：is_anomalous 严格解析（只接受 bool 或 0/1 整数）。

    修复前写法 `1 if c.get("is_anomalous") else 0` 是**真值判断**：字符串 "false"、
    非零整数、非空列表都会落成 1，脏值随导入写库。
    本函数选择「拒绝并报 400 INVALID_IMPORT」而非「静默置 0」：导入是清空重建型
    单事务操作（先 DELETE 再 INSERT），宁严不宽——静默忽略会让用户以为导入成功，
    实际派生字段被改写且无从察觉。
    键缺失 / 显式 null → 0（兼容只含起止两列的 CSV 转换文件，旧导出文件也恒有该键）。
    """
    if value is None:
        return 0
    if isinstance(value, bool):
        return 1 if value else 0
    if isinstance(value, int) and value in (0, 1):
        return value
    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail={
            "detail": f"记录 {record_start.isoformat()} 的 is_anomalous 非法（须为 bool 或 0/1 整数）",
            "code": "INVALID_IMPORT",
        },
    )


def _validate_created_at(value: Any, predicted: date, label: str = "预测") -> str:
    """v0.14.0 修 CN-2（审计 M8）：导入 created_at 的宽松校验。

    规则：缺失 / 非字符串 / 空串 → 兜底 _now_sqlite()（v0.13.0 修 F10 的既有语义，
    旧文件可能没有该键）；字符串则要求「长度 <= _MAX_CREATED_AT_LEN(32) 且不含
    控制字符」，保证其可被 SQLite 字符串比较/排序安全使用（created_at 是
    ORDER BY created_at DESC 的排序键，换行等控制字符会污染排序与展示）。
    刻意**不做** datetime 解析强约束：旧导出文件的时间戳格式不保证统一，
    强解析会破坏既有导出文件的往返兼容性。
    2026-10-26：加 label 参数供 daily_records 复用（默认值保持既有调用零改动）。
    """
    if not isinstance(value, str) or not value:
        return _now_sqlite()
    if len(value) > _MAX_CREATED_AT_LEN or any(ch < " " or ch == "\x7f" for ch in value):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "detail": f"{label} {predicted.isoformat()} 的 created_at 非法（须为不超过 {_MAX_CREATED_AT_LEN} 字符、"
                          f"不含控制字符的时间戳文本）",
                "code": "INVALID_IMPORT",
            },
        )
    return value


def _parse_daily_level(value: Any, field: str, record_date: date, required: bool) -> int | None:
    """2026-10-26：daily_records 数值等级的严格解析（排除 bool；required 时缺失即拒）。

    口径与 schemas.DailyRecordUpsert 一致：只接受 [1,10] 整数；违规 → 400 INVALID_DAILY。
    """
    if value is None:
        if required:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={"detail": f"每日详情 {record_date.isoformat()} 的 {field} 缺失（须为 1-10 整数）",
                        "code": config.INVALID_DAILY_CODE},
            )
        return None
    if isinstance(value, bool) or not isinstance(value, int) or not (1 <= value <= 10):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"detail": f"每日详情 {record_date.isoformat()} 的 {field} 非法（须为 1-10 整数）",
                    "code": config.INVALID_DAILY_CODE},
        )
    return value


def _validate_daily_rows(rows: list[dict]) -> list[dict]:
    """2026-10-26：逐条校验导入的 daily_records（结构校验照走；note 静默忽略）。

    与 PUT 端点的差异（用户裁定）：还原历史——不受补填窗口与来潮日限制，
    但**不得晚于今天**（与 CN-1 同理：API 侧拦住的未来日期不能从导入路径绕回）。
    """
    validated: list[dict] = []
    for d in rows:
        record_date = _parse_iso_date(d.get("record_date"), "daily_records[].record_date")
        _reject_import_future_date(record_date, "每日详情日期", record_date, code=config.INVALID_DAILY_CODE)
        pain_present_raw = d.get("pain_present")
        if isinstance(pain_present_raw, bool):
            pain_present = pain_present_raw
        elif isinstance(pain_present_raw, int) and pain_present_raw in (0, 1):
            pain_present = bool(pain_present_raw)
        else:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={"detail": f"每日详情 {record_date.isoformat()} 的 pain_present 非法（须为布尔）",
                        "code": config.INVALID_DAILY_CODE},
            )
        pain_level = _parse_daily_level(d.get("pain_level"), "pain_level", record_date, required=False)
        if pain_present and pain_level is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={"detail": f"每日详情 {record_date.isoformat()} 有疼痛时必须填写疼痛等级（1-10）",
                        "code": config.INVALID_DAILY_CODE},
            )
        if not pain_present and pain_level is not None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={"detail": f"每日详情 {record_date.isoformat()} 无疼痛时疼痛等级必须为空",
                        "code": config.INVALID_DAILY_CODE},
            )
        flow_level = _parse_daily_level(d.get("flow_level"), "flow_level", record_date, required=True)
        mood_level = _parse_daily_level(d.get("mood_level"), "mood_level", record_date, required=True)
        validated.append({
            "record_date": record_date.isoformat(),
            "pain_present": pain_present,
            "pain_level": pain_level,
            "flow_level": flow_level,
            "mood_level": mood_level,
            # 行内 note 一律静默忽略（感受文本永不随备份往返）
            "created_at": _validate_created_at(d.get("created_at"), record_date, label="每日详情"),
            "updated_at": _validate_created_at(d.get("updated_at"), record_date, label="每日详情"),
        })
    return validated


# ============================================================
# 2026-10-31 修 #24：导入数值边界（类型 + 范围）统一入口
# ============================================================

# SQLite INTEGER 为有符号 64 位；超出范围的整数无法绑定，必须在入口 400
# （否则 import 事务内抛 OverflowError → 500，且回滚后用户只看到裸 500）。
_SQLITE_INT64_MIN = -(2 ** 63)
_SQLITE_INT64_MAX = 2 ** 63 - 1


def _is_finite_number(value: Any) -> bool:
    """有限数值判定：排除 bool/非数值；超出 float 范围的整数视为非有限（与 Android 同构）。

    math.isfinite(10**400) 会抛 OverflowError（int 先转 float），必须捕获并返回 False；
    math.isfinite(nan/inf) 返回 False。注意 0.0 <= 10**400 不抛异常，故 range 判断
    必须在有限性判断之后或与之同时使用（见 confidence/prior_weight）。
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def _parse_import_cycle_length(value: Any, start: date) -> int | float | None:
    """导入 cycles[].cycle_length：有限数值才交 _sanitize_cycle_length。

    None → None（键缺失/显式 null 沿用旧语义）；非有限数值（字符串/布尔/NaN/
    Infinity/超 float 范围整数）→ 400 INVALID_IMPORT（修复前字符串会冒到
    crud._sanitize_cycle_length 比较时 TypeError → 500）；有限数值仍走既有
    sanitize：越 [MIN_CYCLE_DAYS, MAX_CYCLE_DAYS] 置 None；通过校验的入参值随后仍由
    导入事务 recompute_derived_fields 按日期重推，不在库中保留（45.5 仅表示类型可过，
    不是最终落库值）。
    """
    if value is None:
        return None
    if not _is_finite_number(value):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "detail": f"记录 {start.isoformat()} 的 cycle_length 非法（须为有限数值）",
                "code": "INVALID_IMPORT",
            },
        )
    return _sanitize_cycle_length(value)  # type: ignore[arg-type]


def _parse_import_optional_int(value: Any, field: str, subject: str) -> int | None:
    """导入可选整数字段（cycles[].period_days / predictions[].error_days）。

    口径：None/bool/非 int（字符串、float）→ None（沿用既有「视为无值」，
    与 Android strictInt 同构）；int 超出 SQLite 64 位范围 → 400 INVALID_IMPORT
    （修复前 10**100 会在 create_cycle/create_import_prediction 绑定参数时抛
    OverflowError → 500）；否则原样返回。
    """
    if value is None or isinstance(value, bool) or not isinstance(value, int):
        return None
    if not (_SQLITE_INT64_MIN <= value <= _SQLITE_INT64_MAX):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "detail": f"{subject} 的 {field} 超出可存储范围（须为 64 位整数）",
                "code": "INVALID_IMPORT",
            },
        )
    return value


# 审计第二批 P2：model_params_json 的已知数值字段（消费侧 debug.py 对这些键做
# int()/float()，脏类型入库 = GET /debug/model_history 永久 500，入口必须堵死）。
_MP_JSON_NUMERIC_FIELDS = ("mean_cycle", "std_cycle", "ema_cycle", "prior_mean", "prior_std")


def _validate_import_model_params_json(mp: Any, predicted: date) -> str:
    """校验并归一 predictions[].model_params_json（审计第二批 P2；非法 → 400 INVALID_IMPORT）。

    背景：旧实现 dict/str 一律透传入库，``{"std_cycle": "x"}`` 这类脏类型会随
    重建写库，使 GET /debug/model_history 对其 int()/float() 永久 500（风险只增不减，
    单条脏预测钉死整个端点）。

    规则：
    - dict 形态：数值字段（mean_cycle/std_cycle/ema_cycle/prior_mean/prior_std）
      必须是有限数值（_is_finite_number：排除 bool/非数值/NaN/Infinity，以及
      **超出 float 范围的整数**——math.isfinite(10**400) 抛 OverflowError，视为非有限）；
      prior_weight 有限且 0≤x≤1；n_records 非负整数（排除 bool，超大 int 与 Android
      BigInteger 口径一致放行）；n_records/prior_weight 显式 null **放行**（与 Android
      ImportModelParams 同构，消费侧 debug.py 按缺失默认处理）。非法 → 400。
      通过后以 allow_nan=False 重新 dumps（未知附加键里的 NaN/Infinity 在此拦下，
      TypeError/ValueError → 400「包含无法序列化的数值」）。
      **缺失键放行**（消费侧 .get() 有默认值）；多余未知键忽略（导出快照可能带
      n_eff / stale_correction 等附加键，不得因附加键拒收自家导出文件）。
    - str 形态：json.loads（parse_constant 拒绝 NaN/Infinity/-Infinity）；解析失败或
      解析结果不是 dict → 400；是 dict 则按上述同规则校验，再以 allow_nan=False
      dumps 仅作校验（丢弃结果，仍原样返回 str——避免键序/空白/转义差异引入无谓的
      存储漂移）。这一步还能拦住 JSON 文本里 ``1e400`` 这类解析成 inf 的未知键数值。
    - 空串 / None → "{}"（旧导出文件可能缺键，既有兜底行为保留）。
    - 其余类型（list/int/bool 等）→ 400（宁严不宽：旧实现静默落 "{}" 会掩盖手改
      文件的数据损坏，与同文件 cycles/predictions 校验的「可疑输入一律 400」一致）。
    """
    def _reject(field: str, reason: str) -> None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "detail": f"预测 {predicted.isoformat()} 的 model_params_json.{field} 非法（{reason}）",
                "code": "INVALID_IMPORT",
            },
        )

    def _reject_unserializable() -> None:
        """未知键里的非有限/不可序列化数值：错误无法定位到单一字段。

        单独成 helper，文案不带 ``.model_params_json.`` 前缀——避免出现
        ``model_params_json.model_params_json`` 的重复字段名。
        """
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "detail": f"预测 {predicted.isoformat()} 的 model_params_json 非法（包含无法序列化的数值）",
                "code": "INVALID_IMPORT",
            },
        )

    def _check_dict(mp_obj: dict) -> None:
        for field in _MP_JSON_NUMERIC_FIELDS:
            if field not in mp_obj:
                continue
            # 2026-10-31 修 #24：统一走 _is_finite_number（10**400 不再抛 OverflowError）
            if not _is_finite_number(mp_obj[field]):
                _reject(field, "须为有限数值")
        prior_weight = mp_obj.get("prior_weight")
        # 2026-10-31 修 #24：显式 null 放行（消费侧按缺失处理）；10**400 由
        # _is_finite_number 判 False，0.0 <= 10**400 <= 1.0 本身不抛异常。
        if prior_weight is not None and (
            not _is_finite_number(prior_weight) or not (0.0 <= prior_weight <= 1.0)
        ):
            _reject("prior_weight", "须为 0-1 的数值")
        n_records = mp_obj.get("n_records")
        if n_records is not None and (
            isinstance(n_records, bool) or not isinstance(n_records, int) or n_records < 0
        ):
            _reject("n_records", "须为非负整数")

    if mp is None:
        return "{}"
    if isinstance(mp, dict):
        _check_dict(mp)
        try:
            # 2026-10-31 修 #24：未知键里的 NaN/Infinity 在此被 allow_nan=False 拦下
            return json.dumps(mp, ensure_ascii=False, allow_nan=False)
        except (TypeError, ValueError):
            _reject_unserializable()
    if isinstance(mp, str):
        if not mp:
            return "{}"

        def _reject_constant(_value: str) -> None:
            # json.loads 的 parse_constant 在 NaN/Infinity/-Infinity 时被调用
            raise ValueError("non-finite JSON constant")

        try:
            # 2026-10-31 修 #24：parse_constant 拒绝 NaN/Infinity/-Infinity；
            # ValueError 一并覆盖 JSONDecodeError（其子类）
            parsed = json.loads(mp, parse_constant=_reject_constant)
        except ValueError as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={
                    "detail": f"预测 {predicted.isoformat()} 的 model_params_json 非法（不是合法的 JSON 文本）",
                    "code": "INVALID_IMPORT",
                },
            ) from exc
        if not isinstance(parsed, dict):
            _reject("model_params_json", "JSON 文本必须表示对象")
        _check_dict(parsed)
        try:
            # 仅作校验（结果丢弃，仍原样返回 str）：拦住 1e400 → inf 等未知键数值
            json.dumps(parsed, ensure_ascii=False, allow_nan=False)
        except (TypeError, ValueError):
            _reject_unserializable()
        return mp  # 校验通过后原样保留 str（见 docstring：避免二次序列化差异）
    _reject("model_params_json", "须为对象、JSON 文本或 null")


def _parse_iso_date(value: Any, field: str, required: bool = True) -> date | None:
    """解析 ISO 日期字符串；非法 → 400 INVALID_IMPORT（不暴露堆栈）。

    required=False 时 None 合法（如 period_end 未填、actual_date 未验证），
    返回 None；其余非法输入一律 400。
    """
    from datetime import date as _date

    if value is None:
        if required:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={"detail": f"{field} 缺失或不是合法的 ISO 日期（YYYY-MM-DD）", "code": "INVALID_IMPORT"},
            )
        return None
    if isinstance(value, _date):
        return value
    if isinstance(value, str):
        try:
            return _date.fromisoformat(value)
        except ValueError:
            pass
    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail={"detail": f"{field} 缺失或不是合法的 ISO 日期（YYYY-MM-DD）", "code": "INVALID_IMPORT"},
    )


# ============================================================
# R2-A PeriodIQ：导出预览（数据预览端点，非文件格式通道，不写库）
# ============================================================

def _build_export_model(user_id: int, model_params: dict, valid_lengths: list[float]) -> dict:
    """组装「算法与权重」面板所需 model 字段。

    **必须取自既有函数**（stats.predict_core + crud.get_model_params），
    不得重写算法、不得新增算法口径。weights[] 标签中文、值域 [0,1]。
    """
    prev_ema = replay_ema(valid_lengths, config, exclude_last=True) if valid_lengths else None
    core = stats.predict_core(valid_lengths, prev_ema, config)
    prior_weight = round(float(core["prior_weight"]), 4)
    data_weight = round(1.0 - prior_weight, 4)
    n_records = int(model_params.get("n_records", core["n"]))
    model_version = (
        config.MODEL_VERSION_NONE if not valid_lengths else core["model_version"]
    )
    return {
        "n_records": n_records,
        "mean_cycle": round(float(model_params.get("mean_cycle", config.PRIOR_MEAN)), 4),
        "std_cycle": round(float(model_params.get("std_cycle", config.PRIOR_STD)), 4),
        "ema_cycle": round(float(model_params.get("ema_cycle", config.PRIOR_MEAN)), 4),
        "prior_mean": round(float(model_params.get("prior_mean", config.PRIOR_MEAN)), 4),
        "prior_std": round(float(model_params.get("prior_std", config.PRIOR_STD)), 4),
        "prior_weight": prior_weight,
        "posterior_n_eff": round(float(core["posterior_n_eff"]), 4),
        "shrink_irregularity": round(float(core["shrink_irregularity"]), 4),
        "weights": [
            {"label": "先验权重", "value": prior_weight},
            {"label": "数据权重", "value": data_weight},
        ],
        "model_version": model_version,
    }


def _format_preview_prediction(latest_pred: dict | None, model_params: dict) -> dict | None:
    """把 crud 预测行整理成 preview.prediction（与首页展示同源字段）。"""
    if latest_pred is None:
        return None
    try:
        predicted_date = date.fromisoformat(latest_pred["predicted_date"])
        days_until = (predicted_date - date.today()).days
    except (KeyError, ValueError, TypeError):
        predicted_date = None
        days_until = None
    return {
        "predicted_date": latest_pred.get("predicted_date"),
        "predicted_start_lower": latest_pred.get("predicted_start_lower"),
        "predicted_start_upper": latest_pred.get("predicted_start_upper"),
        "confidence": latest_pred.get("confidence"),
        "model_version": latest_pred.get("model_version"),
        "days_until_predicted": days_until,
        "model_params": model_params,
        "actual_date": latest_pred.get("actual_date"),
        "created_at": latest_pred.get("created_at"),
        "id": latest_pred.get("id"),
    }


@router.get("/export/preview", response_model=ExportPreviewResponse)
async def export_preview(user: dict = Depends(require_user)) -> dict:
    """导出预览：cycles + 当前 prediction + model（算法与权重面板）。

    cycles 与 GET /cycles 同形；顺序为 period_start ASC, id ASC（修 #25：与
    /export 的 cycles 顺序一致，CSV 导出同序）。model 字段全部取自既有函数
    （predict_core / get_model_params），不重写算法。
    prediction 走 prediction_service（与首页同源，含过期刷新语义）。

    **不变量（修 #35 登记）**：本端点是数据预览通道、不是备份通道——cycles
    **恒返回完整列表、不截断**（与 /export 的「取最新 1000 条」不同）。
    由此产生的边界：cycles > MAX_IMPORT_CYCLES（1000）条时，预览完整但据其
    发起的 CSV/JSON 导入会被 ImportRequest 的条数校验 422——前端重建轮须提示
    用户或先截断（/export 的 cycles 已是 ≤1000 条的可回灌形态）。
    """
    cycles = await crud.get_all_cycles_asc(user["id"])
    model_params = await crud.get_model_params(user["id"])
    valid_lengths = await crud.get_all_valid_cycle_lengths(user["id"])
    fresh = await get_fresh_prediction(user["id"])
    prediction = _format_preview_prediction(fresh.get("latest_pred"), fresh.get("model_params") or {})
    model = _build_export_model(user["id"], model_params, valid_lengths)
    return {
        "cycles": cycles,
        "prediction": prediction,
        "model": model,
    }
