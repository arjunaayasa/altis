import { decodeBase64Url, encodeBase64Url } from '@altis/crypto';
import type { DbHandle } from '@altis/db';
import { dataPath, ensureDir, withFileLock, type HeldFileLock } from '@altis/platform';
import {
  DomainError,
  NEEDS_ATTENTION,
  OP_KINDS,
  OP_STATES,
  OP_TERMINAL_STATES,
  isDomainError,
  isOpState,
  isTerminal,
  isUlid,
  newId,
  type OpKind,
} from '@altis/shared';
import { errorFields, type CoreLogger } from '../context.js';
import { openValue, sealValue, secretAad, type KeyringEntry } from '../crypto/secret-box.js';
import { randomToken, safeEqual, sha256hex } from '../crypto/tokens.js';
import { createRealtimeTransport } from '../events/publish.js';
import { KEEPS_MAINTENANCE, effectiveState, holdsFrom } from './boot-plan.js';
import {
  MAINTENANCE_REASONS,
  archiveOpFile,
  clearControlRequest,
  clearCorruptReported,
  clearMaintenance,
  corruptReported,
  createOpFile,
  markCorruptReported,
  parseOpFile,
  readControlRequest,
  readMaintenance,
  readOpFile,
  setAsideOpFiles,
  stepLockPath,
  writeControlRequest,
  writeMaintenance,
  writeOpFile,
  type MaintenanceFlag,
  type OpActor,
  type OpFile,
} from './files.js';
import { FREEZE_SETTLE_MS, FREEZE_WAIT_MS, liveLeases } from './freeze.js';

// The OpsMachine (spec §9.4, decisions C8/C9, preflight S1/B4/M21): the exclusive operations of an installation
// (install-migrate, update, rollback, restore, frozen backup, migrate, reset), one at a time, resumable by anyone.
//
// - The ops lock is `ops/op.json`, created with O_EXCL by `begin`. `begin` reads, archives the finished op and
//   creates the new one under `ops/step.lock` (S1), so two processes beginning at once cannot both win, nor archive
//   one another's op.
// - `step` advances the op by handler steps until its budget is spent (at least one per call), under
//   `ops/step.lock` (one stepper at a time: a busy lock means another process is stepping, and the call returns the
//   status at once). Every op.json write follows `lock.assertHeld()` (L11): a process that stalled long enough for
//   its lock to be taken over writes nothing more.
// - Control actions (`cancel`, `takeover`, `resume`, `setAsideUnreadable`) go first (final review, P9): each is one
//   request of ≤ 20 s that writes `ops/control-request` before it waits for the lock; while that is fresh no step
//   begins and a step under way stops after its handler step (withControlLock). A lock still held after 15 s answers
//   409 OPS_IN_PROGRESS, and the retry finds it free.
// - Whoever steps the op keeps its maintenance flag in place (M21; not for an op in `needs_attention`, whose flag an
//   operator may force off until `resume` raises it again, unless it freezes and is past its point of no return: a
//   restore's half-loaded tables are never served), notices a stalled op (15 minutes without movement
//   → `needs_attention`), and for a freezing kind waits for the freeze (no live lease, ≥ 3 s, ≤ 60 s) before the
//   first handler step. A freeze whose flag was down meanwhile (raised again by M21 or `resume`) has broken: before the
//   point of no return it starts over, and the kind's `refreeze` drops the work done under it (final review G2). A kind
//   without `refreeze` (a restore) ends `failed` instead, through its `cancel`, and its flag is not raised again; a
//   freeze that times out after the op did work (after a refreeze) undoes that work through `cancel` too (R1c-15).
//   An op that ends lowers its maintenance flag, unless it ended in `restore_failed` (an update that could not
//   restore its backup stays in maintenance; `needs_attention` does not end an op at all). Lowering is idempotent:
//   the next step (or `begin`) that finds an ended op whose flag is still up lowers it (P7).
// - 1d Task 11 (decision D1d-14): a kind may hold its flag only from a given state on (`maintenanceFrom`: an update
//   downloads and verifies while the site serves, §9.6). Before it the op holds neither the flag nor the freeze; the
//   first step at or after it asks the kind (`beforeMaintenance`, which may still refuse the op), raises the flag and
//   waits for the freeze. An op may also begin in one of its kind's entry states (§9.8 begins an update at `verified`).
// - Handlers reach the database only through `ctx.db()` (this process's live handle, absent while a booting process
//   waits for the op, B4) or `ctx.connectDedicated()` (a pool-1 connection of the op in this process, P17), never
//   through a boot path.

/** No movement for this long → `needs_attention` (spec §9.4: 15 minutes). */
export const OPS_STALL_MS = 900_000;

/**
 * A finished op stays current (and its `altis_ops` valid) for this long after `finishedAt` (spec §9.4: 1 hour). 1d review
 * C16: one that ended keeping its maintenance (`restore_failed`) stays current while that maintenance is up; its
 * `altis_ops` does not.
 */
const AFTER_END_MS = 3_600_000;

/** `step` waits this long for `ops/step.lock`: a longer wait means another process is stepping. */
const STEP_LOCK_WAIT_MS = 200;
/** `begin` waits this long; a lock held longer means an op is being stepped, so one is in progress. */
const BEGIN_LOCK_WAIT_MS = 10_000;
/**
 * Final review (P9; cancel and takeover starved behind back-to-back drives): a control action (`cancel`, `takeover`,
 * `resume`, `setAsideUnreadable`) is one request of at most this long. It first writes `ops/control-request`, which
 * keeps every new step out and stops a step under way after its handler step ({@link withControlLock}).
 */
const CONTROL_BUDGET_MS = 20_000;
/**
 * It waits this long for `ops/step.lock` (a step that began just before it holds the lock up to its own budget), then
 * answers 409 `OPS_IN_PROGRESS`, its request left in place so that a retry finds the lock free. What is left of
 * {@link CONTROL_BUDGET_MS} (≥ 5 s) is the budget of a kind's `cancel`.
 */
const CONTROL_LOCK_WAIT_MS = 15_000;
/** A control request keeps steps out this long after it was written (one whose writer died is forgotten then). */
const CONTROL_REQUEST_TTL_MS = 30_000;

/** The progress hint channel of each kind (M43); the others publish nothing. */
const PROGRESS_CHANNEL: Partial<Record<OpKind, string>> = {
  backup: 'system.backup',
  restore: 'system.backup',
  update: 'system.update',
  rollback: 'system.update',
};

/** The kind a maintenance reason belongs to, for the status of an unreadable op.json. */
const REASON_KIND: Readonly<Record<MaintenanceFlag['reason'], OpKind | null>> = {
  restore: 'restore',
  backup: 'backup',
  update: 'update',
  install: 'install-migrate',
  migrate: 'migrate',
  reset: 'reset',
  manual: null,
};

const ACTOR_TYPES: ReadonlySet<string> = new Set(['staff', 'cli', 'install', 'system']);
/** The longest `message` of a progress hint. */
const MESSAGE_MAX = 200;
/** The longest `message` and `error.detail` op.json holds (files.ts's schema). */
const TEXT_MAX = 2000;

/** `text` cut to at most `max` UTF-16 code units, never between the two halves of a surrogate pair. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/**
 * What callers see of an op. For an op.json whose `.bak` is unreadable too (spec §9.4): state `needs_attention`, error
 * `STATE_CORRUPT`, `pointOfNoReturn: true` (nothing cancels an op nobody can read), the op id and kind from the
 * maintenance flag, and `backupId` from the newest `releases_log` row that has one.
 */
export interface OpStatus {
  /** Null only when op.json and its `.bak` are both unreadable and no maintenance flag names the op. */
  opId: string | null;
  /** Null as `opId`, or for an unreadable op.json under a manual flag. */
  kind: OpKind | null;
  state: string;
  terminal: boolean;
  needsAttention: boolean;
  /** Null for an unreadable op.json (as `heartbeatAt` and `actor`). */
  startedAt: number | null;
  heartbeatAt: number | null;
  finishedAt: number | null;
  /** 0 to 100. */
  progress: number;
  message: string | null;
  error: OpFile['error'];
  pointOfNoReturn: boolean;
  backupId: string | null;
  actor: OpActor | null;
}

