package io.github.yui0818.periodiq.domain.daily

import io.github.yui0818.periodiq.PiqConfig
import io.github.yui0818.periodiq.api.contract.ApiError
import io.github.yui0818.periodiq.api.contract.validationError
import io.github.yui0818.periodiq.toIso
import java.time.LocalDate
import org.json.JSONObject

/** 过闸的每日详情取值（写入 `DailyRecordRow` 前的最终形态）。 */
data class DailyValues(
    val painPresent: Boolean,
    val painLevel: Long?,
    val flowLevel: Long,
    val moodLevel: Long,
    val moodTags: List<String>,
)

/**
 * `PUT /daily-records/{record_date}` 的纯 JVM 校验链（**不打日志**，所以可单测）。
 *
 * 顺序与桌面 `routes/daily.py` 严格同序：
 *  1. body 字段（422 VALIDATION_ERROR）—— FastAPI 在进入路由前先做 pydantic 校验；
 *     #15 起含 mood_tags（[MoodTags.fromBody]）；#14 起日记文本不在这里（[JournalGate]），
 *     旧客户端仍发送的 mood_note 按未知字段忽略；
 *  2. 日期不得晚于今天（422 VALIDATION_ERROR，field=record_date）；
 *  3. 补填窗口（400 [PiqConfig.DAILY_WINDOW_CODE]）；
 *  4. 来潮日（400 [PiqConfig.NOT_PERIOD_DAY_CODE]）。
 *
 * 来潮日判定走传入的 lambda：字段/未来/窗口任一失败时**一次都不调用**（不查库）。
 */
object DailyPutGate {

    fun validate(
        body: JSONObject,
        day: LocalDate,
        today: LocalDate,
        isPeriodDay: (LocalDate) -> Boolean,
    ): DailyValues {
        // 1. body 字段（对齐桌面 pydantic 的接受集与文案）
        val painPresent = body.opt("pain_present") as? Boolean
            ?: throw validationError("pain_present", "值应为布尔")
        val painLevel = levelOrReject(body, "pain_level")
        if (painPresent && painLevel == null) throw validationError("pain_level", "有疼痛时必须填写疼痛等级（1-10）")
        if (!painPresent && painLevel != null) throw validationError("pain_level", "无疼痛时疼痛等级必须为空（存 NULL，不存 0）")
        val flow = levelOrReject(body, "flow_level")
            ?: throw validationError("flow_level", "值应为 1-10 整数")
        val mood = levelOrReject(body, "mood_level")
            ?: throw validationError("mood_level", "值应为 1-10 整数")
        val tags = MoodTags.fromBody(body)
        // 2. 日期不得晚于今天
        if (day.isAfter(today)) {
            throw validationError("record_date", "每日详情日期不能晚于今天（${today.toIso()}）")
        }
        // 3. 补填窗口：仅今天与昨天
        val earliest = today.minusDays(PiqConfig.DAILY_BACKFILL_WINDOW_DAYS - 1)
        if (day.isBefore(earliest)) {
            throw ApiError(
                400,
                "仅可记录今天与昨天（${PiqConfig.DAILY_BACKFILL_WINDOW_DAYS} 天补填窗口），" +
                    "${day.toIso()} 超出窗口",
                PiqConfig.DAILY_WINDOW_CODE,
            )
        }
        // 4. 来潮日（查库；前三步全过才走到这里）
        if (!isPeriodDay(day)) {
            throw ApiError(400, "${day.toIso()} 不是来潮日（无覆盖该日的周期记录）", PiqConfig.NOT_PERIOD_DAY_CODE)
        }
        return DailyValues(painPresent, painLevel, flow, mood, tags)
    }

    /** 等级字段：缺失/null → null（pain_level 选填）；给了就只认 1-10 的 JSON 整数（bool/小数/字符串拒收）。 */
    private fun levelOrReject(body: JSONObject, key: String): Long? {
        if (!body.has(key) || body.isNull(key)) return null
        return when (val raw = body.opt(key)) {
            is Int -> raw.toLong()
            is Long -> raw
            else -> throw validationError(key, "值应为 1-10 整数")
        }.also { if (it < 1L || it > 10L) throw validationError(key, "值应为 1-10 整数") }
    }
}
