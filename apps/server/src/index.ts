import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  activeOp,
  bundledAttempt,
  bundledCandidate,
  bundledUpdatePlan,
  clearBundledBlocked,
  createGrantsCache,
  createSettingsCache,
  enqueue,
  ensureSystemRoles,
  failedBefore,
  holdsMaintenance,
  opBootPlan,
  persistKeysetDocs,
  readMaintenance,
  readOpFile,
  recordBundledBlocked,
  releaseKeysetDocs,
  releaseSourceMode,
  runPrecheck,
  runnerMode,
  schemaHoldInstruction,
  snapshotBackupRunning,
  sweepStagingLocked,
  writeMaintenance,
  type BootHooks,
  type Candidate,
  type OpFile,
  type OpStatus,
  type PrecheckReport,
} from '@altis/core';
import { readReleaseKeyset, type KeysetDoc, type KeysetSource, type TrustedKey } from '@altis/crypto';
import { connect, releaseMigrations, runMigrations, withTx, type DbHandle } from '@altis/db';
import {
  dataPath,
  faultMatchesVersion,
  isEnvSet,
  killSelf,
  parseCurrentState,
  readJsonWithBak,
  readPreviousRelease,
  releaseDir,
  sqliteAllowed,
  type CurrentState,
  type Env,
  type Runtime,
} from '@altis/platform';
// 1d Task 32 (L8): SQLite refused under a PM2 cluster.
import { pm2ClusterSignals } from '@altis/platform';
import { DomainError, isDomainError, isTerminal } from '@altis/shared';
import { getRequestListener } from '@hono/node-server';
import { createApp, type AppState } from './app.js';
import { catalogBoot } from './catalog-boot.js';
import { loadConfig, type Config } from './config.js';
import { createConfigFence } from './http/config-fence.js';
import { HEALTH_PATH, updateHealth } from './http/health.js';
import { createOpsFence } from './http/ops-fence.js';
import { createReleaseFence, releaseRestart } from './http/release-fence.js';
import { announceInstallCode, createInstallService } from './install/gate.js';
import { createJobRuntime, jobHandlers, opKinds, testClockOffsetMs, updateRestoreRunner } from './jobs/runtime.js';
import { createLogger, type LogFields, type Logger } from './logger.js';
import { loadOpacFonts } from './opac/fonts.js';
import { embeddedRootKeys, installedKeysets, refusesDevKids } from './release-keys.js';
import { trackRetirement } from './retirements.js';
import { appUpdateKindDeps, createAppEdition, createAppOps, createAppUpdateSource, jobMailer, type AppUpdates } from './services.js';

// server.mjs, the bootloader contract v1 (spec §9.2): `bootProtocol`, `start(ctx)` and `runCli(argv, ctx)` (the CLI,
// cli/index.ts).
//
// start(ctx), as a state machine over AppState.phase (the app answers from it at every step):
//
//   starting ── ctx.serve() throws ──────────────────────────────────────► reject (its error)
//      │ serving: the app's request listener goes to ctx.serve(handler). app.js owns the one http.Server and
//      │ already listens (P2, ruling R64); start() never creates a server or calls listen(). P3: everything else
//      │ comes after.
//      ▼
//   attempt: loadConfig → P20 for ctx.runtime → (1c) the ops lock → connect → runMigrations → ensureSystemRoles
//            (its own withTx, D5) → internal GET /_health
//      ├─ no config.json, or installState ≠ complete ──────► not_installed   the install code on stdout (1c), resolve;
//      │                                                       a database of ALTIS_DB_* the install gate cannot
//      │                                                       read yet is DB_UNAVAILABLE (below): no code until then
//      ├─ the migration lock stayed held by another process
//      │  (migrate.lock, or MySQL/MariaDB GET_LOCK; R60) ───► starting        wait 1, 2, 4 … 30 s, attempt again
//      ├─ DB_UNAVAILABLE (connect, migrations, a lost
//      │  connection mid-migration, /_health not 200) ─────► db_unavailable  wait 1, 2, 4 … 30 s, attempt again
//      ├─ 1c Task 15 (preflight B4, decision C40): an
//      │  exclusive op holds the ops lock (op.json has an op
//      │  that has not ended, or cannot be read), looked at
//      │  before any connection ──────────────────────────────► ops_wait        no connection, migration, system
//      │                                                       roles, health check or markHealthy; the ops routes
//      │                                                       (by `altis_ops`), /_cron, /_health (503 maintenance)
//      │                                                       are served (app.ts); in worker mode the op is stepped
//      │                                                       every 2 s here. Once the ops fence sees the op end (a
//      │                                                       request's look, or that loop's), attempt again
//      ├─ migrations report too-old ───────────────────────► too_old         resolve (database closed)
//      ├─ any other error (INVALID_CONFIG, SCHEMA_CONFLICT,
//      │  SQLITE_NOT_ALLOWED for the runtime this process
//      │  runs under (R66) or under PM2's cluster signals
//      │  (1d Task 32, L8), a migration's own error,
//      │  STATE_CORRUPT other than the lock wait, …) ───────► explicit boot failure (ruling R52): log it (safe
//      │                                                       fields), close the database, reject (original
//      │                                                       error). No server is closed: app.js decides what
//      │                                                       serves next (the previous release or its rescue page).
//      └─ done ────────────────────────────────────────────► ready → ctx.markHealthy() once → (1c) one step of an
//                                                              op that is active now (§9.4 "atau boot") → resolve
//
// - The config fence (§9.3, decision D34): after the first loadConfig that finds a config, start() puts it in
//   `state.config` and creates the fence (`state.fence`), which the app checks on every request. A config.json
//   changed by another process is then served within 2 s; a changed `port` calls ctx.requestRestart('config:port').
// - From then on the fence is the single writer of `state.config`: a retry takes its config through the fence (a
//   check, then current()) instead of loading the file itself, so a corrected config is still picked up without a
//   restart (at most 2 s late), and a load that started earlier can never put an older config back over a newer one.
//   The one other writer is the app's config writer (`PUT system/config`, the cron-token rotation, D42), which applies
//   what this process wrote itself and resets the fence to it (a look begun before that is discarded).
// - Ruling R66: a headless install decided P20 and P15 for the runtime it was told or detected (config.json
//   install.runtime), which a shell can get wrong. SQLite is checked again for the runtime this process actually runs
//   under, before connecting; a runtime other than the install's is logged once as a warning (the proxy hops were
//   chosen for that one).
// - A database outage never ends the process (Review Focus 1): start() stays pending while the app answers 503.
// - Once the handler is no longer served (app.js put another one in its place, or its server closed: the promise
//   ctx.serve returned resolves), the loop stops at once (its timer is cleared and unref'd), the job runtime drains
//   (1c Task 13, P14: no new claim, running slices waited for, job sessions and op connections closed), the database
//   is closed, and a pending start() settles (resolved: nothing failed).
// - 1c Task 13: the app's OpsMachine is made here with the app (S11), so the wizard can step `install-migrate` before
//   the install completes; the job runtime (jobs/runtime.ts) is made once `ready` and runs its worker loop in worker
//   mode. The test hook ALTIS_TEST_CLOCK_OFFSET_MS (test profile only, M23) moves the app's clock.
// - 1c Task 15: the ops fence (http/ops-fence.ts; ops/maintenance.json, ops/data-epoch, the active op), checked by
//   every request and by the worker loop. A data epoch that moves (a restore finished, in this process or another)
//   drops the settings and grants caches and calls ctx.requestRestart('data-epoch') (S23, P14: every serving process
//   restarts after a restore).
// - 1c Task 25 (decision C17): on SQLite a restore loads a work file and swaps it into place once every process let go
//   of `db/altis.sqlite`. This process lets go (the ops machine's op connections, then `state.db`, whose close removes
//   `tmp/sqlite-owner.json`) when its ops fence sees `maintenance.json.sqliteRelease`, or when it steps the swap itself
//   (the restore kind's own hooks); it opens `state.db` again after the swap it stepped, or when the fence sees the data
//   epoch move or the op end, just before the restart that the moved epoch asks for.
// - 1c Task 27 (L45, S12): start() resolves in `not_installed`, but the process keeps listening for the install: the
//   wizard's `finish` in this process (services.installDone()), the config fence's onChange (an installState written by
//   any process), and, for a process that started before config.json existed and so has no fence, app.ts's look at
//   install.lock and config.json (at most every 2 s, on requests only) each start a new boot attempt (bootAgain). Such
//   an attempt reads config.json from the file, prints no install code, and boots to `ready` once the install is
//   complete, without a restart; one loop runs at a time. An explicit failure of it is logged and a restart requested.
// - Logging: ctx.log until config.json has been read (no level, no server log yet); then the server log
//   (createLogger: DATA_DIR/logs/altis.log, config's level, and stdout as well on docker/pm2 or with
//   ALTIS_LOG_STDOUT=1, ruling R59).
// - 1d Task 25 (spec §9.3, §9.6 step 6, §9.7; decisions D1d-14, D1d-17, D1d-20, D1d-42; preflight B8, S1, S2, 1D-02,
//   1D-05, 1D-06, 1D-21): after the config and before any connection (C40), the op op.json holds decides the boot
//   (`opBootPlan(op, version, ctx.pendingBoot)`):
//     normal       the boot above (no op, an op that ended, or one that holds no maintenance: an update downloading);
//     ops_wait     as 1c (an op that holds maintenance, judged by `stateBefore` for `needs_attention`);
//     refuse       start() rejects at once with UPDATE_BOOT_FAILED (`reason` the op's error detail, else `start`),
//                  having opened nothing, so that app.js reverts the pending release in this same process: the target of
//                  an update that is reverting or restoring (B8), a pending boot whose op needs attention, and every
//                  plan but `update_boot` while `ctx.pendingBoot` (1D-02);
//     update_boot  phase `updating`; the database opened without runMigrations; the update op stepped (20 s steps) with
//                  the boot hooks (ctx.bootMarker, updateHealth: the database answers and nothing is pending, whatever
//                  the phase, 1D-05; ctx.markHealthy) while it is in `switched`..`verifying`, backing off 1 s rising to
//                  5 s while a step changes nothing, and 1, 2, 4 … 30 s while the database is unavailable
//                  (`marker.waiting('db_unavailable')`). `done` → the normal boot (migrations up to date, the job
//                  runtime, `ready`), the release fence rebased after the promotion. `reverting`, `restoring`,
//                  `needs_attention` or any other end (or an error opening the database other than DB_UNAVAILABLE:
//                  reason `start`) → everything this start() opened is closed first (the database,
//                  the ops machine's connections, the SQLite handle, the job runtime, the fences, the timers; 1D-06),
//                  then start() rejects with UPDATE_BOOT_FAILED: app.js reverts in this process, where the release left
//                  behind then steps the revert (a SQLite restore renames the live file: no handle may be left). Except
//                  a target booted as `active` (promoted already, not pending) whose op needs attention: it waits in
//                  `updating` for a resume, maintenance kept (a rejection would fall back to `previous`, which never
//                  ends a promoted op); and one whose op another process ended (another op, or none, found at its
//                  step), which plans again (review L06);
//     revert       phase `updating` (the "terlalu lama" mode of §9.7 included); the database opened without migrations;
//                  the op stepped until it ends, with the same back-off: `rolled_back` → the normal boot; `restored` →
//                  the restart the op asked for (the phase stays); `restore_failed` → the phase stays (maintenance kept,
//                  /admin/_update shows the CLI steps); `needs_attention` (a revert step threw) → no more steps until the
//                  op moves again (an operator's resume), the phase and maintenance kept (R1c-12, S2).
//   Both plans hand over to the normal boot (`done`, `rolled_back`, an end another process recorded) only after the ops
//   fence looked again (bootAgainAfterOp): its last look was the plan's own, the op's flag still up, and a request looks
//   again only 2 s later, so `ready` would answer 503 MAINTENANCE meanwhile (A7: the admin SPA then follows the
//   flag's reason to /admin/_update instead of serving the old release out of maintenance, §9.7).
//   Review C17: a later start() whose plan is `normal` but whose op ended in a state that keeps maintenance (an
//   update's `restore_failed`), its flag still up, does as that process did: phase `updating`, no runMigrations (whose
//   `too_old` would hide /admin/_update and its CLI steps behind 503 SCHEMA_TOO_NEW).
//   The faults of a test build: `health:<version>` fails the target's health check; `boot-crash:<version>` kills the
//   process right after `ctx.bootMarker.phase('listening')` of a pending boot.
// - 1d Task 25 (decision D1d-20, preflight 1D-21): the release fence (http/release-fence.ts) is rebased when start()
//   begins, again after the process's own promotion (and its own revert), and checked by requests and the worker loop
//   once `ready`. Another release named in current.json → the job runtime stops claiming and drains, then
//   ctx.requestRestart('release'), unless tmp/restart.txt was touched since `pendingSince`.
// - 1d Task 27 (spec §9.3, §9.8; decisions D1d-16, D1d-23, D1d-24; preflight B7, S9, S12, 1D-04, 1D-20; ruling R65a):
//     after `ready`, every start: the keyset documents of the installed releases (and of this one) go to
//                  DATA_DIR/releases/keyset.json; the staging folders of no live op are swept (under ops/step.lock);
//                  the `release.retention` job is enqueued, and `release.adopt` for a `bundled` active release in data
//                  mode; a newer `ctx.bundledRelease` (§9.8 row 1) that is not pinned, did not fail before and finds no
//                  op running gets the prechecks of §9.6 step 2 on its verified manifest, then an update op (source
//                  `bundled`) begun at `verified`, or (row 2) `update.bundled_blocked` and one `update_blocked`
//                  notification per version. Each part is logged on failure and never fails the boot.
//     an update of this release's own (source `self`) that has not ended is stepped here, in phase `updating`, with the
//                  boot hooks, whatever the boot mode (a schemaHold process that died; the release booted as `active`
//                  after its point of no return named it). `done` → the restart the op asked for (the phase stays);
//                  any other end, or a failure to step it, → maintenance kept with a manual `update` flag (the op's
//                  error detail and the log carry the instruction), the phase stays: never runMigrations.
//     schemaHold   (`ctx.bootMode`, §9.8 row 3, when the plan is `normal`): phase `updating`, the database opened without
//                  migrating. A version that failed before (a `releases_log` row aborted, rolled_back, restored or
//                  restore_failed, or an op.json update of it that ended otherwise than `done`) begins nothing again:
//                  maintenance kept, the instruction naming that failure's `pre_update` backup (1D-04). current.json
//                  naming this release active already (another process's update of it ended `done` after app.js
//                  classified this one) → the normal boot. Otherwise the prechecks against the database (`active` =
//                  current.json's): failed → `update.bundled_blocked` and maintenance kept; passed → an update op
//                  (source `self`, from current.json's `active`) begun at `verified` and stepped as above. An op
//                  another process began meanwhile is followed, or waited for.

