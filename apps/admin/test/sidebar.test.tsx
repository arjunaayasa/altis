import { systemRolePermissions, type Permission } from '@altis/shared';
import type { MeResponse } from '@altis/shared/api/auth';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { SIDEBAR_STORAGE_KEY, readSidebarCollapsed } from '@/components/shell/sidebar-state';
import { connectApiClient, createAppRouter } from '@/routes';

// The one sidebar of the admin frame under jsdom: the navigation by permission in its three sections, the groups that
// open and close, the page marked as current, the collapsed form (icons, their names, the menu of a group), and the
// drawer of a narrow screen (a modal dialog that keeps the focus). `fetch` is faked.

type SignedIn = Extract<MeResponse, { authenticated: true }>;

function signedIn(o: { permissions?: readonly Permission[]; superAdmin?: boolean; locale?: 'id' | 'en' | null } = {}): SignedIn {
  return {
    authenticated: true,
    csrfToken: 'csrf-1',
    stage: 'full',
    mustChangePassword: false,
    user: { id: 'u1', username: 'ani', name: 'Ani Lestari', email: null, locale: o.locale ?? null, totpEnabled: false, mfaRequired: false },
    permissions: [...(o.permissions ?? systemRolePermissions('admin'))],
    branchPermissions: {},
    superAdmin: o.superAdmin ?? false,
    reauthUntil: null,
    library: { name: 'Perpustakaan Arsya', locale: 'id' },
    build: '0.1.0',
    banners: [],
  };
}

const fetchMock = vi.fn<typeof fetch>();

