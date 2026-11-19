package io.github.yui0818.periodiq.domain.model

import java.time.LocalDate
import io.github.yui0818.periodiq.PyMath
import io.github.yui0818.periodiq.toIso

/**
 * 一条待回填的预测行（只带判定所需的最小字段）：**纯逻辑输入**，不依赖数据库。
 * [currentActualDate] / [currentErrorDays] 是库内现值，用于"值不变不写"的幂等判定。
 */
data class PredictionBackfillRow(
    val predictionId: Long,
    val predictedDate: LocalDate,
    val currentActualDate: String?,
    val currentErrorDays: Long?,
)

/** 需要写回的一行：由 [PredictionActualBackfill.plan] 产出，调用方只负责落库。 */
data class PredictionActualUpdate(
    val predictionId: Long,
    val actualDate: String,
    val errorDays: Long,
)

/**
 * 按当前真实记录日期重推预测的 `actual_date` / `error_days`（单一实现）。
 *
 * 对照点：`Win/backend/app/prediction_service.py::rebackfill_prediction_actuals`。
 * 调用方有两条：cycles 修正/补录管线（`PiqRouter.recomputeAllRecords`）与
 * 导入事务（`PiqRouter.applyImport`，在 `regenerateCurrentPrediction` 之前）。
 *
 * 口径（与 Win 逐条一致，且不新增"清空"语义）：
 * - `startsAsc` = 导入/当前 cycles 的 `period_start` **升序**；
 * - 锚点 = `predicted_date` **严格之前**的最后一条 start，`idx` = 第一条 `start >= predicted_date`
 *   的下标（二分 = Python `bisect_left`）；`idx == 0`（无锚点）或 `idx >= size`（无后继）⇒ 跳过；
 * - 实际来潮日 = `startsAsc[idx]`，`error_days = |actual - predicted|` 天；
 * - 库内 actual/error 与推算值相同 ⇒ 不产出更新（幂等：重复调用返回空）。
 */
object PredictionActualBackfill {

    fun plan(
        startsAsc: List<LocalDate>,
        predictions: List<PredictionBackfillRow>,
    ): List<PredictionActualUpdate> {
        if (startsAsc.isEmpty()) return emptyList()
        val updates = mutableListOf<PredictionActualUpdate>()
        for (prediction in predictions) {
            val idx = firstNotBefore(startsAsc, prediction.predictedDate)
            if (idx == 0 || idx >= startsAsc.size) continue
            val actualDate = startsAsc[idx]
            val actualIso = actualDate.toIso()
            val errorDays = kotlin.math.abs(PyMath.daysBetween(prediction.predictedDate, actualDate))
            if (prediction.currentActualDate == actualIso && prediction.currentErrorDays == errorDays) continue
            updates += PredictionActualUpdate(prediction.predictionId, actualIso, errorDays)
        }
        return updates
    }

    /** 第一条 `>= target` 的下标（Python `bisect_left`）；[startsAsc] 必须升序。 */
    private fun firstNotBefore(startsAsc: List<LocalDate>, target: LocalDate): Int {
        var low = 0
        var high = startsAsc.size
        while (low < high) {
            val mid = (low + high) ushr 1
            if (startsAsc[mid] < target) low = mid + 1 else high = mid
        }
        return low
    }
}