export const bootProtocol = 1;

export { runCli } from './cli/index.js';
export type { CliIo } from './cli/index.js';

export type BootPhase = 'importing' | 'listening' | 'migrating';

/** 1d Task 16: what a boot waits for that is no fault of the release (spec §9.3 "Bukan alasan revert"). */
export type BootWaitReason = 'db_unavailable' | 'migration_lock';

/** A Node request listener, what ctx.serve takes (packages/bootloader mirrors this type). */
export type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void;

/**
 * What the bootloader (app.js, Task 16) hands to start() and runCli() (spec §9.2). packages/bootloader/src/boot.ts
 * mirrors this interface exactly.
 */
export interface BootContext {
  bootProtocol: 1;
  appRoot: string;
  dataDir: string;
  release: { version: string; dir: string; source: 'bundled' | 'data' };
  runtime: Runtime;
  /** The port app.js listens on (informational: app.js owns the server; under Passenger it is not used). */
  port: number;
  /**
   * The release booted healthy (§9.3). Called once, after the migrations, when /_health answers 200. For a release
   * booted as `pending` (`pendingBoot`) app.js promotes it, removes its boot markers and lets boot.lock go; it rejects
   * when the release is no longer pending (reverted) or boot.lock was taken over. Otherwise it changes nothing.
   */
  markHealthy(): Promise<void>;
  requestRestart(reason: string): Promise<void>;
  /**
   * The boot marker (§9.3), written by app.js only while a `pending` release boots (a no-op otherwise). `phase()` and
   * `progress()` are progress; `waiting(reason)` (1d Task 16, additive in v1: call it as `waiting?.()`) marks a wait for
   * the environment, never counted as a failed boot, until the next phase() or progress().
   */
  bootMarker: { phase(p: BootPhase): void; progress(): void; waiting?(reason: BootWaitReason): void };
  log: Logger;
  /**
   * Makes `handler` answer every request of app.js's one http.Server (P2, ruling R64), in place of the one before.
   * The returned promise resolves once `handler` is no longer served (another handler took its place, or the
   * server closed). Throws for a command (CLI): it has no server.
   */
  serve(handler: RequestHandler): Promise<void>;
  /**
   * 1c Task 23 (decision C29; additive in contract v1, as R64's `serve`): the version of the running app.js (its
   * bundled version), which Diagnostik shows. An app.js that predates it passes none; the report then shows null.
   */
  appJsVersion?: string;
  /**
   * 1d Task 16 (additive in v1, spec §9.8): the release bundled beside app.js and how it compares with this release,
   * when there is one and this release boots as `active` (or its fallback). Absent otherwise.
   */
  bundledRelease?: { version: string; dir: string; relation: 'newer' | 'same' | 'older' };
  /**
   * 1d Task 16 (additive in v1, spec §9.8 row 3): `schemaHold` when the bundled release boots because it is newer and
   * the `active` folder is missing (Task 27 runs its own update op). Absent means `normal`.
   */
  bootMode?: 'normal' | 'schemaHold';
  /** 1d Task 16 (additive in v1, spec §9.3): true when this release boots as `pending`, holding boot.lock. */
  pendingBoot?: boolean;
}

/** 1c Task 15: the budget of one op step by the boot, or while a process waits for an op (P9). */
const OPS_STEP_BUDGET_MS = 20_000;
/** 1c Task 15: in worker mode, how often a process waiting for an op steps it (and looks whether it ended). */
const OPS_WAIT_STEP_MS = 2000;

/** 1d Task 25: the states of an update op the target's `update_boot` steps through. */
const UPDATE_BOOT_STATES: ReadonlySet<string> = new Set(['switched', 'booting', 'migrating', 'verifying']);
/** 1d Task 25: the states of an update op the release it left steps (`revert` plan, §9.7). */
const REVERT_STATES: ReadonlySet<string> = new Set(['reverting', 'restoring']);
/** 1d Task 27: the states of a `self` update op (§9.8 row 3) that this release steps itself, from its entry state on. */
const SELF_STATES: ReadonlySet<string> = new Set(['verified', 'frozen', 'backed_up', 'staged', 'switched', 'booting', 'migrating', 'verifying']);
/** 1d Task 27: the actor of the update ops a start begins (§9.8 rows 1 and 3). */
const SYSTEM_ACTOR = { type: 'system', id: null } as const;
/** 1d Task 25: the reasons an UPDATE_BOOT_FAILED of start() names (errors.ts); any other detail is `start`. */
const BOOT_FAILURE_REASONS: ReadonlySet<string> = new Set(['verify', 'import', 'start', 'migration', 'health', 'stalled', 'repeated', 'operator']);

/** 1d Task 25 (1D-02, D1d-42 7): the pause after the `n`-th step in a row that changed nothing: 1, 2, 4, 5, 5 … s. */
export function unchangedStepDelayMs(n: number): number {
  return Math.min(1000 * 2 ** Math.max(0, n - 1), 5000);
}

/** 1d Task 25: the reason start() names for the update op's error (its registered detail, else `start`). */
function bootFailureReason(error: OpFile['error'] | undefined): string {
  const detail = error?.detail;
  return typeof detail === 'string' && BOOT_FAILURE_REASONS.has(detail) ? detail : 'start';
}

const RETRY_FIRST_MS = 1000;
const RETRY_MAX_MS = 30_000;

/** The pause before attempt `failures + 1` after `failures` database failures in a row: 1, 2, 4 … s, at most 30 s. */
export function retryDelayMs(failures: number): number {
  return Math.min(RETRY_FIRST_MS * 2 ** Math.min(failures, 15), RETRY_MAX_MS);
}

/**
 * P20 for the runtime this process runs under (ruling R66): SQLite on Passenger or LiteSpeed (several worker
 * processes on one file) is an explicit boot failure, whatever runtime the install was decided for.
 */
function sqliteNotAllowed(runtime: Runtime, installRuntime: Runtime | undefined): DomainError {
  const installedId = installRuntime === undefined ? '' : `, dipasang untuk runtime ${installRuntime}`;
  const installedEn = installRuntime === undefined ? '' : `, installed for runtime ${installRuntime}`;
  return new DomainError('SQLITE_NOT_ALLOWED', {
    detail:
      `SQLite tidak dapat dipakai pada runtime ${runtime} (beberapa proses pekerja${installedId}); pindahkan database ke MySQL/MariaDB atau PostgreSQL / ` +
      `SQLite cannot be used on runtime ${runtime} (several worker processes${installedEn}); move the database to MySQL/MariaDB or PostgreSQL`,
    meta: { runtime, installRuntime: installRuntime ?? null },
  });
}

