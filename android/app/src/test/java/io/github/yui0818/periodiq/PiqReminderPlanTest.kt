package io.github.yui0818.periodiq

import java.time.LocalDate
import java.time.ZoneId
import java.time.ZonedDateTime
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `PiqReminderPlan` 的 JVM 单测：钉住两件事
 * ① 五个提醒开关出厂默认全 false（`Options` 的 data class 默认值 + `PiqSettings.NOTIFY_DEFAULTS` 单一来源）；
 * ② 每日填写腿「每天检查、今日 note 未填就挂」——**不再依赖任何来潮事实**，
 *    已填则当晚免扰，子开关关则 daily-off。
 *
 * 时钟固定为 2026-10-29 20:00（Asia/Shanghai）：未过默认 21 点触发点，结果与真实运行日无关。
 */
class PiqReminderPlanTest {

    private val zone: ZoneId = ZoneId.of("Asia/Shanghai")
    private val now: ZonedDateTime = ZonedDateTime.of(2026, 10, 29, 20, 0, 0, 0, zone)
    private val today: LocalDate = now.toLocalDate()

    /** 只打开每日填写腿的最小设置（预测三腿全关，避免预测事实干扰断言）。 */
    private fun options(
        master: Boolean = true,
        dailyFill: Boolean = true,
        noteFilled: Boolean = false,
        loggedIn: Boolean = true,
    ): PiqReminderPlan.Options = PiqReminderPlan.Options(
        masterEnabled = master,
        advanceEnabled = false,
        onDayEnabled = false,
        overdueEnabled = false,
        days = 3,
        loggedIn = loggedIn,
        dailyFillEnabled = dailyFill,
        todayDailyNoteFilled = noteFilled,
    )

    @Test
    fun `Options 默认每日填写关且今日 note 未填`() {
        val defaults = PiqReminderPlan.Options(
            masterEnabled = false,
            advanceEnabled = false,
            onDayEnabled = false,
            overdueEnabled = false,
            days = PiqReminderPlan.DEFAULT_DAYS,
            loggedIn = false,
        )
        assertFalse(defaults.masterEnabled)
        assertFalse(defaults.advanceEnabled)
        assertFalse(defaults.onDayEnabled)
        assertFalse(defaults.overdueEnabled)
        assertFalse(defaults.dailyFillEnabled)
        assertFalse(defaults.todayDailyNoteFilled)
        assertEquals(3, defaults.days)
        assertEquals(9, defaults.trioHour)
        assertEquals(21, defaults.fillHour)
    }

    @Test
    fun `NOTIFY_DEFAULTS 五个开关全为 false`() {
        val defaults = PiqSettings.NOTIFY_DEFAULTS
        assertEquals("false", defaults[PiqSettings.KEY_NOTIFY_ENABLED])
        assertEquals("false", defaults[PiqSettings.KEY_NOTIFY_ADVANCE])
        assertEquals("false", defaults[PiqSettings.KEY_NOTIFY_ON_DAY])
        assertEquals("false", defaults[PiqSettings.KEY_NOTIFY_OVERDUE])
        assertEquals("false", defaults[PiqSettings.KEY_NOTIFY_DAILY_FILL])
        assertEquals("3", defaults[PiqSettings.KEY_NOTIFY_DAYS])
    }

    @Test
    fun `每日填写子开关关时记 daily-off 且不挂`() {
        val plan = PiqReminderPlan.plan(options(dailyFill = false), predictedStart = null, now = now)
        assertTrue(plan.skipped.contains(PiqReminderPlan.SKIP_DAILY_FILL_OFF))
        assertTrue(plan.alarms.none { it.notifyId == PiqReminderPlan.NOTIFY_ID_DAILY_FILL })
    }

    @Test
    fun `非来潮日且 note 未填仍挂当晚填写提醒`() {
        // 入参里没有任何来潮事实：只要今日 note 未填，就该挂当天 21:00 的提醒
        val plan = PiqReminderPlan.plan(options(noteFilled = false), predictedStart = null, now = now)
        val alarm = plan.alarms.singleOrNull { it.notifyId == PiqReminderPlan.NOTIFY_ID_DAILY_FILL }
        assertTrue("应挂每日填写提醒：${plan.alarms}", alarm != null)
        assertEquals(today, alarm!!.triggerDate)
        assertEquals(PiqReminderPlan.REQUEST_CODE_DAILY_FILL, alarm.requestCode)
        assertEquals(PiqReminderPlan.dailyFillTitle(), alarm.title)
        assertEquals(PiqReminderPlan.dailyFillBody(), alarm.body)
        assertEquals(
            ZonedDateTime.of(2026, 10, 29, 21, 0, 0, 0, zone).toInstant().toEpochMilli(),
            alarm.triggerEpochMillis,
        )
        assertFalse(plan.skipped.contains(PiqReminderPlan.SKIP_DAILY_FILL_OFF))
        assertFalse(plan.skipped.contains(PiqReminderPlan.SKIP_DAILY_FILLED))
    }

    @Test
    fun `note 已填则当晚免扰并记 daily-filled`() {
        val plan = PiqReminderPlan.plan(options(noteFilled = true), predictedStart = null, now = now)
        assertTrue(plan.alarms.none { it.notifyId == PiqReminderPlan.NOTIFY_ID_DAILY_FILL })
        assertTrue(plan.skipped.contains(PiqReminderPlan.SKIP_DAILY_FILLED))
    }

    @Test
    fun `已过 21 点只跳过当日填写腿并记 daily-time-passed`() {
        val late = ZonedDateTime.of(2026, 10, 29, 22, 0, 0, 0, zone)
        val plan = PiqReminderPlan.plan(options(noteFilled = false), predictedStart = null, now = late)
        assertTrue(plan.alarms.none { it.notifyId == PiqReminderPlan.NOTIFY_ID_DAILY_FILL })
        assertTrue(plan.skipped.contains(PiqReminderPlan.SKIP_DAILY_TIME_PASSED))
    }

    @Test
    fun `总开关关时四条腿全灭`() {
        val plan = PiqReminderPlan.plan(
            options(master = false, noteFilled = false),
            predictedStart = today.plusDays(3),
            now = now,
        )
        assertTrue(plan.alarms.isEmpty())
        assertEquals(listOf(PiqReminderPlan.SKIP_MASTER_OFF), plan.skipped)
    }
}
