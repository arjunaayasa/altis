import { fullTextClear, fullTextFamily, withTx, type DB, type DbHandle } from '@altis/db';
import { newId } from '@altis/shared';
import type { Transaction } from 'kysely';
import { agentNameKey, publisherNameKey, subjectTermKey } from '../../src/catalog/data/keys.js';
import { titleKey } from '../../src/catalog/lib/title-key.js';
import { indexRecords } from '../../src/search/index-records.js';
import { addSearchTermsBatch, clearSearchTerms, finishSearchTerms } from '../../src/search/terms.js';
import { SEARCH_TOKEN_VERSION } from '../../src/search/tokenize.js';
import type { CatalogSearchQuery } from '../../src/search/types.js';

// The search corpus of acceptance K8 (Phase 2 spec §15, §4): 208 records written straight into the catalogue tables and
// indexed through indexRecords, and 39 queries with the record sets they must return, on every dialect (§4.3: result
// sets are compared, not relevance orders). Task 15 runs it on SQLite (db/search-query.test.ts); Task 39 runs the same
// module on MariaDB and PostgreSQL. The expectations are written by hand from the records below, never computed by the
// search code, and the filler records use a vocabulary that no hand-written query word can reach.
//
// seedCatalog is the general writer the other search tests use too: records with their authorities (found or made by
// key), identifiers, live or archived items and their locations.

/** The ISBN-13 of 12 digits plus its check digit. */
export function isbn13(body: string): string {
  let sum = 0;
  for (let i = 0; i < 12; i += 1) sum += Number(body[i]) * (i % 2 === 0 ? 1 : 3);
  return body + String((10 - (sum % 10)) % 10);
}

/** The ISBN-10 of 9 digits plus its check character. */
export function isbn10(body: string): string {
  let sum = 0;
  for (let i = 0; i < 9; i += 1) sum += (10 - i) * Number(body[i]);
  const r = (11 - (sum % 11)) % 11;
  return body + (r === 10 ? 'X' : String(r));
}

/** The ISSN of 7 digits plus its check character. */
export function issn(body: string): string {
  let sum = 0;
  for (let i = 0; i < 7; i += 1) sum += (8 - i) * Number(body[i]);
  const r = (11 - (sum % 11)) % 11;
  return body + (r === 10 ? 'X' : String(r));
}

/** An item of a seeded record. */
export interface SeedItem {
  barcode: string;
  /** Default `available`. */
  status?: string;
  /** Default the seeding branch. */
  branchId?: string;
  locationId?: string | null;
  /** A collection type's code (default `UMUM`). */
  collectionType?: string;
  callNumber?: string | null;
  archived?: boolean;
}

/** A record to seed: what the search reads, the rest left empty. */
export interface SeedRecord {
  key: string;
  title: string;
  subtitle?: string;
  series?: string;
  agents?: (string | { name: string; type?: 'person' | 'organization' | 'meeting' })[];
  subjects?: (string | { term: string; classification?: string })[];
  publisher?: { name: string; place?: string };
  place?: string;
  year?: string;
  classification?: string;
  callNumber?: string;
  identifiers?: { type: 'isbn' | 'issn' | 'doi' | 'control' | 'other'; display: string; key: string; valid?: boolean }[];
  summary?: string;
  notes?: string;
  /** A material type's code (default `BUKU`). */
  materialType?: string;
  /** A language's code (`IND`, `ENG`, …), else none. */
  language?: string;
  hidden?: boolean;
  archived?: boolean;
  /** The key of the record it was merged into (it is archived too). */
  mergedInto?: string;
  /** Default: one minute after the previous record. */
  createdAt?: number;
  items?: SeedItem[];
}

const CHUNK = 300;
const MINUTE = 60_000;

/**
 * Empties the catalogue and the search index (FTS5 `'delete-all'` first, as every wipe of `search_doc` must), the
 * custom fields (of records and items, and the member fields a SLiMS run makes with them), and the jobs, locks and events a reindex leaves. Branches stay.
 */
