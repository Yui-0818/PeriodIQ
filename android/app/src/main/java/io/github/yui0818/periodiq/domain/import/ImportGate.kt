package io.github.yui0818.periodiq.domain.import

import java.time.LocalDate
import org.json.JSONArray
import org.json.JSONObject
import io.github.yui0818.periodiq.PiqConfig
import io.github.yui0818.periodiq.PyMath
import io.github.yui0818.periodiq.api.contract.ApiError
import io.github.yui0818.periodiq.api.contract.validationError
import io.github.yui0818.periodiq.data.DailyRecordRow
import io.github.yui0818.periodiq.strictDoubleOrNull
import io.github.yui0818.periodiq.strictTextOrNull
import io.github.yui0818.periodiq.toIso

/**
 * 导入异常门禁 G1-G5（桌面 `app/services/gate.py::evaluate_gate` 的移植，阈值取
 * [PiqConfig] 同源常量；判据不得放宽）。
 *
 * 与桌面同口径的四处细节：① 派生周期长度与 G4 相邻间隔必须按**日历升序**算，
 * 不能用列表下标（导入顺序任意：备份/CSV/手改都不保证顺序；同日开始日按稳定排序
 * 保留输入序）；② 基线（[baselineCycleLengths]）**只用待导入数据自身**派生，无基线时
 * G3/G4 一律不适用（修 #32：导入是清空重建的全量替换，不再拿库内旧周期当中位数）；
 * ③ 输出顺序 = 输入序，同一条记录内 G1→G5；④ 日期解析与导入结构校验**同源**
 * （[PyMath.parseDateFromIsoFormat]：YYYY-MM-DD / YYYYMMDD / YYYY-Www-d），
 * 非字符串/非法日期仍由逐条结构校验 400，门禁只跳过——不改变"只判定不报错"的定位。
 */
object ImportGate {

    /**
     * 导入体里**日期字段的 JSON 键 → 文案标签**对照表（R9 的 R8-B1：生产调用点必须从这里取，
     * 不再各写一遍字面量）。R8 把两者合成一个参数时，`row.has("cycles[].period_start")` 恒假
     * ⇒ 任何合法备份都吃 400；而当时的单测给的是真实键，所以 80 条全绿也没接住（L2 第 1 轮 F-1）。
     * 现在：调用点用常量，哨兵验"标签的最后一段必须等于键"，写反就红。
     */
    val IMPORT_DATE_FIELDS = listOf(
        ImportDateField("period_start", "cycles[].period_start"),
        ImportDateField("period_end", "cycles[].period_end"),
        ImportDateField("predicted_date", "predictions[].predicted_date"),
        ImportDateField("predicted_start_upper", "predictions[].predicted_start_upper"),
        ImportDateField("predicted_start_lower", "predictions[].predicted_start_lower"),
        ImportDateField("actual_date", "predictions[].actual_date"),
    )

    /**
     * 一个导入日期字段：`key` 是备份里的 JSON 键（**唯一取值依据**），`label` 只进错误文案。
     * 取值方法挂在字段上 ⇒ 调用点写不出"把标签当键"这种形态（R8 的 R8-B1 就是这么坏的）。
     */
    data class ImportDateField(val key: String, val label: String) {
        /** 必填：键缺失 / null / 空串 / 垃圾形态都抛 400 `INVALID_IMPORT`，文案用本字段的 label。 */
        fun require(row: JSONObject): java.time.LocalDate = ImportGate.requireImportDate(row, key, label)

        /** 选填：只有键缺失或显式 JSON null 合法（返回 null）。 */
        fun optional(row: JSONObject): java.time.LocalDate? = ImportGate.optionalImportDate(row, key, label)
    }

    /** 表里每个字段的具名入口（调用点用名字，不用下标）。 */
    val CYCLE_START = IMPORT_DATE_FIELDS[0]
    val CYCLE_END = IMPORT_DATE_FIELDS[1]
    val PRED_DATE = IMPORT_DATE_FIELDS[2]
    val PRED_UPPER = IMPORT_DATE_FIELDS[3]
    val PRED_LOWER = IMPORT_DATE_FIELDS[4]
    val PRED_ACTUAL = IMPORT_DATE_FIELDS[5]


    private const val G1 = "G1"
    private const val G2 = "G2"
    private const val G3 = "G3"
    private const val G4 = "G4"
    private const val G5 = "G5"

