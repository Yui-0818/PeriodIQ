/* ===== api.domain.js =====
 * 1 角色：真实 provider 的写面与安装：cycles CRUD、putDaily、settings、export/import、auth 各写操作、putDaily/import 的镜像与 commit。
 * 2 依赖：transport.js、state.js、api.auth.js（signOut/applyAuthUser）、hydrate.js（realHydrate，安装时已定义）、api.surface.js（emptyPredictions，仅 installReal() 末尾调用时）、mock.js（仅经 core 引用）。
 * 3 暴露：REAL_SETTINGS,dailyBody,normalizeImport,installReal（顶层，不挂 window）。
 * 4 不变量：本层不写 CYC、不 commit（core.edit 负责）；成功形状与 mock 对齐；失败原样透传；import 后必 commit 一次（即使 hydrate 失败）。
 * 5 契约来源：契约头 cycles/putDaily/import/auth 条款；数据层契约（原 api.js 585–586 行注释随段保留）。
 * 6 禁止改动项：请求方法/路径、状态码与错误码、REAL_SETTINGS 默认值、dailyBody 形状、各种长度/上限判断、commit 次数。
 *
 * 设备设置（`/device/settings`）：GET 不在这里发——Win 由 hydrate.js 在启动时拉取并写进
 * `A._settings`（失败只记 note，默认值兜底）；Android 不发 HTTP，而是每次读取时从原生
 * `core.platform.settingsBridge`（HostSettingsBridge 的八条提醒键）同步 hydrate。
 * 写面分平台：Win real 的 `A.settings(patch)` 发 `PUT /device/settings`，成功后就响应里已知的
 * 8 键合并回 `A._settings` 并返回完整副本；Android 逐键调用原生桥，以原生返回的 `value`
 * 为准更新 `A._settings`，任一键失败即回 ok:false（页面负责把错误显示在可见位置）。
 * 读面恒为同步（`A.settings()` 无参返回缓存），页面 `you.settings.js` 依赖这一同步形态。
 */
  // Defaults mirror Win/backend /device/settings and mock SDEF. They are the fallback for the
  // readable cache (A._settings): on Win, hydrate.js overwrites it with the real GET /device/settings.
  const REAL_SETTINGS = {
    reminder_master: false,
    reminder_advance: false,
    reminder_on_day: false,
    reminder_overdue: false,
    reminder_days: 3,
    reminder_trio_hour: 9,
    reminder_fill_hour: 21,
    reminder_daily_fill: false
  };
  const dailyBody = function dailyBody(body) {
    var b = body && typeof body === 'object' ? body : {};
    return {
      pain_present: !!b.pain_present,
      pain_level: b.pain_present ? b.pain_level : null,
      flow_level: b.flow_level,
      mood_level: b.mood_level,
      mood_tags: Array.isArray(b.mood_tags) ? b.mood_tags : []
    };
  };

  const normalizeImport = function normalizeImport(payload) {
    if (typeof payload === 'string') {
      if (!payload.trim()) return { ok: false, error: E.invalidImport('The file is empty.') };
      var parsed;
      try { parsed = JSON.parse(payload); }
      catch (_) { return { ok: false, error: E.invalidImport('The file is not valid JSON.') }; }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, error: E.invalidImport('The file is not a PeriodIQ export.') };
      }
      return { ok: true, value: parsed };
    }
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      return { ok: true, value: payload };
    }
    return { ok: false, error: E.invalidImport('The file is not a PeriodIQ export.') };
  };
  const installReal = function installReal() {
    A.predictions = function () { return core._data.predictions() || emptyPredictions(); };
    A.getDaily = function (n) { var g = core.m.DAILY[n]; return g ? Object.assign({}, g) : null; };
    A.validateDaily = function () { return E.notWired('Daily detail validation'); };
    // Pure local gate mirroring PUT /daily-records (DailyPutGate): not after today, inside the
    // today+yesterday backfill window, AND covered by a period. The server stays the authority;
    // this only decides which controls the panel may enable (journal has its own today-only rule).
    A.gate = function (n) {
      if (n > core.m.TODAY) return { ok: false, status: 422, code: 'VALIDATION_ERROR', reason: 'future', message: 'Date is in the future.' };
      if (n < core.m.TODAY - 1) return { ok: false, status: 400, code: 'DAILY_WINDOW', reason: 'old', message: 'Only today and yesterday can be edited.' };
      if (!A.isPeriodDay(n)) return { ok: false, status: 400, code: 'NOT_PERIOD_DAY', reason: 'notperiod', message: E.text('NOT_PERIOD_DAY') };
      return { ok: true };
    };
    // [data-layer] real cycles writes: mock-shaped success, failure passthrough, never reject.
    // This layer never writes CYC and never commits; core.edit re-hydrates and commits once.
    function cycleSave(method, path, body) {
      return safe(function () {
        return request(method, path, body).then(function (r) {
          if (!r || !r.ok) return r;
          var d = r.data;
          if (!d || typeof d !== 'object' || Array.isArray(d) ||
              typeof d.id !== 'number' || typeof d.period_start !== 'string') return E.badResponse(r.status);
          return { ok: true, status: r.status, id: d.id, period_start: d.period_start, period_end: d.period_end == null ? null : d.period_end };
        }).catch(function (e) { return E.internal(e && e.message ? e.message : String(e)); });
      });
    }
    A.cycles = {
      // Sync read of the hydrated cycles: DESC, same shape as the mock provider.
      list: function () {
        return core.m.CYC.slice().sort(function (a, b) { return b.s - a.s; }).map(function (c) {
          return { id: c.id, period_start: core._data.iso(c.s), period_end: c.e == null ? null : core._data.iso(c.e), period_days: c.e == null ? null : c.e - c.s + 1 };
        });
      },
      create: function (body) { return cycleSave('POST', '/cycles', body); },
      update: function (id, body) { return cycleSave('PUT', '/cycles/' + id, body); },
      // DELETE body is not part of the contract: accept an empty/absent body (use the request id)
      // and prefer a numeric response id when the server sends one.
      remove: function (id) {
        return safe(function () {
          return request('DELETE', '/cycles/' + id, null).then(function (r) {
            if (!r || !r.ok) return r;
            var d = r.data;
            if (d != null && (typeof d !== 'object' || Array.isArray(d))) return E.badResponse(r.status);
            var rid = d && typeof d.id === 'number' ? d.id : id;
            return { ok: true, status: r.status, deleted: true, id: rid };
          }).catch(function (e) { return E.internal(e && e.message ? e.message : String(e)); });
        });
      }
    };
    // Readable cache of the 8 device-settings keys. Seeded from REAL_SETTINGS, replaced by the
    // Win hydrate GET and, on Android, refreshed from the native settings bridge on every read.
    A._settings = Object.assign({}, REAL_SETTINGS);
    function hydrateAndroidSettings() {
      var b = core.platform && core.platform.settingsBridge;
      if (!b || typeof b.read !== 'function') return false;
      var r = b.read();
      if (!r || !r.ok || !r.data || typeof r.data !== 'object') return false;
      var next = Object.assign({}, A._settings);
      Object.keys(r.data).forEach(function (k) {
        if (Object.prototype.hasOwnProperty.call(next, k)) next[k] = r.data[k];
      });
      A._settings = next;
      return true;
    }
    function settingsFailure(code, message) {
      return {
        ok: false, status: 500, code: code || 'ADAPTER_ERROR',
        message: message || 'Could not save this setting on this device.'
      };
    }
    A.settings = function (patch) {
      var android = core.platform && core.platform.kind() === 'android';
      if (patch === undefined) {
        if (android) hydrateAndroidSettings();
        return E.success(200, Object.assign({}, A._settings));
      }
      if (android) {
        var bridge = core.platform && core.platform.settingsBridge;
        if (!bridge) return settingsFailure('BRIDGE_UNAVAILABLE', 'Native settings are unavailable on this device.');
        // Start from the on-device truth even if this is the first call after a reload: a write
        // must not echo stale defaults for the other seven keys.
        hydrateAndroidSettings();
        var next = Object.assign({}, A._settings);
        var keys = Object.keys(patch || {});
        for (var i = 0; i < keys.length; i++) {
          var k = keys[i];
          var w = bridge.write(k, patch[k]);
          if (!w || !w.ok) {
            return settingsFailure(w && w.code, 'Could not save this setting on this device.');
          }
          if (w.value === null || w.value === undefined) {
            return settingsFailure('BAD_RESPONSE', 'Could not save this setting on this device.');
          }
          next[k] = w.value;
        }
        A._settings = next;
        return E.success(200, Object.assign({}, next));
      }
      return safe(function () {
        return request('PUT', '/device/settings', patch).then(function (r) {
          if (!r || !r.ok) return r;
          if (!r.data || typeof r.data !== 'object' || Array.isArray(r.data)) return E.badResponse(r.status);
          var cur = A.settings().data;
          var next = {};
          Object.keys(cur).forEach(function (k) {
            next[k] = Object.prototype.hasOwnProperty.call(r.data, k) ? r.data[k] : cur[k];
          });
          A._settings = next;
          return { ok: true, status: r.status, data: Object.assign({}, next) };
        });
      }).catch(function (e) { return E.internal(e && e.message ? e.message : String(e)); });
    };
    A.scenario = function () { return E.notWired('Demo scenario switch'); };
    A.exportDaily = function () { return null; };

    function authState() {
      return {
        authed: !!AUTH.authed,
        persistent: !!AUTH.persistent,
        user: AUTH.user ? Object.assign({}, AUTH.user) : null,
        demo_password: ''
      };
    }
    function authPayload(r) {
      if (!r || !r.ok) return null;
      var d = r.data;
      if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
      if (typeof d.token !== 'string' || !d.token) return null;
      if (!d.user || typeof d.user !== 'object' || Array.isArray(d.user)) return null;
      return d;
    }
    function authUserPayload(r) {
      if (!r || !r.ok) return null;
      var d = r.data;
      if (!d || typeof d !== 'object' || Array.isArray(d) || typeof d.username !== 'string') return null;
      return d;
    }
    function applySession(d, persistent) {
      if (!setToken(d.token)) return false;
      AUTH.authed = true;
      AUTH.persistent = !!persistent;
      applyAuthUser(d.user, false);
      return true;
    }
    function staleNote(h) {
      if (h && h.ok) return 'hydrate after login superseded';
      return 'hydrate after login failed: ' + (h && h.code ? h.code : 'unknown');
    }
    // Interactive login/register: the server session is already valid at this point, so a failed
    // re-hydrate must not reject or downgrade the login result. The page still gets data:{token,user}
    // and receives stale:true + A._hydrateNote; commit 'api' happens exactly once for the auth change.
    // The result may also carry sessionCleared:true when that hydrate 401 already ran signOut (the
    // token in data is dead): ok/data stay, but a caller that navigates (B9) MUST check
    // auth.state().authed first instead of trusting ok alone.
    function completeLogin(r, persistent) {
      var d = authPayload(r);
      if (!d) return E.badResponse(r ? r.status : 0);
      if (!applySession(d, persistent)) return E.internal('Could not save the sign-in state.');
      var out = { ok: true, status: r.status, data: { token: d.token, user: d.user } };
      function settle() {
        // A 401 during hydrate already ran signOut (one commit/one auth event); do not double it.
        if (AUTH.authed) {
          core.commit('api');
          core.emit('auth', authState());
        } else {
          // The hydrate 401 cleared the fresh session: keep ok/data, but tell the caller it is gone.
          out.sessionCleared = true;
        }
        return out;
      }
      function finish(h) {
        if (!h || !h.ok || (h.data && h.data.stale)) {
          out.stale = true;
          A._hydrateNote = staleNote(h);
        }
        return settle();
      }
      function onReject(e) {
        out.stale = true;
        A._hydrateNote = 'hydrate after login failed: ' + (e && e.message ? e.message : String(e));
        return settle();
      }
      // Promise.resolve().then(...) so a SYNCHRONOUS throw from a patched hydrate() lands in the
      // stale failure branch instead of escaping as an outer ADAPTER_ERROR with the session applied.
      return Promise.resolve().then(function () { return A.hydrate(); }).then(finish, onReject);
    }

    A.auth = {
      state: authState,
      login: function (username, password, keep) {
        return safe(function () {
          return request('POST', '/auth/login', {
            username: username,
            password: password,
            keep_logged_in: !!keep
          }).then(function (r) {
            if (!r || !r.ok) return r;
            return completeLogin(r, !!keep);
          });
        }).catch(function (e) { return E.internal(e && e.message ? e.message : String(e)); });
      },
      register: function (username, password, nickname) {
        return safe(function () {
          var body = { username: username, password: password };
          if (nickname !== undefined) body.nickname = nickname;
          return request('POST', '/auth/register', body).then(function (r) {
            if (!r || !r.ok) return r;
            return completeLogin(r, false);
          });
        }).catch(function (e) { return E.internal(e && e.message ? e.message : String(e)); });
      },
      relogin: function () {
        return safe(function () {
          return request('POST', '/auth/relogin', null).then(function (r) {
            if (!r || !r.ok) return r;
            var d = authPayload(r);
            if (!d) return E.badResponse(r.status);
            if (!applySession(d, true)) return E.internal('Could not save the sign-in state.');
            // Inside the startup bootstrap window main.js owns the single startup commit, so the
            // restore must not broadcast an auth event before any listener exists.
            if (!BOOTSTRAP) core.emit('auth', authState());
            // Pure auth restore: main.js owns the startup hydrate, so never hydrate/commit here.
            return { ok: true, status: r.status, data: { token: d.token, user: d.user } };
          });
        }).catch(function (e) { return E.internal(e && e.message ? e.message : String(e)); });
      },
      me: function () {
        return safe(function () {
          return request('GET', '/auth/me', null).then(function (r) {
            if (!r || !r.ok) return r;
            var u = authUserPayload(r);
            if (!u) return E.badResponse(r.status);
            applyAuthUser(u, false);
            return { ok: true, status: r.status, data: u };
          });
        }).catch(function (e) { return E.internal(e && e.message ? e.message : String(e)); });
      },
      profile: function (patch) {
        return safe(function () {
          return request('PUT', '/auth/profile', patch).then(function (r) {
            if (!r || !r.ok) return r;
            var u = authUserPayload(r);
            if (!u) return E.badResponse(r.status);
            applyAuthUser(u, true);
            return { ok: true, status: r.status, data: u };
          });
        }).catch(function (e) { return E.internal(e && e.message ? e.message : String(e)); });
      },
      persistence: function (password) {
        return safe(function () {
          return request('POST', '/auth/persistence', { password: password }).then(function (r) {
            if (r && r.ok && r.data && typeof r.data.enabled === 'boolean') AUTH.persistent = r.data.enabled;
            return r;
          });
        }).catch(function (e) { return E.internal(e && e.message ? e.message : String(e)); });
      },
      clearPersistence: function () {
        return safe(function () {
          return request('DELETE', '/auth/persistence', null).then(function (r) {
            if (r && r.ok) AUTH.persistent = false;
            return r;
          });
        }).catch(function (e) { return E.internal(e && e.message ? e.message : String(e)); });
      },
      changePassword: function (oldPassword, newPassword) {
        return safe(function () {
          return request('POST', '/auth/change-password', {
            old_password: oldPassword,
            new_password: newPassword
          }).then(function (r) {
            if (r && r.ok) signOut();
            return r;
          });
        }).catch(function (e) { return E.internal(e && e.message ? e.message : String(e)); });
      },
      logout: function () {
        return safe(function () {
          return request('POST', '/auth/logout', null).then(function (r) {
            if (r && r.ok) signOut();
            return r;
          });
        }).catch(function (e) { return E.internal(e && e.message ? e.message : String(e)); });
      },
      deleteAccount: function (password) {
        return safe(function () {
          return request('POST', '/auth/delete-account', { password: password }).then(function (r) {
            if (r && r.ok) signOut();
            return r;
          });
        }).catch(function (e) { return E.internal(e && e.message ? e.message : String(e)); });
      },
      bootstrap: async function () {
        BOOTSTRAP = true;
        try {
          if (token()) {
            var mr = await A.auth.me();
            if (!mr || !mr.ok) {
              if (mr && mr.status === 401) {
                // The transport's /auth/me 401 hook already cleared silently; this is a no-op
                // fallback that also covers a patched/failed transport response.
                signOut({ silent: true, force: true });
              } else {
                // A 5xx/network failure must not discard a token that may still be valid.
                signOut({ silent: true, force: true, keepToken: true });
                return E.success(200, { authed: false });
              }
            }
          }
          if (!AUTH.authed) {
            var rr = await A.auth.relogin();
            if (!rr || !rr.ok) {
              signOut({ silent: true, force: true });
              return E.success(200, { authed: false });
            }
          }
          var pr = await request('GET', '/auth/persistence', null);
          if (pr && pr.ok && pr.data && typeof pr.data.enabled === 'boolean') {
            AUTH.persistent = pr.data.enabled;
          }
          return E.success(200, { authed: !!AUTH.authed });
        } catch (e) {
          signOut({ silent: true, force: true });
          return E.success(200, { authed: false });
        } finally {
          BOOTSTRAP = false;
        }
      }
    };

    // Write daily details, then mirror the server row into DAILY and commit 'cal' exactly once.
    // A malformed response changes nothing locally but still returns the server result.
    A.putDaily = function (n, body) {
      return safe(function () {
        var date = core._data.iso(n);
        if (!date) return E.fromHttp(422, { detail: 'Invalid date.', code: 'VALIDATION_ERROR' });
        return request('PUT', '/daily-records/' + date, dailyBody(body)).then(function (r) {
          try {
            if (r && r.ok && r.data && typeof r.data.record_date === 'string' && typeof r.data.flow_level === 'number' && isFinite(r.data.flow_level)) {
              var d = core._data.un(r.data.record_date);
              if (d != null) {
                core.m.DAILY[d] = {
                  id: r.data.id,
                  created_at: r.data.created_at == null ? null : r.data.created_at,
                  updated_at: r.data.updated_at == null ? null : r.data.updated_at,
                  pain_present: !!r.data.pain_present,
                  pain_level: r.data.pain_present && r.data.pain_level != null ? r.data.pain_level : null,
                  flow_level: r.data.flow_level,
                  mood_level: r.data.mood_level,
                  mood_tags: Array.isArray(r.data.mood_tags) ? r.data.mood_tags : [],
                  mood_note: ''
                };
                core.commit('cal');
              }
            }
          } catch (_) { /* local mirror is best-effort; the server result still wins */ }
          return r;
        });
      }).catch(function (e) { return E.internal(e && e.message ? e.message : String(e)); });
    };
    A.export = function () {
      return safe(function () { return request('GET', '/export', null); });
    };
    // Import, then re-hydrate and commit 'api' exactly once (even when the re-hydrate fails).
    A.import = function (payload, opts) {
      return safe(function () {
        var n = normalizeImport(payload);
        if (!n.ok) return n.error;
        var body = Object.assign({}, n.value, { allow_anomalies: !!(opts && opts.allow_anomalies) });
        return request('POST', '/import', body).then(function (r) {
          if (!r || !r.ok) return r;
          return A.hydrate().then(function (h) {
            if (!h || !h.ok) A._hydrateNote = 'hydrate after import failed: ' + (h ? h.code : 'unknown');
            core.commit('api');
            return r;
          }, function (e) {
            A._hydrateNote = 'hydrate after import failed: ' + (e && e.message ? e.message : String(e));
            core.commit('api');
            return r;
          });
        });
      }).catch(function (e) { return E.internal(e && e.message ? e.message : String(e)); });
    };
    A.health = function () {
      return safe(function () { return request('GET', '/health', null); });
    };
    A.hydrate = realHydrate;
  };
