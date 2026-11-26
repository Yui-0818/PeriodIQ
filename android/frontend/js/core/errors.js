/* PeriodIQ data-layer error adapter (classic script; no ES modules).
 * Contract: success {ok:true,status,data}; failure {ok:false,status,code,message[,field|anomalies]}.
 * Real backend errors are {detail,code[,anomalies]}. ERROR_TEXT is the built-in English fallback
 * table (English is the only shipped language as of 3.1.3); core.i18n.errorText (when loaded)
 * takes priority. Every constructor resolves `message` through
 * text(): known code -> mapped text, unknown code -> the HTTP_ERROR text, so `message` is always the
 * localized, user-facing line. Raw backend/dynamic strings (detail, an explicit network message, the
 * not-wired feature name, an import/internal reason) stay verbatim in out.detail and pages must
 * consume `message` only. There is no `total`: DATA_ANOMALY consumers count `anomalies.length`.
 */
(function () {
  var ERROR_TEXT = {
    UNAUTHORIZED: 'Your session has expired. Please sign in again.',
    AUTH_FAILED: 'Incorrect username or password.',
    USERNAME_TAKEN: 'That username is already taken.',
    TOO_MANY_ATTEMPTS: 'Too many attempts. Please try again later.',
    VALIDATION_ERROR: 'The submitted data is invalid. Please check it and try again.',
    DATE_OVERLAP: 'These dates overlap an existing period. Adjust the neighbouring records first.',
    INVALID_PERIOD_END: 'The end date cannot be earlier than the start date.',
    NOT_FOUND: 'This record does not exist; it may have been deleted.',
    HTTP_ERROR: 'The request failed. Please try again later.',
    INTERNAL_ERROR: 'Internal error in the local service. Please try again later.',
    EMPTY_IMPORT: 'This file contains no period records, so it cannot be imported.',
    INVALID_IMPORT: 'This file is not a valid PeriodIQ backup.',
    INVALID_DAILY: 'The daily details in this file are invalid.',
    IMPORT_TOO_LARGE: 'This backup is too large and exceeds the 8 MB import limit on this device.',
    DATA_ANOMALY: 'The file contains unusual records. Nothing was written.',
    NOT_PERIOD_DAY: 'This day is not part of a period, so daily details cannot be entered.',
    JOURNAL_READONLY: 'Past dates are read-only: their journal entries cannot be edited.',
    WRONG_PASSWORD: 'Incorrect password.',
    PERSISTENCE_UNAVAILABLE: 'The session cannot be saved on this device right now. Please try again later.'
  };
  var GENERIC = 'The request failed. Please try again later.';

  // code -> user-facing text; unknown codes (and a missing code) fall back to the generic line.
  // Local gates call this directly (e.g. you.js for IMPORT_TOO_LARGE) so no page keeps a table.
  function text(code) {
    try {
      if (core.i18n && core.i18n.errorText) {
        var t = core.i18n.errorText(code);
        if (t) return t;
      }
    } catch (_) {}
    return typeof code === 'string' && Object.prototype.hasOwnProperty.call(ERROR_TEXT, code) ? ERROR_TEXT[code] : GENERIC;
  }

  // Does a user-facing text exist for this code? Lookup chain matches text(): dictionary first,
  // then the built-in English fallback table. An unknown code is not an error; it just gets HTTP_ERROR text.
  function known(code) {
    if (typeof code !== 'string' || !code) return false;
    try {
      if (core.i18n && core.i18n.errorText && core.i18n.errorText(code)) return true;
    } catch (_) {}
    return Object.prototype.hasOwnProperty.call(ERROR_TEXT, code);
  }

  function success(status, data) {
    return { ok: true, status: status, data: data };
  }

  function fromHttp(status, body) {
    var b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    var code = typeof b.code === 'string' && b.code ? b.code : (status === 422 ? 'VALIDATION_ERROR' : 'HTTP_ERROR');
    var detail = typeof b.detail === 'string' && b.detail ? b.detail : '';
    // Known code -> its localized text; an unknown code keeps `code` verbatim but shows the
    // localized HTTP_ERROR line, so raw backend detail never leaks into `message`.
    var message = known(code) ? text(code) : text('HTTP_ERROR');
    var out = { ok: false, status: status, code: code, message: message };
    if (detail) out.detail = detail;
    else if (b.detail != null) out.detail = b.detail;
    if (typeof b.field === 'string') out.field = b.field;
    if (code === 'DATA_ANOMALY' || Array.isArray(b.anomalies)) {
      out.anomalies = Array.isArray(b.anomalies) ? b.anomalies : [];
    }
    return out;
  }

  function network(message) {
    var out = { ok: false, status: 0, code: 'NETWORK_ERROR', message: text('NETWORK_ERROR') };
    if (typeof message === 'string' && message) out.detail = message;
    return out;
  }

  function bridgeUnavailable() {
    return {
      ok: false, status: 0, code: 'BRIDGE_UNAVAILABLE',
      message: text('BRIDGE_UNAVAILABLE')
    };
  }

  function badResponse(status) {
    return {
      ok: false, status: status || 0, code: 'BAD_RESPONSE',
      message: text('BAD_RESPONSE')
    };
  }

  function notWired(what) {
    var out = { ok: false, status: 501, code: 'NOT_WIRED', message: text('NOT_WIRED') };
    if (typeof what === 'string' && what) out.detail = what;
    return out;
  }

  function invalidImport(message) {
    var out = { ok: false, status: 400, code: 'INVALID_IMPORT', message: text('INVALID_IMPORT') };
    if (typeof message === 'string' && message) out.detail = message;
    return out;
  }

  function internal(message) {
    var out = { ok: false, status: 500, code: 'ADAPTER_ERROR', message: text('ADAPTER_ERROR') };
    if (typeof message === 'string' && message) out.detail = message;
    return out;
  }

  core.errors = {
    text: text,
    success: success,
    fromHttp: fromHttp,
    network: network,
    bridgeUnavailable: bridgeUnavailable,
    badResponse: badResponse,
    notWired: notWired,
    invalidImport: invalidImport,
    internal: internal
  };
})();
