import { COMPLETE_FILE } from '@altis/crypto';
import { readSchemaMetaMirror, withTx, type DbHandle } from '@altis/db';
import {
  acquireFileLock,
  dataPath,
  ensureDir,
  realPathOf,
  releaseDir,
  removeTree,
  updateCurrentState,
  type CurrentState,
  type HeldFileLockHandle,
  type ReleaseRef,
} from '@altis/platform';
import { DomainError, NEEDS_ATTENTION, compareSemver, isDomainError, isSemver, isTerminal } from '@altis/shared';
import { z } from 'zod';
import { errorFields, txCtx } from '../context.js';
import type { notify as notifyFn } from '../notifications/service.js';
import { effectiveState } from '../ops/boot-plan.js';
import { readOpFile, writeOpFile, type OpActor, type OpFile } from '../ops/files.js';
import { withControlLock, type OpHandle, type OpKindHandler, type OpStepContext, type OpsMachine } from '../ops/machine.js';
import { actorOf } from '../restore/finalize.js';
import { RELEASE_LOG_FINAL, insertReleaseLog, readReleaseLog, setReleaseLogStatus } from './releases-log.js';

// The manual rollback (spec §9.7 "Manual (tombol/`release:rollback`)"; plan Task 26; decision D1d-33; preflight
// 1D-02, 1D-03, 1D-22) and the command line's revert of a pending release.
//
// - rollbackAvailability: whether `previous` can run again: it exists (`previous` set, its folder with `.complete`),
//   the database allows it (schema-meta.json's `minCodeVersion` ≤ previous, §9.7 "target ≥ min_code_version") and no
//   update is pending (that one is reverted, not rolled back). Pembaruan disables its button with the reason (§9.7).
// - rollbackKind, the `rollback` op (`running` → `done` | `failed`; no maintenance, no freeze: pointers only):
//     running  current.json already flipped (`active` = the target, pinned = the version left; a process killed after
//              the flip, 1D-22) → the end: releases_log `done`, `update.rollback {from, to}` and `update_rolled_back`
//              written once (only while the row is not final), a restart requested → `done`.
//              Else the availability again (and the database's own `min_code_version`): refused → `failed` with 409
//              ROLLBACK_UNAVAILABLE and its reason, the row (if any) `failed`.
//              Else, the first time: the releases_log row (`rollback`, version = the target, from = the version left)
//              and `params.flipping = true`, a checkpoint written to op.json before current.json changes; it is the
//              op's point of no return (no cancel after it; a step that throws goes to needs_attention, and resume
//              finishes the rollback).
//              Then: current.json `active = previous`, `previous = null`, `pinned = <the version left>` under
//              current.lock, and the end as above → `done`.
//   Every step is idempotent (P7): the flip is recognised by the pointers, the end by the row's final status.
// - revertPending: `release:rollback` while `pending` is set (D1d-33), app.js's revert from the command line. It takes
//   `releases/boot.lock` itself (stale after 60 s, as app.js's), so no process boots the pending release meanwhile: a
//   live holder (its process there and the lock refreshed within 60 s, §9.3) is booting or migrating it → 409
//   RELEASE_PENDING, nothing changed; `force` waits for that holder to go, polling every 5 s for at most 15 min
//   (1D-03). Under `ops/step.lock` (ahead of the steppers, withControlLock) the update op of the pending version, judged
//   by its effective state (1D-02), moves to `reverting` with UPDATE_BOOT_FAILED `operator`; only once it is recorded
//   (or no op matches) is `pending` cleared (Review Focus 1: never cleared unrecorded) and its boot markers removed.
//   A busy step lock → 409 RELEASE_PENDING with nothing changed. The release that stays steps the op on (`reverting`
//   → `rolled_back`, or the "terlalu lama" restore, Task 25).

/** A rollback is refused for this reason (PROBLEM_REASONS of ROLLBACK_UNAVAILABLE). */
export type RollbackUnavailableReason = 'no_previous' | 'incompatible' | 'missing' | 'pending';

/** Whether the manual rollback can run now, and to which version. */
export interface RollbackAvailability {
  available: boolean;
  /** Why not; null when available. */
  reason: RollbackUnavailableReason | null;
  /** The version a rollback goes back to (`previous`), or null without one. */
  target: string | null;
}

