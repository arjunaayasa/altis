import type { Permission } from '@altis/shared';
import type { MeResponse } from '@altis/shared/api/auth';
import { editionNav } from '@/edition';
import type { AdminKey } from '@/i18n';

/**
 * The shell's sections (spec §13.3 "Kerangka admin": navigation by permission). An item shows when the signed-in
 * user holds its permission (a super admin holds every one) and, for `superAdminOnly`, is a super admin. Hiding is a
 * convenience only: the server refuses whatever the menus hide (§4.8).
 *
 * Phase 2 (its spec §13; plan Task 2) groups them: Katalog, OPAC, then Sistem (the Phase 1 screens); Beranda stays
 * above the groups. The shell and the command palette show each group under its heading (`nav.group.<group>`). The
 * community milestones add Laporan (reports and accreditation) after Katalog, and Layanan (the circulation desk and its
 * lists) and Anggota (members) between Katalog and Laporan.
 *
 * The shell shows them as modules (at the end of this file): a module bar with Beranda and each group the user sees,
 * and a sidebar with the pages of the active module only (Beranda adds its shortcuts). The palette lists every item.
 */
export type NavGroup = 'catalog' | 'circulation' | 'members' | 'reports' | 'opac' | 'system';

/** The groups in the order the shell and the palette show them. */
export const NAV_GROUPS: readonly NavGroup[] = Object.freeze(['catalog', 'circulation', 'members', 'reports', 'opac', 'system'] as const);

export interface NavItem {
  to: string;
  labelKey: AdminKey;
  permission?: Permission;
  superAdminOnly?: boolean;
  /**
   * The permission is granted per branch (the service desk): the item also shows for a user who holds it at any one
   * branch through a role assigned there.
   */
  anyBranch?: boolean;
  /** The group the item is listed under; none for Beranda. */
  group?: NavGroup;
}

