import type { AreaAuditScript } from './catalog.js';

// The audit script of the SLiMS usage import (its end is written by the job, as the system actor): the actions it owns,
// and the run that appends each of them through the API (null until the routes are written; the change that writes them
// fills this file).

export const AUDIT: AreaAuditScript = {
  actions: ['accreditation.slims_usage.start', 'accreditation.slims_usage.finish'],
  run: null,
};
