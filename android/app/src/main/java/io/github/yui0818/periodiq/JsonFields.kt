package io.github.yui0818.periodiq

import org.json.JSONObject

/** JSON 文本列读数：`null` / 缺键 / 空串统一视为"无值"（与 Python 的 `None` 对齐）。 */
fun JSONObject.textOrNull(name: String): String? {
    if (isNull(name)) return null
    return optString(name).takeIf { it.isNotEmpty() }
}

fun JSONObject.doubleOrNull(name: String): Double? {
    if (isNull(name)) return null
    val raw = opt(name)
    return when (raw) {
        is Number -> raw.toDouble()
        is String -> raw.toDoubleOrNull()
        else -> null
    }
}

fun JSONObject.longOrNull(name: String): Long? {
    if (isNull(name)) return null
    val raw = opt(name)
    return when (raw) {
        is Number -> raw.toLong()
        is String -> raw.toLongOrNull()
        else -> null
    }
}

/**
 * **导入链路专用**的数值读取（2026-10-26 修 P2）：只认 JSON Number，String 一律视为字段缺失/无值
 * （桌面 `gate.py::_as_number` 的口径——`isinstance(x, (int, float))` 且排除 bool，字符串是无值）。
 *
 * 不能改成把 [doubleOrNull] 本体收紧：后者对数字字符串的折算是 [PiqRouter.profileWeightOrReject]
 * 一类非导入路径**刻意**对齐 pydantic lax 模式的契约（`"70.5"`→70.5 两端同判）。
 * 两个口径并存、按路径选用，是本文件的新边界。
 */
fun JSONObject.strictDoubleOrNull(name: String): Double? = (opt(name) as? Number)?.toDouble()

/**
 * **导入时间戳专用**的文本读取（2026-10-31 修 #26）：只认 JSON 字符串，
 * 数字/布尔/对象/数组/null 一律返回 null（= 无值）。
 *
 * 不能复用 [textOrNull]：它走 `optString`，会把数字 `123` 折成 `"123"` 入库——
 * 这正是 #26 的根因（桌面 `_validate_created_at` 判 `isinstance(value, str)`，
 * 非字符串按导入时刻兜底）。两个口径并存、按路径选用，与 [strictDoubleOrNull] 同一边界。
 */
fun JSONObject.strictTextOrNull(name: String): String? = opt(name) as? String

fun JSONObject.boolAt(name: String): Boolean = when (opt(name)) {
    is Boolean -> getBoolean(name)
    is Number -> getLong(name) != 0L
    else -> false
}
