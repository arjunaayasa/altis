import type { RoleItem } from '@altis/shared/api/roles';
import type { CatalogSettings, EmailSettings, LibrarySettings, OpacSettings, SecuritySettings, SettingsView } from '@altis/shared/api/settings';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ROLES, ROLE_ADMIN, ROLE_LIBRARIAN, adminMe, problem, signedIn, startApp, superMe, type FakeHandler, type FakeRequest } from './fake-api';

// Spec §13.3 "Pengaturan" (Task 30): one form per group (library, email, security, opac), each saved with its own
// `PUT settings/<group>`, which answers the changed keys only, so the screen reads the group again. Security also
// lists the roles with their 2FA switch (`PATCH roles/:id` with the role's version). The server is faked.

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const LIBRARY: LibrarySettings = { name: 'Perpustakaan Arsya', type: 'sekolah', address: null, timezone: 'Asia/Jakarta', locale: 'id' };
const EMAIL: EmailSettings = {
  senderName: 'Pustaka Arsya',
  templates: { passwordReset: { id: { subject: null, body: null }, en: { subject: null, body: null } } },
};
const SECURITY: SecuritySettings = { passwordMinLength: 10, sessionIdleMinutes: 30 };
const OPAC: OpacSettings = {
  welcome: { id: null, en: null },
  accent: 'teal',
  // Phase 2 (Task 2): the six new keys (the OPAC form gains them in Task 28).
  resultsPerPage: 20,
  indexable: true,
  oai: { enabled: true, adminEmail: '' },
  showShelfMap: true,
  newTitlesCount: 12,
};
/** Phase 2 (Task 2): the catalog group (its screen is Task 28's). */
const CATALOG: CatalogSettings = {
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
};

/** `patch` written into `target`, nested objects merged (a key left out keeps its value, as the server does). */
function merge(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    const at = target[key];
    if (value !== null && typeof value === 'object' && at !== null && typeof at === 'object') {
      merge(at as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      target[key] = value;
    }
  }
}

/** A fake settings store: GET answers the stored group, PUT records the body and answers `{changed}`. */
function settingsStore() {
  const groups: SettingsView = {
    library: { ...LIBRARY },
    email: structuredClone(EMAIL),
    security: { ...SECURITY },
    opac: structuredClone(OPAC),
    catalog: structuredClone(CATALOG),
  };
  const puts: { group: string; body: unknown }[] = [];
  const routes: Record<string, FakeHandler> = {
    'GET settings/:group': (req) => structuredClone(groups[req.params['group'] as keyof SettingsView]),
    'PUT settings/:group': (req) => {
      const group = req.params['group'] as keyof SettingsView;
      puts.push({ group, body: req.body });
      merge(groups[group] as unknown as Record<string, unknown>, req.body as Record<string, unknown>);
      return { changed: Object.keys(req.body as object).map((k) => `${group}.${k}`) };
    },
  };
  return { groups, puts, routes };
}

const getsOf = (requests: FakeRequest[], path: string): number => requests.filter((r) => r.method === 'GET' && r.path === path).length;

