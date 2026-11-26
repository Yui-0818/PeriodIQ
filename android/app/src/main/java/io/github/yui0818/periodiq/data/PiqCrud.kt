/*
 * Copyright (c) 2026 Yui_0818 (aaaj6719@gmail.com)
 * Licensed under the PolyForm Noncommercial License 1.0.0.
 * Commercial use is prohibited without separate written authorization.
 * See LICENSE and COMMERCIAL.md in the repository root.
 */

package io.github.yui0818.periodiq.data

import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteStatement
import io.github.yui0818.periodiq.PiqConfig
import io.github.yui0818.periodiq.PyMath
import io.github.yui0818.periodiq.api.contract.ApiError
import io.github.yui0818.periodiq.boolAt
import io.github.yui0818.periodiq.doubleOrNull
import io.github.yui0818.periodiq.domain.daily.MoodTags
import io.github.yui0818.periodiq.longOrNull
import io.github.yui0818.periodiq.textOrNull
import org.json.JSONObject

/**
 * 数据访问层：桌面 `backend/app/db/crud.py` 的 Kotlin 忠实移植。
 *
 * **口径来源**：`crud.py` + 早期跨端契约是唯一规格来源，SQL 文本、函数边界与
 * 返回值语义逐条对照（`insert_row` 返 lastrowid、`write_query` 返 rowcount；
 * "None = 不更新"与"clear_\* = 显式清空"两套语义不得合并）。全部语句参数化（`?` 占位符）。
 *
 * **事务约定**照 crud.py 文件头的 E7：参与"删除 / 修正 / 导入重算"链的函数都接
 * `handle: SQLiteDatabase?` —— 传外层写事务连接时并入同一事务，传 null 时自开一次事务
 * （桌面用不可重入的 `asyncio.Lock` 快速失败；安卓用 [PiqDb.write] 的 `ReentrantLock`
 * 串行化，链内必须透传同一连接，否则中途异常会留下半提交状态）。
 */
class PiqCrud(private val store: PiqDb) {

    private val db: SQLiteDatabase get() = store.handle

    // ============================================================
    // users / sessions / profile
    // ============================================================

    /** crud.create_user：返回新 id；用户名 UNIQUE 冲突抛异常（由路由转 409）。 */
    fun createUser(username: String, passwordHash: String, nickname: String?, handle: SQLiteDatabase? = null): Long =
        insert(handle, "INSERT INTO users (username, password_hash, nickname) VALUES (?, ?, ?)",
            argsOf(username, passwordHash, nickname))

    /** crud.get_user_by_username：按用户名取整行；不存在返回 null。 */
    fun getUserByUsername(username: String): JSONObject? =
        one("SELECT * FROM users WHERE username = ?", argsOf(username), PiqDb.USER_COLUMNS)

    /** crud.get_user_by_id：按 user_id 取整行；不存在返回 null。 */
    fun getUserById(userId: Long): JSONObject? =
        one("SELECT * FROM users WHERE id = ?", argsOf(userId), PiqDb.USER_COLUMNS)

    /** crud.update_profile：仅更新传入字段；clear_* 表示显式清空可空字段。 */
    fun updateProfile(
        userId: Long,
        nickname: String? = null,
        avatar: String? = null,
        birthday: String? = null,
        weightKg: Double? = null,
        clearBirthday: Boolean = false,
        clearWeight: Boolean = false,
        handle: SQLiteDatabase? = null,
    ): Int {
        val fields = mutableListOf<String>()
        val params = mutableListOf<Any?>()
        if (nickname != null) { fields.add("nickname = ?"); params.add(nickname) }
        if (avatar != null) { fields.add("avatar = ?"); params.add(avatar) }
        if (birthday != null) { fields.add("birthday = ?"); params.add(birthday) }
        else if (clearBirthday) fields.add("birthday = NULL")
        if (weightKg != null) { fields.add("weight_kg = ?"); params.add(weightKg) }
        else if (clearWeight) fields.add("weight_kg = NULL")
        if (fields.isEmpty()) return 0
        params.add(userId)
        return update(handle, "UPDATE users SET ${fields.joinToString(", ")} WHERE id = ?", params.toTypedArray())
    }

    /**
     * crud.create_session（v0.13.1 修 G4）：缺省 `expires_at` = UTC 此刻 + SESSION_TTL_DAYS；
     * 2026-10-26 登录持久化扩参：`persistent=true` ⇒ `expires_at = NULL`（永不登出；
     * 读取侧 `getSessionUser` 对 NULL 按"不过期"判定，与桌面同一条 SQL 语义）。
     */
    fun createSession(token: String, userId: Long, persistent: Boolean = false, handle: SQLiteDatabase? = null): Long =
        insert(handle, "INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)",
            argsOf(token, userId,
                if (persistent) null else PyMath.utcPlusDays(PiqConfig.SESSION_TTL_DAYS)))

    /**
     * 2026-10-26 登录持久化：把当前会话升级为永不过期（POST /auth/persistence、
     * relogin 成功后的既有 NULL 会话无需再调）。按令牌定位，当前令牌由调用方经
     * `sessions.current()` 取。
     */
    fun upgradeSessionToPersistent(token: String, handle: SQLiteDatabase? = null): Int =
        update(handle, "UPDATE sessions SET expires_at = NULL WHERE token = ?", argsOf(token))

