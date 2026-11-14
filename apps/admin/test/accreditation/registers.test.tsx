import type {
  ActivityView,
  BudgetView,
  DocumentView,
  EvidenceView,
  PartnershipView,
  RegisterKind,
  StaffView,
  TrainingView,
} from '@altis/shared/api/accreditation';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatMajorAmount, parseMajorAmount } from '@/components/accreditation/registers/budgets';
import { uploadFile } from '@/lib/upload';
import { RegistersTab } from '@/screens/accreditation/tabs/registers';
import { json, problem, type SignedIn } from '../fake-api';
import { instrumentsAnswer, readerMe, renderWithServer, type RouteHandler } from './register-harness';

// The Register tab of the accreditation workspace: the five registers of the library (activities, staff with their
// trainings, partnerships, budgets, documents) as sub-tabs, each a list with create and edit in a dialog and archive
// after a confirmation; a row's dialog also holds its attachments (evidence files linked to the row). Budgets are typed
// in major units and sent in minor units (two decimals) with their currency; documents of a kind with aspects show one
// checkbox per aspect. A reader sees everything and changes nothing.

vi.mock('@/lib/upload', () => ({ uploadFile: vi.fn() }));

const PERIOD = '01JZ0000000000000000000P01';
const ACT = '01JZ0000000000000000000A01';
const STAFF_ID = '01JZ0000000000000000000S01';
const TRAINING_ID = '01JZ0000000000000000000T01';
const PARTNER = '01JZ0000000000000000000K01';
const BUDGET = '01JZ0000000000000000000B01';
const DOC = '01JZ0000000000000000000D01';
const FILE_MOU = '01JZ0000000000000000000F09';
const FILE_NOTES = '01JZ0000000000000000000F08';
const EVIDENCE = '01JZ0000000000000000000E01';
const UPLOAD = '01JZ0000000000000000000U01';
const NEW = (n: number): string => `01JZ0000000000000000000N${String(n).padStart(2, '0')}`;

const TRAIL = { createdAt: 1_760_000_000_000, createdBy: 'u1', updatedAt: 1_760_000_000_000, updatedBy: 'u1' };

const ACTIVITY: ActivityView = {
  id: ACT,
  version: 2,
  ...TRAIL,
  kind: 'promotion',
  title: 'Pameran buku baru',
  heldOn: '2026-02-10',
  endedOn: null,
  participants: 120,
  partner: null,
  usesLibraryFacility: false,
  externalSpeaker: false,
  description: null,
};

const TRAINING: TrainingView = {
  id: TRAINING_ID,
  staffId: STAFF_ID,
  title: 'Diklat pengelolaan perpustakaan sekolah',
  organizer: 'Perpustakaan Nasional',
  heldOn: '2025-09-01',
  hours: 40,
  certificateFileId: null,
  certificateFileName: null,
  version: 1,
};

const STAFF: StaffView = {
  id: STAFF_ID,
  version: 1,
  ...TRAIL,
  staffUserId: null,
  name: 'Siti Rahmawati',
  position: 'Kepala perpustakaan',
  role: 'head',
  isLibrarian: true,
  employment: 'civil_servant',
  educationLevel: 's1',
  educationLibrary: true,
  libraryTraining: true,
  competencyCert: false,
  associationMember: true,
  appointmentRef: '800/12/2024',
  startsOn: '2024-07-15',
  endsOn: null,
  trainings: [TRAINING],
};

const PARTNERSHIP: PartnershipView = {
  id: PARTNER,
  version: 1,
  ...TRAIL,
  partner: 'Dinas Perpustakaan Kabupaten',
  kind: 'mou',
  startsOn: '2025-01-01',
  endsOn: '2027-12-31',
  scope: 'Layanan perpustakaan keliling',
  documentFileId: FILE_MOU,
  documentFileName: 'mou-dinas.pdf',
};

const BUDGET_2025: BudgetView = {
  id: BUDGET,
  version: 1,
  ...TRAIL,
  year: 2025,
  libraryMinor: 1_200_000_000,
  parentMinor: null,
  parentNonpersonnelMinor: 24_000_000_000,
  collectionMinor: null,
  communityMinor: null,
  currency: 'IDR',
  note: null,
};

