/**
 * The permission catalog (spec §13.4, §7.2): `<module>.<object>.<action>`, each with a scope.
 * No Node built-ins here: the browser bundles this package.
 */

/**
 * The 19 permissions of Phase 1, all of global scope, in the order of spec §13.4; then the 10 of Phase 2 (its spec
 * §12.1), in that spec's order; then the community edition's reports and accreditation keys, all global.
 * The members and circulation keys follow: the desk's per branch, the others global.
 */
export const PERMISSIONS = Object.freeze([
  'system.settings.read',
  'system.settings.manage',
  'system.config.manage',
  'system.users.read',
  'system.users.manage',
  'system.roles.manage',
  'system.branches.manage',
  'system.audit.read',
  'system.audit.export',
  'system.jobs.read',
  'system.jobs.manage',
  'system.backup.read',
  'system.backup.create',
  'system.backup.download',
  'system.backup.restore',
  'system.update.read',
  'system.update.run',
  'system.diagnostics.read',
  'system.diagnostics.manage',
  // ---- Phase 2 (catalog): Task 2 ----
  'catalog.records.read',
  'catalog.records.manage',
  'catalog.authorities.manage',
  'catalog.masters.manage',
  'catalog.locations.manage',
  'catalog.items.manage',
  'catalog.import.run',
  'catalog.export.run',
  'catalog.migration.run',
  'opac.pages.manage',
  // ---- Komunitas K1 (reports and accreditation) ----
  // Aggregate reports without personal data (viewing and exporting them), then the accreditation workspace: reading it
  // (results, snapshots, evidence files) apart from managing it (periods, profile, answers, registers, evidence,
  // manual usage, the SLiMS statistics import, freezing and unfreezing).
  'reports.statistics.read',
  'accreditation.workspace.read',
  'accreditation.workspace.manage',
  // ---- Komunitas (members and circulation) ----
  // Members: reading them and their history, managing them (create, edit, extend, suspend, archive), the member types,
  // and the CSV member import. Circulation: the desk (lend, return, renew; at a branch), the loan rules, and the loan
  // records of every member (history, overdue list).
  'members.records.read',
  'members.records.manage',
  'members.types.manage',
  'members.import.run',
  'circulation.desk.use',
  'circulation.policies.manage',
  'circulation.records.read',
  // ---- Komunitas (circulation core) ----
  // Forcing a refused loan (limit, hold, block, collection type, rule), a loan dated before today, a changed due date,
  // and voiding another staff member's last loan; at a branch, like the desk.
  'circulation.desk.override',
  // ---- Komunitas K2 (members extended and visits) ----
  // The member list export (personal data), the member's own data export and anonymisation, then visits: reading
  // the visit list and its statistics (library-wide), recording visits at a branch (staff check-in, manual and class
  // visits, voiding one) and the guestbook stations of a branch (create, activation code, revoke).
  'members.export.run',
  'members.privacy.manage',
  'visits.records.read',
  'visits.records.manage',
  'visits.stations.manage',
  // ---- Komunitas (charges and payments) ----
  // Waiving a charge and voiding a payment, at a branch (taking payments and booking a charge by hand is the desk's).
  'circulation.charges.waive',
] as const);

/** A catalog key. The second member exists only in the test profile (spec §12.5): see {@link permissionCatalog}. */
export type Permission = (typeof PERMISSIONS)[number] | 'test.branch.manage';

/** Global permissions are granted only with `scope_key = ''`; branch permissions per branch. */
export type PermissionScope = 'global' | 'branch';

/** The module of a permission: its key's first segment. */
export type PermissionModule = 'system' | 'test' | 'catalog' | 'opac' | 'reports' | 'accreditation' | 'members' | 'circulation' | 'visits';

export interface PermissionDef {
  key: Permission;
  scope: PermissionScope;
  module: PermissionModule;
}

type Profile = 'test' | 'production';

// ---- Phase 2 (catalog): Task 2 ----
/**
 * The branch-scoped keys of Phase 2 (its spec §12.1, decision D2-02): locations and items belong to a branch, and a
 * global role grants them at every branch (`can()` of Phase 1). Every other production key is global.
 */
