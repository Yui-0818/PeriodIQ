/* ===== api.mock.js =====
 * 1 角色：mock provider 安装：把 core._providers.mock 的同步实现包装成与 real 同形的异步写面。
 * 2 依赖：mock.js（core._providers.mock 已安装）、transport.js（A/E/safe）、state.js（core.emit）；file:// 或 ?mock=1 时由 api.surface.js 调用。
 * 3 暴露：installMock（顶层，不挂 window）。
 * 4 不变量：被安装成员集合与顺序不变；mwrite 对成功结果只调用一次 after；mock hydrate/health 不发请求、不 commit。
 * 5 契约来源：契约头 mock 条款（原 api.js 26–27、71–72 行）+ mock.js 契约。
 * 6 禁止改动项：安装成员、notWired 文案、Promise 时机、after 钩子、A.hydrate 的 mock 返回形状。
 */
  const installMock = function installMock() {
    var P = core._providers.mock;
    P.installHooks();
    A.predictions = P.predictions;
    A.scenario = P.scenario;
    A.validateDaily = P.validateDaily;
    A.gate = P.gate;
    A.getDaily = P.getDaily;
    A.exportDaily = P.exportDaily;
    A.cycles = P.cycles;
    A.settings = P.settings;
    // Mock keeps the demo provider effects (demo1234 / fake persistent switch / wipe reseeds), but
    // exposes the same async write surface as real auth. Promise just defers resolution; it does not
    // change what the provider does or when its synchronous side effects run.
    var MP = P.auth;
    function mwrite(fn, after) {
      return function () {
        var args = arguments;
        return safe(function () { return fn.apply(MP, args); }).then(function (r) {
          if (r && r.ok && after) {
            try { after(r); } catch (_) { /* event hooks never turn a successful write into a failure */ }
          }
          return r;
        }).catch(function (e) { return E.internal(e && e.message ? e.message : String(e)); });
      };
    }
    A.auth = {
      state: function () {
        var s = MP.state();
        return { authed: true, persistent: !!s.persistent, user: null, demo_password: s.demo_password || '' };
      },
      profile: mwrite(MP.profile, function () { core.emit('profile'); }),
      persistence: mwrite(MP.persistence),
      clearPersistence: mwrite(MP.clearPersistence),
      changePassword: mwrite(MP.changePassword),
      logout: mwrite(MP.logout),
      deleteAccount: mwrite(MP.deleteAccount),
      login: function () { return Promise.resolve(E.notWired('登录（演示模式）')); },
      register: function () { return Promise.resolve(E.notWired('注册（演示模式）')); },
      relogin: function () { return Promise.resolve(E.notWired('恢复登录（演示模式）')); },
      me: function () { return Promise.resolve(E.notWired('用户资料（演示模式）')); },
      bootstrap: function () { return Promise.resolve(E.success(200, { authed: true })); }
    };
    A.putDaily = function (n, b) { return safe(function () { return P.putDailySync(n, b); }); };
    A.export = function () { return safe(function () { return P.exportSync(); }); };
    A.import = function (payload, opts) { return safe(function () { return P.importSync(payload, opts); }); };
    A.health = function () { return Promise.resolve(E.notWired('健康检查（演示模式无后端）')); };
    // Mock hydration is a no-op: no request, no data change, no commit (main.js must not dirty pages).
    A.hydrate = function () { return Promise.resolve(E.success(200, { mock: true })); };
  };
