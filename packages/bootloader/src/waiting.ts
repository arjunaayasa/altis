import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type http from 'http';
import { dataPath, parseCurrentState, readJsonWithBak } from '@altis/platform';
import { MESSAGES, NEEDS_ATTENTION, OP_KINDS, OP_STATES, OP_TERMINAL_STATES, isDomainError, newId, type Locale, type OpKind } from '@altis/shared';
import type { OpActorView, OpStatusView, OpView } from '@altis/shared/api/ops';
import type { UpdateStatusView } from '@altis/shared/api/updates';
import { HEALTH_PATH, PAGE_STYLE, pathOf, sendPage, type RequestHandler } from './front.js';
import type { BootLog } from './log.js';

// The minimal serving of §9.2 step 6 (1d Task 22; Review Focus 4): what a process answers while another process holds
// releases/boot.lock and boots the pending release (pending.ts waitForBootLock), or while the revert of a failed one
// waits for ops/step.lock. Nothing here touches the database or takes a lock; everything comes straight from
// DATA_DIR/ops/op.json and DATA_DIR/releases/current.json, read as they are (a rename is atomic; a torn file is read
// from its `.bak`):
//
//   GET  /api/v1/ops/current     200 OpView of op.json (mode `external`, no CSRF token, never driveable: this process
//                                steps nothing)
//   GET  /api/v1/updates/status  200 UpdateStatusView: the op, the versions current.json names, `serving: 'app'`
//   GET  /admin/_update          a minimal bilingual page that polls ops/current every 2 s (GET events answers 503 in
//                                this phase, preflight 1D-27) and reloads once the server answers (`X-Altis-Serving:
//                                server`, which its ops.current and updates.status send, Task 28, preflight S20) or
//                                the op it followed ends; its inline style and script carry the response's CSP nonce
//   /_health                     503 {status: 'maintenance', version: null}
//   anything else                503, the static bilingual page, `Retry-After: 5`
//
// The three routes are `opsAuth` (§9.4) with the cookie alone, as the server's are while it waits for an op: the
// `altis_ops` cookie, or `__Host-altis_ops` (which name the server sets depends on its baseUrl, which app.js does not
// read), whose SHA-256 hex equals op.json's `opsTokenHash` (compared in constant time), while the op has not ended or
// ended at most an hour ago. Otherwise 401 OPS_AUTH_REQUIRED (problem+json), or a 401 page for `/admin/_update`.
// Every answer of these three carries `X-Altis-Serving: app`.
//
// Every request first calls `onRequest()`: that is the retry of waitForBootLock (at most every 5 s, §9.3 "dipicu
// request"), so the next request after the holder is done boots this process. app.js bundles this module (ES2017, P1);
// it runs only after the Node check.

export const OPS_CURRENT_PATH = '/api/v1/ops/current';
export const UPDATE_STATUS_PATH = '/api/v1/updates/status';
export const UPDATE_PAGE_PATH = '/admin/_update';

/** `Retry-After` of the static 503 page: the retry of waitForBootLock comes at most every 5 s. */
export const WAITING_RETRY_AFTER_S = 5;

/** How often `/admin/_update`'s script polls ops/current. */
export const POLL_MS = 2000;

/** Who answered (Task 28, preflight S20): the server sends `server`, the minimal serving `app`. */
export const SERVING_HEADER = 'X-Altis-Serving';

/** Spec §9.4: `altis_ops` stays valid until the op ended + 1 hour (OpsMachine.tokenMatches). */
const AFTER_END_MS = 3600000;

/** The cookie names that may carry the op's token (see the top of this file). */
const OPS_COOKIES: readonly string[] = ['altis_ops', '__Host-altis_ops'];

/** A longer value is no token of ours (OpsMachine.tokenMatches refuses it too). */
const MAX_TOKEN_CHARS = 256;

/** At most this many cookie values are tried per request (each costs a SHA-256). */
const MAX_TOKENS = 8;

const TOKEN_HASH = /^[0-9a-f]{64}$/;

const JSON_TYPE = 'application/json; charset=utf-8';
const PROBLEM_TYPE = 'application/problem+json; charset=utf-8';
const HTML_TYPE = 'text/html; charset=utf-8';