    private val EXPECTED = mapOf(
        G1 to "${PiqConfig.GATE_CYCLE_MIN_DAYS}–${PiqConfig.GATE_CYCLE_MAX_DAYS} 天",
        G2 to "不晚于今天",
        // 修 #32：基线改为「本次导入数据自身」，EXPECTED 同步去掉「历史」二字（与 Win 逐字一致）。
        G3 to "偏离中位数不超过 ${PiqConfig.GATE_HISTORY_DEVIATION_DAYS.toInt()} 天",
        G4 to "相邻开始日间隔不超过 ${PiqConfig.GATE_GAP_MAX_DAYS.toInt()} 天",
        G5 to "${PiqConfig.GATE_PERIOD_MIN_DAYS}–${PiqConfig.GATE_PERIOD_MAX_DAYS} 天",
    )

    /**
     * 桌面 `f"{cycle_length:.0f}"` 的口径：Python 的 format 用**四舍六入五取偶**，
     * 而 `${x.toInt()}` 是**向零截断**（R9.1 实测：6.7 桌面印 `7`、截断印 `6`；6.5 桌面印 `6`、截断印 `6`）
     * ⇒ 异常文案里的天数必须走这一条，不能直接 `.toInt()`。
     */
    internal fun pyDays(value: Double): String =
        java.math.BigDecimal.valueOf(value).setScale(0, java.math.RoundingMode.HALF_EVEN).toPlainString()

    /**
     * 桌面 `f"{x:.1f}"` 的口径：一位小数，且**不跟设备 locale** ——
     * `"...%.1f...".format(...)` 用的是 `Locale.getDefault()`，在 `de_DE`/`fr_FR` 下会印成 `22,3`
     * （同仓库 `ImportBodyGate.kt:40` 与下面那行都已锁 `Locale.US` ⇒ 这类调用点共两处，无漏网）。
     */
    internal fun pyDays1(value: Double): String = String.format(java.util.Locale.US, "%.1f", value)

    /**
     * G1-G5 评估。`cycles` 的每一项是 **(原始下标, 对象)** 配对（2026-10-26 修 P2 导入 #N 标签错位）：
     * 桌面 `enumerate(cycles)` 保留原始下标、非 dict 条目跳过；安卓此前在路由侧
     * `mapNotNull { optJSONObject(it) }` 先把非对象条目丢掉再传入 ⇒ `entry.idx` 是**过滤后**位置，
     * `#N` 标签与备份文件错位。调用点（PiqRouter）改用带原始下标的枚举，非对象条目本身
     * 仍由逐条严格校验拒（422），这里只保证下标不错位。
     *
     * 第二个参数是 **G3/G4 基线**（修 #32）：由 [baselineCycleLengths] 从**待导入数据自身**
     * 派生，调用点不得再传库内 `getAllValidCycleLengths` 的结果。空基线 ⇒ G3/G4 不适用。
     * 取值口径（provided cycle_length 优先、否则按日历序相邻开始日派生）与
     * [baselineCycleLengths] 共用 [deriveCalendar] / [effectiveCycleLength]，只此一份。
     *
     * 数值字段（cycle_length / period_days）走 [strictDoubleOrNull]：只认 JSON Number，
     * 字符串一律视为无值（2026-10-26 修 P2，桌面 `_as_number` 同口径）。
     */
    fun evaluate(
        cycles: List<Pair<Int, JSONObject>>,
        baselineCycleLengths: List<Double>,
        today: LocalDate,
    ): JSONArray {
        val anomalies = JSONArray()
        val baselineMedian = if (baselineCycleLengths.isEmpty()) null else PyMath.median(baselineCycleLengths)
        val hasBaseline = baselineMedian != null

        val calendar = deriveCalendar(cycles)

        for (entry in calendar.entries) {
            val row = entry.row
            val providedDays = row.strictDoubleOrNull("period_days")
            val cycleLength = effectiveCycleLength(entry, calendar.derivedLength)
            val periodDays = when {
                providedDays != null -> providedDays
                entry.start != null && entry.end != null -> (PyMath.daysBetween(entry.start, entry.end) + 1).toDouble()
                else -> null
            }
            val label = entry.start?.toIso() ?: "#${entry.idx + 1}"

            if (cycleLength != null &&
                (cycleLength < PiqConfig.GATE_CYCLE_MIN_DAYS || cycleLength > PiqConfig.GATE_CYCLE_MAX_DAYS)
            ) {
                anomalies.put(anomaly(G1, cycleLength,
                    "记录 $label 的周期长度 ${pyDays(cycleLength)} 天超出常见范围" +
                        "（${PiqConfig.GATE_CYCLE_MIN_DAYS}–${PiqConfig.GATE_CYCLE_MAX_DAYS} 天）", "cycle_length"))
            }
            listOf(("开始日期" to entry.start), ("结束日期" to entry.end)).forEach { (labelDate, d) ->
                if (d != null && d > today) {
                    anomalies.put(anomaly(G2, d.toIso(),
                        "记录 $label 的$labelDate ${d.toIso()} 晚于今天（${today.toIso()}）",
                        if (labelDate == "开始日期") "period_start" else "period_end"))
                }
            }
            if (hasBaseline && cycleLength != null) {
                val deviation = kotlin.math.abs(cycleLength - baselineMedian!!)
                if (deviation > PiqConfig.GATE_HISTORY_DEVIATION_DAYS) {
                    anomalies.put(anomaly(G3, cycleLength,
                        "记录 $label 的周期长度 ${pyDays(cycleLength)} 天与本次导入数据的中位数 " +
                            "${pyDays1(baselineMedian)} 天偏离 ${pyDays1(deviation)} 天" +
                            "（阈值 ${PiqConfig.GATE_HISTORY_DEVIATION_DAYS.toInt()} 天）",
                        "cycle_length"))
                }
            }
            calendar.chronoGap[entry.idx]?.let { (gap, prevStart) ->
                if (hasBaseline && gap > PiqConfig.GATE_GAP_MAX_DAYS) {
                    anomalies.put(anomaly(G4, gap,
                        "记录 $label 与上一条开始日 ${prevStart.toIso()} 间隔 $gap 天" +
                            "（阈值 ${PiqConfig.GATE_GAP_MAX_DAYS} 天）", "period_start_gap"))
                }
            }
            if (periodDays != null &&
                (periodDays < PiqConfig.GATE_PERIOD_MIN_DAYS || periodDays > PiqConfig.GATE_PERIOD_MAX_DAYS)
            ) {
                anomalies.put(anomaly(G5, periodDays,
                    "记录 $label 的经期时长 ${pyDays(periodDays)} 天超出常见范围" +
                        "（${PiqConfig.GATE_PERIOD_MIN_DAYS}–${PiqConfig.GATE_PERIOD_MAX_DAYS} 天）", "period_days"))
            }
        }
        return anomalies
    }

