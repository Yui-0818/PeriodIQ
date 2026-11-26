/*
 * Copyright (c) 2026 Yui_0818 (aaaj6719@gmail.com)
 * Licensed under the PolyForm Noncommercial License 1.0.0.
 * Commercial use is prohibited without separate written authorization.
 * See LICENSE and COMMERCIAL.md in the repository root.
 */

package io.github.yui0818.periodiq

import io.github.yui0818.periodiq.algo.PiqAlgo
import io.github.yui0818.periodiq.api.contract.ApiError
import io.github.yui0818.periodiq.api.contract.Envelope
import io.github.yui0818.periodiq.api.contract.genericFailure
import io.github.yui0818.periodiq.api.contract.validationError
import io.github.yui0818.periodiq.api.projection.ApiProjection
import io.github.yui0818.periodiq.api.projection.nullableNumber
import io.github.yui0818.periodiq.api.projection.nullableString
import io.github.yui0818.periodiq.domain.daily.DailyPutGate
import io.github.yui0818.periodiq.domain.daily.JournalGate
import io.github.yui0818.periodiq.domain.daily.MoodTags
import io.github.yui0818.periodiq.domain.import.ImportBodyGate
import io.github.yui0818.periodiq.domain.import.ImportGate
import io.github.yui0818.periodiq.domain.import.ImportModelParams
import io.github.yui0818.periodiq.domain.model.ModelRecomputeService
import io.github.yui0818.periodiq.domain.model.PredictionActualBackfill
import io.github.yui0818.periodiq.domain.model.PredictionBackfillRow
import io.github.yui0818.periodiq.data.CycleRow
import io.github.yui0818.periodiq.data.DailyRecordRow
import io.github.yui0818.periodiq.data.PiqCrud
import io.github.yui0818.periodiq.data.PiqDb
import io.github.yui0818.periodiq.data.PredictionRow

import android.database.sqlite.SQLiteConstraintException
import android.database.sqlite.SQLiteDatabase
import android.util.Log
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit
import org.json.JSONArray
import org.json.JSONObject

/**
 * 未实现分支的统一信封：501 + `implemented=false`，判据要求**绝不假 200**。
 *
 * 走 [Envelope.failure] 单源。
 * 响应体**不带** `path`/方法名 —— 内部路由路径对用户零信息量，进页面 DOM 等于外泄路由表结构；
 * 技术细节只进 `api-error|method=…|path=…` 的本地日志。
 */
internal fun notImplementedEnvelope(reason: String): Envelope = Envelope.failure(
    501,
    reason,
    "NOT_IMPLEMENTED",
    JSONObject().put("implemented", false),
)

/**
 * `PUT /auth/profile` 的 `weight_kg` 取值。
 *
 * 契约：**缺键或 JSON null ⇒ 返回 null**（表示"这一列不改"）；**键存在但不是数值、或数值越界 ⇒ 抛 422**
 * （名字里的 `OrReject` 说的就是这件事，与同文件的 [isoOrReject] 同一命名口径）。
 *
 * 桌面声明是 `Optional[float] = Field(None, ge=25, le=300)`（`schemas/api.py:479`），pydantic 2
 * **lax 模式**下**接受数字字符串**（实测 `"70.5"`→70.5、`" 70.5 "`→70.5、`"1e2"`→100.0、`"+28"`→28.0），
 * 安卓同样用 [doubleOrNull] ⇒ 这些形态两端同判。
 *
 * ⚠ **非有限值是真实分叉，不是假想**（`NumericFieldAcceptanceTest` 三条实测）：
 * Java/Kotlin 的浮点字面量语法**大小写敏感** —— `"nan"` 解析失败（返回 null，两端都拒），
 * 但 `"NaN"` 得到 `Double.NaN`、`"Infinity"` 得到 `POSITIVE_INFINITY`；
 * 而 `NaN < 25` 与 `NaN > 300` **都是 false**（IEEE 754），所以"只比区间"的旧写法会把 NaN 放行入库，
 * 桌面则在 `le=300` 上拒它。`[PiqConfig.WEIGHT_MIN_KG]`/`[PiqConfig.WEIGHT_MAX_KG]` 因此
 * 必须配一条有限性判断才等价 —— 这条判断不是防御性代码，是**补齐桌面的 ge/le 语义**。
 */
internal fun profileWeightOrReject(body: JSONObject): Double? {
    if (!body.has("weight_kg") || body.isNull("weight_kg")) return null
    val value = body.doubleOrNull("weight_kg")
        ?: throw validationError("weight_kg", "值应为数值")
    if (!value.isFinite() || value < PiqConfig.WEIGHT_MIN_KG || value > PiqConfig.WEIGHT_MAX_KG) {
        throw validationError("weight_kg", "数值应在 25 到 300 之间")
    }
    return value
}

/**
 * 生日的入站校验（与桌面 `schemas/api.py` 的 pydantic 校验同口径）：生日不得晚于今天。
 * 晚于今天的生日会让 `computeAge` 算出负年龄；历史存量数据不在读取侧改写（见 ApiProjection.computeAge）。
 * 错误形态与桌面展平后的 pydantic 文案同构：422 VALIDATION_ERROR，field=birthday。
 */
internal fun rejectFutureBirthday(birthday: LocalDate) {
    if (birthday.isAfter(LocalDate.now())) {
        throw validationError("birthday", "生日不能晚于今天")
    }
}

/** 桌面 `datetime.now(timezone.utc).isoformat()` 给的是 `+00:00` 而不是 `Z`，这里逐字对齐。 */
private val UTC_SECONDS_FORMAT: DateTimeFormatter = DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ss")
private const val UTC_OFFSET_SUFFIX = "+00:00"

/**
 * 陈旧预测修正的审计时间戳（`model_params.stale_correction.corrected_at`）。
 *
 * ⚠ 基线（`a65d82e` 的 `PiqRouter.kt:1038-1039`）写的是 `LocalDateTime.now(UTC).format(ISO_OFFSET_DATE_TIME)`，
 * 而 `LocalDateTime` **不带偏移字段** ⇒ 该表达式**每次必抛** `UnsupportedTemporalTypeException`
 * （`StaleCorrectionTimestampTest` 前两条把它钉成实测读数）；调用点落在 `store.write { … }` 里、
 * `createPrediction` 之前 ⇒ 整个修正事务回滚，`handle()` 再把它收敛成 `500 INTERNAL_ERROR`。
 *
 * 产出形态 `2026-10-14T05:59:43+00:00`：显式偏移 + **秒级截断**（不用 `ISO_OFFSET_DATE_TIME`
 * 直出，因为零偏移会被它印成 `Z`，与桌面形态不一致；这个字段的值会进 `model_params_json` 跨端往返）。
 * 桌面同一字段带微秒 ⇒ 精度差一档作为 P3 登记在早期记录，不在此默默放宽。
 */
internal fun utcSecondsIso(): String =
    OffsetDateTime.now(ZoneOffset.UTC).truncatedTo(ChronoUnit.SECONDS).format(UTC_SECONDS_FORMAT) + UTC_OFFSET_SUFFIX

/**
 * 路由壳：R3 的 30 条端点再加 R7 的三条算法透视镜端点，
 * **路径与响应信封逐字对齐桌面 REST**。
 *
 * - 前缀 [PiqConfig.API_PREFIX]（`twa` 那条按桌面一样挂在根路径上）；
 * - 成功 = `{status, json}`（`json` 就是桌面那个 HTTP 响应体，数组端点保持数组），
 *   失败 = 同信封里放桌面扁平错误契约 `{detail, code}`（+ 业务附加字段如 `anomalies`）；
 * - **未实现的分支一律 501 + `implemented=false`**，绝不假 200；
 * - 算法一律转 [PiqAlgo]（Python 快照），本文件不重算任何模型指标（禁令）。
 */
/** 算法不可用的统一错误：503 + 现有扁平错误信封，文案可读。 */
internal fun algorithmUnavailable(): ApiError =
    ApiError(503, "本机算法暂时不可用，请稍后重试。", "ALGO_UNAVAILABLE")

/**
 * 算法端点的统一闸门：JVM 用假 [AlgoGate] 就能验证
 * “失败 ⇒ 503 + 业务体一行都不执行”，不必绕过 Android SQLite 桩类去造 router。
 */
internal fun <T> runAlgorithmEndpoint(gate: AlgoGate, block: () -> T): T {
    if (!gate.ensure()) throw algorithmUnavailable()
    return block()
}

/**
 * 删除周期的算法闸门：删完还剩周期时 [recomputeAfterDeleteTx] 才会走到
 * `regenerateCurrentPrediction` → [PiqAlgo]；删最后一条只 reset 模型参数，不查闸门。
 * 计数必须在删除之前完成（503 时行保持不变）。
 */
internal fun <T> runDeleteWithAlgorithmGate(remainingAfterDelete: Int, gate: AlgoGate, delete: () -> T): T {
    if (remainingAfterDelete > 0) runAlgorithmEndpoint(gate) { }
    return delete()
}

/**
 * 可清空字段（备注 / 昵称）专用：缺键或显式 null 才算“未提供”，`""` 必须原样下传。
 * 只给这两个字段用，不替换全局 `optionalString`。
 */
internal fun optionalStringAllowingEmpty(body: JSONObject, key: String): String? {
    if (!body.has(key) || body.isNull(key)) return null
    return body.optString(key)
}

