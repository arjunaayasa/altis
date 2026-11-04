import type { KeysetSource, TrustedKey } from '@altis/crypto';
import { releaseDirExists, type Runtime } from '@altis/platform';
import { classifyBundled, type BundledRelation } from './bundled.js';
import { markHealthy, releaseDir, type CurrentState, type ReleaseRef } from './current.js';
import { startingHandler, type Front, type RequestHandler } from './front.js';
import type { BootLog } from './log.js';
import type { BootPhase, BootWaitReason } from './markers.js';
import { importServer, previousIsCompatible, verify, type ServerModule } from './release.js';
import { createRequestRestart } from './restart.js';
import { errorCode, rescueHandler, rescueSteps, rescueSummary, type RescueReason } from './rescue.js';

// The boot internals that boot.ts (the order of app.js's work) and pending.ts (the pending boot protocol, 1d Task 16)
// share, kept here so that pending.ts never imports boot.ts (preflight M9: no import cycle): the context handed to
// start() and runCli(), the load of a release (verification + import), its start on app.js's one server, the fallback
// from `active` to `previous` (and to the bundled copy of the same version, S14), and the boot of `active` with the
// §9.8 classification of the bundled release.
//
// app.js bundles this module (ES2017, P1).

/** Where a release failed: its verification, its import, or its start() (the detail a pending revert reports). */
export type BootStage = 'verify' | 'import' | 'start';

/** Thrown for a failure that has a rescue reason. */
export class BootFailure extends Error {
  readonly reason: RescueReason;
  /** Where the release failed; null for a failure that is not a release's (a state file, say). */
  readonly stage: BootStage | null;

  constructor(reason: RescueReason, detail: string, cause?: unknown, stage?: BootStage) {
    super(reason + ': ' + detail, cause === undefined ? undefined : { cause });
    this.name = 'BootFailure';
    this.reason = reason;
    this.stage = stage === undefined ? null : stage;
  }
}

/** What contract v1 hands to start() and runCli() (spec §9.2). Mirrors apps/server's BootContext exactly. */
export interface BootContext {
  bootProtocol: 1;
  appRoot: string;
  dataDir: string;
  release: { version: string; dir: string; source: ReleaseRef['source'] };
  runtime: Runtime;
  /** The port app.js listens on (informational: app.js owns the server; under Passenger it is not used). */
  port: number;
  /**
   * The release booted healthy (§9.3). For a release booted as `pending` (`pendingBoot`), this promotes it
   * (`previous = active`, `active = pending`, `pending = null`), removes its boot markers and lets boot.lock go; it
   * rejects when the release is no longer pending (a revert took it away) or boot.lock was taken over. For any other
   * release it changes nothing.
   */
  markHealthy(): Promise<void>;
  requestRestart(reason: string): Promise<void>;
  /**
   * The boot marker (§9.3): written only while a `pending` release boots, a no-op otherwise. `phase()` and
   * `progress()` are progress; `waiting(reason)` (1d, additive in v1) says the boot waits for its environment (the
   * database, the migration lock), which is never counted as a failed boot, until the next phase() or progress().
   */
  bootMarker: {
    phase(p: 'importing' | 'listening' | 'migrating'): void;
    progress(): void;
    waiting?(reason: 'db_unavailable' | 'migration_lock'): void;
  };
  log: BootLog;
  /**
   * Makes `handler` answer every request of app.js's one http.Server (P2, ruling R64), in place of the one before.
   * The returned promise resolves once `handler` is no longer served (another handler took its place, or the
   * server closed). Throws for a command (CLI): it has no server.
   */
  serve(handler: RequestHandler): Promise<void>;
  /**
   * 1c Task 23 (decision C29; additive in contract v1, as R64's `serve`): this app.js's own version
   * (`__BUNDLED_VERSION__`), which Diagnostik shows. Absent in a build without one.
   */
  appJsVersion?: string;
  /**
   * 1d (additive in v1, spec §9.8): the release bundled beside app.js and how it compares with the release booted, when
   * there is one and this release boots as `active` (or its fallback). Absent otherwise.
   */
  bundledRelease?: { version: string; dir: string; relation: 'newer' | 'same' | 'older' };
  /**
   * 1d (additive in v1, spec §9.8 row 3): `schemaHold` when the bundled release boots because it is newer and the
   * `active` folder is missing (no migration, maintenance, only the ops routes, until its own update op is done).
   * Absent means `normal`.
   */
  bootMode?: 'normal' | 'schemaHold';
  /**
   * 1d (additive in v1, spec §9.3): true when this release boots as `pending`, holding boot.lock; absent otherwise.
   */
  pendingBoot?: boolean;
}

