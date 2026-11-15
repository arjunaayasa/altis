import { AsyncLocalStorage } from 'node:async_hooks';
import { BUCKETS, hit, txCtx, type Actor, type AuditInput, type BucketName, type InstallSession, type TxCtx } from '@altis/core';
import { withTx, type DbHandle } from '@altis/db';
import {
  DomainError,
  isAuditAction,
  isDomainError,
  isPermission,
  permissionCatalog,
  type AuditAction,
  type IpTrust,
  type Permission,
} from '@altis/shared';
import type { Context, Hono, MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode, StatusCode } from 'hono/utils/http-status';
import type { z } from 'zod';
import type { AppState } from '../app.js';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import { loggableError } from '../safe-error.js';
import type { AppServices } from '../services.js';
import { checkInstallRoute } from '../install/gate.js';
import { auditDenial, authorize, markTestGate, resolveAuth, type OpsGate, type ResolvedAuth } from './auth.js';
import type { AuthState } from './auth-state.js';
import { applyPersistedIpTrust, countIpLimits } from './client-ip.js';
import { checkCsrfOrigin, checkOpsCsrfOrigin, checkSideEffectGet } from './csrf.js';
import { beginIdempotency, finishIdempotency, releaseIdempotency, replayResponse, type IdempotencyClaim } from './idempotency.js';
import { maintenanceRefusal, refusalResponse } from './maintenance.js';
// ---- Komunitas (member area) ----
import { readFormBody, type FormBody } from './form.js';
import { checkMemberCsrf, memberRedirect, memberSignInRedirect, resolveMemberAuth, type MemberAuthState } from './member-auth.js';
import { isOverridden } from './method-override.js';
import { opsCookieOp, opsSessionAllowed, type OpsAuth } from './ops-auth.js';
import type { AppEnv } from './request-id.js';
import { validateInput } from './validate.js';
// ---- Komunitas K2 (visits) ----
import { checkFormCsrf, readFormBody as readStationFormBody, resolveVisitStation, type VisitStationAuth } from './visit-station.js';

// The route-declaration contract (spec §4.6) and the per-route part of the middleware chain (§4.7, steps 5-13).
//
// Every route the app serves is a RouteDecl. defineRoutes refuses an incomplete or contradictory declaration (its
// body, query and params schemas strict at every depth), and createApp calls assertAllRoutesDeclared last, so a Hono
// route without a declaration fails startup. Method `ALL` entries pass only for the middleware createApp registers
// through declareMiddleware: a raw `app.all(...)` or an undeclared `app.use(...)` fails startup too.
//
// mountRoutes runs, per route and in this order:
//      method override (1c Task 16)   a request sent as `POST` + `X-HTTP-Method-Override` (http/method-override.ts;
//                                     it arrives here as the method it names, with the header) is refused with 403
//                                     METHOD_OVERRIDE_DENIED on a Bearer, `session: 'none'` or wizard route and on a
//                                     probe route (`*.probe.methods.*`), and after step 7 when no session resolved;
//                                     step 8 then checks it as any write (P10, C37)
//   5  maintenance                    1c Task 15 (decision C20): http/maintenance.ts checkMaintenance on the flag the
//                                     ops fence read (`services.opsFence`), before step 3's persisted part: no flag
//                                     → pass; a restore → only `restore-allow`; otherwise `allow` and `restore-allow`
//                                     (and the wizard's routes during `install-migrate`); else 503 MAINTENANCE
//   6  rate limiter (`ipLimits`)      one hit per bucket and client IP, each in its own transaction; skipped
//                                     unless the IP is trusted (`ipTrust` ok, D13), which needs the persisted
//                                     `system.ip_trust` (read first for every route but `session: 'none'` ones,
//                                     never during a restore: its tables may be gone, S2)
//   7  session                        http/auth.ts resolveAuth: the `altis_sid` session, its staff user and grants,
//                                     rotation when the rights changed (routes under /api only, ruling R1b-1), the
//                                     touch; never for `session: 'none'` (no cookie read, no database: S29), and no
//                                     cookie read for `auth: 'bearer'`; a `background` route (1c) neither rotates nor
//                                     touches, as a request with `X-Altis-Background: 1`. 1c Task 15: an `opsAuth`
//                                     route skips it past a restore's point of no return and in `ops_wait` (S3; the
//                                     `altis_ops` cookie alone opens it then, http/ops-auth.ts)
//   8  CSRF/Origin                    non-GET `auth: 'cookie'` routes: Sec-Fetch-Site, Origin/Referer, X-CSRF-Token
//                                     (against the session step 7 found; on an `opsAuth` route, 1c Task 15, the
//                                     session's token or the op's of the request's `altis_ops`, http/csrf.ts
//                                     checkOpsCsrfOrigin); a GET `auth: 'cookie'` route with side
//                                     effects (an `audit` action, or `sideEffects`): HEAD → 404 and Sec-Fetch-Site,
//                                     Origin/Referer (T23: a cross-site link never writes its audit entry). Phase 2
//                                     (Task 2): not for a cookieless read-only route (isCookielessRead, OAI-PMH's
//                                     POST), which reads no cookie and changes nothing
//   9  declarative authorization      http/auth.ts authorize, deny by default; not for `session: 'none'`; an
//                                     `opsAuth` route by http/ops-auth.ts authorizeOps (`rc.opsAuth`)
//   10 edition gate                   `services.editionGate` (http/edition-gate.ts, ruling R2) with the route and its
//                                     mode (routeMode: as declared, else GET `read`, otherwise `write`); the community
//                                     edition's gate refuses nothing. Authorized but not yet validated: it gets the
//                                     request context with the raw path parameters, and no body or query
//   11 validation                     validate.ts (a `rawBody` route: its content type and size only, the
//                                     handler reads the body itself)
//   12 idempotency                    http/idempotency.ts, for `store` routes with an `Idempotency-Key` and a
//                                     session: the key's row booked (its own transaction), or the stored response
//                                     replayed, or 409/422; the row is marked `done` in the handler transaction, and
//                                     deleted again when `prepare` or the handler ends in a 4xx
//      prepare                        slow work (scrypt) outside any transaction (S18); errors map like the handler's.
//                                     On a `tx: 'handler'` route it writes nothing: rc.withTx and rc.audit throw a
//                                     TypeError there (it reads through rc.db), so the handler transaction holds the
//                                     route's only audit entry
//   13 handler                        see "Transactions" below
//
// A wizard route (`install`, 1c Task 10, decision C19; install/gate.ts checkInstallRoute) runs the wizard's own checks
// in place of steps 7-9: first the install gate (installed → 404 NOT_FOUND, read from the files on every request, so a
// process spawned before the install finished answers 404 at once; a lost volume or DATA_DIR → 503), then for
// `claim` an http(s) `Origin` and no cross-site `Sec-Fetch-Site`, for `claimed` a valid `altis_install` claim
// (INSTALL_CLAIM_REQUIRED) and, on a non-GET request, the claim's Origin and the wizard's `X-CSRF-Token` (1d Task 18:
// on a `sideEffects` GET, HEAD → 404 and no cross-site `Sec-Fetch-Site` or foreign `Origin`, as step 8). The gate
// comes first so that an installed system answers 404 whatever the request carries. Its database (rc.db, rc.withTx,
// the audit-once check) is `MountOptions.dbFor(decl)`: the wizard's own handle (services.install.db()).
//
// Transactions (decision D3, ruling R37/R49):
// - A non-GET route with `tx: 'handler'` (the default) runs its handler inside one withTx: `rc.trx` is that
//   transaction and `rc.tx()` its TxCtx. The framework runs no statement in it before the handler does (Task 11's
//   super-admin guard must be the transaction's first statement).
// - A GET route, or a route with `tx: 'self'`, gets `rc.trx = null` and opens its own transactions with `rc.withTx`
//   (also the TxRunner core services take, M38). Every route that calls the rate limiter is `tx: 'self'`: a 429 must
//   not roll back the counter it just incremented.
// - Audit once (B3, decision D37): a route whose `audit` is an action appends exactly one entry of that action;
//   besides it only the security set (SECURITY_AUDIT_ACTIONS) and the route's own `alsoAudits` may be appended, and
//   with `audit: null` only those. A request that repeats an earlier one whose answer was lost (P7) may instead find
//   that earlier entry with `rc.auditedBefore` (the declared action, the same entity and entity id, the same actor):
//   it then stands for the request's one entry, so the action is audited once, not once per resend (1c Task 21, a
//   repeated `backups.upload`). Anything else is 500 AUDIT_MISSING: checked before COMMIT of the handler
//   transaction (which then rolls back), or when a `tx: 'self'`/GET handler resolves (what it committed stays,
//   `prepare`'s transactions included). Only entries written through the route's TxCtx (`rc.audit`, `rc.tx().audit`, the `tx` of
//   `rc.withTx`) count. A `tx: 'handler'` route's `prepare` cannot audit at all (above), so nothing it could have
//   committed escapes the check.
// - Per attempt: the audit counts, the `afterCommit` hooks and the `afterResponse` hooks registered inside a
//   transaction belong to one withTx attempt; an R37 retry starts from zero, and the hooks of an attempt that did not
//   commit never run. `afterCommit` hooks run (in order, awaited) after their COMMIT. A failing hook is logged, never
//   thrown.
// - `afterResponse` hooks run on setImmediate after the response, and only when the handler returned one: a route
//   that ends in an error (anything thrown, problem+json) drops every `afterResponse` hook, those registered in
//   transactions that did commit (`tx: 'self'`, GET) included. Follow-up work of a commit that must happen however
//   the route ends belongs in `afterCommit`.
// - Because withTx may run the handler again (R37), a handler keeps its side effects inside the transaction or in
//   these hooks.
//
// Response headers (ruling R1b-1): every response carries the headers set on the context (`c.header`), a Response the
// handler built itself included. A route that ends in an error keeps only those set before `prepare` and the handler
// ran (steps 7 and 9: a rotated or cleared `altis_sid`, `X-CSRF-Token`, the test gate): a cookie the handler set for
// work its rolled-back transaction undid never goes out.
//
// ---- Komunitas (member area) ----
// A route of the OPAC member area is declared `member` (`required` | `optional`) with `public: true` and `session:
// 'none'`, under `/akun`: step 7 reads no staff cookie for it and resolves the member session of `altis_msid` instead
// (http/member-auth.ts; `rc.member`, the actor `{type: 'member', id}`); a `form: true` route's HTML form body is read
// first (http/form.ts: urlencoded, ≤ 16 KB, no field twice), so that step 8 takes the token from its `_csrf` field
// (or `X-CSRF-Token`): the Origin rule, then the member session's token, or the pre-session token for the sign-in,
// forgotten-password and set-password forms (PRE_SESSION_FORMS). A `required` route without a signed-in member is a
// 303 to `/akun/masuk` (a GET carries its own path as `lanjut`), a member who must set a new password reaches only
// MUST_RESET_ROUTES, and a member's write counts `member_write` per session. Step 11 validates the form's fields
// (without `_csrf`) with the route's `body` schema.