/** What the rollback kind needs from its process (a subset of the update kind's deps, so either may be passed). */
export interface RollbackKindDeps {
  dataDir: string;
  /** The folder of app.js (`bundled-release/<v>` lives there); '' for none. */
  appRoot: string;
  requestRestart(reason: string): Promise<void>;
  notify: typeof notifyFn;
}

/** `op.params` of a rollback op: what `begin` gave (`target` = previous, `from` = active), then the checkpoint. */
export type RollbackParams = {
  target: string;
  from: string;
  /** The releases_log row is written: the next step flips current.json. */
  flipping?: boolean;
};

/** `releases/boot.lock` is stale after this long without a refresh (spec §9.3; app.js's BOOT_LOCK_STALE_MS). */
const BOOT_LOCK_STALE_MS = 60_000;
/** `force`: how often the holder of boot.lock is looked at again (1D-03). */
const WAIT_POLL_MS = 5000;
/** `force`: the longest wait for the holder of boot.lock (1D-03: at most 15 min). */
const WAIT_MAX_MS = 900_000;
/** How long the revert waits for `ops/step.lock` (a step under way stops after its handler step, withControlLock). */
const STEP_LOCK_WAIT_MS = 15_000;

/** Where the rollback notification leads. */
const UPDATES_LINK = '/admin/updates';

/** The states in which the target boots, after the point of no return (app.js's op-record.ts BOOT_STATES). */
const BOOT_STATES: ReadonlySet<string> = new Set(['switched', 'booting', 'migrating', 'verifying']);

const semver = z
  .string()
  .max(64)
  .refine((v) => isSemver(v), 'not SemVer');

/** Loose (as the update op's, S21): a later release's fields are kept and written back. */
const rollbackParamsSchema = z.looseObject({ target: semver, from: semver, flipping: z.boolean().optional() });

/**
 * The params of a rollback op (see {@link RollbackParams}), unknown fields kept.
 *
 * @throws TypeError when they are not a rollback op's
 */
export function parseRollbackParams(raw: unknown): RollbackParams {
  const parsed = rollbackParamsSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new TypeError(`rollback op: the params are not valid (${issue === undefined ? 'shape' : `${issue.path.join('.')}: ${issue.message}`})`);
  }
  return parsed.data as unknown as RollbackParams;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** current.json as it is now, read under current.lock (nothing written). */
async function readState(dataDir: string): Promise<CurrentState> {
  return (await updateCurrentState(dataDir, () => null)).state;
}

/**
 * Whether the release folder of `ref` (`<appRoot>/bundled-release/<v>` or `DATA_DIR/releases/<v>`) holds `.complete`.
 * A bundled release without an app folder, or a folder that cannot be looked at, counts as absent.
 */
async function releaseComplete(appRoot: string, dataDir: string, ref: ReleaseRef): Promise<boolean> {
  if (ref.source === 'bundled' && appRoot === '') return false;
  try {
    return (await realPathOf(`${releaseDir(appRoot, dataDir, ref)}/${COMPLETE_FILE}`)) !== null;
  } catch {
    return false;
  }
}

/**
 * The `minCodeVersion` of schema-meta.json: null when there is no mirror yet (nothing was migrated; the release checks
 * the database itself when it starts, as app.js's fallback rule), `'unreadable'` when the file and its `.bak` cannot be
 * used (then nothing counts as compatible, as app.js's previousIsCompatible).
 */
async function mirrorMinCode(dataDir: string): Promise<string | null | 'unreadable'> {
  try {
    return (await readSchemaMetaMirror(dataDir))?.minCodeVersion ?? null;
  } catch {
    return 'unreadable';
  }
}

/** {@link rollbackAvailability} plus the minimum code version that refused it (for the message). */
async function availabilityOf(dataDir: string, state: CurrentState, appRoot: string): Promise<RollbackAvailability & { minCodeVersion?: string }> {
  const previous = state.previous;
  const target = previous === null ? null : previous.version;
  if (state.pending !== null) return { available: false, reason: 'pending', target };
  if (previous === null) return { available: false, reason: 'no_previous', target: null };
  if (!(await releaseComplete(appRoot, dataDir, previous))) return { available: false, reason: 'missing', target: previous.version };
  const min = await mirrorMinCode(dataDir);
  if (min === 'unreadable') return { available: false, reason: 'incompatible', target: previous.version };
  if (min !== null && compareSemver(previous.version, min) < 0) {
    return { available: false, reason: 'incompatible', target: previous.version, minCodeVersion: min };
  }
  return { available: true, reason: null, target: previous.version };
}

