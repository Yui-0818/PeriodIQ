/* ===== i18n.js =====
 * 1 角色：i18n 面：语言判定与持久化、词典查找链、插值、日期/数字/复数格式化；本文件不内置任何 UI 文案。
 * 2 依赖：js/core.js 顶层 const core（必须在其后加载）；三份词典全局常量 js/i18n/zh-CN.js、en.js、es.js 须先于本文件加载；localStorage、document.cookie 与 document 仅在调用时读取。
 * 3 暴露：core.i18n 10 个成员 locale/setLocale/t/has/errorText/plural/date/number/SUPPORTED/STORAGE_KEY；运行期唯一允许的扩展是 i18n.apply.js 追加的 core.i18n.applyDom。不挂 window。
 * 4 不变量：加载期只做 core.i18n = I，零 DOM 读取、不注册事件、不发请求；
 *   locale() 每次调用重新读存储：cookie → localStorage → window.__piqLang（Android 宿主注入）→ 系统默认链；
 *   任一显式存储值非法（如 en-US）即回落系统默认链（只读、绝不写盘）；
 *   setLocale 只对精确 zh-CN|en|es 持久化（cookie + localStorage + Android 原生桥 PIQNative.setLang）；
 *   t() 查找链 当前 locale → en → zh-CN → key，命中才做 {name} 插值；
 *   plural(n,base) 只做复数档位选键（返回 base.<category>）；
 *   date() 恒用 'en' locale（D9 裁决：月份/星期名全语言英文显示），保持 dayNumber+UTC 口径不变；数字 I.number 随 locale。
 */
(function () {
  var I = core.i18n = {};
  var SUPPORTED = ['zh-CN', 'en', 'es'];
  var STORAGE_KEY = 'menstrual_lang';

  var dictFor = function (code) {
    if (code === 'zh-CN') return typeof I18N_ZH_CN !== 'undefined' ? I18N_ZH_CN : null;
    if (code === 'en') return typeof I18N_EN !== 'undefined' ? I18N_EN : null;
    if (code === 'es') return typeof I18N_ES !== 'undefined' ? I18N_ES : null;
    return null;
  };

  var hit = function (key) {
    var chain = [I.locale(), 'en', 'zh-CN'];
    for (var i = 0; i < chain.length; i++) {
      var d = dictFor(chain[i]);
      if (d && Object.prototype.hasOwnProperty.call(d, key)) return d[key];
    }
    return null;
  };

  var fill = function (s, vars) {
    if (!vars || typeof s !== 'string') return s;
    return s.replace(/\{([A-Za-z0-9_.-]+)\}/g, function (m, k) {
      return Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m;
    });
  };

  var defaultLocale = function () {
    var langs = [];
    try {
      if (navigator.languages && navigator.languages.length) langs = navigator.languages;
      else if (navigator.language) langs = [navigator.language];
    } catch (_) {}
    for (var i = 0; i < langs.length; i++) {
      var l = String(langs[i] || '').toLowerCase();
      if (l.indexOf('zh') === 0) return 'zh-CN';
      if (l.indexOf('es') === 0) return 'es';
    }
    return 'en';
  };

  var COOKIE_MAX_AGE = 31536000;
  var readCookie = function () {
    try {
      var all = document.cookie || '';
      var parts = all.split(';');
      for (var i = 0; i < parts.length; i++) {
        var p = parts[i].trim();
        var cut = p.indexOf('=');
        if (cut < 1) continue;
        if (p.slice(0, cut) !== STORAGE_KEY) continue;
        var raw = p.slice(cut + 1);
        try { return decodeURIComponent(raw); } catch (_) { return raw; }
      }
    } catch (_) {}
    return null;
  };
  var writeCookie = function (value) {
    try {
      document.cookie = STORAGE_KEY + '=' + encodeURIComponent(value) +
        '; path=/; max-age=' + COOKIE_MAX_AGE + '; SameSite=Lax';
    } catch (_) {}
  };

  I.locale = function () {
    var ls = null, ck = null, nat = null;
    try { ls = localStorage.getItem(STORAGE_KEY); } catch (_) { ls = null; }
    ck = readCookie();
    try { if (typeof window.__piqLang === 'string' && window.__piqLang) nat = window.__piqLang; } catch (_) {}
    if (ls !== null && SUPPORTED.indexOf(ls) < 0) return defaultLocale();
    if (ck !== null && SUPPORTED.indexOf(ck) < 0) return defaultLocale();
    if (nat !== null && SUPPORTED.indexOf(nat) < 0) nat = null;
    if (ck !== null) return ck;
    if (ls !== null) return ls;
    if (nat !== null) return nat;
    return defaultLocale();
  };

  I.setLocale = function (code) {
    var valid = SUPPORTED.indexOf(code) >= 0;
    var final = valid ? code : defaultLocale();
    if (valid) {
      try { localStorage.setItem(STORAGE_KEY, final); } catch (_) {}
      writeCookie(final);
      try { window.__piqLang = final; } catch (_) {}
      try {
        if (window.PIQNative && typeof window.PIQNative.setLang === 'function') {
          window.PIQNative.setLang(final);
        }
      } catch (_) {}
    }
    document.documentElement.lang = final;
    core.emit('lang', { locale: final });
    return final;
  };

  I.t = function (key, vars) {
    if (typeof key !== 'string') return key;
    var s = hit(key);
    return s === null ? key : fill(s, vars);
  };

  I.has = function (key) {
    if (typeof key !== 'string') return false;
    return hit(key) !== null;
  };

  I.errorText = function (code) {
    if (typeof code !== 'string' || !code) return null;
    var key = 'error.' + code;
    var s = I.t(key);
    return s === key ? null : s;
  };

  I.plural = function (n, base) {
    return base + '.' + new Intl.PluralRules(I.locale()).select(n);
  };

  I.date = function (dayNumber, opts) {
    return new Intl.DateTimeFormat('en', Object.assign({ timeZone: 'UTC' }, opts || {})).format(new Date(dayNumber * 864e5));
  };

  I.number = function (n, opts) {
    return new Intl.NumberFormat(I.locale(), opts).format(n);
  };

  I.SUPPORTED = SUPPORTED;
  I.STORAGE_KEY = STORAGE_KEY;
})();
