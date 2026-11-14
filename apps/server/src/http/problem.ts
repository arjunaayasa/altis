import { DomainError, isDomainError, newId, type ErrorCode } from '@altis/shared';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Logger } from '../logger.js';
import { loggableError } from '../safe-error.js';
import type { AppEnv } from './request-id.js';

// problem+json (RFC 9457, spec §11, ruling R53 as amended by decision D10). Every error the app answers with has this
// body:
//
//   {type: 'about:blank', title, status, code, detail?, errors?, reason?, traceId}
//
// - `code` is a registered DomainError code; `traceId` is the request id (also in `X-Request-Id`).
// - `detail` only for a 4xx DomainError (its detail is written to be shown). A status of 500 or more never has one,
//   whatever the error carries (host names, lock holders, driver text), with three exceptions that show a fixed
//   bilingual text of this file instead (S7): NOT_INSTALLED, DATA_VOLUME_MISSING and DATA_DIR_MISMATCH. And one that
//   shows the detail it carries (Phase 2, review L09): 502 CATALOG_SRU_INVALID, whose detail is set only for the
//   diagnostic of an SRU server that refused a search, cut to 200 characters (spec §6.2 "dengan pesan server").
// - `errors` only for VALIDATION_FAILED: `meta.errors` reduced to `{path, code}` entries (field paths and Zod issue
//   codes, never an input value); `[]` when there is none.
// - `reason` only for the codes of PROBLEM_REASONS (S30), and only when `meta.reason` is one of the words listed
//   for the code: a closed list with no input value in it, so the SPA and the tests can tell the cases apart. A 5xx
//   sends it only for 503 MAINTENANCE (S7: the admin client reads it to find where the op page is).
// - `meta` itself is never sent.
// - `Retry-After: <meta.retryAfterS>` (whole seconds, rounded up) for a 429 code, and for 503 MAINTENANCE, which
//   sends 30 when `meta.retryAfterS` is absent or not a number. DB_UNAVAILABLE never carries it, whatever its reason
//   (packet_too_large included, L32).
// - A Hono HTTPException (its middleware throws them: body-limit's 413) becomes a registered code by its status:
//   413 PAYLOAD_TOO_LARGE, 400 INVALID_JSON, 415 UNSUPPORTED_MEDIA_TYPE (L48); its own response is never sent.
//   Any other status is a 500 INTERNAL, logged.
// - Anything else that is not a DomainError is a 500 INTERNAL; it is logged with the request id and nothing of it
//   reaches the body. What is logged of an error follows the safe-cause policy of @altis/db (loggableError): a raw
//   database driver error, also below another error, is logged as {name, code, errno, sqlState, constraint}, never
//   its message, SQL text or values, whichever Logger receives it.

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/** A detail a 5xx problem shows (ruling R53): the instruction for an installation that has not happened yet. */
export const NOT_INSTALLED_DETAIL = 'Jalankan / Run: node app.js install --config <file>';

/**
 * Fixed details of the two 503s that must never show the install wizard (S7; spec §7.7, §9.5). Like the one above
 * they name the cause and the way out, and no path, host name or secret: an address bar must not show where the data
 * was, only that it is missing.
 */
export const DATA_VOLUME_MISSING_DETAIL =
  'Folder data tidak ditemukan; volume Docker kemungkinan belum terpasang. Pasang volume yang benar lalu mulai ulang / ' +
  'The data folder was not found; the Docker volume is probably not mounted. Mount the right volume and restart';

export const DATA_DIR_MISMATCH_DETAIL =
  'Folder data tidak cocok atau isinya hilang. Pulihkan lalu mulai ulang, atau jalankan node app.js install:reset / ' +
  'The data folder does not match or is empty. Restore it and restart, or run node app.js install:reset';

/** The only 5xx codes that show a detail, and the fixed text each one shows (whatever detail the error carries). */
const FIXED_DETAILS: Readonly<Partial<Record<ErrorCode, string>>> = Object.freeze({
  NOT_INSTALLED: NOT_INSTALLED_DETAIL,
  DATA_VOLUME_MISSING: DATA_VOLUME_MISSING_DETAIL,
  DATA_DIR_MISMATCH: DATA_DIR_MISMATCH_DETAIL,
});

