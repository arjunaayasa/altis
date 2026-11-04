import { ERROR_CODES, resolveLocale, type ErrorCode, type Locale, type Permission } from '@altis/shared';
import type { MeClient } from '@altis/shared/api/auth';
import { buildSync } from './build-sync';
import { dirtyForms } from './dirty-forms';
import { showMaintenanceScreen } from './maintenance';
import { page } from './page';

/**
 * The SPA's only way to the server (spec §4.8, §7.4; the admin reaches the server only through /api/v1).
 *
 * - JSON in, JSON out, same-origin cookies; `X-CSRF-Token` carries the latest token: the one `GET auth/me` gave
 *   ({@link setCsrfToken}) or the one a response sent when it created or rotated the session (S9). Session rotation
 *   happens on /api routes only (ruling R1b-1), so every token the SPA needs arrives here.
 * - Every response, error or not, feeds `X-Altis-Build` to {@link buildSync}.
 * - A problem+json answer becomes an {@link ApiError}.
 * - Recoverable problems are retried once each:
 *   - 401 AUTH_REAUTH_REQUIRED → `await reauth.request()` (the reauth dialog), then the same request again;
 *   - 403 CSRF_INVALID → `GET auth/me` for a fresh `csrfToken`, then the same request again (ruling R1b-1: two tabs, or
 *     a rotation that crossed an in-flight request); only while that session is still the same user's. Signed out
 *     or someone else's now: no retry, the request rejects and the page goes where a lost session goes.
 * - The other auth problems send the user where the server says they stand: 401 AUTH_REQUIRED → the sign-in page
 *   saying the session ended, with `?next=` (not while a form is dirty: the shell warns instead), 401
 *   AUTH_MFA_REQUIRED → `/admin/login/2fa`, 403 AUTH_PASSWORD_CHANGE_REQUIRED → `/admin/profile/password`; the
 *   promise still rejects with the ApiError.
 * - Method override (1c Task 16; spec §5 P10, decision C37): a WAF in front of a shared host may refuse PUT, PATCH and
 *   DELETE. They go out as `POST` + `X-HTTP-Method-Override` when `auth/me`'s `client.methodOverride` says the browser
 *   test saw that, or when this tab already met it; otherwise a 403/405 answer that is not problem+json (the WAF's own
 *   page) is sent again once that way, and when the server answers it, the tab keeps overriding
 *   (`sessionStorage['altis.method-override'] = '1'`). The server takes it only from a signed-in session with its
 *   CSRF token, as any write. So an overridden write answered 403 METHOD_OVERRIDE_DENIED asks `GET auth/me`, and when
 *   the session is gone (or someone else's) the page goes where 401 AUTH_REQUIRED would send it. A request with
 *   `methodOverride: false` ({@link ApiOptions}) always goes out with its real method.
 * - Every successful `GET auth/me` leaves its `client` hints here ({@link clientHints}; null when signed out or
 *   before stage `full`) for the realtime and upload clients.
 * - Maintenance (1c Task 19; spec §9.4, decision C20): a 503 MAINTENANCE whose `reason` belongs to an op the user may
 *   follow (`restore` → `system.backup.restore`, `backup` → `system.backup.create`, `update` → `system.update.run`, read
 *   from the last `GET auth/me`) loads the operations page `/admin/_update` (a server page, outside the SPA), once; any
 *   other user gets the blocking maintenance screen (lib/maintenance.ts), which asks `GET auth/me` every 15 s and lifts
 *   itself once that answers without `maintenance: true` (and without a `maintenance` banner); it links the operations
 *   page only when the page opens for the user during that reason. The promise still rejects with the ApiError.
 *
 * A body is JSON, or a FormData sent as it is (multipart, the chunked uploads of lib/upload.ts). A network failure
 * (no response at all) rejects with fetch's own TypeError; an aborted `signal` with its reason.
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface ApiOptions {
  /** Sent as `Idempotency-Key` (§7.9): the same key for a retried submission of the same form. */
  idempotencyKey?: string;
  /** Sent as `X-Altis-Background: 1`: polling that must not keep the session alive. */
  background?: boolean;
  /** Aborts the request (fetch's `signal`). */
  signal?: AbortSignal;
  /**
   * `false`: PUT, PATCH and DELETE go out with their real method whatever `auth/me`'s hint or the tab say, and a WAF's
   * page is the answer, never sent again as `POST` + override (the methods probe of Diagnostik tests the real methods,
   * and the server refuses an overridden probe). Absent or true: method override as described at the top of this file.
   */
  methodOverride?: boolean;
}