export type RouteMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** What a handler returns: a Response as it is, or JSON `body` (204 without one) with `status` and `headers`. */
export type RouteResult = Response | { status?: number; body?: unknown; headers?: Record<string, string> };

export type RouteHook = () => void | Promise<void>;

type Trx = TxCtx['trx'];

export interface RouteDecl<B = unknown, Q = unknown, P = unknown> {
  /** Unique, dotted (`users.create`): the route catalog and the audit/matrix tests name routes by it. */
  id: string;
  method: RouteMethod;
  /** Hono path, absolute. */
  path: string;
  /** Exactly one of `permission`, `public` and `opsAuth`. */
  permission?: Permission;
  public?: true;
  /** A session with an operations permission or a valid `altis_ops` cookie (§9.4, 1c). */
  opsAuth?: true;
  /** Only with `public` (decision D2). Default `optional`; `none` never reads cookies (S29). */
  session?: 'required' | 'optional' | 'none';
  /** Reachable by a pre-2FA session (§7.1). */
  partialAuth?: boolean;
  /** Needs a password confirmation within the last 5 minutes (§7.3). */
  reauth?: boolean;
  /** What the edition gate (step 10, http/edition-gate.ts) sees of the route; default GET `read`, otherwise `write`. */
  mode?: 'read' | 'write' | 'system';
  /** Default `deny` (§9.4). */
  maintenance?: 'allow' | 'deny' | 'restore-allow';
  /**
   * `store` (§7.9, http/idempotency.ts): a request with an `Idempotency-Key` runs once per key and subject, and the
   * same key replays its response; the handler then returns a RouteResult (not a Response) without `headers` (they
   * are not replayed) whose JSON body is at most 60000 bytes and holds no secret. A `store` route takes no `query`
   * (the request hash does not cover it). `none` for `auth/*`, `users/:id/reset-password|reset-2fa` and secret
   * responses.
   */
  idempotency: 'store' | 'none';
  audit: AuditAction | null;
  /**
   * Actions that a path of the route may append besides `audit` and the security set (e.g. `auth.2fa.verify`, whose
   * audit is the auth layer's, D9, audits the 2FA reset of a re-enrolment, D15, as `auth.2fa.disable`). Never `audit`
   * itself (its one entry stays required), never a security action (always allowed), no duplicates.
   */
  alsoAudits?: readonly AuditAction[];
  /** Default `cookie`; `bearer` routes read no cookie and skip CSRF/Origin (§7.4). */
  auth?: 'cookie' | 'bearer';
  /**
   * A GET route whose request changes something besides its audit entry (1c: `backups.download`, whose completed
   * download starts the deletion of the prepared archive). It, and every GET route with an `audit` action
   * (`audit.export`), is a side-effect GET: step 8 answers HEAD with 404 and refuses a cross-site request with
   * ORIGIN_DENIED before anything runs (T23). GET only.
   */
  sideEffects?: boolean;
  /** The path parameter holding the branch id of a branch-scoped permission. */
  branchParam?: string;
  /** Per-IP buckets counted at step 6 (Task 12). */
  ipLimits?: BucketName[];
  /**
   * A route a page calls on its own (1c, Task 8: the events poll and stream): step 7 never touches or rotates its
   * session, as for a request with `X-Altis-Background: 1`, so it never keeps an idle session alive. GET only.
   */
  background?: true;
  /** Non-GET only; default `handler` (decision D3). */
  tx?: 'handler' | 'self';
  /**
   * Slow work (scrypt) after validation, outside any transaction; its result is `rc.prepared` (S18). On a
   * `tx: 'handler'` route it writes nothing: `rc.withTx` and `rc.audit` throw a TypeError there.
   */
  prepare?(rc: RouteContext<B, Q, P>): Promise<unknown>;
  /**
   * A body the handler reads itself (1c, Task 9): `multipart` for P10's chunked uploads. POST only, without a `body`
   * schema and with `idempotency: 'none'` (the request hash covers JSON bodies only). Step 11 refuses any content type
   * but `multipart/form-data` (415 UNSUPPORTED_MEDIA_TYPE) and a body over `maxBytes` (413 PAYLOAD_TOO_LARGE); the
   * handler then reads `rc.c.req.formData()`.
   */
  rawBody?: { type: 'multipart'; maxBytes: number };
  /**
   * A route of the install wizard (1c Task 10, decision C19): `page` (GET `/install`), `claim` (the claim, under
   * `/install/api/`) or `claimed` (every other route under `/install/api/`, open only to the claim's holder). Needs
   * `public: true` and `session: 'none'`, and then a non-GET route is allowed too (reason `install_decl_invalid`
   * otherwise). See the top of this file for the checks it runs instead of steps 7-9.
   */
  install?: 'page' | 'claim' | 'claimed';
  // ---- Komunitas K2 (visits) ----
  /**
   * A guestbook station's page (`/kunjungan` and below; `public` without a `session`): step 7 never reads the staff
   * session (`altis_sid`), only the station's own cookie `altis_vs` (rc.visitStation, null without a live station).
   */
  visitStation?: true;
  // ---- Komunitas (member area) ----
  /**
   * A route of the OPAC member area (see the top of this file): `required` or `optional` member session. Only with
   * `public: true`, `session: 'none'` and a path at or under `/akun`; besides, `GET /files/:id` may be `optional` (its
   * handler reads the member session for an attachment of access `members`).
   */
  member?: 'required' | 'optional';
  /**
   * An HTML form body (`application/x-www-form-urlencoded`, at most 16 KB), read before step 8, which takes the CSRF
   * token from the `_csrf` field. On a POST of a `visitStation` route (http/visit-station.ts) or a non-GET `member`
   * route (http/form.ts); `idempotency: 'none'`, no `rawBody`; the `body` schema validates the fields (`_csrf` is
   * removed before it).
   */
  form?: true;
  /** Strict Zod objects (`z.strictObject`) whose nested objects are strict too, spec §7.4. */
  body?: z.ZodType<B>;
  query?: z.ZodType<Q>;
  params?: z.ZodType<P>;
  handler(rc: RouteContext<B, Q, P>): Promise<RouteResult>;
}

