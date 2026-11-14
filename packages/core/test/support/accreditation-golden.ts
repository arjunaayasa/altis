import { withTx, type DB, type DbHandle } from '@altis/db';
import { newId, normalizeKey, type SnpOutcome } from '@altis/shared';
import type { Insertable, Kysely } from 'kysely';
import { titleKey } from '../../src/catalog/lib/title-key.js';
import { writeSettings } from '../../src/settings/service.js';

// The golden school dataset "SMA contoh": one school library (an upper secondary school with 3 classes of 36
// students, 10 teachers and 5 education staff) whose catalogue, usage, registers, OPAC pages and settings are written
// straight into the tables, and three periods over the same school year 2025/2026, one per school instrument of 2025
// (upper secondary, lower secondary, primary). Each indicator the instruments compute has a hand-computed value and
// answer, recorded below with its formula (GOLDEN_EXPECTED); the tests compare the evaluation with them and never the
// other way round. Every date is a local date of Asia/Jakarta (UTC+7, no daylight saving); the snapshot date of every
// period is its last day, 2026-06-30, because the periods are evaluated after it.
//
// The catalogue on 2023-12-31 holds 700 titles: 20 e-books without copies; 40 titles the SLiMS migration of
// 2026-01-02 brought in with an empty input date (the record's creation is the migration's own clock) and one copy
// without any date (undated: in the stock at every date, never an addition); a title whose only copy was withdrawn on
// 2025-02-01; a two-copy title one copy of which was declared lost on 2026-01-05; and 638 more migrated titles dated by
// their copies' receiving dates, the dates their copies were entered in SLiMS, or their records' input dates. Titles
// were first acquired on 2024-03-15 (100, migrated), 2025-03-15 (101, migrated) and 2026-02-15 (100, received here
// after the migration). So the stock on 2026-06-30 is 700 − 1 + 301 = 1 000 titles with 1 200 live copies (the lost
// one is not live), every copy processed (barcode, call number, class, location). 250 titles have fiction copies
// (`FIKSI`), 50 have reference copies (`REF`) of five reference kinds, four are serials (`BERSERI`; three received in
// the twelve months to the snapshot date) and six are local works: four by the school's people of the kinds the
// instruments count (written work, clipping, poetry, abstract; abstract only by the upper secondary one), one by the
// school's people of another kind, and one by the community, which the instruments do not count.
//
// The evaluation reads the installation's base address from the job's settings: run it with GOLDEN_BASE_URL (public).
//
// Optional variants:
// - `withoutPopulation`: the student and education staff counts are not entered (the teachers are, so the lesson-plan
//   item keeps its value): the items divided by the population give no value;
// - `rulingEdges`: three acquisition-date edge cases added for new titles: a copy on order made here on 2026-05-01, a
//   copy received on 2026-08-01 (after the snapshot date), and one more migrated record with an invalid input date and
//   one undated copy.

/** The three periods, by school instrument. */
export type GoldenLevel = 'sma' | 'smp' | 'sd';

export const GOLDEN_LEVELS: readonly GoldenLevel[] = Object.freeze(['sma', 'smp', 'sd'] as const);

/** The instrument and the school level of each period. */
export const GOLDEN_INSTRUMENTS: Readonly<Record<GoldenLevel, { instrumentId: string; schoolLevel: 'sma_smk_ma' | 'smp_mts' | 'sd_mi'; name: string }>> = Object.freeze({
  sma: { instrumentId: 'sch-sma-2025', schoolLevel: 'sma_smk_ma', name: 'Tahun pelajaran 2025/2026 (SMA)' },
  smp: { instrumentId: 'sch-smp-2025', schoolLevel: 'smp_mts', name: 'Tahun pelajaran 2025/2026 (SMP)' },
  sd: { instrumentId: 'sch-sd-2025', schoolLevel: 'sd_mi', name: 'Tahun pelajaran 2025/2026 (SD)' },
});

/** The installation's public base address (`baseUrl` of the job's settings): the automation item reads it as public. */
export const GOLDEN_BASE_URL = 'https://perpus.sma-contoh.sch.id';

/** The library's time zone. */
export const GOLDEN_TZ = 'Asia/Jakarta';

/** The instant of the local time `hh:mm` (default 10:00) of `date` in {@link GOLDEN_TZ}. */
export function goldenAt(date: string, hhmm = '10:00'): number {
  return Date.parse(`${date}T${hhmm}:00+07:00`);
}

/** The SLiMS migration run: 2026-01-02 08:00 to 10:00. */
export const GOLDEN_MIGRATION_SPAN = Object.freeze({ from: goldenAt('2026-01-02', '08:00'), to: goldenAt('2026-01-02', '10:00') });

type Letter = 'a' | 'b' | 'c' | 'd';
type PerLevel<T> = Readonly<Record<GoldenLevel, T>>;

/** One indicator of the expected table, by its concept code (upper secondary numbering). */
export interface GoldenIndicator {
  code: string;
  /** How the value is found, with its numbers. */
  formula: string;
  /** The computed value per level; null for an item answered by hand or one the instrument lacks. */
  value: PerLevel<number | null>;
  /** The final answer per level (the suggestion, or the answer given by hand); null when the instrument lacks it. */
  answer: PerLevel<Letter | null>;
  /** Answered by hand: no value of its own and no suggestion. */
  manual: boolean;
  /** The numerator and denominator the value carries (a share or a ratio); null for a plain count or a code. */
  fraction: readonly [number, number] | null;
}

/** The score of one period: the component sums (K, SP, L, T, F, G), the score as the fraction N ÷ L, its form. */
export interface GoldenTotals {
  sums: readonly [number, number, number, number, number, number];
  n: number;
  l: number;
  na: string;
  grade: 'A' | 'B' | 'C' | 'D';
}

export interface GoldenStandard {
  code: string;
  outcome: PerLevel<SnpOutcome>;
  /** The value the standard reads, when it is one number for every level. */
  value?: number | null;
  formula: string;
}

export interface GoldenExpected {
  /** The snapshot date of the three periods. */
  D: string;
  indicators: readonly GoldenIndicator[];
  totals: PerLevel<GoldenTotals>;
  /** The ten largest gaps of the upper secondary period: official number and gap (four decimals). */
  gaps: { sma: readonly string[] };
  /** The school standards. */
  snp: readonly GoldenStandard[];
  /** The official number of each indicator of each instrument, by catalogue code. */
  officialNo: PerLevel<Readonly<Record<string, string>>>;
}

