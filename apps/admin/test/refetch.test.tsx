import { DEFAULT_CARD_PROFILE } from '@altis/shared/api/member-ops';
import type { SettingsView } from '@altis/shared/api/settings';
import type { SystemConfigView } from '@altis/shared/api/system-config';
import type { QueryKey } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dirtyForms } from '@/lib/dirty-forms';
import { ME_KEY } from '@/lib/me';
import {
  BRANCH_MAIN,
  BRANCH_NORTH,
  ROLES,
  USERS,
  USER_BUDI,
  adminMe,
  permissionsAnswer,
  problem,
  startApp,
  superMe,
  type FakeHandler,
  type SignedIn,
} from './fake-api';
import { fakeServer, json, renderApp, signedIn as shellMe } from './fake-server';

// React Query v5 keeps a query's data when a background refetch fails (status 'error', `isRefetchError`). An edit
// screen that checked `isError` before its data replaced a loaded, possibly dirty form with an error notice, and the
// typed values were gone (the dirty guard with them, so the next newer build reloaded the page). The data wins: the
// form stays, and a notice above it says the latest data could not be loaded, with "Coba lagi".

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const REFETCH_FAILED = 'Data terbaru gagal dimuat; yang tampil masih data yang dimuat sebelumnya.';

const SETTINGS: SettingsView = {
  library: { name: 'Perpustakaan Arsya', type: 'sekolah', address: null, timezone: 'Asia/Jakarta', locale: 'id' },
  email: { senderName: 'Pustaka Arsya', templates: { passwordReset: { id: { subject: null, body: null }, en: { subject: null, body: null } } } },
  security: { passwordMinLength: 10, sessionIdleMinutes: 30 },
  opac: {
    welcome: { id: 'Halo, pengunjung.', en: null },
    accent: 'teal',
    // Phase 2 (Task 2): the six new OPAC keys.
    resultsPerPage: 20,
    indexable: true,
    oai: { enabled: true, adminEmail: '' },
    showShelfMap: true,
    newTitlesCount: 12,
  },
  // Phase 2 (Task 2): the catalog group.
  catalog: {
    marcOrgCode: null,
    defaultMaterialTypeId: null,
    defaultCollectionTypeId: null,
    currency: 'IDR',
    barcode: { patterns: [{ id: 'default', name: 'Bawaan', prefix: 'B', digits: 7, suffix: '' }], symbology: 'code128' },
    labelProfiles: [],
    sru: { servers: [], allowPrivateHosts: false },
    isbn: { arsyaEnabled: false },
    attachment: { maxMb: 200 },
    dedupe: { threshold: 80 },
  },
  // Reports and accreditation: the accreditation group (its screen has its own tests).
  accreditation: {
    schoolYearStartMonth: 7,
    fiction: { collectionTypeCodes: ['FIKSI'], callNumberPrefixes: [], ddcPrefixes: [] },
    referenceCollectionTypeCodes: ['REF'],
    electronicMaterialTypeCodes: ['EBOOK'],
    usedUnit: 'titles',
    websiteFeatures: {},
    liveFrom: null,
    evidence: { maxMb: 5, componentLimitMb: 9 },
    textbookCollectionTypeCodes: [],
    k7: { processedThresholdPct: 100 },
    undatedShareMaxPct: 10,
    visits: { dedupeLegacy: true },
    unknownMemberGroup: { default: 'auto' },
  },
  // ---- Komunitas (circulation core) ----
  circulation: {
      holds: { enabled: true, opac: true, onlyWhenNoneAvailable: true, pickupDays: 3 },
      renew: { opac: true },
      loanVoidMinutes: 10,
      lost: { useItemPrice: true, processingFeeMinor: 0 },
    },
  // ---- Komunitas K2: members (clearance and card), visits and privacy (their screens have their own tests) ----
  members: {
    password: { minLength: 8 },
    opac: { enabled: true },
    session: { idleMinutes: 20, absoluteHours: 8 },
    clearance: { prefix: 'BP', profile: { paper: 'A4', city: '', signerTitle: 'Kepala Perpustakaan', signerName: '', signerId: '', bodyText: '' } },
    card: { profile: DEFAULT_CARD_PROFILE },
  },
  visits: { dedupeMinutes: 60, fromDesk: true, fromOnline: true, askPurpose: false, station: { showPhoto: false, welcome: { id: null, en: null } } },
  privacy: { loans: { anonymizeAfterYears: 5 }, visits: { anonymizeAfterYears: 2 }, members: { anonymizeArchivedAfterYears: null } },
};

