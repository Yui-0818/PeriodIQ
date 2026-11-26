/*
 * Copyright (c) 2026 Yui_0818 (aaaj6719@gmail.com)
 * Licensed under the PolyForm Noncommercial License 1.0.0.
 * Commercial use is prohibited without separate written authorization.
 * See LICENSE and COMMERCIAL.md in the repository root.
 */

package io.github.yui0818.periodiq

import java.time.LocalDate
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter

/**
 * 提醒的排程**纯函数层**（R11 · 范围见早期记录；
 * 2026-10-26 增第四类「每日填写」腿）：输入「设置 + 登录态 + 预计开始日 +
 * 今日 note 已填状态 + 此刻」，输出「要挂的闹钟清单 + 每条为什么没挂」。
 *
 * 四类提醒各占一条独立的腿：
 *
 * | 提醒 | 触发时刻（本地） | 通知 id |
 * |---|---|---|
 * | 提前 N 天 | `预计开始日 − N 天` 09:00 | 1 |
 * | 当日 | `预计开始日` 09:00 | 2 |
 * | 逾期 | `预计开始日 + 1 天` 与 `+ 3 天` 09:00（**最多两条**） | 3 / 4 |
 * | 每日填写 | **今天** 21:00（每天检查，今日 note 未填就挂；2026-10-26 用户立项） | 5 |
 *
 * 这一层刻意不碰 `Context` / `AlarmManager` / `NotificationManager` / 数据库，两个理由：
 *  1. "各腿互不连带取消"这种规则必须在 JVM 上逐值钉住，设备侧只能看结果；
 *  2. 发通知那一步不许起 Python、不许碰 WebView（早期记录）⇒ "什么时候发什么文案"
 *     必须在写盘那一刻就算清，落成可以被接收器直接复读的数据。
 *
 * **时刻口径**：预测三腿一律是**该时区当天的 09:00**（不是 UTC，也不是"提前 N×24 小时"），
 * 跨夏令时的 23 / 25 小时间隔由 [triggerAtLocalHour] 交给时区规则决定（哨兵见
 * `PiqReminderPlanTest` 的纽约用例）；每日填写腿是**当天 21:00**（用户裁定，
 * 睡前填写窗口），已过 21:00 则该腿跳过（`daily-time-passed`），次日由任何一次
 * 重排（开 App / 任一 API / 开机）重新挂上。
 */
object PiqReminderPlan {

    /** 三类提醒共用同一个通知渠道。 */
    const val CHANNEL_ID = "periodiq_reminder"

    /** 「提前 N 天」的通知 id（逐字：`1`）。 */
    const val NOTIFY_ID_ADVANCE = 1

    /** 「当日」的通知 id（逐字：`2`）。 */
    const val NOTIFY_ID_ON_DAY = 2

    /** 「逾期 +1 天」的通知 id（逐字：`3`）。 */
    const val NOTIFY_ID_OVERDUE_FIRST = 3

    /** 「逾期 +3 天」的通知 id（逐字：`4`）。 */
    const val NOTIFY_ID_OVERDUE_SECOND = 4

    /**
     * 「每日填写」（2026-10-26 用户立项）的通知 id：`5`。
     *
     * 每晚填写提醒·两端口径（2026-10-26 用户裁定同步契约；Win 同义段见
     * ~\Win\backend\app\services\reminder.py）：默认 21:00 触发（reminder_fill_hour
     * 可调 0-23；三件套 reminder_trio_hour 默认 9）；条件 = 总开关 + 已登录 +
     * 今日 note 未填（每天检查，不看来潮日）；默认关；已填当晚免扰；文案两端同一句
     * （标题 PeriodIQ、正文「睡前一分钟，把今天的感受记下来吧」）；标题/正文/日志不得
     * 含经期字样（隐私）。
     * 平台差异仅两条：① 本端 AlarmManager 闹钟，Win 为进程内 asyncio 任务、仅
     * 运行时有效；② 开关两端同构（总开关+子开关）：本端 SharedPreferences 子键 notify_daily_fill，Win 设备偏好文件键 reminder_daily_fill（config 常量为默认值来源）。
     */
    const val NOTIFY_ID_DAILY_FILL = 5

    /** 每条闹钟各自独立的 `PendingIntent` requestCode：id 与 requestCode 一一对应，互不顶替。 */
    const val REQUEST_CODE_ADVANCE = 11
    const val REQUEST_CODE_ON_DAY = 12
    const val REQUEST_CODE_OVERDUE_FIRST = 13
    const val REQUEST_CODE_OVERDUE_SECOND = 14
    const val REQUEST_CODE_DAILY_FILL = 15