/**
 * 1d Task 32 (L8, decision D1d-36): P20 also needs PM2 to run one process. Under runtime pm2, SQLite with any of
 * PM2's cluster signals in this process's environment (cluster mode, more than one instance, an instance index other
 * than 0) is an explicit boot failure naming them (`meta.signals`); null when the boot may go on.
 */
function sqlitePm2Cluster(dialect: string, runtime: Runtime, installRuntime: Runtime | undefined, env: Env): DomainError | null {
  if (dialect !== 'sqlite' || runtime !== 'pm2') return null;
  const signals = pm2ClusterSignals(env);
  if (signals.length === 0) return null;
  const named = signals.join(', ');
  return new DomainError('SQLITE_NOT_ALLOWED', {
    detail:
      `SQLite tidak dapat dipakai di PM2 mode cluster atau dengan lebih dari 1 instance (${named}); jalankan PM2 dalam mode fork dengan instances: 1, ` +
      `atau pindahkan database ke MySQL/MariaDB atau PostgreSQL / ` +
      `SQLite cannot be used under PM2 cluster mode or with more than 1 instance (${named}); run PM2 in fork mode with instances: 1, ` +
      `or move the database to MySQL/MariaDB or PostgreSQL`,
    meta: { runtime, installRuntime: installRuntime ?? null, signals },
  });
}

/** Ruling R59: Docker and PM2 collect stdout; elsewhere only on request (`ALTIS_LOG_STDOUT=1`). */
export function logsToStdout(runtime: Runtime, env: Env): boolean {
  if (runtime === 'docker' || runtime === 'pm2') return true;
  return isEnvSet(env, 'ALTIS_LOG_STDOUT') && env['ALTIS_LOG_STDOUT']!.trim() === '1';
}

let stdoutGuarded = false;

/**
 * A stdout whose reader went away (EPIPE, a closed pipe) emits 'error', which without a listener is an uncaught
 * exception. One listener per process swallows it; the logger reports the failed write once on stderr.
 */
function guardStdout(): void {
  if (stdoutGuarded) return;
  stdoutGuarded = true;
  process.stdout.on('error', () => {});
}

function openServerLog(ctx: BootContext, config: Config, env: Env): Logger {
  const stdout = logsToStdout(ctx.runtime, env);
  if (stdout) guardStdout();
  return createLogger({ dataDir: ctx.dataDir, level: config.log.level, stdout });
}

/** A Logger that passes every call on to `target()` as it is at that moment (children included). */
function forwardingLogger(target: () => Logger, fields?: LogFields): Logger {
  const to = (): Logger => (fields === undefined ? target() : target().child(fields));
  return {
    debug: (msg, more) => to().debug(msg, more),
    info: (msg, more) => to().info(msg, more),
    warn: (msg, more) => to().warn(msg, more),
    error: (msg, more) => to().error(msg, more),
    child: (more) => forwardingLogger(target, { ...fields, ...more }),
  };
}

/**
 * Test hook, compiled out of production builds (dead branch once `__BUILD_PROFILE__` is 'production'):
 * ALTIS_TEST_MIGRATE_LOCK_WAIT_MS=<ms> is how long a migration run waits for the migration lock before giving up
 * (the runner's `lockWaitMs`; default 10 min), so tests can see the wait run out.
 */
function testMigrationLockWaitMs(env: Env): number | undefined {
  if (typeof __BUILD_PROFILE__ !== 'undefined' && __BUILD_PROFILE__ !== 'production') {
    const value = Number(env['ALTIS_TEST_MIGRATE_LOCK_WAIT_MS']);
    if (Number.isInteger(value) && value >= 0) return value;
  }
  return undefined;
}

/**
 * Which migration lock another process kept for the whole wait (ruling R60: waiting for it is not a boot failure,
 * spec §9.3): `migrate.lock` (DATA_DIR/tmp/migrate.lock, STATE_CORRUPT `lock_timeout`; the only file lock start()
 * takes) or `database` (MySQL/MariaDB GET_LOCK, DB_UNAVAILABLE `busy` `MIGRATION_LOCK`); undefined for anything
 * else. A lock file the file system refuses (`lock_io`) is not a wait: that stays a boot failure.
 */
function migrationLockWait(error: unknown): 'migrate.lock' | 'database' | undefined {
  if (!isDomainError(error)) return undefined;
  if (error.code === 'STATE_CORRUPT' && error.meta?.['reason'] === 'lock_timeout') return 'migrate.lock';
  if (error.code === 'DB_UNAVAILABLE' && error.meta?.['reason'] === 'busy' && error.meta['code'] === 'MIGRATION_LOCK') return 'database';
  return undefined;
}

function isDbUnavailable(error: unknown): error is DomainError {
  return isDomainError(error) && error.code === 'DB_UNAVAILABLE';
}

function stringMeta(error: DomainError, key: string): string | undefined {
  const value = error.meta?.[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * What the log says about a failed boot: the code, status and reason; the detail of a DomainError (written to be
 * shown to an operator; config errors name field paths, never values) and the message of a MigrationError (made
 * safe by the runner); of any other error only its name and code, as its message may carry driver text. The class is
 * `errorName`, as in core's `errorFields`: the server log redacts every field called `name` (a person's name is
 * personal data).
 */
function bootErrorFields(error: unknown): LogFields {
  if (isDomainError(error)) {
    return {
      code: error.code,
      status: error.status,
      detail: error.detail,
      reason: stringMeta(error, 'reason'),
      migration: stringMeta(error, 'migration'),
    };
  }
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return {
      errorName: error.name,
      code: typeof code === 'string' ? code : undefined,
      message: error.name === 'MigrationError' ? error.message : undefined,
    };
  }
  return { errorName: typeof error };
}

/**
 * The directory of the release before this one (current.json's `previous`), where the admin finds the assets of a
 * tab loaded before an update (spec §4.8). Asked on an asset miss only, and read each time (read-only, no lock): an
 * update moves `previous`. A current.json that cannot be read costs the fallback only: logged, answered null.
 */
export function previousReleaseDir(ctx: Pick<BootContext, 'appRoot' | 'dataDir'>, log: Logger): () => Promise<string | null> {
  return async () => {
    try {
      const ref = await readPreviousRelease(ctx.dataDir);
      return ref === null ? null : releaseDir(ctx.appRoot, ctx.dataDir, ref);
    } catch (error) {
      log.warn('previous release not readable; no admin asset fallback', { error: bootErrorFields(error) });
      return null;
    }
  };
}

/**
 * Starts the server (bootloader contract v1, §9.2): hands the app's request listener to `ctx.serve` (app.js already
 * listens), then reads the config, opens the database and migrates it, retrying while the database is unavailable
 * (see the state machine at the top of this file).
 *
 * Resolves once the boot has settled: `ready` (after `ctx.markHealthy()`), `not_installed`, `too_old`, or the
 * handler is no longer served. While the database is unavailable, or another process holds the migration lock, it
 * stays pending, the app answering 503.
 *
 * @throws the error of `ctx.serve`, as it is; any error of the boot other than DB_UNAVAILABLE and the
 *   migration-lock wait, as it is, after logging it (no server is closed: app.js decides what serves next)
 */
