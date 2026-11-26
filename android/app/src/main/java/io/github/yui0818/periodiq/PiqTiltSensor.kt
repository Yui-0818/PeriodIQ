/*
 * Copyright (c) 2026 Yui_0818 (aaaj6719@gmail.com)
 * Licensed under the PolyForm Noncommercial License 1.0.0.
 * Commercial use is prohibited without separate written authorization.
 * See LICENSE and COMMERCIAL.md in the repository root.
 */

package io.github.yui0818.periodiq

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.SystemClock
import kotlin.math.abs
import kotlin.math.asin
import kotlin.math.sqrt

/**
 * 低功耗页面视差倾斜传感器：零权限、按需启停、静止零回调。
 *
 * 优先使用 `TYPE_GAME_ROTATION_VECTOR`（无需磁力计且抗磁场干扰），依次回退
 * `TYPE_ROTATION_VECTOR` 与 `TYPE_ACCELEROMETER`；若设备无可用传感器则安全空操作。
 */
class PiqTiltSensor(
    context: Context,
    private val onTilt: (nx: Float, ny: Float) -> Unit,
) : SensorEventListener {

    private val sensorManager: SensorManager? =
        context.applicationContext.getSystemService(Context.SENSOR_SERVICE) as? SensorManager

    private val sensor: Sensor? = sensorManager?.let { sm ->
        sm.getDefaultSensor(Sensor.TYPE_GAME_ROTATION_VECTOR)
            ?: sm.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR)
            ?: sm.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
    }

    private val rotMatrix = FloatArray(9)
    private val orientation = FloatArray(3)

    private var registered = false
    private var hasBaseline = false
    private var baseRollDeg = 0f
    private var basePitchDeg = 0f

    private var smoothX = CENTER
    private var smoothY = CENTER
    private var lastSentX = CENTER
    private var lastSentY = CENTER
    private var lastEmitMs = 0L

    fun start() {
        val sm = sensorManager ?: return
        val s = sensor ?: return
        if (registered) return
        hasBaseline = false
        smoothX = CENTER
        smoothY = CENTER
        lastSentX = CENTER
        lastSentY = CENTER
        lastEmitMs = 0L
        registered = runCatching {
            sm.registerListener(this, s, SAMPLING_PERIOD_US)
        }.getOrDefault(false)
    }

    fun stop() {
        if (!registered) return
        runCatching { sensorManager?.unregisterListener(this) }
        registered = false
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit

    override fun onSensorChanged(event: SensorEvent) {
        if (!registered) return
        val rollDeg: Float
        val pitchDeg: Float
        when (event.sensor.type) {
            Sensor.TYPE_GAME_ROTATION_VECTOR,
            Sensor.TYPE_ROTATION_VECTOR -> {
                if (event.values.size < 3) return
                SensorManager.getRotationMatrixFromVector(rotMatrix, event.values)
                SensorManager.getOrientation(rotMatrix, orientation)
                pitchDeg = Math.toDegrees(orientation[1].toDouble()).toFloat()
                rollDeg = Math.toDegrees(orientation[2].toDouble()).toFloat()
            }

            Sensor.TYPE_ACCELEROMETER -> {
                if (event.values.size < 3) return
                val ax = event.values[0]
                val ay = event.values[1]
                val az = event.values[2]
                val norm = sqrt((ax * ax + ay * ay + az * az).toDouble()).toFloat().coerceAtLeast(1e-3f)
                rollDeg = Math.toDegrees(asin((-ax / norm).coerceIn(-1f, 1f).toDouble())).toFloat()
                pitchDeg = Math.toDegrees(asin((ay / norm).coerceIn(-1f, 1f).toDouble())).toFloat()
            }

            else -> return
        }

        if (!hasBaseline) {
            baseRollDeg = rollDeg
            basePitchDeg = pitchDeg
            hasBaseline = true
            return
        }

        val dRoll = wrapDeg(rollDeg - baseRollDeg)
        val dPitch = wrapDeg(pitchDeg - basePitchDeg)
        baseRollDeg = wrapDeg(baseRollDeg + BASELINE_ALPHA * dRoll)
        basePitchDeg = wrapDeg(basePitchDeg + BASELINE_ALPHA * dPitch)

        val rawX = (CENTER + (dRoll / MAX_TILT_DEG).coerceIn(-1f, 1f) * HALF_RANGE).coerceIn(MIN_OUT, MAX_OUT)
        val rawY = (CENTER + (dPitch / MAX_TILT_DEG).coerceIn(-1f, 1f) * HALF_RANGE).coerceIn(MIN_OUT, MAX_OUT)

        smoothX += SMOOTH_ALPHA * (rawX - smoothX)
        smoothY += SMOOTH_ALPHA * (rawY - smoothY)

        val nowMs = SystemClock.uptimeMillis()
        if (nowMs - lastEmitMs < MIN_INTERVAL_MS) return
        if (abs(smoothX - lastSentX) < DEADZONE && abs(smoothY - lastSentY) < DEADZONE) return

        lastEmitMs = nowMs
        lastSentX = smoothX
        lastSentY = smoothY
        onTilt(smoothX, smoothY)
    }

    private fun wrapDeg(deg: Float): Float {
        var d = deg % 360f
        if (d > 180f) d -= 360f
        if (d < -180f) d += 360f
        return d
    }

    companion object {
        private const val SAMPLING_PERIOD_US = 50_000
        private const val MIN_INTERVAL_MS = 50L
        private const val MAX_TILT_DEG = 16f
        private const val BASELINE_ALPHA = 0.005f
        private const val SMOOTH_ALPHA = 0.22f
        private const val DEADZONE = 0.015f
        private const val MIN_OUT = 0.02f
        private const val MAX_OUT = 0.98f
        private const val CENTER = 0.5f
        private const val HALF_RANGE = 0.48f
    }
}
