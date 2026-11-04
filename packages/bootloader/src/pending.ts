import {
  acquireFileLock,
  dataPath,
  lockHostIdentity,
  processStartMs,
  readJsonWithBak,
  type HeldFileLockHandle,
} from '@altis/platform';
import {
  BootFailure,
  bundledVersion,
  isBootPhase,
  isBootWaitReason,
  load,
  rescueOnFront,
  serveActive,
  startLoaded,
  stateFailure,
  type BootContext,
  type ContextExtras,
  type Setup,
} from './boot-core.js';
import { parseCurrentState, promote, readCurrentState, updateCurrentState, type CurrentState, type ReleaseRef } from './current.js';
import type { Front } from './front.js';
import type { BootLog } from './log.js';
import {
  BOOT_LOCK_STALE_MS,
  BOOT_REFRESH_MS,
  BOOT_RETRY_MS,
  REVERT_FAILED_BOOTS,
  REVERT_STALL_MS,
  attemptEnded,
  classifyAttempts,
  readMarkers,
  removeMarkers,
  writeMarker,
  type AttemptCount,
  type BootMarker,
  type BootPhase,
  type BootWaitReason,
} from './markers.js';
import { isPendingFailureDetail, readUpdateOpFor, recordPendingFailure, touchOpHeartbeat, type PendingFailureDetail } from './op-record.js';
import { installedKeysets } from './release.js';
import { RESTART_EXIT_CODE } from './restart.js';
import { waitingHandler } from './waiting.js';

// The boot of a `pending` release (spec §9.2 step 3, §9.3; decisions D1d-18, D1d-19, D1d-42; Review Focus 1;
// preflight B8, S3, S15, 1D-02, 1D-03). current.json names a release in `pending` from the update's point of no return
// until it is promoted (healthy) or reverted. Only the holder of `releases/boot.lock` boots it:
//
//   lock = acquireFileLock(releases/boot.lock, stale 60 s)
//   no lock → serve the minimal pages of §9.2 step 6 (waiting.ts, Task 22); a request, at most every 5 s, re-reads
//             current.json: pending gone → boot `active`; the lock free → go on below
//   attempts = the markers of releases/boot/<v>/ whose attempt ended (attemptEnded), counted (classifyAttempts)
//   op = op.json's update op of <v> (no lock)
//   an explicit error, ≥ 3 failed, or the op settled (reverting, restoring, needs_attention after the point of no
//   return, B8) → revert without importing <v>
//   otherwise: our marker (`importing`) and the refresher (every 10 s: the marker's refreshedAt, op.json's heartbeatAt;
//     boot.lock refreshes itself, lock.ts); load + start(ctx {pendingBoot, bootMarker → our marker, markHealthy →
//     promote, remove the markers, let boot.lock go})
//   a BootFailure (verify, import, start) → our marker's explicit error, then revert, then `active` in this process
//   revert: op.json first (recordPendingFailure → reverting); busy → keep `pending` and our marker's error, let
//     boot.lock go and wait (the next attempt, in any process, reverts, S3); otherwise pending = null, remove the
//     markers, let boot.lock go, boot `active` (serveActive)
//   a migration without progress for 15 min (the refresher) → our marker's explicit error `stalled`, then exit 75
//     keeping boot.lock: the next holder finds the lock stale (our pid is gone), sees the error and reverts while
//     ops/step.lock is free; a live holder is never reverted under its feet (1D-03)
//
// Timers: the refresher's interval and boot.lock's heartbeat run only while this process holds boot.lock (Passenger
// allows a timer while a lock is held). app.js bundles this module (ES2017, P1).

/** What bootPending did: booted the pending release (it serves, boot.lock held until markHealthy), reverted it and
 * booted `active`, or waits for boot.lock (another process boots it, or the revert could not be recorded yet). */
export type PendingOutcome = 'booted' | 'reverted' | 'waiting';

/** The log lines tests look for. */
const REVERTED = 'pending release reverted';
const KEPT_BUSY = 'pending release kept: ops/step.lock is busy; the revert is tried again';
const WAITING = 'another process holds releases/boot.lock; waiting';

function bootLockPath(dataDir: string) {
  return dataPath(dataDir, 'releases', 'boot.lock');
}

function now(): number {
  return Date.now();
}

function mono(): number {
  return performance.now();
}

// ---------------------------------------------------------------------------------------------------------------------
// The holder's own marker