/**
 * The only 5xx codes that show the detail the error carries (see the top of this file): CATALOG_SRU_INVALID's is the
 * text an SRU server the administrator configured answered to a catalog manager's search, never one of this server.
 */
const OWN_DETAIL_ON_5XX: ReadonlySet<ErrorCode> = new Set<ErrorCode>(['CATALOG_SRU_INVALID']);

/** The wait `MAINTENANCE` sends as `Retry-After` when its `meta.retryAfterS` does not say (seconds). */
export const MAINTENANCE_RETRY_AFTER_S = 30;

/** One entry of a VALIDATION_FAILED problem: where (a field path, `.`-joined; '' for the body itself) and which check. */
export interface ProblemFieldError {
  path: string;
  code: string;
}

export interface ProblemBody {
  type: 'about:blank';
  title: string;
  status: number;
  code: ErrorCode;
  detail?: string;
  /** VALIDATION_FAILED only. */
  errors?: ProblemFieldError[];
  /** The codes of {@link PROBLEM_REASONS} only; of the 5xx, 503 MAINTENANCE alone. */
  reason?: string;
  traceId: string;
}

/**
 * The `reason` words a problem may carry, per code (S30). A `meta.reason` outside its code's list is dropped, and a
 * code that is not here never carries one.
 */
export const PROBLEM_REASONS: Readonly<Partial<Record<ErrorCode, readonly string[]>>> = Object.freeze({
  /** validateBaseUrl's reasons (config.ts), and `origin_mismatch`: the request's Origin would no longer match (D27). */
  INVALID_BASE_URL: Object.freeze([
    'not_a_string',
    'empty',
    'invalid_characters',
    'not_a_url',
    'scheme',
    'userinfo',
    'path',
    'query',
    'fragment',
    'invalid_host',
    'port',
    'origin_mismatch',
    // 1c: the wizard's base URL probe (the browser's HMAC proof) did not come back right.
    'probe_failed',
  ]),
  PASSWORD_TOO_WEAK: Object.freeze(['too_short', 'too_long', 'common']),
  SMTP_FAILED: Object.freeze(['connect', 'tls', 'auth', 'send']),
  TRUST_PROXY_INVALID: Object.freeze(['collapsed', 'chain_short']),
  // 1c. The op kind that holds the maintenance flag (or `manual` for `maintenance:on`); the admin client reads it.
  MAINTENANCE: Object.freeze(['restore', 'backup', 'update', 'manual', 'install', 'migrate', 'reset']),
  // 1c. What is wrong with an archive: its layout, a part's or the manifest's digest, the HMAC, an entry name, a
  // decompression bomb, the schema version's shape, or an entry that is not allowed.
  BACKUP_INVALID: Object.freeze(['format', 'checksum', 'signature', 'path', 'bomb', 'schema', 'entry']),
  UPLOAD_CHUNK_INVALID: Object.freeze(['order', 'size']),
  UPLOAD_MISMATCH: Object.freeze(['size', 'sha256']),
  JOB_NOT_RETRYABLE: Object.freeze(['origin_only', 'state']),
  // 1c (Task 9): another request holds the upload's lock, or took it over; the client sends the same request again.
  TX_CONFLICT: Object.freeze(['upload_busy']),

  // 1d (Task 1). The words of the three 5xx codes below (UPDATE_BOOT_FAILED 500, FEED_INVALID and FEED_UNREACHABLE
  // 502) never reach a client, since REASON_ON_5XX holds MAINTENANCE only: they are kept in `op.json`'s
  // `error.detail` and in the setting `update.check.error`, and the UI shows the code's message (preflight M6).
  // The edition does not cover the release (the edition seam; the community edition always does).
  UPDATE_NOT_ENTITLED: Object.freeze(['no_license', 'released_after']),
  // The first failed precheck (meta.failures lists them all); the entitlement has its own code (D1d-32).
  UPDATE_PRECHECK_FAILED: Object.freeze(['not_newer', 'min_upgrade_from', 'boot_protocol', 'min_node', 'min_db', 'snapshot_backup']),
  UPDATE_PACKAGE_INVALID: Object.freeze(['hash', 'signature', 'manifest', 'mismatch', 'entry', 'bomb', 'size', 'version', 'keyset']),
  UPDATE_BOOT_FAILED: Object.freeze(['verify', 'import', 'start', 'migration', 'health', 'stalled', 'repeated', 'operator']),
  FEED_INVALID: Object.freeze(['signature', 'freshness', 'expired', 'seq', 'hash', 'shape', 'channel']),
  FEED_UNREACHABLE: Object.freeze(['no_feed_url', 'network', 'status', 'timeout', 'too_large', 'insecure']),
  ROLLBACK_UNAVAILABLE: Object.freeze(['no_previous', 'incompatible', 'missing', 'pending']),
  UPDATE_HIDDEN: Object.freeze(['image']),
  // ---- Komunitas K1 (catalogue re-sync) ----
  // A real SLiMS migration run that skips the catalogue follows a sync dry run that found catalogue changes.
  MIGRATION_PRECHECK_FAILED: Object.freeze(['catalog_changed']),
  // ---- Komunitas (members and circulation) ----
  // The desk tells the cases of a refused loan or renewal apart by these words (the numbers are in the detail).
  // A scanned "barcode" that is a member number: the desk offers to switch to that member.
  NOT_FOUND: Object.freeze(['member_no']),
  MEMBER_IMPORT_FORMAT: Object.freeze(['empty', 'header', 'unreadable', 'too_many_rows']),
  CIRC_NOT_LOANABLE: Object.freeze(['status', 'collection_type', 'policy']),
  CIRC_ITEM_ON_LOAN: Object.freeze(['same_member', 'other_member']),
  CIRC_LIMIT_REACHED: Object.freeze(['member_type', 'policy']),
  CIRC_RENEW_REFUSED: Object.freeze(['changed', 'suspended', 'expired', 'same_day', 'limit', 'hold', 'blocked', 'not_online']),
  // ---- Komunitas (circulation core) ----
  // An item recorded lost that is scanned back (the desk offers to take it back), and why a loan cannot be voided.
  CIRC_LOAN_NOT_OPEN: Object.freeze(['lost_item']),
  CIRC_VOID_REFUSED: Object.freeze(['too_late', 'other_staff', 'renewed', 'charged']),
});

