package io.github.yui0818.periodiq

import io.github.yui0818.periodiq.domain.model.PredictionBackfillRow
import io.github.yui0818.periodiq.domain.model.PredictionActualBackfill
import java.time.LocalDate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `PredictionActualBackfill` 的 JVM 哨兵：钉住与 Win
 * `prediction_service.rebackfill_prediction_actuals` 同一条口径
 * （锚点 = predicted 严格之前最后一条 start；actual = 第一条 start >= predicted；
 * 无锚点/无后继保持原值；值不变不写；重复 plan 幂等）。
 */
class PredictionActualBackfillTest {

    private val starts = listOf("2026-01-01", "2026-01-29", "2026-02-27").map(LocalDate::parse)

    private fun row(
        id: Long,
        predicted: String,
        actual: String? = null,
        errorDays: Long? = null,
    ): PredictionBackfillRow =
        PredictionBackfillRow(id, LocalDate.parse(predicted), actual, errorDays)

    @Test
    fun `正常回填 actual 与 error_days`() {
        val updates = PredictionActualBackfill.plan(
            starts,
            listOf(row(1, "2026-01-29"), row(2, "2026-02-01")),
        )
        assertEquals(2, updates.size)
        assertEquals(1L, updates[0].predictionId)
        assertEquals("2026-01-29", updates[0].actualDate)
        assertEquals(0L, updates[0].errorDays)
        assertEquals(2L, updates[1].predictionId)
        assertEquals("2026-02-27", updates[1].actualDate)
        assertEquals(26L, updates[1].errorDays)
    }

    @Test
    fun `文件原值不一致时被修正`() {
        val updates = PredictionActualBackfill.plan(
            starts,
            listOf(row(3, "2026-01-29", actual = "2026-01-20", errorDays = 9)),
        )
        assertEquals(1, updates.size)
        assertEquals("2026-01-29", updates.single().actualDate)
        assertEquals(0L, updates.single().errorDays)
    }

    @Test
    fun `预测日恰为记录日时取该记录且误差为零`() {
        val updates = PredictionActualBackfill.plan(starts, listOf(row(4, "2026-02-27")))
        assertEquals("2026-02-27", updates.single().actualDate)
        assertEquals(0L, updates.single().errorDays)
    }

    @Test
    fun `无后继记录保持原值不写`() {
        val updates = PredictionActualBackfill.plan(
            starts,
            listOf(row(5, "2026-03-10", actual = "2026-03-01", errorDays = 9)),
        )
        assertTrue(updates.isEmpty())
    }

    @Test
    fun `无锚点保持原值不写`() {
        val updates = PredictionActualBackfill.plan(
            starts,
            listOf(row(6, "2025-12-20", actual = "2025-12-25", errorDays = 5)),
        )
        assertTrue(updates.isEmpty())
    }

    @Test
    fun `空 starts 不产出更新`() {
        val updates = PredictionActualBackfill.plan(
            emptyList(),
            listOf(row(7, "2026-01-29", actual = "2026-01-29", errorDays = 0)),
        )
        assertTrue(updates.isEmpty())
    }

    @Test
    fun `值不变不产出更新`() {
        val updates = PredictionActualBackfill.plan(
            starts,
            listOf(row(8, "2026-02-01", actual = "2026-02-27", errorDays = 26)),
        )
        assertTrue(updates.isEmpty())
    }

    @Test
    fun `应用更新后再 plan 为空（幂等）`() {
        val rows = listOf(
            row(9, "2026-01-29", actual = "2026-01-20", errorDays = 9),
            row(10, "2026-02-01"),
            row(11, "2026-03-10", actual = "2026-03-01", errorDays = 9),
        )
        val first = PredictionActualBackfill.plan(starts, rows)
        assertEquals(2, first.size)
        val applied = rows.map { current ->
            val update = first.firstOrNull { it.predictionId == current.predictionId }
            if (update == null) current
            else current.copy(currentActualDate = update.actualDate, currentErrorDays = update.errorDays)
        }
        assertTrue(PredictionActualBackfill.plan(starts, applied).isEmpty())
    }
}
