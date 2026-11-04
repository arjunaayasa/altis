import { systemRolePermissions, type Permission } from '@altis/shared';
import type { MeResponse } from '@altis/shared/api/auth';
import { describe, expect, it } from 'vitest';
import { editionNav } from '@/edition';
import { ADMIN_MESSAGES } from '@/i18n';
import { NAV, NAV_GROUPS, visibleNav, visibleNavSections } from '@/lib/nav';

// Permission-based navigation (spec §13.3 "Kerangka admin"). The menus only hide: the server refuses whatever they
// hide anyway (§4.8).

type FullMe = Extract<MeResponse, { authenticated: true }>;

function me(o: { permissions: readonly Permission[]; superAdmin?: boolean }): FullMe {
  return {
    authenticated: true,
    csrfToken: 'csrf',
    stage: 'full',
    mustChangePassword: false,
    user: { id: 'u1', username: 'ani', name: 'Ani', email: null, locale: null, totpEnabled: false, mfaRequired: false },
    permissions: [...o.permissions],
    branchPermissions: {},
    superAdmin: o.superAdmin ?? false,
    reauthUntil: null,
    library: { name: 'Perpustakaan Arsya', locale: 'id' },
    build: '0.1.0',
    banners: [],
  };
}

const paths = (items: readonly { to: string }[]): string[] => items.map((item) => item.to);

/** The Phase 1 sections (1d's Pembaruan included; no Lisensi), now in the `system` group (Phase 2 spec §13). */
const SYSTEM_SECTIONS: [string, string | null][] = [
  ['/admin/users', 'system.users.read'],
  ['/admin/roles', 'system.users.read'],
  ['/admin/branches', 'system.branches.manage'],
  ['/admin/settings', 'system.settings.read'],
  ['/admin/system', 'system.config.manage'],
  ['/admin/updates', 'system.update.read'],
  ['/admin/audit', 'system.audit.read'],
  ['/admin/jobs', 'system.jobs.read'],
  ['/admin/backups', 'system.backup.read'],
  ['/admin/diagnostics', 'system.diagnostics.read'],
  ['/admin/about', null],
];

/** Phase 2 (§13): the Katalog group, in the spec's order. */
const CATALOG_SECTIONS: [string, string][] = [
  ['/admin/catalog/records', 'catalog.records.read'],
  ['/admin/catalog/items', 'catalog.records.read'],
  ['/admin/catalog/authorities', 'catalog.records.read'],
  ['/admin/catalog/locations', 'catalog.records.read'],
  ['/admin/catalog/masters', 'catalog.records.read'],
  ['/admin/catalog/exchange', 'catalog.records.read'],
  ['/admin/catalog/labels', 'catalog.records.read'],
  ['/admin/catalog/duplicates', 'catalog.records.manage'],
  ['/admin/catalog/migration', 'catalog.migration.run'],
];

const sectionsOf = (m: FullMe) => visibleNavSections(m).map((s) => [s.group, paths(s.items)]);

describe('NAV', () => {
  it('lists the shell sections in order, with their permissions: Beranda, then Katalog, OPAC and Sistem', () => {
    expect(NAV.map((item) => [item.to, item.permission ?? null])).toEqual([
      ['/admin', null],
      ...CATALOG_SECTIONS,
      ['/admin/opac/pages', 'opac.pages.manage'],
      ...SYSTEM_SECTIONS,
    ]);
    for (const item of NAV) expect(item.labelKey).toMatch(/^nav\./);
  });

  it('Phase 2: NAV_GROUPS orders catalog, opac, system; Beranda alone is ungrouped, every Phase 1 section is system', () => {
    expect([...NAV_GROUPS]).toEqual(['catalog', 'opac', 'system']);
    expect(NAV.filter((item) => item.group === undefined).map((item) => item.to)).toEqual(['/admin']);
    expect(NAV.filter((item) => item.group === 'system').map((item) => item.to)).toEqual(SYSTEM_SECTIONS.map(([to]) => to));
    expect(NAV.filter((item) => item.group === 'catalog').map((item) => item.to)).toEqual(CATALOG_SECTIONS.map(([to]) => to));
    expect(NAV.filter((item) => item.group === 'opac').map((item) => item.to)).toEqual(['/admin/opac/pages']);
    // M1: Migrasi SLiMS follows its permission, which a super admin may grant to a custom role.
    expect(NAV.find((item) => item.to === '/admin/catalog/migration')).toMatchObject({ permission: 'catalog.migration.run' });
    expect(NAV.some((item) => item.superAdminOnly === true)).toBe(false);
  });

  it('the community edition adds no item of its own (editionNav is empty) and has no Lisensi entry', () => {
    expect(editionNav).toEqual([]);
    expect(NAV.some((item) => item.to === '/admin/license')).toBe(false);
    expect(Object.keys(ADMIN_MESSAGES.id).filter((key) => key === 'nav.license' || key.startsWith('licensing.'))).toEqual([]);
  });

  it('every label and group heading has its text in both languages', () => {
    const keys = [...NAV.map((item) => item.labelKey), ...NAV_GROUPS.map((group) => `nav.group.${group}` as const)];
    for (const key of keys) {
      expect(ADMIN_MESSAGES.id[key], `id ${key}`).toBeTruthy();
      expect(ADMIN_MESSAGES.en[key], `en ${key}`).toBeTruthy();
      // No English left in the Indonesian text; OPAC is a name in both.
      if (key !== 'nav.group.opac') expect(ADMIN_MESSAGES.id[key], key).not.toBe(ADMIN_MESSAGES.en[key]);
    }
  });
});

