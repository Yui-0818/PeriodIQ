/* ===== api.auth.js =====
 * 1 角色：会话状态机：AUTH/BOOTSTRAP、昵称映射、signOut、401 守卫、bootstrap 标记。
 * 2 依赖：transport.js（A/E/token/clearToken）、state.js（core.profile/core._data/core.emit/core.commit）；HYDRATE_SEQ 来自 hydrate.js（仅运行时）。
 * 3 暴露：AUTH,BOOTSTRAP,authName,applyAuthUser,signOut,authAttemptPath,guard401（顶层，不挂 window）。
 * 4 不变量：401 只清一次会话且仅在请求 token 仍是当前 token 时；bootstrap 窗口内静默清空（无 commit/emit）；credential/slot 路径豁免；signOut 递增 HYDRATE_SEQ。
 * 5 契约来源：契约头 Auth 条款（原 api.js 47–62 行）；数据层契约见本文件 data-layer 注释。
 * 6 禁止改动项：三条豁免路径字符串、清空顺序、commit/emit 次数与条件、错误文案。
 */
  // Auth state is private: pages read the snapshot through auth.state(). The token is only returned
  // by the login/register/relogin results (B9 contract) and never enters state(), logs or error text.
  const AUTH = { authed: false, persistent: false, user: null };
  // True only for the bootstrap() window. Every non-exempt 401 there clears locally without
  // commit/emit because no page data is loaded yet and main owns the single startup commit.
  let BOOTSTRAP = false;
  const authName = function authName(user) {
    if (!user || typeof user !== 'object') return '';
    if (typeof user.nickname === 'string' && user.nickname) return user.nickname;
    return typeof user.username === 'string' ? user.username : '';
  };

  // Mirror a server AuthUserResponse into the shared profile name. `alwaysProfile` is used by
  // profile() (the page consumed the mapping event for that save); me/login/relogin only emit when
  // the displayed name actually changes.
  const applyAuthUser = function applyAuthUser(user, alwaysProfile) {
    var next = authName(user);
    var changed = core.profile.name !== next;
    AUTH.user = user || null;
    AUTH.authed = !!user;
    core.profile.name = next;
    if (alwaysProfile || changed) core.emit('profile');
  };

  // The single local-session cleanup entry. Default calls commit 'api' once and emit 'auth' once.
  // Bootstrap may call it with {silent:true}: token/AUTH/stores/profile are still cleared, but
  // commit/emit are suppressed because no page data or auth listener exists yet and main owns the
  // one startup commit. `keepToken` is only for a non-401 /auth/me failure (do not clear a token
  // we could not validate); `force` lets bootstrap clear empty-but-stale stores idempotently.
  const signOut = function signOut(opts) {
    var opt = opts || {};
    if (!token() && !AUTH.authed && !opt.force) return false;
    var hadName = !!core.profile.name;
    // Any hydration still in flight must not apply after a logout: bumping the sequence makes
    // realHydrate's final seq check fail, so a sign-out can never be overwritten by stale data.
    HYDRATE_SEQ++;
    if (!opt.keepToken) clearToken();
    AUTH.authed = false;
    AUTH.persistent = false;
    AUTH.user = null;
    try {
      core._data.applyHydrate({ cycles: [], daily: [], journal: [], predictions: null });
    } catch (_) { /* the stores are best-effort here; auth must still be cleared */ }
    core.profile.name = '';
    if (!opt.silent) {
      core.commit('api');
      // Today's header subtitle listens to 'profile', not 'auth': clearing the nickname must be
      // broadcast as a profile change too, or the old name stays on screen after a session wipe.
      if (hadName) core.emit('profile');
      core.emit('auth', A.auth.state());
    }
    return true;
  };

  const authAttemptPath = function authAttemptPath(path) {
    var p = String(path || '').split('?')[0];
    return p === '/auth/login' || p === '/auth/register' || p === '/auth/relogin';
  };

  // 401 hook shared by both transports. It only fires when THIS request captured a token before
  // dispatch AND that exact token is still the current one: an old in-flight 401 must never clear a
  // session that was already replaced (re-login) or cleared (the idempotent guard handles that).
  // Credential/slot attempts are exempt so a wrong password or an empty relogin slot never wipes an
  // otherwise valid local session. During the bootstrap window EVERY non-exempt startup 401 is
  // silent: no page data or auth listener exists yet and main.js owns the single startup commit, so
  // a /auth/persistence 401 must not commit/emit on its own either.
  const guard401 = function guard401(path, sentToken, result) {
    if (sentToken && sentToken === token() && result && result.status === 401 && !authAttemptPath(path)) {
      if (BOOTSTRAP) signOut({ silent: true });
      else signOut();
    }
    return result;
  };
