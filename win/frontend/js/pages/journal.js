/* ------------------------------------------------------------------
   1 角色：Journal — PeriodIQ 的第六页（不是 dock 标签）。顶部是可写的 Today 页（450 ms autosave），其下是只读的过往日记时间线（一条星座脊线，今天在最上、记忆向下沉）；#jsky 是本页星空；加载时绑定 Calendar header 里的 #jrn 入口。
   2 依赖：core（nav、api.journal、api.getDaily、api.isPeriodDay、m、fx 可选）、PG（#pg-journal）；base.css 的 .glass；journal.css。
   3 暴露：boot_journal(core,PG) → {size,setSY,refresh}（本文件唯一的全局名）。新增类仅 x- 前缀：x-td x-nd x-now x-th x-dn x-dl x-pane x-nt x-ft x-st x-rt x-ct x-en x-pd x-eh x-ed x-em x-tx x-dt x-kr x-kv x-tg x-mo x-go x-near x-full。
   4 不变量：写入只经 api.journal.put，且只写 core.m.TODAY；300 上限、计数、截断只经 api.journal.limit/countNote/truncate（码点，不用 .length）；读取均为同步内存读（journal.get/range、getDaily、isPeriodDay）；不虚构条目、计数或标签；无 i18n 调用、无直接浏览器存储、无新 API、无新增 window 名。
   5 契约来源：早期记录；api.surface.js 的 journal/moodTags/isPeriodDay 条款；state.js 的 JOURNAL 存取器与日期函数；journal 外壳现由 index.html 承载。
   6 禁止改动项：不改 index.html / main.js / calendar.detail.js / api.surface.js / state.js / DNA.md；第六页的 core.register 与 CSS/脚本链接由外壳完成，本文件不调用 register；入口 #jrn 之外，加载期不调用 nav。
   迁自：新建（B8），无迁移来源。
   ------------------------------------------------------------------ */