export async function wipeCatalog(h: DbHandle): Promise<void> {
  await withTx(h, async (trx) => {
    await fullTextClear(trx, fullTextFamily(trx));
    for (const table of ['search_facet', 'search_doc', 'search_term', 'search_state', 'custom_values', 'attachments', 'item_events', 'items'] as const) {
      await trx.deleteFrom(table).execute();
    }
    await trx.deleteFrom('custom_field_defs').where('entity', 'in', ['records', 'items', 'members']).execute();
    for (const table of ['record_identifiers', 'record_marc_extra', 'record_agents', 'record_subjects', 'record_relations', 'records'] as const) {
      await trx.deleteFrom(table).execute();
    }
    for (const table of ['agents', 'subject_relations', 'subjects', 'publishers', 'locations', 'files', 'jobs', 'locks', 'events'] as const) {
      await trx.deleteFrom(table).execute();
    }
  });
}

/** The id of the row of `table` with `code_key`, cached per call. */
async function codeId(trx: Transaction<DB>, table: 'material_types' | 'languages' | 'collection_types', code: string): Promise<string> {
  const row = await trx.selectFrom(table).select('id').where('code_key', '=', code).executeTakeFirst();
  if (row === undefined) throw new Error(`seedCatalog: no ${table} row ${code}`);
  return row.id;
}

/**
 * Writes `records` (and the authorities, identifiers and items they name) at `o.now`, then indexes them; returns each
 * key's record id. `o.branchId` is the branch of the items (a branch `PUSAT` is made when it is absent and none is
 * given). `o.index === false` leaves them unindexed.
 */
