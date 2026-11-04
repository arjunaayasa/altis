import type { DbHandle } from '@altis/db';
import { configMtimeMs, dataPath, statOrNull, type Env, type Runtime } from '@altis/platform';
import { DomainError } from '@altis/shared';
import { Hono, type Context } from 'hono';
import { CRON_PATH, cronWaitsForBoot, waitForBoot } from './api/cron.js';
import { updatePageRefusal } from './api/ops.js';
import { defaultProxyHops } from './cli/install.js';
import type { Config } from './config.js';
import { setClientIp } from './http/client-ip.js';
import type { ConfigFence } from './http/config-fence.js';
import { HEALTH_PATH } from './http/health.js';
import { maintenanceResponse } from './http/maintenance.js';
import { servesOpOnly } from './http/op-phase.js';
import { opsSessionAllowed } from './http/ops-auth.js';
import { methodOverride } from './http/method-override.js';
import { NOT_INSTALLED_DETAIL, errorResponse, problemResponse } from './http/problem.js';
import { requestId, type AppEnv } from './http/request-id.js';
import { assertAllRoutesDeclared, declareMiddleware, defineRoutes, mountRoutes, type RouteDecl } from './http/route.js';
import { securityHeaders } from './http/security-headers.js';
import { isInstallPath } from './install/gate.js';
import type { JobRuntime } from './jobs/runtime.js';
import type { Logger } from './logger.js';
import { opacStatusResponse, type OpacStatus } from './opac/catalog/respond.js';
import { errorPageResponse, notFoundResponse, wantsHtml } from './opac/routes.js';
import { ALL_ROUTES } from './routes.js';
import { loggableError } from './safe-error.js';
import { createServices, type AppServices } from './services.js';

export type { AppEnv } from './http/request-id.js';

export type AppPhase = 'not_installed' | 'starting' | 'db_unavailable' | 'too_old' | 'ops_wait' | 'updating' | 'ready';

/**
 * What the app serves from, changed in place by start() as the boot goes on (the app reads it per request):
 *
 * - `phase`: `starting` until config.json has been read; `not_installed` (no config, or an install that did not
 *   finish); `db_unavailable` while start() retries the database; `too_old` when the database needs newer code;
 *   `ready` once the migrations are done; 1c Task 15 (preflight B4, decision C40): `ops_wait` while an exclusive op
 *   holds the ops lock at boot (no database is opened, no migration runs) until the op ends; 1d Task 25: `updating`
 *   while start() boots an update's target (`update_boot`) or steps its revert (`revert`) inside the update op, and
 *   after a revert that ended `restore_failed` (maintenance kept) or `restored` (the restart replaces the process).
 * - `db`: the open database, present when `ready`.
 * - `baseUrl`: config.json's baseUrl once read (decides HSTS); until then `createApp`'s `baseUrl`, if any.
 * - `config`: config.json (env overrides applied) once read, kept current by the fence; what `rc.config` answers.
 * - `fence`: the config fence (decision D34), created by start() after its first loadConfig; step 4 checks it.
 * - `jobs`: the job runtime (1c Task 13), created by start() once `ready` and stopped when the handler is retired;
 *   `services.jobs` answers it. It stays set after the drain: a stopped runtime runs nothing.
 * - `retired`: set by start() once the handler is no longer served, before the job runtime drains and the database
 *   closes (1c Task 13); a request still on its way to this handler then starts no work (`POST /_cron` answers 202).
 * - `releaseFence`: 1d Task 25 (decision D1d-20), the release fence (http/release-fence.ts), set by start() once the app
 *   is `ready` (rebased after its own promotion); step 4 checks it.
 */
export interface AppState {
  phase: AppPhase;
  db?: DbHandle;
  baseUrl?: string;
  config?: Config;
  fence?: ConfigFence;
  jobs?: JobRuntime;
  retired?: boolean;
  releaseFence?: { check(): Promise<void> };
}

