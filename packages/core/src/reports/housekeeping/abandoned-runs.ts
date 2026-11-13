// Stub: replaced by a later change in this milestone.
// The step `abandoned_runs` of `reports.housekeeping`: its name, its age dependence and its place are final; it does
// nothing until it is written.
import type { ReportsHousekeepingStep } from './index.js';

/**
 * Report runs still queued or running whose job ended are ended as their job did (the catalogue runs' rule for
 * abandoned runs), so the work_dirs step sweeps their folders in the same pass. It runs first for that reason.
 */
export const abandonedRunsStep: ReportsHousekeepingStep = Object.freeze<ReportsHousekeepingStep>({
  name: 'abandoned_runs',
  ageBased: true,
  run: async () => ({ done: true, cursor: null }),
});
