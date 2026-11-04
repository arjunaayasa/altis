import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { once } from 'node:events';
import { withTx, type DB, type DbHandle } from '@altis/db';
import { newId } from '../../../packages/shared/src/index.js';
import type { Insertable, Transaction } from 'kysely';
import {
  MARCXML_COLLECTION_CLOSE,
  MARCXML_COLLECTION_OPEN,
  agentNameKey,
  codeKey,
  localStorageDriver,
  publisherNameKey,
  subjectTermKey,
  titleKey,
  writeMarcXmlRecord,
  type MarcDataField,
  type MarcRecord,
} from '../../../packages/core/src/index.js';
import { FIXTURE_TABLES } from '../../../packages/core/test/support/slims-fixture/schema.js';

// The seed `perf-phase2` of acceptance K9 and K16 (Phase 2 spec §15; plan Task 39): a catalogue of 100 000 records,
// 150 000 items, 50 000 agents, 20 000 subjects and 2 000 attachments, generated from fixed formulas, so one count
// always gives the same catalogue (titles, names, years, barcodes), and smaller counts (`perfCounts(scale)`) give the
// same shape for a quick run.
//
// Three ways to the data, one per question:
//
// - seedPhase2(h, …) — the K9 catalogue, written straight into the tables of an installed database in multi-row
//   batches (one transaction per RECORD_BATCH records with their identifiers, agents, subjects, items and item
//   history), the keys made by the very functions the services use (titleKey, agentNameKey, subjectTermKey,
//   publisherNameKey, codeKey), the attachment files stored through the local storage driver. It leaves the search
//   index empty: run.ts then rebuilds it with the release's own `node app.js catalog:reindex` (the real sliced
//   `catalog.reindex`, search_term included), whose duration is part of the report.
// - writePerfMarcXml(file, …) — the import mode of K16 (and K5's 100 000-record MARCXML): the same catalogue as one
//   MARCXML file (Task 6's writer) with its items in 952 and its links in 856, for `POST catalog/imports` with
//   `createItems`, which takes every record through the real write path (createRecord, find-or-create of the
//   authorities, createItem, the synchronous index, the duplicate check).
// - writePerfSlimsDump(file, …) — the migration mode of K16: the same catalogue as a SLiMS 9 mysqldump (the table and
//   column layout of the synthetic fixture's schema, packages/core/test/support/slims-fixture/schema.ts), for
//   `node app.js slims:import --dump`.
//
// Both files are written as a stream, one batch at a time: memory stays flat whatever the count.

/** The counts of the seed (spec §15 K9). */
export const PERF_PHASE2_SEED = Object.freeze({
  name: 'perf-phase2',
  records: 100_000,
  items: 150_000,
  agents: 50_000,
  subjects: 20_000,
  attachments: 2_000,
});

export interface PerfCounts {
  records: number;
  items: number;
  agents: number;
  subjects: number;
  attachments: number;
}

/** The most of each the formulas below keep distinct (ISBN body, barcode digits, name syllables). */
export const PERF_COUNT_MAX = Object.freeze({ records: 999_999, items: 9_999_999, agents: 1_048_576, subjects: 1_000_000, attachments: 999_999 });

/**
 * The seed's counts times `scale` (rounded, each at least 1, attachments at most the records), e.g. 0.01 → 1 000
 * records, 1 500 items, 500 agents, 200 subjects, 20 attachments.
 *
 * @throws RangeError for a scale that is not a positive finite number, or one that goes past {@link PERF_COUNT_MAX}
 */
export function perfCounts(scale = 1): PerfCounts {
  if (!Number.isFinite(scale) || scale <= 0) throw new RangeError(`perfCounts: scale ${String(scale)} is not a positive number`);
  const of = (n: number): number => Math.max(1, Math.round(n * scale));
  const counts = { records: of(PERF_PHASE2_SEED.records), items: of(PERF_PHASE2_SEED.items), agents: of(PERF_PHASE2_SEED.agents), subjects: of(PERF_PHASE2_SEED.subjects), attachments: of(PERF_PHASE2_SEED.attachments) };
  counts.attachments = Math.min(counts.attachments, counts.records);
  checkCounts(counts);
  return counts;
}

/** @throws RangeError for a count that is not a positive integer within {@link PERF_COUNT_MAX} (items may be 0) */
export function checkCounts(c: PerfCounts): void {
  for (const key of ['records', 'items', 'agents', 'subjects', 'attachments'] as const) {
    const v = c[key];
    const min = key === 'items' || key === 'attachments' ? 0 : 1;
    if (!Number.isSafeInteger(v) || v < min || v > PERF_COUNT_MAX[key]) throw new RangeError(`perf counts: ${key} ${String(v)} is out of range`);
  }
  if (c.attachments > c.records) throw new RangeError('perf counts: more attachments than records');
}

// ---------------------------------------------------------------------------------------------------------------------
// The generator (pure)

/** A small seeded generator (mulberry32): the same seed, the same numbers. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** An index into a list of `n` that favours the start (a Zipf-like spread: a few words are very common). */
function skewed(u: number, n: number, power = 2.4): number {
  return Math.min(n - 1, Math.floor(n * u ** power));
}

