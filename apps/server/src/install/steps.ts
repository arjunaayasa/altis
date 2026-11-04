import {
  PASSWORD_MIN_LENGTH,
  appliedMigrationNames,
  assertInstallStep,
  checkPasswordPolicy,
  cronStatus,
  currentInstallSession,
  ensureInstallProbe,
  ensureSystemRoles,
  exposedBy,
  exposureCandidates,
  exposureTargets,
  failedChecks,
  installCsrfToken,
  migrationCounts,
  panelWarningFor,
  preflightChecks,
  probeHmac,
  readCronSeen,
  recordProbeResult,
  removeInstallProbe,
  runnerMode,
  safeEqual,
  updateInstallWizard,
  type Actor,
  type InstallSession,
  type OpStatus,
} from '@altis/core';
import { checkServer, connect, releaseMigrations, type DbConfig, type DbHandle } from '@altis/db';
import { dataPath, ensureDir, poolSize, realPathOf, removeFile, withFileLock } from '@altis/platform';
import { DomainError, ERROR_CODES, isDomainError, newId, type ErrorCode } from '@altis/shared';
import {
  type AdminBody,
  type ConfigBody,
  type CronTestResponse,
  type DbConfigBody,
  type DbTestBody,
  type DbTestResponse,
  type ExposureBody,
  type ExposureResponse,
  type FinishResponse,
  type InstallChecksResponse,
  type InstallStateResponse,
  type MigrateResponse,
  type ProfileBody,
  type ProgressResponse,
} from '@altis/shared/api/install';
import { homeDir } from '../cli/common.js';
import { detectPanelMarkers } from '../cli/host-panels.js';
import {
  checkEmpty,
  checkSqlite,
  claimSchemaMeta,
  createFirstSuperAdmin,
  dbUnsupported,
  freshInstallConfig,
  installDatabaseState,
  installRunLockPath,
  resumedInstallConfig,
  seedLibrary,
  writeInstallLock,
  writeInstalledMarker,
} from '../cli/install.js';
import { applyEnvOverrides, loadConfig, updateConfig, validateBaseUrl, writeConfig, type Config } from '../config.js';
import type { RouteContext } from '../http/route.js';
import { validationFailed } from '../http/validate.js';
import { clearInstallCookie, type InstallService } from './gate.js';

// The web wizard's steps (spec §9.5; plan Task 27, decision C35), which install/routes.ts declares. Every process of
// an installation may answer any step (Passenger runs up to six), so a step keeps nothing in memory that the next one
// needs: config.json (read from the file under the lock, never the state's copy, which a fence may hold 2 s late),
// tmp/install-session.json (the claim and the wizard's state: install/session.ts), ops/op.json (the `install-migrate`
// op) and the database. Every POST step runs under DATA_DIR/tmp/install-run.lock, the headless install's lock, so two
// steps (or a step and `install --config`) never interleave, and checks config.json's `installState` first
// (INSTALL_STEP_ORDER otherwise).
//
//   checks     the preflight checks, the runtime and its aaPanel warning, the CSRF token again, and the exposure test's
//              probe file (`tmp/<probeId>`, made once per claim) with the candidate URL paths to fetch
//   exposure   the browser's fetches: one that returned the probe file, app.js or altis-data-dir.txt → the session is
//              marked exposed (`config` refused) and 422 INSTALL_EXPOSED; none, with a result for every candidate
//              `checks` handed out → `exposure.okAt` recorded; a candidate left out → 422 VALIDATION_FAILED
//   db/test    connects (10 s) to the database the body names, with the environment's ALTIS_DB_* overrides as the
//              server will apply them: server check, pool size, empty or resumable
//   config     needs a clean exposure test (the session read again under the lock) and no preflight error; the base URL canonical (validateBaseUrl), equal to
//              the claim's origin (`origin_mismatch`) and proven by the probe HMAC (`probe_failed`: the browser reached
//              this installation at that URL); the database checked (server, empty or this install's own); config.json
//              written (new identity and secrets, or the unfinished install's kept), the browser test's results kept in
//              the session, and the `install-migrate` op begun
//   migrate    one handler step of the op (one migration, §9.5); once every migration is applied, the seeds in one
//              transaction (schema_meta.install_id, the system roles, `system.probe`) and installState `profile`
//   progress   installState and the migrations applied
//   profile    the library settings and the default branch → `admin`
//   admin      the password policy and scrypt in `prepare` (S18); createFirstSuperAdmin (its `users.create` counted
//              for the route) → `cron`
//   cron/test  whether a scheduler call was seen (tmp/cron-seen.json, written by `jobs:run` and `POST /_cron` before
//              the install completes) or the worker runs, and the lines to paste
//   finish     on Passenger/LiteSpeed a detected scheduler first (CRON_NOT_DETECTED); then audit `install.complete`
//              (first: once installState or install.lock says complete every /install request is 404, so an entry
//              that failed after them could never be written, D37) → installState `complete` → install.lock → the
//              marker (only where appRoot is writable and the runtime is not docker/service) → the code, session and
//              probe files removed → the wizard's handle closed and a new boot attempt (L45) → `altis_install` cleared

