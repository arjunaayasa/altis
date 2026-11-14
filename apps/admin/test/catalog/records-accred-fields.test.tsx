import type { CatalogConfigView } from '@altis/shared/api/settings';
import type { RecordDraft } from '@altis/shared/api/catalog/record-data';
import type { LanguageView, MaterialTypeView } from '@altis/shared/api/catalog/masters';
import { RecordCreateBody, RecordPatchBody, type RecordDetail } from '@altis/shared/api/catalog/records';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { draftToFormValues, formToCreateBody } from '@/screens/catalog/records/draft-to-form';
import { adminMe, json, startApp, type FakeHandler, type FakeRequest } from '../fake-api';

// The record editor's accreditation fields: who a record is meant for (Sasaran pembaca), who made a local work (Karya
// lokal) and its kind (Jenis karya), and the kind of a reference work (Jenis referensi). Each is a value of its shared
// vocabulary or none; a create sends only the ones chosen, a patch only the ones changed (null clears one), and a
// stored record shows them again after the save reads it back.

const MT_BOOK = '01JZ0000000000000000000B01';
const LANG_IND = '01JZ0000000000000000000G01';
const RECORD = '01JZ0000000000000000000R01';
const NEW_ID = '01JZ0000000000000000000R09';

const BOOK: MaterialTypeView = {
  id: MT_BOOK,
  code: 'BUKU',
  nameId: 'Buku',
  nameEn: 'Book',
  marcType: 'a',
  marcLevel: 'm',
  contentType: 'txt',
  mediaType: 'n',
  carrierType: 'nc',
  schemaType: 'Book',
  dcmiType: 'Text',
  template: { fields: {}, defaults: { languageId: LANG_IND }, customFields: [] },
  sortOrder: 0,
  usage: 1,
  archived: false,
  version: 1,
};

const LANGUAGES: LanguageView[] = [{ id: LANG_IND, code: 'ind', nameId: 'Indonesia', nameEn: 'Indonesian', usage: 1, archived: false, version: 1 }];

const CONFIG: CatalogConfigView = {
  barcodePatterns: [],
  symbology: 'code128',
  labelProfiles: [],
  currency: 'IDR',
  dedupeThreshold: 80,
  defaultMaterialTypeId: MT_BOOK,
  defaultCollectionTypeId: null,
  sruServers: [],
  arsyaEnabled: false,
};

function detail(o: Partial<RecordDetail> = {}): RecordDetail {
  return {
    id: RECORD,
    version: 3,
    materialTypeId: MT_BOOK,
    languageId: LANG_IND,
    source: 'slims:12',
    custom: {},
    warnings: [],
    itemCounts: { total: 1, available: 1 },
    createdAt: 1_700_000_000_000,
    updatedAt: 1_760_000_000_000,
    changedAt: 1_760_000_000_000,
    opacVisible: true,
    promoted: false,
    archived: false,
    mergedInto: null,
    materialType: { id: MT_BOOK, code: 'BUKU', nameId: 'Buku', nameEn: 'Book', marcType: 'a', marcLevel: 'm', schemaType: 'Book', dcmiType: 'Text' },
    language: { code: 'ind', nameId: 'Indonesia', nameEn: 'Indonesian' },
    materialTypeCode: 'BUKU',
    title: 'Kliping Sejarah Desa',
    publisher: null,
    contentType: 'txt',
    mediaType: 'n',
    carrierType: 'nc',
    identifiers: [],
    agents: [],
    subjects: [],
    links: [],
    items: [],
    marcExtra: [],
    coverFileId: null,
    attachments: [],
    relations: [],
    customPublic: [],
    audience: 'children',
    localWork: 'student',
    localWorkKind: 'clipping',
    referenceKind: null,
    ...o,
  };
}

function start(path: string, routes: Record<string, FakeHandler>) {
  return startApp({
    me: adminMe(),
    path,
    routes: {
      'GET catalog/material-types': () => ({ items: [BOOK] }),
      'GET catalog/languages': () => ({ items: LANGUAGES }),
      'GET catalog/custom-fields': () => ({ items: [] }),
      'GET catalog/config': () => CONFIG,
      'GET catalog/agents': () => ({ items: [], nextCursor: null }),
      'POST catalog/records/duplicates': () => ({ candidates: [], threshold: 80 }),
      'GET catalog/records/:id/attachments': () => ({ items: [] }),
      ...routes,
    },
  });
}

const writes = (requests: FakeRequest[], path: string): unknown[] => requests.filter((r) => r.method !== 'GET' && r.path === path).map((r) => r.body);

const select = (label: string): HTMLSelectElement => screen.getByLabelText(label) as HTMLSelectElement;