/**
 * Whether the manual rollback of the installation whose current.json is `state` can run now (spec §9.7): `pending`
 * set → `pending` (the pending release is reverted instead, `release:rollback`); no `previous` → `no_previous`; its
 * folder (`<appRoot>/bundled-release/<v>` or `DATA_DIR/releases/<v>`, releaseDir) without `.complete` → `missing`;
 * schema-meta.json's `minCodeVersion` above `previous` (or the mirror unreadable) → `incompatible`. `target` is
 * `previous`'s version whenever there is one.
 */
export async function rollbackAvailability(dataDir: string, state: CurrentState, appRoot: string): Promise<RollbackAvailability> {
  const a = await availabilityOf(dataDir, state, appRoot);
  return { available: a.available, reason: a.reason, target: a.target };
}

/** 409 ROLLBACK_UNAVAILABLE with `reason` and a message that says why. */
export function rollbackUnavailable(reason: RollbackUnavailableReason, o: { target?: string | null; minCodeVersion?: string; pending?: string | null } = {}): DomainError {
  const v = o.target ?? '-';
  let detail: string;
  switch (reason) {
    case 'no_previous':
      detail = 'Tidak ada versi sebelumnya untuk dikembalikan / There is no previous version to go back to';
      break;
    case 'missing':
      detail = `Folder rilis ${v} tidak ada atau tidak lengkap / The folder of release ${v} is missing or incomplete`;
      break;
    case 'incompatible':
      detail =
        o.minCodeVersion === undefined
          ? `Database tidak lagi cocok dengan versi ${v} / The database no longer fits version ${v}`
          : `Database memerlukan ALTIS ${o.minCodeVersion} atau lebih baru; versi ${v} terlalu lama / ` +
            `The database needs ALTIS ${o.minCodeVersion} or newer; version ${v} is too old`;
      break;
    case 'pending': {
      const p = o.pending ?? '-';
      detail =
        `Pembaruan ke ${p} sedang tertunda; batalkan dengan: node app.js release:rollback / ` +
        `An update to ${p} is pending; revert it with: node app.js release:rollback`;
      break;
    }
  }
  return new DomainError('ROLLBACK_UNAVAILABLE', { detail, meta: { reason } });
}

/** What op.json records of a refusal: the code, the detail and the registered reason (op.json's error is loose). */
function errorOf(error: DomainError): NonNullable<OpFile['error']> & { reason?: string } {
  const out: NonNullable<OpFile['error']> & { reason?: string } = { code: error.code };
  if (error.detail !== undefined) out.detail = error.detail;
  const reason = error.meta?.['reason'];
  if (typeof reason === 'string') out.reason = reason;
  return out;
}

/** This process's handle, or the op's dedicated connection (P17). */
async function dbOf(ctx: OpStepContext): Promise<DbHandle> {
  return ctx.db() ?? (await ctx.connectDedicated());
}

/** `schema_meta.min_code_version` of the database, or null when it records none. */
async function databaseMinCode(h: DbHandle): Promise<string | null> {
  const row = await h.db.selectFrom('schema_meta').select('min_code_version').where('id', '=', 1).executeTakeFirst();
  const version = row?.min_code_version;
  return typeof version === 'string' && isSemver(version) ? version : null;
}

/** Whether current.json already shows this rollback done: `active` is the target and the version left is pinned. */
function flipped(s: CurrentState, p: RollbackParams): boolean {
  if (s.active.version !== p.target || s.pending !== null) return false;
  // The pin is the flip's own mark; once the flip was checkpointed, `previous` cleared tells it too (an unpin since).
  return s.pinned === p.from || (p.flipping === true && s.previous === null);
}

/**
 * Ends the op `failed` with `error`: its releases_log row, when the checkpoint wrote one, `failed` (no audit entry or
 * notification: nothing changed).
 */
