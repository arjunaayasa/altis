import { sweepOrphanUploads } from '../../catalog/attachments/housekeeping.js';
import { sweepUnfinishedSnapshotCopies } from '../../accreditation/snapshots.js';
import type { ReportsHousekeepingStep } from './index.js';

// The step `orphan_uploads` of `reports.housekeeping`: the catalogue housekeeping's sweep of unclaimed uploads (mark,
// then the blob, then the row; batches of 200; 24 hours to be claimed), over the contexts the orphan-upload registry
// gives to this job (the community contexts: evidence files and register attachments). The catalogue housekeeping
// keeps its own contexts, so neither job removes the other's uploads. Once those are done, the step removes the
// evidence file copies of snapshots that a killed copy left unfinished a day ago or more (their content, then their
// row; accreditation/snapshots.ts). Age-based: skipped while the clock looks wrong.

const sweepUploads = sweepOrphanUploads('reports.housekeeping');

/**
 * The uploads of the community contexts no one claimed within 24 hours (the orphan-upload registry's entries swept by
 * this job), then the unfinished snapshot evidence file copies.
 */
export const orphanUploadsReportsStep: ReportsHousekeepingStep = Object.freeze<ReportsHousekeepingStep>({
  name: 'orphan_uploads',
  ageBased: true,
  run: async (c) => {
    const uploads = await sweepUploads(c);
    if (!uploads.done) return uploads;
    await sweepUnfinishedSnapshotCopies(c.h.db, { storage: c.deps.storage, now: c.now, log: c.deps.log });
    return { done: true, cursor: null };
  },
});