    /**
     * 修 #32：由**待导入数据自身**派生 G3/G4 基线（合法周期长度列表）。
     *
     * 口径与 [evaluate] 完全一致（共用 [deriveCalendar] / [effectiveCycleLength]）：
     * provided `cycle_length` 优先，否则按**日历序**相邻开始日派生；只收
     * [PiqConfig.GATE_CYCLE_MIN_DAYS, PiqConfig.GATE_CYCLE_MAX_DAYS] 内的**有限**值
     * （与库内 `get_all_valid_cycle_lengths` 的合法长度同口径：越界值落库时本就置 NULL，
     * 不得参与中位数）。
     *
     * 空列表 ⇒ 路由层传空基线 ⇒ G3/G4 不适用（单条记录既无中位数也无可比间隔）。
     * 纯函数：不读库、不碰时钟、不改入参。
     */
    fun baselineCycleLengths(cycles: List<Pair<Int, JSONObject>>): List<Double> {
        val calendar = deriveCalendar(cycles)
        val lengths = mutableListOf<Double>()
        for (entry in calendar.entries) {
            val cycleLength = effectiveCycleLength(entry, calendar.derivedLength) ?: continue
            if (!cycleLength.isFinite()) continue
            if (cycleLength < PiqConfig.GATE_CYCLE_MIN_DAYS || cycleLength > PiqConfig.GATE_CYCLE_MAX_DAYS) continue
            lengths.add(cycleLength)
        }
        return lengths
    }

    /** 门禁评估的一条记录：原始下标、原始对象、开始日/结束日（解析失败为 null）。 */
    private data class GateEntry(
        val idx: Int,
        val row: JSONObject,
        val start: LocalDate?,
        val end: LocalDate?,
    )

    /** 日历序派生的单一产物：输入序条目 + 派生周期长度 + 相邻间隔（G4 报告用）。 */
    private class GateCalendar(
        val entries: List<GateEntry>,
        val derivedLength: Map<Int, Double>,
        val chronoGap: Map<Int, Pair<Long, LocalDate>>,
    )