/** Common words of Indonesian titles, the most frequent first (written for this seed). */
export const WORDS_ID = Object.freeze([
  'pendidikan', 'indonesia', 'sejarah', 'pengantar', 'dasar', 'metode', 'sistem', 'pengembangan', 'manajemen', 'analisis',
  'hukum', 'ekonomi', 'masyarakat', 'bahasa', 'teknologi', 'pembelajaran', 'kebijakan', 'budaya', 'agama', 'kesehatan',
  'penelitian', 'teori', 'praktik', 'anak', 'sosial', 'politik', 'pertanian', 'lingkungan', 'informasi', 'komunikasi',
  'matematika', 'fisika', 'kimia', 'biologi', 'sastra', 'seni', 'islam', 'negara', 'daerah', 'pembangunan',
  'keuangan', 'akuntansi', 'pemasaran', 'industri', 'perusahaan', 'koperasi', 'perbankan', 'pajak', 'administrasi', 'publik',
  'desa', 'kota', 'pesisir', 'hutan', 'laut', 'pulau', 'sungai', 'gunung', 'tanah', 'air',
  'guru', 'siswa', 'sekolah', 'kurikulum', 'evaluasi', 'strategi', 'model', 'media', 'perencanaan', 'pengelolaan',
  'perpustakaan', 'arsip', 'dokumentasi', 'katalog', 'klasifikasi', 'literasi', 'membaca', 'menulis', 'cerita', 'puisi',
  'novel', 'kumpulan', 'kamus', 'ensiklopedia', 'panduan', 'pedoman', 'modul', 'latihan', 'soal', 'jawaban',
  'filsafat', 'etika', 'psikologi', 'konseling', 'keluarga', 'perempuan', 'pemuda', 'tradisi', 'adat', 'kearifan',
  'nusantara', 'jawa', 'sumatra', 'kalimantan', 'sulawesi', 'papua', 'bali', 'maluku', 'aceh', 'minangkabau',
  'perang', 'kemerdekaan', 'revolusi', 'kolonial', 'kerajaan', 'raja', 'rakyat', 'bangsa', 'tokoh', 'biografi',
  'kesehatan', 'gizi', 'penyakit', 'obat', 'tanaman', 'hewan', 'ikan', 'padi', 'kopi', 'rempah',
  'energi', 'listrik', 'mesin', 'konstruksi', 'bangunan', 'jalan', 'transportasi', 'jaringan', 'komputer', 'program',
  'data', 'statistika', 'aljabar', 'geometri', 'kalkulus', 'logika', 'algoritma', 'pemrograman', 'basis', 'digital',
  'zaman', 'abad', 'modern', 'klasik', 'baru', 'lama', 'awal', 'akhir', 'jalan', 'cahaya',
]);

/** Common words of English titles. */
export const WORDS_EN = Object.freeze([
  'introduction', 'history', 'theory', 'practice', 'management', 'development', 'education', 'research', 'methods', 'policy',
  'economics', 'society', 'culture', 'language', 'science', 'health', 'technology', 'information', 'systems', 'analysis',
  'indonesia', 'southeast', 'asia', 'islam', 'politics', 'law', 'reading', 'writing', 'learning', 'teaching',
  'handbook', 'guide', 'principles', 'foundations', 'advanced', 'modern', 'classical', 'world', 'global', 'local',
]);

/** Words for summaries (besides the title words). */
const SUMMARY_LINKS = Object.freeze(['ini', 'membahas', 'tentang', 'yang', 'dengan', 'untuk', 'dari', 'serta', 'bagi', 'dalam', 'buku', 'kajian']);

/** Syllables of the generated names (32: five bits each). */
const SYLLABLES = Object.freeze([
  'su', 'ri', 'wa', 'ti', 'da', 'ni', 'ra', 'ma', 'ha', 'di', 'sa', 'to', 'ka', 'ya', 'na', 'pu',
  'ar', 'in', 'an', 'li', 'ja', 'yo', 'ba', 'ru', 'ge', 'lo', 'we', 'tu', 'me', 'si', 'ko', 'de',
]);

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** A word made of syllables from the bits of `n` (`width` syllables): distinct for each n below 32^width. */
function syllableWord(n: number, width: number): string {
  let out = '';
  for (let k = 0; k < width; k += 1) out += SYLLABLES[Math.floor(n / 32 ** k) % 32]!;
  return out;
}

/** The name of agent `k` (0-based): `Given Family`, distinct for every k below 2^20. */
export function perfAgentName(k: number): string {
  return `${cap(syllableWord(k % 1024, 2))} ${cap(syllableWord(Math.floor(k / 1024), 2))}${k % 7 === 0 ? 'wan' : ''}`;
}

/** Agent `k` is an organization for one in fifty, a person otherwise. */
export function perfAgentType(k: number): 'person' | 'organization' {
  return k % 50 === 49 ? 'organization' : 'person';
}

const TOPICS = Object.freeze([
  'Pendidikan', 'Sejarah', 'Hukum', 'Ekonomi', 'Pertanian', 'Kesehatan', 'Agama Islam', 'Bahasa Indonesia', 'Sastra', 'Seni',
  'Teknologi informasi', 'Lingkungan hidup', 'Politik', 'Sosiologi', 'Antropologi', 'Psikologi', 'Matematika', 'Fisika', 'Kimia', 'Biologi',
  'Perpustakaan', 'Manajemen', 'Akuntansi', 'Perbankan', 'Koperasi', 'Pariwisata', 'Perikanan', 'Kehutanan', 'Peternakan', 'Pertambangan',
  'Arsitektur', 'Teknik sipil', 'Energi', 'Transportasi', 'Komunikasi', 'Jurnalistik', 'Filsafat', 'Etika', 'Kebudayaan', 'Adat istiadat',
  'Keluarga', 'Anak', 'Perempuan', 'Kepemudaan', 'Olahraga', 'Musik', 'Tari', 'Kuliner', 'Kerajinan', 'Geografi',
]);
const ASPECTS = Object.freeze([
  'Sejarah', 'Kebijakan', 'Penelitian', 'Pengajaran', 'Kamus', 'Panduan', 'Statistik', 'Biografi', 'Peraturan', 'Ekonomi',
  'Aspek sosial', 'Teknologi', 'Organisasi', 'Studi kasus', 'Esai', 'Bibliografi', 'Evaluasi', 'Perencanaan', 'Pengelolaan', 'Teori',
]);
const PLACES = Object.freeze([
  'Indonesia', 'Jawa Barat', 'Jawa Tengah', 'Jawa Timur', 'Sumut', 'Sumbar', 'Aceh', 'Riau', 'Kaltim', 'Sulsel',
  'Bali', 'NTT', 'Maluku', 'Papua', 'Jakarta', 'Yogyakarta', 'Banten', 'Lampung', 'Bengkulu', 'Gorontalo',
]);

/**
 * The term of subject `k` (0-based): `Topic -- Aspect -- Place`, distinct for every k below 20 000 (then numbered), at
 * most 50 characters below 20 000 (SLiMS `mst_topic.topic` is a varchar(50)).
 */
export function perfSubjectTerm(k: number): string {
  const base = `${TOPICS[k % 50]} -- ${ASPECTS[Math.floor(k / 50) % 20]} -- ${PLACES[Math.floor(k / 1000) % 20]}`;
  return k < 20_000 ? base : `${base} ${Math.floor(k / 20_000)}`;
}

/** The DDC-like class of a subject's topic. */
function topicClass(k: number): string {
  return `${String((k % 50) * 19 % 1000).padStart(3, '0')}`;
}