export interface BootOptions {
  /** The folder that holds app.js. */
  appRoot: string;
  /** app.js itself (the supervisor forks it). */
  script: string;
  /** The command-line arguments after app.js. */
  argv: string[];
  /** Run as a command (`node app.js <command>`), not as the server. */
  cli: boolean;
  log: BootLog;
}

export interface Setup extends BootOptions {
  env: NodeJS.ProcessEnv;
  dataDir: string;
  runtime: Runtime;
  port: number;
  state: CurrentState;
  /** The embedded root keys (__TRUSTED_KEYS__). */
  roots: TrustedKey[];
  /** Every root-signed keyset document of the installation (step 5). */
  keysets: KeysetSource[];
}

export interface Loaded {
  ref: ReleaseRef;
  dir: string;
  server: ServerModule;
}

/** What a boot adds to the context of contract v1 (see {@link BootContext}); absent: the defaults. */
export interface ContextExtras {
  markHealthy?: () => Promise<void>;
  bootMarker?: BootContext['bootMarker'];
  pendingBoot?: boolean;
  bootMode?: 'normal' | 'schemaHold';
  bundledRelease?: { version: string; dir: string; relation: BundledRelation };
}

/** Errors of the file system that say "cannot write here" rather than "the content is bad". */
const UNWRITABLE_CODES = ['EACCES', 'EPERM', 'EROFS', 'ENOSPC', 'EDQUOT'];

export function embeddedRoots(): TrustedKey[] {
  return typeof __TRUSTED_KEYS__ === 'undefined' ? [] : __TRUSTED_KEYS__;
}

/** The version app.js was built with (`__BUNDLED_VERSION__`), as current.json's initial `active` names it. */
export function bundledVersion(): string {
  return typeof __BUNDLED_VERSION__ === 'undefined' ? '0.0.0' : __BUNDLED_VERSION__;
}

/** A failure of a state file in DATA_DIR/releases: unwritable folder, or corrupt state. */
export function stateFailure(what: string, error: unknown): BootFailure {
  const code = errorCode(error);
  const reason: RescueReason = UNWRITABLE_CODES.indexOf(code) !== -1 ? 'DATA_DIR_UNWRITABLE' : 'STATE_CORRUPT';
  return new BootFailure(reason, what + ' cannot be used', error);
}

/** Step 6 + import: verify the release, then import its server.mjs. */
export async function load(s: Setup, ref: ReleaseRef): Promise<Loaded> {
  let dir: string;
  try {
    dir = releaseDir(s.appRoot, s.dataDir, ref);
    await verify(dir, ref, s.roots, s.keysets, s.log);
  } catch (error) {
    throw new BootFailure('RELEASE_INVALID', 'release ' + ref.version + ' (' + ref.source + ') failed verification', error, 'verify');
  }
  try {
    return { ref, dir, server: await importServer(dir) };
  } catch (error) {
    throw new BootFailure('START_FAILED', 'release ' + ref.version + ' could not be imported', error, 'import');
  }
}

/**
 * Runs `attempt` with `ref`; when `ref` is a DATA_DIR release that fails its verification and `bundled-release/<v>`
 * beside app.js holds the same version, once more with that bundled copy (spec §9.2 step 3, preflight S14: "Rilis
 * terbundel menjadi fallback hanya bila versinya sama dengan active/previous"). A bundled release of another version is
 * never tried here: a newer one always goes through §9.8. The failure reported is the DATA_DIR release's.
 */
async function withBundledCopy<T>(s: Setup, ref: ReleaseRef, attempt: (ref: ReleaseRef) => Promise<T>): Promise<T> {
  try {
    return await attempt(ref);
  } catch (first) {
    if (!(first instanceof BootFailure) || first.stage !== 'verify' || ref.source !== 'data') throw first;
    const copy: ReleaseRef = { version: ref.version, source: 'bundled' };
    if (!(await releaseDirExists(s.appRoot, s.dataDir, copy))) throw first;
    s.log.warn('the release failed verification; falling back to the bundled copy of the same release', {
      release: ref.version,
      reason: first.reason,
      err: first,
    });
    try {
      return await attempt(copy);
    } catch (second) {
      if (!(second instanceof BootFailure)) throw second;
      s.log.error('the bundled copy failed too', { release: ref.version, reason: second.reason, err: second });
      throw first;
    }
  }
}

