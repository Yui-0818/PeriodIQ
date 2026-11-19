r"""提醒服务（2026-10-26 由每日填写提醒模块改名扩展为四类，语义镜像 Android）。

四类提醒（前三类「经期三件套」+ 每晚填写，与 ~\Android\...\PiqReminderPlan.kt 同语义）：

| 提醒 | 触发时刻（本地） | 条件 |
|---|---|---|
| 提前 N 天 | 预测日 − N 天 09:00 | advance 开且预测日未过 |
| 当日 | 预测日当天 09:00 | on_day 开且预测日未过 |
| 逾期 | 预测日 +1 / +3 天 09:00（各一次） | overdue 开、预测日已过且未记录新开始日 |
| 每晚填写 | 今天 21:00 | 总开关 + 已登录 + 今日 note 未填（每天检查，不看是否来潮日；B1 返工纳入总开关） |

三件套语义逐条镜像 Android（差异仅在机制：Android 是 AlarmManager 闹钟**预挂**，
Win 是到点**现查现判**——[decide_period_trio] 即「该发哪些」的判定纯函数）：
- 总开关关 / 未登录 ⇒ 四腿全灭（master-off / no-session；含每晚填写腿——B1 返工，完全镜像 Android master 闸门）；
- 没有预测 ⇒ 三件套全灭（no-prediction；每晚填写腿不依赖预测）；
- 三条开关互不影响：关某一类只少某一类；
- 「预测日已过」（预测日 < 今天）只否决提前与当日（predicted-start-past）——
  逾期正是「开始日已过还没记录」那段；逾期腿只 +1/+3 两次，绝不逐日循环；
- 「已来潮灭灯」：最新周期开始日 ≥ 预测日（含「今日已有新周期开始日」）⇒
  当天三件套全灭——Android 靠「周期写入即重排」隐式达成，本端以状态判定等价实现；
- N 不在合法集（VALID_DAYS=[1,2,3,5,7]）⇒ 回落默认 3（days-clamped，默认值组
  master=false / advance=false / onDay=false / overdue=false / dailyFill=false 对齐 Android）。

每晚填写·两端口径（2026-10-26 用户裁定同步契约；B1 返工纳入总开关）：默认 21:00
触发（reminder_fill_hour 可调 0-23；三件套 reminder_trio_hour 默认 9）；
条件 = 总开关 + 已登录 + 今日日记未填（**每天检查**：今日 daily_journal 行不存在、
或行存在但 note 去首尾空白后为空，都算未填；不再要求今天必须是来潮日；
#14 起口径从旧 daily_records.mood_note 改为 daily_journal.note）；填写子开关默认
false（默认值来源 config.DAILY_NOTIFY_ENABLED，运行值在设备偏好文件
reminder_daily_fill 键，GET/PUT /api/v1/device/settings 读写）；已填当晚免扰；
skip 原因码与 Android 同构（daily-off / daily-filled / no-session，已无 no-period-day）；
文案两端同一句（标题 PeriodIQ、正文「睡前一分钟，把今天的感受记下来吧」）；
标题/正文/日志不得含经期字样（隐私——三件套文案本身含「经期」字样，与 Android
逐字一致，属用户明确要求的产品文案）。

平台边界（开关层级两端已同构：总开关 + 子开关；仅剩两条差异）：① 运行时边界——
本端进程内 asyncio 任务、**仅应用运行时有效**（不注册系统计划任务/开机项；托盘
驻留 = 运行中，提醒可触发），Android 为 AlarmManager 闹钟；② 存储介质——本端
设备偏好文件（reminder_* 键），Android 为设备级 SharedPreferences。

实现：常驻循环「事件唤醒 + 带超时重读」（2026-10-31 修 #34）——每轮先 clear
唤醒事件、再重读设备偏好、再 `asyncio.wait_for(event.wait(), timeout=到下一个触发
整点的秒数)`（不做每分钟轮询）：
- 超时 = 到点 → 跑对应 tick，继续下一轮；
- 事件被 `wake()` 置位（PUT /device/settings 写盘后调用）= 时点被改 → 立即 continue
  重排（**不 tick**），新时点下一轮即生效（旧实现睡在旧整点，改时点要等整轮过去）。
唤醒事件按**当前 running loop** 懒建（模块级缓存 loop，换 loop 重建），避免同进程
多生命周期/测试复用时报 "bound to a different event loop"；不取消任务、不泄漏
后台 sleep。winotify 的导入与调用全程守护：未安装/系统拒绝等任何失败只
logger.warning，绝不抛出（提醒是增强功能，不能影响主服务）。
"""

