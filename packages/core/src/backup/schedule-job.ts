import { withTx, type DB, type DbHandle } from '@altis/db';
import type { Runtime } from '@altis/platform';
import { DomainError } from '@altis/shared';
import type { Transaction } from 'kysely';
import { enqueue } from '../jobs/enqueue.js';
import { createJobRegistry } from '../jobs/registry.js';
import type { JobHandler } from '../jobs/types.js';
import { notify } from '../notifications/service.js';
import type { OpActor } from '../ops/files.js';
import type { OpsMachine } from '../ops/machine.js';
import { scheduleWindowSchema, type ScheduleWindow } from '../scheduler/registry.js';
import {
  BACKUP_CREATE_JOB,
  BACKUPS_LINK,
  backupCreateJob,
  backupOpBegunBy,
  type BackupCreatePayload,
  type BackupJobDeps,
} from './create-job.js';
import { BACKUP_FROZEN_SKIP_MS, decideBackupMode } from './mode.js';

// Beginning a backup (spec §9.9; decisions C31, C41; preflight B5, S16): the mode is chosen (mode.ts), then a frozen
// backup begins the `backup` op, a snapshot backup enqueues the `backup.create` job. `POST backups`, `backup:create`
// and the daily schedule all begin theirs here.
//
// The daily schedule `backup.daily` (01:00 library time) enqueues the light job `backup.schedule` with the schedule
// window as its payload (S16). It finishes in one slice, so `POST /_cron` alone runs it (B5): a frozen backup estimated
// over 3 hours is skipped with `notification.backup_skipped` to the holders of `system.backup.read`; otherwise the
// frozen op begins (DB-only, §9.9: "Backup terjadwal ... default hanya DB"), or `backup.create` is enqueued with
// `uniqueKey 'backup:scheduled'`. A slice run again after its process died finds the op it began (its `scheduleJob`
// param) or the job it enqueued (the unique key), so a backup is begun once.

export const BACKUP_SCHEDULE_JOB = 'backup.schedule';

/** What {@link startBackup} began. */
export type StartedBackup =
  | { consistency: 'snapshot'; jobId: string; existing: boolean }
  | { consistency: 'frozen'; opId: string; opsToken: string }
  | { skipped: true; estimateMs: number };

/** A registry that knows `backup.create`'s payload, for enqueue (whose handler never runs from it). */
const enqueueRegistry = createJobRegistry([
  backupCreateJob(() => {
    throw new TypeError('backup.create of the enqueue registry never runs');
  }),
]);

/**
 * Begins a backup of `kind` now: chooses the mode (decideBackupMode); `frozen` → the `backup` op (`ops.begin`, params
 * `{kind, includeFiles, ...opParams}`), unless `skipLongFrozen` and the estimate is over 3 hours (then nothing);
 * `snapshot` → the `backup.create` job enqueued with `uniqueKey` (a live job holding it is returned instead).
 *
 * @throws DomainError `OPS_IN_PROGRESS`, `OPS_BLOCKED_BY_BACKUP` (409) from `ops.begin`; the database's errors
 */
export async function startBackup(o: {
  h: DbHandle;
  dataDir: string;
  runtime: Runtime;
  ops: OpsMachine;
  now: number;
  kind: 'manual' | 'scheduled';
  includeFiles: boolean;
  actor: OpActor;
  createdBy: string | null;
  uniqueKey: string;
  opParams?: Record<string, unknown>;
  skipLongFrozen?: boolean;
}): Promise<StartedBackup> {
  const { consistency, estimateMs } = await decideBackupMode(o.h.db, o.dataDir, { runtime: o.runtime, now: o.now, includeFiles: o.includeFiles });
  if (consistency === 'frozen') {
    if (o.skipLongFrozen === true && estimateMs > BACKUP_FROZEN_SKIP_MS) return { skipped: true, estimateMs };
    const handle = await o.ops.begin('backup', o.actor, { kind: o.kind, includeFiles: o.includeFiles, ...o.opParams });
    return { consistency: 'frozen', opId: handle.opId, opsToken: handle.opsToken };
  }
  const payload: BackupCreatePayload = { backupId: null, kind: o.kind, includeFiles: o.includeFiles, checkpoint: null, snapshot: null };
  const { id, existing } = await withTx(o.h, (trx) =>
    enqueueSnapshotBackup(trx, { payload, uniqueKey: o.uniqueKey, createdBy: o.createdBy, now: o.now }),
  );
  return { consistency: 'snapshot', jobId: id, existing };
}

