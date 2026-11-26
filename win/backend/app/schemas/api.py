# Copyright (c) 2026 Yui_0818 (aaaj6719@gmail.com)
# Licensed under the PolyForm Noncommercial License 1.0.0.
# Commercial use is prohibited without separate written authorization.
# See LICENSE and COMMERCIAL.md in the repository root.

"""Pydantic 请求/响应模型（早期设计文档）。

日期统一 ISO 8601 YYYY-MM-DD（Pydantic 强制，致命 Bug 禁令）。
字段名严格按DDL 和 API 契约，不得修改。
"""

from datetime import date, timedelta
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app import config


# ============================================================
# v0.14.0 修 CN-1（审计 H6）：业务日期上限——不得晚于「今天 + MAX_FUTURE_CYCLE_DAYS」
# ============================================================

def _reject_beyond_future_limit(v: Optional[date], label: str) -> Optional[date]:
    """业务日期上限校验（None 直通，供可选字段复用）。

    上限 = date.today() + config.MAX_FUTURE_CYCLE_DAYS（当前 0 = 不晚于今天）。
    时区口径按 config.py v0.13.1 G17 登记：period_start/period_end 是**用户的业务
    日期**，与 date.today()（本地时区）同口径，不得改用 UTC（UTC 会在东八区
    00:00-08:00 把「今天」判成明天，误拒合法的当天录入）。
    违规抛 ValueError → FastAPI 422 VALIDATION_ERROR（扁平契约）。
    """
    if v is None:
        return None
    today = date.today()
    limit = today + timedelta(days=config.MAX_FUTURE_CYCLE_DAYS)
    if v > limit:
        if config.MAX_FUTURE_CYCLE_DAYS == 0:
            raise ValueError(f"{label}不能晚于今天（{today.isoformat()}）")
        raise ValueError(
            f"{label}不能晚于今天 + {config.MAX_FUTURE_CYCLE_DAYS} 天（最晚 {limit.isoformat()}）"
        )
    return v


# ============================================================
# cycles 请求/响应
# ============================================================

class CycleCreate(BaseModel):
    """新增月经记录请求（POST /cycles）。

    v0.12.0 死代码清理：删除原 validate_iso_date 空操作验证器
    （Pydantic 已强制 date 类型，验证器只原样返回 v，无任何作用）。
    v0.14.0 修 CN-1（审计 H6）：period_start 与 period_end 均不得晚于
    「今天 + config.MAX_FUTURE_CYCLE_DAYS」（当前 0 = 不晚于今天）——
    修复前 2099-01-01 可创建成功，模型锚点被拉到 2099 年、所有预测失去意义，
    首页圆环还会渲染「26438 天后开始」撑破布局。
    """
    period_start: date = Field(..., description="月经开始日期 YYYY-MM-DD")
    period_end: Optional[date] = Field(None, description="月经结束日期，可选")
    note: str = Field("", max_length=2000, description="备注（v0.13.0 修 F5：≤2000 字符）")

    @field_validator("period_start")
    @classmethod
    def _check_period_start_not_future(cls, v: date) -> date:
        """v0.14.0 修 CN-1：开始日不得晚于今天（上限见 config.MAX_FUTURE_CYCLE_DAYS）。"""
        return _reject_beyond_future_limit(v, "月经开始日期")

    @field_validator("period_end")
    @classmethod
    def _check_period_end_not_future(cls, v: Optional[date]) -> Optional[date]:
        """v0.14.0 修 CN-1：结束日不得晚于同一上限（否则可造出「结束日在 2099」的记录）。

        仅追加**上限**校验：不新增「不得早于 start」以外的其它限制，
        跨日/时区边界仍保持宽松（start > end 由路由层 400 INVALID_PERIOD_END 负责）。
        """
        return _reject_beyond_future_limit(v, "月经结束日期")