const CITIES = Object.freeze([
  'Jakarta', 'Bandung', 'Yogyakarta', 'Surabaya', 'Semarang', 'Medan', 'Malang', 'Makassar', 'Padang', 'Denpasar',
  'Bogor', 'Solo', 'Palembang', 'Pekanbaru', 'Banjarmasin', 'Pontianak', 'Manado', 'Ambon', 'Jayapura', 'Kupang',
]);

/** The publishers of the seed (fixed, independent of the counts). */
export const PERF_PUBLISHERS = 2_000;

/** The name of publisher `k`. */
export function perfPublisherName(k: number): string {
  const kinds = ['Penerbit', 'Pustaka', 'Media', 'Press', 'Grafika'];
  return k % 5 === 3 ? `${cap(syllableWord(k, 3))} Press` : `${kinds[k % 5]} ${cap(syllableWord(k, 3))}`;
}

/** The ISBN-13 of `body` (12 digits) with its check digit. */
export function isbn13(body: string): string {
  let sum = 0;
  for (let i = 0; i < 12; i += 1) sum += Number(body[i]) * (i % 2 === 0 ? 1 : 3);
  return body + String((10 - (sum % 10)) % 10);
}

/** The material types the seed spreads its records over, by the codes of 0027 (§2.6), and their share in 20. */
const MATERIAL_SPREAD = Object.freeze(['BUKU', 'BUKU', 'BUKU', 'BUKU', 'BUKU', 'BUKU', 'BUKU', 'BUKU', 'BUKU', 'BUKU', 'BUKU', 'BUKU', 'BUKU', 'BUKU', 'BUKU', 'KARYA-ILMIAH', 'KARYA-ILMIAH', 'EBOOK', 'BERSERI', 'PETA']);
/** The languages, by the codes of 0027, and their share in 20. */
const LANGUAGE_SPREAD = Object.freeze(['IND', 'IND', 'IND', 'IND', 'IND', 'IND', 'IND', 'IND', 'IND', 'IND', 'IND', 'IND', 'IND', 'IND', 'IND', 'ENG', 'ENG', 'ENG', 'JAV', 'ARA']);

/** One generated record (what every one of the three writers takes). */
export interface PerfRecord {
  /** 0-based. */
  n: number;
  title: string;
  subtitle: string | null;
  responsibility: string | null;
  materialType: string;
  language: string;
  agents: { k: number; role: 'aut' | 'edt'; isMain: boolean }[];
  subjects: { k: number; isPrimary: boolean }[];
  publisher: number;
  place: string;
  year: string;
  edition: string | null;
  physicalDesc: string;
  series: string | null;
  classification: string;
  callNumber: string;
  isbn: string | null;
  summary: string | null;
  promoted: boolean;
  hidden: boolean;
  archived: boolean;
  /** Its items: the 0-based item numbers. */
  items: number[];
  /** Its attachment, when it has one: a stored file or a link. */
  attachment: 'file' | 'url' | null;
}

/** The first item number of record `n` and how many it has: F(n+1) − F(n) with F(x) = ⌊x · items / records⌋. */
export function itemRange(n: number, c: PerfCounts): { first: number; count: number } {
  const f = (x: number): number => Math.floor((x * c.items) / c.records);
  return { first: f(n), count: f(n + 1) - f(n) };
}

/** Whether record `n` has an attachment: every ⌊records / attachments⌋-th, `attachments` of them, files and links alternating. */
export function attachmentOf(n: number, c: PerfCounts): 'file' | 'url' | null {
  if (c.attachments === 0) return null;
  const stride = Math.floor(c.records / c.attachments);
  if (n % stride !== 0 || n / stride >= c.attachments) return null;
  return (n / stride) % 2 === 0 ? 'file' : 'url';
}

/** The unique word of record `n` (a made-up word no other record has): a search for it finds exactly that record. */
export function perfUniqueWord(n: number): string {
  return `${syllableWord(n, 4)}x`;
}

/** Record `n` (0-based) of a catalogue of counts `c`. */
export function perfRecord(n: number, c: PerfCounts): PerfRecord {
  const r = prng(n * 2_654_435_761 + 97);
  const english = LANGUAGE_SPREAD[n % 20] === 'ENG';
  const words = english ? WORDS_EN : WORDS_ID;
  const length = 2 + Math.floor(r() * 4);
  const picked: string[] = [];
  while (picked.length < length) {
    const w = words[skewed(r(), words.length)]!;
    if (!picked.includes(w)) picked.push(w);
  }
  // Every other title carries the record's own made-up word (as real titles carry names and rare words).
  if (n % 2 === 0) picked.splice(1 + Math.floor(r() * (picked.length - 1)), 0, perfUniqueWord(n));
  const title = cap(picked.join(' '));
  const subtitle = r() < 0.3 ? cap(`${words[skewed(r(), words.length)]!} ${english ? 'and' : 'dan'} ${words[skewed(r(), words.length)]!}`) : null;
  const main = n % c.agents;
  const agents: PerfRecord['agents'] = [{ k: main, role: 'aut', isMain: true }];
  if (r() < 0.25) {
    const co = (n * 31 + 17) % c.agents;
    if (co !== main) agents.push({ k: co, role: r() < 0.5 ? 'aut' : 'edt', isMain: false });
  }
  const subjects: PerfRecord['subjects'] = [{ k: (n * 13) % c.subjects, isPrimary: true }];
  for (const [p, mul, add] of [[0.5, 29, 7], [0.2, 53, 11]] as const) {
    const k = (n * mul + add) % c.subjects;
    if (r() < p && !subjects.some((s) => s.k === k)) subjects.push({ k, isPrimary: false });
  }
  const year = String(2026 - skewed(r(), 66, 1.6));
  const cls = topicClass(subjects[0]!.k);
  const classification = `${cls}.${Math.floor(r() * 100)}`;
  const agentName = perfAgentName(main);
  const callNumber = `${classification} ${agentName.slice(0, 3).toUpperCase()} ${title.charAt(0).toLowerCase()}`;
  const summary =
    r() < 0.3
      ? cap(
          `${SUMMARY_LINKS[n % 12]} ${picked.join(' ')} ${Array.from({ length: 12 + Math.floor(r() * 10) }, () => (r() < 0.6 ? words[skewed(r(), words.length)]! : SUMMARY_LINKS[Math.floor(r() * 12)]!)).join(' ')}.`,
        )
      : null;
  const range = itemRange(n, c);
  return {
    n,
    title,
    subtitle,
    responsibility: agentName,
    materialType: MATERIAL_SPREAD[(n * 7) % 20]!,
    language: LANGUAGE_SPREAD[n % 20]!,
    agents,
    subjects,
    publisher: skewed(r(), PERF_PUBLISHERS, 1.8),
    place: CITIES[skewed(r(), CITIES.length, 1.5)]!,
    year,
    edition: r() < 0.15 ? `Ed. ${2 + Math.floor(r() * 4)}` : null,
    physicalDesc: `${80 + Math.floor(r() * 400)} hlm. ; ${[21, 23, 24, 25][Math.floor(r() * 4)]} cm`,
    series: r() < 0.1 ? `Seri ${cap(words[skewed(r(), words.length)]!)}` : null,
    classification,
    callNumber,
    isbn: n % 4 === 3 ? null : isbn13(`978602${String(n).padStart(6, '0')}`),
    summary,
    promoted: n % 2_000 === 1_000,
    hidden: n % 97 === 96,
    archived: n % 211 === 210,
    items: Array.from({ length: range.count }, (_, j) => range.first + j),
    attachment: attachmentOf(n, c),
  };
}

