/* ===== platform.js =====
 * 1 角色：平台能力探测面 + Android 设备设置桥。
 * 2 依赖：js/core.js 顶层 const core（本文件必须在其后、errors.js 前加载）；document/window 仅在调用时读取。
 * 3 暴露：core.platform（P 只在 IIFE 内）；成员 kind/hasNativeBridge/hasExportBridge/hasShellBridge +
 *    扩展点 windowControl/settingsBridge/exportBridge。settingsBridge 只在 Android 下非 null 且只封装
 *    八条提醒键（键名映射集中在本文件 SETTING_MAP）；Win/mock 仍为 null。
 * 4 不变量：加载期只做一次平台判定（读 <html class>）与对象构造，不写 DOM、不注册事件、不发请求；
 *    四个探测每次调用重新求值、不缓存；桥方法每次都重新取 window.PIQNative（允许注入晚到）并解析
 *    原生返回的 JSON 字符串；任何桥缺失/格式异常都回 {ok:false}，绝不抛给页面。
 * 5 契约来源：早期前端设计文档；宿主事实 Win\desktop\native_host.cs；Android PiqSettings.kt /
 *    HostSettingsBridge / MainActivity.PiqBridge（getSetting 返回原值串，setSetting 返回 JSON）。
 * 6 禁止改动项：不得用探测结果改变页面行为；不得注册事件/写 DOM/发请求；不得缓存探测结果；
 *    不得实现窗控或导出；不得挂 window；不得改 kind() 的判定顺序（piq-android → chrome.webview → web）。
 *
 * 新建：P1-b3（无 demo 前身）；Android 收尾轮接通 settingsBridge（八条提醒键）。
 */
(function () {
  var P = core.platform = {};
  P.kind = function () {
    if (document.documentElement.classList.contains('piq-android')) return 'android';
    if (window.chrome && window.chrome.webview) return 'win';
    return 'web';
  };
  P.hasNativeBridge = function () { return !!(window.PIQNative && window.PIQNative.request); };
  P.hasExportBridge = function () { return !!(window.PIQExport && window.PIQExport.save); };
  P.hasShellBridge  = function () { return !!(window.chrome && window.chrome.webview && window.chrome.webview.postMessage); };

  // 前端键 -> 原生键 + 值类型。这是唯一的映射表（hydrate / 写入 / 回读都以它为准）。
  var SETTING_MAP = {
    reminder_master:     { key: 'app_settings.notify_enabled',  type: 'bool' },
    reminder_advance:    { key: 'app_settings.notify_advance',  type: 'bool' },
    reminder_on_day:     { key: 'app_settings.notify_on_day',   type: 'bool' },
    reminder_overdue:    { key: 'app_settings.notify_overdue',  type: 'bool' },
    reminder_days:       { key: 'app_settings.notify_days',     type: 'int'  },
    reminder_trio_hour:  { key: 'app_settings.reminder_trio_hour', type: 'int' },
    reminder_fill_hour:  { key: 'app_settings.reminder_fill_hour', type: 'int' },
    reminder_daily_fill: { key: 'app_settings.notify_daily_fill', type: 'bool' }
  };

  function nativeBridge() {
    try {
      var n = window.PIQNative;
      return n && typeof n.getSetting === 'function' && typeof n.setSetting === 'function' ? n : null;
    } catch (_) { return null; }
  }

  function coerce(type, raw) {
    if (raw == null || raw === '') return null;
    if (type === 'bool') {
      if (raw === 'true') return true;
      if (raw === 'false') return false;
      return null;
    }
    var n = Number(raw);
    return isFinite(n) ? n : null;
  }

  var bridge = {
    /** 前端键 -> 原生键（供诊断与测试读取，页面不应写死原生键）。 */
    map: SETTING_MAP,

    /** 同步读回八键；任一键缺失/非法即整体失败（不做半套 hydrate）。 */
    read: function () {
      var n = nativeBridge();
      if (!n) return { ok: false, code: 'BRIDGE_UNAVAILABLE' };
      var out = {};
      for (var k in SETTING_MAP) {
        if (!Object.prototype.hasOwnProperty.call(SETTING_MAP, k)) continue;
        var spec = SETTING_MAP[k], raw;
        try { raw = n.getSetting(spec.key); }
        catch (e) { return { ok: false, code: 'BRIDGE_UNAVAILABLE', detail: String(e) }; }
        var v = coerce(spec.type, raw);
        if (v === null) return { ok: false, code: 'INVALID_VALUE', detail: k };
        out[k] = v;
      }
      return { ok: true, data: out };
    },

    /** 逐键写入；以原生返回的 value 为准（days/hour 会回落合法值），ok:false 原样带回 code。 */
    write: function (frontKey, value) {
      var spec = SETTING_MAP[frontKey];
      if (!spec) return { ok: false, code: 'UNKNOWN_KEY' };
      var n = nativeBridge();
      if (!n) return { ok: false, code: 'BRIDGE_UNAVAILABLE' };
      var raw;
      try { raw = n.setSetting(spec.key, String(value)); }
      catch (e) { return { ok: false, code: 'BRIDGE_UNAVAILABLE', detail: String(e) }; }
      var r = null;
      try { r = raw ? JSON.parse(raw) : null; } catch (_) { r = null; }
      if (!r || typeof r !== 'object') return { ok: false, code: 'BAD_RESPONSE' };
      if (!r.ok) return { ok: false, code: r.code || 'WRITE_FAILED' };
      return { ok: true, value: coerce(spec.type, r.value == null ? '' : String(r.value)) };
    }
  };

  // 扩展点：Android 下提供八键桥；Win/mock 保持既有 null 契约。
  P.windowControl = null;   // 'win' 下由 shell 层实现（win_* 消息）
  P.settingsBridge = P.kind() === 'android' ? bridge : null;
  P.exportBridge = null;    // Android 导出走 PIQExport.save(name, b64, mime)
})();
