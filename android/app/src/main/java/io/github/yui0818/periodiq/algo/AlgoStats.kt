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
import kotlin.math.abs
import kotlin.math.pow
import kotlin.math.sqrt
import org.json.JSONArray
import org.json.JSONObject

/**
 * Pure-Kotlin port of `app/algo/stats.py`.
 */
object AlgoStats {

    data class PredictCoreResult(
        val legalCycles: List<Double>,
        val robustWeights: List<Double>,
        val n: Int,
        val nEff: Double,
        val window: Int,
        val latestCycle: Double?,
        val droppedIllegal: Int,
        val emaPrev: Double,
        val newEma: Double,
        val wMean: Double,
        val fused: Double,
        val muPost: Double,
        val sigmaPost: Double,
        val priorWeight: Double,
        val posteriorNEff: Double,
        val shrinkIrregularity: Double,
        val bayesApplied: Boolean,
        val predictedCycle: Double,
        val std: Double,
        val intervalDays: Double,
        val intervalNEffApplied: Boolean,
        val intervalMultApplied: Double,
        val confidence: Double,
        val stage: String,
        val modelVersion: String,
    ) {
        fun toJson(): JSONObject = JSONObject()
            .put("legal_cycles", JSONArray().also { a -> legalCycles.forEach { a.put(it) } })
            .put("robust_weights", JSONArray().also { a -> robustWeights.forEach { a.put(it) } })
            .put("n", n)
            .put("n_eff", nEff)
            .put("window", window)
            .put("latest_cycle", latestCycle ?: JSONObject.NULL)
            .put("dropped_illegal", droppedIllegal)
            .put("ema_prev", emaPrev)
            .put("new_ema", newEma)
            .put("w_mean", wMean)
            .put("fused", fused)
            .put("mu_post", muPost)
            .put("sigma_post", sigmaPost)
            .put("prior_weight", priorWeight)
            .put("posterior_n_eff", posteriorNEff)
            .put("shrink_irregularity", shrinkIrregularity)
            .put("bayes_applied", bayesApplied)
            .put("predicted_cycle", predictedCycle)
            .put("std", std)
            .put("interval_days", intervalDays)
            .put("interval_n_eff_applied", intervalNEffApplied)
            .put("interval_mult_applied", intervalMultApplied)
            .put("confidence", confidence)
            .put("stage", stage)
            .put("model_version", modelVersion)
    }

    internal fun legalCycles(cycleLengths: List<Double>): List<Double> {
        val lo = AlgoConfig.MIN_CYCLE_DAYS.toDouble()
        val hi = AlgoConfig.MAX_CYCLE_DAYS.toDouble()
        return cycleLengths.filter { it >= lo && it <= hi }
    }

    fun robustWeights(cycleLengths: List<Double>): List<Double> {
        val n = cycleLengths.size
        if (n <= 1) return List(n) { 1.0 }
        val med = PyMath.median(cycleLengths)
        val mad = PyMath.median(cycleLengths.map { abs(it - med) })
        val scale = maxOf(AlgoConfig.ROBUST_MAD_SCALE * mad, AlgoConfig.ROBUST_MIN_SCALE)
        return cycleLengths.map { c ->
            val z = abs(c - med) / scale
            val excess = maxOf(0.0, z - AlgoConfig.ROBUST_SOFT_Z)
            val w = 1.0 / (1.0 + excess * excess)
            maxOf(w, AlgoConfig.ROBUST_MIN_WEIGHT)
        }
    }

    fun effectiveSampleSize(weights: List<Double>): Double {
        var sw = 0.0
        var sw2 = 0.0
        for (w in weights) {
            sw += w
            sw2 += w * w
        }
        if (sw2 <= 0.0) return 0.0
        return sw * sw / sw2
    }

