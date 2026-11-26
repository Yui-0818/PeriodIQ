/* ===== desktop.js =====
 * 1 角色：Win WebView2 桌壳桥。宿主在导航完成后给 html/body 加 piq-shell；本文件只在此时
 *   把空 #app-titlebar 填成标题栏，绑定三个窗控按钮与拖拽消息，并同步页名。移动端/无 piq-shell 零作用。
 * 2 依赖：无 core/数据层；当前 DOM 的 #app-titlebar、#app、.page.cur、#pg-auth；宿主
 *   window.chrome.webview.postMessage(string)。CSS 由 css/shell.css 提供。
 * 3 暴露：无 window 全局；加载后自身观察 piq-shell/页面 class。
 * 4 不变量：只发 win_start_drag / win_minimize / win_toggle_max / win_close；不改 #app-titlebar
 *   之外结构、不碰页面 DOM、不写 storage、不发请求；无 piq-shell 不注入。
 * 5 契约来源：早期前端设计文档；Win/desktop/native_host.cs:739-740、1001-1020；
 *   B10 早期记录。
 * 6 禁止改动项：不改消息名/按钮 data-win；不接管页面导航；不隐藏/替换五页；不新增全局；
 *   不实现窗口几何/最大化状态（宿主负责）；不写 titlebar HTML 之外的页面内容。
 * 新建：B10（桥）。
 * ------------------------------------------------------------------ */
(function () {
  'use strict';
  var TITLE = { 'pg-today': 'Today', 'pg-cal': 'Calendar', 'pg-hist': 'History', 'pg-ins': 'Insights', 'pg-you': 'You', 'pg-journal': 'Journal' };
  var ready = false, bar = null, pageEl = null, authEl = null, moApp = null, moAuth = null;

  function post(cmd) {
    try {
      if (window.chrome && window.chrome.webview && typeof window.chrome.webview.postMessage === 'function') {
        window.chrome.webview.postMessage(cmd);
      }
    } catch (_) {}
  }

  function title() {
    if (!bar) return;
    var label = '';
    if (document.querySelector('#pg-auth.x-on')) label = 'Access';
    else {
      var cur = document.querySelector('.page.cur');
      label = cur && TITLE[cur.id] || 'PeriodIQ';
    }
    var p = bar.querySelector('#titlebar-page');
    if (p && p.textContent !== label) p.textContent = label;
  }

  function html() {
    bar.innerHTML =
      '<div class="titlebar-drag" data-win-drag>' +
        '<span class="titlebar-mark" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><path d="M12 2.5 14.2 9.8 21.5 12l-7.3 2.2L12 21.5 9.8 14.2 2.5 12l7.3-2.2Z" fill="currentColor"/></svg></span>' +
        '<b class="titlebar-product">PeriodIQ</b>' +
        '<span class="titlebar-sep" aria-hidden="true"></span>' +
        '<span class="titlebar-page" id="titlebar-page">Today</span>' +
      '</div>' +
      '<div class="titlebar-actions">' +
        '<button class="titlebar-btn" type="button" data-win="minimize" aria-label="Minimize" title="Minimize"><svg viewBox="0 0 24 24" focusable="false"><path d="M6 12h12"/></svg></button>' +
        '<button class="titlebar-btn" type="button" data-win="toggle" aria-label="Maximize" title="Maximize"><svg viewBox="0 0 24 24" focusable="false"><rect x="6.5" y="6.5" width="11" height="11" rx="1.2"/></svg></button>' +
        '<button class="titlebar-btn titlebar-close" type="button" data-win="close" aria-label="Close" title="Close"><svg viewBox="0 0 24 24" focusable="false"><path d="M7 7l10 10M17 7 7 17"/></svg></button>' +
      '</div>';
  }

  function bind() {
    var drag = bar.querySelector('.titlebar-drag');
    if (drag) {
      drag.addEventListener('mousedown', function (e) {
        if (e.button !== 0 || (e.target.closest && e.target.closest('button'))) return;
        e.preventDefault();
        try { window.getSelection().removeAllRanges(); } catch (_) {}
        post('win_start_drag');
      });
      drag.addEventListener('dblclick', function (e) {
        if (e.target.closest && e.target.closest('button')) return;
        e.preventDefault();
        post('win_toggle_max');
      });
    }
    bar.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('[data-win]');
      if (!b) return;
      var k = b.getAttribute('data-win');
      if (k === 'minimize') post('win_minimize');
      else if (k === 'toggle') post('win_toggle_max');
      else if (k === 'close') post('win_close');
    });
  }

  function enable() {
    if (ready || !document.body.classList.contains('piq-shell')) return;
    bar = document.getElementById('app-titlebar');
    if (!bar) return;
    ready = true;
    if (!bar.children.length) html();
    bar.setAttribute('aria-hidden', 'false');
    bind();
    var app = document.getElementById('app');
    if (app) {
      moApp = new MutationObserver(title);
      moApp.observe(app, { subtree: true, attributes: true, attributeFilter: ['class'] });
    }
    authEl = document.getElementById('pg-auth');
    if (authEl) {
      moAuth = new MutationObserver(title);
      moAuth.observe(authEl, { attributes: true, attributeFilter: ['class'] });
    }
    title();
  }

  function check() { if (document.body.classList.contains('piq-shell')) enable(); }

  check();
  new MutationObserver(check).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  new MutationObserver(check).observe(document.body, { attributes: true, attributeFilter: ['class'] });
})();