    /** 2026-10-26 登录持久化：当前会话降级回普通有效期（此刻 + SESSION_TTL_DAYS，DELETE /auth/persistence）。 */
    fun downgradeSessionToTtl(token: String, handle: SQLiteDatabase? = null): Int =
        update(handle, "UPDATE sessions SET expires_at = ? WHERE token = ?",
            argsOf(PyMath.utcPlusDays(PiqConfig.SESSION_TTL_DAYS), token))

    /**
     * crud.get_session_user：过期判定在 SQL 内完成
     * （`expires_at IS NULL OR expires_at > datetime('now')`；NULL 按不过期 fail-open）。
     */
    fun getSessionUser(token: String): JSONObject? = one(
        "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id " +
            "WHERE s.token = ? AND (s.expires_at IS NULL OR s.expires_at > datetime('now'))",
        argsOf(token), PiqDb.USER_COLUMNS,
    )

    /** crud.delete_session：按令牌删会话，返回删除行数。当前唯一调用点是登出（`/auth/logout`）；删号不经过本函数，走 `deleteUserAccount` 里按 `user_id` 整片删。 */
    fun deleteSession(token: String, handle: SQLiteDatabase? = null): Int =
        update(handle, "DELETE FROM sessions WHERE token = ?", argsOf(token))

    /** crud.prune_user_sessions：先清过期，再只保留最新 N 个（顺序不可交换，同一事务）。 */
    fun pruneUserSessions(userId: Long, handle: SQLiteDatabase? = null) {
        val run: (SQLiteDatabase) -> Unit = { h ->
            bind(h, SQL_PRUNE_EXPIRED, argsOf(userId)).use { it.executeUpdateDelete() }
            bind(h, SQL_PRUNE_KEEP_NEWEST, argsOf(userId, userId, PiqConfig.SESSION_MAX_PER_USER))
                .use { it.executeUpdateDelete() }
        }
        if (handle != null) run(handle) else store.write { run(it) }
    }

    /** crud.update_user_password：改写口令哈希列，返回受影响行数。 */
    fun updateUserPassword(userId: Long, passwordHash: String, handle: SQLiteDatabase? = null): Int =
        update(handle, "UPDATE users SET password_hash = ? WHERE id = ?", argsOf(passwordHash, userId))

    /** crud.delete_all_sessions（#10）：删该用户全部会话（含当前）——改密后立即登出。 */
    fun deleteAllSessions(userId: Long, handle: SQLiteDatabase? = null): Int =
        update(handle, "DELETE FROM sessions WHERE user_id = ?", argsOf(userId))

    /** crud.delete_user_account：子表先删、users 行最后删（单事务）。 */
    fun deleteUserAccount(userId: Long, handle: SQLiteDatabase? = null) {
        val run: (SQLiteDatabase) -> Unit = { h ->
            SQL_DELETE_USER_ACCOUNT.forEach { sql -> bind(h, sql, argsOf(userId)).use { it.executeUpdateDelete() } }
        }
        if (handle != null) run(handle) else store.write { run(it) }
    }

    /**
     * crud.ensure_user_defaults：model_params / app_settings 默认行（幂等 INSERT OR IGNORE）。
     *
     * 2026-10-26 审计（P3 两语句非原子）：唯一调用点是注册（`PiqRouter.register`），不带 handle
     * ⇒ 两条语句各自成事务；第一条成功、第二条失败会留下"users 行在、默认行缺"的中间态。
     * 判定**可达但无破坏**，保持现状不合并：缺行被全部读写方自愈——[getModelParams] 对缺行
     * 返回默认值，[updateSettings]/[updateModelParams] 是 UPSERT（行不存在则插入）。
     * 强行并成一个事务需要把 createUser 也拉进同一事务边界（跨文件改动），零破坏优先。
     */
    fun ensureUserDefaults(userId: Long, handle: SQLiteDatabase? = null) {
        update(handle, "INSERT OR IGNORE INTO model_params (user_id) VALUES (?)", argsOf(userId))
        update(handle, "INSERT OR IGNORE INTO app_settings (user_id) VALUES (?)", argsOf(userId))
    }

    // ============================================================
    // cycles
    // ============================================================

    /** crud.get_all_cycles：该用户全部周期，`period_start` 倒序、同日期再按 `id` 倒序。 */
    fun getAllCycles(userId: Long): List<JSONObject> =
        all("SELECT * FROM cycles WHERE user_id = ? ORDER BY period_start DESC, id DESC",
            argsOf(userId), PiqDb.CYCLE_COLUMNS)

    /** crud.get_cycle_by_id：取该用户名下指定 id 的一条周期；不存在或不属于该用户返回 null。 */
    fun getCycleById(userId: Long, cycleId: Long, handle: SQLiteDatabase? = null): JSONObject? =
        oneOn(handle, "SELECT * FROM cycles WHERE id = ? AND user_id = ?",
            argsOf(cycleId, userId), PiqDb.CYCLE_COLUMNS)

    /** crud.get_latest_cycle：period_start 最新的一条周期（预测与重算的锚点）。 */
    fun getLatestCycle(userId: Long, handle: SQLiteDatabase? = null): JSONObject? =
        oneOn(handle, "SELECT * FROM cycles WHERE user_id = ? ORDER BY period_start DESC, id DESC LIMIT 1",
            argsOf(userId), PiqDb.CYCLE_COLUMNS)

    /** crud.get_previous_cycle_before：早于给定日期的最近一条（无 id 次键，与桌面同形）。 */
    fun getPreviousCycleBefore(userId: Long, periodStart: String): JSONObject? =
        one("SELECT * FROM cycles WHERE user_id = ? AND period_start < ? ORDER BY period_start DESC LIMIT 1",
            argsOf(userId, periodStart), PiqDb.CYCLE_COLUMNS)

