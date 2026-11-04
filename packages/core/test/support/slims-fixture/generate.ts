import { rawZip, type RawEntry } from '../../helpers/raw-zip.js';
import { BIBLIO_CUSTOM_COLUMNS, FIXTURE_TABLES, ITEM_CUSTOM_COLUMNS, type FixtureTable } from './schema.js';

// The data of the synthetic SLiMS fixture and its rendering as a mysqldump (see index.ts). Fixed rows carry the 15
// traps of spec §11.7; the rest is generated from a seeded generator, so a seed always gives the same bytes and two
// seeds give two catalogues with the same shape (Task 37 migrates a second seed under another source name).

/** A cell of the dump: NULL, a number, text, raw bytes inside a string literal (not UTF-8), or a 0x… hex literal. */
type Cell = null | number | string | { raw: Uint8Array } | Uint8Array;
type Row = Record<string, Cell>;

/** A text trap: the value stored in SLiMS and what the §11.5 clean-up must make of it. */
export interface TextTrap {
  table: string;
  column: string;
  /** The row's primary key (composite keys joined with `|`). */
  key: string;
  stored: string;
  clean: string;
}

export interface SlimsFixtureTraps {
  /** 1. Orphans: no foreign keys in SLiMS. */
  orphans: {
    /** Items whose `biblio_id` has no `biblio` row (migrated under one hidden placeholder record per missing id). */
    items: { itemId: number; biblioId: number }[];
    missingBiblioIds: number[];
    authorLinks: { biblioId: number; authorId: number }[];
    topicLinks: { biblioId: number; topicId: number }[];
    /** `biblio_attachment` rows whose `files` row is missing. */
    attachments: { biblioId: number; fileId: number }[];
    /** `files` rows no attachment links to. */
    unlinkedFiles: number[];
    /** Relations to a `biblio_id` that does not exist (besides 0). */
    relations: { biblioId: number; relBiblioId: number }[];
  };
  /** 2. Double decoded UTF-8. */
  mojibake: TextTrap[];
  /** 3. Stored backslashes. */
  backslash: TextTrap[];
  /** Bytes that are not UTF-8 (a latin1 table): decoded as Windows-1252 on the dump path. */
  cp1252: TextTrap[];
  /** NUL inside a value. */
  nul: TextTrap[];
  /** 4. PHP-serialized values, well-formed (`value`) and broken (`strings`, what phpUnserialize recovers). */
  php: {
    valid: { table: string; column: string; key: string; stored: string; value: unknown }[];
    broken: { table: string; column: string; key: string; stored: string; strings: string[] }[];
  };
  /** 5. Odd and empty primary keys. */
  oddKeys: { emptyKeys: { table: string; key: string }[]; lowercase: { table: string; key: string }[] };
  /** 6. Item statuses: the stored `item_status_id` of each item, and what it becomes (§11.4). */
  itemStatuses: Record<string, { status: 'available' | 'not_for_loan' | 'repair' | 'missing'; items: number; note: boolean }>;
  /** 7. Prices: a few items with what `priceMode: 'major'` makes of them. */
  prices: { itemId: number; price: number | null; currency: string | null; major: number | null; currencyFallback: boolean }[];
  /** 8. Free-text years and the year §11.5 step 5 extracts. */
  years: { biblioId: number; text: string; year: string | null }[];
  /** 9. Mixed identifier cells and how many identifiers each holds. */
  identifiers: { biblioId: number; text: string; count: number }[];
  /** 10. Duplicate authorities (same key after normalisation) and topic types that are not valid. */
  duplicates: {
    authors: { ids: number[]; name: string }[];
    publishers: { ids: number[]; name: string }[];
    topics: { ids: number[]; name: string }[];
  };
  invalidTopicTypes: { topicId: number; type: string }[];
  /** 11. Zero dates. */
  zeroDates: { table: string; key: string; column: string }[];
  /** 12. Custom fields: the `cf_*` columns, a numeric field stored as text, a broken option list, empty dates. */
  customFields: {
    biblio: string[];
    item: string[];
    numberText: { biblioId: number; column: string; text: string; value: number }[];
    invalidNumber: { biblioId: number; column: string; text: string }[];
    brokenOptions: string[];
    emptyDates: { biblioId: number; column: string; text: string }[];
  };
  /** 13. Records hidden from the OPAC (`opac_hide = 1`). */
  hidden: number[];
  /** 14. Files referenced but absent from the files zip (and a path that tries to leave the repository). */
  missingFiles: { table: string; key: string; rel: string }[];
  /** 15. `biblio_relation`: what is kept (`related`) and what is dropped. */
  relations: { rows: number; zero: number; self: number; reciprocal: number; dangling: number; kept: [number, number][] };
  /** Titles split on the first `:` when both sides are non-empty (§11.4). */
  titles: { biblioId: number; stored: string; title: string; subtitle: string | null }[];
  /** RDA carrier and place lookups (M13): the carrier code a record gets (null: unmatched or missing). */
  rda: { biblioId: number; carrierTypeId: number; carrier: string | null }[];
  places: { biblioId: number; placeId: number; place: string | null }[];
  /** Barcodes that need §11.4's treatment. */
  barcodes: { itemId: number; stored: string; outcome: 'normalised' | 'nonstandard' | 'replaced' | 'collision' }[];
  /** Attachments by kind (S4, access, file key). */
  attachments: {
    url: { fileId: number; url: string }[];
    invalidUrl: { fileId: number; url: string }[];
    private: number[];
    accessLimit: { fileId: number; stored: string }[];
    fileKey: number[];
    /** A file whose entry inflates past 1 MiB (S10 with `catalog.attachment.maxMb` 1). */
    tooLarge: { fileId: number; rel: string; bytes: number }[];
  };
  /** Covers present and missing in `images/docs/`. */
  covers: { present: { biblioId: number; rel: string }[]; missing: { biblioId: number; rel: string }[] };
  /** `content`: pages, news, translations (`_id`/`_en`), drafts, images present and missing. */
  content: {
    pages: string[];
    news: string[];
    drafts: string[];
    translations: { path: string; base: string; lang: 'id' | 'en' }[];
    images: { present: string[]; missing: string[] };
  };
  /** `files_read` sums per file. */
  readCounts: Record<string, number>;
  /** `biblio_log` columns that are personal data and must not be archived (M12). */
  biblioLogPersonal: string[];
}

export interface SlimsFixtureExpected {
  seed: number;
  /** Rows per table, for every table of the dump (§11.6 `sumber`). */
  tables: Record<string, { source: number }>;
  /** The tables of the dump that the migration reads, does not read in Phase 2, skips as derived, or does not know. */
  roles: { read: string[]; archived: string[]; phase3: string[]; derived: string[]; other: string[] };
  /** The entries of the files zip (regular files only). */
  zipFiles: string[];
  traps: SlimsFixtureTraps;
}

// ---------------------------------------------------------------------------------------------------------------------

