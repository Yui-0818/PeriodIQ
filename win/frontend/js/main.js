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
try {
  core.api.auth.bootstrap().then(function (r) {
    if (core.api._mode !== 'real') { authEvent(); return; }
    var authed = !!(r && r.ok && r.data && r.data.authed);
    if (!authed) { startupCommit(); authEvent(); return; }
    try {
      core.api.hydrate().then(function () { startupCommit(); authEvent(); }, function () { startupCommit(); authEvent(); });
    } catch (_) {
      startupCommit();
      authEvent();
    }
  }, function () { startupCommit(); authEvent(); });
} catch (_) {
  startupCommit();
  authEvent();
}
