import type { AreaAuditScript } from './catalog.js';
import { AUDIT as MEMBERS_EXT } from './komunitas-members-ext.js';

// The audit scripts of the member tools, visits and privacy actions: one script, in a file of its own that only its
// owning change fills. db/audit-coverage.test.ts runs it after the members and circulation scripts, on the same
// installation, with the same checks.

/** Every member tools and visits area's script, in the order audit-coverage.test.ts runs them. */
export const MEMBERS_VISITS_AUDIT_SCRIPTS: Readonly<Record<string, AreaAuditScript>> = Object.freeze({
  'members-ext': MEMBERS_EXT,
});
