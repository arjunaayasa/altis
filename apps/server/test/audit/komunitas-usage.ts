import type { AreaAuditScript } from './catalog.js';

// The audit script of the monthly usage table and the member-type mapping: the actions it owns, and the run that
// appends each of them through the API (null until the routes are written; the change that writes them fills this
// file).

export const AUDIT: AreaAuditScript = {
  actions: ['accreditation.usage.update', 'accreditation.usage_groups.update'],
  run: null,
};