export interface RouteContext<B = unknown, Q = unknown, P = unknown> {
  /** The validated body; undefined without a `body` schema. */
  body: B;
  /** The validated query; undefined without a `query` schema. */
  query: Q;
  /** The validated path parameters; without a `params` schema the raw ones (`Record<string, string>`). */
  params: P;
  /** Epoch ms of the request (one clock reading for all of it). */
  now: number;
  requestId: string;
  log: Logger;
  ip: string | null;
  ipTrust: IpTrust;
  /** The session step 7 resolved (http/auth.ts); null without one, on a Bearer route and on `session: 'none'`. */
  auth: AuthState | null;
  /** `{type: 'staff', id, ip}` with a session, else `{type: 'anonymous', id: null, ip}`. */
  actor: Actor;
  /** The database; reading it without one throws DB_UNAVAILABLE. */
  readonly db: DbHandle;
  /** The handler transaction: set while a non-GET `tx: 'handler'` handler runs, null otherwise. */
  trx: Trx | null;
  /** The handler transaction's TxCtx (its audits count). @throws TypeError unless `trx` is set */
  tx(o?: { actor?: Actor }): TxCtx;
  /**
   * A transaction of its own (GET routes, `tx: 'self'`, their `prepare`); its audits count.
   * @throws TypeError inside the handler transaction, and inside the `prepare` of a `tx: 'handler'` route
   */
  withTx<T>(fn: (tx: TxCtx) => Promise<T>, o?: { actor?: Actor }): Promise<T>;
  /**
   * Appends an entry of the declared action in the current transaction (the handler's, or the `rc.withTx` it is
   * called in); outside any, in a transaction of its own.
   * @throws TypeError when the route declares `audit: null`, and inside the `prepare` of a `tx: 'handler'` route
   */
  audit(e: Omit<AuditInput, 'action'>): Promise<void>;
  /**
   * For a request that repeats an earlier one whose answer was lost (P7): looks, in the current transaction, for an
   * entry of the declared action on `entity`/`entityId` whose actor is the transaction's. When there is one, it stands
   * for this request's one entry (the action was audited when it happened; a resend appends nothing) and true is
   * returned; otherwise false, nothing is counted and the request audits as usual.
   * @throws TypeError when the route declares `audit: null`, and outside a transaction
   */
  auditedBefore(e: { entity: string; entityId: string }): Promise<boolean>;
  /** Runs `fn` after the COMMIT of the current transaction. @throws TypeError outside a transaction */
  afterCommit(fn: RouteHook): void;
  /**
   * Runs `fn` on setImmediate after the handler's response; dropped when the route ends in an error, and with an
   * attempt that did not commit (use `afterCommit` for what must follow a commit regardless).
   */
  afterResponse(fn: RouteHook): void;
  /** What `prepare` returned (undefined without one). */
  prepared: unknown;
  /**
   * A refusal of `permission` decided by the route itself, for a permission its declaration cannot name (a job
   * handler's, a schedule's, an upload context's): counted on `authz-denied` and, for a `system.*` permission, audited
   * as `authz.denied` the way step 9 does it (§7.8; the first hit of the minute, each in a transaction of its own, so
   * neither depends on how the request ends). Resolves to the 403 AUTHZ_DENIED to throw. Called from `prepare` or from
   * a handler outside any transaction (a `tx: 'handler'` route decides it in `prepare`).
   * @throws TypeError inside a transaction of the route
   */
  authzDenied(permission: string): Promise<DomainError>;
  /** The installed config. @throws TypeError when none is loaded */
  readonly config: Config;
  services: AppServices;
  c: Context<AppEnv>;
  /** The install claim of an `install: 'claimed'` route (1c Task 10); null on every other route. */
  installSession: InstallSession | null;
  /** What `opsAuth` decided for an `opsAuth` route (1c Task 15, http/ops-auth.ts); null on every other route. */
  opsAuth: OpsAuth | null;
  /** The guestbook station of a `visitStation` route's `altis_vs` cookie (Komunitas K2); null otherwise. */
  visitStation: VisitStationAuth | null;
  // ---- Komunitas (member area) ----
  /** The signed-in member of a `member` route (http/member-auth.ts); null without one, and on every other route. */
  member: MemberAuthState | null;
}

/** What mountRoutes runs the routes with. */
export interface MountOptions {
  state: AppState;
  services: AppServices;
  /** For hook failures when the request has no logger child (the request-id middleware sets one). */
  log?: Logger;
  /**
   * The database of a route's `rc.db`, `rc.withTx` and handler transaction (1c Task 10): createApp answers the wizard's
   * own handle (services.install.db()) for an `install` declaration and `state.db` for the others. Default `state.db`.
   */
  dbFor?(decl: RouteDecl): DbHandle | undefined;
}

/** Audit actions any route may append besides its own (decision D37). */
export const SECURITY_AUDIT_ACTIONS: ReadonlySet<AuditAction> = new Set<AuditAction>([
  'auth.login.success',
  'auth.login.failed',
  'authz.denied',
  'auth.remember.reuse',
]);

/** Keeps type inference for one declaration (`body`, `query`, `params` → `rc`); returns it unchanged. */
export function route<B = unknown, Q = unknown, P = unknown>(decl: RouteDecl<B, Q, P>): RouteDecl {
  return decl as unknown as RouteDecl;
}

// ---------------------------------------------------------------------------------------------------------------
// defineRoutes