/** The barcode of item `j` (0-based). */
export function perfBarcode(j: number): string {
  return `P2${String(j + 1).padStart(7, '0')}`;
}

/** What an item of record `rec` looks like (the status spread of a library open to the public). */
export function perfItem(j: number, rec: PerfRecord): { barcode: string; branch: 0 | 1; status: string; collectionType: string; supplier: number | null; price: number | null } {
  const r = prng(j * 40_503 + 11);
  const u = r();
  const status = u < 0.9 ? 'available' : u < 0.94 ? 'not_for_loan' : u < 0.96 ? 'repair' : u < 0.98 ? 'missing' : 'processing';
  return {
    barcode: perfBarcode(j),
    branch: rec.n % 5 === 4 ? 1 : 0,
    status,
    collectionType: rec.materialType === 'KARYA-ILMIAH' ? 'REF' : r() < 0.2 ? 'FIKSI' : r() < 0.1 ? 'REF' : 'UMUM',
    supplier: r() < 0.3 ? Math.floor(r() * PERF_SUPPLIERS) : null,
    price: r() < 0.4 ? (25 + Math.floor(r() * 200)) * 1000 : null,
  };
}

/** The suppliers of the seed; their contact strings must never reach the OPAC, OAI or an export. */
export const PERF_SUPPLIERS = 20;

/** The contact fields of supplier `k` (distinctive strings a test can grep the outputs for). */
export function perfSupplier(k: number): { code: string; name: string; contactName: string; phone: string; email: string; address: string } {
  const nn = String(k + 1).padStart(2, '0');
  return { code: `PMS-${nn}`, name: `Pemasok ${cap(syllableWord(k + 77, 3))}`, contactName: `Kontakperf ${nn}`, phone: `0812-7700-90${nn}`, email: `pemasok${nn}@perf-kontak.test`, address: `Jl. Kontakperf No. ${nn}` };
}

/** A small PDF (a page with a line of text) for attachment `n`: distinct bytes per n. */
export function perfPdf(n: number): Buffer {
  const text = `Lampiran perf-phase2 ${n}`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${text.length + 33} >>\nstream\nBT /F1 12 Tf 20 70 Td (${text}) Tj ET\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(body));
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

// ---------------------------------------------------------------------------------------------------------------------
// seedPhase2: straight into the tables

/** Records written per transaction (with their identifiers, agents, subjects, items and item history). */
export const RECORD_BATCH = 500;
/** Rows per multi-row INSERT: far below every engine's parameter limit (records have 34 columns). */
const ROWS_PER_INSERT = 200;
/** The span of `created_at` over the records: the last five years before `now`. */
const SPAN_MS = 5 * 365 * 86_400_000;

export interface SeedPhase2Options {
  counts?: PerfCounts;
  /** DATA_DIR: where the attachment files go (uploads/<yyyy>/<mm>/<id>). */
  dataDir: string;
  /** The clock the rows are written at (default Date.now()). */
  now?: number;
  say?: (line: string) => void;
}

export interface SeedPhase2Result {
  counts: PerfCounts;
  /** The branch the items of most records live in (the installation's first), and the second one the seed made. */
  branchIds: [string, string];
  ms: number;
}

async function insertRows<T extends keyof DB & string>(trx: Transaction<DB>, table: T, rows: Insertable<DB[T]>[]): Promise<void> {
  for (let i = 0; i < rows.length; i += ROWS_PER_INSERT) {
    // Kysely cannot narrow a generic table's insert type; the rows are typed by the caller.
    await (trx.insertInto(table) as unknown as { values(v: unknown[]): { execute(): Promise<unknown> } }).values(rows.slice(i, i + ROWS_PER_INSERT)).execute();
  }
}

async function idsByCode(h: DbHandle, table: 'material_types' | 'languages' | 'collection_types'): Promise<Map<string, string>> {
  const rows = await h.db.selectFrom(table).select(['id', 'code_key']).where('archived_at', 'is', null).execute();
  return new Map(rows.map((r) => [r.code_key, r.id]));
}

/**
 * Writes the catalogue of `o.counts` (default the full seed) into the installed database `h` (see the top of this
 * file). The catalogue must be empty (no record yet): the seed is written once, on a fresh installation.
 *
 * @throws Error when records exist already, or a master of 0027 the seed names is missing
 */