    fun weightedMean(
        cycleLengths: List<Double>,
        windowN: Int,
        decay: Double = AlgoConfig.WEIGHT_DECAY,
        extraWeights: List<Double>? = null,
    ): Double {
        val recent = if (windowN <= 0) emptyList() else cycleLengths.takeLast(windowN)
        if (recent.isEmpty()) return AlgoConfig.PRIOR_MEAN
        val len = recent.size
        val tail = extraWeights?.takeLast(len)
        var totalW = 0.0
        var weightedSum = 0.0
        for (idx in 0 until len) {
            var w = decay.pow(len - 1 - idx)
            if (tail != null) {
                w *= tail[idx]
            }
            totalW += w
            weightedSum += recent[idx] * w
        }
        if (totalW <= 0.0) return AlgoConfig.PRIOR_MEAN
        return weightedSum / totalW
    }

    fun emaUpdate(
        prevEma: Double?,
        newCycle: Double,
        alpha: Double = AlgoConfig.EMA_ALPHA,
    ): Double {
        if (prevEma == null) return newCycle
        return alpha * newCycle + (1.0 - alpha) * prevEma
    }

    internal fun sampleStdev(values: List<Double>): Double {
        val n = values.size
        require(n >= 2) { "sampleStdev requires at least 2 values" }
        val mean = values.sum() / n
        var sumSq = 0.0
        for (v in values) {
            val d = v - mean
            sumSq += d * d
        }
        return sqrt(sumSq / (n - 1))
    }

    fun cycleStd(
        cycleLengths: List<Double>,
        windowN: Int,
        extraWeights: List<Double>? = null,
    ): Double {
        val recent = if (windowN <= 0) emptyList() else cycleLengths.takeLast(windowN)
        if (recent.size < 2) return AlgoConfig.PRIOR_STD
        if (extraWeights == null) {
            return maxOf(sampleStdev(recent), AlgoConfig.MIN_STD)
        }
        val tail = extraWeights.takeLast(recent.size)
        val sw = tail.sum()
        if (sw <= 0.0) return AlgoConfig.PRIOR_STD
        var weightedSum = 0.0
        for (i in recent.indices) {
            weightedSum += recent[i] * tail[i]
        }
        val mean = weightedSum / sw
        var varianceSum = 0.0
        for (i in recent.indices) {
            val d = recent[i] - mean
            varianceSum += tail[i] * d * d
        }
        var variance = varianceSum / sw
        val nEff = effectiveSampleSize(tail)
        if (nEff > 1.0) {
            variance *= nEff / (nEff - 1.0)
        }
        return maxOf(sqrt(variance), AlgoConfig.MIN_STD)
    }

    fun replayEma(cycleLengths: List<Double>, excludeLast: Boolean = true): Double {
        val seq = if (excludeLast) cycleLengths.dropLast(1) else cycleLengths
        var ema = AlgoConfig.PRIOR_MEAN
        for (c in seq) {
            ema = emaUpdate(ema, c, AlgoConfig.EMA_ALPHA)
        }
        return ema
    }

    private fun clamp(value: Double, low: Double, high: Double): Double =
        maxOf(low, minOf(high, value))

    fun decayWeights(weights: List<Double>, decay: Double): List<Double> {
        val n = weights.size
        return List(n) { i -> weights[i] * decay.pow(n - 1 - i) }
    }

    fun normalConjugatePosterior(
        priorMean: Double,
        priorStd: Double,
        observations: List<Double>,
        minSigma: Double = AlgoConfig.MIN_STD,
        weights: List<Double>? = null,
    ): Pair<Double, Double> {
        val n = observations.size
        if (n == 0) return Pair(priorMean, priorStd)

        var xBar = observations.sum() / n
        var sigma = if (n < 2) minSigma else maxOf(sampleStdev(observations), minSigma)

        var nEff = n.toDouble()
        if (weights != null && weights.size == n) {
            val sw = weights.sum()
            if (sw > 0.0) {
                var weightedSum = 0.0
                for (i in 0 until n) {
                    weightedSum += weights[i] * observations[i]
                }
                xBar = weightedSum / sw
                nEff = effectiveSampleSize(weights)
                if (n >= 2 && nEff > 1.0) {
                    var varSum = 0.0
                    for (i in 0 until n) {
                        val d = observations[i] - xBar
                        varSum += weights[i] * d * d
                    }
                    var variance = varSum / sw
                    variance *= nEff / (nEff - 1.0)
                    sigma = maxOf(sqrt(variance), minSigma)
                } else {
                    sigma = minSigma
                }
            }
        }

        val priorVar = priorStd * priorStd
        val obsVar = sigma * sigma
        val numerator = priorMean / priorVar + nEff * xBar / obsVar
        val denominator = 1.0 / priorVar + nEff / obsVar
        return Pair(numerator / denominator, sqrt(1.0 / denominator))
    }