/**
 * Runs `attempt` with `active`, and when that fails with a rescue reason, once more with `previous` if there is
 * one and schema-meta.json allows it (spec §9.2 step 3, §9.7). Each of them is tried from its bundled copy of the same
 * version when its DATA_DIR folder fails verification (S14). The failure reported is the active release's.
 */
export async function withFallback<T>(s: Setup, attempt: (ref: ReleaseRef) => Promise<T>): Promise<T> {
  const active = s.state.active;
  try {
    return await withBundledCopy(s, active, attempt);
  } catch (first) {
    if (!(first instanceof BootFailure)) throw first;
    s.log.error('release failed', { release: active.version, source: active.source, reason: first.reason, err: first });
    const previous = s.state.previous;
    if (previous === null || (previous.version === active.version && previous.source === active.source)) throw first;
    if (!(await previousIsCompatible(s.dataDir, previous, s.log))) throw first;
    s.log.warn('falling back to the previous release', { release: previous.version, source: previous.source });
    try {
      return await withBundledCopy(s, previous, attempt);
    } catch (second) {
      if (!(second instanceof BootFailure)) throw second;
      s.log.error('the previous release failed too', { release: previous.version, reason: second.reason, err: second });
      throw first;
    }
  }
}

/** The boot marker of a release that does not boot as `pending`: nothing is written (a command, `active`). */
function noMarker(): BootContext['bootMarker'] {
  return { phase: () => {}, progress: () => {}, waiting: () => {} };
}

export function context(s: Setup, loaded: Loaded, mode: 'server' | 'cli', serve: BootContext['serve'], extras?: ContextExtras): BootContext {
  const log = s.log.child({ release: loaded.ref.version });
  const x: ContextExtras = extras === undefined ? {} : extras;
  const ctx: BootContext = {
    bootProtocol: 1,
    appRoot: s.appRoot,
    dataDir: s.dataDir,
    release: { version: loaded.ref.version, dir: loaded.dir, source: loaded.ref.source },
    runtime: s.runtime,
    port: s.port,
    markHealthy: x.markHealthy !== undefined ? x.markHealthy : () => markHealthy(s.dataDir, loaded.ref.version),
    requestRestart: createRequestRestart({ runtime: s.runtime, appRoot: s.appRoot, log, mode }),
    bootMarker: x.bootMarker !== undefined ? x.bootMarker : noMarker(),
    log,
    serve,
  };
  // 1c Task 23 (C29), 1d Task 16: optional fields only when they say something (ES2017: no object spread here).
  if (typeof __BUNDLED_VERSION__ !== 'undefined') ctx.appJsVersion = __BUNDLED_VERSION__;
  if (x.bundledRelease !== undefined) {
    ctx.bundledRelease = { version: x.bundledRelease.version, dir: x.bundledRelease.dir, relation: x.bundledRelease.relation };
  }
  if (x.bootMode !== undefined) ctx.bootMode = x.bootMode;
  if (x.pendingBoot === true) ctx.pendingBoot = true;
  return ctx;
}

/**
 * Step 8, the server: start(ctx) of the loaded release, which serves on `front` through ctx.serve. When its start()
 * fails, its handler is retired ("starting" answers again) and its ctx.serve stops working, so that nothing it left
 * running can take the server back from the release that serves next or the rescue page.
 *
 * @throws BootFailure `START_FAILED` (stage `start`) when start() rejects or resolves without calling ctx.serve()
 */
export async function startLoaded(s: Setup, front: Front, loaded: Loaded, extras?: ContextExtras): Promise<void> {
  const ref = loaded.ref;
  let started = true; // this release may (still) serve
  let served = false;
  const ctx = context(
    s,
    loaded,
    'server',
    (handler: RequestHandler) => {
      if (typeof handler !== 'function') throw new TypeError('ctx.serve(handler): the handler must be a function');
      if (!started) {
        s.log.warn('ctx.serve() ignored: this release is no longer started', { release: ref.version });
        return Promise.resolve();
      }
      served = true;
      return front.use(handler);
    },
    extras,
  );
  s.log.info('starting release', { release: ref.version, source: ref.source, runtime: s.runtime, port: s.port });
  try {
    await loaded.server.start(ctx);
  } catch (error) {
    started = false;
    void front.use(startingHandler());
    throw new BootFailure('START_FAILED', 'start() of release ' + ref.version + ' failed', error, 'start');
  }
  if (!served) {
    started = false;
    throw new BootFailure('START_FAILED', 'start() of release ' + ref.version + ' resolved without calling ctx.serve()', undefined, 'start');
  }
}

