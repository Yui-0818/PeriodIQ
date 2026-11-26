package io.github.yui0818.periodiq

import io.github.yui0818.periodiq.api.contract.ApiError
import io.github.yui0818.periodiq.domain.import.ImportModelParams
import java.math.BigDecimal
import java.math.BigInteger
import java.time.LocalDate
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 导入 `predictions[].model_params_json` 严格校验的 JVM 哨兵（对照 Win
 * `settings._validate_import_model_params_json`）。
 *
 * 覆盖：dict 合法/未知键保留、五个数值字段遇 bool/string/null、prior_weight 与 n_records
 * 边界、str 合法原样保留、str 非法 JSON/尾随垃圾/数组/标量、null/空串 → "{}"、
 * 顶层数组/数字/bool 拒绝，以及所有拒绝的码 = 400 `INVALID_IMPORT`。
 */
class ImportModelParamsTest {

    private val predicted: LocalDate = LocalDate.of(2026, 1, 1)

    private fun normalize(raw: Any?): String = ImportModelParams.normalize(raw, predicted)

    private fun assertRejected(raw: Any?, vararg detailFragments: String): ApiError {
        val error = assertThrows(ApiError::class.java) { normalize(raw) }
        assertEquals(400, error.status)
        assertEquals("INVALID_IMPORT", error.code)
        assertTrue("文案应包含预测日期：${error.detail}", error.detail.contains("2026-01-01"))
        detailFragments.forEach {
            assertTrue("文案应包含「$it」：${error.detail}", error.detail.contains(it))
        }
        return error
    }

    private val numericFields = listOf("mean_cycle", "std_cycle", "ema_cycle", "prior_mean", "prior_std")

    @Test
    fun `dict 合法且未知附加键保留`() {
        val raw = JSONObject(
            """
            {"mean_cycle":29.5,"std_cycle":2.0,"ema_cycle":30,"prior_mean":28,"prior_std":3.5,
             "prior_weight":0.5,"n_records":3,"n_eff":2.5,"stale_correction":{"from_predicted_date":"2026-01-01"}}
            """.trimIndent(),
        )
        val out = JSONObject(normalize(raw))
        assertEquals(29.5, out.getDouble("mean_cycle"), 0.0)
        assertEquals(2.0, out.getDouble("std_cycle"), 0.0)
        assertEquals(30, out.getInt("ema_cycle"))
        assertEquals(28, out.getInt("prior_mean"))
        assertEquals(3.5, out.getDouble("prior_std"), 0.0)
        assertEquals(0.5, out.getDouble("prior_weight"), 0.0)
        assertEquals(3, out.getInt("n_records"))
        assertEquals(2.5, out.getDouble("n_eff"), 0.0)
        assertEquals(
            "2026-01-01",
            out.getJSONObject("stale_correction").getString("from_predicted_date"),
        )
    }

    @Test
    fun `dict 五个数值字段遇 bool string null 一律拒绝`() {
        for (field in numericFields) {
            for (bad in listOf<Any>(true, "28.5", JSONObject.NULL)) {
                val raw = JSONObject().put(field, bad)
                assertRejected(raw, "model_params_json.$field", "须为有限数值")
            }
        }
    }

    @Test
    fun `dict 五个数值字段接受整数与小数`() {
        for (field in numericFields) {
            normalize(JSONObject().put(field, 28))
            normalize(JSONObject().put(field, 28.5))
        }
    }

    @Test
    fun `prior_weight 0 0_5 1 通过 越界与错类型拒绝`() {
        listOf<Any>(0, 0.5, 1, BigDecimal("0.25")).forEach { ok ->
            val out = normalize(JSONObject().put("prior_weight", ok))
            val expected = (ok as Number).toDouble()
            assertEquals(expected, JSONObject(out).getDouble("prior_weight"), 0.0)
        }
        for (bad in listOf<Any>(-0.1, 1.1, true, "0.5")) {
            assertRejected(JSONObject().put("prior_weight", bad), "model_params_json.prior_weight", "须为 0-1 的数值")
        }
    }

    @Test
    fun `prior_weight 缺失与显式 null 放行`() {
        normalize(JSONObject().put("std_cycle", 2.0))
        normalize(JSONObject().put("prior_weight", JSONObject.NULL))
    }

    @Test
    fun `n_records 0 与 3 通过 负数浮点 bool 字符串拒绝`() {
        normalize(JSONObject().put("n_records", 0))
        normalize(JSONObject().put("n_records", 3))
        for (bad in listOf<Any>(-1, 1.5, true, "3")) {
            assertRejected(JSONObject().put("n_records", bad), "model_params_json.n_records", "须为非负整数")
        }
        // JSON 文本里的 3.0 是浮点（Python float）⇒ 与 Win 同拒。
        assertRejected(JSONObject("""{"n_records": 3.0}"""), "model_params_json.n_records", "须为非负整数")
        // 直接构造的 Double 同样拒（不依赖某个具体数字类）。
        assertRejected(JSONObject().put("n_records", 3.0), "model_params_json.n_records", "须为非负整数")
    }

