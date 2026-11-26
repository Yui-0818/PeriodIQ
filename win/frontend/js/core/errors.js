/* PeriodIQ data-layer error adapter (classic script; no ES modules).
 * Contract: success {ok:true,status,data}; failure {ok:false,status,code,message[,field|anomalies]}.
 * Real backend errors are {detail,code[,anomalies]}. ERROR_TEXT is the default zh-CN fallback table;
 * core.i18n.errorText (when loaded) takes priority. Every constructor resolves `message` through
 * text(): known code -> mapped text, unknown code -> the HTTP_ERROR text, so `message` is always the
 * localized, user-facing line. Raw backend/dynamic strings (detail, an explicit network message, the
 * not-wired feature name, an import/internal reason) stay verbatim in out.detail and pages must
 * consume `message` only. There is no `total`: DATA_ANOMALY consumers count `anomalies.length`.
 */
(function () {
  var ERROR_TEXT = {
    UNAUTHORIZED: '登录状态已失效，请重新登录。',
    AUTH_FAILED: '用户名或密码错误。',
    USERNAME_TAKEN: '这个用户名已经被占用。',
    TOO_MANY_ATTEMPTS: '尝试次数过多，请稍后再试。',
    VALIDATION_ERROR: '提交的内容不合法，请检查后重试。',
    DATE_OVERLAP: '这段日期与已有周期重叠，请先调整相邻记录。',
    INVALID_PERIOD_END: '结束日期不能早于开始日期。',
    NOT_FOUND: '记录不存在，可能已被删除。',
    HTTP_ERROR: '请求失败，请稍后重试。',
    INTERNAL_ERROR: '本机服务内部错误，请稍后重试。',
    EMPTY_IMPORT: '这个文件里没有周期记录，无法导入。',
    INVALID_IMPORT: '这个文件不是有效的 PeriodIQ 备份。',
    INVALID_DAILY: '这个文件里的每日详情不合法。',
    IMPORT_TOO_LARGE: '这份备份太大了，超过了本机 8 MB 的导入上限。',
    DATA_ANOMALY: '文件里有看起来不寻常的记录，本次没有写入任何数据。',
    NOT_PERIOD_DAY: '这一天不在经期内，不能填每日详情。',
    JOURNAL_READONLY: '过去的日期只能查看日记，不能再修改。',
    WRONG_PASSWORD: '密码不正确。',
    PERSISTENCE_UNAVAILABLE: '本机暂时无法保存登录状态，请稍后重试。'
  };
  var GENERIC = '请求失败，请稍后重试。';

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
  // then the zh-CN fallback table. An unknown code is not an error; it just gets HTTP_ERROR text.
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