class CycleUpdate(BaseModel):
    """更新月经记录请求（PUT /cycles/{id}）。

    v0.9.0 放开 period_start（用户授权的「修正」功能）：过往标定的经期开始日
    允许修正，路由层会做邻接重叠校验，并触发**全量重算**（本条及其后所有记录的
    cycle_length 与模型参数都会随修正更新）。period_end/note 语义不变。
    v0.11.5 修 B1：新增 clear_period_end 显式清空结束日。None 语义是「不更新」，
    无法表达「清空」（前端修正弹窗承诺「留空表示未填结束日」却永远发不出去），
    对齐 ProfileUpdate 的 clear_birthday/clear_weight 显式清空模式。
    v0.13.1 修 G3：note 补 max_length=2000（与 CycleCreate 对齐——F5 只修了 POST 侧，
    PUT 侧此前可写超长文本；导入路径的同限校验见 settings._validate_import）。
    v0.14.0 修 CN-1（审计 H6）：period_start/period_end 可选，**提供时**同样受
    「不得晚于今天 + config.MAX_FUTURE_CYCLE_DAYS」约束（未提供的 None 直通，
    不触发校验）——修复前 PUT 可把记录修正到 2099 年，绕过 POST 侧新增的限制。
    """
    period_start: Optional[date] = None
    period_end: Optional[date] = None
    note: Optional[str] = Field(None, max_length=2000)
    clear_period_end: bool = Field(False, description="显式清空结束日期（period_days 一并置 NULL）")

    @field_validator("period_start")
    @classmethod
    def _check_period_start_not_future(cls, v: Optional[date]) -> Optional[date]:
        """v0.14.0 修 CN-1：修正开始日不得晚于今天（None = 不更新，直通）。"""
        return _reject_beyond_future_limit(v, "月经开始日期")

    @field_validator("period_end")
    @classmethod
    def _check_period_end_not_future(cls, v: Optional[date]) -> Optional[date]:
        """v0.14.0 修 CN-1：修正结束日不得晚于同一上限（None = 不更新，直通）。"""
        return _reject_beyond_future_limit(v, "月经结束日期")

    @model_validator(mode="after")
    def _reject_clear_conflict(self) -> "CycleUpdate":
        """clear_period_end 与 period_end 互斥（同时提供属客户端逻辑错误）。"""
        if self.clear_period_end and self.period_end is not None:
            raise ValueError("clear_period_end 与 period_end 不能同时提供")
        return self


class CycleResponse(BaseModel):
    """月经记录响应。"""
    id: int
    period_start: date
    period_end: Optional[date] = None
    cycle_length: Optional[int] = None
    period_days: Optional[int] = None
    note: str = ""
    is_anomalous: bool = False
    created_at: Optional[str] = None

    model_config = ConfigDict(from_attributes=True)


class CycleCreateResponse(BaseModel):
    """POST /cycles 成功响应（201，含 prediction，既有 API 契约）。"""
    id: int
    period_start: date
    period_end: Optional[date] = None
    cycle_length: Optional[int] = None
    period_days: Optional[int] = None
    note: str = ""
    is_anomalous: bool = False
    created_at: Optional[str] = None
    prediction: Optional[dict] = Field(None, description="本次新增触发的预测快照")


# ============================================================
# predictions 响应
# ============================================================

class PredictionCurrentResponse(BaseModel):
    """GET /predictions/current 响应（既有 API 契约）。

    有记录时返回完整预测；无记录时 predicted_date=null。
    days_until_predicted 为计算字段（predicted_date - today）。
    is_corrected / corrected_from 为 v0.8.0 新增（修 F7）：当本次请求检测到
    库内预测已过期并已就地重算落库时为 true，corrected_from 记原预测日；
    正常情况为 False/null，旧客户端可安全忽略。
    """
    predicted_date: Optional[date] = None
    predicted_start_lower: Optional[date] = None
    predicted_start_upper: Optional[date] = None
    confidence: float = 0.0
    model_version: str = "none"
    days_until_predicted: Optional[int] = None
    model_params: Optional[dict] = None
    message: Optional[str] = None
    is_corrected: bool = False
    corrected_from: Optional[date] = None


class FertileWindowResponse(BaseModel):
    """GET /analysis/fertile-window 响应（v0.8.0 新增，早期设计文档）。

    仅基于已有月经周期数据按标准日历法推算，不要求任何新增输入。
    ovulation_sigma_days 为排卵日不确定幅度（等于周期标准差），ⓘ 弹窗展示。
    less_certain_windows 为「相对不易受孕期」（非「安全期」），可能 0-2 段；
    未填 period_end 且无历史经期记录时卵泡期段不会出现（不臆造经期长度）。
    v0.8.1：predicted_period_days 为历史经期天数中位数，
    predicted_period_windows 为本次/下次经期预测区间（前端淡粉标注）。
    """
    available: bool = False
    ovulation_date: Optional[date] = None
    ovulation_sigma_days: float = 0.0
    fertile_window: Optional[dict] = None
    less_certain_windows: list[dict] = []
    basis: str = "calendar_rule"
    predicted_period_days: Optional[int] = None
    current_period_predicted_end: Optional[date] = None
    next_period_predicted_end: Optional[date] = None
    predicted_period_windows: list[dict] = []


