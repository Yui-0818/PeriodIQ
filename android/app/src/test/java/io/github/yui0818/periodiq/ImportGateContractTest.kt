package io.github.yui0818.periodiq

import io.github.yui0818.periodiq.api.contract.ApiError
import io.github.yui0818.periodiq.domain.import.ImportGate
import java.time.LocalDate
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 导入契约的 JVM 哨兵（2026-10-31）：
 * - #26 导入时间戳只认 JSON 字符串（非字符串 → 导入时刻，超长/控制字符 → 400 INVALID_IMPORT）；
 * - #31 daily_records 的键存在性语义（缺键保留 / 显式 [] 清空 / 显式 null 422）；
 * - #32 G3/G4 基线只用待导入数据自身派生（[ImportGate.baselineCycleLengths]）。
 *
 * 期望值按 Win 侧 gate.py 的口径计算；同类用例在 Win 隔离库脚本（%TEMP%\piq_verify_3235.py）
 * 与本次 JVM 用例中分别验证；两端文案逐字一致。
 * 只跑纯函数，不碰 Android SQLite。
 */
class ImportGateContractTest {

    private val today: LocalDate = LocalDate.of(2026, 10, 31)

    private fun expectApiError(block: () -> Unit): ApiError {
        try {
            block()
        } catch (e: ApiError) {
            return e
        }
        throw AssertionError("应抛 ApiError，但没有抛")
    }

    private fun indexed(vararg rows: JSONObject): List<Pair<Int, JSONObject>> =
        rows.mapIndexed { i, row -> i to row }

    private fun plusDays(start: String, days: Long): String =
        LocalDate.parse(start).plusDays(days).toString()

    private fun cycleAt(start: String, end: String? = null, cycleLength: Int? = null): JSONObject {
        val row = JSONObject().put("period_start", start)
        if (end != null) row.put("period_end", end)
        if (cycleLength != null) row.put("cycle_length", cycleLength)
        return row
    }

    private fun codesOf(anomalies: JSONArray): List<String> =
        (0 until anomalies.length()).map { anomalies.getJSONObject(it).getString("code") }

    private fun valuesOf(anomalies: JSONArray): List<Double> =
        (0 until anomalies.length()).map { anomalies.getJSONObject(it).getDouble("value") }

    private fun evaluate(rows: List<JSONObject>): JSONArray {
        val indexedRows = rows.mapIndexed { i, row -> i to row }
        return ImportGate.evaluate(indexedRows, ImportGate.baselineCycleLengths(indexedRows), today)
    }

    // ============================================================
    // #26 导入时间戳
    // ============================================================

    @Test
    fun `非字符串 created_at 一律按导入时刻兜底`() {
        val day = LocalDate.of(2026, 1, 1)
        val pattern = Regex("^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}$")
        val nonStrings = listOf<Any>(
            123,
            45.5,
            true,
            JSONObject().put("a", 1),
            JSONArray().put(1),
            JSONObject.NULL,
        )
        for (raw in nonStrings) {
            val value = ImportGate.importTimestampOrNow(
                JSONObject().put("created_at", raw), "created_at", "预测", day,
            )
            assertTrue("应为 SQLite 时间戳形态：$value", pattern.matches(value))
            assertFalse("数字 123 不得被折成字符串 \"123\"", value == "123")
        }
    }

    @Test
    fun `空白与缺键的 created_at 按导入时刻兜底`() {
        val day = LocalDate.of(2026, 1, 1)
        val pattern = Regex("^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}$")
        assertTrue(pattern.matches(ImportGate.importTimestampOrNow(JSONObject(), "created_at", "预测", day)))
        assertTrue(pattern.matches(
            ImportGate.importTimestampOrNow(JSONObject().put("created_at", ""), "created_at", "预测", day),
        ))
    }

    @Test
    fun `33 字符 created_at 是 400 INVALID_IMPORT 且文案与 Win 同形`() {
        val day = LocalDate.of(2026, 1, 1)
        val err = expectApiError {
            ImportGate.importTimestampOrNow(
                JSONObject().put("created_at", "x".repeat(33)), "created_at", "预测", day,
            )
        }
        assertEquals(400, err.status)
        assertEquals("INVALID_IMPORT", err.code)
        assertTrue("文案应含对象与键：${err.detail}", err.detail.contains("预测 2026-01-01 的 created_at 非法"))
        assertTrue("文案应含上限：${err.detail}", err.detail.contains("不超过 32 字符"))
    }