export interface LiveMarkerOptions {
  dataDir: string;
  version: string;
  pid: number;
  startMs: number;
  log: BootLog;
  /** Epoch ms for the marker's time stamps (default Date.now). */
  clock?: () => number;
  /** Elapsed ms for the stall rule, which a step of the wall clock must not trigger (default performance.now). */
  mono?: () => number;
}

/** The marker of the process that holds boot.lock: in memory, and written to `releases/boot/<v>/<pid>-<startMs>`. */
export interface LiveMarker {
  /** A copy of the marker as it is now. */
  snapshot(): BootMarker;
  /** Elapsed ms (monotonic) since the last progress. */
  sinceProgressMs(): number;
  /** The first write (`importing`), creating the folders. @throws the write's error */
  begin(): Promise<void>;
  /** A new phase: progress, and the end of any wait. Written in the background. */
  phase(p: BootPhase): void;
  /** Progress, and the end of any wait. Written in the background. */
  progress(): void;
  /** The boot waits for its environment (§9.3): not a failure while it lasts. Written in the background. */
  waiting(reason: BootWaitReason): void;
  /** The refresh of the holder (every 10 s): `refreshedAt = at`, written. */
  refresh(at: number): Promise<void>;
  /** The attempt failed explicitly: written (and fsynced) before this resolves. */
  fail(error: NonNullable<BootMarker['error']>): Promise<void>;
  /** Resolves once every write asked for so far has been made. */
  flush(): Promise<void>;
  /** No write after this one; resolves once the last one is made. */
  close(): Promise<void>;
}

/**
 * The marker of this holder. Writes are made one at a time in the order asked, a write that is waiting taking in what
 * changed meanwhile (bursts of progress() cost one write). A write that fails is logged and the next one repairs it;
 * after the first one, a write never creates the folder again (a promotion or a revert removed it).
 */
