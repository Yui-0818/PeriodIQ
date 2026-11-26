/* ===== platform.js =====
 * 1 角色：平台能力探测面（P1-b3 预留锚点）：只判定运行端与桥是否存在，不实现任何桥功能。
 * 2 依赖：js/core.js 顶层 const core（本文件必须在其后、errors.js 前加载）；document/window 仅在调用时读取。
 * 3 暴露：core.platform（P 只在 IIFE 内）；成员 kind/hasNativeBridge/hasExportBridge/hasShellBridge + 三个扩展点 windowControl/settingsBridge/exportBridge（本轮恒 null）。不挂 window。
 * 4 不变量：除把 P 挂到 core.platform 外，加载期零副作用（不写 DOM、不注册事件、不发请求）；四个探测每次调用重新求值、不缓存；扩展点恒 null，本文件不实现窗控/设置/导出。
 * 5 契约来源：早期前端设计文档；宿主事实 Win\desktop\native_host.cs:301、739–740、1001–1020，Android PiqInsets.kt / AndroidGate.kt / PiqExport.kt（本轮只预留探测面，不接消息、insets 或导出）。
 * 6 禁止改动项：不得用探测结果改变页面行为；不得注册事件/写 DOM/发请求；不得缓存探测结果；不得实现窗控/设置/导出；不得挂 window；不得改 kind() 的判定顺序（piq-android → chrome.webview → web）。
 *
 * 新建：P1-b3（无 demo 前身；P2/B10 才接线）。
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

  // 扩展点占位：P2/B10 接入，当前一律不实现
  P.windowControl = null;   // 'win' 下由 shell 层实现（win_* 消息）
  P.settingsBridge = null;  // Android 8 个提醒键走原生设置桥
  P.exportBridge = null;    // Android 导出走 PIQExport.save(name, b64, mime)
})();