    @Test
    fun `daily created_at 非法改走 INVALID_IMPORT`() {
        val rows = JSONArray().put(
            JSONObject()
                .put("record_date", "2026-01-01")
                .put("pain_present", false)
                .put("flow_level", 3)
                .put("mood_level", 5)
                .put("created_at", "y".repeat(33)),
        )
        val err = expectApiError { ImportGate.validateDailyRows(1L, rows) }
        assertEquals(400, err.status)
        assertEquals("INVALID_IMPORT", err.code)
        assertTrue(err.detail.contains("每日详情 2026-01-01 的 created_at 非法"))
    }

    @Test
    fun `daily flow_level 越界仍是 INVALID_DAILY`() {
        val rows = JSONArray().put(
            JSONObject()
                .put("record_date", "2026-01-01")
                .put("pain_present", false)
                .put("flow_level", 0)
                .put("mood_level", 5),
        )
        val err = expectApiError { ImportGate.validateDailyRows(1L, rows) }
        assertEquals(400, err.status)
        assertEquals("INVALID_DAILY", err.code)
        assertTrue(err.detail.contains("flow_level"))
    }

    // ============================================================
    // #31 daily_records 键存在性
    // ============================================================

    @Test
    fun `daily_records 显式 null 在形状闸门 422`() {
        val body = JSONObject().put("cycles", JSONArray()).put("daily_records", JSONObject.NULL)
        val err = expectApiError { ImportGate.requirePayloadShapes(body) }
        assertEquals(422, err.status)
        assertEquals("VALIDATION_ERROR", err.code)
        assertTrue(err.detail.contains("daily_records"))
    }

    @Test
    fun `daily_records 给字符串在形状闸门 422`() {
        val body = JSONObject().put("cycles", JSONArray()).put("daily_records", "abc")
        val err = expectApiError { ImportGate.requirePayloadShapes(body) }
        assertEquals(422, err.status)
        assertEquals("VALIDATION_ERROR", err.code)
        assertTrue(err.detail.contains("daily_records"))
    }

    @Test
    fun `dailyRowsOrNull 缺键返回 null`() {
        assertNull(ImportGate.dailyRowsOrNull(1L, JSONObject().put("cycles", JSONArray())))
    }

    @Test
    fun `dailyRowsOrNull 显式空数组返回空列表`() {
        val body = JSONObject().put("cycles", JSONArray()).put("daily_records", JSONArray())
        val rows = ImportGate.dailyRowsOrNull(1L, body)
        assertNotNull(rows)
        assertTrue(rows!!.isEmpty())
    }

    @Test
    fun `dailyRowsOrNull 显式 null 直接调用也是 422`() {
        // 该 helper 是 public、单测可绕过 requirePayloadShapes 直接调用：显式 null 不得被
        // 静默折成空列表（那等于"清空"），必须与形状闸门同形同码地 422。
        val body = JSONObject().put("cycles", JSONArray()).put("daily_records", JSONObject.NULL)
        val err = expectApiError { ImportGate.dailyRowsOrNull(1L, body) }
        assertEquals(422, err.status)
        assertEquals("VALIDATION_ERROR", err.code)
        assertTrue("detail 应含 daily_records：${err.detail}", err.detail.contains("daily_records"))
    }

    @Test
    fun `dailyRowsOrNull 给字符串直接调用也是 422`() {
        val body = JSONObject().put("cycles", JSONArray()).put("daily_records", "abc")
        val err = expectApiError { ImportGate.dailyRowsOrNull(1L, body) }
        assertEquals(422, err.status)
        assertEquals("VALIDATION_ERROR", err.code)
        assertTrue("detail 应含 daily_records：${err.detail}", err.detail.contains("daily_records"))
    }

    @Test
    fun `dailyRowsOrNull 解析一行且数字时间戳兜底为导入时刻`() {
        val body = JSONObject().put("cycles", JSONArray()).put(
            "daily_records",
            JSONArray().put(
                JSONObject()
                    .put("record_date", "2026-01-01")
                    .put("pain_present", true)
                    .put("pain_level", 2)
                    .put("flow_level", 4)
                    .put("mood_level", 6)
                    .put("created_at", 123),
            ),
        )
        val rows = ImportGate.dailyRowsOrNull(1L, body)
        assertNotNull(rows)
        assertEquals(1, rows!!.size)
        val row = rows[0]
        assertEquals("2026-01-01", row.recordDate)
        assertTrue(row.painPresent)
        assertEquals(2L, row.painLevel)
        assertEquals(4L, row.flowLevel)
        assertEquals(6L, row.moodLevel)
        assertTrue(
            "数字 created_at 应兜底为导入时刻：${row.createdAt}",
            Regex("^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}$").matches(row.createdAt.orEmpty()),
        )
    }

