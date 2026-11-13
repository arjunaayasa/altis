import type { AreaAuditScript } from './catalog.js';

// The audit script of the bulk change of the records' accreditation fields: the actions it owns, and the run that
// appends each of them through the API (null until the routes are written; the change that writes them fills this
// file).

export const AUDIT: AreaAuditScript = {
  actions: ['catalog.record.bulk_update'],
  run: null,
};
