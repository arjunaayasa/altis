import os from 'node:os';
import {
  SLICE_BUDGET_MS,
  backupCreateJob,
  backupKind,
  backupPrepareDownloadJob,
  backupScheduleJob,
  closeJobSessions,
  createJobRegistry,
  createPiggyback,
  createRestoreRunner,
  createRunner,
  createScheduler,
  createSettingsCache,
  createSqliteSwap,
  diagnosticsJobs,
  housekeepingJobs,
  installMigrateKind,
  mailJobs,
  migrateKind,
  recordRun,
  releaseAdoptJob, // 1d Task 27
  releaseRetentionJob, // 1d Task 27
  resetKind,
  restoreKind,
  rollbackKind,
  runnerMode,
  updateKind,
  type BackupJobDeps,
  type BackupOpDeps,
  type CoreLogger,
  type JobContext,
  type JobHandler,
  type JobOutcome,
  type JobRegistry,
  type Mailer,
  type OpKindHandler,
  type OpsMachine,
  type PassReport,
  type PrepareDownloadDeps,
  type RestoreKindDeps,
  type RestoreRunner,
  type Runner,
  type RunMode,
  type SettingsCache,
  type SliceResult,
  type UpdateKindDeps,
} from '@altis/core';
// 1d Task 28: the update check's handler and its feed client.
import { updateCheckJob, type UpdateSource } from '@altis/core';
import { connect, releaseMigrations, upsert, withTx } from '@altis/db';
import type { Env, Runtime } from '@altis/platform';
import { z } from 'zod';
import type { AppState } from '../app.js';
import { CRON_PATH } from '../api/cron.js';
import type { Config } from '../config.js';
import { csrfKey } from '../http/csrf.js';
import { HEALTH_PATH } from '../http/health.js';
import type { Logger } from '../logger.js';
import { embeddedRootKeys, installedKeysets, refusesDevKids } from '../release-keys.js'; // 1d Task 27
import { loggableError } from '../safe-error.js';
import { catalogJobDeps, catalogJobHandlers } from './catalog.js';
import { komunitasJobDeps, komunitasJobHandlers } from './komunitas.js';

// The job runtime of a server process (spec §10.2, P14; plan Task 13, M13): the job handlers and op kinds of this
// release, and what runs them in each runner mode.
//
// - worker (every runtime but passenger/litespeed, unless ALTIS_RUNNER=off): start() runs a loop in the process.
//   Before each pass it checks the fences (config, and Task 15's ops fence), which otherwise only requests check
//   (S19); a pass steps the op, ticks the scheduler and runs up to two light slices and one heavy; the loop sleeps 0 s
//   after a pass that ran slices, 1 s while an op is in progress, and otherwise backs off from 2 s to 5 s, waking at
//   once on kick() (a local enqueue, decision C36).
// - A continued `longRunning` job (worker, jobs:run) runs on as a task of its own that the runtime adopts and tracks
//   for the drain (ruling R1c-7): the passes after it go on as above, without their heavy lane, until it ends.
// - external (passenger/litespeed, or ALTIS_RUNNER=off): no timer at all. `POST /_cron` (cron()), drive and piggyback
//   (maybePiggyback(), after a response) do the work.
// - The scheduler (Task 14, spec §10.4): start() seeds the schedules once ready, in every mode (a process that never
//   starts, jobs:run, seeds at its first tick); every pass outside maintenance ticks them, after refreshing
//   clock_anomaly.
// - stop() is the drain of P14: no new claim or op step, the slices running now (≤ 20 s) are waited for, then the job
//   sessions and the ops machine's connections are closed. index.ts calls it once the handler is retired, before it
//   closes the database.
// - 1d Task 25 (decision D1d-20): the release fence is one of the fences the loop checks; once it saw current.json name
//   another release, nothing is claimed any more (the loop ends, cron/drive/piggyback run nothing) until the restart
//   that start()'s change handler asks for replaces the process.
//
// Handlers and op kinds are one array each below; later tasks add one line each. A handler that needs its process
// (DATA_DIR, the config, the ops machine: Task 20's backups) is made with needsRuntime(): createJobRuntime binds it to
// its own JobRuntimeDeps, and the unbound one jobHandlers() returns only serves registries that enqueue (its schema).