class PredictionHistoryItem(BaseModel):
    """历史预测列表项。"""
    id: int
    predicted_date: date
    predicted_start_upper: date
    predicted_start_lower: date
    confidence: float
    model_version: str
    model_params_json: str
    actual_date: Optional[date] = None
    error_days: Optional[int] = None
    created_at: Optional[str] = None


# ============================================================
# analysis 响应
# ============================================================

class AccuracyResponse(BaseModel):
    """GET /analysis/accuracy 响应（既有 API 契约）。"""
    total_predictions: int = 0
    evaluated: int = 0
    hit_rate_pm1: Optional[float] = None
    hit_rate_pm2: Optional[float] = None
    hit_rate_pm3: Optional[float] = None
    hit_rate_pm5: Optional[float] = None
    hit_rate_pm7: Optional[float] = None
    mae: Optional[float] = None
    interval_coverage: Optional[float] = None
    bias: Optional[float] = None
    trend: Optional[str] = None
    error: Optional[str] = None


class CycleStatsResponse(BaseModel):
    """GET /analysis/cycle-stats 响应。

    v0.9.0 新增 clinical_notes：临床观察提示（纯派生自用户数据，不新增输入、
    不做诊断；措辞「建议关注/建议咨询医生」）。空列表表示无提示。
    """
    total_records: int = 0
    total_cycles: int = 0
    avg_cycle_length: Optional[float] = None
    avg_period_days: Optional[float] = None
    shortest_cycle: Optional[int] = None
    longest_cycle: Optional[int] = None
    anomalous_count: int = 0
    status: str = "EMPTY"
    status_message: str = "暂无数据"
    clinical_notes: list[dict] = []


# ============================================================
# daily-records 请求/响应（经期每日详情，2026-10-26 用户立项）
# ============================================================

class DailyRecordUpsert(BaseModel):
    """PUT /daily-records/{record_date} 请求。

    疼痛契约：pain_present=true ⇒ pain_level∈[1,10] 必填；false ⇒ 必须 NULL
    （无疼痛存 NULL 不存 0）。经期四件套 = 疼痛 / 血量 / 心情等级 / 心情标签（#15）。
    日记文本不在这里（#14：独立渠道 /daily-journal）；旧客户端仍发送的 mood_note
    按未知字段忽略（pydantic 默认 extra=ignore），不再入库。
    """
    pain_present: bool = Field(..., description="是否有疼痛")
    pain_level: Optional[int] = Field(None, ge=1, le=10, description="疼痛等级 1-10；无疼痛必须 null")
    flow_level: int = Field(..., ge=1, le=10, description="血量等级 1-10")
    mood_level: int = Field(..., ge=1, le=10, description="心情等级 1-10（高=好）")
    mood_tags: list[str] = Field(
        default_factory=list,
        description="心情/身体标签 ID（受控词表，≤8 个且不重复，每个 ≤24 字符）",
    )

    @field_validator("mood_tags")
    @classmethod
    def _check_mood_tags(cls, v: list[str]) -> list[str]:
        """标签校验（违反 → 422 VALIDATION_ERROR）：个数 ≤ 8、每个 ≤ 24 字符、在词表内、不重复。"""
        if len(v) > config.MOOD_TAGS_MAX_COUNT:
            raise ValueError(f"心情标签最多 {config.MOOD_TAGS_MAX_COUNT} 个")
        seen: set[str] = set()
        for tag in v:
            if len(tag) > config.MOOD_TAG_ID_MAX_CHARS:
                raise ValueError(f"每个心情标签不超过 {config.MOOD_TAG_ID_MAX_CHARS} 个字符")
            if tag not in config.MOOD_TAG_IDS:
                raise ValueError(f"未知的心情标签：{tag}")
            if tag in seen:
                raise ValueError(f"心情标签重复：{tag}")
            seen.add(tag)
        return v

    @model_validator(mode="after")
    def _check_pain_level(self) -> "DailyRecordUpsert":
        """疼痛等级与疼痛开关严格联动（违反 → 422 VALIDATION_ERROR）。"""
        if self.pain_present and self.pain_level is None:
            raise ValueError("有疼痛时必须填写疼痛等级（1-10）")
        if not self.pain_present and self.pain_level is not None:
            raise ValueError("无疼痛时疼痛等级必须为空（存 NULL，不存 0）")
        return self