async function failed(ctx: OpStepContext, op: OpFile, error: DomainError): Promise<OpFile> {
  const recorded = errorOf(error);
  const h = await dbOf(ctx);
  await withTx(h, (trx) =>
    setReleaseLogStatus(trx, op.opId, 'failed', { finishedAt: ctx.now(), detail: { outcome: 'failed', error: { code: recorded.code, reason: recorded.reason ?? null } } }),
  );
  ctx.log.warn('rollback: refused', { opId: op.opId, code: recorded.code, reason: recorded.reason ?? null });
  return { ...op, state: 'failed', error: recorded };
}

/**
 * The end of a rollback whose pointers are flipped: in one transaction its releases_log row `done` (inserted when
 * absent), `update.rollback {from, to}` as the op's actor and `update_rolled_back` to `system.update.run`, unless the
 * row is final already (written by a step whose op.json was lost, 1D-22); then a restart, so that every process loads
 * the release now active.
 */
async function finish(d: RollbackKindDeps, ctx: OpStepContext, op: OpFile, p: RollbackParams): Promise<OpFile> {
  const h = await dbOf(ctx);
  const now = ctx.now();
  await withTx(h, async (trx) => {
    const row = await readReleaseLog(trx, op.opId);
    if (row !== null && RELEASE_LOG_FINAL.has(row.status)) return;
    if (row === null) {
      await insertReleaseLog(trx, { id: op.opId, version: p.target, action: 'rollback', fromVersion: p.from, startedAt: op.startedAt, backupId: null });
    }
    await setReleaseLogStatus(trx, op.opId, 'done', { finishedAt: now, detail: { outcome: 'done' } });
    await txCtx(trx, now, actorOf(op.actor)).audit({ action: 'update.rollback', entity: 'releases_log', entityId: op.opId, meta: { from: p.from, to: p.target } });
    // The notification last: its event is the transaction's last statement (§10.6).
    await d.notify(
      trx,
      {
        audience: { permission: 'system.update.run' },
        type: 'update.rolled_back',
        titleKey: 'notification.update_rolled_back.title',
        params: { version: p.from },
        link: UPDATES_LINK,
      },
      now,
    );
  });
  try {
    await d.requestRestart('rollback');
  } catch (error) {
    ctx.log.warn('rollback: the restart could not be requested; restart ALTIS to load the release now active', { opId: op.opId, ...errorFields(error) });
  }
  ctx.publish({ progress: 100 });
  return { ...op, state: 'done', progress: 100, error: null };
}

async function stepRollback(d: RollbackKindDeps, ctx: OpStepContext, op: OpFile): Promise<OpFile> {
  if (op.state !== 'running') return op;
  const p = parseRollbackParams(op.params);
  const state = await readState(d.dataDir);
  if (flipped(state, p)) return finish(d, ctx, op, p);

  const a = await availabilityOf(d.dataDir, state, d.appRoot);
  if (!a.available) {
    return failed(ctx, op, rollbackUnavailable(a.reason ?? 'no_previous', { target: a.target, minCodeVersion: a.minCodeVersion, pending: state.pending?.version ?? null }));
  }
  if (a.target !== p.target || state.active.version !== p.from) {
    // The releases moved since the op began (nothing goes back to a version other than the one asked for).
    return failed(ctx, op, rollbackUnavailable('no_previous', { target: p.target }));
  }
  // The database's own `min_code_version` too: a mirror whose write failed after a migration lags it.
  const h = await dbOf(ctx);
  const min = await databaseMinCode(h);
  if (min !== null && compareSemver(p.target, min) < 0) {
    return failed(ctx, op, rollbackUnavailable('incompatible', { target: p.target, minCodeVersion: min }));
  }

  if (p.flipping !== true) {
    // The checkpoint (1D-22): the row first, then op.json says the flip comes next. It is the op's point of no return:
    // a step that fails from here on (the flip may be done) leaves it in needs_attention, and resume finishes it (the
    // steps are idempotent), instead of ending it `failed` with its row `running` and maybe its pointers moved.
    await withTx(h, (trx) => insertReleaseLog(trx, { id: op.opId, version: p.target, action: 'rollback', fromVersion: p.from, startedAt: op.startedAt, backupId: null }));
    return { ...op, params: { ...op.params, flipping: true }, pointOfNoReturn: true, progress: 50 };
  }

  ctx.lock.assertHeld();
  let moved = false;
  await updateCurrentState(d.dataDir, (s) => {
    if (flipped(s, p)) return null;
    const previous = s.previous;
    if (s.pending !== null || s.active.version !== p.from || previous === null || previous.version !== p.target) {
      moved = true;
      return null;
    }
    return { ...s, active: previous, previous: null, pinned: s.active.version };
  });
  if (moved) return failed(ctx, op, rollbackUnavailable('no_previous', { target: p.target }));
  return finish(d, ctx, op, p);
}

