import { dataPath, parseCurrentState, readJsonWithBak, restartRequestedSince, type CurrentState, type Runtime } from '@altis/platform';
import { isDomainError } from '@altis/shared';
import type { LogFields, Logger } from '../logger.js';
import { loggableError } from '../safe-error.js';

// The release part of the fence of spec §9.3 ("setiap 2 detik … Versi berbeda → berhenti mengklaim tugas, drain,
// restart (P14)"; plan Task 25; decision D1d-20; preflight 1D-21): which release this process should be, compared with
// which release it is.
//
// - The fence compares `{active.version, pending?.version}` of DATA_DIR/releases/current.json with this process's
//   snapshot, never with the release it runs: a process that fell back to `previous` (its `active` failed to load) is
//   not restarted in a loop. The snapshot is taken by `rebase()` (start() at the beginning of its boot, and again after
//   this process's own promotion or revert) or, without one, by the first look.
// - It looks at most once per `intervalMs` (2 s), from requests (app.ts step 4, once the app is ready) and from the
//   worker loop before each pass (jobs/runtime.ts), never on a timer (Passenger runs none). Concurrent checks share one
//   look. A look that cannot read current.json keeps the snapshot (logged once until a read works again), so the fence
//   never rejects.
// - A change calls `onChange` once per version (`pending ?? active` of the new state): the update's point of no return
//   and the promotion of that same pending release are one change, not two. `changed()` is true from then on, until a
//   rebase; the job runtime claims nothing while it is.
// - {@link releaseRestart} is what start() does on a change: the job runtime stops claiming and drains, then
//   `ctx.requestRestart('release')`, unless, under Passenger or LiteSpeed, `<appRoot>/tmp/restart.txt` was touched at
//   or after `pendingSince` (restartRequestedSince): the pool restarts after that touch already (the update's
//   `switched` step made it), and touching it again once the boot-lock holder has spawned would restart the holder as
//   well, which counts as a failed boot of the pending release (1D-21). Elsewhere (PM2, Docker, a service, standalone)
//   restart.txt restarts nothing, so every process asks for its own restart.

/** The release state a change reports. */
export interface ReleaseChange {
  active: string;
  pending: string | null;
  /** current.json's `pendingSince` (epoch ms), null without `pending`. */
  pendingSince: number | null;
}

export interface ReleaseFenceOptions {
  dataDir: string;
  /** Epoch ms. */
  clock(): number;
  /** The shortest time between two looks (default 2000 ms). */
  intervalMs?: number;
  /** current.json moved away from the snapshot (once per version, see the top of this file). A throw is logged. */
  onChange(change: ReleaseChange): void;
  log?: Logger;
}

export interface ReleaseFence {
  /** Looks at current.json when `intervalMs` passed since the last look (or the clock went back). Never rejects. */
  check(): Promise<void>;
  /** Looks now and takes what current.json says as the snapshot (no change fired; `changed()` false). Never rejects. */
  rebase(): Promise<void>;
  /** A change was seen since the last rebase. */
  changed(): boolean;
}

const DEFAULT_INTERVAL_MS = 2000;

const silentLogger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => silentLogger };

function errorFields(error: unknown): LogFields {
  if (isDomainError(error)) return { code: error.code, reason: error.meta?.['reason'] as string | undefined };
  return { error: loggableError(error) };
}

/** What the fence compares. */
interface Snapshot {
  active: string;
  pending: string | null;
}

/**
 * The release fence of one process (see the top of this file).
 *
 * @throws TypeError for an `intervalMs` that is not a finite number of at least 0
 */