const HEALTH_BODY = JSON.stringify({ status: 'maintenance', version: null });

// ---------------------------------------------------------------------------------------------------------------------
// op.json

/** What the minimal serving knows of op.json: the status it shows, and the hash its cookie must match. */
interface WaitingOp {
  status: OpStatusView;
  tokenHash: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function epochOrNull(value: unknown): number | null {
  return typeof value === 'number' && isFinite(value) && value >= 0 ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function errorOf(value: unknown): OpStatusView['error'] {
  if (!isRecord(value) || typeof value['code'] !== 'string') return null;
  const error: { code: string; detail?: string } = { code: value['code'] };
  if (typeof value['detail'] === 'string') error.detail = value['detail'];
  return error;
}

const ACTOR_TYPES: readonly string[] = ['staff', 'cli', 'install', 'system'];

function actorOf(value: unknown): OpActorView | null {
  if (!isRecord(value) || typeof value['type'] !== 'string' || ACTOR_TYPES.indexOf(value['type']) === -1) return null;
  const id = value['id'];
  if (id !== null && typeof id !== 'string') return null;
  return { type: value['type'] as OpActorView['type'], id: id };
}

/**
 * op.json as the minimal serving reads it: an `opSchema 1` object with an id, a known kind, a state and an
 * `opsTokenHash` that is null or 64 lower-case hex digits (else it is unusable, and its `.bak` is tried). The other
 * fields are taken when they have their type, else shown empty; the rest (params, the secret, fields a later release
 * adds) is never read.
 */
function parseOp(raw: unknown): WaitingOp {
  if (!isRecord(raw) || raw['opSchema'] !== 1) throw new TypeError('op.json: not an opSchema 1 object');
  const opId = raw['opId'];
  const kind = raw['kind'];
  const state = raw['state'];
  if (typeof opId !== 'string' || typeof kind !== 'string' || (OP_KINDS as readonly string[]).indexOf(kind) === -1 || typeof state !== 'string') {
    throw new TypeError('op.json: opId, kind or state');
  }
  const hash = raw['opsTokenHash'];
  if (hash !== null && (typeof hash !== 'string' || !TOKEN_HASH.test(hash))) throw new TypeError('op.json: opsTokenHash');
  const progress = raw['progress'];
  const status: OpStatusView = {
    opId: opId,
    kind: kind as OpKind,
    state: state,
    terminal: OP_TERMINAL_STATES[kind as OpKind].indexOf(state) !== -1,
    needsAttention: state === NEEDS_ATTENTION,
    startedAt: epochOrNull(raw['startedAt']),
    heartbeatAt: epochOrNull(raw['heartbeatAt']),
    finishedAt: epochOrNull(raw['finishedAt']),
    progress: typeof progress === 'number' && isFinite(progress) ? Math.min(100, Math.max(0, progress)) : 0,
    message: stringOrNull(raw['message']),
    error: errorOf(raw['error']),
    pointOfNoReturn: raw['pointOfNoReturn'] === true,
    backupId: stringOrNull(raw['backupId']),
    actor: actorOf(raw['actor']),
  };
  return { status: status, tokenHash: hash };
}

/**
 * The op of op.json (from its `.bak` when op.json is torn), or null when there is none or neither file is usable (the
 * server shows that one as needs_attention; here nobody's cookie can match it).
 *
 * @throws I/O errors other than a missing file (EACCES, EISDIR, ...)
 */
async function readOp(dataDir: string): Promise<WaitingOp | null> {
  try {
    return await readJsonWithBak(dataPath(dataDir, 'ops', 'op.json'), parseOp);
  } catch (error) {
    if (isDomainError(error) && error.code === 'STATE_CORRUPT') return null;
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The cookie

/**
 * The values of the `altis_ops` and `__Host-altis_ops` cookies of a request's Cookie header (Node joins several
 * headers with `; `), unquoted and percent-decoded as the server's cookie reader does; empty and overlong values are
 * skipped, and at most {@link MAX_TOKENS} are kept.
 */
function opsTokens(header: string | string[] | undefined): string[] {
  if (header === undefined) return [];
  const text = Array.isArray(header) ? header.join('; ') : header;
  const out: string[] = [];
  const parts = text.split(';');
  for (let i = 0; i < parts.length && out.length < MAX_TOKENS; i += 1) {
    const part = parts[i] as string;
    const eq = part.indexOf('=');
    if (eq === -1 || OPS_COOKIES.indexOf(part.slice(0, eq).trim()) === -1) continue;
    let value = part.slice(eq + 1).trim();
    if (value.length >= 2 && value.charAt(0) === '"' && value.charAt(value.length - 1) === '"') value = value.slice(1, -1);
    if (value.indexOf('%') !== -1) {
      try {
        value = decodeURIComponent(value);
      } catch {
        continue;
      }
    }
    if (value.length > 0 && value.length <= MAX_TOKEN_CHARS) out.push(value);
  }
  return out;
}

function sha256hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Whether one of `tokens` opens `op` at `now`: its SHA-256 hex equals `opsTokenHash` (constant time, every candidate
 * compared), and the op has not ended, or ended at most an hour ago (`finishedAt`, else its last step).
 */
function cookieOpens(op: WaitingOp, tokens: string[], now: number): boolean {
  if (op.tokenHash === null || tokens.length === 0) return false;
  if (op.status.terminal) {
    const end = op.status.finishedAt !== null ? op.status.finishedAt : op.status.heartbeatAt;
    if (end === null || now > end + AFTER_END_MS) return false;
  }
  const expected = Buffer.from(op.tokenHash, 'utf8');
  let match = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const actual = Buffer.from(sha256hex(tokens[i] as string), 'utf8');
    if (actual.length === expected.length && timingSafeEqual(actual, expected)) match = true;
  }
  return match;
}

// ---------------------------------------------------------------------------------------------------------------------
// Texts

/** A message of the shared catalogs (the ones the server's pages use), or null for a key they do not have. */
function message(locale: Locale, key: string): string | null {
  const catalog = MESSAGES[locale] as Readonly<Record<string, string>>;
  return Object.prototype.hasOwnProperty.call(catalog, key) ? (catalog[key] as string) : null;
}

/** The label of an op state (`ops.state.<state>`), or the state itself when the catalogs do not name it. */
export function stateLabel(locale: Locale, state: string): string {
  const label = message(locale, 'ops.state.' + state);
  return label !== null ? label : state;
}

function text(locale: Locale, key: string): string {
  const found = message(locale, key);
  return found !== null ? found : key;
}

/** Every state's label in `locale`, for the page's script. */
function stateLabels(locale: Locale): Record<string, string> {
  const labels: Record<string, string> = {};
  for (let i = 0; i < OP_KINDS.length; i += 1) {
    const states = OP_STATES[OP_KINDS[i] as OpKind];
    for (let j = 0; j < states.length; j += 1) labels[states[j] as string] = stateLabel(locale, states[j] as string);
  }
  labels[NEEDS_ATTENTION] = stateLabel(locale, NEEDS_ATTENTION);
  return labels;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** JSON that can sit inside a `<script>` element: nothing in it can end the element or open a comment. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .split(String.fromCharCode(0x2028)).join('\\u2028')
    .split(String.fromCharCode(0x2029)).join('\\u2029');
}

/** Both languages of a shared message, each in its own `lang`. */
function both(key: string): string {
  return '<span lang="id">' + escapeHtml(text('id', key)) + '</span> / <span lang="en">' + escapeHtml(text('en', key)) + '</span>';
}

function percent(progress: number): number {
  return Math.round(Math.min(100, Math.max(0, progress)));
}

function errorText(error: OpStatusView['error']): string {
  if (error === null) return '';
  return error.detail !== undefined && error.detail !== '' ? error.code + ': ' + error.detail : error.code;
}

const PAGE_HEAD =
  '<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
  '<meta name="robots" content="noindex">';

const TITLE = '<title>ALTIS: pembaruan / update</title>';

const UPDATING_ID = 'ALTIS sedang diperbarui';
const UPDATING_EN = 'ALTIS is being updated';

/** The static 503 page of every other request (see the top of this file). */
const UNAVAILABLE_HTML =
  PAGE_HEAD +
  '<meta http-equiv="refresh" content="5">' +
  TITLE +
  '<style>' +
  PAGE_STYLE +
  '</style></head><body>' +
  '<section lang="id"><h1>' +
  UPDATING_ID +
  '</h1><p>Layanan dihentikan sementara selama versi baru dimulai. Halaman ini dimuat ulang sendiri dalam beberapa detik.</p>' +
  '<p>Administrator dapat mengikuti kemajuannya di <a href="' +
  UPDATE_PAGE_PATH +
  '">halaman pembaruan</a>.</p></section><hr>' +
  '<section lang="en"><h1>' +
  UPDATING_EN +
  '</h1><p>The service is paused while the new version starts. This page reloads by itself in a few seconds.</p>' +
  '<p>Administrators can follow it on the <a href="' +
  UPDATE_PAGE_PATH +
  '">update page</a>.</p></section>' +
  '</body></html>';

/** `/admin/_update` without the op's cookie: nobody can sign in while no release serves (no session to check). */
const REFUSED_PAGE_HTML =
  PAGE_HEAD +
  '<meta http-equiv="refresh" content="5">' +
  TITLE +
  '<style>' +
  PAGE_STYLE +
  '</style></head><body>' +
  '<section lang="id"><h1>' +
  UPDATING_ID +
  '</h1><p>Selama versi baru dimulai, kemajuan pembaruan hanya dapat diikuti dari peramban yang memulainya. ' +
  'Halaman ini dimuat ulang sendiri; setelah server siap, masuk sebagai administrator untuk mengikutinya.</p></section><hr>' +
  '<section lang="en"><h1>' +
  UPDATING_EN +
  '</h1><p>While the new version starts, the update can be followed only from the browser that started it. ' +
  'This page reloads by itself; once the server is ready, sign in as an administrator to follow it.</p></section>' +
  '</body></html>';

const PAGE_EXTRA_STYLE = 'dt{font-weight:600;margin-top:.75rem}dd{margin:0}progress{width:100%;max-width:24rem}';

/**
 * The page's script (ES5, so any browser runs it; no `on…` attribute, no eval, the DOM written with textContent
 * only): every {@link POLL_MS} it asks ops/current; an answer with `X-Altis-Serving: server` reloads the page into the
 * server's own; an op that ends after the page saw it running reloads too (an op that had already ended when the page
 * was rendered waits for the server instead, so the page never reloads in a loop); a 401 stops it; anything else says
 * it retries.
 */
const PAGE_SCRIPT =
  "(function(){'use strict';var d=__DATA__;var live=d.live;var stopped=false;" +
  'function el(id){return document.getElementById(id);}' +
  'function put(id,t){var e=el(id);if(e){e.textContent=t;}}' +
  'function label(l,s){var all=d.states[l];return Object.prototype.hasOwnProperty.call(all,s)?all[s]:s;}' +
  "function say(k){put('status-id',k?d.text.id[k]:'');put('status-en',k?d.text.en[k]:'');}" +
  'function show(op){' +
  "put('state-id',label('id',op.state));put('state-en',label('en',op.state));" +
  "var p=typeof op.progress==='number'&&isFinite(op.progress)?Math.round(Math.max(0,Math.min(100,op.progress))):0;" +
  "var bar=el('progress');if(bar){bar.value=p;}put('progress-text',p+'%');" +
  "put('message',typeof op.message==='string'?op.message:'');" +
  "var e=op.error;put('error',e&&typeof e.code==='string'?e.code+(typeof e.detail==='string'&&e.detail?': '+e.detail:''):'');}" +
  'function reload(){stopped=true;window.location.reload();}' +
  'function poll(){if(stopped){return;}var x=new XMLHttpRequest();' +
  "x.addEventListener('loadend',function(){" +
  "if(x.getResponseHeader('" +
  SERVING_HEADER +
  "')==='server'){reload();return;}" +
  "if(x.status===401){stopped=true;say('lost');return;}" +
  'var op=null;if(x.status===200){try{op=JSON.parse(x.responseText);}catch(err){op=null;}}' +
  "if(op&&typeof op.state==='string'){say('');show(op);if(op.terminal===true){if(live){reload();return;}}else{live=true;}}" +
  "else{say('retrying');}" +
  'setTimeout(poll,d.every);});' +
  "x.open('GET',d.api,true);x.timeout=10000;x.setRequestHeader('Accept','application/json');x.send();}" +
  'setTimeout(poll,d.every);})();';

/** The labels the script needs, made once. */
let scriptLabels: { states: Record<Locale, Record<string, string>>; text: Record<Locale, Record<string, string>> } | null = null;

function labelsForScript(): NonNullable<typeof scriptLabels> {
  if (scriptLabels === null) {
    scriptLabels = {
      states: { id: stateLabels('id'), en: stateLabels('en') },
      text: {
        id: { retrying: text('id', 'ops.page.retrying'), lost: text('id', 'ops.page.lost') },
        en: { retrying: text('en', 'ops.page.retrying'), lost: text('en', 'ops.page.lost') },
      },
    };
  }
  return scriptLabels;
}

function row(key: string, value: string): string {
  return '<dt>' + both(key) + '</dt><dd>' + value + '</dd>';
}

/** `/admin/_update` for the holder of the op's cookie (see the top of this file). */
function updatePage(op: OpStatusView, nonce: string): string {
  const kind = op.kind === null ? '' : 'ops.kind.' + op.kind;
  const progress = percent(op.progress);
  const labels = labelsForScript();
  const data = { api: OPS_CURRENT_PATH, every: POLL_MS, live: !op.terminal, states: labels.states, text: labels.text };
  return (
    PAGE_HEAD +
    TITLE +
    '<style nonce="' +
    nonce +
    '">' +
    PAGE_STYLE +
    PAGE_EXTRA_STYLE +
    '</style></head><body>' +
    '<section lang="id"><h1>' +
    UPDATING_ID +
    '</h1><p>Proses lain sedang memulai versi baru. Halaman ini memantau kemajuannya dan beralih sendiri ke halaman ' +
    'operasi lengkap begitu server siap.</p></section>' +
    '<section lang="en"><h1>' +
    UPDATING_EN +
    '</h1><p>Another process is starting the new version. This page follows its progress and moves on to the full ' +
    'operations page by itself once the server is ready.</p></section><hr>' +
    '<dl>' +
    (kind === '' ? '' : row('ops.page.kind', both(kind))) +
    row(
      'ops.page.state',
      '<span id="state-id" lang="id">' +
        escapeHtml(stateLabel('id', op.state)) +
        '</span> / <span id="state-en" lang="en">' +
        escapeHtml(stateLabel('en', op.state)) +
        '</span>',
    ) +
    row(
      'ops.page.progress',
      '<progress id="progress" max="100" value="' + progress + '">' + progress + '%</progress> <span id="progress-text">' + progress + '%</span>',
    ) +
    '<dt><span lang="id">Pesan</span> / <span lang="en">Message</span></dt><dd id="message">' +
    escapeHtml(op.message === null ? '' : op.message) +
    '</dd>' +
    row('ops.page.error', '<span id="error">' + escapeHtml(errorText(op.error)) + '</span>') +
    '</dl>' +
    '<p role="status" aria-live="polite"><span id="status-id" lang="id"></span> <span id="status-en" lang="en"></span></p>' +
    '<noscript><p lang="id">' +
    escapeHtml(text('id', 'ops.page.no_script')) +
    '</p><p lang="en">' +
    escapeHtml(text('en', 'ops.page.no_script')) +
    '</p></noscript>' +
    '<script nonce="' +
    nonce +
    '">' +
    PAGE_SCRIPT.replace('__DATA__', function () {
      return scriptJson(data);
    }) +
    '</script>' +
    '</body></html>'
  );
}

/** The page's policy: its inline style and script by `nonce` only, requests to this origin only. */
function pagePolicy(nonce: string): string {
  return (
    "default-src 'none'; script-src 'nonce-" +
    nonce +
    "'; style-src 'nonce-" +
    nonce +
    "'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Answers

const SERVING_APP: http.OutgoingHttpHeaders = { 'X-Altis-Serving': 'app' };

function sendJson(res: http.ServerResponse, method: string | undefined, status: number, value: unknown): void {
  sendPage(res, method, status, JSON_TYPE, JSON.stringify(value), SERVING_APP);
}

function sendUnavailable(res: http.ServerResponse, method: string | undefined): void {
  sendPage(res, method, 503, HTML_TYPE, UNAVAILABLE_HTML, { 'Retry-After': String(WAITING_RETRY_AFTER_S) });
}

/** 401: problem+json OPS_AUTH_REQUIRED (as the server's problem.ts writes it), or the 401 page for `/admin/_update`. */
function refuse(res: http.ServerResponse, method: string | undefined, path: string): void {
  if (path === UPDATE_PAGE_PATH) {
    sendPage(res, method, 401, HTML_TYPE, REFUSED_PAGE_HTML, SERVING_APP);
    return;
  }
  const traceId = newId();
  const body = { type: 'about:blank', title: 'Perlu masuk / Unauthorized', status: 401, code: 'OPS_AUTH_REQUIRED', traceId: traceId };
  sendPage(res, method, 401, PROBLEM_TYPE, JSON.stringify(body), { 'X-Altis-Serving': 'app', 'X-Request-Id': traceId });
}

function opView(status: OpStatusView): OpView {
  return {
    opId: status.opId,
    kind: status.kind,
    state: status.state,
    terminal: status.terminal,
    needsAttention: status.needsAttention,
    startedAt: status.startedAt,
    heartbeatAt: status.heartbeatAt,
    finishedAt: status.finishedAt,
    progress: status.progress,
    message: status.message,
    error: status.error,
    pointOfNoReturn: status.pointOfNoReturn,
    backupId: status.backupId,
    actor: status.actor,
    mode: 'external',
    csrfToken: null,
    driveable: false,
  };
}

/** One of the three `opsAuth` routes (`path`), read with GET or HEAD. */
async function answer(dataDir: string, req: http.IncomingMessage, res: http.ServerResponse, path: string): Promise<void> {
  const method = req.method;
  const op = await readOp(dataDir);
  if (op === null || !cookieOpens(op, opsTokens(req.headers.cookie), Date.now())) {
    refuse(res, method, path);
    return;
  }
  if (path === OPS_CURRENT_PATH) {
    sendJson(res, method, 200, opView(op.status));
    return;
  }
  if (path === UPDATE_STATUS_PATH) {
    const state = await readJsonWithBak(dataPath(dataDir, 'releases', 'current.json'), parseCurrentState);
    if (state === null) throw new Error('releases/current.json is missing');
    const view: UpdateStatusView = {
      op: op.status,
      releases: {
        active: state.active.version,
        previous: state.previous === null ? null : state.previous.version,
        pending: state.pending === null ? null : state.pending.version,
        pinned: state.pinned,
      },
      serving: 'app',
    };
    sendJson(res, method, 200, view);
    return;
  }
  const nonce = randomBytes(16).toString('base64url');
  sendPage(res, method, 200, HTML_TYPE, updatePage(op.status, nonce), {
    'Content-Security-Policy': pagePolicy(nonce),
    'X-Altis-Serving': 'app',
  });
}

export interface WaitingHandlerOptions {
  dataDir: string;
  log: BootLog;
  /** Called first for every request: the retry of waitForBootLock (pending.ts). What it throws is ignored. */
  onRequest(): void;
}

/**
 * The handler of a process that waits for releases/boot.lock: the minimal serving of §9.2 step 6 (see the top of this
 * file). A state file that cannot be read (EACCES, a folder, a current.json that is missing or unusable) is logged and
 * answered with the static 503 page.
 */
export function waitingHandler(o: WaitingHandlerOptions): RequestHandler {
  return function (req, res) {
    try {
      o.onRequest();
    } catch {
      // the retry never fails a request
    }
    req.resume();
    const path = pathOf(req);
    const method = req.method;
    if (path === HEALTH_PATH) {
      sendPage(res, method, 503, JSON_TYPE, HEALTH_BODY);
      return;
    }
    const routed = path === OPS_CURRENT_PATH || path === UPDATE_STATUS_PATH || path === UPDATE_PAGE_PATH;
    if (!routed || (method !== 'GET' && method !== 'HEAD')) {
      sendUnavailable(res, method);
      return;
    }
    answer(o.dataDir, req, res, path).then(undefined, function (error: unknown) {
      o.log.warn('the minimal serving could not read the state files', { path: path, err: error });
      if (res.headersSent) res.destroy();
      else sendUnavailable(res, method);
    });
  };
}
