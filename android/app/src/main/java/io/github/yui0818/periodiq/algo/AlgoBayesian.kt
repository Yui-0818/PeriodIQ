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
import org.json.JSONObject

/**
 * Pure-Kotlin port of `app/algo/bayesian.py`.
 */
object AlgoBayesian {

    fun bayesianUpdate(
        priorMean: Double,
        priorStd: Double,
        observations: List<Double>,
        minSigma: Double = AlgoConfig.MIN_STD,
        weights: List<Double>? = null,
    ): Pair<Double, Double> = AlgoStats.normalConjugatePosterior(
        priorMean = priorMean,
        priorStd = priorStd,
        observations = observations,
        minSigma = minSigma,
        weights = weights,
    )

    fun priorWeight(n: Double, k: Double = AlgoConfig.PRIOR_DECAY_K): Double =
        1.0 / (1.0 + n / k)

    fun onNewCycleAdded(
        newStartIso: String,
        prevStartIso: String?,
        currentParams: JSONObject,
    ): JSONObject {
        val newPeriodStart = LocalDate.parse(newStartIso)
        val cycleLength: Long? = if (prevStartIso == null) {
            null
        } else {
            PyMath.daysBetween(LocalDate.parse(prevStartIso), newPeriodStart)
        }

        val historicalCycles = mutableListOf<Double>()
        val rawHistory = currentParams.optJSONArray("cycle_lengths")
        if (rawHistory != null) {
            for (i in 0 until rawHistory.length()) {
                historicalCycles.add(rawHistory.getDouble(i))
            }
        }

        var isAnomalous = false
        var isHardInvalid = false
        if (cycleLength != null) {
            if (cycleLength < AlgoConfig.MIN_CYCLE_DAYS || cycleLength > AlgoConfig.MAX_CYCLE_DAYS) {
                isAnomalous = true
                isHardInvalid = true
            } else if (
                historicalCycles.size >= 2 &&
                abs(cycleLength.toDouble() - PyMath.median(historicalCycles)) > AlgoConfig.ANOMALY_DEVIATION_THRESHOLD
            ) {
                isAnomalous = true
            }
        }

        val allCycles = if (cycleLength != null && !isHardInvalid) {
            historicalCycles + cycleLength.toDouble()
        } else {
            historicalCycles
        }

        val newModelParams: JSONObject = if (cycleLength == null || isHardInvalid) {
            JSONObject()
                .put("mean_cycle", currentParams.get("mean_cycle"))
                .put("std_cycle", currentParams.get("std_cycle"))
                .put("n_records", currentParams.get("n_records"))
                .put("ema_cycle", currentParams.get("ema_cycle"))
                .put("prior_mean", currentParams.get("prior_mean"))
                .put("prior_std", currentParams.get("prior_std"))
                .put("prior_weight", currentParams.get("prior_weight"))
        } else {
            val prevEma = AlgoStats.replayEma(allCycles, excludeLast = true)
            val core = AlgoStats.predictCore(allCycles, prevEma)
            JSONObject()
                .put("mean_cycle", core.predictedCycle)
                .put("std_cycle", core.std)
                .put("n_records", core.n)
                .put("ema_cycle", core.newEma)
                .put("prior_mean", core.muPost)
                .put("prior_std", core.sigmaPost)
                .put("prior_weight", core.priorWeight)
                .put("n_eff", core.nEff)
                .put("dropped_illegal", core.droppedIllegal)
                .put("bayes_applied", core.bayesApplied)
                .put("shrink_irregularity", core.shrinkIrregularity)
        }

        val prediction = AlgoStats.predictNextPeriod(
            lastPeriodStartIso = newStartIso,
            cycleLengths = allCycles,
            prevEma = AlgoStats.replayEma(allCycles, excludeLast = true),
        )

        return JSONObject()
            .put("model_params", newModelParams)
            .put("prediction", prediction)
            .put("is_anomalous", isAnomalous)
            .put("is_hard_invalid", isHardInvalid)
            .put("cycle_length", cycleLength ?: JSONObject.NULL)
    }
}