/** The worker loop's first wait, and its wait while an op is in progress. */
const WORKER_IDLE_FIRST_MS = 1000;
/** The longest wait of an idle worker loop (decision C36: "backs off from 1 s to 5 s"). */
const WORKER_IDLE_MAX_MS = 5000;
/** stop() waits this long for running slices (P9: a slice is ≤ 20 s). */
const DRAIN_MS = SLICE_BUDGET_MS;
/** A test-slice effect row lives "far in the future" (2100-01-01): nothing ever expires it. */
const TEST_EFFECT_UNTIL = 4_102_444_800_000;

/** 1c Task 25: what the restore's SQLite swap needs from its process (start() passes it). */
export interface OpKindsSqlite {
  log: Logger;
  /**
   * This process's own handles on the live SQLite file (its server handle, the op's dedicated connections): closed
   * before the swap and a rename back, reopened after the swap.
   */
  own: { close(): Promise<void>; reopen(): Promise<void> };
}

/**
 * The op kinds of this release (S11; later tasks add theirs here, one line each). `config` is the config of the moment
 * (`state.config`), for the kinds that need its secrets (Task 20: the frozen backup's manifest). 1c Task 22: `dataDir`
 * and `requestRestart` for the restore (without them it uses the machine's DATA_DIR and leaves the restart to every
 * process's data-epoch fence, S23). 1c Task 25: with `dataDir` and `sqlite`, a SQLite restore runs on a work file
 * swapped into place (createSqliteSwap); without them the restore has no swap. 1d Task 24 (preflight S6): `update`, what
 * the update kind needs from the process (its prechecks with the edition, feed client, backup facts, restore runner, boot
 * hooks, app folder), built by each of the four callers (start(), the services' default, `ops:*`, `backup:restore`);
 * the kind is registered only when it is given (Task 26 registers `rollbackKind` from the same option).
 */
export function opKinds(deps: {
  appVersion: string;
  config?: () => Config | undefined;
  dataDir?: string;
  requestRestart?: (reason: string) => Promise<void>;
  sqlite?: OpKindsSqlite;
  update?: () => UpdateKindDeps;
}): OpKindHandler[] {
  const migrations = { appVersion: deps.appVersion, migrations: releaseMigrations() };
  const restore = restoreKind(restoreKindDeps(deps));
  return [
    migrateKind(migrations),
    resetKind(),
    installMigrateKind(migrations),
    backupKind(() => backupOpDeps(deps.config?.(), deps.appVersion)), // 1c Task 20
    deps.dataDir !== undefined && deps.sqlite !== undefined ? restore : leavesSqliteRestores(restore, deps.config), // 1c Tasks 22, 25
    ...(deps.update === undefined ? [] : [updateKind(deps.update)]), // 1d Task 24
    ...(deps.update === undefined ? [] : [rollbackKind(deps.update)]), // 1d Task 26: the update deps fit it
  ];
}

/**
 * 1d Task 24: the restore runner of the update's "terlalu lama" revert (Task 25 steps it inside the update op), with
 * the same deps as the restore kind of {@link opKinds}: with `dataDir` and `sqlite`, a SQLite restore swaps a work file
 * into place. Made on first use (the update deps of a process read it lazily).
 */
export function updateRestoreRunner(deps: {
  appVersion: string;
  config?: () => Config | undefined;
  dataDir?: string;
  requestRestart?: (reason: string) => Promise<void>;
  sqlite?: OpKindsSqlite;
}): () => RestoreRunner {
  let runner: RestoreRunner | undefined;
  return () => (runner ??= createRestoreRunner(restoreKindDeps(deps)));
}

