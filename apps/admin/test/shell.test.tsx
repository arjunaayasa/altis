import { MESSAGES, systemRolePermissions, type Permission } from '@altis/shared';
import type { Banner, MeResponse } from '@altis/shared/api/auth';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { reauth } from '@/lib/api';
import { buildSync } from '@/lib/build-sync';
import { dirtyForms } from '@/lib/dirty-forms';
import { ME_KEY } from '@/lib/me';
import { connectApiClient, createAppRouter } from '@/routes';

// The admin frame end to end under jsdom (spec §13.3 "Kerangka admin"): the route gate on `GET auth/me`, navigation
// by permission, the language, the status banners, the command palette and the reauth dialog. `fetch` is faked.

type SignedIn = Extract<MeResponse, { authenticated: true }>;

function signedIn(
  o: { permissions?: readonly Permission[]; superAdmin?: boolean; locale?: 'id' | 'en' | null; banners?: Banner[]; user?: { id: string; username: string; name: string } } = {},
): SignedIn {
  return {
    authenticated: true,
    csrfToken: 'csrf-1',
    stage: 'full',
    mustChangePassword: false,
    user: { id: 'u1', username: 'ani', name: 'Ani', ...o.user, email: null, locale: o.locale ?? null, totpEnabled: false, mfaRequired: false },
    permissions: [...(o.permissions ?? systemRolePermissions('admin'))],
    branchPermissions: {},
    superAdmin: o.superAdmin ?? false,
    reauthUntil: null,
    library: { name: 'Perpustakaan Arsya', locale: 'id' },
    build: '0.1.0',
    banners: o.banners ?? [],
  };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'X-Altis-Build': '0.1.0' } });

const fetchMock = vi.fn<typeof fetch>();

function setup(me: MeResponse, path = '/admin') {
  let current = me;
  fetchMock.mockImplementation(async (url, init) => {
    const method = init?.method ?? 'GET';
    if (url === '/api/v1/auth/me' && method === 'GET') return json(current);
    if (url === '/api/v1/auth/me' && method === 'PATCH') return json({});
    if (url === '/api/v1/auth/logout') {
      current = { authenticated: false, csrfToken: 'pre', library: me.library, build: me.build };
      return new Response(null, { status: 204 });
    }
    if (url === '/api/v1/auth/reauth') return json({ reauthUntil: 1 });
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
  /** What `GET auth/me` answers from now on. */
  const answerMe = (next: MeResponse): void => {
    current = next;
  };
  return { router, queryClient, view, answerMe };
}

/** The window regains focus after `auth/me` went stale: React Query reads it again (what a returning user does). */
async function returnToTab(queryClient: QueryClient): Promise<void> {
  await act(() => queryClient.invalidateQueries({ queryKey: ME_KEY }));
}

const calls = (): [string, string][] => fetchMock.mock.calls.map((c) => [c[1]?.method ?? 'GET', String(c[0])]);

/** The navigation of the sidebar (test/sidebar.test.tsx covers the sidebar itself). */
const mainNav = (name = 'Navigasi utama'): HTMLElement => screen.getByRole('navigation', { name });

/** The pages listed under a group of the sidebar, once the group is open. */
const pagesOf = (group: string): [string | null, string | null][] => {
  const button = within(mainNav()).getByRole('button', { name: group });
  if (button.getAttribute('aria-expanded') !== 'true') fireEvent.click(button);
  return within(document.getElementById(button.getAttribute('aria-controls')!)!)
    .getAllByRole('link')
    .map((a) => [a.textContent, a.getAttribute('href')]);
};

/** Where the top bar says the user is. */
const crumbs = (name = 'Lokasi halaman'): (string | null)[] =>
  within(screen.getByRole('navigation', { name }))
    .getAllByRole('listitem')
    .map((li) => li.textContent);

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  sessionStorage.clear();
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  buildSync.mismatch = false;
});

