import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { issueCode } from '../src/api/common.js';
import {
  TEXT_MAX_BYTES,
  codeField,
  cursorQuery,
  dateField,
  longText,
  priceField,
  shortText,
  utf8Length,
  utf8Max,
  yearField,
  type FieldWarning,
  type Paged,
  type StoreResponse,
} from '../src/api/catalog/common.js';
import { MarcExtraField, RecordDraft, type RecordData } from '../src/api/catalog/record-data.js';
import {
  CoverBody,
  DuplicateCheckBody,
  MergeBody,
  RecordCreateBody,
  RecordListQuery,
  RecordPatchBody,
} from '../src/api/catalog/records.js';
import { AttachmentCreateBody, AttachmentPatchBody } from '../src/api/catalog/attachments.js';
import {
  AgentBody,
  AgentPatchBody,
  AuthorityListQuery,
  MergeIntoBody,
  OrphansArchiveBody,
  OrphansQuery,
  PublisherBody,
  SubjectBody,
  SubjectPatchBody,
  SubjectRelationsBody,
} from '../src/api/catalog/authorities.js';
import {
  CollectionTypeBody,
  CustomFieldBody,
  CustomFieldPatchBody,
  LanguageBody,
  MasterListQuery,
  MaterialTypeBody,
  MaterialTypePatchBody,
  MaterialTypeTemplate,
  SupplierBody,
  SupplierPatchBody,
} from '../src/api/catalog/masters.js';
import { LocationBody, LocationListQuery, LocationMapBody, LocationPatchBody } from '../src/api/catalog/locations.js';
import {
  ItemBatchBody,
  ItemBulkBody,
  ItemByBarcodeQuery,
  ItemCreateBody,
  ItemListQuery,
  ItemPatchBody,
} from '../src/api/catalog/items.js';
import { DedupeScanBody, RunListQuery } from '../src/api/catalog/runs.js';
import { ExportBody, ImportBody, MarcFormatQuery, type MarcJsonRecord } from '../src/api/catalog/exchange.js';
import { SruSearchQuery, SruTestBody } from '../src/api/catalog/copy.js';
import { LabelBody } from '../src/api/catalog/labels.js';
import type { ReindexResponse } from '../src/api/catalog/search.js';
import { SlimsDbInput, SlimsStartBody, SlimsTestBody } from '../src/api/catalog/migration.js';
import { PageBody, PageListQuery, PagePatchBody, PagePreviewBody, PageTranslationInput } from '../src/api/opac-pages.js';
import { newId } from '../src/ids.js';

// The Phase 2 API contracts (plan Task 4): strict Zod bodies at every depth, every maximum equal to its column, every
// free TEXT value capped at 60 000 UTF-8 bytes (Review Focus 3), and the "exactly one of" rules of S3 and Task 4.

interface Parser {
  safeParse(v: unknown): { success: boolean; error?: { issues: { code: string; path: PropertyKey[]; params?: Record<string, unknown> }[] } };
}

/** The `{path, code}` field errors the server would answer for `value` (validate.ts uses the same issueCode). */
function errorsOf(schema: Parser, value: unknown): { path: string; code: string }[] {
  const r = schema.safeParse(value);
  if (r.success) return [];
  return r.error!.issues.map((i) => ({ path: i.path.map(String).join('.'), code: issueCode(i) }));
}

const ok = (schema: Parser, value: unknown): boolean => schema.safeParse(value).success;

const id = (): string => newId();
const MT = id();
const LANG = id();
const AGENT = id();
const SUBJECT = id();
const OTHER = id();
const UPLOAD = id();
const RUN = id();
const BRANCH = id();
const COLL = id();

/** 4 UTF-8 bytes each, one code point each. */
const BOOKS = '\u{1F4DA}';
/** 15 001 four-byte characters: 60 004 bytes, though only 15 001 characters (Review Focus 3). */
const WIDE = BOOKS.repeat(15_001);
const NARROW = 'a'.repeat(20_000);

function recordBody(): Record<string, unknown> {
  return {
    materialTypeId: MT,
    title: 'Laskar Pelangi',
    subtitle: 'sebuah novel',
    responsibility: 'Andrea Hirata',
    edition: 'Cet. 5',
    publisher: { name: 'Bentang', place: 'Yogyakarta' },
    publicationYear: '2005',
    publicationDateText: 'c2005',
    languageId: LANG,
    contentType: 'txt',
    mediaType: 'n',
    carrierType: 'nc',
    summary: 'Kisah sepuluh anak Belitung.',
    notes: 'Catatan.',
    identifiers: [{ type: 'isbn', value: '979-3062-79-7', qualifier: 'jil. 1' }],
    agents: [
      { ref: { type: 'person', name: 'Hirata, Andrea' }, role: 'aut', isMain: true },
      { ref: { id: AGENT }, role: 'edt', isMain: false },
    ],
    subjects: [
      { ref: { type: 'topic', term: 'Pendidikan' }, isPrimary: true },
      { ref: { id: SUBJECT }, isPrimary: false },
    ],
    relations: [{ relatedId: OTHER, type: 'other_edition' }],
    marcExtra: [{ tag: '590', ind1: ' ', ind2: ' ', data: '[["a","catatan lokal"]]' }],
    links: [{ url: 'https://example.org/e', title: 'Versi elektronik' }],
    custom: { halaman: 12 },
    source: 'sru:perpusnas',
    opacVisible: true,
    promoted: false,
  };
}

function draft(): Record<string, unknown> {
  return {
    materialTypeCode: 'BUKU',
    title: 'Laskar Pelangi',
    publisher: { name: 'Bentang' },
    identifiers: [{ type: 'isbn', value: '9789793062792' }],
    agents: [{ type: 'person', name: 'Hirata, Andrea', role: 'aut', isMain: true }],
    subjects: [{ type: 'topic', term: 'Pendidikan', isPrimary: true }],
    links: [],
    items: [{ barcode: 'B0000001', locationCode: 'R1' }],
    marcExtra: [],
  };
}

function itemBody(): Record<string, unknown> {
  return { recordId: OTHER, barcode: 'B0000001', collectionTypeId: COLL };
}

function pageTranslation(): Record<string, unknown> {
  return { title: 'Tentang kami', bodyFormat: 'markdown', body: '# Halo' };
}

function pageBody(): Record<string, unknown> {
  return { kind: 'page', slug: 'tentang-kami', status: 'draft', showInNav: true, sortOrder: 0, translations: { id: pageTranslation() } };
}

function importBody(extra: Record<string, unknown>): Record<string, unknown> {
  return { matchOn: 'isbn', onMatch: 'skip', onDuplicate: 'report', createItems: false, dryRun: true, ...extra };
}

