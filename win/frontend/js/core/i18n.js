/* ===== i18n.js =====
 * 1 角色：i18n 面：语言判定与持久化、词典查找链、插值、日期/数字/复数格式化；本文件不内置任何 UI 文案。
 *   迭代1（3.0.1）契约变更（经本轮授权，推翻 P1-c 的两条禁令并在 commit message 注明）：
 *   (a) 词典允许承载全量 UI 文案键（ui/dock/shell/auth/today/cal/hist/ins/journal/you/tra 域 + 既有 error.* / lang.*）；
 *   (b) 新增统一应用层 applier（js/core/i18n.apply.js），向 core.i18n 追加唯一的新成员 applyDom。
 *   迭代2（3.0.2）契约变更（F2：语言每次重启必丢）：
 *   (c) 持久层由「仅 localStorage（按 origin 隔离）」改为「cookie（按 host 隔离、跨端口共享）+ localStorage（当次会话快路径）」：
 *       读取链 cookie → localStorage → 系统默认链；**任一显式存储值非法（如 en-US）即回落系统默认链**（迭代1 既有口径，不得回归）；
 *       写入链仅 setLocale 命中合法值时写 cookie + localStorage 两处（**首次启动绝不写盘**，只有用户点选语言才写）；
 *       存储键名不变（localStorage 与 cookie 同为 menstrual_lang）；端口策略不变（仍取随机空闲端口）。
 *       浏览器 cookie 按 host 而非 port 隔离，故 127.0.0.1:<随机端口> 换端口后 cookie 仍在，语言不丢；
 *       既有口径全部保留：不 reload、不重播入场动画、不丢滚动/主题/提醒/当前页/打开的 sheet。
 * 2 依赖：js/core.js 顶层 const core（必须在其后加载）；三份词典全局常量 js/i18n/zh-CN.js、en.js、es.js 须先于本文件加载；localStorage、document.cookie 与 document 仅在调用时读取。
 * 3 暴露：core.i18n 本文件恰好 10 个成员 locale/setLocale/t/has/errorText/plural/date/number/SUPPORTED/STORAGE_KEY；运行期唯一允许的扩展是 i18n.apply.js 追加的 core.i18n.applyDom（静态 DOM 应用，含对 [data-i18n]/[data-i18n-attr] 的统一处理与唯一的全局 'lang' 监听）。不挂 window。
 * 4 不变量：加载期只做 core.i18n = I，零 DOM 读取、不注册事件、不发请求；
 *   locale() 每次调用重新读存储：cookie（按 host 隔离、跨端口共享）→ localStorage（按 origin 隔离）→ 系统默认链；
 *   两个存储中**任一显式值非法**（如 en-US）即回落系统默认链——依次扫描 navigator.languages（退化 navigator.language），
 *   首个 zh* → zh-CN、首个 es* → es、否则 en；该链只读、绝不写盘；
 *   setLocale 只对精确 zh-CN|en|es 持久化（写盘仅此一处，即用户显式点选语言：cookie + localStorage 两处同写）；
 *   其它输入（含大小写不符、en-US、空值）不抛、不写盘，按同一系统默认链解析生效语言，仍然同步 <html lang> 并 emit 'lang'；
 *   t() 查找链 当前 locale → en → zh-CN → key，命中才做 {name} 插值、vars 缺名保留占位符；词典不在本文件复制/合并，一律运行期读全局常量并用 hasOwnProperty 守卫；
 *   <html lang> 由 setLocale() 与应用层启动同步改写；boot/main.js 绝不写 menstrual_lang；
 *   plural(n,base) 只做复数档位选键（返回 base.<category>，不翻译不插值）；调用方 t(I.plural(n,base),{n}) 一步完成选档+翻译+插值；
 *   date() 恒用 'en' locale（迭代1 用户裁决：月份/星期名全语言英文显示，如 'Dec 11'、'November 2026'），
 *     保持 dayNumber+UTC 口径与 Object.assign({timeZone:'UTC'}, opts||{}) 合并逻辑不变；数字 I.number 仍随 locale。
 * 5 契约来源：早期前端设计文档；既有 i18n 口径；Win 全量零 bug 迭代轮迭代1（3.0.1）授权改写；迭代2（3.0.2）F2 语言持久层改写。
 * 6 禁止改动项：不得增删本文件这 10 个成员；不得在本文件内置 UI 文案；不得挂 window；不得在加载期读 DOM 或写 <html lang>；core.m.fmt 保持 en 口径（显示面一律经 date()/页面本地 dfmt 本地化，数据层格式不动）。
 *
 * 新建：P1-c；契约改写：迭代1（3.0.1）、迭代2（3.0.2）
 */