    /**
     * 按**日历序**派生周期长度与相邻开始日间隔（[evaluate] 与 [baselineCycleLengths] 的单一实现）。
     *
     * 为什么必须按日历序：导入顺序任意（备份/CSV/手改），按列表下标做差会把行序当时间序，
     * 派生值与 G4 间隔双双失真；同开始日按稳定排序保留输入序。
     *
     * 日期解析与导入结构校验（[requireImportDate]）共用 [PyMath.parseDateFromIsoFormat]：
     * 接受集同为 YYYY-MM-DD / YYYYMMDD / YYYY-Www-d（非字符串/非法日期此处按"无日期"跳过，
     * 仍由逐条结构校验 400；门禁只判定不报错，不因解析失败改变自己的定位）。
     */
    private fun deriveCalendar(cycles: List<Pair<Int, JSONObject>>): GateCalendar {
        val entries = cycles.map { (idx, row) ->
            GateEntry(
                idx,
                row,
                PyMath.parseDateFromIsoFormat(row.opt("period_start")),
                PyMath.parseDateFromIsoFormat(row.opt("period_end")),
            )
        }
        val chrono = entries.filter { it.start != null }.sortedBy { it.start }
        val derivedLength = mutableMapOf<Int, Double>()
        val chronoGap = mutableMapOf<Int, Pair<Long, LocalDate>>()
        for (k in 1 until chrono.size) {
            val prevStart = chrono[k - 1].start!!
            val gap = PyMath.daysBetween(prevStart, chrono[k].start!!)
            derivedLength[chrono[k].idx] = gap.toDouble()
            chronoGap[chrono[k].idx] = gap to prevStart
        }
        return GateCalendar(entries, derivedLength, chronoGap)
    }

    /** 单条记录的**生效周期长度**：provided cycle_length 优先，否则按日历序派生（G1/G3 与基线共用）。 */
    private fun effectiveCycleLength(entry: GateEntry, derivedLength: Map<Int, Double>): Double? =
        entry.row.strictDoubleOrNull("cycle_length") ?: derivedLength[entry.idx]

    private fun anomaly(code: String, value: Any?, message: String, field: String): JSONObject = JSONObject()
        .put("code", code)
        .put("field", field)
        .put("value", JSONObject.wrap(value))
        .put("expected", EXPECTED[code])
        .put("message", message)

    /**
     * 导入请求的**容器形态**校验（桌面由 pydantic `ImportRequest` 承担：
     * `cycles: list[dict] = []`、`predictions: list[dict] = []`、`model_params: Optional[dict] = None`）。
     *
     * 为什么必须在闸门**之前**做：调用方原本用 `body.optJSONArray("cycles") ?: JSONArray()` 取容器，
     * 于是 `cycles` 给字符串/对象/数字时被**静默折成空数组**（实测 pydantic 对
     * `'abc' / {} / 5 / None` 一律 ValidationError ⇒ 422）。
     *
     * 2026-10-26 修复 P1 后，空导入闸门 [hasImportablePayload] **只认 `cycles` 非空**
     * （`model_params` 非空对象不再能过闸门，"清空重建"不可再由无 cycles 载荷触发）。
     * 本形态校验仍留在闸门之前：容器形态错误应先报 422 形态错，而不是被折成空数组后
     * 再吃一句"缺少经期记录"的 400——那会把真正的错误原因（键类型不对）掩盖掉一层。
     *
     * 2026-10-31 修 #31：`daily_records` 额外拒绝**显式 JSON null**（422，pydantic 同判）；
     * 缺键合法且与 `[]` 语义不同（见 [dailyRowsOrNull]）。
     */
    fun requirePayloadShapes(body: JSONObject) {
        requireArrayOrAbsent(body, "cycles")
        requireArrayOrAbsent(body, "predictions")
        // 修 #31：daily_records 的**键存在性**承载「保留 / 清空重建」语义，因此显式 JSON null
        // 必须 422（Win `ImportRequest.daily_records: list[dict]` 由 pydantic 对 null 回 422）。
        // 缺键仍合法（= 保留库内既有每日详情），在 [dailyRowsOrNull] 里体现为 null。
        if (body.has("daily_records") && body.isNull("daily_records")) {
            throw validationError("daily_records", "should be a list")
        }
        requireArrayOrAbsent(body, "daily_records")
        requireObjectOrAbsent(body, "model_params")
        requireObjectOrAbsent(body, "app_settings")
    }