/** How long a step waits for another one (or the headless install) holding install-run.lock. */
export const INSTALL_RUN_WAIT_MS = 10_000;
/** `db/test` and `config` give the database this long to answer (spec §9.5 step 2). */
export const DB_TEST_CONNECT_MS = 10_000;

const NO_STORE = { 'Cache-Control': 'no-store' };
/** The time zone of the install date (config.json `install.trialStartedAt`) before the library has one. */
const INSTALL_TIMEZONE = 'Asia/Jakarta';

type Rc<B = unknown> = RouteContext<B, unknown, unknown>;

/** What every step needs of the app. */
interface Wizard {
  install: InstallService;
  dataDir: string;
  appRoot: string;
  /** The claim the route chain checked (`install: 'claimed'`). */
  session: InstallSession;
}

function wizardOf(rc: Rc<unknown>): Wizard {
  const install = rc.services.install;
  const { dataDir, appRoot } = install;
  if (dataDir === undefined || appRoot === undefined) throw new TypeError(`route ${rc.c.req.path}: the app has no DATA_DIR or appRoot`);
  if (rc.installSession === null) throw new TypeError(`route ${rc.c.req.path}: no install session (not an install: 'claimed' route)`);
  return { install, dataDir, appRoot, session: rc.installSession };
}

/** The claim moved or went idle while the step ran: the same answer as without one. */
function claimGone(): DomainError {
  return new DomainError('INSTALL_CLAIM_REQUIRED');
}

/** Who the wizard's writes and audit entries are by: the installation itself, from the installer's address. */
function systemActor(rc: Rc<unknown>): Actor {
  return { type: 'system', id: null, ip: rc.ip };
}

/** config.json as written (no environment override applied), or null when there is none. */
function fileConfig(dataDir: string): Promise<Config | null> {
  return loadConfig(dataDir, {});
}

/**
 * Runs `fn` under DATA_DIR/tmp/install-run.lock (see the top of this file), with the wizard's handle held when `hold`
 * is given ({@link holding}).
 *
 * @throws DomainError `INSTALL_STEP_ORDER` when another step holds the lock for longer than {@link INSTALL_RUN_WAIT_MS}
 */
async function underRunLock<T>(dataDir: string, fn: () => Promise<T>, hold?: Wizard): Promise<T> {
  await ensureDir(dataPath(dataDir, 'tmp'));
  try {
    // A step that uses the wizard's handle holds it inside the lock: `config`, which closes the handle while it holds
    // the lock, never waits for a step that is itself waiting for the lock.
    return await withFileLock(installRunLockPath(dataDir), () => (hold === undefined ? fn() : holding(hold, fn)), { waitMs: INSTALL_RUN_WAIT_MS });
  } catch (error) {
    if (isDomainError(error) && error.code === 'STATE_CORRUPT' && error.meta?.['reason'] === 'lock_timeout') {
      throw new DomainError('INSTALL_STEP_ORDER', {
        detail: 'Langkah instalasi lain sedang berjalan; coba lagi / Another install step is running; try again',
        meta: { reason: 'busy' },
      });
    }
    throw error;
  }
}

/** The step's config.json, checked against `step`'s order (the file must exist past `config`). */
async function stepConfig(dataDir: string, step: Parameters<typeof assertInstallStep>[0]): Promise<Config | null> {
  const file = await fileConfig(dataDir);
  assertInstallStep(step, file?.installState ?? null);
  return file;
}