export function createReleaseFence(o: ReleaseFenceOptions): ReleaseFence {
  const intervalMs = o.intervalMs ?? DEFAULT_INTERVAL_MS;
  if (!Number.isFinite(intervalMs) || intervalMs < 0) throw new TypeError('createReleaseFence: intervalMs must be a finite number of at least 0');
  const log = o.log ?? silentLogger;
  let snapshot: Snapshot | null = null;
  let lastLookAt: number | null = null;
  let running: Promise<void> | undefined;
  /** The versions a change was fired for since the last rebase. */
  const fired = new Set<string>();
  let failing = false;

  /** current.json (or its `.bak`); null when there is none, or it cannot be read (logged once until it can). */
  async function read(): Promise<CurrentState | null> {
    try {
      const state = await readJsonWithBak(dataPath(o.dataDir, 'releases', 'current.json'), parseCurrentState);
      failing = false;
      return state;
    } catch (error) {
      if (!failing) log.error('release fence: releases/current.json cannot be read; the snapshot is kept', errorFields(error));
      failing = true;
      return null;
    }
  }

  async function look(rebase: boolean): Promise<void> {
    const state = await read();
    if (state === null) return;
    const seen: Snapshot = { active: state.active.version, pending: state.pending?.version ?? null };
    if (rebase || snapshot === null) {
      snapshot = seen;
      fired.clear();
      return;
    }
    if (seen.active === snapshot.active && seen.pending === snapshot.pending) return;
    const version = seen.pending ?? seen.active;
    if (fired.has(version)) return;
    fired.add(version);
    log.warn('release fence: current.json names another release than this process booted with', {
      snapshotActive: snapshot.active,
      snapshotPending: snapshot.pending,
      active: seen.active,
      pending: seen.pending,
    });
    try {
      o.onChange({ active: seen.active, pending: seen.pending, pendingSince: state.pendingSince });
    } catch (error) {
      log.error('release fence: onChange failed', errorFields(error));
    }
  }

  function shared(fn: () => Promise<void>): Promise<void> {
    running = fn().finally(() => {
      running = undefined;
    });
    return running;
  }

  return {
    check() {
      if (running !== undefined) return running;
      const now = o.clock();
      // A clock that went back counts as due.
      if (lastLookAt !== null && now >= lastLookAt && now - lastLookAt < intervalMs) return Promise.resolve();
      lastLookAt = now;
      return shared(() => look(false));
    },
    async rebase() {
      if (running !== undefined) await running;
      lastLookAt = o.clock();
      return shared(() => look(true));
    },
    changed: () => fired.size > 0,
  };
}

/** What {@link releaseRestart} needs from its process. */
export interface ReleaseRestartOptions {
  /** The folder of app.js (its `tmp/restart.txt`). */
  appRoot: string;
  /** The runtime of this process: only Passenger and LiteSpeed restart through `tmp/restart.txt`. */
  runtime: Runtime;
  /** `ctx.requestRestart`. */
  requestRestart(reason: string): Promise<void>;
  /** The job runtime's drain (no new claim, the running slices waited for); a no-op without one. */
  stopClaims(): Promise<void>;
  log: Logger;
}

/**
 * What a process does once its release fence saw a change (see the top of this file): stop claiming and drain, then ask
 * for a restart, unless (Passenger, LiteSpeed) `<appRoot>/tmp/restart.txt` was touched at or after the change's
 * `pendingSince`. Never throws (a failure is logged).
 *
 * @returns `'skipped'` when restart.txt said the pool restarts already, `'requested'` otherwise
 */
export function releaseRestart(o: ReleaseRestartOptions): (change: ReleaseChange) => Promise<'requested' | 'skipped'> {
  return async (change) => {
    try {
      await o.stopClaims();
    } catch (error) {
      o.log.warn('release fence: the job runtime could not be drained', errorFields(error));
    }
    const touchRestarts = o.runtime === 'passenger' || o.runtime === 'litespeed';
    if (touchRestarts && change.pendingSince !== null && (await restartRequestedSince(o.appRoot, change.pendingSince))) {
      o.log.info('release fence: tmp/restart.txt was touched since the update began; the restart it asked for replaces this process', {
        pending: change.pending,
      });
      return 'skipped';
    }
    o.log.warn('release fence: restart requested', { active: change.active, pending: change.pending });
    try {
      await o.requestRestart('release');
    } catch (error) {
      o.log.error('release fence: requestRestart failed', errorFields(error));
    }
    return 'requested';
  };
}
