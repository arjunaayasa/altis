// Stub: replaced by a later change in this milestone.
// The step `report_files` of `reports.housekeeping`: its name, its age dependence and its place are final; it does
// nothing until it is written.
import type { ReportsHousekeepingStep } from './index.js';

/**
 * Files in `exports/reports/` without a run that can serve them: at once for a finished run, after 24 hours for a name
 * no run has.
 */
export const reportFilesStep: ReportsHousekeepingStep = Object.freeze<ReportsHousekeepingStep>({
  name: 'report_files',
  ageBased: true,
  run: async () => ({ done: true, cursor: null }),
});
