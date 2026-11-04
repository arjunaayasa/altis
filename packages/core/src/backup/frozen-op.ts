import { ensureHeadroom } from '@altis/platform';
import { DomainError, isDomainError } from '@altis/shared';
import { z } from 'zod';
import { errorFields } from '../context.js';
import type { OpFile } from '../ops/files.js';
import type { OpKindHandler, OpStepContext } from '../ops/machine.js';
import {
  abandonBackup,
  auditHeadOf,
  backupFinished,
  backupHeadroomBytes,
  finishBackup,
  insertBackupRow,
  publishBackupProgress,
  schemaVersionOf,
  type BackupDeps,
} from './create-job.js';
import { createExporter, exportCheckpointSchema } from './exporter.js';

// The frozen backup: the `backup` op kind (spec §9.4, §9.9 "frozen"; decisions C9, C12; preflight S24; P7, P21).
// `begin` raises maintenance `backup` (the gate closes the writing routes, claims pause in every process), and the
// machine waits for the freeze (no live job lease, at least 3 s, at most 60 s, else `aborted` with
// OPS_FREEZE_TIMEOUT) before the kind's first step. Then:
//
//   frozen     the headroom (S8), the `backups` row (`running`, `frozen`; its id is the op's own, so a step run again
//              finds it), the audit chain head as it froze (`params.auditHead`: the manifest's, and audit_log is
//              exported up to it, since normal maintenance still lets sign-ins write audit entries), → `exporting`;
//   exporting  one exporter step per op step on the op's dedicated connection (P17) with the checkpoint in
//              `op.params.checkpoint` (any process resumes it: the database does not change while frozen), two progress
//              hints each step on `system.backup` (S24): `op.progress` (the machine's) and, as a snapshot backup's
//              slice does, `backup.progress {backupId, progress}` (ruling R1c-13: the backup screens and the bell
//              follow one event type for both modes; best effort), → `done` once the manifest is written: the row
//              `ok`, `backup.done`, the notification and the retention (finishBackup, the last two best effort);
//              the machine then lowers the maintenance flag. A step that finds the row `ok` already (its op.json
//              write was lost) or fails after it turned `ok` ends `done` too: a finished backup is never abandoned;
//   aborted    a failure (a full disk or quota included, P21): the backup's folder removed, its row `failed`, the
//              notifications (`disk_low` for a quota); the machine lowers the flag. A lost connection or a busy lock
//              leaves the op as it was for the next step. `cancel` before `done` removes the folder and fails the row,
//              then the machine ends the op `aborted`.
//
// A broken freeze (final review G2: the flag was down after the export began, forced off while the op needed attention
// or removed by hand, so the database changed under it): `refreeze` sends an `exporting` op back to `frozen` without
// its checkpoint and audit head, and the machine freezes again. The same row and folder then take a new audit head
// and an export from the start: every part written again from the first (the exporter's `step(null)` starts the part
// log over and drops stale later parts), so no table keeps rows read before the break. A freeze that then times out
// (a lease alive past 60 s) ends the op `aborted` with OPS_FREEZE_TIMEOUT through `cancel`: the row `failed`, the
// folder removed (R1c-15).
//
// `op.params`: `{kind: 'manual' | 'scheduled', includeFiles, checkpoint, auditHead}` (plus who began it:
// `convertedFrom`, `scheduleJob`).

/** What the op needs from the installation (its DATA_DIR is the machine's, `ctx.dataDir`). */
export type BackupOpDeps = Omit<BackupDeps, 'dataDir'>;

const paramsSchema = z.looseObject({
  kind: z.enum(['manual', 'scheduled']),
  includeFiles: z.boolean(),
  checkpoint: exportCheckpointSchema.nullable().optional(),
  auditHead: z.strictObject({ seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), hash: z.string().min(1).max(128) }).optional(),
});

/** What the machine records of a failure (its errorOf): a code, and the detail of a 4xx DomainError. */
function errorOf(error: unknown): NonNullable<OpFile['error']> {
  if (isDomainError(error)) {
    return error.status < 500 && error.detail !== undefined ? { code: error.code, detail: error.detail } : { code: error.code };
  }
  return { code: 'INTERNAL' };
}

/** Errors after which the same step may succeed later (the machine leaves the op as it was). */
function transient(error: unknown): boolean {
  if (!isDomainError(error)) return false;
  if (error.code === 'DB_UNAVAILABLE') return true;
  const reason = error.meta?.['reason'];
  return error.code === 'STATE_CORRUPT' && (reason === 'lock_timeout' || reason === 'lock_lost');
}

