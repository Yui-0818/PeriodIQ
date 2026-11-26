/*
 * Copyright (c) 2026 Yui_0818 (aaaj6719@gmail.com)
 * Licensed under the PolyForm Noncommercial License 1.0.0.
 * Commercial use is prohibited without separate written authorization.
 * See LICENSE and COMMERCIAL.md in the repository root.
 */

package io.github.yui0818.periodiq

import io.github.yui0818.periodiq.api.contract.Envelope
import io.github.yui0818.periodiq.api.contract.genericFailure
import io.github.yui0818.periodiq.data.PiqCrud
import io.github.yui0818.periodiq.data.PiqDb

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.app.UiModeManager
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.View
import android.view.ViewTreeObserver
import android.view.WindowInsetsController
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.io.File
import java.time.LocalDate
import java.util.Locale
import org.json.JSONObject

/**
 * 安全事件日志里的 URL 形态：只留 scheme、host 与长度。
 *
 * `data:` 文档的正文、外部链接的 path/query 都可能带用户输入，**不得**进 logcat；
 * 这里只给定位所需的最小信息。scheme 取首冒号前且限制字符集，避免畸形串塞入任意文本。
 */
internal fun safeUrlForLog(url: String?): String {
    if (url == null) return "scheme=-|host=-|len=0"
    val rawScheme = url.substringBefore(':', "")
    val scheme = if (rawScheme.length in 1..16 && rawScheme.all { it.isLetterOrDigit() || it == '+' || it == '-' || it == '.' }) {
        rawScheme
    } else {
        "-"
    }
    val host = runCatching { java.net.URI(url).host }.getOrNull() ?: "-"
    return "scheme=$scheme|host=$host|len=${url.length}"
}

/**
 * 每进程随机的桥令牌：只经 document-start 脚本注入 ORIGIN 文档，
 * `data:`/外部文档拿不到；桥方法再校验一次，避免拉回后 `currentPageUrl` 已是 origin
 * 时把旧文档的迟到调用当成本地页面。
 */
private fun newBridgeToken(): String {
    val bytes = ByteArray(16)
    java.security.SecureRandom().nextBytes(bytes)
    return bytes.joinToString("") { "%02x".format(it) }
}

/** 进程级令牌持有者：Activity 重建不换令牌。 */
internal object BridgeToken {
    val value: String = newBridgeToken()
}

/** 包装 `PIQNative` / `PIQExport`，给页内调用补上令牌；只对 ORIGIN 生效。 */
private fun bridgeTokenScript(token: String): String = """
    (function () {
        if (window.__piqTokenInstalled) { return; }
        window.__piqTokenInstalled = true;
        var t = "$token";
        var n = window.PIQNative;
        if (n) {
            window.PIQNative = {
                request: function (m, p, b) { return n.requestWithToken(m, p, b, t); },
                getSetting: function (k) { return n.getSettingWithToken(k, t); },
                setSetting: function (k, v) { return n.setSettingWithToken(k, v, t); },
                setTheme: function (dark) { return n.setThemeWithToken(!!dark, t); },
                setLang: function (lang) { return n.setLangWithToken(String(lang || ''), t); }
            };
        } else {
            console.warn('[piq-token] bridge-absent');
        }
        var e = window.PIQExport;
        if (e) {
            window.PIQExport = {
                save: function (name, b64, mime) { return e.saveWithToken(name, b64, mime, t); }
            };
        }
    })();
""".trimIndent()

/**
 * 单 Activity + WebView + 真实前端资产根 + `piq-android` 门控 + JS 桥。
 *
 * 不申请 `INTERNET`：资产全部来自 APK 内 `assets/`，缺文件返回 404；
 * `api/` 前缀下的路径一律交给 [ApiGatewayHandler]（⇒ [apiGateway] ⇒ [PiqRouter]），
 * **不交回网络栈**（早期跨端契约的订正块：放行会把"端上有实现"伪装成"取回失败"）。
 * 系统栏留白（edge-to-edge insets）由 [PiqInsets] 算并注入成 CSS 变量，前端只消费。
 *
 * 起它还是提醒层的 [PiqReminderHooks] 实现方与 [ReminderSource] 提供方：
 * 权限框只能由 Activity 发起，而预计开始日只能查库 —— 两件事都不属于设置桥本身。
 */
class MainActivity : Activity(), PiqReminderHooks {

    private lateinit var prefs: SharedPreferences
    private lateinit var webView: WebView
    private lateinit var themeSource: PiqRootSource
    private lateinit var assetLoader: WebViewAssetLoader
    private lateinit var insets: PiqInsets

    private lateinit var settings: PiqSettings
    private lateinit var sessions: SessionHolder
    private lateinit var hostSettings: HostSettingsBridge
    private lateinit var fileChooser: PiqFileChooser

    /**
     * 业务侧服务对象：DB / Chaquopy 都不在主线程创建 —— 首次桥调用（JS 桥线程）
     * 才惰性建立，`Python.start` 与 DDL 都发生在那条线程上。
     *
     * 改字号/语言/密度会让本 Activity 重建，于是这里会再多一个 `PiqServices`；但**库是进程级
     * 单实例**（`PiqDb.shared`）⇒ 重建不产生第二套库句柄。`onDestroy` 因此
     * 也**不关**那个句柄：它的生命周期跟进程一致。
     */
    private val services by lazy { PiqServices(applicationContext, sessions, BuildConfig.VERSION_NAME) }

    /**
     * 本机 REST 的唯一入口（早期跨端契约：`request(method, path, body) -> {status, json}`）。
     * JS 桥（`PIQNative.request`）与资源请求拦截（[ApiGatewayHandler]）共用它
     * ⇒ 两条通道对同一个 `api/` 前缀路径必然给同一个答案。
     *
     * 写成 lambda 而不是直接持有路由，是为了**保住惰性**：首次取 `services` 会建表并
     * `Python.start`，那不该发生在 `onCreate`（主线程），只在第一条请求真的到来时
     * ——JS 桥线程或 WebView 工作线程——才发生。
     */
    private val apiGateway = PiqApiGateway { method, path, body ->
        settleStartupSession(path)
        val envelope = services.router.handle(method, path, body)
        afterApiServed(method, path, envelope.status)
        envelope
    }