    /** 预测三腿的默认触发时刻：本地当日 09:00（可经设备偏好 reminder_trio_hour 调整）。 */
    const val TRIGGER_HOUR_OF_DAY = 9

    /** 每日填写腿的默认触发时刻：本地当日 21:00（可经设备偏好 reminder_fill_hour 调整）。 */
    const val DAILY_FILL_TRIGGER_HOUR = 21

    /** 提醒触发整点的合法范围（reminder_trio_hour / reminder_fill_hour 共用，两端同值）。 */
    val VALID_HOURS: IntRange = 0..23

    /** 下拉的合法候选（与快照 `js/app.js` 那五个 option 同源）；默认 3 天。 */
    val VALID_DAYS: List<Int> = listOf(1, 2, 3, 5, 7)
    const val DEFAULT_DAYS = 3

    /** 逾期的两个时刻（距预计开始日的天数），上限 = 表长；D+1 一条、D+3 一条，之后不再提醒。 */
    val OVERDUE_DAY_OFFSETS: List<Int> = listOf(1, 3)

    /** 逾期这一类最多挂几条（顾问口径：一天一条会变成骚扰，不许改成每天循环）。 */
    const val MAX_OVERDUE_ALARMS = 2

    /** `plan` 的判定结果里可读的"为什么没排"原因码（进 logcat，也进落盘计划的对照）。 */
    const val SKIP_MASTER_OFF = "master-off"
    const val SKIP_NO_SESSION = "no-session"
    const val SKIP_NO_PREDICTION = "no-prediction"
    const val SKIP_PREDICTED_PAST = "predicted-start-past"
    const val SKIP_ADVANCE_OFF = "advance-off"
    const val SKIP_ON_DAY_OFF = "on-day-off"
    const val SKIP_OVERDUE_OFF = "overdue-off"
    const val SKIP_ADVANCE_TIME_PASSED = "advance-time-passed"
    const val SKIP_ON_DAY_TIME_PASSED = "on-day-time-passed"
    const val SKIP_OVERDUE_TIME_PASSED = "overdue-time-passed"

    /** 每日填写腿的 skip 原因（2026-10-26；进 logcat 与落盘计划对照，不含经期字样；
     *  与 Win services/reminder.py 同构，`no-period-day` 已随「每天检查」口径移除）。 */
    const val SKIP_DAILY_FILL_OFF = "daily-off"
    const val SKIP_DAILY_FILLED = "daily-filled"
    const val SKIP_DAILY_TIME_PASSED = "daily-time-passed"

    /** 调用点给的 N 不在合法集里 ⇒ 回落 [DEFAULT_DAYS]，并把这条写进 skipped。 */
    const val SKIP_DAYS_CLAMPED = "days-clamped"

    /** 通知正文里那个日期的形态：`Nov 6`（与英文 UI 一致；月/日不补零）。 */
    private val DATE_LABEL: DateTimeFormatter = DateTimeFormatter.ofPattern("MMM d")

    /**
     * 设备级设置 + 登录态 + 每日填写腿的一个**运行时事实**（今日 note 是否已填）；
     * `days` 允许是非法值，由 [plan] 回落（见 [normalizeDays]）。该事实不在此层查库——
     * 由调度层（[PiqReminderScheduler.rescheduleNow]）经 [ReminderSource] 取数后
     * copy 进来，保持计划层纯函数可测。
     */
    data class Options(
        val masterEnabled: Boolean,
        val advanceEnabled: Boolean,
        val onDayEnabled: Boolean,
        val overdueEnabled: Boolean,
        val days: Int,
        val loggedIn: Boolean,
        val dailyFillEnabled: Boolean = false,
        val todayDailyNoteFilled: Boolean = false,
        val trioHour: Int = TRIGGER_HOUR_OF_DAY,
        val fillHour: Int = DAILY_FILL_TRIGGER_HOUR,
    )

    /** 一条要挂的闹钟：通知 id、requestCode、本地触发日、时区、绝对时刻、逐字文案。 */
    data class Alarm(
        val notifyId: Int,
        val requestCode: Int,
        val triggerDate: LocalDate,
        val zoneId: String,
        val triggerEpochMillis: Long,
        val title: String,
        val body: String,
    )