const DB_SOURCE = { kind: 'db', host: 'db.example.org', port: 3306, user: 'slims', password: 'rahasia', database: 'slims', tls: false };

function slimsBody(extra: Record<string, unknown>): Record<string, unknown> {
  return { branchId: BRANCH, allowNonEmpty: false, dryRun: true, ...extra };
}

// ---------------------------------------------------------------------------------------------------------------------

describe('common fields', () => {
  it('utf8Length counts UTF-8 bytes: 1, 2, 3 and 4 per code point', () => {
    expect(utf8Length('')).toBe(0);
    expect(utf8Length('abc')).toBe(3);
    expect(utf8Length('é')).toBe(2);
    expect(utf8Length('€')).toBe(3);
    expect(utf8Length(BOOKS)).toBe(4);
    expect(utf8Length(WIDE)).toBe(60_004);
    // A lone surrogate is written as U+FFFD (3 bytes), as TextEncoder does.
    expect(utf8Length('\ud800')).toBe(3);
    expect(utf8Length('a\udc00b')).toBe(5);
  });

  it('utf8Max refuses with too_big past the byte limit, even when the character count is lower', () => {
    const s = longText;
    expect(TEXT_MAX_BYTES).toBe(60_000);
    expect(ok(s, 'a'.repeat(60_000))).toBe(true);
    expect(errorsOf(s, 'a'.repeat(60_001))).toEqual([{ path: '', code: 'too_big' }]);
    expect(errorsOf(s, BOOKS.repeat(15_000))).toEqual([]);
    expect(errorsOf(s, WIDE)).toEqual([{ path: '', code: 'too_big' }]);
    expect(ok(shortText(10).check(utf8Max(4)), 'abcde')).toBe(false);
  });

  it('longText keeps line breaks and leading spaces, and refuses NUL and the other C0 controls', () => {
    expect(longText.parse('  baris satu\r\n\tbaris dua\n')).toBe('  baris satu\r\n\tbaris dua\n');
    expect(ok(longText, 'a\u0000b')).toBe(false);
    expect(ok(longText, 'a\u0007b')).toBe(false);
    expect(ok(longText, 'a\u007fb')).toBe(false);
  });

  it('shortText trims, counts characters (not bytes) and refuses control characters', () => {
    expect(shortText(5).parse('  abc  ')).toBe('abc');
    expect(ok(shortText(5), BOOKS.repeat(5))).toBe(true);
    expect(ok(shortText(5), BOOKS.repeat(6))).toBe(false);
    expect(ok(shortText(50), 'a\nb')).toBe(false);
    expect(ok(shortText(50), 'a\u0085b')).toBe(false);
  });

  it('codeField: 1-32 printable characters, trimmed', () => {
    expect(codeField.parse(' BUKU ')).toBe('BUKU');
    expect(codeField.parse('KARYA-ILMIAH')).toBe('KARYA-ILMIAH');
    expect(ok(codeField, 'Lt 2')).toBe(true);
    expect(ok(codeField, '')).toBe(false);
    expect(ok(codeField, '   ')).toBe(false);
    expect(ok(codeField, 'A'.repeat(32))).toBe(true);
    expect(ok(codeField, 'A'.repeat(33))).toBe(false);
    expect(ok(codeField, 'A\tB')).toBe(false);
  });

  it('yearField, dateField and priceField', () => {
    expect(ok(yearField, '2005')).toBe(true);
    for (const bad of ['205', '20055', 'c2005', ' 2005']) expect(ok(yearField, bad), bad).toBe(false);
    expect(ok(dateField, '2024-02-29')).toBe(true);
    for (const bad of ['2023-02-29', '2024-13-01', '2024-1-01', '2024-04-31', '01-02-2024']) expect(ok(dateField, bad), bad).toBe(false);
    for (const good of ['0', '125000', '125000.5', '125000.00', '9999999999999.99']) expect(ok(priceField, good), good).toBe(true);
    for (const bad of ['-1', '1.234', '1,5', '.5', '10000000000000', '']) expect(ok(priceField, bad), bad).toBe(false);
  });

  it('cursorQuery: cursor ≤ 200, limit 1-200 read from text, 50 by default', () => {
    const q = z.strictObject({ ...cursorQuery });
    expect(q.parse({})).toEqual({ limit: 50 });
    expect(q.parse({ limit: '200', cursor: 'abc' })).toEqual({ limit: 200, cursor: 'abc' });
    expect(ok(q, { limit: '0' })).toBe(false);
    expect(ok(q, { limit: '201' })).toBe(false);
    expect(ok(q, { cursor: 'x'.repeat(201) })).toBe(false);
  });

  it('pins the shapes of StoreResponse and Paged (S15)', () => {
    expectTypeOf<StoreResponse>().toEqualTypeOf<{ id: string; version: number; warnings?: FieldWarning[] }>();
    expectTypeOf<FieldWarning>().toEqualTypeOf<{ path: string; code: string }>();
    expectTypeOf<Paged<number>>().toEqualTypeOf<{ items: number[]; nextCursor: string | null }>();
    expectTypeOf<ReindexResponse>().toEqualTypeOf<{ jobId: string }>();
    // B3: an item of RecordData carries its location's code, for 852 $c.
    expectTypeOf<RecordData['items'][number]['locationCode']>().toEqualTypeOf<string | null>();
    expectTypeOf<RecordData['publisher']>().toEqualTypeOf<{ id: string; name: string; place?: string } | null>();
  });
});

