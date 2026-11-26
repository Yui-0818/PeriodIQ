/* ===== transport.js =====
 * 1 角色：api 对象骨架、模式判定、错误的安全包装、token 存取、fetch/PIQNative 两种传输。
 * 2 依赖：core（core.api/core.errors，errors.js 需先加载）；guard401 由 api.auth.js 提供，仅运行时调用。
 * 3 暴露：A,E,BASE,TOKEN_KEY,pickMode,safe,token,setToken,clearToken,isAndroid,nativeBridge,fullPath,fromEnvelope,httpRequest,nativeRequest,request（顶层，不挂 window）。
 * 4 不变量：写操作永不 reject（同步抛错也转 Promise）；Bearer 只经 token()；PIQNative 每请求检查不缓存；BASE=/api/v1 唯一。
 * 5 契约来源：原 api.js 1–75 行契约头（紧随本模块头原样保留）；73–74 行传输条款。
 * 6 禁止改动项：请求路径/方法、BASE、TOKEN_KEY、'Bearer 、超时/重试、错误码、envelope 判定。
 */
/* PeriodIQ data layer (classic script; attaches to the existing core.api object).
 *
 * Method contract
 * - Async writes (always return a Promise, never reject):
 *   putDaily(dayNumber, body) -> {ok:true,status:200,data:DailyRecordOut}
 *   export()                  -> {ok:true,status:200,data:ExportResponse}
 *   import(payload, opts)     -> {ok:true,status:200,data:ImportResponse}
 *   cycles.create(body) / cycles.update(id, body) / cycles.remove(id)
 *                             -> real only (mock keeps its sync provider methods): never reject,
 *                                never touch CYC and never commit (core.edit owns the post-write
 *                                hydrate + the single commit). Success shapes match the mock:
 *                                create/update {ok:true,status,id,period_start,period_end},
 *                                remove {ok:true,status,deleted:true,id} (an empty/absent DELETE
 *                                body is accepted; a missing id falls back to the request id).
 *                                An unusable create/update 2xx body, or a non-object remove body,
 *                                is BAD_RESPONSE; failures pass through unchanged.
 *   journal.put(dayNumber,note) -> {ok:true,status:200,data:JournalOut} / {ok:false,...}
 *                                never rejects; note null/undefined -> '' ('' = delete). A valid
 *                                JournalOut mirrors into the journal store and commits 'api'
 *                                exactly once; a malformed 2xx -> BAD_RESPONSE (no store change,
 *                                no commit); any failure changes nothing. The data layer
 *                                deliberately does NOT pre-block past days: the page decides
 *                                whether to call, the server/mock answers 400 JOURNAL_READONLY for
 *                                a past date (mock: same contract).
 *   health()                  -> real: {ok:true,status:200,data:{status,version}}
 *                                mock: {ok:false,status:501,code:'NOT_WIRED',message:<中文>}
 *   hydrate()                 -> mock: {ok:true,status:200,data:{mock:true}} (no request, no commit)
 *                                real: GET /cycles + /daily-records?from&to
 *                                + /daily-journal?from&to + /predictions/current
 *                                + /analysis/fertile-window, applied in ONE core._data.applyHydrate
 *                                (cycles/daily/predictions are all-or-nothing: a failed hydration
 *                                applies none of them). The journal range is a SEPARATE optional
 *                                channel requested after /daily-records succeeds and before
 *                                /predictions/current: failure, a non-array or a mapping error stores
 *                                journal [] and appends to A._hydrateNote, but never fails hydrate.
 *                                A._version comes from /health (non-fatal); A._hydrateNote records
 *                                range retries.
 * - Real sync reads mirror the hydrated model: getDaily() = null when the day has no row (never a
 *   default row), predictions() = empty shape until hydrate lands, gate(n) is pure local (no request).
 *   journal.get(n) -> {id,note,has} (sync, no request); journal.range(fromN,toN) -> [{n,id,note}]
 *   DESC, only days that have a note; isPeriodDay(n) -> bool derived from the hydrated cycles
 *   (sync, no request, no DB).
 * - moodTags: list() -> {mood:[...],body:[...]} fresh copies; validate(ids) -> {ok} /
 *   {ok:false,message}; limit = max tags per day (contract: Win\backend\app\config.py).
 * - Real putDaily mirrors the PUT response into DAILY and commits 'cal' once; real import hydrates
 *   and then commits 'api' once (even when that hydration fails). Mock keeps its old behavior.
 * - Auth: auth.state() is the ONLY sync auth read. Every auth WRITE returns a Promise and never
 *   rejects: login/register hydrate through the public hydrate() and commit 'api' exactly once
 *   (hydrate failure/superseded still resolves success with `stale:true` + A._hydrateNote).
 *   Those results may also carry `sessionCleared:true` when the post-login hydrate 401 already
 *   signed out (the returned token is dead): ok/data stay, but B9 MUST check auth.state().authed
 *   before navigating. relogin never hydrates or commits. Successful login/register/relogin report
 *   {ok:true,status,data:{token,user}}, me/profile report {ok:true,status,data:user}, and the
 *   remaining writes pass the server success body through. The token is read/written only here
 *   (localStorage 'menstrual_auth_token'); no page stores or logs it.
 * - A 401 response clears the local session exactly once (signOut: token/AUTH/stores/profile +
 *   commit 'api' + 'profile' when a nickname was displayed + 'auth' event), and only when the token
 *   captured by that request is still the current one, so an old in-flight 401 never wipes a
 *   re-login; credential/slot attempts (/auth/login, /auth/register, /auth/relogin) are exempt.
 *   During the startup bootstrap window EVERY non-exempt 401 clears silently (no commit/emit; main
 *   owns the single startup commit), and signOut bumps HYDRATE_SEQ so an in-flight hydrate can
 *   never apply after it.
 * - Sync reads / preserved sync calls: cycles.list(), getDaily(n), predictions(),
 *   gate(n), settings(), scenario(...), auth.state().
 * - Failure shape: {ok:false,status,code,message[,field|anomalies]}. `message` is the only text
 *   pages render: the code -> user-facing table lives in js/core/errors.js (out.detail keeps the
 *   raw backend detail; DATA_ANOMALY carries `anomalies` and no `total`).
 * - Import body: built by js/pages/you.js per D4 — it always carries cycles / predictions /
 *   daily_records (missing in the file -> []); this layer only adds allow_anomalies and
 *   transmits the payload unchanged.
 * - Mode: file:// or ?mock=1 -> mock provider from js/core/mock.js; http(s) -> real.
 *   Real mode never falls back to mock; unwired operations return status 501 NOT_WIRED.
 * - Real transport: fetch('/api/v1'+path) + Bearer token, or window.PIQNative.request
 *   (3 args) when present. PIQNative is checked per request, never cached at load.
 */
  const A = core.api;
  const E = core.errors;
  const BASE = '/api/v1';
  const TOKEN_KEY = 'menstrual_auth_token';
  const pickMode = function pickMode() {
    if (location.protocol === 'file:') return 'mock';
    if (new URLSearchParams(location.search).get('mock') === '1') return 'mock';
    return 'real';
  };
  const safe = function safe(fn) {
    try {
      return Promise.resolve(fn());
    } catch (e) {
      return Promise.resolve(E.internal(e && e.message ? e.message : String(e)));
    }
  };
  const token = function token() {
    try { return localStorage.getItem(TOKEN_KEY) || ''; }
    catch (_) { return ''; }
  };
  const setToken = function setToken(t) {
    try { localStorage.setItem(TOKEN_KEY, t); return true; }
    catch (_) { return false; }
  };
  const clearToken = function clearToken() {
    try { localStorage.removeItem(TOKEN_KEY); }
    catch (_) { /* storage unavailable: the in-memory state is still cleared below */ }
  };
  const isAndroid = function isAndroid() {
    return !!(document.documentElement && document.documentElement.classList.contains('piq-android'));
  };

  const nativeBridge = function nativeBridge() {
    var n = window.PIQNative;
    return n && typeof n.request === 'function' ? n : null;
  };

  const fullPath = function fullPath(path) {
    return path.indexOf(BASE + '/') === 0 ? path : BASE + path;
  };

  const fromEnvelope = function fromEnvelope(status, json) {
    if (status >= 200 && status < 300) return E.success(status, json);
    return E.fromHttp(status, json);
  };

  const httpRequest = function httpRequest(method, path, payload) {
    var headers = { Accept: 'application/json' };
    if (payload != null) headers['Content-Type'] = 'application/json';
    var t = token();
    if (t) headers.Authorization = 'Bearer ' + t;
    try {
      return fetch(fullPath(path), {
        method: method,
        headers: headers,
        body: payload == null ? undefined : payload
      }).then(function (res) {
        return res.text().then(function (txt) {
          var json = null;
          if (txt) {
            try { json = JSON.parse(txt); }
            catch (_) {
              if (res.ok) return E.badResponse(res.status);
            }
          }
          var out = res.ok ? E.success(res.status, json) : E.fromHttp(res.status, json);
          return guard401(path, t, out);
        });
      }).catch(function () {
        return E.network();
      });
    } catch (e) {
      // fetch itself can throw synchronously (bad URL, patched fetch, sandbox):
      // the async contract still requires a resolved failure, never a throw.
      return Promise.resolve(E.network());
    }
  };

  const nativeRequest = function nativeRequest(method, path, payload) {
    var bridge = nativeBridge();
    if (!bridge) return Promise.resolve(E.bridgeUnavailable());
    // Android injects its own bearer; the local token is only used to decide whether a 401 may
    // clear this session. Capture the exact value before the bridge call, not after the response:
    // guard401 compares it with the token that is current when the response arrives.
    var sentToken = token();
    return new Promise(function (resolve) {
      try {
        var raw = bridge.request(method, fullPath(path), payload);
        var env = JSON.parse(raw);
        if (!env || typeof env.status !== 'number') {
          resolve(E.badResponse(0));
          return;
        }
        // A 2xx envelope without a parsed body is not a success (e.g. {status:200}).
        if (env.status >= 200 && env.status < 300 && !('json' in env)) {
          resolve(E.badResponse(env.status));
          return;
        }
        resolve(guard401(path, sentToken, fromEnvelope(env.status, env.json)));
      } catch (e) {
        resolve(E.network('本机桥调用失败：' + (e && e.message ? e.message : String(e))));
      }
    });
  };

  const request = function request(method, path, body) {
    var payload;
    try {
      payload = body == null ? null : JSON.stringify(body);
    } catch (e) {
      return Promise.resolve(E.internal(e && e.message ? e.message : String(e)));
    }
    var bridge = nativeBridge();
    if (bridge) return nativeRequest(method, path, payload);
    if (isAndroid()) return Promise.resolve(E.bridgeUnavailable());
    return httpRequest(method, path, payload);
  };