export async function seedPhase2(h: DbHandle, o: SeedPhase2Options): Promise<SeedPhase2Result> {
  const t0 = Date.now();
  const counts = o.counts ?? perfCounts(1);
  checkCounts(counts);
  const now = o.now ?? Date.now();
  const say = o.say ?? (() => undefined);
  const existing = await h.db.selectFrom('records').select('id').limit(1).executeTakeFirst();
  if (existing !== undefined) throw new Error('seedPhase2: the catalogue is not empty (the seed is written once, on a fresh installation)');
  const materialTypes = await idsByCode(h, 'material_types');
  const languages = await idsByCode(h, 'languages');
  const collectionTypes = await idsByCode(h, 'collection_types');
  for (const [what, map, codes] of [
    ['material type', materialTypes, MATERIAL_SPREAD],
    ['language', languages, LANGUAGE_SPREAD],
    ['collection type', collectionTypes, ['UMUM', 'REF', 'FIKSI']],
  ] as const) {
    for (const code of codes) if (!map.has(code)) throw new Error(`seedPhase2: no ${what} ${code} (migration 0027)`);
  }
  const base = now - SPAN_MS;
  const step = Math.max(1, Math.floor(SPAN_MS / counts.records));
  const trail = (at: number) => ({ archived_at: null, version: 0, created_at: at, created_by: null, updated_at: at, updated_by: null });

  // ---- branches, locations, suppliers, publishers, agents, subjects ----
  const first = await h.db.selectFrom('branches').select('id').where('archived_at', 'is', null).orderBy('created_at').orderBy('id').limit(1).executeTakeFirst();
  const branchIds: [string, string] = [first?.id ?? newId(base), newId(base)];
  const shelves: [string[], string[]] = [[], []];
  const supplierIds = Array.from({ length: PERF_SUPPLIERS }, () => newId(base));
  const publisherIds = Array.from({ length: PERF_PUBLISHERS }, () => newId(base));
  const agentIds = Array.from({ length: counts.agents }, () => newId(base));
  const subjectIds = Array.from({ length: counts.subjects }, () => newId(base));
  await withTx(h, async (trx) => {
    const branches = [
      ...(first === undefined ? [{ id: branchIds[0], code_display: 'PUSAT', code_key: 'PUSAT', name: 'Perpustakaan Pusat' }] : []),
      { id: branchIds[1], code_display: 'CABANG-UTARA', code_key: codeKey('CABANG-UTARA'), name: 'Cabang Utara' },
    ];
    await insertRows(trx, 'branches', branches.map((b) => ({ ...b, address: null, timezone: 'Asia/Jakarta', ...trail(base) })));
    const locations: Insertable<DB['locations']>[] = [];
    for (const [b, branchId] of branchIds.entries()) {
      const room = newId(base);
      locations.push({ id: room, branch_id: branchId, parent_id: null, kind: 'room', code_display: 'R-BACA', code_key: 'R-BACA', name: 'Ruang Baca', shelf_hint: null, class_from: null, class_to: null, map_file_id: null, map_x: null, map_y: null, map_w: null, map_h: null, is_public: 1, sort_order: 0, ...trail(base) });
      for (let s = 0; s < 10; s += 1) {
        const id = newId(base);
        shelves[b as 0 | 1].push(id);
        locations.push({ id, branch_id: branchId, parent_id: room, kind: 'shelf', code_display: `RAK-${s}`, code_key: `RAK-${s}`, name: `Rak ${s}00-${s}99`, shelf_hint: `${s}00`, class_from: `${s}00`, class_to: `${s}99`, map_file_id: null, map_x: null, map_y: null, map_w: null, map_h: null, is_public: 1, sort_order: s + 1, ...trail(base) });
      }
    }
    await insertRows(trx, 'locations', locations);
    await insertRows(
      trx,
      'suppliers',
      supplierIds.map((id, k) => {
        const s = perfSupplier(k);
        return { id, code_display: s.code, code_key: codeKey(s.code), name: s.name, contact_name: s.contactName, phone: s.phone, email: s.email, address: s.address, note: null, ...trail(base) };
      }),
    );
    await insertRows(
      trx,
      'publishers',
      publisherIds.map((id, k) => ({ id, name_display: perfPublisherName(k), name_key: publisherNameKey(perfPublisherName(k)), place: CITIES[k % CITIES.length]!, merged_into: null, ...trail(base) })),
    );
  });
  for (let at = 0; at < counts.agents; at += 5_000) {
    await withTx(h, (trx) =>
      insertRows(
        trx,
        'agents',
        agentIds.slice(at, at + 5_000).map((id, i) => {
          const k = at + i;
          const name = perfAgentName(k);
          return { id, type: perfAgentType(k), name_display: name, name_key: agentNameKey(name), dates: null, authority_source: null, authority_ref: null, note: null, merged_into: null, ...trail(base) };
        }),
      ),
    );
  }
  for (let at = 0; at < counts.subjects; at += 5_000) {
    await withTx(h, (trx) =>
      insertRows(
        trx,
        'subjects',
        subjectIds.slice(at, at + 5_000).map((id, i) => {
          const term = perfSubjectTerm(at + i);
          return { id, type: 'topic', term_display: term, term_key: subjectTermKey(term), classification: topicClass(at + i), scope_note: null, authority_source: null, merged_into: null, ...trail(base) };
        }),
      ),
    );
  }
  say(`seed: ${counts.agents} agents, ${counts.subjects} subjects, ${PERF_PUBLISHERS} publishers, ${PERF_SUPPLIERS} suppliers`);

  // ---- records with their identifiers, agents, subjects, items and item history ----
  const storage = localStorageDriver(o.dataDir);
  const attachments: { recordId: string; n: number; kind: 'file' | 'url'; at: number }[] = [];
  for (let start = 0; start < counts.records; start += RECORD_BATCH) {
    const records: Insertable<DB['records']>[] = [];
    const identifiers: Insertable<DB['record_identifiers']>[] = [];
    const recordAgents: Insertable<DB['record_agents']>[] = [];
    const recordSubjects: Insertable<DB['record_subjects']>[] = [];
    const items: Insertable<DB['items']>[] = [];
    const events: Insertable<DB['item_events']>[] = [];
    for (let n = start; n < Math.min(counts.records, start + RECORD_BATCH); n += 1) {
      const rec = perfRecord(n, counts);
      const at = base + n * step;
      const id = newId(at);
      records.push({
        id,
        material_type_id: materialTypes.get(rec.materialType)!,
        title: rec.title,
        subtitle: rec.subtitle,
        responsibility: rec.responsibility,
        title_key: titleKey(rec.title, rec.subtitle),
        edition: rec.edition,
        material_detail: null,
        publisher_id: publisherIds[rec.publisher]!,
        publication_place: rec.place,
        publication_year: rec.year,
        publication_date_text: rec.year,
        physical_desc: rec.physicalDesc,
        series: rec.series,
        classification: rec.classification,
        call_number: rec.callNumber,
        language_id: languages.get(rec.language)!,
        content_type: null,
        media_type: null,
        carrier_type: null,
        summary: rec.summary,
        notes: null,
        cover_file_id: null,
        opac_visible: rec.hidden ? 0 : 1,
        promoted: rec.promoted ? 1 : 0,
        source: 'manual',
        merged_into: null,
        changed_at: at,
        ...trail(at),
        archived_at: rec.archived ? at : null,
      });
      if (rec.isbn !== null) {
        identifiers.push({ id: newId(at), record_id: id, type: 'isbn', value_display: rec.isbn, value_key: rec.isbn, qualifier: null, is_valid: 1, sort_order: 0 });
      }
      rec.agents.forEach((a, i) => recordAgents.push({ record_id: id, agent_id: agentIds[a.k]!, role: a.role, is_main: a.isMain ? 1 : 0, sort_order: i }));
      rec.subjects.forEach((s, i) => recordSubjects.push({ record_id: id, subject_id: subjectIds[s.k]!, is_primary: s.isPrimary ? 1 : 0, sort_order: i }));
      for (const j of rec.items) {
        const it = perfItem(j, rec);
        // An archived record has no live item (archiving one with live items is refused, §2.5): its items are withdrawn.
        const status = rec.archived ? 'withdrawn' : it.status;
        const itemId = newId(at + 1000);
        const shelf = shelves[it.branch][Number(rec.classification.charAt(0)) % 10]!;
        items.push({
          id: itemId,
          record_id: id,
          branch_id: branchIds[it.branch],
          barcode_display: it.barcode,
          barcode_key: it.barcode,
          inventory_no: `INV/${rec.year}/${String(j + 1).padStart(7, '0')}`,
          call_number: null,
          location_id: shelf,
          collection_type_id: collectionTypes.get(it.collectionType)!,
          status,
          status_note: null,
          parts_total: 1,
          acq_source: it.supplier === null ? 'gift' : 'purchase',
          order_no: null,
          order_date: null,
          received_date: `${rec.year}-0${1 + (j % 9)}-1${j % 10}`,
          invoice_date: null,
          supplier_id: it.supplier === null ? null : supplierIds[it.supplier]!,
          invoice_no: null,
          price: it.price,
          currency: it.price === null ? null : 'IDR',
          note: null,
          ...trail(at + 1000),
          archived_at: rec.archived ? at + 1000 : null,
        });
        events.push({ id: newId(at + 1000), item_id: itemId, at: at + 1000, type: 'imported', from_status: null, to_status: status, from_location_id: null, to_location_id: shelf, actor_type: 'cli', actor_id: null, meta: '{"fields":[]}' });
      }
      if (rec.attachment !== null) attachments.push({ recordId: id, n, kind: rec.attachment, at: at + 2000 });
    }
    await withTx(h, async (trx) => {
      await insertRows(trx, 'records', records);
      await insertRows(trx, 'record_identifiers', identifiers);
      await insertRows(trx, 'record_agents', recordAgents);
      await insertRows(trx, 'record_subjects', recordSubjects);
      await insertRows(trx, 'items', items);
      await insertRows(trx, 'item_events', events);
    });
    const done = Math.min(counts.records, start + RECORD_BATCH);
    if (done % 10_000 === 0 || done === counts.records) say(`seed: ${done} records`);
  }

  // ---- attachments: a stored PDF (through the storage driver) or a link, every other one ----
  for (let start = 0; start < attachments.length; start += ROWS_PER_INSERT) {
    const files: Insertable<DB['files']>[] = [];
    const rows: Insertable<DB['attachments']>[] = [];
    for (const a of attachments.slice(start, start + ROWS_PER_INSERT)) {
      const id = newId(a.at);
      let fileId: string | null = null;
      if (a.kind === 'file') {
        fileId = newId(a.at);
        const bytes = perfPdf(a.n);
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        await storage.put(fileId, bytes, { size: bytes.length, sha256 });
        files.push({ id: fileId, original_name: `lampiran-${a.n}.pdf`, mime: 'application/pdf', size: bytes.length, sha256, context: 'catalog.attachment', owner_type: 'attachments', owner_id: id, access: 'public', status: 'ok', created_at: a.at, created_by: null });
      }
      rows.push({
        id,
        record_id: a.recordId,
        kind: a.kind,
        file_id: fileId,
        url: a.kind === 'url' ? `https://repositori.perf.test/dokumen/${a.n}` : null,
        title: a.kind === 'file' ? `Naskah lengkap ${a.n}` : `Tautan repositori ${a.n}`,
        description: null,
        access: 'public',
        legacy_access_limit: null,
        read_count: 0,
        sort_order: 0,
        ...trail(a.at),
      });
    }
    await withTx(h, async (trx) => {
      await insertRows(trx, 'files', files);
      await insertRows(trx, 'attachments', rows);
    });
  }
  say(`seed: ${attachments.length} attachments`);
  return { counts, branchIds, ms: Date.now() - t0 };
}

