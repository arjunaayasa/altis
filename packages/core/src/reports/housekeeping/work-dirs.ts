// Stub: replaced by a later change in this milestone.
// The step `work_dirs` of `reports.housekeeping`: its name, its age dependence and its place are final; it does
// nothing until it is written.
import type { ReportsHousekeepingStep } from './index.js';

/**
 * The work folders `tmp/reports/<runId>/` of runs that ended (succeeded, failed or cancelled); a live run's folder
 * stays, whatever its age.
 */
export const workDirsStep: ReportsHousekeepingStep = Object.freeze<ReportsHousekeepingStep>({
  name: 'work_dirs',
  ageBased: false,
  run: async () => ({ done: true, cursor: null }),
});