describe('Review Focus 3: every TEXT-backed field is capped at 60 000 UTF-8 bytes', () => {
  /** [label, schema, body with the field set to the given text]. */
  const cases: [string, Parser, (text: string) => unknown][] = [
    ['records.create title', RecordCreateBody, (t) => ({ ...recordBody(), title: t })],
    ['records.create subtitle', RecordCreateBody, (t) => ({ ...recordBody(), subtitle: t })],
    ['records.create responsibility', RecordCreateBody, (t) => ({ ...recordBody(), responsibility: t })],
    ['records.create summary', RecordCreateBody, (t) => ({ ...recordBody(), summary: t })],
    ['records.create notes', RecordCreateBody, (t) => ({ ...recordBody(), notes: t })],
    ['records.patch summary', RecordPatchBody, (t) => ({ version: 1, summary: t })],
    ['records.patch notes', RecordPatchBody, (t) => ({ version: 1, notes: t })],
    ['draft title', RecordDraft, (t) => ({ ...draft(), title: t })],
    ['draft summary', RecordDraft, (t) => ({ ...draft(), summary: t })],
    ['draft notes', RecordDraft, (t) => ({ ...draft(), notes: t })],
    ['agent note', AgentBody, (t) => ({ type: 'person', name: 'Hirata, Andrea', note: t })],
    ['agent patch note', AgentPatchBody, (t) => ({ version: 2, note: t })],
    ['subject scopeNote', SubjectBody, (t) => ({ type: 'topic', term: 'Pendidikan', scopeNote: t })],
    ['subject patch scopeNote', SubjectPatchBody, (t) => ({ version: 2, scopeNote: t })],
    ['supplier note', SupplierBody, (t) => ({ code: 'SUP1', name: 'CV Buku', note: t })],
    ['supplier address', SupplierBody, (t) => ({ code: 'SUP1', name: 'CV Buku', address: t })],
    ['supplier patch address', SupplierPatchBody, (t) => ({ version: 1, address: t })],
    ['item note', ItemCreateBody, (t) => ({ ...itemBody(), note: t })],
    ['item patch note', ItemPatchBody, (t) => ({ version: 1, note: t })],
    ['attachment description (file)', AttachmentCreateBody, (t) => ({ kind: 'file', fileId: UPLOAD, title: 'PDF', access: 'public', description: t })],
    ['attachment description (url)', AttachmentCreateBody, (t) => ({ kind: 'url', url: 'https://example.org', title: 'Situs', access: 'staff', description: t })],
    ['attachment patch description', AttachmentPatchBody, (t) => ({ version: 1, description: t })],
    ['page body', PageTranslationInput, (t) => ({ ...pageTranslation(), body: t })],
    ['page summary', PageTranslationInput, (t) => ({ ...pageTranslation(), summary: t })],
    ['page create body', PageBody, (t) => ({ ...pageBody(), translations: { id: { ...pageTranslation(), body: t } } })],
    ['page patch en body', PagePatchBody, (t) => ({ version: 3, translations: { en: { ...pageTranslation(), body: t } } })],
    ['page preview body', PagePreviewBody, (t) => ({ bodyFormat: 'html', body: t })],
  ];

  it.each(cases)('%s refuses 15 001 four-byte characters with too_big and accepts 20 000 ASCII characters', (_label, schema, make) => {
    expect(errorsOf(schema, make(NARROW))).toEqual([]);
    const errors = errorsOf(schema, make(WIDE));
    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe('too_big');
  });
});

describe('records', () => {
  it('accepts a full create body and refuses an unknown key at any depth', () => {
    expect(errorsOf(RecordCreateBody, recordBody())).toEqual([]);
    /** The create body with `extra: 1` added to the object at `path` (`[]` = the body itself). */
    const withExtraAt = (path: (string | number)[]): unknown => {
      const body = recordBody();
      let node: unknown = body;
      for (const key of path) node = (node as Record<string | number, unknown>)[key];
      (node as Record<string, unknown>)['extra'] = 1;
      return body;
    };
    const paths: (string | number)[][] = [
      [],
      ['publisher'],
      ['identifiers', 0],
      ['agents', 0],
      ['agents', 0, 'ref'],
      ['agents', 1, 'ref'],
      ['subjects', 0, 'ref'],
      ['subjects', 1],
      ['relations', 0],
      ['marcExtra', 0],
      ['links', 0],
    ];
    for (const path of paths) expect(ok(RecordCreateBody, withExtraAt(path)), path.join('.')).toBe(false);
    // A reference is an id or a description, never both.
    expect(ok(RecordCreateBody, { ...recordBody(), publisher: { id: OTHER, name: 'x' } })).toBe(false);
  });

  it('requires materialTypeId and title', () => {
    const b = recordBody();
    delete b['materialTypeId'];
    delete b['title'];
    expect(errorsOf(RecordCreateBody, b).map((e) => e.path).sort()).toEqual(['materialTypeId', 'title']);
    expect(ok(RecordCreateBody, { materialTypeId: MT, title: '   ' })).toBe(false);
    expect(ok(RecordCreateBody, { materialTypeId: MT, title: 'Judul' })).toBe(true);
  });

  it('bounds the lists: identifiers 50, agents 100, subjects 200, relations 100, marcExtra 500, links 50', () => {
    const many = <T>(n: number, f: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => f(i));
    const base = { materialTypeId: MT, title: 'T' };
    const lists: [string, number, (i: number) => unknown][] = [
      ['identifiers', 50, (i) => ({ type: 'other', value: `X${i}` })],
      ['agents', 100, (i) => ({ ref: { type: 'person', name: `Nama ${i}` }, role: 'aut', isMain: false })],
      ['subjects', 200, (i) => ({ ref: { type: 'topic', term: `Topik ${i}` }, isPrimary: false })],
      ['relations', 100, () => ({ relatedId: OTHER, type: 'related' })],
      ['marcExtra', 500, () => ({ tag: '500', ind1: ' ', ind2: ' ', data: '[]' })],
      ['links', 50, () => ({ url: 'https://example.org' })],
    ];
    for (const [key, max, f] of lists) {
      expect(ok(RecordCreateBody, { ...base, [key]: many(max, f) }), `${key} ${max}`).toBe(true);
      expect(errorsOf(RecordCreateBody, { ...base, [key]: many(max + 1, f) }), `${key} ${max + 1}`).toEqual([{ path: key, code: 'too_big' }]);
    }
  });

  it('S4: a link of any scheme passes the contract (createRecord skips it with invalid_url), but stays ≤ 2000 characters', () => {
    expect(ok(RecordCreateBody, { materialTypeId: MT, title: 'T', links: [{ url: 'javascript:alert(1)' }] })).toBe(true);
    expect(ok(RecordCreateBody, { materialTypeId: MT, title: 'T', links: [{ url: 'https://e.org/' + 'a'.repeat(1986) }] })).toBe(true);
    expect(ok(RecordCreateBody, { materialTypeId: MT, title: 'T', links: [{ url: 'https://e.org/' + 'a'.repeat(1987) }] })).toBe(false);
  });

  it('custom: at most 200 codes of printable ASCII; the server checks the values', () => {
    const codes = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`cf_${i}`, i]));
    expect(ok(RecordCreateBody, { materialTypeId: MT, title: 'T', custom: codes(200) })).toBe(true);
    expect(errorsOf(RecordCreateBody, { materialTypeId: MT, title: 'T', custom: codes(201) })).toEqual([{ path: 'custom', code: 'too_big' }]);
    for (const key of [' x', 'x ', 'a\tb', 'k'.repeat(33), 'kôde']) {
      expect(ok(RecordCreateBody, { materialTypeId: MT, title: 'T', custom: { [key]: 1 } }), JSON.stringify(key)).toBe(false);
    }
    expect(ok(ItemCreateBody, { ...itemBody(), custom: { halaman: [1, 2], catatan: null } })).toBe(true);
  });

  it('source is manual, sru:<server id> or isbn:arsya', () => {
    for (const s of ['manual', 'sru:perpusnas', 'sru:loc', 'isbn:arsya']) expect(ok(RecordCreateBody, { materialTypeId: MT, title: 'T', source: s }), s).toBe(true);
    for (const s of ['slims:12', 'import:X', 'sru:', 'sru:Perpus Nas', 'isbn:other', 'manual ']) {
      expect(ok(RecordCreateBody, { materialTypeId: MT, title: 'T', source: s }), s).toBe(false);
    }
  });

  it('checks the widths of the scalar fields against their columns', () => {
    const base = { materialTypeId: MT, title: 'T' };
    expect(ok(RecordCreateBody, { ...base, edition: 'e'.repeat(191) })).toBe(true);
    expect(ok(RecordCreateBody, { ...base, edition: 'e'.repeat(192) })).toBe(false);
    expect(ok(RecordCreateBody, { ...base, classification: '8'.repeat(65) })).toBe(false);
    expect(ok(RecordCreateBody, { ...base, callNumber: '8'.repeat(65) })).toBe(false);
    expect(ok(RecordCreateBody, { ...base, publicationDateText: 'c'.repeat(65) })).toBe(false);
    expect(ok(RecordCreateBody, { ...base, publicationYear: 'c2005' })).toBe(false);
    expect(ok(RecordCreateBody, { ...base, contentType: 'abcdefghi' })).toBe(false);
    expect(ok(RecordCreateBody, { ...base, identifiers: [{ type: 'isbn', value: '9'.repeat(65) }] })).toBe(false);
    expect(ok(RecordCreateBody, { ...base, identifiers: [{ type: 'barcode', value: '1' }] })).toBe(false);
    expect(ok(RecordCreateBody, { ...base, agents: [{ ref: { type: 'person', name: 'n' }, role: 'xyz', isMain: true }] })).toBe(false);
    expect(ok(RecordCreateBody, { ...base, publisher: null, languageId: null })).toBe(true);
  });

  it('RecordPatchBody: every field optional with the version, links refused', () => {
    expect(ok(RecordPatchBody, { version: 0 })).toBe(true);
    expect(ok(RecordPatchBody, {})).toBe(false);
    expect(ok(RecordPatchBody, { version: 1, title: 'Baru', subtitle: null, agents: [] })).toBe(true);
    expect(errorsOf(RecordPatchBody, { version: 1, links: [{ url: 'https://example.org' }] })).toEqual([{ path: '', code: 'unrecognized_keys' }]);
    const withoutLinks = recordBody();
    delete withoutLinks['links'];
    expect(ok(RecordPatchBody, { version: 4, ...withoutLinks })).toBe(true);
  });

  it('the list query reads text', () => {
    expect(RecordListQuery.parse({ archived: 'true', hasItems: '0', page: '2', changedFrom: '1700000000000', sort: 'title' })).toEqual({
      archived: true,
      hasItems: false,
      page: 2,
      changedFrom: 1_700_000_000_000,
      sort: 'title',
      limit: 50,
    });
    expect(ok(RecordListQuery, { page: '51' })).toBe(false);
    expect(ok(RecordListQuery, { hidden: 'all' })).toBe(false);
    expect(ok(RecordListQuery, { foo: '1' })).toBe(false);
  });

  it('merge, cover and the duplicate check', () => {
    expect(ok(MergeBody, { sourceId: OTHER, version: 1 })).toBe(true);
    expect(ok(CoverBody, { fileId: null, version: 1 })).toBe(true);
    expect(ok(CoverBody, { fileId: 'not-a-ulid', version: 1 })).toBe(false);
    expect(ok(DuplicateCheckBody, { title: 'Laskar', year: '2005', identifiers: [{ type: 'isbn', value: '9789793062792' }], excludeId: OTHER })).toBe(true);
    expect(ok(DuplicateCheckBody, { title: 'Laskar', extra: 1 })).toBe(false);
  });
});