const METHODS: readonly string[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

const ENUM_KEYS: Readonly<Record<string, readonly unknown[]>> = {
  session: ['required', 'optional', 'none'],
  mode: ['read', 'write', 'system'],
  maintenance: ['allow', 'deny', 'restore-allow'],
  idempotency: ['store', 'none'],
  auth: ['cookie', 'bearer'],
  tx: ['handler', 'self'],
  // ---- Komunitas (member area) ----
  member: ['required', 'optional'],
};

/** The parts of a Zod (v4) schema definition the strictness walk reads. */
interface SchemaDef {
  type?: unknown;
  catchall?: unknown;
  shape?: Record<string, unknown>;
  innerType?: unknown;
  element?: unknown;
  options?: readonly unknown[];
  keyType?: unknown;
  valueType?: unknown;
  items?: readonly unknown[];
  rest?: unknown;
  left?: unknown;
  right?: unknown;
  in?: unknown;
  out?: unknown;
  getter?: () => unknown;
}

function defOf(schema: unknown): SchemaDef | undefined {
  return (schema as { _zod?: { def?: SchemaDef } } | null | undefined)?._zod?.def;
}

/** The schemas `def` contains: object members, wrapped types, array/tuple/set elements, union and intersection
 *  members, record and map keys and values, both ends of a pipe, a lazy schema's target. */
function childSchemas(def: SchemaDef): unknown[] {
  const out: unknown[] = [];
  if (def.type === 'object' && def.shape !== undefined) out.push(...Object.values(def.shape));
  if (def.type === 'lazy' && typeof def.getter === 'function') out.push(def.getter());
  for (const one of [def.innerType, def.element, def.keyType, def.valueType, def.rest, def.left, def.right, def.in, def.out]) {
    if (one !== undefined && one !== null) out.push(one);
  }
  for (const list of [def.options, def.items]) {
    if (Array.isArray(list)) out.push(...(list as unknown[]));
  }
  return out;
}

/**
 * A strict input schema (spec §7.4): a `z.strictObject` (a ZodObject whose catchall is `z.never()`; refinements
 * keep it one, a transform does not), and every object nested in it, at any depth and through any wrapper
 * (optional, nullable, default, array, union, record, pipe, lazy, ...), is one too.
 */
function isStrictObject(schema: unknown): boolean {
  if (defOf(schema)?.type !== 'object') return false;
  const seen = new Set<unknown>();
  const walk = (s: unknown): boolean => {
    if (seen.has(s)) return true; // a lazy schema that refers to itself
    seen.add(s);
    const def = defOf(s);
    if (def === undefined) return true;
    if (def.type === 'object' && defOf(def.catchall)?.type !== 'never') return false;
    return childSchemas(def).every(walk);
  };
  return walk(schema);
}

/** The `:name` parameters of a Hono path. */
function pathParams(path: string): string[] {
  return [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]!);
}

/** `METHOD path` with parameter names erased: `/x/:id` and `/x/:key` are the same route. */
function routeKey(decl: RouteDecl): string {
  return `${decl.method} ${decl.path.replace(/:[^/]+/g, ':')}`;
}

// ---- Komunitas (member area) ----
/** The forms posted before a member is signed in: their CSRF token is the pre-session one of `altis_csrf`. */
export const PRE_SESSION_FORMS: ReadonlySet<string> = new Set(['/akun/masuk', '/akun/lupa-sandi', '/akun/atur-sandi/:token']);

/** The routes a member who must set a new password may still reach (the password page, signing out). */
export const MUST_RESET_ROUTES: ReadonlySet<string> = new Set(['akun.password', 'akun.password.change', 'akun.logout']);

/** A route of the OPAC member area: `member` with `session: 'none'` (not `GET /files/:id`, which reads it itself). */
export function isMemberRoute(d: RouteDecl): boolean {
  return d.member !== undefined && d.session === 'none';
}

// ---- Phase 2 (catalog): Task 2 ----
/**
 * A cookieless read-only route (Phase 2 spec §10, decision D2-34; OAI-PMH's `POST /oai`): a non-GET route that is
 * `public` with `session: 'none'`, declares `mode: 'read'` explicitly, stores no response (`idempotency: 'none'`),
 * audits nothing (`audit: null`, no `alsoAudits`), declares no `body` schema and no `rawBody` (its handler reads the
 * form itself, within its own limits), and asks for no reauth or partial authentication. Such a route reads no cookie
 * and changes nothing, so a cross-site request gains nothing from it: step 8 (CSRF/Origin) is skipped for it. It is
 * the only non-GET `session: 'none'` route besides the wizard's; any other is `session_none_conflict`.
 */
export function isCookielessRead(d: RouteDecl): boolean {
  const raw = d as unknown as Record<string, unknown>;
  return (
    d.method !== 'GET' &&
    d.public === true &&
    d.session === 'none' &&
    raw['mode'] === 'read' &&
    d.idempotency === 'none' &&
    d.audit === null &&
    d.alsoAudits === undefined &&
    d.body === undefined &&
    raw['rawBody'] === undefined &&
    d.reauth !== true &&
    d.partialAuth !== true &&
    d.install === undefined
  );
}

