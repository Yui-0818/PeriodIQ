/*
 * Copyright (c) 2026 Yui_0818 (aaaj6719@gmail.com)
 * Licensed under the PolyForm Noncommercial License 1.0.0.
 * Commercial use is prohibited without separate written authorization.
 * See LICENSE and COMMERCIAL.md in the repository root.
 */

package io.github.yui0818.periodiq.algo

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * Pure-Kotlin algorithm facade (replaces the former Chaquopy bridge).
 *
 * Public method signatures and returned JSON shapes are 100% compatible with
 * the previous Python-backed implementation, verified via Golden Vectors in
 * `AlgoGoldenTest`.
 */
object PiqAlgo {

    /** No-op in pure Kotlin; always ready immediately without Python startup overhead. */
    fun ensureStarted(@Suppress("UNUSED_PARAMETER") context: Context): Boolean = true

    /** `replay_ema(cycle_lengths, config, exclude_last)` -> Double. */
    fun replayEma(cycleLengths: List<Double>, excludeLast: Boolean): Double =
        AlgoStats.replayEma(cycleLengths, excludeLast)

    /** `predict_core(cycle_lengths, prev_ema, config)` -> JSONObject. */
    fun predictCore(cycleLengths: List<Double>, prevEma: Double?): JSONObject =
        AlgoStats.predictCore(cycleLengths, prevEma).toJson()

    /**
     * `predict_next_period(last_period_start, cycle_lengths, prev_ema, config)` -> JSONObject.
     * `lastPeriodStartIso == null` returns the empty-prediction contract.
     */
    fun predictNextPeriod(lastPeriodStartIso: String?, cycleLengths: List<Double>, prevEma: Double?): JSONObject =
        AlgoStats.predictNextPeriod(lastPeriodStartIso, cycleLengths, prevEma)

    /**
     * `on_new_cycle_added(new_period_start, prev_period_start, current_params, config)` -> JSONObject.
     */
    fun onNewCycleAdded(newStartIso: String, prevStartIso: String?, currentParams: JSONObject): JSONObject =
        AlgoBayesian.onNewCycleAdded(newStartIso, prevStartIso, currentParams)

    /** `evaluate_predictions(predictions, n_days=None)` -> JSONObject. */
    fun evaluatePredictions(predictions: JSONArray): JSONObject =
        AlgoEval.evaluatePredictions(predictions)

    /** `compute_fertility_window(...)` -> JSONObject. */
    fun computeFertilityWindow(
        predictedPeriodDateIso: String?,
        currentPeriodStartIso: String?,
        currentPeriodEndIso: String?,
        cycleStd: Double,
        predictedPeriodDays: Int?,
    ): JSONObject = AlgoFertility.computeFertilityWindow(
        predictedPeriodDateIso = predictedPeriodDateIso,
        currentPeriodStartIso = currentPeriodStartIso,
        currentPeriodEndIso = currentPeriodEndIso,
        cycleStd = cycleStd,
        predictedPeriodDays = predictedPeriodDays,
    )

    /** Runtime engine identifier (kept for log compatibility after Chaquopy removal). */
    fun pythonVersion(): String = "kotlin-native"

    /** `trace.prediction_trace(last_period_start, cycle_lengths, prev_ema, model_params, config)` -> JSONObject. */
    fun predictionTrace(
        lastPeriodStartIso: String,
        cycleLengths: List<Double>,
        prevEma: Double?,
        modelParams: JSONObject,
    ): JSONObject = AlgoTrace.predictionTrace(lastPeriodStartIso, cycleLengths, prevEma, modelParams)

    /** Algorithm numeric constant lookup (mirrors `app.config`). */
    fun configNumber(name: String): Double = AlgoConfig.number(name)

    /** Algorithm integer constant lookup (mirrors `app.config`). */
    fun configInt(name: String): Int = AlgoConfig.int(name)

    /** Algorithm string constant lookup (mirrors `app.config`). */
    fun configText(name: String): String = AlgoConfig.text(name)
}
