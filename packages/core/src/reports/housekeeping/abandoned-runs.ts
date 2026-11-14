import { withTx } from '@altis/db';
import { isUlid } from '@altis/shared';
import type { ReportsHousekeepingStep } from './index.js';

// The step `abandoned_runs` of `reports.housekeeping` (the catalogue runs' rule for abandoned runs): a report run still
// `queued` or `running` whose export job is no longer live (it ended without ending the run: dead, cancelled, or
// succeeded without its last phase) is ended `failed` with the error code `abandoned` at the time of the sweep. A run
// whose job row is gone, or that never got one, is ended so once it is 24 hours old. Its work folder then belongs to an
// ended run, which the step `work_dirs` removes later in the same pass (this step runs first for that reason).
//
// Not age-based (it runs while the clock looks wrong too): a job that ended is ended whatever the clock says, and the
// 24 hours only matter for a run whose job is gone.
//
// In batches of 200 runs by id; the cursor is the last id looked at, returned when the slice's budget runs low. The
// end is a conditional UPDATE (still queued or running), so a run its job ended meanwhile keeps that end.

const DAY = 86_400_000;
const BATCH = 200;
/** Below this much budget left, no further batch starts in this slice. */
const BATCH_MARGIN_MS = 2000;
/** The job states in which a job may still end its run. */
const LIVE_JOB: ReadonlySet<string> = new Set(['queued', 'running']);
const LIVE_RUN = ['queued', 'running'] as const;

/**
 * Report runs still queued or running whose job ended are ended as failed (`abandoned`), so the work_dirs step sweeps
 * their folders in the same pass. It runs first for that reason.
 */
export const abandonedRunsStep: ReportsHousekeepingStep = Object.freeze<ReportsHousekeepingStep>({
  name: 'abandoned_runs',
  ageBased: false,
  async run(c) {
    let last = c.cursor !== null && isUlid(c.cursor) ? c.cursor : '';
    for (;;) {
      let q = c.h.db
        .selectFrom('report_runs as r')
        .leftJoin('jobs as j', 'j.id', 'r.job_id')
        .select(['r.id', 'r.created_at', 'j.id as job_row', 'j.status as job_status'])
        .where('r.status', 'in', LIVE_RUN);
      if (last !== '') q = q.where('r.id', '>', last);
      const rows = await q.orderBy('r.id').limit(BATCH).execute();
      if (rows.length === 0) return { done: true, cursor: null };
      const ended = rows
        .filter((r) => (r.job_row === null || r.job_status === null ? Number(r.created_at) <= c.now - DAY : !LIVE_JOB.has(r.job_status)))
        .map((r) => r.id);
      if (ended.length > 0) {
        await withTx(c.h, (trx) =>
          trx
            .updateTable('report_runs')
            .set({ status: 'failed', error_code: 'abandoned', finished_at: c.now })
            .where('id', 'in', ended)
            .where('status', 'in', LIVE_RUN)
            .execute(),
        );
      }
      last = rows[rows.length - 1]!.id;
      if (rows.length < BATCH) return { done: true, cursor: null };
      if (c.budgetLeftMs() < BATCH_MARGIN_MS) return { done: false, cursor: last };
    }
  },
});
