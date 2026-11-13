// Stub: replaced by a later change in this milestone.
// The step `expired_runs` of `reports.housekeeping`: its name, its age dependence and its place are final; it does
// nothing until it is written.
import type { ReportsHousekeepingStep } from './index.js';

/** Runs whose file expired lose it (`exports/reports/<runId>.<ext>`); their download answers 410 from then on. */
export const expiredRunsStep: ReportsHousekeepingStep = Object.freeze<ReportsHousekeepingStep>({
  name: 'expired_runs',
  ageBased: true,
  run: async () => ({ done: true, cursor: null }),
});