    /** 排程结果：要挂的清单 + 每条"为什么没挂"的原因（去重后）。 */
    data class Plan(val alarms: List<Alarm>, val skipped: List<String>)

    /** 设置值 → N：只接受 [VALID_DAYS]，其余（`0`/`4`/`"abc"`/空串/`null`/负数）一律回落 [DEFAULT_DAYS]。 */
    fun normalizeDays(raw: String?): Int =
        raw?.toIntOrNull()?.takeIf { it in VALID_DAYS } ?: DEFAULT_DAYS

    /** 设置值 → 触发整点：只接受 [VALID_HOURS]（0-23），其余（`24`/`-1`/`"abc"`/空串/`null`）一律回落 `default`。 */
    fun normalizeHour(raw: String?, default: Int): Int =
        raw?.toIntOrNull()?.takeIf { it in VALID_HOURS } ?: default

    /**
     * 排程主函数。
     *
     * 规则（2026-10-26 每日填写腿）：
     *  - 总开关关 / 未登录 ⇒ **四条腿全不排**（取消由调用点按 [Alarm] 清单做）；
     *  - **每日填写腿不依赖预测**：只要开、今日 note 未填、未过触发整点 ⇒ 挂当天
     *    该整点（默认 21:00，[Options.fillHour] 可调；「没有预测」只否决预测三腿，不影响本腿；
     *    不看今天是否来潮日——每天检查）；
     *  - 没有预测 ⇒ 预测三腿全不排（skip `no-prediction`）；
     *  - `advanceEnabled` / `onDayEnabled` / `overdueEnabled` **互不影响**：关某一类只少某一类；
     *  - 「预计开始日已过」只否决**提前与当日**两条腿——逾期正是"开始日已过还没记录"那段；
     *  - 某条腿自己算出的时刻已过 ⇒ **只跳过那条**，其余照排；
     *  - 逾期只产出 [OVERDUE_DAY_OFFSETS] 里的两个时刻，条数封顶 [MAX_OVERDUE_ALARMS]。
     */
    fun plan(options: Options, predictedStart: LocalDate?, now: ZonedDateTime): Plan {
        if (!options.masterEnabled) return Plan(emptyList(), listOf(SKIP_MASTER_OFF))
        if (!options.loggedIn) return Plan(emptyList(), listOf(SKIP_NO_SESSION))

        val alarms = mutableListOf<Alarm>()
        val skipped = mutableListOf<String>()

        // ---- 每日填写腿（2026-10-26）：与预测无关，先于 no-prediction 闸门 ----
        when {
            !options.dailyFillEnabled -> skipped += SKIP_DAILY_FILL_OFF
            options.todayDailyNoteFilled -> skipped += SKIP_DAILY_FILLED
            else -> arm(
                alarms, skipped,
                date = now.toLocalDate(),
                zone = now.zone, nowMillis = now.toInstant().toEpochMilli(),
                notifyId = NOTIFY_ID_DAILY_FILL, requestCode = REQUEST_CODE_DAILY_FILL,
                hour = options.fillHour,
                title = dailyFillTitle(), body = dailyFillBody(),
                passedReason = SKIP_DAILY_TIME_PASSED,
            )
        }

        if (predictedStart == null) {
            skipped += SKIP_NO_PREDICTION
            return Plan(alarms, skipped.distinct())
        }

        val days = options.days.takeIf { it in VALID_DAYS } ?: DEFAULT_DAYS
        val clamped = if (days == options.days) emptyList() else listOf(SKIP_DAYS_CLAMPED)
        val zone = now.zone
        val nowMillis = now.toInstant().toEpochMilli()
        val startAlreadyPast = predictedStart.isBefore(now.toLocalDate())

        if (!options.advanceEnabled) {
            skipped += SKIP_ADVANCE_OFF
        } else if (startAlreadyPast) {
            skipped += SKIP_PREDICTED_PAST
        } else {
            arm(
                alarms, skipped,
                date = predictedStart.minusDays(days.toLong()),
                zone = zone, nowMillis = nowMillis,
                notifyId = NOTIFY_ID_ADVANCE, requestCode = REQUEST_CODE_ADVANCE,
                hour = options.trioHour,
                title = advanceTitle(days), body = advanceBody(predictedStart),
                passedReason = SKIP_ADVANCE_TIME_PASSED,
            )
        }

        if (!options.onDayEnabled) {
            skipped += SKIP_ON_DAY_OFF
        } else if (startAlreadyPast) {
            skipped += SKIP_PREDICTED_PAST
        } else {
            arm(
                alarms, skipped,
                date = predictedStart,
                zone = zone, nowMillis = nowMillis,
                notifyId = NOTIFY_ID_ON_DAY, requestCode = REQUEST_CODE_ON_DAY,
                hour = options.trioHour,
                title = onDayTitle(), body = onDayBody(predictedStart),
                passedReason = SKIP_ON_DAY_TIME_PASSED,
            )
        }

        if (!options.overdueEnabled) {
            skipped += SKIP_OVERDUE_OFF
        } else {
            OVERDUE_DAY_OFFSETS.take(MAX_OVERDUE_ALARMS).forEachIndexed { index, offset ->
                arm(
                    alarms, skipped,
                    date = predictedStart.plusDays(offset.toLong()),
                    zone = zone, nowMillis = nowMillis,
                    notifyId = NOTIFY_ID_OVERDUE_FIRST + index,
                    requestCode = REQUEST_CODE_OVERDUE_FIRST + index,
                    hour = options.trioHour,
                    title = overdueTitle(offset), body = overdueBody(),
                    passedReason = SKIP_OVERDUE_TIME_PASSED,
                )
            }
        }

        return Plan(alarms, (clamped + skipped).distinct())
    }