const DOCUMENT: DocumentView = {
  id: DOC,
  version: 1,
  ...TRAIL,
  kind: 'collection_policy',
  title: 'Kebijakan pengembangan koleksi 2025',
  reference: '421/15/2025',
  issuedOn: '2025-07-01',
  issuedBy: 'Kepala sekolah',
  aspectCodes: ['a1', 'a2', 'a3'],
  validUntil: null,
  fileId: null,
  fileName: null,
};

const NOTES: EvidenceView = {
  id: EVIDENCE,
  periodId: null,
  indicatorCode: null,
  evidenceCode: null,
  entity: 'library_documents',
  entityId: DOC,
  fileId: FILE_NOTES,
  fileName: 'notulen.pdf',
  size: 2048,
  mime: 'application/pdf',
  caption: 'Notulen rapat penetapan',
  sortOrder: 0,
  createdAt: 1_760_000_000_000,
};

type Row = { id: string; version: number } & Record<string, unknown>;

/** A view of a created row: the body's values over the empty ones (upload ids become file ids). */
function created(kind: RegisterKind, id: string, body: Record<string, unknown>): Row {
  const { documentUploadId, fileUploadId, ...rest } = body;
  const base: Record<RegisterKind, Record<string, unknown>> = {
    activities: { endedOn: null, participants: null, partner: null, description: null },
    staff: { staffUserId: null, position: null, employment: null, educationLevel: null, appointmentRef: null, endsOn: null, trainings: [] },
    partnerships: { endsOn: null, scope: null, documentFileId: documentUploadId ?? null, documentFileName: documentUploadId === undefined ? null : 'pks.pdf' },
    budgets: { parentMinor: null, parentNonpersonnelMinor: null, collectionMinor: null, communityMinor: null, note: null },
    documents: { reference: null, issuedOn: null, issuedBy: null, aspectCodes: [], validUntil: null, fileId: fileUploadId ?? null, fileName: null },
  };
  return { id, version: 1, ...TRAIL, ...base[kind], ...rest };
}

/** The registers' fake server: lists, writes and the attachments of the rows, kept in memory. */
function start(o: { me?: SignedIn; budgetTaken?: boolean; evidence?: EvidenceView[] } = {}) {
  const rows: Record<RegisterKind, Row[]> = {
    activities: [ACTIVITY as unknown as Row],
    staff: [structuredClone(STAFF) as unknown as Row],
    partnerships: [PARTNERSHIP as unknown as Row],
    budgets: [BUDGET_2025 as unknown as Row],
    documents: [DOCUMENT as unknown as Row],
  };
  let evidence = [...(o.evidence ?? [])];
  let n = 0;
  const routes: Record<string, RouteHandler> = {
    'GET accreditation/instruments': () => instrumentsAnswer(5),
    'GET accreditation/evidence': (req) => ({
      evidence: evidence.filter((e) => e.entity === req.query.get('entity') && e.entityId === req.query.get('entityId')),
      componentBytes: { K: 0, SP: 0, L: 0, T: 0, F: 0, G: 0, profil: 0 },
    }),
    'POST accreditation/evidence': (req) => {
      const b = req.body as { entity: EvidenceView['entity']; entityId: string; caption: string };
      const id = NEW(++n);
      evidence = [...evidence, { ...NOTES, id, fileId: id, fileName: 'baru.pdf', entity: b.entity, entityId: b.entityId, caption: b.caption }];
      return json({ id, version: 1 }, 201);
    },
    'DELETE accreditation/evidence/:id': (req) => {
      evidence = evidence.filter((e) => e.id !== req.params['id']);
      return { id: req.params['id'], version: 1 };
    },
    'POST accreditation/staff/:id/trainings': (req) => {
      const staff = rows.staff.find((r) => r.id === req.params['id'])!;
      const id = NEW(++n);
      const b = req.body as Record<string, unknown>;
      const training: TrainingView = { id, staffId: staff.id, title: '', organizer: null, heldOn: '', hours: null, certificateFileId: null, certificateFileName: null, version: 1, ...b };
      staff['trainings'] = [...(staff['trainings'] as TrainingView[]), training];
      return json({ id, version: 1 }, 201);
    },
    'DELETE accreditation/trainings/:id': (req) => {
      for (const staff of rows.staff) staff['trainings'] = (staff['trainings'] as TrainingView[]).filter((t) => t.id !== req.params['id']);
      return { id: req.params['id'], version: 2 };
    },
  };
  for (const kind of ['activities', 'staff', 'partnerships', 'budgets', 'documents'] as const) {
    routes[`GET accreditation/${kind}`] = () => ({ rows: rows[kind] });
    routes[`POST accreditation/${kind}`] = (req) => {
      if (kind === 'budgets' && o.budgetTaken === true) return problem(422, 'VALIDATION_FAILED', { errors: [{ path: 'year', code: 'taken' }] });
      const id = NEW(++n);
      rows[kind] = [...rows[kind], created(kind, id, req.body as Record<string, unknown>)];
      return json({ id, version: 1 }, 201);
    };
    routes[`PATCH accreditation/${kind}/:id`] = (req) => {
      const patch = { ...(req.body as Record<string, unknown>) };
      delete patch['version'];
      rows[kind] = rows[kind].map((r) => (r.id === req.params['id'] ? { ...r, ...patch, version: r.version + 1 } : r));
      return { id: req.params['id'], version: 3 };
    };
    routes[`DELETE accreditation/${kind}/:id`] = (req) => {
      rows[kind] = rows[kind].filter((r) => r.id !== req.params['id']);
      return { id: req.params['id'], version: 9 };
    };
  }
  return renderWithServer(<RegistersTab periodId={PERIOD} />, { ...(o.me === undefined ? {} : { me: o.me }), routes });
}