// ---------------------------------------------------------------------------------------------------------------------
// The import file (MARCXML) and the migration dump (SLiMS)

/** Writes `chunks` to `file` (created or replaced), waiting for the stream to drain: memory stays flat. */
async function writeStreamed(file: string, chunks: Iterable<string | Buffer>): Promise<number> {
  const out = fs.createWriteStream(file);
  let bytes = 0;
  try {
    for (const chunk of chunks) {
      bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
      if (!out.write(chunk)) await once(out, 'drain');
    }
  } finally {
    await new Promise<void>((resolve, reject) => out.end((error?: Error | null) => (error ? reject(error) : resolve())));
  }
  return bytes;
}

const sub = (tag: string, ind1: string, ind2: string, subfields: [string, string][]): MarcDataField => ({ tag, ind1, ind2, subfields });

/** Record `rec` as MARC 21 (the fields marcToDraft maps; items in 952 with `branchCodes`, links in 856). */
export function perfMarcRecord(rec: PerfRecord, branchCodes: readonly [string, string]): MarcRecord {
  const typeCode = rec.materialType === 'PETA' ? 'e' : 'a';
  const level = rec.materialType === 'BERSERI' ? 's' : 'm';
  const fields: MarcRecord['fields'] = [
    { tag: '001', value: `perf-${rec.n}` },
    { tag: '008', value: `260101s${rec.year}    io            000 0 ${rec.language.toLowerCase()} d` },
  ];
  if (rec.isbn !== null) fields.push(sub('020', ' ', ' ', [['a', rec.isbn]]));
  fields.push(sub('082', '0', '4', [['a', rec.classification]]));
  rec.agents.forEach((a, i) => {
    const name = perfAgentName(a.k);
    const org = perfAgentType(a.k) === 'organization';
    if (i === 0) fields.push(sub(org ? '110' : '100', org ? '2' : '0', ' ', [['a', name]]));
    else fields.push(sub(org ? '710' : '700', org ? '2' : '0', ' ', [['a', name], ['e', a.role === 'edt' ? 'editor' : 'author']]));
  });
  fields.sort((x, y) => Number(x.tag) - Number(y.tag));
  fields.push(sub('245', '1', '0', [['a', rec.title], ...(rec.subtitle === null ? [] : [['b', rec.subtitle] as [string, string]]), ['c', rec.responsibility ?? '']]));
  if (rec.edition !== null) fields.push(sub('250', ' ', ' ', [['a', rec.edition]]));
  fields.push(sub('264', ' ', '1', [['a', rec.place], ['b', perfPublisherName(rec.publisher)], ['c', rec.year]]));
  fields.push(sub('300', ' ', ' ', [['a', rec.physicalDesc]]));
  if (rec.series !== null) fields.push(sub('490', '0', ' ', [['a', rec.series]]));
  if (rec.summary !== null) fields.push(sub('520', ' ', ' ', [['a', rec.summary]]));
  for (const s of rec.subjects) {
    const [topic, ...rest] = perfSubjectTerm(s.k).split(' -- ');
    fields.push(sub('650', ' ', '4', [['a', topic!], ...rest.map((x) => ['x', x] as [string, string])]));
  }
  if (rec.attachment !== null) fields.push(sub('856', '4', '0', [['u', `https://repositori.perf.test/dokumen/${rec.n}`], ['y', `Tautan repositori ${rec.n}`]]));
  for (const j of rec.items) {
    const it = perfItem(j, rec);
    fields.push(sub('952', ' ', ' ', [['a', branchCodes[it.branch]], ['p', it.barcode], ['o', rec.callNumber], ['y', it.collectionType]]));
  }
  return { leader: `00000n${typeCode}${level} a2200000 i 4500`, fields };
}