    /** crud.get_all_cycles_asc：日历**升序**的全部周期；导出（/export、/export/preview）同样使用升序；GET /cycles 仍为倒序。 */
    fun getAllCyclesAsc(userId: Long, handle: SQLiteDatabase? = null): List<JSONObject> =
        allOn(handle, "SELECT * FROM cycles WHERE user_id = ? ORDER BY period_start ASC, id ASC",
            argsOf(userId), PiqDb.CYCLE_COLUMNS)

    /**
     * crud.create_cycle：`cycle_length` 入库前经 sanitize（超 [7,90] → NULL，M4 Bug1）。
     * 2026-10-26 修 P2：`cycle_length` 全链路改 Double——导入 45.5 存 45.5（桌面同形），
     * 不再在读取/折算处截成整数。SQLite INTEGER 亲和列对整值 Double 自动收敛回 INTEGER 存储。
     * 2026-10-31 修 #35：`created_at` 随行写入（导入还原）；[CycleRow.createdAt] 为 null 时
     * `COALESCE(?, CURRENT_TIMESTAMP)` 回落 DDL 默认值（手动新增调用点零改动）。
     */
    fun createCycle(row: CycleRow, handle: SQLiteDatabase? = null): Long = insert(
        handle,
        "INSERT INTO cycles (user_id, period_start, period_end, cycle_length, period_days, note, is_anomalous, created_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))",
        argsOf(row.userId, row.periodStart, row.periodEnd, sanitizeCycleLength(row.cycleLength),
            row.periodDays, row.note, if (row.isAnomalous) 1L else 0L, row.createdAt),
    )

    /**
     * crud.update_cycle：`null` 表示"不更新该字段"；[clearPeriodEnd] 为 true 时
     * `period_end` 与 `period_days` 一并显式置 NULL（v0.11.5 修 B1）。
     * 传入超范围的 `cycle_length` 会经 sanitize 转 NULL 写入（M4 Bug1）。
     */
    fun updateCycle(
        userId: Long,
        cycleId: Long,
        periodStart: String? = null,
        periodEnd: String? = null,
        cycleLength: Double? = null,
        periodDays: Long? = null,
        note: String? = null,
        isAnomalous: Boolean? = null,
        clearPeriodEnd: Boolean = false,
        handle: SQLiteDatabase? = null,
    ): Int {
        val hasCycleLength = cycleLength != null
        val sanitized = if (hasCycleLength) sanitizeCycleLength(cycleLength) else null
        val fields = mutableListOf<String>()
        val params = mutableListOf<Any?>()
        if (periodStart != null) { fields.add("period_start = ?"); params.add(periodStart) }
        if (clearPeriodEnd) {
            fields.add("period_end = NULL")
            fields.add("period_days = NULL")
        } else if (periodEnd != null) {
            fields.add("period_end = ?"); params.add(periodEnd)
        }
        if (hasCycleLength) { fields.add("cycle_length = ?"); params.add(sanitized) }
        if (periodDays != null) { fields.add("period_days = ?"); params.add(periodDays) }
        if (note != null) { fields.add("note = ?"); params.add(note) }
        if (isAnomalous != null) { fields.add("is_anomalous = ?"); params.add(if (isAnomalous) 1L else 0L) }
        if (fields.isEmpty()) return 0
        params.add(userId)
        params.add(cycleId)
        return update(handle, "UPDATE cycles SET ${fields.joinToString(", ")} WHERE user_id = ? AND id = ?",
            params.toTypedArray())
    }

    /** crud.delete_cycle：删该用户的一条周期，返回删除行数。 */
    fun deleteCycle(userId: Long, cycleId: Long, handle: SQLiteDatabase? = null): Int =
        update(handle, "DELETE FROM cycles WHERE user_id = ? AND id = ?", argsOf(userId, cycleId))

    /**
     * crud.get_recent_anomalous_count：最近 [limit] 条里的异常数（状态机 ANOMALY_ALERT）。
     * `limit` 是 Kotlin `Int`（非用户输入），直接内联进 SQL —— SQLite 的 `LIMIT` 表达式
     * 不接受 TEXT 绑定，走字符串占位符会报 datatype mismatch。
     */
    fun getRecentAnomalousCount(userId: Long, limit: Int): Long = scalarLong(
        "SELECT COUNT(*) FROM (SELECT is_anomalous FROM cycles WHERE user_id = ? " +
            "ORDER BY period_start DESC LIMIT $limit) WHERE is_anomalous = 1",
        argsOf(userId),
    )

    /** crud.finalize_cycle_derived：总是显式写入（与 update_cycle 的"None=不更新"不同）。
     *  `cycleLength` 自 2026-10-26 起为 Double（P2 小数周期长度全链路统一）。 */
    fun finalizeCycleDerived(
        cycleId: Long,
        cycleLength: Double?,
        periodDays: Long?,
        isAnomalous: Boolean,
        note: String,
        handle: SQLiteDatabase? = null,
    ): Int = update(
        handle,
        "UPDATE cycles SET cycle_length = ?, period_days = ?, is_anomalous = ?, note = ? WHERE id = ?",
        argsOf(cycleLength, periodDays, if (isAnomalous) 1L else 0L, note, cycleId),
    )

    // ============================================================
    // predictions
    // ============================================================