class DailyRecordOut(BaseModel):
    """每日详情响应（经期四件套；#14 起不再携带 mood_note，日记走 /daily-journal）。
    导出/预览路径单独构造行，不携带 mood_tags（仅本机存储）。"""
    id: int
    record_date: date
    pain_present: bool = False
    pain_level: Optional[int] = None
    flow_level: int
    mood_level: int
    mood_tags: list[str] = Field(default_factory=list)
    created_at: Optional[str] = None
    updated_at: Optional[str] = None

    model_config = ConfigDict(from_attributes=True)


# ============================================================
# daily-journal 请求/响应（#14 每日日记，独立渠道）
# ============================================================

class JournalUpsert(BaseModel):
    """PUT /daily-journal/{record_date} 请求。

    note 为 null / 空串 / 纯空白 → 删除当日日记（幂等）；否则原文保存。
    长度按 Unicode 码点计（pydantic max_length 与 Python len 同口径），超过 300 → 422。
    """
    note: Optional[str] = Field(
        None, max_length=config.DAILY_NOTE_MAX_CHARS,
        description="每日日记 ≤300 字（码点），空/null 表示清空",
    )


class JournalOut(BaseModel):
    """日记响应。当日无日记时 id/note/created_at/updated_at 均为 null（单日 GET 恒 200，前端据此显示未记录态）。"""
    id: Optional[int] = None
    record_date: date
    note: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None

    model_config = ConfigDict(from_attributes=True)


# ============================================================
# settings 请求/响应
# ============================================================

class SettingsResponse(BaseModel):
    """GET /settings 响应（R1 设置域空壳化）。

    用户 2026-09-18 裁定：notify_enabled / notify_days / theme 从 API 面彻底消失。
    app_settings 表保留空壳（不删表、不删端点）。本模型刻意无字段——
    序列化结果恰为 {}，不得含 user_id / updated_at / 任何旧字段。
    """
    # 刻意无字段：契约冻结为响应体 {}


class SettingsUpdate(BaseModel):
    """PUT /settings 请求（R1 设置域空壳化）。

    请求体允许空对象 {}；不得因缺字段报 422。
    遗留客户端若仍发送 notify_*/theme 等键，一律忽略、不报错
    （Pydantic v2 默认 extra='ignore'）。
    """
    # 刻意无字段：契约冻结为「允许 {} / 忽略遗留键 / 响应 {}」


# ============================================================
# device 设备级偏好（2026-10-26 Win 端补齐；同日对齐 Android 端点改名
# 旧 desktop 路径 → /device/settings，并扩展经期提醒三件套平台键）
#
# 口径登记（2026-10-26 用户裁定，登记不改行为）：pydantic 默认 lax 模式会接受
# "5"/"true" 等字符串形态（布尔/整数字段的宽松折算），Android 手写解析严格拒绝
# 字符串形态——已知差异，前端重建轮统一收紧。
# ============================================================