/** mulberry32: a small deterministic generator. */
function generator(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** PHP's serialize() for strings, integers, lists and string-keyed objects (byte lengths in UTF-8). */
export function phpSerialize(v: unknown): string {
  if (v === null) return 'N;';
  if (typeof v === 'boolean') return `b:${v ? 1 : 0};`;
  if (typeof v === 'number') return `i:${v};`;
  if (typeof v === 'string') return `s:${Buffer.byteLength(v, 'utf8')}:"${v}";`;
  const entries: [string | number, unknown][] = Array.isArray(v) ? v.map((x, i) => [i, x]) : Object.entries(v as object);
  return `a:${entries.length}:{${entries.map(([k, x]) => phpSerialize(k) + phpSerialize(x)).join('')}}`;
}

/** The check digit of an ISBN-13 from its first 12 digits. */
function isbn13(first12: string): string {
  const sum = [...first12].reduce((s, d, i) => s + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
  return first12 + String((10 - (sum % 10)) % 10);
}

const NUL = String.fromCharCode(0);
const pad = (n: number, w: number): string => String(n).padStart(w, '0');

const WORDS = [
  'Sejarah', 'Perpustakaan', 'Pendidikan', 'Teknologi', 'Informasi', 'Budaya', 'Nusantara', 'Ekonomi', 'Kesehatan', 'Pertanian',
  'Hukum', 'Bahasa', 'Sastra', 'Matematika', 'Fisika', 'Kimia', 'Biologi', 'Seni', 'Musik', 'Geografi', 'Politik', 'Sosial',
  'Manajemen', 'Komputer', 'Jaringan', 'Data', 'Anak', 'Remaja', 'Desa', 'Kota', 'Laut', 'Gunung', 'Hutan', 'Pesisir', 'Pangan',
];
const LINKS = ['dan', 'di', 'untuk', 'dalam', 'pada', 'bagi'];
const GIVEN = ['Andi', 'Budi', 'Citra', 'Dewi', 'Eko', 'Fajar', 'Gita', 'Hendra', 'Indah', 'Joko', 'Kartika', 'Lukman', 'Maya', 'Nanda', 'Oki', 'Putri', 'Rina', 'Sari', 'Taufik', 'Wulan'];
const FAMILY = ['Saputra', 'Wijaya', 'Siregar', 'Nasution', 'Lubis', 'Hasibuan', 'Pratama', 'Kusuma', 'Halim', 'Santoso', 'Gunawan', 'Hidayat', 'Rahman', 'Purba', 'Tanjung'];

interface Data {
  rows: Map<string, Row[]>;
  traps: SlimsFixtureTraps;
  zip: RawEntry[];
}

/** The rows of every table and the traps' expectations. */
function buildData(seed: number): Data {
  const rand = generator(seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!;
  const rows = new Map<string, Row[]>();
  const add = (table: string, row: Row): void => {
    let list = rows.get(table);
    if (list === undefined) rows.set(table, (list = []));
    list.push(row);
  };
  const stamp = (n: number): Row => ({ input_date: `2019-0${(n % 9) + 1}-1${n % 9} 08:00:00`, last_update: `2020-0${(n % 9) + 1}-2${n % 8} 09:30:00` });

  const traps: SlimsFixtureTraps = {
    orphans: { items: [], missingBiblioIds: [9001, 9002], authorLinks: [], topicLinks: [], attachments: [], unlinkedFiles: [], relations: [] },
    mojibake: [],
    backslash: [],
    cp1252: [],
    nul: [],
    php: { valid: [], broken: [] },
    oddKeys: { emptyKeys: [], lowercase: [] },
    itemStatuses: {},
    prices: [],
    years: [],
    identifiers: [],
    duplicates: { authors: [], publishers: [], topics: [] },
    invalidTopicTypes: [],
    zeroDates: [],
    customFields: {
      biblio: BIBLIO_CUSTOM_COLUMNS.map(([c]) => c),
      item: ITEM_CUSTOM_COLUMNS.map(([c]) => c),
      numberText: [],
      invalidNumber: [],
      brokenOptions: [],
      emptyDates: [],
    },
    hidden: [],
    missingFiles: [],
    relations: { rows: 0, zero: 0, self: 0, reciprocal: 0, dangling: 0, kept: [] },
    titles: [],
    rda: [],
    places: [],
    barcodes: [],
    attachments: { url: [], invalidUrl: [], private: [], accessLimit: [], fileKey: [], tooLarge: [] },
    covers: { present: [], missing: [] },
    content: { pages: [], news: [], drafts: [], translations: [], images: { present: [], missing: [] } },
    readCounts: {},
    biblioLogPersonal: ['ip', 'realname'],
  };
  const zip: RawEntry[] = [];
  const file = (name: string, data: Buffer): void => {
    zip.push({ name, data, method: 8 });
  };

  // ---- RDA vocabularies, GMD, languages, places, publishers
  [
    [1, 'Text', 'TE'],
    [2, 'Art Original', 'AR'],
    [3, 'CD-ROM', 'CD'],
    [4, 'Map', 'MP'],
    [5, 'Music', 'MU'],
    [6, 'Video Recording', 'VR'],
    [7, 'Electronic Resource', 'ER'],
    [8, 'Manuscript', 'MS'],
    [9, 'Bahan Campuran', null],
    [10, 'Kit', 'KI'],
  ].forEach(([id, name, code]) => add('mst_gmd', { gmd_id: id as number, gmd_code: code as string | null, gmd_name: name as string, icon_image: null, ...stamp(id as number) }));
  [
    [1, 'text', 'txt', 't'],
    [2, 'still image', 'sti', 'k'],
    [3, 'performed music', 'prm', 'j'],
    [4, 'cartographic image', 'cri', 'e'],
    [5, 'unspecified', 'zzz', ' '],
  ].forEach(([id, name, code, code2]) => add('mst_content_type', { id: id as number, content_type: name as string, code: code as string, code2: code2 as string, ...stamp(id as number) }));
  [
    [1, 'unmediated', 'n', 't'],
    [2, 'computer', 'c', 'c'],
    [3, 'audio', 's', 's'],
    [4, 'video', 'v', 'v'],
  ].forEach(([id, name, code, code2]) => add('mst_media_type', { id: id as number, media_type: name as string, code: code as string, code2: code2 as string, ...stamp(id as number) }));
  const carriers: [number, string, string][] = [
    [1, 'volume', 'nc'],
    [2, 'online resource', 'cr'],
    [3, 'audio disc', 'sd'],
    [4, 'kaset pita lokal', 'xx'], // not an RDA carrier: `rda_unmatched`
  ];
  carriers.forEach(([id, name, code]) => add('mst_carrier_type', { id, carrier_type: name, code, code2: '', ...stamp(id) }));
  [
    ['ar', 'Arab'],
    ['en', 'English'],
    ['id', 'Indonesia'],
    ['jv', 'Jawa'],
    ['ms', 'Melayu'],
    ['xx', 'Tidak Dikenal'],
    ['', 'Kosong'], // an empty primary key from an import bug: skipped `empty_key`
  ].forEach(([id, name], n) => add('mst_language', { language_id: id!, language_name: name!, ...stamp(n) }));
  traps.oddKeys.emptyKeys.push({ table: 'mst_language', key: '' });
  const places: [number, string][] = [
    [1, 'Jakarta'],
    [2, 'Bandung'],
    [3, 'Yogyakarta'],
    [4, 'Belitung'],
    [5, 'Surabaya'],
  ];
  places.forEach(([id, name]) => add('mst_place', { place_id: id, place_name: name, ...stamp(id) }));
  const publishers: [number, Cell][] = [
    [1, 'Gramedia Pustaka Utama'],
    [2, 'Gramedia  Pustaka Utama'], // the same name key: merged, both ids mapped
    [3, 'Bentang Pustaka'],
    [4, 'Balai Pustaka'],
    [5, 'Mizan'],
    [6, 'Erlangga'],
    [7, { raw: Uint8Array.from(Buffer.concat([Buffer.from('Penerbit Caf'), Buffer.from([0xe9]), Buffer.from(' Jaya')])) }],
    [8, 'Andi Offset'],
    [9, 'Kanisius'],
    [10, 'Deepublish'],
  ];
  publishers.forEach(([id, name]) => add('mst_publisher', { publisher_id: id, publisher_name: name, ...stamp(id) }));
  traps.duplicates.publishers.push({ ids: [1, 2], name: 'Gramedia Pustaka Utama' });
  traps.cp1252.push({ table: 'mst_publisher', column: 'publisher_name', key: '7', stored: 'Penerbit Caf\xe9 Jaya', clean: 'Penerbit Café Jaya' });

  // ---- authors
  const authors: [number, string, 'p' | 'o' | 'c', string | null][] = [
    [1, 'Hirata, Andrea', 'p', '1967-'],
    [2, 'Hirata,  Andrea', 'p', null],
  ];
  const seen = new Set(['Hirata, Andrea', 'Hirata,  Andrea']);
  for (let id = 3; id <= 30; id += 1) {
    let name = `${pick(FAMILY)}, ${pick(GIVEN)}`;
    for (let k = 2; seen.has(name); k += 1) name = `${name.split(' (')[0]} (${k})`;
    seen.add(name);
    authors.push([id, name, 'p', rand() < 0.3 ? `19${50 + Math.floor(rand() * 40)}-` : null]);
  }
  authors.push(
    [31, 'JosÃ© Rizal', 'p', '1861-1896'],
    [32, "O\\'Brien, Flann", 'p', null],
    [33, 'Perpustakaan Nasional Republik Indonesia', 'o', null],
    [34, 'Seminar Nasional Kepustakawanan 2019', 'c', null],
    [35, 'Universitas Indonesia', 'o', null],
    [36, 'Ikatan Pustakawan Indonesia', 'o', null],
  );
  for (let id = 37; id <= 40; id += 1) {
    let name = `${pick(GIVEN)} ${pick(FAMILY)}`;
    for (let k = 2; seen.has(name); k += 1) name = `${name.split(' (')[0]} (${k})`;
    seen.add(name);
    authors.push([id, name, 'p', null]);
  }
  authors.forEach(([id, name, type, year]) =>
    add('mst_author', { author_id: id, author_name: name, author_year: year, authority_type: type, auth_list: id % 5 === 0 ? 'LCNAF' : null, ...stamp(id) }),
  );
  traps.duplicates.authors.push({ ids: [1, 2], name: 'Hirata, Andrea' });
  traps.mojibake.push({ table: 'mst_author', column: 'author_name', key: '31', stored: 'JosÃ© Rizal', clean: 'José Rizal' });
  traps.backslash.push({ table: 'mst_author', column: 'author_name', key: '32', stored: "O\\'Brien, Flann", clean: "O'Brien, Flann" });

  // ---- topics and the thesaurus
  const topics: [number, string, string, string | null][] = [
    [1, 'Sejarah', 't', '900'],
    [2, 'Indonesia', 'g', null],
    [3, 'Soekarno', 'n', null],
    [4, 'Abad ke-20', 'tm', null],
    [5, 'Novel', 'gr', '808.3'],
    [6, 'Pustakawan', 'oc', '020'],
    [7, 'Komputer', 'o', '004'], // not a topic type: topic + report
    [8, 'Konferensi', 'c', null],
    [9, 'Fiksi Indonesia', 't', '899.221'],
    [10, 'Fiksi  Indonesia', 't', null], // duplicate key of 9
    [11, 'Pendidikan', 't', '370'],
    [12, 'Teknologi Informasi', 't', '004'],
    [13, 'Ekonomi', 't', '330'],
    [14, 'Bahasa Indonesia', 't', '499.221'],
    [15, 'Perpustakaan', 't', '020'],
  ];
  topics.forEach(([id, topic, type, cls]) => add('mst_topic', { topic_id: id, topic, topic_type: type, auth_list: null, classification: cls, ...stamp(id) }));
  traps.invalidTopicTypes.push({ topicId: 7, type: 'o' }, { topicId: 8, type: 'c' });
  traps.duplicates.topics.push({ ids: [9, 10], name: 'Fiksi Indonesia' });
  [
    [1, 'U', 'Use'],
    [2, 'UF', 'Use For'],
    [3, 'BT', 'Broader Term'],
    [4, 'NT', 'Narrower Term'],
    [5, 'RT', 'Related Term'],
    [6, 'SA', 'See Also'],
  ].forEach(([id, code, desc]) => add('mst_relation_term', { ID: id as number, rt_id: code as string, rt_desc: desc as string }));
  [
    [1, 1, 'U', '2', null],
    [2, 1, 'UF', '3', null],
    [3, 1, 'BT', '4', null],
    [4, 2, 'NT', '1', null],
    [5, 2, 'RT', '3', null],
    [6, 3, 'SA', '4', null],
    [7, 4, 'XX', '5', null], // an unknown relation code: rt + report
    [8, 5, null, null, 'Karya fiksi berbentuk prosa panjang.'], // a scope note
  ].forEach(([id, topic, rt, rel, scope]) =>
    add('mst_voc_ctrl', { vocabolary_id: id as number, topic_id: topic as number, rt_id: rt as string | null, related_topic_id: rel as string | null, scope: scope as string | null }),
  );

  // ---- locations, collection types, statuses, suppliers
  [
    ['REF', 'Ruang Referensi'],
    ['SL', 'My Library'],
    ['lt2', 'Lantai 2'],
  ].forEach(([id, name], n) => add('mst_location', { location_id: id!, location_name: name!, ...stamp(n) }));
  traps.oddKeys.lowercase.push({ table: 'mst_location', key: 'lt2' });
  [
    [1, 'Reference'],
    [2, 'Textbook'],
    [3, 'Fiction'],
  ].forEach(([id, name]) => add('mst_coll_type', { coll_type_id: id as number, coll_type_name: name as string, ...stamp(id as number) }));
  const rules = phpSerialize([1, 2]);
  [
    ['MIS', 'Missing', rules, 1, 1],
    ['NL', 'No Loan', null, 1, 1],
    ['R', 'Repair', rules, 1, 1],
    ['RSV', 'Dipesan', null, 0, 0],
  ].forEach(([id, name, r, noLoan, skip], n) =>
    add('mst_item_status', { item_status_id: id as string, item_status_name: name as string, rules: r as string | null, no_loan: noLoan as number, skip_stock_take: skip as number, ...stamp(n) }),
  );
  traps.php.valid.push({ table: 'mst_item_status', column: 'rules', key: 'MIS', stored: rules, value: [1, 2] });
  [
    [1, 'CV Buku Kita', 'Jl. Merdeka 1'],
    [2, 'Toko Buku Gramedia', 'Jl. Sudirman 2'],
    [3, 'Hibah Alumni', null],
  ].forEach(([id, name, address]) =>
    add('mst_supplier', {
      supplier_id: id as number,
      supplier_name: name as string,
      address: address as string | null,
      postal_code: null,
      phone: '0211234567',
      contact: null,
      fax: null,
      account: null,
      e_mail: null,
      ...stamp(id as number),
    }),
  );

  // ---- custom field definitions
  const checklistOptions = phpSerialize([
    ['1', 'Fiksi'],
    ['2', 'Nonfiksi'],
    ['3', 'Muatan Lokal'],
  ]);
  const brokenOptions = phpSerialize([['1', 'Tinggi'], ['2', 'Rendah']]).slice(0, 39); // cut inside 'Tinggi'
  const conditionOptions = phpSerialize([
    ['1', 'Baik'],
    ['2', 'Rusak Ringan'],
    ['3', 'Rusak Berat'],
  ]);
  const customDefs: [number, string, string, string, string, string | null][] = [
    [1, 'biblio', 'cf_1a2b3', 'Sumber Dana', 'text', null],
    [2, 'biblio', 'cf_4c5d6', 'Jumlah Lampiran', 'numeric', null],
    [3, 'biblio', 'cf_7e8f9', 'Kategori', 'checklist', checklistOptions],
    [4, 'biblio', 'cf_0a1b2', 'Tanggal Terima', 'date', null],
    [5, 'biblio', 'cf_bad01', 'Prioritas', 'dropdown', brokenOptions],
    [6, 'item', 'cf_9c8d7', 'Kondisi', 'dropdown', conditionOptions],
    [7, 'item', 'cf_5e6f7', 'Catatan Fisik', 'longtext', null],
    [8, 'member', 'cf_m0001', 'Pekerjaan', 'text', null], // a member field: not migrated in Phase 2
  ];
  customDefs.forEach(([id, table, dbfield, label, type, data]) =>
    add('mst_custom_field', { field_id: id, primary_table: table, dbfield, label, type, default: null, max: null, data, indexed: 0, class: '', is_public: id % 2, width: 100, note: null }),
  );
  traps.php.valid.push({
    table: 'mst_custom_field',
    column: 'data',
    key: 'cf_7e8f9',
    stored: checklistOptions,
    value: [
      ['1', 'Fiksi'],
      ['2', 'Nonfiksi'],
      ['3', 'Muatan Lokal'],
    ],
  });
  traps.php.broken.push({ table: 'mst_custom_field', column: 'data', key: 'cf_bad01', stored: brokenOptions, strings: ['1', 'Ting'] });
  traps.customFields.brokenOptions.push('cf_bad01');

  // ---- copy-cataloguing servers and settings
  [
    [1, 'Perpusnas', 'http://opac.perpusnas.go.id/sru.aspx', 4],
    [2, 'P2P Kampus', 'http://kampus.example/slims/', 1],
    [3, 'LoC Z39.50', 'z3950.loc.gov:7090/Voyager', 2],
  ].forEach(([id, name, uri, type]) => add('mst_servers', { server_id: id as number, name: name as string, uri: uri as string, server_type: type as number, ...stamp(id as number) }));
  const patterns = phpSerialize(['B00000', 'R0000S']);
  [
    [1, 'library_name', phpSerialize('Perpustakaan Uji')],
    [2, 'batch_item_code_pattern', patterns],
    [3, 'barcode_print_settings', phpSerialize({ barcode_page_margin: '0.2', barcode_items_per_row: '3' })],
    [4, 'template', phpSerialize('default')],
  ].forEach(([id, name, value]) => add('setting', { setting_id: id as number, setting_name: name as string, setting_value: value as string }));
  traps.php.valid.push({ table: 'setting', column: 'setting_value', key: '2', stored: patterns, value: ['B00000', 'R0000S'] });

  // ---- content (pages and news)
  const contents: [number, string, string, string, number, number, string | null][] = [
    [1, 'libinfo', 'Library Information', '<p>Informasi perpustakaan.</p>', 0, 0, null],
    [2, 'help', 'Help On Usage', '<p>Bantuan penggunaan OPAC.</p>', 0, 0, null],
    [3, 'profil_id', 'Profil Perpustakaan', '<p>Peta <img src="images/content/peta.png" alt="peta"> dan <img src="images/content/hilang.png"></p><script>alert(1)</script>', 0, 0, null],
    [4, 'profil_en', 'Library Profile', '<p>Map <img src="images/content/peta.png"></p>', 0, 0, null],
    [5, 'berita-pameran', 'Pameran Buku 2023', '<p>Pameran buku tahunan.</p>', 1, 0, '2023-08-17'],
    [6, 'berita-draf', 'Berita Draf', '<p>Belum terbit.</p>', 1, 1, null],
  ];
  contents.forEach(([id, p, title, desc, news, draft, date]) =>
    add('content', { content_id: id, content_title: title, content_desc: desc, content_path: p, is_news: news, is_draft: draft, publish_date: date, ...stamp(id), content_ownpage: '1' }),
  );
  traps.content = {
    pages: ['libinfo', 'help', 'profil_id', 'profil_en'],
    news: ['berita-pameran', 'berita-draf'],
    drafts: ['berita-draf'],
    translations: [
      { path: 'profil_id', base: 'profil', lang: 'id' },
      { path: 'profil_en', base: 'profil', lang: 'en' },
    ],
    images: { present: ['images/content/peta.png'], missing: ['images/content/hilang.png'] },
  };
  file('images/content/peta.png', Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]));

  // ---- biblio
  const titleFor = (): string => {
    const n = 2 + Math.floor(rand() * 3);
    const words: string[] = [];
    for (let k = 0; k < n; k += 1) words.push(k > 0 && rand() < 0.3 ? `${pick(LINKS)} ${pick(WORDS)}` : pick(WORDS));
    return words.join(' ');
  };
  const special: Record<number, Row> = {
    1: { title: 'Laskar Pelangi: sebuah novel', publish_year: '2005', isbn_issn: isbn13('978979122700'), publisher_id: 3, publish_place_id: 4, carrier_type_id: 1, image: 'cover-1.jpg', language_id: 'id' },
    2: { title: 'CafÃ© Bandung' },
    3: { isbn_issn: '978-0-306-40615-7; 0317-8471' },
    4: { title: "O\\'Reilly untuk Pemula" },
    5: { publish_year: 'c1998?' },
    6: { publish_year: '[2005?]' },
    7: { publish_year: '1998-2000' },
    8: { publish_year: 'tanpa tahun' },
    9: { input_date: '0000-00-00 00:00:00', last_update: '0000-00-00 00:00:00' },
    10: { notes: `Catatan${NUL} tersembunyi` },
    11: { opac_hide: 1 },
    12: { opac_hide: 1 },
    13: { opac_hide: 1 },
    14: { promoted: 1 },
    15: { labels: phpSerialize([['label-new', '']]) },
    16: { labels: phpSerialize([['label-new', '']]).slice(0, 32) }, // cut after 'label-new'
    17: { frequency_id: 3 },
    18: { title: 'Sejarah Ã‰ropa' },
    19: { sor: 'Ahmad \\"Kiai\\" Dahlan' },
    20: { image: 'cover-20.jpg' },
    21: { image: 'cover-21.jpg' },
    22: { title: ': tanpa judul utama' },
    23: { title: 'Judul tanpa anak judul:' },
    24: { title: 'Ilmu Perpustakaan: teori dan praktik: edisi revisi' },
    25: { carrier_type_id: 4, publish_place_id: 2 },
    26: { carrier_type_id: 99 },
    27: { language_id: 'xx' },
    28: { language_id: '' },
    29: { gmd_id: 0 },
    30: { gmd_id: 99 },
    31: { publisher_id: 999 },
    32: { publish_place_id: 0 },
    33: { isbn_issn: '0-306-40615-2 / 978-1-56619-909-4' },
    34: { title: 'Kopi \\"Tubruk\\" dari CafÃ© Lama' },
  };
  for (let id = 1; id <= 300; id += 1) {
    const title = titleFor();
    const row: Row = {
      biblio_id: id,
      gmd_id: (id % 10) + 1,
      title,
      sor: `${pick(GIVEN)} ${pick(FAMILY)}`,
      edition: id % 7 === 0 ? 'Cet. 2' : null,
      isbn_issn: id % 3 === 0 ? isbn13(`978602${pad(id * 37, 6)}`) : null,
      publisher_id: (id % 10) + 1,
      publish_year: String(1980 + (id % 44)),
      collation: `${100 + (id % 300)} hlm. ; 21 cm`,
      series_title: id % 9 === 0 ? 'Seri Pengetahuan' : null,
      call_number: `${300 + (id % 600)} ${pick(FAMILY).slice(0, 3).toUpperCase()} ${title[0]!.toLowerCase()}`,
      language_id: id % 11 === 0 ? 'en' : 'id',
      source: null,
      publish_place_id: (id % 5) + 1,
      classification: String(300 + (id % 600)),
      notes: rand() < 0.2 ? `Catatan ${pick(WORDS).toLowerCase()}.` : null,
      image: null,
      file_att: null,
      opac_hide: 0,
      promoted: 0,
      labels: null,
      frequency_id: 0,
      spec_detail_info: null,
      content_type_id: 1,
      media_type_id: 1,
      carrier_type_id: 1,
      ...stamp(id),
      uid: 1,
      ...(special[id] ?? {}),
    };
    add('biblio', row);
  }
  const biblio = (id: number): Row => rows.get('biblio')![id - 1]!;
  traps.titles.push(
    { biblioId: 1, stored: 'Laskar Pelangi: sebuah novel', title: 'Laskar Pelangi', subtitle: 'sebuah novel' },
    { biblioId: 22, stored: ': tanpa judul utama', title: ': tanpa judul utama', subtitle: null },
    { biblioId: 23, stored: 'Judul tanpa anak judul:', title: 'Judul tanpa anak judul:', subtitle: null },
    { biblioId: 24, stored: 'Ilmu Perpustakaan: teori dan praktik: edisi revisi', title: 'Ilmu Perpustakaan', subtitle: 'teori dan praktik: edisi revisi' },
  );
  traps.mojibake.push(
    { table: 'biblio', column: 'title', key: '2', stored: 'CafÃ© Bandung', clean: 'Café Bandung' },
    { table: 'biblio', column: 'title', key: '18', stored: 'Sejarah Ã‰ropa', clean: 'Sejarah Éropa' },
  );
  traps.backslash.push(
    { table: 'biblio', column: 'title', key: '4', stored: "O\\'Reilly untuk Pemula", clean: "O'Reilly untuk Pemula" },
    { table: 'biblio', column: 'sor', key: '19', stored: 'Ahmad \\"Kiai\\" Dahlan', clean: 'Ahmad "Kiai" Dahlan' },
    { table: 'biblio', column: 'title', key: '34', stored: 'Kopi \\"Tubruk\\" dari CafÃ© Lama', clean: 'Kopi "Tubruk" dari Café Lama' },
  );
  traps.mojibake.push({ table: 'biblio', column: 'title', key: '34', stored: 'Kopi \\"Tubruk\\" dari CafÃ© Lama', clean: 'Kopi "Tubruk" dari Café Lama' });
  traps.nul.push({ table: 'biblio', column: 'notes', key: '10', stored: `Catatan${NUL} tersembunyi`, clean: 'Catatan tersembunyi' });
  traps.years.push(
    { biblioId: 5, text: 'c1998?', year: '1998' },
    { biblioId: 6, text: '[2005?]', year: '2005' },
    { biblioId: 7, text: '1998-2000', year: '1998' },
    { biblioId: 8, text: 'tanpa tahun', year: null },
  );
  traps.identifiers.push(
    { biblioId: 3, text: '978-0-306-40615-7; 0317-8471', count: 2 },
    { biblioId: 33, text: '0-306-40615-2 / 978-1-56619-909-4', count: 2 },
  );
  traps.zeroDates.push({ table: 'biblio', key: '9', column: 'input_date' }, { table: 'biblio', key: '9', column: 'last_update' });
  traps.hidden.push(11, 12, 13);
  traps.php.valid.push({ table: 'biblio', column: 'labels', key: '15', stored: biblio(15)['labels'] as string, value: [['label-new', '']] });
  traps.php.broken.push({ table: 'biblio', column: 'labels', key: '16', stored: biblio(16)['labels'] as string, strings: ['label-new'] });
  traps.rda.push({ biblioId: 1, carrierTypeId: 1, carrier: 'nc' }, { biblioId: 25, carrierTypeId: 4, carrier: null }, { biblioId: 26, carrierTypeId: 99, carrier: null });
  traps.places.push({ biblioId: 1, placeId: 4, place: 'Belitung' }, { biblioId: 25, placeId: 2, place: 'Bandung' }, { biblioId: 32, placeId: 0, place: null });
  traps.covers.present.push({ biblioId: 1, rel: 'images/docs/cover-1.jpg' }, { biblioId: 20, rel: 'images/docs/cover-20.jpg' });
  traps.covers.missing.push({ biblioId: 21, rel: 'images/docs/cover-21.jpg' });
  const jpeg = (n: number): Buffer => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, n), Buffer.from([0xff, 0xd9])]);
  file('images/docs/cover-1.jpg', jpeg(1));
  file('images/docs/cover-20.jpg', jpeg(20));

  // ---- authors, topics and relations of records
  for (let id = 1; id <= 300; id += 1) {
    if (id === 5) {
      for (let level = 1; level <= 10; level += 1) add('biblio_author', { biblio_id: 5, author_id: level + 2, level });
      continue;
    }
    const first = id === 1 ? 1 : id === 2 ? 2 : ((id * 7) % 38) + 3;
    add('biblio_author', { biblio_id: id, author_id: first, level: 1 });
    const second = ((id * 11) % 38) + 3;
    if (id % 3 === 0 && second !== first) add('biblio_author', { biblio_id: id, author_id: second, level: 2 });
    if (id % 10 === 0 && first !== 33 && second !== 33) add('biblio_author', { biblio_id: id, author_id: 33, level: 3 });
  }
  add('biblio_author', { biblio_id: 6, author_id: 9999, level: 1 });
  traps.orphans.authorLinks.push({ biblioId: 6, authorId: 9999 });
  for (let id = 1; id <= 300; id += 1) {
    const first = ((id * 5) % 15) + 1;
    add('biblio_topic', { biblio_id: id, topic_id: first, level: 1 });
    const second = ((id * 3) % 15) + 1;
    if (id % 4 === 0 && second !== first) add('biblio_topic', { biblio_id: id, topic_id: second, level: 2 });
  }
  add('biblio_topic', { biblio_id: 7, topic_id: 8888, level: 1 });
  traps.orphans.topicLinks.push({ biblioId: 7, topicId: 8888 });
  const relations: [number, number][] = [
    [1, 2],
    [2, 1], // the reciprocal of 1-2: dropped as a duplicate
    [3, 4],
    [5, 5], // to itself
    [6, 0], // rel_biblio_id 0
    [7, 9001], // to a record that does not exist
    [8, 9],
    [10, 11],
    [12, 0],
  ];
  relations.forEach(([a, b]) => add('biblio_relation', { biblio_id: a, rel_biblio_id: b, rel_type: 1 }));
  traps.relations = { rows: relations.length, zero: 2, self: 1, reciprocal: 1, dangling: 1, kept: [[1, 2], [3, 4], [8, 9], [10, 11]] };
  traps.orphans.relations.push({ biblioId: 7, relBiblioId: 9001 });

  // ---- custom values of records
  const numberTexts: [number, string][] = [
    [1, '12'],
    [2, '7'],
    [3, ''],
    [4, 'dua belas'],
  ];
  const dates: [number, string][] = [
    [1, '2019-05-01'],
    [2, ''],
    [3, '0000-00-00'],
    [4, 'kemarin'],
  ];
  for (let id = 1; id <= 40; id += 1) {
    const number = numberTexts.find(([b]) => b === id)?.[1] ?? (id % 2 === 0 ? String(id) : null);
    const date = dates.find(([b]) => b === id)?.[1] ?? null;
    add('biblio_custom', {
      biblio_id: id,
      cf_1a2b3: id % 3 === 0 ? 'Hibah' : `APBN ${2015 + (id % 8)}`,
      cf_4c5d6: number,
      cf_7e8f9: id % 4 === 0 ? phpSerialize(['1', '3']) : id === 5 ? phpSerialize(['2']).slice(0, 15) : null,
      cf_0a1b2: date,
      cf_bad01: id % 5 === 0 ? '2' : null,
    });
  }
  traps.customFields.numberText.push({ biblioId: 1, column: 'cf_4c5d6', text: '12', value: 12 }, { biblioId: 2, column: 'cf_4c5d6', text: '7', value: 7 });
  traps.customFields.invalidNumber.push({ biblioId: 4, column: 'cf_4c5d6', text: 'dua belas' });
  traps.customFields.emptyDates.push({ biblioId: 2, column: 'cf_0a1b2', text: '' }, { biblioId: 3, column: 'cf_0a1b2', text: '0000-00-00' }, { biblioId: 4, column: 'cf_0a1b2', text: 'kemarin' });
  traps.zeroDates.push({ table: 'biblio_custom', key: '3', column: 'cf_0a1b2' });
  traps.php.valid.push({ table: 'biblio_custom', column: 'cf_7e8f9', key: '4', stored: phpSerialize(['1', '3']), value: ['1', '3'] });
  traps.php.broken.push({ table: 'biblio_custom', column: 'cf_7e8f9', key: '5', stored: phpSerialize(['2']).slice(0, 15), strings: ['2'] });

  // ---- files and attachments
  const pdf = (n: number): Buffer => Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(300, 0x20 + (n % 64)), Buffer.from('\n%%EOF\n')]);
  const accessLimit = phpSerialize(['1', '2']);
  const big = 2 * 1024 * 1024;
  const fileRows: [number, string, string, string | null, string | null, string, string | null, boolean][] = [
    // id, title, name, url, dir, mime, key, in the zip
    [1, 'Laskar Pelangi (PDF)', 'laskar.pdf', null, 'docs', 'application/pdf', null, true],
    [2, 'Berkas Hilang', 'hilang.pdf', null, 'docs', 'application/pdf', null, false],
    [3, 'Dokumen Internal', 'internal.pdf', null, 'staff', 'application/pdf', null, true],
    [4, 'Koleksi Khusus', 'khusus.pdf', null, 'terbatas', 'application/pdf', null, true],
    [5, 'E-book Daring', '', 'https://example.org/ebook.pdf', null, 'text/uri-list', null, false],
    [6, 'Tautan Berbahaya', '', 'javascript:alert(1)', null, 'text/uri-list', null, false],
    [7, 'PDF Terkunci', 'terkunci.pdf', null, 'rahasia', 'application/pdf', 'rahasia123', true],
    [8, 'Pindaian Besar', 'besar.pdf', null, 'scan', 'application/pdf', null, true],
    [9, 'Jalur Aneh', 'passwd', null, '../../etc', 'text/plain', null, false],
    [10, 'Berkas Tanpa Tautan', 'lepas.pdf', null, 'docs', 'application/pdf', null, true],
    [11, 'Panduan', 'panduan.pdf', null, '', 'application/pdf', null, true],
  ];
  for (const [id, title, name, url, dir, mime, key, present] of fileRows) {
    add('files', { file_id: id, file_title: title, file_name: name, file_url: url, file_dir: dir, mime_type: mime, file_desc: null, file_key: key, uploader_id: 1, ...stamp(id) });
    if (url !== null) continue;
    const rel = dir === '' || dir === null ? `repository/${name}` : `repository/${dir}/${name}`;
    if (present) file(rel, id === 8 ? Buffer.alloc(big, 0x41) : pdf(id));
    else traps.missingFiles.push({ table: 'files', key: String(id), rel });
  }
  const attachments: [number, number, string, string, string | null][] = [
    [1, 1, 'embed', 'public', null],
    [2, 2, 'link', 'public', null],
    [3, 3, 'link', 'private', null],
    [4, 4, 'popup', 'public', accessLimit],
    [5, 5, 'link', 'public', null],
    [6, 6, 'link', 'public', null],
    [7, 7, 'embed', 'public', null],
    [8, 8, 'embed', 'public', null],
    [9, 9, 'link', 'public', null],
    [11, 11, 'link', 'public', null],
    [12, 999, 'link', 'public', null], // its files row is missing
  ];
  attachments.forEach(([b, f, placement, access, limit]) => add('biblio_attachment', { biblio_id: b, file_id: f, placement, access_type: access, access_limit: limit }));
  traps.orphans.attachments.push({ biblioId: 12, fileId: 999 });
  traps.orphans.unlinkedFiles.push(10);
  traps.attachments = {
    url: [{ fileId: 5, url: 'https://example.org/ebook.pdf' }],
    invalidUrl: [{ fileId: 6, url: 'javascript:alert(1)' }],
    private: [3],
    accessLimit: [{ fileId: 4, stored: accessLimit }],
    fileKey: [7],
    tooLarge: [{ fileId: 8, rel: 'repository/scan/besar.pdf', bytes: big }],
  };
  traps.php.valid.push({ table: 'biblio_attachment', column: 'access_limit', key: '4|4', stored: accessLimit, value: ['1', '2'] });
  [
    [1, 1, 'M0001', null, '10.0.0.5'],
    [2, 1, 'M0002', null, '10.0.0.6'],
    [3, 1, null, 1, '10.0.0.7'],
    [4, 4, 'M0003', null, '10.0.0.8'],
  ].forEach(([id, f, member, user, ip]) =>
    add('files_read', { filelog_id: id as number, file_id: f as number, date_read: '2023-01-0' + String(id) + ' 10:00:00', member_id: member as string | null, user_id: user as number | null, client_ip: ip as string }),
  );
  traps.readCounts = { '1': 3, '4': 1 };

  // ---- items
  const site = (i: number): Cell =>
    [
      'Rak A1',
      'rak  a1 ', // the same shelf as 'Rak A1' once normalised
      'Rak B2',
      '',
      null,
      'Lemari Koleksi Khusus Sejarah Lokal Nusantara Lt 2', // longer than the 40-character shelf hint
    ][i % 6]!;
  const statusOf = (i: number): string => (['', '', '', '', '', '', '', '', '0', '0', '0', '0', '0', '0', 'R', 'NL', 'MIS', 'RSV', '', ''] as const)[i % 20]!;
  const statusMap: Record<string, { status: 'available' | 'not_for_loan' | 'repair' | 'missing'; note: boolean }> = {
    '': { status: 'available', note: false },
    '0': { status: 'available', note: false },
    NL: { status: 'not_for_loan', note: false },
    R: { status: 'repair', note: false },
    MIS: { status: 'missing', note: false },
    RSV: { status: 'available', note: true },
  };
  const barcodeTraps: Record<number, [string, SlimsFixtureTraps['barcodes'][number]['outcome']]> = {
    10: [' b  0010 ', 'normalised'],
    11: ['B 0010', 'collision'],
    12: ['7', 'nonstandard'],
    13: ['B–0013', 'replaced'],
    14: ['', 'replaced'],
    15: ['b00015', 'normalised'],
  };
  for (let i = 1; i <= 600; i += 1) {
    const biblioId = i <= 597 ? ((i - 1) % 297) + 1 : i === 600 ? 9002 : 9001;
    const status = statusOf(i);
    const entry = (traps.itemStatuses[status] ??= { ...statusMap[status]!, items: 0 });
    entry.items += 1;
    const barcode = barcodeTraps[i]?.[0] ?? `B${pad(i, 5)}`;
    let price: Cell = 25000 + ((i * 1000) % 100000);
    let currency: Cell = 'IDR';
    if (i === 20) [price, currency] = [125000, 'Rp'];
    if (i === 21) [price, currency] = [125000, 'IDR'];
    if (i === 22) [price, currency] = [0, 'IDR'];
    if (i === 23) [price, currency] = [null, null];
    if (i === 24) [price, currency] = [50, 'USD'];
    if (i === 25) [price, currency] = [75000, ''];
    add('item', {
      item_id: i,
      biblio_id: biblioId,
      call_number: `${300 + (biblioId % 600)} ${String.fromCharCode(65 + (i % 26))}`,
      coll_type_id: i % 7 === 0 ? 0 : i % 7 === 1 ? 9 : (i % 3) + 1,
      item_code: barcode,
      inventory_code: `INV/${pad(i, 4)}`,
      received_date: i % 11 === 0 ? '0000-00-00' : `2019-${pad((i % 12) + 1, 2)}-${pad((i % 27) + 1, 2)}`,
      supplier_id: i === 30 ? '77' : (['1', '2', '', '3'] as const)[i % 4]!,
      order_no: i % 5 === 0 ? `PO-${pad(i, 4)}` : null,
      location_id: i === 50 ? 'XX' : (['SL', 'SL', 'SL', 'REF', 'lt2'] as const)[i % 5]!,
      order_date: null,
      item_status_id: status,
      site: site(i),
      source: [1, 2, 0][i % 3]!,
      invoice: null,
      price,
      price_currency: currency,
      invoice_date: null,
      ...stamp(i),
      uid: 1,
    });
    if (biblioId > 300) traps.orphans.items.push({ itemId: i, biblioId });
  }
  traps.prices.push(
    { itemId: 20, price: 125000, currency: 'Rp', major: 12500000, currencyFallback: true },
    { itemId: 21, price: 125000, currency: 'IDR', major: 12500000, currencyFallback: false },
    { itemId: 22, price: 0, currency: 'IDR', major: 0, currencyFallback: false },
    { itemId: 23, price: null, currency: null, major: null, currencyFallback: true },
    { itemId: 24, price: 50, currency: 'USD', major: 5000, currencyFallback: false },
    { itemId: 25, price: 75000, currency: '', major: 7500000, currencyFallback: true },
  );
  for (const [i, [stored, outcome]] of Object.entries(barcodeTraps)) traps.barcodes.push({ itemId: Number(i), stored, outcome });
  traps.zeroDates.push({ table: 'item', key: '11', column: 'received_date' });
  for (let i = 1; i <= 30; i += 1) {
    add('item_custom', { item_id: i, cf_9c8d7: String((i % 3) + 1), cf_5e6f7: i % 4 === 0 ? 'Sampul robek' : null });
  }

  // ---- archived tables
  [
    [1, 'Weekly', 'en', 1, 'week'],
    [2, 'Bi-weekly', 'en', 2, 'week'],
    [3, 'Monthly', 'en', 1, 'month'],
    [4, 'Bi-Monthly', 'en', 2, 'month'],
    [5, 'Quarterly', 'en', 3, 'month'],
    [6, '3 Times a Year', 'en', 4, 'month'],
    [7, 'Annual', 'en', 1, 'year'],
    [8, 'Harian', 'id', 1, 'day'],
  ].forEach(([id, name, lang, inc, unit]) =>
    add('mst_frequency', { frequency_id: id as number, frequency: name as string, language_prefix: lang as string, time_increment: inc as number, time_unit: unit as string, ...stamp(id as number) }),
  );
  for (let id = 1; id <= 3; id += 1) {
    add('serial', { serial_id: id, date_start: '2020-01-01', date_end: null, period: `Langganan ${id}`, notes: null, biblio_id: 17, gmd_id: 1, ...stamp(id) });
  }
  for (let id = 1; id <= 6; id += 1) {
    add('kardex', { kardex_id: id, date_expected: `2020-0${id}-01`, date_received: id % 2 === 0 ? `2020-0${id}-03` : null, seq_number: `Vol. 1 No. ${id}`, notes: null, serial_id: ((id - 1) % 3) + 1, ...stamp(id) });
  }
  add('stock_take', {
    stock_take_id: 1,
    stock_take_name: 'Inventarisasi 2022',
    start_date: '2022-06-01 08:00:00',
    end_date: '2022-06-03 16:00:00',
    init_user: 'admin',
    total_item_stock_taked: 10,
    total_item_lost: 1,
    total_item_exists: 9,
    total_item_loan: 0,
    stock_take_users: phpSerialize(['admin']),
    is_active: 0,
    report_file: null,
  });
  for (let i = 1; i <= 10; i += 1) {
    add('stock_take_item', {
      stock_take_id: 1,
      item_id: i + 100,
      item_code: `B${pad(i + 100, 5)}`,
      title: `Judul ${i}`,
      gmd_name: 'Text',
      classification: '020',
      coll_type_name: 'Textbook',
      call_number: '020 A',
      location: 'My Library',
      status: i === 3 ? 'm' : 'e',
      checked_by: 'admin',
      last_update: '2022-06-02 10:00:00',
    });
  }
  [
    [1, 'label-new', 'New Title', 'label-new.png'],
    [2, 'label-favorite', 'Favorite Title', 'label-favorite.png'],
    [3, 'label-multimedia', 'Multimedia', 'label-multimedia.png'],
  ].forEach(([id, name, desc, image]) => add('mst_label', { label_id: id as number, label_name: name as string, label_desc: desc as string, label_image: image as string, ...stamp(id as number) }));
  for (let id = 1; id <= 10; id += 1) {
    add('biblio_log', {
      biblio_log_id: id,
      biblio_id: id,
      user_id: 1,
      realname: 'Pustakawan Satu',
      title: `Judul ${id}`,
      ip: `192.168.1.${10 + id}`,
      action: id % 2 === 0 ? 'update' : 'create',
      affectedrow: 'biblio',
      rawdata: phpSerialize({ title: `Judul ${id}` }),
      additional_information: '',
      date: `2021-03-${pad(id, 2)} 11:00:00`,
    });
  }

  // ---- not read in Phase 2, derived, and a plugin table
  [
    ['M0001', 'Anggota Satu', 'satu@example.test', '2020-01-01'],
    ['M0002', 'Anggota Dua', null, '2021-02-02'],
    ['M0003', 'Anggota Tiga', 'tiga@example.test', null],
  ].forEach(([id, name, email, since]) => add('member', { member_id: id!, member_name: name!, member_email: email ?? null, member_since_date: since ?? null }));
  for (let id = 1; id <= 4; id += 1) {
    add('loan', { loan_id: id, item_code: `B${pad(id + 40, 5)}`, member_id: `M000${(id % 3) + 1}`, loan_date: '2023-03-01', due_date: '2023-03-08' });
  }
  for (let id = 1; id <= 2; id += 1) {
    add('loan_history', { loan_id: id, item_code: `B${pad(id + 40, 5)}`, biblio_id: id + 40, title: `Judul ${id + 40}`, member_id: `M000${id}` });
  }
  for (let id = 1; id <= 5; id += 1) add('search_biblio', { biblio_id: id, title: biblio(id)['title'] as string, author: null, topic: null });
  for (let id = 1; id <= 2; id += 1) add('read_counter', { id, item_code: `B${pad(id, 5)}`, title: null, created_at: '2023-04-01 09:00:00' });

  // ---- the zip's other entries: the files of the repository and a folder entry (ignored by readers)
  zip.push({ name: 'repository/', data: Buffer.alloc(0), externalAttributes: (0o040755 << 16) >>> 0 });
  zip.sort((a, b) => (String(a.name) < String(b.name) ? -1 : String(a.name) > String(b.name) ? 1 : 0));
  return { rows, traps, zip };
}