/** Why `d` is invalid (the reason of ROUTE_DECL_INVALID), or null. */
function declProblem(d: RouteDecl): string | null {
  const raw = d as unknown as Record<string, unknown>;
  if (
    typeof d.id !== 'string' ||
    d.id === '' ||
    d.method === undefined ||
    d.path === undefined ||
    d.idempotency === undefined ||
    d.audit === undefined ||
    typeof d.handler !== 'function'
  ) {
    return 'incomplete';
  }
  if (!METHODS.includes(d.method) || typeof d.path !== 'string' || !d.path.startsWith('/')) return 'invalid_value';
  for (const [key, allowed] of Object.entries(ENUM_KEYS)) {
    if (raw[key] !== undefined && !allowed.includes(raw[key])) return 'invalid_value';
  }
  for (const key of ['partialAuth', 'reauth', 'sideEffects']) {
    if (raw[key] !== undefined && typeof raw[key] !== 'boolean') return 'invalid_value';
  }
  if (d.sideEffects === true && d.method !== 'GET') return 'invalid_value';
  // `background` (1c, Task 8): `true` on a GET route only.
  if (raw['background'] !== undefined) {
    if (raw['background'] !== true) return 'invalid_value';
    if (d.method !== 'GET') return 'background_not_get';
  }
  if (d.prepare !== undefined && typeof d.prepare !== 'function') return 'invalid_value';
  if (d.branchParam !== undefined && typeof d.branchParam !== 'string') return 'invalid_value';
  if (d.ipLimits !== undefined && (!Array.isArray(d.ipLimits) || !d.ipLimits.every((b) => Object.hasOwn(BUCKETS, b)))) {
    return 'invalid_value';
  }

  // `rawBody` (1c, Task 9): a multipart body on a POST route that declares no `body` schema and stores no response.
  if (raw['rawBody'] !== undefined) {
    const rb = raw['rawBody'] as { type?: unknown; maxBytes?: unknown } | null;
    const shapeOk =
      typeof rb === 'object' &&
      rb !== null &&
      !Array.isArray(rb) &&
      rb.type === 'multipart' &&
      typeof rb.maxBytes === 'number' &&
      Number.isSafeInteger(rb.maxBytes) &&
      rb.maxBytes > 0;
    if (!shapeOk || d.method !== 'POST' || d.body !== undefined || d.idempotency !== 'none') return 'raw_body_invalid';
  }

  const given = [d.permission, d.public, d.opsAuth].filter((v) => v !== undefined).length;
  if (given !== 1 || (d.public !== undefined && d.public !== true) || (d.opsAuth !== undefined && d.opsAuth !== true)) {
    return 'access';
  }
  if (d.session !== undefined && d.public !== true) return 'session_without_public';
  if (d.permission !== undefined && (typeof d.permission !== 'string' || !isPermission(d.permission))) return 'unknown_permission';
  if (d.audit !== null && (typeof d.audit !== 'string' || !isAuditAction(d.audit))) return 'unknown_audit';
  if (d.alsoAudits !== undefined) {
    const also: unknown = d.alsoAudits;
    if (!Array.isArray(also) || also.length === 0) return 'invalid_value';
    if (!also.every((a) => typeof a === 'string' && isAuditAction(a))) return 'unknown_audit';
    const actions = also as AuditAction[];
    if (new Set(actions).size !== actions.length || actions.some((a) => a === d.audit || SECURITY_AUDIT_ACTIONS.has(a))) {
      return 'also_audits_overlap';
    }
  }
  // 1c Task 10: a wizard route (decision C19) is public, `session: 'none'`, and lives at /install (the page, GET) or
  // under /install/api/; it may then be a non-GET route (below).
  if (raw['install'] !== undefined) {
    if (!['page', 'claim', 'claimed'].includes(raw['install'] as string)) return 'invalid_value';
    if (d.public !== true || d.session !== 'none') return 'install_decl_invalid';
    const wizardPath = d.install === 'page' ? d.path === '/install' && d.method === 'GET' : d.path.startsWith('/install/api/');
    if (!wizardPath) return 'install_decl_invalid';
  }
  // ---- Komunitas K2 (visits) ----
  if (raw['visitStation'] !== undefined) {
    const underStation = d.path === '/kunjungan' || d.path.startsWith('/kunjungan/');
    if (raw['visitStation'] !== true || d.public !== true || d.session !== undefined || !underStation || (d.auth ?? 'cookie') !== 'cookie') {
      return 'visit_station_invalid';
    }
  }
  // ---- Komunitas (member area) ----
  if (raw['member'] !== undefined) {
    const filesRoute = d.method === 'GET' && d.path === '/files/:id' && d.member === 'optional' && d.public === true;
    const akunPath = d.path === '/akun' || d.path.startsWith('/akun/');
    if (!filesRoute && (d.public !== true || d.session !== 'none' || !akunPath)) return 'member_decl_invalid';
  }
  if (raw['form'] !== undefined) {
    if (d.visitStation === true) {
      if (raw['form'] !== true || d.method !== 'POST' || d.body === undefined || raw['rawBody'] !== undefined || d.idempotency !== 'none') {
        return 'form_invalid';
      }
    } else {
      if (raw['form'] !== true) return 'invalid_value';
      if (d.method === 'GET' || !isMemberRoute(d) || d.idempotency !== 'none' || raw['rawBody'] !== undefined) return 'form_decl_invalid';
    }
  }
  // Phase 2 (catalog): Task 2 — a cookieless read-only route is the one non-GET `session: 'none'` route outside the
  // wizard (isCookielessRead); Komunitas (member area): a member route reads the member session instead.
  const writesWithoutSession = d.method !== 'GET' && d.install === undefined && !isCookielessRead(d) && !isMemberRoute(d);
  if (d.session === 'none' && (d.partialAuth === true || d.reauth === true || d.idempotency === 'store' || writesWithoutSession)) {
    return 'session_none_conflict';
  }
  if (d.reauth === true && d.partialAuth === true) return 'reauth_partial';
  if (d.method === 'GET') {
    if (d.body !== undefined) return 'get_with_body';
    if (d.idempotency !== 'none') return 'get_idempotency';
    if (d.tx !== undefined) return 'tx_on_get';
  }
  if (d.body !== undefined && !isStrictObject(d.body)) return 'body_not_strict';
  if (d.query !== undefined && !isStrictObject(d.query)) return 'query_not_strict';
  if (d.params !== undefined && !isStrictObject(d.params)) return 'params_not_strict';
  if (d.permission !== undefined) {
    const scope = permissionCatalog().find((p) => p.key === d.permission)?.scope;
    if (scope === 'branch' && (d.branchParam === undefined || !pathParams(d.path).includes(d.branchParam))) {
      return 'branch_param_missing';
    }
  }
  if (d.path.startsWith('/api/v1/auth/') && d.idempotency !== 'none') return 'auth_idempotency';
  if (d.idempotency === 'store' && d.public === true && d.session !== 'required') return 'store_needs_session';
  if (d.tx === 'self' && d.idempotency === 'store') return 'self_tx_store';
  // The request hash covers method, path and body only: two queries under one key would share a stored response.
  if (d.idempotency === 'store' && d.query !== undefined) return 'store_with_query';
  return null;
}

/**
 * Validates `decls` and returns them (the same array).
 *
 * @throws Error `ROUTE_DECL_INVALID:<id>:<reason>` for the first invalid declaration (`?` for a missing id). Reasons:
 *   `incomplete` (no id, method, path, idempotency, audit or handler), `invalid_value` (an unknown method or enum
 *   value, a relative path, an unknown bucket, an `alsoAudits` that is not a non-empty array), `access`,
 *   `session_without_public`, `unknown_permission`, `unknown_audit`, `also_audits_overlap` (`alsoAudits` repeats an
 *   action, or names `audit` or a security action), `session_none_conflict`, `reauth_partial`, `get_with_body`,
 *   `get_idempotency`, `tx_on_get`, `body_not_strict`, `query_not_strict`, `params_not_strict`,
 *   `branch_param_missing`, `auth_idempotency`, `store_needs_session`, `self_tx_store`, `store_with_query`,
 *   `duplicate_id`, `duplicate_route`
 *
 *   1c: `raw_body_invalid` (a `rawBody` that is not `{type: 'multipart', maxBytes: <positive integer>}`, or one on a
 *   route that is not POST, declares a `body` schema or stores its response); `install_decl_invalid` (an `install`
 *   route that is not public with `session: 'none'`, or not at GET /install for `page` and under /install/api/ for
 *   `claim`/`claimed`)
 *
 *   1c: `background_not_get` (`background` on a route that is not GET; a `background` that is not `true` is
 *   `invalid_value`)
 *
 *   Phase 2 (Task 2): a non-GET `session: 'none'` route outside the wizard is valid only as a cookieless read-only
 *   route (isCookielessRead); any other stays `session_none_conflict`.
 *
 *   Komunitas (member area): `member_decl_invalid` (`member` on a route that is not public with `session: 'none'` under
 *   `/akun`, other than an `optional` GET /files/:id); `form_decl_invalid` (`form` on a GET route, without `member`,
 *   with `idempotency: 'store'` or a `rawBody`); a member route may be a non-GET `session: 'none'` route.
 */
export function defineRoutes(decls: RouteDecl[]): RouteDecl[] {
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const d of decls) {
    const id = typeof d?.id === 'string' && d.id !== '' ? d.id : '?';
    const problem = d === null || typeof d !== 'object' ? 'incomplete' : declProblem(d);
    if (problem !== null) throw new Error(`ROUTE_DECL_INVALID:${id}:${problem}`);
    if (ids.has(d.id)) throw new Error(`ROUTE_DECL_INVALID:${id}:duplicate_id`);
    ids.add(d.id);
    const key = routeKey(d);
    if (keys.has(key)) throw new Error(`ROUTE_DECL_INVALID:${id}:duplicate_route`);
    keys.add(key);
  }
  return decls;
}

// ---------------------------------------------------------------------------------------------------------------
// The startup check

/** The handlers mountRoutes created, with their declaration. */
const mountedHandlers = new WeakMap<object, RouteDecl>();

/** The middleware createApp registers (declareMiddleware): the only method `ALL` entries the startup check allows. */
const declaredMiddleware = new WeakSet<object>();

/**
 * Marks `fn` as middleware createApp registers (`app.use(declareMiddleware(fn))`) and returns it. Only createApp
 * calls it: any other `ALL` entry (`app.all(...)`, an unmarked `app.use(...)`) fails the startup check.
 */