describe('record data', () => {
  it('MarcExtraField: LDR or a 3-digit tag, one-character indicators, data ≤ 9999', () => {
    expect(ok(MarcExtraField, { tag: 'LDR', ind1: ' ', ind2: ' ', data: '00000nam a2200000 a 4500' })).toBe(true);
    expect(ok(MarcExtraField, { tag: '245', ind1: '1', ind2: '4', data: 'd'.repeat(9999) })).toBe(true);
    expect(ok(MarcExtraField, { tag: '245', ind1: '1', ind2: '4', data: 'd'.repeat(10_000) })).toBe(false);
    for (const tag of ['24', '2450', 'ldr', 'ABC']) expect(ok(MarcExtraField, { tag, ind1: ' ', ind2: ' ', data: '' }), tag).toBe(false);
    expect(ok(MarcExtraField, { tag: '245', ind1: '', ind2: ' ', data: '' })).toBe(false);
    expect(ok(MarcExtraField, { tag: '245', ind1: '10', ind2: ' ', data: '' })).toBe(false);
  });

  it('RecordDraft is strict at every depth', () => {
    expect(errorsOf(RecordDraft, draft())).toEqual([]);
    expect(ok(RecordDraft, { ...draft(), materialTypeCode: null, publisher: null })).toBe(true);
    expect(ok(RecordDraft, { ...draft(), extra: 1 })).toBe(false);
    expect(ok(RecordDraft, { ...draft(), publisher: { name: 'B', extra: 1 } })).toBe(false);
    expect(ok(RecordDraft, { ...draft(), items: [{ barcode: 'B1', extra: 1 }] })).toBe(false);
    expect(ok(RecordDraft, { ...draft(), agents: [{ type: 'person', name: 'N', role: 'aut', isMain: true, id: OTHER }] })).toBe(false);
    const missing = draft();
    delete missing['marcExtra'];
    expect(ok(RecordDraft, missing)).toBe(false);
  });
});