/**
 * Enqueues the snapshot backup job `payload` under `uniqueKey` in `trx`, or returns the live job that holds the key
 * (`existing`) when it backs up the same way: a request with files never joins a job without them, nor the other way
 * round, since its caller would answer (and audit) a backup that is not the one asked for. `POST backups`,
 * `backup:create` and the schedule enqueue theirs here.
 *
 * @throws DomainError `OPS_BLOCKED_BY_BACKUP` (409) when the live job of `uniqueKey` has the other `includeFiles`
 */
export async function enqueueSnapshotBackup(
  trx: Transaction<DB>,
  o: { payload: BackupCreatePayload; uniqueKey: string; createdBy?: string | null; now: number },
): Promise<{ id: string; existing: boolean }> {
  const r = await enqueue(
    trx,
    enqueueRegistry,
    { type: BACKUP_CREATE_JOB, payload: o.payload, uniqueKey: o.uniqueKey, createdBy: o.createdBy ?? null },
    { now: o.now, keyring: [] },
  );
  if (!r.existing) return r;
  const live = await trx.selectFrom('jobs').select('payload').where('id', '=', r.id).executeTakeFirst();
  const includeFiles = live === undefined ? undefined : (JSON.parse(live.payload) as { includeFiles?: unknown }).includeFiles;
  if (includeFiles !== undefined && includeFiles !== o.payload.includeFiles) {
    throw new DomainError('OPS_BLOCKED_BY_BACKUP', {
      detail: o.payload.includeFiles
        ? 'Pencadangan tanpa berkas sedang antre atau berjalan; tunggu sampai selesai / A backup without files is queued or running; wait until it ends'
        : 'Pencadangan dengan berkas sedang antre atau berjalan; tunggu sampai selesai / A backup with files is queued or running; wait until it ends',
    });
  }
  return r;
}

/**
 * The job `backup.schedule` (see the top of this file): light, `system.backup.create`, retryable through the API; its
 * payload is the schedule window.
 */
export function backupScheduleJob(deps: () => BackupJobDeps): JobHandler<ScheduleWindow> {
  return {
    type: BACKUP_SCHEDULE_JOB,
    permission: 'system.backup.create',
    retryable: 'api',
    // It begins the frozen `backup` op, which piggyback would leave unstepped, in maintenance (final review, jobs).
    piggyback: false,
    payload: scheduleWindowSchema,
    async run(ctx) {
      const d = deps();
      if (await backupOpBegunBy(d.dataDir, 'scheduleJob', ctx.jobId)) return { done: true };
      const started = await startBackup({
        h: ctx.handle,
        dataDir: d.dataDir,
        runtime: d.runtime,
        ops: d.ops,
        now: ctx.now(),
        kind: 'scheduled',
        includeFiles: false,
        actor: { type: 'system', id: null },
        createdBy: null,
        uniqueKey: 'backup:scheduled',
        opParams: { scheduleJob: ctx.jobId },
        skipLongFrozen: true,
      });
      if ('skipped' in started) {
        ctx.log.warn('backup: the scheduled backup was skipped (frozen, estimated over 3 hours)', { estimateMs: started.estimateMs });
        await withTx(ctx.handle, (trx) =>
          notify(
            trx,
            {
              audience: { permission: 'system.backup.read' },
              type: 'backup.skipped',
              titleKey: 'notification.backup_skipped.title',
              link: BACKUPS_LINK,
            },
            ctx.now(),
          ),
        );
      }
      return { done: true };
    },
  };
}