function boot_journal(core, PG) {
  'use strict';
  const api = core.api, J = api.journal, M = core.m, TODAY = M.TODAY, fmt = M.fmt;
  const $ = s => PG.querySelector(s);
  const bk = $('#jback'), meta = $('#jmeta'), tdw = $('#jtoday'), lst = $('#jlist'), emp = $('#jempty'), cv = $('#jsky'), h1 = $('h1');
  // shell missing → an inert surface, never a console error
  if (!bk || !meta || !tdw || !lst || !emp || !cv) return { size() {}, setSY() {}, refresh() {} };

  const h = (t, c, x) => { const e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; };
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const rnd = (i, k) => { const x = Math.sin(i * 127.1 + k * 311.7) * 43758.5453; return x - Math.floor(x); };
  const iso = n => M.dOf(n).toISOString().slice(0, 10);
  const pt = (e, el) => { let x = e.clientX, y = e.clientY; if (!x && !y) { const r = el.getBoundingClientRect(); x = r.left + r.width / 2; y = r.top + r.height / 2; } return { x, y }; };
  const mq = matchMedia('(prefers-reduced-motion:reduce)');
  let reduce = mq.matches, on = false;
  // 迭代1（3.0.1）：文案走 core.i18n；日期显示走 date()（dayNumber+UTC 不变）
  const t = (k, v) => core.i18n.t(k, v), plw = (n, b) => core.i18n.t(core.i18n.plural(n, b), { n }),
    dfmt = (n, o) => core.i18n.date(n, o),
    MWK = [null, 'cal.moodW2', 'cal.moodW2', 'cal.moodW4', 'cal.moodW4', 'cal.moodW6', 'cal.moodW6', 'cal.moodW8', 'cal.moodW8', 'cal.moodW10', 'cal.moodW10'];

  // ---------- Today: the one open page. Hollow star = nothing written, ringed dot = saving, solid = remembered, dashed = not saved.
  const td = h('section', 'x-td');
  td.setAttribute('aria-label', t('ui.today'));
  td.dataset.st = 'empty';
  td.innerHTML = '<i class="x-nd x-now" aria-hidden="true"></i>'
    + '<div class="x-th"><span class="x-dn"></span><span class="x-dl"><b data-i18n="ui.today">Today</b><small></small></span></div>'
    + '<div class="x-pane glass"><textarea class="x-nt" rows="4" data-i18n-attr="placeholder:journal.ph;aria-label:journal.noteAria" placeholder="What stayed with you today?" aria-label="Today’s note" autocomplete="off" autocapitalize="sentences" spellcheck="true"></textarea>'
    + '<div class="x-ft"><span class="x-st" role="status"></span><button class="x-rt" type="button" hidden data-i18n="journal.retry">Retry</button><span class="x-ct" aria-hidden="true"></span></div></div>';
  tdw.textContent = '';
  tdw.append(td);
  try { core.i18n.applyDom(td); } catch (_) {}
  emp.textContent = t('journal.empty');
  const nowNd = td.querySelector('.x-now'), pane = td.querySelector('.x-pane'), nt = td.querySelector('.x-nt'),
    stEl = td.querySelector('.x-st'), rt = td.querySelector('.x-rt'), ct = td.querySelector('.x-ct');
  td.querySelector('.x-dn').textContent = dfmt(TODAY, { day: 'numeric' });
  td.querySelector('.x-dl small').textContent = dfmt(TODAY, { weekday: 'long' }) + ' · ' + dfmt(TODAY, { month: 'short', year: 'numeric' });

  let st = 'empty', base = '', prev = '', timer = 0, busy = false, again = false, comp = false, full = false;
  const LINE = { empty: 'journal.stEmpty', saved: 'journal.stSaved', saving: 'journal.stSaving' };
  // [data-layer] truncate through the API, never .slice on the string; blank-over-blank is not a change (no pointless delete)
  const dirty = () => { const v = J.truncate(nt.value); return v !== base && (v.trim() !== '' || base.trim() !== ''); };
  function mark(s, m) {
    st = s; td.dataset.st = s; rt.hidden = s !== 'error';
    const msg = s === 'error' ? (m || t('journal.stErr')) : t(LINE[s]);
    if (stEl.textContent !== msg) stEl.textContent = msg;
  }
  const settle = () => mark(base.trim() ? 'saved' : 'empty');
  function fit() { if (!nt.offsetParent) return; nt.style.height = 'auto'; nt.style.height = nt.scrollHeight + 'px'; }
  function count() {
    const L = J.limit, n = J.countNote(nt.value); // [data-layer] code points, never .length
    ct.textContent = n + ' / ' + L;
    td.style.setProperty('--f', (n / L).toFixed(3));
    td.classList.toggle('x-near', n >= L * .9);
    const hit = n >= L && !full;           // true only on the keystroke that arrives at the limit
    full = n >= L;
    if (hit) { td.classList.remove('x-full'); void td.offsetWidth; td.classList.add('x-full'); }
    return hit;
  }
  // 300-code-point cap: an overflowing paste/keystroke is cut from the INSERTED part, so the text you already wrote stays
  function cap() {
    const L = J.limit, v = nt.value;
    if (J.countNote(v) <= L) { prev = v; return; }
    const a = Array.from(prev), b = Array.from(v);
    let p = 0, s = 0;
    while (p < a.length && p < b.length && a[p] === b[p]) p++;
    while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
    const head = b.slice(0, p), mid = b.slice(p, b.length - s), tail = b.slice(b.length - s);
    const keep = head.concat(mid.slice(0, Math.max(0, L - head.length - tail.length)));
    nt.value = J.truncate(keep.concat(tail).join('')); // [data-layer] final guard through the API
    const c = keep.join('').length; // UTF-16 caret offset for setSelectionRange, not a character count
    nt.setSelectionRange(c, c);
    prev = nt.value;
  }
  function onInput(e) {
    if (!comp && !(e && e.isComposing)) cap(); // never rewrite the value in the middle of an IME composition
    fit(); if (count()) burst(ct, 1); charge = Math.min(1, charge + .22);
    clearTimeout(timer); timer = 0;
    if (!dirty()) { if (!busy) settle(); return; }
    mark('saving');
    timer = setTimeout(run, 450);
  }
  async function run() {
    clearTimeout(timer); timer = 0;
    if (busy) { again = true; return; }
    if (!J.writable(TODAY)) return; // [data-layer] only today is writable
    if (!dirty()) { settle(); return; }
    const text = J.truncate(nt.value);
    busy = true; mark('saving');
    let r;
    // [data-layer] the ONLY write path. put never rejects; an empty/whitespace note is the API's delete.
    try { r = await J.put(TODAY, text); } catch (_) { r = null; }
    busy = false;
    if (r && r.ok) {
      base = text;
      if (again) { again = false; run(); return; }
      if (timer) return; // more typing is already queued, stay in "saving"
      settle(); render();
      burst(nowNd, text.trim() ? 1 : -1);
    } else {
      again = false;
      mark('error', r && r.code ? core.errors.text(r.code) : (r && r.message)); // 迭代1（3.0.1）：按 code 走词典映射
    }
  }
  function flush() { clearTimeout(timer); timer = 0; if (dirty()) run(); }
  nt.addEventListener('input', onInput);
  nt.addEventListener('compositionstart', () => { comp = true; });
  nt.addEventListener('compositionend', () => { comp = false; onInput(); });
  nt.addEventListener('blur', flush);
  rt.addEventListener('click', () => run());
  // a Calendar write or a hydrate re-renders; a focused, pending, saving or failed textarea is never overwritten
  function syncToday() {
    const rec = J.get(TODAY); // [data-layer] sync memory read
    if (!busy && !timer && st !== 'error' && document.activeElement !== nt) {
      if (nt.value !== rec.note) { nt.value = rec.note; fit(); }
      base = rec.note; prev = nt.value;
    }
    if (!busy && !timer && st !== 'error' && !dirty()) settle();
    count();
    return rec.note.trim() !== '';
  }

  // ---------- the remembered days: a spine of stars, newest at the top. Each star is one real day with a real note.
  const MON = n => dfmt(n, { month: 'long', year: 'numeric' });
  // 迭代1（3.0.1）：相对日期走词典（数据 token 如 mood_tags 保持原样，属用户数据）
  const rel = d => d === 1 ? t('journal.relYest') : d > 1 ? t('journal.relAgo', { n: d }) : d === -1 ? t('journal.relTmr') : t('journal.relAhead', { n: -d });
  const word = id => { const s = id.replace(/_/g, ' '); return s.charAt(0).toUpperCase() + s.slice(1); };
  function past() {
    // [data-layer] range is sync, hydrated memory only, descending, only days that have a note; today lives in the Today page
    return J.range(TODAY - 36525, TODAY + 36525).filter(r => r.n !== TODAY && r.note.trim() !== '').map(r => {
      const pd = api.isPeriodDay(r.n); // [data-layer] period days only
      return { n: r.n, note: r.note, pd, g: pd ? api.getDaily(r.n) : null };
    });
  }
  function detail(g) {
    const kv = [];
    if (g.flow_level != null) kv.push([t('journal.kvFlow'), t('cal.tier' + M.tierOf(g.flow_level)), g.flow_level + '/10']);
    if (g.pain_present && g.pain_level != null) kv.push([t('journal.kvPain'), core.i18n.t([null, 'cal.painW1', 'cal.painW1', 'cal.painW1', 'cal.painW5', 'cal.painW5', 'cal.painW5', 'cal.painW8', 'cal.painW8', 'cal.painW10', 'cal.painW10'][g.pain_level] || 'cal.painW1'), g.pain_level + '/10']);
    else if (!g.pain_present) kv.push([t('journal.kvPain'), t('journal.kvNone'), '']);
    if (g.mood_level != null) kv.push([t('journal.kvMood'), t(MWK[g.mood_level] || 'cal.moodW6'), g.mood_level + '/10']);
    const tg = Array.isArray(g.mood_tags) ? g.mood_tags.filter(x => typeof x === 'string' && x) : [];
    if (!kv.length && !tg.length) return null;
    const d = h('div', 'x-dt');
    if (kv.length) {
      const row = h('div', 'x-kr');
      kv.forEach(k => { const s = h('span', 'x-kv'); s.append(h('small', '', k[0]), h('b', '', k[1])); if (k[2]) s.append(h('span', '', k[2])); row.append(s); });
      d.append(row);
    }
    if (tg.length) { const u = h('ul', 'x-tg'); tg.forEach(id => u.append(h('li', '', word(id)))); d.append(u); }
    return d;
  }
  function entry(r, pn, i) {
    const n = r.n, e = h('article', 'x-en' + (r.pd ? ' x-pd' : ''));
    e.style.setProperty('--g', clamp(Math.abs(pn - n), 1, 12));                                  // quiet space grows with the days between notes
    e.style.setProperty('--m', Math.sqrt(clamp(J.countNote(r.note) / J.limit, 0, 1)).toFixed(2)); // star magnitude = how much was written
    e.style.setProperty('--i', Math.min(i, 12));
    const nd = h('i', 'x-nd'); nd.setAttribute('aria-hidden', 'true');
    const t = h('time', 'x-eh'); t.dateTime = iso(n);
    const em = h('span', 'x-em'), c = r.pd ? M.cycAt(n) : null;
    em.append(h('b', '', dfmt(n, { weekday: 'long' })), h('small', '', rel(TODAY - n) + (c ? ' · ' + t('journal.periodDay', { n: n - c.s + 1 }) : '')));
    t.append(h('span', 'x-ed', dfmt(n, { day: 'numeric' })), em);
    e.append(nd, t, h('p', 'x-tx', r.note));
    if (r.pd && r.g) { const d = detail(r.g); if (d) e.append(d); }
    return e;
  }
  let sig = null;
  function build(rows) {
    const f = document.createDocumentFragment();
    let pn = TODAY, pm = MON(TODAY);
    rows.forEach((r, i) => {
      const mk = MON(r.n);
      if (mk !== pm) { const m = h('h2', 'x-mo'); m.append(h('span', '', mk)); f.append(m); pm = mk; }
      f.append(entry(r, pn, i)); pn = r.n;
    });
    lst.textContent = '';
    lst.append(f);
  }
  function render() {
    const has = syncToday(), rows = past();
    const s = rows.map(r => r.n + '\u0001' + r.note + '\u0001' + (r.g ? [r.g.flow_level, r.g.pain_present, r.g.pain_level, r.g.mood_level, (r.g.mood_tags || []).join()].join() : '') + (r.pd ? 'p' : '')).join('\u0002');
    if (s !== sig) { sig = s; build(rows); }
    const total = rows.length + (has ? 1 : 0);
    meta.textContent = dfmt(TODAY, { weekday: 'long', month: 'long', day: 'numeric' }) + ' · ' + (total ? t(core.i18n.plural(total, 'journal.metaDays'), { n: total }) : t('journal.metaNone'));
    emp.hidden = total > 0;
  }

  // ---------- sky: one monochrome starfield. Parallax on scroll, gravity waves from touches and saves, a little more light while you write.
  let W = 0, H = 0, D = 1, ctx = null, stars = [], waves = [], sy = 0, sy0 = 0, raf = 0, last = 0, lt = 0, fr = 0, ema = .016, lvl = 0, charge = 0, ink = '255,255,255';
  const ik = a => 'rgba(' + ink + ',' + a + ')';
  const readInk = () => { const v = getComputedStyle(PG).getPropertyValue('--ink').trim(); if (v) ink = v; };
  function seed() {
    const n = clamp(Math.round(W * H / 4600), 56, 140);
    stars = [];
    for (let i = 0; i < n; i++) stars.push({ u: rnd(i, 1), v: rnd(i, 2), z: .15 + .85 * rnd(i, 3) * rnd(i, 3), p: rnd(i, 4) * 6.283, s: .5 + rnd(i, 5) * 1.5 });
  }
  function paint(t, dt) {
    if (!ctx) return;
    const c = ctx, still = reduce, n = stars.length, step = 1 + lvl;
    c.setTransform(D, 0, 0, D, 0, 0); c.clearRect(0, 0, W, H);
    if (!still) { waves = waves.filter(w => t - w.t < 2.2); charge = Math.max(0, charge - dt * .7); }
    for (let i = 0; i < n; i += step) {
      const s = stars[i]; let x = s.u * W, y = still ? s.v * H : ((s.v * H - sy * .14 * s.z) % H + H) % H, b = 1;
      if (!still) {
        for (const w of waves) {
          const a = Math.max(0, t - w.t), dx = x - w.x, dy = y - w.y, d = Math.hypot(dx, dy) || 1, u = (d - a * 360) / 64, k = Math.exp(-u * u - a * 1.5) * w.k;
          x += dx / d * 20 * k; y += dy / d * 20 * k; b += 1.3 * Math.abs(k);
        }
        b += .6 * charge;
      }
      const tw = still ? .8 : .72 + .28 * Math.sin(t * s.s + s.p), al = Math.min(.92, (.16 + .5 * s.z) * tw * b);
      c.fillStyle = ik(al.toFixed(2)); c.beginPath(); c.arc(x, y, .45 + s.z * .85 + (b > 1.5 ? .35 : 0), 0, 6.2832); c.fill();
    }
    if (!still) for (const w of waves) { const a = Math.max(0, t - w.t); c.strokeStyle = ik((.14 * Math.exp(-a * 1.5)).toFixed(3)); c.lineWidth = 1; c.beginPath(); c.arc(w.x, w.y, a * 360, 0, 6.2832); c.stroke(); }
  }
  function tick(ts) {
    raf = 0;
    if (!on || document.hidden) return;
    const t = ts / 1000, iv = Math.min(.05, lt ? t - lt : .016);
    lt = t; fr++;
    if (fr % 45 === 0) readInk();
    ema = ema * .92 + iv * .08;
    if (fr > 90 && ema > .027 && lvl < 2) { lvl++; ema = .016; fr = 0; } // quality ladder: fewer stars, never a different look
    const calm = !waves.length && charge < .02 && Math.abs(sy - sy0) < .5; // nothing moving: twinkle at half rate
    if (!calm || fr % 2 === 0) { paint(t, Math.min(.1, last ? t - last : .016)); last = t; sy0 = sy; }
    raf = requestAnimationFrame(tick);
  }
  function start() { if (!on) return; if (reduce) { paint(0, 0); return; } if (!raf) { last = lt = 0; raf = requestAnimationFrame(tick); } }
  function stop() { if (raf) cancelAnimationFrame(raf); raf = 0; }
  function wave(x, y, k) { if (reduce || !on) return; waves.push({ x, y, t: performance.now() / 1000, k: k || 1 }); if (waves.length > 4) waves.shift(); start(); }
  // spine stars answer a wave with distance-based delay (spring-ish overshoot)
  function pulse(oy) {
    if (reduce) return;
    PG.querySelectorAll('.x-nd').forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.bottom < -60 || r.top > innerHeight + 60) return;
      el.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.9)', offset: .28 }, { transform: 'scale(.86)', offset: .6 }, { transform: 'scale(1)' }],
        { duration: 760, delay: Math.min(Math.abs(r.top + r.height / 2 - oy) * .9, 700), easing: 'cubic-bezier(.2,.9,.1,1)' });
    });
  }
  // a save (outward) or a delete (inward collapse) moves the whole system: sky, spine, shared FX ring
  function burst(el, k) {
    if (reduce) return;
    const r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
    wave(x, y, k); pulse(y);
    if (k > 0 && typeof core.fx === 'function') core.fx({ type: 'ring', x, y, dur: 1000 });
  }

  // ---------- life cycle: the page owns its loop; it sleeps whenever it is not the current page
  const act = () => PG.classList.contains('cur') || PG.classList.contains('entering');
  function size() {
    W = innerWidth; H = innerHeight; D = Math.min(devicePixelRatio || 1, 2);
    cv.width = Math.round(W * D); cv.height = Math.round(H * D);
    ctx = ctx || cv.getContext('2d');
    seed(); readInk(); fit();
    if (on) paint(performance.now() / 1000, 0);
  }
  function enter() {
    on = true;
    if (scrollY) scrollTo(0, 0); // the memory always opens at today
    size(); render();
    PG.classList.remove('x-go'); void PG.offsetWidth; PG.classList.add('x-go'); // replays the spine's arrival
    start();
    wave(W / 2, H * .22, 1);
    try { h1.setAttribute('tabindex', '-1'); h1.focus({ preventScroll: true }); } catch (_) {}
  }
  function leave() { flush(); on = false; stop(); }
  const tog = () => { const a = act(); if (a === on) return; if (a) enter(); else leave(); };
  new MutationObserver(tog).observe(PG, { attributes: true, attributeFilter: ['class'] });
  let rz = 0; // belt and braces: core calls size(), but a rotation must never leave a stretched sky
  addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (on) size(); }, 120); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { flush(); stop(); } else if (on) start(); });
  addEventListener('pagehide', flush);
  if (mq.addEventListener) mq.addEventListener('change', () => { reduce = mq.matches; waves = []; if (on) { stop(); start(); } });

  // ---------- interaction
  bk.addEventListener('click', e => {
    flush();
    const o = pt(e, bk);
    if (!reduce && typeof core.fx === 'function') core.fx({ type: 'ring', x: o.x, y: o.y, dur: 900 });
    core.nav(1, { origin: o }); // back to Calendar
  });
  PG.addEventListener('pointerdown', e => { if (e.target.closest && !e.target.closest('.x-nt')) { wave(e.clientX, e.clientY, 1); pulse(e.clientY); } }, { passive: true });
  let lp = null;
  const lit = () => {
    const e = lp; lp = null; if (!e) return;
    const r = pane.getBoundingClientRect();
    pane.style.setProperty('--px', (e.clientX - r.left) + 'px');
    pane.style.setProperty('--py', (e.clientY - r.top) + 'px');
    pane.style.setProperty('--ang', (Math.atan2(e.clientY - r.top - r.height / 2, e.clientX - r.left - r.width / 2) * 57.2958 + 90).toFixed(0) + 'deg');
  };
  const aim = e => { if (!lp) requestAnimationFrame(lit); lp = e; };
  PG.addEventListener('pointermove', aim, { passive: true });
  PG.addEventListener('pointerdown', aim, { passive: true });

  render();
  tog(); // lazy boot: the page may already be current
  // 迭代1（3.0.1）：本页唯一 'lang' 监听 —— 重放 applier、重写状态行/日期/空态与列表
  try { core.on('lang', () => { core.i18n.applyDom(td); emp.textContent = t('journal.empty'); td.setAttribute('aria-label', t('ui.today')); td.querySelector('.x-dn').textContent = dfmt(TODAY, { day: 'numeric' }); td.querySelector('.x-dl small').textContent = dfmt(TODAY, { weekday: 'long' }) + ' · ' + dfmt(TODAY, { month: 'short', year: 'numeric' }); settle(); render(); }); } catch (_) {}
  return {
    size,
    setSY(y) { const v = +y; if (isFinite(v)) sy = v; },
    refresh: render
  };
}

/* entry: Calendar header → #jrn opens Journal (page index 5). Bound at load, before any boot; an absent entry does nothing. */
(function () {
  'use strict';
  var done = new WeakSet();
  function bind() {
    var b = document.getElementById('jrn');
    if (!b) return false;
    if (done.has(b)) return true;
    done.add(b);
    b.addEventListener('click', function (e) {
      if (typeof core === 'undefined' || !core || typeof core.nav !== 'function') return;
      var x = e.clientX, y = e.clientY;
      if (!x && !y) { var r = b.getBoundingClientRect(); x = r.left + r.width / 2; y = r.top + r.height / 2; }
      if (typeof core.fx === 'function' && !matchMedia('(prefers-reduced-motion:reduce)').matches) core.fx({ type: 'ring', x: x, y: y, dur: 900 });
      core.nav(5, { origin: { x: x, y: y } });
    });
    return true;
  }
  if (!bind() && document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, { once: true });
})();
