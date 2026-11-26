/*
 * Copyright (c) 2026 Yui_0818 (aaaj6719@gmail.com)
 * Licensed under the PolyForm Noncommercial License 1.0.0.
 * Commercial use is prohibited without separate written authorization.
 * See LICENSE and COMMERCIAL.md in the repository root.
 */

package io.github.yui0818.periodiq.algo

/**
 * Pure-Kotlin port of `app/config.py` algorithm constants.
 *
 * All tunable algorithm parameters live here (single source of truth on Android).
 * Values are strictly identical to `win/backend/app/config.py`.
 */
object AlgoConfig {

    // Prior parameters
    const val PRIOR_MEAN: Double = 28.0
    const val PRIOR_STD: Double = 7.0

    // Statistics window & decay
    const val STATS_WINDOW_N: Int = 12
    const val WEIGHT_DECAY: Double = 0.85

    // EMA parameters
    const val EMA_ALPHA: Double = 0.3
    const val EMA_FUSION_WEIGHT: Double = 0.4

    // Prediction interval
    const val INTERVAL_STD_MULT: Double = 1.5

    // Bayesian prior decay
    const val PRIOR_DECAY_K: Double = 5.0

    // Cycle legality bounds
    const val MIN_CYCLE_DAYS: Int = 7
    const val MAX_CYCLE_DAYS: Int = 90

    // Anomaly detection
    const val ANOMALY_DEVIATION_THRESHOLD: Int = 14
    const val ANOMALY_CONSECUTIVE_THRESHOLD: Int = 3

    // Minimum std floor
    const val MIN_STD: Double = 2.0

    // Cold-start threshold (minimum legal cycle count for Bayesian branch)
    const val COLD_START_THRESHOLD: Int = 3

    // Notification default
    const val NOTIFY_DAYS_DEFAULT: Int = 3

    // Confidence bounds & cold-start values
    const val CONFIDENCE_MIN: Double = 0.3
    const val CONFIDENCE_MAX: Double = 0.95
    const val CONFIDENCE_COLD_0: Double = 0.3
    const val CONFIDENCE_COLD_1: Double = 0.4
    const val CONFIDENCE_COLD_2: Double = 0.5
    const val CONFIDENCE_STD_SCALE: Double = 14.0

    // Model version identifiers
    const val MODEL_VERSION_NONE: String = "none"
    const val MODEL_VERSION_COLD_1: String = "cold_start_1"
    const val MODEL_VERSION_COLD_2: String = "cold_start_2"
    const val MODEL_VERSION_BAYESIAN: String = "bayesian_v1"

    // v0.8.0 effective window & robust reweighting
    const val STATS_WINDOW_N_V080: Int = 6
    const val ROBUST_MAD_SCALE: Double = 1.4826
    const val ROBUST_MIN_SCALE: Double = 2.0
    const val ROBUST_SOFT_Z: Double = 1.5
    const val ROBUST_MIN_WEIGHT: Double = 0.15

    // Stale prediction grace days
    const val PREDICTION_STALE_GRACE_DAYS: Int = 0

    // Ovulation / fertility calendar-rule constants
    const val LUTEAL_PHASE_DAYS: Int = 14
    const val FERTILE_PRE_OVULATION_DAYS: Int = 5
    const val FERTILE_POST_OVULATION_DAYS: Int = 1

    // v0.8.1 adaptive secondary shrinkage endpoints
    const val ADAPTIVE_SHRINK_REGULAR_STD: Double = 3.0
    const val ADAPTIVE_SHRINK_IRREGULAR_STD: Double = 7.0

    // Clinical observation thresholds
    const val CLINICAL_CYCLE_MIN_DAYS: Int = 21
    const val CLINICAL_CYCLE_MAX_DAYS: Int = 35
    const val CLINICAL_PERIOD_MAX_DAYS: Int = 8
    const val OVERDUE_NOTICE_DAYS: Int = 7
    const val CLINICAL_WINDOW: Int = 6

    // v0.10.0 interval calibration
    const val INTERVAL_IRREGULAR_EXTRA: Double = 0.5

    // Drift tolerances
    const val MODEL_PARAMS_DRIFT_EPS: Double = 0.01
    const val MODEL_PARAMS_DRIFT_EPS_PRIOR_WEIGHT: Double = 0.001

    // Product / gate identifiers
    const val PRODUCT_NAME: String = "PeriodIQ"
    const val DATA_ANOMALY_CODE: String = "DATA_ANOMALY"
    const val API_PREFIX: String = "/api/v1"