/**
 * 1c Task 25: the restore kind of a process made without the SQLite swap (the commands whose machines createAppOps
 * makes with the default kinds; review C11: no longer jobs:run, which swaps over its own handles as `ops:resume` does)
 * leaves a restore on SQLite as it is, for a process whose kind swaps a work file into place: stepped here, its load
 * would run on the live file while other processes hold it.
 * The dialect comes from the process's own handle, else from the config (no connection is opened to learn it).
 */
function leavesSqliteRestores(kind: OpKindHandler, config: (() => Config | undefined) | undefined): OpKindHandler {
  return {
    ...kind,
    async step(ctx, op) {
      const dialect = ctx.db()?.dialect ?? config?.()?.db.dialect;
      return dialect === 'sqlite' ? op : kind.step(ctx, op);
    },
  };
}

/**
 * 1c Task 22: what the restore kind needs, read from the config of the moment at every step (the keyring and the
 * session key follow config.json). 1c Task 25: the SQLite swap and this process's own handles.
 */
function restoreKindDeps(deps: {
  appVersion: string;
  config?: () => Config | undefined;
  dataDir?: string;
  requestRestart?: (reason: string) => Promise<void>;
  sqlite?: OpKindsSqlite;
}): RestoreKindDeps {
  const config = (): Config => {
    const c = deps.config?.();
    if (c === undefined) throw new TypeError('restore: no config is loaded');
    return c;
  };
  return {
    dataDir: deps.dataDir ?? '',
    appVersion: deps.appVersion,
    migrations: releaseMigrations(),
    sessionKey: () => csrfKey(config()),
    keyring: () => config().keyring,
    get installId() {
      return config().install.id;
    },
    requestRestart: deps.requestRestart ?? (async () => {}),
    // 1c Task 25: used only when the database is SQLite (restoreKind checks the dialect).
    sqliteSwap: deps.dataDir !== undefined && deps.sqlite !== undefined ? createSqliteSwap({ dataDir: deps.dataDir, log: deps.sqlite.log }) : null,
    ...(deps.sqlite === undefined ? {} : { sqliteOwn: deps.sqlite.own }),
  };
}

/**
 * What a job handler of this release that needs its process gets from the job runtime that runs it (Task 20): the
 * runtime's own options, and the config of the moment.
 */
export interface JobRuntimeDeps {
  dataDir: string;
  runtime: Runtime;
  installId: string;
  appVersion: string;
  ops: OpsMachine;
  /** `state.config` when the slice runs (the keyring and the session key follow config.json). */
  config(): Config | undefined;
  /** Phase 2 Task 3: the runtime's logger (the catalog jobs' `CatalogJobDeps.log`); absent, they log nowhere. */
  log?: CoreLogger;
}

/** The handlers jobHandlers() made with needsRuntime(), each with the maker createJobRuntime binds it with. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const runtimeMakers = new WeakMap<JobHandler<any>, (deps: JobRuntimeDeps) => JobHandler<any>>();

/**
 * A handler that needs its process: `make(deps)` with the deps of the job runtime that runs it ({@link bindJobHandlers});
 * unbound, its slices throw TypeError (it still checks payloads at enqueue).
 */
function needsRuntime<P>(make: (deps: () => JobRuntimeDeps) => JobHandler<P>): JobHandler<P> {
  const unbound = make(() => {
    throw new TypeError('this job handler runs only in a job runtime (createJobRuntime binds it)');
  });
  runtimeMakers.set(unbound, (deps) => make(() => deps));
  return unbound;
}

/**
 * Phase 2 Task 3: {@link needsRuntime} for a list of handlers made together (the catalog's, jobs/catalog.ts): each one
 * is bound with the runtime's deps as the others are.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function needsRuntimeAll(make: (deps: () => JobRuntimeDeps) => JobHandler<any>[]): JobHandler<any>[] {
  const unbound = make(() => {
    throw new TypeError('this job handler runs only in a job runtime (createJobRuntime binds it)');
  });
  unbound.forEach((handler, i) => runtimeMakers.set(handler, (deps) => make(() => deps)[i]!));
  return unbound;
}

/** `handlers` with each handler of needsRuntime() bound to `deps`; the others as they are. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function bindJobHandlers(handlers: readonly JobHandler<any>[], deps: JobRuntimeDeps): JobHandler<any>[] {
  return handlers.map((h) => runtimeMakers.get(h)?.(deps) ?? h);
}

/** The installation facts of the backup op (Task 20), from the config of the moment. */
function backupOpDeps(config: Config | undefined, appVersion: string): BackupOpDeps {
  if (config === undefined) throw new TypeError('backup: no config is loaded');
  return { installId: config.install.id, appVersion, sessionKey: csrfKey(config), kids: config.keyring.map((k) => k.kid) };
}