export async function seedCatalog(
  h: DbHandle,
  records: readonly SeedRecord[],
  o: { now: number; branchId?: string; index?: boolean },
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const r of records) ids.set(r.key, newId(o.now));
  const branchId =
    o.branchId ??
    (await withTx(h, async (trx) => {
      const found = await trx.selectFrom('branches').select('id').where('code_key', '=', 'PUSAT').executeTakeFirst();
      if (found !== undefined) return found.id;
      const id = newId(o.now);
      await trx
        .insertInto('branches')
        .values({ id, code_key: 'PUSAT', code_display: 'PUSAT', name: 'Pusat', address: null, timezone: 'Asia/Jakarta', archived_at: null, created_at: o.now, created_by: null, updated_at: o.now, updated_by: null })
        .execute();
      return id;
    }));
  const trail = { archived_at: null, version: 0, created_at: o.now, created_by: null, updated_at: o.now, updated_by: null };
  let clock = o.now;

  for (let start = 0; start < records.length; start += CHUNK) {
    const chunk = records.slice(start, start + CHUNK);
    await withTx(h, async (trx) => {
      const codes = new Map<string, string>();
      const code = async (table: 'material_types' | 'languages' | 'collection_types', c: string): Promise<string> => {
        const k = `${table}:${c}`;
        if (!codes.has(k)) codes.set(k, await codeId(trx, table, c));
        return codes.get(k)!;
      };
      const authority = new Map<string, string>();
      const agentId = async (name: string, type: string): Promise<string> => {
        const key = agentNameKey(name);
        const k = `a:${type}:${key}`;
        if (authority.has(k)) return authority.get(k)!;
        const found = await trx.selectFrom('agents').select('id').where('type', '=', type).where('name_key', '=', key).executeTakeFirst();
        const id = found?.id ?? newId(o.now);
        if (found === undefined) {
          await trx
            .insertInto('agents')
            .values({ id, type, name_display: name, name_key: key, dates: null, authority_source: null, authority_ref: null, note: null, merged_into: null, ...trail })
            .execute();
        }
        authority.set(k, id);
        return id;
      };
      const subjectId = async (term: string, classification: string | null): Promise<string> => {
        const key = subjectTermKey(term);
        const k = `s:${key}`;
        if (authority.has(k)) return authority.get(k)!;
        const found = await trx.selectFrom('subjects').select('id').where('type', '=', 'topic').where('term_key', '=', key).executeTakeFirst();
        const id = found?.id ?? newId(o.now);
        if (found === undefined) {
          await trx
            .insertInto('subjects')
            .values({ id, type: 'topic', term_display: term, term_key: key, classification, scope_note: null, authority_source: null, merged_into: null, ...trail })
            .execute();
        }
        authority.set(k, id);
        return id;
      };
      const publisherId = async (name: string, place: string | null): Promise<string> => {
        const key = publisherNameKey(name);
        const k = `p:${key}`;
        if (authority.has(k)) return authority.get(k)!;
        const found = await trx.selectFrom('publishers').select('id').where('name_key', '=', key).executeTakeFirst();
        const id = found?.id ?? newId(o.now);
        if (found === undefined) {
          await trx.insertInto('publishers').values({ id, name_display: name, name_key: key, place, merged_into: null, ...trail }).execute();
        }
        authority.set(k, id);
        return id;
      };

      const rows = [];
      for (const r of chunk) {
        clock = r.createdAt ?? clock + MINUTE;
        const archived = r.archived === true || r.mergedInto !== undefined;
        rows.push({
          id: ids.get(r.key)!,
          material_type_id: await code('material_types', r.materialType ?? 'BUKU'),
          title: r.title,
          subtitle: r.subtitle ?? null,
          responsibility: null,
          title_key: titleKey(r.title, r.subtitle ?? null),
          edition: null,
          material_detail: null,
          publisher_id: r.publisher === undefined ? null : await publisherId(r.publisher.name, r.publisher.place ?? null),
          publication_place: r.place ?? null,
          publication_year: r.year ?? null,
          publication_date_text: r.year ?? null,
          physical_desc: null,
          series: r.series ?? null,
          classification: r.classification ?? null,
          call_number: r.callNumber ?? null,
          language_id: r.language === undefined ? null : await code('languages', r.language),
          content_type: null,
          media_type: null,
          carrier_type: null,
          summary: r.summary ?? null,
          notes: r.notes ?? null,
          cover_file_id: null,
          opac_visible: r.hidden === true ? 0 : 1,
          promoted: 0,
          source: 'manual',
          merged_into: r.mergedInto === undefined ? null : ids.get(r.mergedInto)!,
          changed_at: clock,
          archived_at: archived ? clock : null,
          version: 0,
          created_at: clock,
          created_by: null,
          updated_at: clock,
          updated_by: null,
        });
      }
      await trx.insertInto('records').values(rows).execute();

      for (const r of chunk) {
        const recordId = ids.get(r.key)!;
        const identifiers = (r.identifiers ?? []).map((i, n) => ({
          id: newId(o.now),
          record_id: recordId,
          type: i.type,
          value_display: i.display,
          value_key: i.key,
          qualifier: null,
          is_valid: i.valid === false ? 0 : 1,
          sort_order: n,
        }));
        if (identifiers.length > 0) await trx.insertInto('record_identifiers').values(identifiers).execute();
        const agents = [];
        for (const [n, a] of (r.agents ?? []).entries()) {
          const { name, type } = typeof a === 'string' ? { name: a, type: 'person' as const } : { name: a.name, type: a.type ?? 'person' };
          agents.push({ record_id: recordId, agent_id: await agentId(name, type), role: 'aut', is_main: n === 0 ? 1 : 0, sort_order: n });
        }
        if (agents.length > 0) await trx.insertInto('record_agents').values(agents).execute();
        const subjects = [];
        for (const [n, s] of (r.subjects ?? []).entries()) {
          const { term, classification } = typeof s === 'string' ? { term: s, classification: null } : { term: s.term, classification: s.classification ?? null };
          subjects.push({ record_id: recordId, subject_id: await subjectId(term, classification), is_primary: n === 0 ? 1 : 0, sort_order: n });
        }
        if (subjects.length > 0) await trx.insertInto('record_subjects').values(subjects).execute();
        const items = [];
        for (const item of r.items ?? []) {
          items.push({
            id: newId(o.now),
            record_id: recordId,
            branch_id: item.branchId ?? branchId,
            barcode_display: item.barcode,
            barcode_key: item.barcode.toUpperCase(),
            inventory_no: null,
            call_number: item.callNumber ?? null,
            location_id: item.locationId ?? null,
            collection_type_id: await code('collection_types', item.collectionType ?? 'UMUM'),
            status: item.status ?? 'available',
            status_note: null,
            parts_total: 1,
            acq_source: null,
            order_no: null,
            order_date: null,
            received_date: null,
            invoice_date: null,
            supplier_id: null,
            invoice_no: null,
            price: null,
            currency: null,
            note: null,
            archived_at: item.archived === true ? o.now : null,
            version: 0,
            created_at: o.now,
            created_by: null,
            updated_at: o.now,
            updated_by: null,
          });
        }
        if (items.length > 0) await trx.insertInto('items').values(items).execute();
      }
      if (o.index !== false) await indexRecords(trx, chunk.map((r) => ids.get(r.key)!), o.now);
    });
  }
  return ids;
}

