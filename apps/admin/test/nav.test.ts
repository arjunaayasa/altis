import { systemRolePermissions, type Permission } from '@altis/shared';
import type { MeResponse } from '@altis/shared/api/auth';
import { describe, expect, it } from 'vitest';
import { editionNav } from '@/edition';
import { ADMIN_MESSAGES } from '@/i18n';
import { NAV, NAV_GROUPS, activeNavPath, visibleNav, visibleNavSections } from '@/lib/nav';

// Permission-based navigation (spec §13.3 "Kerangka admin"). The menus only hide: the server refuses whatever they
// hide anyway (§4.8).

type FullMe = Extract<MeResponse, { authenticated: true }>;

function me(o: { permissions: readonly Permission[]; superAdmin?: boolean; branchPermissions?: Record<string, Permission[]> }): FullMe {
  return {
    authenticated: true,
    csrfToken: 'csrf',
    stage: 'full',
    mustChangePassword: false,
    user: { id: 'u1', username: 'ani', name: 'Ani', email: null, locale: null, totpEnabled: false, mfaRequired: false },
    permissions: [...o.permissions],
    branchPermissions: o.branchPermissions ?? {},
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

/** The Laporan group: the report catalogue and the accreditation workspace, each behind its own permission. */
const REPORTS_SECTIONS: [string, string][] = [
  ['/admin/reports', 'reports.statistics.read'],
  ['/admin/accreditation', 'accreditation.workspace.read'],
];

/**
 * Layanan: the desk, quick return and read in place (granted per branch), the overdue list, the loan rules and the
 * calendar.
 */
const CIRCULATION_SECTIONS: [string, string][] = [
  ['/admin/layanan', 'circulation.desk.use'],
  ['/admin/layanan/kembali', 'circulation.desk.use'],
  ['/admin/layanan/rak-tunggu', 'circulation.desk.use'],
  ['/admin/layanan/baca', 'circulation.desk.use'],
  ['/admin/layanan/terlambat', 'circulation.records.read'],
  ['/admin/layanan/aturan', 'circulation.policies.manage'],
  ['/admin/layanan/kalender', 'circulation.policies.manage'],
  ['/admin/layanan/kunjungan', 'visits.records.read'],
  ['/admin/layanan/buku-tamu', 'visits.stations.manage'],
];

/** Anggota: the member list, the member types, the CSV import and the clearance letters. */
const MEMBERS_SECTIONS: [string, string][] = [
  ['/admin/anggota', 'members.records.read'],
  ['/admin/anggota/tipe', 'members.types.manage'],
  ['/admin/anggota/impor', 'members.import.run'],
  ['/admin/anggota/bebas-pustaka', 'members.records.manage'],
  ['/admin/anggota/kartu', 'members.records.read'],
];

const sectionsOf = (m: FullMe) => visibleNavSections(m).map((s) => [s.group, paths(s.items)]);

describe('NAV', () => {
  it('lists the shell sections with their permissions: Beranda, Katalog, OPAC and Sistem, then the Laporan, Layanan and Anggota blocks at the end', () => {
    expect(NAV.map((item) => [item.to, item.permission ?? null])).toEqual([
      ['/admin', null],
      ...CATALOG_SECTIONS,
      ['/admin/opac/pages', 'opac.pages.manage'],
      ...SYSTEM_SECTIONS,
      ...REPORTS_SECTIONS,
      ...CIRCULATION_SECTIONS,
      ...MEMBERS_SECTIONS,
    ]);
    for (const item of NAV) expect(item.labelKey).toMatch(/^nav\./);
  });

  it('NAV_GROUPS orders catalog, circulation, members, reports, opac, system; Beranda alone is ungrouped, every Phase 1 section is system', () => {
    expect([...NAV_GROUPS]).toEqual(['catalog', 'circulation', 'members', 'reports', 'opac', 'system']);
    expect(NAV.filter((item) => item.group === 'circulation').map((item) => item.to)).toEqual(CIRCULATION_SECTIONS.map(([to]) => to));
    expect(NAV.filter((item) => item.group === 'members').map((item) => item.to)).toEqual(MEMBERS_SECTIONS.map(([to]) => to));
    expect(NAV.filter((item) => item.group === 'reports').map((item) => [item.to, item.labelKey])).toEqual([
      ['/admin/reports', 'nav.reports.reports'],
      ['/admin/accreditation', 'nav.reports.accreditation'],
    ]);
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
      '/admin/reports',
      '/admin/accreditation',
      ...CIRCULATION_SECTIONS.map(([to]) => to),
      ...MEMBERS_SECTIONS.map(([to]) => to),
    ]);
  });

  it('the desk permission held at one branch only shows Meja Layanan, Kembali Cepat, the hold shelf and Baca di Tempat; a global grant elsewhere does not', () => {
    expect(sectionsOf(me({ permissions: [], branchPermissions: { B1: ['circulation.desk.use'] } }))).toEqual([
      [null, ['/admin']],
      ['circulation', ['/admin/layanan', '/admin/layanan/kembali', '/admin/layanan/rak-tunggu', '/admin/layanan/baca']],
      ['system', ['/admin/about']],
    ]);
    // Only the desk is granted per branch: another permission held at a branch opens no menu item.
    expect(sectionsOf(me({ permissions: [], branchPermissions: { B1: ['catalog.items.manage'] } }))).toEqual([
      [null, ['/admin']],
      ['system', ['/admin/about']],
    ]);
    expect(sectionsOf(me({ permissions: ['members.records.read', 'circulation.records.read'] }))).toEqual([
      [null, ['/admin']],
      ['circulation', ['/admin/layanan/terlambat']],
      ['members', ['/admin/anggota', '/admin/anggota/kartu']],
      ['system', ['/admin/about']],
    ]);
  });

  it('reports.statistics.read alone shows the Laporan group with Laporan only', () => {
    expect(sectionsOf(me({ permissions: ['reports.statistics.read'] }))).toEqual([
      [null, ['/admin']],
      ['reports', ['/admin/reports']],
      ['system', ['/admin/about']],
    ]);
  });

  it('accreditation.workspace.read alone shows the Laporan group with Akreditasi only', () => {
    expect(sectionsOf(me({ permissions: ['accreditation.workspace.read'] }))).toEqual([
      [null, ['/admin']],
      ['reports', ['/admin/accreditation']],
      ['system', ['/admin/about']],
    ]);
    // Managing the workspace alone opens no menu item: reading it is what the item needs.
    expect(sectionsOf(me({ permissions: ['accreditation.workspace.manage'] }))).toEqual([
      [null, ['/admin']],
      ['system', ['/admin/about']],
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

  it('a super admin sees the six groups catalog, circulation, members, reports, opac, system in that order, with every item', () => {
    const sections = visibleNavSections(me({ permissions: systemRolePermissions('super_admin'), superAdmin: true }));
    expect(sections.map((s) => s.group)).toEqual([null, 'catalog', 'circulation', 'members', 'reports', 'opac', 'system']);
    expect(sections.flatMap((s) => paths(s.items))).toEqual([
      '/admin',
      ...CATALOG_SECTIONS.map(([to]) => to),
      ...CIRCULATION_SECTIONS.map(([to]) => to),
      ...MEMBERS_SECTIONS.map(([to]) => to),
      ...REPORTS_SECTIONS.map(([to]) => to),
      '/admin/opac/pages',
      ...SYSTEM_SECTIONS.map(([to]) => to),
    ]);
    expect([...sections.flatMap((s) => paths(s.items))].sort()).toEqual([...paths(NAV)].sort());
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

describe('activeNavPath: the one menu item a page marks', () => {
  it('a page with its own item marks that item alone, not the item whose path it lies under', () => {
    expect(activeNavPath(NAV, '/admin/layanan')).toBe('/admin/layanan');
    expect(activeNavPath(NAV, '/admin/layanan/kembali')).toBe('/admin/layanan/kembali');
    expect(activeNavPath(NAV, '/admin/layanan/terlambat')).toBe('/admin/layanan/terlambat');
    expect(activeNavPath(NAV, '/admin/anggota/tipe')).toBe('/admin/anggota/tipe');
    expect(activeNavPath(NAV, '/admin/anggota/impor/')).toBe('/admin/anggota/impor');
  });

  it('a page without an item of its own marks the closest item above it; Beranda only itself', () => {
    expect(activeNavPath(NAV, '/admin/anggota/01J0000000000000000000000A')).toBe('/admin/anggota');
    expect(activeNavPath(NAV, '/admin/anggota/baru')).toBe('/admin/anggota');
    expect(activeNavPath(NAV, '/admin/catalog/records/new')).toBe('/admin/catalog/records');
    expect(activeNavPath(NAV, '/admin')).toBe('/admin');
    expect(activeNavPath(NAV, '/admin/')).toBe('/admin');
    expect(activeNavPath(NAV, '/admin/profile')).toBeNull();
    expect(activeNavPath(NAV, '/admin/layanan-lain')).toBeNull();
  });

  it('only the items given count: a hidden item leaves the page to the item above it', () => {
    const shown = NAV.filter((item) => item.to !== '/admin/anggota/tipe');
    expect(activeNavPath(shown, '/admin/anggota/tipe')).toBe('/admin/anggota');
  });
});
