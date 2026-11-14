/**
 * The audit actions of Phases 1b, 1c and 1d (spec §7.8), then Phase 2's (its spec §12.4). `audit_log.action` is VARCHAR(64).
 * Later sub-milestones append to this list; an existing action is never renamed.
 * No Node built-ins here: the browser bundles this package.
 */
export const AUDIT_ACTIONS = Object.freeze([
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

  // ---- Phase 1c (operations) ----
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

  // ---- Phase 1d (updates) ----
  // updates and releases: the update and rollback ops write their own entry (C25)
  'update.apply',
  'update.rollback',
  'update.upload',
  'update.channel',
  'release.unpin',

  // ---- Phase 2 (catalog): Task 2 ----
  // Phase 2 spec §12.4, in its order. `meta` holds field names and counts only, never full values or secrets.
  // records
  'catalog.record.create',
  'catalog.record.update',
  'catalog.record.archive',
  'catalog.record.restore',
  'catalog.record.merge',
  // attachments
  'catalog.attachment.create',
  'catalog.attachment.update',
  'catalog.attachment.archive',
  // items
  'catalog.item.create',
  'catalog.item.update',
  'catalog.item.archive',
  'catalog.item.batch_create',
  'catalog.item.bulk_update',
  // authorities (`entity` = agents | subjects | publishers; archiving orphans is one `.archive` with `meta.count`)
  'catalog.authority.create',
  'catalog.authority.update',
  'catalog.authority.archive',
  'catalog.authority.merge',
  // masters and locations (`entity` = material_types | languages | collection_types | suppliers | custom_field_defs | locations)
  'catalog.master.create',
  'catalog.master.update',
  'catalog.master.archive',
  // import, export, migration, search
  'catalog.import.start',
  'catalog.import.finish',
  'catalog.export.start',
  'catalog.export.download',
  'catalog.migration.start',
  'catalog.migration.finish',
  'catalog.search.reindex',
  // OPAC pages and news
  'opac.page.create',
  'opac.page.update',
  'opac.page.archive',

  // ---- Komunitas K1 (reports and accreditation) ----
  // `meta` holds field names, counts and reason names only, never a personal value.
  // report runs
  'reports.run.start',
  'reports.run.download',
  // accreditation periods and answers
  'accreditation.period.create',
  'accreditation.period.update',
  'accreditation.period.archive',
  'accreditation.period.freeze',
  'accreditation.period.unfreeze',
  'accreditation.answer.update',
  // monthly usage and the member type groups
  'accreditation.usage.update',
  'accreditation.usage_groups.update',
  // registers and evidence
  'accreditation.register.create',
  'accreditation.register.update',
  'accreditation.register.archive',
  'accreditation.evidence.create',
  'accreditation.evidence.archive',
  // the SLiMS usage statistics import (`finish` is written by the job, as the system actor)
  'accreditation.slims_usage.start',
  'accreditation.slims_usage.finish',
  // the bulk edit of records
  'catalog.record.bulk_update',
  // ---- Komunitas (members and circulation) ----
  // `meta` holds field names, counts and reason names only, never a personal value.
  // members (a status change, suspending or reactivating, is an update)
  'members.member.create',
  'members.member.update',
  'members.member.archive',
  'members.member.extend',
  // member types
  'members.type.create',
  'members.type.update',
  'members.type.archive',
  // the CSV member import (`finish` is written when the import ends)
  'members.import.start',
  'members.import.finish',
  // the desk
  'circulation.loan.create',
  'circulation.loan.return',
  'circulation.loan.renew',
  // loan rules
  'circulation.policy.create',
  'circulation.policy.update',
  'circulation.policy.archive',
  // ---- Komunitas (holds) ----
  // holds and the hold shelf (`circulation.holds.run` is one entry per run of the expiry job, `meta`: counts)
  'circulation.hold.create',
  'circulation.hold.cancel',
  'circulation.hold.ready',
  'circulation.hold.shelf_clear',
  'circulation.holds.run',
  // ---- Komunitas (circulation core) ----
  // the desk: voiding the last loan, a loan declared lost, a due date changed by hand
  'circulation.loan.void',
  'circulation.loan.lost',
  'circulation.loan.due_change',
  // the library calendar
  'circulation.calendar.create',
  'circulation.calendar.update',
  'circulation.calendar.archive',
  // numbered clearance letters
  'members.clearance.issue',
  'members.clearance.void',
  // ---- Komunitas K2 (members extended and visits) ----
  // `meta` holds field names, counts and reason names only, never a personal value.
  // members: restore an archived one, the bulk actions (one entry, `meta.count`), the photo, the card sheet
  'members.member.restore',
  'members.member.bulk_update',
  'members.member.photo_set',
  'members.card.print',
  // personal data: a member's own data exported by staff, and anonymisation (by staff; the daily job as the system)
  'members.privacy.export',
  'members.privacy.anonymize',
  'privacy.anonymize.run',
  // visits (a staff check-in is not audited: it is a count, not a change) and guestbook stations
  'visits.visit.create',
  'visits.visit.void',
  'visits.station.create',
  'visits.station.activation_code',
  'visits.station.revoke',
  // written with the station as the actor when a station is activated with its code
  'visits.station.activated',
  // ---- Komunitas (member area) ----
  // staff setting a member's OPAC password, and what a member does in the OPAC member area (`login_locked`: once when a
  // sign-in bucket first fills up in its window). A member's renewals, holds and cancellations use the circulation
  // actions above with a member actor.
  'members.member.password_set',
  'members.self.password_change',
  'members.self.password_reset',
  'members.self.data_export',
  'members.self.login_locked',
  // ---- Komunitas (charges and payments) ----
  // a charge booked by hand, a waive; a payment with its numbered receipt, a voided payment
  'circulation.charge.create',
  'circulation.charge.waive',
  'circulation.payment.create',
  'circulation.payment.void',
] as const);

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** True when `s` is one of {@link AUDIT_ACTIONS}. */
export function isAuditAction(s: string): s is AuditAction {
  return (AUDIT_ACTIONS as readonly string[]).includes(s);
}