describe('attachments', () => {
  it('a file attachment needs fileId, a URL attachment an http(s) url, and neither takes the other', () => {
    expect(ok(AttachmentCreateBody, { kind: 'file', fileId: UPLOAD, title: 'Naskah', access: 'public' })).toBe(true);
    expect(ok(AttachmentCreateBody, { kind: 'url', url: 'https://example.org/a', title: 'Situs', access: 'staff' })).toBe(true);
    expect(errorsOf(AttachmentCreateBody, { kind: 'file', title: 'Naskah', access: 'public' })).toEqual([{ path: 'fileId', code: 'invalid_type' }]);
    expect(ok(AttachmentCreateBody, { kind: 'file', fileId: UPLOAD, url: 'https://example.org', title: 'x', access: 'public' })).toBe(false);
    expect(ok(AttachmentCreateBody, { kind: 'url', fileId: UPLOAD, url: 'https://example.org', title: 'x', access: 'public' })).toBe(false);
    for (const url of ['javascript:alert(1)', 'ftp://example.org/a', 'mailto:a@example.org', '//example.org', 'https://', 'https://exa mple.org']) {
      expect(errorsOf(AttachmentCreateBody, { kind: 'url', url, title: 'x', access: 'public' }), url).toEqual([{ path: 'url', code: 'invalid_url' }]);
    }
    expect(ok(AttachmentCreateBody, { kind: 'url', url: 'https://e.org/' + 'a'.repeat(1987), title: 'x', access: 'public' })).toBe(false);
    expect(ok(AttachmentCreateBody, { kind: 'link', url: 'https://example.org', title: 'x', access: 'public' })).toBe(false);
  });

  it('the patch takes title, description, access and sortOrder with the version', () => {
    expect(ok(AttachmentPatchBody, { version: 1, access: 'staff', sortOrder: 3, title: 'Baru', description: null })).toBe(true);
    expect(ok(AttachmentPatchBody, { version: 1, kind: 'url' })).toBe(false);
    expect(ok(AttachmentPatchBody, { access: 'staff' })).toBe(false);
  });
});

describe('authorities', () => {
  it('agents, subjects and publishers', () => {
    expect(ok(AgentBody, { type: 'person', name: 'Toer, Pramoedya Ananta', dates: '1925-2006', authoritySource: 'lcnaf', authorityRef: 'n80000000' })).toBe(true);
    expect(ok(AgentBody, { type: 'person', name: 'n'.repeat(192) })).toBe(false);
    expect(ok(AgentBody, { type: 'person', name: 'n', dates: 'd'.repeat(65) })).toBe(false);
    expect(ok(AgentBody, { type: 'family', name: 'n' })).toBe(false);
    expect(ok(SubjectBody, { type: 'geographic', term: 'Belitung', classification: '959.8' })).toBe(true);
    expect(ok(PublisherBody, { name: 'Bentang', place: 'Yogyakarta' })).toBe(true);
    expect(ok(PublisherBody, { name: '' })).toBe(false);
    expect(ok(AgentPatchBody, { version: 1, name: 'Baru' })).toBe(true);
    expect(ok(AgentPatchBody, { name: 'Baru' })).toBe(false);
  });

  it('subject relations ≤ 200, merges and orphans ≤ 500', () => {
    const rel = (i: number) => ({ rel: (['bt', 'nt', 'rt'] as const)[i % 3], subjectId: OTHER });
    expect(ok(SubjectRelationsBody, { version: 1, relations: Array.from({ length: 200 }, (_, i) => rel(i)) })).toBe(true);
    expect(ok(SubjectRelationsBody, { version: 1, relations: Array.from({ length: 201 }, (_, i) => rel(i)) })).toBe(false);
    expect(ok(SubjectRelationsBody, { version: 1, relations: [{ rel: 'xx', subjectId: OTHER }] })).toBe(false);
    expect(ok(MergeIntoBody, { intoId: OTHER, version: 2 })).toBe(true);
    expect(ok(OrphansArchiveBody, { kind: 'agents', ids: Array.from({ length: 500 }, id) })).toBe(true);
    expect(ok(OrphansArchiveBody, { kind: 'agents', ids: Array.from({ length: 501 }, id) })).toBe(false);
    expect(ok(OrphansArchiveBody, { kind: 'records', ids: [OTHER] })).toBe(false);
    expect(OrphansQuery.parse({ kind: 'subjects' })).toEqual({ kind: 'subjects', limit: 50 });
    expect(AuthorityListQuery.parse({ q: 'hirata', type: 'person', includeArchived: 'true' })).toEqual({ q: 'hirata', type: 'person', includeArchived: true, limit: 50 });
  });
});

