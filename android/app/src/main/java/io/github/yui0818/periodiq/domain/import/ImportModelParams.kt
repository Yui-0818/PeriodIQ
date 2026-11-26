/*
 * Copyright (c) 2026 Yui_0818 (aaaj6719@gmail.com)
 * Licensed under the PolyForm Noncommercial License 1.0.0.
 * Commercial use is prohibited without separate written authorization.
 * See LICENSE and COMMERCIAL.md in the repository root.
 */

package io.github.yui0818.periodiq.domain.import

import java.math.BigDecimal
import java.math.BigInteger
import java.time.LocalDate
import org.json.JSONException
import org.json.JSONObject
import io.github.yui0818.periodiq.api.contract.ApiError
import io.github.yui0818.periodiq.toIso

/**
 * 导入 `predictions[].model_params_json` 的**严格校验**（与 Win 同构的单一实现）。
 *
 * 对照点：`Win/backend/app/routes/settings.py::_validate_import_model_params_json`。
 * 旧实现（PiqRouter 里的 `when` 兜底）把 dict 直接序列化、把任何非 dict/str 静默落成 `"{}"`：
 * `{"std_cycle": "x"}` 这类脏类型随清空重建写库后，`GET /debug/model_history` 永久 500
 * （单条脏预测钉死整个端点）。桌面已改成"宁严不宽"，本端补齐同一条闸门。
 *
 * 规则（逐条对照 Win）：
 * - **dict**：`mean_cycle/std_cycle/ema_cycle/prior_mean/prior_std` 键存在时必须是有限数值
 *   （排除 bool；显式 null 拒）；`prior_weight` 键存在且非 null 时必须是 0-1 的有限数值；
 *   `n_records` 键存在且非 null 时必须是非负整数（排除 bool 与 `3.0` 这类浮点）。
 *   缺失键一律放行（消费侧 `.get()` 有默认值）；未知键原样保留（自家导出会带
 *   `n_eff` / `stale_correction` 等附加键，不得因此拒收）。校验通过后序列化入库。
 * - **str**：空串 → `"{}"`；其余必须通过 [StrictJson] 的文法检查且顶层为对象
 *   （尾随垃圾 / 单引号 / 注释 / 数组 / 标量都拒），然后按 dict 同一套字段规则校验，
 *   通过后**原样保留字符串**（不二次序列化，导出往返逐字节稳定）。
 * - **JSON null / 缺键** → `"{}"`（旧备份可能缺键，保留既有兜底）。
 * - **其余类型**（数组 / 数字 / bool 等）→ 400（静默落 `"{}"` 会掩盖手改文件的数据损坏）。
 *
 * 错误码一律 `INVALID_IMPORT`（400），文案带预测日期与字段名，与 Win 同义。
 */
object ImportModelParams {

    /** 五个"有限数值"字段（Win `_MP_JSON_NUMERIC_FIELDS` 的同源清单）。 */
    private val NUMERIC_FIELDS = listOf("mean_cycle", "std_cycle", "ema_cycle", "prior_mean", "prior_std")

    private const val EMPTY = "{}"

    /**
     * 把备份里的 `model_params_json` 原始值归一成入库字符串；非法输入抛 400 `INVALID_IMPORT`。
     *
     * [raw] 直接收 `JSONObject.opt("model_params_json")` 的返回值：缺键得 `null`、
     * 显式 JSON null 得 [JSONObject.NULL]，两者都落 `"{}"`（与 Win 的 `None` 同义）。
     */
    fun normalize(raw: Any?, predictedDate: LocalDate): String {
        if (raw == null || raw === JSONObject.NULL) return EMPTY
        return when (raw) {
            is JSONObject -> {
                checkObject(raw, predictedDate)
                // 未知键里混进裸 NaN/Infinity 时序列化会失败：org.json 20240303 的 toString()
                // 吞掉异常返回 null，其它版本抛 JSONException。两者都归一为 400，避免冒泡成 500。
                val text: String? = try {
                    raw.toString()
                } catch (e: JSONException) {
                    null
                }
                text ?: throw reject(predictedDate, null, "包含无法序列化的数值")
            }
            is String -> normalizeText(raw, predictedDate)
            else -> throw reject(predictedDate, null, "须为对象、JSON 文本或 null")
        }
    }

