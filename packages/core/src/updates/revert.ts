import type { DB } from '@altis/db';
import { updateCurrentState } from '@altis/platform';
import { compareSemver, isSemver } from '@altis/shared';
import type { Kysely } from 'kysely';
import { errorFields } from '../context.js';
import type { OpFile } from '../ops/files.js';
import type { OpStepContext } from '../ops/machine.js';
import type { RestoreRun, RestoreRunParams } from '../restore/runner.js';
import { finishUpdate } from './finish.js';
import type { UpdateKindDeps, UpdateParams } from './kind.js';
import { readReleaseLog } from './releases-log.js';

// The automatic revert of an update (spec §9.7; plan Task 25; decisions D1d-21, D1d-42, D1d-44; preflight B8, S21,
// 1D-07): the states an update op reaches when its target failed to boot after the point of no return (app.js's
// `recordPendingFailure`, a migration or health failure the target's own steps recorded, or a step of another release
// that found `pending` cleared, S3). The release the update left (N) steps them; the target never does (its own
// revert: `opBootPlan` answers `refuse` there, and a direct step leaves the op as it is, B8).
//
//   reverting   `current.json.pending` still the target (a kill between the op record and app.js's own clear) →
//               `pending = null`. Then the database decides (D1d-21): `schema_meta.min_code_version ≤ N`
//               ({@link schemaCompat}) → the pointer alone went back, `rolled_back`. Otherwise N is "terlalu lama"
//               for it: without a `pre_update` backup → `restore_failed` (maintenance kept, the error names the CLI
//               steps); with one → the restore runner is begun on it (`params.restore`), `restoring`.
//   restoring   the runner stepped (spec §9.7: no new key, no `pre_restore` backup, secrets through branch (a),
//               `targetSchema: 'backup'`, tables dropped by `schema_tables`) until it is `done` → `restored`, then
//               `requestRestart('restore')` (every process serves the restored data, P14); `failed` (before the
//               runner's point of no return, the database untouched) → `restore_failed`, maintenance kept. Past its
//               point of no return the runner throws: the machine moves the op to `needs_attention` (maintenance kept,
//               resumable from the run's checkpoint; the target's kept rows wait in ops/<opId>/keep/).
//
// The runner is begun with `withoutFiles: false` (Task 12's report): the revert restores this installation's own
// backup into its own DATA_DIR, so the uploads in place stay `ok` (with `true` every upload would be marked missing).
// Nothing here publishes a progress hint: the `events` table may be dropped or reloaded while the restore runs.
//
// Every step is idempotent (P7): the pointer write changes nothing the second time, finishUpdate records an end once
// (a final `releases_log` row stays as it is), and the runner resumes from its checkpoint. `params` and
// `params.restore` are read loosely and written back with every field this release does not know (S21).

/** The steps the operator can run from a terminal when the revert cannot restore anything (spec §9.7). */
const CLI_STEPS = 'node app.js backup:restore <backupId>, node app.js release:rollback';

/**
 * Whether the database accepts code `appVersion`: `schema_meta.min_code_version ≤ appVersion` (decision D1d-21). A
 * missing row, or a value that is not SemVer, accepts nothing.
 */
export async function schemaCompat(db: Kysely<DB>, appVersion: string): Promise<boolean> {
  const row = await db.selectFrom('schema_meta').select('min_code_version').where('id', '=', 1).executeTakeFirst();
  const min = row?.min_code_version;
  if (typeof min !== 'string' || !isSemver(min) || !isSemver(appVersion)) return false;
  return compareSemver(min, appVersion) <= 0;
}

/** The restore the revert begins on the `pre_update` backup `backupId` (spec §9.7 `restoring`). */
export function revertRestoreParams(backupId: string): RestoreRunParams {
  return {
    backupId,
    source: 'server',
    targetSchema: 'backup',
    skipPreRestore: true,
    secrets: 'a',
    dropBy: 'schema_tables',
    confirmed: true,
    // Task 12's report: the revert restores its own backup into its own DATA_DIR; the uploads in place stay `ok`.
    withoutFiles: false,
  };
}

/** `op` with `set` merged into its params; every other param kept as it was (S21). */
function withParams(op: OpFile, set: Record<string, unknown>): OpFile {
  return { ...op, params: { ...op.params, ...set } };
}

/** This process's handle, or the op's dedicated connection (P17). */
async function dbOf(ctx: OpStepContext) {
  return ctx.db() ?? (await ctx.connectDedicated());
}

/** The `pre_update` backup of the op: op.json's, else the one its `releases_log` row names (an op.json rewritten by hand). */
async function backupOf(ctx: OpStepContext, op: OpFile): Promise<string | null> {
  if (op.backupId !== null) return op.backupId;
  const row = await readReleaseLog((await dbOf(ctx)).db, op.opId);
  return row?.backupId ?? null;
}

