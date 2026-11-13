import type { AreaAuditScript } from './catalog.js';
import { AUDIT as CATALOG } from './komunitas-catalog.js';
import { AUDIT as PERIODS } from './komunitas-periods.js';
import { AUDIT as REGISTERS } from './komunitas-registers.js';
import { AUDIT as REPORTS } from './komunitas-reports.js';
import { AUDIT as RESULTS } from './komunitas-results.js';
import { AUDIT as SLIMS_USAGE } from './komunitas-slims-usage.js';
import { AUDIT as USAGE } from './komunitas-usage.js';

// The audit scripts of the community actions (reports and accreditation): one script per area, each in a file of its
// own that only its owning change fills, so no later change edits a shared file. db/audit-coverage.test.ts runs them
// after the catalogue's scripts, on the same installation and in this order, with the same checks. A script left
// `null` lists its actions as pending (`it.todo`) while K1_PENDING_ALLOWED; the last change of the milestone sets it to
// false, and every action must then be covered.

/** Every community area's script, in the order audit-coverage.test.ts runs them. */
export const KOMUNITAS_AUDIT_SCRIPTS: Readonly<Record<string, AreaAuditScript>> = Object.freeze({
  reports: REPORTS,
  periods: PERIODS,
  registers: REGISTERS,
  usage: USAGE,
  results: RESULTS,
  'slims-usage': SLIMS_USAGE,
  catalog: CATALOG,
});

/** While true, a script that is still null lists its actions as pending. */
export const K1_PENDING_ALLOWED: boolean = true;