import asyncio
import logging
from datetime import date, datetime, timedelta

from app import config
from app.db import crud
from app.routes.device import read_effective_settings

logger = logging.getLogger(__name__)

# ============================================================
# 2026-10-31 修 #34：唤醒事件（时点修改立即重排）
# ============================================================
# asyncio.Event 与事件循环绑定：模块级复用同一个 Event、跨 asyncio.run（测试/嵌入式
# 重启）会抛 "bound to a different event loop"。故缓存「事件 + 其所属 loop」，
# 在 running loop 变化时重建（懒建，导入本模块时不需要 loop）。
_wake_event: asyncio.Event | None = None
_wake_event_loop: asyncio.AbstractEventLoop | None = None

# ---- 通知文案（三件套与 Android PiqReminderPlan 逐字一致；日期形态 `11月6日` 不补零）----

def _date_label(d: date) -> str:
    """Android DateTimeFormatter.ofPattern("M月d日") 的同形态（月/日不补零）。"""
    return f"{d.month}月{d.day}日"

def advance_title(days: int) -> str:
    """「提前」标题（Android advanceTitle 逐字）。"""
    return f"距离预计经期还有 {days} 天"

def advance_body(predicted_start: date) -> str:
    """「提前」正文（Android advanceBody 逐字）。"""
    return f"预计 {_date_label(predicted_start)}开始 · 可在设置里调整提醒"

def on_day_title() -> str:
    """「当日」标题（Android onDayTitle 逐字）。"""
    return "预计今天开始经期"

def on_day_body(predicted_start: date) -> str:
    """「当日」正文（Android onDayBody 逐字）。"""
    return f"预计开始日 {_date_label(predicted_start)} · 打开 App 记录实际情况"

def overdue_title(days_overdue: int) -> str:
    """「逾期」标题（Android overdueTitle 逐字；K = 距预测日天数，1 或 3）。"""
    return f"预计经期已过 {days_overdue} 天"

def overdue_body() -> str:
    """「逾期」正文（Android overdueBody 逐字）。"""
    return "还没有记录这次的开始日 · 打开 App 记一下吧"

# 每晚填写文案（两端同步的原句，维持不变）
DAILY_TITLE = config.PRODUCT_NAME
DAILY_BODY = "睡前一分钟，把今天的感受记下来吧"