    /** 一条腿的落地：算出本地指定时刻的绝对时刻，没过期就收进清单，过期就记下原因。 */
    private fun arm(
        alarms: MutableList<Alarm>,
        skipped: MutableList<String>,
        date: LocalDate,
        zone: ZoneId,
        nowMillis: Long,
        notifyId: Int,
        requestCode: Int,
        hour: Int = TRIGGER_HOUR_OF_DAY,
        title: String,
        body: String,
        passedReason: String,
    ) {
        val trigger = triggerAtLocalHour(date, hour, zone)
        val epoch = trigger.toInstant().toEpochMilli()
        if (epoch > nowMillis) {
            alarms += Alarm(notifyId, requestCode, date, zone.id, epoch, title, body)
        } else {
            skipped += passedReason
        }
    }

    /** 「提前」的标题与正文（文案集中在 [PiqStrings]，与页面的英文 UI 同语言）。 */
    fun advanceTitle(days: Int): String = PiqStrings.advanceTitle(days)

    fun advanceBody(predictedStart: LocalDate): String =
        PiqStrings.advanceBody(predictedStart.format(DATE_LABEL))

    /** 「当日」的标题与正文。 */
    fun onDayTitle(): String = PiqStrings.onDayTitle()

    fun onDayBody(predictedStart: LocalDate): String =
        PiqStrings.onDayBody(predictedStart.format(DATE_LABEL))

    /** 「逾期」的标题与正文：K 是距预计开始日的天数（1 或 3）。 */
    fun overdueTitle(daysOverdue: Int): String = PiqStrings.overdueTitle(daysOverdue)

    fun overdueBody(): String = PiqStrings.overdueBody()

    /**
     * 「每日填写」的标题与正文（2026-10-26 用户立项）：标题用应用名，正文亲切中性、
     * **不含经期字样**（他人看见锁屏/横幅不尴尬）；文案集中在 [PiqStrings]。
     */
    fun dailyFillTitle(): String = PiqStrings.dailyFillTitle()

    fun dailyFillBody(): String = PiqStrings.dailyFillBody()

    /** 本地日期 + 当日 09:00 → 该时区里的绝对时刻（夏令时按时区规则走，不做固定偏移）。 */
    fun triggerAtLocalNine(date: LocalDate, zone: ZoneId): ZonedDateTime =
        triggerAtLocalHour(date, TRIGGER_HOUR_OF_DAY, zone)

    /** 本地日期 + 当日 `hour` 点 → 该时区里的绝对时刻（triggerAtLocalNine 的泛化，21 点腿共用）。 */
    fun triggerAtLocalHour(date: LocalDate, hour: Int, zone: ZoneId): ZonedDateTime =
        date.atTime(hour, 0).atZone(zone)

    /** 全部已知通知 id（取消那一腿时按 id `NotificationManager.cancel`，落盘复读时也按它过滤）。 */
    val ALL_NOTIFY_IDS: List<Int> = listOf(
        NOTIFY_ID_ADVANCE,
        NOTIFY_ID_ON_DAY,
        NOTIFY_ID_OVERDUE_FIRST,
        NOTIFY_ID_OVERDUE_SECOND,
        NOTIFY_ID_DAILY_FILL,
    )
}
