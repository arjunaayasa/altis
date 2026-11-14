import type { AreaAuditScript } from './catalog.js';

// The audit script of the circulation desk (lend, return, renew) and the loan rules. Not written yet: the routes'
// handlers come first. Its actions are listed as pending while MEMBERS_CIRCULATION_PENDING_ALLOWED
// (audit/members-circulation.ts).

export const AUDIT: AreaAuditScript = {
  actions: [
    'circulation.loan.create',
    'circulation.loan.return',
    'circulation.loan.renew',
    'circulation.policy.create',
    'circulation.policy.update',
    'circulation.policy.archive',
  ],
  run: null,
};