export async function start(ctx: BootContext): Promise<void> {
  const env = process.env;
  const state: AppState = { phase: 'starting' };
  let serverLog: Logger | undefined;
  const log = forwardingLogger(() => serverLog ?? ctx.log);
  // BootContext v1 carries no build id (the manifest's buildId stays with the bootloader); every release has its own
  // version, which therefore identifies the build for X-Altis-Build.
  const release = { dir: ctx.release.dir, previousDir: previousReleaseDir(ctx, log) };
  const where = { release, env, dataDir: ctx.dataDir, appRoot: ctx.appRoot, runtime: ctx.runtime, log };
  // The OPAC's font files, read once from this release (opac/fonts.ts); without them the pages use the system font.
  await loadOpacFonts(ctx.release.dir, log);
  // The app's clock (services.clock): the install code start() announces is dated by it, as the wizard's routes are.
  // 1c Task 13 (M23): plus ALTIS_TEST_CLOCK_OFFSET_MS in the test profile.
  const clockOffset = testClockOffsetMs(env);
  const clock = (): number => Date.now() + clockOffset;
  // The app's install service, made here so that start() can ask its gate too (1c Task 10).
  const install = createInstallService(state, where);
  // 1c Task 25 (decision C17): this process's own handles on a SQLite file, which a restore's swap asks every process
  // to let go of (sqliteOwn below), for the restore kind (its closeOwn/reopenOwn) and the ops fence.
  const sqliteOwn = { close: () => releaseSqlite(), reopen: () => reopenSqlite() };
  // 1d Task 25: whether this process still boots a pending release (cleared once its update op is `done`: the target
  // was promoted), the boot hooks of the `update_boot` plan (null otherwise), and whether the op's verifying step had
  // ctx.markHealthy() promote it already.
  let pendingBoot = ctx.pendingBoot === true;
  let bootHooks: BootHooks | null = null;
  let healthyMarked = false;
  // 1d Task 24 (preflight S6): what the update kind needs from this process: the edition and the feed client made
  // below (read at step time), the restore runner with the SQLite swap, the restart of app.js. Task 25: the boot hooks
  // in the `update_boot` plan.
  const updateDeps = appUpdateKindDeps(state, {
    dataDir: ctx.dataDir,
    appRoot: ctx.appRoot,
    releaseDir: ctx.release.dir,
    version: ctx.release.version,
    env,
    clock,
    log,
    installDb: () => install.db(),
    edition: () => edition,
    source: () => updates.source,
    restore: updateRestoreRunner({ appVersion: ctx.release.version, config: () => state.config, dataDir: ctx.dataDir, sqlite: { log, own: sqliteOwn } }),
    requestRestart: (reason) => ctx.requestRestart(reason),
    boot: () => bootHooks, // 1d Task 25
  });
  // 1c Task 13 (S11): the app's ops machine, made with the app; the job runtime gets it too. 1c Task 25: its restore
  // kind swaps a SQLite work file into place. 1d Task 24: its update kind.
  const ops = createAppOps(state, {
    dataDir: ctx.dataDir,
    version: ctx.release.version,
    log,
    clock,
    runtime: ctx.runtime,
    installDb: () => install.db(),
    kinds: opKinds({
      appVersion: ctx.release.version,
      config: () => state.config,
      dataDir: ctx.dataDir,
      sqlite: { log, own: sqliteOwn },
      update: updateDeps,
    }),
  });
  // 1c Task 15: the caches a restore makes stale (dropped when the data epoch moves), shared with the app, and the ops
  // fence. `opWake` wakes start() while it waits for an op (the fence saw it end, or the handler was retired).
  const settings = createSettingsCache({ clock });
  const grants = createGrantsCache();
  let opWake: (() => void) | undefined;
  const opsFence = createOpsFence({
    dataDir: ctx.dataDir,
    clock,
    log,
    onEpoch: (next, prev) => dataEpochChanged(next, prev),
    onOpEnded: () => opWake?.(),
    sqlite: { release: () => sqliteOwn.close(), reopen: () => sqliteOwn.reopen() }, // 1c Task 25
  });
  // The edition of this process (ruling R1), shared with the app; its cached check (none in the community edition) is
  // dropped when config.json or the data epoch changes.
  const edition = createAppEdition(state, { clock, log, installDb: () => install.db() });
  // 1d Task 25 (D1d-20, 1D-21): the release fence. A change stops the job runtime's claims and drains it, then asks for a
  // restart unless tmp/restart.txt was touched since the update began.
  const onReleaseChange = releaseRestart({
    appRoot: ctx.appRoot,
    runtime: ctx.runtime,
    requestRestart: (reason) => ctx.requestRestart(reason),
    stopClaims: async () => {
      await state.jobs?.stop();
    },
    log,
  });
  const releaseFence = createReleaseFence({
    dataDir: ctx.dataDir,
    clock,
    log,
    onChange: (change) => {
      void onReleaseChange(change);
    },
  });
  // 1d Task 24: the feed client of this process, shared by the app's routes and the update kind.
  const updates: AppUpdates = {
    source: createAppUpdateSource(state, {
      dataDir: ctx.dataDir,
      appRoot: ctx.appRoot,
      releaseDir: ctx.release.dir,
      env,
      clock,
      log,
      installDb: () => install.db(),
      edition: () => edition,
    }),
  };
  const app = createApp({
    ...where,
    state,
    version: ctx.release.version,
    buildId: ctx.release.version,
    clock,
    // 1c Task 27 (L45): installDone starts a new boot attempt while not installed.
    services: { install, ops, opsFence, settings, grants, edition, updates, installDone: () => bootAgain() },
    ...(ctx.appJsVersion === undefined ? {} : { appJsVersion: ctx.appJsVersion }), // 1c Task 23
  });

  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  let wake: (() => void) | undefined;
  let runtimeNoted = false;
  /** 1c Task 27 (L45): the boot loop running now (the first one, or one bootAgain started), and whether to run again. */
  let booting: Promise<void> | undefined;
  let bootPending = false;

  const retired = ctx.serve(getRequestListener(app.fetch));
  ctx.bootMarker.phase('listening');
  // 1d Task 25 (test builds only, D1d-25): `boot-crash:<version>` kills a pending boot of that release right here.
  if (pendingBoot && faultMatchesVersion(env, 'boot-crash', ctx.release.version)) killSelf();
  log.info('serving', { port: ctx.port, runtime: ctx.runtime, version: ctx.release.version });

  async function releaseDb(): Promise<void> {
    const db = state.db;
    state.db = undefined;
    if (db === undefined) return;
    try {
      await db.close();
    } catch (error) {
      log.warn('closing the database failed', { error: bootErrorFields(error) });
    }
  }

  /** The server handle of `config` (purpose `server`; L19: idle connection errors go to the server log). */
  function openDb(config: Config): Promise<DbHandle> {
    return connect(config.db, {
      runtime: ctx.runtime,
      purpose: 'server',
      dataDir: ctx.dataDir,
      onIdleError: (error) => log.warn('database idle connection error', { error: bootErrorFields(error) }),
    });
  }

  // 1c Task 25 (decision C17; S19, S23, P20): a restore swaps a SQLite work file into the place of db/altis.sqlite once
  // every process let go of it. releaseSqlite closes what this process holds on it (the op connections of its ops
  // machine, then `state.db`, whose close removes tmp/sqlite-owner.json); reopenSqlite opens `state.db` again, only
  // when releaseSqlite closed it. Both are idempotent and run one at a time: the ops fence calls them (while the flag
  // asks; once the data epoch moved or the op ended), and so does the restore kind when this process steps the swap.
  // A handle released in `ready` leaves the phase as it is: the restore holds the installation in maintenance (routes
  // that need the database answer DB_UNAVAILABLE), and the restart the data epoch asks for follows the reopen.
  let sqliteReleased = false;
  let sqliteTurn: Promise<void> = Promise.resolve();

  function sqliteSerial(fn: () => Promise<void>): Promise<void> {
    const run = sqliteTurn.then(fn);
    sqliteTurn = run.catch(() => {});
    return run;
  }

  function releaseSqlite(): Promise<void> {
    return sqliteSerial(async () => {
      if (state.config?.db.dialect !== 'sqlite') return;
      await ops.close();
      if (state.db === undefined) return;
      sqliteReleased = true;
      await releaseDb();
      log.warn('sqlite: the database file was let go for a restore');
    });
  }

  function reopenSqlite(): Promise<void> {
    return sqliteSerial(async () => {
      const config = state.config;
      if (!sqliteReleased || closed || config === undefined) return;
      const h = await openDb(config);
      if (closed || state.db !== undefined) {
        await h.close();
      } else {
        state.db = h;
        log.info('sqlite: the database file was opened again after the restore');
      }
      sqliteReleased = false;
    });
  }

  /**
   * 1c Task 13: the drain of the job runtime (or, without one, the op connections), then the database. `retired` goes
   * up first, so a request still on its way to this handler starts no work (`POST /_cron` answers 202 and never
   * steps the op on the machine being closed); `state.jobs` stays, a stopped runtime running nothing.
   */
  async function retire(): Promise<void> {
    state.retired = true;
    const jobs = state.jobs;
    try {
      if (jobs === undefined) await ops.close();
      else await jobs.stop();
    } catch (error) {
      log.warn('stopping the job runtime failed', { error: bootErrorFields(error) });
    }
    // 1c Task 27: the wizard's own handle of a process retired before the install completed.
    await install.close().catch((error: unknown) => log.warn('closing the wizard database failed', { error: bootErrorFields(error) }));
    await releaseDb();
  }

  void retired.then(() => {
    closed = true;
    clearTimeout(timer);
    wake?.();
    opWake?.();
    trackRetirement(retire());
  });

  function pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      wake = resolve;
      timer = setTimeout(resolve, ms);
      timer.unref();
    });
  }

  /**
   * The fence saw a changed config.json (D34): the app serves from it at once, and a changed `port` asks the
   * bootloader for a restart (app.js owns the listening socket).
   */
  function configChanged(next: Config, prev: Config): void {
    state.config = next;
    state.baseUrl = next.baseUrl;
    edition.invalidate();
    // 1c Task 27 (L45): an install step written by any process (installState moved on, the install completed).
    if (state.phase === 'not_installed') bootAgain();
    if (next.port === prev.port) return;
    log.warn('config.json port changed, restart requested', { from: prev.port ?? null, to: next.port ?? null });
    requestRestart('config:port');
  }

  /** Asks the bootloader for a restart; a failure is logged, never thrown. */
  function requestRestart(reason: string): void {
    try {
      ctx.requestRestart(reason).catch((error: unknown) => {
        log.error('requestRestart failed', { error: bootErrorFields(error) });
      });
    } catch (error) {
      log.error('requestRestart failed', { error: bootErrorFields(error) });
    }
  }

  /**
   * 1c Task 15 (S23, P14): the ops fence saw the data epoch move (a restore finished): what this process cached of the
   * old data goes, and the bootloader restarts it (sessions, caches and connections all start again).
   */
  function dataEpochChanged(next: number, prev: number): void {
    settings.invalidate();
    grants.clear();
    edition.invalidate();
    log.warn('the data epoch changed (a restore), restart requested', { from: prev, to: next });
    requestRestart('data-epoch');
  }

  /**
   * 1c Task 15 (B4, C40), 1d Task 25: the ops fence looks now (so that it fires onOpEnded when the op ends), and says
   * whether the op still holds the ops lock: an op that ended between the plan's look and this one does not.
   */
  async function opHoldsLock(): Promise<boolean> {
    await opsFence.refresh();
    return opsFence.active();
  }

  /**
   * Review C17: whether `op` ended in a state that keeps its maintenance flag (KEEPS_MAINTENANCE: an update's
   * `restore_failed`) and that flag, looked at now, is still its own.
   */
  async function heldByEndedOp(op: OpFile | 'corrupt' | null): Promise<boolean> {
    if (op === null || op === 'corrupt' || !isTerminal(op.kind, op.state) || !holdsMaintenance(op.kind, op.state)) return false;
    await opsFence.refresh();
    return opsFence.maintenance()?.opId === op.opId;
  }

  /**
   * 1d Task 25 (1D-06): closes everything this start() opened, before it rejects so that app.js reverts in this same
   * process (where the release left behind may rename the SQLite file): requests stop starting work (`retired`), the
   * boot loop and its timers stop, the job runtime drains, the ops machine's connections, the wizard's handle and the
   * server handle (the SQLite file's own) close, the boot hooks and the release fence go. Idempotent, never throws; the
   * retirement after app.js swaps the handler runs the same closes again, as no-ops.
   */
  async function closeOwn(): Promise<void> {
    state.retired = true;
    closed = true;
    clearTimeout(timer);
    wake?.();
    opWake?.();
    bootHooks = null;
    delete state.releaseFence;
    try {
      if (state.jobs !== undefined) await state.jobs.stop();
      await ops.close();
    } catch (error) {
      log.warn('stopping the job runtime failed', { error: bootErrorFields(error) });
    }
    await install.close().catch((error: unknown) => log.warn('closing the wizard database failed', { error: bootErrorFields(error) }));
    await releaseDb();
  }

  /**
   * 1d Task 25 (B8, 1D-02): the `refuse` plan, or a failed `update_boot`: everything closed, then UPDATE_BOOT_FAILED,
   * whose rejection app.js answers by reverting the pending release in this process.
   */
  async function bootRefused(op: OpFile | 'corrupt' | OpStatus | null, why: string): Promise<DomainError> {
    const error = op === null || op === 'corrupt' ? null : op.error;
    const reason = bootFailureReason(error);
    log.error(why, {
      opId: op === null || op === 'corrupt' ? null : op.opId,
      state: op === null ? null : op === 'corrupt' ? 'corrupt' : op.state,
      reason,
      version: ctx.release.version,
    });
    await closeOwn();
    return new DomainError('UPDATE_BOOT_FAILED', { meta: { reason } });
  }

  /**
   * 1d Task 25: the server handle of `config`, waiting 1, 2, 4 … 30 s while the database is unavailable (a pending
   * boot's marker says `waiting`, never a failed boot: §9.3). Null once the handler retired. Review L07: each retry
   * takes the config through the config fence, as the boot loop's retries do, so a config.json corrected by hand (wrong
   * credentials are DB_UNAVAILABLE too, and `config:set` is refused while `pending`) is used without a restart.
   */
  async function openWaiting(config: Config): Promise<DbHandle | null> {
    let current = config;
    for (let failures = 0; ; failures += 1) {
      if (closed) return null;
      try {
        const h = await openDb(current);
        if (!closed) return h;
        await h.close().catch(() => {});
        return null;
      } catch (error) {
        if (!isDbUnavailable(error)) throw error;
        if (pendingBoot) ctx.bootMarker.waiting?.('db_unavailable');
        const retryInMs = retryDelayMs(failures);
        log.warn('database unavailable, retrying', { reason: stringMeta(error, 'reason'), attempt: failures + 1, retryInMs });
        await pause(retryInMs);
        const fence = state.fence;
        if (fence !== undefined) {
          await fence.check();
          current = fence.current();
        }
      }
    }
  }

  /**
   * 1d Task 25: steps the update op `opId` (20 s steps) while it is in one of `moving`, and returns what it is then (an
   * end, `needs_attention`, another state, another op or none), or `closed` once the handler retired. A step that leaves
   * the op as it was is followed by a pause of 1 s rising to 5 s (1D-02: no spin); a database that cannot be reached by
   * one of 1, 2, 4 … 30 s (a pending boot's marker says `waiting`).
   */
  async function stepOp(opId: string, moving: ReadonlySet<string>, first: OpFile): Promise<OpStatus | null | 'closed'> {
    let dbFailures = 0;
    let unchanged = 0;
    let last = `${first.state}|${first.progress}|${first.message ?? ''}`;
    for (;;) {
      if (closed) return 'closed';
      let status: OpStatus | null;
      try {
        status = await ops.step(OPS_STEP_BUDGET_MS);
        dbFailures = 0;
      } catch (error) {
        if (closed) return 'closed';
        if (isDbUnavailable(error)) {
          if (pendingBoot) ctx.bootMarker.waiting?.('db_unavailable');
          const retryInMs = retryDelayMs(dbFailures);
          dbFailures += 1;
          log.warn('database unavailable while stepping the update op, retrying', { opId, reason: stringMeta(error, 'reason'), retryInMs });
          await pause(retryInMs);
          continue;
        }
        // A step lock taken over meanwhile (another process stepped), or a fault of this process: the op is as it was.
        unchanged += 1;
        log.warn('a step of the update op failed; it is tried again', { opId, error: bootErrorFields(error) });
        await pause(unchangedStepDelayMs(unchanged));
        continue;
      }
      if (closed) return 'closed';
      if (status === null || status.opId !== opId || status.terminal || status.needsAttention || !moving.has(status.state)) return status;
      const seen = `${status.state}|${status.progress}|${status.message ?? ''}`;
      if (seen === last) {
        unchanged += 1;
        await pause(unchangedStepDelayMs(unchanged));
      } else {
        unchanged = 0;
      }
      last = seen;
    }
  }

  /**
   * 1d Task 25: the boot hooks of the process that boots an update's target (`update_boot`; 1d Task 27: a `self`
   * update too): the boot marker, §9.3's health whatever the phase (S1, 1D-05; the `health:<version>` fault of a test
   * build fails it), and ctx.markHealthy.
   */
  function targetBootHooks(): BootHooks {
    return {
      version: ctx.release.version,
      marker: ctx.bootMarker,
      health: async () => {
        if (faultMatchesVersion(env, 'health', ctx.release.version)) return false;
        const db = state.db;
        // Review C09 (§9.3): no database to ask (the handler retiring) or one that cannot be reached is a wait, never
        // an unhealthy release: DB_UNAVAILABLE leaves the op as it was.
        if (db === undefined) throw new DomainError('DB_UNAVAILABLE', { meta: { reason: 'health_check' } });
        return updateHealth(db, releaseMigrations());
      },
      markHealthy: async () => {
        await ctx.markHealthy();
        healthyMarked = true;
      },
    };
  }

  /**
   * 1d Task 25: how the `update_boot` and `revert` plans hand over to the normal boot once their op ended (`done`,
   * `rolled_back`, or an end another process recorded): a fresh attempt, which plans again. The ops fence looks first.
   * Its last look is the one the plan took while the op held its `update` flag, and only a request 2 s later would look
   * again (http/ops-fence.ts check), so the release, once `ready`, would answer 503 MAINTENANCE meanwhile although the
   * op's end lowered the flag (spec §9.7: after a pointer-only revert the old release serves out of maintenance; the
   * admin SPA follows such a 503 to /admin/_update, A7). Requests see the flag as the end left it.
   */
  async function bootAgainAfterOp(): Promise<'again'> {
    await opsFence.refresh();
    await releaseDb(); // the next attempt opens its own
    state.phase = 'starting';
    return 'again';
  }

  /**
   * 1d Task 25: the `update_boot` plan (see the top of this file): this release is the update's target and boots it
   * inside the op. `again` once the op is `done` (the normal boot follows); otherwise it rejects (UPDATE_BOOT_FAILED,
   * everything closed first), except for an op of a promoted target that needs attention, which is waited out.
   */
  async function updateBoot(config: Config, op: OpFile): Promise<'again' | 'done'> {
    state.phase = 'updating';
    log.warn('this release is the target of an update: it boots inside the update op', { opId: op.opId, state: op.state, version: ctx.release.version });
    await opsFence.refresh();
    let end: OpStatus | null | 'closed';
    try {
      const h = await openWaiting(config);
      if (h === null) return 'done';
      state.db = h;
      bootHooks = targetBootHooks();
      let from = op;
      for (;;) {
        end = await stepOp(op.opId, UPDATE_BOOT_STATES, from);
        // A target booted as `active`, not pending (app.js promoted it; its op has only its end to record), is healthy:
        // were start() to reject, app.js would fall back to `previous`, which never ends the op (S3: it leaves a
        // promoted op alone). So an op of its that needs attention (a step of it threw; review C08: never a mere 15 min
        // without a step, which the update kind does not count as a stall here) is waited out in phase `updating`,
        // maintenance kept, until someone resumes it (R1c-12).
        if (pendingBoot || end === 'closed' || end === null || end.opId !== op.opId || !end.needsAttention) break;
        log.error('the update op of this promoted release needs attention; maintenance stays and /admin/_update offers resume', {
          opId: op.opId,
          error: end.error?.code ?? null,
        });
        if ((await untilAttentionEnds(op.opId)) === 'closed') {
          end = 'closed';
          break;
        }
        const now = await readOpFile(ctx.dataDir);
        if (now !== null && now !== 'corrupt') from = now;
      }
    } catch (error) {
      if (closed) return 'done'; // the handler retired meanwhile
      // Not a wait (openWaiting waits out DB_UNAVAILABLE; stepOp keeps stepping): a failed boot of the target. Everything
      // closed first (1D-06), then UPDATE_BOOT_FAILED, which boot() passes on although `closed` is set now, so that
      // start() rejects and app.js reverts in this process.
      log.error('the boot of the update target failed', { opId: op.opId, error: bootErrorFields(error) });
      await closeOwn();
      throw new DomainError('UPDATE_BOOT_FAILED', { meta: { reason: 'start' } });
    }
    bootHooks = null;
    if (end === 'closed') return 'done';
    if (end !== null && end.opId === op.opId && end.state === 'done') {
      log.info('the update is done; the promoted release boots as usual', { opId: op.opId, version: ctx.release.version });
      pendingBoot = false;
      await releaseFence.rebase(); // this process's own promotion is no change
      return bootAgainAfterOp(); // the flag its end lowered, not the one this boot first read
    }
    if (!pendingBoot && (end === null || end.opId !== op.opId)) {
      // Review L06: a target booted as `active` (promoted already) whose op another process ended (and maybe another op
      // began, or op.json went) before this one stepped it: nothing failed. A rejection would make app.js fall back to
      // `previous` for good (its release fence matches current.json); plan afresh instead, as revertBoot does.
      log.info('the update op of this promoted release ended in another process; the boot plans again', { opId: op.opId, now: end?.opId ?? null });
      return bootAgainAfterOp(); // requests see the flag as the other process left it, not as this boot first read it
    }
    throw await bootRefused(end, 'the update target failed to boot; start() rejects so that app.js reverts it');
  }

  /** 1d Task 25: waits until the update op `opId` no longer needs attention (an operator's resume, or its end). */
  async function untilAttentionEnds(opId: string): Promise<'closed' | 'moved'> {
    const worker = runnerMode(ctx.runtime, env) === 'worker';
    for (;;) {
      // Worker mode looks every 2 s; otherwise a request's ops fence wakes this when the op ends (drive steps it).
      await waitForOp(worker ? OPS_WAIT_STEP_MS : null);
      if (closed) return 'closed';
      const now = await ops.current();
      if (now === null || now.opId !== opId || !now.needsAttention) return 'moved';
    }
  }

  /**
   * 1d Task 25: the `revert` plan (see the top of this file): this release steps the revert of an update whose target
   * failed. `again` for the normal boot (`rolled_back`, or the op no longer the plan's); `done` when the phase stays
   * `updating` (`restored`: the restart follows; `restore_failed`: maintenance kept).
   */
  async function revertBoot(config: Config, op: OpFile): Promise<'again' | 'done'> {
    state.phase = 'updating';
    log.warn('an update is reverting: this release steps its revert', { opId: op.opId, state: op.state, version: ctx.release.version });
    await opsFence.refresh();
    const h = await openWaiting(config);
    if (h === null) return 'done';
    state.db = h;
    let from = op;
    for (;;) {
      const end = await stepOp(op.opId, REVERT_STATES, from);
      if (end === 'closed') return 'done';
      if (end !== null && end.opId === op.opId && end.needsAttention) {
        // S2, R1c-12: a revert step threw; no spin and no more steps until someone resumes it (maintenance kept).
        log.error('the revert of the update needs attention; maintenance stays and /admin/_update offers resume', { opId: op.opId, error: end.error?.code ?? null });
        if ((await untilAttentionEnds(op.opId)) === 'closed') return 'done';
        const now = await readOpFile(ctx.dataDir);
        if (now !== null && now !== 'corrupt') from = now;
        continue;
      }
      if (end !== null && end.opId === op.opId && end.state === 'restored') {
        log.warn('the revert restored the pre_update backup; the restart it asked for replaces this process', { opId: op.opId });
        requestRestart('restore');
        return 'done';
      }
      if (end !== null && end.opId === op.opId && end.state === 'restore_failed') {
        log.error('the revert could not restore the database; maintenance stays and /admin/_update shows the CLI steps', {
          opId: op.opId,
          error: end.error?.code ?? null,
        });
        return 'done';
      }
      if (end !== null && end.opId === op.opId && end.state === 'rolled_back') await releaseFence.rebase(); // its own revert
      // The flag the revert's end lowered (or the end another process recorded), not the one this boot first read: the
      // release left behind serves out of maintenance as soon as it is `ready` (A7).
      return bootAgainAfterOp();
    }
  }

  /** 1d Task 27: current.json (or its `.bak`) as it is now, read-only (app.js creates it); null when it cannot be read. */
  async function readCurrent(): Promise<CurrentState | null> {
    try {
      return await readJsonWithBak(dataPath(ctx.dataDir, 'releases', 'current.json'), parseCurrentState);
    } catch (error) {
      log.warn('current.json cannot be read', { error: bootErrorFields(error) });
      return null;
    }
  }

  /** 1d Task 27: the keys a release folder is verified with, as app.js's (the embedded roots, R65a's documents). */
  async function releaseKeys(): Promise<{ roots: readonly TrustedKey[]; sources: KeysetSource[]; refuseDevKids: boolean }> {
    return { roots: embeddedRootKeys() ?? [], sources: [...(await installedKeysets(ctx.appRoot, ctx.dataDir)).sources], refuseDevKids: refusesDevKids() };
  }

  /**
   * 1d Task 27: the prechecks of §9.6 step 2 of updating the installation, whose `active` release is `active`, to the
   * bundled `candidate` (§9.8 rows 1 and 3), against the database `h` and this process's edition.
   */
  async function bundledPrecheck(h: DbHandle, candidate: Candidate, active: string): Promise<PrecheckReport> {
    const row = await h.db.selectFrom('schema_meta').select('schema_version').where('id', '=', 1).executeTakeFirst();
    const schema = typeof row?.schema_version === 'string' && /^\d{4}$/.test(row.schema_version) ? Number(row.schema_version) : null;
    return runPrecheck(
      {
        dataDir: ctx.dataDir,
        db: h,
        edition,
        snapshotBackupRunning: () => snapshotBackupRunning(h, Date.now()),
        nodeVersion: process.versions.node,
        appVersion: active,
        migrationsAhead: (c) => (c.schemaLatest !== undefined && schema !== null && Number(c.schemaLatest) > schema ? 1 : 0),
      },
      candidate,
    );
  }

  /** 1d Task 27: whether `op` is an update of this release's own (`self`, §9.8 row 3) that has not ended. */
  function ownSelfOp(op: OpFile | 'corrupt' | null): op is OpFile {
    return (
      op !== null &&
      op !== 'corrupt' &&
      op.kind === 'update' &&
      op.params['source'] === 'self' &&
      op.params['target'] === ctx.release.version &&
      !isTerminal(op.kind, op.state)
    );
  }

  /**
   * 1d Task 27 (§9.8 row 3 "Bila gagal: tetap dalam pemeliharaan, dengan instruksi"; preflight 1D-04): stays in phase
   * `updating` with maintenance kept: a manual `update` flag unless a flag is up already (an op's that has not ended is
   * never replaced), and the reason logged with its instruction. Never throws; `done` for the boot loop.
   */
  async function holdMaintenance(why: string, fields: LogFields): Promise<'done'> {
    state.phase = 'updating';
    try {
      const flag = await readMaintenance(ctx.dataDir);
      if (flag === null || (flag.opId !== null && (await activeOp(ctx.dataDir)) === null)) {
        await writeMaintenance(ctx.dataDir, { reason: 'update', since: clock(), opId: null, exemptJobIds: [] });
      }
    } catch (error) {
      log.error('the maintenance flag could not be written', { error: bootErrorFields(error) });
    }
    log.error(why, { version: ctx.release.version, ...fields });
    await opsFence.refresh();
    return 'done';
  }

  /**
   * 1d Task 27 (§9.8 row 3): steps the `self` update `op` of this release (see the top of this file) in phase
   * `updating`, with the boot hooks, from its entry state to its end. An op that needs attention is waited out (an
   * operator's resume). `done` leaves the phase as it is until the restart the op asked for; any other end keeps
   * maintenance ({@link holdMaintenance}).
   */
  async function selfBoot(config: Config, op: OpFile): Promise<'done'> {
    state.phase = 'updating';
    log.warn('this release runs its own update (schemaHold)', { opId: op.opId, state: op.state, version: ctx.release.version });
    await opsFence.refresh();
    let end: OpStatus | null | 'closed';
    try {
      if (state.db === undefined) {
        const h = await openWaiting(config);
        if (h === null) return 'done';
        state.db = h;
      }
      bootHooks = targetBootHooks();
      let from = op;
      for (;;) {
        end = await stepOp(op.opId, SELF_STATES, from);
        if (end === 'closed' || end === null || end.opId !== op.opId || !end.needsAttention) break;
        log.error('the schemaHold update needs attention; maintenance stays and /admin/_update offers resume', { opId: op.opId, error: end.error?.code ?? null });
        if ((await untilAttentionEnds(op.opId)) === 'closed') {
          end = 'closed';
          break;
        }
        const now = await readOpFile(ctx.dataDir);
        if (now !== null && now !== 'corrupt') from = now;
      }
    } catch (error) {
      bootHooks = null;
      if (closed) return 'done';
      return holdMaintenance('the schemaHold update could not be stepped; maintenance stays', { opId: op.opId, error: bootErrorFields(error) });
    }
    bootHooks = null;
    if (end === 'closed') return 'done';
    if (end !== null && end.opId === op.opId && end.state === 'done') {
      log.warn('the schemaHold update is done; the restart it asked for boots this release as active', { opId: op.opId, version: ctx.release.version });
      return 'done';
    }
    return holdMaintenance('the schemaHold update failed; maintenance stays', {
      opId: op.opId,
      state: end?.state ?? null,
      error: end?.error?.code ?? null,
      instruction: end?.error?.detail ?? null,
    });
  }

  /**
   * 1d Task 27: the `schemaHold` boot (§9.8 row 3; see the top of this file), when no op stands in the way (the plan is
   * `normal`). `ops_wait` when an op that has not ended is there (another release's update still downloading): the
   * boot loop waits for it and attempts again; `again` when such an op ended right as this process looked; `normal`
   * when current.json already names this release active (its update, run by another process, is done): the normal
   * boot follows, its database handle released.
   */
  async function schemaHoldBoot(config: Config, found: OpFile | 'corrupt' | null): Promise<'done' | 'ops_wait' | 'again' | 'normal'> {
    state.phase = 'updating';
    const version = ctx.release.version;
    log.warn('schemaHold: the bundled release is newer and the active release folder is missing; it runs its own update', { version });
    if (found !== null && found !== 'corrupt' && !isTerminal(found.kind, found.state) && (await opHoldsLock())) {
      state.phase = 'ops_wait';
      return 'ops_wait';
    }
    await opsFence.refresh();
    let h: DbHandle | null;
    try {
      h = await openWaiting(config);
    } catch (error) {
      return holdMaintenance('schemaHold: the database cannot be opened; maintenance stays', { error: bootErrorFields(error) });
    }
    if (h === null) return 'done';
    state.db = h;
    try {
      const current = await readCurrent();
      // 1D-04 first: a version that failed before begins nothing again (no new op, no new pre_update backup).
      const failed = await failedBefore(h.db, version, found);
      if (failed.failed) {
        const instruction = schemaHoldInstruction({ version, from: failed.from ?? current?.active.version ?? null, backupId: failed.backupId });
        return await holdMaintenance('schemaHold: this release failed before; nothing is begun again', { status: failed.status, backupId: failed.backupId, instruction });
      }
      if (current === null) return await holdMaintenance('schemaHold: current.json cannot be read; nothing is begun', {});
      if (current.active.version === version) {
        // app.js classified this process before the update of this release (run by another process) named it active,
        // and that update ended `done` meanwhile: the release is installed and boots as usual. Never a precheck
        // against itself, which would fail and raise a manual flag after a good update.
        log.info('schemaHold: current.json names this release active already (its update is done); it boots as usual', { version });
        await releaseDb();
        state.phase = 'starting';
        return 'normal';
      }
      const from = current.active.version;
      const { candidate } = await bundledCandidate(ctx.release.dir, await releaseKeys());
      const report = await bundledPrecheck(h, candidate, from);
      if (!report.ok) {
        await recordBundledBlocked(h, { version, failures: report.failures, now: clock() });
        return await holdMaintenance('schemaHold: the prechecks failed; the release is not installed', {
          failures: report.failures,
          instruction: schemaHoldInstruction({ version, from, backupId: null }),
        });
      }
      // A look again right before begin: another process may have begun the op (follow it) or seen it fail meanwhile.
      const again = await readOpFile(ctx.dataDir);
      if (ownSelfOp(again)) return await selfBoot(config, again);
      if ((await failedBefore(h.db, version, again)).failed) return await holdMaintenance('schemaHold: this release failed meanwhile; nothing is begun again', {});
      try {
        await ops.begin('update', SYSTEM_ACTOR, { source: 'self', target: version, from, entry: null, staging: null, needsBackup: null }, { state: 'verified' });
      } catch (error) {
        if (!(isDomainError(error) && error.code === 'OPS_IN_PROGRESS')) throw error;
      }
      await clearBundledBlocked(h, version, clock()).catch((error: unknown) => log.warn('update.bundled_blocked could not be cleared', { error: bootErrorFields(error) }));
      const begun = await readOpFile(ctx.dataDir);
      if (ownSelfOp(begun)) return await selfBoot(config, begun);
      // Another op holds the ops lock (begun by another process meanwhile): the boot loop waits for it.
      await releaseDb();
      if (await opHoldsLock()) {
        state.phase = 'ops_wait';
        return 'ops_wait';
      }
      // The op another process began ended between the begin and this look (its end may be this release's own `done`):
      // the boot plans again from op.json and current.json as they are now, after a pause (no spin).
      log.warn('schemaHold: the op in the way ended before this process could follow it; the boot plans again', { version });
      await pause(OPS_WAIT_STEP_MS);
      return 'again';
    } catch (error) {
      if (closed) return 'done';
      if (isDbUnavailable(error)) throw error; // the boot loop waits for the database and attempts again
      return holdMaintenance('schemaHold failed; maintenance stays', {
        error: bootErrorFields(error),
        instruction: schemaHoldInstruction({ version, from: null, backupId: null }),
      });
    }
  }

  /**
   * 1d Task 27 (R65a): the keyset documents of every release the installation holds (the bundled ones, those
   * current.json names) and of this one, appended to DATA_DIR/releases/keyset.json (with the Diagnostik alert when it is
   * full).
   */
  async function persistReleaseKeysets(h: DbHandle, current: CurrentState | null): Promise<void> {
    const roots = embeddedRootKeys() ?? [];
    if (roots.length === 0) return; // a server.mjs the release build did not bundle trusts no document
    const named: CurrentState = current ?? {
      schema: 1,
      active: { version: ctx.release.version, source: ctx.release.source },
      previous: null,
      pending: null,
      pendingSince: null,
      pinned: null,
    };
    const docs: KeysetDoc[] = await releaseKeysetDocs({ appRoot: ctx.appRoot, dataDir: ctx.dataDir, state: named, log });
    try {
      docs.push(...(await readReleaseKeyset(ctx.release.dir)));
    } catch {
      // A release without a usable keyset.json adds nothing (app.js refuses to run one anyway).
    }
    await persistKeysetDocs({ dataDir: ctx.dataDir, roots, docs, refuseDevKids: refusesDevKids(), log, db: h, now: clock() });
  }

  /**
   * 1d Task 27 (§9.3, D1d-23): the `release.retention` job, and `release.adopt` of this release when it runs as the
   * `bundled` active release in data mode (each once: their unique keys), then a kick of the worker loop.
   */
  async function enqueueReleaseJobs(h: DbHandle, config: Config, current: CurrentState | null): Promise<void> {
    const jobs = state.jobs;
    if (jobs === undefined) return;
    const version = ctx.release.version;
    const adopt =
      releaseSourceMode(env) === 'data' &&
      ctx.release.source === 'bundled' &&
      current !== null &&
      current.active.version === version &&
      current.active.source === 'bundled';
    const now = clock();
    await withTx(h, async (trx) => {
      await enqueue(trx, jobs.registry, { type: 'release.retention', payload: {}, uniqueKey: 'release.retention' }, { now, keyring: config.keyring });
      if (adopt) {
        await enqueue(trx, jobs.registry, { type: 'release.adopt', payload: { version }, uniqueKey: `release.adopt:${version}` }, { now, keyring: config.keyring });
      }
    });
    jobs.kick();
  }

  /**
   * 1d Task 27 (§9.8 rows 1 and 2; D1d-24; preflight B7, S9): a newer bundled release beside app.js. Only the `active`
   * release offers it, with nothing pending; see {@link bundledUpdatePlan} for when an op begins.
   */
  async function bundledOffer(h: DbHandle, current: CurrentState | null): Promise<void> {
    const bundled = ctx.bundledRelease;
    if (bundled === undefined || current === null) return;
    if (current.active.version !== ctx.release.version || current.pending !== null) return;
    const mode = releaseSourceMode(env);
    const plan = async (): Promise<ReturnType<typeof bundledUpdatePlan>> => {
      const op = await readOpFile(ctx.dataDir);
      const opActive = op === 'corrupt' || (op !== null && !isTerminal(op.kind, op.state));
      return bundledUpdatePlan({ bundled, state: current, mode, lastAttempt: await bundledAttempt(h.db, bundled.version), opActive });
    };
    const first = await plan();
    if (first !== 'begin') {
      if (first !== 'none') log.info('the bundled release is not installed', { version: bundled.version, why: first });
      return;
    }
    const { candidate } = await bundledCandidate(bundled.dir, await releaseKeys());
    const report = await bundledPrecheck(h, candidate, current.active.version);
    if (!report.ok) {
      const notified = await recordBundledBlocked(h, { version: bundled.version, failures: report.failures, now: clock() });
      log.warn('the bundled release did not pass its prechecks; this release keeps serving', { version: bundled.version, failures: report.failures, notified });
      return;
    }
    // A look again right before begin: another process may have begun an update, or ended one of this version.
    if ((await plan()) !== 'begin') return;
    try {
      await ops.begin('update', SYSTEM_ACTOR, { source: 'bundled', target: bundled.version, from: current.active.version, entry: null, staging: null, needsBackup: null }, { state: 'verified' });
    } catch (error) {
      if (isDomainError(error) && (error.code === 'OPS_IN_PROGRESS' || error.code === 'OPS_BLOCKED_BY_BACKUP')) {
        log.info('the update of the bundled release is not begun now', { version: bundled.version, code: error.code });
        return;
      }
      throw error;
    }
    await clearBundledBlocked(h, bundled.version, clock());
    log.warn('a newer bundled release: its update begins (§9.8)', { version: bundled.version, from: current.active.version });
  }

  /**
   * 1d Task 27: what every start does once `ready` (see the top of this file). Each part runs on its own; a failure is
   * logged and never fails the boot.
   */
  async function afterReady(h: DbHandle, config: Config): Promise<void> {
    const current = await readCurrent();
    const parts: [string, () => Promise<unknown>][] = [
      ['the keyset documents of the releases could not be stored', () => persistReleaseKeysets(h, current)],
      ['the staging folders could not be swept', () => sweepStagingLocked(ctx.dataDir, log)],
      ['the release jobs could not be enqueued', () => enqueueReleaseJobs(h, config, current)],
      ['the bundled release could not be looked at', () => bundledOffer(h, current)],
    ];
    for (const [failed, part] of parts) {
      if (closed) return;
      try {
        await part();
      } catch (error) {
        log.warn(failed, { error: bootErrorFields(error) });
      }
    }
  }

  /** Resolves after `ms` (never with null), or at once when opWake is called (the op ended, or the handler retired). */
  function waitForOp(ms: number | null): Promise<void> {
    return new Promise((resolve) => {
      let t: NodeJS.Timeout | undefined;
      const done = (): void => {
        clearTimeout(t);
        if (opWake === done) opWake = undefined;
        resolve();
      };
      opWake = done;
      if (ms !== null) {
        t = setTimeout(done, ms);
        t.unref();
      }
    });
  }

  /**
   * 1c Task 15 (B4, C40): serves `ops_wait` until the ops fence sees the op end (a request's look, or this loop's). In
   * worker mode the op is stepped every 2 s meanwhile; its kinds reach the database only through ctx.db() (absent
   * here) or ctx.connectDedicated(), never through this boot path. Otherwise `POST /_cron` and `ops/drive` step it.
   */
  async function untilOpEnds(): Promise<void> {
    const worker = runnerMode(ctx.runtime, env) === 'worker';
    while (!closed && opsFence.active()) {
      ctx.bootMarker.progress();
      if (worker) {
        try {
          await ops.step(OPS_STEP_BUDGET_MS);
        } catch (error) {
          log.warn('ops: a step while waiting for the op failed', { error: bootErrorFields(error) });
        }
        if (closed || !opsFence.active()) return;
      }
      await waitForOp(worker ? OPS_WAIT_STEP_MS : null);
      if (worker && !closed) await opsFence.check();
    }
  }

  /** 1c Task 15 (§9.4: an op is resumed by anyone, "atau boot"): one step of an op that is active once the app is ready. */
  async function bootStep(): Promise<void> {
    try {
      if (closed || (await activeOp(ctx.dataDir)) === null) return;
      await ops.step(OPS_STEP_BUDGET_MS);
    } catch (error) {
      log.warn('ops: the boot step of the op failed', { error: bootErrorFields(error) });
    }
  }

  /**
   * The config of one attempt. The first config found goes into the state and gets the fence; from then on the fence
   * is the single writer of `state.config` (configChanged), and the config comes from it. 1c Task 27 (L45): an attempt
   * that bootAgain started (`reload`) reads the file itself, since its fence may look only 2 s later, and resets the
   * fence to what it read.
   */
  async function attemptConfig(reload: boolean): Promise<Config | null> {
    const fence = state.fence;
    if (fence !== undefined && !reload) {
      await fence.check();
      return fence.current();
    }
    const config = await loadConfig(ctx.dataDir, env);
    if (config !== null && !closed) {
      state.baseUrl = config.baseUrl;
      state.config = config;
      if (fence === undefined) state.fence = createConfigFence({ dataDir: ctx.dataDir, env, initial: config, onChange: configChanged, log });
      else fence.reset(config);
    } else if (config === null && !closed && state.config !== undefined) {
      // Final review: config.json went away (`install:reset`) while this process waited for the op. The config it had
      // goes with its fence (which would keep it), so that the install gate reads the files again, as in a process
      // that started before config.json existed (app.ts's look at install.lock and config.json).
      log.warn('config.json is gone: the config in use is dropped');
      state.config = undefined;
      state.fence = undefined;
      state.baseUrl = undefined;
    }
    return config;
  }

  /**
   * One pass over config → database → migrations → health. Leaves `state` as the outcome says; `ops_wait` when an
   * exclusive op holds the ops lock (1c Task 15): the caller then waits for it and attempts again. 1c Task 27: `o`
   * says whether the config is read from the file (`reload`) and whether a `not_installed` outcome prints the install
   * code (`announce`: the first attempt only; GET /install prints a renewed one). 1d Task 25: the boot plan of the op
   * decides first (see the top of this file); `again` when the update op this process stepped ended in a way that
   * needs a fresh attempt (the promoted target's normal boot, or the boot after a revert).
   */
  async function attempt(o: BootOptions): Promise<'done' | 'ops_wait' | 'again'> {
    const config = await attemptConfig(o.reload);
    if (closed) return 'done';
    if (config === null || config.installState !== 'complete') {
      state.phase = 'not_installed';
      log.info('not installed', { installState: config?.installState ?? null });
      // 1c Task 10: the install code on stdout, on the app's clock. A malformed ALTIS_INSTALL_CODE is an explicit boot
      // failure (INVALID_CONFIG); a gate that cannot decide yet (DB_UNAVAILABLE: the database of ALTIS_DB_* cannot be
      // read) goes to the retry loop below, with no code printed (fail closed); anything else is logged.
      if (o.announce) await announceInstallCode(install, { clock, log });
      return 'done';
    }
    // 1c Task 27 (L45): the install completed while this process served the wizard: `starting` while it boots (a 503
    // DB_UNAVAILABLE, not the NOT_INSTALLED instruction), and the wizard's own handle closed first (P20: one SQLite
    // connection per process).
    if (state.phase === 'not_installed') state.phase = 'starting';
    await install.close().catch((error: unknown) => log.warn('closing the wizard database failed', { error: bootErrorFields(error) }));
    serverLog ??= openServerLog(ctx, config, env);

    const installRuntime = config.install.runtime;
    if (installRuntime !== undefined && installRuntime !== ctx.runtime && !runtimeNoted) {
      runtimeNoted = true;
      log.warn('runtime differs from the install', { runtime: ctx.runtime, installRuntime });
    }
    if (config.db.dialect === 'sqlite' && !sqliteAllowed(ctx.runtime)) throw sqliteNotAllowed(ctx.runtime, installRuntime);
    const pm2Cluster = sqlitePm2Cluster(config.db.dialect, ctx.runtime, installRuntime, env); // 1d Task 32 (L8)
    if (pm2Cluster !== null) throw pm2Cluster;

    // 1d Task 25 (decisions C40, D1d-14): the op op.json holds decides the boot, before any connection.
    const found = await readOpFile(ctx.dataDir);
    if (closed) return 'done';
    const plan = opBootPlan(found, ctx.release.version, pendingBoot);
    if (plan === 'refuse') {
      throw await bootRefused(found, 'start() refuses: this release must not boot now; app.js reverts it (its update op settled, or a pending boot without its op)');
    }
    // 1d Task 27 (§9.8 row 3): an update of this release's own that has not ended is stepped here, in either boot mode.
    if (!pendingBoot && ownSelfOp(found)) return selfBoot(config, found);
    if (plan === 'update_boot' && found !== null && found !== 'corrupt') return updateBoot(config, found);
    if (plan === 'revert' && found !== null && found !== 'corrupt') return revertBoot(config, found);
    // 1d Task 27: the bundled release booted because it is newer and the active folder is missing (§9.8 row 3). Only
    // once current.json names it active already (its own update done by another process) does the normal boot follow.
    if (ctx.bootMode === 'schemaHold' && plan === 'normal') {
      const held = await schemaHoldBoot(config, found);
      if (held !== 'normal') return held;
    }
    // Review C17 (§9.7 "restore_failed: tetap dalam pemeliharaan dan /admin/_update menampilkan langkah CLI"): an op that
    // ended in a state that keeps maintenance (an update's `restore_failed`) boots as the process that stepped it ended:
    // phase `updating`, no runMigrations, whose `too_old` (the database is too new for this release) would answer 503
    // SCHEMA_TOO_NEW on /admin/_update and the ops routes too. Only while its flag is up: after `maintenance:off --force`
    // (or another op) the boot goes on as usual.
    if (plan === 'normal' && (await heldByEndedOp(found))) {
      state.phase = 'updating';
      log.error('an update ended restore_failed; maintenance stays and /admin/_update shows the CLI steps', {
        opId: found !== null && found !== 'corrupt' ? found.opId : null,
      });
      return 'done';
    }

    // 1c Task 15 (preflight B4, decision C40): an exclusive op holds the ops lock: nothing touches the database (no
    // connection, migration, system roles, health check or markHealthy) until it ends. 1d Task 25: an op that holds its
    // maintenance (`ops_wait`); an update still downloading holds none and the boot goes on.
    if (plan === 'ops_wait' && (await opHoldsLock())) {
      if (closed) return 'done';
      state.phase = 'ops_wait';
      const op = opsFence.op();
      log.warn('an operation holds the ops lock; the boot waits for it', {
        opId: op?.opId ?? null,
        kind: op?.kind ?? null,
        state: op?.state ?? null,
      });
      return 'ops_wait';
    }
    if (closed) return 'done';

    // L19: an error on an idle pooled connection (server restart, idle kill) reaches the server log, not stderr.
    const h = await openDb(config);
    let adopted = false;
    try {
      if (closed) return 'done';
      ctx.bootMarker.phase('migrating');
      const lockWaitMs = testMigrationLockWaitMs(env);
      const outcome = await runMigrations(h, {
        appVersion: ctx.release.version,
        dataDir: ctx.dataDir,
        migrations: releaseMigrations(), // a test build's fixture level included (decision D1d-26)
        ...(lockWaitMs === undefined ? {} : { lockWaitMs }),
      });
      if (closed) return 'done';
      if (outcome.mode === 'too-old') {
        state.phase = 'too_old';
        log.error('the database needs a newer ALTIS', {
          version: ctx.release.version,
          schemaVersion: outcome.schemaVersion,
          minCodeVersion: outcome.minCodeVersion,
        });
        return 'done';
      }
      // The system roles (D5) are code's, made at every boot in a transaction of their own: a restore or an older
      // install may lack them, and their name follows the release. A no-op when they are as they should be.
      const roles = await withTx(h, (trx) => ensureSystemRoles(trx, Date.now()));
      if (roles.created.length > 0) log.info('system roles created', { roles: roles.created });
      if (closed) return 'done';
      state.db = h;
      adopted = true;
      state.phase = 'ready';
      state.releaseFence = releaseFence; // 1d Task 25: requests check it from now on
      log.info('migrations done', { mode: outcome.mode, applied: outcome.applied.length, schemaVersion: outcome.schemaVersion });
    } finally {
      if (!adopted) await h.close().catch(() => {});
    }

    // Healthy = listening + database reachable + /_health 200 + migrations done (spec §9.3).
    const health = await app.request(HEALTH_PATH);
    if (closed) return 'done';
    if (health.status !== 200) {
      throw new DomainError('DB_UNAVAILABLE', { meta: { reason: 'health_check' } });
    }
    log.info('ready', { version: ctx.release.version, dialect: h.dialect, poolSize: h.poolSize });
    try {
      // 1d Task 25: an update target that its own op promoted (verifying) has said it already.
      if (!healthyMarked) await ctx.markHealthy();
    } catch (error) {
      // The bootloader's own bookkeeping failed; the server itself is healthy and keeps serving.
      log.error('markHealthy failed', { error: bootErrorFields(error) });
    }
    if (closed) return 'done';
    // 1c Task 13: the job runtime of this process; its worker loop runs in worker mode only (passenger/litespeed and
    // ALTIS_RUNNER=off leave the work to /_cron, drive and piggyback).
    state.jobs = createJobRuntime({
      state,
      runtime: ctx.runtime,
      env,
      dataDir: ctx.dataDir,
      log,
      clock,
      ops,
      // 1c Task 23: the Diagnostik jobs' DATA_DIR, app folder and base URL (as the fence keeps the config).
      // 1c Task 18: the housekeeping and mail handlers need DATA_DIR, the mail and the base URL (M22).
      handlers: jobHandlers({
        diagnostics: { dataDir: ctx.dataDir, appRoot: ctx.appRoot, baseUrl: () => state.config?.baseUrl ?? null },
        housekeeping: { dataDir: ctx.dataDir, mailer: jobMailer(state), baseUrl: () => (state.config ?? config).baseUrl, settings },
        updateCheck: { source: () => updates.source }, // 1d Task 28: the daily update check reads the feed with it
      }),
      requestRestart: (reason) => ctx.requestRestart(reason),
      installId: config.install.id,
      appVersion: ctx.release.version,
      // S19: the fences the worker loop checks before each pass.
      fences: () => [state.fence],
      opsFence, // 1c Task 15
      releaseFence, // 1d Task 25
    });
    state.jobs.start();
    log.info('job runtime started', { mode: state.jobs.mode });
    // ---- Phase 2 (catalog): Task 3 ----
    // The catalog's boot hook (catalog-boot.ts; Task 15 queues a full reindex when the index was never built). Every
    // process runs it; a failure is logged and never fails the boot (the catalogue is served all the same, and the daily
    // `catalog.housekeeping` makes up for it).
    try {
      await catalogBoot(h, { registry: state.jobs.registry, keyring: (state.config ?? config).keyring, now: clock() });
    } catch (error) {
      log.error('catalog boot hook failed', { error: bootErrorFields(error) });
    }
    await afterReady(h, config); // 1d Task 27: keyset, sweep, release jobs, §9.8 rows 1-2
    await bootStep();
    return 'done';
  }

  /**
   * The boot loop: attempts until one settles (see the state machine at the top of this file), retrying while the
   * database is unavailable or another process migrates, and waiting out an exclusive op.
   *
   * @throws an explicit boot failure, as it is
   */
  async function boot(o: BootOptions): Promise<void> {
    let opts = o;
    for (let failures = 0; !closed; failures += 1) {
      let outcome: 'done' | 'ops_wait' | 'again';
      try {
        outcome = await attempt(opts);
      } catch (error) {
        // 1d Task 25: a refused or failed update boot closed everything (closed is set) and must still reject start().
        if (isDomainError(error) && error.code === 'UPDATE_BOOT_FAILED') throw error;
        if (closed) return;
        const lock = migrationLockWait(error);
        if (lock === undefined && !isDbUnavailable(error)) throw error;
        // Another process is migrating (R60): still starting, not a database problem.
        state.phase = lock === undefined ? 'db_unavailable' : 'starting';
        await releaseDb();
        const retryInMs = retryDelayMs(failures);
        if (lock === undefined) {
          log.warn('database unavailable, retrying', { reason: stringMeta(error as DomainError, 'reason'), attempt: failures + 1, retryInMs });
        } else {
          log.warn('migration lock busy, retrying', { lock, attempt: failures + 1, retryInMs });
        }
        ctx.bootMarker.progress();
        await pause(retryInMs);
        continue;
      }
      if (outcome === 'done' || closed) return;
      if (outcome === 'again') {
        // 1d Task 25: the update op this process stepped ended (done, rolled_back): a fresh attempt, which plans again.
        failures = -1;
        continue;
      }
      // 1c Task 15 (B4): an op holds the ops lock; once it ended, the boot runs as usual (no failure: the retry delays
      // start again). Final review: from config.json as the op left it (`install:reset` renames it), not from the
      // config fence, which keeps the config it had.
      await untilOpEnds();
      if (!closed) state.phase = 'starting';
      opts = { ...opts, reload: true };
      failures = -1;
    }
  }

  /**
   * 1c Task 27 (L45): boot loops one after another, from `first`, for as long as a bootAgain() call arrived during one
   * and the app is still `not_installed`.
   */
  async function boots(first: BootOptions): Promise<void> {
    let o = first;
    for (;;) {
      bootPending = false;
      await boot(o);
      if (!bootPending || closed || state.phase !== 'not_installed') return;
      o = AGAIN;
    }
  }

  /**
   * 1c Task 27 (L45, S12): a new boot attempt while the app is `not_installed`, so that an install completed by the
   * wizard (in this process: services.installDone(); in another: the config fence's onChange, or app.ts's look at
   * install.lock and config.json) is served without a restart. One loop at a time: a call during one makes it run
   * again. Never throws: an explicit failure of such a boot (there is no start() promise left to reject) is logged and
   * the bootloader is asked for a restart, whose boot then fails the way a cold start would (app.js decides).
   */
  function bootAgain(): void {
    if (closed || state.phase !== 'not_installed') return;
    if (booting !== undefined) {
      bootPending = true;
      return;
    }
    booting = boots(AGAIN)
      .catch(async (error: unknown) => {
        log.error('boot failed', bootErrorFields(error));
        await releaseDb();
        requestRestart('boot-failed');
      })
      .finally(() => {
        booting = undefined;
      });
  }

  // 1d Task 25 (D1d-20): the release fence's boot snapshot, what app.js read just before it loaded this release.
  await releaseFence.rebase();
  try {
    booting = boots(FIRST);
    await booting;
  } catch (error) {
    log.error('boot failed', bootErrorFields(error));
    await releaseDb();
    throw error;
  } finally {
    booting = undefined;
  }
}

/** 1c Task 27: how one boot loop runs (start()'s attempt). */
interface BootOptions {
  /** Read config.json from the file even when the fence holds one (a boot attempt bootAgain started). */
  reload: boolean;
  /** A `not_installed` outcome prints the install code (the first boot only). */
  announce: boolean;
}

const FIRST: BootOptions = { reload: false, announce: true };
const AGAIN: BootOptions = { reload: true, announce: false };
