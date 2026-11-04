import type { RecordDraft } from '@altis/shared/api/catalog/record-data';
import { RecordCreateBody } from '@altis/shared/api/catalog/records';
import type { CatalogConfigView } from '@altis/shared/api/settings';
import type { LanguageView, MaterialTypeView } from '@altis/shared/api/catalog/masters';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IsbnLookupButtonProps, SruCopyDialogProps } from '@/components/catalog/sru-dialog';
import { draftToFormValues, formToCreateBody } from '@/screens/catalog/records/draft-to-form';
import { adminMe, json, startApp, type FakeRequest } from '../fake-api';

// Copy cataloguing in the record editor (Phase 2 spec §6.2, §6.3, §13; plan Task 24, S4): "Salin dari SRU" and the
// ISBN lookup hand a RecordDraft to the editor, which fills its form through draftToFormValues: new authorities stay
// `{type, name}` references, `marcExtra` and the draft's `links` are kept (the links are posted as
// RecordCreateBody.links on create), and `source` is set. The dialogs themselves are Task 32's; here they are fakes.

vi.mock('@/components/catalog/sru-dialog', () => ({
  SruCopyDialog: (props: SruCopyDialogProps) =>
    props.open ? (
      <div role="dialog" aria-label="Salin dari SRU (uji)">
        <button type="button" onClick={() => props.onPick({ draft: DRAFT, source: 'sru:perpusnas' })}>
          Pilih salinan uji
        </button>
      </div>
    ) : null,
  IsbnLookupButton: (props: IsbnLookupButtonProps) => (
    <span>
      <output aria-label="ISBN yang dicari">{props.isbn}</output>
      <button type="button" onClick={() => props.onExisting(EXISTING)}>
        Sudah ada (uji)
      </button>
    </span>
  ),
}));

const MT_BOOK = '01JZ0000000000000000000B01';
const MT_MAP = '01JZ0000000000000000000B02';
const LANG_IND = '01JZ0000000000000000000G01';
const NEW_ID = '01JZ0000000000000000000R09';
const EXISTING = '01JZ0000000000000000000R05';

function type(id: string, code: string, nameId: string, rda: [string, string, string]): MaterialTypeView {
  return {
    id,
    code,
    nameId,
    nameEn: nameId,
    marcType: 'a',
    marcLevel: 'm',
    contentType: rda[0],
    mediaType: rda[1],
    carrierType: rda[2],
    schemaType: 'Book',
    dcmiType: 'Text',
    template: { fields: {}, defaults: {}, customFields: [] },
    sortOrder: 0,
    usage: 0,
    archived: false,
    version: 1,
  };
}

const TYPES = [type(MT_BOOK, 'BUKU', 'Buku', ['txt', 'n', 'nc']), type(MT_MAP, 'PETA', 'Peta', ['cri', 'n', 'nb'])];
const LANGUAGES: LanguageView[] = [{ id: LANG_IND, code: 'ind', nameId: 'Indonesia', nameEn: 'Indonesian', usage: 0, archived: false, version: 1 }];
const MASTERS = { materialTypes: TYPES, languages: LANGUAGES, defaultMaterialTypeId: MT_BOOK };

const DRAFT: RecordDraft = {
  materialTypeCode: 'buku',
  title: 'Laskar Pelangi',
  subtitle: 'sebuah novel',
  responsibility: 'Andrea Hirata',
  publisher: { name: 'Bentang Pustaka', place: 'Yogyakarta' },
  publicationPlace: 'Yogyakarta',
  publicationYear: '2005',
  publicationDateText: 'c2005',
  physicalDesc: 'xiv, 529 hlm. ; 20 cm',
  languageCode: 'ind',
  identifiers: [{ type: 'isbn', value: '9789793062792' }],
  agents: [
    { type: 'person', name: 'Hirata, Andrea', dates: '1967-', role: 'aut', isMain: true, authoritySource: 'perpusnas' },
    { type: 'organization', name: 'Bentang Pustaka', role: 'ctb', isMain: false },
  ],
  subjects: [{ type: 'topic', term: 'Fiksi Indonesia', classification: '899.221 3', isPrimary: true }],
  links: [{ url: 'https://opac.perpusnas.go.id/laskar', title: 'Perpusnas' }, { url: 'ftp://contoh/laskar' }],
  items: [{ barcode: 'B0001' }],
  marcExtra: [{ tag: '500', ind1: ' ', ind2: ' ', data: '[["a","Catatan asli"]]' }],
};