async function frozenStep(d: BackupOpDeps, ctx: OpStepContext, op: OpFile): Promise<OpFile> {
  const parsed = paramsSchema.safeParse(op.params);
  if (!parsed.success) throw new TypeError('backup op: params must be {kind, includeFiles, checkpoint?}');
  const params = parsed.data;
  const write = ctx.db() ?? (await ctx.connectDedicated());
  try {
    if (op.state === 'frozen') {
      await ensureHeadroom(ctx.dataDir, await backupHeadroomBytes(write.db));
      const backupId = op.backupId ?? op.opId;
      const row = { schemaVersion: await schemaVersionOf(write.db), now: ctx.now() };
      await insertBackupRow(write, {
        id: backupId,
        kind: params.kind,
        consistency: 'frozen',
        dialect: write.dialect,
        schemaVersion: row.schemaVersion,
        appVersion: d.appVersion,
        now: row.now,
      });
      // A refrozen backup (its row made under the broken freeze) dates from this freeze, as its data and its
      // manifest's createdAt do: the list, the newest backup and the retention's weeks go by created_at.
      await write.db
        .updateTable('backups')
        .set({ created_at: row.now, schema_version: row.schemaVersion })
        .where('id', '=', backupId)
        .where('status', '=', 'running')
        .execute();
      // The head as the database froze: the manifest records it, and audit_log is exported up to it (the sign-ins
      // normal maintenance allows append after it while the export goes on).
      const auditHead = await auditHeadOf(write.db);
      return { ...op, state: 'exporting', backupId, params: { ...op.params, checkpoint: null, auditHead }, progress: 0, message: null };
    }
    if (op.state !== 'exporting') return op;
    const backupId = op.backupId;
    if (backupId === null) throw new DomainError('STATE_CORRUPT', { meta: { reason: 'backup_id' } });
    // Finished by a step whose own op.json write was lost (P7): exporting again would rewrite its manifest.
    if (await backupFinished(write.db, backupId)) return { ...op, state: 'done', progress: 100 };
    const read = await ctx.connectDedicated();
    const exporter = createExporter({
      read: read.db,
      dialect: read.dialect,
      dataDir: ctx.dataDir,
      backupId,
      kind: params.kind,
      includeFiles: params.includeFiles,
      consistency: 'frozen',
      appVersion: d.appVersion,
      schemaVersion: await schemaVersionOf(read.db),
      installId: d.installId,
      sessionKey: d.sessionKey,
      kids: [...d.kids],
      auditHead: params.auditHead ?? (await auditHeadOf(read.db)),
      clock: () => ctx.now(),
    });
    const r = await exporter.step(params.checkpoint ?? null, { deadline: ctx.deadline });
    ctx.publish({ progress: r.progress });
    try {
      await publishBackupProgress(write, backupId, r.progress);
    } catch (error) {
      ctx.log.warn('backup: the backup.progress hint could not be published', { opId: op.opId, backupId, ...errorFields(error) });
    }
    const next = { ...op, params: { ...op.params, checkpoint: r.checkpoint }, progress: r.progress };
    if (!r.done) return next;
    ctx.lock.assertHeld();
    await finishBackup(write, ctx.dataDir, { backupId, now: ctx.now(), log: ctx.log });
    return { ...next, state: 'done', progress: 100 };
  } catch (error) {
    if (transient(error)) throw error;
    if (op.backupId !== null && (await backupFinished(write.db, op.backupId).catch(() => false))) {
      // The backup ended `ok` before the failure (finishBackup's commit whose answer was lost): the op is done.
      ctx.log.warn('backup: a failure after the backup finished; the backup stays', { opId: op.opId, backupId: op.backupId, ...errorFields(error) });
      return { ...op, state: 'done', progress: 100 };
    }
    ctx.log.error('backup: the frozen backup failed', { opId: op.opId, backupId: op.backupId, ...errorFields(error) });
    await abandonBackup(write, ctx.dataDir, { backupId: op.backupId, error, now: ctx.now(), log: ctx.log, notify: true });
    return { ...op, state: 'aborted', error: errorOf(error) };
  }
}

/**
 * The `backup` op kind (see the top of this file): maintenance `backup`, freeze. `deps` is read at every step (the
 * config of the moment).
 */
export function backupKind(deps: () => BackupOpDeps): OpKindHandler {
  return {
    kind: 'backup',
    initialState: 'frozen',
    maintenance: 'backup',
    freeze: true,
    step: (ctx, op) => frozenStep(deps(), ctx, op),
    refreeze(op) {
      if (op.state !== 'exporting') return op; // `frozen` has exported nothing yet
      const params = { ...op.params };
      delete params['checkpoint'];
      delete params['auditHead'];
      return { ...op, state: 'frozen', params, progress: 0, message: null };
    },
    async cancel(ctx, op) {
      if (op.backupId === null) return;
      const write = ctx.db() ?? (await ctx.connectDedicated());
      await abandonBackup(write, ctx.dataDir, { backupId: op.backupId, error: null, now: ctx.now(), log: ctx.log, notify: false });
    },
  };
}