/**
 * `reverting` (see the top of this file), stepped by a release other than the target.
 *
 * @throws TypeError without a restore runner when one is needed (the machine: `needs_attention`); the database's
 *   errors (`DB_UNAVAILABLE`: the op left as it was)
 */
export async function revertingStep(d: UpdateKindDeps, ctx: OpStepContext, op: OpFile, p: UpdateParams): Promise<OpFile> {
  if (d.appVersion === p.target) return op; // B8: the target never steps its own revert
  // The pointer first: a release that still names the target as pending would boot it again (S3).
  ctx.lock.assertHeld();
  await updateCurrentState(ctx.dataDir, (s) =>
    s.pending !== null && s.pending.version === p.target ? { ...s, pending: null, pendingSince: null } : null,
  );
  const h = await dbOf(ctx);
  if (await schemaCompat(h.db, d.appVersion)) {
    ctx.log.warn('update: reverted; the database accepts this release, so only the pointer went back', { opId: op.opId, target: p.target });
    await finishUpdate(ctx, op, 'rolled_back', d);
    return { ...op, state: 'rolled_back' };
  }
  const backupId = await backupOf(ctx, op);
  if (backupId === null) {
    const failing: OpFile = {
      ...op,
      error: {
        code: 'SCHEMA_TOO_NEW',
        detail:
          `Database memerlukan rilis yang lebih baru dari ${d.appVersion} dan tidak ada backup pre_update untuk dipulihkan; ` +
          `pulihkan backup lewat terminal: ${CLI_STEPS} / ` +
          `The database needs a newer release than ${d.appVersion} and there is no pre_update backup to restore; ` +
          `restore a backup from a terminal: ${CLI_STEPS}`,
      },
    };
    ctx.log.error('update: the revert cannot restore: no pre_update backup; maintenance stays', { opId: op.opId, target: p.target });
    await finishUpdate(ctx, failing, 'restore_failed', d);
    return { ...failing, state: 'restore_failed' };
  }
  if (d.restore === null) throw new TypeError('update op: the revert needs a restore runner (UpdateKindDeps.restore)');
  const run = d.restore.begin(revertRestoreParams(backupId));
  ctx.log.warn('update: reverted; the database is too new for this release, its pre_update backup is restored', { opId: op.opId, target: p.target, backupId });
  return { ...withParams(op, { restore: run }), backupId, state: 'restoring', progress: 0 };
}

/**
 * `restoring` (see the top of this file), stepped by a release other than the target: one runner step per op step.
 *
 * @throws TypeError without a restore runner or a run in `params.restore`; the runner's errors past its point of no
 *   return (the machine: `needs_attention`, resumable); `DB_UNAVAILABLE` and lock timeouts (the op left as it was)
 */
export async function restoringStep(d: UpdateKindDeps, ctx: OpStepContext, op: OpFile, p: UpdateParams): Promise<OpFile> {
  if (d.appVersion === p.target) return op; // B8
  if (d.restore === null) throw new TypeError('update op: the revert needs a restore runner (UpdateKindDeps.restore)');
  if (p.restore === undefined) throw new TypeError('update op: restoring without params.restore');
  const run = await d.restore.step(ctx, p.restore as unknown as RestoreRun, { opId: op.opId, actor: op.actor });
  const next: OpFile = { ...withParams(op, { restore: run }), progress: Math.min(100, Math.max(0, Math.floor(run.progress ?? op.progress))) };
  if (run.state === 'done') {
    await finishUpdate(ctx, next, 'restored', d);
    try {
      await d.requestRestart('restore');
    } catch (error) {
      ctx.log.warn('update: the restart after the restore could not be requested', { opId: op.opId, ...errorFields(error) });
    }
    return { ...next, state: 'restored', progress: 100 };
  }
  if (run.state === 'failed') {
    const failing: OpFile = { ...next, error: run.error === null ? { code: 'INTERNAL' } : runError(run.error) };
    ctx.log.error('update: the restore of the revert failed before it changed anything; maintenance stays', { opId: op.opId, code: failing.error?.code });
    await finishUpdate(ctx, failing, 'restore_failed', d);
    return { ...failing, state: 'restore_failed' };
  }
  return next;
}

/** What op.json records of a failed run: its code and detail (the run's own bounds), and its reason. */
function runError(e: NonNullable<RestoreRun['error']>): NonNullable<OpFile['error']> {
  const out: NonNullable<OpFile['error']> & { reason?: string } = { code: e.code };
  if (e.detail !== undefined) out.detail = e.detail;
  if (e.reason !== undefined) out.reason = e.reason;
  return out;
}