/** What the backup jobs (Task 20) need, from the runtime's deps. */
function backupJobDeps(d: JobRuntimeDeps): BackupJobDeps {
  const config = d.config();
  if (config === undefined) throw new TypeError('backup: no config is loaded');
  return {
    ...backupOpDeps(config, d.appVersion),
    installId: d.installId,
    dataDir: d.dataDir,
    runtime: d.runtime,
    ops: d.ops,
    // P17: a pool-1 connection outside the pool for the snapshot transaction.
    connectSnapshot: () => connect(config.db, { runtime: d.runtime, purpose: 'cli', dataDir: d.dataDir }),
  };
}

/** 1c Task 21: what the download preparation needs, from the runtime's deps (the config of the moment). */
function prepareDownloadDeps(d: JobRuntimeDeps): PrepareDownloadDeps {
  const config = d.config();
  if (config === undefined) throw new TypeError('backup: no config is loaded');
  return { dataDir: d.dataDir, keyring: config.keyring, sessionKey: csrfKey(config) };
}

/**
 * What handlers need from the process that runs them (core holds no config, M22). The server and `jobs:run` pass all
 * of it; an app or a registry built without it (tests, the test-only route) gets no handler that needs it, so the
 * scheduler skips their schedules as it does any type without a handler.
 */
export interface JobHandlerDeps {
  /** 1c Task 23: DATA_DIR and the app folder of the Diagnostik jobs, and config.json's baseUrl (exposure). */
  diagnostics?: { dataDir: string; appRoot: string; baseUrl(): string | null };
  /**
   * 1c Task 18: what the handlers that touch files or send mail are built with (M22: core holds no configuration). A
   * server process and `jobs:run` pass it; without it (tests of the runtime itself) those handlers are not there.
   */
  housekeeping?: {
    /** DATA_DIR: the files cleanup, the audit anchor log, upload staging. */
    dataDir: string;
    /** The mail of the jobs (the SMTP settings read at every send). */
    mailer: Mailer;
    /** config.json's `baseUrl` at the time of a send (the links of the mails). */
    baseUrl(): string;
    settings: SettingsCache;
  };
  /**
   * 1d Task 28: the feed client the update check (`update.check`, spec §9.6 step 1) reads the feed with: the process's
   * `services.updates.source` (start()), or one made like it (`jobs:run`). Without it there is no `update.check`
   * handler, and the scheduler skips the daily check.
   */
  updateCheck?: { source(): UpdateSource };
}