const same = <T>(v: T): PerLevel<T> => Object.freeze({ sma: v, smp: v, sd: v });
const per = <T>(sma: T, smp: T, sd: T): PerLevel<T> => Object.freeze({ sma, smp, sd });
const letters = (s: string): PerLevel<Letter | null> => {
  const [sma, smp, sd] = s.split('') as (Letter | '-')[];
  const l = (x: Letter | '-' | undefined): Letter | null => (x === undefined || x === '-' ? null : x);
  return per(l(sma), l(smp), l(sd));
};

const computed = (code: string, value: number | PerLevel<number | null>, answers: string, formula: string, fraction: readonly [number, number] | null = null): GoldenIndicator =>
  Object.freeze({ code, formula, value: typeof value === 'number' ? same(value) : value, answer: letters(answers), manual: false, fraction });
const byHand = (code: string, answers: string, formula: string): GoldenIndicator =>
  Object.freeze({ code, formula, value: same(null), answer: letters(answers), manual: true, fraction: null });

/** The hand-computed table. Answer strings read upper secondary, lower secondary, primary. */
const INDICATORS: readonly GoldenIndicator[] = Object.freeze([
  computed('K1', 1000, 'ccc', 'titles in stock on 2026-06-30: 700 on 2023-12-31 − the withdrawn title + 301 first acquired = 1 000 (20 e-books, 40 undated)'),
  computed('K2', 25, 'abb', '250 fiction titles × 100 ÷ 1 000 titles = 25 (upper secondary: 25 lies in a and b, a is suggested)', [250, 1000]),
  computed('K3', 6, 'bba', 'aspects a1–a6 of the current collection policy (a1–a5 required, all present)'),
  computed('K4', 2, 'bbb', '2 needs surveys in the period'),
  computed('K5', 25, 'ccc', '250 titles used × 100 ÷ 1 000 titles = 25', [250, 1000]),
  computed('K6', 43, 'bbb', '301 titles added × 100 ÷ 700 titles on 2023-12-31 = 43.0…; start below 1 000 → first tier; 40 of 1 200 copies undated (3 %)', [301, 700]),
  computed('K7', 100, 'aaa', '1 200 of 1 200 live copies processed (100 %), 2 barcode scanners', [1200, 1200]),
  computed('K8', 4, 'bbb', '4 preservation activities from 2023-07-01 to 2026-06-30 (the one of 2023-03-01 is outside)'),
  byHand('SP1', 'aaa', 'answered a by hand'),
  byHand('SP2', 'bbb', 'answered b by hand'),
  byHand('SP3', 'ccc', 'answered c by hand'),
  computed('SP4', 4, 'aaa', '5 ICT devices × 100 ÷ 123 people = 4.06… → 4', [5, 123]),
  computed('SP5', 50, 'ccc', '1 staff PC × 100 ÷ 2 active staff = 50', [1, 2]),
  computed('SP6', 30, 'ccc', '30 Mbps'),
  computed('SP7', 5, 'bbb', '4 learning sessions + 1 writing guidance held in the library (a learning session also held there counts once)'),
  computed('L1', 3, 'bbb', 'rules, membership and loan procedures (the two required ones present)'),
  computed('L2', 6, 'aaa', '6 services'),
  computed('L3', 4, 'bba', '4 reading culture activities'),
  computed('L4', 5, 'baa', '5 reading guidance sessions'),
  computed('L5', 3, 'cbb', '3 writing guidance sessions'),
  computed('L6', per(4, 3, 3), 'bbb', 'kinds of school local works: written work, clipping, poetry, abstract (abstract counted by the upper secondary instrument only)'),
  computed('L7', per(1, null, null), 'c--', '1 plagiarism guidance session (upper secondary only)'),
  computed('L8', 2, 'bbb', '2 innovations'),
  computed('L9', 3, 'bbb', '2 outside literacy activities + 1 writing guidance with an outside speaker'),
  computed('L10', 1, 'ccc', '1 satisfaction survey'),
  computed('L11', 1, 'aaa', 'the base address is public (value 1: the address is set)'),
  computed('L12', 5, 'bba', 'OPAC, profile, services and contact pages, a social link (the databases page is a draft; no FAQ page)'),
  computed('L13', 9, 'baa', '9 promotions in the period (one of 2025-06-30 and an archived one are not counted)'),
  computed('L14', 50, 'ccc', '625 visits (student 520 + 35 of deleted members, teacher 50, education staff 20) × 100 ÷ (10 school months × 123) = 50.8… → 50', [625, 1230]),
  computed('T1', 1, 'bbb', 'one head: S1 outside library science, with library training'),
  computed('T2', 4, 'bbb', 'aspects a1–a4 of the head performance report of 2026-06-01'),
  computed('T3', 2, 'bbb', '2 active staff: a librarian (the head) and a technical staff member'),
  computed('T4', 6, 'cca', '12 trainings of the active staff from 2023-07-01 to 2026-06-30 ÷ 2 = 6', [12, 2]),
  computed('T5', 61, 'bbb', '123 people ÷ 2 active staff = 61.5 → 61', [123, 2]),
  computed('F1', 3, 'bbb', 'founding decree, NPP, duties (no organisation structure)'),
  computed('F2', 4, 'bbb', 'collection, organisation, service and promotion procedures'),
  byHand('F3', 'ccc', 'answered c by hand'),
  computed('F4', 40, 'bbb', '4 of 10 teachers use the library in their lesson plans = 40', [4, 10]),
  computed('G1', 3, 'ccc', 'areas a1–a3 of the current library programme'),
  computed('G2', 3, 'cba', '3 partners (an agreement ended 2023-06-30 is outside; one partner with two agreements counts once)'),
  computed('G3', 6, 'bbb', 'exact mean of 6.5 %, 5.2 % and 6.9 % of the parent budget = 6.2 → 6'),
  computed('G4', 18, 'bbb', 'an annual and two semester reports in each of the three years (quarterly reports only 3 a year); value = 18 reports counted'),
]);

