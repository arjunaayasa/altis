import { reportExportPath, reportExportsDir, listNames, removeFile, removeStaleTemps, statOrNull, type ReportFileExt } from '@altis/platform';
import { isUlid, ulidTime } from '@altis/shared';
import type { ReportsHousekeepingStep } from './index.js';

// The step `report_files` of `reports.housekeeping`: leftovers in `exports/reports/` (the only folder it lists; the
// catalogue's housekeeping never looks into it, and this step never looks anywhere else).
//
// - A file `<runId>.<ext>` whose run ended without that file to serve (failed, cancelled, expired, another format)
//   goes at once; a live run's file stays, whatever its age.
// - A file that names no run goes once its id is 24 hours old (the row went first: an expiry killed between the two,
//   a restore that emptied the runs).
// - Temporary siblings an interrupted write left (`.<name>.tmp-…`) go after 24 hours.
// - Any other name is left alone.
//
// Age-based (skipped while the clock looks wrong). Names in sorted order, 200 at a time; the cursor is the last name
// done, returned when the slice's budget runs low.

const DAY = 86_400_000;
const BATCH = 200;
/** Below this much budget left, no further name is looked at in this slice (the first always is). */
const ITEM_MARGIN_MS = 2000;
/** A report file's name: the run id and one of the report extensions. */
const REPORT_NAME = /^([0-9A-Z]{26})\.(csv|xlsx|pdf|zip)$/;
const ENDED: ReadonlySet<string> = new Set(['succeeded', 'failed', 'cancelled']);

/**
 * Files in `exports/reports/` without a run that can serve them: at once for a finished run, after 24 hours for a name
 * no run has.
 */
export const reportFilesStep: ReportsHousekeepingStep = Object.freeze<ReportsHousekeepingStep>({
  name: 'report_files',
  ageBased: true,
  async run(c) {
    const dir = reportExportsDir(c.deps.dataDir);
    const after = c.cursor !== null && REPORT_NAME.test(c.cursor) ? c.cursor : '';
    if (after === '') await removeStaleTemps(dir, { now: c.now, olderThanMs: DAY });
    const names = (await listNames(dir)).filter((n) => n > after && REPORT_NAME.test(n) && isUlid(REPORT_NAME.exec(n)![1]!));
    let last = after;
    let worked = false;
    for (let i = 0; i < names.length; i += BATCH) {
      const batch = names.slice(i, i + BATCH);
      const ids = [...new Set(batch.map((n) => REPORT_NAME.exec(n)![1]!))];
      const runs = new Map(
        (await c.h.db.selectFrom('report_runs').select(['id', 'status', 'format', 'expires_at']).where('id', 'in', ids).execute()).map((r) => [r.id, r] as const),
      );
      for (const name of batch) {
        if (worked && c.budgetLeftMs() < ITEM_MARGIN_MS) return { done: false, cursor: last === '' ? null : last };
        worked = true;
        last = name;
        const [, id, ext] = REPORT_NAME.exec(name)!;
        const run = runs.get(id!);
        let remove: boolean;
        if (run === undefined) remove = ulidTime(id!) <= c.now - DAY;
        else if (!ENDED.has(run.status)) remove = false;
        else remove = run.status !== 'succeeded' || run.format !== ext || (run.expires_at !== null && Number(run.expires_at) <= c.now);
        if (!remove) continue;
        const file = reportExportPath(c.deps.dataDir, id!, ext as ReportFileExt);
        if ((await statOrNull(file))?.kind === 'file') await removeFile(file);
      }
    }
    return { done: true, cursor: null };
  },
});
