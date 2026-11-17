import type { BranchView } from '@altis/shared/api/branches';
import type { MemberTypeView, MemberView } from '@altis/shared/api/members';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { adminMe, problem, startApp } from '../fake-api';

// Anggota baru: the form is checked with the shared contract first, sends only what was filled (no gender unless
// chosen, no dates unless typed: the server counts them from today and the type), shows the server's field errors on
// their fields (a taken member number), and opens the new member's page after the save. The member's page sends only
// the fields the user changed, also after the member was read again at a new version (an extension, "Muat ulang data").

beforeAll(async () => {
  await Promise.all([import('@/screens/members/edit')]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const TYPE_ID = '01JZ0000000000000000000T01';
const NEW_ID = '01JZ0000000000000000000N01';

const SISWA: MemberTypeView = {
  id: TYPE_ID,
  code: 'SISWA',
  nameId: 'Siswa',
  nameEn: 'Student',
  accredGroup: 'student',
  membershipDays: 365,
  loanLimit: 3,
  holdsAllowed: true,
  holdsLimit: 2,
  onlineRenewal: true,
  sortOrder: 0,
  memberCount: 12,
  archived: false,
  version: 1,
};

const BRANCH: BranchView = {
  id: 'B1',
  code: 'PUSAT',
  name: 'Perpustakaan Pusat',
  address: null,
  timezone: 'Asia/Jakarta',
  isDefault: true,
  archivedAt: null,
  version: 1,
  active: true,
};

const CREATED: MemberView = {
  id: NEW_ID,
  memberNo: 'B 001',
  type: { id: TYPE_ID, code: 'SISWA', nameId: 'Siswa', nameEn: 'Student', loanLimit: 3 },
  homeBranchId: null,
  storedStatus: 'active',
  status: 'active',
  statusNote: null,
  name: 'Siti Aminah',
  gender: null,
  birthDate: null,
  identityNo: null,
  institution: null,
  className: '8B',
  email: null,
  phone: null,
  address: null,
  postalCode: null,
  mailingAddress: null,
  notes: null,
  photoFileId: null,
  locale: 'id',
  joinedOn: '2026-11-15',
  validFrom: '2026-11-15',
  expiresOn: '2027-11-15',
  openLoans: 0,
  source: 'manual',
  archived: false,
  createdAt: 1_763_164_800_000,
  updatedAt: 1_763_164_800_000,
  version: 1,
};

describe('Anggota baru', () => {
  it('shows a taken number on its field, then saves only what was filled and opens the member', async () => {
    let attempts = 0;
    const app = startApp({
      me: adminMe(),
      path: '/admin/anggota/baru',
      routes: {
        'GET members/types': () => ({ items: [SISWA] }),
        'GET branches': () => ({ items: [BRANCH] }),
        'POST members': () => {
          attempts += 1;
          if (attempts === 1) return problem(422, 'VALIDATION_FAILED', { errors: [{ path: 'memberNo', code: 'taken' }] });
          return new Response(JSON.stringify({ id: NEW_ID, version: 1 }), { status: 201, headers: { 'Content-Type': 'application/json', 'X-Altis-Build': '0.1.0' } });
        },
        'GET members/:id': () => CREATED,
        'GET members/:id/events': () => ({ items: [], nextCursor: null }),
      },
    });

    expect(await screen.findByRole('heading', { name: 'Anggota baru' })).toBeTruthy();
    // The contract's own checks first: nothing is sent without the required fields.
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    expect(await screen.findAllByText('Wajib diisi.')).not.toHaveLength(0);
    expect(app.requests.filter((r) => r.method === 'POST')).toHaveLength(0);

    fireEvent.change(screen.getByLabelText('Nomor anggota'), { target: { value: 'b 001' } });
    await screen.findByRole('option', { name: 'SISWA — Siswa' });
    fireEvent.change(screen.getByLabelText('Tipe anggota'), { target: { value: TYPE_ID } });
    fireEvent.change(screen.getByLabelText('Nama'), { target: { value: '  Siti Aminah ' } });
    fireEvent.change(screen.getByLabelText('Kelas'), { target: { value: '8B' } });
    // Gender has no default: "Tidak diisi" is the one checked.
    expect((screen.getByLabelText('Tidak diisi') as HTMLInputElement).checked).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    expect(await screen.findByText('Sudah dipakai. Gunakan yang lain.')).toBeTruthy();
    expect(screen.getByLabelText('Nomor anggota').getAttribute('aria-invalid')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    expect(await screen.findByRole('heading', { name: 'Siti Aminah' })).toBeTruthy();
    expect(screen.getByText('Anggota ditambahkan.')).toBeTruthy();

    const body = app.requests.filter((r) => r.method === 'POST' && r.path === 'members')[1]?.body as Record<string, unknown>;
    expect(body).toMatchObject({ memberNo: 'b 001', memberTypeId: TYPE_ID, name: 'Siti Aminah', className: '8B', gender: null, homeBranchId: null, locale: 'id' });
    expect(body).not.toHaveProperty('joinedOn');
    expect(body).not.toHaveProperty('expiresOn');
  });
});

describe('the member page form', () => {
  const PATH = `/admin/anggota/${NEW_ID}`;

  /** The member's page with `current` as the stored member; every PATCH body lands in `patches`. */
  function memberPage(o: { patch?: () => Response | undefined } = {}) {
    let current: MemberView = { ...CREATED, expiresOn: '2026-11-30', version: 3 };
    const patches: Record<string, unknown>[] = [];
    const app = startApp({
      me: adminMe(),
      path: PATH,
      routes: {
        'GET members/types': () => ({ items: [SISWA] }),
        'GET branches': () => ({ items: [BRANCH] }),
        'GET members/:id': () => current,
        'GET members/:id/events': () => ({ items: [], nextCursor: null }),
        'POST members/:id/extend': () => {
          current = { ...current, expiresOn: '2027-11-30', version: current.version + 1 };
          return { id: NEW_ID, version: current.version };
        },
        'PATCH members/:id': (req) => {
          patches.push(req.body as Record<string, unknown>);
          const refused = o.patch?.();
          if (refused !== undefined) return refused;
          const body = req.body as Record<string, unknown>;
          current = { ...current, ...(typeof body['phone'] === 'string' ? { phone: body['phone'] } : {}), version: current.version + 1 };
          return { id: NEW_ID, version: current.version };
        },
      },
    });
    return { app, patches, change: (next: Partial<MemberView>) => (current = { ...current, ...next, version: current.version + 1 }) };
  }

  it("shows the member's type and home branch in their lists also when the lists come after the member", async () => {
    // The lists answer only once the form is on the page: their options arrive after the form set the values.
    let answer: () => void = () => undefined;
    const later = new Promise<void>((resolve) => (answer = resolve));
    startApp({
      me: adminMe(),
      path: PATH,
      routes: {
        'GET members/types': async () => {
          await later;
          return { items: [SISWA] };
        },
        'GET branches': async () => {
          await later;
          return { items: [BRANCH] };
        },
        'GET members/:id': () => ({ ...CREATED, homeBranchId: BRANCH.id }),
        'GET members/:id/events': () => ({ items: [], nextCursor: null }),
      },
    });
    await screen.findByLabelText('Tipe anggota');
    answer();
    await waitFor(() => expect(screen.getByLabelText<HTMLSelectElement>('Tipe anggota').options.length).toBe(2));
    await waitFor(() => expect(screen.getByLabelText<HTMLSelectElement>('Tipe anggota').value).toBe(TYPE_ID));
    expect(screen.getByLabelText<HTMLSelectElement>('Cabang asal').value).toBe(BRANCH.id);
    // Putting the values back changed nothing the user typed.
    expect(screen.queryByText('Ada perubahan yang belum disimpan.')).toBeNull();
  });

  it('puts the head, then the summary strip, then the tabs across the page; a wrapped tab row grows instead of covering the panel', async () => {
    memberPage();
    const heading = await screen.findByRole('heading', { level: 1, name: 'Siti Aminah' });
    const list = screen.getByRole('tablist');
    const tabs = list.closest('[data-slot="tabs"]')!;
    // The figures are one strip under the head, before the tabs (no side column).
    const summary = document.querySelector<HTMLElement>('dl[aria-label="Ringkasan anggota"]')!;
    expect(summary).toBeTruthy();
    expect(within(summary).getByText('Sedang dipinjam')).toBeTruthy();
    expect(heading.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(summary.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole('complementary', { name: 'Ringkasan anggota' })).toBeNull();
    // "Layani di Meja Layanan" is the head's main action.
    expect(screen.getByRole('link', { name: 'Layani di Meja Layanan' }).getAttribute('href')).toContain('/admin/layanan?member=');
    expect(list.className.split(/\s+/)).toEqual(expect.arrayContaining(['h-auto', 'flex-wrap']));
    expect(list.className.split(/\s+/)).not.toContain('h-9');
    // Each tab keeps one row's height: a share of the list's height would overflow it once the tabs wrap.
    for (const tab of within(list).getAllByRole('tab')) {
      expect(tab.className.split(/\s+/)).toContain('h-7.5');
      expect(tab.className).not.toContain('h-[calc(100%-1px)]');
    }
  });

  it('after an extension, a save of another field never sends the old end date back', async () => {
    const page = memberPage();
    expect(await screen.findByRole('heading', { name: 'Siti Aminah' })).toBeTruthy();
    expect((screen.getByLabelText('Berlaku sampai') as HTMLInputElement).value).toBe('2026-11-30');
    fireEvent.change(screen.getByLabelText('Telepon'), { target: { value: '0812' } });

    fireEvent.click(screen.getByRole('button', { name: 'Perpanjang masa…' }));
    // The extension opens in the page, under the head (no dialog).
    const dialog = await screen.findByRole('form', { name: 'Perpanjang masa keanggotaan' });
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Perpanjang' }));
    // The member read again: the untouched end date follows it, the typed phone stays.
    await waitFor(() => expect((screen.getByLabelText('Berlaku sampai') as HTMLInputElement).value).toBe('2027-11-30'));
    expect((screen.getByLabelText('Telepon') as HTMLInputElement).value).toBe('0812');

    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(page.patches).toHaveLength(1));
    expect(page.patches[0]).toEqual({ version: 4, phone: '0812' });
  });

  it('after "Muat ulang data", a save sends only what was typed, never the old values of the other fields', async () => {
    let refuse = true;
    const page = memberPage({
      patch: () => {
        if (!refuse) return undefined;
        refuse = false;
        return problem(409, 'CONFLICT_STALE');
      },
    });
    expect(await screen.findByRole('heading', { name: 'Siti Aminah' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Telepon'), { target: { value: '0812' } });
    // Another staff member changes the e-mail and the class meanwhile.
    page.change({ email: 'siti@sekolah.sch.id', className: '9A' });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Muat ulang data' }));
    await waitFor(() => expect((screen.getByLabelText('Alamat e-mail') as HTMLInputElement).value).toBe('siti@sekolah.sch.id'));
    expect((screen.getByLabelText('Telepon') as HTMLInputElement).value).toBe('0812');

    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(page.patches).toHaveLength(2));
    expect(page.patches[1]).toEqual({ version: 4, phone: '0812' });
  });
});