    /** 桌面 `cycles: list[dict] = []` / `predictions: list[dict] = []`：缺席合法，给了就必须是数组。 */
    private fun requireArrayOrAbsent(body: JSONObject, key: String) {
        if (!body.has(key) || body.isNull(key)) return
        if (body.opt(key) !is JSONArray) throw validationError(key, "should be a list")
    }

    /** 桌面 `model_params: Optional[dict] = None` / `app_settings: Optional[dict] = None`。 */
    private fun requireObjectOrAbsent(body: JSONObject, key: String) {
        if (!body.has(key) || body.isNull(key)) return
        if (body.opt(key) !is JSONObject) throw validationError(key, "should be a dict")
    }

    /**
     * `predictions[].confidence` 的取值口径（桌面 `isinstance(confidence, (int,float)) and
     * not isinstance(confidence, bool)`）：**只有 JSON 数字**算有值。
     *
     * 数字字符串 `"0.5"` 在桌面是"无值" ⇒ 400；此前安卓走 `doubleOrNull`，它会把字符串转成数字，
     * 于是脏值随清空重建入库（R8 的 F-16）。
     */
    fun confidenceValue(row: JSONObject): Double? = (row.opt("confidence") as? Number)?.toDouble()

    /**
     * 导入体里是否带 **U+FFFD**（替换字符）。它是"字节流按 UTF-8 解码失败"的唯一可见痕迹：
     * 页内用 `FileReader.readAsText(file,'utf-8')` 读文件是**非致命**的，GBK/ANSI 文件会被
     * 静默替换成 U+FFFD 后照常解析，导入还回 200"已导入 1 条"——中文备注在库里已经是乱码。
     *
     * 实现取 `toString()` 全量扫描（一次序列化）而不是递归走树：导入体积上限是
     * `MAX_IMPORT_CYCLES=1000` / `MAX_IMPORT_PREDICTIONS=2000`，一次额外字符串分配的代价可接受，
     * 换来"任何层级的损坏都跑得掉"这条更强的一致性。
     */
    fun hasReplacementCharacter(body: JSONObject): Boolean = body.toString().contains(REPLACEMENT_CHAR)

    /**
     * 空导入闸门（2026-10-26 修复 P1，与 Win 端同口径）：**导入必须含至少一条 cycle**。
     *
     * 旧契约（桌面 `settings.import_data` 的 `if not body.cycles and not body.model_params`）把
     * `model_params` 非空对象也算"有内容"——但安卓的导入编排（applyImport）**从不载入**载荷里的
     * model_params：无 cycles 时它走 `resetModelParams` 把模型参数打回默认。于是
     * `{"model_params":{...}}` 这类载荷能过闸门、进"清空重建"，把用户已有的全部周期与预测
     * 删光、一行数据不写、还回 200 "成功导入 0 条"（清库不载入，P1）。
     *
     * 新契约：只认 `cycles` 数组非空；predictions-only / model_params-only 一律 400 `EMPTY_IMPORT`
     * （文案见调用点）。安卓的导入是**清空重建**型单事务操作（先 `deleteUserCycles`/
     * `deleteUserPredictions` 再插入），闸门漏判一次就会把用户已有的全部数据抹掉——按 P0/P1 对待。
     */
    fun hasImportablePayload(body: JSONObject): Boolean =
        (body.optJSONArray("cycles")?.length() ?: 0) > 0

    /**
     * `predictions[].model_version` 的取值口径（桌面 `str(p.get("model_version", "unknown"))`）。
     *
     * 只有**键缺失**才回退 `"unknown"`；键存在但显式为 `null` 时桌面得到字符串 `"None"`，
     * 空串得到 `""`，数字得到 `"5"` —— 三者都不在白名单里 ⇒ 一律 400（"宁严不宽"）。
     * 安卓若把这些形态统统折成 `"unknown"`，脏值就会随清空重建写库并流向透视镜 DOM。
     */
    fun normalizeModelVersion(row: JSONObject): String = when {
        !row.has("model_version") -> "unknown"
        row.isNull("model_version") -> "None"
        else -> row.opt("model_version").toString()
    }