    fun predictCore(cycleLengths: List<Double>, prevEma: Double?): PredictCoreResult {
        val legal = legalCycles(cycleLengths)
        val n = legal.size
        val rw = robustWeights(legal)
        val nEff = if (n > 0) effectiveSampleSize(rw) else 0.0
        val window = AlgoConfig.STATS_WINDOW_N_V080

        val latestCycle: Double? = legal.lastOrNull()
        val baseEma = prevEma ?: AlgoConfig.PRIOR_MEAN

        // Step 1: weighted mean
        val wMean = weightedMean(legal, window, AlgoConfig.WEIGHT_DECAY, rw)

        // Step 2: EMA update
        val emaPrev: Double
        val newEma: Double
        if (n == 0) {
            emaPrev = baseEma
            newEma = baseEma
        } else if (n == 1) {
            emaPrev = AlgoConfig.PRIOR_MEAN
            newEma = emaUpdate(emaPrev, latestCycle!!, AlgoConfig.EMA_ALPHA)
        } else {
            emaPrev = baseEma
            newEma = emaUpdate(emaPrev, latestCycle!!, AlgoConfig.EMA_ALPHA)
        }

        // Step 3: fused prediction
        val fused = when (n) {
            0 -> AlgoConfig.PRIOR_MEAN
            1 -> latestCycle!!
            else -> (1.0 - AlgoConfig.EMA_FUSION_WEIGHT) * wMean + AlgoConfig.EMA_FUSION_WEIGHT * newEma
        }

        // Step 4 pre: std
        val std = if (n <= 1) AlgoConfig.PRIOR_STD else cycleStd(legal, window, rw)

        // Step 4: Bayesian shrinkage
        val pw = if (nEff > 0.0) 1.0 / (1.0 + nEff / AlgoConfig.PRIOR_DECAY_K) else 1.0
        val posteriorWeights = decayWeights(rw, AlgoConfig.WEIGHT_DECAY)
        val (muPost, sigmaPost) = normalConjugatePosterior(
            AlgoConfig.PRIOR_MEAN,
            AlgoConfig.PRIOR_STD,
            legal,
            AlgoConfig.MIN_STD,
            posteriorWeights,
        )
        val bayesApplied = n >= AlgoConfig.COLD_START_THRESHOLD
        val shrinkSpan = AlgoConfig.ADAPTIVE_SHRINK_IRREGULAR_STD - AlgoConfig.ADAPTIVE_SHRINK_REGULAR_STD
        val shrinkIrregularity = if (shrinkSpan > 0.0) {
            clamp((std - AlgoConfig.ADAPTIVE_SHRINK_REGULAR_STD) / shrinkSpan, 0.0, 1.0)
        } else {
            0.0
        }
        val predictedCycle = if (bayesApplied) {
            muPost + shrinkIrregularity * pw * (AlgoConfig.PRIOR_MEAN - muPost)
        } else {
            fused
        }

        // Step 5: prediction interval
        val intervalMultEff = AlgoConfig.INTERVAL_STD_MULT + AlgoConfig.INTERVAL_IRREGULAR_EXTRA * shrinkIrregularity
        val intervalNEffApplied = n > 1 && nEff >= 1.0
        val intervalDays: Double
        val intervalMultApplied: Double
        if (intervalNEffApplied) {
            intervalDays = std * intervalMultEff * sqrt(1.0 + 1.0 / nEff)
            intervalMultApplied = intervalMultEff
        } else {
            intervalDays = std * AlgoConfig.INTERVAL_STD_MULT
            intervalMultApplied = AlgoConfig.INTERVAL_STD_MULT
        }

        // Step 6: confidence
        val confidence = when (n) {
            0 -> AlgoConfig.CONFIDENCE_COLD_1
            1 -> AlgoConfig.CONFIDENCE_COLD_2
            else -> clamp(
                1.0 - std / AlgoConfig.CONFIDENCE_STD_SCALE,
                AlgoConfig.CONFIDENCE_MIN,
                AlgoConfig.CONFIDENCE_MAX,
            )
        }

        // stage / model_version mapping
        val (stage, modelVersion) = when (n) {
            0 -> Pair("empty", AlgoConfig.MODEL_VERSION_COLD_1)
            1 -> Pair("cold_1", AlgoConfig.MODEL_VERSION_COLD_2)
            2 -> Pair("cold_2", AlgoConfig.MODEL_VERSION_BAYESIAN)
            else -> Pair("bayesian", AlgoConfig.MODEL_VERSION_BAYESIAN)
        }

        return PredictCoreResult(
            legalCycles = legal,
            robustWeights = rw,
            n = n,
            nEff = nEff,
            window = window,
            latestCycle = latestCycle,
            droppedIllegal = cycleLengths.size - n,
            emaPrev = emaPrev,
            newEma = newEma,
            wMean = wMean,
            fused = fused,
            muPost = muPost,
            sigmaPost = sigmaPost,
            priorWeight = pw,
            posteriorNEff = effectiveSampleSize(posteriorWeights),
            shrinkIrregularity = shrinkIrregularity,
            bayesApplied = bayesApplied,
            predictedCycle = predictedCycle,
            std = std,
            intervalDays = intervalDays,
            intervalNEffApplied = intervalNEffApplied,
            intervalMultApplied = intervalMultApplied,
            confidence = confidence,
            stage = stage,
            modelVersion = modelVersion,
        )
    }

