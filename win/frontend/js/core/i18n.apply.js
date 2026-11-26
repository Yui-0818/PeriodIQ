/* ===== i18n.apply.js =====
 * 1 角色：i18n 统一应用层（applier）。静态 DOM 文案由 data-i18n（textContent）与 data-i18n-attr
 *   （"attr:key;attr2:key2"，可扩展属性名）声明，本文件统一应用；词典内置的受信富文本（<b> 等）
 *   用 data-i18n-html（innerHTML，只允许词典键值，绝不用于用户数据）；并在 'lang' 事件时同步
 *   <html lang> 后全量重放。页面动态文案由各页在各自的唯一 'lang' 监听里重绘
 *   （core.i18n.t()/plural()/date()）。
 *   迭代1（3.0.1）契约：本文件是对 core.i18n 的唯一运行期扩展（仅追加 applyDom），静态与动态两条路径
 *   之外不得再有散落的逐键硬编码；lang 驱动的文本更新一律直接赋值（textContent/innerHTML/setAttribute），
 *   不走 flick()/roll() 等进入动画，不 reload、不重播页面动画。
 * 2 依赖：js/core.js 顶层 const core；core.i18n（i18n.js，必须先于本文件加载）；词典三件套先于 i18n.js。
 * 3 暴露：core.i18n.applyDom(scope?)（scope 缺省 = document）；加载末尾同步一次 <html lang> 并应用
 *   全文档，然后注册全局唯一的 'lang' 监听（每个页面至多再各挂一个）。不挂 window。
 * 4 不变量：applyDom 只写 textContent / innerHTML（仅 data-i18n-html）/ 目标属性，不触发动画、
 *   不发请求；t() 未命中的键保持原状（不写 raw key 也绝不抛）；监听内先同步 <html lang> 再应用文案。
 * 5 契约来源：Win 全量零 bug 迭代轮迭代1（3.0.1）授权新增；P1-c 的「不得加应用层」禁令由本轮推翻。
 * 6 禁止改动项：不得在此内置任何 UI 文案键；不得挂 window；不得新增第二个全局 'lang' 监听；
 *   data-i18n-html 是词典受信富文本的唯一通道（值全部来自随包词典，非用户数据）。
 *
 * 新建：迭代1（3.0.1）
 */
(function () {
  var I = core.i18n;

  // data-i18n-attr="aria-label:key;placeholder:key2;title:key3" —— 属性名可扩展。
  // 三条通道一律先 I.has(key) 守卫：键未命中保持元素原状（不把 raw key 写进 DOM），也绝不抛。
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

  // 同步 <html lang> 为当前生效语言（boot 绝不写 menstrual_lang；这里也只读）。
  function syncHtmlLang() {
    try { document.documentElement.lang = I.locale(); } catch (_) {}
  }

  // 启动：先把 <html lang> 同步为生效语言，再应用全文档静态文案。本文件在 body 中段加载，
  // 首次应用必须等到 DOM 就绪（覆盖其后的静态节点）；index.html <head> 的内联脚本已在更早
  // 时机同步过 <html lang>（先于可见 UI），这里兜底并完成词典文本的应用。
  function boot() { syncHtmlLang(); I.applyDom(document); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
  try {
    core.on('lang', function () { syncHtmlLang(); I.applyDom(document); });
  } catch (_) {}
})();