/**
 * The `rollback` op kind (see the top of this file): initial state `running`, no maintenance, no freeze. `deps` is read
 * at every step; the update kind's deps fit it (the server registers both from the `opKinds` option `update`).
 */
export function rollbackKind(deps: () => RollbackKindDeps): OpKindHandler {
  return {
    kind: 'rollback',
    initialState: 'running',
    maintenance: null,
    freeze: false,
    step: (ctx, op) => stepRollback(deps(), ctx, op),
  };
}

/**
 * The manual rollback's params if it can run now: current.json read (under current.lock), {@link rollbackAvailability}
 * checked. Nothing is written.
 *
 * @returns `{target: previous, from: active}`
 * @throws DomainError 409 ROLLBACK_UNAVAILABLE (with `meta.reason` and a message naming the versions) when it cannot
 *   run; `STATE_CORRUPT` for a current.json that cannot be read
 */
export async function checkRollback(dataDir: string, appRoot: string): Promise<{ target: string; from: string }> {
  const state = await readState(dataDir);
  const a = await availabilityOf(dataDir, state, appRoot);
  if (!a.available || a.target === null) {
    throw rollbackUnavailable(a.reason ?? 'no_previous', { target: a.target, minCodeVersion: a.minCodeVersion, pending: state.pending?.version ?? null });
  }
  return { target: a.target, from: state.active.version };
}

/**
 * Begins the manual rollback with `ops` as `o.actor` (`release:rollback`, `POST updates/rollback`): {@link checkRollback},
 * then the `rollback` op begun with `params = {target: previous, from: active}`. The op re-checks everything in its step.
 *
 * @throws as {@link checkRollback}, nothing begun; the machine's `OPS_IN_PROGRESS` while another op has not ended
 */
export async function beginRollback(
  ops: OpsMachine,
  o: { dataDir: string; appRoot: string; actor: OpActor },
): Promise<OpHandle & { target: string; from: string }> {
  const params = await checkRollback(o.dataDir, o.appRoot);
  const handle = await ops.begin('rollback', o.actor, { target: params.target, from: params.from });
  return { ...handle, ...params };
}

// ---------------------------------------------------------------------------------------------------------------------
// The revert of a pending release from the command line

/** What {@link revertPending} may be told. */
export interface RevertPendingOptions {
  /** Wait for a live holder of boot.lock to go instead of refusing (`release:rollback --force`, 1D-03). */
  force?: boolean;
  /** `force`: how often boot.lock is tried again (default 5 s). */
  pollMs?: number;
  /** `force`: the longest wait (default 15 min). */
  maxWaitMs?: number;
  /** How long `ops/step.lock` is waited for (default 15 s). */
  stepLockWaitMs?: number;
  /** `force`: called each time the holder is found still there, with the ms waited so far. */
  onWait?(waitedMs: number): void;
}

/** 409 RELEASE_PENDING: the pending release cannot be reverted now. */
function releasePending(version: string, why: 'holder' | 'waited' | 'step_lock'): DomainError {
  const detail =
    why === 'step_lock'
      ? 'Operasi sedang dijalankan oleh proses lain (ops/step.lock); coba lagi / ' +
        'The operation is being stepped by another process (ops/step.lock); try again'
      : why === 'waited'
        ? `Rilis ${version} masih di-boot atau dimigrasi oleh proses yang hidup setelah 15 menit; periksa log, lalu coba lagi / ` +
          `Release ${version} is still being booted or migrated by a live process after 15 minutes; check the log, then try again`
        : `Rilis ${version} sedang di-boot atau dimigrasi oleh proses yang hidup (releases/boot.lock); tunggu sampai selesai, ` +
          'atau jalankan dengan --force untuk menunggunya lalu membatalkan / ' +
          `Release ${version} is being booted or migrated by a live process (releases/boot.lock); wait until it finishes, ` +
          'or run with --force to wait for it and then revert';
  return new DomainError('RELEASE_PENDING', { detail, meta: { version } });
}

