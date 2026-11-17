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

/** The module bar under the top bar. */
const mainNav = (name = 'Navigasi utama'): HTMLElement => screen.getByRole('navigation', { name });

/** The sidebar: the pages of the active module (`Menu <module>`). */
const sidebar = (module: string, name = `Menu ${module}`): HTMLElement => screen.getByRole('navigation', { name });

const linksOf = (el: HTMLElement): [string | null, string | null][] =>
  within(el)
    .getAllByRole('link')
    .map((a) => [a.textContent, a.getAttribute('href')]);

/** The module the shell marks as the one the page is in. */
const currentModule = (): (string | null)[] =>
  within(mainNav())
    .getAllByRole('link')
    .filter((a) => a.getAttribute('aria-current') === 'true')
    .map((a) => a.textContent);

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
    expect(within(mainNav()).getByRole('link', { name: 'Sistem' })).toBeTruthy();
    // A path no route serves belongs to no module: Beranda's sidebar.
    expect(currentModule()).toEqual(['Beranda']);
    expect(within(sidebar('Beranda')).getByRole('link', { name: 'Ringkasan' })).toBeTruthy();
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
    expect(within(mainNav()).getByRole('link', { name: 'Sistem' })).toBeTruthy();

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
  /** Each module of an admin with the pages its sidebar lists, opened through the module bar. */
  const ADMIN_MODULES: [string, string, [string, string][]][] = [
    ['Beranda', '/admin', [['Ringkasan', '/admin']]],
    [
      'Katalog',
      '/admin/catalog/records',
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
      'Layanan',
      '/admin/layanan',
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
      '/admin/anggota',
      [
        ['Daftar Anggota', '/admin/anggota'],
        ['Tipe Anggota', '/admin/anggota/tipe'],
        ['Impor Anggota', '/admin/anggota/impor'],
        ['Surat Bebas Pustaka', '/admin/anggota/bebas-pustaka'],
        ['Cetak Kartu', '/admin/anggota/kartu'],
      ],
    ],
    [
      'Laporan',
      '/admin/reports',
      [
        ['Laporan', '/admin/reports'],
        ['Akreditasi', '/admin/accreditation'],
      ],
    ],
    [
      'OPAC',
      '/admin/opac/pages',
      [
        ['Halaman & Berita', '/admin/opac/pages'],
        ['Halaman awal', '/admin/opac/beranda'],
        // Not a page of the admin: the public site.
        ['Situs publik', '/'],
      ],
    ],
    [
      'Sistem',
      '/admin/users',
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

  it('an admin sees every module; the sidebar lists the pages of the module only, every page but Konfigurasi Sistem', async () => {
    const { router } = setup(signedIn());
    await screen.findByText('Selamat datang, Ani.');
    // Each module opens its first page.
    expect(linksOf(mainNav())).toEqual(ADMIN_MODULES.map(([name, first]) => [name, first]));
    for (const [name, first, pages] of ADMIN_MODULES) {
      fireEvent.click(within(mainNav()).getByRole('link', { name }));
      await waitFor(() => expect(router.state.location.pathname).toBe(first));
      expect(currentModule()).toEqual([name]);
      expect(linksOf(sidebar(name))).toEqual(name === 'Beranda' ? [...pages, ...BERANDA_SHORTCUTS] : pages);
    }
    expect(screen.queryByRole('link', { name: 'Konfigurasi Sistem' })).toBeNull();
  });

  it('a change of screen moves the focus to its heading and names the page in the tab title; the first screen keeps it', async () => {
    document.title = 'ALTIS Admin';
    const { router } = setup(signedIn());
    await screen.findByText('Selamat datang, Ani.');
    expect(document.activeElement).toBe(document.body);
    expect(document.title).toBe('Beranda · ALTIS Admin');
    const link = within(sidebar('Beranda')).getByRole('link', { name: 'Tambah anggota' });
    link.focus();
    fireEvent.click(link);
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/anggota/baru'));
    const heading = await screen.findByRole('heading', { level: 1, name: 'Anggota baru' });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(heading.getAttribute('tabindex')).toBe('-1');
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

  /** "Pintasan" of an admin: the desk, quick return, a new member, the member import. */
  const BERANDA_SHORTCUTS: [string, string][] = [
    ['Meja Layanan', '/admin/layanan'],
    ['Kembali Cepat', '/admin/layanan/kembali'],
    ['Tambah anggota', '/admin/anggota/baru'],
    ['Impor Anggota', '/admin/anggota/impor'],
  ];

  it('Beranda lists its overview, then the shortcuts the user may open under "Pintasan"', async () => {
    setup(signedIn());
    await screen.findByText('Selamat datang, Ani.');
    expect(within(sidebar('Beranda')).getByRole('list', { name: 'Pintasan' })).toBeTruthy();
    expect(linksOf(within(sidebar('Beranda')).getByRole('list', { name: 'Pintasan' }))).toEqual(BERANDA_SHORTCUTS);
  });

  it('the active module follows the route, deep links and detail pages included; one page is marked', async () => {
    const marked = async (path: string): Promise<[(string | null)[], (string | null)[]]> => {
      const { view } = setup(signedIn({ permissions: systemRolePermissions('super_admin'), superAdmin: true }), path);
      await waitFor(() => expect(currentModule()).toHaveLength(1));
      const module = currentModule()[0]!;
      const pages = within(sidebar(module!))
        .getAllByRole('link')
        .filter((a) => a.getAttribute('aria-current') === 'page')
        .map((a) => a.textContent);
      view.unmount();
      return [[module], pages];
    };
    expect(await marked('/admin/layanan/kembali')).toEqual([['Layanan'], ['Kembali Cepat']]);
    expect(await marked('/admin/layanan?member=01J0000000000000000000000A')).toEqual([['Layanan'], ['Meja Layanan']]);
    expect(await marked('/admin/anggota/tipe')).toEqual([['Anggota'], ['Tipe Anggota']]);
    expect(await marked('/admin/anggota/01J0000000000000000000000A')).toEqual([['Anggota'], ['Daftar Anggota']]);
    expect(await marked('/admin/settings/catalog')).toEqual([['Sistem'], ['Pengaturan']]);
    expect(await marked('/admin/accreditation/01J0000000000000000000000A')).toEqual([['Laporan'], ['Akreditasi']]);
    // A page of its own path under no menu item still opens its module.
    expect(await marked('/admin/catalog/runs/01J0000000000000000000000A')).toEqual([['Katalog'], []]);
    expect(await marked('/admin/profile')).toEqual([['Beranda'], []]);
    expect(await marked('/admin')).toEqual([['Beranda'], ['Ringkasan']]);
  });

  it('the top bar says where the user is: the module, then the page', async () => {
    setup(signedIn(), '/admin/anggota/tipe');
    const crumbs = await screen.findByRole('navigation', { name: 'Lokasi halaman' });
    expect(within(crumbs).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Anggota', '›Tipe Anggota']);
    expect(within(crumbs).getAllByRole('listitem')[1]!.getAttribute('aria-current')).toBe('page');
  });

  it('a super admin sees Konfigurasi Sistem under Sistem', async () => {
    setup(signedIn({ permissions: systemRolePermissions('super_admin'), superAdmin: true }), '/admin/system');
    expect(await within(await screen.findByRole('navigation', { name: 'Menu Sistem' })).findByRole('link', { name: 'Konfigurasi Sistem' })).toBeTruthy();
  });

  it('Phase 2: a catalogue reader sees Beranda, Katalog with its seven pages and Sistem with Tentang only', async () => {
    const { router } = setup(signedIn({ permissions: ['catalog.records.read'] }));
    await screen.findByText('Selamat datang, Ani.');
    expect(within(mainNav()).getAllByRole('link').map((a) => a.textContent)).toEqual(['Beranda', 'Katalog', 'Sistem']);
    // No shortcut: none of their pages is open to a catalogue reader.
    expect(within(sidebar('Beranda')).queryByRole('list', { name: 'Pintasan' })).toBeNull();
    fireEvent.click(within(mainNav()).getByRole('link', { name: 'Katalog' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/catalog/records'));
    expect(within(sidebar('Katalog')).getAllByRole('link')).toHaveLength(7);
    fireEvent.click(within(mainNav()).getByRole('link', { name: 'Sistem' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/about'));
    expect(linksOf(sidebar('Sistem'))).toEqual([['Tentang', '/admin/about']]);
  });

  it('a user holding the desk at one branch only: Beranda, Layanan (the desk pages), Sistem (Tentang), the desk shortcuts', async () => {
    const deskOnly: SignedIn = { ...signedIn({ permissions: [] }), branchPermissions: { b1: ['circulation.desk.use'] } };
    const { router } = setup(deskOnly);
    await screen.findByText('Selamat datang, Ani.');
    expect(within(mainNav()).getAllByRole('link').map((a) => a.textContent)).toEqual(['Beranda', 'Layanan', 'Sistem']);
    expect(linksOf(within(sidebar('Beranda')).getByRole('list', { name: 'Pintasan' }))).toEqual(BERANDA_SHORTCUTS.slice(0, 2));
    fireEvent.click(within(mainNav()).getByRole('link', { name: 'Layanan' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/layanan'));
    expect(within(sidebar('Layanan')).getAllByRole('link').map((a) => a.textContent)).toEqual([
      'Meja Layanan',
      'Kembali Cepat',
      'Rak Tunggu & Reservasi',
      'Baca di Tempat',
    ]);
  });

  it('"Menu" opens the sidebar as a drawer on a narrow screen; Escape closes it and gives the focus back', async () => {
    setup(signedIn(), '/admin/anggota');
    const menu = await screen.findByRole('button', { name: 'Menu' });
    expect(menu.getAttribute('aria-controls')).toBe('altis-sidebar');
    expect(menu.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(menu);
    expect(menu.getAttribute('aria-expanded')).toBe('true');
    // The focus goes to the marked page.
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Daftar Anggota'));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(menu.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(menu);
  });

  it("the user's own language wins over the library's", async () => {
    setup(signedIn({ locale: 'en' }));
    expect(await screen.findByText('Welcome, Ani.')).toBeTruthy();
    expect(document.documentElement.lang).toBe('en');
    expect(within(mainNav('Main navigation')).getByRole('link', { name: 'Home' })).toBeTruthy();
    expect(within(sidebar('Home', 'Home menu')).getByRole('link', { name: 'Overview' })).toBeTruthy();
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
  it('Phase 2: the sections come under their nav groups, Beranda under Navigasi', async () => {
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
    expect(options('OPAC')).toEqual(['Halaman & Berita', 'Halaman awal']);
    expect(options('Sistem')).toEqual(['Log audit', 'Tentang']);
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
