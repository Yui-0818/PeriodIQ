package io.github.yui0818.periodiq

import io.github.yui0818.periodiq.api.contract.ApiError
import io.github.yui0818.periodiq.domain.daily.DailyPutGate
import java.time.LocalDate
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `DailyPutGate` 的 JVM 单测：校验顺序与桌面 `routes/daily.py` 同序
 * （字段 422 → 未来日期 422 → 补填窗口 400 → 来潮日 400）。
 *
 * 关键约束：来潮日回调只有在字段/未来/窗口全过后才会被调用 —— 前序失败时计数必须为 0。
 */
class DailyPutGateTest {

    private val today: LocalDate = LocalDate.of(2026, 10, 29)

    private fun validBody(): JSONObject = JSONObject()
        .put("pain_present", true)
        .put("pain_level", 3)
        .put("flow_level", 5)
        .put("mood_level", 7)
        .put("mood_tags", JSONArray().put("calm").put("cramps"))

    /** 坏字段：flow_level 越界（0 不在 1-10）。 */
    private fun badFlowBody(): JSONObject = validBody().put("flow_level", 0)

    private fun expectApiError(block: () -> Unit): ApiError {
        try {
            block()
        } catch (e: ApiError) {
            return e
        }
        throw AssertionError("应抛 ApiError，但没有抛")
    }

    @Test
    fun `超窗加坏字段先报字段错误且不查来潮日`() {
        var checks = 0
        val err = expectApiError {
            DailyPutGate.validate(badFlowBody(), today.minusDays(2), today) {
                checks++
                true
            }
        }
        assertEquals(422, err.status)
        assertEquals("VALIDATION_ERROR", err.code)
        assertTrue(err.detail.contains("flow_level"))
        assertEquals(0, checks)
    }

    @Test
    fun `未来日期加坏字段先报字段错误`() {
        val err = expectApiError {
            DailyPutGate.validate(badFlowBody(), today.plusDays(1), today) { true }
        }
        assertEquals(422, err.status)
        assertEquals("VALIDATION_ERROR", err.code)
        assertTrue(err.detail.contains("flow_level"))
    }

    @Test
    fun `未来日期加合法字段报 record_date`() {
        var checks = 0
        val err = expectApiError {
            DailyPutGate.validate(validBody(), today.plusDays(1), today) {
                checks++
                true
            }
        }
        assertEquals(422, err.status)
        assertEquals("VALIDATION_ERROR", err.code)
        assertTrue(err.detail.contains("record_date"))
        assertEquals(0, checks)
    }

    @Test
    fun `超窗加合法字段报 DAILY_WINDOW`() {
        var checks = 0
        val err = expectApiError {
            DailyPutGate.validate(validBody(), today.minusDays(2), today) {
                checks++
                true
            }
        }
        assertEquals(400, err.status)
        assertEquals(PiqConfig.DAILY_WINDOW_CODE, err.code)
        assertTrue(err.detail.contains(today.minusDays(2).toIso()))
        assertEquals(0, checks)
    }

    @Test
    fun `今天非来潮日加坏字段先报字段错误且不查来潮日`() {
        var checks = 0
        val err = expectApiError {
            DailyPutGate.validate(badFlowBody(), today, today) {
                checks++
                false
            }
        }
        assertEquals(422, err.status)
        assertEquals("VALIDATION_ERROR", err.code)
        assertEquals(0, checks)
    }

    @Test
    fun `今天非来潮日加合法字段报 NOT_PERIOD_DAY`() {
        var checks = 0
        val err = expectApiError {
            DailyPutGate.validate(validBody(), today, today) {
                checks++
                false
            }
        }
        assertEquals(400, err.status)
        assertEquals(PiqConfig.NOT_PERIOD_DAY_CODE, err.code)
        assertEquals(1, checks)
    }

    @Test
    fun `今天来潮日加合法字段返回取值`() {
        var checks = 0
        val values = DailyPutGate.validate(validBody(), today, today) {
            checks++
            true
        }
        assertTrue(values.painPresent)
        assertEquals(3L, values.painLevel)
        assertEquals(5L, values.flowLevel)
        assertEquals(7L, values.moodLevel)
        assertEquals(listOf("calm", "cramps"), values.moodTags)
        assertEquals(1, checks)
    }

    @Test
    fun `无疼痛时疼痛等级必须为空`() {
        val body = validBody().put("pain_present", false)
        val err = expectApiError {
            DailyPutGate.validate(body, today, today) { true }
        }
        assertEquals(422, err.status)
        assertTrue(err.detail.contains("pain_level"))

        val noPain = validBody().put("pain_present", false)
        noPain.remove("pain_level")
        val ok = DailyPutGate.validate(noPain, today, today) { true }
        assertFalse(ok.painPresent)
        assertNull(ok.painLevel)
    }

    private fun tagsErr(tags: Any?): ApiError = expectApiError {
        DailyPutGate.validate(validBody().put("mood_tags", tags), today, today) { true }
    }

    @Test
    fun `mood_tags 缺键为空列表，旧 mood_note 被忽略`() {
        val body = validBody().put("mood_note", "legacy")
        body.remove("mood_tags")
        assertEquals(emptyList<String>(), DailyPutGate.validate(body, today, today) { true }.moodTags)
    }

    @Test
    fun `mood_tags 违规一律 422 并指向 mood_tags`() {
        val nine = JSONArray(PiqConfig.MOOD_TAG_IDS.sorted().take(9))
        val cases = listOf<Any?>(
            JSONArray().put("nope"),                      // 词表外
            JSONArray().put("calm").put("calm"),          // 重复
            JSONArray().put("x".repeat(25)),              // >24
            nine,                                         // >8
            "calm",                                       // 非数组
            JSONObject.NULL,                              // 显式 null
            JSONArray().put(1),                           // 非字符串元素
        )
        for (c in cases) {
            val err = tagsErr(c)
            assertEquals("case=$c", 422, err.status)
            assertEquals("VALIDATION_ERROR", err.code)
            assertTrue("case=$c", err.detail.contains("mood_tags"))
        }
    }

    @Test
    fun `mood_tags 恰好 8 个通过且保持顺序`() {
        val eight = PiqConfig.MOOD_TAG_IDS.sorted().take(8)
        val v = DailyPutGate.validate(validBody().put("mood_tags", JSONArray(eight)), today, today) { true }
        assertEquals(eight, v.moodTags)
    }

    @Test
    fun `未来生日报 422 VALIDATION_ERROR 且 detail 含 birthday`() {
        val err = expectApiError { rejectFutureBirthday(LocalDate.now().plusDays(1)) }
        assertEquals(422, err.status)
        assertEquals("VALIDATION_ERROR", err.code)
        assertTrue(err.detail.contains("birthday"))
    }

    @Test
    fun `过去生日不抛`() {
        rejectFutureBirthday(LocalDate.now().minusDays(1))
        rejectFutureBirthday(LocalDate.now())
    }
}