/** The label of the option a select shows. */
const shown = (label: string): string => {
  const s = select(label);
  return s.options[s.selectedIndex]?.textContent ?? '';
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the accreditation fields of the record editor', () => {
  it('shows the stored values, patches only the changed ones (null clears) and shows them again after the read-back', async () => {
    let stored = detail();
    const { requests } = start(`/admin/catalog/records/${RECORD}`, {
      [`GET catalog/records/${RECORD}`]: () => stored,
      [`PATCH catalog/records/${RECORD}`]: (req) => {
        const body = req.body as Record<string, unknown>;
        stored = detail({ ...stored, ...body, version: stored.version + 1 } as Partial<RecordDetail>);
        return { id: RECORD, version: stored.version };
      },
    });
    await waitFor(() => expect((screen.getByLabelText('Judul (wajib)') as HTMLInputElement).value).toBe('Kliping Sejarah Desa'), { timeout: 10_000 });
    const section = screen.getByRole('region', { name: 'Akreditasi' });
    expect(within(section).getByText(/tidak membuat cantuman hasil migrasi dianggap disunting di ALTIS/)).toBeTruthy();
    expect(shown('Sasaran pembaca')).toBe('Anak');
    expect(shown('Karya lokal')).toBe('Karya siswa');
    expect(shown('Jenis karya')).toBe('Kliping');
    expect(shown('Jenis referensi')).toBe('(tidak ada)');
    expect([...select('Jenis referensi').options].map((o) => o.value)).toEqual([
      '',
      'encyclopedia',
      'dictionary',
      'handbook',
      'atlas',
      'globe',
      'biography',
      'almanac',
      'directory',
      'other',
    ]);

    fireEvent.change(select('Sasaran pembaca'), { target: { value: '' } });
    fireEvent.change(select('Jenis referensi'), { target: { value: 'dictionary' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(writes(requests, `catalog/records/${RECORD}`)).toHaveLength(1));
    const body = writes(requests, `catalog/records/${RECORD}`)[0];
    expect(body).toEqual({ version: 3, audience: null, referenceKind: 'dictionary' });
    expect(RecordPatchBody.safeParse(body).success).toBe(true);

    expect(await screen.findByText('Perubahan cantuman disimpan.')).toBeTruthy();
    await waitFor(() => expect(shown('Jenis referensi')).toBe('Kamus'));
    expect(shown('Sasaran pembaca')).toBe('(tidak ada)');
    expect(shown('Karya lokal')).toBe('Karya siswa');
    expect(shown('Jenis karya')).toBe('Kliping');

    // Nothing changed: nothing is sent.
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await screen.findByText('Perubahan cantuman disimpan.');
    expect(writes(requests, `catalog/records/${RECORD}`)).toHaveLength(1);
  });

  it('a new record posts the fields chosen', async () => {
    const { requests } = start('/admin/catalog/records/new', {
      'POST catalog/records': () => json({ id: NEW_ID, version: 0 }, 201),
      [`GET catalog/records/${NEW_ID}`]: () => detail({ id: NEW_ID, version: 0, title: 'Antologi Puisi Guru' }),
    });
    const title = await screen.findByLabelText('Judul (wajib)', undefined, { timeout: 10_000 });
    await waitFor(() => expect(select('Jenis bahan (wajib)').value).toBe(MT_BOOK));
    fireEvent.change(title, { target: { value: 'Antologi Puisi Guru' } });
    fireEvent.change(select('Sasaran pembaca'), { target: { value: 'general' } });
    fireEvent.change(select('Karya lokal'), { target: { value: 'teacher' } });
    fireEvent.change(select('Jenis karya'), { target: { value: 'poetry' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(writes(requests, 'catalog/records')).toHaveLength(1));
    const body = writes(requests, 'catalog/records')[0] as Record<string, unknown>;
    expect(body).toMatchObject({ title: 'Antologi Puisi Guru', audience: 'general', localWork: 'teacher', localWorkKind: 'poetry' });
    expect(body).not.toHaveProperty('referenceKind');
    expect(RecordCreateBody.safeParse(body).success).toBe(true);
  });

  it('a copied draft keeps the fields it carries into the create body', () => {
    const draft: RecordDraft = {
      materialTypeCode: 'BUKU',
      title: 'Ensiklopedia Flora',
      publisher: null,
      identifiers: [],
      agents: [],
      subjects: [],
      links: [],
      items: [],
      marcExtra: [],
      audience: 'special_needs',
      referenceKind: 'encyclopedia',
    };
    const values = draftToFormValues(draft, { materialTypes: [BOOK], languages: LANGUAGES, defaultMaterialTypeId: MT_BOOK });
    expect([values.audience, values.localWork, values.localWorkKind, values.referenceKind]).toEqual(['special_needs', '', '', 'encyclopedia']);
    const body = formToCreateBody(values, { template: BOOK.template, customFields: [] });
    expect(body).toMatchObject({ audience: 'special_needs', referenceKind: 'encyclopedia' });
    expect(body).not.toHaveProperty('localWork');
    expect(body).not.toHaveProperty('localWorkKind');
  });
});