/** The school standards (the same outcome under the three instruments). */
const STANDARDS: readonly GoldenStandard[] = Object.freeze([
  { code: 'SNP-S-01', outcome: same<SnpOutcome>('pass'), value: 1000, formula: '1 000 titles ≥ 1 000' },
  { code: 'SNP-S-02', outcome: same<SnpOutcome>('fail'), value: 26, formula: '250 fiction of 950 enrichment titles = 26 %, not the level’s share' },
  { code: 'SNP-S-03', outcome: same<SnpOutcome>('fail'), value: 950, formula: '950 enrichment titles < 1 000 for 3 classes' },
  { code: 'SNP-S-04', outcome: same<SnpOutcome>('pass'), value: 5, formula: '5 reference kinds, the named ones present' },
  { code: 'SNP-S-05', outcome: same<SnpOutcome>('pass'), value: 3, formula: '3 serial titles received in the twelve months to 2026-06-30' },
  { code: 'SNP-S-06', outcome: same<SnpOutcome>('pass'), value: 11, formula: '100 titles added in the period × 100 ÷ 900 at its start = 11 ≥ 10' },
  { code: 'SNP-S-07', outcome: same<SnpOutcome>('pass'), value: 2, formula: 'a stock-take on 2024-08-10 and a weeding on 2024-08-12' },
  { code: 'SNP-S-08', outcome: same<SnpOutcome>('pass'), value: 35, formula: '35 opening hours a week' },
  { code: 'SNP-S-09', outcome: same<SnpOutcome>('pass'), value: 12, formula: 'visits in 12 months, loans in 12 months' },
  { code: 'SNP-S-10', outcome: same<SnpOutcome>('pass'), value: 9, formula: '9 promotions' },
  { code: 'SNP-S-11', outcome: same<SnpOutcome>('pass'), value: 2, formula: '2 staff for 3 classes' },
  { code: 'SNP-S-12', outcome: same<SnpOutcome>('pass'), value: 6, formula: '6.9 % of the parent budget in 2026 ≥ 5 %' },
  { code: 'SNP-S-13', outcome: same<SnpOutcome>('reported'), value: null, formula: 'reported; no usage data for the twelve months before the period' },
  { code: 'SNP-S-14', outcome: same<SnpOutcome>('not_available'), formula: 'needs the membership module' },
]);

/** The official numbers: the primary and lower secondary instruments have no plagiarism item, so L8…L14 print L7…L13. */
function officialNumbers(level: GoldenLevel): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const i of INDICATORS) {
    if (i.answer[level] === null) continue;
    const m = /^L(\d+)$/.exec(i.code);
    const shifted = level !== 'sma' && m !== null && Number(m[1]) >= 8 ? `L${Number(m[1]) - 1}` : i.code;
    out[`SCH-${i.code}`] = shifted;
  }
  return Object.freeze(out);
}

/** The expected table of the base dataset (the variants differ only where their tests say). */
export const GOLDEN_EXPECTED: GoldenExpected = Object.freeze({
  D: '2026-06-30',
  indicators: INDICATORS,
  totals: per<GoldenTotals>(
    // N = Σ S_k × W_k × (L ÷ 4n_k); NA = floor(N × 100 ÷ L) hundredths.
    { sums: [24, 20, 40, 14, 11, 10], n: 78_910, l: 1_120, na: '70.45', grade: 'C' },
    { sums: [23, 20, 41, 14, 11, 11], n: 1_065_905, l: 14_560, na: '73.20', grade: 'C' },
    { sums: [24, 20, 43, 16, 11, 12], n: 1_123_270, l: 14_560, na: '77.14', grade: 'B' },
  ),
  // Gap = (4 − score) ÷ (4n) × W, ties in component then item order: F3 1.875; T4 1.5; L5, L7, L10, L14, G1, G2
  // 1.25; K1, K5 0.9375.
  gaps: { sma: Object.freeze(['F3 1.8750', 'T4 1.5000', 'L5 1.2500', 'L7 1.2500', 'L10 1.2500', 'L14 1.2500', 'G1 1.2500', 'G2 1.2500', 'K1 0.9375', 'K5 0.9375']) },
  snp: STANDARDS,
  officialNo: per(officialNumbers('sma'), officialNumbers('smp'), officialNumbers('sd')),
});

// ---- the dataset ---------------------------------------------------------------------------------------------------

export interface GoldenFixture {
  /** The period of each instrument. */
  periods: PerLevel<string>;
  /** The instrument id of each period. */
  instruments: PerLevel<string>;
  branchId: string;
  locationId: string;
  migrationRunId: string;
  records: {
    /** The 40 migrated titles without any date. */
    undated: readonly string[];
    /** The title whose only copy was withdrawn on 2025-02-01. */
    withdrawn: string;
    /** The two-copy title with a lost copy. */
    lostCopy: string;
    /** The edge-case titles (with `rulingEdges` only). */
    edges?: { onOrder: string; afterD: string; undatedLate: string };
  };
  items: { lost: string };
  staff: { head: string; technical: string; former: string };
  expected: GoldenExpected;
}

type Db = Kysely<DB>;

/** Inserts `rows` into `table` a hundred at a time. */
async function insertAll<T extends keyof DB & string>(db: Db, table: T, rows: readonly Insertable<DB[T]>[]): Promise<void> {
  for (let i = 0; i < rows.length; i += 100) {
    // Kysely cannot narrow a generic table name; the rows are typed by the caller.
    await (db as unknown as Kysely<Record<string, Record<string, unknown>>>)
      .insertInto(table)
      .values(rows.slice(i, i + 100) as unknown as Record<string, unknown>[])
      .execute();
  }
}

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

/** A deterministic calendar date of `year` for the n-th title. */
const dateIn = (year: number, n: number): string => `${year}-${pad(1 + (n % 12))}-${pad(1 + (n % 28))}`;

const trail = (at: number) => ({ archived_at: null, created_at: at, created_by: null, updated_at: at, updated_by: null });

/** Ids of the masters the catalogue seed made. */
async function masterId(db: Db, table: 'material_types' | 'collection_types', code: string): Promise<string> {
  return (await db.selectFrom(table).select('id').where('code_key', '=', normalizeKey(code)).executeTakeFirstOrThrow()).id;
}

type MaterialCode = 'BUKU' | 'EBOOK' | 'BERSERI';
type CollectionCode = 'UMUM' | 'REF' | 'FIKSI';

