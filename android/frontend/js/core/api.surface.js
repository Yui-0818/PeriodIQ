/* ===== api.surface.js =====
 * 1 角色：两模式共用 api 表面（journal/moodTags/isPeriodDay/importBytes/_transport/_mode/_version/_hydrateNote）与启动装配。
 * 2 依赖：transport.js、hydrate.js、api.auth.js、api.domain.js、api.mock.js、state.js、mock.js（仅 mock 分支）。
 * 3 暴露：MOOD_TAGS,MOOD_TAG_ID_MAX_CHARS,emptyPredictions,mode（顶层，不挂 window）+ api.* 表面成员。
 * 4 不变量：_mode 由 pickMode() 唯一决定；_version/_hydrateNote 初始为 ""；启动顺序 mock: installMock→seed，real: installReal，最后 core._data.recompute() 且仅一次。
 * 5 契约来源：契约头 journal/moodTags/importBytes 条款（原 api.js 17–24、43–46、63–67 行）；数据层契约（935–939 行注释随段保留）。
 * 6 禁止改动项：limit 300、tags 上限 8、MOOD_TAG_ID_MAX_CHARS 24、8*1024*1024、标签词表、commit 次数、初始化顺序。
 */
  // Journal note limit in Unicode CODE POINTS. Contract source:
  // Win\backend\app\config.py::DAILY_NOTE_MAX_CHARS (Android mirror: PiqConfig.DAILY_NOTE_MAX_CHARS).
  // `limit: 300` below is the ONLY note-length 300 literal in the JS: the HTTP `status < 300`
  // checks and the pre-existing animation/layout numbers (e.g. calendar's -300) are not contract
  // limits and do not count. Count/bootstrap and the page's counter all read api.journal.limit,
  // never a hardcoded number.
  // Controlled mood/body tag vocabulary. Contract source:
  // Win\backend\app\config.py::MOOD_TAG_IDS_MOOD / MOOD_TAG_IDS_BODY. The 18 ids below are the ONLY
  // copy in JS (the mock validates through api.moodTags.validate, it does not keep its own list);
  // both ends change in the same round and the Android mirror lives in PiqConfig.kt.
  const MOOD_TAGS = {
    mood: ['calm', 'happy', 'energetic', 'steady', 'irritable', 'anxious', 'sad', 'sensitive'],
    body: ['cramps', 'headache', 'bloating', 'back_ache', 'tender_breasts', 'fatigue', 'nausea', 'cravings', 'acne', 'insomnia']
  };
  // Contract source: Win\backend\app\config.py::MOOD_TAG_ID_MAX_CHARS (counted in code points).
  const MOOD_TAG_ID_MAX_CHARS = 24;
  // Factory: the two window lists are mutable arrays, so each call must get its
  // own instances (a shallow copy would share them between callers).
  const emptyPredictions = function emptyPredictions() {
    return {
      available: false,
      ovulation_date: null,
      fertile_window: null,
      less_certain_windows: [],
      predicted_period_windows: []
    };
  };

  const mode = pickMode();
  A._mode = mode;
  // Both modes initialize the health version and the hydrate note ('' = no note).
  A._version = '';
  A._hydrateNote = '';
  // ---- journal / moodTags / isPeriodDay: one surface, identical shape in mock and real mode ----
  // Reads are sync (hydrated memory only, never a request):
  //   journal.get(n)     -> {id:id|null, note:string, has:boolean}
  //   journal.range(a,b) -> [{n,id,note}] DESC, only days that have a note
  //   moodTags.list()    -> {mood:[...], body:[...]} (fresh copies on every call)
  // Writes are async via journal.put and share one commit point below.
  A.journal = {
    // Contract source: Win\backend\app\config.py::DAILY_NOTE_MAX_CHARS — the ONLY note-length 300
    // literal in JS (HTTP status / the pre-existing animation number do not count).
    limit: 300,
    get: function (n) {
      var r = core._data.journalGet(n);
      return { id: r && r.id != null ? r.id : null, note: r ? r.note : '', has: !!r };
    },
    range: function (fromN, toN) {
      return core._data.journalRange(fromN, toN).map(function (r) {
        return { n: r.n, id: r.id == null ? null : r.id, note: typeof r.note === 'string' ? r.note : '' };
      }).sort(function (a, b) { return b.n - a.n; });
    },
    countNote: function (t) {
      // Unicode code points, never .length: an emoji counts as one character (#28).
      return typeof t === 'string' ? Array.from(t).length : 0;
    },
    truncate: function (t) {
      return typeof t === 'string' ? Array.from(t).slice(0, A.journal.limit).join('') : '';
    },
    writable: function (n) {
      return n === core.m.TODAY;
    },
    // [data-layer] async write (never rejects). Null/undefined note -> '' ('' = delete); a
    // non-integer dayNumber is 422 before any request. valid JournalOut -> mirror + exactly one
    // commit; malformed 2xx -> BAD_RESPONSE, no store change/no commit; any failure changes nothing.
    // Past days are NOT pre-blocked here: the page decides, the server/mock answers 400
    // JOURNAL_READONLY.
    put: function (n, note) {
      return safe(function () {
        if (typeof n !== 'number' || !Number.isInteger(n)) return E.fromHttp(422, { detail: 'Invalid date.', code: 'VALIDATION_ERROR' });
        var date = null;
        try { date = core._data.iso(n); } catch (_) { date = null; }
        if (!date) return E.fromHttp(422, { detail: 'Invalid date.', code: 'VALIDATION_ERROR' });
        var text = note == null ? '' : String(note);
        if (mode === 'mock') {
          var mr = core._providers.mock.journalPutSync(n, text);
          if (mr && mr.ok) {
            if (!journalMirror(n, mr.data)) return E.badResponse(mr.status);
            core.commit('api');
          }
          return mr;
        }
        return request('PUT', '/daily-journal/' + date, { note: text }).then(function (r) {
          if (r && r.ok) {
            if (!journalMirror(n, r.data)) return E.badResponse(r.status);
            core.commit('api');
          }
          return r;
        });
      }).catch(function (e) { return E.internal(e && e.message ? e.message : String(e)); });
    }
  };
  A.moodTags = {
    // Contract source: Win\backend\app\config.py::MOOD_TAGS_MAX_COUNT — the ONLY tag-limit 8 in JS.
    limit: 8,
    list: function () {
      return { mood: MOOD_TAGS.mood.slice(), body: MOOD_TAGS.body.slice() };
    },
    // One message source only (errors.js); callers never add a second text table.
    validate: function (ids) {
      var fail = function () { return { ok: false, message: E.text('VALIDATION_ERROR') }; };
      if (!Array.isArray(ids)) return fail();
      if (ids.length > A.moodTags.limit) return fail();
      var seen = Object.create(null);
      for (var i = 0; i < ids.length; i++) {
        var id = ids[i];
        if (typeof id !== 'string') return fail();
        if (Array.from(id).length > MOOD_TAG_ID_MAX_CHARS) return fail();
        if (MOOD_TAGS.mood.indexOf(id) < 0 && MOOD_TAGS.body.indexOf(id) < 0) return fail();
        if (seen[id]) return fail();
        seen[id] = 1;
      }
      return { ok: true };
    }
  };
  // Pure local derivation from the hydrated cycles (no request, no DB); absent day -> false.
  A.isPeriodDay = function (n) {
    return n != null && !!core.m.cycAt(n);
  };
  // Import body limit in RAW bytes. Contract source: Win\backend\app\config.py::MAX_IMPORT_BYTES
  // (Android PiqConfig.MAX_IMPORT_BYTES is the same value and the same code) — the backend gate
  // runs main.py's middleware before JSON parsing and rejects STRICTLY greater sizes with
  // 400 IMPORT_TOO_LARGE. Pages compare File.size against this value before reading the file.
  A.importBytes = 8 * 1024 * 1024;
  // Evaluated at call time: PIQNative may be injected after page load.
  A._transport = function () {
    if (mode === 'mock') return 'mock';
    if (nativeBridge()) return 'native';
    return isAndroid() ? 'bridge-unavailable' : 'fetch';
  };

  if (mode === 'mock') {
    installMock();
    core._providers.mock.seed();
  } else {
    installReal();
  }
  core._data.recompute();