(function () {
  var I = core.i18n = {};
  var SUPPORTED = ['zh-CN', 'en', 'es'];
  var STORAGE_KEY = 'menstrual_lang';

  // 词典全局常量在调用时读取（缺失时返回 null，不抛）；本文件不复制、不合并任何词条。
  var dictFor = function (code) {
    if (code === 'zh-CN') return typeof I18N_ZH_CN !== 'undefined' ? I18N_ZH_CN : null;
    if (code === 'en') return typeof I18N_EN !== 'undefined' ? I18N_EN : null;
    if (code === 'es') return typeof I18N_ES !== 'undefined' ? I18N_ES : null;
    return null;
  };

  // 查找链：当前 locale → en → zh-CN；用 hasOwnProperty 防原型键。
  var hit = function (key) {
    var chain = [I.locale(), 'en', 'zh-CN'];
    for (var i = 0; i < chain.length; i++) {
      var d = dictFor(chain[i]);
      if (d && Object.prototype.hasOwnProperty.call(d, key)) return d[key];
    }
    return null;
  };

  // {name} 插值：vars 缺该名时保留占位符，不抛。
  var fill = function (s, vars) {
    if (!vars || typeof s !== 'string') return s;
    return s.replace(/\{([A-Za-z0-9_.-]+)\}/g, function (m, k) {
      return Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m;
    });
  };

  // 系统默认链：navigator.languages（退化 navigator.language）依次扫描，zh* → zh-CN、es* → es、否则 en。
  // 只读系统偏好，不写盘；存储缺失/非法时 locale() 与 setLocale() 都走这里。
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

  // 迭代2（3.0.2）F2：cookie 持久层。浏览器 cookie 按 host 而非 port 隔离，
  // 故 127.0.0.1:<随机端口> 每次启动换端口后 cookie 仍在（localStorage 按 origin 隔离，会跟着换桶丢）。
  // 键名与 localStorage 相同（menstrual_lang）；写盘只在 setLocale 命中合法值时发生。
  var COOKIE_MAX_AGE = 31536000; // 1 年：跨浏览器会话存活（WebView2 profile 落在数据目录，重启不丢）
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
    // 迭代2（3.0.2）F2：cookie 按 host 隔离（127.0.0.1:<随机端口> 换端口后仍在），localStorage 按 origin 隔离。
    // 读取链：cookie → localStorage → 系统默认链；任一显式存储值非法即回落系统默认链（迭代1 口径不得回归）。
    var ls = null, ck = null;
    try { ls = localStorage.getItem(STORAGE_KEY); } catch (_) { ls = null; }
    ck = readCookie();
    if (ls !== null && SUPPORTED.indexOf(ls) < 0) return defaultLocale();
    if (ck !== null && SUPPORTED.indexOf(ck) < 0) return defaultLocale();
    if (ck !== null) return ck;
    if (ls !== null) return ls;
    return defaultLocale();
  };

  I.setLocale = function (code) {
    var valid = SUPPORTED.indexOf(code) >= 0;
    var final = valid ? code : defaultLocale();
    if (valid) {
      try {
        // 隐私模式 / 配额 / 存储禁用时写入会抛，持久化失败不得让调用方抛。
        localStorage.setItem(STORAGE_KEY, final);
      } catch (_) {}
      writeCookie(final);
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

  // 复数键选择器：返回 base.<category> 原始键（不做翻译、不插值）。调用方一律
  // t(I.plural(n, base), { n: ... }) 一步完成「选档 + 翻译 + {n} 插值」。
  I.plural = function (n, base) {
    return base + '.' + new Intl.PluralRules(I.locale()).select(n);
  };

  I.date = function (dayNumber, opts) {
    // 迭代1（3.0.1）：月/星期名恒为英文（用户 2026-11-15 裁决）。dayNumber 与 UTC 口径不变。
    return new Intl.DateTimeFormat('en', Object.assign({ timeZone: 'UTC' }, opts || {})).format(new Date(dayNumber * 864e5));
  };

  I.number = function (n, opts) {
    return new Intl.NumberFormat(I.locale(), opts).format(n);
  };

  I.SUPPORTED = SUPPORTED;
  I.STORAGE_KEY = STORAGE_KEY;
})();