class PiqRouter(
    private val store: PiqDb,
    private val crud: PiqCrud,
    private val sessions: SessionHolder,
    private val limiter: RateLimiter,
    private val appVersion: String,
    private val algoGate: AlgoGate,
) {

    private val recompute = ModelRecomputeService(crud)

    /** 算法端点入口：先验会话（401），再验算法可用性（503），顺序不得颠倒。 */
    private fun requireAlgorithmReady() {
        runAlgorithmEndpoint(algoGate) { }
    }

    /** 入口：任何异常都收敛成可读信封（不得把堆栈抛给页面）。 */
    fun handle(methodIn: String, pathIn: String, bodyIn: String?): Envelope {
        val method = methodIn.uppercase()
        val path = pathIn.substringBefore('?')
        // 2026-10-26：查询串透传（GET /daily-records?from=&to=）；其余端点一律忽略
        val query = pathIn.substringAfter('?', "")
        return try {
            dispatch(method, path, bodyIn, query)
        } catch (e: ApiError) {
            Log.i(TAG, "api-error|method=$method|path=$path|status=${e.status}|code=${e.code}")
            Envelope.error(e)
        } catch (e: Throwable) {
            Log.w(TAG, "api-exception|method=$method|path=$path|type=${e.javaClass.name}|message=${e.message}")
            genericFailure(500, "INTERNAL_ERROR")
        }
    }

    private fun dispatch(method: String, path: String, raw: String?, query: String): Envelope = when {
        path == PATH_ASSETLINKS -> notImplementedEnvelope("TWA 域名所有权文件只在 PWA/TWA 分发形态有意义；本机 APK 不适用")

        // REG-06：404 不再把方法名与路径回显给用户（内部路径对用户零信息量，
        // 且等于把路由表结构甩进页面 DOM）。技术细节仍进 `api-error|method=…|path=…` 日志。
        !path.startsWith(PiqConfig.API_PREFIX) -> throw ApiError(404, MSG_NOT_FOUND, "NOT_FOUND")

        else -> {
            val rest = path.removePrefix(PiqConfig.API_PREFIX)
            // 只有 JSON 备份导入走四档可读错误 + 体积闸门；其余端点保持原宽松形态
            val body = if (method == "POST" && rest == REST_IMPORT) ImportBodyGate.parse(raw) else parseBody(rest, raw)
            route(method, rest, body, query)
        }
    }

    private fun route(method: String, rest: String, body: JSONObject, query: String): Envelope = when {
        method == "GET" && rest == "/health" ->
            Envelope(200, JSONObject().put("status", "ok").put("version", appVersion))

        method == "POST" && rest == "/auth/register" -> register(body)
        method == "POST" && rest == "/auth/login" -> login(body)
        method == "GET" && rest == "/auth/me" -> Envelope(200, ApiProjection.user(requireUser()))
        method == "POST" && rest == "/auth/logout" -> Envelope(200, logout())
        method == "POST" && rest == "/auth/change-password" -> changePassword(body)
        method == "POST" && rest == "/auth/delete-account" -> deleteAccount(body)
        method == "PUT" && rest == "/auth/profile" -> updateProfile(body)
        // 登录持久化（2026-10-26 双端对齐；与桌面 routes/auth.py 镜像，本端点前缀 /api/v1）
        method == "GET" && rest == "/auth/persistence" -> getPersistence()
        method == "POST" && rest == "/auth/persistence" -> enablePersistence(body)
        method == "DELETE" && rest == "/auth/persistence" -> disablePersistence()
        method == "POST" && rest == "/auth/relogin" -> relogin()

        method == "GET" && rest == "/cycles" ->
            Envelope(200, ApiProjection.cycles(crud.getAllCycles(requireUser().userId()), ApiProjection::cycle))
        method == "POST" && rest == "/cycles" -> createCycle(body)
        method == "PUT" && CYCLE_ID.matches(rest) -> updateCycle(cycleIdOf(rest), body)
        method == "DELETE" && CYCLE_ID.matches(rest) -> deleteCycle(cycleIdOf(rest))

        // 经期每日详情（2026-10-26；与桌面 routes/daily.py 镜像）
        method == "PUT" && DAILY_DATE.matches(rest) -> upsertDailyRecord(rest.removePrefix("/daily-records/"), body)
        method == "GET" && rest == "/daily-records" -> listDailyRecords(query)
        // 每日日记（#14，独立渠道；与桌面 routes/journal.py 镜像）
        method == "GET" && rest == "/daily-journal" -> listJournal(query)
        method == "GET" && JOURNAL_DATE.matches(rest) -> getJournal(rest.removePrefix("/daily-journal/"))
        method == "PUT" && JOURNAL_DATE.matches(rest) -> putJournal(rest.removePrefix("/daily-journal/"), body)

        method == "GET" && rest == "/predictions/current" -> currentPrediction()
        method == "GET" && rest == "/predictions/history" -> predictionHistory()

        method == "GET" && rest == "/analysis/accuracy" -> accuracy()
        method == "GET" && rest == "/analysis/cycle-stats" -> cycleStats()
        method == "GET" && rest == "/analysis/fertile-window" -> fertileWindow()

        method == "GET" && rest == "/settings" -> Envelope(200, JSONObject())
        method == "PUT" && rest == "/settings" -> Envelope(200, JSONObject().also { crud.updateSettings(requireUser().userId()) })

        // 设备级主题（2026-10-26 双端对齐；与 Win 同路径同认证同部分更新语义，端侧差异：
        // 本端只支持 theme，不暴露 Win 平台键 close_action / reminder_* 段）
        method == "GET" && rest == "/device/settings" -> getDeviceSettings()
        method == "PUT" && rest == "/device/settings" -> putDeviceSettings(body)

        method == "GET" && rest == "/export" -> exportData()
        method == "GET" && rest == "/export/preview" -> exportPreview()
        method == "POST" && rest == "/import" -> importData(body)

        method == "GET" && rest == "/backups" ->
            notImplementedEnvelope("桌面列的是启动器写在备份目录里的 app-*.db；本机 APK 没有该产物形态")
        method == "PUT" && rest == "/backups/dir" ->
            notImplementedEnvelope("同上：本机没有可选目录的 .db 备份写入方，设置目录没有作用对象")
        method == "GET" && rest == "/debug/model" -> {
            val userId = requireUser().userId()
            requireAlgorithmReady()
            Envelope(200, PiqDebug.model(crud, userId))
        }
        method == "GET" && rest == "/debug/model_history" -> {
            val userId = requireUser().userId()
            requireAlgorithmReady()
            Envelope(200, PiqDebug.modelHistory(crud, userId))
        }
        method == "GET" && rest == "/debug/prediction_trace" -> {
            val userId = requireUser().userId()
            requireAlgorithmReady()
            Envelope(200, PiqDebug.predictionTrace(crud, userId))
        }
        method == "GET" && rest.startsWith("/debug/") ->
            notImplementedEnvelope("桌面 debug 路由族的其余路径没有端上消费方（前端透视镜只用 model / model_history / prediction_trace 三条）")
        method == "GET" && rest == "/keepalive" ->
            notImplementedEnvelope("SSE 心跳用于让常驻服务自我关停；APK 内无常驻服务，且桥是单次请求-响应形态")
        method == "GET" && rest == "/keepalive/status" ->
            notImplementedEnvelope("同上：没有可被轮询的服务进程")

        else -> throw ApiError(404, MSG_NOT_FOUND, "NOT_FOUND")
    }

    // ============================================================
    // auth（7）
    // ============================================================

    private fun register(body: JSONObject): Envelope {
        limiter.checkRegister()
        val username = requireString(body, "username")
        PiqSecurity.usernameRejection(username)?.let { throw validationError("username", it) }
        val password = requireString(body, "password")
        PiqSecurity.newPasswordRejection(password)?.let { throw validationError("password", it) }
        val nickname = optionalString(body, "nickname")
        if (nickname != null && nickname.length > PiqConfig.MAX_NICKNAME_CHARS) throw validationError("nickname", "字符串太长")

        if (crud.getUserByUsername(username) != null) {
            limiter.recordRegisterFailure()
            throw ApiError(409, "用户名已被占用", "USERNAME_TAKEN")
        }
        val userId = try {
            crud.createUser(username, PiqSecurity.hashPassword(password), nickname ?: username)
        } catch (e: SQLiteConstraintException) {
            limiter.recordRegisterFailure()
            throw ApiError(409, "用户名已被占用", "USERNAME_TAKEN")
        }
        limiter.clearRegister()
        crud.ensureUserDefaults(userId)
        val user = crud.getUserById(userId) ?: throw ApiError(500, "注册后读取用户失败", "INTERNAL_ERROR")
        return Envelope(201, issueSession(user))
    }

    private fun login(body: JSONObject): Envelope {
        val username = requireString(body, "username")
        if (username.length < PiqConfig.LOGIN_USERNAME_MIN_CHARS || username.length > PiqConfig.USERNAME_MAX_CHARS) {
            throw validationError("username",
                "用户名长度须为 ${PiqConfig.LOGIN_USERNAME_MIN_CHARS}-${PiqConfig.USERNAME_MAX_CHARS} 位")
        }
        val password = requireString(body, "password")
        val keepLoggedIn = body.boolAt("keep_logged_in")
        limiter.checkLogin(username)

        val user = crud.getUserByUsername(username)
        val stored = user?.textOrNull("password_hash") ?: PiqSecurity.dummyStoredHash()
        val ok = PiqSecurity.verifyPassword(password, stored)
        if (user != null && ok) {
            limiter.clearLogin(username)
            // 2026-10-26 登录持久化：keep_logged_in=true ⇒ 先固化槽；固化失败（加密存储不可用）
            // 降级为普通 30 天会话并记警告日志，登录照常成功、不阻塞。固化成功才打开开关——
            // 开关开着 [SessionHolder.issue] 才会把令牌落盘，下次启动才有被采纳的凭证。
            var persistent = false
            if (keepLoggedIn) {
                val settings = PiqSettings.processSharedOrNull()
                if (settings != null && settings.savePasswordSlot(username, password)) {
                    persistent = true
                    settings.setAutoLoginEnabled(true)
                } else {
                    Log.w(TAG, "login-persist|ok=false|reason=storage-unavailable|downgraded=ttl")
                }
            }
            val payload = issueSession(user, persistent = persistent)
            crud.pruneUserSessions(user.userId())
            return Envelope(200, payload)
        }
        limiter.recordLoginFailure(username)
        throw ApiError(401, "用户名或密码错误", "AUTH_FAILED")
    }

    private fun issueSession(user: JSONObject, persistent: Boolean = false): JSONObject {
        val token = PiqSecurity.generateToken()
        crud.createSession(token, user.userId(), persistent = persistent)
        sessions.issue(token)
        return JSONObject().put("token", token).put("user", ApiProjection.user(user))
    }

    // ============================================================
    // 登录持久化（2026-10-26 双端对齐；与桌面 routes/auth.py 镜像，契约摘要）：
    // GET /auth/persistence（需登录）→ {"enabled": 槽存在且槽内用户名==当前用户}，响应永不携带口令；
    // POST /auth/persistence（需登录）{"password"} 必填（缺失/空 422）→ 口令错 400 WRONG_PASSWORD
    // 「密码不正确」→ 对则固化槽 + 开关/令牌落盘 + 当前会话升级 expires_at=NULL → {"enabled": true}；
    // 固化失败 503 PERSISTENCE_UNAVAILABLE「本机加密存储暂不可用，请稍后重试」；
    // DELETE /auth/persistence（需登录）→ 槽属当前用户则清槽 + 开关关（连令牌凭证一起清）+
    // 当前会话降级回 30 天 → {"enabled": false}，幂等；
    // POST /auth/relogin（无需鉴权，空请求体）→ 无槽 401 NO_PERSISTENCE「本机未开启登录持久化」；
    // 用户不存在/口令不符 → 清槽 + 401 AUTH_FAILED「用户名或密码错误」；成功 → 新发 NULL 会话 +
    // 会话治理，响应与 login 同形。本端点不参与登录限流（设备内固化凭证；失败一次即清槽）。
    // 联动副作用：logout / change-password（2026-10-31 #10 起不再重存槽）/ delete-account 均清槽。
    // ============================================================

    private fun getPersistence(): Envelope {
        val user = requireUser()
        val slot = PiqSettings.processSharedOrNull()?.loadPasswordSlot()
        val enabled = slot != null && slot.username == user.optString("username")
        return Envelope(200, JSONObject().put("enabled", enabled))
    }

    private fun enablePersistence(body: JSONObject): Envelope {
        val user = requireUser()
        val settings = PiqSettings.processSharedOrNull()
            ?: throw ApiError(503, "本机加密存储暂不可用，请稍后重试", "PERSISTENCE_UNAVAILABLE")
        val password = requireString(body, "password")
        if (!PiqSecurity.verifyPassword(password, user.textOrNull("password_hash") ?: "")) {
            throw ApiError(400, "密码不正确", "WRONG_PASSWORD")
        }
        if (!settings.savePasswordSlot(user.optString("username"), password)) {
            throw ApiError(503, "本机加密存储暂不可用，请稍后重试", "PERSISTENCE_UNAVAILABLE")
        }
        settings.setAutoLoginEnabled(true)
        sessions.current()?.let { settings.save(it) }
        sessions.current()?.let { crud.upgradeSessionToPersistent(it) }
        return Envelope(200, JSONObject().put("enabled", true))
    }

    private fun disablePersistence(): Envelope {
        val user = requireUser()
        val settings = PiqSettings.processSharedOrNull()
        if (settings != null) {
            val slot = settings.loadPasswordSlot()
            if (slot != null && slot.username == user.optString("username")) settings.clearPasswordSlot()
            // 现有 clear 会连令牌凭证一起清（不落「开关开着但凭证已撤」的中间态）
            settings.setAutoLoginEnabled(false)
        }
        sessions.current()?.let { crud.downgradeSessionToTtl(it) }
        return Envelope(200, JSONObject().put("enabled", false))
    }

    private fun relogin(): Envelope {
        val settings = PiqSettings.processSharedOrNull()
        val slot = settings?.loadPasswordSlot()
            ?: throw ApiError(401, "本机未开启登录持久化", "NO_PERSISTENCE")
        val user = crud.getUserByUsername(slot.username)
        val ok = user != null && PiqSecurity.verifyPassword(slot.password, user.textOrNull("password_hash") ?: "")
        if (!ok) {
            settings.clearPasswordSlot()
            throw ApiError(401, "用户名或密码错误", "AUTH_FAILED")
        }
        // 与 login 同形：issueSession 内 [SessionHolder.issue] 采纳令牌（开关开启时同步落盘）
        val payload = issueSession(user!!, persistent = true)
        crud.pruneUserSessions(user.userId())
        return Envelope(200, payload)
    }

    private fun logout(): JSONObject {
        val user = requireUser()
        sessions.current()?.let { crud.deleteSession(it) }
        // 登录持久化联动：槽属当前用户 ⇒ 清槽（换账号不带走别人的固化凭证）
        clearPasswordSlotIfOwned(user)
        sessions.clear()
        return JSONObject().put("message", "已登出").put("username", user.optString("username"))
    }

    private fun changePassword(body: JSONObject): Envelope {
        val user = requireUser()
        val oldPassword = requireString(body, "old_password")
        val newPassword = requireString(body, "new_password")
        if (!PiqSecurity.verifyPassword(oldPassword, user.textOrNull("password_hash") ?: "")) {
            throw ApiError(400, "原密码不正确", "WRONG_PASSWORD")
        }
        PiqSecurity.newPasswordRejection(newPassword)?.let { throw validationError("new_password", it) }
        crud.updateUserPassword(user.userId(), PiqSecurity.hashPassword(newPassword))
        // 2026-10-31 #10（行为契约变更，与桌面同步）：改密后立即登出——删该用户全部会话（含当前），
        // 槽属当前用户 ⇒ 清槽（不再用新口令重存），清掉当前会话持有者（同 logout）。旧契约（保留当前会话 +
        // 重存槽）废止。
        crud.deleteAllSessions(user.userId())
        clearPasswordSlotIfOwned(user)
        sessions.clear()
        return Envelope(200, JSONObject().put("message", "密码已更新，所有设备已登出，请重新登录"))
    }

    private fun deleteAccount(body: JSONObject): Envelope {
        val user = requireUser()
        val password = requireString(body, "password")
        if (!PiqSecurity.verifyPassword(password, user.textOrNull("password_hash") ?: "")) {
            throw ApiError(400, "密码不正确", "WRONG_PASSWORD")
        }
        crud.deleteUserAccount(user.userId())
        // 登录持久化联动：删号后槽属该用户 ⇒ 清槽
        clearPasswordSlotIfOwned(user)
        sessions.clear()
        return Envelope(200, JSONObject().put("message", "账号及全部数据已删除"))
    }

    /** 槽属给定用户才清（logout / delete-account 共用的联动判定）。 */
    private fun clearPasswordSlotIfOwned(user: JSONObject) {
        val settings = PiqSettings.processSharedOrNull() ?: return
        val slot = settings.loadPasswordSlot()
        if (slot != null && slot.username == user.optString("username")) settings.clearPasswordSlot()
    }

    private fun updateProfile(body: JSONObject): Envelope {
        val user = requireUser()
        val avatar = optionalString(body, "avatar")
        if (avatar != null &&
            (avatar.length > PiqConfig.AVATAR_MAX_CHARS || !PiqConfig.AVATAR_PREFIX_PATTERN.matches(avatar))
        ) {
            throw ApiError(400, "头像格式或大小不合法", "INVALID_AVATAR")
        }
        val nickname = optionalStringAllowingEmpty(body, "nickname")
        if (nickname != null && nickname.length > PiqConfig.MAX_NICKNAME_CHARS) throw validationError("nickname", "字符串太长")
        // 2026-10-26 修 P3（负年龄）：生日晚于今天会让 computeAge 算出负数，入站直接拒（与 Win 端同口径）。
        val birthday = optionalString(body, "birthday")?.let {
            isoOrReject(it, "birthday").also { b -> rejectFutureBirthday(b) }
        }
        val weight = profileWeightOrReject(body)
        crud.updateProfile(
            user.userId(),
            nickname = nickname,
            avatar = avatar,
            birthday = birthday?.toIso(),
            weightKg = weight,
            clearBirthday = body.boolAt("clear_birthday"),
            clearWeight = body.boolAt("clear_weight"),
        )
        val updated = crud.getUserById(user.userId()) ?: throw ApiError(500, "资料更新后读取失败", "INTERNAL_ERROR")
        return Envelope(200, ApiProjection.user(updated))
    }

    // ============================================================
    // cycles（4）
    // ============================================================

    private fun createCycle(body: JSONObject): Envelope {
        val user = requireUser()
        val userId = user.userId()
        val start = isoOrReject(requireString(body, "period_start"), "period_start")
        val end = optionalString(body, "period_end")?.let { isoOrReject(it, "period_end") }
        val note = optionalString(body, "note") ?: ""
        if (note.length > PiqConfig.MAX_NOTE_CHARS) throw validationError("note", "字符串太长")
        rejectFutureLimit(start, "月经开始日期")
        end?.let { rejectFutureLimit(it, "月经结束日期") }

        val created = store.write { db ->
            if (end != null && end < start) {
                throw ApiError(400, "结束日期不能早于开始日期", "INVALID_PERIOD_END")
            }
            checkDateOverlap(userId, start, end, db, excludingId = null)
            requireAlgorithmReady()
            val newId = crud.createCycle(CycleRow(userId, start.toIso(), end?.toIso(), null, null, note, false), db)
            newId to runPostCycleChain(userId, newId, start, end, note, db)
        }
        val saved = crud.getCycleById(userId, created.first)
            ?: throw ApiError(500, "写入后读取记录失败", "INTERNAL_ERROR")
        return Envelope(201, ApiProjection.cycle(saved).put("prediction", predictionOrNothing(created.second)))
    }

    private fun updateCycle(cycleId: Long, body: JSONObject): Envelope {
        val user = requireUser()
        val userId = user.userId()
        store.write { db ->
            val existing = crud.getCycleById(userId, cycleId, db) ?: throw ApiError(404, "记录不存在", "NOT_FOUND")
            val bodyStart = optionalString(body, "period_start")?.let {
                isoOrReject(it, "period_start").also { d -> rejectFutureLimit(d, "月经开始日期") }
            }
            val bodyEnd = optionalString(body, "period_end")?.let {
                isoOrReject(it, "period_end").also { d -> rejectFutureLimit(d, "月经结束日期") }
            }
            val clearEnd = body.boolAt("clear_period_end")
            if (clearEnd && bodyEnd != null) {
                throw validationError("clear_period_end", "clear_period_end 与 period_end 不能同时提供")
            }
            val note = optionalStringAllowingEmpty(body, "note")
            if (note != null && note.length > PiqConfig.MAX_NOTE_CHARS) throw validationError("note", "字符串太长")

            val finalStart = bodyStart ?: (PyMath.parseIsoDate(existing.textOrNull("period_start"))
                ?: throw ApiError(500, "记录的开始日期不可解析", "INTERNAL_ERROR"))
            val finalEnd = when {
                clearEnd -> null
                bodyEnd != null -> bodyEnd
                else -> PyMath.parseIsoDate(existing.textOrNull("period_end"))
            }
            if (finalEnd != null && finalEnd < finalStart) {
                throw ApiError(400, "结束日期不能早于开始日期", "INVALID_PERIOD_END")
            }
            val startChanged = bodyStart != null && bodyStart.toIso() != existing.optString("period_start")
            if (startChanged) requireAlgorithmReady()
            checkDateOverlap(userId, finalStart, finalEnd, db, excludingId = cycleId)
            val periodDays = if (finalEnd != null) PyMath.daysBetween(finalStart, finalEnd) + 1 else null

            crud.updateCycle(
                userId = userId,
                cycleId = cycleId,
                periodStart = if (startChanged) finalStart.toIso() else null,
                periodEnd = finalEnd?.toIso(),
                periodDays = periodDays,
                note = note,
                clearPeriodEnd = clearEnd,
                handle = db,
            )
            if (startChanged) recomputeAllRecords(userId, db)
        }
        val updated = crud.getCycleById(userId, cycleId) ?: throw ApiError(404, "记录不存在", "NOT_FOUND")
        return Envelope(200, ApiProjection.cycle(updated))
    }

    private fun deleteCycle(cycleId: Long): Envelope {
        val userId = requireUser().userId()
        crud.getCycleById(userId, cycleId) ?: throw ApiError(404, "记录不存在", "NOT_FOUND")
        store.write { db ->
            val remaining = crud.getAllCyclesAsc(userId, db).count { it.optLong("id") != cycleId }
            runDeleteWithAlgorithmGate(remaining, algoGate) {
                crud.deleteCycle(userId, cycleId, db)
                recomputeAllRecords(userId, db)
            }
        }
        return Envelope(
            200,
            JSONObject().put("message", "记录已删除").put("id", cycleId).put("recomputed", true),
        )
    }

    /**
     * POST /cycles 副作用链（早期跨端契约）：算 cycle_length → 异常检查 → 贝叶斯更新 →
     * 生成预测 → 落库 → 回填全部未验证预测。补录历史分支走全量重算管线（v0.14.0 修 AN-4）。
     */
    private fun runPostCycleChain(
        userId: Long,
        newCycleId: Long,
        start: LocalDate,
        end: LocalDate?,
        note: String,
        db: SQLiteDatabase,
    ): JSONObject {
        val prevStart = crud.getPreviousCycleBefore(userId, start.toIso())?.textOrNull("period_start")
        val params = crud.getModelParams(userId, db)
        val lengths = JSONArray(crud.getAllValidCycleLengths(userId, db).jsonText())
        params.put("cycle_lengths", lengths)

        val algo = PiqAlgo.onNewCycleAdded(start.toIso(), prevStart, params)
        // 2026-10-26 修 P2：algo 输出的 cycle_length 是 Python float，改按 Double 读取
        // （longOrNull 会把 45.5 截成 45），sanitizeCycleLength 同步为 Double 形态。
        val cycleLength = algo.doubleOrNull("cycle_length")
        val isAnomalous = algo.boolAt("is_anomalous")
        val isHardInvalid = algo.boolAt("is_hard_invalid")
        val newParams = algo.optJSONObject("model_params") ?: JSONObject()
        val prediction = algo.optJSONObject("prediction") ?: JSONObject()
        val periodDays = if (end != null) PyMath.daysBetween(start, end) + 1 else null

        crud.finalizeCycleDerived(
            newCycleId, PiqCrud.sanitizeCycleLength(cycleLength), periodDays, isAnomalous, note, db,
        )

        val latestStart = crud.getAllCyclesAsc(userId, db).lastOrNull()?.textOrNull("period_start") ?: start.toIso()
        if (latestStart != start.toIso()) {
            recomputeAllRecords(userId, db)
            return currentPredictionPayload(userId, db)
        }

        if (cycleLength != null && !isHardInvalid) {
            crud.updateModelParams(
                userId,
                meanCycle = newParams.optDouble("mean_cycle"),
                stdCycle = newParams.optDouble("std_cycle"),
                nRecords = newParams.optLong("n_records"),
                emaCycle = newParams.optDouble("ema_cycle"),
                priorMean = newParams.optDouble("prior_mean"),
                priorStd = newParams.optDouble("prior_std"),
                priorWeight = newParams.optDouble("prior_weight"),
                handle = db,
            )
        }

        crud.getAllPredictions(userId, db).forEach { pred ->
            if (pred.textOrNull("actual_date") == null) {
                val predicted = PyMath.parseIsoDate(pred.textOrNull("predicted_date")) ?: return@forEach
                crud.backfillPredictionActual(
                    pred.optLong("id"), start.toIso(), kotlin.math.abs(PyMath.daysBetween(predicted, start)), db,
                )
            }
        }

        if (prediction.textOrNull("predicted_date") != null) {
            crud.createPrediction(predictionRow(userId, prediction), db)
        }
        return prediction
    }

    /** cycles._current_prediction_payload：与 regenerate 同源同参，只读不写。 */
    private fun currentPredictionPayload(userId: Long, db: SQLiteDatabase): JSONObject {
        val lengths = crud.getAllValidCycleLengths(userId, db)
        val latest = crud.getLatestCycle(userId, db) ?: return PiqAlgo.predictNextPeriod(null, lengths, null)
        return PiqAlgo.predictNextPeriod(
            latest.textOrNull("period_start"), lengths, PiqAlgo.replayEma(lengths, excludeLast = true),
        )
    }

    /** cycles._recompute_all_records：重推派生字段 → 重算管线 → 重推 actual（AN-3）。 */
    private fun recomputeAllRecords(userId: Long, db: SQLiteDatabase) {
        recompute.recomputeDerivedFields(userId, db)
        recomputeAfterDeleteTx(db, userId)
        rebackfillPredictionActuals(userId, db)
    }

    private fun recomputeAfterDeleteTx(db: SQLiteDatabase, userId: Long) {
        val lengths = crud.getAllValidCycleLengths(userId, db)
        recompute.fullRecomputeModelParams(userId, lengths, db)
        crud.deleteUnverifiedPredictions(userId, db)
        recompute.regenerateCurrentPrediction(userId, db)
    }

    /**
     * cycles._rebackfill_prediction_actuals：锚点 = `predicted_date` 之前最后一条记录，
     * 来潮日 = 锚点之后最早一条；推不出锚点或锚点后无记录则保持原状（不做"清空"语义）。
     * 判定规则在 [PredictionActualBackfill]（纯逻辑，导入路径共用同一实现）；这里只做映射与写库。
     */
    private fun rebackfillPredictionActuals(userId: Long, db: SQLiteDatabase): Int {
        val starts = crud.getAllCyclesAsc(userId, db).mapNotNull { PyMath.parseIsoDate(it.textOrNull("period_start")) }
        if (starts.isEmpty()) return 0
        val rows = crud.getAllPredictions(userId, db).mapNotNull { pred ->
            val predicted = PyMath.parseIsoDate(pred.textOrNull("predicted_date")) ?: return@mapNotNull null
            PredictionBackfillRow(
                predictionId = pred.optLong("id"),
                predictedDate = predicted,
                currentActualDate = pred.textOrNull("actual_date"),
                currentErrorDays = pred.longOrNull("error_days"),
            )
        }
        val updates = PredictionActualBackfill.plan(starts, rows)
        updates.forEach { crud.backfillPredictionActual(it.predictionId, it.actualDate, it.errorDays, db) }
        return updates.size
    }

    /** cycles._check_date_overlap：前后邻居全量规则（AN-4）；未填结束日占用 [start, start]。 */
    private fun checkDateOverlap(
        userId: Long,
        newStart: LocalDate,
        newEnd: LocalDate?,
        db: SQLiteDatabase,
        excludingId: Long?,
    ) {
        val records = crud.getAllCyclesAsc(userId, db).filter { it.optLong("id") != excludingId }
        var prev: JSONObject? = null
        var next: JSONObject? = null
        for (r in records) {
            val s = PyMath.parseIsoDate(r.textOrNull("period_start")) ?: continue
            if (s < newStart) {
                val prevS = prev?.let { PyMath.parseIsoDate(it.textOrNull("period_start")) }
                if (prevS == null || prevS < s) prev = r
            } else {
                val nextS = next?.let { PyMath.parseIsoDate(it.textOrNull("period_start")) }
                if (nextS == null || s < nextS) next = r
            }
        }
        prev?.let { p ->
            val prevEnd = PyMath.parseIsoDate(p.textOrNull("period_end"))
                ?: PyMath.parseIsoDate(p.textOrNull("period_start"))
            if (prevEnd != null && !newStart.isAfter(prevEnd)) {
                throw ApiError(
                    400,
                    "开始日期与前一条记录（${p.optString("period_start")}~${prevEnd.toIso()}）重叠：" +
                        "period_start 不能早于或等于上一条记录的 period_end",
                    "DATE_OVERLAP",
                )
            }
        }
        next?.let { n ->
            val occupiedUntil = (newEnd ?: newStart).toIso()
            val nextStart = n.optString("period_start")
            if (occupiedUntil >= nextStart) {
                throw ApiError(
                    400,
                    "记录区间与下一条记录（$nextStart）重叠：period_end 不能晚于或等于下一条记录的 period_start",
                    "DATE_OVERLAP",
                )
            }
        }
    }

    // ============================================================
    // predictions（2）/ analysis（3）
    // ============================================================

    /**
     * 修 #27：三种状态都返回 Win `PredictionCurrentResponse` 的 **10 键**
     * （predicted_date / predicted_start_lower / predicted_start_upper / confidence /
     * model_version / days_until_predicted / model_params / message / is_corrected /
     * corrected_from）。Win 路由的空态只回 4 键，其余由 response_model 默认值补齐——
     * 安卓手写 JSON 没有那一层，必须自己补：空态缺键补 null / false（model_params=null，
     * 与 response_model 的 `Optional[dict] = None` 一致），正常态补 message=null。
     */
    private fun currentPrediction(): Envelope {
        val userId = requireUser().userId()
        requireAlgorithmReady()
        val resolved = freshPrediction(userId)
        val latestCycle = resolved.optJSONObject("latest_cycle")
        if (latestCycle == null) {
            return Envelope(200, emptyPrediction("尚无月经记录，请先记录至少一次月经开始日期"))
        }
        val latestPred = resolved.optJSONObject("latest_pred")
        if (latestPred == null) {
            return Envelope(200, emptyPrediction("暂无预测，请稍后重试"))
        }
        val predicted = PyMath.parseIsoDate(latestPred.textOrNull("predicted_date"))
        return Envelope(200, JSONObject()
            .put("predicted_date", latestPred.nullableString("predicted_date"))
            .put("predicted_start_lower", latestPred.nullableString("predicted_start_lower"))
            .put("predicted_start_upper", latestPred.nullableString("predicted_start_upper"))
            .put("confidence", latestPred.opt("confidence"))
            .put("model_version", latestPred.opt("model_version"))
            .put("days_until_predicted", if (predicted == null) JSONObject.NULL else PyMath.daysBetween(LocalDate.now(), predicted))
            .put("model_params", resolved.optJSONObject("model_params") ?: JSONObject())
            .put("message", JSONObject.NULL)
            .put("is_corrected", resolved.optBoolean("is_corrected"))
            .put("corrected_from", resolved.nullableString("corrected_from")))
    }

    /** 无预测时的 10 键空态（Win response_model 的默认值形态：null / 0.0 / none / false）。 */
    private fun emptyPrediction(message: String): JSONObject = JSONObject()
        .put("predicted_date", JSONObject.NULL)
        .put("predicted_start_lower", JSONObject.NULL)
        .put("predicted_start_upper", JSONObject.NULL)
        .put("confidence", 0.0)
        .put("model_version", "none")
        .put("days_until_predicted", JSONObject.NULL)
        .put("model_params", JSONObject.NULL)
        .put("message", message)
        .put("is_corrected", false)
        .put("corrected_from", JSONObject.NULL)

    private fun predictionHistory(): Envelope {
        val rows = crud.getPredictionHistory(requireUser().userId(), PiqConfig.PREDICTION_HISTORY_LIMIT)
        return Envelope(200, ApiProjection.cycles(rows, ApiProjection::predictionHistoryItem))
    }

    private fun accuracy(): Envelope {
        val userId = requireUser().userId()
        requireAlgorithmReady()
        val rows = crud.getAllPredictions(userId)
        return Envelope(200, PiqAlgo.evaluatePredictions(rows.jsonArray()))
    }

    private fun cycleStats(): Envelope {
        val userId = requireUser().userId()
        requireAlgorithmReady()
        val cycles = crud.getAllCycles(userId)
        if (cycles.isEmpty()) {
            return Envelope(200, JSONObject()
                .put("total_records", 0)
                .put("total_cycles", 0)
                .put("avg_cycle_length", JSONObject.NULL)
                .put("avg_period_days", JSONObject.NULL)
                .put("shortest_cycle", JSONObject.NULL)
                .put("longest_cycle", JSONObject.NULL)
                .put("anomalous_count", 0)
                .put("status", "EMPTY")
                .put("status_message", "暂无数据")
                .put("clinical_notes", JSONArray()))
        }
        // 2026-10-26 修 P2：cycle_length 改按 Double 读取（库里可能存有 45.5 这类小数 REAL，
        // longOrNull 会截断）；period_days 仍是整日数，保持 Long。
        val valid = cycles.mapNotNull { it.doubleOrNull("cycle_length") }
        val days = cycles.mapNotNull { it.longOrNull("period_days") }
        val anomalous = cycles.count { it.boolAt("is_anomalous") }
        val avgCycle = if (valid.isEmpty()) null else valid.sumOf { it } / valid.size
        val avgPeriod = if (days.isEmpty()) null else days.sumOf { it.toDouble() } / days.size
        val recentAnomalous = crud.getRecentAnomalousCount(userId, PiqConfig.ANOMALY_CONSECUTIVE_THRESHOLD)
        val (status, message) = determineStatus(cycles.size, recentAnomalous)

        return Envelope(200, JSONObject()
            .put("total_records", cycles.size)
            .put("total_cycles", valid.size)
            .put("avg_cycle_length", if (avgCycle == null) JSONObject.NULL else PyMath.roundTo(avgCycle, 2))
            .put("avg_period_days", if (avgPeriod == null) JSONObject.NULL else PyMath.roundTo(avgPeriod, 2))
            .put("shortest_cycle", if (valid.isEmpty()) JSONObject.NULL else valid.min())
            .put("longest_cycle", if (valid.isEmpty()) JSONObject.NULL else valid.max())
            .put("anomalous_count", anomalous)
            .put("status", status)
            .put("status_message", message)
            .put("clinical_notes", clinicalNotes(cycles, crud.getLatestPrediction(userId))))
    }

    /** analysis._determine_status（状态机，P12 的近期窗口语义）。 */
    private fun determineStatus(totalRecords: Int, recentAnomalous: Long): Pair<String, String> = when {
        recentAnomalous >= PiqConfig.ANOMALY_CONSECUTIVE_THRESHOLD ->
            "ANOMALY_ALERT" to "近期周期波动较大，建议检查记录或咨询医生"
        totalRecords <= RECORDS_COLD_MAX -> "COLD" to "记录更多周期可提升精度"
        totalRecords <= RECORDS_WARMING_MAX -> "WARMING" to "模型正在学习你的周期"
        totalRecords <= RECORDS_STABLE_MAX -> "STABLE" to "正常展示"
        else -> "MATURE" to "正常展示"
    }

    /** analysis._build_clinical_notes：纯派生提示，措辞「建议关注」不构成诊断。 */
    private fun clinicalNotes(cycles: List<JSONObject>, latestPred: JSONObject?): JSONArray {
        val notes = JSONArray()
        val recent = cycles.sortedByDescending { it.optString("period_start") }.take(PiqConfig.CLINICAL_WINDOW)
        // 2026-10-26 修 P2：同 cycleStats，cycle_length 按 Double 读取（不截断小数 REAL）。
        val lengths = recent.mapNotNull { it.doubleOrNull("cycle_length") }
        val short = lengths.filter { it < PiqConfig.CLINICAL_CYCLE_MIN_DAYS }
        val long = lengths.filter { it > PiqConfig.CLINICAL_CYCLE_MAX_DAYS }
        if (short.isNotEmpty()) notes.put(JSONObject()
            .put("code", "short_cycle").put("severity", "info")
            .put("message", "近期有周期短于 ${PiqConfig.CLINICAL_CYCLE_MIN_DAYS} 天（最短 ${short.min()} 天）。若持续出现，建议咨询医生。"))
        if (long.isNotEmpty()) notes.put(JSONObject()
            .put("code", "long_cycle").put("severity", "info")
            .put("message", "近期有周期长于 ${PiqConfig.CLINICAL_CYCLE_MAX_DAYS} 天（最长 ${long.max()} 天）。若持续出现，建议咨询医生。"))
        val longPeriod = recent.mapNotNull { it.longOrNull("period_days") }.filter { it > PiqConfig.CLINICAL_PERIOD_MAX_DAYS }
        if (longPeriod.isNotEmpty()) notes.put(JSONObject()
            .put("code", "long_period").put("severity", "info")
            .put("message", "近期经期超过 ${PiqConfig.CLINICAL_PERIOD_MAX_DAYS} 天（最长 ${longPeriod.max()} 天）。若持续出现，建议咨询医生。"))

        if (latestPred != null && latestPred.textOrNull("actual_date") == null) {
            val predicted = PyMath.parseIsoDate(latestPred.textOrNull("predicted_date"))
            if (predicted != null) {
                val overdue = PyMath.daysBetween(predicted, LocalDate.now())
                if (overdue >= PiqConfig.OVERDUE_NOTICE_DAYS) {
                    notes.put(JSONObject()
                        .put("code", "overdue").put("severity", "attention")
                        .put("message", "预测日已过 $overdue 天且未记录新周期。月经推迟可能与多种因素有关；" +
                            "若已来潮请到日历记录，若持续未来潮，建议验孕或咨询医生。"))
                }
            }
        }
        return notes
    }

    private fun fertileWindow(): Envelope {
        val userId = requireUser().userId()
        requireAlgorithmReady()
        val resolved = freshPrediction(userId)
        val latestCycle = resolved.optJSONObject("latest_cycle")
        val latestPred = resolved.optJSONObject("latest_pred")
        if (latestCycle == null || latestPred == null) {
            return Envelope(200, PiqAlgo.computeFertilityWindow(null, null, null, PiqConfig.PRIOR_STD, null))
        }
        val params = resolved.optJSONObject("model_params") ?: JSONObject()
        val cycleStd = params.doubleOrNull("std_cycle") ?: PiqConfig.PRIOR_STD
        val history = crud.getAllCycles(userId)
            .mapNotNull { it.longOrNull("period_days") }
            .filter { it >= 1 }
        val predictedPeriodDays =
            if (history.isEmpty()) null else PyMath.intRound(PyMath.median(history.map { it.toDouble() }))
        return Envelope(200, PiqAlgo.computeFertilityWindow(
            latestPred.textOrNull("predicted_date"),
            latestCycle.textOrNull("period_start"),
            latestCycle.textOrNull("period_end"),
            cycleStd,
            predictedPeriodDays,
        ))
    }

    // ============================================================
    // daily-records（2；2026-10-26 用户立项，与桌面 routes/daily.py 镜像）
    // 校验链与桌面同序：字段口径（422）→ 不得晚于今天（422）→
    // 补填窗口 [昨天,今天]（400 DAILY_WINDOW）→ 来潮日（400 NOT_PERIOD_DAY）。
    // 整条链在 DailyPutGate（纯 JVM，可单测）；这里只保留会话与路径日期解析。
    // #14/#15：经期四件套 = 疼痛/血量/心情等级/心情标签（mood_tags，受控词表）；日记文本走独立的
    // /daily-journal，本路由不再读写 mood_note。mood_tags 仅本地存储：响应携带，导出一律不含。
    // 单日读取 = from=to 的区间查询（#28 裁决，不新增单日端点）。
    // ============================================================

    private fun upsertDailyRecord(rawDate: String, body: JSONObject): Envelope {
        val user = requireUser()
        val userId = user.userId()
        val day = PyMath.parseDateStrictIso(rawDate)
            ?: throw validationError("record_date", "日期格式应为 YYYY-MM-DD")
        val values = DailyPutGate.validate(body, day, LocalDate.now()) {
            crud.isPeriodDay(userId, it.toIso())
        }
        crud.upsertDailyRecord(
            DailyRecordRow(
                userId, day.toIso(), values.painPresent, values.painLevel,
                values.flowLevel, values.moodLevel, values.moodTags,
            ),
        )
        val saved = crud.getDailyRecord(userId, day.toIso())
            ?: throw ApiError(500, "写入后读取每日详情失败", "INTERNAL_ERROR")
        return Envelope(200, dailyOut(saved))
    }

    /** DailyRecordOut 同形（经期四件套，含 mood_tags 数组；#14 起不再携带 mood_note）。 */
    private fun dailyOut(row: JSONObject): JSONObject = JSONObject()
        .put("id", row.optLong("id"))
        .put("record_date", row.nullableString("record_date"))
        .put("pain_present", row.boolAt("pain_present"))
        .put("pain_level", row.nullableNumber("pain_level"))
        .put("flow_level", row.optLong("flow_level"))
        .put("mood_level", row.optLong("mood_level"))
        .put("mood_tags", JSONArray(MoodTags.decode(row.textOrNull("mood_tags"))))
        .put("created_at", row.nullableString("created_at"))
        .put("updated_at", row.nullableString("updated_at"))

    /** JournalOut 同形；`row == null`（当日无日记）时 id/note/created_at/updated_at 均为 null。 */
    private fun journalOut(recordDate: String, row: JSONObject?): JSONObject = JSONObject()
        .put("id", row?.nullableNumber("id") ?: JSONObject.NULL)
        .put("record_date", recordDate)
        .put("note", row?.nullableString("note") ?: JSONObject.NULL)
        .put("created_at", row?.nullableString("created_at") ?: JSONObject.NULL)
        .put("updated_at", row?.nullableString("updated_at") ?: JSONObject.NULL)

    /** 查询串取参（`a=b&c=d` 形态；日期值不含百分号转义，不做 URL decode）。 */
    private fun queryParam(query: String, key: String): String? =
        // 口径登记（2026-10-26 用户裁定，登记不改）：GET 参数不做 URL decode——日期值
        // （YYYY-MM-DD）不含需转义的字符，故安全；前端重建轮统一补齐 decode。
        query.split('&').map { it.split('=', limit = 2) }
            .firstOrNull { it.first() == key }?.getOrNull(1)

    private fun listDailyRecords(query: String): Envelope {
        val userId = requireUser().userId()
        val from = PyMath.parseDateStrictIso(queryParam(query, "from"))
            ?: throw validationError("from", "日期格式应为 YYYY-MM-DD")
        val to = PyMath.parseDateStrictIso(queryParam(query, "to"))
            ?: throw validationError("to", "日期格式应为 YYYY-MM-DD")
        if (from.isAfter(to)) throw ApiError(400, "from 不得晚于 to", PiqConfig.INVALID_DAILY_CODE)
        val rows = crud.getDailyRecordsRange(userId, from.toIso(), to.toIso())
        val arr = JSONArray()
        rows.forEach { arr.put(dailyOut(it)) }
        return Envelope(200, arr)
    }

    // ---- daily-journal（#14）：与桌面 routes/journal.py 同契约 ----

    private fun listJournal(query: String): Envelope {
        val userId = requireUser().userId()
        val from = PyMath.parseDateStrictIso(queryParam(query, "from"))
            ?: throw validationError("from", "日期格式应为 YYYY-MM-DD")
        val to = PyMath.parseDateStrictIso(queryParam(query, "to"))
            ?: throw validationError("to", "日期格式应为 YYYY-MM-DD")
        if (from.isAfter(to)) throw ApiError(400, "from 不得晚于 to", PiqConfig.INVALID_DAILY_CODE)
        val arr = JSONArray()
        crud.getJournalRange(userId, from.toIso(), to.toIso()).forEach { arr.put(journalOut(it.optString("record_date"), it)) }
        return Envelope(200, arr)
    }

    /** 单日读取：恒 200，当日无日记 ⇒ note=null（前端据此显示未记录态，#28）。 */
    private fun getJournal(rawDate: String): Envelope {
        val userId = requireUser().userId()
        val day = PyMath.parseDateStrictIso(rawDate)
            ?: throw validationError("record_date", "日期格式应为 YYYY-MM-DD")
        return Envelope(200, journalOut(day.toIso(), crud.getJournal(userId, day.toIso())))
    }

    /** 写当日日记：校验链见 [JournalGate]；空/null/纯空白 = 清空即删行（幂等）。 */
    private fun putJournal(rawDate: String, body: JSONObject): Envelope {
        val userId = requireUser().userId()
        val day = PyMath.parseDateStrictIso(rawDate)
            ?: throw validationError("record_date", "日期格式应为 YYYY-MM-DD")
        val note = JournalGate.validate(body, day, LocalDate.now()).note
        if (note == null) {
            crud.deleteJournal(userId, day.toIso())
            return Envelope(200, journalOut(day.toIso(), null))
        }
        crud.upsertJournal(userId, day.toIso(), note)
        val saved = crud.getJournal(userId, day.toIso())
            ?: throw ApiError(500, "写入后读取日记失败", "INTERNAL_ERROR")
        return Envelope(200, journalOut(day.toIso(), saved))
    }

    // ============================================================
    // settings 与导入导出（端点 5 个：`/settings` GET、`/settings` PUT、`/export`、`/export/preview`、`/import`）
    // 导入导出规范（用户 2026-10-26 统一；完整版 = Win routes/settings.py
    // 模块 docstring，本块为 Kotlin 侧摘要，契约数字两端一致）：
    // 1. 格式白名单：文件只有 .json 备份与 .csv 周期表；其他格式不支持、
    //    无解析端点；新增须用户立项。
    // 2. JSON 导出（[exportData]）：字段 cycles/predictions/model_params/
    //    app_settings/exported_at/cycles_total/truncated/predictions_total/
    //    truncated/daily_records/total/truncated；app_settings 恒 {}；截断方向统一
    //    为「取最新」（2026-10-31 修 #33/#35，有意契约变更）：三类各自在**升序全量
    //    列表**上取末尾 N 条，列表本身仍升序输出——cycles 按 period_start ASC,
    //    id ASC 取末尾 MAX_EXPORT_CYCLES（1000，修 #25 的升序契约不变；GET /cycles
    //    仍倒序）；predictions 按规范序取末尾 MAX_EXPORT_PREDICTIONS（1000）；
    //    daily_records 按日期升序取末尾 MAX_EXPORT_DAILY_RECORDS（2000），行内不含
    //    mood_note / mood_tags（仅本地；#14 日记 daily_journal 不导出、导入不碰）。*_total = 库内实际总数、*_truncated = total > 上限；
    //    不变量 MAX_EXPORT_* ≤ MAX_IMPORT_*（否则备份自己导不回来）。
    //    **/export/preview 是数据预览通道、不是备份通道，不截断**（恒返回完整
    //    cycles 列表）：cycles > MAX_IMPORT_CYCLES 时预览仍完整，但据此发起的导入会
    //    被条数上限 422（前端重建轮须提示或先截断）。
    // 3. JSON 导入（[importData]，单事务清空重建）：请求体 {cycles,
    //    predictions?, model_params?, app_settings?, allow_anomalies?,
    //    daily_records?}；cycles 非空否则 400 EMPTY_IMPORT；**导入即完全覆盖——
    //    前端须在导入前弹完全覆盖警告并经用户确认**（用户 2026-10-26 裁定）；
    //    上限 cycles ≤ 1000、
    //    predictions ≤ 2000、daily_records ≤ 4000（MAX_IMPORT_*），超出 422；
    //    不变量 导出 ≤ 导入（1000≤1000、1000≤2000、2000≤4000）；G1-G5 门禁单一来源
    //    ImportGate，命中且未 allow_anomalies=true → 400 DATA_ANOMALY + anomalies；
    //    **门禁基线只用待导入数据自身**（修 #32：ImportGate.baselineCycleLengths，
    //    与 evaluate 内部同一派生实现；不再读库内旧 cycles——清空重建的全量替换下，
    //    旧账号历史中位数会把合法异地备份误判为 G3）。daily_records 按**键存在性**
    //    决策（修 #31）：缺键 → 保留库内既有（不清空、不插入）、显式 [] → 仅清空、
    //    非空 → 清空重建、显式 null → 422 VALIDATION_ERROR（早于门禁）；
    //    daily_records 还原历史（不受窗口/来潮日限制，日期不得晚于今天），行内
    //    note 静默忽略，结构违规 → 400 INVALID_DAILY，时间戳非法 → 400 INVALID_IMPORT；
    //    其余字段非法 → 400 INVALID_IMPORT。导入时间戳（cycles/predictions/daily 同一实现
    //    ImportGate.importTimestampOrNow，修 #26）：只认 JSON 字符串，非字符串/空串/
    //    缺键 → 导入时刻；超 32 字符或含控制字符 → 400 INVALID_IMPORT。
    //    cycles.created_at 一并还原（修 #35）；predictions[].model_params_json 走
    //    ImportModelParams 严格校验（与 Win 同构：dict 数值字段逐项校验、str 必须是
    //    严格合法 JSON 对象且原样保留、null/缺键 → "{}"）；
    //    导入事务内先回填全部预测的 actual_date/error_days，再决定是否补生成当前预测。
    // 4. CSV（仅周期记录；CSV 解析属于重建轮的前端，后端无 CSV 端点，统一走
    //    POST /import；旧前端 transfer.js / data.js 已删除，以下为两端统一契约）：
    //    每行「开始日期,结束日期」，结束可空；日期 YYYY-M-D / YYYY/M/D
    //    混合分隔（年 4 位、月/日 1-2 位，真实日历日期）；去 BOM、\r?\n、
    //    跳过空行；每格剥首尾空白与包裹**整格**的成对引号（非整格包裹的
    //    引号不处理）；第 3 列及以后忽略；首个非空行失败视为表头、其余行报错；
    //    导入行顺序任意（门禁与派生按日历序重算；同一开始日按导入先后定序）；
    //    结束日早于开始日不由前端拦截，交后端处理：默认先被 G1-G5 门禁拦截
    //    （至少 G5：派生 period_days ≤ 0）返回 400 DATA_ANOMALY；确认后
    //    （allow_anomalies=true）结构校验返回 400 INVALID_IMPORT；导出侧 CSV 行
    //    按开始日期升序（与 /export、/export/preview 的 cycles 顺序一致）。CSV 不含
    //    model_params/predictions（走 JSON）。
    // 5. 通道收敛：导入通道只剩 JSON 备份 / CSV / 手动录入；原第三种文件导入通道 2026-10-26 删除。
    // ============================================================

    /**
     * GET /device/settings（2026-10-26 双端对齐）：设备级主题，需登录（401 与其余端点同口径）。
     * 响应刻意只有 `theme` 一个键——close_action / reminder_* 是 **Win 平台键**，本端无此概念，
     * 不暴露（双端契约差异登记见本轮交付报告）。存储走 [PiqSettings] 的
     * SharedPreferences（设备级：不落 DB、不随删号清除）。
     */
    private fun getDeviceSettings(): Envelope {
        requireUser()
        val settings = PiqSettings.processSharedOrNull()
            ?: throw ApiError(503, "设备设置存储尚未就绪，请稍后重试", "SETTINGS_UNAVAILABLE")
        return Envelope(200, JSONObject().put("theme", settings.themeValue()))
    }

    /**
     * PUT /device/settings：部分更新（`theme` 缺键或 JSON null = 不更新，与 Win 同语义；
     * Win 平台键即使出现也一律忽略——本端不认）。非法值（含空串）→ 422 VALIDATION_ERROR，
     * 文案与桌面 pydantic 校验同句。空串这里**刻意**不走 [optionalString]（它把空串当无值），
     * 用显式存在性检查：桌面对 `""` 回 422，两端同判。
     */
    private fun putDeviceSettings(body: JSONObject): Envelope {
        requireUser()
        val settings = PiqSettings.processSharedOrNull()
            ?: throw ApiError(503, "设备设置存储尚未就绪，请稍后重试", "SETTINGS_UNAVAILABLE")
        val theme = if (body.has("theme") && !body.isNull("theme")) body.optString("theme") else null
        if (theme != null && theme !in PiqConfig.DEVICE_THEMES) {
            throw validationError("theme", "theme 必须是 ${PiqConfig.DEVICE_THEMES.joinToString("/")} 之一")
        }
        theme?.let { settings.setThemeValue(it) }
        return Envelope(200, JSONObject().put("theme", settings.themeValue()))
    }

    /**
     * GET /export（修 #33/#35 统一「取最新」）：三类各自在**升序全量列表**上取末尾 N 条
     * （列表本身仍升序输出；旧实现取最早 N 条，丢的恰恰是最近的数据，与「备份」语义相反）。
     * `*_total` 用同一全量列表的 size，`*_truncated = total > 上限`。
     */
    private fun exportData(): Envelope {
        val userId = requireUser().userId()
        val allCycles = crud.getAllCyclesAsc(userId)
        val allPredictions = crud.getPredictionsChronological(userId, null)
        // 2026-10-26：daily_records 与 predictions 同款截断口径；行内剥除 mood_tags（#15，仅本地存储；
        // 废弃的 mood_note 列不再读取，行里本来就没有）。
        // 注意 JSONObject.remove 返回**被删的值**而非对象，必须先建对象再 remove，最后才 put。
        val allDaily = crud.getDailyRecordsChronological(userId, null)
        val dailyExport = JSONArray().also { arr ->
            allDaily.takeLast(PiqConfig.MAX_EXPORT_DAILY_RECORDS).forEach { row ->
                val out = JSONObject(row.toString())
                out.remove("mood_tags")
                arr.put(out)
            }
        }
        return Envelope(200, JSONObject()
            // 修 #25：导出 cycles 统一升序（与 /export/preview、CSV 导出同序）；
            // 修 #33/#35：再取升序列表末尾 MAX_EXPORT_CYCLES 条（takeLast(0) 不出现，常量 > 0）
            .put("cycles", allCycles.takeLast(PiqConfig.MAX_EXPORT_CYCLES).jsonArray())
            .put("cycles_total", allCycles.size)
            .put("cycles_truncated", allCycles.size > PiqConfig.MAX_EXPORT_CYCLES)
            .put("predictions", allPredictions.takeLast(PiqConfig.MAX_EXPORT_PREDICTIONS).jsonArray())
            .put("model_params", crud.getModelParams(userId))
            .put("app_settings", JSONObject())
            .put("exported_at", LocalDate.now().toIso())
            .put("predictions_total", allPredictions.size)
            .put("predictions_truncated", allPredictions.size > PiqConfig.MAX_EXPORT_PREDICTIONS)
            .put("daily_records", dailyExport)
            .put("daily_records_total", allDaily.size)
            .put("daily_records_truncated", allDaily.size > PiqConfig.MAX_EXPORT_DAILY_RECORDS))
    }

    private fun exportPreview(): Envelope {
        val userId = requireUser().userId()
        requireAlgorithmReady()
        val modelParams = crud.getModelParams(userId)
        val validLengths = crud.getAllValidCycleLengths(userId)
        val fresh = freshPrediction(userId)
        return Envelope(200, JSONObject()
            .put("cycles", crud.getAllCyclesAsc(userId).jsonArray())
            .put("prediction", previewPrediction(fresh.optJSONObject("latest_pred"), fresh.optJSONObject("model_params")))
            .put("model", exportModel(modelParams, validLengths)))
    }

    private fun previewPrediction(latestPred: JSONObject?, modelParams: JSONObject?): Any {
        if (latestPred == null) return JSONObject.NULL
        val predicted = PyMath.parseIsoDate(latestPred.textOrNull("predicted_date"))
        return JSONObject()
            .put("predicted_date", latestPred.nullableString("predicted_date"))
            .put("predicted_start_lower", latestPred.nullableString("predicted_start_lower"))
            .put("predicted_start_upper", latestPred.nullableString("predicted_start_upper"))
            .put("confidence", latestPred.nullableNumber("confidence"))
            .put("model_version", latestPred.nullableString("model_version"))
            .put("days_until_predicted", if (predicted == null) JSONObject.NULL else PyMath.daysBetween(LocalDate.now(), predicted))
            .put("model_params", modelParams ?: JSONObject())
            .put("actual_date", latestPred.nullableString("actual_date"))
            .put("created_at", latestPred.nullableString("created_at"))
            .put("id", latestPred.nullableNumber("id"))
    }

    /** settings._build_export_model：字段全部取自 predict_core / model_params，不重写算法。 */
    private fun exportModel(modelParams: JSONObject, validLengths: List<Double>): JSONObject {
        val prevEma = if (validLengths.isEmpty()) null else PiqAlgo.replayEma(validLengths, excludeLast = true)
        val core = PiqAlgo.predictCore(validLengths, prevEma)
        val priorWeight = PyMath.roundTo(core.optDouble("prior_weight"), 4)
        val weights = JSONArray()
            .put(JSONObject().put("label", "先验权重").put("value", priorWeight))
            .put(JSONObject().put("label", "数据权重").put("value", PyMath.roundTo(1.0 - priorWeight, 4)))
        return JSONObject()
            .put("n_records", modelParams.longOrNull("n_records") ?: core.optLong("n"))
            .put("mean_cycle", PyMath.roundTo(modelParams.doubleOrNull("mean_cycle") ?: PiqConfig.PRIOR_MEAN, 4))
            .put("std_cycle", PyMath.roundTo(modelParams.doubleOrNull("std_cycle") ?: PiqConfig.PRIOR_STD, 4))
            .put("ema_cycle", PyMath.roundTo(modelParams.doubleOrNull("ema_cycle") ?: PiqConfig.PRIOR_MEAN, 4))
            .put("prior_mean", PyMath.roundTo(modelParams.doubleOrNull("prior_mean") ?: PiqConfig.PRIOR_MEAN, 4))
            .put("prior_std", PyMath.roundTo(modelParams.doubleOrNull("prior_std") ?: PiqConfig.PRIOR_STD, 4))
            .put("prior_weight", priorWeight)
            .put("posterior_n_eff", PyMath.roundTo(core.optDouble("posterior_n_eff"), 4))
            .put("shrink_irregularity", PyMath.roundTo(core.optDouble("shrink_irregularity"), 4))
            .put("weights", weights)
            .put("model_version", if (validLengths.isEmpty()) "none" else core.optString("model_version"))
    }

    /**
     * POST /import（settings.import_data 的移植）：校验成行 + 单事务落库两段。
     *
     * 拆成 [validateImportPayload] 与 [applyImport] 是因为原来这条线性流水有 125 行
     * 。
     * 导入契约的 JVM 哨兵：`DailyPutGateTest` / `ImportModelParamsTest` /
     * `ImportGateContractTest`（门禁基线 #32、时间戳 #26、daily 键存在性 #31）。
     */
    private fun importData(body: JSONObject): Envelope {
        val userId = requireUser().userId()
        val payload = validateImportPayload(userId, body)
        val counts = applyImport(userId, payload)
        var message = "成功导入 ${counts.first} 条记录、${counts.second.second} 条历史预测"
        if (counts.second.first > 0) message += "、${counts.second.first} 条每日详情"
        return Envelope(200, JSONObject()
            .put("imported_cycles", counts.first)
            .put("imported_predictions", counts.second.second)
            .put("imported_daily_records", counts.second.first)
            .put("message", message))
    }

    /**
     * 只读校验 + 成行，**一个字节都不写库**：
     * 形状闸门 → 替换字符 → 空载荷 → 条数上限 → 异常评估 → 逐条严格校验 → `app_settings` 形态。
     * 闸门顺序保持不变：任何一步不过都抛与改前同码同文案的异常（此时库还没被碰过）。
     * daily_records 的条数上限也在门禁之前校验（修 #31 的「422 先于 400 DATA_ANOMALY」不变），
     * 键存在性语义（缺键保留 / [] 清空）在 [applyImport] 落库时兑现。
     */
    private fun validateImportPayload(userId: Long, body: JSONObject): ImportPayload {
        ImportGate.requirePayloadShapes(body)
        if (ImportGate.hasReplacementCharacter(body)) {
            throw ApiError(
                400,
                "这份文件里的中文已经损坏（多半是用 GBK/ANSI 编码保存的）。" +
                    "请在桌面端把它另存为 UTF-8 编码后再导入。",
                "INVALID_IMPORT",
            )
        }
        val cycles = body.optJSONArray("cycles") ?: JSONArray()
        val predictions = body.optJSONArray("predictions") ?: JSONArray()
        // 2026-10-26 修 P1：闸门只认 cycles 非空（model_params-only / predictions-only 一律拒）——
        // applyImport 对无 cycles 载荷走"清空重建 + resetModelParams"，放行等于清库不载入。
        if (!ImportGate.hasImportablePayload(body)) {
            throw ApiError(400, "导入数据缺少经期记录（cycles 不能为空）", "EMPTY_IMPORT")
        }
        if (cycles.length() > PiqConfig.MAX_IMPORT_CYCLES) {
            throw validationError("cycles", "cycles 超出导入上限（${PiqConfig.MAX_IMPORT_CYCLES} 条）")
        }
        if (predictions.length() > PiqConfig.MAX_IMPORT_PREDICTIONS) {
            throw validationError("predictions", "predictions 超出导入上限（${PiqConfig.MAX_IMPORT_PREDICTIONS} 条）")
        }
        val dailyRows = body.optJSONArray("daily_records") ?: JSONArray()
        if (dailyRows.length() > PiqConfig.MAX_IMPORT_DAILY_RECORDS) {
            throw validationError("daily_records", "daily_records 超出导入上限（${PiqConfig.MAX_IMPORT_DAILY_RECORDS} 条）")
        }

        val today = LocalDate.now()
        // 修 #32：G3/G4 基线由**待导入数据自身**派生（与 evaluate 内部共用同一实现），
        // 不再读库内历史周期长度——导入是清空重建的全量替换，旧历史中位数会误判合法备份。
        val indexedCycles = cycles.indexedObjects()
        val anomalies = ImportGate.evaluate(
            indexedCycles,
            ImportGate.baselineCycleLengths(indexedCycles),
            today,
        )
        if (anomalies.length() > 0 && body.opt("allow_anomalies") != true) {
            throw ApiError(400, "数据异常，需确认", "DATA_ANOMALY", JSONObject().put("anomalies", anomalies))
        }

        val cycleRows = importCycleRows(userId, cycles)
        val predictionRows = importPredictionRows(userId, predictions)
        // 2026-10-26：daily_records 结构校验（ImportGate 单一来源；note 静默忽略、不受窗口限制）。
        // 修 #31：缺键 → null（保留库内既有）；显式 [] → 空列表（仅清空）；非空 → 清空重建。
        val dailyRecords = ImportGate.dailyRowsOrNull(userId, body)

        if (body.has("app_settings") && body.opt("app_settings") != null && body.opt("app_settings") !is JSONObject) {
            throw ApiError(400, "app_settings 必须是对象或 null", "INVALID_IMPORT")
        }
        return ImportPayload(cycleRows, predictionRows, dailyRecords)
    }

    /**
     * 逐条严格校验周期行（G1-G5 之外的字段级规则）。
     * 从 [validateImportPayload] 里切出来只为"一个函数一段事"：日期形态、未来日期、
     * 端点倒挂、备注长度、`is_anomalous` 解析各自抛的码与文案保持原样；
     * 2026-10-31 修 #35 新增 `created_at` 还原（走 [ImportGate.importTimestampOrNow]）。
     */
    private fun importCycleRows(userId: Long, cycles: JSONArray): List<CycleRow> =
        (0 until cycles.length()).map { i ->
            val c = cycles.optJSONObject(i) ?: throw validationError("cycles.$i", "应为对象")
            val start = ImportGate.CYCLE_START.require(c)
            val end = ImportGate.CYCLE_END.optional(c)
            rejectImportFuture(start, "开始日期", start)
            if (end != null) rejectImportFuture(end, "结束日期", start)
            if (end != null && end < start) {
                throw ApiError(400, "记录 ${start.toIso()} 的结束日期早于开始日期", "INVALID_IMPORT")
            }
            val note = c.textOrNull("note") ?: ""
            if (note.length > PiqConfig.MAX_NOTE_CHARS) {
                throw ApiError(400, importNoteTooLongDetail(start.toIso()), "INVALID_IMPORT")
            }
            CycleRow(
                userId = userId,
                periodStart = start.toIso(),
                periodEnd = end?.toIso(),
                // 2026-10-26 修 P2×2：cycle_length 只认 JSON Number（字符串视为无值，桌面 _as_number
                // 同口径）且全链路 Double（导入 45.5 → 存 45.5，不再经 Long 截断）。
                cycleLength = PiqCrud.sanitizeCycleLength(c.strictDoubleOrNull("cycle_length")),
                periodDays = strictInt(c, "period_days"),
                note = note,
                isAnomalous = parseIsAnomalous(c.opt("is_anomalous"), start),
                // 修 #35：还原备份里的 cycles.created_at（与 predictions/daily 同一
                // ImportGate.importTimestampOrNow 口径；null 时 DDL 默认 CURRENT_TIMESTAMP）。
                createdAt = ImportGate.importTimestampOrNow(c, "created_at", "记录", start),
            )
        }

    /**
     * 逐条严格校验历史预测行，并按 `(predicted_date, created_at)` 排序
     * （排序在校验之后；`created_at` 由与 cycles/daily 共用的
     * [ImportGate.importTimestampOrNow] 解析——修 #26：只认 JSON 字符串，非字符串/空串
     * 兜底导入时刻，超长/含控制字符 400 INVALID_IMPORT）。
     * `model_params_json` 走 [ImportModelParams] 的严格校验（dict 字段级、str 严格 JSON 且原样保留），
     * 不再是旧的"类型兜底"。
     */
    private fun importPredictionRows(userId: Long, predictions: JSONArray): List<Pair<PredictionRow, String>> =
        (0 until predictions.length()).map { i ->
            val p = predictions.optJSONObject(i) ?: throw validationError("predictions.$i", "应为对象")
            val predicted = ImportGate.PRED_DATE.require(p)
            val upper = ImportGate.PRED_UPPER.require(p)
            val lower = ImportGate.PRED_LOWER.require(p)
            if (!(lower <= predicted && predicted <= upper)) {
                throw ApiError(400, "预测 ${predicted.toIso()} 的区间端点倒挂", "INVALID_IMPORT")
            }
            val confidence = ImportGate.confidenceValue(p)
            if (confidence == null || confidence < 0.0 || confidence > 1.0) {
                throw ApiError(400, "预测 ${predicted.toIso()} 的 confidence 非法（须为 0.0-1.0 的数值）", "INVALID_IMPORT")
            }
            val modelVersion = ImportGate.normalizeModelVersion(p)
            if (modelVersion.length > PiqConfig.MAX_MODEL_VERSION_LEN ||
                !PiqConfig.ALLOWED_MODEL_VERSIONS.contains(modelVersion)
            ) {
                throw ApiError(
                    400,
                    "预测 ${predicted.toIso()} 的 model_version 非法（合法取值：" +
                        PiqConfig.ALLOWED_MODEL_VERSIONS.sorted().joinToString("/") + "）",
                    "INVALID_IMPORT",
                )
            }
            val actual = ImportGate.PRED_ACTUAL.optional(p)
            // 与 Win `_validate_import_model_params_json` 同构（单一实现见 ImportModelParams）：
            // dict 严格校验后序列化；str 严格校验后原样保留；null/缺键 → "{}"；其余类型 400。
            val mpJson = ImportModelParams.normalize(p.opt("model_params_json"), predicted)
            PredictionRow(
                userId = userId,
                predictedDate = predicted.toIso(),
                predictedStartUpper = upper.toIso(),
                predictedStartLower = lower.toIso(),
                confidence = confidence,
                modelVersion = modelVersion,
                modelParamsJson = mpJson,
                actualDate = actual?.toIso(),
                errorDays = strictInt(p, "error_days"),
            ) to ImportGate.importTimestampOrNow(p, "created_at", "预测", predicted)
        }.sortedWith(compareBy({ it.first.predictedDate }, { it.second }))

    /**
     * 单事务落库（桌面 v0.12.0 修 E7 同口径）：清空重建 → 重推派生字段 → 全量重算 →
     * **回填 actual_date/error_days** → 缺未验证预测时补生成。
     * 返回 `(导入周期数, (导入每日详情数, 导入预测数))`。
     *
     * 修 #31：daily_records 按**键存在性**决策——`null`（请求未携带该键）时**保留库内既有**
     * 每日详情（不删除、不插入）；空列表时仅清空；非空时清空重建。
     */
    private fun applyImport(userId: Long, payload: ImportPayload): Pair<Int, Pair<Int, Int>> = store.write { db ->
        if (payload.cycles.isNotEmpty()) requireAlgorithmReady()
        crud.deleteUserCycles(userId, db)
        crud.deleteUserPredictions(userId, db)
        payload.dailyRecords?.let { rows ->
            crud.deleteUserDailyRecords(userId, db)
            rows.forEach { row ->
                crud.createImportDailyRecord(row, row.createdAt ?: PyMath.nowSqliteUtc(),
                    row.updatedAt ?: PyMath.nowSqliteUtc(), db)
            }
        }
        payload.cycles.forEach { crud.createCycle(it, db) }
        payload.predictions.forEach { (row, createdAt) -> crud.createImportPrediction(row, createdAt, db) }
        if (payload.cycles.isNotEmpty()) {
            recompute.recomputeDerivedFields(userId, db)
            val lengths = crud.getAllValidCycleLengths(userId, db)
            recompute.fullRecomputeModelParams(userId, lengths, db)
            // 与 Win settings.import_data 同一时序：先按导入后的真实记录重推 actual，
            // 再判断 hasUnverified / 补生成当前预测（否则下次 POST /cycles 的全量回填会把
            // 陈年未验证预测的 actual_date 盖成新记录当天，污染精度评估）。
            rebackfillPredictionActuals(userId, db)
            val hasUnverified = crud.getAllPredictions(userId, db).any { it.textOrNull("actual_date") == null }
            if (!hasUnverified) recompute.regenerateCurrentPrediction(userId, db)
        } else {
            crud.resetModelParams(userId, db)
        }
        payload.cycles.size to ((payload.dailyRecords?.size ?: 0) to payload.predictions.size)
    }

    // ============================================================
    // prediction_service（current 与 fertile-window 共用的"确保新鲜"）
    // ============================================================

    /** 返回 {latest_cycle, latest_pred, is_corrected, corrected_from, model_params}。 */
    private fun freshPrediction(userId: Long): JSONObject {
        val latestCycle = crud.getLatestCycle(userId)
        if (latestCycle == null) {
            return JSONObject()
                .put("latest_cycle", JSONObject.NULL)
                .put("latest_pred", JSONObject.NULL)
                .put("is_corrected", false)
                .put("corrected_from", JSONObject.NULL)
                .put("model_params", JSONObject())
        }
        var latestPred = crud.getLatestPrediction(userId)
        var isCorrected = false
        var correctedFrom: String? = null
        var modelParams = JSONObject()

        if (latestPred != null) {
            modelParams = jsonObjectOrEmpty(latestPred.textOrNull("model_params_json"))
            val predicted = PyMath.parseIsoDate(latestPred.textOrNull("predicted_date"))
            val today = LocalDate.now()
            val stale = predicted != null &&
                predicted.plusDays(PiqConfig.PREDICTION_STALE_GRACE_DAYS).isBefore(today) &&
                latestPred.textOrNull("actual_date") == null
            if (stale) {
                val outcome = store.write { db ->
                    val rePred = crud.getLatestPrediction(userId, db)
                    val rePredDate = rePred?.let { PyMath.parseIsoDate(it.textOrNull("predicted_date")) }
                    val reStale = rePred != null && rePred.textOrNull("actual_date") == null &&
                        rePredDate != null && rePredDate.isBefore(today)
                    val reCycle = if (reStale) crud.getLatestCycle(userId, db) else null
                    if (rePredDate == null || reCycle == null) return@write null
                    val lengths = crud.getAllValidCycleLengths(userId, db)
                    val fresh = PiqAlgo.predictNextPeriod(
                        reCycle.textOrNull("period_start"), lengths, PiqAlgo.replayEma(lengths, excludeLast = true),
                    )
                    val freshDate = fresh.textOrNull("predicted_date") ?: return@write null
                    if (PyMath.parseIsoDate(freshDate) == rePredDate) return@write null
                    val audit = fresh.optJSONObject("model_params") ?: JSONObject()
                    audit.put("stale_correction", JSONObject()
                        .put("from_predicted_date", rePred.optString("predicted_date"))
                        .put("corrected_at", utcSecondsIso())
                        .put("anchor_period_start", reCycle.optString("period_start"))
                        .put("n_valid_cycles", lengths.size))
                    crud.createPrediction(
                        PredictionRow(
                            userId, freshDate,
                            fresh.optString("predicted_start_upper"), fresh.optString("predicted_start_lower"),
                            fresh.optDouble("confidence"), fresh.optString("model_version"), audit.toString(),
                        ), db,
                    )
                    rePred to (fresh to audit)
                }
                if (outcome != null) {
                    val rePred = outcome.first
                    val fresh = outcome.second.first
                    val audit = outcome.second.second
                    correctedFrom = rePred.textOrNull("predicted_date")
                    isCorrected = true
                    latestPred = JSONObject(rePred.toString())
                        .put("predicted_date", fresh.optString("predicted_date"))
                        .put("predicted_start_lower", fresh.optString("predicted_start_lower"))
                        .put("predicted_start_upper", fresh.optString("predicted_start_upper"))
                        .put("confidence", fresh.opt("confidence"))
                        .put("model_version", fresh.optString("model_version"))
                    modelParams = audit
                }
            }
        }
        healModelParamsCache(userId)
        return JSONObject()
            .put("latest_cycle", latestCycle)
            .put("latest_pred", latestPred ?: JSONObject.NULL)
            .put("is_corrected", isCorrected)
            .put("corrected_from", correctedFrom ?: JSONObject.NULL)
            .put("model_params", modelParams)
    }

    /** prediction_service.heal_model_params_cache：全字段漂移检测（v0.13.0 修 F13）。 */
    private fun healModelParamsCache(userId: Long) {
        val mp = crud.getModelParams(userId)
        val cycles = crud.getAllValidCycleLengths(userId)
        if (cycles.isEmpty()) return
        val core = PiqAlgo.predictCore(cycles, PiqAlgo.replayEma(cycles, excludeLast = true))
        val eps = PiqConfig.MODEL_PARAMS_DRIFT_EPS
        val epsPw = PiqConfig.MODEL_PARAMS_DRIFT_EPS_PRIOR_WEIGHT
        // 单字段漂移判定（P3）：任一侧**缺键**（`optDouble` 的兜底值是 NaN）即判漂移——
        // IEEE 754 下 NaN 参与的一切比较恒假，旧写法 `abs(NaN-x) > eps` 永远不成立 ⇒
        // 部分字段缺失的漂移被静默放过（只剩 n_records 一条兜底）。这里把"读不到值"
        // 当作"必须自愈"而不是"没有差异"。
        fun drift(a: Double, b: Double, tol: Double): Boolean =
            a.isNaN() || b.isNaN() || kotlin.math.abs(a - b) > tol
        val drifted = drift(mp.optDouble("mean_cycle"), core.optDouble("predicted_cycle"), eps) ||
            drift(mp.optDouble("std_cycle"), core.optDouble("std"), eps) ||
            drift(mp.optDouble("ema_cycle"), core.optDouble("new_ema"), eps) ||
            drift(mp.optDouble("prior_mean"), core.optDouble("mu_post"), eps) ||
            drift(mp.optDouble("prior_std"), core.optDouble("sigma_post"), eps) ||
            drift(mp.optDouble("prior_weight"), core.optDouble("prior_weight"), epsPw) ||
            mp.optLong("n_records") != core.optLong("n")
        if (drifted) crud.updateModelParamsFromCore(userId, core)
    }

    // ============================================================
    // 入参 / 出参小工具
    // ============================================================

    private fun requireUser(): JSONObject {
        val token = sessions.current() ?: throw unauthorized()
        return crud.getSessionUser(token) ?: run {
            sessions.clear()
            throw unauthorized()
        }
    }

    private fun unauthorized() = ApiError(401, "未登录或登录已过期", "UNAUTHORIZED")

    private fun JSONObject.userId(): Long = optLong("id")

    private fun parseBody(path: String, raw: String?): JSONObject {
        if (raw.isNullOrBlank()) return JSONObject()
        return runCatching { JSONObject(raw) }.getOrElse {
            Log.w(TAG, "body-parse-failed|path=$path|len=${raw.length}|type=${it.javaClass.name}")
            throw validationError("body", "请求体不是合法的 JSON 对象")
        }
    }

    private fun requireString(body: JSONObject, key: String): String {
        val raw = body.textOrNull(key) ?: throw validationError(key, "Field required")
        if (raw.isEmpty()) throw validationError(key, "should have at least 1 character")
        return raw
    }

    private fun optionalString(body: JSONObject, key: String): String? = body.textOrNull(key)

    private fun isoOrReject(raw: String, field: String): LocalDate =
        PyMath.parseDateStrictIso(raw) ?: throw validationError(field, "日期格式应为 YYYY-MM-DD")

    private fun rejectFutureLimit(value: LocalDate, label: String) {
        val limit = LocalDate.now().plusDays(PiqConfig.MAX_FUTURE_CYCLE_DAYS)
        if (value.isAfter(limit)) throw validationError(label, "${label}不能晚于今天（$limit）")
    }

    /** settings._reject_import_future_date：与 POST/PUT 同一 config 常量、同一错误族。 */
    private fun rejectImportFuture(value: LocalDate, label: String, recordStart: LocalDate) {
        val limit = LocalDate.now().plusDays(PiqConfig.MAX_FUTURE_CYCLE_DAYS)
        if (value.isAfter(limit)) {
            throw ApiError(
                400,
                "记录 ${recordStart.toIso()} 的$label ${value.toIso()} 晚于允许上限（最晚 $limit）",
                "INVALID_IMPORT",
            )
        }
    }

    /** 桌面口径：`isinstance(x, int) and not isinstance(x, bool)` —— 浮点/字符串一律视为"无值"。 */
    private fun strictInt(row: JSONObject, key: String): Long? {
        if (!row.has(key) || row.isNull(key)) return null
        return when (val raw = row.opt(key)) {
            is Int -> raw.toLong()
            is Long -> raw
            else -> null
        }
    }

    /** settings._parse_is_anomalous：只接受 bool 或 0/1 整数；键缺失/null → false。 */
    private fun parseIsAnomalous(value: Any?, recordStart: LocalDate): Boolean {
        val invalid = ApiError(
            400, "记录 ${recordStart.toIso()} 的 is_anomalous 非法（须为 bool 或 0/1 整数）", "INVALID_IMPORT",
        )
        return when (value) {
            null, JSONObject.NULL -> false
            is Boolean -> value
            is Int -> if (value == 0 || value == 1) value == 1 else throw invalid
            is Long -> if (value == 0L || value == 1L) value == 1L else throw invalid
            else -> throw invalid
        }
    }

    private fun predictionRow(userId: Long, prediction: JSONObject) = PredictionRow(
        userId = userId,
        predictedDate = prediction.optString("predicted_date"),
        predictedStartUpper = prediction.optString("predicted_start_upper"),
        predictedStartLower = prediction.optString("predicted_start_lower"),
        confidence = prediction.optDouble("confidence"),
        modelVersion = prediction.optString("model_version"),
        modelParamsJson = prediction.optJSONObject("model_params")?.toString() ?: "{}",
    )

    /** `prediction` 在无预测日时为 null（早期跨端契约：CycleCreateResponse.prediction 可空）。 */
    private fun predictionOrNothing(prediction: JSONObject): Any =
        if (prediction.textOrNull("predicted_date") == null) JSONObject.NULL else prediction

    private fun jsonObjectOrEmpty(raw: String?): JSONObject =
        if (raw.isNullOrEmpty()) JSONObject() else runCatching { JSONObject(raw) }.getOrDefault(JSONObject())

    companion object {
        private const val TAG = "PIQ"
        private const val PATH_ASSETLINKS = "/.well-known/assetlinks.json"
        private val CYCLE_ID = Regex("^/cycles/\\d+$")

        /** /daily-records/{date}：路径参数为日期文本（形态由 isoOrReject 严格校验）。 */
        private val DAILY_DATE = Regex("^/daily-records/[^/]+$")

        /** /daily-journal/{date}：路径参数为日期文本（形态由 parseDateStrictIso 严格校验）。 */
        private val JOURNAL_DATE = Regex("^/daily-journal/[^/]+$")

        /**
         * `analysis._determine_status` 的记录数分档上界（桌面在同一函数里写死的三个档位）：
         * 少于等于 COLD 上界 = 冷启动样本不足；超过 STABLE 上界即进入 MATURE。
         */
        private const val RECORDS_COLD_MAX = 2
        private const val RECORDS_WARMING_MAX = 5
        private const val RECORDS_STABLE_MAX = 10

        /** `POST /api/v1/import` 的后缀（只有它走四档可读错误 + 体积闸门）。 */
        private const val REST_IMPORT = "/import"

        /** 404 的用户可见文案。 */
        private const val MSG_NOT_FOUND = "本机没有对应的功能。请从应用内的页面重新进入；" +
            "如果一直出现这句话，请把看到的页面和操作步骤记下来反馈。"

        /**
         * `CYCLE_ID` 正则只约束"全是数字"；20 位以上的超长数字超出 Long 范围，`toLong()`
         * 抛 `NumberFormatException` 会落进 `handle()` 的 catch-all 变 500。这类 id 不可能
         * 对应任何已存在的周期行 ⇒ 对齐"资源不存在"语义给 404（与 `getCycleById` 行缺失
         * 同一条文案与错误码），其余路径不变。
         */
        private fun cycleIdOf(rest: String): Long =
            rest.removePrefix("/cycles/").toLongOrNull() ?: throw ApiError(404, "记录不存在", "NOT_FOUND")

    }
}