describe('masters', () => {
  const template = { fields: { subtitle: 'required', series: 'hidden' }, defaults: { collectionTypeId: COLL, languageId: LANG }, customFields: ['halaman'] };
  const materialType = {
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
    template,
    sortOrder: 1,
  };

  it('the template names only the §3.8 fields and states, and is strict', () => {
    expect(MaterialTypeTemplate.parse(template)).toEqual(template);
    expect(ok(MaterialTypeTemplate, { fields: {}, defaults: {}, customFields: [] })).toBe(true);
    expect(ok(MaterialTypeTemplate, { ...template, fields: { title: 'required' } })).toBe(false);
    expect(ok(MaterialTypeTemplate, { ...template, fields: { subtitle: 'mandatory' } })).toBe(false);
    expect(ok(MaterialTypeTemplate, { ...template, defaults: { branchId: BRANCH } })).toBe(false);
    expect(ok(MaterialTypeTemplate, { ...template, extra: 1 })).toBe(false);
  });

  it('material types take the RDA codes of the official lists', () => {
    expect(ok(MaterialTypeBody, materialType)).toBe(true);
    expect(ok(MaterialTypeBody, { ...materialType, contentType: 'abc' })).toBe(false);
    expect(ok(MaterialTypeBody, { ...materialType, carrierType: 'txt' })).toBe(false);
    expect(ok(MaterialTypeBody, { ...materialType, marcType: 'ab' })).toBe(false);
    expect(ok(MaterialTypeBody, { ...materialType, schemaType: 'S'.repeat(33) })).toBe(false);
    expect(ok(MaterialTypePatchBody, { version: 1, template })).toBe(true);
  });

  it('languages, collection types and suppliers', () => {
    expect(ok(LanguageBody, { code: 'ind', nameId: 'Indonesia', nameEn: 'Indonesian' })).toBe(true);
    expect(ok(CollectionTypeBody, { code: 'REF', nameId: 'Referensi', nameEn: 'Reference', loanable: true, selfService: false, sortOrder: 2 })).toBe(true);
    expect(ok(SupplierBody, { code: 'SUP1', name: 'CV Buku', email: 'cv@example.org', phone: '0812' })).toBe(true);
    expect(ok(SupplierBody, { code: 'SUP1', name: 'CV Buku', email: 'bukan surel' })).toBe(false);
    expect(ok(SupplierPatchBody, { version: 1, email: null })).toBe(true);
  });

  it('custom fields: a select needs options, the patch cannot change entity or type', () => {
    const field = { entity: 'records', code: 'halaman', type: 'number', labelId: 'Jumlah halaman', required: false, sortOrder: 1, isPublic: true, isSearchable: false };
    expect(ok(CustomFieldBody, field)).toBe(true);
    expect(errorsOf(CustomFieldBody, { ...field, type: 'select' })).toEqual([{ path: 'options', code: 'required' }]);
    expect(errorsOf(CustomFieldBody, { ...field, type: 'multiselect', options: [] })).toEqual([{ path: 'options', code: 'required' }]);
    expect(ok(CustomFieldBody, { ...field, type: 'select', options: [{ value: 'a', labelId: 'A' }, { value: 'b', labelId: 'B', labelEn: 'B (en)' }] })).toBe(true);
    expect(errorsOf(CustomFieldBody, { ...field, type: 'select', options: [{ value: 'a', labelId: 'A' }, { value: 'a', labelId: 'A2' }] })).toEqual([
      { path: 'options.1.value', code: 'duplicate' },
    ]);
    expect(ok(CustomFieldBody, { ...field, entity: 'members' })).toBe(false);
    expect(ok(CustomFieldPatchBody, { version: 1, labelId: 'Halaman' })).toBe(true);
    expect(ok(CustomFieldPatchBody, { version: 1, entity: 'items' })).toBe(false);
    expect(ok(CustomFieldPatchBody, { version: 1, type: 'text' })).toBe(false);
    expect(MasterListQuery.parse({ entity: 'items', includeArchived: 'false' })).toEqual({ entity: 'items', includeArchived: false });
  });

  it('Review Focus 3: the options are stored as JSON in a TEXT column, so their JSON is capped at 60 000 UTF-8 bytes', () => {
    const field = { entity: 'items', code: 'warna', type: 'multiselect', labelId: 'Warna', required: false, sortOrder: 0, isPublic: false, isSearchable: false };
    const options = (label: string) => Array.from({ length: 100 }, (_, i) => ({ value: `v${i}`, labelId: label, labelEn: label }));
    // 100 options with two 100-character labels each: about 22 000 bytes.
    expect(ok(CustomFieldBody, { ...field, options: options('l'.repeat(100)) })).toBe(true);
    // 100 options with two 191-character labels of four-byte characters: each label fits its column, the JSON does not.
    expect(errorsOf(CustomFieldBody, { ...field, options: options(BOOKS.repeat(191)) })).toEqual([{ path: 'options', code: 'too_big' }]);
    expect(errorsOf(CustomFieldPatchBody, { version: 1, options: options(BOOKS.repeat(191)) })).toEqual([{ path: 'options', code: 'too_big' }]);
  });
});

describe('locations', () => {
  const location = { parentId: null, kind: 'room', code: 'R1', name: 'Ruang Baca', isPublic: true, sortOrder: 0 };

  it('the body, its patch and the list query', () => {
    expect(ok(LocationBody, location)).toBe(true);
    expect(ok(LocationBody, { ...location, kind: 'shelf', parentId: OTHER, shelfHint: 'Rak 800-899', classFrom: '800', classTo: '899' })).toBe(true);
    expect(ok(LocationBody, { ...location, shelfHint: 'h'.repeat(41) })).toBe(false);
    expect(ok(LocationBody, { ...location, classFrom: 'c'.repeat(33) })).toBe(false);
    expect(ok(LocationBody, { ...location, kind: 'floor' })).toBe(false);
    expect(ok(LocationPatchBody, { version: 1, name: 'Ruang Referensi' })).toBe(true);
    expect(LocationListQuery.parse({ branchId: BRANCH, includeArchived: 'true' })).toEqual({ branchId: BRANCH, includeArchived: true });
  });

  it('the map: a box in permil within the picture', () => {
    expect(ok(LocationMapBody, { version: 1, floorPlanFileId: UPLOAD })).toBe(true);
    expect(ok(LocationMapBody, { version: 1, box: { x: 0, y: 0, w: 1000, h: 1000 } })).toBe(true);
    expect(ok(LocationMapBody, { version: 1, box: null, floorPlanFileId: null })).toBe(true);
    expect(ok(LocationMapBody, { version: 1, box: { x: -1, y: 0, w: 10, h: 10 } })).toBe(false);
    expect(ok(LocationMapBody, { version: 1, box: { x: 0, y: 0, w: 1001, h: 10 } })).toBe(false);
    expect(errorsOf(LocationMapBody, { version: 1, box: { x: 900, y: 0, w: 200, h: 10 } })).toEqual([{ path: 'box.w', code: 'too_big' }]);
    expect(errorsOf(LocationMapBody, { version: 1, box: { x: 0, y: 950, w: 10, h: 51 } })).toEqual([{ path: 'box.h', code: 'too_big' }]);
    expect(ok(LocationMapBody, { version: 1, box: { x: 0.5, y: 0, w: 10, h: 10 } })).toBe(false);
  });
});