def decide_period_trio(
    *,
    logged_in: bool,
    predicted_date: date | None,
    latest_cycle_start: date | None,
    today: date,
    master: bool,
    advance: bool,
    on_day: bool,
    overdue: bool,
    days: int,
) -> tuple[tuple[str, ...], list[str]]:
    """三件套判定纯函数（语义单一来源为 Android PiqReminderPlan.plan，见模块 docstring）。

    输入：登录态、预测日、最新周期开始日、今日、设备级开关组 → 输出 (legs, skips)。
    legs ∈ {advance, on_day, overdue_1, overdue_3}；skip 原因码与 Android 常量逐字同名
    （master-off / no-session / no-prediction / predicted-start-past / advance-off /
    on-day-off / overdue-off / days-clamped），另有一个本端专属 period-arrived
    （已来潮灭灯，见模块 docstring）。判定顺序与 Android plan() 一致：master 先于登录态。
    不碰库、不碰文件、不碰时钟（today 由调用方注入）——可在 %TEMP% 脚本逐值验证。
    """
    if not master:
        return (), ["master-off"]
    if not logged_in:
        return (), ["no-session"]
    if predicted_date is None:
        return (), ["no-prediction"]

    effective_days = days if days in config.REMINDER_VALID_DAYS else config.REMINDER_DAYS_DEFAULT
    skips: list[str] = [] if effective_days == days else ["days-clamped"]

    # 已来潮灭灯：预测日当天或之后已有新周期开始日被记录（含「今日已有新周期开始日」）
    # ⇒ 三件套全灭。Android 靠「周期写入即重排换新预测」隐式达成，本端按状态等价判定。
    if latest_cycle_start is not None and latest_cycle_start >= predicted_date:
        return (), skips + ["period-arrived"]

    legs: list[str] = []
    start_already_past = predicted_date < today  # 「预测日已过且未记录新开始日」= 逾期窗口

    if not advance:
        skips.append("advance-off")
    elif start_already_past:
        skips.append("predicted-start-past")
    elif today == predicted_date - timedelta(days=effective_days):
        legs.append("advance")

    if not on_day:
        skips.append("on-day-off")
    elif start_already_past:
        skips.append("predicted-start-past")
    elif today == predicted_date:
        legs.append("on_day")

    if not overdue:
        skips.append("overdue-off")
    else:
        for offset in config.REMINDER_OVERDUE_DAY_OFFSETS:
            if today == predicted_date + timedelta(days=offset):
                legs.append(f"overdue_{offset}")

    return tuple(legs), skips


def _seconds_until_next(hours: tuple[int, ...], now: datetime | None = None) -> tuple[float, int]:
    """从当前时刻到「下一个 hours 中任意一个整点」的秒数与那个小时（已过今天则取明天）。"""
    now = now or datetime.now()
    candidates: list[tuple[float, int]] = []
    for hour in hours:
        target = now.replace(hour=hour, minute=0, second=0, microsecond=0)
        if target <= now:
            target += timedelta(days=1)
        candidates.append(((target - now).total_seconds(), hour))
    return min(candidates) if candidates else (0.0, hours[0])


def _send_toast(title: str, body: str) -> None:
    """发一条 toast（winotify 导入与调用全程守护，失败只告警不抛）。"""
    try:
        from winotify import Notification, audio  # 延迟导入：未安装时也能启动主服务

        toast = Notification(app_id=config.PRODUCT_NAME, title=title, msg=body)
        toast.set_audio(audio.Silent)
        toast.show()
        logger.info("reminder|toast|shown|title_len=%d|body_len=%d", len(title), len(body))
    except Exception as exc:  # noqa: BLE001 提醒失败不得影响主服务
        logger.warning("reminder|toast|failed|type=%s|message=%s", type(exc).__name__, exc)


def _trio_toast(leg: str, predicted: date, days: int) -> None:
    """腿 id → 对应文案的 toast（文案函数与 Android 逐字一致，见上方）。"""
    if leg == "advance":
        _send_toast(advance_title(days), advance_body(predicted))
    elif leg == "on_day":
        _send_toast(on_day_title(), on_day_body(predicted))
    else:
        offset = int(leg.removeprefix("overdue_"))
        _send_toast(overdue_title(offset), overdue_body())


def _parse_day(value: str | None) -> date | None:
    if not value:
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        return None


