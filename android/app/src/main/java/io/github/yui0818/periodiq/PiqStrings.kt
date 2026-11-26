/*
 * Copyright (c) 2026 Yui_0818 (aaaj6719@gmail.com)
 * Licensed under the PolyForm Noncommercial License 1.0.0.
 * Commercial use is prohibited without separate written authorization.
 * See LICENSE and COMMERCIAL.md in the repository root.
 */

package io.github.yui0818.periodiq

/**
 * 宿主机侧**全部用户可见文案**的唯一来源，支持三语（`zh-CN` / `en` / `es`）。
 *
 * 语言解析顺序：用户在应用内显式选定的语言（[PiqSettings.langPreference]）优先，
 * 未设定时回落系统语言（`zh* -> zh-CN`、`es* -> es`、其余 `en`）。
 * 非用户可见的日志、原因码、通知 id 不在这里。
 */
object PiqStrings {

    private fun currentLang(): String =
        PiqSettings.processSharedOrNull()?.resolvedLang() ?: PiqSettings.systemDefaultLang()

    private fun pick(zh: String, en: String, es: String, lang: String = currentLang()): String = when (lang) {
        "zh-CN" -> zh
        "es" -> es
        else -> en
    }

    // ---- 提醒通知（渠道 + 文案） ----

    val CHANNEL_NAME: String
        get() = pick("经期提醒", "Period reminders", "Recordatorios de período")

    val CHANNEL_DESCRIPTION: String
        get() = pick(
            "提前、当日和逾期经期提醒",
            "Advance, on-day and overdue period reminders",
            "Recordatorios previos, del día y de retraso del período",
        )

    /** 锁屏/通知栏公开版本：不含日期、不含"经期"等隐私字样。 */
    val PUBLIC_VERSION_TITLE: String
        get() = pick("PeriodIQ 提醒", "Period reminders", "Recordatorios de PeriodIQ")

    val PUBLIC_VERSION_BODY: String
        get() = pick(
            "记得随身带好需要的物品。",
            "Remember to bring what you need.",
            "Recuerda llevar lo que necesitas.",
        )

    fun advanceTitle(days: Int, lang: String = currentLang()): String = pick(
        zh = "预计 $days 天后开始经期",
        en = "Your period is expected in $days ${if (days == 1) "day" else "days"}",
        es = "Tu período se espera en $days ${if (days == 1) "día" else "días"}",
        lang = lang,
    )

    fun advanceBody(predictedStart: String, lang: String = currentLang()): String = pick(
        zh = "预计开始日 $predictedStart · 可在设置中调整提醒",
        en = "Expected to start $predictedStart · You can change reminders in Settings",
        es = "Inicio previsto: $predictedStart · Puedes cambiar los recordatorios en Ajustes",
        lang = lang,
    )

    fun onDayTitle(lang: String = currentLang()): String = pick(
        zh = "预计今天开始经期",
        en = "Your period is expected today",
        es = "Tu período se espera hoy",
        lang = lang,
    )

    fun onDayBody(predictedStart: String, lang: String = currentLang()): String = pick(
        zh = "预计开始日 $predictedStart · 打开应用记录实际情况",
        en = "Expected start $predictedStart · Open the app to record what actually happens",
        es = "Inicio previsto: $predictedStart · Abre la app para registrar lo que ocurra",
        lang = lang,
    )

    fun overdueTitle(daysOverdue: Int, lang: String = currentLang()): String = pick(
        zh = "经期已推迟 $daysOverdue 天",
        en = "Your period is $daysOverdue ${if (daysOverdue == 1) "day" else "days"} late",
        es = "Tu período lleva $daysOverdue ${if (daysOverdue == 1) "día" else "días"} de retraso",
        lang = lang,
    )

    fun overdueBody(lang: String = currentLang()): String = pick(
        zh = "尚未记录开始日期 · 打开应用记录一下",
        en = "No start date has been logged yet · Open the app and record it",
        es = "Aún no se ha registrado la fecha de inicio · Abre la app para registrarla",
        lang = lang,
    )

    fun dailyFillTitle(): String = "PeriodIQ"

    fun dailyFillBody(lang: String = currentLang()): String = pick(
        zh = "睡前一分钟，把今天的感受记下来吧",
        en = "Take a minute before bed to note how today felt",
        es = "Tómate un minuto antes de dormir para anotar cómo te sentiste hoy",
        lang = lang,
    )

    // ---- 导出（对话框 / 回执 / 失败） ----

    fun exportDialogTitle(name: String): String = pick(
        zh = "已导出 $name",
        en = "Exported $name",
        es = "Exportado $name",
    )

    fun exportDialogMessage(name: String, size: String): String = pick(
        zh = "$name（$size）\n备份文件包含周期数据，请仅分享给信任的应用。",
        en = "$name ($size)\nThe backup contains cycle data. Share it only with apps you trust.",
        es = "$name ($size)\nLa copia de seguridad contiene datos del ciclo. Compártela solo con apps de confianza.",
    )