/**
 * The job handlers of this release (later tasks add theirs here, one line each), and, in the test build profile only
 * (S28), `test.slices` and `test.long`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function jobHandlers(deps: JobHandlerDeps = {}): JobHandler<any>[] {
  return [
    needsRuntime((rt) => backupScheduleJob(() => backupJobDeps(rt()))), // 1c Task 20
    needsRuntime((rt) => backupCreateJob(() => backupJobDeps(rt()))), // 1c Task 20
    needsRuntime((rt) => backupPrepareDownloadJob(() => prepareDownloadDeps(rt()))), // 1c Task 21
    ...(deps.housekeeping === undefined ? [] : housekeepingJobs({ dataDir: deps.housekeeping.dataDir })), // 1c Task 18
    ...(deps.housekeeping === undefined ? [] : mailJobs(deps.housekeeping)), // 1c Task 18
    ...testJobHandlers(),
    ...(deps.diagnostics === undefined ? [] : diagnosticsJobs(deps.diagnostics)), // 1c Task 23
    ...(deps.diagnostics === undefined ? [] : releaseJobs(deps.diagnostics)), // 1d Task 27
    ...updateCheckHandlers(deps.updateCheck), // 1d Task 28
    // ---- Phase 2 (catalog): Task 3 ----
    // The catalog's handlers (jobs/catalog.ts: housekeeping, reindex, runs, import/export, SLiMS migration), each area's
    // list from its own module; bound to the process like the backup jobs.
    ...needsRuntimeAll((rt) => catalogJobHandlers(() => catalogJobDeps(rt()))),
    // ---- Komunitas K1 (reports and accreditation) ----
    ...needsRuntimeAll((rt) => komunitasJobHandlers(() => komunitasJobDeps(rt()))),
  ];
}

// 1d Task 27 (spec §9.3; decision D1d-23): the `release.adopt` and `release.retention` jobs. They need DATA_DIR and the
// app folder, which every process that runs jobs passes with its Diagnostik deps (start() and jobs:run); the keys are
// this server.mjs's own (the embedded roots, the installation's keyset documents), as app.js verifies releases.

/** The release jobs of a process whose DATA_DIR and app folder are `d`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function releaseJobs(d: { dataDir: string; appRoot: string }): JobHandler<any>[] {
  return [
    releaseAdoptJob(() => ({
      appRoot: d.appRoot,
      dataDir: d.dataDir,
      roots: embeddedRootKeys() ?? [],
      sources: async () => [...(await installedKeysets(d.appRoot, d.dataDir)).sources],
      refuseDevKids: refusesDevKids(),
      env: process.env,
    })),
    releaseRetentionJob(() => ({ dataDir: d.dataDir })),
  ];
}

/**
 * 1d Task 28: the `update.check` handler over `updateCheck`'s feed client, with the running release and DATA_DIR of
 * the job runtime that runs it; none without a feed client.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function updateCheckHandlers(updateCheck: JobHandlerDeps['updateCheck']): JobHandler<any>[] {
  if (updateCheck === undefined) return [];
  return [needsRuntime((rt) => updateCheckJob(() => ({ source: updateCheck.source(), appVersion: rt().appVersion, dataDir: rt().dataDir })))];
}

type TestSlices = { slices: number; k: number; exitAt?: number };

/**
 * Test build profile only (S28, M49): `test.slices` `{slices: 1..20, k, exitAt?}` upserts the `locks` row
 * `test-slice:<jobId>:<k>` (so its effects can be counted), then continues with `k + 1` until `k = slices`; at
 * `k = exitAt` the process exits with code 1 before the effect (a crash mid-slice). `test.long` is the same with
 * `longRunning: true`, and records in the row's owner (`s<n>`) how many slices its process-local session has seen.
 */
function testJobHandlers(): JobHandler<TestSlices>[] {
  if (typeof __BUILD_PROFILE__ !== 'undefined' && __BUILD_PROFILE__ === 'test') {
    const payload = z.strictObject({
      slices: z.number().int().min(1).max(20),
      k: z.number().int().min(1).max(20),
      exitAt: z.number().int().min(1).max(20).optional(),
    });
    const slice = (long: boolean) =>
      async function run(ctx: JobContext, p: TestSlices): Promise<JobOutcome<TestSlices>> {
        let owner = 'test';
        if (long) {
          const s = await ctx.session(
            async () => ({ slices: 0 }),
            async () => {},
          );
          s.value.slices += 1;
          owner = `s${s.value.slices}`;
        }
        if (p.exitAt === p.k) process.exit(1);
        const name = `test-slice:${ctx.jobId}:${p.k}`;
        await withTx(ctx.handle, (trx) => upsert(trx, 'locks', { name }, { owner, until: TEST_EFFECT_UNTIL }, { owner, until: TEST_EFFECT_UNTIL }));
        return p.k >= p.slices ? { done: true } : { continueWith: { ...p, k: p.k + 1 }, progress: Math.floor((100 * p.k) / p.slices) };
      };
    const base = { permission: 'system.jobs.manage', retryable: 'api', interactive: true, payload } as const;
    return [
      { ...base, type: 'test.slices', run: slice(false) },
      { ...base, type: 'test.long', longRunning: true, run: slice(true) },
    ];
  }
  return [];
}