const SYSTEM: SystemConfigView = {
  baseUrl: 'https://perpus.example',
  trustProxy: { hops: 1 },
  allowedOrigins: [],
  smtp: { host: 'smtp.perpus.example', port: 587, security: 'starttls', username: 'mailer', password: { isSet: true }, from: 'perpustakaan@perpus.example' },
  cronToken: { isSet: true },
  locked: {},
};

interface Case {
  name: string;
  me: SignedIn;
  path: string;
  /** The routes; every GET answers 503 DB_UNAVAILABLE while `down` is set. */
  routes: Record<string, FakeHandler>;
  /** The field typed into. */
  label: string;
  typed: string;
  /** The query whose refetch fails. */
  key: QueryKey;
}

const CASES: Case[] = [
  {
    name: 'Pengaturan → Profil perpustakaan',
    me: adminMe(),
    path: '/admin/settings',
    routes: { 'GET settings/:group': (req) => structuredClone(SETTINGS[req.params['group'] as keyof SettingsView]) },
    label: 'Nama perpustakaan',
    typed: 'Perpustakaan SMA Arsya',
    key: ['settings', 'library'],
  },
  {
    name: 'Pengaturan → E-mail',
    me: adminMe(),
    path: '/admin/settings/email',
    routes: { 'GET settings/:group': (req) => structuredClone(SETTINGS[req.params['group'] as keyof SettingsView]) },
    label: 'Nama pengirim',
    typed: 'Perpustakaan Kota',
    key: ['settings', 'email'],
  },
  {
    name: 'Pengaturan → Keamanan',
    me: adminMe(),
    path: '/admin/settings/security',
    routes: { 'GET settings/:group': (req) => structuredClone(SETTINGS[req.params['group'] as keyof SettingsView]), 'GET roles': () => ({ items: ROLES }) },
    label: 'Panjang minimum kata sandi',
    typed: '14',
    key: ['settings', 'security'],
  },
  {
    name: 'Pengaturan → Tampilan OPAC',
    me: adminMe(),
    path: '/admin/settings/opac',
    routes: { 'GET settings/:group': (req) => structuredClone(SETTINGS[req.params['group'] as keyof SettingsView]) },
    label: 'Teks sambutan (Bahasa Indonesia)',
    typed: 'Selamat datang di perpustakaan kami.',
    key: ['settings', 'opac'],
  },
  {
    name: 'Konfigurasi Sistem',
    me: superMe(),
    path: '/admin/system',
    routes: { 'GET system/config': () => structuredClone(SYSTEM) },
    label: 'Alamat pengirim',
    typed: 'pustaka@perpus.example',
    key: ['system', 'config'],
  },
  {
    name: 'Ubah pengguna',
    me: adminMe(),
    path: `/admin/users/${USER_BUDI.id}`,
    routes: {
      'GET users/:id': (req) => USERS.find((u) => u.id === req.params['id']) ?? problem(404, 'NOT_FOUND'),
      'GET roles': () => ({ items: ROLES }),
      'GET branches': () => ({ items: [BRANCH_MAIN, BRANCH_NORTH] }),
      'GET permissions': () => permissionsAnswer(),
    },
    label: 'Nama lengkap',
    typed: 'Budi S.',
    key: ['users', 'detail', USER_BUDI.id],
  },
  {
    name: 'Ubah peran',
    me: adminMe(),
    path: '/admin/roles/R1PUST',
    routes: {
      'GET roles/:id': (req) => ROLES.find((r) => r.id === req.params['id']) ?? problem(404, 'NOT_FOUND'),
      'GET permissions': () => permissionsAnswer(),
    },
    label: 'Nama peran',
    typed: 'Pustakawan Senior',
    key: ['roles', 'detail', 'R1PUST'],
  },
  {
    name: 'Ubah cabang',
    me: adminMe(),
    path: '/admin/branches/B2',
    routes: { 'GET branches': () => ({ items: [BRANCH_MAIN, BRANCH_NORTH] }) },
    label: 'Nama cabang',
    typed: 'Cabang Utara Baru',
    key: ['branches', { includeArchived: true }],
  },
];