export const NAV: readonly NavItem[] = Object.freeze([
  { to: '/admin', labelKey: 'nav.home' },
  // ---- Phase 2 (catalog): Task 2 ----
  // Katalog (§13), in the spec's order. Migrasi SLiMS follows its own permission, not superAdminOnly (M1): a super
  // admin may grant it to a custom role, as with system.backup.restore, and the API admits any holder.
  { to: '/admin/catalog/records', labelKey: 'nav.catalog.records', permission: 'catalog.records.read', group: 'catalog' },
  { to: '/admin/catalog/items', labelKey: 'nav.catalog.items', permission: 'catalog.records.read', group: 'catalog' },
  { to: '/admin/catalog/authorities', labelKey: 'nav.catalog.authorities', permission: 'catalog.records.read', group: 'catalog' },
  { to: '/admin/catalog/locations', labelKey: 'nav.catalog.locations', permission: 'catalog.records.read', group: 'catalog' },
  { to: '/admin/catalog/masters', labelKey: 'nav.catalog.masters', permission: 'catalog.records.read', group: 'catalog' },
  { to: '/admin/catalog/exchange', labelKey: 'nav.catalog.exchange', permission: 'catalog.records.read', group: 'catalog' },
  { to: '/admin/catalog/labels', labelKey: 'nav.catalog.labels', permission: 'catalog.records.read', group: 'catalog' },
  { to: '/admin/catalog/duplicates', labelKey: 'nav.catalog.duplicates', permission: 'catalog.records.manage', group: 'catalog' },
  { to: '/admin/catalog/migration', labelKey: 'nav.catalog.migration', permission: 'catalog.migration.run', group: 'catalog' },
  // OPAC
  { to: '/admin/opac/pages', labelKey: 'nav.opac.pages', permission: 'opac.pages.manage', group: 'opac' },
  // Sistem: the Phase 1 screens.
  { to: '/admin/users', labelKey: 'nav.users', permission: 'system.users.read', group: 'system' },
  { to: '/admin/roles', labelKey: 'nav.roles', permission: 'system.users.read', group: 'system' },
  { to: '/admin/branches', labelKey: 'nav.branches', permission: 'system.branches.manage', group: 'system' },
  { to: '/admin/settings', labelKey: 'nav.settings', permission: 'system.settings.read', group: 'system' },
  { to: '/admin/system', labelKey: 'nav.system', permission: 'system.config.manage', group: 'system' },
  // 1d Task 30: Pembaruan (§13.3), for whoever may read the update state; updating needs `system.update.run`.
  { to: '/admin/updates', labelKey: 'nav.updates', permission: 'system.update.read', group: 'system' },
  { to: '/admin/audit', labelKey: 'nav.audit', permission: 'system.audit.read', group: 'system' },
  { to: '/admin/jobs', labelKey: 'nav.jobs', permission: 'system.jobs.read', group: 'system' },
  { to: '/admin/backups', labelKey: 'nav.backups', permission: 'system.backup.read', group: 'system' },
  { to: '/admin/diagnostics', labelKey: 'nav.diagnostics', permission: 'system.diagnostics.read', group: 'system' },
  { to: '/admin/about', labelKey: 'nav.about', group: 'system' },
  // ---- Komunitas K1 (nav) ----
  // Laporan: the report catalogue and the accreditation workspace, each behind its own permission (managing the
  // workspace needs reading it first).
  { to: '/admin/reports', labelKey: 'nav.reports.reports', permission: 'reports.statistics.read', group: 'reports' },
  { to: '/admin/accreditation', labelKey: 'nav.reports.accreditation', permission: 'accreditation.workspace.read', group: 'reports' },
  // ---- Members and desk circulation ----
  // Layanan: the desk and its quick-return page work at a branch (the desk permission is granted per branch); the
  // overdue list and the loan rules are library-wide. Anggota: the member list, the member types and the CSV import.
  { to: '/admin/layanan', labelKey: 'nav.circulation.desk', permission: 'circulation.desk.use', anyBranch: true, group: 'circulation' },
  { to: '/admin/layanan/kembali', labelKey: 'nav.circulation.quick_return', permission: 'circulation.desk.use', anyBranch: true, group: 'circulation' },
  // ---- Komunitas (holds) ----
  { to: '/admin/layanan/rak-tunggu', labelKey: 'nav.circulation.hold_shelf', permission: 'circulation.desk.use', anyBranch: true, group: 'circulation' },
  // ---- Komunitas (circulation core): read in place at a desk ----
  { to: '/admin/layanan/baca', labelKey: 'nav.circulation.in_library', permission: 'circulation.desk.use', anyBranch: true, group: 'circulation' },
  // ---- Komunitas (charges and payments): open balances, the daily cash summary, the payments ----
  { to: '/admin/layanan/denda', labelKey: 'nav.circulation.charges', permission: 'circulation.records.read', group: 'circulation' },
  { to: '/admin/layanan/terlambat', labelKey: 'nav.circulation.overdue', permission: 'circulation.records.read', group: 'circulation' },
  // ---- Komunitas (notices): the e-mail reminder log, its status and the test send ----
  { to: '/admin/layanan/pengingat', labelKey: 'nav.circulation.notices', permission: 'circulation.records.read', group: 'circulation' },
  { to: '/admin/layanan/aturan', labelKey: 'nav.circulation.policies', permission: 'circulation.policies.manage', group: 'circulation' },
  // ---- Komunitas (circulation core): the library calendar (read at the desk too; changed with the rules) ----
  { to: '/admin/layanan/kalender', labelKey: 'nav.circulation.calendar', permission: 'circulation.policies.manage', group: 'circulation' },
  // ---- Komunitas K2 (visits) ----
  { to: '/admin/layanan/kunjungan', labelKey: 'nav.circulation.visits', permission: 'visits.records.read', group: 'circulation' },
  { to: '/admin/layanan/buku-tamu', labelKey: 'nav.circulation.stations', permission: 'visits.stations.manage', anyBranch: true, group: 'circulation' },
  // ---- Komunitas K4 (stocktake): the sessions of a branch, scanning, the finish ----
  { to: '/admin/layanan/inventarisasi', labelKey: 'nav.circulation.stocktake', permission: 'stocktake.scan.use', anyBranch: true, group: 'circulation' },
  { to: '/admin/anggota', labelKey: 'nav.members.list', permission: 'members.records.read', group: 'members' },
  { to: '/admin/anggota/tipe', labelKey: 'nav.members.types', permission: 'members.types.manage', group: 'members' },
  { to: '/admin/anggota/impor', labelKey: 'nav.members.import', permission: 'members.import.run', group: 'members' },
  // ---- Komunitas (circulation core): numbered clearance letters ----
  { to: '/admin/anggota/bebas-pustaka', labelKey: 'nav.members.clearances', permission: 'members.records.manage', group: 'members' },
  // ---- Komunitas K2 (members extended) ----
  { to: '/admin/anggota/kartu', labelKey: 'nav.members.cards', permission: 'members.records.read', group: 'members' },
  // ---- Komunitas (OPAC home page): the home page as the library's profile site ----
  { to: '/admin/opac/beranda', labelKey: 'nav.opac.home', permission: 'opac.pages.manage', group: 'opac' },
  // The edition's own items (ruling R2, edition/index.ts), after the community ones: none in the community edition.
  ...editionNav,
] satisfies NavItem[]);

/** The items `me` may see: none until the session is fully signed in (a pre-2FA session learns nothing, M10). */
export function visibleNav(me: MeResponse | undefined): NavItem[] {
  return NAV.filter(navFilter(me));
}

/** The test {@link visibleNav} applies to an item (the same for the shortcuts of Beranda); false for every item until `me` is fully signed in. */
function navFilter(me: MeResponse | undefined): (item: NavItem) => boolean {
  if (me === undefined || !me.authenticated || me.stage !== 'full') return () => false;
  const held = new Set<string>(me.permissions);
  const atSomeBranch = new Set<string>(Object.values(me.branchPermissions).flat());
  return (item) => {
    if (item.superAdminOnly === true && !me.superAdmin) return false;
    if (item.permission === undefined || me.superAdmin || held.has(item.permission)) return true;
    return item.anyBranch === true && atSomeBranch.has(item.permission);
  };
}

