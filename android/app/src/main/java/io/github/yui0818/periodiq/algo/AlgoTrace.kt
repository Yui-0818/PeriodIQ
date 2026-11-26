/*
 * Copyright (c) 2026 Yui_0818 (aaaj6719@gmail.com)
 * Licensed under the PolyForm Noncommercial License 1.0.0.
 * Commercial use is prohibited without separate written authorization.
 * See LICENSE and COMMERCIAL.md in the repository root.
 */

package io.github.yui0818.periodiq.algo

import io.github.yui0818.periodiq.PyMath
import kotlin.math.sqrt
import org.json.JSONArray
import org.json.JSONObject

/**
 * Pure-Kotlin port of `app/algo/trace.py`.
 */
object AlgoTrace {

    private fun r(value: Double, digits: Int): Double = PyMath.roundTo(value, digits)

    fun predictionTrace(
        @Suppress("UNUSED_PARAMETER") lastPeriodStartIso: String,
        cycleLengths: List<Double>,
        prevEma: Double?,
        @Suppress("UNUSED_PARAMETER") modelParams: JSONObject,
    ): JSONObject {
        val core = AlgoStats.predictCore(cycleLengths, prevEma)
        val n = core.n
        val steps = JSONArray()
        val intervalNEffApplied = core.intervalNEffApplied
        val irr = core.shrinkIrregularity
        val irrExtraApplied = intervalNEffApplied && irr > 0.0

        // Step 1: 加权平均
        val recentCycles = core.legalCycles.takeLast(core.window)
        val recentWeights = core.robustWeights.takeLast(core.window)
        val wParts = recentCycles.zip(recentWeights).joinToString(", ") { (c, w) ->
            "${PyMath.generalFormat(c)}×${PyMath.fixedFormat(w, 2)}"
        }
        steps.put(
            JSONObject()
                .put("step", 1)
                .put("name", "加权平均")
                .put("value", r(core.wMean, 2))
                .put(
                    "formula",
                    "weighted_mean(cycles, N=${core.window}, decay=${AlgoConfig.WEIGHT_DECAY}, robust_weights)",
                )
                .put(
                    "description",
                    "最近${core.window}次周期加权平均，异常值按偏离程度降权而非丢弃" +
                        if (wParts.isNotEmpty()) "（$wParts）" else "",
                ),
        )

        // Step 2: EMA更新
        val desc2 = when (n) {
            0 -> "EMA学习率${AlgoConfig.EMA_ALPHA}；无合法周期（n=0），EMA 保持 ${r(core.newEma, 2)} 不更新"
            1 -> "EMA学习率${AlgoConfig.EMA_ALPHA}；冷启动种子 prev 取先验均值 ${AlgoConfig.PRIOR_MEAN}（n=1 时忽略传入的 prev_ema）"
            else -> "EMA学习率${AlgoConfig.EMA_ALPHA}"
        }
        steps.put(
            JSONObject()
                .put("step", 2)
                .put("name", "EMA更新")
                .put("value", r(core.newEma, 2))
                .put(
                    "formula",
                    "ema_update(prev=${r(core.emaPrev, 2)}, new=${core.latestCycle ?: "None"}, alpha=${AlgoConfig.EMA_ALPHA})",
                )
                .put("description", desc2),
        )

        // Step 3: 融合预测
        val desc3: String
        val formula3: String
        when (n) {
            0 -> {
                desc3 = "尚无有效周期（只有锚点记录），使用先验默认值28天"
                formula3 = "先验均值 ${AlgoConfig.PRIOR_MEAN}（冷启动，无周期数据）"
            }
            1 -> {
                desc3 = "仅有1个有效周期，直接使用该周期长度"
                formula3 = "最近周期长度 ${PyMath.generalFormat(core.latestCycle!!)}（冷启动，1个有效周期）"
            }
            2 -> {
                desc3 = "加权平均与EMA的加权融合（冷启动 n=2，本值即为最终预测）"
                formula3 = "(1-${AlgoConfig.EMA_FUSION_WEIGHT})*${r(core.wMean, 2)} + " +
                    "${AlgoConfig.EMA_FUSION_WEIGHT}*${r(core.newEma, 2)}"
            }
            else -> {
                desc3 = "加权平均与EMA的加权融合 —— **仅供审计**：n≥${AlgoConfig.COLD_START_THRESHOLD} 时最终预测由下一步" +
                    "直接对历史周期求共轭后验，不使用本值"
                formula3 = "(1-${AlgoConfig.EMA_FUSION_WEIGHT})*${r(core.wMean, 2)} + " +
                    "${AlgoConfig.EMA_FUSION_WEIGHT}*${r(core.newEma, 2)}（未进入最终预测）"
            }
        }
        steps.put(
            JSONObject()
                .put("step", 3)
                .put("name", "融合预测")
                .put("value", r(core.fused, 2))
                .put("formula", formula3)
                .put("description", desc3),
        )

        // Step 4: 贝叶斯调整
        if (n == 0 || n >= AlgoConfig.COLD_START_THRESHOLD) {
            val auditTail = "（本步直接对全部 $n 个合法周期求后验，不消费上一步的融合值 ${r(core.fused, 2)}；" +
                "后验权重＝鲁棒降权×时间衰减 ${AlgoConfig.WEIGHT_DECAY}，" +
                "后验有效样本量 ${r(core.posteriorNEff, 2)}；" +
                "审计用先验权重 ${r(core.priorWeight * 100.0, 1)}%" +
                "——本档离散度未达附加收缩阈值，该权重只作审计、不进入点预测）"
            val desc4: String
            val formula4: String
            if (!core.bayesApplied) {
                desc4 = "无周期数据，后验退化为先验均值（与实际预测一致）"
                formula4 = "无合法周期 → 不执行共轭后验与附加收缩，直接取先验均值 ${AlgoConfig.PRIOR_MEAN}"
            } else if (irr <= 0.0) {
                desc4 = "共轭后验均值即为最终预测周期：窗口离散度低于规律阈值 " +
                    "${AlgoConfig.ADAPTIVE_SHRINK_REGULAR_STD} 天，不附加先验收缩" + auditTail
                formula4 = "normal_conjugate_posterior(mu_0=${AlgoConfig.PRIOR_MEAN}, " +
                    "sigma_0=${AlgoConfig.PRIOR_STD}, obs=全部合法周期(${n}个), " +
                    "w=robust_weights×decay^Δ(${AlgoConfig.WEIGHT_DECAY}), " +
                    "n_eff=${r(core.posteriorNEff, 2)})"
            } else {
                desc4 = "周期离散度较高（加权 std=${r(core.std, 2)} 天），" +
                    "按离散度比例附加先验收缩 ${r(irr * core.priorWeight * 100.0, 1)}%：" +
                    "后验 ${r(core.muPost, 2)} → 最终 ${r(core.predictedCycle, 2)}"
                formula4 = "normal_conjugate_posterior(mu_0=${AlgoConfig.PRIOR_MEAN}, " +
                    "sigma_0=${AlgoConfig.PRIOR_STD}, obs=全部合法周期(${n}个), " +
                    "w=robust_weights×decay^Δ(${AlgoConfig.WEIGHT_DECAY}), " +
                    "n_eff=${r(core.posteriorNEff, 2)})" +
                    " + ${r(irr, 2)}·pw·(${AlgoConfig.PRIOR_MEAN} − mu_post)"
            }
            steps.put(
                JSONObject()
                    .put("step", 4)
                    .put("name", "贝叶斯调整")
                    .put("value", r(core.predictedCycle, 2))
                    .put("formula", formula4)
                    .put("description", desc4),
            )
        }

        // Step 5: 预测区间
        val intervalExtra = AlgoConfig.INTERVAL_IRREGULAR_EXTRA
        val nEffFactor: Double
        val multFormula: String
        val desc5Extra: String
        if (intervalNEffApplied) {
            nEffFactor = r(sqrt(1.0 + 1.0 / core.nEff), 3)
            if (irrExtraApplied) {
                multFormula = "${AlgoConfig.INTERVAL_STD_MULT}+${intervalExtra}·irr(${r(irr, 2)})=${r(core.intervalMultApplied, 3)}"
                desc5Extra = "；含小样本不确定性展宽 √(1+1/n_eff)（F4 校准）与不规律附加展宽（irr=${r(irr, 2)}）"
            } else {
                multFormula = "${AlgoConfig.INTERVAL_STD_MULT}（irr=0，无附加展宽）"
                desc5Extra = "；含小样本不确定性展宽 √(1+1/n_eff)（F4 校准）"
            }
        } else {
            nEffFactor = 1.0
            val reason = if (n <= 1) {
                "冷启动，有效周期不足 2 个"
            } else {
                "极端降权，n_eff=${r(core.nEff, 2)}<1"
            }
            multFormula = "${AlgoConfig.INTERVAL_STD_MULT}（未叠加展宽修正：$reason）"
            desc5Extra = "；未叠加展宽修正（区间 = std·INTERVAL_STD_MULT：$reason）"
        }
        val droppedSuffix = if (core.droppedIllegal > 0) {
            "；${core.droppedIllegal} 个非法周期（<${AlgoConfig.MIN_CYCLE_DAYS}或>${AlgoConfig.MAX_CYCLE_DAYS}天）已剔除"
        } else {
            ""
        }
        steps.put(
            JSONObject()
                .put("step", 5)
                .put("name", "预测区间")
                .put("value", "${r(core.predictedCycle, 1)} ± ${r(core.intervalDays, 1)} 天")
                .put("formula", "std=${r(core.std, 2)}, mult=$multFormula, n_eff修正=$nEffFactor")
                .put(
                    "description",
                    "标准差${r(core.std, 2)}（加权，含降权样本），区间半宽${r(core.intervalDays, 1)}天" +
                        desc5Extra + droppedSuffix,
                ),
        )

        // Step 6: 置信度
        val confFormula = when (n) {
            0 -> "冷启动置信度 ${AlgoConfig.CONFIDENCE_COLD_1}（无有效周期，按 1 条记录档）"
            1 -> "冷启动置信度 ${AlgoConfig.CONFIDENCE_COLD_2}（1 个有效周期，按 2 条记录档）"
            else -> "clamp(1.0 - ${r(core.std, 2)}/${AlgoConfig.CONFIDENCE_STD_SCALE}, " +
                "${AlgoConfig.CONFIDENCE_MIN}, ${AlgoConfig.CONFIDENCE_MAX})"
        }
        steps.put(
            JSONObject()
                .put("step", 6)
                .put("name", "置信度")
                .put("value", r(core.confidence, 3))
                .put("formula", confFormula)
                .put("description", "标准差越小置信度越高"),
        )

        return JSONObject()
            .put("steps", steps)
            .put(
                "final_prediction",
                JSONObject()
                    .put("predicted_cycle_length", r(core.predictedCycle, 2))
                    .put("confidence", r(core.confidence, 3))
                    .put("std", r(core.std, 2))
                    .put("interval", r(core.intervalDays, 1)),
            )
            .put("algorithm_stage", core.stage)
            .put("bayes_applied", core.bayesApplied)
            .put("n", core.n)
            .put("model_version", core.modelVersion)
    }
}