/** Like {@link stepConfig}, for a step that runs after `config`: the file and the config in use (overrides applied). */
async function installedConfig(w: Wizard, step: Parameters<typeof assertInstallStep>[0]): Promise<{ file: Config; config: Config }> {
  const file = await stepConfig(w.dataDir, step);
  if (file === null) throw new TypeError(`install step ${step}: no config.json past the config step`);
  return { file, config: applyEnvOverrides(file, w.install.env) };
}

/**
 * Runs `fn` with the wizard's handle held (InstallService.hold): a boot that another request starts once the install is
 * complete waits for the step before it closes the handle (finish audits through it after `complete` is written).
 */
async function holding<T>(w: Wizard, fn: () => Promise<T>): Promise<T> {
  const release = w.install.hold();
  try {
    return await fn();
  } finally {
    release();
  }
}

/** The wizard's database handle for `config` (DB_UNAVAILABLE without one). */
async function wizardDb(w: Wizard, config: Config): Promise<DbHandle> {
  const h = await w.install.open(config);
  if (h === undefined) throw new DomainError('DB_UNAVAILABLE');
  return h;
}

/** Moves config.json's installState on, applied to this process at once (the other processes follow by their fence). */
async function moveTo(rc: Rc<unknown>, installState: Config['installState']): Promise<void> {
  await rc.services.configWriter.update((cfg) => {
    cfg.installState = installState;
  });
}

/** The real path of `p` (symbolic links resolved), or `p` itself when it cannot be resolved. */
async function realOr(p: string): Promise<string> {
  if (p === '') return p;
  return (await realPathOf(p).catch(() => null)) ?? p;
}