    /**
     * crud.create_prediction（model_params_json 必填，致命 Bug 禁令）。
     * confidence 写入前过 [requireFiniteConfidence]（NaN 防线，2026-10-26 修 P2）。
     */
    fun createPrediction(row: PredictionRow, handle: SQLiteDatabase? = null): Long {
        requireFiniteConfidence(row.confidence)
        return insert(
            handle,
            "INSERT INTO predictions (user_id, predicted_date, predicted_start_upper, predicted_start_lower, " +
                "confidence, model_version, model_params_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
            argsOf(row.userId, row.predictedDate, row.predictedStartUpper, row.predictedStartLower,
                row.confidence, row.modelVersion, row.modelParamsJson),
        )
    }

    /** crud.create_import_prediction：十列 INSERT（还原精度历史）。confidence 同过 NaN 防线。 */
    fun createImportPrediction(row: PredictionRow, createdAt: String, handle: SQLiteDatabase? = null): Long {
        requireFiniteConfidence(row.confidence)
        return insert(
            handle,
            "INSERT INTO predictions (user_id, predicted_date, predicted_start_upper, predicted_start_lower, " +
                "confidence, model_version, model_params_json, actual_date, error_days, created_at) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            argsOf(row.userId, row.predictedDate, row.predictedStartUpper, row.predictedStartLower,
                row.confidence, row.modelVersion, row.modelParamsJson, row.actualDate, row.errorDays, createdAt),
        )
    }

    /** crud.get_latest_prediction：`created_at` 最新的一条预测（同秒再按 `id` 倒序）；无预测返回 null。 */
    fun getLatestPrediction(userId: Long, handle: SQLiteDatabase? = null): JSONObject? =
        oneOn(handle, "SELECT * FROM predictions WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
            argsOf(userId), PiqDb.PREDICTION_COLUMNS)

    /** 用户可见的"预测历史倒序"；语义不得与规范序取数混用（crud.py 禁令）。 */
    fun getPredictionHistory(userId: Long, limit: Int): List<JSONObject> =
        all("SELECT * FROM predictions WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT $limit",
            argsOf(userId), PiqDb.PREDICTION_COLUMNS)

    /** crud.get_all_predictions：确定性次序号（精度评估 / E8 回填用）。 */
    fun getAllPredictions(userId: Long, handle: SQLiteDatabase? = null): List<JSONObject> =
        allOn(handle, "SELECT * FROM predictions WHERE user_id = ? " +
            "ORDER BY created_at ASC, predicted_date ASC, id ASC",
            argsOf(userId), PiqDb.PREDICTION_COLUMNS)

    /** crud.get_predictions_chronological：规范序（导出 / 调试用）；limit=null 不截断。 */
    fun getPredictionsChronological(userId: Long, limit: Int?, handle: SQLiteDatabase? = null): List<JSONObject> =
        allOn(handle, predictionsChronologicalSql(limit), argsOf(userId), PiqDb.PREDICTION_COLUMNS)

    /** crud.delete_unverified_predictions：删所有还没回填 actual_date 的预测，返回行数。 */
    fun deleteUnverifiedPredictions(userId: Long, handle: SQLiteDatabase? = null): Int =
        update(handle, "DELETE FROM predictions WHERE user_id = ? AND actual_date IS NULL", argsOf(userId))

    /** crud.backfill_prediction_actual：把实际开始日回填进对应预测并算 error_days。 */
    fun backfillPredictionActual(
        predictionId: Long,
        actualDate: String,
        errorDays: Long,
        handle: SQLiteDatabase? = null,
    ): Int = update(handle, "UPDATE predictions SET actual_date = ?, error_days = ? WHERE id = ?",
        argsOf(actualDate, errorDays, predictionId))

    /** crud.delete_user_cycles：清空该用户全部周期（导入=清空重建的前半）。 */
    fun deleteUserCycles(userId: Long, handle: SQLiteDatabase? = null): Int =
        update(handle, "DELETE FROM cycles WHERE user_id = ?", argsOf(userId))

    /** crud.delete_user_predictions：清空该用户全部历史预测（导入=清空重建的后半）。 */
    fun deleteUserPredictions(userId: Long, handle: SQLiteDatabase? = null): Int =
        update(handle, "DELETE FROM predictions WHERE user_id = ?", argsOf(userId))

    /**
     * crud.get_all_valid_cycle_lengths：cycle_length 非空即合法，按 period_start 升序。
     * 2026-10-26 修 P2：读数改 `optDouble`——旧 `optLong().toDouble()` 把 REAL 存储的 45.5
     * 截成 45.0；SQL 已过滤 NULL，`optDouble` 无"缺列回 0"的歧义。
     */
    fun getAllValidCycleLengths(userId: Long, handle: SQLiteDatabase? = null): List<Double> {
        val rows = allOn(handle, "SELECT cycle_length FROM cycles WHERE user_id = ? " +
            "AND cycle_length IS NOT NULL ORDER BY period_start ASC", argsOf(userId), listOf("cycle_length"))
        return rows.map { it.optDouble("cycle_length") }
    }

    // ============================================================
    // daily_records（经期每日详情，2026-10-26 用户立项；桌面 crud.py 同名函数的移植）
    // ============================================================

    /** crud.is_period_day：存在 period_start ≤ day ≤ period_end 的周期（end 空视为进行中）。 */
    fun isPeriodDay(userId: Long, day: String, handle: SQLiteDatabase? = null): Boolean =
        oneOn(handle,
            "SELECT 1 FROM cycles WHERE user_id = ? AND period_start <= ? " +
                "AND (period_end IS NULL OR period_end >= ?) LIMIT 1",
            argsOf(userId, day, day), listOf("1")) != null

    /**
     * crud.upsert_daily_record：UNIQUE(user_id, record_date) 冲突即整行覆盖，updated_at 刷新。
     * #15：写 mood_tags（词表 ID 的 JSON 数组文本）；旧 mood_note 列不再写入（已迁入 daily_journal）。
     */
    fun upsertDailyRecord(row: DailyRecordRow, handle: SQLiteDatabase? = null): Int = update(
        handle,
        "INSERT INTO daily_records (user_id, record_date, pain_present, pain_level, flow_level, " +
            "mood_level, mood_tags, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP) " +
            "ON CONFLICT(user_id, record_date) DO UPDATE SET " +
            "pain_present = excluded.pain_present, pain_level = excluded.pain_level, " +
            "flow_level = excluded.flow_level, mood_level = excluded.mood_level, " +
            "mood_tags = excluded.mood_tags, updated_at = CURRENT_TIMESTAMP",
        argsOf(row.userId, row.recordDate, if (row.painPresent) 1L else 0L, row.painLevel,
            row.flowLevel, row.moodLevel, MoodTags.encode(row.moodTags)),
    )

    /** crud.get_daily_record：该用户指定日的整行（mood_tags 仍是库内 JSON 文本，由路由解成数组）。 */
    fun getDailyRecord(userId: Long, recordDate: String, handle: SQLiteDatabase? = null): JSONObject? =
        oneOn(handle, "SELECT * FROM daily_records WHERE user_id = ? AND record_date = ?",
            argsOf(userId, recordDate), PiqDb.DAILY_RECORD_COLUMNS)

    /**
     * crud.has_daily_note：该日的日记是否已填（#14：今日 note = daily_journal.note）。
     *
     * 判定单一来源（与 Win `app/db/crud.py::has_daily_note` 同口径）：行存在且
     * `note` 去首尾空白后非空才算已填；无行、NULL、空串、纯空白一律视为未填。
     * 提醒「今日日记未填就提醒」直接用它，不另写一份 trim 判定。
     */
    fun hasDailyNote(userId: Long, recordDate: String, handle: SQLiteDatabase? = null): Boolean {
        val row = getJournal(userId, recordDate, handle) ?: return false
        return !row.textOrNull("note").isNullOrBlank()
    }

    // ---- daily_journal（#14 每日日记，独立渠道；不进导出/导入，导入不碰该表） ----

    /** crud.get_journal：该用户指定日的日记行；无行 null（note 可为 NULL）。 */
    fun getJournal(userId: Long, recordDate: String, handle: SQLiteDatabase? = null): JSONObject? =
        oneOn(handle, "SELECT * FROM daily_journal WHERE user_id = ? AND record_date = ?",
            argsOf(userId, recordDate), PiqDb.JOURNAL_COLUMNS)

    /** crud.get_journal_range：闭区间、record_date 升序。 */
    fun getJournalRange(userId: Long, from: String, to: String): List<JSONObject> =
        all("SELECT * FROM daily_journal WHERE user_id = ? AND record_date >= ? AND record_date <= ? " +
            "ORDER BY record_date ASC", argsOf(userId, from, to), PiqDb.JOURNAL_COLUMNS)

    /** crud.upsert_journal：同日重复保存整行覆盖，updated_at 刷新、created_at 保留。 */
    fun upsertJournal(userId: Long, recordDate: String, note: String, handle: SQLiteDatabase? = null): Int = update(
        handle,
        "INSERT INTO daily_journal (user_id, record_date, note, updated_at) " +
            "VALUES (?, ?, ?, CURRENT_TIMESTAMP) " +
            "ON CONFLICT(user_id, record_date) DO UPDATE SET " +
            "note = excluded.note, updated_at = CURRENT_TIMESTAMP",
        argsOf(userId, recordDate, note),
    )

    /** crud.delete_journal：删当日日记（幂等；空文本 PUT 走这里）。 */
    fun deleteJournal(userId: Long, recordDate: String, handle: SQLiteDatabase? = null): Int =
        update(handle, "DELETE FROM daily_journal WHERE user_id = ? AND record_date = ?", argsOf(userId, recordDate))

    /**
     * crud.get_daily_records_range：闭区间、record_date 升序（GET /daily-records 用）。
     * #28 裁决：单日读取 = from=to 的区间查询，不新增单日端点（UNIQUE 自带索引覆盖）。
     */
    fun getDailyRecordsRange(userId: Long, from: String, to: String): List<JSONObject> =
        all("SELECT * FROM daily_records WHERE user_id = ? AND record_date >= ? AND record_date <= ? " +
            "ORDER BY record_date ASC", argsOf(userId, from, to), PiqDb.DAILY_RECORD_COLUMNS)

    /** crud.get_all_daily_records：全部每日详情升序（导出总量统计与截断共用）；limit=null 不截断。 */
    fun getDailyRecordsChronological(userId: Long, limit: Int?, handle: SQLiteDatabase? = null): List<JSONObject> =
        allOn(handle, dailyChronologicalSql(limit), argsOf(userId), PiqDb.DAILY_RECORD_COLUMNS)

    /** crud.delete_user_daily_records：清空该用户全部每日详情（导入=清空重建）。 */
    fun deleteUserDailyRecords(userId: Long, handle: SQLiteDatabase? = null): Int =
        update(handle, "DELETE FROM daily_records WHERE user_id = ?", argsOf(userId))

    /** crud.create_import_daily_record：还原历史（ON CONFLICT 覆盖使重复日期后行胜出）。 */
    fun createImportDailyRecord(row: DailyRecordRow, createdAt: String, updatedAt: String,
                                handle: SQLiteDatabase? = null): Int = update(
        handle,
        "INSERT INTO daily_records (user_id, record_date, pain_present, pain_level, flow_level, " +
            "mood_level, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
            "ON CONFLICT(user_id, record_date) DO UPDATE SET " +
            "pain_present = excluded.pain_present, pain_level = excluded.pain_level, " +
            "flow_level = excluded.flow_level, mood_level = excluded.mood_level, " +
            "created_at = excluded.created_at, updated_at = excluded.updated_at",
        argsOf(row.userId, row.recordDate, if (row.painPresent) 1L else 0L, row.painLevel,
            row.flowLevel, row.moodLevel, createdAt, updatedAt),
    )

    // ============================================================
    // model_params / app_settings
    // ============================================================

    /** crud.get_model_params：行缺失时返回默认值（ensure_user_defaults 的兜底）。 */
    fun getModelParams(userId: Long, handle: SQLiteDatabase? = null): JSONObject {
        val row = oneOn(handle, "SELECT * FROM model_params WHERE user_id = ?",
            argsOf(userId), PiqDb.MODEL_PARAMS_COLUMNS)
        return row ?: JSONObject().apply {
            put("user_id", userId)
            put("mean_cycle", PiqConfig.PRIOR_MEAN)
            put("std_cycle", PiqConfig.PRIOR_STD)
            put("n_records", 0L)
            put("ema_cycle", PiqConfig.PRIOR_MEAN)
            put("prior_mean", PiqConfig.PRIOR_MEAN)
            put("prior_std", PiqConfig.PRIOR_STD)
            put("prior_weight", PiqConfig.PRIOR_WEIGHT)
            put("updated_at", JSONObject.NULL)
        }
    }

    /**
     * crud.update_model_params 的 predict_core 版本（字段名逐字取自 core 的输出键）。
     * NaN 防线在写汇点 [updateModelParams]（2026-10-26 修 P2）：`optDouble` 缺键得 NaN，
     * 旧实现把 NaN 直绑 `REAL NOT NULL` 列 → Android SQLite 把 NaN 存成 NULL →
     * 约束违约、整事务回滚、外部只见一句笼统 500。
     */
    fun updateModelParamsFromCore(userId: Long, core: JSONObject, handle: SQLiteDatabase? = null): Int =
        updateModelParams(
            userId,
            meanCycle = core.optDouble("predicted_cycle"),
            stdCycle = core.optDouble("std"),
            nRecords = core.optLong("n"),
            emaCycle = core.optDouble("new_ema"),
            priorMean = core.optDouble("mu_post"),
            priorStd = core.optDouble("sigma_post"),
            priorWeight = core.optDouble("prior_weight"),
            handle = handle,
        )

    /**
     * crud.update_model_params（UPSERT：行不存在则插入）。
     *
     * 2026-10-26 修 P2（NaN 防线，对齐 `PiqConfig.kt` 96-99 行登记的 NaN 纪律）：
     * 写入前显式校验六个 REAL 列的有限性，任一非有限值抛 500 `INTERNAL_ERROR`
     * （固定中文文案）——防线放在这唯一写汇点，同时覆盖 [updateModelParamsFromCore]
     * （ModelRecomputeService 的重算链）与路由侧直接传 `optDouble` 结果的调用点。
     */
    fun updateModelParams(
        userId: Long,
        meanCycle: Double,
        stdCycle: Double,
        nRecords: Long,
        emaCycle: Double,
        priorMean: Double,
        priorStd: Double,
        priorWeight: Double,
        handle: SQLiteDatabase? = null,
    ): Int {
        if (!meanCycle.isFinite() || !stdCycle.isFinite() || !emaCycle.isFinite() ||
            !priorMean.isFinite() || !priorStd.isFinite() || !priorWeight.isFinite()
        ) {
            throw ApiError(500, "模型参数出现非法数值（非有限），已中止写入", "INTERNAL_ERROR")
        }
        return update(
            handle,
            "INSERT INTO model_params (user_id, mean_cycle, std_cycle, n_records, ema_cycle, " +
                "prior_mean, prior_std, prior_weight, updated_at) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP) " +
                "ON CONFLICT(user_id) DO UPDATE SET " +
                "mean_cycle = excluded.mean_cycle, std_cycle = excluded.std_cycle, " +
                "n_records = excluded.n_records, ema_cycle = excluded.ema_cycle, " +
                "prior_mean = excluded.prior_mean, prior_std = excluded.prior_std, " +
                "prior_weight = excluded.prior_weight, updated_at = CURRENT_TIMESTAMP",
            argsOf(userId, meanCycle, stdCycle, nRecords, emaCycle, priorMean, priorStd, priorWeight),
        )
    }

    /** crud.reset_model_params：把该用户的 model_params 行打回默认值，返回行数。 */
    fun resetModelParams(userId: Long, handle: SQLiteDatabase? = null): Int =
        update(handle, SQL_RESET_MODEL_PARAMS, argsOf(userId))

    /** crud.update_settings（空壳语义：只 UPSERT updated_at）。 */
    fun updateSettings(userId: Long, handle: SQLiteDatabase? = null): Int = update(
        handle,
        "INSERT INTO app_settings (user_id, updated_at) VALUES (?, CURRENT_TIMESTAMP) " +
            "ON CONFLICT(user_id) DO UPDATE SET updated_at = CURRENT_TIMESTAMP",
        argsOf(userId),
    )

    /**
     * ModelRecomputeService 的 SQL 落点：按 id 更新三列派生字段（SQL 保留在数据层）。
     * 2026-10-26 审计（P2 小数周期长度）：派生 `cycle_length` = 日期差，**恒为整日数**，
     * 故本函数保持 `Long?` 不改 Double——bindLong 存 INTEGER 与桌面 `float(gap)` 经 INTEGER
     * 亲和收敛后的存储同形；唯一调用方 ModelRecomputeService 本轮不可改，改签名反而引入破坏。
     */
    fun updateCycleDerivedFields(
        id: Long,
        cycleLength: Long?,
        periodDays: Long?,
        isAnomalous: Boolean,
        handle: SQLiteDatabase? = null,
    ): Int = update(
        handle,
        "UPDATE cycles SET cycle_length = ?, period_days = ?, is_anomalous = ? WHERE id = ?",
        argsOf(cycleLength, periodDays, if (isAnomalous) 1L else 0L, id),
    )

    // ============================================================
    // 执行层 helpers（读走 rawQuery，写走 SQLiteStatement 的类型化绑定）
    // ============================================================

    /**
     * confidence 的 NaN 防线（2026-10-26 修 P2，与 [updateModelParams] 的有限性校验同批，
     * 对齐 `PiqConfig.kt` 96-99 行登记的 NaN 纪律）：调用方多用 `optDouble("confidence")` 取值，
     * **缺键得到 NaN**；NaN 直绑 `REAL NOT NULL` 列会被 Android SQLite 存成 NULL ⇒
     * 约束违约、整事务回滚、外部只见笼统 500。防线放在 [createPrediction]/[createImportPrediction]
     * 这两个写汇点，顺带覆盖 ModelRecomputeService 的写路径（该文件本轮不可改）。
     */
    private fun requireFiniteConfidence(value: Double) {
        if (!value.isFinite()) {
            throw ApiError(500, "预测置信度出现非法数值（非有限），已中止写入", "INTERNAL_ERROR")
        }
    }

    private fun scalarLong(sql: String, args: Array<Any?>? = null): Long =
        db.rawQuery(sql, args?.stringArgs()).use { c -> if (c.moveToFirst()) c.getLong(0) else 0L }

    private fun one(sql: String, args: Array<Any?>, columns: List<String>): JSONObject? =
        oneOn(null, sql, args, columns)

    private fun oneOn(handle: SQLiteDatabase?, sql: String, args: Array<Any?>, columns: List<String>): JSONObject? =
        (handle ?: db).rawQuery(sql, args.stringArgs()).use { c ->
            if (c.moveToFirst()) c.toRowJson(columns) else null
        }

    private fun all(sql: String, args: Array<Any?>, columns: List<String>): List<JSONObject> =
        allOn(null, sql, args, columns)

    private fun allOn(handle: SQLiteDatabase?, sql: String, args: Array<Any?>, columns: List<String>): List<JSONObject> =
        (handle ?: db).rawQuery(sql, args.stringArgs()).use { c ->
            val out = mutableListOf<JSONObject>()
            while (c.moveToNext()) out.add(c.toRowJson(columns))
            out
        }

    /** insert_row：handle=null 时自开一次事务（桌面 WriteLock 的同语义）。 */
    private fun insert(handle: SQLiteDatabase?, sql: String, args: Array<Any?>): Long =
        if (handle != null) bind(handle, sql, args).use { it.executeInsert() }
        else store.write { bind(it, sql, args).use { s -> s.executeInsert() } }

    /** write_query：返回受影响行数（cursor.rowcount 的等价物）。 */
    private fun update(handle: SQLiteDatabase?, sql: String, args: Array<Any?>): Int =
        if (handle != null) bind(handle, sql, args).use { it.executeUpdateDelete() }
        else store.write { bind(it, sql, args).use { s -> s.executeUpdateDelete() } }

    private fun bind(handle: SQLiteDatabase, sql: String, args: Array<Any?>): SQLiteStatement {
        val stmt = handle.compileStatement(sql)
        args.forEachIndexed { i, value ->
            val index = i + 1
            when (value) {
                null, JSONObject.NULL -> stmt.bindNull(index)
                is Long -> stmt.bindLong(index, value)
                is Int -> stmt.bindLong(index, value.toLong())
                is Double -> stmt.bindDouble(index, value)
                is Boolean -> stmt.bindLong(index, if (value) 1L else 0L)
                else -> stmt.bindString(index, value.toString())
            }
        }
        return stmt
    }

    companion object {

        /**
         * crud._sanitize_cycle_length：超 [7,90] 返回 null（避免触发 DDL chk_length）。
         * 2026-10-26 修 P2：参数改 **Double**——导入链路的 cycle_length 允许小数（桌面存 45.5），
         * Long 形态会在导入读取处把 45.5 截成 45。越界（<7.0 或 >90.0）仍返 null。
         */
        fun sanitizeCycleLength(value: Double?): Double? =
            if (value == null) null
            else if (value < PiqConfig.MIN_CYCLE_DAYS || value > PiqConfig.MAX_CYCLE_DAYS) null
            else value

        /**
         * crud.get_predictions_chronological 的取数 SQL：规范序 `predicted_date → created_at → id`。
         *
         * 单独成函数只为了这条排序规则**可被断言** —— 生产取数与哨兵共用这一处拼接，
         * 改排序键两边同时变。
         * `limit` 是 Kotlin `Int`（非用户输入）⇒ 与 [getPredictionHistory] 同理直接内联，
         * SQLite 的 `LIMIT` 不接受 TEXT 绑定。
         */
        internal fun predictionsChronologicalSql(limit: Int?): String {
            val base = "SELECT * FROM predictions WHERE user_id = ? " +
                "ORDER BY predicted_date ASC, created_at ASC, id ASC"
            return if (limit == null) base else "$base LIMIT $limit"
        }

        /**
         * crud.reset_model_params 的 SQL：默认值全部接 [PiqConfig]，与 DDL 的 `DEFAULT` 共用同一份真值
         * （接线前这里把 `28.0 / 7.0 / 0.5` 又抄了一遍，见L3R93-REMAIN5 的 09）。
         * `internal` 只为了让 `SchemaDefaultTextTest` 能逐字节钉住拼接结果 —— 渲染漂移是这类接线唯一的
         * 隐性后果（`331/331` 条目 CRC 也看不出来，CRC 证书面字节不证语义）。
         */
        internal const val SQL_RESET_MODEL_PARAMS =
            "UPDATE model_params SET mean_cycle = ${PiqConfig.PRIOR_MEAN}, std_cycle = ${PiqConfig.PRIOR_STD}, " +
                "n_records = 0, ema_cycle = ${PiqConfig.PRIOR_MEAN}, " +
                "prior_mean = ${PiqConfig.PRIOR_MEAN}, prior_std = ${PiqConfig.PRIOR_STD}, " +
                "prior_weight = ${PiqConfig.PRIOR_WEIGHT}, " +
                "updated_at = CURRENT_TIMESTAMP WHERE user_id = ?"

        private const val SQL_PRUNE_EXPIRED =
            "DELETE FROM sessions WHERE user_id = ? AND expires_at <= datetime('now')"

        private const val SQL_PRUNE_KEEP_NEWEST =
            "DELETE FROM sessions WHERE user_id = ? AND token NOT IN (" +
                "SELECT token FROM sessions WHERE user_id = ? " +
                "ORDER BY created_at DESC, rowid DESC LIMIT ?)"

        private val SQL_DELETE_USER_ACCOUNT = listOf(
            "DELETE FROM cycles WHERE user_id = ?",
            "DELETE FROM predictions WHERE user_id = ?",
            "DELETE FROM daily_records WHERE user_id = ?",
            "DELETE FROM daily_journal WHERE user_id = ?",
            "DELETE FROM model_params WHERE user_id = ?",
            "DELETE FROM app_settings WHERE user_id = ?",
            "DELETE FROM sessions WHERE user_id = ?",
            "DELETE FROM users WHERE id = ?",
        )

        /** [getDailyRecordsChronological] 的取数 SQL（limit 为 Kotlin Int，非用户输入，直接内联）。 */
        internal fun dailyChronologicalSql(limit: Int?): String {
            val base = "SELECT * FROM daily_records WHERE user_id = ? ORDER BY record_date ASC"
            return if (limit == null) base else "$base LIMIT $limit"
        }

    }
}