const CONFIG: CatalogConfigView = {
  barcodePatterns: [],
  symbology: 'code128',
  labelProfiles: [],
  currency: 'IDR',
  dedupeThreshold: 80,
  defaultMaterialTypeId: MT_BOOK,
  defaultCollectionTypeId: null,
  sruServers: [{ id: 'perpusnas', name: 'Perpusnas', enabled: true }],
  arsyaEnabled: false,
};

function start() {
  return startApp({
    me: adminMe(),
    path: '/admin/catalog/records/new',
    routes: {
      'GET catalog/material-types': () => ({ items: TYPES }),
      'GET catalog/languages': () => ({ items: LANGUAGES }),
      'GET catalog/custom-fields': () => ({ items: [] }),
      'GET catalog/config': () => CONFIG,
      'POST catalog/records/duplicates': () => ({ candidates: [], threshold: 80 }),
      'POST catalog/records': () => json({ id: NEW_ID, version: 0, warnings: [{ path: 'links.1.url', code: 'invalid_url' }] }, 201),
    },
  });
}

const creates = (requests: FakeRequest[]) => requests.filter((r) => r.method === 'POST' && r.path === 'catalog/records');

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('draftToFormValues', () => {
  it('maps codes to ids, keeps new authorities as references, the links, marcExtra, and sets source', () => {
    const v = draftToFormValues(DRAFT, MASTERS, 'sru:perpusnas');
    expect(v.materialTypeId).toBe(MT_BOOK);
    expect(v.languageId).toBe(LANG_IND);
    expect([v.contentType, v.mediaType, v.carrierType]).toEqual(['txt', 'n', 'nc']);
    expect(v.agents.map((a) => a.ref)).toEqual([
      { id: null, type: 'person', name: 'Hirata, Andrea', dates: '1967-', authoritySource: 'perpusnas' },
      { id: null, type: 'organization', name: 'Bentang Pustaka', dates: '', authoritySource: '' },
    ]);
    expect(v.publisher).toEqual({ id: null, name: 'Bentang Pustaka', place: 'Yogyakarta' });
    expect(v.subjects).toEqual([{ ref: { id: null, type: 'topic', term: 'Fiksi Indonesia', classification: '899.221 3', authoritySource: '' }, isPrimary: true }]);
    expect(v.links).toEqual(DRAFT.links);
    expect(v.marcExtra).toEqual(DRAFT.marcExtra);
    expect(v.source).toBe('sru:perpusnas');
    expect(v.identifiers).toEqual([{ type: 'isbn', value: '9789793062792', qualifier: '' }]);
  });

  it('an unknown material type falls back to the default, an unknown language to none; RDA codes of the draft win', () => {
    const v = draftToFormValues({ ...DRAFT, materialTypeCode: 'XYZ', languageCode: 'zzz', contentType: 'cri' }, MASTERS);
    expect(v.materialTypeId).toBe(MT_BOOK);
    expect(v.languageId).toBe('');
    expect([v.contentType, v.mediaType, v.carrierType]).toEqual(['cri', 'n', 'nc']);
    expect(v.source).toBeNull();
    expect(draftToFormValues({ ...DRAFT, materialTypeCode: 'peta' }, MASTERS).materialTypeId).toBe(MT_MAP);
  });

  it('becomes a strict create body with the references as {type, name}, the links and source', () => {
    const body = formToCreateBody(draftToFormValues(DRAFT, MASTERS, 'sru:perpusnas'), { template: TYPES[0]!.template, customFields: [] });
    expect(RecordCreateBody.safeParse(body).success).toBe(true);
    expect(body.agents).toEqual([
      { ref: { type: 'person', name: 'Hirata, Andrea', dates: '1967-', authoritySource: 'perpusnas' }, role: 'aut', isMain: true },
      { ref: { type: 'organization', name: 'Bentang Pustaka' }, role: 'ctb', isMain: false },
    ]);
    expect(body.publisher).toEqual({ name: 'Bentang Pustaka', place: 'Yogyakarta' });
    expect(body.subjects).toEqual([{ ref: { type: 'topic', term: 'Fiksi Indonesia', classification: '899.221 3' }, isPrimary: true }]);
    expect(body.links).toEqual(DRAFT.links);
    expect(body.marcExtra).toEqual(DRAFT.marcExtra);
    expect(body.source).toBe('sru:perpusnas');
  });

  it('a field the template hides is not sent', () => {
    const template = { fields: { subtitle: 'hidden' as const, publication_year: 'hidden' as const }, defaults: {}, customFields: [] };
    const body = formToCreateBody(draftToFormValues(DRAFT, MASTERS), { template, customFields: [] });
    expect(body).not.toHaveProperty('subtitle');
    expect(body).not.toHaveProperty('publicationYear');
    expect(body).not.toHaveProperty('publicationDateText');
    expect(body.responsibility).toBe('Andrea Hirata');
  });
});