/**
 * Builds `search_term` from the documents (terms.ts, the way `catalog.reindex` does it) and marks `search_state`
 * ready, so that a seeded catalogue searches as a rebuilt one (spelling included).
 */
export async function finishSeededIndex(h: DbHandle, now: number): Promise<void> {
  await withTx(h, (trx) => clearSearchTerms(trx));
  for (let after: number | null = 0; after !== null; ) {
    const from: number = after;
    after = await withTx(h, (trx) => addSearchTermsBatch(trx, from));
  }
  await withTx(h, async (trx) => {
    await finishSearchTerms(trx);
    await trx.deleteFrom('search_state').execute();
    const docs = await trx.selectFrom('search_doc').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow();
    await trx.insertInto('search_state').values({ id: 1, status: 'ready', docs: Number(docs.n), job_id: null, built_at: now, token_version: SEARCH_TOKEN_VERSION }).execute();
  });
}

// ---------------------------------------------------------------------------------------------------------------
// The K8 corpus

/** `978-979-3062-79-2`, the ISBN of Laskar Pelangi in this corpus. */
export const LASKAR_ISBN = isbn13('978979306279');
export const LASKAR_ISBN_HYPHENS = `${LASKAR_ISBN.slice(0, 3)}-${LASKAR_ISBN.slice(3, 6)}-${LASKAR_ISBN.slice(6, 10)}-${LASKAR_ISBN.slice(10, 12)}-${LASKAR_ISBN.slice(12)}`;
/** An ISBN-10 (`979-22-3040-8`) and its 13-digit key. */
export const KAMUS_ISBN10 = isbn10('979223040');
export const KAMUS_ISBN10_HYPHENS = `${KAMUS_ISBN10.slice(0, 3)}-${KAMUS_ISBN10.slice(3, 5)}-${KAMUS_ISBN10.slice(5, 9)}-${KAMUS_ISBN10.slice(9)}`;
export const KAMUS_ISBN_KEY = isbn13(`978${KAMUS_ISBN10.slice(0, 9)}`);
/** An ISSN (`0215-9481`). */
export const JURNAL_ISSN = issn('0215948');
export const JURNAL_ISSN_HYPHEN = `${JURNAL_ISSN.slice(0, 4)}-${JURNAL_ISSN.slice(4)}`;

const NOVEL = 'Novel Indonesia';
const BENTANG = { name: 'Bentang Pustaka', place: 'Yogyakarta' };