/**
 * Test hook, compiled out of production builds (R57, M23): `ALTIS_TEST_CLOCK_OFFSET_MS=<ms>` is added to the clock of
 * the server (`services.clock`, the runtime) and of `jobs:run`, so a child process can stand past a lease, a backoff
 * or the install code's lifetime. 0 otherwise.
 */
export function testClockOffsetMs(env: Env): number {
  if (typeof __BUILD_PROFILE__ !== 'undefined' && __BUILD_PROFILE__ === 'test') {
    const value = Number(env['ALTIS_TEST_CLOCK_OFFSET_MS']);
    if (Number.isSafeInteger(value)) return value;
  }
  return 0;
}

/** `locked_by` of this process's claims: `[<prefix>:]<host>:<pid>`, printable ASCII, at most 191 characters. */
export function jobWorkerName(prefix?: string): string {
  const host = os.hostname().replace(/[^\x21-\x7e]/g, '?').slice(0, 120) || 'host';
  return `${prefix === undefined ? '' : `${prefix}:`}${host}:${process.pid}`;
}

/**
 * The requests after which a process never piggybacks (decision C36): health, the cron call, static assets, the
 * install wizard and streams (SSE).
 */
export function piggybackSkips(urlPath: string): boolean {
  return (
    urlPath === HEALTH_PATH ||
    urlPath === CRON_PATH ||
    urlPath.startsWith('/admin/assets/') ||
    urlPath.startsWith('/assets/') ||
    urlPath === '/install' ||
    urlPath.startsWith('/install/') ||
    urlPath.endsWith('/stream') ||
    urlPath.endsWith('/sse')
  );
}

export interface JobRuntimeOptions {
  /** The app's state: its `db` and `config` (keyring) at the moment of each pass, its config fence. */
  state: AppState;
  runtime: Runtime;
  env: Env;
  dataDir: string;
  log: Logger;
  /** Epoch ms (services.clock, with the test offset). */
  clock(): number;
  /** The app's ops machine (services.ops). */
  ops: OpsMachine;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handlers: readonly JobHandler<any>[];
  /** For the kinds and handlers that end in a restart (P14: after a restore). */
  requestRestart(reason: string): Promise<void>;
  /** config.json's `install.id`, for the handlers that need it (backups). */
  installId: string;
  /** The running release. */
  appVersion: string;
  /**
   * The fences the worker loop checks before each pass (S19), as they are at that moment; default the config fence
   * (`state.fence`).
   */
  fences?(): readonly ({ check(): Promise<void> } | null | undefined)[];
  // 1c Task 15 (S19): the ops fence.
  /**
   * The process's ops fence (http/ops-fence.ts), checked by the worker loop before each pass after `fences()`: a
   * process without requests still sees another process's maintenance flag, data epoch and op end within 2 s.
   */
  opsFence?: { check(): Promise<void> } | null;
  /**
   * 1d Task 25 (decision D1d-20): the process's release fence (http/release-fence.ts), checked by the worker loop before
   * each pass after the other fences, and by `cron()`. Once it saw current.json name another release (`changed()`),
   * the runtime claims nothing more (no pass, no drive, no piggyback): the process is about to be replaced.
   */
  releaseFence?: { check(): Promise<void>; changed(): boolean } | null;
  /** Where piggyback reads the run records (default: a cache of the runtime's own, P6). */
  settings?: SettingsCache;
  /** `locked_by` of the claims; default {@link jobWorkerName}. */
  worker?: string;
}