    fun predictNextPeriod(
        lastPeriodStartIso: String?,
        cycleLengths: List<Double>,
        prevEma: Double?,
    ): JSONObject {
        if (lastPeriodStartIso == null) {
            return JSONObject()
                .put("predicted_date", JSONObject.NULL)
                .put("predicted_start_lower", JSONObject.NULL)
                .put("predicted_start_upper", JSONObject.NULL)
                .put("confidence", 0.0)
                .put("model_version", AlgoConfig.MODEL_VERSION_NONE)
                .put(
                    "model_params",
                    JSONObject()
                        .put("mean_cycle", AlgoConfig.PRIOR_MEAN)
                        .put("std_cycle", AlgoConfig.PRIOR_STD)
                        .put("n_records", 0)
                        .put("ema_cycle", AlgoConfig.PRIOR_MEAN)
                        .put("prior_weight", 1.0),
                )
        }

        val lastPeriodStart = LocalDate.parse(lastPeriodStartIso)
        val core = predictCore(cycleLengths, prevEma)
        val intervalHalfDays = PyMath.roundHalfEven(core.intervalDays)

        val predictedDate = lastPeriodStart.plusDays(PyMath.roundHalfEven(core.predictedCycle))
        val predictedStartLower = predictedDate.minusDays(intervalHalfDays)
        val predictedStartUpper = predictedDate.plusDays(intervalHalfDays)

        return JSONObject()
            .put("predicted_date", predictedDate.toIso())
            .put("predicted_start_lower", predictedStartLower.toIso())
            .put("predicted_start_upper", predictedStartUpper.toIso())
            .put("confidence", PyMath.roundTo(core.confidence, 4))
            .put("model_version", core.modelVersion)
            .put(
                "model_params",
                JSONObject()
                    .put("mean_cycle", PyMath.roundTo(core.predictedCycle, 4))
                    .put("std_cycle", PyMath.roundTo(core.std, 4))
                    .put("n_records", core.n)
                    .put("ema_cycle", PyMath.roundTo(core.newEma, 4))
                    .put("prior_weight", PyMath.roundTo(core.priorWeight, 4))
                    .put("shrink_irregularity", PyMath.roundTo(core.shrinkIrregularity, 4))
                    .put("n_eff", PyMath.roundTo(core.nEff, 4))
                    .put("dropped_illegal", core.droppedIllegal)
                    .put("bayes_applied", core.bayesApplied),
            )
    }
}
