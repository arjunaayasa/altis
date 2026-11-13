import { withTx } from '@altis/db';
import { reportExportPath, removeFile, type ReportFileExt } from '@altis/platform';
import { isUlid } from '@altis/shared';
import { REPORT_RUN_TTL_DAYS } from '@altis/shared/api/reports';
import type { ReportsHousekeepingStep } from './index.js';

// The step `expired_runs` of `reports.housekeeping` (spec §3.7: a run and its file are kept 7 days): a run whose
// `expires_at` has come loses its file `exports/reports/<runId>.<ext>`, then its row; its download answered 410 from
// `expires_at` on already, and from now on it is gone from the run lists. A run that ended without a file to keep
// (failed, cancelled: no `expires_at`) goes the same way once it is 7 days old. The file first: a slice killed in
// between finds the row again and removes nothing more. Its work folder, if one is left, has no run any more and goes
// in the step `work_dirs` of the same pass.
//
// Age-based (skipped while the clock looks wrong). In batches of 200 runs by id; the cursor is the last id done.

const DAY = 86_400_000;
const BATCH = 200;
/** Below this much budget left, no further run is removed in this slice (the first always is). */
const ITEM_MARGIN_MS = 2000;
const EXTS: readonly ReportFileExt[] = ['csv', 'xlsx', 'pdf', 'zip'];
const ENDED = ['succeeded', 'failed', 'cancelled'] as const;

/** Runs whose file expired lose it (`exports/reports/<runId>.<ext>`); their download answers 410 from then on. */
export const expiredRunsStep: ReportsHousekeepingStep = Object.freeze<ReportsHousekeepingStep>({
  name: 'expired_runs',
  ageBased: true,
  async run(c) {
    const keepUntil = c.now - REPORT_RUN_TTL_DAYS * DAY;
    let last = c.cursor !== null && isUlid(c.cursor) ? c.cursor : '';
    let worked = false;
    for (;;) {
      let q = c.h.db
        .selectFrom('report_runs')
        .select('id')
        .where((eb) =>
          eb.or([
            eb.and([eb('expires_at', 'is not', null), eb('expires_at', '<=', c.now)]),
            eb.and([eb('expires_at', 'is', null), eb('status', 'in', ENDED), eb('created_at', '<=', keepUntil)]),
          ]),
        );
      if (last !== '') q = q.where('id', '>', last);
      const rows = await q.orderBy('id').limit(BATCH).execute();
      if (rows.length === 0) return { done: true, cursor: null };
      for (const { id } of rows) {
        if (worked && c.budgetLeftMs() < ITEM_MARGIN_MS) return { done: false, cursor: last === '' ? null : last };
        worked = true;
        for (const ext of EXTS) await removeFile(reportExportPath(c.deps.dataDir, id, ext));
        await withTx(c.h, (trx) => trx.deleteFrom('report_runs').where('id', '=', id).execute());
        last = id;
      }
      if (rows.length < BATCH) return { done: true, cursor: null };
    }
  },
});
