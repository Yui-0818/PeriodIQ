package io.github.yui0818.periodiq.domain.daily

import io.github.yui0818.periodiq.PiqConfig
import io.github.yui0818.periodiq.api.contract.ApiError
import io.github.yui0818.periodiq.api.contract.validationError
import io.github.yui0818.periodiq.toIso
import java.time.LocalDate
import org.json.JSONObject

/**
 * `PUT /daily-journal/{record_date}`（#14 每日日记）的纯 JVM 校验链，与桌面 `routes/journal.py` 同序：
 *  1. body：`note` 缺键/null → 清空；给了就必须是字符串，且 ≤ [PiqConfig.DAILY_NOTE_MAX_CHARS] **码点**
 *     （不是 UTF-16 单位——一个 emoji 算 1，桌面 pydantic 同口径）→ 422；
 *  2. 晚于今天 → 422 VALIDATION_ERROR；
 *  3. 早于今天 → 400 [PiqConfig.JOURNAL_READONLY_CODE]（过去只读，无补填窗口）。
 * 日记不查 cycles：非经期日同样可写。
 */
object JournalGate {

    /** 过闸结果：`note == null` 表示清空（删行）。 */
    data class Result(val note: String?)

    fun validate(body: JSONObject, day: LocalDate, today: LocalDate): Result {
        val note: String? = when {
            !body.has("note") || body.isNull("note") -> null
            else -> body.opt("note") as? String ?: throw validationError("note", "值应为字符串")
        }
        if (note != null && note.codePointCount(0, note.length) > PiqConfig.DAILY_NOTE_MAX_CHARS) {
            throw validationError("note", "日记不能超过 ${PiqConfig.DAILY_NOTE_MAX_CHARS} 字")
        }
        if (day.isAfter(today)) {
            throw validationError("record_date", "日记日期不能晚于今天（${today.toIso()}）")
        }
        if (day.isBefore(today)) {
            throw ApiError(400, "只有今天的日记可以修改，${day.toIso()} 为只读", PiqConfig.JOURNAL_READONLY_CODE)
        }
        return Result(if (note == null || note.isBlank()) null else note)
    }
}