/** The hand-written records, each with a key the queries name. */
export const CORPUS_RECORDS: readonly SeedRecord[] = [
  {
    key: 'laskar-pelangi',
    title: 'Laskar Pelangi',
    agents: ['Hirata, Andrea'],
    subjects: [NOVEL, 'Pendidikan'],
    publisher: BENTANG,
    year: '2005',
    classification: '899.221',
    callNumber: '899.221 HIR',
    identifiers: [{ type: 'isbn', display: LASKAR_ISBN_HYPHENS, key: LASKAR_ISBN }],
    language: 'IND',
    items: [{ barcode: 'B0000101' }],
  },
  { key: 'sang-pemimpi', title: 'Sang Pemimpi', agents: ['Hirata, Andrea'], subjects: [NOVEL], publisher: BENTANG, year: '2006', classification: '899.221', language: 'IND' },
  { key: 'edensor', title: 'Edensor', agents: ['Hirata, Andrea'], subjects: [NOVEL], year: '2007', classification: '899.221', language: 'IND' },
  { key: 'pelangi-jakarta', title: 'Pelangi di Langit Jakarta', agents: ['Wulandari, Sinta'], subjects: ['Puisi'], publisher: { name: 'Gramedia Pustaka Utama' } },
  { key: 'laskar-rakyat', title: 'Laskar Rakyat dalam Revolusi', agents: ['Kusuma, Bayu'], subjects: ['Sejarah Indonesia'], publisher: { name: 'Balai Pustaka' } },
  { key: 'bumi-manusia', title: 'Bumi Manusia', agents: ['Toer, Pramoedya Ananta'], subjects: [NOVEL], publisher: { name: 'Hasta Mitra' }, year: '1980' },
  { key: 'anak-semua-bangsa', title: 'Anak Semua Bangsa', agents: ['Toer, Pramoedya Ananta'], subjects: [NOVEL], publisher: { name: 'Hasta Mitra' }, year: '1981' },
  { key: 'filsafat-pendidikan', title: 'Filsafat Pendidikan Islam', agents: ['Nata, Abuddin'], subjects: ['Pendidikan Islam'] },
  { key: 'psikologi-pendidikan', title: 'Psikologi Pendidikan', agents: ['Santrock, John'], subjects: ['Psikologi'] },
  { key: 'pendidikan-karakter', title: 'Pendidikan Karakter di Sekolah', agents: ['Lickona, Thomas'], subjects: ['Pendidikan'] },
  { key: 'kurikulum', title: 'Pengembangan Kurikulum', agents: ['Hamalik, Oemar'], subjects: ['Pendidikan'] },
  { key: 'ai-pemula', title: 'AI untuk Pemula', agents: ['Russell, Stuart'], subjects: ['Kecerdasan Buatan'] },
  { key: 'pemrograman-c', title: 'Pemrograman C dan C++', agents: ['Kernighan, Brian'], subjects: ['Pemrograman Komputer'] },
  { key: 'bahasa-go', title: 'Belajar Bahasa Go', agents: ['Donovan, Alan'], subjects: ['Pemrograman Komputer'] },
  { key: 'art-programming', title: 'The Art of Computer Programming', agents: ['Knuth, Donald'], subjects: ['Algoritma'], language: 'ENG' },
  { key: 'hobbit', title: 'The Hobbit', agents: ['Tolkien, John Ronald Reuel'], subjects: ['Fiksi Fantasi'], language: 'ENG' },
  { key: 'nandu', title: 'Ñandú dan Burung Lainnya', agents: ['Herrera, Lucía'], subjects: ['Burung'] },
  { key: 'cafe', title: 'Café di Ujung Jalan', agents: ['Anwar, Rizal'], subjects: ['Cerpen'] },
  { key: 'ensiklopedia-novel', title: 'Ensiklopedia Novel Dunia', agents: ['Hartono, Dewi'], subjects: ['Sastra Dunia'] },
  {
    key: 'jurnal',
    title: 'Jurnal Pendidikan Nasional',
    publisher: { name: 'Kementerian Pendidikan' },
    identifiers: [{ type: 'issn', display: JURNAL_ISSN_HYPHEN, key: JURNAL_ISSN }],
    materialType: 'BERSERI',
  },
  { key: 'kamus', title: 'Kamus Bahasa Indonesia', identifiers: [{ type: 'isbn', display: KAMUS_ISBN10_HYPHENS, key: KAMUS_ISBN_KEY }] },
  { key: 'isbn-notes', title: 'Catatan Perjalanan', notes: 'Terjemahan dari edisi ISBN 978-0-306-40615-7.' },
  { key: 'sejarah-pendidikan', title: 'Sejarah Pendidikan Indonesia', subjects: ['Sejarah Indonesia', 'Pendidikan'] },
  { key: 'atlas', title: 'Atlas Nusantara Lengkap', materialType: 'PETA', items: [{ barcode: 'B0000777' }] },
  // Not public: hidden from the OPAC, archived, merged (archived too).
  { key: 'laskar-rahasia', title: 'Laskar Rahasia', agents: ['Hirata, Andrea'], hidden: true },
  { key: 'laskar-arsip', title: 'Laskar Arsip', archived: true },
  { key: 'laskar-gabung', title: 'Laskar Pelangi Cetak Ulang', mergedInto: 'laskar-pelangi' },
];