/**
 * The path of the one item the page at `pathname` belongs to, so the menu marks a single item: the item whose path is
 * the page's, else the longest one the page lies under (Beranda only for itself). Kembali Cepat
 * (`/admin/layanan/kembali`) is marked alone, never Meja Layanan (`/admin/layanan`) beside it, while a member's page
 * (`/admin/anggota/<id>`) still marks Daftar Anggota. Null when no item covers the page.
 */
export function activeNavPath(items: readonly NavItem[], pathname: string): string | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  let best: string | null = null;
  for (const { to } of items) {
    const covers = path === to || (to !== '/admin' && path.startsWith(`${to}/`));
    if (covers && (best === null || to.length > best.length)) best = to;
  }
  return best;
}

/** One heading of the navigation: its group (null for the items above the groups) and its visible items. */
export interface NavSection {
  group: NavGroup | null;
  items: NavItem[];
}

/**
 * {@link visibleNav} by group: the ungrouped items first, then each group of {@link NAV_GROUPS} that has a visible
 * item, in that order; a group with none is left out.
 */
export function visibleNavSections(me: MeResponse | undefined): NavSection[] {
  const items = visibleNav(me);
  const sections: NavSection[] = [];
  const top = items.filter((item) => item.group === undefined);
  if (top.length > 0) sections.push({ group: null, items: top });
  for (const group of NAV_GROUPS) {
    const inGroup = items.filter((item) => item.group === group);
    if (inGroup.length > 0) sections.push({ group, items: inGroup });
  }
  return sections;
}

// ---- Modules: the module bar and the sidebar of the shell ----

/**
 * A module of the shell: Beranda (`home`, the items of no group) or one nav group. The module bar under the top bar
 * lists the modules the user sees, in this order; the sidebar lists the pages of the active one only.
 */
export type NavModule = 'home' | NavGroup;

/** The modules in the order of the module bar. */
export const NAV_MODULES: readonly NavModule[] = Object.freeze(['home', ...NAV_GROUPS] as const);

/** A module the user sees, with its visible pages (never empty) in the order of {@link NAV}. */
export interface ModuleView {
  module: NavModule;
  items: NavItem[];
}

/** {@link visibleNavSections} as modules: Beranda for the ungrouped items, then each group that has a visible item. */
export function visibleModules(me: MeResponse | undefined): ModuleView[] {
  return visibleNavSections(me).map((section) => ({ module: section.group ?? 'home', items: section.items }));
}

/** The first two segments of a path (`/admin/catalog/runs/1` → `/admin/catalog`): the area a page lies in. */
function areaOf(path: string): string {
  return path.split('/').slice(0, 3).join('/');
}

/**
 * The module the page at `pathname` belongs to, among `modules` (what {@link visibleModules} answers): the module of
 * the visible item {@link activeNavPath} marks; else, for a page under no visible item (a detail page of its own path,
 * a page the user's menus hide), the module whose items share the page's area (`/admin/catalog/runs/1` → Katalog);
 * else Beranda (the profile, a path no route serves).
 */
export function activeModule(modules: readonly ModuleView[], pathname: string): NavModule {
  const items = modules.flatMap((m) => m.items);
  const marked = activeNavPath(items, pathname);
  if (marked !== null) return moduleOfItem(items.find((item) => item.to === marked)!);
  const area = areaOf(pathname.replace(/\/+$/, ''));
  if (area !== '/admin') {
    const owner = NAV.find((item) => item.to !== '/admin' && areaOf(item.to) === area);
    const module = owner === undefined ? undefined : moduleOfItem(owner);
    if (module !== undefined && modules.some((m) => m.module === module)) return module;
  }
  return 'home';
}

function moduleOfItem(item: NavItem): NavModule {
  return item.group ?? 'home';
}

/**
 * The shortcuts the sidebar of Beranda lists under "Pintasan": the everyday pages of the desk and of the member list,
 * each behind the permission its page needs. Shown under the same rules as {@link NAV} ({@link visibleShortcuts}).
 */
export const HOME_SHORTCUTS: readonly NavItem[] = Object.freeze([
  { to: '/admin/layanan', labelKey: 'nav.circulation.desk', permission: 'circulation.desk.use', anyBranch: true },
  { to: '/admin/layanan/kembali', labelKey: 'nav.circulation.quick_return', permission: 'circulation.desk.use', anyBranch: true },
  { to: '/admin/anggota/baru', labelKey: 'shell.shortcut.add_member', permission: 'members.records.manage' },
  { to: '/admin/anggota/impor', labelKey: 'nav.members.import', permission: 'members.import.run' },
] satisfies NavItem[]);

/** The shortcuts of Beranda `me` may open. */
export function visibleShortcuts(me: MeResponse | undefined): NavItem[] {
  return HOME_SHORTCUTS.filter(navFilter(me));
}