    /**
     * 提醒层的"一次 API 服务完了"这条腿：
     * 登录 / 首屏拿到预测 / 周期增删改 / 导入 ⇒ 重排；登出 / 删号 / 改密（2026-10-31 #10：改密即登出） ⇒ 全取消；
     * 401 按 [PiqReminderRoutes.action] 的口径处理（会话失效才全取消）。
     *
     * 判定交给纯函数 [PiqReminderRoutes.action]（JVM 可测），这里只负责分发；
     * 排程本身排在提醒层的执行器线程上 —— 本漏斗可能跑在资源拦截线程或 JS 桥线程，
     * 但**绝不**该在主线程查库（[PiqServices] 的惰性纪律同样适用于这里）。
     */
    private fun afterApiServed(method: String, path: String, status: Int) {
        when (PiqReminderRoutes.action(method, path, status)) {
            ReminderAction.RESCHEDULE ->
                PiqReminderScheduler.rescheduleAsync(applicationContext, reminderSource, "api-$method-$path")

            ReminderAction.CANCEL_ALL ->
                PiqReminderScheduler.cancelAllAsync(applicationContext, "api-$method-$path")

            ReminderAction.NONE -> Unit
        }
        // 深链补触发的路径判定：这个漏斗收到的 path 带 `/api/v1` 前缀（前端 `js/core/transport.js` 的 BASE
        // 常量拼接；PiqRouter 对无前缀路径给 404），所以比较前先剥前缀——剥法与
        // PiqReminderRoutes 同款（先去 ?query 再剥 PiqConfig.API_PREFIX）。
        // 带前缀是常态；不带前缀的裸路径 removePrefix 原样返回，同样兼容。
        val rest = path.substringBefore('?').removePrefix(PiqConfig.API_PREFIX)
        if (status == 200 && pendingCalendarNotifyId != 0 && method.equals("POST", ignoreCase = true) &&
            (rest == "/auth/login" || rest == "/auth/register")
        ) {
            webView.post { applyPendingCalendarRoute() }
        }
    }

    /**
     * 排程要问宿主的事实：现在有没有登录、预计开始日是哪天，以及今天的心情
     * 感受是否已填（2026-10-26 每晚填写腿）。
     *
     * 查库走**进程级单实例**句柄（[PiqDb.shared]）与 [PiqCrud.getLatestPrediction]，
     * 不起 Chaquopy、不碰 WebView：闹钟只需要一个日期，算法重算是路由那条路的事。
     * 登录态用 [SessionHolder.current] + `getSessionUser` 的同一条 SQL —— 与
     * [PiqRouter.requireUser] 同一个口径，避免出现"路由说没登录、排程说有"。
     */
    private val reminderSource = object : ReminderSource {

        override fun isLoggedIn(): Boolean = sessions.current() != null

        override fun predictedStart(): LocalDate? {
            val token = sessions.current() ?: return null
            val crud = PiqCrud(PiqDb.shared(applicationContext))
            val userId = crud.getSessionUser(token)?.optLong("id", 0L) ?: 0L
            if (userId == 0L) return null
            val latest = crud.getLatestPrediction(userId) ?: return null
            return PyMath.parseIsoDate(latest.optString("predicted_date"))
        }

        /** 每晚填写腿：今天的日记是否已填（crud.has_daily_note 同口径：daily_journal.note 去空白非空）。 */
        override fun todayDailyNoteFilled(): Boolean {
            val userId = currentReminderUserId() ?: return false
            return PiqCrud(PiqDb.shared(applicationContext)).hasDailyNote(userId, LocalDate.now().toIso())
        }

        /** 提醒层通用的「当前登录用户 id」：令牌解不出用户（未登录/过期）回 null。 */
        private fun currentReminderUserId(): Long? {
            val token = sessions.current() ?: return null
            val userId = PiqCrud(PiqDb.shared(applicationContext))
                .getSessionUser(token)?.optLong("id", 0L) ?: 0L
            return userId.takeIf { it != 0L }
        }
    }

    private var variant: String = VariantPolicy.DEFAULT
    private lateinit var decision: ThemeDecision

    /**
     * 当前文档 URL 的**主线程快照**。
     *
     * `PiqBridge` 跑在 WebView 的 JavaBridge 线程，Android 规定 `WebView.getUrl()`
     * 只能在创建它的主线程调用；桥里直接读会抛
     * "A WebView method was called on thread 'JavaBridge'"，所有桥调用一起失效。
     * 因此由主线程在导航回调里维护本字段，桥只读它（`@Volatile` 保证可见性）。
     */
    @Volatile
    private var currentPageUrl: String? = null

    /** 最后一个可信文档；用于把绕过 `shouldOverrideUrlLoading` 的导航拉回来。 */
    @Volatile
    private var lastTrustedPage: String? = null

    /** 通知点击待处理的路由目标；0 = 没有待处理。Intent 只带 id，不带任何日期。 */
    private var pendingCalendarNotifyId: Int = 0

    /** 是否已加载过应用页面：决定 `onNewIntent` 走重载还是原地注入路由。 */
    @Volatile
    private var appPageLoaded: Boolean = false

    /** 前台生命周期状态 + 低功耗视差传感器。 */
    private var activityResumed: Boolean = false
    private var tiltSensor: PiqTiltSensor? = null

    /** 返回键正在等 Web 回答；连按时不重复投递，避免两次关闭/退出。 */
    @Volatile
    private var backPending: Boolean = false

    /**
     * 返回键回答的超时兜底（P3）：`finishBack` 是 backPending 的唯一复位点，WebView 销毁 /
     * 回调不达时它会永远等不到 ⇒ 返回键永久失灵。JS 回答先到就在 `finishBack` 里
     * `removeCallbacks` 撤掉超时任务；等到 `BACK_JS_TIMEOUT_MS` 仍无回答则按"前端未处理"复位。
     */
    private val backTimeoutHandler = Handler(Looper.getMainLooper())
    private var backTimeout: Runnable? = null

    /** 本次返回键投递的起点（只用于日志里的 `ms=`，方便设备侧核对应答延迟）。 */
    private var backStartedAt: Long = 0L

    private fun elapsedSinceBack(): Long =
        if (backStartedAt == 0L) 0L else SystemClock.uptimeMillis() - backStartedAt