/**
 * Writes the catalogue of `counts` as one MARCXML collection to `file` (the import mode of K16, K5's 100 000-record
 * file): record `n` becomes perfMarcRecord, its items 952 fields in the branches `branchCodes` (the installation's
 * first branch code, and a second one, which the import refuses as unknown unless it exists: run.ts gives the same
 * code twice). Answers the bytes written.
 */
export async function writePerfMarcXml(file: string, counts: PerfCounts, branchCodes: readonly [string, string]): Promise<number> {
  checkCounts(counts);
  function* chunks(): Iterable<string> {
    yield MARCXML_COLLECTION_OPEN;
    let part = '';
    for (let n = 0; n < counts.records; n += 1) {
      part += writeMarcXmlRecord(perfMarcRecord(perfRecord(n, counts), branchCodes));
      if (n % 200 === 199) {
        yield part;
        part = '';
      }
    }
    yield part + MARCXML_COLLECTION_CLOSE;
  }
  return writeStreamed(file, chunks());
}

/** What mysqldump writes for each character it escapes in a string literal (NUL and SUB by their codes). */
const SQL_ESCAPES: ReadonlyMap<string, string> = new Map([
  ['\\', '\\\\'],
  ["'", "\\'"],
  ['"', '\\"'],
  [String.fromCharCode(0), '\\0'],
  ['\n', '\\n'],
  ['\r', '\\r'],
  [String.fromCharCode(26), '\\Z'],
]);

/** A MySQL string literal of `s` (UTF-8), escaped as mysqldump escapes. */
function sqlText(s: string): string {
  let out = "'";
  for (const ch of s) out += SQL_ESCAPES.get(ch) ?? ch;
  return `${out}'`;
}

type SqlCell = string | number | null;
const cell = (v: SqlCell): string => (v === null ? 'NULL' : typeof v === 'number' ? String(v) : sqlText(v));

/** The CREATE TABLE of a fixture table, as mysqldump writes it. */
function createTable(name: string): string {
  const table = FIXTURE_TABLES.find((t) => t.name === name);
  if (table === undefined) throw new Error(`writePerfSlimsDump: no fixture table ${name}`);
  const lines = table.columns.map(([column, type]) => `  \`${column}\` ${type}`);
  if (table.primaryKey.length > 0) lines.push(`  PRIMARY KEY (${table.primaryKey.map((c) => `\`${c}\``).join(',')})`);
  lines.push(...(table.keys ?? []).map((k) => `  ${k}`));
  const charset = table.charset ?? 'utf8mb4';
  return [
    '--',
    `-- Table structure for table \`${name}\``,
    '--',
    '',
    `DROP TABLE IF EXISTS \`${name}\`;`,
    `CREATE TABLE \`${name}\` (`,
    lines.join(',\n'),
    `) ENGINE=InnoDB DEFAULT CHARSET=${charset}${charset === 'utf8mb4' ? ' COLLATE=utf8mb4_unicode_ci' : ''};`,
    '',
  ].join('\n') + '\n';
}

/** The INSERT statements of `rows` (each in the table's column order), 100 rows per statement. */
function* inserts(name: string, rows: Iterable<SqlCell[]>): Iterable<string> {
  const table = FIXTURE_TABLES.find((t) => t.name === name)!;
  let batch: string[] = [];
  const flush = (): string => {
    const text = `INSERT INTO \`${name}\` VALUES ${batch.join(',')};\n`;
    batch = [];
    return text;
  };
  yield `LOCK TABLES \`${name}\` WRITE;\n`;
  if (table.charset === 'latin1') yield '/*!40101 SET NAMES latin1 */;\n';
  for (const row of rows) {
    if (row.length !== table.columns.length) throw new Error(`writePerfSlimsDump: ${name} has ${table.columns.length} columns, not ${row.length}`);
    batch.push(`(${row.map(cell).join(',')})`);
    if (batch.length === 100) yield flush();
  }
  if (batch.length > 0) yield flush();
  if (table.charset === 'latin1') yield '/*!40101 SET NAMES utf8mb4 */;\n';
  yield 'UNLOCK TABLES;\n\n';
}

/** `YYYY-MM-DD hh:mm:ss` of record `n`'s time. */
function slimsStamp(n: number, counts: PerfCounts, end: number): string {
  const at = end - SPAN_MS + n * Math.max(1, Math.floor(SPAN_MS / counts.records));
  return new Date(at).toISOString().slice(0, 19).replace('T', ' ');
}