private fun List<JSONObject>.jsonArray(): JSONArray = JSONArray().also { a -> forEach { a.put(it) } }

private fun List<Double>.jsonText(): String = JSONArray().also { a -> forEach { a.put(it) } }.toString()

/**
 * 导入专用：带**原始下标**的对象条目（2026-10-26 修 P2 导入 #N 标签错位）。
 * 桌面 `enumerate(cycles)` 保留原始下标、非 dict 条目跳过；安卓此前 `mapNotNull { optJSONObject(it) }`
 * 先把非对象条目丢掉再传入门禁 ⇒ ImportGate 的 `#N` 标签按**过滤后位置**编号、与备份文件错位。
 * 非对象条目本身仍由 `importCycleRows` 的逐条校验拒（422），这里只保证下标不错位。
 */
private fun JSONArray.indexedObjects(): List<Pair<Int, JSONObject>> =
    (0 until length()).mapNotNull { i -> optJSONObject(i)?.let { i to it } }

/**
 * 导入备注超长时给用户看的那句 400 文案（`importCycleRows` 的拒因）。
 *
 * 单独成函数只为一件事：让这句话能被 JVM 哨兵直接调用并逐字比对 —— `importCycleRows` 要 `PiqDb`
 * 才能走到，单测够不到（本文件顶上的 [profileWeightOrReject] 与 [notImplementedEnvelope] 是同一手法）。
 * 文案是**用户可见**的，所以它写的上限必须与真正的闸门 [PiqConfig.MAX_NOTE_CHARS] 是同一个数。
 */
internal fun importNoteTooLongDetail(startIso: String): String =
    "记录 $startIso 的备注超长（>${PiqConfig.MAX_NOTE_CHARS} 字符）"

/**
 * [PiqRouter.validateImportPayload] 的产物：已经过全部闸门、但**还没有一行落库**的导入载荷。
 * 预测按 `(行, created_at)` 成对带着 —— `created_at` 不是 `PredictionRow` 的列，
 * 由 `createImportPrediction` 单独绑定（桌面把导入行的时间戳原样带走）；
 * `dailyRecords` 同理带 created_at/updated_at（还原历史）。
 *
 * 修 #31：`dailyRecords` 可空——`null` 表示请求**未携带** daily_records 键（落库时保留库内既有），
 * `emptyList()` 表示显式 `[]`（仅清空），非空表示清空重建。
 */
private data class ImportPayload(
    val cycles: List<CycleRow>,
    val predictions: List<Pair<PredictionRow, String>>,
    val dailyRecords: List<DailyRecordRow>?,
)