describe('visibleNav', () => {
  it('an admin sees everything but the system configuration and Migrasi SLiMS', () => {
    const items = paths(visibleNav(me({ permissions: systemRolePermissions('admin') })));
    expect(items).not.toContain('/admin/system');
    expect(items).not.toContain('/admin/catalog/migration');
    expect(items).toEqual([
      '/admin',
      ...CATALOG_SECTIONS.map(([to]) => to).filter((to) => to !== '/admin/catalog/migration'),
      '/admin/opac/pages',
      '/admin/users',
      '/admin/roles',
      '/admin/branches',
      '/admin/settings',
      '/admin/updates',
      '/admin/audit',
      '/admin/jobs',
      '/admin/backups',
      '/admin/diagnostics',
      '/admin/about',
    ]);
  });

  it('Phase 2: catalog.records.read alone shows the Katalog group with 7 items, no Duplikat and no Migrasi SLiMS', () => {
    const sections = sectionsOf(me({ permissions: ['catalog.records.read'] }));
    expect(sections).toEqual([
      [null, ['/admin']],
      ['catalog', CATALOG_SECTIONS.slice(0, 7).map(([to]) => to)],
      ['system', ['/admin/about']],
    ]);
    expect(sections.flatMap(([, items]) => items)).not.toContain('/admin/catalog/migration');
  });

  it('M1: a custom role holding catalog.migration.run (no super admin) sees Migrasi SLiMS', () => {
    const sections = sectionsOf(me({ permissions: ['catalog.migration.run'] }));
    expect(sections).toEqual([
      [null, ['/admin']],
      ['catalog', ['/admin/catalog/migration']],
      ['system', ['/admin/about']],
    ]);
  });

  it('a super admin sees all three groups, in order, with every item', () => {
    const sections = visibleNavSections(me({ permissions: systemRolePermissions('super_admin'), superAdmin: true }));
    expect(sections.map((s) => s.group)).toEqual([null, 'catalog', 'opac', 'system']);
    expect(sections.flatMap((s) => paths(s.items))).toEqual(paths(NAV));
  });

  it('opac.pages.manage alone shows the OPAC group with Halaman & Berita', () => {
    expect(sectionsOf(me({ permissions: ['opac.pages.manage'] }))).toEqual([
      [null, ['/admin']],
      ['opac', ['/admin/opac/pages']],
      ['system', ['/admin/about']],
    ]);
  });

  it('a group with nothing visible is left out; signed out, nothing at all', () => {
    expect(sectionsOf(me({ permissions: [] }))).toEqual([
      [null, ['/admin']],
      ['system', ['/admin/about']],
    ]);
    expect(visibleNavSections(undefined)).toEqual([]);
  });

  it('a super admin sees the system configuration too', () => {
    const items = paths(visibleNav(me({ permissions: systemRolePermissions('super_admin'), superAdmin: true })));
    expect(items).toContain('/admin/system');
    expect(items).toEqual(paths(NAV));
  });

  it('a staff user without permissions sees Beranda and Tentang only', () => {
    expect(paths(visibleNav(me({ permissions: [] })))).toEqual(['/admin', '/admin/about']);
  });

  it('one permission shows its section only', () => {
    expect(paths(visibleNav(me({ permissions: ['system.audit.read'] })))).toEqual(['/admin', '/admin/audit', '/admin/about']);
    expect(paths(visibleNav(me({ permissions: ['system.jobs.read'] })))).toEqual(['/admin', '/admin/jobs', '/admin/about']);
    expect(paths(visibleNav(me({ permissions: ['system.backup.read'] })))).toEqual(['/admin', '/admin/backups', '/admin/about']);
    expect(paths(visibleNav(me({ permissions: ['system.diagnostics.read'] })))).toEqual(['/admin', '/admin/diagnostics', '/admin/about']);
  });

  it('nothing while signed out, still pre-2FA, or unknown', () => {
    expect(visibleNav(undefined)).toEqual([]);
    expect(visibleNav({ authenticated: false, csrfToken: 'x', library: { name: 'P', locale: 'id' }, build: '0.1.0' })).toEqual([]);
    expect(visibleNav({ ...me({ permissions: [] }), stage: 'mfa' })).toEqual([]);
  });
});
