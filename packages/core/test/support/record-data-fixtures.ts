// RecordData fixtures for the bibliographic renderers (Phase 2 Task 22) and the tasks that use them (the OPAC detail,
// OAI-PMH): a stored record as `loadRecordData` answers it, built in memory. The base record is a book with one
// author, a publisher and place, a year, one ISBN, two subjects and a summary; every test changes only what it needs.
import type { RecordData } from '@altis/shared/api/catalog/record-data';

type Agent = RecordData['agents'][number];
type Subject = RecordData['subjects'][number];
type Attachment = RecordData['attachments'][number];

/** The options every renderer takes, for a record at RENDER_CANONICAL. */
export const RENDER_BASE_URL = 'https://perpus.example.id';
export const RENDER_RECORD_ID = '01JRENDERREC0000000000001A';
export const RENDER_CANONICAL = `${RENDER_BASE_URL}/katalog/${RENDER_RECORD_ID}/laskar-pelangi-sebuah-novel`;

export const RENDER_OPTIONS: { baseUrl: string; canonicalUrl: string; locale: 'id' | 'en'; coverUrl: string | null } = Object.freeze({
  baseUrl: RENDER_BASE_URL,
  canonicalUrl: RENDER_CANONICAL,
  locale: 'id',
  coverUrl: null,
});

/** The seeded material types (migration 0027) by code: name (id), name (en), leader/06-07, schema.org, DCMI. */
const MATERIAL_TYPES: Readonly<Record<string, RecordData['materialType']>> = Object.freeze({
  BUKU: { id: '01JRENDERMT00000000000BUKU', code: 'BUKU', nameId: 'Buku', nameEn: 'Book', marcType: 'a', marcLevel: 'm', schemaType: 'Book', dcmiType: 'Text' },
  'KARYA-ILMIAH': {
    id: '01JRENDERMT00000000000KILM',
    code: 'KARYA-ILMIAH',
    nameId: 'Karya ilmiah',
    nameEn: 'Academic work',
    marcType: 'a',
    marcLevel: 'm',
    schemaType: 'Thesis',
    dcmiType: 'Text',
  },
  BERSERI: {
    id: '01JRENDERMT00000000000SERI',
    code: 'BERSERI',
    nameId: 'Terbitan berseri',
    nameEn: 'Serial',
    marcType: 'a',
    marcLevel: 's',
    schemaType: 'Periodical',
    dcmiType: 'Text',
  },
  PETA: { id: '01JRENDERMT00000000000PETA', code: 'PETA', nameId: 'Peta', nameEn: 'Map', marcType: 'e', marcLevel: 'm', schemaType: 'Map', dcmiType: 'Image' },
});

/** The material type of a seeded code (`BUKU`, `KARYA-ILMIAH`, `BERSERI`, `PETA`). */
export function materialType(code: 'BUKU' | 'KARYA-ILMIAH' | 'BERSERI' | 'PETA'): RecordData['materialType'] {
  return { ...MATERIAL_TYPES[code]! };
}

let agentSeq = 0;

/** An agent (a person by default) with role `aut`, not the main entry unless `isMain` says so. */
export function agent(name: string, over: Partial<Agent> = {}): Agent {
  agentSeq += 1;
  return { id: `01JRENDERAGENT${String(agentSeq).padStart(12, '0')}`, type: 'person', name, role: 'aut', isMain: false, ...over };
}

let subjectSeq = 0;

/** A subject, a topic by default. */
export function subject(term: string, over: Partial<Subject> = {}): Subject {
  subjectSeq += 1;
  return { id: `01JRENDERSUBJ${String(subjectSeq).padStart(13, '0')}`, type: 'topic', term, isPrimary: false, ...over };
}

let attachmentSeq = 0;

/** A public URL attachment of `url` (stored as is: the renderers must re-check the scheme, S4). */
export function urlAttachment(url: string, over: Partial<Attachment> = {}): Attachment {
  attachmentSeq += 1;
  return { id: `01JRENDERATT${String(attachmentSeq).padStart(14, '0')}`, kind: 'url', fileId: null, url, title: 'Tautan', access: 'public', mime: null, ...over };
}

/** A valid ISBN-13 and ISSN (the check characters are right). */
export const RENDER_ISBN = '978-602-291-135-7';
export const RENDER_ISBN_KEY = '9786022911357';
export const RENDER_ISSN = '1411-4348';

/** The base record: "Laskar pelangi : sebuah novel" by Andrea Hirata (Bentang, Yogyakarta, 2010), changed by `over`. */
export function recordData(over: Partial<RecordData> = {}): RecordData {
  return {
    id: RENDER_RECORD_ID,
    createdAt: 1_760_000_000_000,
    updatedAt: 1_760_000_100_000,
    changedAt: 1_760_000_100_000,
    opacVisible: true,
    promoted: false,
    archived: false,
    mergedInto: null,
    materialTypeCode: 'BUKU',
    materialType: materialType('BUKU'),
    title: 'Laskar pelangi',
    subtitle: 'sebuah novel',
    responsibility: 'Andrea Hirata',
    publisher: { id: '01JRENDERPUBLISHER00000001', name: 'Bentang', place: 'Yogyakarta' },
    publicationPlace: 'Yogyakarta',
    publicationYear: '2010',
    physicalDesc: 'xii, 529 hlm. ; 20 cm',
    classification: '899.2213',
    callNumber: '899.2213 HIR l',
    languageCode: 'ind',
    language: { code: 'ind', nameId: 'Indonesia', nameEn: 'Indonesian' },
    summary: 'Kisah sepuluh anak di sebuah pulau timah.',
    notes: 'Novel pertama dari sebuah tetralogi.',
    identifiers: [{ type: 'isbn', value: RENDER_ISBN }],
    agents: [agent('Hirata, Andrea', { isMain: true })],
    subjects: [subject('Fiksi Indonesia', { isPrimary: true }), subject('Belitung', { type: 'geographic' })],
    links: [],
    items: [],
    marcExtra: [],
    coverFileId: null,
    attachments: [],
    relations: [],
    customPublic: [],
    ...over,
  };
}
