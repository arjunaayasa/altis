// The script of the operations page `/admin/_update` (spec §9.4, §10.2; plan Task 19), inlined by ops/update-page.tsx
// under the page's CSP nonce. It is plain ES2017 text (the page needs no SPA asset: during a restore every other route
// is closed): no `eval`, no inline handler, no newer syntax (test/db/update-page.test.ts checks it), and it reads the
// page through `textContent` and writes it the same way, never as HTML. test/update-script.test.ts runs it in a DOM.
//
// What it reads from the page:
//   <script type="application/json" id="i18n">   the texts of `ops.kind.*`, `ops.state.*`, `ops.page.*` and the
//                                                 `error.*` texts the page may need
//   <script type="application/json" id="state">  {op: OpView | null, csrfToken: string | null, session: boolean,
//                                                 sessionCsrfToken: string | null, totp: boolean}
//
// What it does:
//   - every 2 s `GET /api/v1/ops/current` (`X-Altis-Background: 1`, so the poll never keeps a session alive) and shows
//     the op: kind, state, progress, message and error; 404 OPS_NONE shows "no operation";
//   - while the op is `driveable` and the server runs in `external` mode (no worker: spec §10.2), `POST ops/drive`
//     (each call ≤ 20 s on the server, P9) with the page's `X-CSRF-Token` (the op's token for the `altis_ops` cookie,
//     else the session's). Calls follow back to back only while they do work: a call that came back within 1 s or
//     left the op as it was (same state, progress, message and heartbeat: a freeze settling, another process holding
//     the step lock, a kind this process cannot step) waits 1.5 s before the next, and a failed call 2 s, so an open
//     page never floods a shared host;
//   - Lanjutkan (`#resume`, an op in `needs_attention`): `POST ops/drive {resume: true}`;
//   - Batalkan (`#cancel`, only before the point of no return) and Ambil alih (`#takeover`, while the page does not
//     hold the op's token), on a page a session holds: `POST ops/cancel` (after a confirmation) or `POST ops/takeover`.
//     Both need a fresh re-authentication (ruling R1c-9): a 401 AUTH_REAUTH_REQUIRED opens the `#reauth` form (the
//     password, plus the authenticator code when the user has 2FA), which posts `auth/reauth` with the session's CSRF
//     token and then repeats the action once. A refusal of the action shows its `error.<CODE>` text and the page keeps
//     following the op. A takeover gives the page the op's own token (and the browser the `altis_ops` cookie). On a page
//     without a session `#cancel` is the server's link to the sign-in that comes back here (hidden during a restore,
//     whose sign-in is closed). Final review: while an action is under way or the form waits (60 s at most, the page
//     may be the op's only driver), the page starts no drive (its own drives kept the step lock busy), and an action
//     answered 409 OPS_IN_PROGRESS (a step held the lock through the server's wait) is sent again, twice at most;
//   - Unduh laporan (`#report`): shown once `GET ops/report` answers 200 for an op that ended or needs attention (the
//     probe reads the status only and cancels the body);
//   - the CLI lines (`#cli`, @altis/shared/api/ops opCliLines) for `restore_failed`, a restore that `failed` after
//     `failed_restoring_pre` (seen here, or a failed restore past its point of no return, which always went back to
//     `pre_restore` first) and `needs_attention` (`ops:resume`, `ops:cancel`; final review OPS-ATTN-EXIT);
//   - on `done`, back to `/admin` after 3 s.
// A 401/403 on a poll or a drive (the cookie expired an hour after the op ended, the session went, the token was
// refused) stops the page; on a page held by a session alone, only the fifth 401 OPS_AUTH_REQUIRED in a row does (a
// process waiting in ops_wait reads no session; final review). The session's token follows the session when the server rotates it (`X-CSRF-Token` on a
// response); the op's own token never changes.
//
// 1d Task 29 (spec §9.6, §9.7, §9.8; preflight 1D-27):
//   - SSE when it is available (`#state`'s `sse`: a session that reads `system.update`, SSE on): an EventSource on
//     `GET events/stream?channels=system.update`; each `op.progress` (or `expired`) hint polls `ops/current` at once,
//     and while the stream is open an update or rollback op is polled every 10 s only, as a backstop. A stream that
//     fails or closes (409 with SSE off, 204 with no free slot, 503 from app.js while a pending release boots) leaves
//     the 2 s polling, which is all app.js's own page ever does;
//   - an update op: `#db-restore` (`ops.page.db_restore_needed`) while its view says `update.dbRestoreNeeded`, and for
//     `UPDATE_SCHEMA_HOLD_FAILED` with a backup `#schema-hold` (`ops.page.schema_hold` naming the backup id);
//   - the CLI lines of an update in `restore_failed` add `release:rollback` (but not for a schemaHold failure);
//   - while no op runs (none, or the one shown ended), `#bundled`: a newer bundled release whose prechecks failed, read
//     from `GET updates/status` once each time the page comes to that state (the server renders it first), each failure
//     named by `update.precheck.<failure>`. Built with createElement and textContent, never as HTML.