/** What a kind's step (and cancel) runs with. */
export interface OpStepContext {
  dataDir: string;
  /** This process's live handle; absent while it waits for an op (B4). */
  db(): DbHandle | undefined;
  /** A pool-1 connection of this op in this process (P17), closed when the op ends or the process retires. */
  connectDedicated(): Promise<DbHandle>;
  /** Epoch ms (on `now()`'s clock) by which the step should return; a step may overrun it by its last unit of work. */
  deadline: number;
  now(): number;
  keyring: readonly KeyringEntry[];
  log: CoreLogger;
  /** `ops/step.lock`: call `assertHeld()` before anything that must not happen twice. */
  lock: HeldFileLock;
  /** The op's secret (`begin`'s `o.secret`), or null. */
  secret(): Uint8Array | null;
  /**
   * A progress hint (M43): after the handler step returns, `op.progress` is published on `system.backup`
   * (backup, restore) or `system.update` (update, rollback) through the events table of `db()`; nothing for the other
   * kinds, without a live handle, or during a restore past its point of no return. The status itself is the op's
   * `progress` and `message`, which the step returns.
   */
  publish(o: { progress: number; message?: string }): void;
}

/**
 * One kind of op. `step` takes the op (a copy) and returns its next version: another state of the kind, new
 * `params` (its checkpoints), `progress`, `message`, `backupId`, `pointOfNoReturn`, `error`. It must be idempotent
 * (P7: the process may die after any statement, and the next step starts again from the last op.json written), and
 * it should return by `ctx.deadline`. Returning the op unchanged means "nothing to do yet": the call ends there and a
 * later step tries again. A step may also move the op to `needs_attention` itself (with `stateBefore`).
 *
 * A thrown error: `DB_UNAVAILABLE` and lock timeouts leave the op as it was (the next step retries) and are thrown
 * on; anything else ends the op in its failure state before the point of no return (`failed`; `aborted` for backup
 * and update) and moves it to `needs_attention` after it. A kind that must clean up or go back on failure (restore)
 * does that itself and returns the resulting state instead of throwing.
 */
export interface OpKindHandler {
  kind: OpKind;
  /** The first state: a non-terminal state of the kind. */
  initialState: string;
  /**
   * 1d Task 11: the other states `begin` may start an op in (`o.state`), each a non-terminal state of the kind (an
   * update of the bundled release begins at `verified`, §9.8).
   */
  entryStates?: readonly string[];
  /**
   * The maintenance reason the op raises from `begin` (or from {@link maintenanceFrom}) until it ends, or null for
   * none.
   */
  maintenance: MaintenanceFlag['reason'] | null;
  /**
   * 1d Task 11 (decision D1d-14): a non-terminal state of the kind from which the op holds its maintenance flag (and,
   * for a freezing kind, the freeze); absent, from `begin`. In the states before it (in `OP_STATES` order) the op
   * holds neither: `begin` writes no flag, the machine raises none (M21), no freeze wait happens, and a step may not
   * return there from a state at or after it. The first step at or after it calls {@link beforeMaintenance}, raises
   * the flag and, for `freeze: true`, waits for the freeze before the handler steps the op. Needs a `maintenance`
   * reason. An op in `needs_attention` is judged by its `stateBefore` (`effectiveState`).
   */
  maintenanceFrom?: string;
  /** Whether the first handler step (at or after `maintenanceFrom`) waits for the freeze (no live job lease; C9). */
  freeze: boolean;
  /**
   * 1d Task 11 (preflight 1D-23): called right before the machine raises the op's flag at a step (at
   * `maintenanceFrom`, or a flag that went down before the point of no return), and before `resume()` raises one
   * again; not by `begin`, which refuses a freezing kind during a snapshot backup itself. A throw ends the op as the
   * machine ends one unasked: the kind's `cancel` undoes its work (given the op with the error), then the op ends in its
   * failure state with that error; no flag is raised and no freeze wait happens. `DB_UNAVAILABLE` and lock timeouts
   * leave the op as it was (the next step asks again) and are thrown on. No other effect: it may run again.
   */
  beforeMaintenance?(ctx: OpStepContext, op: OpFile): Promise<void>;
  /**
   * Final review G2: the op's freeze broke. Its maintenance flag was down after the freeze began (forced off while the
   * op needed attention, or removed by hand while it ran), so other processes may have served and written meanwhile.
   * Before the point of no return the machine drops `params.frozenAt` (the next step waits for the settle and the live
   * leases again, under the flag it raises now) and stores what this returns: the op (a copy, in a non-terminal state
   * of the kind other than `needs_attention`) without the work it did on the live database under the old freeze, so
   * that the work is done again under the new one. Pure: no I/O. Without it (R1c-15) the op cannot go on: it ends in its
   * failure state with `OPS_FREEZE_BROKEN`, through `cancel`, and its flag is not raised again.
   */
  refreeze?(op: OpFile): OpFile;
  /**
   * Review C08: whether the 15-minute stall rule ({@link OPS_STALL_MS}: an op whose heartbeat is older goes to
   * `needs_attention` at its next step) applies to `op`, which is not in `needs_attention`. Absent: always. False for a
   * state in which the op waits for what only one process does and nothing steps it meanwhile (an update past its point
   * of no return waiting for its target's boot, §9.3, whose own rules decide). Pure: no I/O.
   */
  stalls?(op: OpFile): boolean;
  step(ctx: OpStepContext, op: OpFile): Promise<OpFile>;
  /**
   * Undoes what the op did so far; only called before the point of no return. `op.error` is null when an operator
   * cancels the op, and the error it ends with when the machine ends it unasked (R1c-15: its freeze broke and the kind
   * has no `refreeze`, `OPS_FREEZE_BROKEN`; or its freeze timed out after it did work, `OPS_FREEZE_TIMEOUT`; 1d Task
   * 11: `beforeMaintenance` refused it, with the error it threw).
   */
  cancel?(ctx: OpStepContext, op: OpFile): Promise<void>;
}

/** The op `begin` (or `takeover`) bound to its caller: `opsToken` is the `altis_ops` cookie value. */
export type OpHandle = { opId: string; opsToken: string };

export interface OpsMachineOptions {
  dataDir: string;
  kinds: readonly OpKindHandler[];
  /** This process's live handle, or undefined while there is none (`ops_wait`, before the install). */
  db(): DbHandle | undefined;
  /** Opens a pool-1 connection outside the pool (`ctx.connectDedicated()`). */
  connect(purpose: 'cli'): Promise<DbHandle>;
  keyring(): readonly KeyringEntry[];
  /** Epoch ms. */
  clock(): number;
  log: CoreLogger;
  /** True while a snapshot backup runs (the named lock `backup:snapshot`): a freezing op is refused then. */
  snapshotBackupRunning(): Promise<boolean>;
  /**
   * Called once when an op enters `needs_attention`, and once for an unreadable op.json and `.bak` (the first step
   * that finds it, in any process). The server notifies the kind's permission (M34).
   */
  onAttention?(op: OpStatus): Promise<void>;
  /** The running code's version, recorded as `version` of the ops it begins. Default `''`. */
  appVersion?: string;
  /** How long a control action waits for `ops/step.lock` (default 15 000 ms; tests shorten it). */
  controlWaitMs?: number;
}