interface TitleSeed {
  title: string;
  material: MaterialCode;
  classification: string;
  createdAt: number;
  /** A record of the SLiMS migration (source `slims:<n>`, in the run's legacy map); else one made here (`manual`). */
  migrated: boolean;
  localWork?: { who: string; kind: string };
  referenceKind?: string;
  copies: readonly CopySeed[];
}

interface CopySeed {
  collection: CollectionCode;
  status: 'available' | 'lost' | 'withdrawn' | 'on_order';
  createdAt: number;
  receivedDate?: string | null;
  inputOn?: string | null;
  archivedAt?: number | null;
  /** The copy's history: migrated (by the run), or made here at `createdAt`; plus later status changes. */
  origin: 'migrated' | 'created';
  later?: readonly { at: number; from: string; to: string }[];
}

/** Writes the titles and their copies, with their history and the SLiMS legacy map; the record ids in order. */
async function writeCatalogue(db: Db, o: { branchId: string; locationId: string; runId: string; migratedAt: number; titles: readonly TitleSeed[]; firstLegacy: number; firstBarcode: number }): Promise<{ records: string[]; items: string[][] }> {
  const material = { BUKU: await masterId(db, 'material_types', 'BUKU'), EBOOK: await masterId(db, 'material_types', 'EBOOK'), BERSERI: await masterId(db, 'material_types', 'BERSERI') };
  const collection = { UMUM: await masterId(db, 'collection_types', 'UMUM'), REF: await masterId(db, 'collection_types', 'REF'), FIKSI: await masterId(db, 'collection_types', 'FIKSI') };
  const records: Insertable<DB['records']>[] = [];
  const items: Insertable<DB['items']>[] = [];
  const events: Insertable<DB['item_events']>[] = [];
  const maps: Insertable<DB['migration_map']>[] = [];
  const recordIds: string[] = [];
  const itemIds: string[][] = [];
  let legacy = o.firstLegacy;
  let barcode = o.firstBarcode;
  for (const t of o.titles) {
    const id = newId(t.createdAt);
    recordIds.push(id);
    const recordLegacy = legacy;
    legacy += 1;
    const source = t.migrated ? `slims:${recordLegacy}` : 'manual';
    if (t.migrated) maps.push({ source: 'slims', entity: 'biblio', legacy_key: String(recordLegacy), target_id: id, run_id: o.runId });
    const callNumber = `${t.classification} ${t.title.slice(0, 3).toUpperCase()} ${t.title.slice(0, 1).toLowerCase()}`;
    records.push({
      id,
      material_type_id: material[t.material],
      title: t.title,
      subtitle: null,
      responsibility: null,
      title_key: titleKey(t.title),
      edition: null,
      material_detail: null,
      publisher_id: null,
      publication_place: null,
      publication_year: null,
      publication_date_text: null,
      physical_desc: null,
      series: null,
      classification: t.classification,
      call_number: callNumber,
      language_id: null,
      content_type: null,
      media_type: null,
      carrier_type: null,
      summary: null,
      notes: null,
      cover_file_id: null,
      source,
      merged_into: null,
      changed_at: t.createdAt,
      ...trail(t.createdAt),
      audience: null,
      local_work: t.localWork?.who ?? null,
      local_work_kind: t.localWork?.kind ?? null,
      reference_kind: t.referenceKind ?? null,
    });
    const copyIds: string[] = [];
    for (const c of t.copies) {
      const itemId = newId(c.createdAt);
      copyIds.push(itemId);
      const code = `SMA-${pad(barcode, 5)}`;
      barcode += 1;
      items.push({
        id: itemId,
        record_id: id,
        branch_id: o.branchId,
        barcode_display: code,
        barcode_key: normalizeKey(code),
        inventory_no: null,
        call_number: null,
        location_id: o.locationId,
        collection_type_id: collection[c.collection],
        status: c.status,
        status_note: null,
        acq_source: null,
        order_no: null,
        order_date: null,
        received_date: c.receivedDate ?? null,
        invoice_date: null,
        supplier_id: null,
        invoice_no: null,
        price: null,
        currency: null,
        note: null,
        ...trail(c.createdAt),
        archived_at: c.archivedAt ?? null,
        input_on: c.inputOn ?? null,
      });
      const first = c.origin === 'migrated' ? { at: o.migratedAt, type: 'migrated', actor: 'system' } : { at: c.createdAt, type: 'created', actor: 'staff' };
      // The status the copy had before its later changes.
      const firstStatus = c.later?.[0]?.from ?? c.status;
      events.push({
        id: newId(first.at),
        item_id: itemId,
        at: first.at,
        type: first.type,
        from_status: null,
        to_status: firstStatus,
        from_location_id: null,
        to_location_id: o.locationId,
        actor_type: first.actor,
        actor_id: null,
        meta: JSON.stringify({ fields: [] }),
      });
      for (const e of c.later ?? []) {
        events.push({
          id: newId(e.at),
          item_id: itemId,
          at: e.at,
          type: 'status',
          from_status: e.from,
          to_status: e.to,
          from_location_id: null,
          to_location_id: null,
          actor_type: 'staff',
          actor_id: null,
          meta: JSON.stringify({ fields: ['status'] }),
        });
      }
      if (c.origin === 'migrated') maps.push({ source: 'slims', entity: 'item', legacy_key: String(recordLegacy * 10 + copyIds.length), target_id: itemId, run_id: o.runId });
    }
    itemIds.push(copyIds);
  }
  await insertAll(db, 'records', records);
  await insertAll(db, 'items', items);
  await insertAll(db, 'item_events', events);
  await insertAll(db, 'migration_map', maps);
  return { records: recordIds, items: itemIds };
}

/** The classes of the non-fiction titles, in turn. */
const NONFICTION_CLASSES = Object.freeze(['300', '370.1', '500', '510', '600', '630', '900', '959.8', '2X4.3', '400']);
/** The reference kinds and a class for each. */
const REFERENCE = Object.freeze([
  ['encyclopedia', '030'],
  ['dictionary', '423'],
  ['handbook', '603'],
  ['globe', '912'],
  ['biography', '920'],
] as const);