/** One entry of a VALIDATION_FAILED problem: the field path (`.`-joined) and the check that failed. */
export interface FieldError {
  path: string;
  code: string;
}

/** A problem+json answer (spec §11, decision D10). `message` is the problem's detail, else its title, else its code. */
export class ApiError extends Error {
  override name = 'ApiError';
  /** The HTTP status. */
  status: number;
  /** A registered code; `INTERNAL` for an answer that is not an ALTIS problem (a proxy's error page). */
  code: ErrorCode;
  /** The problem's own explanation (4xx only), meant to be shown. */
  detail?: string;
  /** VALIDATION_FAILED: the fields and checks. */
  errors?: FieldError[];
  /** A registered reason word of some codes (S30), e.g. `origin_mismatch` for INVALID_BASE_URL. */
  reason?: string;
  /** The request id (`X-Request-Id`), for the administrator's log. */
  traceId?: string;
  /** Seconds to wait (`Retry-After`), on a 429. */
  retryAfterS?: number;
  /**
   * Whether the answer was problem+json, the server's own; false for any other page (a proxy's error page, a WAF's
   * refusal: lib/upload.ts halves its chunk after a 403 that is not the server's).
   */
  problemJson: boolean;

  constructor(
    status: number,
    code: ErrorCode,
    o: {
      detail?: string;
      title?: string;
      errors?: FieldError[];
      reason?: string;
      traceId?: string;
      retryAfterS?: number;
      problemJson?: boolean;
    } = {},
  ) {
    super(o.detail ?? o.title ?? code);
    this.status = status;
    this.code = code;
    this.problemJson = o.problemJson ?? true;
    if (o.detail !== undefined) this.detail = o.detail;
    if (o.errors !== undefined) this.errors = o.errors;
    if (o.reason !== undefined) this.reason = o.reason;
    if (o.traceId !== undefined) this.traceId = o.traceId;
    if (o.retryAfterS !== undefined) this.retryAfterS = o.retryAfterS;
  }
}

const API_BASE = '/api/v1/';
const ME_PATH = 'auth/me';
const LOGIN_PATH = '/admin/login';

let token: string | null = null;

/** The CSRF token the next request carries (from `GET auth/me`'s `csrfToken`). */
export function setCsrfToken(value: string | null): void {
  token = value === '' ? null : value;
}

/** The CSRF token the next request carries, or null before the first `GET auth/me`. */
export function csrfToken(): string | null {
  return token;
}

/** Whose session this page holds, as `GET auth/me` last said: a user id, null when signed out; undefined before it answered. */
let sessionUser: string | null | undefined;

/** Records whose session this page holds (lib/me.ts, with every answer of `GET auth/me`). */
export function setSessionUser(user: string | null): void {
  sessionUser = user;
}
/**
 * Re-authentication (spec §7.3): the reauth dialog registers the handler that asks for the password (and a code)
 * and resolves once `POST auth/reauth` succeeded, or rejects when the user cancels. Requests that hit
 * AUTH_REAUTH_REQUIRED meanwhile share the one dialog.
 */
type ReauthHandler = () => Promise<void>;

let reauthHandler: ReauthHandler | null = null;
let reauthPending: Promise<void> | null = null;

