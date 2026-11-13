import type { AreaAuditScript } from './catalog.js';

// The audit script of the freeze of a period and its reopening: the actions it owns, and the run that appends each of
// them through the API (null until the routes are written; the change that writes them fills this file).

export const AUDIT: AreaAuditScript = {
  actions: ['accreditation.period.freeze', 'accreditation.period.unfreeze'],
  run: null,
};