    override fun onCreate(savedInstanceState: Bundle?) {
        // 主题必须在 super.onCreate() 之前定：窗口底色（也就是系统 splash 撤走后的第一帧，
        // 以及 WebView 尚未绘制的那一段）由这里的 setTheme 决定。晚于 super 就只能改页面内
        // 的 data-theme，窗口层仍按 manifest 的默认主题画（3.0.9 实测：Light 用户先看到
        // 约 0.35–1.0 s 的深色窗口，RGB 26,27,32）。
        settings = PiqSettings(this)
        val savedTheme = settings.themePreference()
        // 系统 splash（Android 12+）由清单里的静态主题决定，而静态主题只按**应用的夜间模式**选
        // values-night。把用户选择映射成应用级 night mode（API 31+，落盘由系统按包名保存），
        // 下一次冷启动的启动窗口/splash 就与所选主题一致，不再跟随系统明暗。
        applyAppNightMode(savedTheme)
        val startupDark = initialDarkTheme(savedTheme)
        setTheme(startupThemeRes(savedTheme))
        super.onCreate(savedInstanceState)
        pendingCalendarNotifyId = intent.getIntExtra(PiqReminderScheduler.EXTRA_NOTIFY_ID, 0)
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
        // 会话/设置桥只是两个轻量对象（不碰库、不解密），留在首帧之前；其余重活见下方注释。
        sessions = SessionHolder(settings, SessionSlot.process)
        hostSettings = HostSettingsBridge(settings, sessions, this, this)

        // 首帧先只画"所选主题的底色"：`new WebView(this)` 的首次构造要加载 WebView provider
        // （本机实测从 ~0.1 s 推迟到 ~0.7 s），放在这里会把整段首屏都留给窗口背景；
        // 其余启动工作（会话采用、主题根探测、CDP 开关、WebView 本身）也一并挪到首帧之后
        // ——它们都不影响这一帧的颜色，却都会推迟它。
        val root = FrameLayout(this)
        root.setBackgroundColor(startupWindowBackground(startupDark))
        setContentView(root)
        applySystemBarIcons(startupDark)
        root.viewTreeObserver.addOnPreDrawListener(object : ViewTreeObserver.OnPreDrawListener {
            override fun onPreDraw(): Boolean {
                root.viewTreeObserver.removeOnPreDrawListener(this)
                // 在 preDraw 里 post：消息排在本次遍历（含首帧绘制）之后执行。
                root.post { if (!isFinishing && !isDestroyed) buildWebView(root) }
                return true
            }
        })
        Log.i(
            TAG,
            "startup-theme|mode=${savedTheme ?: "unset"}|dark=$startupDark|" +
                "window=#${Integer.toHexString(startupWindowBackground(startupDark))}",
        )
        detectCorruptionResetAsync()
        tiltSensor = PiqTiltSensor(this) { nx, ny ->
            if (!::webView.isInitialized || !appPageLoaded || isFinishing || isDestroyed) return@PiqTiltSensor
            val js = "window.__piqTilt&&window.__piqTilt(${"%.3f".format(Locale.US, nx)},${"%.3f".format(Locale.US, ny)})"
            if (Looper.myLooper() == Looper.getMainLooper()) {
                webView.evaluateJavascript(js, null)
            } else {
                webView.post {
                    if (::webView.isInitialized && appPageLoaded && !isFinishing && !isDestroyed) {
                        webView.evaluateJavascript(js, null)
                    }
                }
            }
        }
    }

    /** 按已存主题选窗口主题；从未选过时维持既有暗色首屏（index.html 的 `data-theme="dark"`）。 */
    private fun startupThemeRes(mode: String?): Int = when (mode) {
        "light" -> R.style.PiqThemeLight
        "dark" -> R.style.PiqThemeDark
        "system" -> R.style.PiqThemeSystem
        else -> R.style.PiqThemeDark
    }

    /** 窗口/WebView 的首帧底色：与 [startupThemeRes] 同一套口径（Light 浅、Dark 深、未选过深）。 */
    private fun startupWindowBackground(dark: Boolean): Int = resources.getColor(
        if (dark) R.color.piq_window_dark else R.color.piq_window_light,
        theme,
    )