const FILLER_TOPICS = ['Pertanian', 'Perikanan', 'Kesehatan', 'Ekonomi', 'Geografi', 'Matematika', 'Fisika', 'Kimia', 'Biologi', 'Arsitektur', 'Peternakan', 'Kehutanan'];
const FILLER_CLASSES = ['630', '639', '613', '330', '910', '510', '530', '540', '570', '720', '636', '634'];
const FILLER_AUTHORS = ['Wijaya, Budi', 'Santoso, Agus', 'Lestari, Wening', 'Pratama, Rudi', 'Susanto, Eko', 'Rahmawati, Fitri'];

/** 180 filler records (`koleksi-<topic>-<n>`): 12 topics × 15 volumes, none reachable by a hand-written query word. */
export const FILLER_RECORDS: readonly SeedRecord[] = FILLER_TOPICS.flatMap((topic, t) =>
  Array.from({ length: 15 }, (_, n): SeedRecord => ({
    key: `koleksi-${topic.toLowerCase()}-${n + 1}`,
    title: `Koleksi ${topic} Jilid ${n + 1}`,
    agents: [FILLER_AUTHORS[(t + n) % FILLER_AUTHORS.length]!],
    subjects: [topic],
    publisher: { name: 'Penerbit Nusantara', place: 'Bandung' },
    year: String(1990 + ((t * 15 + n) % 30)),
    classification: FILLER_CLASSES[t]!,
    summary: `Buku koleksi perpustakaan tentang ${topic.toLowerCase()}.`,
    items: [{ barcode: `F${String(t * 15 + n + 1).padStart(6, '0')}` }],
  })),
);

export const ALL_CORPUS_RECORDS: readonly SeedRecord[] = [...CORPUS_RECORDS, ...FILLER_RECORDS];

const HIDDEN_KEYS = ['laskar-rahasia', 'laskar-arsip', 'laskar-gabung'];
/** Every public record (what the OPAC may find). */
export const PUBLIC_KEYS: readonly string[] = ALL_CORPUS_RECORDS.map((r) => r.key).filter((k) => !HIDDEN_KEYS.includes(k));
const FILLER_KEYS = FILLER_RECORDS.map((r) => r.key);
const HIRATA = ['laskar-pelangi', 'sang-pemimpi', 'edensor'];
const TOER = ['bumi-manusia', 'anak-semua-bangsa'];
const NOVEL_KEYS = [...HIRATA, ...TOER, 'ensiklopedia-novel'];
const PENDIDIKAN = ['laskar-pelangi', 'filsafat-pendidikan', 'psikologi-pendidikan', 'pendidikan-karakter', 'kurikulum', 'jurnal', 'sejarah-pendidikan'];