export const reauth = {
  /** Asks the user to confirm their password; rejects when there is no dialog or the user cancels. */
  request(): Promise<void> {
    if (reauthHandler === null) return Promise.reject(new Error('reauth: no dialog is mounted'));
    reauthPending ??= reauthHandler().finally(() => {
      reauthPending = null;
    });
    return reauthPending;
  },
  /** Registers the dialog (one at a time); returns the function that unregisters it. */
  setHandler(handler: ReauthHandler): () => void {
    reauthHandler = handler;
    return () => {
      if (reauthHandler === handler) reauthHandler = null;
    };
  },
};

/** Called when the server says the session is gone (401 AUTH_REQUIRED), before the sign-in page opens. */
const authLostListeners = new Set<() => void>();

export function onAuthLost(listener: () => void): () => void {
  authLostListeners.add(listener);
  return () => authLostListeners.delete(listener);
}

const DEFAULT_NEXT = '/admin';

/** The sign-in pages: outside the shell and its gate (routes.tsx). */
const SIGN_IN_PATH = /^\/admin\/(?:login(?:\/|$)|forgot-password$|reset-password$)/;

/** Whether `pathname` is one of the sign-in pages (`/admin/login…`, `/admin/forgot-password`, `/admin/reset-password`). */
export function isSignInPath(pathname: string): boolean {
  return SIGN_IN_PATH.test(pathname);
}

/**
 * The sign-in page after the session of the page at `path` ended under the user's hands (idle expiry, a sign-out in
 * another tab, an administrator's action): the notice `session_ended`, and `?next=` back to `path` (through
 * {@link safeNext}; left out for Beranda itself).
 */
export function sessionEndedHref(path: string): string {
  const next = safeNext(path);
  const query = new URLSearchParams();
  if (next !== DEFAULT_NEXT && next !== `${DEFAULT_NEXT}/`) query.set('next', next);
  query.set('notice', 'session_ended');
  return `${LOGIN_PATH}?${query.toString()}`;
}

/**
 * Where the sign-in page sends the user afterwards (M11, no open redirect): `next` when it is a same-origin path
 * under `/admin` (`/admin` itself or `/admin/…`): no scheme, no `//`, no backslash, no whitespace or control
 * character, no `.`/`..` segment (also percent-encoded) and still under `/admin` once resolved. Anything else →
 * `/admin`.
 */
export function safeNext(next: string | null): string {
  if (typeof next !== 'string' || next.length > 2048) return DEFAULT_NEXT;
  if (!/^\/admin(?:\/|$)/.test(next)) return DEFAULT_NEXT;
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused here
  if (next.includes('\\') || next.includes('//') || /[\s\u0000-\u001f\u007f]/.test(next)) return DEFAULT_NEXT;
  const pathPart = next.split(/[?#]/, 1)[0] ?? '';
  if (/%(?:2e|2f|5c)/i.test(pathPart) || /\/\.\.?(?:\/|$)/.test(pathPart)) return DEFAULT_NEXT;
  const base = 'https://altis.invalid';
  let url: URL;
  try {
    url = new URL(next, base);
  } catch {
    return DEFAULT_NEXT;
  }
  if (url.origin !== base || !(url.pathname === '/admin' || url.pathname.startsWith('/admin/'))) return DEFAULT_NEXT;
  return next;
}

function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ERROR_CODES, value);
}