    // ============================================================
    // #32 基线只用待导入数据自身
    // ============================================================

    @Test
    fun `基线 45 天五段`() {
        val rows = listOf("2026-01-01", "2026-02-15", "2026-04-01", "2026-05-16", "2026-06-30", "2026-08-14")
            .map { cycleAt(it, plusDays(it, 4)) }
        assertEquals(
            listOf(45.0, 45.0, 45.0, 45.0, 45.0),
            ImportGate.baselineCycleLengths(indexed(*rows.toTypedArray())),
        )
    }

    @Test
    fun `基线 28 28 43`() {
        val rows = listOf("2026-01-01", "2026-01-29", "2026-02-26", "2026-04-10")
            .map { cycleAt(it, plusDays(it, 4)) }
        assertEquals(
            listOf(28.0, 28.0, 43.0),
            ImportGate.baselineCycleLengths(indexed(*rows.toTypedArray())),
        )
    }

    @Test
    fun `基线过滤越界间隔`() {
        val rows = listOf("2026-01-01", "2026-05-01", "2026-05-29")
            .map { cycleAt(it, plusDays(it, 4)) }
        assertEquals(
            listOf(28.0),
            ImportGate.baselineCycleLengths(indexed(*rows.toTypedArray())),
        )
    }

    @Test
    fun `乱序输入按日历序派生（删除排序会红）`() {
        // 输入序：02-26, 01-01, 01-29。按日历序派生长度应恰为 28、28（首条无前驱）；
        // 若误按输入序做差，会得到 -56 与 28 → 基线变 [28] 且 G1 误报。
        val rows = listOf(
            cycleAt("2026-02-26", "2026-03-02"),
            cycleAt("2026-01-01", "2026-01-05"),
            cycleAt("2026-01-29", "2026-02-02"),
        )
        assertEquals(listOf(28.0, 28.0), ImportGate.baselineCycleLengths(indexed(*rows.toTypedArray())))
        assertEquals(0, evaluate(rows).length())
    }

    @Test
    fun `基线 provided cycle_length 优先且越界被过滤`() {
        val rows = arrayOf(
            cycleAt("2026-01-01"),
            cycleAt("2026-01-29", cycleLength = 100),
            cycleAt("2026-02-26"),
        )
        assertEquals(listOf(28.0), ImportGate.baselineCycleLengths(indexed(*rows)))
    }

    @Test
    fun `all45 无异常`() {
        val rows = listOf("2026-01-01", "2026-02-15", "2026-04-01", "2026-05-16", "2026-06-30", "2026-08-14")
            .map { cycleAt(it, plusDays(it, 4)) }
        assertEquals(0, evaluate(rows).length())
    }

    @Test
    fun `28 28 43 恰一条 G3 且文案为本次导入数据中位数`() {
        val rows = listOf("2026-01-01", "2026-01-29", "2026-02-26", "2026-04-10")
            .map { cycleAt(it, plusDays(it, 4)) }
        val anomalies = evaluate(rows)
        assertEquals(listOf("G3"), codesOf(anomalies))
        val hit = anomalies.getJSONObject(0)
        assertEquals(43.0, hit.getDouble("value"), 0.0)
        assertEquals("偏离中位数不超过 14 天", hit.getString("expected"))
        val message = hit.getString("message")
        assertTrue(
            "G3 文案应含本次导入数据的中位数与偏离值：$message",
            message.contains("本次导入数据的中位数 28.0 天偏离 15.0 天"),
        )
    }

    @Test
    fun `120 天间隔命中 G1 G3 G4`() {
        val rows = listOf("2026-01-01", "2026-05-01", "2026-05-29")
            .map { cycleAt(it, plusDays(it, 4)) }
        val anomalies = evaluate(rows)
        assertEquals(listOf("G1", "G3", "G4"), codesOf(anomalies))
        assertEquals(listOf(120.0, 120.0, 120.0), valuesOf(anomalies))
    }