export interface OpsMachine {
  /**
   * Begins an op of `kind`, which must be one of the machine's kinds, in `o.state` (default: the kind's initial state;
   * else one of its `entryStates`). The maintenance flag is raised at once when the op holds it in that state (a kind
   * without `maintenanceFrom`, or a state at or after it).
   *
   * @throws DomainError `OPS_BLOCKED_BY_BACKUP` (409) for a freezing kind while a snapshot backup runs, before
   *   anything is written; `OPS_IN_PROGRESS` (409) while another op has not ended (or op.json is unreadable)
   * @throws TypeError for an unknown kind, an actor or params that are not well formed, a state that is neither the
   *   kind's initial state nor one of its entry states
   */
  begin(kind: OpKind, actor: OpActor, params: Record<string, unknown>, o?: { secret?: Uint8Array; state?: string }): Promise<OpHandle>;
  /**
   * Advances the current op for up to `budgetMs` (at least one handler step), or returns its status at once while
   * another process is stepping it. Null without a current op.
   *
   * @throws DomainError `STATE_CORRUPT` `lock_lost` when `ops/step.lock` was taken over meanwhile (nothing was written
   *   after that); a handler's `DB_UNAVAILABLE` or lock timeout (the op is left as it was)
   */
  step(budgetMs: number): Promise<OpStatus | null>;
  /**
   * The current op: one that has not ended, or one that ended less than an hour ago, or (1d review C16) one that ended in
   * a state that keeps maintenance (`restore_failed`) while a maintenance flag (its own, or a manual one) is up. Null
   * otherwise.
   */
  current(): Promise<OpStatus | null>;
  /**
   * Cancels the current op: the kind's `cancel` runs, then the op ends in its failure state (`failed`; `aborted` for
   * backup and update) with `params.cancelledBy`. With `o.opId`, only that op: a caller that began an op (the CLI)
   * never cancels one somebody else began after its own ended (final review T24).
   *
   * @throws DomainError `OPS_NONE` (404) without an op that has not ended (or when it is not `o.opId`);
   *   `OPS_POINT_OF_NO_RETURN` (409) past its point of no return; `STATE_CORRUPT` for an unreadable op.json;
   *   `OPS_IN_PROGRESS` (409, `step_busy`) when a step kept the lock through the control wait (retry: it goes first)
   */
  cancel(actor: OpActor, o?: { opId?: string }): Promise<OpStatus>;
  /**
   * Binds the current op to `actor` with a new token; the old token stops matching.
   *
   * @throws DomainError `OPS_NONE` (404); `STATE_CORRUPT` for an unreadable op.json; `OPS_IN_PROGRESS` (409,
   *   `step_busy`) as for `cancel`
   */
  takeover(actor: OpActor): Promise<OpHandle>;
  /**
   * Moves an op in `needs_attention` back to its `stateBefore` (with a fresh heartbeat); any other op is returned as
   * it is. A maintenance flag forced off meanwhile is raised again (when the op holds it in that state; before its point
   * of no return the kind's `beforeMaintenance` is asked first), and a freezing op before its point of no return then
   * freezes again and does again what it did under the old freeze (`OpKindHandler.refreeze`).
   *
   * @throws DomainError `OPS_NONE` (404); `STATE_CORRUPT` for an unreadable op.json; `OPS_IN_PROGRESS` (409,
   *   `step_busy`) as for `cancel`
   */
  resume(): Promise<OpStatus>;
  /**
   * Final review (OPS-ATTN-EXIT): sets an op.json whose `.bak` is unreadable too aside, the one op nobody can resume,
   * cancel or step (spec §9.4): both files move to `ops/<folder>/` (a new ULID), so that no process waits for the op
   * any more and an op can begin again. Maintenance stays (§9.4: the data may be half done): a flag that is up becomes
   * a manual one, which the operator lowers (`maintenance:off`) once the data is checked, or a restore replaces.
   *
   * @returns the op the flag named (null when none did), its kind and the folder; null when op.json is readable or
   *   absent (nothing was moved)
   * @throws DomainError `OPS_IN_PROGRESS` (409, `step_busy`) as for `cancel`
   */
  setAsideUnreadable(actor: OpActor): Promise<{ opId: string | null; kind: OpKind | null; folder: string } | null>;
  /** Whether `token` is the `altis_ops` of the current op (one that has not ended, or ended less than an hour ago). */
  tokenMatches(token: string): Promise<boolean>;
  /** Closes the op connections this process opened (the process retires). */
  close(): Promise<void>;
}

function reasonOf(error: unknown): unknown {
  return isDomainError(error) ? error.meta?.['reason'] : undefined;
}

function isLockLost(error: unknown): boolean {
  return isDomainError(error) && error.code === 'STATE_CORRUPT' && reasonOf(error) === 'lock_lost';
}

function isLockTimeout(error: unknown): boolean {
  return isDomainError(error) && error.code === 'STATE_CORRUPT' && reasonOf(error) === 'lock_timeout';
}

/** Errors after which the same step may well succeed later: the op is left as it was. */
function isTransient(error: unknown): boolean {
  return (isDomainError(error) && error.code === 'DB_UNAVAILABLE') || isLockTimeout(error);
}

/** The failure state of a kind: `aborted` where the kind has one (backup, update), else `failed`. */
function failureState(kind: OpKind): string {
  return OP_TERMINAL_STATES[kind].includes('aborted') ? 'aborted' : 'failed';
}

/** What op.json records of a failure: a registered code, and the detail of a 4xx DomainError (authored text). */
function errorOf(error: unknown): NonNullable<OpFile['error']> {
  if (isDomainError(error)) {
    return error.status < 500 && error.detail !== undefined ? { code: error.code, detail: error.detail } : { code: error.code };
  }
  return { code: 'INTERNAL' };
}

function inProgress(): DomainError {
  return new DomainError('OPS_IN_PROGRESS', {
    detail: 'Operasi lain sedang berjalan / Another operation is in progress',
  });
}

/** A control action that waited out its lock wait (see {@link CONTROL_LOCK_WAIT_MS}): 409, retryable. */
function stepBusy(): DomainError {
  return new DomainError('OPS_IN_PROGRESS', {
    detail: 'Operasi sedang dijalankan oleh proses lain; coba lagi / The operation is being stepped by another process; try again',
    meta: { reason: 'step_busy' },
  });
}

/** What op.json records of an op whose freeze timed out. */
function freezeTimeout(): NonNullable<OpFile['error']> {
  return {
    code: 'OPS_FREEZE_TIMEOUT',
    detail:
      'Tugas yang sedang berjalan tidak selesai dalam 60 detik; operasi dibatalkan / ' +
      'Running jobs did not finish within 60 seconds; the operation was cancelled',
  };
}

/** What op.json records of an op whose freeze broke and whose kind cannot redo its work (R1c-15). */
function freezeBroken(): NonNullable<OpFile['error']> {
  return {
    code: 'OPS_FREEZE_BROKEN',
    detail:
      'Pemeliharaan dimatikan saat operasi berjalan; operasi dibatalkan tanpa mengubah data, mulai lagi / ' +
      'Maintenance was turned off while the operation ran; it was cancelled without changing any data, start it again',
  };
}

function noOp(): DomainError {
  return new DomainError('OPS_NONE', { detail: 'Tidak ada operasi yang sedang berjalan / No operation is in progress' });
}

function unreadableOp(): DomainError {
  return new DomainError('STATE_CORRUPT', {
    detail:
      'Berkas ops/op.json dan salinan .bak-nya tidak dapat dibaca; lihat Diagnostik / ' +
      'ops/op.json and its .bak copy cannot be read; see Diagnostics',
    meta: { reason: 'op_unreadable' },
  });
}

function checkActor(actor: OpActor, caller: string): OpActor {
  const ok =
    typeof actor === 'object' &&
    actor !== null &&
    ACTOR_TYPES.has(actor.type) &&
    (actor.type === 'staff' ? typeof actor.id === 'string' && isUlid(actor.id) : actor.id === null || (typeof actor.id === 'string' && actor.id.length <= 64));
  if (!ok) throw new TypeError(`${caller}: the actor must be {type: staff|cli|install|system, id}, a staff actor with a ULID`);
  return { type: actor.type, id: actor.id };
}

/** A JSON copy of `params` (what op.json will hold). */
function jsonParams(params: Record<string, unknown>): Record<string, unknown> {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new TypeError('begin: params must be a plain JSON object');
  }
  let copy: unknown;
  try {
    copy = JSON.parse(JSON.stringify(params)) as unknown;
  } catch (error) {
    throw new TypeError('begin: params must be a plain JSON object', { cause: error });
  }
  return copy as Record<string, unknown>;
}

