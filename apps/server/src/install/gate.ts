import {
  dbInstallId,
  ensureInstallCode,
  formatInstallCode,
  installCsrfToken,
  installGate,
  readInstallSession,
  safeEqual,
  type InstallCodeInfo,
  type InstallGate,
  type InstallSession,
} from '@altis/core';
import { connect, type DbConfig, type DbHandle } from '@altis/db';
import { dataPath, isEnvSet, readJsonWithBak, readReleaseFile, type Env, type Runtime } from '@altis/platform';
import { DomainError, isDomainError, type ErrorCode } from '@altis/shared';
import type { Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { AppState } from '../app.js';
import { loadConfig, type Config } from '../config.js';
import { markTestGate } from '../http/auth.js';
import { isSecureBase } from '../http/cookies.js';
import type { AppEnv } from '../http/request-id.js';
import type { Logger } from '../logger.js';
import { loggableError } from '../safe-error.js';

// The install wizard's side of the HTTP app (spec §7.7, §9.5; plan Task 10, decision C19): the install service the
// routes share (services.install), the `altis_install` cookie, and the checks a wizard route runs instead of steps
// 7-9 of the chain (http/route.ts):
//
//   gate      every wizard request looks at the install gate itself (a stat of install.lock, the marker, config.json):
//             installed → 404 NOT_FOUND, also in a process spawned before the install finished and before any fence
//             saw it; volume_missing / datadir_mismatch → 503, never the wizard; a database named by ALTIS_DB_* that
//             cannot be read yet → 503 DB_UNAVAILABLE (fail closed). The gate comes first, so that an installed
//             system answers 404 whatever the request carries.
//   claim     (`install: 'claim'`) an `Origin` that is an http(s) origin, and no cross-site `Sec-Fetch-Site`.
//   claimed   (`install: 'claimed'`) a valid claim (the `altis_install` cookie, tmp/install-session.json) →
//             otherwise 403 INSTALL_CLAIM_REQUIRED; a non-GET request also needs `Origin` = the claim's origin
//             (ORIGIN_DENIED) and `X-CSRF-Token` = installCsrfToken (CSRF_INVALID).
//   side-effect GET
//             1d Task 18: a `claimed` GET declared `sideEffects` (the request code, whose `?new=1` records a nonce),
//             checked here in place of step 8 (T23): HEAD → 404 NOT_FOUND (Hono would run the GET handler for it); a
//             cross-site `Sec-Fetch-Site`, or an `Origin` header other than the claim's → ORIGIN_DENIED.
//
// Before the install there is no config, so no baseUrl: `altis_install` gets `Secure` and the `__Host-` prefix only
// when ALTIS_BASE_URL is an https URL (C19; P13 never takes the scheme from a header). It is `SameSite=Strict`.

/** The claim cookie (spec §7.7: "altis_install (Strict)"). */
export const INSTALL_COOKIE = 'altis_install';

/** How long the database the environment names gets to answer the volume check (spec §7.7, plan Task 10). */
export const ENV_DB_TIMEOUT_MS = 5000;
/**
 * After a failed look at the environment's database, the next one waits this long; meanwhile the gate keeps answering
 * DB_UNAVAILABLE without looking (fail closed: an unreachable database is never taken for an empty one).
 */
export const ENV_DB_RETRY_MS = 5_000;

/** The wizard's shared state in one app (services.install): its gate, database handle, cookie rule and page. */
export interface InstallService {
  /** DATA_DIR (`deps.dataDir`); undefined in an app built without one (tests, tools). */
  readonly dataDir: string | undefined;
  /** The application folder (`deps.appRoot`), whose install marker the gate reads. */
  readonly appRoot: string | undefined;
  /** The runtime this process runs under (`deps.runtime`, default standalone). */
  readonly runtime: Runtime;
  readonly env: Env;
  /**
   * The install gate now (core installGate): file checks per call; config.json as the state holds it, else as the
   * file says; the environment database's install id cached per process (M35).
   *
   * @throws DomainError `DB_UNAVAILABLE` while the database the environment names cannot be read (fail closed: the
   *   gate cannot tell a fresh install from a lost volume, so neither the wizard nor a new code)
   */
  gate(): Promise<InstallGate>;
  /**
   * The wizard's own database handle, once {@link open} opened it; undefined before. An install route's `rc.db`,
   * `rc.withTx` and audit use it (MountOptions.dbFor).
   */
  db(): DbHandle | undefined;
  /**
   * Opens the wizard's handle from config.json (the state's, else the file) when there is one and none is open yet,
   * once per process (concurrent calls share one attempt); undefined while there is no config.json. A step that needs
   * the database calls it first.
   *
   * 1c Task 27: a step passes the config it has just read from the file (`config`, environment overrides applied): a
   * handle opened for another `db` (the wizard's database step was sent again with other settings, in this process or
   * another) is closed and one for `config.db` opened, so that no step writes to a database config.json no longer names.
   *
   * @throws connect's errors (DB_UNAVAILABLE, INVALID_CONFIG, ...); loadConfig's
   */
  open(config?: Config): Promise<DbHandle | undefined>;
  /**
   * Closes the wizard's handle (the install's `finish`, Task 27; start()'s boot once the install is complete); a later
   * {@link open} opens a new one. 1c Task 27: it waits until no wizard step {@link hold}s the handle, so that a boot
   * that another request started cannot close it under a step still writing through it (finish's audit).
   */
  close(): Promise<void>;
  /**
   * 1c Task 27: marks a wizard step as using the handle until the returned function is called (idempotent);
   * {@link close} waits for every hold to end.
   */
  hold(): () => void;
  /** Whether `altis_install` is `Secure` with the `__Host-` prefix: ALTIS_BASE_URL is an https URL (C19). */
  cookieSecure(): boolean;
  /** install.html of the running release (its nonce placeholders included), or null when the release has none. */
  pageHtml(): Promise<string | null>;
}

export interface InstallServiceDeps {
  dataDir?: string | undefined;
  appRoot?: string | undefined;
  runtime?: Runtime | undefined;
  env?: Env | undefined;
  release?: { dir: string } | undefined;
  log: Logger;
}

/**
 * The connection settings the environment gives without a config.json (ALTIS_DB_*), or null: no ALTIS_DB_DIALECT, an
 * unknown one, or `sqlite` (its file lives in DATA_DIR, so it is gone with the volume, and opening it would create it).
 */
export function envDbConfig(env: Env): DbConfig | null {
  if (!isEnvSet(env, 'ALTIS_DB_DIALECT')) return null;
  const dialect = env['ALTIS_DB_DIALECT']!.trim().toLowerCase();
  if (dialect !== 'mysql' && dialect !== 'mariadb' && dialect !== 'postgres') return null;
  // Without a host the env names no reachable database (the rest may come from config.json), so it decides nothing:
  // failing closed on it would keep a dialect-only setup at 503 for good.
  if (!isEnvSet(env, 'ALTIS_DB_HOST') || env['ALTIS_DB_HOST']!.trim() === '') return null;
  const text = (name: string): string | undefined => (isEnvSet(env, name) ? env[name]! : undefined);
  const port = text('ALTIS_DB_PORT')?.trim();
  return {
    dialect,
    ...(text('ALTIS_DB_HOST') === undefined ? {} : { host: text('ALTIS_DB_HOST')!.trim() }),
    ...(port !== undefined && /^\d{1,5}$/.test(port) ? { port: Number(port) } : {}),
    ...(text('ALTIS_DB_USER') === undefined ? {} : { user: text('ALTIS_DB_USER')! }),
    ...(text('ALTIS_DB_PASSWORD') === undefined ? {} : { password: text('ALTIS_DB_PASSWORD')! }),
    ...(text('ALTIS_DB_NAME') === undefined ? {} : { database: text('ALTIS_DB_NAME')! }),
  };
}

export interface EnvDbInstallIdOptions {
  env: Env;
  runtime: Runtime;
  dataDir: string | undefined;
  log: Logger;
  /** The clock of the retry wait (default `Date.now`). */
  clock?: () => number;
  /**
   * Reads schema_meta.install_id of the database `cfg` names (null: none yet). Default: a connection of its own
   * ({@link ENV_DB_TIMEOUT_MS} to connect, closed again).
   */
  read?: (cfg: DbConfig) => Promise<string | null>;
}

/**
 * `envDbInstallId` of the install gate for this process (M35): schema_meta.install_id of the database ALTIS_DB_*
 * names, read over a connection of its own (5 s to connect, closed again). An answer, null included, is kept for the
 * life of the process: it cannot change while the volume stays missing, and a database the wizard of this very
 * process has just seeded must not turn into "volume missing". Concurrent calls share one look.
 *
 * It fails closed: a look that fails (the database not up yet, refused, wrong credentials) is logged and answered
 * DB_UNAVAILABLE, never null, so the gate cannot take a database it could not read for an empty one (a lost Docker
 * volume would otherwise get the wizard and a new install code). Calls within {@link ENV_DB_RETRY_MS} of a failure
 * answer DB_UNAVAILABLE without looking; the next one looks again.
 *
 * @returns a function that throws DomainError `DB_UNAVAILABLE` while the database cannot be read
 */
export function createEnvDbInstallId(o: EnvDbInstallIdOptions): () => Promise<string | null> {
  const clock = o.clock ?? (() => Date.now());
  const read =
    o.read ??
    (async (cfg: DbConfig): Promise<string | null> => {
      let h: DbHandle | undefined;
      try {
        h = await connect(cfg, { runtime: o.runtime, purpose: 'cli', dataDir: o.dataDir ?? '', connectTimeoutMs: ENV_DB_TIMEOUT_MS });
        return await dbInstallId(h);
      } finally {
        await h?.close().catch(() => {});
      }
    });
  const unavailable = (): DomainError => new DomainError('DB_UNAVAILABLE', { meta: { reason: 'unreachable' } });
  let known: { id: string | null } | undefined;
  let pending: Promise<string | null> | undefined;
  let retryAt = 0;
  const look = async (cfg: DbConfig): Promise<string | null> => {
    try {
      const id = await read(cfg);
      known = { id };
      return id;
    } catch (error) {
      o.log.warn('the database of ALTIS_DB_* could not be read for the install gate', { err: loggableError(error) });
      retryAt = clock() + ENV_DB_RETRY_MS;
      throw unavailable();
    }
  };
  return async () => {
    if (known !== undefined) return known.id;
    const cfg = envDbConfig(o.env);
    if (cfg === null) {
      known = { id: null };
      return null;
    }
    if (pending !== undefined) return pending;
    if (clock() < retryAt) throw unavailable();
    pending = look(cfg).finally(() => {
      pending = undefined;
    });
    return pending;
  };
}

/** config.json's installState as written, or null without a usable one (the gate only needs that field). */
async function fileInstallState(dataDir: string): Promise<{ installState: string } | null> {
  try {
    const state = await readJsonWithBak(dataPath(dataDir, 'root', 'config.json'), (raw) => {
      const value = typeof raw === 'object' && raw !== null ? (raw as { installState?: unknown }).installState : undefined;
      if (typeof value !== 'string') throw new TypeError('config.json: installState is not a string');
      return value;
    });
    return state === null ? null : { installState: state };
  } catch (error) {
    if (isDomainError(error) && error.code === 'STATE_CORRUPT') return null;
    throw error;
  }
}

/** The install service of an app over `state` (see {@link InstallService}). */
export function createInstallService(state: AppState, deps: InstallServiceDeps): InstallService {
  const { dataDir, appRoot } = deps;
  const runtime = deps.runtime ?? 'standalone';
  const env = deps.env ?? process.env;
  const envDbInstallId = createEnvDbInstallId({ env, runtime, dataDir, log: deps.log });
  let handle: DbHandle | undefined;
  /** The `db` settings `handle` was opened with (JSON), to tell whether a step's config still names its database. */
  let handleDb: string | undefined;
  let opening: Promise<DbHandle | undefined> | undefined;
  /** Wizard steps using the handle now (hold), and the closes waiting for them to end. */
  let holds = 0;
  let released: (() => void)[] = [];
  let page: string | undefined;

  const openHandle = async (given: Config | undefined): Promise<DbHandle | undefined> => {
    if (dataDir === undefined) return undefined;
    const config = given ?? state.config ?? (await loadConfig(dataDir, env));
    if (config === null) return undefined;
    handle = await connect(config.db, { runtime, purpose: 'server', dataDir });
    handleDb = JSON.stringify(config.db);
    return handle;
  };

  return {
    dataDir,
    appRoot,
    runtime,
    env,
    async gate() {
      const config = state.config ?? (dataDir === undefined ? null : await fileInstallState(dataDir));
      if (dataDir === undefined) {
        if (config === null) return { kind: 'fresh' };
        return config.installState === 'complete' ? { kind: 'installed' } : { kind: 'resume', installState: config.installState };
      }
      return installGate({ dataDir, appRoot: appRoot ?? null, env, config, envDbInstallId });
    },
    db: () => handle,
    async open(config) {
      while (opening !== undefined) await opening.catch(() => undefined);
      const wanted = config === undefined ? undefined : JSON.stringify(config.db);
      if (handle !== undefined && (wanted === undefined || wanted === handleDb)) return handle;
      opening = (async () => {
        const stale = handle;
        handle = undefined;
        handleDb = undefined;
        await stale?.close().catch(() => {});
        return openHandle(config);
      })().finally(() => {
        opening = undefined;
      });
      return opening;
    },
    async close() {
      while (holds > 0) await new Promise<void>((resolve) => released.push(resolve));
      const h = handle;
      handle = undefined;
      handleDb = undefined;
      await h?.close();
    },
    hold() {
      holds += 1;
      let done = false;
      return () => {
        if (done) return;
        done = true;
        holds -= 1;
        if (holds > 0) return;
        const waiting = released;
        released = [];
        for (const resolve of waiting) resolve();
      };
    },
    cookieSecure: () => isEnvSet(env, 'ALTIS_BASE_URL') && isSecureBase(env['ALTIS_BASE_URL']!.trim()),
    async pageHtml() {
      if (page !== undefined) return page;
      if (deps.release === undefined) return null;
      const bytes = await readReleaseFile(deps.release.dir, 'install-index');
      if (bytes === null) return null;
      page = bytes.toString('utf8');
      return page;
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The cookie

/** The claim cookie's name: `__Host-altis_install` when `secure`, else `altis_install`. */
export function installCookieName(secure: boolean): string {
  return secure ? `__Host-${INSTALL_COOKIE}` : INSTALL_COOKIE;
}

/**
 * Sets `altis_install` to `value`: `HttpOnly; SameSite=Strict; Path=/`, a browser-session cookie (the claim expires
 * on the server after 2 h idle), plus `Secure` and the `__Host-` name when `o.secure` (1b's setAuthCookie needs a
 * loaded config and fixes SameSite=Lax, M10).
 */
export function setInstallCookie(c: Context<AppEnv>, value: string, o: { secure: boolean; maxAgeS?: number }): void {
  setCookie(c, installCookieName(o.secure), value, {
    path: '/',
    httpOnly: true,
    secure: o.secure,
    sameSite: 'Strict',
    ...(o.maxAgeS === undefined ? {} : { maxAge: o.maxAgeS }),
  });
}

/** Removes `altis_install` (an empty value with `Max-Age=0`, same name and attributes). */
export function clearInstallCookie(c: Context<AppEnv>, o: { secure: boolean }): void {
  setInstallCookie(c, '', { secure: o.secure, maxAgeS: 0 });
}

/** The value of `altis_install` under the name `o.secure` decides; undefined when absent or empty. */
export function readInstallCookie(c: Context<AppEnv>, o: { secure: boolean }): string | undefined {
  const value = getCookie(c, installCookieName(o.secure));
  return value === undefined || value === '' ? undefined : value;
}

// ---------------------------------------------------------------------------------------------------------------
// The checks of a wizard route

/** The request's `Origin` header as an http(s) origin, or null (absent, `null`, or not an http(s) URL). */
export function requestInstallOrigin(c: Context<AppEnv>): string | null {
  const origin = c.req.header('origin');
  if (origin === undefined) return null;
  try {
    const url = new URL(origin);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
}

/** A `Sec-Fetch-Site` that names another site (anything but absent, `same-origin` and `none`). */
function crossSite(c: Context<AppEnv>): boolean {
  const site = c.req.header('sec-fetch-site');
  return site !== undefined && site !== 'same-origin' && site !== 'none';
}

/**
 * The checks of a wizard route (see the top of this file), in place of steps 7-9 of the chain. Returns the claim of a
 * `claimed` route, null for `page` and `claim`. `o.sideEffects` is the route's `sideEffects` (1d Task 18).
 *
 * @throws DomainError `NOT_FOUND` (installed; HEAD of a side-effect GET), `DATA_VOLUME_MISSING`, `DATA_DIR_MISMATCH`, `DB_UNAVAILABLE` (the gate
 *   cannot decide yet), `ORIGIN_DENIED`, `INSTALL_CLAIM_REQUIRED`, `CSRF_INVALID`
 */
export async function checkInstallRoute(
  c: Context<AppEnv>,
  kind: 'page' | 'claim' | 'claimed',
  o: { install: InstallService; now: number; sideEffects?: boolean },
): Promise<InstallSession | null> {
  /** A refusal, named in `X-Altis-Test-Gate` under the test profile (D43; the matrix's `gone` is NOT_FOUND, M38). */
  const deny = (code: ErrorCode): DomainError => {
    markTestGate(c, code);
    return new DomainError(code);
  };
  const gate = await o.install.gate();
  if (gate.kind === 'installed') throw deny('NOT_FOUND');
  if (gate.kind === 'volume_missing') throw deny('DATA_VOLUME_MISSING');
  if (gate.kind === 'datadir_mismatch') throw deny('DATA_DIR_MISMATCH');
  if (kind === 'page') return null;
  if (kind === 'claim') {
    if (crossSite(c) || requestInstallOrigin(c) === null) throw deny('ORIGIN_DENIED');
    return null;
  }

  const token = readInstallCookie(c, { secure: o.install.cookieSecure() });
  const dataDir = o.install.dataDir;
  const session = token === undefined || dataDir === undefined ? null : await readInstallSession(dataDir, token, o.now);
  if (session === null) throw deny('INSTALL_CLAIM_REQUIRED');
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    if (crossSite(c) || requestInstallOrigin(c) !== session.origin) throw deny('ORIGIN_DENIED');
    const sent = c.req.header('x-csrf-token');
    if (sent === undefined || !safeEqual(sent, installCsrfToken(session))) throw deny('CSRF_INVALID');
  } else if (o.sideEffects === true) {
    // 1d Task 18: a side-effect GET (see the top of this file). A GET carries no CSRF token; an `Origin` is checked
    // when one is sent (a browser sends one on a cross-origin request).
    if (c.req.method === 'HEAD') throw new DomainError('NOT_FOUND');
    if (crossSite(c) || (c.req.header('origin') !== undefined && requestInstallOrigin(c) !== session.origin)) throw deny('ORIGIN_DENIED');
  }
  return session;
}

/** Whether `urlPath` belongs to the wizard: `/install` and everything under `/install/api/`. */
export function isInstallPath(urlPath: string): boolean {
  return urlPath === '/install' || urlPath.startsWith('/install/api/');
}

// ---------------------------------------------------------------------------------------------------------------
// The code on stdout

let stdoutGuarded = false;

/** Writes `text` to stdout, where a reader that went away (EPIPE) must not crash the process (as index.ts's logs). */
function writeStdout(text: string): void {
  if (!stdoutGuarded) {
    stdoutGuarded = true;
    process.stdout.on('error', () => {});
  }
  process.stdout.write(text);
}

/**
 * What stdout says about the install code (spec §7.7: shown on stdout, never in the log file): the code grouped
 * 5-5-5-5-6 with where to enter it; for ALTIS_INSTALL_CODE only where it comes from (the operator set it, and a
 * container's stdout ends up in its logs).
 */
export function installCodeText(info: Pick<InstallCodeInfo, 'code' | 'source'>): string {
  if (info.source === 'env') {
    return (
      'ALTIS belum terpasang. Buka /install di browser dan masukkan kode instalasi dari ALTIS_INSTALL_CODE.\n' +
      'ALTIS is not installed. Open /install in a browser and enter the installation code of ALTIS_INSTALL_CODE.\n'
    );
  }
  return (
    'ALTIS belum terpasang. Buka /install di browser dan masukkan kode instalasi ini (berlaku 24 jam):\n' +
    'ALTIS is not installed. Open /install in a browser and enter this installation code (valid for 24 hours):\n' +
    `\n    ${formatInstallCode(info.code)}\n\n`
  );
}

/** Prints {@link installCodeText} to stdout, in one write. */
export function printInstallCode(info: Pick<InstallCodeInfo, 'code' | 'source'>): void {
  writeStdout(installCodeText(info));
}

/**
 * start()'s announcement while not installed (spec §7.7): while the gate is `fresh` or `resume`, the install code every
 * process validates against is made when missing or expired, and printed to stdout (never to the log file), so every
 * process prints the same code. Its time is `o.clock()`, the app's clock (services.clock), which also dates and judges
 * the code of `install.page` and `install.claim` (rc.now).
 *
 * A failure of the gate or of the code file (DATA_DIR not writable, an unreadable marker, ...) is logged and GET
 * /install tries again; it never fails the boot.
 *
 * @throws DomainError `INVALID_CONFIG` for a malformed ALTIS_INSTALL_CODE (an explicit boot failure, as a bad
 *   config.json); `DB_UNAVAILABLE` while the gate cannot decide (the database of ALTIS_DB_* cannot be read: start()
 *   retries, and no code is printed meanwhile)
 */
export async function announceInstallCode(install: InstallService, o: { clock: () => number; log: Logger }): Promise<void> {
  const dataDir = install.dataDir;
  if (dataDir === undefined) return;
  let info: InstallCodeInfo;
  try {
    const gate = await install.gate();
    if (gate.kind !== 'fresh' && gate.kind !== 'resume') return;
    info = await ensureInstallCode(dataDir, { now: o.clock(), env: install.env });
  } catch (error) {
    if (isDomainError(error) && (error.code === 'INVALID_CONFIG' || error.code === 'DB_UNAVAILABLE')) throw error;
    o.log.warn('install code not written', { err: loggableError(error) });
    return;
  }
  printInstallCode(info);
}