    @Test
    fun `单日经期命中两条 G5`() {
        val rows = listOf("2026-01-01", "2026-01-29").map { cycleAt(it, it) }
        assertEquals(listOf("G5", "G5"), codesOf(evaluate(rows)))
    }

    @Test
    fun `basic 日期参与门禁并派生 28 天基线`() {
        // 门禁与导入结构校验同源：YYYYMMDD 是导入校验接受的形态，必须参与派生与 G1-G5。
        val rows = listOf(
            cycleAt("20260101", "20260101"),
            cycleAt("20260129", "20260129"),
        )
        assertEquals(listOf(28.0), ImportGate.baselineCycleLengths(indexed(*rows.toTypedArray())))
        assertEquals(listOf("G5", "G5"), codesOf(evaluate(rows)))
    }

    @Test
    fun `basic 日期 120 天间隔命中 G1 G3 G4`() {
        val rows = listOf(
            cycleAt("20260101", "20260105"),
            cycleAt("20260501", "20260505"),
            cycleAt("20260529", "20260602"),
        )
        val anomalies = evaluate(rows)
        assertEquals(listOf("G1", "G3", "G4"), codesOf(anomalies))
        assertEquals(listOf(120.0, 120.0, 120.0), valuesOf(anomalies))
    }

    @Test
    fun `week 日期参与门禁且派生 1 天 G1`() {
        // 2026-W01-1 / 2026-W01-2 = 2025-12-29 / 2025-12-30；第二条派生 cycle_length=1，
        // 基线过滤 1 后为空 ⇒ 无 G3/G4。顺序 = 输入序，同条内 G1 先于 G5。
        val rows = listOf(
            cycleAt("2026-W01-1", "2026-W01-1"),
            cycleAt("2026-W01-2", "2026-W01-2"),
        )
        assertTrue(ImportGate.baselineCycleLengths(indexed(*rows.toTypedArray())).isEmpty())
        assertEquals(listOf("G5", "G1", "G5"), codesOf(evaluate(rows)))
    }

    @Test
    fun `偶数基线中位数 44 命中两条 G3`() {
        val rows = listOf(
            JSONObject().put("cycle_length", 28),
            JSONObject().put("cycle_length", 60),
        )
        assertEquals(listOf(28.0, 60.0), ImportGate.baselineCycleLengths(indexed(*rows.toTypedArray())))
        val anomalies = evaluate(rows)
        assertEquals(listOf("G3", "G3"), codesOf(anomalies))
        assertEquals(listOf(28.0, 60.0), valuesOf(anomalies))
        val message = anomalies.getJSONObject(0).getString("message")
        assertTrue(
            "G3 文案应含偶数中位数 44.0 与偏离 16.0：$message",
            message.contains("本次导入数据的中位数 44.0 天偏离 16.0 天"),
        )
    }

    @Test
    fun `provided 合法值优先于派生`() {
        val rows = listOf(cycleAt("2026-01-01"), cycleAt("2026-01-29", cycleLength = 30))
        assertEquals(listOf(30.0), ImportGate.baselineCycleLengths(indexed(*rows.toTypedArray())))
        // 30 vs 本次导入数据的中位数 30 ⇒ 无 G3；首条无结束日/无 provided ⇒ 无 G5。
        assertEquals(0, evaluate(rows).length())
    }

    @Test
    fun `created_at 含控制字符是 400 INVALID_IMPORT`() {
        val day = LocalDate.of(2026, 1, 1)
        for (raw in listOf("2026-01-01 00:00:00\n", "2026-01-01 00:00:00\u007f")) {
            val err = expectApiError {
                ImportGate.importTimestampOrNow(
                    JSONObject().put("created_at", raw), "created_at", "预测", day,
                )
            }
            assertEquals(400, err.status)
            assertEquals("INVALID_IMPORT", err.code)
            assertTrue("文案应含控制字符口径：${err.detail}", err.detail.contains("不含控制字符"))
        }
    }

    @Test
    fun `未来日期命中两条 G2`() {
        val rows = listOf("2026-10-01", "2026-11-15").map { cycleAt(it, plusDays(it, 4)) }
        assertEquals(listOf("G2", "G2"), codesOf(evaluate(rows)))
    }

    @Test
    fun `provided 100 命中 G1 与 G3`() {
        val rows = arrayOf(cycleAt("2026-01-01", cycleLength = 100), cycleAt("2026-01-29"))
        assertEquals(listOf("G1", "G3"), codesOf(evaluate(rows.toList())))
    }
}