    private val numberMap: Map<String, Double> = mapOf(
        "PRIOR_MEAN" to PRIOR_MEAN,
        "PRIOR_STD" to PRIOR_STD,
        "STATS_WINDOW_N" to STATS_WINDOW_N.toDouble(),
        "WEIGHT_DECAY" to WEIGHT_DECAY,
        "EMA_ALPHA" to EMA_ALPHA,
        "EMA_FUSION_WEIGHT" to EMA_FUSION_WEIGHT,
        "INTERVAL_STD_MULT" to INTERVAL_STD_MULT,
        "PRIOR_DECAY_K" to PRIOR_DECAY_K,
        "MIN_CYCLE_DAYS" to MIN_CYCLE_DAYS.toDouble(),
        "MAX_CYCLE_DAYS" to MAX_CYCLE_DAYS.toDouble(),
        "ANOMALY_DEVIATION_THRESHOLD" to ANOMALY_DEVIATION_THRESHOLD.toDouble(),
        "ANOMALY_CONSECUTIVE_THRESHOLD" to ANOMALY_CONSECUTIVE_THRESHOLD.toDouble(),
        "MIN_STD" to MIN_STD,
        "COLD_START_THRESHOLD" to COLD_START_THRESHOLD.toDouble(),
        "NOTIFY_DAYS_DEFAULT" to NOTIFY_DAYS_DEFAULT.toDouble(),
        "CONFIDENCE_MIN" to CONFIDENCE_MIN,
        "CONFIDENCE_MAX" to CONFIDENCE_MAX,
        "CONFIDENCE_COLD_0" to CONFIDENCE_COLD_0,
        "CONFIDENCE_COLD_1" to CONFIDENCE_COLD_1,
        "CONFIDENCE_COLD_2" to CONFIDENCE_COLD_2,
        "CONFIDENCE_STD_SCALE" to CONFIDENCE_STD_SCALE,
        "STATS_WINDOW_N_V080" to STATS_WINDOW_N_V080.toDouble(),
        "ROBUST_MAD_SCALE" to ROBUST_MAD_SCALE,
        "ROBUST_MIN_SCALE" to ROBUST_MIN_SCALE,
        "ROBUST_SOFT_Z" to ROBUST_SOFT_Z,
        "ROBUST_MIN_WEIGHT" to ROBUST_MIN_WEIGHT,
        "PREDICTION_STALE_GRACE_DAYS" to PREDICTION_STALE_GRACE_DAYS.toDouble(),
        "LUTEAL_PHASE_DAYS" to LUTEAL_PHASE_DAYS.toDouble(),
        "FERTILE_PRE_OVULATION_DAYS" to FERTILE_PRE_OVULATION_DAYS.toDouble(),
        "FERTILE_POST_OVULATION_DAYS" to FERTILE_POST_OVULATION_DAYS.toDouble(),
        "ADAPTIVE_SHRINK_REGULAR_STD" to ADAPTIVE_SHRINK_REGULAR_STD,
        "ADAPTIVE_SHRINK_IRREGULAR_STD" to ADAPTIVE_SHRINK_IRREGULAR_STD,
        "CLINICAL_CYCLE_MIN_DAYS" to CLINICAL_CYCLE_MIN_DAYS.toDouble(),
        "CLINICAL_CYCLE_MAX_DAYS" to CLINICAL_CYCLE_MAX_DAYS.toDouble(),
        "CLINICAL_PERIOD_MAX_DAYS" to CLINICAL_PERIOD_MAX_DAYS.toDouble(),
        "OVERDUE_NOTICE_DAYS" to OVERDUE_NOTICE_DAYS.toDouble(),
        "CLINICAL_WINDOW" to CLINICAL_WINDOW.toDouble(),
        "INTERVAL_IRREGULAR_EXTRA" to INTERVAL_IRREGULAR_EXTRA,
        "MODEL_PARAMS_DRIFT_EPS" to MODEL_PARAMS_DRIFT_EPS,
        "MODEL_PARAMS_DRIFT_EPS_PRIOR_WEIGHT" to MODEL_PARAMS_DRIFT_EPS_PRIOR_WEIGHT,
    )

    private val intMap: Map<String, Int> = mapOf(
        "STATS_WINDOW_N" to STATS_WINDOW_N,
        "MIN_CYCLE_DAYS" to MIN_CYCLE_DAYS,
        "MAX_CYCLE_DAYS" to MAX_CYCLE_DAYS,
        "ANOMALY_DEVIATION_THRESHOLD" to ANOMALY_DEVIATION_THRESHOLD,
        "ANOMALY_CONSECUTIVE_THRESHOLD" to ANOMALY_CONSECUTIVE_THRESHOLD,
        "COLD_START_THRESHOLD" to COLD_START_THRESHOLD,
        "NOTIFY_DAYS_DEFAULT" to NOTIFY_DAYS_DEFAULT,
        "STATS_WINDOW_N_V080" to STATS_WINDOW_N_V080,
        "PREDICTION_STALE_GRACE_DAYS" to PREDICTION_STALE_GRACE_DAYS,
        "LUTEAL_PHASE_DAYS" to LUTEAL_PHASE_DAYS,
        "FERTILE_PRE_OVULATION_DAYS" to FERTILE_PRE_OVULATION_DAYS,
        "FERTILE_POST_OVULATION_DAYS" to FERTILE_POST_OVULATION_DAYS,
        "CLINICAL_CYCLE_MIN_DAYS" to CLINICAL_CYCLE_MIN_DAYS,
        "CLINICAL_CYCLE_MAX_DAYS" to CLINICAL_CYCLE_MAX_DAYS,
        "CLINICAL_PERIOD_MAX_DAYS" to CLINICAL_PERIOD_MAX_DAYS,
        "OVERDUE_NOTICE_DAYS" to OVERDUE_NOTICE_DAYS,
        "CLINICAL_WINDOW" to CLINICAL_WINDOW,
    )

    private val textMap: Map<String, String> = mapOf(
        "MODEL_VERSION_NONE" to MODEL_VERSION_NONE,
        "MODEL_VERSION_COLD_1" to MODEL_VERSION_COLD_1,
        "MODEL_VERSION_COLD_2" to MODEL_VERSION_COLD_2,
        "MODEL_VERSION_BAYESIAN" to MODEL_VERSION_BAYESIAN,
        "PRODUCT_NAME" to PRODUCT_NAME,
        "DATA_ANOMALY_CODE" to DATA_ANOMALY_CODE,
        "API_PREFIX" to API_PREFIX,
    )

    fun number(name: String): Double =
        requireNotNull(numberMap[name]) { "config.$name 取不到" }

    fun int(name: String): Int =
        requireNotNull(intMap[name]) { "config.$name 取不到" }

    fun text(name: String): String =
        requireNotNull(textMap[name]) { "config.$name 取不到" }
}
