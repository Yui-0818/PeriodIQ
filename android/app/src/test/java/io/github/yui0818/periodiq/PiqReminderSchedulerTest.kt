package io.github.yui0818.periodiq

import java.time.LocalDate
import java.time.ZoneId
import java.time.ZonedDateTime
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

/**
 * 调度层 epoch 计算的 JVM 单测（Android 收尾轮 R2-4 的根因回归钉）。
 *
 * 根因：计划层按 `reminder_trio_hour` / `reminder_fill_hour` 算出了 `triggerEpochMillis`，
 * 调度层却固定用 9:00 / 21:00 常量重算 ⇒ 设置 22 点也会在 21 点响。
 * 这里逐值断言 [reminderEpochMillis] **使用传入的设置整点**，且按目标本地日 + 时区重算。
 */
class PiqReminderSchedulerTest {

    private val zone: ZoneId = ZoneId.of("Asia/Shanghai")

    private fun alarm(
        notifyId: Int,
        date: LocalDate = LocalDate.of(2026, 11, 6),
        triggerEpochMillis: Long = 0L,
    ): PiqReminderPlan.Alarm = PiqReminderPlan.Alarm(
        notifyId = notifyId,
        requestCode = 99,
        triggerDate = date,
        zoneId = zone.id,
        triggerEpochMillis = triggerEpochMillis,
        title = "t",
        body = "b",
    )

    private fun epochAt(date: LocalDate, hour: Int, z: ZoneId = zone): Long =
        ZonedDateTime.of(date.year, date.monthValue, date.dayOfMonth, hour, 0, 0, 0, z)
            .toInstant()
            .toEpochMilli()

    @Test
    fun `预测三腿一律使用设置里的 trioHour`() {
        val date = LocalDate.of(2026, 11, 6)
        val ids = listOf(
            PiqReminderPlan.NOTIFY_ID_ADVANCE,
            PiqReminderPlan.NOTIFY_ID_ON_DAY,
            PiqReminderPlan.NOTIFY_ID_OVERDUE_FIRST,
            PiqReminderPlan.NOTIFY_ID_OVERDUE_SECOND,
        )
        ids.forEach { id ->
            assertEquals(
                "notifyId=$id 应按 trioHour=15 挂 15:00",
                epochAt(date, 15),
                reminderEpochMillis(alarm(id, date), trioHour = 15, fillHour = 22, zone = zone),
            )
        }
    }

    @Test
    fun `每日填写腿使用设置里的 fillHour`() {
        val date = LocalDate.of(2026, 11, 6)
        assertEquals(
            epochAt(date, 22),
            reminderEpochMillis(
                alarm(PiqReminderPlan.NOTIFY_ID_DAILY_FILL, date),
                trioHour = 9,
                fillHour = 22,
                zone = zone,
            ),
        )
    }

    @Test
    fun `落盘里的旧 triggerEpochMillis 不会被盲目复用`() {
        val date = LocalDate.of(2026, 11, 6)
        // 计划层算的是旧的 09:00；用户随后把 trioHour 改成 22
        val stale = alarm(PiqReminderPlan.NOTIFY_ID_ADVANCE, date, triggerEpochMillis = epochAt(date, 9))
        val actual = reminderEpochMillis(stale, trioHour = 22, fillHour = 21, zone = zone)
        assertEquals(epochAt(date, 22), actual)
        assertNotEquals(stale.triggerEpochMillis, actual)
    }

    @Test
    fun `同一本地日在不同时区重算为各自的本地整点`() {
        val date = LocalDate.of(2026, 11, 6)
        val shanghai = reminderEpochMillis(
            alarm(PiqReminderPlan.NOTIFY_ID_ON_DAY, date),
            trioHour = 15, fillHour = 21, zone = ZoneId.of("Asia/Shanghai"),
        )
        val newYork = reminderEpochMillis(
            alarm(PiqReminderPlan.NOTIFY_ID_ON_DAY, date),
            trioHour = 15, fillHour = 21, zone = ZoneId.of("America/New_York"),
        )
        assertEquals(epochAt(date, 15, ZoneId.of("Asia/Shanghai")), shanghai)
        assertEquals(epochAt(date, 15, ZoneId.of("America/New_York")), newYork)
        assertNotEquals(shanghai, newYork)
    }
}
