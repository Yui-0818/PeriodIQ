/*
 * Copyright (c) 2026 Yui_0818 (aaaj6719@gmail.com)
 * Licensed under the PolyForm Noncommercial License 1.0.0.
 * Commercial use is prohibited without separate written authorization.
 * See LICENSE and COMMERCIAL.md in the repository root.
 */

package io.github.yui0818.periodiq.algo

import io.github.yui0818.periodiq.PyMath
import io.github.yui0818.periodiq.toIso
import java.time.LocalDate
import org.json.JSONArray
import org.json.JSONObject

/**
 * Pure-Kotlin port of `app/algo/fertility.py`.
 */
object AlgoFertility {

    fun computeFertilityWindow(
        predictedPeriodDateIso: String?,
        currentPeriodStartIso: String?,
        currentPeriodEndIso: String?,
        cycleStd: Double,
        predictedPeriodDays: Int? = null,
    ): JSONObject {
        if (predictedPeriodDateIso == null || currentPeriodStartIso == null) {
            return JSONObject()
                .put("available", false)
                .put("ovulation_date", JSONObject.NULL)
                .put("ovulation_sigma_days", 0.0)
                .put("fertile_window", JSONObject.NULL)
                .put("less_certain_windows", JSONArray())
                .put("predicted_period_days", predictedPeriodDays ?: JSONObject.NULL)
                .put("current_period_predicted_end", JSONObject.NULL)
                .put("next_period_predicted_end", JSONObject.NULL)
                .put("predicted_period_windows", JSONArray())
                .put("basis", "calendar_rule")
        }

        val predictedPeriodDate = LocalDate.parse(predictedPeriodDateIso)
        val currentPeriodStart = LocalDate.parse(currentPeriodStartIso)
        val currentPeriodEnd = currentPeriodEndIso?.let(LocalDate::parse)

        val ovulation = predictedPeriodDate.minusDays(AlgoConfig.LUTEAL_PHASE_DAYS.toLong())
        var fertileStart = ovulation.minusDays(AlgoConfig.FERTILE_PRE_OVULATION_DAYS.toLong())
        val fertileEnd = ovulation.plusDays(AlgoConfig.FERTILE_POST_OVULATION_DAYS.toLong())

        val windows = JSONArray()
        val predictedPeriodWindows = JSONArray()
        var currentPeriodPredictedEnd: String? = null
        var nextPeriodPredictedEnd: String? = null

        if (predictedPeriodDays != null && predictedPeriodDays >= 1) {
            if (currentPeriodEnd != null) {
                currentPeriodPredictedEnd = currentPeriodEnd.toIso()
            } else {
                val curEnd = currentPeriodStart.plusDays((predictedPeriodDays - 1).toLong())
                currentPeriodPredictedEnd = curEnd.toIso()
                predictedPeriodWindows.put(
                    JSONObject()
                        .put("start", currentPeriodStart.toIso())
                        .put("end", curEnd.toIso()),
                )
            }
            val nxtEnd = predictedPeriodDate.plusDays((predictedPeriodDays - 1).toLong())
            nextPeriodPredictedEnd = nxtEnd.toIso()
            predictedPeriodWindows.put(
                JSONObject()
                    .put("start", predictedPeriodDate.toIso())
                    .put("end", nxtEnd.toIso()),
            )
        }

        val sigmaRounded = PyMath.roundTo(maxOf(cycleStd, 0.0), 2)

        if (!ovulation.isAfter(currentPeriodStart)) {
            return JSONObject()
                .put("available", true)
                .put("ovulation_date", JSONObject.NULL)
                .put("ovulation_sigma_days", sigmaRounded)
                .put("fertile_window", JSONObject.NULL)
                .put("less_certain_windows", JSONArray())
                .put("predicted_period_days", predictedPeriodDays ?: JSONObject.NULL)
                .put("current_period_predicted_end", currentPeriodPredictedEnd ?: JSONObject.NULL)
                .put("next_period_predicted_end", nextPeriodPredictedEnd ?: JSONObject.NULL)
                .put("predicted_period_windows", predictedPeriodWindows)
                .put("basis", "calendar_rule")
        }

        if (fertileStart.isBefore(currentPeriodStart)) {
            fertileStart = currentPeriodStart
        }

        var follicularEndBasis: LocalDate? = null
        var follicularBasisLabel: String? = null
        if (currentPeriodEnd != null) {
            follicularEndBasis = currentPeriodEnd
            follicularBasisLabel = "actual"
        } else if (currentPeriodPredictedEnd != null) {
            follicularEndBasis = LocalDate.parse(currentPeriodPredictedEnd)
            follicularBasisLabel = "predicted"
        }
        if (follicularEndBasis != null) {
            val fs = follicularEndBasis.plusDays(1)
            val fe = fertileStart.minusDays(1)
            if (!fs.isAfter(fe)) {
                windows.put(
                    JSONObject()
                        .put("phase", "follicular")
                        .put("basis", follicularBasisLabel ?: JSONObject.NULL)
                        .put("start", fs.toIso())
                        .put("end", fe.toIso()),
                )
            }
        }

        val ls = fertileEnd.plusDays(1)
        val le = predictedPeriodDate.minusDays(1)
        if (!ls.isAfter(le)) {
            windows.put(
                JSONObject()
                    .put("phase", "luteal")
                    .put("basis", JSONObject.NULL)
                    .put("start", ls.toIso())
                    .put("end", le.toIso()),
            )
        }

        return JSONObject()
            .put("available", true)
            .put("ovulation_date", ovulation.toIso())
            .put("ovulation_sigma_days", sigmaRounded)
            .put(
                "fertile_window",
                JSONObject()
                    .put("start", fertileStart.toIso())
                    .put("end", fertileEnd.toIso()),
            )
            .put("less_certain_windows", windows)
            .put("predicted_period_days", predictedPeriodDays ?: JSONObject.NULL)
            .put("current_period_predicted_end", currentPeriodPredictedEnd ?: JSONObject.NULL)
            .put("next_period_predicted_end", nextPeriodPredictedEnd ?: JSONObject.NULL)
            .put("predicted_period_windows", predictedPeriodWindows)
            .put("basis", "calendar_rule")
    }
}
