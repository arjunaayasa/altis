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
] as const);

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** True when `s` is one of {@link AUDIT_ACTIONS}. */
export function isAuditAction(s: string): s is AuditAction {
  return (AUDIT_ACTIONS as readonly string[]).includes(s);
}