    @Test
    fun `n_records 缺失与显式 null 放行`() {
        normalize(JSONObject().put("std_cycle", 2.0))
        normalize(JSONObject().put("n_records", JSONObject.NULL))
    }

    @Test
    fun `str 合法文本原样保留含空白与键序`() {
        val text = """  { "n_records" : 3, "std_cycle" : 28.5, "unknown" : { "b" : 2, "a" : 1 } }  """
        assertEquals(text, normalize(text))
    }

    @Test
    fun `str 空串归一为 空对象`() {
        assertEquals("{}", normalize(""))
    }

    @Test
    fun `str 非法 JSON 尾随垃圾单引号注释与尾逗号拒绝`() {
        for (bad in listOf(
            "{oops}",
            """{"a":1} trailing""",
            """{'a':1}""",
            """{"a":1,}""",
            "// comment\n{}",
            "   ",
        )) {
            assertRejected(bad, "不是合法的 JSON 文本")
        }
    }

    @Test
    fun `str 合法 JSON 但不是对象拒绝`() {
        for (bad in listOf("[1,2]", "5", "\"x\"", "null", "true")) {
            assertRejected(bad, "JSON 文本必须表示对象")
        }
    }

    @Test
    fun `str 对象内字段非法同样按字段拒绝`() {
        assertRejected("""{"std_cycle":"x"}""", "model_params_json.std_cycle", "须为有限数值")
        assertRejected("""{"prior_weight":1.5}""", "model_params_json.prior_weight", "须为 0-1 的数值")
        assertRejected("""{"n_records":-2}""", "model_params_json.n_records", "须为非负整数")
    }

    @Test
    fun `null 与缺键归一为 空对象`() {
        assertEquals("{}", normalize(null))
        assertEquals("{}", normalize(JSONObject.NULL))
        // 调用点的真实形态：键缺失时 opt 返回 null。
        val row = JSONObject()
        assertEquals("{}", normalize(row.opt("model_params_json")))
        // 显式为 JSON null 时 opt 返回 JSONObject.NULL。
        val nullable = JSONObject().put("model_params_json", JSONObject.NULL)
        assertEquals("{}", normalize(nullable.opt("model_params_json")))
    }

    @Test
    fun `顶层数组数字 bool 拒绝`() {
        assertRejected(JSONArray().put(1), "model_params_json", "须为对象、JSON 文本或 null")
        assertRejected(42, "model_params_json", "须为对象、JSON 文本或 null")
        assertRejected(3.5, "model_params_json", "须为对象、JSON 文本或 null")
        assertRejected(true, "model_params_json", "须为对象、JSON 文本或 null")
    }

    @Test
    fun `超大整数数值字段与 prior_weight 拒绝为有限数值`() {
        // 400 位整数字面量在 JVM org.json 里落成 BigInteger，toDouble() 溢出为 Infinity：
        // 必须在门禁处拒（否则下游 roundTo 会 500）。
        val huge = BigInteger("9".repeat(400))
        assertRejected(JSONObject().put("mean_cycle", huge), "model_params_json.mean_cycle", "须为有限数值")
        assertRejected(JSONObject().put("prior_weight", huge), "model_params_json.prior_weight", "须为 0-1 的数值")
    }

    @Test
    fun `dict 未知键为 NaN 时按非法值拒绝而非抛异常`() {
        // org.json 20240303 的 put/构造器都会预先拒绝 NaN，且 toString() 对内部 NaN 吞异常返回
        // null（其它版本抛 JSONException）：从私有 map 注入脏值，断言被兜成 400 而不是 500。
        assertRejected(dictWithRawValue("unknown", Double.NaN), "model_params_json", "包含无法序列化的数值")
    }

    /** 绕过 org.json 的写入校验，构造一个内部持有 [value] 的 dict（模拟解析层漏进来的非有限数值）。 */
    private fun dictWithRawValue(key: String, value: Any?): JSONObject {
        val obj = JSONObject()
        val mapField = JSONObject::class.java.getDeclaredField("map")
        mapField.isAccessible = true
        @Suppress("UNCHECKED_CAST")
        (mapField.get(obj) as MutableMap<String, Any?>)[key] = value
        return obj
    }

    @Test
    fun `合法输入不会误报`() {
        assertNotNull(normalize(JSONObject().put("mean_cycle", 29)))
    }
}