/** The release bundled beside app.js (`bundled-release/<__BUNDLED_VERSION__>`), or null when there is none. */
async function bundledBeside(s: Setup): Promise<{ version: string; dir: string } | null> {
  if (typeof __BUNDLED_VERSION__ === 'undefined') return null;
  const ref: ReleaseRef = { version: __BUNDLED_VERSION__, source: 'bundled' };
  if (!(await releaseDirExists(s.appRoot, s.dataDir, ref))) return null;
  return { version: ref.version, dir: releaseDir(s.appRoot, s.dataDir, ref) };
}

/**
 * What the boot of `active` makes of the bundled release (§9.8, bundled.ts): the release to boot in `schemaHold` (newer
 * than `active`, whose folder is missing; null otherwise), and the `ctx.bundledRelease` of the `active` boot (null when
 * there is no bundled release beside app.js).
 */
export async function bundledPlan(s: Setup): Promise<{ schemaHold: ReleaseRef | null; bundledRelease: ContextExtras['bundledRelease'] | null }> {
  const bundled = await bundledBeside(s);
  if (bundled === null) return { schemaHold: null, bundledRelease: null };
  const c = classifyBundled(s.state, bundled.version, await releaseDirExists(s.appRoot, s.dataDir, s.state.active));
  if (c.action === 'schema_hold') return { schemaHold: { version: bundled.version, source: 'bundled' }, bundledRelease: null };
  return { schemaHold: null, bundledRelease: c.relation === null ? null : { version: bundled.version, dir: bundled.dir, relation: c.relation } };
}

/**
 * Step 8 when nothing is pending: the bundled release is classified against `active` (§9.8, {@link bundledPlan}).
 * - `schemaHold` (newer, the `active` folder missing): the bundled release is loaded and started with
 *   `bootMode: 'schemaHold'`; its own update op moves the pointers (Task 27). There is no fallback.
 * - otherwise: `active`, with the fallback to `previous` (and to the bundled copy of the same version, S14), its
 *   context carrying `bundledRelease` when a bundled release is there (`offer` is the server's to act on).
 *
 * @throws BootFailure when no release could be started (the caller serves the rescue page)
 */
export async function serveActive(s: Setup, front: Front): Promise<void> {
  const plan = await bundledPlan(s);
  if (plan.schemaHold !== null) {
    s.log.warn('the bundled release is newer and the active release folder is missing: it boots in schemaHold', {
      bundled: plan.schemaHold.version,
      active: s.state.active.version,
    });
    const loaded = await load(s, plan.schemaHold);
    await startLoaded(s, front, loaded, { bootMode: 'schemaHold' });
    return;
  }
  const extras: ContextExtras = {};
  if (plan.bundledRelease !== null) extras.bundledRelease = plan.bundledRelease;
  await withFallback(s, async (ref) => startLoaded(s, front, await load(s, ref), extras));
}

/** Step 9 on app.js's own server: the rescue page of `error`'s reason (START_FAILED for an unexpected error). */
export function rescueOnFront(log: BootLog, front: Front, error: unknown): void {
  const failure = error instanceof BootFailure ? error : new BootFailure('START_FAILED', 'unexpected bootloader error', error);
  log.error('boot failed', { reason: failure.reason, err: failure });
  process.stderr.write(rescueSummary(failure.reason) + rescueSteps(failure.reason));
  log.info('serving the rescue page', { reason: failure.reason });
  void front.use(rescueHandler(failure.reason));
}

/** The phases and wait reasons a boot marker accepts (a release may pass anything). */
export function isBootPhase(value: unknown): value is BootPhase {
  return value === 'importing' || value === 'listening' || value === 'migrating';
}

export function isBootWaitReason(value: unknown): value is BootWaitReason {
  return value === 'db_unavailable' || value === 'migration_lock';
}