/** `routes` with every GET answering 503 DB_UNAVAILABLE while `down.value` is set. */
function flaky(routes: Record<string, FakeHandler>, down: { value: boolean }): Record<string, FakeHandler> {
  return Object.fromEntries(
    Object.entries(routes).map(([route, handler]) => [route, (req) => (down.value && req.method === 'GET' ? problem(503, 'DB_UNAVAILABLE') : handler(req))]),
  );
}

describe('a failed background refetch keeps a loaded edit form', () => {
  for (const c of CASES) {
    it(`${c.name}: the typed value, the form and its dirty guard stay; a notice offers "Coba lagi"`, async () => {
      const down = { value: false };
      const { queryClient } = startApp({ me: c.me, path: c.path, routes: flaky(c.routes, down) });
      const field = (await screen.findByLabelText(c.label)) as HTMLInputElement;
      await waitFor(() => expect(field.value).not.toBe(''));
      fireEvent.change(field, { target: { value: c.typed } });
      await waitFor(() => expect(dirtyForms.count()).toBe(1));

      down.value = true;
      await act(() => queryClient.refetchQueries({ queryKey: c.key }));
      expect(await screen.findByText(REFETCH_FAILED)).toBeTruthy();
      expect(screen.getByText('Database tidak dapat dijangkau saat ini. Silakan coba lagi sebentar lagi.')).toBeTruthy();
      expect((screen.getByLabelText(c.label) as HTMLInputElement).value).toBe(c.typed);
      expect(dirtyForms.count()).toBe(1);

      // The server is back: "Coba lagi" reads it again, the notice goes, and what was typed is still there.
      down.value = false;
      fireEvent.click(screen.getByRole('button', { name: 'Coba lagi' }));
      await waitFor(() => expect(screen.queryByText(REFETCH_FAILED)).toBeNull());
      expect((screen.getByLabelText(c.label) as HTMLInputElement).value).toBe(c.typed);
      expect(dirtyForms.count()).toBe(1);
    });
  }

  it('a read that fails before any data came still shows its problem in place of the form', async () => {
    startApp({ me: adminMe(), path: `/admin/users/${USER_BUDI.id}`, routes: { 'GET users/:id': () => problem(503, 'DB_UNAVAILABLE') } });
    expect(await screen.findByText('Database tidak dapat dijangkau saat ini. Silakan coba lagi sebentar lagi.')).toBeTruthy();
    expect(screen.queryByLabelText('Nama lengkap')).toBeNull();
    expect(screen.queryByText(REFETCH_FAILED)).toBeNull();
  });

  it('Profil saya: a failed refetch of auth/me keeps the name form and what was typed', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    const server = fakeServer(fetchMock, () => shellMe());
    const { queryClient } = renderApp('/admin/profile');
    const name = (await screen.findByLabelText('Nama')) as HTMLInputElement;
    await waitFor(() => expect(name.value).toBe('Ani'));
    fireEvent.change(name, { target: { value: 'Ani Lestari' } });
    await waitFor(() => expect(dirtyForms.count()).toBe(1));
    server.on('GET auth/me', () => json({ type: 'about:blank', title: 'x', status: 503, code: 'DB_UNAVAILABLE' }, 503));
    await act(() => queryClient.refetchQueries({ queryKey: ME_KEY }));
    expect((screen.getByLabelText('Nama') as HTMLInputElement).value).toBe('Ani Lestari');
    expect(dirtyForms.count()).toBe(1);
  });
});