/** The catalogue of the base dataset as title seeds, by role. */
function catalogueTitles(migratedAt: number): { base: TitleSeed[]; ebooks: TitleSeed[]; undated: TitleSeed[]; withdrawn: TitleSeed; lostCopy: TitleSeed; added: TitleSeed[] } {
  const migratedCopy = (collection: CollectionCode, dates: { receivedDate?: string; inputOn?: string }): CopySeed => ({
    collection,
    status: 'available',
    createdAt: migratedAt,
    origin: 'migrated',
    ...dates,
  });

  // 638 dated titles of the years 2015-2023: 0-199 fiction, 200-249 reference, the rest non-fiction; 0-219 have two
  // copies. Most copies carry their receiving date; every tenth title the date its copies were entered in SLiMS
  // instead, and every tenth (another) only its record's valid input date.
  const base: TitleSeed[] = [];
  for (let n = 0; n < 638; n += 1) {
    const year = 2015 + (n % 9);
    const date = dateIn(year, n);
    const fiction = n < 200;
    const ref = n >= 200 && n < 250 ? REFERENCE[(n - 200) % REFERENCE.length]! : null;
    const collection: CollectionCode = fiction ? 'FIKSI' : ref !== null ? 'REF' : 'UMUM';
    const dates = n % 10 === 7 ? { inputOn: date } : n % 10 === 8 ? {} : { receivedDate: date };
    const copies = n < 220 ? [migratedCopy(collection, dates), migratedCopy(collection, dates)] : [migratedCopy(collection, dates)];
    base.push({
      title: fiction ? `Novel Nusantara ${n + 1}` : ref !== null ? `Rujukan ${ref[0]} ${n + 1}` : `Buku Pelajaran ${n + 1}`,
      material: 'BUKU',
      classification: fiction ? '899.221' : ref !== null ? ref[1] : NONFICTION_CLASSES[n % NONFICTION_CLASSES.length]!,
      createdAt: goldenAt(date),
      migrated: true,
      ...(ref !== null && { referenceKind: ref[0] }),
      copies,
    });
  }

  const ebooks: TitleSeed[] = Array.from({ length: 20 }, (_, n) => ({
    title: `Buku Elektronik ${n + 1}`,
    material: 'EBOOK' as const,
    classification: '004',
    createdAt: goldenAt(dateIn(2022, n)),
    migrated: true,
    copies: [],
  }));

  // Migrated with an empty input date: the records carry the migration's clock, the copies no date at all.
  const undated: TitleSeed[] = Array.from({ length: 40 }, (_, n) => ({
    title: `Koleksi Lama Tanpa Tanggal ${n + 1}`,
    material: 'BUKU' as const,
    classification: NONFICTION_CLASSES[n % NONFICTION_CLASSES.length]!,
    createdAt: goldenAt('2026-01-02', '09:00') + (n + 1) * 1000,
    migrated: true,
    copies: [migratedCopy('UMUM', {})],
  }));

  const withdrawn: TitleSeed = {
    title: 'Kamus Ejaan Lama',
    material: 'BUKU',
    classification: '499.221',
    createdAt: goldenAt('2019-08-02'),
    migrated: true,
    copies: [{ collection: 'UMUM', status: 'withdrawn', createdAt: migratedAt, origin: 'migrated', receivedDate: '2019-08-01', archivedAt: goldenAt('2025-02-01') }],
  };

  const lostCopy: TitleSeed = {
    title: 'Atlas Indonesia',
    material: 'BUKU',
    classification: '912.598',
    createdAt: goldenAt('2021-04-13'),
    migrated: true,
    copies: [
      migratedCopy('UMUM', { receivedDate: '2021-04-12' }),
      {
        collection: 'UMUM',
        status: 'lost',
        createdAt: migratedAt,
        origin: 'migrated',
        receivedDate: '2021-04-12',
        later: [{ at: goldenAt('2026-01-05'), from: 'available', to: 'lost' }],
      },
    ],
  };

  // First acquisitions: 100 on 2024-03-15 and 101 on 2025-03-15 (migrated), 100 on 2026-02-15 (received here).
  const added: TitleSeed[] = [];
  const localWorks: readonly [string, string][] = [
    ['student', 'written_work'],
    ['student', 'clipping'],
    ['teacher', 'poetry'],
    ['student', 'abstract'],
    ['local', 'short_stories'],
    ['student', 'other'],
  ];
  for (const [year, count, fictionCount] of [
    [2024, 100, 0],
    [2025, 101, 30],
    [2026, 100, 20],
  ] as const) {
    const date = `${year}-${year === 2026 ? '02' : '03'}-15`;
    for (let n = 0; n < count; n += 1) {
      const fiction = n < fictionCount;
      // Serials: one received in 2024 only, three received in 2026.
      const serial = (year === 2024 && n === count - 1) || (year === 2026 && n >= count - 3);
      const local = year === 2025 && n >= 40 && n < 40 + localWorks.length ? localWorks[n - 40]! : null;
      const collection: CollectionCode = fiction ? 'FIKSI' : 'UMUM';
      const here = year === 2026;
      added.push({
        title: serial ? `Majalah Sekolah ${year}-${n + 1}` : local !== null ? `Karya ${local[0]} ${local[1]} ${n + 1}` : fiction ? `Cerita Baru ${year}-${n + 1}` : `Buku Baru ${year}-${n + 1}`,
        material: serial ? 'BERSERI' : 'BUKU',
        classification: fiction ? '899.221' : serial ? '050' : NONFICTION_CLASSES[n % NONFICTION_CLASSES.length]!,
        createdAt: goldenAt(date),
        migrated: !here,
        ...(local !== null && { localWork: { who: local[0], kind: local[1] } }),
        copies: [here ? { collection, status: 'available', createdAt: goldenAt(date), origin: 'created', receivedDate: date } : migratedCopy(collection, { receivedDate: date })],
      });
    }
  }
  return { base, ebooks, undated, withdrawn, lostCopy, added };
}