/** Opens sub-tab `name` and answers its table. */
async function openTab(name: string, caption: string): Promise<HTMLElement> {
  fireEvent.mouseDown(await screen.findByRole('tab', { name }));
  return screen.findByRole('table', { name: caption });
}

/** Archives the row named `name` of `table` through its confirmation. */
async function archive(table: HTMLElement, name: string): Promise<void> {
  fireEvent.click(within(table).getByRole('button', { name: `Arsipkan ${name}` }));
  const confirm = await screen.findByRole('alertdialog', { name: `Arsipkan ${name}?` });
  fireEvent.click(within(confirm).getByRole('button', { name: 'Arsipkan' }));
}

beforeEach(() => {
  vi.mocked(uploadFile).mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the Register tab', () => {
  it('shows the five registers as sub-tabs and lists the activities first', async () => {
    start();
    for (const name of ['Kegiatan', 'Tenaga & PKB', 'Kerja Sama', 'Anggaran', 'Dokumen']) expect(await screen.findByRole('tab', { name })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Kegiatan' }).getAttribute('aria-selected')).toBe('true');
    const table = await screen.findByRole('table', { name: 'Daftar kegiatan' });
    const row = within(table).getByText('Pameran buku baru').closest('tr')!;
    expect(row.textContent).toContain('Promosi perpustakaan');
    expect(row.textContent).toContain('120');
  });

  it('activities: creates one with both flags, keeps its dialog open for the attachments, and archives it after a confirmation', async () => {
    const { sent, requests } = start();
    await screen.findByRole('table', { name: 'Daftar kegiatan' });
    fireEvent.click(screen.getByRole('button', { name: 'Tambah kegiatan' }));
    const dialog = await screen.findByRole('dialog', { name: 'Tambah kegiatan' });
    fireEvent.change(within(dialog).getByLabelText('Jenis kegiatan'), { target: { value: 'reading_guidance' } });
    fireEvent.change(within(dialog).getByLabelText('Judul'), { target: { value: 'Bimbingan membaca kelas 7' } });
    fireEvent.change(within(dialog).getByLabelText('Tanggal pelaksanaan'), { target: { value: '2026-08-12' } });
    fireEvent.change(within(dialog).getByLabelText('Jumlah peserta'), { target: { value: '32' } });
    fireEvent.click(within(dialog).getByLabelText('Memakai fasilitas perpustakaan'));
    fireEvent.click(within(dialog).getByLabelText('Narasumber dari luar'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Simpan' }));

    await waitFor(() => expect(sent('POST', 'accreditation/activities')).toHaveLength(1));
    expect(sent('POST', 'accreditation/activities')[0]!.body).toEqual({
      kind: 'reading_guidance',
      title: 'Bimbingan membaca kelas 7',
      heldOn: '2026-08-12',
      endedOn: null,
      participants: 32,
      partner: null,
      usesLibraryFacility: true,
      externalSpeaker: true,
      description: null,
    });
    const edit = await screen.findByRole('dialog', { name: 'Ubah kegiatan' });
    expect(await within(edit).findByRole('heading', { name: 'Lampiran bukti' })).toBeTruthy();
    await waitFor(() =>
      expect(requests.some((r) => r.path === 'accreditation/evidence' && r.query.get('entity') === 'library_activities' && r.query.get('entityId') === NEW(1))).toBe(true),
    );
    expect(within(edit).getByRole('button', { name: 'Tambah lampiran' })).toBeTruthy();
    fireEvent.click(within(edit).getByRole('button', { name: 'Batal' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    const table = screen.getByRole('table', { name: 'Daftar kegiatan' });
    const row = within(table).getByText('Bimbingan membaca kelas 7').closest('tr')!;
    expect(row.textContent).toContain('Fasilitas perpustakaan');
    expect(row.textContent).toContain('Narasumber luar');
    await archive(table, 'Bimbingan membaca kelas 7');
    await waitFor(() => expect(sent('DELETE', `accreditation/activities/${NEW(1)}`)).toHaveLength(1));
    expect(sent('DELETE', `accreditation/activities/${NEW(1)}`)[0]!.body).toBeUndefined();
    expect(await screen.findByText('Bimbingan membaca kelas 7 diarsipkan.')).toBeTruthy();
    await waitFor(() => expect(within(screen.getByRole('table', { name: 'Daftar kegiatan' })).queryByText('Bimbingan membaca kelas 7')).toBeNull());
  });

  it('activities: an edit sends only what changed, with the row version', async () => {
    const { sent } = start();
    const table = await screen.findByRole('table', { name: 'Daftar kegiatan' });
    fireEvent.click(within(table).getByRole('button', { name: 'Ubah Pameran buku baru' }));
    const dialog = await screen.findByRole('dialog', { name: 'Ubah kegiatan' });
    expect((within(dialog).getByLabelText('Judul') as HTMLInputElement).value).toBe('Pameran buku baru');
    fireEvent.change(within(dialog).getByLabelText('Jumlah peserta'), { target: { value: '150' } });
    fireEvent.click(within(dialog).getByLabelText('Narasumber dari luar'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(sent('PATCH', `accreditation/activities/${ACT}`)).toHaveLength(1));
    expect(sent('PATCH', `accreditation/activities/${ACT}`)[0]!.body).toEqual({ version: 2, participants: 150, externalSpeaker: true });
    expect(await screen.findByText('Pameran buku baru disimpan.')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('staff: lists each person with the trainings inline, creates one and archives one', async () => {
    const { sent } = start();
    const table = await openTab('Tenaga & PKB', 'Daftar tenaga perpustakaan');
    const row = within(table).getByText('Siti Rahmawati').closest('tr')!;
    expect(row.textContent).toContain('Kepala perpustakaan');
    expect(row.textContent).toContain('Diklat pengelolaan perpustakaan sekolah');

    fireEvent.click(screen.getByRole('button', { name: 'Tambah tenaga' }));
    const dialog = await screen.findByRole('dialog', { name: 'Tambah tenaga' });
    fireEvent.change(within(dialog).getByLabelText('Nama'), { target: { value: 'Budi Santoso' } });
    fireEvent.change(within(dialog).getByLabelText('Peran'), { target: { value: 'librarian' } });
    fireEvent.click(within(dialog).getByLabelText('Pustakawan fungsional'));
    fireEvent.change(within(dialog).getByLabelText('Mulai bertugas'), { target: { value: '2025-07-14' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(sent('POST', 'accreditation/staff')).toHaveLength(1));
    expect(sent('POST', 'accreditation/staff')[0]!.body).toEqual({
      name: 'Budi Santoso',
      position: null,
      role: 'librarian',
      isLibrarian: true,
      employment: null,
      educationLevel: null,
      educationLibrary: false,
      libraryTraining: false,
      competencyCert: false,
      associationMember: false,
      appointmentRef: null,
      startsOn: '2025-07-14',
      endsOn: null,
    });
    const edit = await screen.findByRole('dialog', { name: 'Ubah tenaga' });
    expect(within(edit).getByRole('heading', { name: 'Pelatihan dan pengembangan keprofesian (PKB)' })).toBeTruthy();
    fireEvent.click(within(edit).getByRole('button', { name: 'Batal' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await archive(screen.getByRole('table', { name: 'Daftar tenaga perpustakaan' }), 'Siti Rahmawati');
    await waitFor(() => expect(sent('DELETE', `accreditation/staff/${STAFF_ID}`)).toHaveLength(1));
    await waitFor(() => expect(within(screen.getByRole('table', { name: 'Daftar tenaga perpustakaan' })).queryByText('Siti Rahmawati')).toBeNull());
  });

  it('staff: adds a training to a person and archives one, inside the person’s dialog', async () => {
    const { sent } = start();
    const table = await openTab('Tenaga & PKB', 'Daftar tenaga perpustakaan');
    fireEvent.click(within(table).getByRole('button', { name: 'Ubah Siti Rahmawati' }));
    const dialog = await screen.findByRole('dialog', { name: 'Ubah tenaga' });
    const trainings = within(dialog).getByRole('table', { name: 'Pelatihan Siti Rahmawati' });
    expect(within(trainings).getByText('Diklat pengelolaan perpustakaan sekolah').closest('tr')!.textContent).toContain('40');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Tambah pelatihan' }));
    const form = within(dialog).getByRole('form', { name: 'Tambah pelatihan' });
    fireEvent.change(within(form).getByLabelText('Nama pelatihan'), { target: { value: 'Bimtek katalogisasi' } });
    fireEvent.change(within(form).getByLabelText('Tanggal pelatihan'), { target: { value: '2026-03-02' } });
    fireEvent.change(within(form).getByLabelText('Jumlah jam pelajaran'), { target: { value: '16' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Simpan pelatihan' }));
    await waitFor(() => expect(sent('POST', `accreditation/staff/${STAFF_ID}/trainings`)).toHaveLength(1));
    expect(sent('POST', `accreditation/staff/${STAFF_ID}/trainings`)[0]!.body).toEqual({
      title: 'Bimtek katalogisasi',
      organizer: null,
      heldOn: '2026-03-02',
      hours: 16,
    });
    await waitFor(() => expect(within(within(dialog).getByRole('table', { name: 'Pelatihan Siti Rahmawati' })).getByText('Bimtek katalogisasi')).toBeTruthy());

    fireEvent.click(within(dialog).getByRole('button', { name: 'Arsipkan pelatihan Diklat pengelolaan perpustakaan sekolah' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Arsipkan pelatihan Diklat pengelolaan perpustakaan sekolah?' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Arsipkan' }));
    await waitFor(() => expect(sent('DELETE', `accreditation/trainings/${TRAINING_ID}`)).toHaveLength(1));
    await waitFor(() =>
      expect(within(screen.getByRole('table', { name: 'Pelatihan Siti Rahmawati' })).queryByText('Diklat pengelolaan perpustakaan sekolah')).toBeNull(),
    );
  });

  it('partnerships: lists with the agreement file, creates one whose file goes up first, and archives one', async () => {
    vi.mocked(uploadFile).mockResolvedValue({ uploadId: UPLOAD });
    const { sent } = start();
    const table = await openTab('Kerja Sama', 'Daftar kerja sama');
    const row = within(table).getByText('Dinas Perpustakaan Kabupaten').closest('tr')!;
    expect(row.textContent).toContain('Nota kesepahaman (MoU)');
    expect(within(row).getByRole('link', { name: 'mou-dinas.pdf' }).getAttribute('href')).toBe(`/files/${FILE_MOU}`);

    fireEvent.click(screen.getByRole('button', { name: 'Tambah kerja sama' }));
    const dialog = await screen.findByRole('dialog', { name: 'Tambah kerja sama' });
    fireEvent.change(within(dialog).getByLabelText('Mitra'), { target: { value: 'Puskesmas Kecamatan' } });
    fireEvent.change(within(dialog).getByLabelText('Bentuk kerja sama'), { target: { value: 'pks' } });
    fireEvent.change(within(dialog).getByLabelText('Berlaku mulai'), { target: { value: '2026-01-05' } });
    const pdf = new File([new Uint8Array(100)], 'pks.pdf', { type: 'application/pdf' });
    fireEvent.change(within(dialog).getByLabelText('Dokumen kerja sama'), { target: { files: [pdf] } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(sent('POST', 'accreditation/partnerships')).toHaveLength(1));
    expect(uploadFile).toHaveBeenCalledWith(pdf, expect.objectContaining({ context: 'accreditation.evidence' }));
    expect(vi.mocked(uploadFile).mock.invocationCallOrder[0]).toBeLessThan(sent('POST', 'accreditation/partnerships')[0]!.order);
    expect(sent('POST', 'accreditation/partnerships')[0]!.body).toEqual({
      partner: 'Puskesmas Kecamatan',
      kind: 'pks',
      startsOn: '2026-01-05',
      endsOn: null,
      scope: null,
      documentUploadId: UPLOAD,
    });
    const edit = await screen.findByRole('dialog', { name: 'Ubah kerja sama' });
    fireEvent.click(within(edit).getByRole('button', { name: 'Batal' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await archive(screen.getByRole('table', { name: 'Daftar kerja sama' }), 'Dinas Perpustakaan Kabupaten');
    await waitFor(() => expect(sent('DELETE', `accreditation/partnerships/${PARTNER}`)).toHaveLength(1));
  });

  it('budgets: Rp 6.500.000 is sent as 650 000 000 minor units with the currency, and a budget is archived', async () => {
    const { sent } = start();
    const table = await openTab('Anggaran', 'Daftar anggaran');
    const row = within(table).getByText('2025').closest('tr')!;
    expect(row.textContent).toMatch(/Rp\s12\.000\.000/);
    expect(row.textContent).toMatch(/Rp\s240\.000\.000/);

    fireEvent.click(screen.getByRole('button', { name: 'Tambah anggaran' }));
    const dialog = await screen.findByRole('dialog', { name: 'Tambah anggaran' });
    expect((within(dialog).getByLabelText('Mata uang') as HTMLInputElement).value).toBe('IDR');
    fireEvent.change(within(dialog).getByLabelText('Tahun anggaran'), { target: { value: '2026' } });
    fireEvent.change(within(dialog).getByLabelText('Anggaran perpustakaan'), { target: { value: 'Rp 6.500.000' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(sent('POST', 'accreditation/budgets')).toHaveLength(1));
    expect(sent('POST', 'accreditation/budgets')[0]!.body).toEqual({
      year: 2026,
      libraryMinor: 650_000_000,
      parentMinor: null,
      parentNonpersonnelMinor: null,
      collectionMinor: null,
      communityMinor: null,
      currency: 'IDR',
      note: null,
    });
    const edit = await screen.findByRole('dialog', { name: 'Ubah anggaran' });
    expect((within(edit).getByLabelText('Anggaran perpustakaan') as HTMLInputElement).value).toBe('6.500.000');
    fireEvent.click(within(edit).getByRole('button', { name: 'Batal' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await archive(screen.getByRole('table', { name: 'Daftar anggaran' }), 'Anggaran 2025');
    await waitFor(() => expect(sent('DELETE', `accreditation/budgets/${BUDGET}`)).toHaveLength(1));
  });

  it('budgets: a year already recorded shows on the year field, and an amount that is not one is refused before sending', async () => {
    const { sent } = start({ budgetTaken: true });
    await openTab('Anggaran', 'Daftar anggaran');
    fireEvent.click(screen.getByRole('button', { name: 'Tambah anggaran' }));
    const dialog = await screen.findByRole('dialog', { name: 'Tambah anggaran' });
    fireEvent.change(within(dialog).getByLabelText('Tahun anggaran'), { target: { value: '2025' } });
    fireEvent.change(within(dialog).getByLabelText('Anggaran perpustakaan'), { target: { value: 'enam juta' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Simpan' }));
    expect(await within(dialog).findByText('Tulis jumlah uang, misalnya 6.500.000 atau 6.500.000,50.')).toBeTruthy();
    expect(sent('POST', 'accreditation/budgets')).toHaveLength(0);

    fireEvent.change(within(dialog).getByLabelText('Anggaran perpustakaan'), { target: { value: '12.000.000' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(sent('POST', 'accreditation/budgets')).toHaveLength(1));
    expect(await within(dialog).findByText('Anggaran tahun ini sudah dicatat. Ubah baris yang ada, atau arsipkan dulu.')).toBeTruthy();
    expect(within(dialog).getByLabelText('Tahun anggaran').getAttribute('aria-invalid')).toBe('true');
  });

  it('documents: collection_policy shows its 8 aspect checkboxes and rules none; a document is created with its aspects and archived', async () => {
    const { sent } = start();
    const table = await openTab('Dokumen', 'Daftar dokumen');
    const row = within(table).getByText('Kebijakan pengembangan koleksi 2025').closest('tr')!;
    expect(row.textContent).toContain('3 dari 8 aspek');

    fireEvent.click(screen.getByRole('button', { name: 'Tambah dokumen' }));
    const dialog = await screen.findByRole('dialog', { name: 'Tambah dokumen' });
    fireEvent.change(within(dialog).getByLabelText('Jenis dokumen'), { target: { value: 'rules' } });
    expect(within(dialog).queryByRole('group', { name: 'Aspek yang dicakup' })).toBeNull();
    expect(within(dialog).queryAllByRole('checkbox')).toHaveLength(0);

    fireEvent.change(within(dialog).getByLabelText('Jenis dokumen'), { target: { value: 'collection_policy' } });
    const aspects = within(dialog).getByRole('group', { name: 'Aspek yang dicakup' });
    expect(within(aspects).getAllByRole('checkbox')).toHaveLength(8);
    expect(within(aspects).getByLabelText('Aspek 8')).toBeTruthy();
    for (const label of ['Aspek 5', 'Aspek 1', 'Aspek 2']) fireEvent.click(within(aspects).getByLabelText(label));
    fireEvent.change(within(dialog).getByLabelText('Judul'), { target: { value: 'Kebijakan pengembangan koleksi 2026' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(sent('POST', 'accreditation/documents')).toHaveLength(1));
    expect(sent('POST', 'accreditation/documents')[0]!.body).toEqual({
      kind: 'collection_policy',
      title: 'Kebijakan pengembangan koleksi 2026',
      reference: null,
      issuedOn: null,
      issuedBy: null,
      aspectCodes: ['a1', 'a2', 'a5'],
      validUntil: null,
    });
    const edit = await screen.findByRole('dialog', { name: 'Ubah dokumen' });
    fireEvent.click(within(edit).getByRole('button', { name: 'Batal' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await archive(screen.getByRole('table', { name: 'Daftar dokumen' }), 'Kebijakan pengembangan koleksi 2025');
    await waitFor(() => expect(sent('DELETE', `accreditation/documents/${DOC}`)).toHaveLength(1));
  });

  it('documents: a kind change drops the aspects the new kind does not have', async () => {
    const { sent } = start();
    const table = await openTab('Dokumen', 'Daftar dokumen');
    fireEvent.click(within(table).getByRole('button', { name: 'Ubah Kebijakan pengembangan koleksi 2025' }));
    const dialog = await screen.findByRole('dialog', { name: 'Ubah dokumen' });
    const aspects = within(dialog).getByRole('group', { name: 'Aspek yang dicakup' });
    expect(within(aspects).getAllByRole('checkbox').filter((c) => (c as HTMLInputElement).checked)).toHaveLength(3);
    fireEvent.change(within(dialog).getByLabelText('Jenis dokumen'), { target: { value: 'head_performance_report' } });
    expect(within(within(dialog).getByRole('group', { name: 'Aspek yang dicakup' })).getAllByRole('checkbox')).toHaveLength(6);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(sent('PATCH', `accreditation/documents/${DOC}`)).toHaveLength(1));
    expect(sent('PATCH', `accreditation/documents/${DOC}`)[0]!.body).toEqual({ version: 1, kind: 'head_performance_report' });

    fireEvent.click(within(screen.getByRole('table', { name: 'Daftar dokumen' })).getByRole('button', { name: 'Ubah Kebijakan pengembangan koleksi 2025' }));
    const again = await screen.findByRole('dialog', { name: 'Ubah dokumen' });
    fireEvent.change(within(again).getByLabelText('Jenis dokumen'), { target: { value: 'rules' } });
    fireEvent.click(within(again).getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(sent('PATCH', `accreditation/documents/${DOC}`)).toHaveLength(2));
    expect(sent('PATCH', `accreditation/documents/${DOC}`)[1]!.body).toEqual({ version: 2, kind: 'rules', aspectCodes: [] });
  });

  it('the attachments of a row: listed with their files, added through the evidence upload, removed after a confirmation', async () => {
    vi.mocked(uploadFile).mockResolvedValue({ uploadId: UPLOAD });
    const { sent } = start({ evidence: [NOTES] });
    const table = await openTab('Dokumen', 'Daftar dokumen');
    fireEvent.click(within(table).getByRole('button', { name: 'Ubah Kebijakan pengembangan koleksi 2025' }));
    const dialog = await screen.findByRole('dialog', { name: 'Ubah dokumen' });
    const link = await within(dialog).findByRole('link', { name: 'notulen.pdf' });
    expect(link.getAttribute('href')).toBe(`/files/${FILE_NOTES}`);
    expect(within(dialog).getByText('Notulen rapat penetapan')).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Tambah lampiran' }));
    const upload = await screen.findByRole('dialog', { name: 'Tambah lampiran' });
    await within(upload).findByText(/paling besar 5 MB/);
    fireEvent.change(within(upload).getByLabelText('Berkas'), { target: { files: [new File([new Uint8Array(10)], 'daftar-hadir.pdf', { type: 'application/pdf' })] } });
    fireEvent.change(within(upload).getByLabelText('Keterangan'), { target: { value: 'Daftar hadir sosialisasi' } });
    fireEvent.click(within(upload).getByRole('button', { name: 'Unggah' }));
    await waitFor(() => expect(sent('POST', 'accreditation/evidence')).toHaveLength(1));
    expect(sent('POST', 'accreditation/evidence')[0]!.body).toEqual({ uploadId: UPLOAD, entity: 'library_documents', entityId: DOC, caption: 'Daftar hadir sosialisasi' });
    const edit = await screen.findByRole('dialog', { name: 'Ubah dokumen' });
    expect(await within(edit).findByText('Daftar hadir sosialisasi')).toBeTruthy();

    fireEvent.click(within(edit).getByRole('button', { name: 'Hapus lampiran notulen.pdf' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Hapus lampiran notulen.pdf?' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Hapus' }));
    await waitFor(() => expect(sent('DELETE', `accreditation/evidence/${EVIDENCE}`)).toHaveLength(1));
    await waitFor(() => expect(within(screen.getByRole('dialog', { name: 'Ubah dokumen' })).queryByText('notulen.pdf')).toBeNull());
  });

  it('a reader sees the registers and the attachments but cannot add, change or archive anything', async () => {
    start({ me: readerMe(), evidence: [NOTES] });
    const table = await screen.findByRole('table', { name: 'Daftar kegiatan' });
    expect(screen.getByText('Anda dapat melihat register ini, tetapi tidak dapat mengubahnya.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Tambah kegiatan' })).toBeNull();
    expect(within(table).queryByRole('button', { name: /^Arsipkan/ })).toBeNull();

    const documents = await openTab('Dokumen', 'Daftar dokumen');
    fireEvent.click(within(documents).getByRole('button', { name: 'Lihat Kebijakan pengembangan koleksi 2025' }));
    const dialog = await screen.findByRole('dialog', { name: 'Dokumen' });
    expect(await within(dialog).findByRole('link', { name: 'notulen.pdf' })).toBeTruthy();
    expect((within(dialog).getByLabelText('Judul') as HTMLInputElement).disabled).toBe(true);
    expect(within(dialog).queryByRole('button', { name: 'Simpan' })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Tambah lampiran' })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: /^Hapus lampiran/ })).toBeNull();
  });
});

describe('money in major units', () => {
  it('reads Indonesian and English amounts, with or without the currency, into minor units', () => {
    expect(parseMajorAmount('Rp 6.500.000')).toEqual({ ok: true, minor: 650_000_000 });
    expect(parseMajorAmount('6500000')).toEqual({ ok: true, minor: 650_000_000 });
    expect(parseMajorAmount('6.500.000,50')).toEqual({ ok: true, minor: 650_000_050 });
    expect(parseMajorAmount('6,500,000.5')).toEqual({ ok: true, minor: 650_000_050 });
    expect(parseMajorAmount('IDR 1.500')).toEqual({ ok: true, minor: 150_000 });
    expect(parseMajorAmount('12,5')).toEqual({ ok: true, minor: 1_250 });
    expect(parseMajorAmount('0')).toEqual({ ok: true, minor: 0 });
    expect(parseMajorAmount('  ')).toEqual({ ok: true, minor: null });
    for (const bad of ['enam juta', '-5', '1.2.3', '6.50.000', '1,234.567', '12345678901234', '1.5.']) expect(parseMajorAmount(bad), bad).toEqual({ ok: false });
  });

  it('writes minor units back in the UI language, without decimals for a whole amount', () => {
    expect(formatMajorAmount(650_000_000, 'id')).toBe('6.500.000');
    expect(formatMajorAmount(650_000_050, 'id')).toBe('6.500.000,50');
    expect(formatMajorAmount(650_000_000, 'en')).toBe('6,500,000');
    expect(parseMajorAmount(formatMajorAmount(123_456_789, 'id'))).toEqual({ ok: true, minor: 123_456_789 });
    expect(parseMajorAmount(formatMajorAmount(123_456_789, 'en'))).toEqual({ ok: true, minor: 123_456_789 });
  });
});
