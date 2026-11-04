import { atomicWriteJson, dataPath, ensureDir, readJsonWithBak, withFileLock } from '@altis/platform';
import { NEEDS_ATTENTION, OP_TERMINAL_STATES, isDomainError } from '@altis/shared';

// app.js and DATA_DIR/ops/op.json (decision D1d-18, preflight B8, S3, 1D-02): the three things the bootloader does
// to the `update` op of the release it boots as `pending`, and nothing else.
//
// - recordPendingFailure: before `pending` is cleared, the op is moved to `reverting` with UPDATE_BOOT_FAILED, under
//   `ops/step.lock` like every op.json write. `pending` is never cleared unless this answered (S3).
// - readUpdateOpFor: before the pending release is imported, a look at the op (no lock): when it is already settled
//   (reverting, restoring, or stuck after the point of no return), the release is reverted without being imported (B8).
// - touchOpHeartbeat: while app.js holds boot.lock, the op's `heartbeatAt` is refreshed every 10 s (§9.3), so that a
//   boot that takes long (a migration) does not look stalled to the ops machine. It skips when the step lock is busy.
//
// op.json is read as plain JSON, and written back with every field this code does not know (opSchema 1 is shared with
// every later release, which may add fields: app.js is frozen with the first public release). Writes go through
// atomicWriteJson, as the server's own (temporary file, fsync, rename, `.bak`). An op is judged by its effective
// state: `stateBefore` for an op in `needs_attention` (1D-02). app.js never touches an op of another kind or target.
//
// app.js bundles this module (ES2017, P1).

/** How long recordPendingFailure waits for `ops/step.lock` before it answers `busy` (S3). */
export const STEP_LOCK_WAIT_MS = 25_000;

/** The detail of a pending boot failure, as op.json's `error.detail` holds it. */
export type PendingFailureDetail = 'verify' | 'import' | 'start' | 'repeated' | 'stalled';

/** The error recordPendingFailure writes into the op. */
export interface PendingFailure {
  code: 'UPDATE_BOOT_FAILED';
  detail: PendingFailureDetail;
}

/**
 * What recordPendingFailure did: `written` (the op moved to `reverting`), `already` (it was reverting, restoring or
 * ended), `none` (no update op of that target after its point of no return: left alone), `busy` (the step lock was
 * not free in time: nothing written).
 */
export type PendingRecord = 'written' | 'already' | 'none' | 'busy';

const PENDING_FAILURE_DETAILS: readonly string[] = ['verify', 'import', 'start', 'repeated', 'stalled'];

/** The states in which the target boots, after the point of no return: a failure of the boot reverts the op. */
const BOOT_STATES: readonly string[] = ['switched', 'booting', 'migrating', 'verifying'];
/** The states of a revert, which the release left behind steps (§9.7). */
const REVERT_STATES: readonly string[] = ['reverting', 'restoring'];

/** True for one of the details a pending boot failure reports. */
export function isPendingFailureDetail(value: unknown): value is PendingFailureDetail {
  return typeof value === 'string' && PENDING_FAILURE_DETAILS.indexOf(value) !== -1;
}

type Op = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** op.json as plain JSON: an `opSchema 1` object with a kind, a state and params; the rest is kept as it is. */
function parseOp(raw: unknown): Op {
  if (!isRecord(raw)) throw new TypeError('op.json: not an object');
  if (raw['opSchema'] !== 1) throw new TypeError('op.json: not opSchema 1');
  if (typeof raw['kind'] !== 'string' || typeof raw['state'] !== 'string' || !isRecord(raw['params'])) {
    throw new TypeError('op.json: kind, state or params');
  }
  return raw;
}

function opFile(dataDir: string) {
  return dataPath(dataDir, 'ops', 'op.json');
}

/** The op (from its `.bak` when op.json is torn), or null when there is none or neither file can be used. */
async function readOp(dataDir: string): Promise<Op | null> {
  try {
    return await readJsonWithBak(opFile(dataDir), parseOp);
  } catch (error) {
    // Both unusable (STATE_CORRUPT): there is no op app.js can judge; the server reports it (needs_attention).
    if (isDomainError(error) && error.code === 'STATE_CORRUPT') return null;
    throw error;
  }
}

/** The op is the `update` op whose target is `version`. */
function isUpdateFor(op: Op, version: string): boolean {
  return op['kind'] === 'update' && (op['params'] as Record<string, unknown>)['target'] === version;
}

/** `stateBefore` for an op in `needs_attention` (1D-02), else its state. */
function effectiveState(op: Op): string {
  const state = op['state'] as string;
  const before = op['stateBefore'];
  return state === NEEDS_ATTENTION && typeof before === 'string' ? before : state;
}

function ended(op: Op): boolean {
  return OP_TERMINAL_STATES.update.indexOf(op['state'] as string) !== -1;
}