/** The SLiMS GMD of a material type (ids 1-5 of the dump's mst_gmd). */
const SLIMS_GMD: Readonly<Record<string, number>> = Object.freeze({ BUKU: 1, 'KARYA-ILMIAH': 2, EBOOK: 3, BERSERI: 4, PETA: 5 });
/** The SLiMS item statuses: '' is available. */
const SLIMS_STATUS: Readonly<Record<string, string>> = Object.freeze({ available: '', not_for_loan: 'NL', repair: 'R', missing: 'MIS', processing: 'NL' });
const SLIMS_COLL: Readonly<Record<string, number>> = Object.freeze({ UMUM: 1, REF: 2, FIKSI: 3 });

/**
 * Writes the catalogue of `counts` as a SLiMS 9 mysqldump to `file` (the migration mode of K16): every table of the
 * fixture schema is created; the masters, `biblio`, `biblio_author`, `biblio_topic` and `item` are filled (the item
 * codes are the seed's barcodes, so one count gives the same catalogue as the other two writers). No attachments: the
 * migration of files is measured by K15's fixture. Answers the bytes written.
 */
export async function writePerfSlimsDump(file: string, counts: PerfCounts, o: { now?: number } = {}): Promise<number> {
  checkCounts(counts);
  const end = o.now ?? Date.now();
  const stamp = new Date(end - SPAN_MS).toISOString().slice(0, 19).replace('T', ' ');
  const filled = new Set(['mst_gmd', 'mst_language', 'mst_publisher', 'mst_place', 'mst_author', 'mst_topic', 'mst_location', 'mst_coll_type', 'mst_item_status', 'biblio', 'biblio_author', 'biblio_topic', 'item']);
  function* chunks(): Iterable<string> {
    yield [
      '-- MySQL dump 10.13  Distrib 8.0.36, for Linux (x86_64)',
      '--',
      '-- Host: localhost    Database: slims_perf',
      '-- ------------------------------------------------------',
      '',
      '/*!40101 SET NAMES utf8mb4 */;',
      "/*!40103 SET TIME_ZONE='+00:00' */;",
      '',
    ].join('\n') + '\n';
    for (const table of FIXTURE_TABLES) {
      yield createTable(table.name);
      if (!filled.has(table.name)) continue;
      yield* inserts(table.name, slimsRows(table.name));
    }
    yield '-- Dump completed\n';
  }
  function* slimsRows(name: string): Iterable<SqlCell[]> {
    switch (name) {
      case 'mst_gmd':
        yield* [
          [1, 'TE', 'Text', null, stamp, stamp],
          [2, 'KI', 'Karya Ilmiah', null, stamp, stamp],
          [3, 'EB', 'Electronic Resource', null, stamp, stamp],
          [4, 'SE', 'Serial', null, stamp, stamp],
          [5, 'CA', 'Cartographic Material', null, stamp, stamp],
        ];
        return;
      case 'mst_language':
        yield* [['id', 'Indonesia', stamp, stamp], ['en', 'English', stamp, stamp], ['jv', 'Jawa', stamp, stamp], ['ar', 'Arab', stamp, stamp]];
        return;
      case 'mst_publisher':
        for (let k = 0; k < PERF_PUBLISHERS; k += 1) yield [k + 1, perfPublisherName(k), stamp, stamp];
        return;
      case 'mst_place':
        for (const [k, city] of CITIES.entries()) yield [k + 1, city, stamp, stamp];
        return;
      case 'mst_author':
        for (let k = 0; k < counts.agents; k += 1) yield [k + 1, perfAgentName(k), null, perfAgentType(k) === 'organization' ? 'o' : 'p', null, stamp, stamp];
        return;
      case 'mst_topic':
        for (let k = 0; k < counts.subjects; k += 1) yield [k + 1, perfSubjectTerm(k), 't', null, topicClass(k), stamp, stamp];
        return;
      case 'mst_location':
        yield* [['PST', 'Perpustakaan Pusat', stamp, stamp], ['UTR', 'Cabang Utara', stamp, stamp]];
        return;
      case 'mst_coll_type':
        yield* [[1, 'Umum', stamp, stamp], [2, 'Referensi', stamp, stamp], [3, 'Fiksi', stamp, stamp]];
        return;
      case 'mst_item_status':
        yield* [['NL', 'Tidak dipinjamkan', null, 1, 0, stamp, stamp], ['R', 'Perbaikan', null, 1, 0, stamp, stamp], ['MIS', 'Hilang', null, 1, 1, stamp, stamp]];
        return;
      case 'biblio':
        for (let n = 0; n < counts.records; n += 1) {
          const r = perfRecord(n, counts);
          const at = slimsStamp(n, counts, end);
          const lang = { IND: 'id', ENG: 'en', JAV: 'jv', ARA: 'ar' }[r.language] ?? 'id';
          yield [
            n + 1, SLIMS_GMD[r.materialType] ?? 1, r.subtitle === null ? r.title : `${r.title} : ${r.subtitle}`, r.responsibility, r.edition, r.isbn,
            r.publisher + 1, r.year, r.physicalDesc, r.series, r.callNumber, lang, null, CITIES.indexOf(r.place) + 1, r.classification, r.summary,
            null, null, r.hidden ? 1 : 0, r.promoted ? 1 : 0, null, 0, null, null, null, null, at, at, 1,
          ];
        }
        return;
      case 'biblio_author':
        for (let n = 0; n < counts.records; n += 1) for (const a of perfRecord(n, counts).agents) yield [n + 1, a.k + 1, a.isMain ? 1 : 2];
        return;
      case 'biblio_topic':
        for (let n = 0; n < counts.records; n += 1) for (const s of perfRecord(n, counts).subjects) yield [n + 1, s.k + 1, s.isPrimary ? 1 : 2];
        return;
      case 'item':
        for (let n = 0; n < counts.records; n += 1) {
          const r = perfRecord(n, counts);
          const at = slimsStamp(n, counts, end);
          for (const j of r.items) {
            const it = perfItem(j, r);
            yield [
              j + 1, n + 1, null, SLIMS_COLL[it.collectionType] ?? 1, it.barcode, `INV/${r.year}/${String(j + 1).padStart(7, '0')}`, `${r.year}-01-15`,
              it.supplier === null ? null : String(it.supplier + 1), null, it.branch === 0 ? 'PST' : 'UTR', null, SLIMS_STATUS[it.status] ?? '',
              null, it.supplier === null ? 2 : 1, null, it.price, it.price === null ? null : 'Rp', null, at, at, 1,
            ];
          }
        }
        return;
      default:
        return;
    }
  }
  return writeStreamed(file, chunks());
}
