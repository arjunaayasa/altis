import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ADMIN_EXCLUDED,
  PERMISSIONS,
  SUPER_ADMIN_ONLY_GRANTS,
  SYSTEM_ROLE_KEYS,
  isPermission,
  isSystemRoleKey,
  permissionCatalog,
  systemRolePermissions,
} from '../src/permissions.js';

// Spec §13.4, in spec order, without the two licence permissions (the community edition has no licence at all).
const SPEC_13_4 = [
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
];

/** Phase 2 "Katalog & Jelajah" (its spec §12.1), appended in this order after the 19 of Phase 1. */
const PHASE_2 = [
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
];

/** The reports and accreditation keys of the community edition, appended in this order after Phase 2's; all global. */
const KOMUNITAS_K1 = ['reports.statistics.read', 'accreditation.workspace.read', 'accreditation.workspace.manage'];

/** The members and circulation keys, appended in this order after the reports and accreditation keys. */
const MEMBERS_CIRCULATION = [
  'members.records.read',
  'members.records.manage',
  'members.types.manage',
  'members.import.run',
  'circulation.desk.use',
  'circulation.policies.manage',
  'circulation.records.read',
];

/** The circulation core's key, appended after members and circulation: forcing loans at a branch. */
const CIRCULATION_CORE = ['circulation.desk.override'];

/** Charges and payments' key, appended after the circulation core: waiving charges and voiding payments at a branch. */
const CHARGES = ['circulation.charges.waive'];

/** Every production key, in catalog order. */
const ALL = [...SPEC_13_4, ...PHASE_2, ...KOMUNITAS_K1, ...MEMBERS_CIRCULATION, ...CIRCULATION_CORE, ...CHARGES];

/** The two branch-scoped keys of Phase 2 (§12.1: "cabang"). */
const PHASE_2_BRANCH = ['catalog.locations.manage', 'catalog.items.manage'];

const TEST_PERMISSION = 'test.branch.manage';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PERMISSIONS', () => {
  it('is the 19 keys of spec §13.4 in spec order, then the 10 of Phase 2 (§12.1) in theirs, then the 3 of reports and accreditation: 32', () => {
    expect(SPEC_13_4).toHaveLength(19);
    expect(PHASE_2).toHaveLength(10);
    expect(KOMUNITAS_K1).toHaveLength(3);
    expect(PERMISSIONS.slice(0, 32)).toEqual([...SPEC_13_4, ...PHASE_2, ...KOMUNITAS_K1]);
  });

  it('ends with the 7 keys of members and circulation, the circulation core\'s override and the charges\' waive: 41 in all', () => {
    expect(MEMBERS_CIRCULATION).toHaveLength(7);
    expect([...PERMISSIONS]).toEqual(ALL);
    expect(PERMISSIONS).toHaveLength(41);
  });

  it('has no licence permission (the community edition)', () => {
    expect(PERMISSIONS.filter((key) => key.startsWith('system.license.'))).toEqual([]);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(PERMISSIONS)).toBe(true);
  });
});