export interface AppDeps {
  state: AppState;
  /** The release version, reported by /_health. */
  version: string;
  /** Sent as `X-Altis-Build` on /api responses (spec §4.8). */
  buildId: string;
  /** The baseUrl when it is known up front (it decides HSTS); `state.baseUrl`, once set, takes precedence. */
  baseUrl?: string;
  log: Logger;
  /** Replaces services of {@link createServices} (tests). */
  services?: Partial<AppServices>;
  /** The route declarations to mount (default {@link ALL_ROUTES}); validated again with defineRoutes. */
  routes?: RouteDecl[];
  /** The clock of `services.clock` (default `Date.now()`). */
  clock?: () => number;
  /**
   * The environment the server was started with (default `process.env`): the `ALTIS_*` overrides that lock config.json
   * fields (`GET`/`PUT system/config`) and that win again over what a write puts in the file (S17).
   */
  env?: Env;
  /**
   * DATA_DIR, whose config.json the config writer changes (`PUT system/config`, the cron-token rotation). Without it
   * those writes fail (TypeError → 500); start() always passes it.
   */
  dataDir?: string;
  /** The release the server runs from, and its predecessor's directory (admin asset fallback). */
  release?: { dir: string; previousDir(): Promise<string | null> };
  /**
   * The application folder (1c Task 10): the install gate reads its install marker `.altis/installed.json`. Without it
   * the marker is not looked at.
   */
  appRoot?: string;
  /**
   * The runtime this process runs under (default `standalone`). 1c Task 10: before the install there is no config, so
   * step 3 takes `defaultProxyHops(runtime)` proxy hops (S22). 1c Task 8 (M12): `services.runtime`, which decides
   * whether SSE is on while `realtime.sse` is null.
   */
  runtime?: Runtime;
  /**
   * 1c Task 23 (M12, decision C29): the running app.js's version (BootContext.appJsVersion), which Diagnostik shows
   * (`services.appJsVersion`); absent when the bootloader gives none.
   */
  appJsVersion?: string;
  /** Test seams, honoured only when `__BUILD_PROFILE__ === 'test'` (M23). */
  testHooks?: {
    /** Called after the routes are mounted and before the startup check that every route is declared. */
    beforeRouteCheck?(app: Hono<AppEnv>): void;
  };
}

/** Phase 2 Task 3 (S17): the statuses a browser gets the OPAC status page for, instead of problem+json. */
const OPAC_STATUSES: ReadonlySet<number> = new Set<OpacStatus>([404, 410, 429, 503]);

function isOpacStatus(status: number): status is OpacStatus {
  return OPAC_STATUSES.has(status);
}

/** The operations page (Task 19, `ops.update_page`), which the `ops_wait` phase gate lets through. */
const OPS_UPDATE_PATH = '/admin/_update';

/**
 * 1d review C16: the routes besides the ops routes that phase `updating` serves while a session may open the ops
 * routes (http/ops-auth.ts opsSessionAllowed): the sign-in of spec §9.4's normal maintenance allowlist (`GET auth/me`,
 * `POST auth/login|2fa/verify|logout|reauth`) and the admin shell the sign-in pages run in (ruling R1c-9).
 */
export const UPDATING_SIGN_IN_ROUTES: readonly string[] = Object.freeze([
  'auth.me',
  'auth.login',
  'auth.2fa.verify',
  'auth.logout',
  'auth.reauth',
  'admin.root',
  'admin.index',
]);

/**
 * Whether a request (`method`, `urlPath`) is one of `routes` (a GET route answers HEAD too; `:name` matches one
 * segment, a trailing `*` the rest): 1c Task 15, the `opsAuth` routes a process waiting for an op serves.
 */