/** crud.create_cycle 的入参行（字段名同 DDL）。`cycleLength` 为 Double（2026-10-26 修 P2：小数周期长度全链路统一）。 */
data class CycleRow(
    val userId: Long,
    val periodStart: String,
    val periodEnd: String?,
    val cycleLength: Double?,
    val periodDays: Long?,
    val note: String,
    val isAnomalous: Boolean,
    /**
     * 导入还原的创建时间（修 #35）。null = 交给 DDL 的 `DEFAULT CURRENT_TIMESTAMP`
     * （手动新增 / 算法补生成的行零改动），非 null 时由 [PiqCrud.createCycle] 原样写入。
     */
    val createdAt: String? = null,
)

/** crud.create_prediction / create_import_prediction 的入参行。 */
data class PredictionRow(
    val userId: Long,
    val predictedDate: String,
    val predictedStartUpper: String,
    val predictedStartLower: String,
    val confidence: Double,
    val modelVersion: String,
    val modelParamsJson: String,
    val actualDate: String? = null,
    val errorDays: Long? = null,
)

/** crud.upsert_daily_record / create_import_daily_record 的入参行（字段名同 DDL）。
 *  moodTags 仅本地存储（#15；导入还原不携带，恒空）；createdAt/updatedAt 仅供导入还原（upsert 不使用）。 */
data class DailyRecordRow(
    val userId: Long,
    val recordDate: String,
    val painPresent: Boolean,
    val painLevel: Long?,
    val flowLevel: Long,
    val moodLevel: Long,
    val moodTags: List<String> = emptyList(),
    val createdAt: String? = null,
    val updatedAt: String? = null,
)

/** 把变参拼成 `rawQuery` 的占位符数组；只在本文件内使用。 */
private fun argsOf(vararg values: Any?): Array<Any?> = arrayOf(*values)

/** rawQuery 只接受字符串占位符数组；数值参数靠列 affinity 完成同形转换（口径说明见类文档）。 */
private fun Array<Any?>.stringArgs(): Array<String?> = Array(size) { i ->
    when (val value = this[i]) {
        null, JSONObject.NULL -> null
        is Double -> if (value == value.toLong().toDouble()) value.toLong().toString() else value.toString()
        else -> value.toString()
    }
}