describe('permissionCatalog', () => {
  it('lists the Phase 1 entries as global system permissions', () => {
    const production = permissionCatalog('production');
    expect(production.map((d) => d.key)).toEqual(ALL);
    for (const def of production.slice(0, 19)) {
      expect(def.scope, def.key).toBe('global');
      expect(def.module, def.key).toBe('system');
    }
    expect(production.some((d) => d.key.startsWith('test.'))).toBe(false);
  });

  it('Phase 2: the module is the key prefix (catalog, opac); only locations and items are branch-scoped', () => {
    const production = permissionCatalog('production');
    expect(production.slice(19, 29).map((d) => d.key)).toEqual(PHASE_2);
    for (const def of production.slice(19, 29)) {
      expect(def.module, def.key).toBe(def.key.split('.')[0]);
      expect(def.scope, def.key).toBe(PHASE_2_BRANCH.includes(def.key) ? 'branch' : 'global');
    }
    expect(production.filter((d) => d.module === 'opac').map((d) => d.key)).toEqual(['opac.pages.manage']);
    expect(production.filter((d) => d.scope === 'branch' && d.module === 'catalog').map((d) => [d.key, d.module])).toEqual([
      ['catalog.locations.manage', 'catalog'],
      ['catalog.items.manage', 'catalog'],
    ]);
  });

  it('reports and accreditation: three global keys whose module is their prefix, read and manage apart', () => {
    const production = permissionCatalog('production');
    expect(production.slice(29, 32).map((d) => [d.key, d.scope, d.module])).toEqual([
      ['reports.statistics.read', 'global', 'reports'],
      ['accreditation.workspace.read', 'global', 'accreditation'],
      ['accreditation.workspace.manage', 'global', 'accreditation'],
    ]);
  });

  it('members and circulation: seven keys whose module is their prefix; only the desk is branch-scoped', () => {
    const production = permissionCatalog('production');
    expect(production.slice(32, 39).map((d) => [d.key, d.scope, d.module])).toEqual([
      ['members.records.read', 'global', 'members'],
      ['members.records.manage', 'global', 'members'],
      ['members.types.manage', 'global', 'members'],
      ['members.import.run', 'global', 'members'],
      ['circulation.desk.use', 'branch', 'circulation'],
      ['circulation.policies.manage', 'global', 'circulation'],
      ['circulation.records.read', 'global', 'circulation'],
    ]);
    expect(production.filter((d) => d.scope === 'branch').map((d) => d.key)).toEqual([
      'catalog.locations.manage',
      'catalog.items.manage',
      'circulation.desk.use',
      'circulation.desk.override',
      'circulation.charges.waive',
    ]);
    expect(production.slice(39).map((d) => [d.key, d.scope, d.module])).toEqual([
      ['circulation.desk.override', 'branch', 'circulation'],
      ['circulation.charges.waive', 'branch', 'circulation'],
    ]);
  });

  it("the 'test' profile ends with the branch-scoped test permission: 42", () => {
    const test = permissionCatalog('test');
    expect(test).toHaveLength(42);
    expect(test.slice(0, 41).map((d) => d.key)).toEqual(ALL);
    expect(test[41]).toEqual({ key: TEST_PERMISSION, scope: 'branch', module: 'test' });
  });

  it('under the Vitest test profile the default catalog holds the test permission', () => {
    expect(permissionCatalog().map((d) => d.key)).toEqual([...ALL, TEST_PERMISSION]);
    expect(permissionCatalog('test').map((d) => d.key)).toContain(TEST_PERMISSION);
  });

  it('S28: with __BUILD_PROFILE__ production the test permission is gone, whatever the argument says', () => {
    vi.stubGlobal('__BUILD_PROFILE__', 'production');
    expect(permissionCatalog('test').map((d) => d.key)).toEqual(ALL);
    expect(permissionCatalog().map((d) => d.key)).toEqual(ALL);
    expect(permissionCatalog('production').map((d) => d.key)).toEqual(ALL);
  });

  it('S28: an undefined __BUILD_PROFILE__ counts as production', () => {
    vi.stubGlobal('__BUILD_PROFILE__', undefined);
    expect(permissionCatalog('test').map((d) => d.key)).toEqual(ALL);
    expect(permissionCatalog().map((d) => d.key)).toEqual(ALL);
  });

  it("the argument can only remove the entry: 'production' drops it under the test profile too", () => {
    expect(permissionCatalog('production').map((d) => d.key)).toEqual(ALL);
  });

  it('returns frozen lists of frozen entries that callers cannot grow', () => {
    for (const profile of ['test', 'production'] as const) {
      const catalog = permissionCatalog(profile);
      expect(Object.isFrozen(catalog)).toBe(true);
      for (const def of catalog) expect(Object.isFrozen(def)).toBe(true);
    }
  });
});

describe('isPermission', () => {
  it('accepts the catalog and nothing else', () => {
    for (const key of ALL) expect(isPermission(key)).toBe(true);
    expect(isPermission('catalog.records')).toBe(false);
    expect(isPermission('opac.pages.read')).toBe(false);
    expect(isPermission('system.nothing.read')).toBe(false);
    expect(isPermission('')).toBe(false);
    expect(isPermission('SYSTEM.SETTINGS.READ')).toBe(false);
    expect(isPermission('toString')).toBe(false);
    expect(isPermission('__proto__')).toBe(false);
  });

  it('knows the test permission only outside production', () => {
    expect(isPermission(TEST_PERMISSION)).toBe(true);
    expect(isPermission(TEST_PERMISSION, 'test')).toBe(true);
    expect(isPermission(TEST_PERMISSION, 'production')).toBe(false);
    vi.stubGlobal('__BUILD_PROFILE__', 'production');
    expect(isPermission(TEST_PERMISSION)).toBe(false);
    expect(isPermission(TEST_PERMISSION, 'test')).toBe(false);
    expect(isPermission('system.settings.read')).toBe(true);
  });
});