class DeviceSettingsRequest(BaseModel):
    """PUT /device/settings 请求（仅更新传入字段，None = 不更新）。

    非法值（theme/close_action 不在 config.DESKTOP_* 枚举、reminder_days 不在
    config.REMINDER_VALID_DAYS 内、reminder_* 布尔键非布尔、提醒时点超出 0-23）→ 422。
    reminder_* 是 **Win 平台键**（Android 侧 /device/settings 只有 theme，不暴露本段；
    Android 的提醒键经设置桥 app_settings.notify_* 键写入、非法回落默认，
    校验面差异与 days 键既有模式一致）。
    """
    theme: Optional[str] = Field(None, description="主题 light|dark|system")
    close_action: Optional[str] = Field(None, description="关闭行为 ask|exit|tray")
    reminder_master: Optional[bool] = Field(None, description="提醒总开关（默认 false，对齐 Android）")
    reminder_advance: Optional[bool] = Field(None, description="提前 N 天提醒开关（默认 false）")
    reminder_on_day: Optional[bool] = Field(None, description="当天提醒开关（默认 false）")
    reminder_overdue: Optional[bool] = Field(None, description="逾期提醒开关（默认 false）")
    reminder_daily_fill: Optional[bool] = Field(None, description="每日填写提醒开关（默认 false）")
    reminder_days: Optional[int] = Field(None, description="提前量 N ∈ {1,2,3,5,7}（默认 3）")
    reminder_trio_hour: Optional[int] = Field(None, description="经期三件套触发整点 0-23（默认 9）")
    reminder_fill_hour: Optional[int] = Field(None, description="每晚填写触发整点 0-23（默认 21）")

    @field_validator("theme")
    @classmethod
    def _check_theme(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and v not in config.DESKTOP_THEMES:
            raise ValueError(
                f"theme 必须是 {'/'.join(config.DESKTOP_THEMES)} 之一")
        return v

    @field_validator("close_action")
    @classmethod
    def _check_close_action(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and v not in config.DESKTOP_CLOSE_ACTIONS:
            raise ValueError(
                f"close_action 必须是 {'/'.join(config.DESKTOP_CLOSE_ACTIONS)} 之一")
        return v

    @field_validator("reminder_days")
    @classmethod
    def _check_reminder_days(cls, v: Optional[int]) -> Optional[int]:
        """提前量白名单（config.REMINDER_VALID_DAYS，与 Android PiqReminderPlan.VALID_DAYS
        同值；如 4 → 422。Android 的提醒开关走宿主桥写入、非法值回落 3，不经 REST——
        键形态是端侧差异，白名单两端同集）。"""
        if v is not None and v not in config.REMINDER_VALID_DAYS:
            raise ValueError(
                f"reminder_days 必须是 {'/'.join(str(d) for d in config.REMINDER_VALID_DAYS)} 之一")
        return v

    @field_validator("reminder_trio_hour", "reminder_fill_hour")
    @classmethod
    def _check_reminder_hours(cls, v: Optional[int]) -> Optional[int]:
        """提醒触发整点范围（0-23；如 24/-1 → 422。Android 桥面非法回落默认，同 days 模式）。"""
        if v is not None and not (config.REMINDER_HOUR_MIN <= v <= config.REMINDER_HOUR_MAX):
            raise ValueError(
                f"提醒时点必须是 {config.REMINDER_HOUR_MIN}-{config.REMINDER_HOUR_MAX} 的整点")
        return v


class DeviceSettingsResponse(BaseModel):
    """GET/PUT /device/settings 响应（各字段恒返回当前生效值，含默认回落后）。

    reminder_daily_fill 为每晚填写开关的当前生效值（与其它 reminder_* 同经本端点读写；
    默认值来源 config.DAILY_NOTIFY_ENABLED）。
    """
    theme: str = config.DESKTOP_THEME_DEFAULT
    close_action: str = config.DESKTOP_CLOSE_ACTION_DEFAULT
    reminder_master: bool = config.REMINDER_MASTER_DEFAULT
    reminder_advance: bool = config.REMINDER_ADVANCE_DEFAULT
    reminder_on_day: bool = config.REMINDER_ON_DAY_DEFAULT
    reminder_overdue: bool = config.REMINDER_OVERDUE_DEFAULT
    reminder_days: int = config.REMINDER_DAYS_DEFAULT
    reminder_trio_hour: int = config.REMINDER_TRIGGER_HOUR
    reminder_fill_hour: int = config.DAILY_NOTIFY_HOUR
    reminder_daily_fill: bool = config.DAILY_NOTIFY_ENABLED


# ============================================================
# export/import
# ============================================================

class ExportResponse(BaseModel):
    """GET /export 响应。

    截断口径（v0.13.0 修 F26 引入字段；v0.14.0 修 CN-3 收敛上限来源；
    2026-10-31 修 #33/#35 统一「取最新」）：
    - 三类列表均在**各自升序全量列表**上取末尾 N 条（列表本身仍升序输出）：
      cycles 取 period_start ASC, id ASC 末尾 MAX_EXPORT_CYCLES 条；
      predictions 取规范序（predicted_date → created_at → id ASC）末尾
      MAX_EXPORT_PREDICTIONS 条；daily_records 取 record_date 升序末尾
      MAX_EXPORT_DAILY_RECORDS 条。旧实现取最早 N 条、丢最新数据，已废止。
    - <类>_total 是库内**实际总条数**（未截断时的真值）；
    - <类>_truncated = total > 对应上限，为 True 表示列表被截断、导出文件不完整
      （前端须提示用户）。
    - **不变量**：三类导出上限均须 <= 对应导入上限（MAX_EXPORT_CYCLES <=
      MAX_IMPORT_CYCLES、MAX_EXPORT_PREDICTIONS <= MAX_IMPORT_PREDICTIONS、
      MAX_EXPORT_DAILY_RECORDS <= MAX_IMPORT_DAILY_RECORDS），否则「导出 → 导入」
      往返会因超限被 422 拒绝（不变量登记见 settings.export_data）。
      注意 /export/preview 不截断，cycles > MAX_IMPORT_CYCLES 时预览可看、
      但导入必 422（前端重建轮需提示/截断）。
    R1 设置域空壳化：app_settings 键保留、类型注解保留，运行时值恒为 {}。
    cycles 按 period_start ASC, id ASC 升序（修 #25 导出排序契约，与
    /export/preview 一致）。
    """
    cycles: list[dict] = []
    predictions: list[dict] = []
    model_params: dict
    app_settings: dict
    exported_at: str
    # 2026-10-31 修 #35：cycles 同款截断自描述（取最新 MAX_EXPORT_CYCLES 条）
    cycles_total: int = 0
    cycles_truncated: bool = False
    # v0.13.0 修 F26：导出截断自描述——predictions 上限 config.MAX_EXPORT_PREDICTIONS 条，
    # 超出部分不导出，用这两个字段明示总量与截断，避免静默丢数据。
    predictions_total: int = 0
    predictions_truncated: bool = False
    # 2026-10-26：daily_records 同款截断口径（上限 MAX_EXPORT_DAILY_RECORDS）；
    # 行内**不含 mood_note / mood_tags**（仅本地存储，绝不导出）。
    daily_records: list[dict] = []
    daily_records_total: int = 0
    daily_records_truncated: bool = False


class ImportRequest(BaseModel):
    """POST /import 请求。

    v0.9.0 修 P3：新增 predictions——导出文件中的历史预测（含 actual_date/error_days
    精度历史）在导入时完整还原；旧文件（无 predictions 键）仍可导入，行为向后兼容。
    v0.13.1 修 G6：新增条数上限（config.MAX_IMPORT_*）——导入是清空重建型单事务
    逐条插入，超大导入会长期持有写锁；超限 → 422 VALIDATION_ERROR 扁平契约。
    R1 设置域空壳化：app_settings 键保留（Optional[dict]）；内部键（含
    notify_enabled/notify_days/theme 及任何其他键）一律静默忽略、绝不报错——
    用户已有导出文件带着旧键，继续严格校验会把旧备份永久锁死（导入必 400）。
    R2-A：allow_anomalies=false（默认）时命中 G1-G5 门禁 → 400 DATA_ANOMALY
    （响应含 anomalies 列表）；=true 时门禁只提示、不阻断，走既有导入管线。
    2026-10-31 修 #23：daily_records 的**字段类型与默认值刻意保持不变**
    （list[dict] = []，不是 Optional）——字段默认值本身无法区分「键缺省」与「显式 []」，
    覆盖语义由路由层按 model_fields_set 判定：键缺省 → 保留库内既有每日详情
    （不清空）；显式 [] → 清空；非空数组 → 清空重建。显式 JSON null 仍 422。
    2026-10-31 修 #35：cycles[] 支持 created_at 还原——字符串且 ≤32 字符、不含控制
    字符 → 原样落库；非字符串（如 123）/空串/缺键 → 导入时刻（UTC
    "YYYY-MM-DD HH:MM:SS"）；超长或含控制字符 → 400 INVALID_IMPORT
    （规则复用 _validate_created_at，与 predictions/daily_records 同款）。
    """
    cycles: list[dict] = []
    predictions: list[dict] = []
    model_params: Optional[dict] = None
    app_settings: Optional[dict] = None
    allow_anomalies: bool = False
    # 2026-10-26：可选 daily_records（旧备份无此键 → 路由层保留既有每日详情，不再按空列表清空）。
    # 导入还原历史：不受补填窗口/来潮日限制，结构校验照走；行内 note 一律静默忽略。
    # 2026-10-31 修 #23：默认值 [] 仅供类型/上限校验；是否覆盖库内每日详情由路由层
    # 按「请求体是否携带本键」决定——缺键保留既有数据（不再删光），显式 [] 才清空，
    # 非空数组清空后重建。显式 null 仍由本字段的非 Optional 类型 422 拒绝。
    daily_records: list[dict] = []

    @field_validator("cycles")
    @classmethod
    def _cap_cycles(cls, v: list[dict]) -> list[dict]:
        if len(v) > config.MAX_IMPORT_CYCLES:
            raise ValueError(f"cycles 超出导入上限（{config.MAX_IMPORT_CYCLES} 条）")
        return v

    @field_validator("predictions")
    @classmethod
    def _cap_predictions(cls, v: list[dict]) -> list[dict]:
        if len(v) > config.MAX_IMPORT_PREDICTIONS:
            raise ValueError(f"predictions 超出导入上限（{config.MAX_IMPORT_PREDICTIONS} 条）")
        return v

    @field_validator("daily_records")
    @classmethod
    def _cap_daily_records(cls, v: list[dict]) -> list[dict]:
        if len(v) > config.MAX_IMPORT_DAILY_RECORDS:
            raise ValueError(f"daily_records 超出导入上限（{config.MAX_IMPORT_DAILY_RECORDS} 条）")
        return v


class ImportResponse(BaseModel):
    """POST /import 响应。"""
    imported_cycles: int
    imported_predictions: int
    imported_daily_records: int = 0
    message: str


# ============================================================
# PeriodIQ：导出预览 / 备份列表（冻结契约）
# ============================================================

class ExportPreviewResponse(BaseModel):
    """GET /export/preview 响应。

    cycles 与 GET /cycles 同形；顺序为 period_start ASC, id ASC（见 #25 导出排序
    契约）；prediction 为当前预测或 null；
    model 供「算法与权重」面板（字段取自 predict_core / model_params，不重写算法）。
    """
    cycles: list[dict] = []
    prediction: Optional[dict] = None
    model: dict


class BackupItem(BaseModel):
    """备份文件列表项（只读元数据，不提供下载/恢复）。"""
    name: str
    size: int
    mtime: float


class BackupsResponse(BaseModel):
    """GET /backups 响应。dir 为备份目录绝对路径；items 按文件名排序。

    R29 新增：dir_source（env|custom|default）标明解析来源；
    custom_dir 为持久化自定义值（无则 null）。
    """
    dir: str
    items: list[BackupItem] = []
    dir_source: str = "default"
    custom_dir: Optional[str] = None


class BackupDirUpdateRequest(BaseModel):
    """PUT /backups/dir 请求。dir 与 reset 互斥：给 dir 则设置自定义，reset=true 则清除。"""
    dir: Optional[str] = None
    reset: bool = False

    @model_validator(mode="after")
    def _reject_dir_reset_conflict(self) -> "BackupDirUpdateRequest":
        """dir 与 reset=true 互斥强制（审计第二批 P3）。

        旧实现 reset 优先、静默忽略 dir，与 docstring「互斥」声明不符（客户端逻辑
        错误被无声吞掉）。改为同时提供 → 422 VALIDATION_ERROR（中文文案，
        与 CycleUpdate 的 clear_period_end 互斥校验同款 pydantic v2 model_validator）。
        """
        if self.reset and self.dir is not None:
            raise ValueError("dir 与 reset=true 不能同时提供")
        return self


class BackupDirUpdateResponse(BaseModel):
    """PUT /backups/dir 响应（与 GET 同结构，便于前端直接刷新）。"""
    dir: str
    dir_source: str
    custom_dir: Optional[str] = None


# ============================================================
# 认证与用户（v0.11.0 用户管理，早期设计文档）
# （v0.12.0 死代码清理：删除无任何引用的 ErrorResponse——错误契约由
#  main.py 全局异常处理器直接产出 JSON，不需要响应模型占位）
# ============================================================

# v0.13.1 修 G12：新口令强度校验（注册与改密共用）。
# 黑名单为常见弱口令的精确匹配小集合（不引入外部依赖）；登录不校验强度——
# 存量 6-7 位口令（旧契约 ≥6）仍可登录，仅新设口令按新策略约束。
_WEAK_PASSWORDS = frozenset({
    "12345678", "123456789", "1234567890", "password", "password1",
    "qwerty123", "qwertyuiop", "11111111", "00000000", "abc12345",
    "iloveyou", "admin123", "welcome1", "letmein1", "monkey123",
    "dragon123", "sunshine", "princess", "football", "abcd1234",
})


def validate_new_password(v: str) -> str:
    """新口令强度校验（注册 / 改密共用；触发 ValueError → 422 VALIDATION_ERROR）。"""
    if v.lower() in _WEAK_PASSWORDS:
        raise ValueError("口令过于常见，请更换更复杂的口令")
    if len(set(v)) == 1:
        raise ValueError("口令不能为同一字符的重复")
    return v


class RegisterRequest(BaseModel):
    """注册请求（POST /auth/register）。

    v0.13.1 修 G12：口令最小长度 6→8（OWASP 最低建议）+ 弱口令黑名单/全同字符拒绝。
    仅约束新注册；存量口令登录不受影响（LoginRequest 不校验强度）。
    """
    username: str = Field(..., min_length=3, max_length=32, description="用户名 3-32 位")
    password: str = Field(..., min_length=8, max_length=128, description="口令 ≥8 位")
    nickname: Optional[str] = Field(None, max_length=24, description="昵称，可选")

    @field_validator("username")
    @classmethod
    def validate_username(cls, v: str) -> str:
        import re
        if not re.fullmatch(r"[A-Za-z0-9_-]+", v):
            raise ValueError("用户名仅允许字母、数字、下划线与连字符")
        return v

    @field_validator("password")
    @classmethod
    def validate_password(cls, v: str) -> str:
        return validate_new_password(v)


class LoginRequest(BaseModel):
    """登录请求（POST /auth/login）。

    2026-10-26 登录持久化（两端同轮对齐 Android）：keep_logged_in=true ⇒
    ① 会话 expires_at 写 NULL（永不登出，替代旧 365 天口径）；② 服务端把
    {username, password} 经 DPAPI 加密固化到本机持久化槽（固化失败降级普通
    30 天会话，登录照常成功）。false（缺省）⇒ 照旧 30 天会话，不动槽。
    槽的查询/开关/恢复走 /auth/persistence 与 /auth/relogin（两端同契约）。
    """
    username: str = Field(..., min_length=1, max_length=32)
    password: str = Field(..., min_length=1, max_length=128)
    keep_logged_in: bool = Field(
        False, description="保持登录：true ⇒ 会话永不登出（expires_at NULL）并固化本机槽"
    )


class AuthUserResponse(BaseModel):
    """用户信息（登录/注册/me 响应的 user 字段）。"""
    id: int
    username: str
    nickname: Optional[str] = None
    avatar: Optional[str] = None
    birthday: Optional[str] = None
    weight_kg: Optional[float] = None
    age: Optional[int] = Field(None, description="由生日推算（后端计算，诚实展示）")
    created_at: Optional[str] = None


class AuthResponse(BaseModel):
    """登录/注册成功响应。"""
    token: str
    user: AuthUserResponse


class PersistenceEnableRequest(BaseModel):
    """开启「保持登录」请求（POST /auth/persistence）。

    password 必填（缺失/空 → 422 VALIDATION_ERROR）：复核身份 + 作为固化值。
    口令错 → 400 WRONG_PASSWORD（与 change-password 同码同文案）。
    """
    password: str = Field(..., min_length=1, max_length=128)


class PersistenceStatusResponse(BaseModel):
    """GET/POST/DELETE /auth/persistence 响应。

    enabled = 本机槽存在且槽内 username == 当前登录用户名（绝不返回口令本身）。
    """
    enabled: bool


class ProfileUpdate(BaseModel):
    """资料更新请求（PUT /auth/profile，仅更新传入字段）。"""
    nickname: Optional[str] = Field(None, max_length=24)
    avatar: Optional[str] = Field(None, description="data:image/png|jpeg|webp;base64（≤300KB）")
    # 审计第二批 P3：生日不得晚于今天（schema 层校验；两端统一 422
    # VALIDATION_ERROR + field=birthday；register 不含 birthday，无需同款）。
    birthday: Optional[date] = None
    weight_kg: Optional[float] = Field(None, ge=25, le=300)
    clear_birthday: bool = Field(False, description="显式清空生日")
    clear_weight: bool = Field(False, description="显式清空体重")

    @field_validator("birthday")
    @classmethod
    def _check_birthday_not_future(cls, v: Optional[date]) -> Optional[date]:
        """生日晚于今天 → 422（None = 不更新/清空，直通，不触发校验）。"""
        if v is not None and v > date.today():
            raise ValueError("生日不能晚于今天")
        return v


class ChangePasswordRequest(BaseModel):
    """改密请求（POST /auth/change-password，v0.13.1 修 G5 新增）。

    old_password 仅作身份复核（不校验强度——复核的是存量口令）；
    new_password 与注册同强度策略（validate_new_password）。
    """
    old_password: str = Field(..., min_length=1, max_length=128)
    new_password: str = Field(..., min_length=8, max_length=128)

    @field_validator("new_password")
    @classmethod
    def validate_new_password(cls, v: str) -> str:
        return validate_new_password(v)


class DeleteAccountRequest(BaseModel):
    """删号确认请求（POST /auth/delete-account，v0.13.1 修 G5 新增）。

    口令复核防误删/防偷跑（删除不可恢复，必须二次确认）。
    用 POST + 请求体而非 DELETE + body：避免任何中间层对 DELETE body 的兼容性边角。
    """
    password: str = Field(..., min_length=1, max_length=128)