/** The page script (see the top of this file). */
export const UPDATE_PAGE_SCRIPT = `(function () {
  'use strict';
  var API = '/api/v1/';
  var POLL_MS = 2000;
  var RETRY_MS = 2000;
  var BUSY_MS = 1000;
  var PACE_MS = 1500;
  var DONE_RETURN_MS = 3000;
  var SIX_DIGITS = /^[0-9]{6}$/;
  /** 1d Task 29: the backstop poll of an update or rollback op while the SSE stream is open. */
  var SSE_POLL_MS = 10000;
  var SSE_PATH = API + 'events/stream?channels=system.update';
  var SCHEMA_HOLD_FAILED = 'UPDATE_SCHEMA_HOLD_FAILED';
  var PLACEHOLDER = /\\{([A-Za-z_][A-Za-z0-9_]*)\\}/g;

  function byId(id) {
    return document.getElementById(id);
  }
  function readJson(id) {
    var node = byId(id);
    if (!node) return null;
    try {
      return JSON.parse(node.textContent || 'null');
    } catch (error) {
      return null;
    }
  }

  var texts = readJson('i18n') || {};
  var boot = readJson('state') || {};
  var hasSession = boot.session === true;
  var current = boot.op || null;
  // The op's own token (the altis_ops cookie, or a takeover) never changes; without it the ops calls carry the
  // session's, which also re-authenticates, and which follows the session when the server rotates it.
  var opToken = current && typeof current.csrfToken === 'string' ? current.csrfToken : null;
  var sessionCsrf = typeof boot.sessionCsrfToken === 'string' ? boot.sessionCsrfToken : null;
  if (sessionCsrf === null && opToken === null && typeof boot.csrfToken === 'string') sessionCsrf = boot.csrfToken;
  var seenRestoringPre = false;
  var driving = false;
  var stopped = false;
  var leaving = false;
  var reportKey = null;
  /** The action ('cancel' or 'takeover') the reauth form repeats once it succeeds. */
  var pending = null;
  /** When the reauth form opened (Date.now()): it holds the drive loop for REAUTH_HOLD_MS at most (final review G2). */
  var pendingSince = 0;
  var REAUTH_HOLD_MS = 60000;
  /** Cancel, takeover or resume requests under way: the drive loop starts no call meanwhile (final review). */
  var acting = 0;
  /** 401 OPS_AUTH_REQUIRED answers in a row to a page that holds only a session (see take). */
  var refusals = 0;
  var REFUSALS_MAX = 5;
  // 1d Task 29: the poll loop (one timer), the SSE stream, the bundled release shown while no op runs.
  var pollTimer = null;
  var polling = false;
  var pollAgain = false;
  var stream = null;
  var sseLive = false;
  var bundledKey = current ? current.opId + ':' + current.state : 'none';

  function text(key, fallback) {
    var value = texts[key];
    if (typeof value === 'string') return value;
    return fallback === undefined ? key : fallback;
  }
  function errorText(code) {
    return text('error.' + code, text('ops.page.error') + ': ' + code);
  }
  /** A text's {name} placeholders filled from params (one pass, as the shared t() does). */
  function fill(template, params) {
    return template.replace(PLACEHOLDER, function (whole, name) {
      return Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole;
    });
  }
  function show(node, visible) {
    if (node) node.hidden = !visible;
  }
  function setText(id, value) {
    var node = byId(id);
    if (node) node.textContent = value;
  }
  function setStatus(value) {
    setText('status', value);
    show(byId('status'), value !== '');
  }
  function wait(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }
  function opsToken() {
    return opToken !== null ? opToken : sessionCsrf;
  }

  /**
   * The CLI way out (@altis/shared/api/ops opCliLines): ops:resume (and ops:cancel before the point of no return)
   * for a stuck op, ops:cancel then maintenance:off or a restore for an op.json nobody can read,
   * maintenance:off --force, backup:restore and release:rollback for a failed update revert (without release:rollback
   * after a schemaHold failure), and maintenance:off --force then backup:restore for a restore that failed after going
   * back to pre_restore.
   */
  function cliLines(op) {
    if (!op) return [];
    var restore = 'node app.js backup:restore ' + (op.backupId || '<backupId>');
    if (op.needsAttention === true) {
      if (op.startedAt === null) return ['node app.js ops:cancel', 'node app.js maintenance:off', restore];
      return op.pointOfNoReturn === true ? ['node app.js ops:resume'] : ['node app.js ops:resume', 'node app.js ops:cancel'];
    }
    var schemaHold = !!op.error && op.error.code === SCHEMA_HOLD_FAILED;
    if (op.kind === 'update' && op.state === 'restore_failed' && !schemaHold) {
      return ['node app.js maintenance:off --force', restore, 'node app.js release:rollback'];
    }
    var failedRestore = op.kind === 'restore' && op.state === 'failed' && (seenRestoringPre || op.pointOfNoReturn === true);
    if (op.state === 'restore_failed' || failedRestore) return ['node app.js maintenance:off --force', restore];
    return [];
  }

  /** Cancel is offered before the point of no return; without a session (a sign-in link) never during a restore. */
  function cancellable(op) {
    return !!op && op.terminal !== true && op.pointOfNoReturn !== true && (hasSession || op.kind !== 'restore');
  }

  /** A session takes the op over while the page does not hold its token (past a restore's PONR no session is read). */
  function takeoverable(op) {
    if (!hasSession || !op || op.terminal === true || opToken !== null) return false;
    return !(op.kind === 'restore' && op.pointOfNoReturn === true);
  }

  async function request(method, path, body, background, token) {
    var headers = { Accept: 'application/json' };
    if (background) headers['X-Altis-Background'] = '1';
    var sent = token === undefined ? opsToken() : token;
    if (method !== 'GET' && sent !== null) headers['X-CSRF-Token'] = sent;
    var init = { method: method, headers: headers, credentials: 'same-origin', cache: 'no-store' };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    var res = await fetch(API + path, init);
    var rotated = res.headers.get('X-CSRF-Token');
    if (rotated && sessionCsrf !== null) sessionCsrf = rotated;
    var raw = await res.text();
    var data = null;
    try {
      data = raw === '' ? null : JSON.parse(raw);
    } catch (error) {
      data = null;
    }
    return { status: res.status, ok: res.ok, data: data };
  }

  function codeOf(reply) {
    return reply.data && typeof reply.data.code === 'string' ? reply.data.code : null;
  }

  /** The page cannot follow the op any more: no more polls, drives or probes. */
  function lost() {
    stopped = true;
    stopStream();
    closeReauth();
    setStatus(text('ops.page.lost'));
  }

  /** Shows what a reply says of the op; true when it was the op (or "no op"), false for anything else. */
  function take(reply) {
    if (reply.ok && reply.data && typeof reply.data.state === 'string') {
      refusals = 0;
      setStatus('');
      render(reply.data);
      return true;
    }
    if (reply.status === 404 && codeOf(reply) === 'OPS_NONE') {
      refusals = 0;
      setStatus('');
      render(null);
      return true;
    }
    // A process that boots during the op waits in ops_wait and reads no session (C40): with several processes a
    // page held by a session alone meets one now and then. Only refusals in a row mean the session is gone.
    var sessionOnly = hasSession && opToken === null && reply.status === 401 && codeOf(reply) === 'OPS_AUTH_REQUIRED';
    if (sessionOnly && (refusals += 1) < REFUSALS_MAX) {
      setStatus(text('ops.page.retrying'));
      return false;
    }
    if (reply.status === 401 || reply.status === 403) {
      lost();
      return false;
    }
    if (reply.data && reply.data.code) setStatus(errorText(reply.data.code));
    else setStatus(text('ops.page.retrying'));
    return false;
  }

  async function checkReport(op) {
    var key = op && op.opId ? op.opId + ':' + op.state : null;
    if (key === reportKey) return;
    reportKey = key;
    var link = byId('report');
    if (!op || !(op.terminal === true || op.needsAttention === true) || stopped) {
      show(link, false);
      return;
    }
    try {
      var res = await fetch(API + 'ops/report', {
        headers: { 'X-Altis-Background': '1' },
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (res.body && typeof res.body.cancel === 'function') res.body.cancel().catch(function () {});
      if (key === reportKey) show(link, res.ok);
    } catch (error) {
      if (key === reportKey) show(link, false);
    }
  }

  function render(op) {
    current = op;
    if (op && typeof op.csrfToken === 'string') opToken = op.csrfToken;
    if (op && op.state === 'failed_restoring_pre') seenRestoringPre = true;
    show(byId('op'), !!op);
    show(byId('op-none'), !op);
    if (op) {
      setText('op-kind', op.kind ? text('ops.kind.' + op.kind) : '-');
      setText('op-state', text('ops.state.' + op.state, op.state));
      var percent = Math.max(0, Math.min(100, Math.round(Number(op.progress) || 0)));
      var bar = byId('op-progress');
      if (bar) bar.value = percent;
      setText('op-percent', percent + '%');
      setText('op-message', op.message || '');
      show(byId('op-message'), !!op.message);
      var error = op.error ? op.error.code + (op.error.detail ? ' (' + op.error.detail + ')' : '') : '';
      setText('op-error-text', error);
      show(byId('op-error'), error !== '');
      // 1d Task 29: "pemulihan DB diperlukan bila gagal"; the schemaHold instruction naming the backup.
      show(byId('db-restore'), !!op.update && op.update.dbRestoreNeeded === true);
      var hold = !!op.error && op.error.code === SCHEMA_HOLD_FAILED && typeof op.backupId === 'string';
      setText('schema-hold', hold ? fill(text('ops.page.schema_hold'), { backupId: op.backupId }) : '');
      show(byId('schema-hold'), hold);
    }
    show(byId('resume'), !!op && op.needsAttention === true && op.startedAt !== null);
    show(byId('cancel'), cancellable(op));
    show(byId('takeover'), takeoverable(op));
    // The action the open reauth form would repeat is no longer on offer.
    if ((pending === 'cancel' && !cancellable(op)) || (pending === 'takeover' && !takeoverable(op))) closeReauth();
    show(byId('drive-hint'), !!op && op.mode === 'external' && op.driveable === true);
    var lines = cliLines(op);
    show(byId('cli'), lines.length > 0);
    if (lines.length > 0) setText('cli-lines', lines.join('\\n'));
    show(byId('back'), !op || op.terminal === true);
    var done = !!op && op.state === 'done';
    show(byId('done'), done);
    if (done && !leaving) {
      leaving = true;
      stopStream();
      setTimeout(function () {
        window.location.assign('/admin');
      }, DONE_RETURN_MS);
    }
    checkReport(op);
    refreshBundled(op);
    if (op && op.driveable === true && op.mode === 'external') drive();
  }

  // ---- 1d Task 29: the bundled release blocked by its prechecks, while no op runs ----

  function showBundled(blocked) {
    var section = byId('bundled');
    if (!section) return;
    if (!blocked || typeof blocked.version !== 'string') {
      show(section, false);
      return;
    }
    setText('bundled-text', fill(text('ops.page.bundled_blocked'), { version: blocked.version }));
    var list = byId('bundled-failures');
    if (list) {
      while (list.firstChild) list.removeChild(list.firstChild);
      var failures = Array.isArray(blocked.failures) ? blocked.failures : [];
      for (var i = 0; i < failures.length; i += 1) {
        var item = document.createElement('li');
        item.textContent = text('update.precheck.' + failures[i], String(failures[i]));
        list.appendChild(item);
      }
    }
    show(section, true);
  }

  /** Asks GET updates/status once each time the page comes to a state without a running op (see the top). */
  async function refreshBundled(op) {
    var key = op ? op.opId + ':' + op.state : 'none';
    if (key === bundledKey) return;
    bundledKey = key;
    if (op && op.terminal !== true) {
      show(byId('bundled'), false);
      return;
    }
    if (stopped) return;
    try {
      var reply = await request('GET', 'updates/status', undefined, true);
      if (key === bundledKey && reply.ok && reply.data) showBundled(reply.data.bundledBlocked || null);
    } catch (error) {
      // the next change of state asks again
    }
  }

  /** Whether the op moved between two views of it: another state, progress, message or heartbeat. */
  function changed(before, after) {
    if (!before || !after) return before !== after;
    return (
      before.state !== after.state ||
      before.progress !== after.progress ||
      before.message !== after.message ||
      before.heartbeatAt !== after.heartbeatAt
    );
  }

  /**
   * Whether the drive loop holds back: an action is under way or the reauth form waits for its password. The server
   * lets a cancel or takeover go ahead of the steppers, but this page's own drives would keep the step lock busy. A form
   * left open holds it for REAUTH_HOLD_MS at most (final review G2): this page may be the op's only driver, and an op
   * nobody steps stalls into needs_attention after 15 minutes. The next poll then drives again.
   */
  function held() {
    return acting > 0 || (pending !== null && Date.now() - pendingSince < REAUTH_HOLD_MS);
  }

  /** Drives again (when the op can move) once nothing holds the loop back any more. */
  function resumeDriving() {
    if (!held() && current && current.driveable === true && current.mode === 'external') drive();
  }

  async function drive() {
    if (driving || held()) return;
    driving = true;
    try {
      while (!stopped && !leaving && !held() && current && current.driveable === true && current.mode === 'external') {
        var before = current;
        var startedAt = Date.now();
        var answered = false;
        try {
          answered = take(await request('POST', 'ops/drive', {}));
        } catch (error) {
          setStatus(text('ops.page.retrying'));
        }
        // Back to back only while the calls do work (see the top of this file).
        if (!answered) await wait(RETRY_MS);
        else if (Date.now() - startedAt < BUSY_MS || !changed(before, current)) await wait(PACE_MS);
      }
    } finally {
      driving = false;
    }
  }

  /** The pause before the next poll: 2 s, or 10 s for an update or rollback op while the SSE stream is open. */
  function pollDelay() {
    return sseLive && current && (current.kind === 'update' || current.kind === 'rollback') ? SSE_POLL_MS : POLL_MS;
  }

  /** (Re)sets the one poll timer: ms from now, else pollDelay(). */
  function schedulePoll(ms) {
    if (pollTimer !== null) clearTimeout(pollTimer);
    pollTimer = null;
    if (stopped || leaving) return;
    pollTimer = setTimeout(poll, ms === undefined ? pollDelay() : ms);
  }

  async function poll() {
    pollTimer = null;
    if (stopped || leaving) return;
    if (polling) {
      pollAgain = true; // the poll under way schedules the next one
      return;
    }
    polling = true;
    try {
      take(await request('GET', 'ops/current', undefined, true));
    } catch (error) {
      setStatus(text('ops.page.retrying'));
    } finally {
      polling = false;
    }
    if (pollAgain) {
      pollAgain = false;
      schedulePoll(0);
    } else {
      schedulePoll();
    }
  }

  // ---- 1d Task 29 (preflight 1D-27): SSE on system.update when available ----

  function stopStream() {
    if (stream !== null) stream.close();
    stream = null;
    sseLive = false;
  }

  function startStream() {
    if (boot.sse !== true || typeof EventSource !== 'function' || stream !== null || stopped) return;
    var source;
    try {
      source = new EventSource(SSE_PATH);
    } catch (error) {
      return;
    }
    stream = source;
    source.addEventListener('open', function () {
      if (stream !== source) return;
      sseLive = true;
      schedulePoll();
    });
    // Events are hints (spec §10.6): each one makes the page read the op at once.
    source.addEventListener('op.progress', function () {
      if (stream === source) schedulePoll(0);
    });
    source.addEventListener('expired', function () {
      if (stream === source) schedulePoll(0);
    });
    source.addEventListener('error', function () {
      if (stream !== source) return;
      sseLive = false;
      // CLOSED: the stream was refused (SSE off, no free slot, app.js answering 503); the page polls from now on.
      if (source.readyState === 2) {
        source.close();
        stream = null;
      }
      schedulePoll();
    });
  }

  // ---- cancel and takeover, with the page's own re-authentication (ruling R1c-9) ----

  var reauthForm = byId('reauth');
  var passwordField = byId('reauth-password');
  var codeField = byId('reauth-code');
  var reauthSubmit = byId('reauth-submit');

  function setReauthError(value) {
    setText('reauth-error', value);
    show(byId('reauth-error'), value !== '');
  }
  function clearReauthFields() {
    if (passwordField) passwordField.value = '';
    if (codeField) codeField.value = '';
  }
  function openReauth(action) {
    if (!reauthForm) {
      setStatus(errorText('AUTH_REAUTH_REQUIRED'));
      return;
    }
    pending = action;
    pendingSince = Date.now();
    setReauthError('');
    show(reauthForm, true);
    if (passwordField) passwordField.focus();
  }
  function closeReauth() {
    pending = null;
    clearReauthFields();
    setReauthError('');
    show(reauthForm, false);
  }

  /** Shows the answer of a cancel or takeover: the op, or what refused it (the page keeps following the op). */
  function actionDone(reply) {
    if (reply.ok && reply.data && typeof reply.data.state === 'string') {
      setStatus('');
      render(reply.data);
      return;
    }
    var code = codeOf(reply);
    setStatus(code ? errorText(code) : text('ops.page.retrying'));
  }

  /**
   * POST ops/<action>, sent again (twice at most) when it answers 409 OPS_IN_PROGRESS: a step held the lock through
   * the server's wait, and the server keeps the steppers out until the action's next try (final review).
   */
  async function send(action) {
    var reply = await request('POST', 'ops/' + action);
    for (var tries = 0; tries < 2 && reply.status === 409 && codeOf(reply) === 'OPS_IN_PROGRESS'; tries += 1) {
      reply = await request('POST', 'ops/' + action);
    }
    return reply;
  }

  /** POST ops/<action>; a missing re-authentication opens the form, which repeats the action afterwards. */
  async function act(action) {
    var reply = await send(action);
    if (reply.status === 401 && codeOf(reply) === 'AUTH_REAUTH_REQUIRED') openReauth(action);
    else actionDone(reply);
  }

  function onAction(button, action, ask) {
    if (!button || button.tagName !== 'BUTTON' || !hasSession) return;
    button.addEventListener('click', async function () {
      if (ask && !window.confirm(text('ops.page.cancel_confirm'))) return;
      button.disabled = true;
      acting += 1;
      try {
        await act(action);
      } catch (error) {
        setStatus(text('ops.page.retrying'));
      } finally {
        acting -= 1;
        button.disabled = false;
        resumeDriving();
      }
    });
  }
  onAction(byId('cancel'), 'cancel', true);
  onAction(byId('takeover'), 'takeover', false);

  if (reauthForm) {
    reauthForm.addEventListener('submit', async function (event) {
      event.preventDefault();
      if (pending === null || (reauthSubmit && reauthSubmit.disabled)) return;
      var password = passwordField ? passwordField.value : '';
      var code = codeField ? codeField.value.trim() : '';
      if (password === '') {
        setReauthError(text('ops.page.reauth.password_missing'));
        return;
      }
      if (codeField && !SIX_DIGITS.test(code)) {
        setReauthError(text('ops.page.reauth.code_invalid'));
        return;
      }
      var body = { password: password };
      if (codeField) body.code = code;
      if (reauthSubmit) reauthSubmit.disabled = true;
      acting += 1;
      try {
        var reply = await request('POST', 'auth/reauth', body, false, sessionCsrf);
        if (reply.ok) {
          var action = pending;
          closeReauth();
          if (action !== null) actionDone(await send(action));
          return;
        }
        if (codeField) codeField.value = '';
        var refused = codeOf(reply);
        if (refused === 'AUTH_INVALID_CREDENTIALS') setReauthError(text('ops.page.reauth.wrong_password'));
        else setReauthError(refused ? errorText(refused) : text('ops.page.retrying'));
      } catch (error) {
        setReauthError(text('ops.page.retrying'));
      } finally {
        acting -= 1;
        if (reauthSubmit) reauthSubmit.disabled = false;
        resumeDriving();
      }
    });
  }
  var dismiss = byId('reauth-dismiss');
  if (dismiss) {
    dismiss.addEventListener('click', function () {
      closeReauth();
      resumeDriving();
    });
  }

  var resumeButton = byId('resume');
  if (resumeButton) {
    resumeButton.addEventListener('click', async function () {
      resumeButton.disabled = true;
      acting += 1;
      try {
        take(await request('POST', 'ops/drive', { resume: true }));
      } catch (error) {
        setStatus(text('ops.page.retrying'));
      } finally {
        acting -= 1;
        resumeButton.disabled = false;
        resumeDriving();
      }
    });
  }

  render(current); // the server rendered #bundled already (bundledKey is the page's own state: no request here)
  startStream();
  schedulePoll();
})();
`;
