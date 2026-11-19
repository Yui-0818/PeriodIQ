package io.github.yui0818.periodiq.domain.daily

import io.github.yui0818.periodiq.PiqConfig
import io.github.yui0818.periodiq.api.contract.validationError
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

/**
 * #15 心情/身体标签（`daily_records.mood_tags`，存受控词表 ID 的 JSON 数组文本）的纯 JVM 校验与编解码。
 *
 * 校验口径与桌面 `schemas/api.py::DailyRecordUpsert._check_mood_tags` 同源（违反 → 422 VALIDATION_ERROR）：
 * 缺键 = 空数组；显式 null / 非数组 / 非字符串元素 → 拒；个数 ≤ [PiqConfig.MOOD_TAGS_MAX_COUNT]；
 * 每个 ≤ [PiqConfig.MOOD_TAG_ID_MAX_CHARS] 码点；必须在 [PiqConfig.MOOD_TAG_IDS] 内；不得重复。
 */
object MoodTags {

    const val FIELD = "mood_tags"

    /** 取出并校验请求体里的标签列表（保持请求顺序）。 */
    fun fromBody(body: JSONObject): List<String> {
        if (!body.has(FIELD)) return emptyList()
        val raw = body.opt(FIELD)
        if (raw !is JSONArray) throw validationError(FIELD, "值应为字符串数组")
        if (raw.length() > PiqConfig.MOOD_TAGS_MAX_COUNT) {
            throw validationError(FIELD, "心情标签最多 ${PiqConfig.MOOD_TAGS_MAX_COUNT} 个")
        }
        val seen = HashSet<String>()
        val out = ArrayList<String>(raw.length())
        for (i in 0 until raw.length()) {
            val tag = raw.opt(i) as? String ?: throw validationError(FIELD, "标签应为字符串")
            if (tag.codePointCount(0, tag.length) > PiqConfig.MOOD_TAG_ID_MAX_CHARS) {
                throw validationError(FIELD, "每个心情标签不超过 ${PiqConfig.MOOD_TAG_ID_MAX_CHARS} 个字符")
            }
            if (tag !in PiqConfig.MOOD_TAG_IDS) throw validationError(FIELD, "未知的心情标签：$tag")
            if (!seen.add(tag)) throw validationError(FIELD, "心情标签重复：$tag")
            out.add(tag)
        }
        return out
    }

    /** 落库文本（JSON 数组；ID 仅含 ASCII，不需转义特殊字符之外的处理）。 */
    fun encode(tags: List<String>): String = JSONArray(tags).toString()

    /**
     * 库内文本 → 列表。手工改库造成的非法文本按空数组兜底（与桌面 `_decode_daily_row` 同口径，
     * 不让单行脏数据把整个区间查询打成 500）。
     */
    fun decode(text: String?): List<String> {
        if (text.isNullOrBlank()) return emptyList()
        return try {
            val arr = JSONArray(text)
            (0 until arr.length()).map { arr.opt(it) as? String ?: return emptyList() }
        } catch (_: JSONException) {
            emptyList()
        }
    }
}