    /**
     * 必填导入日期（桌面 `settings._parse_iso_date(..., required=True)`）：
     * 键缺失 / JSON null / 空串 / 尾随垃圾 / 非字符串一律 400 `INVALID_IMPORT`。
     *
     * ⚠ [key] 与 [label] 必须是**两个参数**：R8 把它们合成过一个参数，于是
     * `row.has("cycles[].period_start")` 恒假 ⇒ 任何合法备份都吃 400、导入链路整体不可用
     * （R9 的 R8-B1，运行时读数见早期记录）。
     */
    fun requireImportDate(row: JSONObject, key: String, label: String): LocalDate =
        isoOrBasicDateOrNull(row.opt(key)) ?: throw invalidImportDate(label)

    /**
     * 选填导入日期（桌面 `settings._parse_iso_date(..., required=False)`）：
     * **只有键缺失或显式 JSON null** 才合法（返回 null）；空串与垃圾形态仍须 400，
     * 否则它们会被静默写成 NULL，把"文件里写了空日期"伪装成"这一列本来就没填"。
     */
    fun optionalImportDate(row: JSONObject, key: String, label: String): LocalDate? {
        if (!row.has(key) || row.isNull(key)) return null
        return isoOrBasicDateOrNull(row.opt(key)) ?: throw invalidImportDate(label)
    }

    /**
     * 与桌面 `datetime.date.fromisoformat` 的接受集**逐形一致**（15 种形态的双解释器对照表见
     * 早期记录）：单一实现是 [PyMath.parseDateFromIsoFormat]，这里不再重写口径。
     */
    private fun isoOrBasicDateOrNull(raw: Any?): LocalDate? = PyMath.parseDateFromIsoFormat(raw)

    /** U+FFFD：字节流按 UTF-8 解码失败后留下的替换字符。**这里就是裸字符**——本轮实测把它换成 \uFFFD 的转义写法会让 classes3.dex 的 CRC 改变（331 条目里 1 条不同），而本轮已经没有可信的重建窗口 ⇒ 写法不动，只把注释改成与实现一致；要真换成转义写法就进 R9.4 那一批（与剩余 5 条同批重建）。 */
    private const val REPLACEMENT_CHAR = '�'

    private fun invalidImportDate(field: String): ApiError =
        ApiError(400, "$field 缺失或不是合法的 ISO 日期（YYYY-MM-DD）", "INVALID_IMPORT")

    // ============================================================
    // daily_records 结构校验（2026-10-26；口径同 Win schemas/api.py + settings._validate_daily_rows）
    // ============================================================

    /**
     * 修 #31：`daily_records` 的**键存在性**语义入口（与 Win `model_fields_set` 判定同构）：
     * - **缺键** → null：调用方不删除、不插入，保留库内既有每日详情（CSV / 旧备份不带该键）；
     * - **显式 []** → 空列表：调用方仅清空；
     * - **非空数组** → 逐行校验后返回：调用方清空重建。
     *
     * 键存在但不是数组（显式 null / 字符串 / 对象 / 数字）→ 本函数**自己**抛 422
     * `VALIDATION_ERROR`（`validationError("daily_records", "should be a list")`，与
     * [requirePayloadShapes] 同形同码），不再依赖调用顺序：生产路径上
     * [requirePayloadShapes] 已先拒绝，但本函数是 public、单测可直接调用，
     * `?: JSONArray()` 会把"显式 null"静默折成空列表（= 清空语义），是隐藏的语义陷阱。
     * 条数上限仍由调用方先行校验，以保持「422 条数上限先于 400 DATA_ANOMALY」的原顺序。
     */
    fun dailyRowsOrNull(userId: Long, body: JSONObject): List<DailyRecordRow>? {
        if (!body.has("daily_records")) return null
        val rows = body.optJSONArray("daily_records")
            ?: throw validationError("daily_records", "should be a list")
        return validateDailyRows(userId, rows)
    }