export function createLiveMarker(o: LiveMarkerOptions): LiveMarker {
  const clock = o.clock !== undefined ? o.clock : now;
  const elapsed = o.mono !== undefined ? o.mono : mono;
  const at = clock();
  const m: BootMarker = { phase: 'importing', lastProgressAt: at, refreshedAt: at, host: lockHostIdentity(), waiting: null, error: null };
  let progressMono = elapsed();
  let closed = false;
  let queued = false;
  let chain: Promise<void> = Promise.resolve();

  function snapshot(): BootMarker {
    const error = m.error === null ? null : { detail: m.error.detail, reason: m.error.reason };
    return { phase: m.phase, lastProgressAt: m.lastProgressAt, refreshedAt: m.refreshedAt, host: m.host, waiting: m.waiting, error };
  }

  function write(): Promise<void> {
    if (closed || queued) return chain;
    queued = true;
    chain = chain.then(async () => {
      queued = false;
      if (closed) return;
      try {
        await writeMarker(o.dataDir, o.version, o.pid, o.startMs, snapshot(), { inFolder: true });
      } catch (error) {
        o.log.warn('the boot marker could not be written', { release: o.version, err: error });
      }
    });
    return chain;
  }

  function progressed(): void {
    m.lastProgressAt = clock();
    progressMono = elapsed();
    m.waiting = null;
  }

  return {
    snapshot,
    sinceProgressMs: () => elapsed() - progressMono,
    begin: () => writeMarker(o.dataDir, o.version, o.pid, o.startMs, snapshot()),
    phase(p: BootPhase): void {
      if (!isBootPhase(p) || m.error !== null) return;
      m.phase = p;
      progressed();
      void write();
    },
    progress(): void {
      if (m.error !== null) return;
      progressed();
      void write();
    },
    waiting(reason: BootWaitReason): void {
      if (!isBootWaitReason(reason) || m.error !== null) return;
      m.waiting = reason;
      void write();
    },
    refresh(at: number): Promise<void> {
      m.refreshedAt = at;
      return write();
    },
    fail(error: NonNullable<BootMarker['error']>): Promise<void> {
      m.error = { detail: error.detail, reason: error.reason };
      m.refreshedAt = clock();
      return write();
    },
    flush: () => chain,
    close(): Promise<void> {
      closed = true;
      return chain;
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The refresher

export interface RefresherOptions {
  dataDir: string;
  version: string;
  marker: LiveMarker;
  /** boot.lock: once it was taken over, nothing more is refreshed. */
  lock: { lost(): boolean };
  log: BootLog;
  /** How the process ends after a stall (default process.exit). */
  exit?: (code: number) => void;
  /** Epoch ms (default Date.now). */
  clock?: () => number;
}

export interface Refresher {
  /** Resolves once the refresh in progress, if any, is done. */
  idle(): Promise<void>;
  /** Stops refreshing; resolves once the refresh in progress, if any, is done. */
  stop(): Promise<void>;
}

/**
 * Every {@link BOOT_REFRESH_MS} while this process holds boot.lock (spec §9.3; boot.lock's own heartbeat is lock.ts's):
 * the marker's `refreshedAt`, then op.json's `heartbeatAt` (skipped while ops/step.lock is busy). A marker in
 * `migrating`, not waiting, without progress for {@link REVERT_STALL_MS} (by the monotonic clock) gets the explicit error
 * `stalled`, written and fsynced, and the process exits with {@link RESTART_EXIT_CODE} without letting boot.lock go
 * (1D-03): the next process takes the lock once ours is gone, and reverts. A lock taken over stops the refresher.
 */
export function startRefresher(o: RefresherOptions): Refresher {
  const clock = o.clock !== undefined ? o.clock : now;
  const exit = o.exit !== undefined ? o.exit : (code: number): void => process.exit(code);
  let stopped = false;
  let running: Promise<void> | null = null;

  async function tick(): Promise<void> {
    if (stopped) return;
    if (o.lock.lost()) {
      halt();
      o.log.warn('releases/boot.lock was taken over by another process; this process stops refreshing its boot marker', { release: o.version });
      return;
    }
    const at = clock();
    const m = o.marker.snapshot();
    if (m.phase === 'migrating' && m.waiting === null && o.marker.sinceProgressMs() > REVERT_STALL_MS) {
      halt();
      o.log.error('the migration of the pending release made no progress for 15 minutes; exiting, keeping releases/boot.lock for the next process to revert', {
        release: o.version,
      });
      await o.marker.fail({ detail: 'stalled', reason: 'START_FAILED' });
      exit(RESTART_EXIT_CODE);
      return;
    }
    await o.marker.refresh(at);
    try {
      await touchOpHeartbeat(o.dataDir, o.version, at);
    } catch (error) {
      o.log.warn("op.json's heartbeat could not be refreshed", { release: o.version, err: error });
    }
  }

  const timer = setInterval(() => {
    if (stopped || running !== null) return;
    running = tick().then(
      () => {
        running = null;
      },
      (error: unknown) => {
        running = null;
        o.log.warn('the boot marker refresh failed', { release: o.version, err: error });
      },
    );
  }, BOOT_REFRESH_MS);
  if (typeof timer.unref === 'function') timer.unref(); // never keeps the process alive

  function halt(): void {
    stopped = true;
    clearInterval(timer);
  }

  return {
    idle: () => (running === null ? Promise.resolve() : running),
    stop: async (): Promise<void> => {
      halt();
      if (running !== null) await running;
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Waiting for boot.lock

/** What a retry found: still waiting, or it went on (booted, reverted, served `active`, or waits again by itself). */
type RetryOutcome = 'still_waiting' | 'went_on';

/**
 * Re-reads current.json: `pending` gone (promoted or reverted by another process) → boot `active`; otherwise boot.lock
 * free (or stale) → go on with the pending boot; otherwise still waiting.
 */
async function retryBoot(s: Setup, front: Front): Promise<RetryOutcome> {
  let state: CurrentState;
  try {
    state = await readCurrentState(s.dataDir, bundledVersion());
  } catch (error) {
    s.log.warn('releases/current.json could not be read; still waiting', { err: error });
    return 'still_waiting';
  }
  let keysets: Setup['keysets'];
  try {
    keysets = await installedKeysets(s.appRoot, s.dataDir, state, s.log);
  } catch (error) {
    throw stateFailure('releases/keyset.json', error);
  }
  const next: Setup = withState(s, state, keysets);
  if (state.pending === null) {
    s.log.info('the pending release is gone (promoted or reverted); booting the active release', { active: state.active.version });
    await serveActive(next, front);
    return 'went_on';
  }
  const lock = await takeBootLock(s.dataDir);
  if (lock === null) return 'still_waiting';
  await bootHolding(next, front, lock);
  return 'went_on';
}

/**
 * Serves the minimal pages of §9.2 step 6 (waiting.ts waitingHandler: ops/current, updates/status and /admin/_update
 * from op.json and current.json, 503 for the rest) while another process holds boot.lock (or a revert waits for
 * ops/step.lock); a request, at most every {@link BOOT_RETRY_MS} and one at a time, tries again ({@link retryBoot}). A
 * retry that fails serves the rescue page.
 */
function waitForBootLock(s: Setup, front: Front): void {
  s.log.info(WAITING, { release: s.state.pending === null ? null : s.state.pending.version });
  let last = mono();
  let busy = false;
  let done = false;
  const onRequest = (): void => {
    if (busy || done || mono() - last < BOOT_RETRY_MS) return;
    busy = true;
    retryBoot(s, front).then(
      (outcome) => {
        busy = false;
        last = mono();
        if (outcome === 'went_on') done = true;
      },
      (error: unknown) => {
        busy = false;
        done = true;
        rescueOnFront(s.log, front, error);
      },
    );
  };
  void front.use(waitingHandler({ dataDir: s.dataDir, log: s.log, onRequest }));
}

// ---------------------------------------------------------------------------------------------------------------------
// The boot of the pending release

/** A copy of `s` with another state (and its keysets): ES2017, no object spread. */
function withState(s: Setup, state: CurrentState, keysets: Setup['keysets']): Setup {
  return {
    appRoot: s.appRoot,
    script: s.script,
    argv: s.argv,
    cli: s.cli,
    log: s.log,
    env: s.env,
    dataDir: s.dataDir,
    runtime: s.runtime,
    port: s.port,
    state,
    roots: s.roots,
    keysets,
  };
}

/**
 * A step on the state files of the pending boot (boot.lock, the markers, op.json, current.json): an error of it is the
 * installation's (STATE_CORRUPT, DATA_DIR_UNWRITABLE), never the release's, and the rescue page says so.
 */
async function stateStep<T>(what: string, step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (error) {
    throw error instanceof BootFailure ? error : stateFailure(what, error);
  }
}

/** Takes releases/boot.lock if it is free or stale (null while another process holds it). */
function takeBootLock(dataDir: string): Promise<HeldFileLockHandle | null> {
  return stateStep('releases/boot.lock', () => acquireFileLock(bootLockPath(dataDir), { staleMs: BOOT_LOCK_STALE_MS }));
}

/** Whether boot.lock is still this process's (read from the file, L11). */
function stillHeld(lock: HeldFileLockHandle): boolean {
  try {
    lock.assertHeld();
    return true;
  } catch {
    return false;
  }
}

/** The detail a revert reports: the explicit error of an attempt, else the settled op's, else `repeated`. */
function revertDetail(attempts: AttemptCount, op: { settled: boolean; detail: string | null } | null): PendingFailureDetail {
  if (isPendingFailureDetail(attempts.explicit)) return attempts.explicit;
  if (op !== null && isPendingFailureDetail(op.detail)) return op.detail;
  return 'repeated';
}

/**
 * The revert of the pending release `pending` by the holder of boot.lock: op.json first (S3), then `pending = null`,
 * the markers removed and boot.lock let go, then `active` in this process. A busy ops/step.lock keeps everything as it
 * is but boot.lock, and waits. A lock taken over meanwhile is not ours to act on: wait.
 */
async function revertPending(s: Setup, front: Front, lock: HeldFileLockHandle, pending: ReleaseRef, detail: PendingFailureDetail): Promise<PendingOutcome> {
  if (!stillHeld(lock)) {
    s.log.warn('releases/boot.lock was taken over meanwhile; this process does not revert, it waits', { release: pending.version });
    waitForBootLock(s, front);
    return 'waiting';
  }
  const record = await stateStep('ops/op.json', () =>
    recordPendingFailure(s.dataDir, pending.version, { code: 'UPDATE_BOOT_FAILED', detail }, now()),
  );
  if (record === 'busy') {
    s.log.warn(KEPT_BUSY, { release: pending.version, detail });
    await stateStep('releases/boot.lock', () => lock.release());
    waitForBootLock(s, front);
    return 'waiting';
  }
  const result = await stateStep('releases/current.json', () =>
    updateCurrentState(s.dataDir, (state) =>
      state.pending !== null && state.pending.version === pending.version
        ? { schema: 1, active: state.active, previous: state.previous, pending: null, pendingSince: null, pinned: state.pinned }
        : null,
    ),
  );
  await stateStep('releases/boot', () => removeMarkers(s.dataDir, pending.version));
  await stateStep('releases/boot.lock', () => lock.release());
  s.log.warn(REVERTED, { release: pending.version, detail, opRecord: record, active: result.state.active.version });
  const next = withState(s, result.state, s.keysets);
  if (result.state.pending !== null) return bootPending(next, front); // another release is pending now
  await serveActive(next, front);
  return 'reverted';
}

/**
 * markHealthy() of the pending release: under boot.lock (still ours, L11), promote it (current.ts promote); a call
 * after the promotion is harmless. Then the refresher stops, the markers go and boot.lock is let go.
 *
 * @throws Error when the release is no longer pending nor active (a revert took it away), DomainError `lock_lost` when
 *   boot.lock was taken over, and the errors of the state files
 */
async function promoteHeld(s: Setup, pending: ReleaseRef, lock: HeldFileLockHandle, marker: LiveMarker, refresher: Refresher): Promise<void> {
  lock.assertHeld();
  if ((await promote(s.dataDir, pending.version)) === 'not_pending') {
    const state = await readJsonWithBak(dataPath(s.dataDir, 'releases', 'current.json'), parseCurrentState);
    if (state === null || state.active.version !== pending.version) {
      throw new Error('markHealthy: release ' + pending.version + ' is no longer pending; it was reverted');
    }
  }
  await refresher.stop();
  await marker.close();
  await removeMarkers(s.dataDir, pending.version);
  await lock.release();
  s.log.info('the pending release is healthy and was promoted', { release: pending.version });
}

/** The context additions of the pending boot (contract v1, additive): pendingBoot, the live marker, the promotion. */
function pendingExtras(s: Setup, pending: ReleaseRef, lock: HeldFileLockHandle, marker: LiveMarker, refresher: Refresher): ContextExtras {
  let promotion: Promise<void> | null = null;
  const bootMarker: BootContext['bootMarker'] = {
    phase: (p) => marker.phase(p),
    progress: () => marker.progress(),
    waiting: (reason) => marker.waiting(reason),
  };
  return {
    pendingBoot: true,
    bootMarker,
    markHealthy: (): Promise<void> => {
      if (promotion === null) {
        promotion = promoteHeld(s, pending, lock, marker, refresher).catch((error: unknown) => {
          promotion = null;
          throw error;
        });
      }
      return promotion;
    },
  };
}

/** The pending boot once this process holds boot.lock (see the top of this file). */
async function bootHolding(s: Setup, front: Front, lock: HeldFileLockHandle): Promise<PendingOutcome> {
  const pending = s.state.pending as ReleaseRef;
  let marker: LiveMarker | null = null;
  let refresher: Refresher | null = null;
  try {
    const at = now();
    const markers = await stateStep('releases/boot', () => readMarkers(s.dataDir, pending.version));
    const attempts = classifyAttempts(markers, at, attemptEnded);
    const op = await stateStep('ops/op.json', () => readUpdateOpFor(s.dataDir, pending.version));
    s.log.info('releases/boot.lock taken for the pending release', { release: pending.version, attempts, op });
    if (attempts.explicit !== null || attempts.failed >= REVERT_FAILED_BOOTS || (op !== null && op.settled)) {
      return await revertPending(s, front, lock, pending, revertDetail(attempts, op)); // never imported (B8)
    }

    marker = createLiveMarker({ dataDir: s.dataDir, version: pending.version, pid: process.pid, startMs: processStartMs(), log: s.log });
    const live = marker;
    await stateStep('releases/boot', () => live.begin());
    refresher = startRefresher({ dataDir: s.dataDir, version: pending.version, marker, lock, log: s.log });
    try {
      const loaded = await load(s, pending);
      await startLoaded(s, front, loaded, pendingExtras(s, pending, lock, marker, refresher));
    } catch (error) {
      if (!(error instanceof BootFailure)) throw error;
      const detail = error.stage === null ? 'start' : error.stage;
      s.log.error('the pending release failed', { release: pending.version, detail, reason: error.reason, err: error });
      await refresher.stop();
      await marker.fail({ detail, reason: error.reason });
      await marker.close();
      return await revertPending(s, front, lock, pending, detail);
    }
    return 'booted';
  } catch (error) {
    // Not the release's failure (a state file could not be used): let boot.lock go so that another process can try,
    // and leave the rescue page to the caller.
    if (refresher !== null) await refresher.stop().catch(() => undefined);
    if (marker !== null) await marker.close().catch(() => undefined);
    await lock.release().catch(() => false);
    throw error;
  }
}

/**
 * Step 8 when current.json names a `pending` release (see the top of this file).
 *
 * @throws BootFailure when, after a revert, no release could be started; the errors of the state files (the caller
 *   serves the rescue page)
 */
export async function bootPending(s: Setup, front: Front): Promise<PendingOutcome> {
  const lock = await takeBootLock(s.dataDir);
  if (lock === null) {
    waitForBootLock(s, front);
    return 'waiting';
  }
  return bootHolding(s, front, lock);
}