describe('items', () => {
  it('the create body defaults status to available and partsTotal to 1', () => {
    expect(ItemCreateBody.parse(itemBody())).toEqual({ ...itemBody(), status: 'available', partsTotal: 1 });
    expect(ok(ItemCreateBody, { ...itemBody(), price: '125000.00', currency: 'IDR', acqSource: 'gift', orderDate: '2024-01-31', partsTotal: 99 })).toBe(true);
    expect(ok(ItemCreateBody, { ...itemBody(), partsTotal: 100 })).toBe(false);
    expect(ok(ItemCreateBody, { ...itemBody(), price: '1.234' })).toBe(false);
    expect(ok(ItemCreateBody, { ...itemBody(), currency: 'idr' })).toBe(false);
    expect(ok(ItemCreateBody, { ...itemBody(), status: 'on_loan' })).toBe(false);
    expect(ok(ItemCreateBody, { ...itemBody(), barcode: '' })).toBe(false);
  });

  it('the patch has no recordId and no defaults', () => {
    expect(ItemPatchBody.parse({ version: 1 })).toEqual({ version: 1 });
    expect(ok(ItemPatchBody, { version: 1, recordId: OTHER })).toBe(false);
    expect(ok(ItemPatchBody, { version: 1, status: 'missing', locationId: null })).toBe(true);
  });

  it('a batch takes exactly one of patternId and barcodes', () => {
    const template = { collectionTypeId: COLL };
    expect(ok(ItemBatchBody, { recordId: OTHER, count: 100, patternId: 'default', template })).toBe(true);
    expect(ok(ItemBatchBody, { recordId: OTHER, count: 2, barcodes: ['A1', 'A2'], template })).toBe(true);
    expect(errorsOf(ItemBatchBody, { recordId: OTHER, count: 2, patternId: 'default', barcodes: ['A1', 'A2'], template })).toEqual([
      { path: 'barcodes', code: 'exclusive' },
    ]);
    expect(errorsOf(ItemBatchBody, { recordId: OTHER, count: 2, template })).toEqual([{ path: 'patternId', code: 'required' }]);
    expect(errorsOf(ItemBatchBody, { recordId: OTHER, count: 3, barcodes: ['A1', 'A2'], template })).toEqual([{ path: 'barcodes', code: 'count_mismatch' }]);
    expect(ok(ItemBatchBody, { recordId: OTHER, count: 101, patternId: 'default', template })).toBe(false);
    expect(ok(ItemBatchBody, { recordId: OTHER, count: 1, patternId: 'default', template: { ...template, barcode: 'X' } })).toBe(false);
    expect(ok(ItemBatchBody, { recordId: OTHER, count: 1, patternId: 'default', template: { ...template, recordId: OTHER } })).toBe(false);
  });

  it('a bulk change takes ≤ 500 ids and at least one change', () => {
    expect(ok(ItemBulkBody, { ids: Array.from({ length: 500 }, id), set: { status: 'missing' } })).toBe(true);
    expect(ok(ItemBulkBody, { ids: Array.from({ length: 501 }, id), set: { status: 'missing' } })).toBe(false);
    expect(errorsOf(ItemBulkBody, { ids: [OTHER], set: {} })).toEqual([{ path: 'set', code: 'required' }]);
    expect(ok(ItemBulkBody, { ids: [OTHER], set: { price: '1' } })).toBe(false);
  });

  it('M2: the barcode lookup is a query of 1-200 characters; the list query reads text', () => {
    expect(ItemByBarcodeQuery.parse({ barcode: 'B/01' })).toEqual({ barcode: 'B/01' });
    expect(ok(ItemByBarcodeQuery, { barcode: '' })).toBe(false);
    expect(ok(ItemByBarcodeQuery, { barcode: 'b'.repeat(201) })).toBe(false);
    expect(ItemListQuery.parse({ status: 'available', limit: '10' })).toEqual({ status: 'available', limit: 10 });
  });
});

describe('runs, exchange, copy, labels', () => {
  it('runs', () => {
    expect(RunListQuery.parse({ kind: 'import' })).toEqual({ kind: 'import', limit: 50 });
    expect(ok(DedupeScanBody, {})).toBe(true);
    expect(ok(DedupeScanBody, { all: true })).toBe(false);
  });

  it('S3: an import names exactly one of uploadId and fromRunId', () => {
    expect(ok(ImportBody, importBody({ uploadId: UPLOAD }))).toBe(true);
    expect(ok(ImportBody, importBody({ fromRunId: RUN, dryRun: false }))).toBe(true);
    expect(errorsOf(ImportBody, importBody({ uploadId: UPLOAD, fromRunId: RUN }))).toEqual([{ path: 'fromRunId', code: 'exclusive' }]);
    expect(errorsOf(ImportBody, importBody({}))).toEqual([{ path: 'uploadId', code: 'required' }]);
    expect(ok(ImportBody, importBody({ uploadId: UPLOAD, format: 'csv-slims', branchId: BRANCH, createItems: true }))).toBe(true);
    expect(ok(ImportBody, importBody({ uploadId: UPLOAD, format: 'marcjson' }))).toBe(false);
    expect(ok(ImportBody, importBody({ uploadId: UPLOAD, matchOn: 'title' }))).toBe(false);
  });

  it('an export filter takes ≤ 1000 record ids and refuses unknown keys', () => {
    expect(ok(ExportBody, { format: 'marcjson', filter: { recordIds: Array.from({ length: 1000 }, id), includeItems: true } })).toBe(true);
    expect(ok(ExportBody, { format: 'marc21', filter: { recordIds: Array.from({ length: 1001 }, id) } })).toBe(false);
    expect(ok(ExportBody, { format: 'csv-slims', filter: {} })).toBe(false);
    expect(ok(ExportBody, { format: 'marc21', filter: { since: 1 } })).toBe(false);
    expect(MarcFormatQuery.parse({ format: 'json' })).toEqual({ format: 'json' });
    expect(ok(MarcFormatQuery, { format: 'pdf' })).toBe(false);
  });

  it('M9: MarcJsonRecord is MARC-in-JSON', () => {
    const rec: MarcJsonRecord = {
      leader: '00000nam a2200000 a 4500',
      fields: [{ '001': 'X' }, { '245': { ind1: '1', ind2: '0', subfields: [{ a: 'Laskar Pelangi' }] } }],
    };
    expect(rec.fields).toHaveLength(2);
  });

  it('SRU search and test', () => {
    expect(SruSearchQuery.parse({ server: 'perpusnas', index: 'isbn', q: '9789793062792', start: '21' })).toEqual({
      server: 'perpusnas',
      index: 'isbn',
      q: '9789793062792',
      start: 21,
    });
    expect(ok(SruSearchQuery, { server: 'perpusnas', index: 'subject', q: 'x' })).toBe(false);
    expect(ok(SruSearchQuery, { server: 'perpusnas', index: 'any', q: '' })).toBe(false);
    expect(ok(SruSearchQuery, { server: 'perpusnas', index: 'any', q: 'q'.repeat(201) })).toBe(false);
    expect(ok(SruSearchQuery, { server: 'perpusnas', index: 'any', q: 'x', start: '0' })).toBe(false);
    expect(ok(SruTestBody, { url: 'http://lx2.loc.gov:210/LCDB', version: '1.1' })).toBe(true);
    expect(ok(SruTestBody, { url: 'file:///etc/passwd', version: '1.1' })).toBe(false);
    expect(ok(SruTestBody, { url: 'https://example.org/sru', version: '3.0' })).toBe(false);
  });

  it('a label request names exactly one of itemIds and recordIds', () => {
    expect(ok(LabelBody, { profileId: 'spine', itemIds: [OTHER], startPosition: 1, copies: 1 })).toBe(true);
    expect(ok(LabelBody, { profileId: 'spine', recordIds: Array.from({ length: 10_000 }, () => OTHER), startPosition: 4, copies: 5 })).toBe(true);
    expect(errorsOf(LabelBody, { profileId: 'spine', itemIds: [OTHER], recordIds: [OTHER], startPosition: 1, copies: 1 })).toEqual([
      { path: 'recordIds', code: 'exclusive' },
    ]);
    expect(errorsOf(LabelBody, { profileId: 'spine', startPosition: 1, copies: 1 })).toEqual([{ path: 'itemIds', code: 'required' }]);
    expect(ok(LabelBody, { profileId: 'spine', itemIds: Array.from({ length: 10_001 }, () => OTHER), startPosition: 1, copies: 1 })).toBe(false);
    expect(ok(LabelBody, { profileId: 'spine', itemIds: [OTHER], startPosition: 0, copies: 1 })).toBe(false);
    expect(ok(LabelBody, { profileId: 'spine', itemIds: [OTHER], startPosition: 1, copies: 6 })).toBe(false);
  });
});