/** The 5xx codes whose `reason` is sent (S7): all the others keep it out, as R53 says. */
const REASON_ON_5XX: ReadonlySet<ErrorCode> = new Set<ErrorCode>(['MAINTENANCE']);

/** At most this many `errors` entries are sent (a 1 MB body could otherwise produce a far larger answer). */
export const MAX_PROBLEM_ERRORS = 100;

/** With `type: about:blank` the title is the HTTP status phrase (RFC 9457 §4.2.1), here in both languages. */
const TITLES: Readonly<Record<number, string>> = {
  400: 'Permintaan tidak valid / Bad Request',
  401: 'Perlu masuk / Unauthorized',
  403: 'Akses ditolak / Forbidden',
  404: 'Tidak ditemukan / Not Found',
  409: 'Konflik / Conflict',
  410: 'Sudah tidak tersedia / Gone',
  413: 'Data terlalu besar / Content Too Large',
  415: 'Jenis data tidak didukung / Unsupported Media Type',
  416: 'Rentang tidak dapat dipenuhi / Range Not Satisfiable',
  422: 'Data tidak dapat diproses / Unprocessable Content',
  429: 'Terlalu banyak permintaan / Too Many Requests',
  500: 'Galat internal server / Internal Server Error',
  // 1d: the feed and package download codes (FEED_INVALID, FEED_UNREACHABLE, UPDATE_DOWNLOAD_FAILED).
  502: 'Gateway bermasalah / Bad Gateway',
  503: 'Layanan tidak tersedia / Service Unavailable',
  507: 'Ruang penyimpanan tidak cukup / Insufficient Storage',
};

function titleOf(status: number): string {
  return TITLES[status] ?? (status >= 500 ? 'Galat server / Server Error' : 'Permintaan gagal / Request Failed');
}

/** `meta.errors` as `{path, code}` entries: anything else is dropped, and so is every other field of an entry. */
function fieldErrors(meta: Record<string, unknown> | undefined): ProblemFieldError[] {
  const list = meta?.['errors'];
  if (!Array.isArray(list)) return [];
  const out: ProblemFieldError[] = [];
  for (const entry of list as unknown[]) {
    if (out.length >= MAX_PROBLEM_ERRORS) break;
    if (typeof entry !== 'object' || entry === null) continue;
    const { path, code } = entry as { path?: unknown; code?: unknown };
    if (typeof path === 'string' && typeof code === 'string') out.push({ path, code });
  }
  return out;
}

