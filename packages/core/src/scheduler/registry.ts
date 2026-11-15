import type { Permission } from '@altis/shared';
import { z } from 'zod';

// The schedules this release defines (spec §10.4, §6.5 class `config`; decisions C2, C41; preflight B5, S16).
//
// The code is the source of the definitions: seedSchedules writes a `schedules` row for each one, keeps the fields an
// admin may edit (`enabled`; `expr` where `exprEditable`) and drops rows no definition names. Each due run enqueues a
// job of `jobType`, whose payload is built from the window the run covers (`payload`, default the window itself), so
// every scheduled handler's payload schema accepts {@link ScheduleWindow} (or what `payload` builds from it). A
// definition whose job type has no handler in this release is skipped by the tick until its task brings one.

/** The time a scheduled run covers: from the previous run (`last_run_at`) to the time it was scheduled for. */
export type ScheduleWindow = { windowStart: number; windowEnd: number };

/** The window as a payload schema: every scheduled job's payload extends it (`scheduleWindowSchema.extend({...})`). */
export const scheduleWindowSchema = z.strictObject({
  windowStart: z.number().int().min(0),
  windowEnd: z.number().int().min(0),
});

export interface ScheduleDef {
  /** The row's key: lower case, dot-separated (`backup.daily`). */
  name: string;
  /** The default expression (cron-expr.ts), in `library.timezone`. */
  expr: string;
  /** The job type each run enqueues. */
  jobType: string;
  /** What it takes to see and edit the schedule (§10.5: "Jadwal mendeklarasikan izinnya sendiri"). */
  permission: Permission;
  /** The admin may change `expr` (decision C2: only `backup.daily`). */
  exprEditable?: boolean;
  /** `enabled` of a new row. */
  enabledByDefault: boolean;
  /** The job's payload for a window (S16); default the window itself. */
  payload?(w: ScheduleWindow): unknown;
}

const def = (d: ScheduleDef): ScheduleDef => Object.freeze(d);

/** The schedules of this release (job types arrive with Tasks 18, 20 and 23; 1d Task 28 the update check). */
export const SCHEDULES: readonly ScheduleDef[] = Object.freeze([
  // A light job that chooses the backup mode, then begins the frozen op or enqueues the snapshot job (C41, B5).
  def({ name: 'backup.daily', expr: '0 1 * * *', jobType: 'backup.schedule', permission: 'system.backup.create', exprEditable: true, enabledByDefault: true }),
  def({ name: 'retention.volatile', expr: '*/10 * * * *', jobType: 'housekeeping.volatile', permission: 'system.jobs.manage', enabledByDefault: true }),
  def({ name: 'retention.events', expr: '17 * * * *', jobType: 'housekeeping.events', permission: 'system.jobs.manage', enabledByDefault: true }),
  def({
    name: 'retention.notifications',
    expr: '23 3 * * *',
    jobType: 'housekeeping.notifications',
    permission: 'system.jobs.manage',
    enabledByDefault: true,
  }),
  def({ name: 'retention.jobs', expr: '29 3 * * *', jobType: 'housekeeping.jobs', permission: 'system.jobs.manage', enabledByDefault: true }),
  def({ name: 'files.cleanup', expr: '41 * * * *', jobType: 'housekeeping.files', permission: 'system.jobs.manage', enabledByDefault: true }),
  def({ name: 'audit.anchor', expr: '5 0 * * *', jobType: 'audit.anchor', permission: 'system.audit.read', enabledByDefault: true }),
  def({ name: 'audit.retention', expr: '35 3 * * *', jobType: 'audit.retention', permission: 'system.audit.read', enabledByDefault: true }),
  def({
    name: 'diagnostics.exposure',
    expr: '47 2 * * *',
    jobType: 'diagnostics.exposure',
    permission: 'system.diagnostics.manage',
    enabledByDefault: true,
  }),
  def({
    name: 'diagnostics.ip_trust',
    expr: '13 * * * *',
    jobType: 'diagnostics.ip_trust',
    permission: 'system.diagnostics.manage',
    enabledByDefault: true,
  }),
  def({ name: 'diagnostics.usage', expr: '53 4 * * *', jobType: 'diagnostics.usage', permission: 'system.diagnostics.read', enabledByDefault: true }),
  // 1d Task 28 (§9.6 step 1, D1d-30): the daily update check at 04:00 library time; its expression is not editable.
  def({
    name: 'update.check',
    expr: '0 4 * * *',
    jobType: 'update.check',
    permission: 'system.update.read',
    enabledByDefault: true,
    payload: () => ({ reason: 'schedule' }),
  }),
  // ---- Phase 2 (catalog): Task 3 ----
  // §12.6: the catalog's daily upkeep at 03:40 (catalog/housekeeping.ts: the search index, orphan uploads, expired exports).
  def({ name: 'catalog.housekeeping', expr: '40 3 * * *', jobType: 'catalog.housekeeping', permission: 'system.jobs.manage', enabledByDefault: true }),
  // ---- Komunitas K1 (reports) ----
  // The reports' daily upkeep at 03:50 (reports/housekeeping: abandoned and expired runs, report files, work folders,
  // the community contexts' orphan uploads), after the catalogue's.
  def({ name: 'reports.housekeeping', expr: '50 3 * * *', jobType: 'reports.housekeeping', permission: 'system.jobs.manage', enabledByDefault: true }),
  // ---- Komunitas (holds) ----
  // Every 15 minutes: holds not picked up by their deadline (or waiting past their end) expire, and the kept copy goes
  // to the next in the queue (circulation/holds-job.ts). Skipped while the clock looks wrong.
  def({ name: 'circulation.holds', expr: '*/15 * * * *', jobType: 'circulation.holds', permission: 'system.jobs.manage', enabledByDefault: true }),
  // ---- Komunitas (notices) ----
  // Daily at 07:00: the e-mail reminders of loans due soon and overdue are queued, then sent by the sender job
  // (circulation/notices-jobs.ts); the hold shelf's staff notification. Skipped while the clock looks wrong. The library
  // may move the hour (a school that opens later).
  def({
    name: 'circulation.notices',
    expr: '0 7 * * *',
    jobType: 'circulation.notices',
    permission: 'system.jobs.manage',
    exprEditable: true,
    enabledByDefault: true,
  }),
  // ---- Komunitas K2 (privacy) ----
  // The history loses the person after the library's retention periods, daily at 02:15 (skipped while the clock looks
  // wrong).
  def({ name: 'privacy.anonymize', expr: '15 2 * * *', jobType: 'privacy.anonymize', permission: 'system.jobs.manage', enabledByDefault: true }),
]);
