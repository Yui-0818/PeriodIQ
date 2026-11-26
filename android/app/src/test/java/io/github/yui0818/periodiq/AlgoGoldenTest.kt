package io.github.yui0818.periodiq

import io.github.yui0818.periodiq.algo.PiqAlgo
import kotlin.math.abs
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.fail
import org.junit.BeforeClass
import org.junit.Test

/**
 * Golden-vector equivalence test verifying that the pure-Kotlin algorithm port
 * matches the original Python implementation (config.py and algo modules)
 * across all functions, edge cases, rounding boundaries, and trace strings.
 */
class AlgoGoldenTest {

    companion object {
        private const val FLOAT_TOL = 1e-9
        private lateinit var golden: JSONObject

        @JvmStatic
        @BeforeClass
        fun loadGolden() {
            val stream = AlgoGoldenTest::class.java.classLoader
                ?.getResourceAsStream("golden_algo_vectors.json")
            assertNotNull("golden_algo_vectors.json must exist on test classpath", stream)
            val text = stream!!.bufferedReader(Charsets.UTF_8).use { it.readText() }
            golden = JSONObject(text)
        }
    }

    @Test
    fun replayEmaMatchesGolden() {
        val cases = golden.getJSONArray("replay_ema")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val name = c.getString("name")
            val cycles = toDoubleList(c.getJSONArray("cycles"))
            val excludeLast = c.getBoolean("exclude_last")
            val expected = c.getDouble("expected")
            val actual = PiqAlgo.replayEma(cycles, excludeLast)
            assertEquals("replay_ema[$name]", expected, actual, FLOAT_TOL)
        }
    }

    @Test
    fun predictCoreMatchesGolden() {
        val cases = golden.getJSONArray("predict_core")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val name = c.getString("name")
            val cycles = toDoubleList(c.getJSONArray("cycles"))
            val prevEma = if (c.isNull("prev_ema")) null else c.getDouble("prev_ema")
            val expected = c.getJSONObject("expected")
            val actual = PiqAlgo.predictCore(cycles, prevEma)
            assertJsonEquals("predict_core[$name]", expected, actual)
        }
    }

    @Test
    fun predictNextPeriodMatchesGolden() {
        val cases = golden.getJSONArray("predict_next_period")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val name = c.getString("name")
            val lastStart = if (c.isNull("last_period_start")) null else c.getString("last_period_start")
            val cycles = toDoubleList(c.getJSONArray("cycles"))
            val prevEma = if (c.isNull("prev_ema")) null else c.getDouble("prev_ema")
            val expected = c.getJSONObject("expected")
            val actual = PiqAlgo.predictNextPeriod(lastStart, cycles, prevEma)
            assertJsonEquals("predict_next_period[$name]", expected, actual)
        }
    }

    @Test
    fun onNewCycleAddedMatchesGolden() {
        val cases = golden.getJSONArray("on_new_cycle_added")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val name = c.getString("name")
            val newStart = c.getString("new_start")
            val prevStart = if (c.isNull("prev_start")) null else c.getString("prev_start")
            val currentParams = c.getJSONObject("current_params")
            val expected = c.getJSONObject("expected")
            val actual = PiqAlgo.onNewCycleAdded(newStart, prevStart, currentParams)
            assertJsonEquals("on_new_cycle_added[$name]", expected, actual)
        }
    }

    @Test
    fun evaluatePredictionsMatchesGolden() {
        val cases = golden.getJSONArray("evaluate_predictions")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val name = c.getString("name")
            val predictions = c.getJSONArray("predictions")
            val expected = c.getJSONObject("expected")
            val actual = PiqAlgo.evaluatePredictions(predictions)
            assertJsonEquals("evaluate_predictions[$name]", expected, actual)
        }
    }

    @Test
    fun computeFertilityWindowMatchesGolden() {
        val cases = golden.getJSONArray("compute_fertility_window")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val name = c.getString("name")
            val predDate = if (c.isNull("predicted_period_date")) null else c.getString("predicted_period_date")
            val curStart = if (c.isNull("current_period_start")) null else c.getString("current_period_start")
            val curEnd = if (c.isNull("current_period_end")) null else c.getString("current_period_end")
            val cycleStd = c.getDouble("cycle_std")
            val predDays = if (c.isNull("predicted_period_days")) null else c.getInt("predicted_period_days")
            val expected = c.getJSONObject("expected")
            val actual = PiqAlgo.computeFertilityWindow(predDate, curStart, curEnd, cycleStd, predDays)
            assertJsonEquals("compute_fertility_window[$name]", expected, actual)
        }
    }

    @Test
    fun predictionTraceMatchesGolden() {
        val cases = golden.getJSONArray("prediction_trace")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val name = c.getString("name")
            val lastStart = c.getString("last_period_start")
            val cycles = toDoubleList(c.getJSONArray("cycles"))
            val prevEma = if (c.isNull("prev_ema")) null else c.getDouble("prev_ema")
            val expected = c.getJSONObject("expected")
            val actual = PiqAlgo.predictionTrace(lastStart, cycles, prevEma, JSONObject())
            assertJsonEquals("prediction_trace[$name]", expected, actual)
        }
    }

    @Test
    fun configConstantsMatchGolden() {
        val cfg = golden.getJSONObject("config")
        val nums = cfg.getJSONObject("numbers")
        for (key in nums.keys()) {
            assertEquals("configNumber($key)", nums.getDouble(key), PiqAlgo.configNumber(key), 0.0)
        }
        val ints = cfg.getJSONObject("ints")
        for (key in ints.keys()) {
            assertEquals("configInt($key)", ints.getInt(key), PiqAlgo.configInt(key))
        }
        val texts = cfg.getJSONObject("texts")
        for (key in texts.keys()) {
            assertEquals("configText($key)", texts.getString(key), PiqAlgo.configText(key))
        }
    }

    private fun toDoubleList(arr: JSONArray): List<Double> =
        List(arr.length()) { arr.getDouble(it) }

    private fun assertJsonEquals(path: String, expected: Any?, actual: Any?) {
        val expNull = expected == null || expected == JSONObject.NULL
        val actNull = actual == null || actual == JSONObject.NULL
        if (expNull && actNull) return
        if (expNull != actNull) {
            fail("$path: expected=$expected, actual=$actual")
        }

        when {
            expected is JSONObject && actual is JSONObject -> {
                val expKeys = expected.keys().asSequence().toSet()
                val actKeys = actual.keys().asSequence().toSet()
                assertEquals("$path keys mismatch", expKeys, actKeys)
                for (k in expKeys) {
                    assertJsonEquals("$path.$k", expected.get(k), actual.get(k))
                }
            }
            expected is JSONArray && actual is JSONArray -> {
                assertEquals("$path length mismatch", expected.length(), actual.length())
                for (i in 0 until expected.length()) {
                    assertJsonEquals("$path[$i]", expected.get(i), actual.get(i))
                }
            }
            expected is Boolean && actual is Boolean -> {
                assertEquals(path, expected, actual)
            }
            expected is Number && actual is Number -> {
                val e = expected.toDouble()
                val a = actual.toDouble()
                if (abs(e - a) > FLOAT_TOL) {
                    fail("$path: expected=$expected, actual=$actual (diff=${abs(e - a)})")
                }
            }
            else -> {
                assertEquals(path, expected, actual)
            }
        }
    }
}