/** The ruled edge cases: an ordered copy, a copy received after the snapshot date, one more undated migrated record. */
function edgeTitles(migratedAt: number): { onOrder: TitleSeed; afterD: TitleSeed; undatedLate: TitleSeed } {
  return {
    onOrder: {
      title: 'Matematika Lanjut Kelas XII',
      material: 'BUKU',
      classification: '510',
      createdAt: goldenAt('2026-05-01'),
      migrated: false,
      copies: [{ collection: 'UMUM', status: 'on_order', createdAt: goldenAt('2026-05-01'), origin: 'created' }],
    },
    afterD: {
      title: 'Kimia Terapan Kelas XI',
      material: 'BUKU',
      classification: '540',
      createdAt: goldenAt('2026-08-01'),
      migrated: false,
      copies: [{ collection: 'UMUM', status: 'available', createdAt: goldenAt('2026-08-01'), origin: 'created', receivedDate: '2026-08-01' }],
    },
    // The source's input date was invalid, so the migration stored its own clock as the record's creation.
    undatedLate: {
      title: 'Koleksi Lama Tanggal Rusak',
      material: 'BUKU',
      classification: '370.1',
      createdAt: goldenAt('2026-01-02', '09:30'),
      migrated: true,
      copies: [{ collection: 'UMUM', status: 'available', createdAt: migratedAt, origin: 'migrated' }],
    },
  };
}

/** The usage rows of one month of the SLiMS aggregate import (the groups' visits with and without repeats, loans). */
interface MonthUsage {
  visitsDeduped: Readonly<Record<string, number>>;
  visits: Readonly<Record<string, number>>;
  loans: number;
}

/**
 * The twelve months of the school year: July and December are holidays with explicit zero cells; the ten school months
 * hold, per SLiMS member type (1 student, 2 teacher, 3 education staff, 4 public), deleted members and guests, the
 * visits without repeats (sums 520, 50, 20, 30, 35, 40) and the raw visits (580, 55, 25, 30, 40, 40).
 */
function usageMonths(): Map<string, MonthUsage> {
  const months = ['2025-07', '2025-08', '2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06'];
  const holidays = new Set(['2025-07', '2025-12']);
  const out = new Map<string, MonthUsage>();
  let school = 0;
  for (const m of months) {
    if (holidays.has(m)) {
      const zero = { 'slims_type:1': 0, 'slims_type:2': 0, 'slims_type:3': 0, 'slims_type:4': 0, member_unknown: 0, guest: 0 };
      out.set(m, { visitsDeduped: zero, visits: zero, loans: 0 });
      continue;
    }
    const firstHalf = school < 5;
    school += 1;
    out.set(m, {
      visitsDeduped: { 'slims_type:1': 52, 'slims_type:2': 5, 'slims_type:3': 2, 'slims_type:4': 3, member_unknown: firstHalf ? 4 : 3, guest: 4 },
      visits: { 'slims_type:1': 58, 'slims_type:2': firstHalf ? 6 : 5, 'slims_type:3': firstHalf ? 3 : 2, 'slims_type:4': 3, member_unknown: 4, guest: 4 },
      loans: 40,
    });
  }
  return out;
}

