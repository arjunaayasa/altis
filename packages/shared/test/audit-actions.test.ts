import { describe, expect, it } from 'vitest';
import { AUDIT_ACTIONS, isAuditAction } from '../src/audit-actions.js';

/** Phase 1b's list, unchanged and in order. */
const PHASE_1B = [
  // auth
  'auth.login.success',
  'auth.login.failed',
  'auth.logout',
  'auth.remember.reuse',
  'auth.2fa.enable',
  'auth.2fa.disable',
  'auth.2fa.recovery_codes',
  'auth.password.change',
  'auth.password.reset',
  'auth.profile.update',
  'auth.session.revoke',
  // authorization
  'authz.denied',
  // users
  'users.create',
  'users.update',
  'users.disable',
  'users.enable',
  'users.password.reset',
  'users.2fa.reset',
  'users.roles.update',
  // roles
  'roles.create',
  'roles.update',
  'roles.delete',
  // branches
  'branches.create',
  'branches.update',
  'branches.archive',
  // settings and system configuration
  'settings.update',
  'system.config.update',
  'system.config.email_test',
  'system.config.cron_token_rotate',
  // audit
  'audit.export',
];

/** Phase 1c (Task 1), appended after 1b's: backups, jobs, schedules, ops, diagnostics, maintenance, secrets, install, audit retention. */
const PHASE_1C = [
  // backup and restore
  'backup.create',
  'backup.download',
  'backup.upload',
  'backup.restore',
  // jobs and schedules
  'jobs.retry',
  'jobs.cancel',
  'schedules.update',
  // ops
  'ops.cancel',
  'ops.takeover',
  // diagnostics
  'diagnostics.clock_confirm',
  'diagnostics.realtime',
  'diagnostics.probe_result',
  // maintenance and secrets
  'maintenance.on',
  'maintenance.off',
  'system.secrets_rotate',
  // install
  'install.complete',
  'install.reset',
  // audit retention
  'audit.purge',
];

/** Phase 1d (Task 1), appended after 1c's in the plan's order: updates and releases (the community edition has no licence action). */
const PHASE_1D = [
  // updates and releases
  'update.apply',
  'update.rollback',
  'update.upload',
  'update.channel',
  'release.unpin',
];

/** Phase 2 "Katalog & Jelajah" (its spec §12.4), appended after 1d's in the spec's order: 30 actions. */
const PHASE_2 = [
  'catalog.record.create',
  'catalog.record.update',
  'catalog.record.archive',
  'catalog.record.restore',
  'catalog.record.merge',
  'catalog.attachment.create',
  'catalog.attachment.update',
  'catalog.attachment.archive',
  'catalog.item.create',
  'catalog.item.update',
  'catalog.item.archive',
  'catalog.item.batch_create',
  'catalog.item.bulk_update',
  'catalog.authority.create',
  'catalog.authority.update',
  'catalog.authority.archive',
  'catalog.authority.merge',
  'catalog.master.create',
  'catalog.master.update',
  'catalog.master.archive',
  'catalog.import.start',
  'catalog.import.finish',
  'catalog.export.start',
  'catalog.export.download',
  'catalog.migration.start',
  'catalog.migration.finish',
  'catalog.search.reindex',
  'opac.page.create',
  'opac.page.update',
  'opac.page.archive',
];

/** Reports and accreditation, appended after Phase 2's in this order: 18 actions. */
const KOMUNITAS_K1 = [
  'reports.run.start',
  'reports.run.download',
  'accreditation.period.create',
  'accreditation.period.update',
  'accreditation.period.archive',
  'accreditation.period.freeze',
  'accreditation.period.unfreeze',
  'accreditation.answer.update',
  'accreditation.usage.update',
  'accreditation.usage_groups.update',
  'accreditation.register.create',
  'accreditation.register.update',
  'accreditation.register.archive',
  'accreditation.evidence.create',
  'accreditation.evidence.archive',
  'accreditation.slims_usage.start',
  'accreditation.slims_usage.finish',
  'catalog.record.bulk_update',
];

/** Members and circulation, appended after the reports and accreditation actions in this order: 15 actions. */
const MEMBERS_CIRCULATION = [
  'members.member.create',
  'members.member.update',
  'members.member.archive',
  'members.member.extend',
  'members.type.create',
  'members.type.update',
  'members.type.archive',
  'members.import.start',
  'members.import.finish',
  'circulation.loan.create',
  'circulation.loan.return',
  'circulation.loan.renew',
  'circulation.policy.create',
  'circulation.policy.update',
  'circulation.policy.archive',
];

describe('AUDIT_ACTIONS', () => {
  it('is exactly the Phase 1b list followed by the 18 actions of Phase 1c, the 5 of Phase 1d, the 30 of Phase 2, the 18 of reports and accreditation, then the 15 of members and circulation, in order', () => {
    expect(PHASE_1C).toHaveLength(18);
    expect(PHASE_1D).toHaveLength(5);
    expect(PHASE_2).toHaveLength(30);
    expect(KOMUNITAS_K1).toHaveLength(18);
    expect(MEMBERS_CIRCULATION).toHaveLength(15);
    expect([...AUDIT_ACTIONS]).toEqual([...PHASE_1B, ...PHASE_1C, ...PHASE_1D, ...PHASE_2, ...KOMUNITAS_K1, ...MEMBERS_CIRCULATION]);
  });

  it('every action is dotted lower-case and fits audit_log.action (64)', () => {
    for (const action of AUDIT_ACTIONS) {
      expect(action, action).toMatch(/^[a-z0-9_]+(\.[a-z0-9_]+)+$/);
      expect(action.length, action).toBeLessThanOrEqual(64);
    }
  });

  it('has no duplicates and is frozen', () => {
    expect(new Set(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length);
    expect(Object.isFrozen(AUDIT_ACTIONS)).toBe(true);
  });
});

describe('isAuditAction', () => {
  it('accepts the list and nothing else', () => {
    for (const action of AUDIT_ACTIONS) expect(isAuditAction(action)).toBe(true);
    expect(isAuditAction('auth.login')).toBe(false);
    expect(isAuditAction('AUTH.LOGIN.SUCCESS')).toBe(false);
    expect(isAuditAction('')).toBe(false);
    expect(isAuditAction('constructor')).toBe(false);
  });
});