describe('SLiMS migration', () => {
  it('a source is a database or a dump upload', () => {
    expect(ok(SlimsDbInput, DB_SOURCE)).toBe(true);
    expect(ok(SlimsDbInput, { kind: 'dump', uploadId: UPLOAD })).toBe(true);
    expect(ok(SlimsDbInput, { ...DB_SOURCE, port: 0 })).toBe(false);
    expect(ok(SlimsDbInput, { ...DB_SOURCE, port: 65_536 })).toBe(false);
    expect(ok(SlimsDbInput, { ...DB_SOURCE, password: 'p'.repeat(201) })).toBe(false);
    expect(ok(SlimsDbInput, { kind: 'dump', uploadId: UPLOAD, host: 'x' })).toBe(false);
    expect(ok(SlimsTestBody, { source: DB_SOURCE })).toBe(true);
    expect(ok(SlimsTestBody, { source: { kind: 'dump', uploadId: UPLOAD } })).toBe(false);
  });

  it('defaults: sourceName slims, priceMode major', () => {
    const parsed = SlimsStartBody.parse(slimsBody({ source: DB_SOURCE }));
    expect(parsed.sourceName).toBe('slims');
    expect(parsed.priceMode).toBe('major');
  });

  it('S3: fromRunId refuses filesUploadId and a dump source (exclusive); without it a source is required', () => {
    expect(ok(SlimsStartBody, slimsBody({ source: DB_SOURCE, filesUploadId: UPLOAD }))).toBe(true);
    expect(ok(SlimsStartBody, slimsBody({ source: { kind: 'dump', uploadId: UPLOAD }, filesUploadId: UPLOAD }))).toBe(true);
    expect(ok(SlimsStartBody, slimsBody({ fromRunId: RUN, dryRun: false }))).toBe(true);
    expect(ok(SlimsStartBody, slimsBody({ fromRunId: RUN, source: DB_SOURCE, dryRun: false }))).toBe(true);
    expect(errorsOf(SlimsStartBody, slimsBody({ fromRunId: RUN, filesUploadId: UPLOAD }))).toEqual([{ path: 'filesUploadId', code: 'exclusive' }]);
    expect(errorsOf(SlimsStartBody, slimsBody({ fromRunId: RUN, source: { kind: 'dump', uploadId: UPLOAD } }))).toEqual([
      { path: 'source', code: 'exclusive' },
    ]);
    expect(errorsOf(SlimsStartBody, slimsBody({}))).toEqual([{ path: 'source', code: 'required' }]);
    expect(errorsOf(SlimsStartBody, slimsBody({ filesUploadId: UPLOAD }))).toEqual([{ path: 'source', code: 'required' }]);
  });

  it('S13: sourceName is 1-40 of a-z 0-9 _ - (never a colon, so it cannot pass for an import:<runId> source)', () => {
    expect(ok(SlimsStartBody, slimsBody({ source: DB_SOURCE, sourceName: 'kampus-2' }))).toBe(true);
    expect(ok(SlimsStartBody, slimsBody({ source: DB_SOURCE, sourceName: 's'.repeat(40) }))).toBe(true);
    for (const bad of ['', 's'.repeat(41), 'import:01', 'Kampus', 'kampus 2', '-x']) {
      expect(ok(SlimsStartBody, slimsBody({ source: DB_SOURCE, sourceName: bad })), bad).toBe(false);
    }
    expect(ok(SlimsStartBody, slimsBody({ source: DB_SOURCE, priceMode: 'cents' }))).toBe(false);
  });
});

describe('pages', () => {
  it('the slug, the translations and the strictness', () => {
    expect(ok(PageBody, pageBody())).toBe(true);
    expect(ok(PageBody, { ...pageBody(), publishedAt: 1_700_000_000_000, coverFileId: UPLOAD, translations: { id: pageTranslation(), en: pageTranslation() } })).toBe(true);
    for (const slug of ['Tentang', 'tentang kami', 'tentang_kami', '', 'a'.repeat(192)]) expect(ok(PageBody, { ...pageBody(), slug }), slug).toBe(false);
    expect(ok(PageBody, { ...pageBody(), slug: 'a'.repeat(191) })).toBe(true);
    expect(ok(PageBody, { ...pageBody(), translations: { en: pageTranslation() } })).toBe(false);
    expect(ok(PageBody, { ...pageBody(), translations: { id: pageTranslation(), fr: pageTranslation() } })).toBe(false);
    expect(ok(PageBody, { ...pageBody(), translations: { id: { ...pageTranslation(), title: 't'.repeat(192) } } })).toBe(false);
    expect(ok(PagePatchBody, { version: 2, status: 'published', translations: { en: null } })).toBe(true);
    expect(ok(PagePatchBody, { version: 2, translations: { id: null } })).toBe(false);
    expect(PageListQuery.parse({ kind: 'news', status: 'published' })).toEqual({ kind: 'news', status: 'published', limit: 50 });
    expect(ok(PageListQuery, {})).toBe(false);
  });
});

describe('free-text query values', () => {
  // A search text ends up in a SQL parameter (LIKE, a key prefix) on every dialect: PostgreSQL TEXT refuses NUL, so a
  // control character is a field error here, never a 500 there. Spaces around the text are trimmed.
  const cases: [string, Parser, (q: string) => unknown][] = [
    ['records list q', RecordListQuery, (q) => ({ q })],
    ['authorities list q', AuthorityListQuery, (q) => ({ q })],
    ['masters list q', MasterListQuery, (q) => ({ q })],
    ['export filter q', ExportBody, (q) => ({ format: 'marc21', filter: { q } })],
    ['SRU search q', SruSearchQuery, (q) => ({ server: 'perpusnas', index: 'any', q })],
    ['items list barcodePrefix', ItemListQuery, (barcodePrefix) => ({ barcodePrefix })],
  ];

  it.each(cases)('%s refuses NUL and other control characters', (_label, schema, make) => {
    expect(ok(schema, make('laskar "pelangi" -novel'))).toBe(true);
    for (const q of ['laskar\u0000', 'a\nb', 'a\u0085b']) expect(ok(schema, make(q)), JSON.stringify(q)).toBe(false);
  });
});
