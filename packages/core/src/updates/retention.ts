import {
  dataPath,
  ensureDir,
  isReleaseStagingName,
  listNames,
  parseCurrentState,
  readJsonWithBak,
  releaseStagingPath,
  removeTree,
  statOrNull,
  withFileLock,
  type CurrentState,
  type HeldFileLock,
} from '@altis/platform';
import { isDomainError, isSemver, isTerminal } from '@altis/shared';
import { z } from 'zod';
import { errorFields, type CoreLogger } from '../context.js';
import type { JobHandler } from '../jobs/types.js';
import { readOpFile, stepLockPath, type OpFile } from '../ops/files.js';

// Release retention and the staging sweep (spec §9.3 "Retensi: simpan `active`, `previous`, `pending`, `pinned`;
// sisanya dihapus setelah boot sehat. `.tmp-*` dihapus saat boot"; plan Task 27; decisions D1d-16, D1d-23; preflight
// 1D-20). Both live in server.mjs, so a later release can change them; app.js stays minimal.
//
// - releaseRetention keeps every `releases/<v>` folder current.json names (active, previous, pending, pinned) and the
//   target of an update op that has not ended: between `backed_up` and `switched` that folder is named by nothing else
//   (current.json gets `pending` only at `switched`), so a retention that looked earlier must not take it (1D-20). An op
//   in `needs_attention` has not ended. Every other SemVer folder goes; nothing else in `releases/` is touched.
// - sweepReleaseStaging removes every `.tmp-<v>-<opId>` folder except the one of an update op that has not ended
//   (D1d-16): what a killed download, extraction, bundled copy or adoption left behind.
// - runReleaseRetention (the `release.retention` job, enqueued after each healthy boot) and the boot's sweep read op.json
//   and current.json and remove folders under `ops/step.lock`, the lock every op step and `begin` hold: no update step
//   can rename a release into place, or create its staging folder, between the look and the removal (P6, P7). A busy
//   lock postpones the work; an op.json that cannot be read, or a current.json that is missing or unusable, removes
//   nothing (fail closed).

/** How long the retention job waits for `ops/step.lock` (a step holds it ≤ 20 s). */
export const RETENTION_LOCK_WAIT_MS = 5_000;
/** How long the boot's sweep waits for `ops/step.lock` before it leaves the sweep to the next boot. */
export const SWEEP_LOCK_WAIT_MS = 1_000;
/** A retention slice that found the lock busy runs again this much later. */
const RETENTION_RETRY_MS = 30_000;

/** Whether `op` is an update op that has not ended (`needs_attention` has not ended). */
function liveUpdate(op: OpFile | null): op is OpFile {
  return op !== null && op.kind === 'update' && !isTerminal(op.kind, op.state);
}

/** The version an update op that has not ended installs, or null. */
function liveTarget(op: OpFile | null): string | null {
  if (!liveUpdate(op)) return null;
  const target = op.params['target'];
  return typeof target === 'string' && isSemver(target) ? target : null;
}

/** The SemVer folders of `releases/` (the release folders; never `boot/`, a staging folder or a file). */
async function releaseFolders(dataDir: string): Promise<string[]> {
  const out: string[] = [];
  for (const name of await listNames(dataPath(dataDir, 'releases'))) {
    if (!isSemver(name)) continue;
    if ((await statOrNull(dataPath(dataDir, 'releases', name)))?.kind === 'dir') out.push(name);
  }
  return out;
}

/**
 * Removes the `releases/<v>` folders that neither `o.state` (active, previous, pending, pinned) nor the update op
 * `o.activeOp` (when it has not ended: its `params.target`) names (see the top of this file). The caller holds
 * `ops/step.lock` (or knows no op can step meanwhile); {@link runReleaseRetention} does both.
 *
 * @returns the versions removed, sorted
 * @throws the I/O error of a listing or a removal (the folders removed before it are gone)
 */
export async function releaseRetention(o: { dataDir: string; state: CurrentState; activeOp: OpFile | null }): Promise<{ removed: string[] }> {
  const keep = new Set<string>([o.state.active.version]);
  if (o.state.previous !== null) keep.add(o.state.previous.version);
  if (o.state.pending !== null) keep.add(o.state.pending.version);
  if (o.state.pinned !== null) keep.add(o.state.pinned);
  const target = liveTarget(o.activeOp);
  if (target !== null) keep.add(target);
  const removed: string[] = [];
  for (const version of await releaseFolders(o.dataDir)) {
    if (keep.has(version)) continue;
    await removeTree(dataPath(o.dataDir, 'releases', version));
    removed.push(version);
  }
  return { removed: removed.sort() };
}

/**
 * Removes every staging folder `releases/.tmp-<v>-<opId>` except the one of the update op `activeOp` when it has not
 * ended (D1d-16). Names that are not a staging folder's are left alone. The caller holds `ops/step.lock` (the boot's
 * sweep, {@link sweepStagingLocked}).
 *
 * @returns the names removed, sorted
 * @throws the I/O error of a listing or a removal
 */