const lastDayOf = (month: string): string => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return `${month}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
};

/**
 * Writes the golden school dataset into the migrated database of `h` (the catalogue seed's masters present, no
 * catalogue yet) and answers its ids and the expected table.
 */
export async function seedSmaContoh(h: DbHandle, o: { withoutPopulation?: boolean; rulingEdges?: boolean } = {}): Promise<GoldenFixture> {
  const db = h.db;
  const seededAt = goldenAt('2026-07-01', '08:00');

  // ---- settings: a school library; the website features mapped to OPAC pages; otherwise the defaults --------------
  const pageAt = goldenAt('2025-07-15');
  const page = async (slug: string, status: 'published' | 'draft'): Promise<string> => {
    const id = newId(pageAt);
    await db
      .insertInto('pages')
      .values({ id, kind: 'page', slug_key: slug, status, published_at: status === 'published' ? pageAt : null, cover_file_id: null, ...trail(pageAt) })
      .execute();
    return id;
  };
  const websiteFeatures = {
    profilePageId: await page('profil', 'published'),
    servicesPageId: await page('layanan', 'published'),
    contactPageId: await page('kontak', 'published'),
    databasesPageId: await page('pangkalan-data', 'draft'),
    socialUrls: ['https://www.instagram.com/perpus.smacontoh'],
  };
  await withTx(h, (trx) =>
    writeSettings(trx, { 'library.name': 'Perpustakaan SMA Contoh', 'library.type': 'sekolah', 'accreditation.websiteFeatures': websiteFeatures }, { keyring: [], now: seededAt, actorId: null }),
  );

  // ---- branch, location, the migration run ---------------------------------------------------------------------
  const orgAt = goldenAt('2015-01-05');
  const branchId = newId(orgAt);
  await db
    .insertInto('branches')
    .values({ id: branchId, code_key: 'UTAMA', code_display: 'UTAMA', name: 'Perpustakaan SMA Contoh', address: null, timezone: GOLDEN_TZ, is_default: 1, archived_at: null, created_at: orgAt, created_by: null, updated_at: orgAt, updated_by: null })
    .execute();
  const locationId = newId(orgAt);
  await db
    .insertInto('locations')
    .values({
      id: locationId,
      branch_id: branchId,
      parent_id: null,
      kind: 'room',
      code_display: 'RB',
      code_key: normalizeKey('RB'),
      name: 'Ruang Baca',
      shelf_hint: null,
      class_from: null,
      class_to: null,
      map_file_id: null,
      map_x: null,
      map_y: null,
      map_w: null,
      map_h: null,
      ...trail(orgAt),
    })
    .execute();
  const span = GOLDEN_MIGRATION_SPAN;
  const migrationRunId = newId(span.from);
  await db
    .insertInto('catalog_runs')
    .values({
      id: migrationRunId,
      kind: 'migration',
      status: 'succeeded',
      dry_run: 0,
      format: null,
      options: JSON.stringify({ sourceKind: 'dump', sourceName: 'slims' }),
      summary: '{}',
      report_file_id: null,
      output_name: null,
      output_size: null,
      expires_at: null,
      job_id: null,
      created_at: span.from,
      created_by: null,
      finished_at: span.to,
    })
    .execute();

  // ---- the catalogue ---------------------------------------------------------------------------------------------
  const migratedAt = goldenAt('2026-01-02', '09:00');
  const t = catalogueTitles(migratedAt);
  const ordered: TitleSeed[] = [...t.ebooks, ...t.undated, t.withdrawn, t.lostCopy, ...t.base, ...t.added];
  const written = await writeCatalogue(db, { branchId, locationId, runId: migrationRunId, migratedAt, titles: ordered, firstLegacy: 1, firstBarcode: 1 });
  const undatedIds = written.records.slice(t.ebooks.length, t.ebooks.length + t.undated.length);
  const withdrawnId = written.records[t.ebooks.length + t.undated.length]!;
  const lostIndex = t.ebooks.length + t.undated.length + 1;
  const lostCopyId = written.records[lostIndex]!;
  const lostItemId = written.items[lostIndex]![1]!;
  let edges: GoldenFixture['records']['edges'];
  if (o.rulingEdges === true) {
    const e = edgeTitles(migratedAt);
    const more = await writeCatalogue(db, { branchId, locationId, runId: migrationRunId, migratedAt, titles: [e.onOrder, e.afterD, e.undatedLate], firstLegacy: 9001, firstBarcode: 9001 });
    edges = { onOrder: more.records[0]!, afterD: more.records[1]!, undatedLate: more.records[2]! };
  }

  // ---- usage: the SLiMS aggregate import, with its member types mapped ---------------------------------------------
  const mapAt = goldenAt('2026-07-01', '07:00');
  await insertAll(db, 'usage_group_map', [
    { group_key: 'slims_type:1', label: 'Siswa', accred_group: 'student', updated_at: mapAt, updated_by: null },
    { group_key: 'slims_type:2', label: 'Guru', accred_group: 'teacher', updated_at: mapAt, updated_by: null },
    { group_key: 'slims_type:3', label: 'Tenaga Kependidikan', accred_group: 'edu_staff', updated_at: mapAt, updated_by: null },
    { group_key: 'slims_type:4', label: 'Umum', accred_group: 'public', updated_at: mapAt, updated_by: null },
  ]);
  const usage: Insertable<DB['usage_stats']>[] = [];
  const cell = (metric: string, from: string, to: string, groupKey: string, value: number) =>
    usage.push({ source: 'slims', metric, span_from: from, span_to: to, branch_key: '', group_key: groupKey, value, run_id: null, updated_at: mapAt, updated_by: null });
  for (const [month, u] of usageMonths()) {
    const from = `${month}-01`;
    const to = lastDayOf(month);
    for (const [key, v] of Object.entries(u.visitsDeduped)) cell('visits_deduped', from, to, key, v);
    for (const [key, v] of Object.entries(u.visits)) cell('visits', from, to, key, v);
    cell('loans', from, to, '', u.loans);
  }
  cell('titles_used', '2025-07-01', '2026-06-30', '', 250);
  await insertAll(db, 'usage_stats', usage);

  // ---- registers ---------------------------------------------------------------------------------------------------
  const activities: Insertable<DB['library_activities']>[] = [];
  const activity = (kind: string, heldOn: string, more: { facility?: boolean; speaker?: boolean; archived?: boolean } = {}) => {
    const at = goldenAt(heldOn);
    activities.push({
      id: newId(at),
      branch_id: null,
      kind,
      title: `Kegiatan ${kind} ${heldOn}`,
      held_on: heldOn,
      ended_on: null,
      participants: 30,
      partner: null,
      uses_library_facility: more.facility === true ? 1 : 0,
      external_speaker: more.speaker === true ? 1 : 0,
      description: null,
      ...trail(at),
      archived_at: more.archived === true ? goldenAt('2026-03-01') : null,
    });
  };
  // Days inside the period, one per activity of a kind.
  const PERIOD_DAYS = ['2025-08-05', '2025-09-06', '2025-10-07', '2025-11-08', '2026-01-09', '2026-02-10', '2026-03-11', '2026-04-12', '2026-05-13'];
  const series = (kind: string, count: number) => {
    for (let k = 0; k < count; k += 1) activity(kind, PERIOD_DAYS[k]!);
  };
  series('needs_survey', 2);
  series('reading_culture', 4);
  series('reading_guidance', 5);
  activity('writing_guidance', '2025-09-10', { facility: true, speaker: true });
  activity('writing_guidance', '2025-10-10');
  activity('writing_guidance', '2026-02-10');
  series('plagiarism_guidance', 1);
  series('innovation', 2);
  series('external_literacy', 2);
  series('satisfaction_survey', 1);
  activity('learning_session', '2025-08-20', { facility: true });
  activity('learning_session', '2025-10-20');
  activity('learning_session', '2026-01-20');
  activity('learning_session', '2026-03-20');
  series('promotion', 9);
  activity('promotion', '2025-06-30');
  activity('promotion', '2025-11-11', { archived: true });
  activity('stocktake', '2024-08-10');
  activity('weeding', '2024-08-12');
  for (const day of ['2023-09-15', '2024-09-15', '2025-09-15', '2026-04-15']) activity('preservation', day);
  activity('preservation', '2023-03-01');
  await insertAll(db, 'library_activities', activities);

  const documents: Insertable<DB['library_documents']>[] = [];
  const document = (kind: string, issuedOn: string | null, aspects: readonly string[] | null = null, validUntil: string | null = null) => {
    const at = issuedOn === null ? goldenAt('2023-01-10') : goldenAt(issuedOn);
    documents.push({
      id: newId(at),
      branch_id: null,
      kind,
      title: `Dokumen ${kind}${issuedOn === null ? '' : ` ${issuedOn}`}`,
      reference: null,
      issued_on: issuedOn,
      issued_by: null,
      aspect_codes: aspects === null ? null : JSON.stringify(aspects),
      valid_until: validUntil,
      file_id: null,
      ...trail(at),
    });
  };
  document('collection_policy', '2024-01-15', ['a1', 'a2', 'a3', 'a4', 'a5', 'a6']);
  document('rules', '2023-07-17');
  document('sop_membership', '2023-07-17');
  document('sop_loan', '2023-07-17');
  document('founding_decree', '1990-07-02');
  document('duties', '2023-07-17');
  for (const kind of ['pos_collection', 'pos_organisation', 'pos_service', 'pos_promotion']) document(kind, '2024-01-15');
  document('library_program', '2025-07-14', ['a1', 'a2', 'a3']);
  document('head_performance_report', '2026-06-01', ['a1', 'a2', 'a3', 'a4']);
  for (const day of ['2023-12-15', '2024-12-15', '2025-12-15']) document('report_annual', day);
  for (const day of ['2023-12-20', '2024-06-20', '2024-12-20', '2025-06-20', '2025-12-20', '2026-06-20']) document('report_semester', day);
  for (const day of ['2023-09-30', '2023-12-31', '2024-03-31', '2024-09-30', '2024-12-31', '2025-03-31', '2025-09-30', '2025-12-31', '2026-03-31']) document('report_quarterly', day);
  await insertAll(db, 'library_documents', documents);

  const staffAt = goldenAt('2020-07-01');
  const person = (name: string, role: string, f: { librarian: boolean; level: string; training: boolean; startsOn: string; endsOn?: string }): Insertable<DB['library_staff']> => ({
    id: newId(goldenAt(f.startsOn)),
    branch_id: null,
    staff_user_id: null,
    name,
    position: null,
    role,
    is_librarian: f.librarian ? 1 : 0,
    employment: 'civil_servant',
    education_level: f.level,
    education_library: 0,
    library_training: f.training ? 1 : 0,
    competency_cert: 0,
    association_member: 0,
    appointment_ref: null,
    starts_on: f.startsOn,
    ends_on: f.endsOn ?? null,
    ...trail(staffAt),
  });
  const head = person('Kepala Perpustakaan Contoh', 'head', { librarian: true, level: 's1', training: true, startsOn: '2020-07-01' });
  const technical = person('Tenaga Teknis Contoh', 'technical', { librarian: false, level: 'sma', training: true, startsOn: '2022-01-10' });
  const former = person('Pustakawan Terdahulu', 'librarian', { librarian: true, level: 'd3', training: true, startsOn: '2018-01-02', endsOn: '2025-01-31' });
  await insertAll(db, 'library_staff', [head, technical, former]);
  const trainings: Insertable<DB['staff_trainings']>[] = [];
  const training = (staffId: string, heldOn: string) => {
    const at = goldenAt(heldOn);
    trainings.push({ id: newId(at), library_staff_id: staffId, title: `Pelatihan ${heldOn}`, organizer: null, held_on: heldOn, hours: 8, certificate_file_id: null, ...trail(at) });
  };
  for (const day of ['2023-08-10', '2023-11-10', '2024-02-10', '2024-08-10', '2025-02-10', '2025-08-10', '2026-02-10']) training(head.id, day);
  for (const day of ['2023-10-12', '2024-04-12', '2024-10-12', '2025-04-12', '2026-04-12']) training(technical.id, day);
  training(head.id, '2023-05-01');
  training(former.id, '2024-03-05');
  training(former.id, '2024-10-05');
  await insertAll(db, 'staff_trainings', trainings);

  const partnerships: Insertable<DB['library_partnerships']>[] = [];
  const partnership = (partner: string, kind: string, startsOn: string, endsOn: string | null) => {
    const at = goldenAt(startsOn);
    partnerships.push({ id: newId(at), branch_id: null, partner, kind, starts_on: startsOn, ends_on: endsOn, scope: null, document_file_id: null, ...trail(at) });
  };
  partnership('Taman Bacaan Pelangi', 'mou', '2023-01-01', '2024-12-31');
  partnership('Dinas Perpustakaan Kota', 'pks', '2025-02-01', null);
  partnership('Dinas  Perpustakaan kota', 'pks', '2025-08-01', null);
  partnership('Penerbit Cahaya Ilmu', 'mou', '2026-01-10', '2027-01-09');
  partnership('Komunitas Literasi Lama', 'mou', '2022-07-01', '2023-06-30');
  await insertAll(db, 'library_partnerships', partnerships);

  const budgetAt = goldenAt('2024-01-05');
  await insertAll(
    db,
    'library_budgets',
    (
      [
        [2024, 6_500_000],
        [2025, 5_200_000],
        [2026, 6_900_000],
      ] as const
    ).map(([year, library]) => ({
      id: newId(budgetAt + year),
      scope_key: '',
      branch_id: null,
      year,
      library_minor: library,
      parent_minor: 250_000_000,
      parent_nonpersonnel_minor: 100_000_000,
      collection_minor: null,
      community_minor: null,
      currency: 'IDR',
      note: null,
      ...trail(budgetAt),
    })),
  );

  // ---- the three periods, with the four answers given by hand ----------------------------------------------------
  const periodAt = goldenAt('2025-07-01', '08:00');
  const periods = {} as Record<GoldenLevel, string>;
  const instruments = {} as Record<GoldenLevel, string>;
  for (const level of GOLDEN_LEVELS) {
    const spec = GOLDEN_INSTRUMENTS[level];
    const id = newId(periodAt);
    periods[level] = id;
    instruments[level] = spec.instrumentId;
    await db
      .insertInto('accred_periods')
      .values({
        id,
        branch_id: null,
        name: spec.name,
        kind: 'school_year',
        starts_on: '2025-07-01',
        ends_on: '2026-06-30',
        instrument_id: spec.instrumentId,
        status: 'open',
        frozen_at: null,
        frozen_by: null,
        profile: JSON.stringify({ schoolName: 'SMA Contoh', schoolLevel: spec.schoolLevel, status: 'negeri', npp: '3201010D1000004' }),
        students: o.withoutPopulation === true ? null : 108,
        teachers: 10,
        edu_staff: o.withoutPopulation === true ? null : 5,
        classes: 3,
        population_served: null,
        teachers_using: 4,
        all_registered_confirmed: 0,
        user_pcs: 4,
        staff_pcs: 1,
        ict_devices: 5,
        scanners: 2,
        floor_m2: null,
        bandwidth_mbps: 30,
        hours_per_week: 35,
        services: JSON.stringify(['reading_room', 'circulation', 'reference', 'information_literacy', 'speed_reading', 'extension']),
        external_website_url: null,
        version: 0,
        ...trail(periodAt),
      })
      .execute();
    await insertAll(
      db,
      'accred_answers',
      (
        [
          ['SCH-SP1', 'a'],
          ['SCH-SP2', 'b'],
          ['SCH-SP3', 'c'],
          ['SCH-F3', 'c'],
        ] as const
      ).map(([code, answer]) => ({ period_id: id, indicator_code: code, answer, mode: 'manual', note: null, updated_at: periodAt, updated_by: null })),
    );
  }

  return {
    periods: Object.freeze(periods),
    instruments: Object.freeze(instruments),
    branchId,
    locationId,
    migrationRunId,
    records: { undated: Object.freeze(undatedIds), withdrawn: withdrawnId, lostCopy: lostCopyId, ...(edges !== undefined && { edges }) },
    items: { lost: lostItemId },
    staff: { head: head.id, technical: technical.id, former: former.id },
    expected: GOLDEN_EXPECTED,
  };
}