/**
 * Records the operator's revert in the update op of target `version` (under `ops/step.lock`, which the caller holds):
 * an op whose effective state is `switched`..`verifying` moves to `reverting` (`stateBefore`, UPDATE_BOOT_FAILED
 * `operator`, `heartbeatAt = at`); any other op (reverting, restoring, ended, another kind or target, before its point
 * of no return), an unreadable op.json or none is left as it is.
 *
 * @returns whether the op was moved
 */
async function recordOperatorRevert(dataDir: string, version: string, at: number, assertHeld: () => void): Promise<boolean> {
  const op = await readOpFile(dataDir);
  if (op === null || op === 'corrupt') return false;
  if (op.kind !== 'update' || op.params['target'] !== version || isTerminal(op.kind, op.state)) return false;
  const state = effectiveState(op);
  if (state === NEEDS_ATTENTION || !BOOT_STATES.has(state)) return false;
  const next: OpFile = { ...op, state: 'reverting', stateBefore: state, error: { code: 'UPDATE_BOOT_FAILED', detail: 'operator' }, heartbeatAt: at };
  assertHeld();
  await writeOpFile(dataDir, next);
  return true;
}

/**
 * Reverts the pending release of `dataDir` (see the top of this file): the CLI's counterpart of app.js's revert.
 * `now` (epoch ms) dates the op's heartbeat (moved on by the time waited).
 *
 * @returns the version reverted; null when nothing is pending (or it stopped being pending while `force` waited:
 *   promoted or reverted by its holder)
 * @throws DomainError 409 RELEASE_PENDING (`meta.version`) while a live holder boots it (without `force`, or still
 *   after the wait) or while `ops/step.lock` stays busy, with nothing changed; `STATE_CORRUPT` for state files that
 *   cannot be read or a lock taken over (`lock_lost`)
 */
export async function revertPending(dataDir: string, now: number, o: RevertPendingOptions = {}): Promise<string | null> {
  const began = performance.now();
  const at = (): number => now + Math.round(performance.now() - began);
  let state = await readState(dataDir);
  if (state.pending === null) return null;
  await ensureDir(dataPath(dataDir, 'releases'));
  const bootLock = dataPath(dataDir, 'releases', 'boot.lock');
  const pollMs = o.pollMs ?? WAIT_POLL_MS;
  const maxWaitMs = o.maxWaitMs ?? WAIT_MAX_MS;
  let lock: HeldFileLockHandle | null;
  for (;;) {
    lock = await acquireFileLock(bootLock, { staleMs: BOOT_LOCK_STALE_MS });
    if (lock !== null) break;
    const pending = state.pending.version;
    if (o.force !== true) throw releasePending(pending, 'holder');
    const waited = performance.now() - began;
    if (waited >= maxWaitMs) throw releasePending(pending, 'waited');
    o.onWait?.(Math.round(waited));
    await sleep(Math.min(pollMs, Math.max(1, maxWaitMs - waited)));
    state = await readState(dataDir);
    if (state.pending === null) return null; // its holder promoted or reverted it meanwhile
  }
  const held = lock;
  try {
    // Read again under boot.lock: the holder that just let it go may have promoted or reverted it.
    state = await readState(dataDir);
    if (state.pending === null) return null;
    const version = state.pending.version;
    try {
      await withControlLock(dataDir, { now: at, waitMs: o.stepLockWaitMs ?? STEP_LOCK_WAIT_MS }, (step) =>
        recordOperatorRevert(dataDir, version, at(), () => {
          held.assertHeld();
          step.assertHeld();
        }),
      );
    } catch (error) {
      if (isDomainError(error) && error.code === 'OPS_IN_PROGRESS') throw releasePending(version, 'step_lock');
      throw error;
    }
    // Only now, the op recorded (or none to record): `pending` cleared (Review Focus 1).
    held.assertHeld();
    await updateCurrentState(dataDir, (s) => (s.pending !== null && s.pending.version === version ? { ...s, pending: null, pendingSince: null } : null));
    // A later attempt at this version counts its boots from zero (D1d-19); what a failed removal leaves, the update's
    // `switched` step removes before it makes this version pending again (kind.ts clearLeftoverMarkers).
    await removeTree(dataPath(dataDir, 'releases', 'boot', version)).catch(() => undefined);
    return version;
  } finally {
    await held.release().catch(() => undefined);
  }
}