export interface JobRuntime {
  readonly registry: JobRegistry;
  readonly runner: Runner;
  readonly ops: OpsMachine;
  readonly mode: 'worker' | 'external';
  /**
   * Seeds the schedules (every mode, once; Task 14) and starts the worker loop (worker mode only; a no-op otherwise, and
   * when already started or stopped).
   */
  start(): void;
  /** The drain (P14): stops claiming, waits ≤ 20 s for running slices, closes job sessions and op connections. */
  stop(): Promise<void>;
  /** One cron pass (`POST /_cron`, `jobs:run`) of at most `budgetMs`, then its run record. */
  cron(mode: 'cron_http' | 'cron_cli', budgetMs: number): Promise<PassReport>;
  /** One slice of job `jobId` (drive); null without running in worker mode (the loop runs it) or when not claimable. */
  drive(jobId: string, o: { budgetMs: number }): Promise<SliceResult | null>;
  /** After the response to a request for `urlPath` (external mode only): maybe one piggyback slice, on setImmediate. */
  maybePiggyback(urlPath: string): void;
  /** Wakes an idle worker loop (a job was enqueued in this process). */
  kick(): void;
  /**
   * The continued `longRunning` job this process runs on its own (R1c-7; worker mode and jobs:run): it settles once
   * that job ends, may no longer run here, or the runtime drains. Null when there is none.
   */
  longJob(): Promise<void> | null;
  /** The slices this runtime's continued `longRunning` jobs ran on their own so far (jobs:run counts them). */
  longJobSlices(): number;
}