export async function sweepReleaseStaging(dataDir: string, activeOp: OpFile | null): Promise<string[]> {
  const live = liveUpdate(activeOp) ? activeOp.opId : null;
  const removed: string[] = [];
  for (const name of await listNames(dataPath(dataDir, 'releases'))) {
    const staging = isReleaseStagingName(name);
    if (staging === null || staging.opId === live) continue;
    await removeTree(releaseStagingPath(dataDir, staging.version, staging.opId));
    removed.push(name);
  }
  return removed.sort();
}

/** current.json (or its `.bak`) as it is now, read-only; null when neither exists or neither is usable. */
async function currentStateOrNull(dataDir: string, log: CoreLogger): Promise<CurrentState | null> {
  try {
    return await readJsonWithBak(dataPath(dataDir, 'releases', 'current.json'), parseCurrentState);
  } catch (error) {
    log.warn('retention: current.json cannot be read; no release folder is removed', errorFields(error));
    return null;
  }
}

/** Whether `error` is a lock that stayed held for the whole wait (`STATE_CORRUPT` `lock_timeout`). */
export function isLockTimeout(error: unknown): boolean {
  return isDomainError(error) && error.code === 'STATE_CORRUPT' && error.meta?.['reason'] === 'lock_timeout';
}

/**
 * `fn` under `ops/step.lock` (the lock of every op step and `begin`, files.ts), `ops/` created when missing.
 *
 * @throws DomainError `STATE_CORRUPT` `lock_timeout` when the lock stays held for `waitMs`; `fn`'s own error
 */
export async function withStepLock<T>(dataDir: string, fn: (lock: HeldFileLock) => Promise<T>, waitMs: number): Promise<T> {
  await ensureDir(dataPath(dataDir, 'ops'));
  return withFileLock(stepLockPath(dataDir), fn, { waitMs });
}

/** What {@link runReleaseRetention} did: `busy` when `ops/step.lock` stayed held; `unreadable` when it removed nothing for want of op.json or current.json. */
export type RetentionRun = { busy: boolean; removed: string[]; unreadable?: true };

/**
 * Release retention under `ops/step.lock` (see the top of this file): op.json and current.json read there, then
 * {@link releaseRetention}. Nothing is removed when the lock stays held for `o.waitMs` (default
 * {@link RETENTION_LOCK_WAIT_MS}: `busy`), when op.json cannot be read, or when current.json is missing or unusable.
 *
 * @throws the I/O error of a removal; a lock lost meanwhile (`STATE_CORRUPT` `lock_lost`)
 */
export async function runReleaseRetention(dataDir: string, o: { log: CoreLogger; waitMs?: number }): Promise<RetentionRun> {
  try {
    return await withStepLock(
      dataDir,
      async (lock) => {
        const op = await readOpFile(dataDir);
        const state = await currentStateOrNull(dataDir, o.log);
        if (op === 'corrupt' || state === null) {
          if (op === 'corrupt') o.log.warn('retention: op.json cannot be read; no release folder is removed');
          return { busy: false, removed: [], unreadable: true };
        }
        lock.assertHeld();
        const { removed } = await releaseRetention({ dataDir, state, activeOp: op });
        if (removed.length > 0) o.log.info('retention: release folders removed', { removed });
        return { busy: false, removed };
      },
      o.waitMs ?? RETENTION_LOCK_WAIT_MS,
    );
  } catch (error) {
    if (isLockTimeout(error)) return { busy: true, removed: [] };
    throw error;
  }
}

/**
 * The boot's staging sweep (D1d-16, D1d-23) under `ops/step.lock`: op.json read there, then
 * {@link sweepReleaseStaging}. Best effort: a busy lock (`busy`), an op.json that cannot be read or any failure removes
 * what it could and is logged, never thrown, so the boot goes on.
 */
export async function sweepStagingLocked(dataDir: string, log: CoreLogger, waitMs = SWEEP_LOCK_WAIT_MS): Promise<string[] | 'busy'> {
  try {
    return await withStepLock(
      dataDir,
      async (lock) => {
        const op = await readOpFile(dataDir);
        if (op === 'corrupt') {
          log.warn('sweep: op.json cannot be read; no staging folder is removed');
          return [];
        }
        lock.assertHeld();
        const removed = await sweepReleaseStaging(dataDir, op);
        if (removed.length > 0) log.info('sweep: staging folders removed', { removed });
        return removed;
      },
      waitMs,
    );
  } catch (error) {
    if (isLockTimeout(error)) return 'busy';
    log.warn('sweep: the staging folders could not be swept; the next boot tries again', errorFields(error));
    return [];
  }
}

/**
 * The `release.retention` job (payload `{}`, permission `system.update.run`, retried only by the code that enqueued
 * it): one {@link runReleaseRetention}; a busy `ops/step.lock` queues it again 30 s later.
 */
export function releaseRetentionJob(deps: () => { dataDir: string }): JobHandler<Record<string, never>> {
  return {
    type: 'release.retention',
    permission: 'system.update.run',
    retryable: 'origin-only',
    payload: z.strictObject({}),
    async run(ctx) {
      const run = await runReleaseRetention(deps().dataDir, { log: ctx.log });
      if (run.busy) return { waitUntil: ctx.now() + RETENTION_RETRY_MS, message: 'busy' };
      return { done: true, message: `removed ${run.removed.length}` };
    },
  };
}