/**
 * Whether an op of `handler`'s kind in `state` (an effective state: `stateBefore` for `needs_attention`) has reached
 * the states where it holds its flag and freeze: always without `maintenanceFrom`, else from it on (1d Task 11).
 */
function reached(handler: OpKindHandler, state: string): boolean {
  return handler.maintenanceFrom === undefined || holdsFrom(handler.kind, handler.maintenanceFrom, state);
}

/** {@link reached} for `op`, judged by its effective state. */
function reachedBy(handler: OpKindHandler, op: OpFile): boolean {
  return reached(handler, effectiveState(op));
}

/** Whether `state` is one an op of `kind` can go on from: a state of the kind's set that does not end the op. */
function movingState(kind: OpKind, state: unknown): boolean {
  return typeof state === 'string' && OP_STATES[kind].includes(state) && !isTerminal(kind, state);
}

/** Checks the 1d Task 11 fields of `handler` (`entryStates`, `maintenanceFrom`, `beforeMaintenance`). */
function checkMaintenanceFrom(handler: OpKindHandler): void {
  const entries = handler.entryStates;
  if (entries !== undefined && (!Array.isArray(entries) || !entries.every((s) => movingState(handler.kind, s)))) {
    throw new TypeError(`createOpsMachine: ${handler.kind}'s entry states must be non-terminal states of the kind`);
  }
  const from = handler.maintenanceFrom;
  if (from !== undefined && (!movingState(handler.kind, from) || handler.maintenance === null)) {
    throw new TypeError(`createOpsMachine: ${handler.kind}'s maintenanceFrom must be a non-terminal state of the kind, with a maintenance reason`);
  }
  if (handler.beforeMaintenance !== undefined && typeof handler.beforeMaintenance !== 'function') {
    throw new TypeError(`createOpsMachine: ${handler.kind}'s beforeMaintenance must be a function`);
  }
}

function statusOf(op: OpFile): OpStatus {
  return {
    opId: op.opId,
    kind: op.kind,
    state: op.state,
    terminal: isTerminal(op.kind, op.state),
    needsAttention: op.state === NEEDS_ATTENTION,
    startedAt: op.startedAt,
    heartbeatAt: op.heartbeatAt,
    finishedAt: op.finishedAt,
    progress: op.progress,
    message: op.message,
    error: op.error,
    pointOfNoReturn: op.pointOfNoReturn,
    backupId: op.backupId,
    actor: op.actor,
  };
}

/** `op` without its secret: what op.json holds once the op ended. */
function withoutSecret(op: OpFile): OpFile {
  const copy = { ...op };
  delete copy.secretParam;
  return copy;
}

function secretAadOf(opId: string): string {
  return secretAad('ops', 'secret_param', opId);
}

/**
 * Whether a control action waits for `ops/step.lock` now: `ops/control-request` exists and is younger than
 * {@link CONTROL_REQUEST_TTL_MS} on `now` (a clock that went back counts the same). Never rejects.
 */
export async function controlPending(dataDir: string, now: number): Promise<boolean> {
  try {
    const r = await readControlRequest(dataDir);
    return r !== null && Math.abs(now - r.at) < CONTROL_REQUEST_TTL_MS;
  } catch {
    return false;
  }
}

/**
 * Runs `fn` under `ops/step.lock` ahead of the steppers (final review: cancel and takeover starved behind
 * back-to-back drives). `ops/control-request` is written first: while it is fresh no step begins (`step` answers the
 * status as it is) and a step under way stops after its handler step, so the lock comes free within one handler step
 * or, for a handler step that runs to its deadline, one drive budget. The request is removed once `fn` ran (or failed);
 * a wait that runs out leaves it in place, so that the caller's next try finds the lock free.
 *
 * @throws DomainError `OPS_IN_PROGRESS` (409, `meta.reason: 'step_busy'`) when the lock stayed held for `o.waitMs`
 */
export async function withControlLock<T>(
  dataDir: string,
  o: { now(): number; waitMs: number },
  fn: (lock: HeldFileLock) => Promise<T>,
): Promise<T> {
  await ensureDir(dataPath(dataDir, 'ops'));
  const id = randomToken();
  await writeControlRequest(dataDir, { id, at: o.now() });
  let entered = false;
  let busy = false;
  try {
    return await withFileLock(
      stepLockPath(dataDir),
      (lock) => {
        entered = true;
        return fn(lock);
      },
      { waitMs: o.waitMs },
    );
  } catch (error) {
    busy = !entered && isLockTimeout(error);
    throw busy ? stepBusy() : error;
  } finally {
    if (!busy) await clearControlRequest(dataDir, id).catch(() => undefined);
  }
}

