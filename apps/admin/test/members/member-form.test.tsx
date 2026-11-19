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
    // A short list of types is a group of radio buttons, each with what the type allows; none is chosen for the user.
    const typeGroup = await screen.findByRole('group', { name: 'Tipe anggota' });
    const siswa = within(typeGroup).getByRole('radio', { name: /^Siswa/ }) as HTMLInputElement;
    expect(siswa.checked).toBe(false);
    expect(siswa.closest('label')?.textContent).toBe('Siswa3 eksemplar · berlaku 365 hari');
    expect(screen.queryByRole('combobox', { name: 'Tipe anggota' })).toBeNull();
    fireEvent.click(siswa);
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

describe('Anggota baru: the type list, the order of the sections, the card preview and the possible duplicates', () => {
  const type = (k: number): MemberTypeView => ({ ...SISWA, id: `01JZ00000000000000000000T${k}`, code: `T${k}`, nameId: `Tipe ${k}`, nameEn: null, sortOrder: k });
  const DUP_ID = '01JZ0000000000000000000D01';

  function open(o: { types?: MemberTypeView[]; me?: ReturnType<typeof adminMe>; duplicates?: (body: unknown) => unknown } = {}) {
    return startApp({
      me: o.me ?? adminMe(),
      path: '/admin/anggota/baru',
      routes: {
        'GET members/types': () => ({ items: o.types ?? [SISWA] }),
        'GET branches': () => ({ items: [BRANCH] }),
        'POST members/duplicates': (req) => (o.duplicates ?? (() => ({ items: [] })))(req.body),
        'POST members': () => new Response(JSON.stringify({ id: NEW_ID, version: 1 }), { status: 201, headers: { 'Content-Type': 'application/json', 'X-Altis-Build': '0.1.0' } }),
        'GET members/:id': () => CREATED,
        'GET members/:id/events': () => ({ items: [], nextCursor: null }),
      },
    });
  }

  it('six types are radio buttons with the loan period of their rule; seven are a select', async () => {
    const withRule: MemberTypeView = { ...SISWA, loanRule: { policyId: 'P1', code: 'UMUM', loanDays: 7, renewLimit: 1, loanable: true, others: 0 }, membershipDays: null, loanLimit: null };
    const six = [withRule, ...[2, 3, 4, 5, 6].map(type)];
    const first = open({ types: six });
    const group = await screen.findByRole('group', { name: 'Tipe anggota' });
    expect(within(group).getAllByRole('radio')).toHaveLength(6);
    expect(within(group).getByRole('radio', { name: /^Siswa/ }).closest('label')?.textContent).toBe('SiswaTanpa batas · 7 hari · Tanpa kedaluwarsa');
    // One group for the keyboard: the radios share a name, so the arrow keys move within it.
    expect(new Set(within(group).getAllByRole('radio').map((r) => (r as HTMLInputElement).name))).toEqual(new Set(['memberTypeId']));
    first.queryClient.setQueryData(['members', 'types', { includeArchived: false }], { items: [...six, type(7)] });
    const select = (await screen.findByRole('combobox', { name: 'Tipe anggota' })) as HTMLSelectElement;
    expect(select.options).toHaveLength(8);
    expect(screen.queryByRole('group', { name: 'Tipe anggota' })).toBeNull();
  });

  it('the sections run Data diri, Kontak, Keanggotaan, Catatan internal', async () => {
    open();
    await screen.findByRole('group', { name: 'Tipe anggota' });
    const form = screen.getByLabelText('Nama').closest('form') as HTMLElement;
    const titles = within(form)
      .getAllByRole('heading')
      .map((h) => h.textContent);
    expect(titles.filter((x) => ['Data diri', 'Kontak', 'Keanggotaan', 'Catatan internal'].includes(x ?? ''))).toEqual(['Data diri', 'Kontak', 'Keanggotaan', 'Catatan internal']);
  });

  it('the card preview carries the number as a Code 128 barcode once it can be one', async () => {
    open();
    await screen.findByRole('group', { name: 'Tipe anggota' });
    const preview = document.querySelector('[data-card-preview]') as HTMLElement;
    expect(preview.querySelector('[data-card-barcode]')).toBeNull();
    fireEvent.change(screen.getByLabelText('Nomor anggota'), { target: { value: 'S-1114' } });
    const barcode = await within(preview).findByRole('img', { name: 'Barkod nomor anggota S-1114' });
    // The bars are the modules of the shared encoder (the one the printed card uses), with a quiet zone of 10 on each side.
    const { code128Modules } = await import('@altis/shared');
    const modules = code128Modules('S-1114');
    expect(barcode.getAttribute('viewBox')).toBe(`0 0 ${modules.length + 20} 24`);
    const dark = [...barcode.querySelectorAll('rect')].reduce((n, r) => n + Number(r.getAttribute('width')), 0);
    expect(dark).toBe(modules.filter(Boolean).length);
    // A number Code 128 cannot hold: no barcode (the field says what is wrong when saved).
    fireEvent.change(screen.getByLabelText('Nomor anggota'), { target: { value: 'Sé-1' } });
    await waitFor(() => expect(preview.querySelector('[data-card-barcode]')).toBeNull());
  });

  it('possible duplicates: asked with the name and birth date or the phone, listed with links, and never in the way of saving', async () => {
    const asked: unknown[] = [];
    const app = open({
      duplicates: (body) => {
        asked.push(body);
        return { items: [{ id: DUP_ID, memberNo: 'S-001', name: 'Siti Aminah', match: ['name_birth', 'phone'] }] };
      },
    });
    const card = await screen.findByRole('region', { name: 'Kemungkinan duplikat' });
    expect(within(card).getByText(/^Setelah nama dan tanggal lahir, atau nomor telepon, diisi/)).toBeTruthy();
    // A name alone asks nothing.
    fireEvent.change(screen.getByLabelText('Nama'), { target: { value: ' Siti Aminah ' } });
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(asked).toEqual([]);
    fireEvent.change(screen.getByLabelText('Tanggal lahir'), { target: { value: '2012-05-06' } });
    fireEvent.change(screen.getByLabelText('Telepon'), { target: { value: '0811-111' } });
    const link = await within(card).findByRole('link', { name: /S-001 · Siti Aminah/ }, { timeout: 3000 });
    // One request for the two changes made in a row, with what was typed and nothing else.
    expect(asked).toEqual([{ name: 'Siti Aminah', birthDate: '2012-05-06', phone: '0811-111' }]);
    expect(link.getAttribute('href')).toBe(`/admin/anggota/${DUP_ID}`);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(within(card).getByText('1 anggota mungkin orang yang sama')).toBeTruthy();
    expect(within(card).getByText('Nama dan tanggal lahir sama · Nomor telepon sama')).toBeTruthy();
    expect(within(card).getByRole('status').contains(link)).toBe(true);

    // The save goes through all the same.
    fireEvent.change(screen.getByLabelText('Nomor anggota'), { target: { value: 'B 002' } });
    fireEvent.click(within(screen.getByRole('group', { name: 'Tipe anggota' })).getByRole('radio', { name: /^Siswa/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(app.requests.filter((r) => r.method === 'POST' && r.path === 'members')).toHaveLength(1));
  });

  it('possible duplicates: none found says so; a failed check says the member can still be saved', async () => {
    let fail = false;
    open({ duplicates: () => (fail ? problem(500, 'INTERNAL') : { items: [] }) });
    const card = await screen.findByRole('region', { name: 'Kemungkinan duplikat' });
    fireEvent.change(screen.getByLabelText('Telepon'), { target: { value: '0811-111' } });
    expect(await within(card).findByText('Tidak ada anggota dengan nama dan tanggal lahir, atau nomor telepon, yang sama.', undefined, { timeout: 3000 })).toBeTruthy();
    fail = true;
    fireEvent.change(screen.getByLabelText('Telepon'), { target: { value: '0811-112' } });
    expect(await within(card).findByText('Pemeriksaan duplikat gagal dimuat. Anggota tetap bisa disimpan.', undefined, { timeout: 3000 })).toBeTruthy();
  });

  it('possible duplicates are not asked for, nor shown, without members.records.read', async () => {
    const me = adminMe();
    if (me.authenticated) me.permissions = me.permissions.filter((p) => p !== 'members.records.read');
    const app = open({ me });
    await screen.findByRole('group', { name: 'Tipe anggota' });
    fireEvent.change(screen.getByLabelText('Telepon'), { target: { value: '0811-111' } });
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(screen.queryByRole('region', { name: 'Kemungkinan duplikat' })).toBeNull();
    expect(app.requests.filter((r) => r.path === 'members/duplicates')).toEqual([]);
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
    // Until the types are in, the field is the select with its placeholder; then the member's type is the one chosen.
    await screen.findByLabelText('Tipe anggota');
    answer();
    await waitFor(() => expect((within(screen.getByRole('group', { name: 'Tipe anggota' })).getByRole('radio', { name: /^Siswa/ }) as HTMLInputElement).checked).toBe(true));
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