describe('route gate', () => {
  it('GET auth/me is the first request, then the shell renders Beranda in Indonesian', async () => {
    setup(signedIn());
    expect(await screen.findByText('Selamat datang, Ani.')).toBeTruthy();
    expect(calls()[0]).toEqual(['GET', '/api/v1/auth/me']);
    expect(document.documentElement.lang).toBe('id');
    expect(screen.getAllByText('Perpustakaan Arsya').length).toBeGreaterThan(0);
  });

  it('signed out → /admin/login?next=<path>, no shell', async () => {
    const { router } = setup({ authenticated: false, csrfToken: 'pre', library: { name: 'Perpustakaan Arsya', locale: 'id' }, build: '0.1.0' }, '/admin/users?q=a');
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/login'));
    expect(router.state.location.search).toEqual({ next: '/admin/users?q=a' });
    expect(await screen.findByRole('heading', { name: 'Masuk' })).toBeTruthy();
    expect(screen.queryByRole('navigation')).toBeNull();
  });

  it('a session that still owes the second factor → /admin/login/2fa', async () => {
    const { router } = setup({ ...signedIn({ permissions: [] }), stage: 'mfa' });
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/login/2fa'));
    expect(screen.queryByRole('navigation')).toBeNull();
  });

  it('a section without a screen yet shows "not found" inside the frame', async () => {
    setup(signedIn(), '/admin/no-such-section');
    expect(await screen.findByText('Halaman tidak ditemukan')).toBeTruthy();
    expect(within(mainNav()).getByRole('button', { name: 'Sistem' })).toBeTruthy();
    // A path no route serves belongs to no group: no page is marked, and the top bar says Beranda.
    expect(mainNav().querySelector('[aria-current="page"]')).toBeNull();
    expect(crumbs()).toEqual(['Beranda']);
  });

  it('the community edition has no Lisensi screen: /admin/license is "not found" inside the frame, and no link leads there', async () => {
    setup(signedIn({ permissions: systemRolePermissions('super_admin'), superAdmin: true }), '/admin/license');
    expect(await screen.findByText('Halaman tidak ditemukan')).toBeTruthy();
    expect(within(mainNav()).queryByRole('link', { name: 'Lisensi' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Lisensi' })).toBeNull();
    expect(document.querySelector('a[href="/admin/license"]')).toBeNull();
  });
});

describe('a session that ends while the shell is open', () => {
  const ANON: MeResponse = { authenticated: false, csrfToken: 'pre', library: { name: 'Perpustakaan Arsya', locale: 'id' }, build: '0.1.0' };
  const ENDED_NOTICE = 'Sesi Anda telah berakhir. Silakan masuk lagi.';

  it('auth/me answering signed out (idle expiry, sign-out elsewhere) → the sign-in page says why; the page never goes blank', async () => {
    const { router, queryClient, view, answerMe } = setup(signedIn());
    await screen.findByText('Selamat datang, Ani.');
    let blank = false;
    const watch = new MutationObserver(() => {
      blank ||= view.container.textContent === '';
    });
    watch.observe(view.container, { childList: true, subtree: true, characterData: true });
    answerMe(ANON);
    await returnToTab(queryClient);
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/login'));
    expect(router.state.location.search).toEqual({ notice: 'session_ended' });
    expect(await screen.findByText(ENDED_NOTICE)).toBeTruthy();
    watch.disconnect();
    expect(blank).toBe(false);
  });

  it('keeps the page to come back to in ?next=', async () => {
    const { router, queryClient, answerMe } = setup(signedIn(), '/admin/no-such-section?q=a');
    await screen.findByText('Halaman tidak ditemukan');
    answerMe(ANON);
    await returnToTab(queryClient);
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/login'));
    expect(router.state.location.search).toEqual({ next: '/admin/no-such-section?q=a', notice: 'session_ended' });
  });

  it('a form being filled stays, with what was typed: the shell warns and offers to sign in again', async () => {
    const { router, queryClient, answerMe } = setup(signedIn(), '/admin/profile');
    const name = (await screen.findByLabelText('Nama')) as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'Ani Lestari' } });
    await waitFor(() => expect(dirtyForms.count()).toBe(1));
    answerMe(ANON);
    await returnToTab(queryClient);
    const warning = await screen.findByRole('alert', { name: 'Sesi Anda telah berakhir' });
    expect(router.state.location.pathname).toBe('/admin/profile');
    expect((screen.getByLabelText('Nama') as HTMLInputElement).value).toBe('Ani Lestari');
    expect(dirtyForms.count()).toBe(1);
    expect(within(mainNav()).getByRole('button', { name: 'Sistem' })).toBeTruthy();
    // The warning keeps its place above the screen, inside the content column.
    expect(warning.compareDocumentPosition(document.getElementById('main')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(within(warning).getByRole('button', { name: 'Masuk lagi' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/login'));
    expect(router.state.location.search).toEqual({ next: '/admin/profile', notice: 'session_ended' });
  });

  it('another user signed in meanwhile (a shared PC): the page starts over under that user, never keeping the form', async () => {
    const { router, queryClient, answerMe } = setup(signedIn(), '/admin/profile');
    const name = (await screen.findByLabelText('Nama')) as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'Diketik oleh Ani' } });
    await waitFor(() => expect(dirtyForms.count()).toBe(1));
    queryClient.setQueryData(['users', 'list', { q: '' }], { items: ['read while Ani was signed in'] });
    answerMe(signedIn({ user: { id: 'u2', username: 'budi', name: 'Budi' } }));
    await returnToTab(queryClient);
    await waitFor(() => expect((screen.getByLabelText('Nama') as HTMLInputElement).value).toBe('Budi'));
    expect(router.state.location.pathname).toBe('/admin/profile');
    expect(screen.queryByRole('alert', { name: 'Sesi Anda telah berakhir' })).toBeNull();
    expect(screen.queryByDisplayValue('Diketik oleh Ani')).toBeNull();
    expect(dirtyForms.count()).toBe(0);
    // Nothing read for Ani is shown to Budi.
    expect(queryClient.getQueryData(['users', 'list', { q: '' }])).toBeUndefined();
    expect(queryClient.getQueryData(ME_KEY)).toMatchObject({ user: { id: 'u2' } });
  });

  it('a session that now owes the second factor (signed in again elsewhere) → /admin/login/2fa, never the error page', async () => {
    const { router, queryClient, answerMe } = setup(signedIn(), '/admin/profile');
    await screen.findByLabelText('Nama');
    answerMe({ ...signedIn({ permissions: [] }), stage: 'mfa' });
    await returnToTab(queryClient);
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/login/2fa'));
    expect(screen.queryByText('Terjadi kesalahan')).toBeNull();
  });
});

describe('CSRF recovery and the identity of the page', () => {
  it('a write refused for its CSRF token is not sent again once auth/me names another user', async () => {
    const { answerMe } = setup(signedIn());
    await screen.findByText('Selamat datang, Ani.');
    const answer = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url, init) =>
      url === '/api/v1/auth/reauth'
        ? new Response(JSON.stringify({ type: 'about:blank', title: 'x', status: 403, code: 'CSRF_INVALID' }), {
            status: 403,
            headers: { 'Content-Type': 'application/problem+json' },
          })
        : answer(url, init),
    );
    // Ani's session ended in another tab, and Budi signed in there; this tab has not read auth/me since.
    answerMe(signedIn({ user: { id: 'u2', username: 'budi', name: 'Budi' } }));
    act(() => {
      reauth.request().catch(() => {});
    });
    const dialog = await screen.findByRole('dialog', { name: 'Konfirmasi kata sandi' });
    fireEvent.change(within(dialog).getByLabelText('Kata sandi'), { target: { value: 'kata-sandi-ani' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Konfirmasi' }));
    await waitFor(() => expect(calls().filter(([, url]) => url === '/api/v1/auth/me').length).toBeGreaterThanOrEqual(2));
    await screen.findByText('Selamat datang, Budi.');
    expect(calls().filter(([, url]) => url === '/api/v1/auth/reauth')).toHaveLength(1);
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Konfirmasi kata sandi' })).getByRole('button', { name: 'Batal' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('navigation and language', () => {
  /** Each group of an admin, in the sidebar's order, with the pages it lists. */
  const ADMIN_GROUPS: [string, [string, string][]][] = [
    [
      'Layanan',
      [
        ['Meja Layanan', '/admin/layanan'],
        ['Kembali Cepat', '/admin/layanan/kembali'],
        ['Rak Tunggu & Reservasi', '/admin/layanan/rak-tunggu'],
        ['Baca di Tempat', '/admin/layanan/baca'],
        ['Denda & Pembayaran', '/admin/layanan/denda'],
        ['Terlambat & Jatuh Tempo', '/admin/layanan/terlambat'],
        ['Pengingat E-mail', '/admin/layanan/pengingat'],
        ['Aturan Peminjaman', '/admin/layanan/aturan'],
        ['Kalender', '/admin/layanan/kalender'],
        ['Kunjungan', '/admin/layanan/kunjungan'],
        ['Perangkat Buku Tamu', '/admin/layanan/buku-tamu'],
        ['Inventarisasi', '/admin/layanan/inventarisasi'],
      ],
    ],
    [
      'Anggota',
      [
        ['Daftar Anggota', '/admin/anggota'],
        ['Tipe Anggota', '/admin/anggota/tipe'],
        ['Impor Anggota', '/admin/anggota/impor'],
        ['Surat Bebas Pustaka', '/admin/anggota/bebas-pustaka'],
        ['Cetak Kartu', '/admin/anggota/kartu'],
      ],
    ],
    [
      'Katalog',
      // An admin has no Migrasi SLiMS (ADMIN_EXCLUDED).
      [
        ['Bibliografi', '/admin/catalog/records'],
        ['Eksemplar', '/admin/catalog/items'],
        ['Otoritas', '/admin/catalog/authorities'],
        ['Lokasi & Rak', '/admin/catalog/locations'],
        ['Data Induk', '/admin/catalog/masters'],
        ['Impor/Ekspor', '/admin/catalog/exchange'],
        ['Cetak Label', '/admin/catalog/labels'],
        ['Duplikat', '/admin/catalog/duplicates'],
      ],
    ],
    [
      'Laporan',
      [
        ['Laporan', '/admin/reports'],
        ['Akreditasi', '/admin/accreditation'],
      ],
    ],
    [
      'Situs / OPAC',
      [
        ['Halaman awal', '/admin/opac/beranda'],
        ['Identitas situs', '/admin/opac/identitas'],
        ['Halaman & Berita', '/admin/opac/pages'],
        // Not a page of the admin: the public site, in a tab of its own.
        ['Situs publik(tab baru)', '/'],
      ],
    ],
    [
      'Sistem',
      [
        ['Pengguna', '/admin/users'],
        ['Peran', '/admin/roles'],
        ['Cabang', '/admin/branches'],
        ['Pengaturan', '/admin/settings'],
        ['Pembaruan', '/admin/updates'],
        ['Log audit', '/admin/audit'],
        ['Tugas dan Jadwal', '/admin/jobs'],
        ['Cadangan', '/admin/backups'],
        ['Diagnostik', '/admin/diagnostics'],
        ['Tentang', '/admin/about'],
      ],
    ],
  ];

  it('an admin sees Beranda and every group in one sidebar, each group with its pages: every page but Konfigurasi Sistem', async () => {
    setup(signedIn());
    await screen.findByText('Selamat datang, Ani.');
    expect(within(mainNav()).getByRole('link', { name: 'Beranda' }).getAttribute('href')).toBe('/admin');
    expect(
      within(mainNav())
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(ADMIN_GROUPS.map(([name]) => name));
    for (const [name, pages] of ADMIN_GROUPS) expect(pagesOf(name), name).toEqual(pages);
    expect(screen.queryByRole('link', { name: 'Konfigurasi Sistem' })).toBeNull();
  });

  it('there is one navigation and one top bar: no bar of modules, no sidebar per module', async () => {
    setup(signedIn(), '/admin/anggota');
    await screen.findByRole('heading', { level: 1, name: 'Anggota' });
    expect(
      screen
        .getAllByRole('navigation')
        .map((n) => n.getAttribute('aria-label'))
        .slice(0, 2),
    ).toEqual(['Navigasi utama', 'Lokasi halaman']);
    expect(screen.queryByRole('navigation', { name: 'Menu Anggota' })).toBeNull();
    // The navigation is in the sidebar, the top bar beside it.
    const sidebar = document.getElementById('altis-sidebar')!;
    expect(sidebar.contains(mainNav())).toBe(true);
    expect(sidebar.contains(screen.getByRole('banner'))).toBe(false);
    expect(screen.getAllByRole('banner')).toHaveLength(1);
  });

  it('a change of screen moves the focus to its heading and names the page in the tab title; the first screen keeps it', async () => {
    document.title = 'ALTIS Admin';
    const { router } = setup(signedIn());
    await screen.findByText('Selamat datang, Ani.');
    expect(document.activeElement).toBe(document.body);
    expect(document.title).toBe('Beranda · ALTIS Admin');
    fireEvent.click(within(mainNav()).getByRole('button', { name: 'Anggota' }));
    const link = within(mainNav()).getByRole('link', { name: 'Daftar Anggota' });
    link.focus();
    fireEvent.click(link);
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/anggota'));
    const heading = await screen.findByRole('heading', { level: 1, name: 'Anggota' });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(heading.getAttribute('tabindex')).toBe('-1');
    expect(document.title).toBe('Daftar Anggota · ALTIS Admin');
    // The screen is drawn in the main region, which the skip link names.
    expect(document.getElementById('main')!.contains(heading)).toBe(true);
    expect(document.getElementById('main')!.tagName).toBe('MAIN');

    // A page under the same item keeps the item's name in the title.
    await router.navigate({ href: '/admin/anggota/baru' });
    const fresh = await screen.findByRole('heading', { level: 1, name: 'Anggota baru' });
    await waitFor(() => expect(document.activeElement).toBe(fresh));
    expect(document.title).toBe('Daftar Anggota · ALTIS Admin');

    // A screen that focuses a control of its own keeps it: the heading does not take it back.
    await router.navigate({ href: '/admin/anggota' });
    const list = await screen.findByRole('heading', { level: 1, name: 'Anggota' });
    await waitFor(() => expect(document.activeElement).toBe(list));
    const search = screen.getByRole('searchbox', { name: 'Cari' });
    search.focus();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(document.activeElement).toBe(search);
    expect(document.title).toBe('Daftar Anggota · ALTIS Admin');
  });

  it('the top bar says where the user is: the group, then the page; Beranda alone', async () => {
    const { router } = setup(signedIn(), '/admin/anggota/tipe');
    await screen.findByRole('navigation', { name: 'Lokasi halaman' });
    expect(crumbs()).toEqual(['Anggota', 'Tipe Anggota']);
    const items = within(screen.getByRole('navigation', { name: 'Lokasi halaman' })).getAllByRole('listitem');
    expect(items.map((li) => li.getAttribute('aria-current'))).toEqual([null, 'page']);
    // The separator is drawn, not read.
    expect(items[1]!.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
    await act(() => router.navigate({ to: '/admin' }));
    await waitFor(() => expect(crumbs()).toEqual(['Beranda']));
    // A page of a group without an item of its own: the group alone.
    await act(() => router.navigate({ href: '/admin/catalog/runs/01J0000000000000000000000A' }));
    await waitFor(() => expect(crumbs()).toEqual(['Katalog']));
  });

  it('the top bar holds the menu button, the command search with its shortcut, the date, the notifications and the user menu; signing out is in the user menu only', async () => {
    setup(signedIn());
    await screen.findByText('Selamat datang, Ani.');
    const bar = screen.getByRole('banner');
    expect(
      within(bar)
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label')),
    ).toEqual(['Buka menu', 'Cari perintah', 'Notifikasi', 'Akun Ani']);
    const search = within(bar).getByRole('button', { name: 'Cari perintah' });
    expect(search.querySelector('kbd')!.textContent).toMatch(/^(Ctrl K|⌘K)$/);
    expect(search.getAttribute('aria-keyshortcuts')).toBe('Control+K Meta+K');
    expect(bar.querySelector('time')!.getAttribute('datetime')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // The user's initials stand in a small circle beside the name; the name is what the button says.
    const user = within(bar).getByRole('button', { name: 'Akun Ani' });
    expect(user.textContent).toBe('AAni');
    expect(user.firstElementChild!.getAttribute('aria-hidden')).toBe('true');
    expect(within(bar).queryByRole('button', { name: 'Keluar' })).toBeNull();
    expect(within(mainNav()).queryByRole('button', { name: 'Keluar' })).toBeNull();
  });

  it("the user's own language wins over the library's", async () => {
    setup(signedIn({ locale: 'en' }));
    expect(await screen.findByText('Welcome, Ani.')).toBeTruthy();
    expect(document.documentElement.lang).toBe('en');
    expect(within(mainNav('Main navigation')).getByRole('link', { name: 'Home' })).toBeTruthy();
    expect(within(mainNav('Main navigation')).getByRole('button', { name: 'Site / OPAC' })).toBeTruthy();
    expect(crumbs('You are here')).toEqual(['Home']);
    expect(screen.getByRole('button', { name: 'Open menu' })).toBeTruthy();
  });
});

describe('user menu', () => {
  const openUserMenu = async (): Promise<HTMLElement> => {
    fireEvent.keyDown(await screen.findByRole('button', { name: 'Akun Ani' }), { key: 'Enter' });
    return screen.findByRole('menu');
  };

  afterEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });

  it('holds the profile, the theme (following the system at first), the language and signing out', async () => {
    setup(signedIn());
    await screen.findByText('Selamat datang, Ani.');
    const menu = await openUserMenu();
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Profil saya', 'Keluar']);
    expect(
      within(menu)
        .getAllByRole('menuitemradio')
        .map((i) => [i.textContent, i.getAttribute('aria-checked')]),
    ).toEqual([
      ['Terang', 'false'],
      ['Gelap', 'false'],
      ['Ikuti sistem', 'true'],
      ['Bahasa Indonesia', 'true'],
      ['English', 'false'],
    ]);
  });

  it('Gelap puts data-theme="dark" on the page and remembers it in this browser; Ikuti sistem forgets it', async () => {
    setup(signedIn());
    await screen.findByText('Selamat datang, Ani.');
    fireEvent.click(within(await openUserMenu()).getByRole('menuitemradio', { name: 'Gelap' }));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(localStorage.getItem('altis.admin.theme')).toBe('dark');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(within(await openUserMenu()).getByRole('menuitemradio', { name: 'Gelap' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitemradio', { name: 'Ikuti sistem' }));
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(localStorage.getItem('altis.admin.theme')).toBeNull();
  });

  it('Keluar signs out', async () => {
    const { router } = setup(signedIn());
    await screen.findByText('Selamat datang, Ani.');
    fireEvent.click(within(await openUserMenu()).getByRole('menuitem', { name: 'Keluar' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/login'));
    expect(calls()).toContainEqual(['POST', '/api/v1/auth/logout']);
  });
});

describe('banners', () => {
  it("shows auth/me's banners, and the version banner while a form is dirty", async () => {
    setup(signedIn({ banners: [{ kind: 'maintenance', severity: 'warning', messageKey: 'banner.maintenance' }] }));
    expect(await screen.findByText(MESSAGES.id['banner.maintenance'])).toBeTruthy();
    expect(screen.queryByText('ALTIS telah diperbarui — muat ulang')).toBeNull();
    const form = Symbol('form');
    dirtyForms.add(form);
    act(() => buildSync.observe('0.2.0'));
    expect(await screen.findByText('ALTIS telah diperbarui — muat ulang')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Muat ulang' })).toBeTruthy();
    dirtyForms.remove(form);
  });

  it('the maintenance banner links the operations page as a page load (a server page, not a route of the SPA)', async () => {
    const { router } = setup(
      signedIn({ banners: [{ kind: 'maintenance', severity: 'warning', messageKey: 'banner.maintenance', link: '/admin/_update' }] }),
    );
    expect(await screen.findByText(MESSAGES.id['banner.maintenance'])).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Lihat' });
    expect(link.getAttribute('href')).toBe('/admin/_update');
    // The router would take the click (preventDefault) and show its own not-found screen; the browser must load it.
    let routed: boolean | undefined;
    const observe = (event: MouseEvent): void => {
      routed = event.defaultPrevented;
      event.preventDefault(); // jsdom does not navigate
    };
    window.addEventListener('click', observe);
    onTestFinished(() => window.removeEventListener('click', observe));
    fireEvent.click(link);
    expect(routed).toBe(false);
    expect(router.state.location.pathname).toBe('/admin');
  });
});

describe('command palette', () => {
  it('the sections come under their nav groups in the order of the sidebar, Beranda under Navigasi', async () => {
    setup(signedIn({ permissions: ['catalog.records.read', 'opac.pages.manage', 'system.audit.read'] }));
    await screen.findByText('Selamat datang, Ani.');
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    const dialog = await screen.findByRole('dialog', { name: 'Palet perintah' });
    const options = (name: string) =>
      within(within(dialog).getByRole('group', { name }))
        .getAllByRole('option')
        .map((o) => o.textContent);
    expect(options('Navigasi')).toEqual(['Beranda']);
    expect(options('Katalog')).toEqual(['Bibliografi', 'Eksemplar', 'Otoritas', 'Lokasi & Rak', 'Data Induk', 'Impor/Ekspor', 'Cetak Label']);
    expect(options('Situs / OPAC')).toEqual(['Halaman awal', 'Identitas situs', 'Halaman & Berita']);
    expect(options('Sistem')).toEqual(['Log audit', 'Tentang']);
    expect(
      within(dialog)
        .getAllByRole('group')
        .map((g) => document.getElementById(g.getAttribute('aria-labelledby') ?? '')?.textContent)
        .slice(0, 4),
    ).toEqual(['Navigasi', 'Katalog', 'Situs / OPAC', 'Sistem']);
  });

  it('Ctrl+K opens it with the visible sections, the account and the languages; English sets the user language', async () => {
    setup(signedIn({ permissions: ['system.audit.read'] }));
    await screen.findByText('Selamat datang, Ani.');
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    const dialog = await screen.findByRole('dialog', { name: 'Palet perintah' });
    const options = within(dialog)
      .getAllByRole('option')
      .map((o) => o.textContent?.replace('dipakai', '').trim());
    expect(options).toEqual(['Beranda', 'Log audit', 'Tentang', 'Profil saya', 'Keluar', 'Bahasa Indonesia', 'English', 'Terang', 'Gelap', 'Ikuti sistem']);

    fireEvent.click(within(dialog).getByRole('option', { name: 'English' }));
    await waitFor(() => expect(calls()).toContainEqual(['PATCH', '/api/v1/auth/me']));
    const patch = fetchMock.mock.calls.find((c) => c[1]?.method === 'PATCH');
    expect(patch?.[1]?.body).toBe(JSON.stringify({ locale: 'en' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('the header button "Cari perintah" opens it too', async () => {
    setup(signedIn());
    await screen.findByText('Selamat datang, Ani.');
    fireEvent.click(screen.getByRole('button', { name: 'Cari perintah' }));
    expect(await screen.findByRole('dialog', { name: 'Palet perintah' })).toBeTruthy();
  });

  it('a language the server does not save falls back to the one auth/me answers with (no unhandled rejection)', async () => {
    setup(signedIn());
    await screen.findByText('Selamat datang, Ani.');
    const answer = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url, init) =>
      init?.method === 'PATCH'
        ? new Response(JSON.stringify({ type: 'about:blank', title: 'x', status: 404, code: 'NOT_FOUND' }), {
            status: 404,
            headers: { 'Content-Type': 'application/problem+json' },
          })
        : answer(url, init),
    );
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    const dialog = await screen.findByRole('dialog', { name: 'Palet perintah' });
    fireEvent.click(within(dialog).getByRole('option', { name: 'English' }));
    await waitFor(() => expect(calls().filter(([method, url]) => method === 'GET' && url === '/api/v1/auth/me').length).toBe(2));
    expect(await screen.findByText('Selamat datang, Ani.')).toBeTruthy();
    expect(document.documentElement.lang).toBe('id');
  });

  it('Keluar signs out and opens the sign-in page', async () => {
    const { router } = setup(signedIn());
    await screen.findByText('Selamat datang, Ani.');
    fireEvent.keyDown(document.body, { key: 'k', metaKey: true });
    const dialog = await screen.findByRole('dialog', { name: 'Palet perintah' });
    fireEvent.click(within(dialog).getByRole('option', { name: 'Keluar' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/login'));
    expect(calls()).toContainEqual(['POST', '/api/v1/auth/logout']);
    // Signing out is not a session that ended under the user's hands: no notice.
    await screen.findByRole('heading', { name: 'Masuk' });
    expect(router.state.location.search).toEqual({});
    expect(screen.queryByText('Sesi Anda telah berakhir. Silakan masuk lagi.')).toBeNull();
  });
});

describe('reauth dialog', () => {
  it('reauth.request() asks for the password, POSTs auth/reauth and resolves', async () => {
    setup(signedIn());
    await screen.findByText('Selamat datang, Ani.');
    let settled: 'resolved' | 'rejected' | undefined;
    act(() => {
      reauth.request().then(
        () => (settled = 'resolved'),
        () => (settled = 'rejected'),
      );
    });
    const dialog = await screen.findByRole('dialog', { name: 'Konfirmasi kata sandi' });
    expect(within(dialog).queryByLabelText('Kode autentikator')).toBeNull();
    fireEvent.change(within(dialog).getByLabelText('Kata sandi'), { target: { value: 'kata-sandi-ani' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Konfirmasi' }));
    await waitFor(() => expect(settled).toBe('resolved'));
    const post = fetchMock.mock.calls.find((c) => c[0] === '/api/v1/auth/reauth');
    expect(post?.[1]?.body).toBe(JSON.stringify({ password: 'kata-sandi-ani' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it("checks its fields itself, in the user's language (no browser tooltip): an empty password sends nothing", async () => {
    setup(signedIn());
    await screen.findByText('Selamat datang, Ani.');
    act(() => {
      reauth.request().catch(() => {});
    });
    const dialog = await screen.findByRole('dialog', { name: 'Konfirmasi kata sandi' });
    expect(dialog.querySelector('form')?.noValidate).toBe(true);
    const password = within(dialog).getByLabelText('Kata sandi');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Konfirmasi' }));
    await waitFor(() => expect(password.getAttribute('aria-invalid')).toBe('true'));
    const described = (password.getAttribute('aria-describedby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent);
    expect(described).toContain('Wajib diisi.');
    expect(document.activeElement).toBe(password);
    expect(calls().some(([, url]) => url === '/api/v1/auth/reauth')).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Batal' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('with 2FA, a code that is not six digits is refused on its field before anything is sent', async () => {
    const me = signedIn();
    setup({ ...me, user: { ...me.user, totpEnabled: true } });
    await screen.findByText('Selamat datang, Ani.');
    act(() => {
      reauth.request().catch(() => {});
    });
    const dialog = await screen.findByRole('dialog', { name: 'Konfirmasi kata sandi' });
    fireEvent.change(within(dialog).getByLabelText('Kata sandi'), { target: { value: 'kata-sandi-ani' } });
    const code = within(dialog).getByLabelText('Kode autentikator');
    fireEvent.change(code, { target: { value: '12345' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Konfirmasi' }));
    await waitFor(() => expect(code.getAttribute('aria-invalid')).toBe('true'));
    expect(within(dialog).getByText('Formatnya belum benar.')).toBeTruthy();
    expect(calls().some(([, url]) => url === '/api/v1/auth/reauth')).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Batal' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('Batal rejects, so the action is not repeated', async () => {
    setup(signedIn());
    await screen.findByText('Selamat datang, Ani.');
    let settled: 'resolved' | 'rejected' | undefined;
    act(() => {
      reauth.request().then(
        () => (settled = 'resolved'),
        () => (settled = 'rejected'),
      );
    });
    const dialog = await screen.findByRole('dialog', { name: 'Konfirmasi kata sandi' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Batal' }));
    await waitFor(() => expect(settled).toBe('rejected'));
    expect(calls().some(([, url]) => url === '/api/v1/auth/reauth')).toBe(false);
  });
});