/** One K8 query: its text (and scope/filters), the keys it must find (as a set), and its typo correction. */
export interface CorpusQuery {
  q: string;
  scope?: CatalogSearchQuery['scope'];
  filters?: CatalogSearchQuery['filters'];
  expect: readonly string[];
  correction?: { to: string; applied: boolean } | null;
}

export const CORPUS_QUERIES: readonly CorpusQuery[] = [
  { q: 'laskar', expect: ['laskar-pelangi', 'laskar-rakyat'] },
  { q: '"laskar pelangi"', expect: ['laskar-pelangi'] },
  { q: 'Laskar Pelangi', expect: ['laskar-pelangi'] },
  { q: 'pelangi', expect: ['laskar-pelangi', 'pelangi-jakarta'] },
  { q: 'laskar OR edensor', expect: ['laskar-pelangi', 'laskar-rakyat', 'edensor'] },
  { q: 'laskar ATAU edensor', expect: ['laskar-pelangi', 'laskar-rakyat', 'edensor'] },
  { q: 'pengarang:hirata', expect: HIRATA },
  { q: 'author:Hirata', expect: HIRATA },
  { q: 'hirata -edensor', expect: ['laskar-pelangi', 'sang-pemimpi'] },
  { q: '-novel', expect: PUBLIC_KEYS.filter((k) => !NOVEL_KEYS.includes(k)) },
  { q: 'novel -hirata', expect: [...TOER, 'ensiklopedia-novel'] },
  { q: '"novel indonesia" -hirata', expect: TOER },
  { q: 'pendidkan', expect: PENDIDIKAN, correction: { to: 'pendidikan', applied: true } },
  { q: 'pendidikan', expect: PENDIDIKAN, correction: null },
  { q: 'judul:pendidikan', expect: ['filsafat-pendidikan', 'psikologi-pendidikan', 'pendidikan-karakter', 'jurnal', 'sejarah-pendidikan'] },
  { q: 'subjek:pendidikan', expect: ['laskar-pelangi', 'filsafat-pendidikan', 'pendidikan-karakter', 'kurikulum', 'sejarah-pendidikan'] },
  { q: 'pendidikan islam', expect: ['filsafat-pendidikan'] },
  { q: 'AI', expect: ['ai-pemula'] },
  { q: 'C', expect: ['pemrograman-c'] },
  { q: 'C++', expect: ['pemrograman-c'] },
  { q: 'go', expect: ['bahasa-go'] },
  { q: 'the', expect: ['art-programming', 'hobbit'] },
  { q: 'nandu', expect: ['nandu'] },
  { q: 'Ñandú', expect: ['nandu'] },
  { q: 'cafe', expect: ['cafe'] },
  { q: LASKAR_ISBN_HYPHENS, expect: ['laskar-pelangi'] },
  { q: LASKAR_ISBN, expect: ['laskar-pelangi'] },
  { q: `isbn:${LASKAR_ISBN_HYPHENS}`, expect: ['laskar-pelangi'] },
  { q: KAMUS_ISBN10_HYPHENS, expect: ['kamus'] },
  { q: JURNAL_ISSN_HYPHEN, expect: ['jurnal'] },
  { q: '9780306406157', expect: ['isbn-notes'] },
  { q: 'penerbit:bentang', expect: ['laskar-pelangi', 'sang-pemimpi'] },
  { q: 'pemrog*', expect: ['pemrograman-c', 'bahasa-go'] },
  { q: 'toer', expect: TOER },
  { q: '"pramoedya ananta toer"', expect: TOER },
  { q: 'nomor:B0000777', expect: ['atlas'] },
  { q: 'koleksi', expect: FILLER_KEYS },
  { q: 'sejarah', expect: ['laskar-rakyat', 'sejarah-pendidikan'] },
  { q: 'zzzxqy', expect: [], correction: null },
  {
    q: 'laskar',
    scope: 'admin',
    filters: { includeArchived: true, includeHidden: true },
    expect: ['laskar-pelangi', 'laskar-rakyat', 'laskar-rahasia', 'laskar-arsip', 'laskar-gabung'],
  },
];
