// Stub: replaced by a later change in this milestone.
// The step `orphan_uploads` of `reports.housekeeping`: its name, its age dependence and its place are final; it does
// nothing until it is written.
import type { ReportsHousekeepingStep } from './index.js';

/**
 * The uploads of the community contexts no one claimed within 24 hours (the orphan-upload registry's entries swept by
 * this job).
 */
export const orphanUploadsReportsStep: ReportsHousekeepingStep = Object.freeze<ReportsHousekeepingStep>({
  name: 'orphan_uploads',
  ageBased: true,
  run: async () => ({ done: true, cursor: null }),
});