const BRANCH_SCOPED: ReadonlySet<string> = new Set([
  'catalog.locations.manage',
  'catalog.items.manage',
  // ---- Komunitas (members and circulation) ----
  // The desk works at a branch (its routes are `branches/:branchId/circulation/...`).
  'circulation.desk.use',
  // ---- Komunitas (circulation core) ----
  'circulation.desk.override',
  // ---- Komunitas K2 (members extended and visits) ----
  // Visits and guestbook stations belong to a branch (`branches/:branchId/visits/...`).
  'visits.records.manage',
  'visits.stations.manage',
  // ---- Komunitas (charges and payments) ----
  'circulation.charges.waive',
]);

/** The module of a production key: its prefix (`system`, `catalog`, `opac`, `reports`, `accreditation`, `members` or `circulation`). */
function moduleOf(key: (typeof PERMISSIONS)[number]): PermissionModule {
  return key.slice(0, key.indexOf('.')) as PermissionModule;
}

const BASE_CATALOG: readonly PermissionDef[] = Object.freeze(
  PERMISSIONS.map(
    (key): PermissionDef => Object.freeze({ key, scope: BRANCH_SCOPED.has(key) ? 'branch' : 'global', module: moduleOf(key) }),
  ),
);

let testCatalog: readonly PermissionDef[] | undefined;

/**
 * The catalog, in spec order.
 *
 * The test-only entry `{key: 'test.branch.manage', scope: 'branch', module: 'test'}` is appended only when the
 * build profile is `test` (`__BUILD_PROFILE__`, substituted by esbuild and by Vitest; undefined counts as production)
 * and `profile` is not `'production'`. The argument can only remove the entry, never add it, so in a production bundle
 * the whole branch is dead code and the entry's text never ships (spec §12.5, S28: test hooks exist only under the test
 * build profile); the release build's leak scan fails when it does.
 */
export function permissionCatalog(profile?: Profile): readonly PermissionDef[] {
  if (typeof __BUILD_PROFILE__ !== 'undefined' && __BUILD_PROFILE__ === 'test' && profile !== 'production') {
    testCatalog ??= Object.freeze([
      ...BASE_CATALOG,
      Object.freeze<PermissionDef>({ key: 'test.branch.manage', scope: 'branch', module: 'test' }),
    ]);
    return testCatalog;
  }
  return BASE_CATALOG;
}

/** True when `s` is a key of {@link permissionCatalog} for `profile`. */
export function isPermission(s: string, profile?: Profile): s is Permission {
  return permissionCatalog(profile).some((def) => def.key === s);
}

/**
 * What the `admin` system role lacks (spec §7.2); Phase 2 adds the SLiMS migration (its spec §12.1: "khusus super
 * admin"). A super admin may still grant any of them to a custom role (SUPER_ADMIN_ONLY_GRANTS).
 */
export const ADMIN_EXCLUDED = Object.freeze([
  'system.update.run',
  'system.backup.restore',
  'system.config.manage',
  // ---- Phase 2 (catalog): Task 2 ----
  'catalog.migration.run',
] as const);

/**
 * Permissions only a super admin may grant (spec §7.2 rule 5; with reauth and an audit entry):
 * {@link ADMIN_EXCLUDED} plus `system.roles.manage`.
 */
export const SUPER_ADMIN_ONLY_GRANTS = Object.freeze([...ADMIN_EXCLUDED, 'system.roles.manage'] as const);

/** The two roles seeded by code, never edited; their permissions are computed from the catalog (decision D5). */
export const SYSTEM_ROLE_KEYS = Object.freeze(['super_admin', 'admin'] as const);

export type SystemRoleKey = (typeof SYSTEM_ROLE_KEYS)[number];

/** True for a key of {@link SYSTEM_ROLE_KEYS}. */
export function isSystemRoleKey(key: string): key is SystemRoleKey {
  return (SYSTEM_ROLE_KEYS as readonly string[]).includes(key);
}

/** `super_admin`: every catalog key; `admin`: every catalog key except {@link ADMIN_EXCLUDED}. */
export function systemRolePermissions(key: SystemRoleKey, profile?: Profile): readonly Permission[] {
  const all = permissionCatalog(profile).map((def) => def.key);
  if (key === 'super_admin') return Object.freeze(all);
  const excluded: readonly string[] = ADMIN_EXCLUDED;
  return Object.freeze(all.filter((permission) => !excluded.includes(permission)));
}
