/* ===== hydrate.js =====
 * 1 角色：启动 hydrate：health 之后（仅 Win）可选设备设置，再 cycles/daily/journal/predictions 四路请求、响应映射、journal 镜像、预测合并、序列防覆盖。
 * 2 依赖：transport.js（request/A/E）、state.js（core._data/core.m）、api.auth.js 提供的 signOut 仅经 guard401 间接生效。
 * 3 暴露：HYDRATE_SEQ,mapCycles,mapDaily,mapJournal,journalMirror,mergePredictions,noteHydrate,realHydrate（顶层，不挂 window）。
 * 4 不变量：cycles/daily/predictions 全有或全无；journal 与设备设置都是独立可选通道，失败只记 note；seq 检查保证旧 hydrate 不覆盖新结果；失败不改数据。
 * 5 契约来源：数据层契约（原 api.js 399–403、493–496 行注释随段保留）；契约头 hydrate 条款。
 * 6 禁止改动项：请求顺序与 URL（health 后 Win 多一条可选 GET /device/settings）、from/to 推导、365 天回退、预测合并规则、note 文案、数组/对象校验条件。
 *
 * P2 变更（设备级主题落盘/启动应用）：Win 启动 hydrate 拿到 GET /device/settings 的 theme 后，
 *   把档位落到根元素（data-ap = 原始档位，data-theme = 实际深浅），使重载/重启后仍是用户那档；
 *   theme 不进 A._settings（8 键合并口径不变），You 页从根元素 data-ap 同步按钮态。
 *
 * 请求顺序：GET /health →〔仅 Win 平台〕GET /device/settings →GET /cycles → GET /daily-records →
 * GET /daily-journal → GET /predictions/current → GET /analysis/fertile-window。
 * `core.platform.kind() === 'android'` 时不发设备设置请求（安卓设置桥尚未接，保持现状）。
 */
  let HYDRATE_SEQ = 0;
  const mapCycles = function mapCycles(rows) {
    var out = [];
    rows.forEach(function (x) {
      if (!x || typeof x !== 'object' || Array.isArray(x)) throw new Error('cycles row is not an object');
      var s = core._data.un(x.period_start);
      if (s == null) return; // an unparsable start is skipped, never stored as NaN
      var e = x.period_end == null ? null : core._data.un(x.period_end);
      out.push({ id: x.id, s: s, e: e, note: x.note || '' });
    });
    return out;
  };

  const mapDaily = function mapDaily(rows) {
    var out = [];
    rows.forEach(function (r) {
      if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Error('daily row is not an object');
      var n = core._data.un(r.record_date);
      if (n == null) return; // same rule as cycles: skip the row, never NaN
      out.push({
        n: n,
        id: r.id,
        pain_present: r.pain_present,
        pain_level: r.pain_level,
        flow_level: r.flow_level,
        mood_level: r.mood_level,
        mood_tags: r.mood_tags,
        created_at: r.created_at == null ? null : r.created_at,
        updated_at: r.updated_at == null ? null : r.updated_at
      });
    });
    return out;
  };

  // journal row -> {n,...}. record_date is authoritative; an unparsable date skips the row (never
  // NaN). note is normalized to '' here so the store invariant (note always a string) holds.
  const mapJournal = function mapJournal(rows) {
    var out = [];
    rows.forEach(function (r) {
      if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Error('journal row is not an object');
      var n = core._data.un(r.record_date);
      if (n == null) return;
      out.push({
        n: n,
        id: r.id == null ? null : r.id,
        note: typeof r.note === 'string' ? r.note : '',
        created_at: r.created_at == null ? null : r.created_at,
        updated_at: r.updated_at == null ? null : r.updated_at,
        record_date: typeof r.record_date === 'string' ? r.record_date : core._data.iso(n)
      });
    });
    return out;
  };

  // [data-layer] Mirror a VALID JournalOut into the private journal store and report whether the
  // 2xx payload was usable. Returns false, changing nothing, for a malformed body (not a plain
  // object, note neither string nor null, or an unparsable record_date). A string note writes the
  // row (record_date from the response); note null deletes that day. This helper never commits:
  // the caller owns exactly one commit after a true return.
  const journalMirror = function journalMirror(n, data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
    if (typeof data.note !== 'string' && data.note !== null) return false;
    if (typeof data.record_date !== 'string') return false;
    var day = core._data.un(data.record_date);
    if (day == null) return false;
    if (typeof data.note === 'string') {
      core._data.journalPut(day, {
        id: data.id == null ? null : data.id,
        note: data.note,
        created_at: data.created_at == null ? null : data.created_at,
        updated_at: data.updated_at == null ? null : data.updated_at,
        record_date: data.record_date
      });
    } else {
      core._data.journalPut(day, null);
    }
    return true;
  };

  // predictions = /predictions/current (onset) + /analysis/fertile-window (ovulation / fertile /
  // less-certain / predicted period windows). User-confirmed merge: only when predicted_date is
  // STRICTLY after TODAY, move the first predicted window that starts after TODAY to that date;
  // synthesize the window when it is missing. Otherwise the service windows pass through untouched.
  const mergePredictions = function mergePredictions(current, fertile, today) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) throw new Error('predictions/current is not an object');
    if (!fertile || typeof fertile !== 'object' || Array.isArray(fertile)) throw new Error('fertile-window is not an object');
    if (!Array.isArray(fertile.predicted_period_windows) || !Array.isArray(fertile.less_certain_windows)) throw new Error('fertile-window windows are not arrays');
    var pw = [];
    fertile.predicted_period_windows.forEach(function (w) {
      if (!w || typeof w !== 'object') return;
      if (core._data.un(w.start) == null || core._data.un(w.end) == null) return;
      pw.push({ start: w.start, end: w.end });
    });
    var predicted = current.predicted_date == null ? null : core._data.un(current.predicted_date);
    if (predicted != null && predicted > today) {
      var hit = -1;
      for (var i = 0; i < pw.length; i++) {
        if (core._data.un(pw[i].start) > today) { hit = i; break; }
      }
      if (hit >= 0) {
        pw[hit].start = core._data.iso(predicted);
      } else {
        var len = typeof fertile.predicted_period_days === 'number' && isFinite(fertile.predicted_period_days) && fertile.predicted_period_days > 0 ? fertile.predicted_period_days : 5;
        pw.push({ start: core._data.iso(predicted), end: core._data.iso(predicted + len - 1) });
      }
    }
    return {
      available: !!fertile.available,
      ovulation_date: fertile.ovulation_date == null ? null : fertile.ovulation_date,
      fertile_window: fertile.fertile_window == null ? null : fertile.fertile_window,
      less_certain_windows: fertile.less_certain_windows,
      predicted_period_windows: pw
    };
  };

  // A._hydrateNote append helper: a daily retry note must survive a later journal note (same run).
  const noteHydrate = function noteHydrate(msg) {
    A._hydrateNote = A._hydrateNote ? A._hydrateNote + '; ' + msg : msg;
  };

  // Startup hydrate. Never rejects: every failure resolves {ok:false,...} and applies NOTHING
  // (all-or-nothing). Health goes first but only feeds A._version (non-fatal). Responses are
  // sequenced by HYDRATE_SEQ so an older hydration can never overwrite a newer one.
  const realHydrate = async function realHydrate() {
    try {
      var seq = ++HYDRATE_SEQ;
      A._hydrateNote = '';
      try {
        var h = await request('GET', '/health', null);
        if (h && h.ok && h.data && typeof h.data.version === 'string') A._version = h.data.version;
      } catch (_) { /* version is optional */ }
      // Device settings are optional and Win-only: a failure (or a non-object body) only notes and
      // never blocks the hydration; the merge happens right before applyHydrate (seq-checked).
      // [P2] Device theme is a device-level preference (GET /device/settings -> theme in
      // light|dark|system), so it is applied to the root element at startup: a reload or a restart
      // keeps the tier the user picked instead of falling back to the markup default. The tier is
      // kept on the root element (data-ap) and NOT in A._settings, which stays the 8 reminder
      // keys; the You page reads data-ap to sync its three buttons.
      // Same contract as core/app.js setTheme: the same data-theme attribute plus the ink refresh
      // (readInk + every booted page's cacheInk), otherwise the canvases keep painting with the
      // previous theme's ink. No view transition here: this is a startup restore, not a touch.
      function applyDeviceTheme(s) {
        if (!s || typeof s !== 'object') return;
        var tier = s.theme;
        if (tier !== 'light' && tier !== 'dark' && tier !== 'system') return;
        var el = document.documentElement;
        el.setAttribute('data-ap', tier);
        var dark = tier === 'dark' || (tier === 'system' && matchMedia('(prefers-color-scheme:dark)').matches);
        var t = dark ? 'dark' : 'light';
        if (el.dataset.theme === t) return;
        el.dataset.theme = t;
        readInk();
        pages.forEach(function (p) { p.booted && p.api.cacheInk && p.api.cacheInk(); });
      }
      var settings = null;
      try {
        if (core.platform && core.platform.kind() === 'win') {
          var st = await request('GET', '/device/settings', null);
          if (st && st.ok && st.data && typeof st.data === 'object' && !Array.isArray(st.data)) settings = st.data;
          else noteHydrate('device settings -> ' + (st && st.code ? st.code : 'status ' + (st ? st.status : 0)));
        }
      } catch (e) { noteHydrate('device settings -> ' + (e && e.message ? e.message : String(e))); }
      applyDeviceTheme(settings);
      var cy = await request('GET', '/cycles', null);
      if (!cy || !cy.ok) return cy && !cy.ok ? cy : E.badResponse(cy ? cy.status : 0); // 2xx + array required
      if (!Array.isArray(cy.data)) return E.badResponse(cy.status);
      var cycles = mapCycles(cy.data);
      var today = core.m.TODAY;
      var fallbackFrom = core._data.iso(today - 365);
      var from = cycles.length ? core._data.iso(Math.min.apply(null, cycles.map(function (c) { return c.s; }))) : fallbackFrom;
      var to = core._data.iso(today);
      var dr = await request('GET', '/daily-records?from=' + from + '&to=' + to, null);
      if ((!dr || !dr.ok) && dr && dr.status >= 400 && dr.status < 500 && from !== fallbackFrom) {
        A._hydrateNote = 'daily range ' + from + ' -> ' + dr.code + ' (' + dr.status + '); retried from ' + fallbackFrom;
        from = fallbackFrom;
        dr = await request('GET', '/daily-records?from=' + from + '&to=' + to, null);
      }
      if (!dr || !dr.ok) return dr && !dr.ok ? dr : E.badResponse(dr ? dr.status : 0);
      if (!Array.isArray(dr.data)) return E.badResponse(dr.status);
      var daily = mapDaily(dr.data);
      // [data-layer] journal is an independent OPTIONAL channel: its own request and its own
      // failure mode. Requested after /daily-records succeeded (reusing the same `from` the daily
      // range actually ended up with) and before /predictions/current; any problem stores [] plus a
      // note, and never fails the hydration.
      var journal = [];
      try {
        var jr = await request('GET', '/daily-journal?from=' + from + '&to=' + to, null);
        if (!jr || !jr.ok) {
          noteHydrate('journal range ' + from + ' -> ' + (jr && jr.code ? jr.code : 'status ' + (jr ? jr.status : 0)));
        } else if (!Array.isArray(jr.data)) {
          noteHydrate('journal range ' + from + ' -> status ' + jr.status + ' (not an array)');
        } else {
          journal = mapJournal(jr.data);
        }
      } catch (e) {
        journal = [];
        noteHydrate('journal range ' + from + ' -> ' + (e && e.message ? e.message : String(e)));
      }
      var pr = await request('GET', '/predictions/current', null);
      if (!pr || !pr.ok) return pr && !pr.ok ? pr : E.badResponse(pr ? pr.status : 0);
      var fw = await request('GET', '/analysis/fertile-window', null);
      if (!fw || !fw.ok) return fw && !fw.ok ? fw : E.badResponse(fw ? fw.status : 0);
      var predictions = mergePredictions(pr.data, fw.data, today);
      if (seq !== HYDRATE_SEQ) return E.success(200, { stale: true }); // a newer hydrate started: apply nothing
      // Merge only the keys the frontend already knows (8 reminder keys) so a wider server object
      // (theme / close_action) can never reshape the settings surface.
      if (settings) {
        var curSet = A.settings().data;
        var nextSet = {};
        Object.keys(curSet).forEach(function (k) {
          nextSet[k] = Object.prototype.hasOwnProperty.call(settings, k) ? settings[k] : curSet[k];
        });
        A._settings = nextSet;
      }
      core._data.applyHydrate({ cycles: cycles, daily: daily, journal: journal, predictions: predictions });
      return E.success(200, { cycles: cycles.length, daily: daily.length });
    } catch (e) {
      return E.internal(e && e.message ? e.message : String(e));
    }
  };