describe('settings: library', () => {
  it('sends only what changed with PUT settings/library, then reads the group again', async () => {
    const store = settingsStore();
    const { requests } = startApp({ me: adminMe(), path: '/admin/settings', routes: store.routes });
    const name = (await screen.findByLabelText('Nama perpustakaan')) as HTMLInputElement;
    await waitFor(() => expect(name.value).toBe('Perpustakaan Arsya'));
    expect(getsOf(requests, 'settings/library')).toBe(1);
    fireEvent.change(name, { target: { value: 'Perpustakaan SMA Arsya' } });
    fireEvent.change(screen.getByLabelText('Alamat'), { target: { value: 'Jl. Merdeka 1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(store.puts).toEqual([{ group: 'library', body: { name: 'Perpustakaan SMA Arsya', address: 'Jl. Merdeka 1' } }]));
    expect(await screen.findByText('Perubahan disimpan.')).toBeTruthy();
    expect(getsOf(requests, 'settings/library')).toBe(2);
    expect(name.value).toBe('Perpustakaan SMA Arsya');
  });

  it('an empty name is refused before anything is sent', async () => {
    const store = settingsStore();
    const { writes } = startApp({ me: adminMe(), path: '/admin/settings', routes: store.routes });
    const name = (await screen.findByLabelText('Nama perpustakaan')) as HTMLInputElement;
    await waitFor(() => expect(name.value).toBe('Perpustakaan Arsya'));
    fireEvent.change(name, { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(name.getAttribute('aria-invalid')).toBe('true'));
    expect(writes()).toEqual([]);
  });

  it('with system.settings.read only, the form is read-only and has no save button', async () => {
    const store = settingsStore();
    startApp({ me: signedIn({ permissions: ['system.settings.read'] }), path: '/admin/settings', routes: store.routes });
    const name = (await screen.findByLabelText('Nama perpustakaan')) as HTMLInputElement;
    await waitFor(() => expect(name.value).toBe('Perpustakaan Arsya'));
    expect(name.disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Simpan' })).toBeNull();
  });
});

describe('settings: email', () => {
  it('a template typed in is sent at its path; a cleared sender name is sent as null', async () => {
    const store = settingsStore();
    startApp({ me: adminMe(), path: '/admin/settings/email', routes: store.routes });
    const sender = (await screen.findByLabelText('Nama pengirim')) as HTMLInputElement;
    await waitFor(() => expect(sender.value).toBe('Pustaka Arsya'));
    fireEvent.change(sender, { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Subjek (Bahasa Indonesia)'), { target: { value: 'Kata sandi baru untuk {name}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(store.puts).toHaveLength(1));
    expect(store.puts[0]).toEqual({
      group: 'email',
      body: { senderName: null, templates: { passwordReset: { id: { subject: 'Kata sandi baru untuk {name}' } } } },
    });
  });

  const MISSING_LINK = 'Isi e-mail ini harus memuat penanda {link}: di situlah tautan untuk membuat kata sandi baru dimasukkan.';

  /** The message the field `label` shows (through its aria-describedby). */
  const messagesOf = (label: string): (string | null | undefined)[] => {
    const field = screen.getByLabelText(label);
    return (field.getAttribute('aria-describedby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent);
  };

  it('a reset mail body without {link} is refused on its field before anything is sent', async () => {
    const store = settingsStore();
    startApp({ me: adminMe(), path: '/admin/settings/email', routes: store.routes });
    await waitFor(() => expect((screen.getByLabelText('Nama pengirim') as HTMLInputElement).value).toBe('Pustaka Arsya'));
    fireEvent.change(screen.getByLabelText('Isi (Bahasa Indonesia)'), { target: { value: 'Klik tautan berikut: {tautan}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(screen.getByLabelText('Isi (Bahasa Indonesia)').getAttribute('aria-invalid')).toBe('true'));
    expect(messagesOf('Isi (Bahasa Indonesia)')).toContain(MISSING_LINK);
    expect(store.puts).toEqual([]);
  });

  it("the server's 422 missing_link shows on the body field it names", async () => {
    const store = settingsStore();
    startApp({
      me: adminMe(),
      path: '/admin/settings/email',
      routes: {
        ...store.routes,
        'PUT settings/:group': () => problem(422, 'VALIDATION_FAILED', { errors: [{ path: 'templates.passwordReset.en.body', code: 'missing_link' }] }),
      },
    });
    await waitFor(() => expect((screen.getByLabelText('Nama pengirim') as HTMLInputElement).value).toBe('Pustaka Arsya'));
    fireEvent.change(screen.getByLabelText('Isi (English)'), { target: { value: 'Open {link} to set a new password.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(screen.getByLabelText('Isi (English)').getAttribute('aria-invalid')).toBe('true'));
    expect(messagesOf('Isi (English)')).toContain(MISSING_LINK);
  });
});

describe('settings: security', () => {
  it('saves the password policy with PUT settings/security', async () => {
    const store = settingsStore();
    startApp({ me: adminMe(), path: '/admin/settings/security', routes: { ...store.routes, 'GET roles': () => ({ items: ROLES }) } });
    const min = (await screen.findByLabelText('Panjang minimum kata sandi')) as HTMLInputElement;
    await waitFor(() => expect(min.value).toBe('10'));
    fireEvent.change(min, { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(store.puts).toEqual([{ group: 'security', body: { passwordMinLength: 12 } }]));
  });

  it('a value out of range is refused before anything is sent', async () => {
    const store = settingsStore();
    const { writes } = startApp({ me: adminMe(), path: '/admin/settings/security', routes: { ...store.routes, 'GET roles': () => ({ items: ROLES }) } });
    const min = (await screen.findByLabelText('Panjang minimum kata sandi')) as HTMLInputElement;
    await waitFor(() => expect(min.value).toBe('10'));
    fireEvent.change(min, { target: { value: '8' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(min.getAttribute('aria-invalid')).toBe('true'));
    expect(writes()).toEqual([]);
  });

  it('the 2FA switch of a role calls PATCH roles/:id with the role version', async () => {
    const store = settingsStore();
    const patched: unknown[] = [];
    startApp({
      me: superMe(),
      path: '/admin/settings/security',
      routes: {
        ...store.routes,
        'GET roles': () => ({ items: ROLES }),
        'PATCH roles/:id': (req): RoleItem => {
          patched.push({ id: req.params['id'], body: req.body });
          return { ...ROLE_LIBRARIAN, mfaRequired: true, version: ROLE_LIBRARIAN.version + 1 };
        },
      },
    });
    const sw = (await screen.findByRole('switch', { name: 'Pustakawan' })) as HTMLInputElement;
    expect(sw.checked).toBe(false);
    fireEvent.click(sw);
    await waitFor(() => expect(patched).toEqual([{ id: ROLE_LIBRARIAN.id, body: { version: 4, mfaRequired: true } }]));
    await waitFor(() => expect(sw.checked).toBe(true));
  });

  it('an admin cannot switch a role holding what only a super admin grants', async () => {
    const store = settingsStore();
    startApp({ me: adminMe(), path: '/admin/settings/security', routes: { ...store.routes, 'GET roles': () => ({ items: ROLES }) } });
    const own = (await screen.findByRole('switch', { name: 'Pustakawan' })) as HTMLInputElement;
    expect(own.disabled).toBe(false);
    expect((screen.getByRole('switch', { name: ROLE_ADMIN.name }) as HTMLInputElement).disabled).toBe(true);
  });

  it('without system.roles.manage the roles show their 2FA status, with no switch', async () => {
    const store = settingsStore();
    startApp({
      me: signedIn({ permissions: ['system.settings.read', 'system.settings.manage', 'system.users.read'] }),
      path: '/admin/settings/security',
      routes: { ...store.routes, 'GET roles': () => ({ items: ROLES }) },
    });
    await screen.findByText('Pustakawan');
    expect(screen.queryByRole('switch')).toBeNull();
  });
});

describe('settings: OPAC', () => {
  it('the accent is saved with PUT settings/opac', async () => {
    const store = settingsStore();
    startApp({ me: adminMe(), path: '/admin/settings/opac', routes: store.routes });
    const accent = (await screen.findByLabelText('Warna aksen')) as HTMLSelectElement;
    await waitFor(() => expect(accent.value).toBe('teal'));
    fireEvent.change(accent, { target: { value: 'blue' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(store.puts).toEqual([{ group: 'opac', body: { accent: 'blue' } }]));
  });
});