    /**
     * 第一帧之后才建 WebView（理由见 [onCreate]）。除构造时机外，初始化顺序与旧版一致。
     */
    private fun buildWebView(root: FrameLayout) {
        val adopted = sessions.adoptPersisted()
        Log.i(TAG, "startup-session|stage=adopt|autoLogin=${settings.isAutoLoginEnabled()}|candidate=$adopted|ttl=${if (sessions.adoptionPending()) "pending" else "n/a"}")
        variant = resolveAndPersist(intent)
        bindThemeRoot(resolveTheme(variant))

        // CDP 取证需要：debug 构建开 devtools socket（release 构建不进入这个分支）。
        // 放在第一帧之后：这条调用会拉起 WebView provider，是首帧最大的单项开销。
        if (BuildConfig.DEBUG) {
            WebView.setWebContentsDebuggingEnabled(true)
        }
        Log.i(TAG, "webview-debug|enabled=${BuildConfig.DEBUG}")

        webView = WebView(this)
        // 页面绘制前的底色与窗口一致：否则 WebView 默认底（黑）会在这段里再闪一次。
        webView.setBackgroundColor(startupWindowBackground(initialDarkTheme(settings.themePreference())))
        root.addView(
            webView,
            FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT),
        )
        insets = PiqInsets(webView)
        insets.enable(window)
        with(webView.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                setAlgorithmicDarkeningAllowed(false)
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                @Suppress("DEPRECATION")
                setForceDark(WebSettings.FORCE_DARK_OFF)
            }
        }
        fileChooser = PiqFileChooser(this)
        webView.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(cm: ConsoleMessage): Boolean {
                Log.i(TAG, "console|level=${cm.messageLevel()}|src=${cm.sourceId()}:${cm.lineNumber()}|msg=${cm.message()}")
                return true
            }

            /**
             * `<input type=file>` 的选择请求交给 [PiqFileChooser]。
             * 返回值即"宿主是否承接了这次请求"，不承接时 WebView 自行结束等待。
             */
            override fun onShowFileChooser(
                view: WebView,
                callback: ValueCallback<Array<Uri>>,
                params: FileChooserParams,
            ): Boolean = fileChooser.open(params, callback)
        }
        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                assetLoader.shouldInterceptRequest(request.url)

            /**
             * 只允许应用自己的 asset origin。`startsWith(ORIGIN)` 会放进
             * `appassets.androidplatform.net.evil`，所以判据由 [BridgeOriginGuard] 统一给出；
             * 返回 true = 取消导航，页面停在原文档。
             */
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url.toString()
                val allowed = BridgeOriginGuard.isTrusted(url)
                if (allowed) {
                    currentPageUrl = url
                    lastTrustedPage = url
                }
                if (!allowed) Log.w(TAG, "nav-blocked|${safeUrlForLog(url)}|origin=$ORIGIN")
                return !allowed
            }

            /**
             * CDP / 程序化导航可能绕过 `shouldOverrideUrlLoading`（R13.1 F3 设备实测：
             * `Page.navigate` 到 `data:` 时直接进了 onPageStarted）。这里把当前 URL 先记成
             * **实际文档**（桥随即拒绝），再停止加载并拉回最后一个可信页面。
             * 桥的最终判定另由文档启动令牌收紧（`data:` 文档拿不到令牌）。
             */
            override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
                currentPageUrl = url
                if (!BridgeOriginGuard.isTrusted(url)) {
                    Log.w(TAG, "nav-blocked|stage=started|${safeUrlForLog(url)}|origin=$ORIGIN")
                    view.stopLoading()
                    lastTrustedPage?.let(view::loadUrl)
                    return
                }
                lastTrustedPage = url
            }

            override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean) {
                if (BridgeOriginGuard.isTrusted(url)) {
                    currentPageUrl = url
                    lastTrustedPage = url
                }
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                Log.w(TAG, "net-error|url=${request.url}|code=${error.errorCode}|desc=${error.description}")
            }

            override fun onPageFinished(view: WebView, url: String) {
                if (BridgeOriginGuard.isTrusted(url)) {
                    currentPageUrl = url
                    lastTrustedPage = url
                    appPageLoaded = true
                    if (activityResumed) tiltSensor?.start()
                }
                Log.i(TAG, "page-finished|url=$url|title=${view.title}")
                insets.repush()
                applyPendingCalendarRoute()
            }
        }
        webView.addJavascriptInterface(PiqBridge(), JS_BRIDGE)
        webView.addJavascriptInterface(
            PiqExport.Bridge(this, { currentPageUrl }, { BridgeToken.value }),
            PiqExport.BRIDGE_NAME,
        )
        installAndroidGate()

        logWebViewPackage()
        loadRoot()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        pendingCalendarNotifyId = intent.getIntExtra(PiqReminderScheduler.EXTRA_NOTIFY_ID, 0)
        val previous = variant
        variant = resolveAndPersist(intent)
        Log.i(TAG, "new-intent|previous=$previous|now=$variant")
        bindThemeRoot(resolveTheme(variant))
        // 首帧的 WebView 还没建好（冷启动一帧内收到新 Intent）：variant 已更新，
        // buildWebView 会按最新 variant 调 loadRoot；这里不能碰未初始化的 webView。
        if (!::webView.isInitialized) return
        if (variant != previous || !appPageLoaded) {
            loadRoot()
        } else {
            applyPendingCalendarRoute()
        }
    }

    /**
     * 文件选择结果回填（[PiqFileChooser] 的请求码）。取消也要回填，否则 WebView 认为请求仍挂起，
     * 之后点「选择文件」不会再出选择器。
     */
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == PiqFileChooser.REQUEST_CODE) {
            if (::fileChooser.isInitialized) fileChooser.finish(resultCode, data)
        } else if (requestCode == PiqExport.SAVE_AS_REQUEST_CODE) PiqExport.finishSaveAs(this, resultCode, data)
    }

    // ------------------------------------------------------------- R11 提醒层（PiqReminderHooks）

    /** 挂在权限框上等结果的回调：同一时刻最多一个（用户没点掉就不会再问第二次）。 */
    private var pendingPermissionCallback: ((Boolean) -> Unit)? = null

    override fun notificationPermissionGranted(): Boolean = PiqReminderScheduler.permissionGranted(this)

    /**
     * 用户亲手打开总开关 ⇒ 弹一次权限框。
     *
     * 两件事决定了这里的写法：设置写入跑在 JS 桥线程，而 `requestPermissions` 只能在主线程 ⇒
     * 统一 `runOnUiThread`；早期任务要求"不许循环弹框" ⇒ 已经有回调挂在框上就直接跳过。
     * API 32 及以下没有这个运行时权限，回调同步给 `true`（开关直接可用）。
     */
    override fun requestNotificationPermission(onResult: (granted: Boolean) -> Unit) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            Log.i(TAG, "notify-permission|path=pre-33|granted=true")
            onResult(true)
            return
        }
        runOnUiThread {
            if (pendingPermissionCallback != null) {
                Log.i(TAG, "notify-permission|skipped=request-already-in-flight")
                return@runOnUiThread
            }
            pendingPermissionCallback = onResult
            requestPermissions(
                arrayOf(Manifest.permission.POST_NOTIFICATIONS),
                PiqReminderScheduler.PERMISSION_REQUEST_CODE,
            )
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != PiqReminderScheduler.PERMISSION_REQUEST_CODE) return
        val granted = grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED
        val callback = pendingPermissionCallback
        pendingPermissionCallback = null
        Log.i(TAG, "notify-permission|granted=$granted|callback=${if (callback == null) "none" else "delivered"}")
        if (callback != null) {
            callback.invoke(granted)
        } else {
            // 权限对话框还开着的时候 Activity 因配置变更（字号/语言/密度）重建 ⇒ 回调挂在
            // 旧实例的字段上、随旧实例一起丢了；此刻开关已落 true、闹钟已挂而无人认领结果
            // ⇒ 按"用户拒绝"处理，走 HostSettingsBridge 拒绝分支的同一条回滚（共用函数，不另写一份）。
            Log.w(TAG, "notify-permission|callback=lost|activity-rebuilt|rolled-back=true")
            rollbackNotifyAfterPermissionDeny(settings, this, this)
        }
    }

    override fun rescheduleAsync(reason: String) =
        PiqReminderScheduler.rescheduleAsync(applicationContext, reminderSource, reason)

    override fun cancelAllAsync(reason: String) =
        PiqReminderScheduler.cancelAllAsync(applicationContext, reason)

    override fun onPause() {
        activityResumed = false
        tiltSensor?.stop()
        if (::webView.isInitialized) webView.onPause()
        super.onPause()
    }

    override fun onResume() {
        super.onResume()
        activityResumed = true
        if (::webView.isInitialized) webView.onResume()
        if (appPageLoaded) tiltSensor?.start()
    }

    override fun onDestroy() {
        tiltSensor?.stop()
        tiltSensor = null
        backTimeout?.let(backTimeoutHandler::removeCallbacks)
        backTimeout = null
        if (::webView.isInitialized) webView.destroy()
        super.onDestroy()
    }

    /**
     * 返回键 = 先问 Web 层（弹层 / 子页），未消费才回退 WebView 历史。
     *
     * 历史页打开 sheet 时 `history.length=3` 但 `canGoBack()=false`；只走 `goBack()` 会直接
     * 退出应用。前端 `__piqHandleBack` 负责关最上层 modal 或子页回父级；宿主只消费它的
     * `true`，其余仍按既有 `canGoBack()` / `super.onBackPressed()` 处理。
     */
    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        if (backPending) return
        if (isFinishing || isDestroyed) {
            super.onBackPressed()
            return
        }
        // 首帧的 WebView 还没建好：没有页面可问，按"前端未处理"退出（不碰未初始化字段）。
        if (!::webView.isInitialized) {
            Log.i(TAG, "back-js|handled=false|reason=webview-not-ready")
            super.onBackPressed()
            return
        }
        backPending = true
        backStartedAt = SystemClock.uptimeMillis()
        // 有界兜底（P3）：到点仍 backPending=true 就按"前端未处理"走 finishBack("null")，
        // 与真实回调返回 null/false 完全同一条复位路径。
        val timeout = Runnable {
            Log.w(TAG, "back-js|handled=false|reason=callback-timeout|ms=${elapsedSinceBack()}")
            finishBack("null")
        }
        backTimeout = timeout
        try {
            webView.evaluateJavascript(
                "(function(){try{return String(window.__piqHandleBack && window.__piqHandleBack())}catch(e){return 'false'}})()",
            ) { result ->
                runOnUiThread { finishBack(result) }
            }
        } catch (e: Throwable) {
            backTimeout = null
            backPending = false
            Log.w(TAG, "back-js|handled=false|reason=webview-unavailable|type=${e.javaClass.simpleName}")
            fallbackBack()
            return
        }
        backTimeoutHandler.postDelayed(timeout, BACK_JS_TIMEOUT_MS)
    }

    private fun finishBack(result: String?) {
        backTimeout?.let(backTimeoutHandler::removeCallbacks)
        backTimeout = null
        // 兜底先到 ⇒ backPending 已按"前端未处理"复位；迟到的真实回调直接丢弃，
        // 不得再触发一次回退/退出（双重 goBack 或连退两层）。
        if (!backPending) return
        backPending = false
        if (isFinishing || isDestroyed) {
            super.onBackPressed()
            return
        }
        // evaluateJavascript 返回的是 JSON 形态：字符串 "true" 会带引号，布尔 true 不带。
        if (result?.trim()?.trim('"') == "true") {
            Log.i(TAG, "back-js|handled=true|ms=${elapsedSinceBack()}")
            return
        }
        fallbackBack()
    }

    @Suppress("DEPRECATION")
    private fun fallbackBack() {
        if (!::webView.isInitialized) {
            Log.i(TAG, "back-exit|reason=webview-not-ready")
            super.onBackPressed()
            return
        }
        if (webView.canGoBack()) {
            val before = webView.url
            webView.goBack()
            // 只记 from=：goBack() 是异步导航，立刻读 webView.url 会把"还没动"读成"动到了"，
            // 那条读数会误导设备侧判据。回退后的真实地址由 onPageFinished 那条日志给。
            Log.i(TAG, "back-navigate|from=$before|canGoBackNow=${webView.canGoBack()}")
        } else {
            Log.i(TAG, "back-exit|reason=no-webview-history")
            super.onBackPressed()
        }
    }

    /**
     * 资产根选择入口（B1 授权的形态）：`MainActivity` 的**启动 extra** `ui_variant`。
     * 不是导出组件、不是 broadcast；白名单之外的取值一律忽略并回落 `default`，且不写盘。
     * 的设置页（早期跨端契约：`app_settings.ui_variant` + 密码门）将替换它。
     */
    private fun resolveAndPersist(source: Intent?): String {
        val extra = source?.getStringExtra(EXTRA_UI_VARIANT)
        val stored = prefs.getString(KEY_UI_VARIANT, null)
        val resolved = VariantPolicy.resolve(extra, stored)
        val writable = VariantPolicy.persistable(extra)
        if (writable != null && writable != stored) {
            prefs.edit().putString(KEY_UI_VARIANT, writable).apply()
        }
        Log.i(TAG, "resolve-variant|extra=$extra|stored=$stored|resolved=$resolved|written=${writable != null}")
        return resolved
    }

    /**
     * 主题根探测（早期跨端契约：硬护栏）：**在选根之前**把候选根验一遍，
     * 缺失 / 损坏 / `minApp` 不满足一律回退内置默认根，并把可读原因落日志（R2-a 的缺陷：
     * 请求时才解析路径 ⇒ 根不存在只在加载期 404 ⇒ 页面变成 `chrome-error://`）。
     */
    private fun resolveTheme(requested: String): ThemeDecision =
        ThemeResolver.resolve(assets, File(filesDir, DIR_THEMES), requested, BuildConfig.VERSION_NAME)

    /** 按判定结果换根：重建 handler 与 loader（`/shared/` 恒指默认根，不随主题切换）。 */
    private fun bindThemeRoot(decision: ThemeDecision) {
        this.decision = decision
        themeSource = when (val root = decision.root) {
            is ThemeRoot.Assets -> AssetRootHandler(assets, root.prefix)
            is ThemeRoot.Installed -> FileRootHandler(root.dir, ThemeResolver.label(root))
        }
        // 注册顺序即匹配顺序（第一个前缀命中就用它，**不是**最长前缀优先）：
        // 所以不能再单独注册 /assets/——它会把 /assets/x 解析成 www/x，
        // 而真实前端要的是 www/assets/x。静态绝对路径 /js /css /fonts /assets 一律交给根兜底。
        assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler(PATH_THEME, themeSource)
            .addPathHandler(PATH_ROOT, ApiGatewayHandler(themeSource, apiGateway))
            .build()
        val reason = decision.fallbackReason
        if (reason == null) {
            Log.i(TAG, "theme-bound|requested=${decision.requested}|root=${themeSource.rootLabel()}|entry=${decision.entry}|evidence=${decision.evidence}")
        } else {
            Log.w(TAG, "theme-fallback|requested=${decision.requested}|effective=default|root=${themeSource.rootLabel()}|reason=$reason|evidence=${decision.evidence}")
        }
    }

    private fun loadRoot() {
        // 深链不再拼 `#/calendar`：前端没有 hashchange/`location.hash` 消费点（Round 4 根因之一）。
        // 通知点击统一走 onPageFinished / onNewIntent 的 `window.__piqNavigate('calendar')` 契约。
        val url = ORIGIN + PATH_THEME + decision.entry
        Log.i(TAG, "load-root|variant=$variant|root=${themeSource.rootLabel()}|url=$url|coldDeepLink=${pendingCalendarNotifyId != 0}")
        webView.loadUrl(url)
    }

    /**
     * 把通知点击带到日历页。
     *
     * 旧实现用 `typeof App!=='undefined'&&App.user` 判断前端就绪——页内并不挂 `window.App`，
     * 判据恒 false；把 `#/calendar` 拼进 URL 也没有任何消费点。现在唯一契约是页内
     * `window.__piqNavigate('calendar')`（`js/main.js`，复用 dock 的 `core.nav`，不新造路由），
     * 三种回答：
     *  - `'1'`   已切到 Calendar（或本来就在）⇒ 清 pending，日志 applied=true；
     *  - `'pending'` 页面已就绪但未认证 ⇒ 目标已存进 sessionStorage（登录后的 reload 由页内消费），
     *    停止重试，等 `afterApiServed` 的登录成功再触发一次；
     *  - 其它（`'0'`/空）页面还没就绪 ⇒ 200ms 后重试，10 次为止；超时**不清 pending**。
     * 日志只带 notifyId 与结果，不带日期。
     */
    private fun applyPendingCalendarRoute(attempt: Int = 1) {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            webView.post { applyPendingCalendarRoute(attempt) }
            return
        }
        val notifyId = pendingCalendarNotifyId
        if (notifyId == 0) return
        webView.evaluateJavascript(
            "(function(){try{return String(window.__piqNavigate&&window.__piqNavigate('calendar'))}catch(e){return '0'}})()",
        ) { raw ->
            if (pendingCalendarNotifyId != notifyId) return@evaluateJavascript
            when (raw?.trim()?.trim('"')) {
                "1" -> {
                    pendingCalendarNotifyId = 0
                    Log.i(TAG, "deeplink|route=calendar|notifyId=$notifyId|applied=true")
                }

                "pending" ->
                    Log.i(TAG, "deeplink|route=calendar|notifyId=$notifyId|applied=false|reason=auth-pending")

                else -> if (attempt >= MAX_DEEPLINK_ATTEMPTS) {
                    Log.i(TAG, "deeplink|route=calendar|notifyId=$notifyId|applied=false")
                } else {
                    webView.postDelayed({ applyPendingCalendarRoute(attempt + 1) }, DEEPLINK_RETRY_MS)
                }
            }
        }
    }

    /**
     * 首条请求被服务之前结算启动期的候选凭证（L2E-03）。
     *
     * **为什么挂在这个位置**：[apiGateway] 是桥（[PiqBridge]）与资源拦截（`ApiGatewayHandler`）
     * 两条通道共同的漏斗，在它分发之前判一次，就保证过期凭证**没有**授权过任何一次请求；
     * 判据由 [PiqServices.isSessionLive] 给出，与 `PiqRouter.requireUser` 用的是同一条 SQL。
     *
     * **为什么不在 `onCreate` 里判**：有效性只有数据库知道，而建表与 `Python.start` 按
     * [PiqServices] 的纪律不得落在主线程；启动期主线程唯一能做的是"解出候选"。
     *
     * ⚠ 页内的令牌播种（[installAndroidGate]）发生在结算之前 —— 这是有意的：播种撤掉的话，
     * 前端在"没有令牌"的形态下根本不发请求，结算点就没有触发时机，用户会被静默停在登录页，
     * 与这条缺陷要求的"看得见一句解释"相反。
     */
    private fun settleStartupSession(path: String) {
        if (!sessions.adoptionPending()) {
            // 没有候选会话也照样可能刚发生过"损坏库保底重置"（后台开库探测是另一条入口）。
            notifyCorruptionResetIfAny(path)
            return
        }
        val autoLoginBefore = settings.isAutoLoginEnabled()
        val outcome = sessions.settleAdoption { token -> services.isSessionLive(token) }
        // 损坏库被保底重置后，账号/会话本就随之消失（DB 刚打开时才判出来）——
        // 这不是"登录过期"（P0 误报），也无需再试口令固化槽重登：给明确的"本地数据已重置"提示。
        if (notifyCorruptionResetIfAny(path)) return
        if (outcome != SessionSettlement.EXPIRED) {
            Log.i(TAG, "startup-session|stage=settle|adopted=${outcome == SessionSettlement.KEPT}|reason=${if (outcome == SessionSettlement.KEPT) "live" else "no-candidate"}|path=$path")
            return
        }
        // 2026-10-26 登录持久化：固化槽在 ⇒ 走 POST /auth/relogin 同一条路由做本机重登，
        // 成功则用户无感继续（不发过期提示）；无槽/失败维持现状。直接调 [PiqServices.router]
        // 不经 [apiGateway]，不构成递归；重登的新令牌由路由内 SessionHolder.issue 采纳进
        // 进程级 SessionSlot，对本漏斗后续服务的桥请求生效。
        if (settings.loadPasswordSlot() != null) {
            val envelope = services.router.handle("POST", PiqConfig.API_PREFIX + "/auth/relogin", "{}")
            if (envelope.status == 200) {
                if (autoLoginBefore) {
                    // 开关在上面的过期结算里被 clear 回弹 ⇒ 恢复开启并落盘新令牌，
                    // 下次冷启动仍能无感恢复（与 POST /auth/persistence 成功后的落盘同形）
                    settings.setAutoLoginEnabled(true)
                    sessions.current()?.let { settings.save(it) }
                }
                Log.i(TAG, "startup-session|stage=settle|adopted=true|reason=relogin|path=$path")
                return
            }
            Log.w(TAG, "startup-session|stage=settle|reason=relogin-failed|status=${envelope.status}|path=$path")
        }
        showUserHint(this, PiqStrings.SESSION_EXPIRED_HINT)
        Log.i(TAG, "startup-session|stage=settle|adopted=false|reason=expired|autoLogin=$autoLoginBefore>${settings.isAutoLoginEnabled()}|hint=shown|path=$path")
    }

    /**
     * 启动期在**后台**把库打开一次：损坏检测（`PiqDb` 的完整性探测）因此发生在首屏之前，
     * "本地数据已重置"才有落点。健康库只是把本来第一条请求就会做的开库提前到启动期，
     * 不开 Python、不碰 WebView，也不阻塞主线程。
     */
    private fun detectCorruptionResetAsync() {
        Thread({
            val opened = runCatching { PiqDb.shared(applicationContext) }
            if (opened.isFailure) {
                Log.w(TAG, "db-integrity|open=failed|type=${opened.exceptionOrNull()?.javaClass?.simpleName}")
                return@Thread
            }
            val backup = PiqDb.takeCorruptionReset(applicationContext)
            if (backup == null) {
                Log.i(
                    TAG,
                    "db-integrity|open=ok|corruption=" +
                        if (PiqDb.corruptionResetInProcess() != null) "notified" else "none",
                )
                return@Thread
            }
            showCorruptionResetOnce(backup)
            Log.i(TAG, "db-integrity|open=ok|corruption=reset|backup=$backup|thread=background")
        }, "piq-db-integrity").apply { isDaemon = true }.start()
    }

    /** 本进程发生过损坏重置 ⇒ 取走一次性标志并给提示；返回是否命中（命中时调用方不再报"登录过期"）。 */
    private fun notifyCorruptionResetIfAny(path: String): Boolean {
        val backup = PiqDb.corruptionResetInProcess() ?: return false
        // 每次请求都会经过这里；提示只发一次，也不再重复读写一次性标志。
        if (corruptionNoticeShown) return true
        PiqDb.takeCorruptionReset(this)
        showCorruptionResetOnce(backup)
        Log.w(TAG, "db-corrupt|notice=startup|backup=$backup|path=$path")
        return true
    }

    /**
     * 一条**只出现一次**的明确告知（与"登录过期"互斥）：本地数据文件坏了、已重置、
     * 原文件已备份、可登录后从备份导入。没有它，用户只会看到账号/周期凭空消失。
     */
    private fun showCorruptionResetOnce(backup: String) {
        synchronized(corruptionNoticeLock) {
            if (corruptionNoticeShown) return
            corruptionNoticeShown = true
        }
        showUserHint(applicationContext, PiqStrings.CORRUPTION_RESET_HINT)
        Log.w(TAG, "db-corrupt|notice=shown|backup=$backup")
    }

    /**
     * 早期跨端契约里的 `piq-android` 注入点：不改前端源码，只影响行为（SW 替身、标记、键盘滚动、令牌播种）。
     */
    private fun installAndroidGate() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            Log.w(TAG, "gate-unsupported|feature=DOCUMENT_START_SCRIPT|minWebView=83|consequence=blocked")
            webView.visibility = View.GONE
            AlertDialog.Builder(this)
                .setTitle(PiqStrings.WEBVIEW_OUTDATED_TITLE)
                .setMessage(PiqStrings.WEBVIEW_OUTDATED_MESSAGE)
                .setCancelable(false)
                .setPositiveButton(PiqStrings.EXIT) { _, _ -> finish() }
                .show()
            return
        }
        val seed = sessions.current()
        WebViewCompat.addDocumentStartJavaScript(
            webView,
            AndroidGate.documentStartScript(seed, settings.themePreference(), isSystemDark(), settings.langPreference()) + "\n" +
                PiqExport.SCRIPT + "\n" + bridgeTokenScript(BridgeToken.value),
            setOf(ORIGIN),
        )
        Log.i(TAG, "gate-installed|class=${AndroidGate.CLASS_FLAG}|origin=$ORIGIN|exportBridge=${PiqExport.BRIDGE_NAME}|tokenSeed=${if (seed == null) "none" else "len" + seed.length}|bridgeToken=len${BridgeToken.value.length}")
    }

    private fun logWebViewPackage() {
        val pkg = WebView.getCurrentWebViewPackage()
        Log.i(TAG, "webview-package|name=${pkg?.packageName}|version=${pkg?.versionName}")
    }

    /**
     * JS 桥（请求-响应形态，早期跨端契约：`request(method, path, body) -> {status, json}`）。
     *
     * 起 `request` 转 [PiqRouter]（本机实现）。**计数口径写全**：`method ==` 守卫行 31 条 = 字面 `method` + `rest` 28 条 + 正则匹配 `CYCLE_ID` 2 条（`:137`、`:138`）+ `/debug/` 前缀兜底 1 条（`:169`）；**端点条数**以早期跨端契约的清单为准，注释里不写死；未实现分支由路由给 501。
     * `getSetting` / `setSetting` 是**宿主机设置**通道（自动登录开关，早期跨端契约的命名域），
     * 只在 `piq-android` 门控内的 UI 里被调用，不是任何 REST 端点的替身。
     *
     * 跑在 WebView 的 JS 桥线程上（非 `main`）；日志只记长度与状态码，**不记 body 内容**
     * ——登录/注册响应里含会话令牌（早期跨端契约：凭证不得进入日志）。
     */
    inner class PiqBridge {

        /** 非应用 origin 的文档不得调用任何桥方法；只读主线程快照，不碰 WebView。 */
        private fun trustedDocument(): Boolean = BridgeOriginGuard.isTrusted(currentPageUrl)

        /** 令牌只注入 ORIGIN 文档；`data:` 文档即使拖到拉回后执行也拿不到。 */
        private fun tokenValid(token: String?): Boolean = token != null && token == BridgeToken.value

        private fun rejectUntrusted(operation: String, token: String?): String? {
            val trusted = trustedDocument()
            val tokenOk = tokenValid(token)
            if (trusted && tokenOk) return null
            val reason = if (!trusted) "untrusted-origin" else "bad-token"
            return rejectWithLog(operation, reason)
        }

        private fun rejectWithLog(operation: String, reason: String): String {
            Log.w(TAG, "bridge-origin-rejected|op=$operation|reason=$reason|${safeUrlForLog(currentPageUrl)}")
            return Envelope.failure(
                403,
                "This page is not part of the app, so the local request was refused.",
                "FORBIDDEN_ORIGIN",
            ).toJsonString()
        }

        /** 旧的三参入口：没有令牌，直接 403（让 `data:` 文档的普通调用留下可观测拒绝）。 */
        @JavascriptInterface
        fun request(method: String?, path: String?, body: String?): String =
            rejectWithLog("request", "missing-token")

        @JavascriptInterface
        fun requestWithToken(method: String?, path: String?, body: String?, token: String?): String {
            rejectUntrusted("request", token)?.let { return it }
            val thread = Thread.currentThread().name
            if (method.isNullOrBlank() || path.isNullOrBlank()) {
                Log.w(TAG, "bridge-call-rejected|method=$method|path=$path|thread=$thread")
                return Envelope(
                    404,
                    JSONObject().put("detail", "Missing method or path").put("code", "NOT_FOUND"),
                ).toJsonString()
            }
            Log.i(TAG, "bridge-call|method=$method|path=$path|bytes=${body?.utf8ByteLength() ?: 0}|chars=${body?.length ?: 0}|thread=$thread|onUiThread=${Looper.myLooper() == Looper.getMainLooper()}")
            val envelope = try {
                apiGateway.request(method, path, body)
            } catch (e: Throwable) {
                Log.w(TAG, "bridge-unhandled|path=$path|type=${e.javaClass.name}|message=${e.message}")
                genericFailure(500, "BRIDGE_ERROR")
            }
            // 序列化一次、两处复用（返回给页内的就是这一个串）；两腿都记 bytes/chars 才对得上账
            val responseJson = envelope.toJsonString()
            Log.i(TAG, "bridge-return|path=$path|status=${envelope.status}|bytes=${responseJson.utf8ByteLength()}|chars=${responseJson.length}|thread=$thread")
            return responseJson
        }

        /** 无令牌入口：直接空回并留拒绝日志。 */
        @JavascriptInterface
        fun getSetting(key: String?): String {
            rejectWithLog("getSetting", "missing-token")
            return ""
        }

        @JavascriptInterface
        fun getSettingWithToken(key: String?, token: String?): String {
            if (rejectUntrusted("getSetting", token) != null) return ""
            return hostSettings.getSetting(key ?: "")
        }

        @JavascriptInterface
        fun setSetting(key: String?, value: String?): String {
            rejectWithLog("setSetting", "missing-token")
            return ""
        }

        @JavascriptInterface
        fun setSettingWithToken(key: String?, value: String?, token: String?): String {
            if (rejectUntrusted("setSetting", token) != null) return ""
            return hostSettings.setSetting(key ?: "", value ?: "")
        }

        @JavascriptInterface
        fun setThemeWithToken(dark: Boolean, token: String?): String {
            if (rejectUntrusted("setTheme", token) != null) return ""
            // 页内先落盘 `app_settings.theme` 再调这里（you.settings.js 的 persistTheme），
            // 所以读落盘值就是用户刚选的那一档；应用级 night mode 决定下一次冷启动的 splash 取色。
            applyAppNightMode(settings.themePreference())
            runOnUiThread { applySystemBarIcons(dark) }
            Log.i(TAG, "theme-bars|dark=$dark")
            return "ok"
        }

        @JavascriptInterface
        fun setLangWithToken(lang: String?, token: String?): String {
            if (rejectUntrusted("setLang", token) != null) return ""
            val saved = settings.setLangValue(lang ?: "") ?: return ""
            PiqReminderScheduler.ensureChannel(applicationContext)
            rescheduleAsync("lang-changed")
            Log.i(TAG, "app-lang|lang=$saved")
            return saved
        }
    }

    /**
     * AndroidManifest 自己消化 `uiMode`（不重建 Activity），所以 WebView 不会重算
     * `prefers-color-scheme`。系统深色开关变化时把新的明暗送进页内：
     *  - 页内只有当前选择是 System 时才真正换主题（见 app.js 的 piq-system-theme 监听）；
     *  - 系统栏图标按"已选模式 + 新系统明暗"重算，Light/Dark 不受系统切换影响。
     */
    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        val systemDark = (newConfig.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
            Configuration.UI_MODE_NIGHT_YES
        val pageDark = when (settings.themePreference()) {
            "light" -> false
            "dark" -> true
            "system" -> systemDark
            else -> true
        }
        applySystemBarIcons(pageDark)
        if (::webView.isInitialized) {
            webView.evaluateJavascript(
                "document.dispatchEvent(new CustomEvent('piq-system-theme',{detail:{dark:$systemDark}}))",
                null,
            )
        }
    }

    /**
     * 首帧系统栏图标要用的明暗：已选 Light/Dark 直接照做；System 取当前系统深色开关；
     * 从未选过（null）维持既有暗色首屏，与 index.html 的 `data-theme="dark"` 一致。
     */
    private fun initialDarkTheme(mode: String?): Boolean = when (mode) {
        "light" -> false
        "dark" -> true
        "system" -> isSystemDark()
        else -> true
    }

    /** 系统的深色开关（Activity 当前 Configuration），WebView 的 prefers-color-scheme 可能滞后，以它为准。 */
    private fun isSystemDark(): Boolean =
        (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
            Configuration.UI_MODE_NIGHT_YES

    /**
     * 把用户主题偏好映射成**应用级夜间模式**（Android 收尾轮 Round 4，P2）。
     *
     * 为什么这与 `setTheme()` 不是一回事：Android 12+ 的冷启动 splash 由清单静态主题
     * （`PiqThemeSystem`）决定，而 `values-night` 的选取只看**应用的**夜间模式。系统保存这个值
     * （按包名），所以只要在用户选主题时写一次，之后每次冷启动的启动窗口就按所选主题取色：
     * Dark ⇒ 深色 splash、Light ⇒ 浅色、System ⇒ 跟随系统。`setTheme()` 只能改 Activity 自己的
     * 窗口，晚于系统已经画出的 splash。
     *
     * 从未选择过（null）按既有默认深色处理（与 index.html 的 `data-theme="dark"` 同口径）。
     * API < 31 没有这个接口 ⇒ 退回"跟随系统"（低版本的启动窗口极短，如实作为可接受子集）。
     */
    private fun applyAppNightMode(mode: String?) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            Log.i(TAG, "app-night-mode|skipped=api<31|mode=${mode ?: "unset"}")
            return
        }
        val target = when (mode) {
            "light" -> UiModeManager.MODE_NIGHT_NO
            "dark" -> UiModeManager.MODE_NIGHT_YES
            "system" -> UiModeManager.MODE_NIGHT_AUTO
            else -> UiModeManager.MODE_NIGHT_YES
        }
        val manager = getSystemService(UiModeManager::class.java) ?: return
        // 没有公开 getter（android.jar 里只有 setApplicationNightMode）⇒ 直接写；同值写入是系统的
        // 幂等语义，不会因为"设置没变"而触发一次配置变化。
        runCatching { manager.setApplicationNightMode(target) }
            .onFailure { Log.w(TAG, "app-night-mode|ok=false|type=${it.javaClass.simpleName}") }
        Log.i(TAG, "app-night-mode|mode=${mode ?: "unset"}|value=$target")
    }

    /** 系统栏图标跟随页面主题：亮底用深色图标，暗底用浅色图标。 */
    private fun applySystemBarIcons(dark: Boolean) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val controller = window.insetsController ?: return
            val lightBars = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or
                WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
            controller.setSystemBarsAppearance(if (dark) 0 else lightBars, lightBars)
        } else {
            @Suppress("DEPRECATION")
            val lightFlags = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
            @Suppress("DEPRECATION")
            val flags = if (dark) {
                window.decorView.systemUiVisibility and lightFlags.inv()
            } else {
                window.decorView.systemUiVisibility or lightFlags
            }
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = flags
        }
    }

    companion object {
        private const val TAG = "PIQ"
        private const val PREFS = "piq_spike"
        private const val KEY_UI_VARIANT = "ui_variant"
        private const val EXTRA_UI_VARIANT = "ui_variant"
        private const val JS_BRIDGE = "PIQNative"

        /** 启动期凭证过期时给用户的那一句（L2E-03：不得静默弹回登录页）。 */
        private const val SESSION_EXPIRED_HINT = "Your previous sign-in has expired. Enter your password again."

        /**
         * DB 损坏重置的提示**每进程只发一次**（后台开库探测与首条请求结算两条入口都会检查，
         * Activity 因字号/语言重建也不重复弹）。放进程级是刻意的：重置只发生在进程启动期。
         */
        @Volatile
        private var corruptionNoticeShown: Boolean = false

        /** 提示只发一次的进程级锁（后台开库线程与 JS 桥线程会同时走进来）。 */
        private val corruptionNoticeLock = Any()

        /**
         * DB 损坏被保底重置时给用户的那一句（P0）：必须说清"本地文件坏了 / 已重置 / 可导入备份"，
         * 不能用"登录过期"顶替（那会让用户以为只是会话失效，实际是账号与周期数据一起没了）。
         */
        private const val CORRUPTION_RESET_HINT =
            "Local data was damaged and has been reset (the original file was backed up). Sign in and import a backup to restore it."

        private const val ORIGIN = BridgeOriginGuard.ORIGIN
        private const val PATH_THEME = "/theme/"
        private const val PATH_ROOT = "/"

        /** 已安装主题包的落点（早期跨端契约：安卓 `files/themes/<id>/`）。 */
        private const val DIR_THEMES = "themes"

        /** 通知深链：单次触发最多 10 次（约 2s），超时不清 pending。 */
        private const val MAX_DEEPLINK_ATTEMPTS = 10
        private const val DEEPLINK_RETRY_MS = 200L

        /**
         * 返回键 JS 回答的超时兜底：等不到回调就按"前端未处理"复位（P3）。
         *
         * 5000ms 的依据（3.0.9 设备实测，logcat 里的 `back-js|handled=true|ms=` 是实际应答延迟）：
         * `__piqHandleBack()` 本身只花 ~11ms（CDP 直测），但 `evaluateJavascript` 的回答要排进
         * WebView 渲染器/主线程队列；在 You 的玻璃+星空主循环、Calendar 的拨盘绘制、页面转场同时
         * 存在时，实测应答 0.8s / 0.93s / 1.37s / 2.37s / 2.71s，旧值 500ms 与 1200ms 都会在处理器
         * 明明存在时先走 timeout（`back-js|handled=false|reason=callback-timeout`），把"关闭 sheet"
         * 误判成"前端未处理"进而退出应用。兜底只服务"JS 真的不回答"这一支，抬高它不会拖慢正常返回，
         * 且仍是**有界**等待（渲染器真的没了时最坏约 5s 后按无历史退出）。
         *
         * 注意：主线程被卡住时 timeout 与回调一起排队，此时通常是先到的回调先执行、兜底自然失效，
         * 不会出现"UI 卡顿反而触发退出"的反向误伤。
         */
        private const val BACK_JS_TIMEOUT_MS = 5000L
    }
}
