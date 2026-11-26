core.register([{id:'today',factory:boot_today},{id:'cal',factory:boot_cal},{id:'hist',factory:boot_hist},{id:'ins',factory:boot_ins},{id:'you',factory:boot_you},{id:'journal',factory:boot_journal}]);
// Auth restore owns the startup order now: bootstrap only validates/restores the session and never
// commits. Real mode then hydrates only when authenticated and commits exactly once (linked or
// unauthenticated, hydrate success/failure). Mock resolves without requests and must NOT commit at
// startup, so file:// keeps its seeded data and badge-free boot.
function startupCommit() {
  if (core.api._mode === 'real') core.commit('api');
}
function authEvent() {
  try { core.emit('auth', core.api.auth.state()); } catch (_) {}
}

// ================= Android host deep link (notification -> Calendar) =================
// The host's only navigation contract. It evaluates window.__piqNavigate(page) once the page is
// loaded (and again after a successful login); the target is mirrored in sessionStorage so the login
// flow (auth.js reloads after a successful sign-in) still lands on Calendar. Returns '1' = navigated
// (or already there), 'pending' = stored until auth passes, '0' = unknown page / not ready.
var PIQ_NAV_PAGES = { today: 0, calendar: 1, history: 2, insights: 3, you: 4, journal: 5 };
var PIQ_NAV_IDS = ['today', 'cal', 'hist', 'ins', 'you', 'journal'];
var PIQ_NAV_KEY = 'piq_nav_target';
function piqNavIndex(target) {
  return Object.prototype.hasOwnProperty.call(PIQ_NAV_PAGES, target) ? PIQ_NAV_PAGES[target] : -1;
}
function piqNavAuthed() {
  try { var s = core.api.auth.state(); return !!(s && s.authed); } catch (_) { return false; }
}
function piqNavStored() {
  try { return sessionStorage.getItem(PIQ_NAV_KEY) || ''; } catch (_) { return ''; }
}
function piqNavStore(target) {
  try {
    if (target) sessionStorage.setItem(PIQ_NAV_KEY, target);
    else sessionStorage.removeItem(PIQ_NAV_KEY);
  } catch (_) {}
}
function piqNavApply(target) {
  var idx = piqNavIndex(target);
  if (idx < 0) return false;
  if (core.isCur(PIQ_NAV_IDS[idx])) return true;
  try { core.nav(idx); } catch (_) { return false; }
  return true;
}
window.__piqNavigate = function (target) {
  try {
    if (piqNavIndex(target) < 0) return '0';
    if (!piqNavAuthed()) { piqNavStore(target); return 'pending'; }
    return piqNavApply(target) ? '1' : '0';
  } catch (_) { return '0'; }
};
// After auth settles: consume a target stored while the gate was closed (post-login reload path).
function piqConsumeNav() {
  if (!piqNavAuthed()) return;
  var target = piqNavStored();
  if (!target) return;
  if (piqNavApply(target)) piqNavStore('');
}

// The auth gate must not flash the signed-in shell: html.piq-boot (markup) hides #app and #dock and
// shows the themed boot layer until the auth conclusion is known and the gate/app has been decided.
function finishStartup() {
  try { piqConsumeNav(); } catch (_) {}
  try { document.documentElement.classList.remove('piq-boot'); } catch (_) {}
}

function start() {
  try {
    core.api.auth.bootstrap().then(function (r) {
      if (core.api._mode !== 'real') { authEvent(); finishStartup(); return; }
      var authed = !!(r && r.ok && r.data && r.data.authed);
      if (!authed) { startupCommit(); authEvent(); finishStartup(); return; }
      try {
        core.api.hydrate().then(function () { startupCommit(); authEvent(); finishStartup(); }, function () { startupCommit(); authEvent(); finishStartup(); });
      } catch (_) {
        startupCommit();
        authEvent();
        finishStartup();
      }
    }, function () { startupCommit(); authEvent(); finishStartup(); });
  } catch (_) {
    startupCommit();
    authEvent();
    finishStartup();
  }
}
// Wait for DOMContentLoaded so the auth gate's controller (pages/auth.js) is bound before the auth
// conclusion is emitted and the boot layer is removed (main.js is the last script in the document).
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
else start();