    /**
     * 导入的 daily_records 逐条严格校验（还原历史：**不受补填窗口/来潮日限制**，
     * 但日期不得晚于今天；行内 mood_note / mood_tags 一律静默忽略——仅本地存储、永不随备份往返，导入重建后标签为空）。
     * 结构违规 → 400 `INVALID_DAILY`（与 Win 同码同文案）；
     * `created_at`/`updated_at` 非法 → 400 `INVALID_IMPORT`（修 #26：与 Win
     * `_validate_created_at` 同码，旧 `INVALID_DAILY` 码已废止、旧前端已删）。
     */
    fun validateDailyRows(userId: Long, rows: JSONArray): List<DailyRecordRow> =
        (0 until rows.length()).map { i ->
            val r = rows.optJSONObject(i) ?: throw validationError("daily_records.$i", "应为对象")
            val day = requireImportDate(r, "record_date", "daily_records[].record_date")
            rejectDailyFuture(day)
            val painPresent = when (val raw = r.opt("pain_present")) {
                is Boolean -> raw
                is Int -> if (raw == 0 || raw == 1) raw == 1 else throw invalidDaily(day, "pain_present 非法（须为布尔）")
                is Long -> if (raw == 0L || raw == 1L) raw == 1L else throw invalidDaily(day, "pain_present 非法（须为布尔）")
                else -> throw invalidDaily(day, "pain_present 非法（须为布尔）")
            }
            val painLevel = dailyLevel(r, "pain_level", day)
            if (painPresent && painLevel == null) throw invalidDaily(day, "有疼痛时必须填写疼痛等级（1-10）")
            if (!painPresent && painLevel != null) throw invalidDaily(day, "无疼痛时疼痛等级必须为空")
            val flow = dailyLevel(r, "flow_level", day) ?: throw invalidDaily(day, "flow_level 缺失（须为 1-10 整数）")
            val mood = dailyLevel(r, "mood_level", day) ?: throw invalidDaily(day, "mood_level 缺失（须为 1-10 整数）")
            DailyRecordRow(
                userId = userId,
                recordDate = day.toIso(),
                painPresent = painPresent,
                painLevel = painLevel,
                flowLevel = flow,
                moodLevel = mood,
                createdAt = importTimestampOrNow(r, "created_at", "每日详情", day),
                updatedAt = importTimestampOrNow(r, "updated_at", "每日详情", day),
            )
        }

    /** 等级字段：缺失/null → null（pain_level 选填）；给了就只认 1-10 的 JSON 整数（bool/小数/字符串拒收）。 */
    private fun dailyLevel(row: JSONObject, key: String, day: LocalDate): Long? {
        if (!row.has(key) || row.isNull(key)) return null
        return when (val raw = row.opt(key)) {
            is Int -> raw.toLong()
            is Long -> raw
            else -> throw invalidDaily(day, "$key 非法（须为 1-10 整数）")
        }.also { if (it < 1L || it > 10L) throw invalidDaily(day, "$key 非法（须为 1-10 整数）") }
    }

    /**
     * 导入时间戳（cycles / predictions / daily_records 三处共用，2026-10-31 修 #26）。
     *
     * 口径与 Win `settings._validate_created_at` 逐字同形：
     * - **只认 JSON 字符串**（[strictTextOrNull]）；数字/布尔/对象/数组/null、空串、缺键
     *   → 导入时刻 [PyMath.nowSqliteUtc]（旧写法经 `optString` 把数字 `123` 折成 `"123"` 入库）；
     * - 字符串超过 [PiqConfig.MAX_CREATED_AT_LEN] 或含控制字符（< U+0020 或 U+007F）
     *   → 400 `INVALID_IMPORT`，文案 `"<label> <日期> 的 <key> 非法（须为不超过 32 字符、
     *   不含控制字符的时间戳文本）"`。
     */
    fun importTimestampOrNow(row: JSONObject, key: String, label: String, recordDate: LocalDate): String {
        val raw = row.strictTextOrNull(key)
        if (raw.isNullOrEmpty()) return PyMath.nowSqliteUtc()
        if (raw.length > PiqConfig.MAX_CREATED_AT_LEN || raw.any { it < ' ' || it == '\u007f' }) {
            throw ApiError(
                400,
                "$label ${recordDate.toIso()} 的 $key 非法（须为不超过 ${PiqConfig.MAX_CREATED_AT_LEN} 字符、" +
                    "不含控制字符的时间戳文本）",
                "INVALID_IMPORT",
            )
        }
        return raw
    }

    private fun rejectDailyFuture(day: LocalDate) {
        val limit = LocalDate.now().plusDays(PiqConfig.MAX_FUTURE_CYCLE_DAYS)
        if (day.isAfter(limit)) {
            throw invalidDaily(day, "每日详情日期 ${day.toIso()} 晚于允许上限（最晚 $limit）")
        }
    }

    private fun invalidDaily(day: LocalDate, reason: String): ApiError =
        ApiError(400, "每日详情 ${day.toIso()} 的 $reason", PiqConfig.INVALID_DAILY_CODE)
}
