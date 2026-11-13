import { sweepOrphanUploads } from '../../catalog/attachments/housekeeping.js';
import type { ReportsHousekeepingStep } from './index.js';

// The step `orphan_uploads` of `reports.housekeeping`: the catalogue housekeeping's sweep of unclaimed uploads (mark,
// then the blob, then the row; batches of 200; 24 hours to be claimed), over the contexts the orphan-upload registry
// gives to this job (the community contexts: evidence files and register attachments). The catalogue housekeeping
// keeps its own contexts, so neither job removes the other's uploads. Age-based: skipped while the clock looks wrong.

/**
 * The uploads of the community contexts no one claimed within 24 hours (the orphan-upload registry's entries swept by
 * this job).
 */
export const orphanUploadsReportsStep: ReportsHousekeepingStep = Object.freeze<ReportsHousekeepingStep>({
  name: 'orphan_uploads',
  ageBased: true,
  run: sweepOrphanUploads('reports.housekeeping'),
});