/** `meta.reason` when it is one of the words registered for `code`. */
function registeredReason(code: ErrorCode, meta: Record<string, unknown> | undefined): string | undefined {
  const reason = meta?.['reason'];
  const allowed = PROBLEM_REASONS[code];
  return typeof reason === 'string' && allowed !== undefined && allowed.includes(reason) ? reason : undefined;
}

/** The problem body for `error` (see the top of this file for what is shown). */
export function problemBody(error: DomainError, traceId: string): ProblemBody {
  const body: Omit<ProblemBody, 'traceId'> = { type: 'about:blank', title: titleOf(error.status), status: error.status, code: error.code };
  const fixed = FIXED_DETAILS[error.code];
  if (fixed !== undefined) body.detail = fixed;
  else if ((error.status < 500 || OWN_DETAIL_ON_5XX.has(error.code)) && typeof error.detail === 'string') body.detail = error.detail;
  if (error.status < 500 && error.code === 'VALIDATION_FAILED') body.errors = fieldErrors(error.meta);
  if (error.status < 500 || REASON_ON_5XX.has(error.code)) {
    const reason = registeredReason(error.code, error.meta);
    if (reason !== undefined) body.reason = reason;
  }
  return { ...body, traceId };
}

/**
 * `Retry-After` for a 429: `meta.retryAfterS` in whole seconds (rounded up), when it is a finite number ≥ 0, else
 * none. For 503 MAINTENANCE the same, with {@link MAINTENANCE_RETRY_AFTER_S} when it is not. Never for any other code.
 */
function retryAfter(error: DomainError): string | undefined {
  const isMaintenance = error.code === 'MAINTENANCE';
  if (error.status !== 429 && !isMaintenance) return undefined;
  const s = error.meta?.['retryAfterS'];
  if (typeof s === 'number' && Number.isFinite(s) && s >= 0) return String(Math.ceil(s));
  return isMaintenance ? String(MAINTENANCE_RETRY_AFTER_S) : undefined;
}

export function problemResponse(error: DomainError, traceId: string): Response {
  const body = problemBody(error, traceId);
  const headers: Record<string, string> = { 'Content-Type': PROBLEM_CONTENT_TYPE };
  const wait = retryAfter(error);
  if (wait !== undefined) headers['Retry-After'] = wait;
  return new Response(JSON.stringify(body), { status: body.status, headers });
}

/** The registered code of a Hono HTTPException's status (L48), or undefined: then it is a 500 INTERNAL. */
const HTTP_EXCEPTION_CODES: Readonly<Record<number, ErrorCode>> = {
  400: 'INVALID_JSON',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
};

/**
 * The response for an error thrown while handling a request (Hono's onError, and the app's catch-all for thrown
 * values that are not Errors). A DomainError keeps its code and status; a Hono HTTPException maps by its status;
 * anything else becomes 500 INTERNAL. Errors of 500 and above are logged with the request id (the request's logger
 * child carries it).
 */
export function errorResponse(error: unknown, c: Context<AppEnv>, fallbackLog: Logger): Response {
  // Both are set by the first middleware; an error inside that middleware itself finds neither.
  const traceId = (c.get('requestId') as string | undefined) ?? newId();
  const log = (c.get('log') as Logger | undefined) ?? fallbackLog.child({ requestId: traceId });
  const where = { method: c.req.method, path: c.req.path };
  if (isDomainError(error)) {
    if (error.status >= 500) log.error('request failed', { ...where, code: error.code, err: loggableError(error) });
    return problemResponse(error, traceId);
  }
  if (error instanceof HTTPException) {
    const code = HTTP_EXCEPTION_CODES[error.status];
    if (code !== undefined) return problemResponse(new DomainError(code), traceId);
    log.error('unexpected HTTP exception', { ...where, status: error.status });
    return problemResponse(new DomainError('INTERNAL'), traceId);
  }
  log.error('unexpected error', { ...where, err: loggableError(error) });
  return problemResponse(new DomainError('INTERNAL'), traceId);
}