function setup(me: MeResponse, path = '/admin') {
  fetchMock.mockImplementation(async (url, init) => {
    if (url === '/api/v1/auth/me' && (init?.method ?? 'GET') === 'GET') {
      return new Response(JSON.stringify(me), { status: 200, headers: { 'Content-Type': 'application/json', 'X-Altis-Build': '0.1.0' } });
    }
    return new Response(JSON.stringify({ type: 'about:blank', title: 'Not found', status: 404, code: 'NOT_FOUND' }), {
      status: 404,
      headers: { 'Content-Type': 'application/problem+json' },
    });
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter({ queryClient, history: createMemoryHistory({ initialEntries: [path] }) });
  onTestFinished(connectApiClient(router, queryClient));
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, view };
}

/** The sidebar's navigation. */
const nav = async (name = 'Navigasi utama'): Promise<HTMLElement> => screen.findByRole('navigation', { name });

/** The sidebar itself. */
const sidebar = (): HTMLElement => document.getElementById('altis-sidebar')!;

/** The entries of the sidebar from top to bottom: `link:` Beranda, `group:` a collapsible group. */
const entries = (el: HTMLElement): string[] =>
  [...el.querySelectorAll<HTMLElement>(':scope > div > ul > li > :is(a, button)')].map((e) => `${e.tagName === 'A' ? 'link' : 'group'}:${e.getAttribute('aria-label') ?? e.textContent}`);

const group = (el: HTMLElement, name: string): HTMLElement => within(el).getByRole('button', { name });

/** The pages listed under an open group. */
const pagesOf = (el: HTMLElement, name: string): [string | null, string | null][] => {
  const button = group(el, name);
  expect(button.getAttribute('aria-expanded')).toBe('true');
  return within(document.getElementById(button.getAttribute('aria-controls')!)!)
    .getAllByRole('link')
    .map((a) => [a.textContent, a.getAttribute('href')]);
};

const openGroups = (el: HTMLElement): (string | null)[] =>
  within(el)
    .getAllByRole('button')
    .filter((b) => b.getAttribute('aria-expanded') === 'true')
    .map((b) => b.textContent);

const currentPages = (el: HTMLElement): (string | null)[] => [...el.querySelectorAll('a[aria-current="page"]')].map((a) => a.textContent);

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  sessionStorage.clear();
  localStorage.clear();
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('navigation', () => {
  it('three labelled sections; Beranda is a link, every group a button that opens its pages', async () => {
    setup(signedIn());
    const el = await nav();
    expect(within(el).getAllByRole('list').map((ul) => ul.getAttribute('aria-labelledby')).filter((id) => id !== null).map((id) => document.getElementById(id)!.textContent)).toEqual([
      'Kerja harian',
      'Koleksi',
      'Situs & sistem',
    ]);
    expect(entries(el)).toEqual(['link:Beranda', 'group:Layanan', 'group:Anggota', 'group:Katalog', 'group:Laporan', 'group:Situs / OPAC', 'group:Sistem']);
    // On Beranda no group is open, and only Beranda is a link.
    expect(openGroups(el)).toEqual([]);
    expect(within(el).getAllByRole('link').map((a) => [a.textContent, a.getAttribute('href'), a.getAttribute('aria-current')])).toEqual([['Beranda', '/admin', 'page']]);

    fireEvent.click(group(el, 'Anggota'));
    expect(pagesOf(el, 'Anggota')).toEqual([
      ['Daftar Anggota', '/admin/anggota'],
      ['Tipe Anggota', '/admin/anggota/tipe'],
      ['Impor Anggota', '/admin/anggota/impor'],
      ['Surat Bebas Pustaka', '/admin/anggota/bebas-pustaka'],
      ['Cetak Kartu', '/admin/anggota/kartu'],
    ]);
    fireEvent.click(group(el, 'Katalog'));
    expect(openGroups(el)).toEqual(['Anggota', 'Katalog']);
    // Pressed again, a group closes: its pages leave the accessibility tree.
    fireEvent.click(group(el, 'Anggota'));
    expect(openGroups(el)).toEqual(['Katalog']);
    expect(within(el).queryByRole('link', { name: 'Daftar Anggota' })).toBeNull();
  });

  it('every entry has its icon, hidden from screen readers, beside its name', async () => {
    setup(signedIn());
    const el = await nav();
    for (const entry of el.querySelectorAll(':scope > div > ul > li > :is(a, button)')) {
      expect(entry.querySelector('svg')!.getAttribute('aria-hidden'), entry.textContent ?? '').toBe('true');
      expect(entry.textContent).not.toBe('');
    }
  });

  it('Situs / OPAC lists its pages, then the public site in a tab of its own', async () => {
    setup(signedIn());
    const el = await nav();
    fireEvent.click(group(el, 'Situs / OPAC'));
    expect(pagesOf(el, 'Situs / OPAC')).toEqual([
      ['Halaman awal', '/admin/opac/beranda'],
      ['Identitas situs', '/admin/opac/identitas'],
      ['Halaman & Berita', '/admin/opac/pages'],
      ['Situs publik(tab baru)', '/'],
    ]);
    const site = within(el).getByRole('link', { name: /Situs publik/ });
    expect([site.getAttribute('target'), site.getAttribute('rel')]).toEqual(['_blank', 'noopener']);
  });

  it('follows the permissions: a catalogue reader sees Beranda, Katalog with its seven pages and Sistem with Tentang only', async () => {
    setup(signedIn({ permissions: ['catalog.records.read'] }));
    const el = await nav();
    expect(entries(el)).toEqual(['link:Beranda', 'group:Katalog', 'group:Sistem']);
    // A section with nothing to show has no label.
    expect(within(el).queryByText('Kerja harian')).toBeTruthy();
    fireEvent.click(group(el, 'Katalog'));
    expect(pagesOf(el, 'Katalog')).toHaveLength(7);
    fireEvent.click(group(el, 'Sistem'));
    expect(pagesOf(el, 'Sistem')).toEqual([['Tentang', '/admin/about']]);
    expect(screen.queryByRole('link', { name: 'Konfigurasi Sistem' })).toBeNull();
  });

  it('the desk held at one branch only: Layanan with the desk pages', async () => {
    setup({ ...signedIn({ permissions: [] }), branchPermissions: { b1: ['circulation.desk.use'] } });
    const el = await nav();
    expect(entries(el)).toEqual(['link:Beranda', 'group:Layanan', 'group:Sistem']);
    expect(within(el).queryByText('Koleksi')).toBeNull();
    fireEvent.click(group(el, 'Layanan'));
    expect(pagesOf(el, 'Layanan').map(([name]) => name)).toEqual(['Meja Layanan', 'Kembali Cepat', 'Rak Tunggu & Reservasi', 'Baca di Tempat']);
  });

  it('a super admin sees Konfigurasi Sistem under Sistem', async () => {
    setup(signedIn({ permissions: systemRolePermissions('super_admin'), superAdmin: true }), '/admin/system');
    const el = await nav();
    expect(pagesOf(el, 'Sistem').map(([name]) => name)).toContain('Konfigurasi Sistem');
    expect(currentPages(el)).toEqual(['Konfigurasi Sistem']);
  });

  it('the group of the page is open and one page is marked, deep links and detail pages included', async () => {
    const at = async (path: string): Promise<[(string | null)[], (string | null)[]]> => {
      const { view } = setup(signedIn({ permissions: systemRolePermissions('super_admin'), superAdmin: true }), path);
      const el = await nav();
      const found: [(string | null)[], (string | null)[]] = [openGroups(el), currentPages(el)];
      view.unmount();
      return found;
    };
    expect(await at('/admin/layanan/kembali')).toEqual([['Layanan'], ['Kembali Cepat']]);
    expect(await at('/admin/layanan?member=01J0000000000000000000000A')).toEqual([['Layanan'], ['Meja Layanan']]);
    expect(await at('/admin/anggota/01J0000000000000000000000A')).toEqual([['Anggota'], ['Daftar Anggota']]);
    expect(await at('/admin/settings/catalog')).toEqual([['Sistem'], ['Pengaturan']]);
    expect(await at('/admin/accreditation/01J0000000000000000000000A')).toEqual([['Laporan'], ['Akreditasi']]);
    // A page of its own path under no menu item still opens its group.
    expect(await at('/admin/catalog/runs/01J0000000000000000000000A')).toEqual([['Katalog'], []]);
    expect(await at('/admin/profile')).toEqual([[], []]);
    expect(await at('/admin')).toEqual([[], ['Beranda']]);
  });

  it('following a link moves the mark; the group of the new page opens, a group opened by hand stays open', async () => {
    const { router } = setup(signedIn(), '/admin/anggota');
    const el = await nav();
    expect(openGroups(el)).toEqual(['Anggota']);
    fireEvent.click(group(el, 'Laporan'));
    fireEvent.click(within(el).getByRole('link', { name: 'Tipe Anggota' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/anggota/tipe'));
    await waitFor(() => expect(currentPages(el)).toEqual(['Tipe Anggota']));
    // Another group's page, reached without the sidebar (the command palette, a link on a page).
    await act(() => router.navigate({ to: '/admin/about' }));
    await waitFor(() => expect(currentPages(el)).toEqual(['Tentang']));
    expect(openGroups(el)).toEqual(['Laporan', 'Sistem']);
  });

  it('the library stands at the top by its name, as plain text', async () => {
    setup(signedIn());
    await nav();
    const brand = sidebar().firstElementChild!;
    expect(brand.textContent).toBe('Perpustakaan Arsya');
    expect(brand.querySelector('img, svg')).toBeNull();
  });

  it('in English', async () => {
    setup(signedIn({ locale: 'en' }));
    const el = await nav('Main navigation');
    expect(entries(el)).toEqual(['link:Home', 'group:Circulation', 'group:Members', 'group:Catalogue', 'group:Reports', 'group:Site / OPAC', 'group:System']);
    expect(within(el).getByText('Daily work')).toBeTruthy();
    expect(within(el).getByText('Site & system')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Collapse menu' })).toBeTruthy();
  });
});

describe('collapsed to its icons', () => {
  it('the button at the foot collapses the sidebar and says so; the choice is remembered in this browser', async () => {
    const { view } = setup(signedIn(), '/admin/anggota');
    await nav();
    const toggle = screen.getByRole('button', { name: 'Ciutkan menu' });
    expect([toggle.getAttribute('aria-expanded'), toggle.getAttribute('aria-controls')]).toEqual(['true', 'altis-sidebar']);
    expect(sidebar().hasAttribute('data-collapsed')).toBe(false);
    expect(localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBeNull();

    fireEvent.click(toggle);
    expect(localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe('collapsed');
    expect(sidebar().hasAttribute('data-collapsed')).toBe(true);
    const expand = screen.getByRole('button', { name: 'Lebarkan menu' });
    expect(expand.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('[data-slot="shell"]')!.className).toContain('lg:grid-cols-[56px_minmax(0,1fr)]');

    // The page loaded again: still collapsed.
    view.unmount();
    setup(signedIn(), '/admin/anggota');
    await nav();
    expect(sidebar().hasAttribute('data-collapsed')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Lebarkan menu' }));
    expect(localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe('expanded');
    expect(sidebar().hasAttribute('data-collapsed')).toBe(false);
    expect(document.querySelector('[data-slot="shell"]')!.className).toContain('lg:grid-cols-[240px_minmax(0,1fr)]');
  });

  it('storage that cannot be read or written: the sidebar starts full, and the button still works', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    expect(readSidebarCollapsed()).toBe(false);
    setup(signedIn());
    await nav();
    fireEvent.click(screen.getByRole('button', { name: 'Ciutkan menu' }));
    expect(sidebar().hasAttribute('data-collapsed')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Lebarkan menu' }));
    expect(sidebar().hasAttribute('data-collapsed')).toBe(false);
  });

  it('an unknown stored value is not "collapsed"', () => {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, 'icons');
    expect(readSidebarCollapsed()).toBe(false);
    localStorage.setItem(SIDEBAR_STORAGE_KEY, 'collapsed');
    expect(readSidebarCollapsed()).toBe(true);
  });

  it('every icon keeps its name: Beranda a link, each group a button; the section labels stay for screen readers', async () => {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, 'collapsed');
    setup(signedIn(), '/admin/anggota/tipe');
    const el = await nav();
    expect(entries(el)).toEqual(['link:Beranda', 'group:Layanan', 'group:Anggota', 'group:Katalog', 'group:Laporan', 'group:Situs / OPAC', 'group:Sistem']);
    expect(within(el).getByRole('link', { name: 'Beranda' }).getAttribute('href')).toBe('/admin');
    for (const entry of el.querySelectorAll(':scope > div > ul > li > :is(a, button)')) {
      // The name is the accessible name; the icon alone is what shows.
      expect(entry.textContent).toBe('');
      expect(entry.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
    }
    expect(within(el).getByText('Kerja harian').className).toBe('sr-only');
    // The group of the page is marked.
    expect(group(el, 'Anggota').className).toContain('bg-side-active');
    expect(group(el, 'Katalog').className).not.toContain('bg-side-active ');
  });

  it('a tooltip names the icon that has the keyboard focus', async () => {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, 'collapsed');
    setup(signedIn());
    const el = await nav();
    act(() => group(el, 'Katalog').focus());
    expect((await screen.findByRole('tooltip')).textContent).toBe('Katalog');
  });

  it('a group opens a menu of its pages from the keyboard; a page is followed, and Escape gives the focus back', async () => {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, 'collapsed');
    const { router } = setup(signedIn(), '/admin/anggota/tipe');
    const el = await nav();
    const members = group(el, 'Anggota');
    members.focus();
    fireEvent.keyDown(members, { key: 'Enter' });
    const menu = await screen.findByRole('menu');
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((a) => [a.tagName, a.textContent, a.getAttribute('href'), a.getAttribute('aria-current')])).toEqual([
      ['A', 'Daftar Anggota', '/admin/anggota', null],
      ['A', 'Tipe Anggota', '/admin/anggota/tipe', 'page'],
      ['A', 'Impor Anggota', '/admin/anggota/impor', null],
      ['A', 'Surat Bebas Pustaka', '/admin/anggota/bebas-pustaka', null],
      ['A', 'Cetak Kartu', '/admin/anggota/kartu', null],
    ]);
    // The menu is named by its group.
    expect(menu.getAttribute('aria-labelledby')).toBe(members.id);
    fireEvent.keyDown(menu, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(document.activeElement).toBe(members);

    fireEvent.keyDown(members, { key: 'ArrowDown' });
    fireEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Impor Anggota' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/anggota/impor'));
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  it('the menu of Situs / OPAC ends with the public site', async () => {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, 'collapsed');
    setup(signedIn());
    const el = await nav();
    fireEvent.keyDown(group(el, 'Situs / OPAC'), { key: 'Enter' });
    const site = within(await screen.findByRole('menu')).getByRole('menuitem', { name: /Situs publik/ });
    expect([site.getAttribute('href'), site.getAttribute('target')]).toEqual(['/', '_blank']);
  });
});

describe('the drawer of a narrow screen', () => {
  // jsdom knows the attribute, not the property.
  const inert = (...els: Element[]): boolean[] => els.map((el) => el.hasAttribute('inert'));

  it('the menu button opens it as a modal dialog with the focus on the page shown; the rest of the frame is inert', async () => {
    setup(signedIn(), '/admin/anggota');
    const menu = await screen.findByRole('button', { name: 'Buka menu' });
    expect([menu.getAttribute('aria-controls'), menu.getAttribute('aria-expanded')]).toEqual(['altis-sidebar', 'false']);
    expect(menu.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
    const header = screen.getByRole('banner');
    const content = document.getElementById('main')!.parentElement!;
    const skip = screen.getByRole('link', { name: 'Lewati ke konten utama' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(inert(header, content, skip)).toEqual([false, false, false]);

    fireEvent.click(menu);
    expect(menu.getAttribute('aria-expanded')).toBe('true');
    const drawer = screen.getByRole('dialog', { name: 'Menu' });
    expect(drawer).toBe(sidebar());
    expect(drawer.getAttribute('aria-modal')).toBe('true');
    expect(inert(header, content, skip)).toEqual([true, true, true]);
    expect(inert(drawer)).toEqual([false]);
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Daftar Anggota'));
    expect(drawer.contains(document.activeElement)).toBe(true);
    // Everything that can take the focus now is inside the drawer.
    const focusable = [...document.querySelectorAll<HTMLElement>('a[href], button')].filter((el) => el.closest('[inert]') === null && el.closest('[hidden]') === null);
    expect(focusable.length).toBeGreaterThan(0);
    for (const el of focusable) expect(drawer.contains(el), el.textContent ?? '').toBe(true);
  });

  it('Escape closes it from anywhere and gives the focus back to the menu button', async () => {
    setup(signedIn(), '/admin/anggota');
    const menu = await screen.findByRole('button', { name: 'Buka menu' });
    fireEvent.click(menu);
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Daftar Anggota'));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(menu.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(menu);

    // The focus somewhere else (a click on the page under the scrim): Escape still closes it.
    fireEvent.click(menu);
    act(() => (document.activeElement as HTMLElement).blur());
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(menu);
  });

  it('its close button and the scrim close it too, the focus back on the menu button', async () => {
    setup(signedIn(), '/admin/anggota');
    const menu = await screen.findByRole('button', { name: 'Buka menu' });
    fireEvent.click(menu);
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Menu' })).getByRole('button', { name: 'Tutup menu' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(menu);
    // The close button is the drawer's only.
    expect(screen.queryByRole('button', { name: 'Tutup menu' })).toBeNull();

    fireEvent.click(menu);
    fireEvent.click(document.querySelector('[data-slot="scrim"]')!);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('[data-slot="scrim"]')).toBeNull();
    expect(document.activeElement).toBe(menu);
  });

  it('a page followed in it closes it; so does a change of page by other means', async () => {
    const { router } = setup(signedIn(), '/admin/anggota');
    const menu = await screen.findByRole('button', { name: 'Buka menu' });
    const header = screen.getByRole('banner');
    fireEvent.click(menu);
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Menu' })).getByRole('link', { name: 'Tipe Anggota' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/anggota/tipe'));
    expect(screen.queryByRole('dialog', { name: 'Menu' })).toBeNull();
    expect(inert(header)).toEqual([false]);

    fireEvent.click(menu);
    expect(menu.getAttribute('aria-expanded')).toBe('true');
    await act(() => router.navigate({ to: '/admin/profile' }));
    expect(menu.getAttribute('aria-expanded')).toBe('false');
    expect(inert(header)).toEqual([false]);
  });

  it('the drawer shows the full menu even when the sidebar is collapsed on a wide screen', async () => {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, 'collapsed');
    setup(signedIn(), '/admin/anggota');
    fireEvent.click(await screen.findByRole('button', { name: 'Buka menu' }));
    const drawer = screen.getByRole('dialog', { name: 'Menu' });
    expect(drawer.hasAttribute('data-collapsed')).toBe(false);
    expect(within(drawer).getByRole('link', { name: 'Daftar Anggota' }).getAttribute('aria-current')).toBe('page');
    expect(within(drawer).getByText('Kerja harian').className).not.toBe('sr-only');
  });
});

describe('keyboard', () => {
  it('every entry is a link or a button in the tab order, in the order shown', async () => {
    setup(signedIn(), '/admin/anggota');
    const el = await nav();
    const stops = [...sidebar().querySelectorAll<HTMLElement>('a[href], button')].filter((e) => e.closest('[hidden]') === null);
    for (const stop of stops) expect(stop.tabIndex, stop.textContent ?? '').toBe(0);
    expect(stops.map((e) => e.textContent)).toEqual([
      'Beranda',
      'Layanan',
      'Anggota',
      'Daftar Anggota',
      'Tipe Anggota',
      'Impor Anggota',
      'Surat Bebas Pustaka',
      'Cetak Kartu',
      'Katalog',
      'Laporan',
      'Situs / OPAC',
      'Sistem',
      'Ciutkan menu',
    ]);
    // A group is a native button: Enter and Space press it.
    expect(group(el, 'Katalog').getAttribute('type')).toBe('button');
  });

  it('the skip link stays the first stop of the page, before the sidebar', async () => {
    setup(signedIn());
    await nav();
    const first = document.querySelector<HTMLElement>('a[href], button')!;
    expect(first.textContent).toBe('Lewati ke konten utama');
    expect(first.getAttribute('href')).toBe('#main');
    expect(first.compareDocumentPosition(sidebar()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