describe('the editor with a copied draft', () => {
  it('a fake onPick fills title, ISBN and agents, and the links are posted with the create', async () => {
    const { requests } = start();
    await screen.findByLabelText('Judul (wajib)');
    fireEvent.click(await screen.findByRole('button', { name: 'Salin dari SRU' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Salin dari SRU (uji)' })).getByRole('button', { name: 'Pilih salinan uji' }));

    await waitFor(() => expect((screen.getByLabelText('Judul (wajib)') as HTMLInputElement).value).toBe('Laskar Pelangi'));
    expect((screen.getByLabelText('Nilai pengenal 1') as HTMLInputElement).value).toBe('9789793062792');
    const agents = screen.getByRole('group', { name: 'Pengarang dan kontributor' });
    expect(within(agents).getByText('Hirata, Andrea')).toBeTruthy();
    expect(within(agents).getByText('Bentang Pustaka')).toBeTruthy();
    expect(screen.getByRole('status', { name: 'ISBN yang dicari' }).textContent).toBe('9789793062792');
    expect(screen.getByText('https://opac.perpusnas.go.id/laskar')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(creates(requests)).toHaveLength(1));
    const body = creates(requests)[0]!.body as RecordCreateBody;
    expect(RecordCreateBody.safeParse(body).success).toBe(true);
    expect(body.title).toBe('Laskar Pelangi');
    expect(body.identifiers).toEqual([{ type: 'isbn', value: '9789793062792' }]);
    expect(body.agents?.map((a) => a.ref)).toEqual([
      { type: 'person', name: 'Hirata, Andrea', dates: '1967-', authoritySource: 'perpusnas' },
      { type: 'organization', name: 'Bentang Pustaka' },
    ]);
    expect(body.links).toEqual(DRAFT.links);
    expect(body.marcExtra).toEqual(DRAFT.marcExtra);
    expect(body.source).toBe('sru:perpusnas');
  });

  it('while "Salin dari SRU" is open, a scan is the dialog\'s: the editor\'s ISBN field stays as it was', async () => {
    start();
    await screen.findByLabelText('Judul (wajib)');
    fireEvent.click(await screen.findByRole('button', { name: 'Salin dari SRU' }));
    const dialog = await screen.findByRole('dialog', { name: 'Salin dari SRU (uji)' });
    for (const key of '9789793062792') fireEvent.keyDown(dialog, { key });
    fireEvent.keyDown(dialog, { key: 'Enter' });
    await new Promise((r) => setTimeout(r, 100));
    expect((screen.getByLabelText('Nilai pengenal 1') as HTMLInputElement).value).toBe('');
  });

  it('a removed link is not posted', async () => {
    const { requests } = start();
    await screen.findByLabelText('Judul (wajib)');
    fireEvent.click(await screen.findByRole('button', { name: 'Salin dari SRU' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Pilih salinan uji' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Hapus tautan ftp://contoh/laskar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(creates(requests)).toHaveLength(1));
    expect((creates(requests)[0]!.body as RecordCreateBody).links).toEqual([DRAFT.links[0]]);
  });

  it('the ISBN is already in the catalogue: a link to the record and "Tambah eksemplar"', async () => {
    start();
    await screen.findByLabelText('Judul (wajib)');
    fireEvent.click(await screen.findByRole('button', { name: 'Sudah ada (uji)' }));
    const notice = (await screen.findByText('Sudah ada di katalog.')).closest('[role="status"]')!;
    expect(within(notice as HTMLElement).getByRole('link', { name: 'Buka cantuman' }).getAttribute('href')).toBe(`/admin/catalog/records/${EXISTING}`);
    expect(within(notice as HTMLElement).getByRole('link', { name: 'Tambah eksemplar' }).getAttribute('href')).toBe(`/admin/catalog/records/${EXISTING}?tab=items`);
  });
});