/** Creates the OpsMachine of an installation (one per process; every process shares DATA_DIR's ops files). */
export function createOpsMachine(o: OpsMachineOptions): OpsMachine {
  const handlers = new Map<OpKind, OpKindHandler>();
  for (const handler of o.kinds) {
    if (!(OP_KINDS as readonly string[]).includes(handler.kind) || handlers.has(handler.kind)) {
      throw new TypeError(`createOpsMachine: kind ${JSON.stringify(handler.kind)} is unknown or registered twice`);
    }
    const first = handler.initialState;
    if (!isOpState(handler.kind, first) || first === NEEDS_ATTENTION || isTerminal(handler.kind, first)) {
      throw new TypeError(`createOpsMachine: ${handler.kind}'s initial state must be a non-terminal state of the kind`);
    }
    if (handler.maintenance !== null && !(MAINTENANCE_REASONS as readonly string[]).includes(handler.maintenance)) {
      throw new TypeError(`createOpsMachine: ${handler.kind}'s maintenance reason is unknown`);
    }
    checkMaintenanceFrom(handler);
    handlers.set(handler.kind, handler);
  }
  const { dataDir, log } = o;
  const opsDir = (): string => dataPath(dataDir, 'ops');
  const lockPath = (): string => stepLockPath(dataDir);
  const controlWaitMs = o.controlWaitMs ?? CONTROL_LOCK_WAIT_MS;
  /** A control action waits for the step lock (see {@link withControlLock}). */
  const controlWaiting = (): Promise<boolean> => controlPending(dataDir, o.clock());

  // Dedicated connections, by op: opened on first use, closed when the op ends (or another op is current, or the
  // process retires).
  const dedicated = new Map<string, Promise<DbHandle>>();

  /**
   * The unreadable op.json files (by the op their flag names, '' for none) this process reported while the
   * `ops/corrupt-reported` marker could not be kept (corruptAttention); `begin` forgets them, as it clears the marker.
   */
  const reportedHere = new Set<string>();

  function dedicatedFor(opId: string): Promise<DbHandle> {
    let opened = dedicated.get(opId);
    if (opened === undefined) {
      opened = o.connect('cli');
      dedicated.set(opId, opened);
      const settled = opened;
      settled.catch(() => {
        if (dedicated.get(opId) === settled) dedicated.delete(opId);
      });
    }
    return opened;
  }

  /** Closes every dedicated connection but the one of `keep`. */
  async function closeDedicated(keep: string | null): Promise<void> {
    for (const [opId, opened] of [...dedicated]) {
      if (opId === keep) continue;
      dedicated.delete(opId);
      try {
        await (await opened).close();
      } catch {
        // never opened, or already gone
      }
    }
  }

  /** The status of an ended op while its `altis_ops` lasts (an hour after `finishedAt`), else null. */
  function visible(op: OpFile): OpStatus | null {
    return o.clock() <= (op.finishedAt ?? op.heartbeatAt) + AFTER_END_MS ? statusOf(op) : null;
  }

  /**
   * The status of the ended `op` while it is still current, else null: for an hour after `finishedAt` ({@link visible}),
   * and (1d review C16; spec §9.7, §9.8 row 3) for as long as maintenance stays up after an op that ended in a state
   * that keeps it (an update in `restore_failed`: a flag that names it, or the manual one a restart raises in its
   * place), so that the ops views show its instructions until an operator acts. Its `altis_ops` still lasts the hour.
   */
  async function shownEnded(op: OpFile): Promise<OpStatus | null> {
    const status = visible(op);
    if (status !== null || !KEEPS_MAINTENANCE.has(op.state)) return status;
    const flag = await readMaintenance(dataDir);
    return flag !== null && (flag.opId === null || flag.opId === op.opId) ? statusOf(op) : null;
  }

  /** The newest backup id `releases_log` knows (spec §9.4: for an unreadable op.json), or null. */
  async function lastBackupId(): Promise<string | null> {
    const h = o.db();
    if (h === undefined) return null;
    try {
      const row = await h.db
        .selectFrom('releases_log')
        .select('backup_id')
        .where('backup_id', 'is not', null)
        .orderBy('started_at', 'desc')
        .orderBy('id', 'desc')
        .limit(1)
        .executeTakeFirst();
      return row?.backup_id ?? null;
    } catch {
      return null; // tables gone (a restore past its point of no return), or no database
    }
  }

  /** The status of an op whose op.json and `.bak` are unreadable: needs attention, maintenance stays (spec §9.4). */
  async function corruptStatus(): Promise<OpStatus> {
    const flag = await readMaintenance(dataDir).catch(() => null);
    return {
      opId: flag?.opId ?? null,
      kind: flag === null ? null : REASON_KIND[flag.reason],
      state: NEEDS_ATTENTION,
      terminal: false,
      needsAttention: true,
      startedAt: null,
      heartbeatAt: null,
      finishedAt: null,
      progress: 0,
      message: null,
      error: { code: 'STATE_CORRUPT' },
      pointOfNoReturn: true,
      backupId: await lastBackupId(),
      actor: null,
    };
  }

  /** Reports an op that entered `needs_attention` (once per entry: callers call it right after recording it). */
  async function notify(status: OpStatus, stateBefore: string | null): Promise<void> {
    log.warn('ops: the op needs attention', { opId: status.opId, kind: status.kind, stateBefore, error: status.error?.code ?? null });
    if (o.onAttention === undefined) return;
    try {
      await o.onAttention(status);
    } catch (error) {
      log.error('ops: onAttention failed', { opId: status.opId, ...errorFields(error) });
    }
  }

  function attention(op: OpFile): Promise<void> {
    return notify(statusOf(op), op.stateBefore ?? null);
  }

  /**
   * The status of an unreadable op.json and `.bak` (see {@link corruptStatus}), reported through `onAttention` the
   * first time any process steps it: `ops/corrupt-reported` remembers the op (M34).
   */
  async function corruptAttention(lock: HeldFileLock): Promise<OpStatus> {
    const status = await corruptStatus();
    // Final review (T6): a marker that cannot be read or written (a full or read-only disk, likely beside an unreadable
    // op.json) must not hide the status nor the report: it is reported then, once per process (final review G2: this
    // process remembers it, a cache that is safe when stale, P6), not at every step.
    const key = status.opId ?? '';
    let reported = reportedHere.has(key);
    let unkept = false;
    if (!reported) {
      try {
        reported = await corruptReported(dataDir, status.opId);
      } catch (error) {
        unkept = true;
        log.warn('ops: the report marker of an unreadable op.json cannot be kept; it may be reported again', errorFields(error));
      }
    }
    if (!reported) {
      lock.assertHeld();
      try {
        await markCorruptReported(dataDir, status.opId);
      } catch (error) {
        unkept = true;
        log.warn('ops: the report marker of an unreadable op.json cannot be kept; it may be reported again', errorFields(error));
      }
      if (unkept) reportedHere.add(key);
      await notify(status, null);
    }
    return status;
  }

  /**
   * Lowers the maintenance flag of the ended `op`, unless its state keeps maintenance; only a flag that names the op.
   * Idempotent: whoever finds an ended op with its flag still up (a process that died between the terminal op.json
   * and the flag, or a removal that failed) lowers it.
   *
   * @returns true when a flag was removed
   */
  async function lowerFlagOf(lock: HeldFileLock, op: OpFile): Promise<boolean> {
    if (KEEPS_MAINTENANCE.has(op.state)) return false;
    lock.assertHeld();
    return clearMaintenance(dataDir, op.opId);
  }

  /**
   * After an op ended (its terminal op.json written): its maintenance flag lowered first (unless the state keeps it,
   * or the op never held one: `held` false, 1d Task 11), then its connections closed. Nothing that may fail or stall
   * comes between the end and the flag.
   */
  async function finish(lock: HeldFileLock, op: OpFile, held: boolean): Promise<void> {
    try {
      if (held) await lowerFlagOf(lock, op);
    } finally {
      await closeDedicated(null);
    }
  }

  /**
   * Ends the op: writes the ended `op` (without its secret) to op.json twice, so that the `.bak` holds the ended op as
   * well and no copy of the sealed `secretParam` stays on disk, then {@link finish}es it. `held`: whether the op may
   * hold a flag, judged by the state it ended from (false only before its kind's `maintenanceFrom`).
   */
  async function endOp(lock: HeldFileLock, op: OpFile, held: boolean): Promise<void> {
    const end = withoutSecret(op);
    for (let i = 0; i < 2; i += 1) {
      lock.assertHeld();
      await writeOpFile(dataDir, end);
    }
    await finish(lock, end, held);
  }

  /** Whether `op` (in the state it ends from) may hold its flag: see {@link endOp}; true for a kind not registered. */
  function mayHold(op: OpFile): boolean {
    const handler = handlers.get(op.kind);
    return handler === undefined || reachedBy(handler, op);
  }

  /** Whether the ended `op` left its maintenance flag up where its state does not keep it (lock-free check). */
  async function flagLeftUp(op: OpFile): Promise<boolean> {
    if (KEEPS_MAINTENANCE.has(op.state)) return false;
    return (await readMaintenance(dataDir))?.opId === op.opId;
  }

  /** `op` ended in `state` now. */
  function ended(op: OpFile, state: string, error: OpFile['error']): OpFile {
    const now = o.clock();
    return { ...withoutSecret(op), state, error, heartbeatAt: now, finishedAt: now };
  }

  /** A pending progress hint of the step under way: only the latest one is published. */
  interface Hint {
    progress: number;
    message?: string;
  }

  function contextFor(current: () => OpFile, deadline: number, lock: HeldFileLock, hint: { latest: Hint | null }): OpStepContext {
    const opId = current().opId;
    const keyring = o.keyring();
    return {
      dataDir,
      db: () => o.db(),
      connectDedicated: () => dedicatedFor(opId),
      deadline,
      now: () => o.clock(),
      keyring,
      log,
      lock,
      secret: () => {
        const sealed = current().secretParam;
        if (sealed === undefined) return null;
        const bytes = decodeBase64Url(openValue(o.keyring(), secretAadOf(opId), sealed));
        if (bytes === null) throw new DomainError('SECRET_UNREADABLE', { meta: { reason: 'malformed' } });
        return bytes;
      },
      publish: (p) => {
        if (typeof p !== 'object' || p === null || typeof p.progress !== 'number' || !(p.progress >= 0 && p.progress <= 100)) {
          throw new TypeError('ctx.publish: progress must be a number from 0 to 100');
        }
        hint.latest = p.message === undefined ? { progress: p.progress } : { progress: p.progress, message: p.message };
      },
    };
  }

  /** Publishes the step's latest progress hint, if the kind has a channel and the events table can be written. */
  async function flushHint(op: OpFile, hint: { latest: Hint | null }): Promise<void> {
    const latest = hint.latest;
    hint.latest = null;
    const channel = PROGRESS_CHANNEL[op.kind];
    if (latest === null || channel === undefined) return;
    if (op.kind === 'restore' && op.pointOfNoReturn) return; // the events table may be gone
    const h = o.db();
    if (h === undefined) return;
    const payload: Record<string, unknown> = { opId: op.opId, kind: op.kind, state: op.state, progress: latest.progress };
    if (latest.message !== undefined) payload['message'] = latest.message.slice(0, MESSAGE_MAX);
    try {
      await createRealtimeTransport(h, () => 'polling').publish(channel, 'op.progress', payload);
    } catch (error) {
      log.warn('ops: the progress hint could not be published', { opId: op.opId, ...errorFields(error) });
    }
  }

  /**
   * The handler's next op, checked: the same op, the fields only the machine changes kept as they were, `message` and
   * `error.detail` cut to op.json's limit, and the whole an op that op.json holds and reads back (a JSON copy that
   * parses as `opSchema 1`).
   *
   * @throws TypeError otherwise; it is called inside the step's `try`, so the op fails as for a thrown error
   */
  function nextOf(prev: OpFile, next: OpFile, kind: OpKind): OpFile {
    if (typeof next !== 'object' || next === null || next.opId !== prev.opId || next.kind !== prev.kind) {
      throw new TypeError(`ops: the ${kind} step must return the same op (opId and kind unchanged)`);
    }
    const kept: OpFile = {
      ...next,
      opSchema: 1,
      actor: prev.actor,
      opsTokenHash: prev.opsTokenHash,
      startedAt: prev.startedAt,
      finishedAt: prev.finishedAt,
    };
    if (typeof kept.message === 'string') kept.message = cut(kept.message, TEXT_MAX);
    if (typeof kept.error === 'object' && kept.error !== null && typeof kept.error.detail === 'string') {
      kept.error = { ...kept.error, detail: cut(kept.error.detail, TEXT_MAX) };
    }
    if (prev.secretParam === undefined) delete kept.secretParam;
    else kept.secretParam = prev.secretParam;
    try {
      return parseOpFile(JSON.parse(JSON.stringify(kept)) as unknown);
    } catch (error) {
      throw new TypeError(`ops: the ${kind} step returned an op that op.json cannot hold`, { cause: error });
    }
  }

  /**
   * Whether the freeze of `op`, whose maintenance flag was down, broke in a way that matters (see
   * {@link OpKindHandler.refreeze}): a freezing kind, an op that had frozen, before its point of no return. Past it (a
   * restore loading) what the op did cannot be done again: it goes on. 1d Task 11: only in the states where the op
   * holds its flag and freeze (at or after `maintenanceFrom`).
   */
  function freezeBroke(handler: OpKindHandler, op: OpFile): boolean {
    return handler.freeze && !op.pointOfNoReturn && op.params['frozenAt'] !== undefined && reachedBy(handler, op);
  }

  /**
   * `op` after its freeze broke ({@link freezeBroke}): without `params.frozenAt` and with the kind's `refreeze` applied.
   *
   * @throws TypeError when `refreeze` returns an op that is not the same op in a state it may go on from (one where it
   *   still holds its flag: at or after `maintenanceFrom`)
   */
  function refrozen(handler: OpKindHandler, refreeze: NonNullable<OpKindHandler['refreeze']>, op: OpFile): OpFile {
    const params = { ...op.params };
    delete params['frozenAt'];
    const thawed: OpFile = { ...op, params };
    const next = nextOf(thawed, refreeze(structuredClone(thawed)), op.kind);
    if (
      next.state === NEEDS_ATTENTION ||
      isTerminal(next.kind, next.state) ||
      next.params['frozenAt'] !== undefined ||
      !reached(handler, next.state)
    ) {
      throw new TypeError(`ops: the ${op.kind} refreeze must return the op unfrozen, in a state it can go on from`);
    }
    return next;
  }

  /**
   * 1d Task 11: asks the kind's `beforeMaintenance` about `op`, whose flag the machine is about to raise. A refusal ends
   * the op unasked through the kind's `cancel` ({@link endUnasked}), with no flag raised.
   *
   * @returns the status of the op it ended, or null when the kind lets the flag rise (or has no `beforeMaintenance`)
   * @throws the kind's `DB_UNAVAILABLE` or lock timeout, and a lost lock, with the op left as it was
   */
  async function refusedBeforeMaintenance(
    lock: HeldFileLock,
    handler: OpKindHandler,
    op: OpFile,
    deadline: number,
  ): Promise<OpStatus | null> {
    if (handler.beforeMaintenance === undefined) return null;
    try {
      await handler.beforeMaintenance(contextFor(() => op, deadline, lock, { latest: null }), structuredClone(op));
      return null;
    } catch (error) {
      if (isLockLost(error) || isTransient(error)) throw error;
      log.warn('ops: the kind refused the op before its maintenance; the op ends', { opId: op.opId, kind: op.kind, state: op.state, ...errorFields(error) });
      return endUnasked(lock, handler, op, deadline, errorOf(error), true);
    }
  }

  /**
   * Ends `op`, before its point of no return, in its failure state with `error`, nobody having asked (R1c-15): its
   * freeze broke and the kind has no `refreeze`, or its freeze timed out. With `undo` (the op did work) the kind's
   * `cancel` undoes that work first, given the op with `error` (an operator's cancel gives it none). A `cancel` that
   * fails for a while (`DB_UNAVAILABLE`, a lock) leaves the op as it was, for the next step or resume to try again; any
   * other failure is logged and the op ends all the same (what is left waits for the housekeeping).
   */
  async function endUnasked(
    lock: HeldFileLock,
    handler: OpKindHandler,
    op: OpFile,
    deadline: number,
    error: NonNullable<OpFile['error']>,
    undo: boolean,
  ): Promise<OpStatus> {
    const failing: OpFile = { ...op, error };
    if (undo && handler.cancel !== undefined) {
      try {
        await handler.cancel(contextFor(() => failing, deadline, lock, { latest: null }), structuredClone(failing));
      } catch (cause) {
        if (isLockLost(cause) || isTransient(cause)) throw cause;
        log.error('ops: the kind could not undo the work of an op that ends; what is left waits for the housekeeping', {
          opId: op.opId,
          kind: op.kind,
          ...errorFields(cause),
        });
      }
    }
    const next = ended(failing, failureState(op.kind), error);
    await endOp(lock, next, reachedBy(handler, op));
    return statusOf(next);
  }

  /** A handler step threw: see {@link OpKindHandler} for what happens. */
  async function handlerFailed(lock: HeldFileLock, handler: OpKindHandler, op: OpFile, error: unknown): Promise<OpStatus> {
    if (isLockLost(error) || isTransient(error)) throw error;
    log.error('ops: a step of the op failed', { opId: op.opId, kind: op.kind, state: op.state, ...errorFields(error) });
    if (op.pointOfNoReturn) {
      const next: OpFile = { ...op, stateBefore: op.state, state: NEEDS_ATTENTION, error: errorOf(error), heartbeatAt: o.clock() };
      lock.assertHeld();
      await writeOpFile(dataDir, next);
      await attention(next);
      return statusOf(next);
    }
    const next = ended(op, failureState(op.kind), errorOf(error));
    await endOp(lock, next, reachedBy(handler, op));
    return statusOf(next);
  }

  async function stepLocked(lock: HeldFileLock, deadline: number, monoDeadline: number): Promise<OpStatus | null> {
    const read = await readOpFile(dataDir);
    if (read === null) return null;
    if (read === 'corrupt') return corruptAttention(lock);
    let op: OpFile = read;
    if (isTerminal(op.kind, op.state)) {
      if (await lowerFlagOf(lock, op)) {
        log.warn('ops: the maintenance flag of an op that had ended was still up; it was lowered', { opId: op.opId, kind: op.kind });
      }
      await closeDedicated(null);
      return shownEnded(op);
    }
    await closeDedicated(op.opId); // connections of ops that ended in another process
    const handler = handlers.get(op.kind);
    if (handler === undefined) {
      log.warn('ops: this process cannot step the current op (unknown kind); it is left alone', { opId: op.opId, kind: op.kind });
      return statusOf(op);
    }

    // Only resume() (or a cancel) leaves needs_attention. Final review (OPS-ATTN-EXIT): its flag is not raised again
    // here, so `maintenance:off --force` holds while the op waits for someone (R1c-12); resume() raises it again.
    // Final review G2: except a freezing op past its point of no return (a restore loading), whose half-written tables
    // no process may serve: its flag comes back as before.
    const halfWritten = handler.freeze && op.pointOfNoReturn && reachedBy(handler, op);
    if (op.state === NEEDS_ATTENTION && !halfWritten) return statusOf(op);

    const now = o.clock();
    let flag = await readMaintenance(dataDir);
    // 1d Task 11: an op before its kind's `maintenanceFrom` holds no flag, so none is raised for it.
    if (handler.maintenance !== null && reachedBy(handler, op) && (flag === null || flag.opId !== op.opId)) {
      // M21: the process that began the op died between op.json and the flag (or the flag was removed by hand). 1d
      // Task 11: or the op has just reached `maintenanceFrom`. Before its point of no return the kind may still refuse
      // it (a snapshot backup began during the download, preflight 1D-23): then it ends with the flag never raised.
      if (op.state !== NEEDS_ATTENTION && !op.pointOfNoReturn) {
        const refused = await refusedBeforeMaintenance(lock, handler, op, deadline);
        if (refused !== null) return refused;
      }
      flag = { reason: handler.maintenance, since: now, opId: op.opId, exemptJobIds: [] };
      if (freezeBroke(handler, op)) {
        if (handler.refreeze === undefined) {
          // R1c-15: a kind that cannot redo its work under a new freeze ends, through its cancel; the flag stays down.
          log.warn('ops: the maintenance flag of a frozen op was down; its kind cannot redo its work, the op ends', { opId: op.opId, kind: op.kind, state: op.state });
          return endUnasked(lock, handler, op, deadline, freezeBroken(), true);
        }
        // Final review G2: a freeze that had begun broke while the flag was down: it starts over (op.json first, so
        // that a process that dies before the flag is written leaves the op unfrozen, and the next step raises the flag).
        log.warn('ops: the maintenance flag of a frozen op was down; the freeze starts over', { opId: op.opId, kind: op.kind, state: op.state });
        const thawed = refrozen(handler, handler.refreeze, op);
        lock.assertHeld();
        await writeOpFile(dataDir, thawed);
        op = thawed;
      }
      lock.assertHeld();
      await writeMaintenance(dataDir, flag);
    }
    if (op.state === NEEDS_ATTENTION) return statusOf(op);

    if (now - op.heartbeatAt > OPS_STALL_MS && handler.stalls?.(op) !== false) {
      op = { ...op, stateBefore: op.state, state: NEEDS_ATTENTION };
      lock.assertHeld();
      await writeOpFile(dataDir, op);
      await attention(op);
      return statusOf(op);
    }

    if (handler.freeze && op.params['frozenAt'] === undefined && reachedBy(handler, op)) {
      const since = flag !== null && flag.opId === op.opId ? flag.since : op.startedAt;
      const waited = now - since;
      let settled = waited >= FREEZE_SETTLE_MS;
      if (settled) {
        const h = o.db() ?? (await dedicatedFor(op.opId));
        settled = (await liveLeases(h, now, flag?.opId === op.opId ? flag.exemptJobIds : [])) === 0;
      }
      if (!settled) {
        if (waited <= FREEZE_WAIT_MS) return statusOf(op);
        log.warn('ops: job leases stayed alive through the freeze; the op ends', { opId: op.opId, kind: op.kind });
        // R1c-15: after a refreeze the op may have done work already (a backup's row and folder): its cancel undoes it.
        // 1d Task 11: so did an op past its initial state (an update's download), or begun in an entry state.
        const worked = op.state !== handler.initialState || op.backupId !== null;
        return endUnasked(lock, handler, op, deadline, freezeTimeout(), worked);
      }
      op = { ...op, params: { ...op.params, frozenAt: now } };
    }

    const hint: { latest: Hint | null } = { latest: null };
    const ctx = contextFor(() => op, deadline, lock, hint);
    for (;;) {
      const before = JSON.stringify(op);
      let next: OpFile;
      try {
        next = nextOf(op, await handler.step(ctx, structuredClone(op)), op.kind);
        if (reachedBy(handler, op) && !reachedBy(handler, next) && !isTerminal(next.kind, next.state)) {
          throw new TypeError(`ops: the ${op.kind} step must not go back before its maintenanceFrom without ending the op`);
        }
      } catch (error) {
        return handlerFailed(lock, handler, op, error);
      }
      const progressed = JSON.stringify(next) !== before;
      const at = o.clock();
      next = { ...next, heartbeatAt: at };
      const terminal = isTerminal(next.kind, next.state);
      if (terminal) next = { ...withoutSecret(next), finishedAt: at };
      const enteredAttention = next.state === NEEDS_ATTENTION && op.state !== NEEDS_ATTENTION;
      if (enteredAttention && next.stateBefore === undefined) next = { ...next, stateBefore: op.state };
      // 1d Task 11: an op that reached its kind's `maintenanceFrom` stops here; the next step asks the kind, raises the
      // flag and waits for the freeze before the handler steps it in that state.
      const reachedNow = !terminal && !reachedBy(handler, op) && reachedBy(handler, next);
      if (terminal) {
        await endOp(lock, next, reachedBy(handler, op)); // the flag first: the hint below waits on the database
        op = next;
        await flushHint(op, hint);
        break;
      }
      lock.assertHeld();
      await writeOpFile(dataDir, next);
      op = next;
      await flushHint(op, hint);
      if (enteredAttention) {
        await attention(op);
        break;
      }
      if (reachedNow || !progressed || o.clock() >= deadline || performance.now() >= monoDeadline) break;
      if (await controlWaiting()) break; // a cancel, takeover or resume goes first (final review)
    }
    return statusOf(op);
  }

  /** Runs `fn` under `ops/step.lock` with `waitMs`. */
  async function locked<T>(fn: (lock: HeldFileLock) => Promise<T>, waitMs: number): Promise<T> {
    await ensureDir(opsDir());
    return withFileLock(lockPath(), fn, { waitMs });
  }

  /**
   * `fn` with the current op, which must not have ended, ahead of the steppers ({@link withControlLock}); `deadline`
   * (on `o.clock`) is what is left of the action's {@link CONTROL_BUDGET_MS} once it holds the lock.
   */
  function controlled<T>(fn: (lock: HeldFileLock, op: OpFile, deadline: number) => Promise<T>): Promise<T> {
    const began = performance.now();
    return withControlLock(dataDir, { now: o.clock, waitMs: controlWaitMs }, async (lock) => {
      const op = await readOpFile(dataDir);
      if (op === 'corrupt') throw unreadableOp();
      if (op === null || isTerminal(op.kind, op.state)) throw noOp();
      const left = Math.max(1000, CONTROL_BUDGET_MS - (performance.now() - began));
      return fn(lock, op, o.clock() + left);
    });
  }

  async function current(): Promise<OpStatus | null> {
    const op = await readOpFile(dataDir);
    if (op === null) return null;
    if (op === 'corrupt') return corruptStatus();
    return isTerminal(op.kind, op.state) ? shownEnded(op) : statusOf(op);
  }

  return {
    async begin(kind, actor, params, bo = {}) {
      const handler = handlers.get(kind);
      if (handler === undefined) throw new TypeError(`begin: this machine has no handler for kind ${JSON.stringify(kind)}`);
      const who = checkActor(actor, 'begin');
      const copy = jsonParams(params);
      // 1d Task 11: the initial state, or one of the kind's entry states (§9.8 begins an update at `verified`).
      const state = bo.state ?? handler.initialState;
      if (state !== handler.initialState && !(handler.entryStates ?? []).includes(state)) {
        throw new TypeError(`begin: ${kind} ops begin in ${handler.initialState} or one of the kind's entry states, not ${JSON.stringify(state)}`);
      }
      if (handler.freeze && (await o.snapshotBackupRunning())) {
        throw new DomainError('OPS_BLOCKED_BY_BACKUP', {
          detail: 'Backup snapshot sedang berjalan; coba lagi setelah selesai / A snapshot backup is running; try again once it ends',
        });
      }
      try {
        return await locked(async (lock) => {
          const cur = await readOpFile(dataDir);
          if (cur === 'corrupt' || (cur !== null && !isTerminal(cur.kind, cur.state))) throw inProgress();
          if (cur !== null) {
            await lowerFlagOf(lock, cur); // a flag the ended op left up (the new op raises its own)
            lock.assertHeld();
            await archiveOpFile(dataDir, cur);
          }
          const now = o.clock();
          const opId = newId(now);
          const token = randomToken();
          const op: OpFile = {
            opSchema: 1,
            opId,
            kind,
            actor: who,
            state,
            version: o.appVersion ?? '',
            backupId: null,
            heartbeatAt: now,
            startedAt: now,
            finishedAt: null,
            error: null,
            opsTokenHash: sha256hex(token),
            pointOfNoReturn: false,
            params: copy,
            progress: 0,
            message: null,
          };
          if (bo.secret !== undefined) {
            op.secretParam = sealValue(o.keyring(), secretAadOf(opId), encodeBase64Url(bo.secret));
          }
          lock.assertHeld();
          await clearCorruptReported(dataDir); // op.json is readable again: a later unreadable one is a new report
          reportedHere.clear();
          if (!(await createOpFile(dataDir, op))) throw inProgress();
          // 1d Task 11: no flag before the kind's `maintenanceFrom`; the step that reaches it raises the flag.
          if (handler.maintenance !== null && reached(handler, state)) {
            await writeMaintenance(dataDir, { reason: handler.maintenance, since: now, opId, exemptJobIds: [] });
          }
          return { opId, opsToken: token };
        }, BEGIN_LOCK_WAIT_MS);
      } catch (error) {
        if (isLockTimeout(error)) throw inProgress();
        throw error;
      }
    },

    async step(budgetMs) {
      if (typeof budgetMs !== 'number' || !(budgetMs > 0) || !Number.isFinite(budgetMs)) {
        throw new RangeError('step: budgetMs must be a positive number');
      }
      const deadline = o.clock() + budgetMs;
      const monoDeadline = performance.now() + budgetMs;
      // Without an op that can move, no lock is needed: unless the op ended with its flag still up (the locked path
      // lowers it).
      const peek = await readOpFile(dataDir);
      if (peek === null || (peek !== 'corrupt' && isTerminal(peek.kind, peek.state) && !(await flagLeftUp(peek)))) {
        await closeDedicated(null);
        return peek === null ? null : shownEnded(peek);
      }
      // A control action waits for the lock: it goes first (final review), this step answers the status as it is.
      if (await controlWaiting()) return current();
      try {
        return await locked(
          async (lock) => ((await controlWaiting()) ? current() : stepLocked(lock, deadline, monoDeadline)),
          STEP_LOCK_WAIT_MS,
        );
      } catch (error) {
        if (isLockTimeout(error)) return current(); // another process is stepping
        throw error;
      }
    },

    current,

    cancel(actor, co = {}) {
      const who = checkActor(actor, 'cancel');
      return controlled(async (lock, op, deadline) => {
        if (co.opId !== undefined && op.opId !== co.opId) throw noOp();
        if (op.pointOfNoReturn) {
          throw new DomainError('OPS_POINT_OF_NO_RETURN', {
            detail: 'Operasi sudah melewati titik tanpa kembali / The operation is past its point of no return',
          });
        }
        const handler = handlers.get(op.kind);
        if (handler?.cancel !== undefined) {
          const hint: { latest: Hint | null } = { latest: null };
          await handler.cancel(contextFor(() => op, deadline, lock, hint), structuredClone({ ...op, error: null }));
        }
        const now = o.clock();
        const next = ended({ ...op, params: { ...op.params, cancelledBy: who, cancelledAt: now } }, failureState(op.kind), null);
        await endOp(lock, next, mayHold(op));
        log.info('ops: the op was cancelled', { opId: op.opId, kind: op.kind, actorType: who.type });
        return statusOf(next);
      });
    },

    takeover(actor) {
      const who = checkActor(actor, 'takeover');
      return controlled(async (lock, op) => {
        const token = randomToken();
        const next: OpFile = { ...op, actor: who, opsTokenHash: sha256hex(token) };
        lock.assertHeld();
        await writeOpFile(dataDir, next);
        return { opId: op.opId, opsToken: token };
      });
    },

    resume() {
      return controlled(async (lock, op, deadline) => {
        if (op.state !== NEEDS_ATTENTION || op.stateBefore === undefined) return statusOf(op);
        const { stateBefore, ...rest } = op;
        const now = o.clock();
        const moving: OpFile = { ...rest, state: stateBefore, error: null, heartbeatAt: now };
        // The op moves again under its maintenance: a flag forced off while it needed attention comes back. 1d Task
        // 11: only where the op holds one (at or after its kind's `maintenanceFrom`).
        const handler = handlers.get(op.kind);
        const reason = handler !== undefined && reached(handler, stateBefore) ? handler.maintenance : null;
        const forcedOff = reason !== null && (await readMaintenance(dataDir))?.opId !== op.opId;
        // 1d Task 11: before its point of no return the kind may still refuse the op before its flag rises again.
        if (forcedOff && handler !== undefined && !moving.pointOfNoReturn) {
          const refused = await refusedBeforeMaintenance(lock, handler, moving, deadline);
          if (refused !== null) return refused;
        }
        // Final review G2: the database was not frozen while the flag was off, so a freeze starts over, and so does the
        // work done under it (refrozen). op.json goes first: a process that dies before the flag is written leaves an
        // unfrozen op, whose next step raises the flag (M21) and waits for the freeze.
        let next = moving;
        if (forcedOff && handler !== undefined && freezeBroke(handler, moving)) {
          if (handler.refreeze === undefined) {
            // R1c-15: a kind that cannot redo its work under a new freeze ends, through its cancel; no flag is raised.
            log.warn('ops: the maintenance flag of a frozen op was forced off; its kind cannot redo its work, the op ends', { opId: op.opId, kind: op.kind, state: moving.state });
            return endUnasked(lock, handler, moving, deadline, freezeBroken(), true);
          }
          next = refrozen(handler, handler.refreeze, moving);
        }
        lock.assertHeld();
        await writeOpFile(dataDir, next);
        if (forcedOff && reason !== null) {
          lock.assertHeld();
          await writeMaintenance(dataDir, { reason, since: now, opId: op.opId, exemptJobIds: [] });
        }
        log.info('ops: the op was resumed', { opId: op.opId, kind: op.kind, state: next.state, refrozen: next !== moving });
        return statusOf(next);
      });
    },

    async setAsideUnreadable(actor) {
      const who = checkActor(actor, 'setAsideUnreadable');
      return withControlLock(dataDir, { now: o.clock, waitMs: controlWaitMs }, async (lock) => {
        if ((await readOpFile(dataDir)) !== 'corrupt') return null;
        const flag = await readMaintenance(dataDir);
        const now = o.clock();
        const folder = newId(now);
        lock.assertHeld();
        if (flag !== null) {
          // The flag first: once op.json is gone nothing else keeps maintenance, and the data may be half done.
          await writeMaintenance(dataDir, { reason: 'manual', since: now, opId: null, exemptJobIds: [] });
        }
        await setAsideOpFiles(dataDir, folder);
        const opId = flag?.opId ?? null;
        const kind = flag === null ? null : REASON_KIND[flag.reason];
        log.warn('ops: an unreadable op.json was set aside; maintenance stays as a manual flag', { opId, kind, folder, actorType: who.type });
        return { opId, kind, folder };
      });
    },

    async tokenMatches(token) {
      if (typeof token !== 'string' || token.length === 0 || token.length > 256) return false;
      const op = await readOpFile(dataDir);
      if (op === null || op === 'corrupt' || op.opsTokenHash === null) return false;
      if (isTerminal(op.kind, op.state) && visible(op) === null) return false;
      return safeEqual(sha256hex(token), op.opsTokenHash);
    },

    close() {
      return closeDedicated(null);
    },
  };
}
