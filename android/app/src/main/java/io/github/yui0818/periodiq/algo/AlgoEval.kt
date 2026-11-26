/*
 * Copyright (c) 2026 Yui_0818 (aaaj6719@gmail.com)
 * Licensed under the PolyForm Noncommercial License 1.0.0.
 * Commercial use is prohibited without separate written authorization.
 * See LICENSE and COMMERCIAL.md in the repository root.
 */

package io.github.yui0818.periodiq.algo

import io.github.yui0818.periodiq.PyMath
import java.time.LocalDate
import kotlin.math.abs
import org.json.JSONArray
import org.json.JSONObject

/**
 * Pure-Kotlin port of `app/algo/eval.py`.
 */
object AlgoEval {

    private val DEFAULT_N_DAYS = listOf(1, 2, 3, 5, 7)

    private data class ParsedPrediction(
        val predictedDate: LocalDate,
        val predictedStartLower: LocalDate,
        val predictedStartUpper: LocalDate,
        val actualDate: LocalDate,
    )

    private fun toDate(raw: Any?): LocalDate {
        if (raw is LocalDate) return raw
        if (raw is String) return LocalDate.parse(raw)
        throw IllegalArgumentException("无法解析日期: $raw")
    }

    private fun sortStringField(obj: JSONObject, key: String): String {
        val v = obj.opt(key)
        return if (v == null || v == JSONObject.NULL) "" else v.toString()
    }

    private fun sortIdField(obj: JSONObject): Long {
        val v = obj.opt("id")
        if (v == null || v == JSONObject.NULL) return 0L
        return when (v) {
            is Number -> v.toLong()
            is String -> v.toLongOrNull() ?: 0L
            else -> 0L
        }
    }

    fun evaluatePredictions(
        predictions: JSONArray,
        nDays: List<Int> = DEFAULT_N_DAYS,
    ): JSONObject {
        val evaluatedRaw = mutableListOf<JSONObject>()
        for (i in 0 until predictions.length()) {
            val item = predictions.getJSONObject(i)
            val actual = item.opt("actual_date")
            if (actual != null && actual != JSONObject.NULL) {
                evaluatedRaw.add(item)
            }
        }

        val evaluated = evaluatedRaw.sortedWith(
            compareBy(
                { sortStringField(it, "predicted_date") },
                { sortStringField(it, "created_at") },
                { sortIdField(it) },
            ),
        )
        val total = evaluated.size
        if (total == 0) {
            return JSONObject().put("error", "no_evaluated_predictions")
        }

        val parsed = evaluated.map { p ->
            ParsedPrediction(
                predictedDate = toDate(p.opt("predicted_date")),
                predictedStartLower = toDate(p.opt("predicted_start_lower")),
                predictedStartUpper = toDate(p.opt("predicted_start_upper")),
                actualDate = toDate(p.opt("actual_date")),
            )
        }

        val result = JSONObject()
            .put("total_predictions", predictions.length())
            .put("evaluated", total)

        val errors = parsed.map { abs(PyMath.daysBetween(it.predictedDate, it.actualDate)) }
        for (n in nDays) {
            val hits = errors.count { it <= n }
            result.put("hit_rate_pm$n", PyMath.roundTo(hits.toDouble() / total, 4))
        }

        result.put("mae", PyMath.roundTo(errors.sum().toDouble() / total, 4))

        val inInterval = parsed.count { p ->
            !p.actualDate.isBefore(p.predictedStartLower) && !p.actualDate.isAfter(p.predictedStartUpper)
        }
        result.put("interval_coverage", PyMath.roundTo(inInterval.toDouble() / total, 4))

        val biases = parsed.map { PyMath.daysBetween(it.predictedDate, it.actualDate) }
        result.put("bias", PyMath.roundTo(biases.sum().toDouble() / total, 4))

        val trend = if (total >= 4) {
            val half = total / 2
            val maeEarly = errors.subList(0, half).sum().toDouble() / half
            val maeLate = errors.subList(half, total).sum().toDouble() / (total - half)
            when {
                maeLate <= maeEarly - 0.5 -> "improving"
                maeLate >= maeEarly + 0.5 -> "degrading"
                else -> "stable"
            }
        } else {
            "stable"
        }
        result.put("trend", trend)

        return result
    }
}