    private fun normalizeText(text: String, predictedDate: LocalDate): String {
        if (text.isEmpty()) return EMPTY
        // 先用严格文法判"是不是一份合法 JSON 文档"：org.json 的 JSONObject(String) 很宽松
        // （尾随垃圾/单引号/注释都吃），桌面 json.loads 全拒 ⇒ 必须以 StrictJson 为准。
        if (StrictJson.firstSyntaxError(text) != -1) throw rejectNotJsonText(predictedDate)
        if (StrictJson.topLevelKind(text) != "对象") {
            throw reject(predictedDate, null, "JSON 文本必须表示对象")
        }
        val parsed = try {
            JSONObject(text)
        } catch (e: Exception) {
            // 文法检查放行、org.json 仍拒的形态（如裸 NaN/Infinity 字面量）：按非法 JSON 文本拒。
            throw rejectNotJsonText(predictedDate)
        }
        checkObject(parsed, predictedDate)
        return text
    }

    private fun checkObject(obj: JSONObject, predictedDate: LocalDate) {
        for (field in NUMERIC_FIELDS) {
            if (!obj.has(field)) continue
            val value = obj.opt(field)
            // 显式 null 得到 JSONObject.NULL（不是 Number）⇒ 拒；bool 在 Java 里不是 Number ⇒ 拒。
            if (value !is Number || !isFinite(value)) {
                throw reject(predictedDate, field, "须为有限数值")
            }
        }
        if (obj.has("prior_weight") && !obj.isNull("prior_weight")) {
            val value = obj.opt("prior_weight")
            if (value !is Number || !isFinite(value) || value.toDouble() < 0.0 || value.toDouble() > 1.0) {
                throw reject(predictedDate, "prior_weight", "须为 0-1 的数值")
            }
        }
        if (obj.has("n_records") && !obj.isNull("n_records")) {
            if (!isNonNegativeInteger(obj.opt("n_records"))) {
                throw reject(predictedDate, "n_records", "须为非负整数")
            }
        }
    }

    /**
     * 有限性按语义判定，不认具体数字类：org.json 会把整数解析成 Integer/Long/BigInteger、
     * 小数解析成 Double（某些版本是 BigDecimal），全部都要接住。
     */
    private fun isFinite(value: Number): Boolean = when (value) {
        is Double -> value.isFinite()
        is Float -> value.isFinite()
        is BigDecimal -> value.toDouble().isFinite()
        is BigInteger -> value.toDouble().isFinite()
        else -> true
    }

    /**
     * 非负整数：只认整型（Byte/Short/Int/Long/BigInteger）。
     * `3.0` 在 JSON 里是浮点、在 Python 里是 `float` ⇒ 桌面拒，本端同样拒；
     * bool 在 Java 里不是 Number ⇒ 自然落进 else。
     */
    private fun isNonNegativeInteger(value: Any?): Boolean = when (value) {
        is Byte -> value >= 0
        is Short -> value >= 0
        is Int -> value >= 0
        is Long -> value >= 0L
        is BigInteger -> value.signum() >= 0
        else -> false
    }

    private fun reject(predictedDate: LocalDate, field: String?, reason: String): ApiError {
        val subject = if (field == null) "model_params_json" else "model_params_json.$field"
        return ApiError(
            400,
            "预测 ${predictedDate.toIso()} 的 $subject 非法（$reason）",
            "INVALID_IMPORT",
        )
    }

    /** Win 对 `json.loads` 失败的那一档文案（不带字段后缀）。 */
    private fun rejectNotJsonText(predictedDate: LocalDate): ApiError = ApiError(
        400,
        "预测 ${predictedDate.toIso()} 的 model_params_json 非法（不是合法的 JSON 文本）",
        "INVALID_IMPORT",
    )
}