describe('ADMIN_EXCLUDED and SUPER_ADMIN_ONLY_GRANTS (spec §7.2)', () => {
  it('ADMIN_EXCLUDED is the three permissions the admin role lacks, and Phase 2 adds the SLiMS migration (§12.1)', () => {
    expect([...ADMIN_EXCLUDED]).toEqual([
      'system.update.run',
      'system.backup.restore',
      'system.config.manage',
      'catalog.migration.run',
    ]);
  });

  it('SUPER_ADMIN_ONLY_GRANTS adds system.roles.manage (rule 5)', () => {
    expect([...SUPER_ADMIN_ONLY_GRANTS]).toEqual([...ADMIN_EXCLUDED, 'system.roles.manage']);
  });

  it('every entry is a catalog permission', () => {
    for (const key of SUPER_ADMIN_ONLY_GRANTS) expect(isPermission(key, 'production')).toBe(true);
  });
});

describe('systemRolePermissions', () => {
  it('SYSTEM_ROLE_KEYS is super_admin and admin', () => {
    expect([...SYSTEM_ROLE_KEYS]).toEqual(['super_admin', 'admin']);
  });

  it('isSystemRoleKey: exactly the keys of SYSTEM_ROLE_KEYS', () => {
    for (const key of SYSTEM_ROLE_KEYS) expect(isSystemRoleKey(key)).toBe(true);
    for (const key of ['SUPER_ADMIN', 'Admin', 'admin ', 't_admin', '', 'constructor']) expect(isSystemRoleKey(key)).toBe(false);
  });

  it('super_admin holds every key of the catalog', () => {
    expect(systemRolePermissions('super_admin', 'test')).toEqual(permissionCatalog('test').map((d) => d.key));
    expect(systemRolePermissions('super_admin', 'production')).toEqual([...ALL]);
  });

  it('admin holds the production keys minus exactly the four of ADMIN_EXCLUDED: 37, without catalog.migration.run', () => {
    const admin = systemRolePermissions('admin', 'production');
    expect(admin).toEqual(ALL.filter((k) => !(ADMIN_EXCLUDED as readonly string[]).includes(k)));
    expect(admin).toHaveLength(37);
    for (const key of ADMIN_EXCLUDED) expect(admin).not.toContain(key);
    expect(admin).not.toContain('catalog.migration.run');
    expect(admin).toContain('system.roles.manage');
    for (const key of PHASE_2.filter((k) => k !== 'catalog.migration.run')) expect(admin).toContain(key);
  });

  it('admin holds the reports and accreditation keys: none of them is reserved to a super admin', () => {
    const admin = systemRolePermissions('admin', 'production');
    for (const key of KOMUNITAS_K1) expect(admin, key).toContain(key);
    for (const key of KOMUNITAS_K1) expect(SUPER_ADMIN_ONLY_GRANTS as readonly string[], key).not.toContain(key);
  });

  it('admin holds the members and circulation keys: none of them is reserved to a super admin', () => {
    const admin = systemRolePermissions('admin', 'production');
    for (const key of MEMBERS_CIRCULATION) expect(admin, key).toContain(key);
    for (const key of MEMBERS_CIRCULATION) expect(SUPER_ADMIN_ONLY_GRANTS as readonly string[], key).not.toContain(key);
  });

  it('admin has the test permission under the test profile', () => {
    expect(systemRolePermissions('admin', 'test')).toContain(TEST_PERMISSION);
    expect(systemRolePermissions('super_admin', 'test')).toContain(TEST_PERMISSION);
    expect(systemRolePermissions('admin', 'production')).not.toContain(TEST_PERMISSION);
  });

  it('is computed from the catalog, so the production bundle has no test permission', () => {
    vi.stubGlobal('__BUILD_PROFILE__', 'production');
    expect(systemRolePermissions('super_admin', 'test')).toEqual([...ALL]);
    expect(systemRolePermissions('admin')).toHaveLength(37);
  });

  it('returns frozen lists', () => {
    expect(Object.isFrozen(systemRolePermissions('admin', 'production'))).toBe(true);
    expect(Object.isFrozen(systemRolePermissions('super_admin', 'test'))).toBe(true);
  });
});