// ---------------------------------------------------------------------------------------------------------------------
// The dump

/** A string's bytes escaped for a single-quoted MySQL literal, as mysqldump escapes them. */
function escapeBytes(bytes: Uint8Array): Buffer {
  const out: number[] = [];
  for (const b of bytes) {
    if (b === 0x00) out.push(0x5c, 0x30);
    else if (b === 0x0a) out.push(0x5c, 0x6e);
    else if (b === 0x0d) out.push(0x5c, 0x72);
    else if (b === 0x1a) out.push(0x5c, 0x5a);
    else if (b === 0x5c || b === 0x27 || b === 0x22) out.push(0x5c, b);
    else out.push(b);
  }
  return Buffer.from(out);
}

function literal(cell: Cell): Buffer {
  if (cell === null) return Buffer.from('NULL');
  if (typeof cell === 'number') return Buffer.from(String(cell));
  if (typeof cell === 'string') return Buffer.concat([Buffer.from("'"), escapeBytes(Buffer.from(cell, 'utf8')), Buffer.from("'")]);
  if (cell instanceof Uint8Array) return Buffer.from(`0x${Buffer.from(cell).toString('hex')}`);
  return Buffer.concat([Buffer.from("'"), escapeBytes(cell.raw), Buffer.from("'")]);
}