function preflightOf(w: Wizard) {
  const env = w.install.env;
  return preflightChecks({
    nodeVersion: process.versions.node,
    dataDir: w.dataDir,
    appRoot: w.appRoot,
    home: homeDir(env),
    runtime: w.install.runtime,
    env,
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Step 1

/** The exposure test's candidate URL paths for the probe file `probeId` (decision C21), from the folders' real paths. */
async function candidatesFor(w: Wizard, probeId: string) {
  return exposureCandidates({
    dataDir: await realOr(w.dataDir),
    appRoot: await realOr(w.appRoot),
    home: await realOr(homeDir(w.install.env)),
    probeId,
  });
}

/** `GET checks` (see the top of this file). */
export async function checksStep(rc: Rc<unknown>): Promise<{ body: InstallChecksResponse; headers: Record<string, string> }> {
  const w = wizardOf(rc);
  const file = await fileConfig(w.dataDir);
  const preflight = await preflightOf(w);
  let probeId = w.session.wizard.probeId;
  if (probeId === null) {
    const next = await updateInstallWizard(w.dataDir, w.session.claimHash, rc.now, (s) => ({ ...s, probeId: s.probeId ?? newId(rc.now) }));
    if (next === null || next.wizard.probeId === null) throw claimGone();
    probeId = next.wizard.probeId;
  }
  await ensureInstallProbe(w.dataDir, probeId);
  const candidates = await candidatesFor(w, probeId);
  const body: InstallChecksResponse = {
    installState: file?.installState ?? null,
    preflight,
    runtime: w.install.runtime,
    panelWarning: panelWarningFor(w.install.runtime, detectPanelMarkers()),
    csrfToken: installCsrfToken(w.session),
    exposure: { probeId, candidates },
  };
  return { body, headers: NO_STORE };
}

/** `POST exposure` (see the top of this file). */
export async function exposureStep(rc: Rc<ExposureBody>): Promise<{ body: ExposureResponse; headers: Record<string, string> }> {
  const w = wizardOf(rc);
  return underRunLock(w.dataDir, async () => {
    await stepConfig(w.dataDir, 'exposure');
    const probeId = w.session.wizard.probeId;
    if (probeId === null) {
      throw new DomainError('INSTALL_STEP_ORDER', {
        detail: 'Jalankan pemeriksaan lebih dulu / Run the checks first',
        meta: { step: 'exposure', reason: 'no_probe' },
      });
    }
    const hit = exposedBy(rc.body.results, await exposureTargets({ dataDir: w.dataDir, appRoot: w.appRoot, probeId }));
    if (hit === null) {
      // Nothing served is a verdict only when every candidate `checks` handed out was fetched (a failed fetch is still
      // reported, with status 0): a report that leaves one out, an empty one included, proves nothing (A2).
      const reported = new Set(rc.body.results.map((r) => r.path));
      if ((await candidatesFor(w, probeId)).some((x) => !reported.has(x.path))) throw validationFailed([{ path: 'results', code: 'incomplete' }]);
    }
    const next = await updateInstallWizard(w.dataDir, w.session.claimHash, rc.now, (s) => ({
      ...s,
      exposure: hit === null ? { exposed: false, okAt: rc.now } : { exposed: true, okAt: null },
    }));
    if (next === null) throw claimGone();
    if (hit !== null) {
      rc.log.warn('install: the exposure test fetched a file of the data or app folder through the web', { kind: hit.kind });
      throw new DomainError('INSTALL_EXPOSED', {
        detail:
          'Berkas ALTIS dapat diambil lewat web: folder data atau folder aplikasi ada di dalam document root. Pindahkan ke luar ' +
          'lalu ulangi pemeriksaan / ALTIS files can be fetched through the web: the data or app folder lies inside the ' +
          'document root. Move it outside, then run the checks again',
        meta: { kind: hit.kind },
      });
    }
    return { body: { ok: true }, headers: NO_STORE };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Step 2

/** A config with nothing but its `db`, to apply the environment's ALTIS_DB_* overrides to a database the body names. */
let dbTemplate: Config | undefined;

/** `db` as the server will connect to it: the environment's ALTIS_DB_* overrides applied. */
function effectiveDb(db: DbConfigBody, env: InstallService['env']): DbConfig {
  dbTemplate ??= freshInstallConfig({ baseUrl: 'http://localhost', hops: 0, db: { dialect: 'sqlite' }, runtime: 'standalone', timezone: INSTALL_TIMEZONE });
  return applyEnvOverrides({ ...dbTemplate, db }, env).db;
}

/** `POST db/test` (see the top of this file). */
export async function dbTestStep(rc: Rc<DbTestBody>): Promise<{ body: DbTestResponse; headers: Record<string, string> }> {
  const w = wizardOf(rc);
  const runtime = w.install.runtime;
  return underRunLock(w.dataDir, async () => {
    const existing = await stepConfig(w.dataDir, 'db_test');
    const db = effectiveDb(rc.body.db, w.install.env);
    checkSqlite(db.dialect, runtime);
    const h = await connect(db, { runtime, purpose: 'cli', dataDir: w.dataDir, connectTimeoutMs: DB_TEST_CONNECT_MS });
    try {
      const server = await checkServer(h);
      const state = await installDatabaseState(h, existing);
      const body: DbTestResponse = {
        ok: server.ok,
        flavor: server.flavor,
        version: server.version,
        problems: [...server.problems],
        poolSize: poolSize(runtime, 'server', h.limits),
        empty: state.empty,
        resumable: state.resumable,
      };
      return { body, headers: NO_STORE };
    } finally {
      await h.close();
    }
  });
}

function invalidBaseUrl(reason: 'origin_mismatch' | 'probe_failed'): DomainError {
  const why =
    reason === 'origin_mismatch'
      ? 'tidak sama dengan alamat yang dipakai browser ini / is not the address this browser uses'
      : 'tidak menjangkau instalasi ini (uji HMAC gagal) / does not reach this installation (the HMAC test failed)';
  return new DomainError('INVALID_BASE_URL', { detail: `baseUrl ${why}`, meta: { reason } });
}

/** `POST config` (see the top of this file). */
export async function configStep(rc: Rc<ConfigBody>): Promise<{ body: InstallStateResponse; headers: Record<string, string> }> {
  const w = wizardOf(rc);
  const { body } = rc;
  const runtime = w.install.runtime;
  const env = w.install.env;
  return underRunLock(w.dataDir, async () => {
    const existing = await stepConfig(w.dataDir, 'config');
    // The wizard state as it is now, under the run lock (an exposure step may have run since the route chain read it).
    const current = await currentInstallSession(w.dataDir, w.session.claimHash, rc.now);
    if (current === null) throw claimGone();
    const exposure = current.wizard.exposure;
    if (exposure.exposed || exposure.okAt === null) {
      throw new DomainError('INSTALL_STEP_ORDER', {
        detail: 'Uji paparan belum lolos / The exposure test has not passed',
        meta: { step: 'config', reason: 'exposure' },
      });
    }
    const preflight = await preflightOf(w);
    const errors = failedChecks(preflight, 'error');
    if (errors.length > 0) {
      throw new DomainError('INSTALL_STEP_ORDER', {
        detail: `Pemeriksaan wajib gagal / Mandatory checks failed: ${errors.join(', ')}`,
        meta: { step: 'config', reason: 'preflight', checks: errors },
      });
    }
    const baseUrl = validateBaseUrl(body.baseUrl);
    if (baseUrl !== w.session.origin) throw invalidBaseUrl('origin_mismatch');
    if (!safeEqual(body.probe.hmac, probeHmac(w.session, body.probe.nonce))) throw invalidBaseUrl('probe_failed');

    const settings = { baseUrl, hops: body.trustProxy.hops, db: body.db, runtime };
    // The install date by the app clock, as the claim and the install code are dated (rc.now).
    const config = existing === null ? freshInstallConfig({ ...settings, timezone: INSTALL_TIMEZONE, now: rc.now }) : resumedInstallConfig(existing, settings);
    const effective = applyEnvOverrides(config, env);
    checkSqlite(effective.db.dialect, runtime);
    const h = await connect(effective.db, { runtime, purpose: 'cli', dataDir: w.dataDir, connectTimeoutMs: DB_TEST_CONNECT_MS });
    try {
      const server = await checkServer(h);
      if (!server.ok) throw dbUnsupported(server.problems, server.version);
      await checkEmpty(h, existing);
    } finally {
      await h.close();
    }

    if (existing === null) {
      await writeConfig(w.dataDir, config);
    } else {
      await updateConfig(w.dataDir, (current) => {
        // Thrown inside mutate, so nothing is written: the identity checked against the database must not change.
        if (current.install.id !== existing.install.id) {
          throw new DomainError('STATE_CORRUPT', {
            detail: 'config.json berubah selama instalasi / config.json changed during the install',
            meta: { reason: 'install_id_changed' },
          });
        }
        return resumedInstallConfig(current, settings);
      });
    }
    const kept = await updateInstallWizard(w.dataDir, w.session.claimHash, rc.now, (s) => ({ ...s, probeResults: body.probe.results }));
    if (kept === null) throw claimGone();
    // The database may be another one now: this process's handle is opened again by the next step.
    await w.install.close();

    const op = await rc.services.ops.current();
    if (op === null || op.terminal) {
      await rc.services.ops.begin('install-migrate', { type: 'install', id: null }, {});
    } else if (op.kind !== 'install-migrate') {
      throw new DomainError('OPS_IN_PROGRESS', { detail: 'Operasi lain sedang berjalan / Another operation is in progress' });
    }
    // This process serves from the new config.json at once (its config fence is made by that boot attempt).
    rc.services.installDone();
    return { body: { installState: 'migrate' }, headers: NO_STORE };
  });
}

/** The failure an `install-migrate` op ended with, as the step's answer. */
function migrationFailed(op: OpStatus): DomainError {
  const code = op.error?.code;
  const known = code !== undefined && Object.prototype.hasOwnProperty.call(ERROR_CODES, code) ? (code as ErrorCode) : 'INTERNAL';
  return new DomainError(known, {
    detail: op.error?.detail ?? 'Migrasi database gagal; lihat log server / A database migration failed; see the server log',
    meta: { reason: 'migration_failed' },
  });
}

/** `POST migrate` (see the top of this file). */
export async function migrateStep(rc: Rc<unknown>): Promise<{ body: MigrateResponse; headers: Record<string, string> }> {
  const w = wizardOf(rc);
  const ops = rc.services.ops;
  return underRunLock(w.dataDir, async () => {
    const { config } = await installedConfig(w, 'migrate');
    const h = await wizardDb(w, config);
    const known = Object.keys(releaseMigrations()).sort();
    const before = await appliedMigrationNames(h);
    let op = await ops.current();
    const pending = known.some((name) => !before.includes(name));
    if (pending || (op !== null && !op.terminal)) {
      if (op === null || op.terminal) {
        await ops.begin('install-migrate', { type: 'install', id: null }, {});
      } else if (op.kind !== 'install-migrate') {
        throw new DomainError('OPS_IN_PROGRESS', { detail: 'Operasi lain sedang berjalan / Another operation is in progress' });
      } else if (op.needsAttention) {
        await ops.resume();
      }
      // One handler step (§9.5: "satu migrateUp() per panggilan"); a step that finds the op stalled (an install
      // interrupted for longer than 15 minutes) only marks it: it is resumed and stepped once more.
      op = await ops.step(1);
      if (op?.kind === 'install-migrate' && op.needsAttention) {
        await ops.resume();
        op = await ops.step(1);
      }
      if (op?.kind === 'install-migrate' && op.terminal && op.state !== 'done') throw migrationFailed(op);
    }
    const after = await appliedMigrationNames(h);
    const applied = after.find((name) => !before.includes(name)) ?? null;
    const counts = migrationCounts(after, known);
    const remaining = counts.total - counts.applied;
    if (remaining > 0 || (op !== null && !op.terminal)) return { body: { done: false, applied, remaining }, headers: NO_STORE };

    // The seeds of the migrations (one transaction): this database is the install's, the system roles, and the browser
    // test's results (a spoofable X-Forwarded-For sets system.ip_trust). The forged poll ran before config.json
    // existed, at the pre-install hops: it is judged at the hops the installation runs with (C22).
    const results = w.session.wizard.probeResults;
    await rc.withTx(
      async (tx) => {
        await claimSchemaMeta(tx.trx, config.install.id);
        await ensureSystemRoles(tx.trx, rc.now);
        if (results !== null) await recordProbeResult(tx.trx, results, { now: rc.now, actorId: null, hops: config.trustProxy.hops });
      },
      { actor: systemActor(rc) },
    );
    await moveTo(rc, 'profile');
    return { body: { done: true, applied, remaining: 0 }, headers: NO_STORE };
  }, w);
}

/** `GET progress` (see the top of this file). */
export async function progressStep(rc: Rc<unknown>): Promise<{ body: ProgressResponse; headers: Record<string, string> }> {
  const w = wizardOf(rc);
  const known = Object.keys(releaseMigrations());
  const file = await fileConfig(w.dataDir);
  if (file === null) return { body: { installState: null, migrations: { applied: 0, total: known.length } }, headers: NO_STORE };
  return holding(w, async () => {
    const h = await wizardDb(w, applyEnvOverrides(file, w.install.env));
    return { body: { installState: file.installState, migrations: migrationCounts(await appliedMigrationNames(h), known) }, headers: NO_STORE };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Steps 3-6

/** `POST profile` (see the top of this file). */
export async function profileStep(rc: Rc<ProfileBody>): Promise<{ body: InstallStateResponse; headers: Record<string, string> }> {
  const w = wizardOf(rc);
  return underRunLock(w.dataDir, async () => {
    const { config } = await installedConfig(w, 'profile');
    await wizardDb(w, config);
    const { library, branch } = rc.body;
    // The canonical spelling (`asia/jakarta` → `Asia/Jakarta`), as the headless install writes it.
    const timezone = new Intl.DateTimeFormat('en-US', { timeZone: library.timezone }).resolvedOptions().timeZone;
    await rc.withTx(
      (tx) =>
        seedLibrary(
          tx.trx,
          { name: library.name, timezone, locale: library.locale, type: library.type, address: library.address },
          { now: rc.now, branch: { code: branch.code, name: branch.name } },
        ),
      { actor: systemActor(rc) },
    );
    await moveTo(rc, 'admin');
    return { body: { installState: 'admin' }, headers: NO_STORE };
  }, w);
}

/** `POST admin`'s `prepare` (S18): the step's order, the password policy, then scrypt, all outside any transaction. */
export async function adminPrepare(rc: Rc<AdminBody>): Promise<{ passwordHash: string }> {
  const w = wizardOf(rc);
  await stepConfig(w.dataDir, 'admin');
  checkPasswordPolicy(rc.body.password, { minLength: PASSWORD_MIN_LENGTH });
  return { passwordHash: await rc.services.hasher.hash(rc.body.password) };
}

/** `POST admin` (see the top of this file). */
export async function adminStep(rc: Rc<AdminBody>): Promise<{ body: InstallStateResponse; headers: Record<string, string> }> {
  const w = wizardOf(rc);
  const { passwordHash } = rc.prepared as { passwordHash: string };
  return underRunLock(w.dataDir, async () => {
    const { config } = await installedConfig(w, 'admin');
    await wizardDb(w, config);
    const { username, name, email } = rc.body;
    await rc.withTx((tx) => createFirstSuperAdmin(tx.trx, { admin: { username, name, email }, passwordHash, now: rc.now, tx }), {
      actor: systemActor(rc),
    });
    await moveTo(rc, 'cron');
    return { body: { installState: 'cron' }, headers: NO_STORE };
  }, w);
}

/** The scheduler test of this process for `config` (overrides applied). */
async function cronOf(rc: Rc<unknown>, w: Wizard, config: Config): Promise<CronTestResponse> {
  const runtime = w.install.runtime;
  return cronStatus({
    runtime,
    worker: runnerMode(runtime, w.install.env) === 'worker',
    seen: await readCronSeen(w.dataDir),
    now: rc.now,
    execPath: process.execPath,
    appRoot: w.appRoot,
    baseUrl: config.baseUrl,
    cronToken: config.secrets.cronToken,
  });
}

/** `POST cron/test` (see the top of this file). */
export async function cronTestStep(rc: Rc<unknown>): Promise<{ body: CronTestResponse; headers: Record<string, string> }> {
  const w = wizardOf(rc);
  return underRunLock(w.dataDir, async () => {
    const { config } = await installedConfig(w, 'cron_test');
    return { body: await cronOf(rc, w, config), headers: NO_STORE };
  });
}

/** `POST finish` (see the top of this file). */
export async function finishStep(rc: Rc<unknown>): Promise<{ body: FinishResponse; headers: Record<string, string> }> {
  const w = wizardOf(rc);
  const { install } = w;
  const runtime = install.runtime;
  const { installId, marker } = await finishUnderLock(rc, w);
  rc.log.info('install: complete', { installId, runtime, marker });
  // L45: the wizard's handle goes, and this process boots from the installed config.json without a restart.
  await install.close();
  rc.services.installDone();
  clearInstallCookie(rc.c, { secure: install.cookieSecure() });
  return { body: { next: '/admin/login' }, headers: NO_STORE };
}

/** finish's work under install-run.lock: its install id. */
async function finishUnderLock(rc: Rc<unknown>, w: Wizard): Promise<{ installId: string; marker: boolean }> {
  const runtime = w.install.runtime;
  return underRunLock(w.dataDir, async () => {
    const { file, config } = await installedConfig(w, 'finish');
    const cron = await cronOf(rc, w, config);
    if (cron.required && !cron.detected) {
      throw new DomainError('CRON_NOT_DETECTED', {
        detail:
          'Penjadwal belum terdeteksi: pasang baris cron (atau URL /_cron) lalu uji lagi / ' +
          'No scheduler was detected: add the cron line (or the /_cron URL), then test again',
      });
    }
    await wizardDb(w, config);
    const installId = file.install.id;
    // D37: the route's one entry before anything marks the install complete (see the top of this file). A failure
    // here leaves installState `cron`: the step can run again.
    await rc.withTx((tx) => tx.audit({ action: 'install.complete', entity: 'install', entityId: installId, meta: { runtime } }), {
      actor: systemActor(rc),
    });
    await moveTo(rc, 'complete');
    await writeInstallLock(w.dataDir, installId, rc.now);
    // The marker (spec §7.7): only where the app folder is writable and the runtime is not docker/service; failing to
    // write it is no install error.
    let marker = false;
    try {
      marker = await writeInstalledMarker({ appRoot: w.appRoot, dataDir: w.dataDir, installId, runtime });
    } catch (error) {
      rc.log.warn('install: the installed marker could not be written', { code: (error as { code?: unknown } | null)?.code ?? null });
    }
    await removeFile(dataPath(w.dataDir, 'root', 'install-code.txt'));
    await removeFile(dataPath(w.dataDir, 'tmp', 'install-session.json'));
    if (w.session.wizard.probeId !== null) await removeInstallProbe(w.dataDir, w.session.wizard.probeId);
    return { installId, marker };
  }, w);
}
