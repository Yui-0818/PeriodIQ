package io.github.yui0818.periodiq

import io.github.yui0818.periodiq.api.contract.ApiError
import io.github.yui0818.periodiq.data.PiqDb
import io.github.yui0818.periodiq.domain.daily.JournalGate
import io.github.yui0818.periodiq.domain.daily.MoodTags
import java.time.LocalDate
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #14 每日日记 / #15 心情标签的 JVM 契约哨兵（与 Win 隔离库 TestClient 用例同口径）。
 * SQLite 落库路径（`migrateV4Journal`、journal CRUD）在 JVM 里只有桩类 ⇒ 这里只钉纯函数部分。
 */
class DailyJournalContractTest {

    private val today: LocalDate = LocalDate.of(2026, 10, 31)

    private fun err(block: () -> Unit): ApiError {
        try {
            block()
        } catch (e: ApiError) {
            return e
        }
        throw AssertionError("应抛 ApiError，但没有抛")
    }

    private fun note(n: String?): JSONObject = JSONObject().put("note", n ?: JSONObject.NULL)

    @Test
    fun `今天可写且原文保存`() {
        assertEquals("今天还好", JournalGate.validate(note("今天还好"), today, today).note)
    }

    @Test
    fun `空 null 纯空白 缺键 都表示清空`() {
        assertNull(JournalGate.validate(note(""), today, today).note)
        assertNull(JournalGate.validate(note("  \n "), today, today).note)
        assertNull(JournalGate.validate(note(null), today, today).note)
        assertNull(JournalGate.validate(JSONObject(), today, today).note)
    }

    @Test
    fun `过去日只读 JOURNAL_READONLY，昨天也不例外`() {
        for (d in listOf(today.minusDays(1), today.minusDays(5))) {
            val e = err { JournalGate.validate(note("x"), d, today) }
            assertEquals(400, e.status)
            assertEquals(PiqConfig.JOURNAL_READONLY_CODE, e.code)
        }
    }

    @Test
    fun `未来日 422 VALIDATION_ERROR`() {
        val e = err { JournalGate.validate(note("x"), today.plusDays(1), today) }
        assertEquals(422, e.status)
        assertEquals("VALIDATION_ERROR", e.code)
        assertTrue(e.detail.contains("record_date"))
    }

    @Test
    fun `300 字按码点计：300 个 emoji 通过，301 个拒绝`() {
        val emoji = "\uD83D\uDE00"
        assertEquals(300, JournalGate.validate(note("字".repeat(300)), today, today).note!!.length)
        // 300 个 emoji = 600 个 UTF-16 单位，按码点仍合法
        assertEquals(600, JournalGate.validate(note(emoji.repeat(300)), today, today).note!!.length)
        for (over in listOf("字".repeat(301), emoji.repeat(301))) {
            val e = err { JournalGate.validate(note(over), today, today) }
            assertEquals(422, e.status)
            assertTrue(e.detail.contains("note"))
        }
    }

    @Test
    fun `note 非字符串 422`() {
        val e = err { JournalGate.validate(JSONObject().put("note", 5), today, today) }
        assertEquals(422, e.status)
    }

    @Test
    fun `未来日加超长文本先报字段错误`() {
        val e = err { JournalGate.validate(note("字".repeat(301)), today.plusDays(1), today) }
        assertTrue(e.detail.contains("note"))
    }

    @Test
    fun `mood_tags 编解码往返且脏文本兜底为空`() {
        assertEquals("[\"calm\",\"cramps\"]", MoodTags.encode(listOf("calm", "cramps")))
        assertEquals(listOf("calm", "cramps"), MoodTags.decode("[\"calm\",\"cramps\"]"))
        assertEquals(emptyList<String>(), MoodTags.decode("[]"))
        for (dirty in listOf(null, "", "not json", "{\"a\":1}", "[1,2]")) {
            assertEquals("dirty=$dirty", emptyList<String>(), MoodTags.decode(dirty))
        }
    }

    @Test
    fun `词表与桌面同值（两组 18 个，并集校验）`() {
        assertEquals(8, PiqConfig.MOOD_TAG_IDS_MOOD.size)
        assertEquals(10, PiqConfig.MOOD_TAG_IDS_BODY.size)
        assertEquals(18, PiqConfig.MOOD_TAG_IDS.size)
        assertTrue(PiqConfig.MOOD_TAG_IDS.all { it.length <= PiqConfig.MOOD_TAG_ID_MAX_CHARS })
    }

    @Test
    fun `旧 mood_note 迁移规则：空白跳过，不 trim，超长按码点截断`() {
        assertNull(PiqDb.migratedJournalNote(null))
        assertNull(PiqDb.migratedJournalNote(""))
        assertNull(PiqDb.migratedJournalNote("   \n"))
        assertEquals("  还好 ", PiqDb.migratedJournalNote("  还好 "))
        val emoji = "\uD83D\uDE00"
        val cut = PiqDb.migratedJournalNote(emoji.repeat(305))!!
        assertEquals(300, cut.codePointCount(0, cut.length))
    }
}