export function declareMiddleware(fn: MiddlewareHandler<AppEnv>): MiddlewareHandler<AppEnv> {
  declaredMiddleware.add(fn);
  return fn;
}

/**
 * Throws for the first route of `app` that is not either the handler mountRoutes created for one of `decls`, on
 * that declaration's method and path, or a method `ALL` entry (what `app.use` registers) of declared middleware.
 *
 * @throws Error `ROUTE_UNDECLARED:<METHOD> <path>` (`ALL` for a raw `app.all` route or undeclared middleware)
 */
export function assertAllRoutesDeclared(
  app: { routes: readonly { method: string; path: string; handler: unknown }[] },
  decls: readonly RouteDecl[],
): void {
  const declared = new Set(decls);
  for (const r of app.routes) {
    if (r.method === 'ALL') {
      if (typeof r.handler === 'function' && declaredMiddleware.has(r.handler)) continue;
      throw new Error(`ROUTE_UNDECLARED:${r.method} ${r.path}`);
    }
    const decl = typeof r.handler === 'function' ? mountedHandlers.get(r.handler) : undefined;
    if (decl === undefined || !declared.has(decl) || decl.method !== r.method || decl.path !== r.path) {
      throw new Error(`ROUTE_UNDECLARED:${r.method} ${r.path}`);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The runtime

/** One withTx attempt of a request (see "Per attempt" at the top of this file). */
interface Attempt {
  /** The request run it belongs to. */
  owner: object;
  trx: Trx;
  actor: Actor;
  /** Entries of the declared action, and of actions outside it and the security set. */
  declared: number;
  foreign: number;
  afterCommit: RouteHook[];
  afterResponse: RouteHook[];
}

/** For hook failures when neither the request nor the mount options carry a logger. */
const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};

/** The attempt whose callback is running (async context): where rc.audit, rc.afterCommit and rc.tx belong. */
const currentAttempt = new AsyncLocalStorage<Attempt>();

/** The request run whose `prepare` is running (async context). */
const currentPrepare = new AsyncLocalStorage<object>();

function newAttempt(owner: object, trx: Trx, actor: Actor): Attempt {
  return { owner, trx, actor, declared: 0, foreign: 0, afterCommit: [], afterResponse: [] };
}

/** A TxCtx over `attempt` whose audits are counted for the audit-once check. */
function countingTx(decl: RouteDecl, attempt: Attempt, now: number, actor: Actor): TxCtx {
  const base = txCtx(attempt.trx, now, actor);
  return {
    trx: attempt.trx,
    now,
    actor,
    audit: async (e) => {
      await base.audit(e);
      if (e.action === decl.audit) attempt.declared += 1;
      else if (!SECURITY_AUDIT_ACTIONS.has(e.action) && decl.alsoAudits?.includes(e.action) !== true) attempt.foreign += 1;
    },
  };
}

/** AUDIT_MISSING unless the counts are what `decl` allows (exactly one declared entry; no foreign one). */
function checkAuditOnce(decl: RouteDecl, declared: number, foreign: number): void {
  if (foreign === 0 && (decl.audit === null || declared === 1)) return;
  throw new DomainError('AUDIT_MISSING', { meta: { route: decl.id, audit: decl.audit, declared, foreign } });
}

/** Runs `hooks` in order; a failure is logged and the rest still run. Never rejects. */
async function runHooks(hooks: readonly RouteHook[], kind: 'afterCommit' | 'afterResponse', decl: RouteDecl, log: Logger): Promise<void> {
  for (const fn of hooks) {
    try {
      await fn();
    } catch (error) {
      log.error(`${kind} hook failed`, { route: decl.id, err: loggableError(error) });
    }
  }
}

/**
 * Makes the problem response of an error that ends the route carry the headers already set on the context: step 7's
 * cookies (a rotated `altis_sid` with its `X-CSRF-Token`, a stale cookie cleared) and step 9's test header. Hono drops
 * headers set with `c.header()` when an error response replaces them, unless the context already holds a response:
 * reading `c.res` makes one from them, and the error response set on the context is then merged with it (Set-Cookie
 * lines kept, other headers set, its own Content-Type kept).
 *
 * With `only` (the headers as they were before `prepare` and the handler ran, ruling R1b-1 d), the context keeps
 * exactly those: a cookie or header the handler set for work its rolled-back transaction undid never goes out.
 */
function keepContextHeaders(c: Context<AppEnv>, only?: Headers): void {
  const headers = c.res.headers;
  if (only === undefined) return;
  for (const name of new Set(headers.keys())) headers.delete(name);
  for (const [name, value] of only) if (name !== 'set-cookie') headers.set(name, value);
  for (const cookie of only.getSetCookie()) headers.append('Set-Cookie', cookie);
}

/** A copy of the headers set on the context so far, without making the context hold a response. */
function contextHeaders(c: Context<AppEnv>): Headers {
  return new Headers(c.newResponse(null).headers);
}

/**
 * The route's response, carrying the headers set on the context (step 7's rotated cookie and `X-CSRF-Token`, ruling
 * R1b-1 a). `RouteResult` objects become `c.json`/`c.body` responses. A Response the handler returned is rebuilt
 * through the context with its status, body and headers: its headers win over the context's, and the Set-Cookie
 * lines of both are kept (Hono's own merge would replace the Response's cookies with the context's), each once: a
 * Response built through the context (`rc.c.json`, ...) already holds the context's lines.
 */
function toResponse(c: Context<AppEnv>, decl: RouteDecl, result: RouteResult): Response {
  if (result instanceof Response) {
    const held = contextHeaders(c).getSetCookie();
    for (const cookie of result.headers.getSetCookie()) {
      const at = held.indexOf(cookie);
      if (at >= 0) held.splice(at, 1);
      else c.header('Set-Cookie', cookie, { append: true });
    }
    for (const [name, value] of result.headers) if (name !== 'set-cookie') c.header(name, value);
    return result.body === null
      ? c.body(null, result.status as StatusCode)
      : c.body(result.body, result.status as ContentfulStatusCode);
  }
  if (result === null || typeof result !== 'object') {
    throw new TypeError(`route ${decl.id}: the handler must return a Response or {status?, body?, headers?}`);
  }
  const { status, body, headers } = result;
  if (body === undefined) return c.body(null, (status ?? 204) as StatusCode, headers);
  return c.json(body, (status ?? 200) as ContentfulStatusCode, headers);
}

/** The probe routes of Diagnostik and the wizard (`diagnostics.probe.methods.put`, ...): they test the real methods. */
const PROBE_METHODS_ID = /(?:^|\.)probe\.methods\./;

/**
 * Whether an overridden request (1c Task 16, C37) may reach `decl` at all: a cookie route that reads a session, not a
 * wizard route, not a probe route. The session itself is checked once step 7 has resolved it.
 */
function overridable(decl: RouteDecl): boolean {
  return (decl.auth ?? 'cookie') === 'cookie' && decl.session !== 'none' && decl.install === undefined && !PROBE_METHODS_ID.test(decl.id);
}

/** Steps 5-13 for one request of `decl`; the hooks to run after the response come back with the result. */
async function runRoute(decl: RouteDecl, c: Context<AppEnv>, o: MountOptions, log: Logger): Promise<{ result: RouteResult; hooks: RouteHook[] }> {
  const { state, services } = o;
  const now = (c.get('now') as number | undefined) ?? services.clock();
  const ip = (c.get('ip') as string | null | undefined) ?? null;
  const cookieAuth = (decl.auth ?? 'cookie') === 'cookie';

  // 1c Task 16 (C37): an overridden request needs a cookie route that resolves a session; never a probe route.
  const overridden = isOverridden(c);
  if (overridden && !overridable(decl)) throw new DomainError('METHOD_OVERRIDE_DENIED');
  // Step 5 (1c Task 15, C20): the maintenance gate, before step 3's persisted part (S2). Its 503 is an expected
  // refusal, answered here as the phase gate answers its own, never logged as a failure; a browser's GET of a page gets
  // the maintenance page (1c Task 19).
  const fence = services.opsFence;
  const refusal = fence === null ? null : maintenanceRefusal(decl, fence);
  if (refusal !== null) return { result: refusalResponse(c, refusal), hooks: [] };
  // Step 3's persisted part: `system.ip_trust`, a database read that `session: 'none'` routes never make (S29), nor
  // any route during a restore (S2: its tables may be gone; the request then keeps the trust step 3 derived).
  const restoring = fence?.restoreInProgress() === true;
  const memberRoute = isMemberRoute(decl); // Komunitas (member area)
  if (!restoring && (decl.session !== 'none' || decl.ipLimits !== undefined || memberRoute)) {
    await applyPersistedIpTrust(c, services.settings, state.db);
  }
  await countIpLimits(state.db, decl.ipLimits ?? [], ip, c.get('ipTrust'), now); // step 6
  // 1c Task 15: what an `opsAuth` route is authorized against (services.ops is read only for one).
  const opsGate: OpsGate | undefined = decl.opsAuth === true ? { fence, ops: services.ops, phase: state.phase } : undefined;
  // Step 7: never for `session: 'none'`; a Bearer route reads no cookie (§7.4); an `opsAuth` route past a restore's
  // point of no return, in `ops_wait`, or (1d review C16) in `updating` without a database or while an op moves the
  // schema reads no session (S3, B4; http/ops-auth.ts opsSessionAllowed).
  const sessionStep =
    decl.session !== 'none' &&
    decl.visitStation !== true && // Komunitas K2: a station page never reads the staff session
    cookieAuth &&
    (opsGate === undefined || opsSessionAllowed({ ...opsGate, db: state.db }));
  const noSession: ResolvedAuth = { auth: null, csrfSessionId: null };
  const readSession = (): Promise<ResolvedAuth> =>
    resolveAuth(c, {
      db: state.db,
      services,
      now,
      rotate: decl.path.startsWith('/api/'),
      background: decl.background === true, // 1c, Task 8
    });
  // 1d review C16: in `updating` the release that runs may not read this database's sessions yet (a schemaHold release
  // before its migrations, a half-migrated schema after a failure): for an `opsAuth` route such a read is no session,
  // so the op's cookie still opens it and nothing answers 500.
  const tolerant = opsGate !== undefined && state.phase === 'updating';
  const resolved: ResolvedAuth = !sessionStep
    ? noSession
    : tolerant
      ? await readSession().catch((error: unknown) => {
          log.warn('ops: the session could not be read in phase updating; the request goes on without one', {
            route: decl.id,
            err: loggableError(error),
          });
          return noSession;
        })
      : await readSession();
  const auth: AuthState | null = resolved.auth;
  c.set('auth', auth);
  if (overridden && auth === null) throw new DomainError('METHOD_OVERRIDE_DENIED'); // 1c Task 16: P10, authenticated only
  // 1c Task 10: a wizard route's own gate, claim and CSRF checks (see the top of this file), in place of steps 8-9.
  const installSession =
    decl.install === undefined
      ? null
      : await checkInstallRoute(c, decl.install, { install: services.install, now, sideEffects: decl.sideEffects === true });
  // ---- Komunitas K2 (visits) ----
  // A station page's own cookie (in place of step 7's session), and a form body read before step 8 (its `_csrf`).
  const visitStation = decl.visitStation === true ? await resolveVisitStation(c, state.db) : null;
  const stationForm = decl.form === true && decl.visitStation === true ? await readStationFormBody(c) : null;
  // ---- Komunitas (member area): the member session, the form body, step 8 and the member's gate ----
  const member: MemberAuthState | null = memberRoute
    ? await resolveMemberAuth(c, { db: state.db, services, now, touch: decl.method !== 'GET' || c.req.method !== 'HEAD' })
    : null;
  const form: FormBody | null = decl.form === true && memberRoute ? await readFormBody(c) : null;
  if (memberRoute) {
    const preSession = decl.form === true && PRE_SESSION_FORMS.has(decl.path);
    if (decl.method !== 'GET') {
      if (decl.member === 'required' && member === null) {
        checkMemberCsrf(c, { sessionId: null, preSession: false, formToken: undefined, originOnly: true });
        return { result: memberSignInRedirect(c, '/akun'), hooks: [] };
      }
      checkMemberCsrf(c, { sessionId: member?.session.id ?? null, preSession, formToken: form?.csrf });
    } else if (decl.member === 'required' && member === null) {
      const url = new URL(c.req.url);
      return { result: memberSignInRedirect(c, `${url.pathname}${url.search}`), hooks: [] };
    }
    if (member !== null && member.mustResetPassword && decl.member === 'required' && !MUST_RESET_ROUTES.has(decl.id)) {
      return { result: memberRedirect(c, '/akun/sandi'), hooks: [] };
    }
    if (member !== null && decl.method !== 'GET' && decl.member === 'required') {
      const h = await withTx(state.db!, (trx) => hit(trx, 'member_write', member.session.id, now));
      if (!h.allowed) throw new DomainError('AUTH_TOO_MANY_ATTEMPTS', { meta: { retryAfterS: h.retryAfterS } });
    }
  }
  // Step 8; Bearer routes are exempt (§7.4), a wizard route was checked just above, and a cookieless read-only route
  // (Phase 2, Task 2: OAI-PMH's POST) reads no cookie and changes nothing; a member route was checked just above.
  const step8 = cookieAuth && decl.install === undefined && !isCookielessRead(decl) && !memberRoute;
  if (step8 && stationForm !== null) {
    checkFormCsrf(c, stationForm.csrf, visitStation);
  } else if (step8 && decl.method !== 'GET' && opsGate !== undefined) {
    checkOpsCsrfOrigin(c, resolved.csrfSessionId, await opsCookieOp(c, opsGate.ops)); // 1c Task 15
  } else if (step8 && decl.method !== 'GET') {
    checkCsrfOrigin(c, resolved.csrfSessionId);
  } else if (step8 && (decl.audit !== null || decl.sideEffects === true)) {
    checkSideEffectGet(c);
  }
  // Step 9; for an `opsAuth` route what it decided (1c Task 15).
  const opsAuth =
    decl.session !== 'none'
      ? await authorize(c, decl, auth, { db: state.db, now, ip, ...(opsGate === undefined ? {} : { ops: opsGate }) })
      : null;
  markTestGate(c, 'PASSED'); // test profile only (T31); kept on an error response, being set before the handler

  // The request context exists from step 10 on (the edition gate receives it); the validated input joins it at step 11.
  const owner = {};
  const actor: Actor =
    auth !== null
      ? { type: 'staff', id: auth.subjectId, ip }
      : member !== null
        ? { type: 'member', id: member.memberId, ip }
        : { type: 'anonymous', id: null, ip };
  const committed = { declared: 0, foreign: 0 };
  const responseHooks: RouteHook[] = [];
  const handlerTx = decl.method !== 'GET' && (decl.tx ?? 'handler') === 'handler';
  /** Inside the `prepare` of a `tx: 'handler'` route: no transaction and no audit (see the top of this file). */
  const refuseInPrepare = (what: string): void => {
    if (handlerTx && currentPrepare.getStore() === owner) {
      throw new TypeError(
        `${what}: route ${decl.id} is tx: 'handler', whose prepare writes nothing (read through rc.db); write and audit in the handler`,
      );
    }
  };

  const db = (): DbHandle => {
    const handle = o.dbFor === undefined ? state.db : o.dbFor(decl);
    if (handle === undefined) throw new DomainError('DB_UNAVAILABLE');
    return handle;
  };
  const mine = (): Attempt | undefined => {
    const a = currentAttempt.getStore();
    return a?.owner === owner ? a : undefined;
  };
  /** After an attempt's COMMIT: its counts and response hooks join the request's; its afterCommit hooks run. */
  const commit = async (a: Attempt): Promise<void> => {
    committed.declared += a.declared;
    committed.foreign += a.foreign;
    responseHooks.push(...a.afterResponse);
    await runHooks(a.afterCommit, 'afterCommit', decl, log);
  };

  const rc: RouteContext = {
    // Until step 11: no body or query read yet, the raw path parameters.
    body: undefined,
    query: undefined,
    params: c.req.param(),
    now,
    requestId: c.get('requestId'),
    log,
    ip,
    ipTrust: (c.get('ipTrust') as IpTrust | undefined) ?? 'ok',
    auth,
    actor,
    get db() {
      return db();
    },
    trx: null,
    tx: (opts) => {
      const a = mine();
      if (rc.trx === null || a === undefined) {
        throw new TypeError(`rc.tx(): route ${decl.id} has no handler transaction here (GET, tx: 'self' or prepare): use rc.withTx()`);
      }
      return countingTx(decl, a, now, opts?.actor ?? actor);
    },
    withTx: async (fn, opts) => {
      refuseInPrepare('rc.withTx()');
      if (rc.trx !== null) {
        throw new TypeError(`rc.withTx(): route ${decl.id} is inside its handler transaction (R49): use rc.tx()`);
      }
      let last: Attempt | undefined;
      const result = await withTx(db(), (trx) => {
        const a = newAttempt(owner, trx, opts?.actor ?? actor);
        last = a;
        return currentAttempt.run(a, () => fn(countingTx(decl, a, now, a.actor)));
      });
      await commit(last!);
      return result;
    },
    audit: async (e) => {
      const action = decl.audit;
      if (action === null) throw new TypeError(`rc.audit(): route ${decl.id} declares audit: null`);
      refuseInPrepare('rc.audit()');
      const a = mine();
      if (a !== undefined) return countingTx(decl, a, now, a.actor).audit({ ...e, action });
      return rc.withTx((tx) => tx.audit({ ...e, action }));
    },
    auditedBefore: async (e) => {
      const action = decl.audit;
      if (action === null) throw new TypeError(`rc.auditedBefore(): route ${decl.id} declares audit: null`);
      const a = mine();
      if (a === undefined) throw new TypeError(`rc.auditedBefore(): route ${decl.id} is not inside a transaction here`);
      if (a.actor.id === null) return false;
      const found = await a.trx
        .selectFrom('audit_log')
        .select('id')
        .where('action', '=', action)
        .where('entity', '=', e.entity)
        .where('entity_id', '=', e.entityId)
        .where('actor_type', '=', a.actor.type)
        .where('actor_id', '=', a.actor.id)
        .limit(1)
        .executeTakeFirst();
      if (found === undefined) return false;
      a.declared += 1;
      return true;
    },
    afterCommit: (fn) => {
      const a = mine();
      if (a === undefined) throw new TypeError(`rc.afterCommit(): route ${decl.id} is not inside a transaction here`);
      a.afterCommit.push(fn);
    },
    afterResponse: (fn) => {
      (mine()?.afterResponse ?? responseHooks).push(fn);
    },
    prepared: undefined,
    authzDenied: async (permission) => {
      if (mine() !== undefined) {
        throw new TypeError(`rc.authzDenied(): route ${decl.id} is inside a transaction (its denial is written in its own): refuse in prepare`);
      }
      if (auth !== null && permission.startsWith('system.') && state.db !== undefined) {
        await auditDenial(state.db, decl, permission, auth, now, ip);
      }
      return new DomainError('AUTHZ_DENIED');
    },
    get config(): Config {
      if (state.config === undefined) throw new TypeError(`rc.config: no config is loaded (route ${decl.id})`);
      return state.config;
    },
    services,
    c,
    installSession,
    opsAuth,
    visitStation,
    member,
  };

  await rc.services.editionGate(rc, decl); // step 10 (ruling R2): before anything reads the body
  const formFields = stationForm?.fields ?? form?.fields;
  const input = await validateInput(c, decl, formFields === undefined ? undefined : { body: formFields }); // step 11
  rc.body = input.body;
  rc.query = input.query;
  rc.params = input.params;
  const idempotency = await beginIdempotency(c, decl, auth, { db: state.db, config: state.config, now, body: input.body }); // step 12
  if (idempotency?.kind === 'replay') return { result: replayResponse(idempotency), hooks: [] };
  const claim: IdempotencyClaim | null = idempotency?.kind === 'run' ? idempotency.claim : null;

  // What an error response may carry from here on: the headers set so far (steps 7 and 9), not those `prepare` or the
  // handler set before failing (ruling R1b-1 d).
  const before = contextHeaders(c);
  try {
    if (decl.prepare !== undefined) rc.prepared = await currentPrepare.run(owner, () => decl.prepare!(rc));

    // Step 13, the handler.
    if (handlerTx) {
      let last: Attempt | undefined;
      const result = await withTx(db(), (trx) => {
        const a = newAttempt(owner, trx, actor);
        last = a;
        rc.trx = trx;
        return currentAttempt
          .run(a, async () => {
            const r = await decl.handler(rc);
            checkAuditOnce(decl, a.declared, a.foreign); // before COMMIT: a failure rolls back
            if (claim !== null) await finishIdempotency(trx, decl, claim, r); // step 12's finish, in this transaction
            return r;
          })
          .finally(() => {
            rc.trx = null;
          });
      });
      await commit(last!);
      return { result, hooks: responseHooks };
    }
    const result = await decl.handler(rc);
    checkAuditOnce(decl, committed.declared, committed.foreign);
    return { result, hooks: responseHooks };
  } catch (error) {
    keepContextHeaders(c, before);
    // A 4xx: the client may send the request again with its key (a 5xx keeps the key locked until it expires).
    if (claim !== null && isDomainError(error) && error.status >= 400 && error.status < 500) {
      try {
        await releaseIdempotency(db(), claim);
      } catch (failure) {
        // The key then stays locked until it expires; the client gets the handler's error either way.
        log.error('idempotency key release failed', { route: decl.id, err: loggableError(failure) });
      }
    }
    throw error;
  }
}

/**
 * Mounts every declaration on `app` (one Hono handler each, `app.on(method, path)`), running steps 5-13 above. A
 * GET route also answers HEAD (Hono's own rule).
 */
export function mountRoutes(app: Hono<AppEnv>, decls: RouteDecl[], o: MountOptions): void {
  for (const decl of decls) {
    const handler = async (c: Context<AppEnv>): Promise<Response> => {
      const log = (c.get('log') as Logger | undefined) ?? o.log ?? silentLogger;
      let run: Awaited<ReturnType<typeof runRoute>>;
      try {
        run = await runRoute(decl, c, o, log);
      } catch (error) {
        keepContextHeaders(c);
        throw error;
      }
      const { result, hooks } = run;
      const response = toResponse(c, decl, result);
      if (hooks.length > 0) {
        setImmediate(() => {
          void runHooks(hooks, 'afterResponse', decl, log);
        });
      }
      return response;
    };
    mountedHandlers.set(handler, decl);
    app.on(decl.method, decl.path, handler);
  }
}