const ROWS_PER_INSERT = 50;

function renderDump(data: Data): Buffer {
  const out: Buffer[] = [];
  const text = (s: string): void => {
    out.push(Buffer.from(s, 'utf8'));
  };
  text(
    [
      '-- MySQL dump 10.13  Distrib 8.0.36, for Linux (x86_64)',
      '--',
      '-- Host: localhost    Database: slims_uji',
      '-- ------------------------------------------------------',
      '-- Server version\t8.0.36',
      '',
      '/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;',
      '/*!40101 SET NAMES utf8mb4 */;',
      '/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;',
      "/*!40103 SET TIME_ZONE='+00:00' */;",
      '/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;',
      "/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;",
      '',
    ].join('\n') + '\n',
  );
  const later: FixtureTable[] = [];
  for (const table of FIXTURE_TABLES) {
    const rows = data.rows.get(table.name) ?? [];
    const php = table.style === 'phpmyadmin';
    const charset = table.charset ?? 'utf8mb4';
    const lines = table.columns.map(([name, type]) => `  \`${name}\` ${type}`);
    if (!php && table.primaryKey.length > 0) lines.push(`  PRIMARY KEY (${table.primaryKey.map((c) => `\`${c}\``).join(',')})`);
    if (!php) lines.push(...(table.keys ?? []).map((k) => `  ${k}`));
    text(
      [
        '--',
        `-- Table structure for table \`${table.name}\``,
        '--',
        '',
        `DROP TABLE IF EXISTS \`${table.name}\`;`,
        '/*!40101 SET @saved_cs_client     = @@character_set_client */;',
        '/*!50503 SET character_set_client = utf8mb4 */;',
        `CREATE TABLE \`${table.name}\` (`,
        lines.join(',\n'),
        `) ENGINE=MyISAM DEFAULT CHARSET=${charset}${charset === 'utf8mb4' ? ' COLLATE=utf8mb4_unicode_ci' : ''};`,
        '/*!40101 SET character_set_client = @saved_cs_client */;',
        '',
        '--',
        `-- Dumping data for table \`${table.name}\``,
        '--',
        '',
        `LOCK TABLES \`${table.name}\` WRITE;`,
        `/*!40000 ALTER TABLE \`${table.name}\` DISABLE KEYS */;`,
        charset === 'latin1' ? '/*!40101 SET NAMES latin1 */;' : '',
      ].join('\n') + '\n',
    );
    const names = table.columns.map(([name]) => name);
    for (let at = 0; at < rows.length; at += ROWS_PER_INSERT) {
      const chunk = rows.slice(at, at + ROWS_PER_INSERT);
      text(php ? `INSERT INTO \`${table.name}\` (${names.map((c) => `\`${c}\``).join(', ')}) VALUES\n` : `INSERT INTO \`${table.name}\` VALUES `);
      chunk.forEach((row, k) => {
        if (k > 0) text(php ? ',\n' : ',');
        out.push(Buffer.from('('));
        names.forEach((name, m) => {
          if (m > 0) out.push(Buffer.from(php ? ', ' : ','));
          out.push(literal(Object.hasOwn(row, name) ? row[name]! : null));
        });
        out.push(Buffer.from(')'));
      });
      text(';\n');
    }
    text(
      [
        charset === 'latin1' ? '/*!40101 SET NAMES utf8mb4 */;' : '',
        `/*!40000 ALTER TABLE \`${table.name}\` ENABLE KEYS */;`,
        'UNLOCK TABLES;',
        '',
      ].join('\n') + '\n',
    );
    if (table.name === 'loan') {
      text(
        [
          '/*!50003 SET @saved_sql_mode = @@sql_mode */ ;',
          'DELIMITER ;;',
          '/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `loan_ai` AFTER INSERT ON `loan` FOR EACH ROW BEGIN',
          "  INSERT INTO loan_history VALUES (NEW.loan_id, NEW.item_code, 0, 'x;y', NEW.member_id);",
          'END */;;',
          'DELIMITER ;',
          '/*!50003 SET sql_mode = @saved_sql_mode */ ;',
          '',
        ].join('\n') + '\n',
      );
    }
    if (php) later.push(table);
  }
  if (later.length > 0) {
    text('--\n-- Indexes for dumped tables\n--\n\n');
    for (const table of later) {
      const adds = [
        ...(table.primaryKey.length > 0 ? [`ADD PRIMARY KEY (${table.primaryKey.map((c) => `\`${c}\``).join(',')})`] : []),
        ...(table.keys ?? []).map((k) => `ADD ${k}`),
      ];
      text(`--\n-- Indexes for table \`${table.name}\`\n--\nALTER TABLE \`${table.name}\`\n  ${adds.join(',\n  ')};\n\n`);
    }
  }
  text(
    [
      '/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;',
      '/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;',
      '/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;',
      '/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;',
      '',
      '-- Dump completed on 2026-10-30 10:00:00',
      '',
    ].join('\n'),
  );
  return Buffer.concat(out);
}

/** The fixture's dump, files zip and expectations for `seed`. */
export function generateSlimsFixture(seed: number): { dump: Buffer; filesZip: Buffer; expected: SlimsFixtureExpected } {
  const data = buildData(seed);
  const dump = renderDump(data);
  const filesZip = rawZip(data.zip);
  const tables: Record<string, { source: number }> = {};
  for (const table of FIXTURE_TABLES) tables[table.name] = { source: data.rows.get(table.name)?.length ?? 0 };
  const archived = ['serial', 'kardex', 'mst_frequency', 'stock_take', 'stock_take_item', 'mst_label', 'biblio_log', 'mst_item_status'];
  const phase3 = ['member', 'loan', 'loan_history'];
  const derived = ['search_biblio'];
  const other = ['read_counter'];
  const read = FIXTURE_TABLES.map((t) => t.name).filter((t) => !phase3.includes(t) && !derived.includes(t) && !other.includes(t));
  return {
    dump,
    filesZip,
    expected: {
      seed,
      tables,
      roles: { read, archived, phase3, derived, other },
      zipFiles: data.zip.filter((e) => !String(e.name).endsWith('/')).map((e) => String(e.name)),
      traps: data.traps,
    },
  };
}
