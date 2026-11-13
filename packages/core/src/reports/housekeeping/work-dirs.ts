import { listNames, removeTree, reportWorkDir, reportWorkRoot } from '@altis/platform';
import { isUlid, ulidTime } from '@altis/shared';
import type { ReportsHousekeepingStep } from './index.js';

// The step `work_dirs` of `reports.housekeeping`: the work folders `tmp/reports/<runId>/` (the only folder it lists;
// the files cleanup and the catalogue's housekeeping only look at `tmp/<ulid>/`, never into `tmp/reports/`).
//
// - The folder of a run that ended (succeeded, failed or cancelled) goes: its file, if any, is in `exports/reports/`.
// - The folder of a run still queued or running stays, whatever its age: a long export keeps writing there.
// - A folder that names no run goes once its id is 24 hours old (its run expired, or a restore emptied the runs).
// - Any other name is left alone.
//
// Not age-based: what decides is the state of a run, which a wrong clock does not change (an abandoned run is ended by
// the step `abandoned_runs`, which runs first). Names in sorted order, 200 at a time; the cursor is the last name done.

const DAY = 86_400_000;
const BATCH = 200;
/** Below this much budget left, no further folder is looked at in this slice (the first always is). */
const ITEM_MARGIN_MS = 2000;
const ENDED: ReadonlySet<string> = new Set(['succeeded', 'failed', 'cancelled']);

/**
 * The work folders `tmp/reports/<runId>/` of runs that ended (succeeded, failed or cancelled); a live run's folder
 * stays, whatever its age.
 */
export const workDirsStep: ReportsHousekeepingStep = Object.freeze<ReportsHousekeepingStep>({
  name: 'work_dirs',
  ageBased: false,
  async run(c) {
    const after = c.cursor !== null && isUlid(c.cursor) ? c.cursor : '';
    const names = (await listNames(reportWorkRoot(c.deps.dataDir))).filter((n) => n > after && isUlid(n));
    let last = after;
    let worked = false;
    for (let i = 0; i < names.length; i += BATCH) {
      const batch = names.slice(i, i + BATCH);
      const runs = new Map((await c.h.db.selectFrom('report_runs').select(['id', 'status']).where('id', 'in', batch).execute()).map((r) => [r.id, r.status] as const));
      for (const id of batch) {
        if (worked && c.budgetLeftMs() < ITEM_MARGIN_MS) return { done: false, cursor: last === '' ? null : last };
        worked = true;
        last = id;
        const status = runs.get(id);
        const remove = status === undefined ? ulidTime(id) <= c.now - DAY : ENDED.has(status);
        if (remove) await removeTree(reportWorkDir(c.deps.dataDir, id));
      }
    }
    return { done: true, cursor: null };
  },
});