async def _notify_trio_users() -> None:
    """09:00 三件套 tick：对每个已登录用户按 [decide_period_trio] 判定并发 toast。

    skip 观测与 Android 同套原因码，每 tick 汇总一行；单用户异常计入 failed，
    不阻断其余用户（与每晚填写腿同纪律）。master 关 = 全体跳过（master-off）。
    """
    settings = read_effective_settings()
    master = settings["reminder_master"]
    if not master:
        logger.info("reminder-trio|tick-summary|users=0|notified=0|reason=master-off")
        return
    today = date.today()
    try:
        user_ids = await crud.get_active_session_user_ids()
    except Exception as exc:  # noqa: BLE001 查库失败只告警，等待下一轮
        logger.warning("reminder-trio|query-users|failed|type=%s|message=%s",
                       type(exc).__name__, exc)
        return
    counts = {"notified": 0, "skip": 0, "failed": 0}
    skip_reasons: list[str] = []
    for uid in user_ids:
        try:
            pred_row = await crud.get_latest_prediction(uid)
            predicted = _parse_day(pred_row.get("predicted_date") if pred_row else None)
            cycle_row = await crud.get_latest_cycle(uid)
            latest_start = _parse_day(cycle_row.get("period_start") if cycle_row else None)
            legs, skips = decide_period_trio(
                logged_in=True,
                predicted_date=predicted,
                latest_cycle_start=latest_start,
                today=today,
                master=master,
                advance=settings["reminder_advance"],
                on_day=settings["reminder_on_day"],
                overdue=settings["reminder_overdue"],
                days=settings["reminder_days"],
            )
            if not legs:
                counts["skip"] += 1
                skip_reasons.extend(skips)
                continue
            for leg in legs:
                _trio_toast(leg, predicted, settings["reminder_days"])
            counts["notified"] += len(legs)
        except Exception as exc:  # noqa: BLE001 单用户失败不阻断其余用户
            counts["failed"] += 1
            logger.warning("reminder-trio|user=%d|failed|type=%s|message=%s",
                           uid, type(exc).__name__, exc)
    summary = (
        f"reminder-trio|tick-summary|users={len(user_ids)}"
        f"|notified={counts['notified']}|skip={counts['skip']}|failed={counts['failed']}"
    )
    if not user_ids:
        summary += "|reason=no-session"
    if skip_reasons:
        summary += f"|skips={sorted(set(skip_reasons))}"
    logger.info(summary)


async def _notify_daily_fill_users() -> None:
    """21:00 每晚填写 tick（2026-10-26 立项并入；B1 返工纳入总开关；后改「每天检查」口径）。

    对每个已登录用户：今日 note 未填 ⇒ toast（单用户异常不影响其余用户）。
    「未填」= 没有今日 daily_journal 行，或行存在但 note 去首尾空白后为空
    （判定单一来源 [crud.has_daily_note]）；**不再要求今天必须是来潮日**——每天检查。
    总开关关 ⇒ 0 toast（master-off，与 9:00 腿及 Android「master 关 ⇒ 四腿全灭」
    同语义）；skip 原因码与 Android 同套：daily-filled（今日 note 已填，当晚免扰）；
    no-session = 本 tick 无任何有效会话用户；daily-off 对应 reminder_daily_fill=false（起点已记）。
    """
    settings = read_effective_settings()
    if not settings["reminder_master"]:
        logger.info("reminder-daily|tick-summary|users=0|notified=0|reason=master-off")
        return
    if not settings["reminder_daily_fill"]:
        logger.info("reminder-daily|tick-summary|users=0|notified=0|reason=daily-off")
        return
    today = date.today().isoformat()
    try:
        user_ids = await crud.get_active_session_user_ids()
    except Exception as exc:  # noqa: BLE001 查库失败只告警，等待下一轮
        logger.warning("reminder-daily|query-users|failed|type=%s|message=%s",
                       type(exc).__name__, exc)
        return
    counts = {"notified": 0, "daily-filled": 0, "failed": 0}
    for uid in user_ids:
        try:
            if await crud.has_daily_note(uid, today):
                counts["daily-filled"] += 1
                continue
            _send_toast(DAILY_TITLE, DAILY_BODY)
            counts["notified"] += 1
        except Exception as exc:  # noqa: BLE001 单用户失败不阻断其余用户
            counts["failed"] += 1
            logger.warning("reminder-daily|user=%d|failed|type=%s|message=%s",
                           uid, type(exc).__name__, exc)
    summary = (
        f"reminder-daily|tick-summary|users={len(user_ids)}"
        f"|notified={counts['notified']}|daily-filled={counts['daily-filled']}"
        f"|failed={counts['failed']}"
    )
    if not user_ids:
        summary += "|reason=no-session"
    logger.info(summary)