    val SHARE: String get() = pick("分享", "Share", "Compartir")
    val SAVE_AS: String get() = pick("另存为", "Save as", "Guardar como")
    val DONE: String get() = pick("完成", "Done", "Listo")
    val SHARE_EXPORT: String get() = pick("分享导出文件", "Share export", "Compartir exportación")
    val NO_SHARE_APP: String get() = pick(
        "没有可用于分享此文件的应用。",
        "No app can share this file.",
        "Ninguna app puede compartir este archivo.",
    )
    val SAVE_CANCELED: String get() = pick("已取消保存。", "Save canceled.", "Guardado cancelado.")
    val SAVE_INCOMPLETE: String get() = pick(
        "保存未完成，请重试。",
        "Save did not finish. Try again.",
        "No se completó el guardado. Inténtalo de nuevo.",
    )
    val SAVE_NO_TARGET: String get() = pick(
        "保存失败：未返回保存位置。",
        "Save failed: no destination was returned.",
        "Error al guardar: no se devolvió ningún destino.",
    )
    val SAVE_FAILED: String get() = pick(
        "保存失败，请重试。",
        "Save failed. Try again.",
        "Error al guardar. Inténtalo de nuevo.",
    )

    fun saved(name: String): String = pick(
        zh = "已保存 $name",
        en = "Saved $name",
        es = "Guardado $name",
    )

    fun exportReceipt(name: String, size: String): String = pick(
        zh = "已将 $name（$size）保存到应用下载目录，可使用「分享」或「另存为」导出。",
        en = "Saved $name ($size) to the app's download folder. Use Share or Save as to export it.",
        es = "Se guardó $name ($size) en la carpeta de descargas de la app. Usa Compartir o Guardar como para exportarlo.",
    )

    fun exportFailure(code: String, name: String): String {
        val maxMb = PiqExport.MAX_EXPORT_BYTES / (1024 * 1024)
        return when (code) {
            "TOO_LARGE" -> pick(
                "导出文件超过 $maxMb MB，未保存。",
                "This export is over $maxMb MB and was not saved.",
                "Esta exportación supera los $maxMb MB y no se guardó.",
            )
            "EMPTY_PAYLOAD" -> pick(
                "页面未发送内容，未导出 $name。",
                "The page sent no content, so $name was not exported.",
                "La página no envió contenido, así que no se exportó $name.",
            )
            "BAD_BASE64" -> pick(
                "页面发送的内容无法解析，未导出 $name。",
                "The page sent unreadable content, so $name was not exported.",
                "La página envió contenido ilegible, así que no se exportó $name.",
            )
            "WRITE_FAILED" -> pick(
                "无法写入 $name，请换一个目录或重试。",
                "Could not write $name. Try another folder or try again.",
                "No se pudo escribir $name. Prueba otra carpeta o inténtalo de nuevo.",
            )
            else -> pick(
                "导出失败（$code），未保存 $name。",
                "Export failed ($code); $name was not saved.",
                "Error al exportar ($code); no se guardó $name.",
            )
        }
    }

    // ---- 导入文件选择 ----

    fun fileTooLarge(limitMb: Long): String = pick(
        zh = "文件超过 $limitMb MB，未传给页面。",
        en = "The file is over $limitMb MB and was not passed to the page.",
        es = "El archivo supera los $limitMb MB y no se envió a la página.",
    )

    // ---- 设备设置提示 ----

    val AUTO_LOGIN_NO_SESSION: String
        get() = pick(
            "当前未登录账号，无法开启保持登录。请先登录后再回到此页面。",
            "No account is signed in, so Keep me signed in can't be turned on. Sign in first, then come back to this screen.",
            "No hay ninguna cuenta iniciada, por lo que no se puede activar Mantener sesión. Inicia sesión primero y vuelve aquí.",
        )

    val AUTO_LOGIN_STORAGE_UNAVAILABLE: String
        get() = pick(
            "此设备的安全存储不可用，无法保存保持登录。下次仍需输入密码。",
            "This device's secure storage is unavailable, so Keep me signed in could not be saved. You'll need to enter your password next time.",
            "El almacenamiento seguro de este dispositivo no está disponible, por lo que no se pudo guardar Mantener sesión. Tendrás que introducir tu contraseña la próxima vez.",
        )

    val THEME_SAVE_FAILED: String
        get() = pick(
            "无法保存主题，请重试。",
            "The theme could not be saved. Try again.",
            "No se pudo guardar el tema. Inténtalo de nuevo.",
        )

    val NOTIFICATION_PERMISSION_DENIED: String
        get() = pick(
            "未授予通知权限，提醒已关闭。请在系统设置中允许通知。",
            "Notifications are not allowed, so reminders were turned off. Allow notifications in system settings.",
            "Las notificaciones no están permitidas, por lo que los recordatorios se desactivaron. Permite las notificaciones en los ajustes del sistema.",
        )

    // ---- 宿主启动 ----

    val SESSION_EXPIRED_HINT: String
        get() = pick(
            "上次登录已过期，请重新输入密码。",
            "Your previous sign-in has expired. Enter your password again.",
            "Tu sesión anterior ha caducado. Introduce tu contraseña de nuevo.",
        )

    val CORRUPTION_RESET_HINT: String
        get() = pick(
            "本地数据已损坏并已重置（原文件已备份）。请登录后导入备份以恢复数据。",
            "Local data was damaged and has been reset (the original file was backed up). Sign in and import a backup to restore it.",
            "Los datos locales se dañaron y se han restablecido (se hizo copia del archivo original). Inicia sesión e importa una copia de seguridad para restaurarlos.",
        )

    val WEBVIEW_OUTDATED_TITLE: String
        get() = pick(
            "更新 Android System WebView",
            "Update Android System WebView",
            "Actualizar Android System WebView",
        )

    val WEBVIEW_OUTDATED_MESSAGE: String
        get() = pick(
            "Android System WebView 版本过低，请更新后重试。",
            "Android System WebView is too old. Update it and try again.",
            "Android System WebView es demasiado antiguo. Actualízalo e inténtalo de nuevo.",
        )

    val EXIT: String get() = pick("退出", "Exit", "Salir")
}