function routeMatcher(routes: readonly RouteDecl[]): (method: string, urlPath: string) => boolean {
  const matchers = routes.map((d) => {
    const pattern = d.path
      .split('/')
      .map((segment) => (segment.startsWith(':') ? '[^/]+' : segment === '*' ? '.*' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      .join('/');
    return { method: d.method, path: new RegExp(`^${pattern}$`) };
  });
  return (method, urlPath) =>
    matchers.some((m) => (m.method === method || (m.method === 'GET' && method === 'HEAD')) && m.path.test(urlPath));
}

/** 1c Task 27 (S12): a `not_installed` process looks at install.lock and config.json at most this often. */
export const INSTALL_LOOK_MS = 2000;

/**
 * 1c Task 27 (L45, S12): the look of a `not_installed` process at the install's files. A process that started before
 * config.json existed has no config fence (start() makes it from the first config it reads), so nothing would tell it
 * that the wizard, in another process, wrote config.json or finished. Driven by requests only (no timer, P6), at most
 * every {@link INSTALL_LOOK_MS} per process on the services clock: the mtimes of install.lock and config.json are
 * stat'ed, and when either appeared or changed since the last look, `services.installDone()` starts a boot attempt
 * (which reads config.json, makes the fence, and boots once the install is complete). A failed stat is logged and
 * looked at again next time. Without a DATA_DIR there is nothing to look at.
 */
function notInstalledLook(dataDir: string | undefined, services: AppServices, log: Logger): () => Promise<void> {
  let last: { at: number; lock: number | null; config: number | null } | undefined;
  let running: Promise<void> | undefined;
  const look = async (now: number): Promise<void> => {
    const dir = dataDir!;
    const lock = (await statOrNull(dataPath(dir, 'root', 'install.lock')))?.mtimeMs ?? null;
    const config = await configMtimeMs(dir);
    const prev = last ?? { lock: null, config: null };
    last = { at: now, lock, config };
    if (lock !== prev.lock || config !== prev.config) services.installDone();
  };
  return () => {
    if (dataDir === undefined) return Promise.resolve();
    if (running !== undefined) return running;
    const now = services.clock();
    // A clock that went back counts as due.
    if (last !== undefined && now >= last.at && now - last.at < INSTALL_LOOK_MS) return Promise.resolve();
    if (last !== undefined) last = { ...last, at: now };
    running = look(now)
      .catch((error: unknown) => {
        log.warn('install look: install.lock or config.json cannot be read', { err: loggableError(error) });
      })
      .finally(() => {
        running = undefined;
      });
    return running;
  };
}

/** The error a request gets while the app is not ready (every path but /_health). */
function notReady(phase: Exclude<AppPhase, 'ready'>): DomainError {
  switch (phase) {
    case 'not_installed':
      return new DomainError('NOT_INSTALLED', { detail: NOT_INSTALLED_DETAIL });
    case 'too_old':
      return new DomainError('SCHEMA_TOO_NEW');
    case 'ops_wait':
    case 'updating':
      return new DomainError('MAINTENANCE');
    default:
      return new DomainError('DB_UNAVAILABLE');
  }
}

/**
 * The HTTP app (spec §4.5–4.7): the declared routes, problem+json for everything else, request id and security
 * headers on every response. Middleware, outermost first:
 *
 * 1. request id (a fresh ULID per request, `X-Request-Id`, a logger child);
 * 2. security headers (nosniff, Referrer-Policy, HSTS for an https baseUrl);
 * 3. a catch-all: anything thrown below, even a value that is not an Error (Hono's onError sees only Errors),
 *    becomes problem+json, so 1 and 2 still apply to it. Only for a visitor's browser (a path outside /api/ whose
 *    Accept names text/html) is an unexpected failure, one that ends as a 500, the OPAC error page instead
 *    (opac/routes.ts, spec §11: a generic message and the last 8 characters of the request id), and (Phase 2, S17) a
 *    404, 410, 429 or 503 the OPAC status page (opac/catalog/respond.ts);
 *    then method override (1c Task 16, C37, M27): a `POST` with `X-HTTP-Method-Override: PUT|PATCH|DELETE` is
 *    dispatched again through this whole app with that method and the same request id (any other value: 403
 *    METHOD_OVERRIDE_DENIED); the route chain admits it only with a session, CSRF/Origin checked (http/route.ts);
 * 4. `X-Altis-Build` on /api responses;
 * 5. the request's clock reading (`now`, from `services.clock()`), no session (`auth` null) until step 7, and
 *    - step 3 of §4.7, the client IP (P15): `ip` and `ipTrust` from the peer, X-Forwarded-For and
 *      trustProxy.hops (before the install, without a config: `defaultProxyHops(deps.runtime)`, S22), without any
 *      database read (the persisted `system.ip_trust` is applied per route, http/client-ip.ts);
 *    - step 4, the config fence: `services.fence.check()` (config.json looked at every 2 s at most), then the
 *      request's `config` (`state.config`), which the cookie and CSRF helpers read; and 1c Task 15, the ops fence:
 *      `services.opsFence.check()` (ops/maintenance.json, ops/data-epoch and op.json's active op, every 2 s at most),
 *      which step 5 (the maintenance gate, http/route.ts) and /_health read;
 * 6. the phase gate: until `state.phase` is `ready`, every path but /_health answers 503: NOT_INSTALLED (with the
 *    install instruction), SCHEMA_TOO_NEW (`too_old`) or DB_UNAVAILABLE (`starting`, `db_unavailable`). 1c Task 10:
 *    `not_installed` asks the install gate (services.install.gate()) first: `volume_missing` and `datadir_mismatch`
 *    answer 503 DATA_VOLUME_MISSING / DATA_DIR_MISMATCH on every path but /_health (never the wizard), and a gate that
 *    cannot decide (the database ALTIS_DB_* names cannot be read yet) 503 DB_UNAVAILABLE; then, in every
 *    phase but `ready`, the wizard (`/install`, `/install/api/*`) and `/admin/assets/*` pass; for `fresh` and
 *    `resume`, GET `/` and `/admin*` answer 302 to /install. 1c Task 13: `/_cron` passes while `not_installed` too.
 *    Ruling R1c-14: a `POST /_cron` that arrives while `starting` or `db_unavailable` first waits (at most 15 s, inside
 *    its 20 s budget; api/cron.ts waitForBoot) for the boot to be done, then goes through this gate as usual.
 *    1c Task 15 (B4, C40): in `ops_wait` only the `opsAuth` routes (authenticated by `altis_ops` alone: no session,
 *    no database), `POST /_cron` (it steps the op), /_health (503 `maintenance`), `/admin/_update` and
 *    `/admin/assets/*` pass; everything else answers 503 MAINTENANCE with `Retry-After: 30` (the OPAC maintenance page
 *    for a browser's GET of a page). 1d Task 25: `updating` is gated the same way; 1d review C16: there, while a
 *    session may open the ops routes (http/ops-auth.ts opsSessionAllowed), {@link UPDATING_SIGN_IN_ROUTES} pass too.
 *    1c Task 27 (S12): in `not_installed` the request first makes the install look
 *    (install.lock and config.json at most every 2 s, notInstalledLook), which starts a boot attempt when either
 *    appeared or changed;
 * 7. piggyback (1c Task 13): once the response is made, `services.jobs.maybePiggyback(path)`; registered after
 *    method override (1c Task 16), so an overridden request reaches it once, through its inner dispatch.
 *
 * Each is registered through declareMiddleware: the startup check refuses any other method `ALL` entry.
 *
 * Then the routes of `deps.routes` (default ALL_ROUTES), each with steps 5-13 of the chain (http/route.ts), and a
 * 404 NOT_FOUND problem for any other path (the OPAC 404 page for a browser's, same rule as above). Last, every Hono
 * route must come from a declaration (§4.6).
 *
 * @throws Error `ROUTE_DECL_INVALID:…` for an invalid declaration, `ROUTE_UNDECLARED:…` for a route without one
 */
export function createApp(deps: AppDeps): Hono<AppEnv> {
  const { state, buildId, log } = deps;
  const routes = defineRoutes(deps.routes ?? ALL_ROUTES);
  const services = createServices(state, deps);
  const app = new Hono<AppEnv>();

  /**
   * The answer to a failure: problem+json, except the OPAC page for a 500 on a path a browser asked for as HTML. 1c Task
   * 19: `/admin/_update` without the op's cookie or a session is a redirect to the sign-in page, or during a restore
   * (and in `ops_wait`, where no session is read either) a page saying where the op can be followed (api/ops.ts).
   * Phase 2 Task 3 (S17): on such a path a 404, 410, 429 or 503 is the OPAC status page (opac/catalog/respond.ts), its
   * `Retry-After` kept; every other status, every /api/ path and every request that does not ask for HTML keeps its
   * problem+json.
   */
  const failure = (error: unknown, c: Context<AppEnv>): Response => {
    // 1d review C16: in `updating` a session may sign in unless the op moves the schema (http/ops-auth.ts).
    const sessionsClosed =
      !opsSessionAllowed({ fence: services.opsFence, phase: state.phase, db: state.db }) ||
      services.opsFence?.restoreInProgress() === true;
    const opsPage = updatePageRefusal(error, c, { sessionsClosed });
    if (opsPage !== null) return opsPage;
    const problem = errorResponse(error, c, log);
    if (!wantsHtml(c)) return problem;
    if (problem.status === 500) return errorPageResponse(c);
    if (isOpacStatus(problem.status)) {
      const retryAfter = problem.headers.get('Retry-After');
      return opacStatusResponse(c, problem.status, retryAfter === null ? {} : { retryAfter });
    }
    return problem;
  };

  app.use(declareMiddleware(requestId(log)));
  app.use(declareMiddleware(securityHeaders(() => state.baseUrl ?? deps.baseUrl)));
  app.use(
    declareMiddleware(async (c, next) => {
      try {
        await next();
      } catch (error) {
        c.res = failure(error, c);
      }
    }),
  );
  // 1c Task 16 (C37, M27): method override, right after the catch-all, so that its refusal is a problem like any
  // other; an overridden POST runs the whole chain again as the method it names (http/method-override.ts).
  app.use(declareMiddleware(methodOverride(app)));
  app.use(
    '/api/*',
    declareMiddleware(async (c, next) => {
      await next();
      c.header('X-Altis-Build', buildId);
    }),
  );
  // Before the install there is no config: the runtime's usual proxy hops (S22), so that the claim limit counts each
  // visitor and not the proxy in front of them.
  const preInstallHops = defaultProxyHops(deps.runtime ?? 'standalone');
  // 1c Task 27 (S12): the `not_installed` look (see installLook below).
  const installLook = notInstalledLook(deps.dataDir, services, log);
  // 1c Task 15: what the `ops_wait` phase gate lets through besides /_health and /_cron: the opsAuth routes.
  const opsAuthRoute = routeMatcher(routes.filter((d) => d.opsAuth === true));
  // 1d review C16: what the `updating` phase gate lets through while a session may open the ops routes.
  const signInRoute = routeMatcher(routes.filter((d) => UPDATING_SIGN_IN_ROUTES.includes(d.id)));
  app.use(
    declareMiddleware(async (c, next) => {
      c.set('now', services.clock());
      c.set('auth', null);
      setClientIp(c, state.config?.trustProxy.hops ?? preInstallHops); // step 3
      await services.fence?.check(); // step 4
      await services.opsFence?.check(); // step 4, 1c Task 15: the ops fence (maintenance, data epoch, active op)
      await state.releaseFence?.check(); // step 4, 1d Task 25: the release fence (once ready)
      c.set('config', state.config);
      return next();
    }),
  );
  app.use(
    declareMiddleware(async (c, next) => {
      const urlPath = c.req.path;
      // Ruling R1c-14: the cron call that woke a cold process (app.js held it until this handler served) waits for the
      // boot, bounded inside its 20 s budget, instead of answering 503 while `starting` (api/cron.ts).
      if (urlPath === CRON_PATH && c.req.method === 'POST' && cronWaitsForBoot(state)) {
        await waitForBoot(state, () => services.jobs !== null);
        // Steps 3 and 4 again: they ran before start() had read config.json (the token, the proxy hops, the fences).
        setClientIp(c, state.config?.trustProxy.hops ?? preInstallHops);
        await services.fence?.check();
        await services.opsFence?.check();
        c.set('config', state.config);
      }
      const phase = state.phase;
      if (phase === 'ready' || urlPath === HEALTH_PATH) return next();
      // 1c Task 15 (B4, C40): the process waits for an exclusive op; nothing but the op's own routes may run. 1d Task
      // 25: so does a process in `updating` (the update op boots its target, or steps its revert, in this process): the
      // op's own steps (`POST /_cron`, `ops/drive`) and pages pass, everything else is MAINTENANCE.
      if (servesOpOnly(phase)) {
        const method = c.req.method;
        if (urlPath === CRON_PATH && method === 'POST') return next();
        if (urlPath === OPS_UPDATE_PATH || urlPath.startsWith('/admin/assets/') || opsAuthRoute(method, urlPath)) return next();
        // 1d review C16: in `updating`, while a session may open the ops routes, the sign-in of §9.4's normal
        // maintenance allowlist and the admin shell it runs in (R1c-9) pass too, so an admin can sign in, re-authenticate
        // and take over an op the system began (§9.8 rows 1 and 3).
        if (phase === 'updating' && signInRoute(method, urlPath) && opsSessionAllowed({ fence: services.opsFence, phase, db: state.db })) {
          return next();
        }
        return maintenanceResponse(c, services.opsFence?.maintenance()?.reason, { page: wantsHtml(c) });
      }
      // 1c Task 27 (S12): a process with no config fence notices an install written by another process.
      if (phase === 'not_installed') await installLook();
      // 1c Task 10: not installed, the install gate decides (§7.7): a lost DATA_DIR or volume is a 503 on every path,
      // never the wizard; otherwise a browser opening the site or the admin is sent to the wizard.
      const gate = phase === 'not_installed' ? await services.install.gate() : null;
      if (gate?.kind === 'volume_missing') return problemResponse(new DomainError('DATA_VOLUME_MISSING'), c.get('requestId'));
      if (gate?.kind === 'datadir_mismatch') return problemResponse(new DomainError('DATA_DIR_MISMATCH'), c.get('requestId'));
      // 1c Task 27 (L45, S12): the gate's own stat found the install complete (another process finished it): boot now,
      // and answer as a process that is starting (the wizard's routes answer 404 themselves).
      const installedMeanwhile = gate?.kind === 'installed';
      if (installedMeanwhile) services.installDone();
      // The wizard (whose routes check the gate themselves) and the assets its page loads.
      if (isInstallPath(urlPath) || urlPath.startsWith('/admin/assets/')) return next();
      // 1c Task 13: the cron line is answered before the install too (`{installed: false}`, for the wizard's scheduler
      // test), once its token can be checked.
      if (phase === 'not_installed' && urlPath === CRON_PATH) return next();
      const toWizard = gate?.kind === 'fresh' || gate?.kind === 'resume';
      const page = urlPath === '/' || urlPath === '/admin' || urlPath.startsWith('/admin/');
      if (toWizard && page && (c.req.method === 'GET' || c.req.method === 'HEAD')) return c.redirect('/install', 302);
      return problemResponse(notReady(installedMeanwhile ? 'starting' : phase), c.get('requestId'));
    }),
  );

  // 1c Task 13: piggyback (spec §10.2, decision C36): once the response to a request is made, an external-mode
  // process that has seen no worker or cron run for 10 minutes may run one light slice (jobs/runtime.ts
  // maybePiggyback, on setImmediate). services.jobs exists only once the app is ready; the paths the gate above lets
  // through before that (/_health, /_cron, the wizard, assets) never piggyback anyway.
  // ORDER: this middleware must stay registered after method override (1c Task 16, which sits right after the
  // catch-all). An overridden POST is answered by its inner dispatch through the whole app, which passes here itself,
  // while the outer POST never reaches this point: one client request, at most one piggyback.
  app.use(
    declareMiddleware(async (c, next) => {
      try {
        await next();
      } finally {
        services.jobs?.maybePiggyback(c.req.path);
      }
    }),
  );

  mountRoutes(app, routes, {
    state,
    services,
    log,
    // 1c Task 10: a wizard route works on the wizard's own database handle (none before config.json exists).
    dbFor: (decl) => (decl.install === undefined ? state.db : services.install.db()),
  });

  app.notFound((c) =>
    wantsHtml(c)
      ? notFoundResponse(c, { settings: services.settings, db: state.db, log: c.get('log') ?? log })
      : problemResponse(new DomainError('NOT_FOUND'), c.get('requestId')),
  );
  app.onError((error, c) => failure(error, c));

  if (typeof __BUILD_PROFILE__ !== 'undefined' && __BUILD_PROFILE__ === 'test') deps.testHooks?.beforeRouteCheck?.(app);
  assertAllRoutesDeclared(app, routes);
  return app;
}
