/* ===== i18n.js =====
 * 1 角色：i18n 面（P1-c 骨架）：语言判定与持久化、词典查找链、插值、日期/数字/复数格式化；本文件不内置任何 UI 文案。
 * 2 依赖：js/core.js 顶层 const core（必须在其后加载）；三份词典全局常量 js/i18n/zh-CN.js、en.js、es.js 须先于本文件加载；localStorage 与 document 仅在调用时读取。
 * 3 暴露：core.i18n（I 只在 IIFE 内），恰好 10 个成员 locale/setLocale/t/has/errorText/plural/date/number/SUPPORTED/STORAGE_KEY。不挂 window。
 * 4 不变量：加载期只做 core.i18n = I，零 DOM 读取、不注册事件、不发请求；locale() 每次调用重新读 localStorage 且读失败/值不在 SUPPORTED 内一律回落 zh-CN；setLocale 只接受精确 zh-CN|en|es，其它（含大小写不符、en-US）不抛、回落 zh-CN；t() 查找链 当前 locale → en → zh-CN → key，命中才做 {name} 插值、vars 缺名保留占位符；词典不在本文件复制/合并，一律运行期读全局常量并用 hasOwnProperty 守卫；<html lang> 只有 setLocale() 显式改写。
 * 5 契约来源：早期前端设计文档；既有 i18n 口径。
 * 6 禁止改动项：不得增删这 10 个成员；不得在词典里加 UI 文案键；不得改写 core.m.fmt（date() 沿用 Object.assign({timeZone:'UTC'}, opts||{}) 口径）；不得挂 window；不得在加载期读 DOM 或写 <html lang>；不得在本轮做页面文案外置或语言切换 UI（B1–B10）。
 *
 * 新建：P1-c
 */
(function () {
  var I = core.i18n = {};
  var SUPPORTED = ['zh-CN', 'en', 'es'];
  var STORAGE_KEY = 'menstrual_lang';
  var FALLBACK = 'zh-CN';

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

  I.locale = function () {
    var v = null;
    try { v = localStorage.getItem(STORAGE_KEY); } catch (_) { return FALLBACK; }
    return SUPPORTED.indexOf(v) >= 0 ? v : FALLBACK;
  };

  I.setLocale = function (code) {
    var final = SUPPORTED.indexOf(code) >= 0 ? code : FALLBACK;
    try {
      // 隐私模式 / 配额 / 存储禁用时写入会抛，持久化失败不得让调用方抛。
      localStorage.setItem(STORAGE_KEY, final);
    } catch (_) {}
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
    return I.t(base + '.' + new Intl.PluralRules(I.locale()).select(n));
  };

  I.date = function (dayNumber, opts) {
    return new Intl.DateTimeFormat(I.locale(), Object.assign({ timeZone: 'UTC' }, opts || {})).format(new Date(dayNumber * 864e5));
  };

  I.number = function (n, opts) {
    return new Intl.NumberFormat(I.locale(), opts).format(n);
  };

  I.SUPPORTED = SUPPORTED;
  I.STORAGE_KEY = STORAGE_KEY;
})();