/** The job runtime of a server process (see the top of this file). */
export function createJobRuntime(o: JobRuntimeOptions): JobRuntime {
  const registry = createJobRegistry(
    bindJobHandlers(o.handlers, {
      dataDir: o.dataDir,
      runtime: o.runtime,
      installId: o.installId,
      appVersion: o.appVersion,
      ops: o.ops,
      config: () => o.state.config,
      log: o.log, // Phase 2 Task 3: the catalog jobs' logger
    }),
  );
  const mode = runnerMode(o.runtime, o.env);
  const log = o.log;
  const settings = o.settings ?? createSettingsCache({ clock: o.clock });
  const configFences = o.fences ?? (() => [o.state.fence]);
  // 1c Task 15 (S19): the ops fence after the config fences.
  const fences = (): readonly ({ check(): Promise<void> } | null | undefined)[] => [...configFences(), o.opsFence, o.releaseFence];
  const db = () => o.state.db;
  let stopping = false;
  /** 1d Task 25: no claim once the release fence saw another release (the process is about to be replaced). */
  const halted = (): boolean => stopping || o.releaseFence?.changed() === true;
  /** What runs now (cron, drive, piggyback, a long job on its own, the loop): stop() waits for it. */
  const running = new Set<Promise<unknown>>();
  /** R1c-7: the long job running on its own, and the slices such jobs ran. */
  let longJob: Promise<void> | null = null;
  let longSlices = 0;
  // ---- the scheduler (Task 14): seeded by start() (or by its first tick), ticked by the runner's passes.
  const scheduler = createScheduler({ db, reg: registry, keyring: () => o.state.config?.keyring ?? [], log });
  const runner = createRunner({
    db,
    reg: registry,
    ops: o.ops,
    dataDir: o.dataDir,
    scheduler,
    keyring: () => o.state.config?.keyring ?? [],
    clock: o.clock,
    log,
    env: o.env,
    worker: o.worker ?? jobWorkerName(),
    stopping: halted, // 1d Task 25: a long job running on its own stops too once the release changed
    adoptLongJob(task) {
      // The task never rejects (the runner logs its failures); stop() waits for it with the other running work.
      const ended = track(task).then((slices) => {
        longSlices += slices;
        if (longJob === ended) longJob = null;
      });
      longJob = ended;
    },
  });
  const piggyback = createPiggyback({ runner, db, dataDir: o.dataDir, clock: o.clock, log, settings });

  function track<T>(p: Promise<T>): Promise<T> {
    running.add(p);
    const done = (): void => {
      running.delete(p);
    };
    p.then(done, done);
    return p;
  }

  async function record(m: RunMode): Promise<void> {
    const h = db();
    // While draining the database may be closing: the next process records its own runs.
    if (h === undefined || stopping) return;
    try {
      await recordRun(h, m, o.clock(), { dataDir: o.dataDir });
      settings.invalidate();
    } catch (error) {
      log.warn('jobs: recording the run failed', { mode: m, err: loggableError(error) });
    }
  }

  // ---- the worker loop

  let loop: Promise<void> | null = null;
  let wake: (() => void) | null = null;
  let kicked = false;

  function sleep(ms: number): Promise<void> {
    if (kicked || ms <= 0) {
      kicked = false;
      return new Promise((resolve) => setImmediate(resolve));
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        wake = null;
        resolve();
      }, ms);
      timer.unref();
      wake = () => {
        clearTimeout(timer);
        wake = null;
        resolve();
      };
    });
  }

  async function workerLoop(): Promise<void> {
    let idle = WORKER_IDLE_FIRST_MS;
    while (!stopping) {
      for (const fence of fences()) {
        try {
          await fence?.check();
        } catch (error) {
          log.warn('jobs: a fence check failed', { err: loggableError(error) });
        }
      }
      if (halted()) {
        if (!stopping) log.warn('jobs: the release changed; the worker loop stops claiming');
        return;
      }
      let report: PassReport | null = null;
      try {
        report = await runner.pass({ budgetMs: SLICE_BUDGET_MS, mode: 'worker' });
        await record('worker');
      } catch (error) {
        if (!stopping) log.warn('jobs: a worker pass failed', { err: loggableError(error) });
      }
      if (report !== null && report.slices > 0) idle = 0;
      else if (report?.op !== null && report?.op !== undefined && !report.op.terminal) idle = WORKER_IDLE_FIRST_MS;
      else idle = Math.min(Math.max(idle, WORKER_IDLE_FIRST_MS / 2) * 2, WORKER_IDLE_MAX_MS);
      if (stopping) return;
      await sleep(idle);
    }
  }

  let stopped: Promise<void> | null = null;

  return {
    registry,
    runner,
    ops: o.ops,
    mode,
    start() {
      if (stopping) return;
      // Task 14: the schedules of this release, in every mode (seeded once; a failure is retried by the next tick).
      track(scheduler.seed(o.clock())).catch((error: unknown) => {
        log.warn('jobs: seeding the schedules failed', { err: loggableError(error) });
      });
      if (mode !== 'worker' || loop !== null) return;
      loop = workerLoop().catch((error: unknown) => {
        log.error('jobs: the worker loop stopped', { err: loggableError(error) });
      });
    },
    stop() {
      stopped ??= (async () => {
        stopping = true;
        wake?.();
        const pending = [...running, ...(loop === null ? [] : [loop])];
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, DRAIN_MS);
          timer.unref();
        });
        await Promise.race([Promise.allSettled(pending), timeout]);
        clearTimeout(timer);
        await closeJobSessions(log);
        try {
          await o.ops.close();
        } catch (error) {
          log.warn('jobs: closing the ops connections failed', { err: loggableError(error) });
        }
      })();
      return stopped;
    },
    async cron(m, budgetMs) {
      if (o.releaseFence !== undefined && o.releaseFence !== null && !stopping) {
        try {
          await o.releaseFence.check();
        } catch (error) {
          log.warn('jobs: a fence check failed', { err: loggableError(error) });
        }
      }
      if (halted()) return { op: null, scheduled: 0, slices: 0 };
      const report = await track(runner.pass({ budgetMs, mode: m }));
      await record(m);
      return report;
    },
    async drive(jobId, d) {
      if (mode === 'worker' || halted()) return null;
      const result = await track(runner.driveJob(jobId, d));
      if (result !== null) await record('drive');
      return result;
    },
    maybePiggyback(urlPath) {
      if (mode !== 'external' || halted() || piggybackSkips(urlPath)) return;
      setImmediate(() => {
        if (halted()) return;
        track(piggyback.run()).catch((error: unknown) => {
          log.warn('jobs: a piggyback slice failed', { err: loggableError(error) });
        });
      });
    },
    kick() {
      if (wake !== null) wake();
      else kicked = true;
    },
    longJob: () => longJob,
    longJobSlices: () => longSlices,
  };
}