/** `Retry-After` in seconds: a number of seconds, or an HTTP date from now; undefined when absent or unreadable. */
function retryAfter(res: Response): number | undefined {
  const value = res.headers.get('Retry-After');
  if (value === null || value.trim() === '') return undefined;
  if (/^\d+$/.test(value.trim())) return Number(value.trim());
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fieldErrors(value: unknown): FieldError[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter(
    (e): e is FieldError => isRecord(e) && typeof e['path'] === 'string' && typeof e['code'] === 'string',
  ).map((e) => ({ path: e.path, code: e.code }));
}

const isJson = (res: Response): boolean => /[/+]json\b/i.test(res.headers.get('Content-Type') ?? '');

/** Whether `res` is a problem+json document (the server's own error answer). */
const isProblemJson = (res: Response): boolean => /^\s*application\/problem\+json\b/i.test(res.headers.get('Content-Type') ?? '');

async function toApiError(res: Response): Promise<ApiError> {
  let body: unknown;
  if (isJson(res)) body = await res.json().catch(() => undefined);
  const problem = isRecord(body) ? body : {};
  const code = isErrorCode(problem['code']) ? problem['code'] : 'INTERNAL';
  const text = (key: string): string | undefined => (typeof problem[key] === 'string' ? (problem[key] as string) : undefined);
  const errors = fieldErrors(problem['errors']);
  const retryAfterS = retryAfter(res);
  return new ApiError(res.status, code, {
    ...(text('detail') === undefined ? {} : { detail: text('detail') }),
    ...(text('title') === undefined ? {} : { title: text('title') }),
    ...(errors === undefined ? {} : { errors }),
    ...(text('reason') === undefined ? {} : { reason: text('reason') }),
    ...(text('traceId') === undefined ? {} : { traceId: text('traceId') }),
    ...(retryAfterS === undefined ? {} : { retryAfterS }),
    problemJson: isProblemJson(res),
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Method override and client hints (1c Task 16)

/** The request header that names the method a `POST` stands for (server: http/method-override.ts). */
const OVERRIDE_HEADER = 'X-HTTP-Method-Override';
/** This tab met a WAF that refuses PUT/PATCH/DELETE: `'1'` (per tab: a WAF rule may change between visits). */
const OVERRIDE_KEY = 'altis.method-override';

/** The hints the API client and the uploads use (the runner mode, 1d, is read from `auth/me` by the screens). */
type TransportHints = Omit<MeClient, 'runner'>;

/** The client hints of the last `GET auth/me` (null: signed out, before stage `full`, or before the first one). */
let hints: TransportHints | null = null;

/** The client hints of the last successful `GET auth/me`, or null (signed out, stage not `full`, none yet). */
export function clientHints(): TransportHints | null {
  return hints;
}

/** The permissions the last `GET auth/me` listed (none when signed out or before stage `full`), for maintenance. */
let granted: ReadonlySet<string> = new Set();

/** The language of the last `GET auth/me` (the user's, else the library's), for the maintenance screen. */
let uiLocale: Locale = resolveLocale();

/**
 * Keeps what the API client needs of an `auth/me` answer: the `client` hints (anything else, or none: null; a
 * `probedAt` that is not a number: null), the permissions and the language (1c Task 19).
 */
function observeMe(me: unknown): void {
  const signedIn = isRecord(me) && me['authenticated'] === true;
  const permissions = signedIn && Array.isArray(me['permissions']) ? (me['permissions'] as unknown[]) : [];
  granted = new Set(permissions.filter((p): p is string => typeof p === 'string'));
  const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
  const user = signedIn && isRecord(me['user']) ? me['user'] : {};
  const library = isRecord(me) && isRecord(me['library']) ? me['library'] : {};
  uiLocale = resolveLocale(text(user['locale']), text(library['locale']));
  const client = signedIn ? me['client'] : undefined;
  hints =
    isRecord(client) &&
    (client['realtime'] === 'sse' || client['realtime'] === 'polling') &&
    typeof client['methodOverride'] === 'boolean' &&
    typeof client['chunkBytes'] === 'number'
      ? {
          realtime: client['realtime'],
          methodOverride: client['methodOverride'],
          chunkBytes: client['chunkBytes'],
          probedAt: typeof client['probedAt'] === 'number' ? client['probedAt'] : null,
        }
      : null;
}

function tabOverrides(): boolean {
  try {
    return sessionStorage.getItem(OVERRIDE_KEY) === '1';
  } catch {
    return false; // storage blocked: the hint of auth/me and the per-request fallback still work
  }
}

function rememberOverride(): void {
  try {
    sessionStorage.setItem(OVERRIDE_KEY, '1');
  } catch {
    // Storage blocked: every request of this page meets the WAF once more and retries.
  }
}

const OVERRIDABLE: ReadonlySet<HttpMethod> = new Set<HttpMethod>(['PUT', 'PATCH', 'DELETE']);

/** Whether `res` is a WAF refusing the method: 403 or 405 with a page that is not the server's problem+json. */
const isWafRefusal = (res: Response): boolean => (res.status === 403 || res.status === 405) && !isProblemJson(res);

/** Sends one request; with `override`, `method` goes out as `POST` + {@link OVERRIDE_HEADER}. */
async function send(method: HttpMethod, path: string, body: unknown, o: ApiOptions | undefined, override = false): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const form = body instanceof FormData;
  // A FormData body gets its multipart Content-Type (with the boundary) from fetch itself.
  if (body !== undefined && !form) headers['Content-Type'] = 'application/json';
  if (token !== null) headers['X-CSRF-Token'] = token;
  if (o?.background === true) headers['X-Altis-Background'] = '1';
  if (o?.idempotencyKey !== undefined) headers['Idempotency-Key'] = o.idempotencyKey;
  if (override) headers[OVERRIDE_HEADER] = method;
  const res = await fetch(`${API_BASE}${path.replace(/^\/+/, '')}`, {
    method: override ? 'POST' : method,
    headers,
    credentials: 'same-origin',
    ...(body === undefined ? {} : { body: form ? body : JSON.stringify(body) }),
    ...(o?.signal === undefined ? {} : { signal: o.signal }),
  });
  const build = res.headers.get('X-Altis-Build');
  if (build !== null) buildSync.observe(build);
  const rotated = res.headers.get('X-CSRF-Token');
  if (rotated !== null && rotated !== '') token = rotated;
  return res;
}

async function readBody<T>(res: Response): Promise<T> {
  if (res.status === 204 || res.status === 205) return undefined as T;
  const text = await res.text();
  if (text === '') return undefined as T;
  return (isJson(res) ? JSON.parse(text) : text) as T;
}

/** What a fresh `GET auth/me` said of the session behind this page ({@link refreshCsrfToken}). */
interface SessionCheck {
  /**
   * The session is still this page's: the same user (or, before the page's first `auth/me`, whoever it is), and its
   * token was taken. False when it ended or belongs to someone else now (another user signed in on this browser): the
   * page keeps its old token, so nothing it sends goes out under the other identity.
   */
  mine: boolean;
  /** Whether `auth/me` named a signed-in user at all. */
  signedIn: boolean;
}

/** A fresh token from `GET auth/me`, without the retries and redirects of {@link api}, taken only while the session is still this page's. */
async function refreshCsrfToken(): Promise<SessionCheck> {
  const res = await send('GET', ME_PATH, undefined, undefined);
  if (!res.ok) throw await toApiError(res);
  const me = await readBody<unknown>(res);
  observeMe(me);
  if (!isRecord(me)) return { mine: false, signedIn: false };
  const user = me['authenticated'] === true && isRecord(me['user']) && typeof me['user']['id'] === 'string' ? me['user']['id'] : null;
  if (sessionUser !== undefined && user !== sessionUser) return { mine: false, signedIn: user !== null };
  if (typeof me['csrfToken'] === 'string') setCsrfToken(me['csrfToken']);
  return { mine: true, signedIn: user !== null };
}

// ---------------------------------------------------------------------------------------------------------------
// Maintenance (1c Task 19)

/** The operations page: a server page (ops.update_page), so it is loaded, never routed to (routes.tsx opsPageRoute). */
export const OPS_PAGE_PATH = '/admin/_update';

/**
 * Whether `href` (an admin path) is a page the server serves itself, outside the SPA (the operations page): a link to
 * it loads it, the router never takes it.
 */
export function isServerPage(href: string): boolean {
  return (href.split(/[?#]/, 1)[0] ?? '') === OPS_PAGE_PATH;
}

/** Who follows an op of each maintenance `reason` on the operations page (decision C20). */
const REASON_PERMISSION: Readonly<Record<string, Permission>> = Object.freeze({
  restore: 'system.backup.restore',
  backup: 'system.backup.create',
  update: 'system.update.run',
});

/**
 * Whom the operations page opens for during a maintenance of each `reason` (the server's opsAuth, http/ops-auth.ts:
 * the permission of the op's kind, OP_KIND_PERMISSION; without an op, a `manual` maintenance, any op permission).
 * The maintenance screen links the page only for them: anyone else would get 403 AUTHZ_DENIED there. An unknown or
 * missing reason links nothing.
 */
const PAGE_PERMISSIONS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  restore: ['system.backup.restore'],
  backup: ['system.backup.create'],
  update: ['system.update.run'],
  install: ['system.config.manage'],
  migrate: ['system.config.manage'],
  reset: ['system.config.manage'],
  manual: ['system.update.run', 'system.backup.restore', 'system.backup.create'],
});

/** The page is on its way to the operations page: the other requests failing meanwhile do not load it again. */
let leavingForOps = false;

/**
 * Whether the maintenance is over, asked by the maintenance screen: `GET auth/me` answers (a restore refuses it)
 * without `maintenance: true` (a normal maintenance leaves `auth/me` open and says so there, signed in or not) and
 * without a `maintenance` banner. A background request: the screen never keeps the session alive.
 */
async function maintenanceOver(): Promise<boolean> {
  const res = await send('GET', ME_PATH, undefined, { background: true });
  if (!res.ok) return false;
  const me = await readBody<unknown>(res);
  observeMe(me);
  if (isRecord(me) && me['maintenance'] === true) return false;
  const banners = isRecord(me) && Array.isArray(me['banners']) ? (me['banners'] as unknown[]) : [];
  return !banners.some((b) => isRecord(b) && b['kind'] === 'maintenance');
}

/** A 503 MAINTENANCE with `reason`: the operations page for whoever may follow the op, else the maintenance screen. */
function followMaintenance(reason: string | undefined): void {
  const needed =
    reason !== undefined && Object.prototype.hasOwnProperty.call(REASON_PERMISSION, reason) ? REASON_PERMISSION[reason] : undefined;
  if (needed !== undefined && granted.has(needed)) {
    const pathname = page.path().split(/[?#]/, 1)[0] ?? '';
    if (pathname !== OPS_PAGE_PATH && !leavingForOps) {
      leavingForOps = true;
      page.assign(OPS_PAGE_PATH);
    }
    return;
  }
  // Ruling R1c-9: the screen links the operations page for whoever it opens for during this reason.
  const opensFor =
    reason !== undefined && Object.prototype.hasOwnProperty.call(PAGE_PERMISSIONS, reason) ? PAGE_PERMISSIONS[reason] : undefined;
  const mayFollow = opensFor !== undefined && opensFor.some((p) => granted.has(p));
  showMaintenanceScreen({ locale: uiLocale, over: maintenanceOver, ...(mayFollow ? { link: OPS_PAGE_PATH } : {}) });
}

/** Moves to the page the server says the user belongs on; the caller still gets the error. */
function followAuthProblem(error: ApiError): void {
  const here = page.path();
  const pathname = here.split(/[?#]/, 1)[0] ?? '';
  const go = (href: string): void => {
    if (pathname !== href.split('?', 1)[0]) page.navigate(href);
  };
  if (error.status === 401 && error.code === 'AUTH_REQUIRED') {
    for (const listener of authLostListeners) listener();
    // A form being filled stays on screen with what was typed: the shell says the session ended and offers to sign
    // in again (components/shell/app-shell.tsx), so that nothing is lost without a word.
    if (pathname === LOGIN_PATH || dirtyForms.count() > 0) return;
    go(isSignInPath(pathname) ? LOGIN_PATH : sessionEndedHref(here));
  } else if (error.status === 401 && error.code === 'AUTH_MFA_REQUIRED') {
    go(`${LOGIN_PATH}/2fa`);
  } else if (error.status === 403 && error.code === 'AUTH_PASSWORD_CHANGE_REQUIRED') {
    go('/admin/profile/password');
  }
}

/** How many {@link inBackground} calls are running (they may nest). */
let backgroundDepth = 0;

/**
 * Runs `f`; every request {@link api} starts while `f` runs (synchronously) goes out as a background one
 * (`X-Altis-Background: 1`, {@link ApiOptions.background}), so that it never keeps the session alive (spec §7.1: an
 * unattended tab must reach the idle limit). For the requests nobody asked for: the realtime client's invalidations
 * (lib/realtime.ts invalidateRealtimeKeys; TanStack Query calls a query function at once when an invalidation refetches
 * it) and its `auth/me` after a refused channel or an SSE back-off (the shell). A fetch that only starts later (a
 * retry after a failure, a query paused while offline) goes out as usual.
 */
export function inBackground<T>(f: () => T): T {
  backgroundDepth += 1;
  try {
    return f();
  } finally {
    backgroundDepth -= 1;
  }
}

/**
 * Sends `method path` (relative to /api/v1) with `body` as JSON (a FormData as it is) and resolves to the parsed
 * answer (undefined for a 204). Rejects with an {@link ApiError} for a problem (see the top of this file for the
 * retries, the redirects and method override). Inside {@link inBackground} it is a background request.
 */
export async function api<T>(method: HttpMethod, path: string, body?: unknown, options?: ApiOptions): Promise<T> {
  // Read before anything is awaited: inBackground only covers what starts while it runs.
  const o = backgroundDepth > 0 && options?.background !== true ? { ...options, background: true } : options;
  let reauthed = false;
  let refreshed = false;
  const overridable = OVERRIDABLE.has(method) && o?.methodOverride !== false;
  let override = overridable && (hints?.methodOverride === true || tabOverrides());
  /** The override is this request's own fallback after a WAF page: remembered for the tab once the server answers. */
  let fallback = false;
  for (;;) {
    const res = await send(method, path, body, o, override);
    if (fallback && !isWafRefusal(res)) {
      rememberOverride();
      fallback = false;
    }
    if (overridable && !override && isWafRefusal(res)) {
      override = true;
      fallback = true;
      continue;
    }
    if (res.ok) {
      const answer = await readBody<T>(res);
      if (method === 'GET' && path.replace(/^\/+/, '') === ME_PATH) observeMe(answer);
      return answer;
    }
    const error = await toApiError(res);
    if (error.status === 401 && error.code === 'AUTH_REAUTH_REQUIRED' && !reauthed) {
      reauthed = true;
      try {
        await reauth.request();
      } catch {
        throw error;
      }
      continue;
    }
    if (error.status === 403 && error.code === 'CSRF_INVALID' && !refreshed && path.replace(/^\/+/, '') !== ME_PATH) {
      refreshed = true;
      if ((await refreshCsrfToken()).mine) continue;
      // The session behind this page ended or is someone else's now: never repeat the request under it. The page
      // goes where a lost session goes (the sign-in page; the shell's warning while a form is dirty).
      followAuthProblem(new ApiError(401, 'AUTH_REQUIRED'));
      throw error;
    }
    if (error.status === 403 && error.code === 'METHOD_OVERRIDE_DENIED' && override) {
      // The server takes an override only under a session (C37): on a cookie route this refusal is what a lost session
      // looks like through the override, where a real PUT would have met 401 AUTH_REQUIRED. Once auth/me confirms the
      // session is gone (or someone else's), the page goes where a lost session goes; otherwise the refusal is the
      // answer. An auth/me that cannot answer proves nothing: the refusal is the answer too.
      const check = await refreshCsrfToken().catch(() => null);
      if (check !== null && !(check.mine && check.signedIn)) followAuthProblem(new ApiError(401, 'AUTH_REQUIRED'));
      throw error;
    }
    if (error.status === 503 && error.code === 'MAINTENANCE') {
      followMaintenance(error.reason);
      throw error;
    }
    followAuthProblem(error);
    throw error;
  }
}