function lockTimedOut(error: unknown): boolean {
  return isDomainError(error) && error.code === 'STATE_CORRUPT' && error.meta !== undefined && error.meta['reason'] === 'lock_timeout';
}

/** A copy of `op` with `changes` (ES2017: no object spread). */
function changed(op: Op, changes: Op): Op {
  const next: Op = {};
  for (const key of Object.keys(op)) next[key] = op[key];
  for (const key of Object.keys(changes)) next[key] = changes[key];
  return next;
}

/**
 * Records the failed boot of the pending release `version` in op.json, under `ops/step.lock` (waiting at most
 * `o.waitMs`, default {@link STEP_LOCK_WAIT_MS}):
 * - the `update` op of target `version` whose effective state is `switched`, `booting`, `migrating` or `verifying` moves
 *   to `reverting`, with `stateBefore` (the state it left), `error` and `heartbeatAt = now` → `written`;
 * - that op already reverting or restoring, or ended → `already`;
 * - no op, an unreadable one, one of another kind or target, or one before its point of no return → `none` (left alone);
 * - the step lock not taken in time → `busy`, nothing written: the caller keeps `pending` and tries again later (S3).
 *
 * @throws DomainError `STATE_CORRUPT` `lock_io` or `lock_lost`, `DISK_QUOTA`, and other I/O errors: nothing is recorded
 */
export async function recordPendingFailure(
  dataDir: string,
  version: string,
  error: PendingFailure,
  now: number,
  o?: { waitMs?: number },
): Promise<PendingRecord> {
  await ensureDir(dataPath(dataDir, 'ops'));
  try {
    return await withFileLock(
      dataPath(dataDir, 'ops', 'step.lock'),
      async (lock): Promise<PendingRecord> => {
        const op = await readOp(dataDir);
        if (op === null || !isUpdateFor(op, version)) return 'none';
        if (ended(op)) return 'already';
        const state = effectiveState(op);
        if (REVERT_STATES.indexOf(state) !== -1) return 'already';
        if (BOOT_STATES.indexOf(state) === -1) return 'none';
        const next = changed(op, {
          state: 'reverting',
          stateBefore: state,
          error: { code: error.code, detail: error.detail },
          heartbeatAt: now,
        });
        lock.assertHeld();
        await atomicWriteJson(opFile(dataDir), next);
        return 'written';
      },
      { waitMs: o !== undefined && o.waitMs !== undefined ? o.waitMs : STEP_LOCK_WAIT_MS },
    );
  } catch (caught) {
    if (lockTimedOut(caught)) return 'busy';
    throw caught;
  }
}

/**
 * The `update` op of target `version`, read without a lock (a rename is atomic), or null when there is none (or op.json
 * cannot be used). `settled`: it is reverting or restoring, or in `needs_attention` after its point of no return, so
 * the pending release must be reverted without being imported (B8, 1D-02). `detail`: its `error.detail`, or null.
 *
 * @throws I/O errors other than a missing or unusable op.json (EACCES, ...)
 */
export async function readUpdateOpFor(dataDir: string, version: string): Promise<{ settled: boolean; detail: string | null } | null> {
  const op = await readOp(dataDir);
  if (op === null || !isUpdateFor(op, version)) return null;
  const state = effectiveState(op);
  let settled = REVERT_STATES.indexOf(state) !== -1;
  if (!settled && op['state'] === NEEDS_ATTENTION) {
    settled = op['pointOfNoReturn'] === true || BOOT_STATES.indexOf(state) !== -1;
  }
  const failure = op['error'];
  const detail = isRecord(failure) && typeof failure['detail'] === 'string' ? failure['detail'] : null;
  return { settled, detail };
}

/**
 * Sets `heartbeatAt = now` on the `update` op of target `version` while it boots (`switched` to `verifying`, not in
 * `needs_attention`), under `ops/step.lock`; when the lock is busy it skips at once (the stepper writes the heartbeat
 * then). Any other op, or none, is left alone.
 *
 * @throws as {@link recordPendingFailure}, except the busy lock
 */
export async function touchOpHeartbeat(dataDir: string, version: string, now: number): Promise<void> {
  await ensureDir(dataPath(dataDir, 'ops'));
  try {
    await withFileLock(
      dataPath(dataDir, 'ops', 'step.lock'),
      async (lock) => {
        const op = await readOp(dataDir);
        if (op === null || !isUpdateFor(op, version)) return;
        if (BOOT_STATES.indexOf(op['state'] as string) === -1) return;
        const heartbeatAt = op['heartbeatAt'];
        if (typeof heartbeatAt === 'number' && heartbeatAt >= now) return;
        lock.assertHeld();
        await atomicWriteJson(opFile(dataDir), changed(op, { heartbeatAt: now }));
      },
      { waitMs: 0 },
    );
  } catch (caught) {
    if (lockTimedOut(caught)) return;
    throw caught;
  }
}