def _get_wake_event() -> asyncio.Event:
    """取**当前 running loop** 的唤醒事件（懒建；loop 变了就重建并弃用旧事件）。

    必须在有 running loop 的协程/回调里调用（[wake] 内部已兜住无 loop 的情形）。
    """
    global _wake_event, _wake_event_loop
    loop = asyncio.get_running_loop()
    if _wake_event is None or _wake_event_loop is not loop:
        _wake_event = asyncio.Event()
        _wake_event_loop = loop
    return _wake_event


def wake() -> None:
    """通知提醒循环立即重排（PUT /device/settings 写盘后调用；修 #34）。

    只置位事件：不取消任务、不重建 task、不启新 sleep——run() 里的
    asyncio.wait_for(event.wait()) 立即返回并 continue 重读设置、按新时点重排。
    无 running loop（提醒任务未启动 / 进程正在退出）时静默返回：提醒是增强功能，
    绝不能让设置写入因唤醒失败而报错。
    """
    try:
        event = _get_wake_event()
    except RuntimeError:  # 无 running loop
        logger.debug("reminder|wake|ignored|reason=no-running-loop")
        return
    event.set()


async def run() -> None:
    """常驻循环：等下一个触发整点（三件套/每晚填写，时点经设备偏好
    reminder_trio_hour / reminder_fill_hour 可调，默认 9/21）触发对应 tick
    （main.py lifespan 启停；仅应用运行时有效，见模块 docstring 平台边界）。

    2026-10-31 修 #34：等待改为「事件唤醒 + 带超时重读」。每轮顺序固定：
    clear 事件 → 读设置 → `asyncio.wait_for(event.wait(), timeout=delay)`。
    - 超时（到点）→ 按排睡时捕获的时点跑 tick；
    - 被 wake() 置位 → continue 重排（**不 tick**，时点已变，旧时点不应再触发）；
    - 先 clear 再读设置：读设置期间发生的 wake 会被下一轮读到（设置值是最新的），
      不会丢失；读设置之后的 wake 立刻结束 wait_for。
    """
    logger.info(
        "reminder|started|default_trio_hour=%d|default_daily_hour=%d|runtime_only=true",
        config.REMINDER_TRIGGER_HOUR, config.DAILY_NOTIFY_HOUR,
    )
    wake_event = _get_wake_event()
    while True:
        # 先 clear：避免上一轮遗留的置位把本轮等待直接短路成空转
        wake_event.clear()
        # 每轮重读设置：改完时点后 wake() 即重排（旧实现要睡过旧整点才生效）；
        # 本轮 tick 按排睡时捕获的时点分派，两时点相同则两个 tick 都跑。
        settings = read_effective_settings()
        trio_hour = settings["reminder_trio_hour"]
        fill_hour = settings["reminder_fill_hour"]
        delay, hour = _seconds_until_next((trio_hour, fill_hour))
        try:
            await asyncio.wait_for(wake_event.wait(), timeout=delay)
        except asyncio.TimeoutError:
            pass  # 正常到点：走下面的 tick
        else:
            # 时点被改：立即重排，不 tick（wait_for 已清理内部等待任务，无泄漏）
            logger.info("reminder|wake|reschedule|remaining_before_wake=%.0f", delay)
            continue
        logger.info("reminder|tick|hour=%d", hour)
        if hour == trio_hour:
            await _notify_trio_users()
        if hour == fill_hour:
            await _notify_daily_fill_users()
