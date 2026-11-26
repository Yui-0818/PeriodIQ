/* ===== i18n.apply.js =====
 * 1 角色：i18n 统一应用层（applier）。静态 DOM 文案由 data-i18n（textContent）与 data-i18n-attr
 *   （"attr:key;attr2:key2"，可扩展属性名）声明，本文件统一应用；词典内置的受信富文本（<b> 等）
 *   用 data-i18n-html（innerHTML，只允许词典键值，绝不用于用户数据）；并在 'lang' 事件时同步
 *   <html lang> 后全量重放。页面动态文案由各页在各自的唯一 'lang' 监听里重绘
 *   （core.i18n.t()/plural()/date()）。
 * 2 依赖：js/core.js 顶层 const core；core.i18n（i18n.js，必须先于本文件加载）；词典三件套先于 i18n.js。
 * 3 暴露：core.i18n.applyDom(scope?)（scope 缺省 = document）；加载末尾同步一次 <html lang> 并应用
 *   全文档，然后注册全局唯一的 'lang' 监听。不挂 window。
 * 4 不变量：applyDom 只写 textContent / innerHTML（仅 data-i18n-html）/ 目标属性，不触发动画、
 *   不发请求；t() 未命中的键保持原状（不写 raw key 也绝不抛）；监听内先同步 <html lang> 再应用文案。
 */
(function () {
  var I = core.i18n;

  function applyAttr(el, spec) {
    var pairs = String(spec).split(';');
    for (var i = 0; i < pairs.length; i++) {
      var pair = pairs[i].trim();
      if (!pair) continue;
      var cut = pair.indexOf(':');
      if (cut < 1) continue;
      var attr = pair.slice(0, cut).trim();
      var key = pair.slice(cut + 1).trim();
      if (!attr || !key || !I.has(key)) continue;
      el.setAttribute(attr, I.t(key));
    }
  }

  I.applyDom = function (scope) {
    var root;
    try { root = scope && scope.querySelectorAll ? scope : document; } catch (_) { root = document; }
    var els, i;
    try { els = root.querySelectorAll('[data-i18n]'); } catch (_) { return; }
    for (i = 0; i < els.length; i++) {
      var key = els[i].getAttribute('data-i18n');
      if (key && I.has(key)) els[i].textContent = I.t(key);
    }
    try { els = root.querySelectorAll('[data-i18n-html]'); } catch (_) { return; }
    for (i = 0; i < els.length; i++) {
      var hkey = els[i].getAttribute('data-i18n-html');
      if (hkey && I.has(hkey)) els[i].innerHTML = I.t(hkey);
    }
    try { els = root.querySelectorAll('[data-i18n-attr]'); } catch (_) { return; }
    for (i = 0; i < els.length; i++) {
      var spec = els[i].getAttribute('data-i18n-attr');
      if (spec) applyAttr(els[i], spec);
    }
  };

  function syncHtmlLang() {
    try { document.documentElement.lang = I.locale(); } catch (_) {}
  }

  function boot() { syncHtmlLang(); I.applyDom(document); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
  try {
    core.on('lang', function () { syncHtmlLang(); I.applyDom(document); });
  } catch (_) {}
})();
