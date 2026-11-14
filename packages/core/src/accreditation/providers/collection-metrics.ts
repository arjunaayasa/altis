import { compareDdcRowKeys, DDC_MAINS } from '@altis/shared';
import type { NoteRef } from '@altis/shared/api/accreditation';
import type { AccredSettings } from '../../settings/accreditation.js';
import type { AccredMetricId } from '../metric-ids.js';
import type { AccredNoteKey } from '../notes.js';
import type { AccredMetricValue } from '../types.js';
import type { ResolvedCell } from '../usage/index.js';
import { localKindOrder, referenceKindOrder, type CollectionCounters, type CollectionDays, type CollectionMetricId } from './collection-scan.js';

// The values of the collection metrics from the finished counters of the pass (collection-scan.ts), with their notes:
// percentages are cut to whole numbers once, at the end, with integers (the note says so whenever decimals were
// dropped); a value without data is null and a note says why. The undated copies are counted in the notes of the
// stock and of both additions (an undated copy is never an addition), and when their share of the copies in stock is
// above the setting's limit neither share of additions suggests an answer: it is printed for the librarian to choose.
// The words the notes carry as parameters (the fiction rule, the unit of use) are in Indonesian, the language of the
// accreditation documents that print them.

/** What the values are computed for: the period, its days, the settings and the instrument's metric parameters. */
export interface CollectionScope {
  periodId: string;
  days: CollectionDays;
  settings: AccredSettings;
  /** The period's barcode scanners (null: not filled in). */
  scanners: number | null;
  paramsOf(metric: AccredMetricId): Readonly<Record<string, unknown>>;
}

const note = (key: AccredNoteKey, params?: Record<string, string | number>): NoteRef => (params === undefined ? { key } : { key, params });

/** `floor(n × 100 ÷ d)` in integers (d > 0), and whether decimals were dropped. */
export function shareOf(n: number, d: number): { value: number; cut: boolean } {
  const scaled = n * 100;
  const rest = scaled % d;
  return { value: (scaled - rest) / d, cut: rest !== 0 };
}

/** A required part of the counters (the pass counted it for this metric). */
function part<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new TypeError(`collection metrics: the pass did not count ${name}`);
  return value;
}

/** The rule a title counts as fiction by, in words (printed in the fiction note). */
export function fictionRule(s: AccredSettings): string {
  const f = s.fiction;
  const parts: string[] = [];
  if (f.collectionTypeCodes.length > 0) parts.push(`tipe koleksi ${f.collectionTypeCodes.join(', ')}`);
  if (f.callNumberPrefixes.length > 0) parts.push(`nomor panggil berawalan ${f.callNumberPrefixes.join(', ')}`);
  if (f.ddcPrefixes.length > 0) parts.push(`klasifikasi berawalan ${f.ddcPrefixes.join(', ')}`);
  return parts.length === 0 ? 'belum ada aturan fiksi di pengaturan Akreditasi' : parts.join(' atau ');
}

/**
 * The notes about undated copies, and whether their share of the copies in stock at `D` is above the limit
 * (`undated × 100 > limit × live`, exactly): then a share of additions suggests no answer.
 */
function undatedNotes(c: CollectionCounters, s: AccredSettings): { notes: NoteRef[]; tooMany: boolean } {
  const notes: NoteRef[] = [];
  if (c.undatedItems > 0) notes.push(note('accred.note.items_without_received_date', { count: c.undatedItems }));
  const tooMany = c.undatedItems * 100 > s.undatedShareMaxPct * c.liveItems;
  if (tooMany) notes.push(note('accred.note.undated_share_high', { pct: shareOf(c.undatedItems, c.liveItems).value, max: s.undatedShareMaxPct }));
  return { notes, tooMany };
}

// ---- tables -------------------------------------------------------------------------------------------------------

/** The printed titles and their copies per DDC row: every main class (`2X` and `NON` too), and each division that holds a title. */
export function ddcTable(c: CollectionCounters): [string, number, number][] {
  const ddc = part(c.ddc, 'the DDC classes');
  const keys = new Set<string>(DDC_MAINS);
  for (const [key, [titles]] of Object.entries(ddc)) if (titles > 0) keys.add(key);
  return [...keys].sort(compareDdcRowKeys).map((key) => [key, ddc[key]?.[0] ?? 0, ddc[key]?.[1] ?? 0]);
}

/** The total printed titles and copies (the sum of the main classes). */
export function ddcTotals(c: CollectionCounters): [number, number] {
  const ddc = part(c.ddc, 'the DDC classes');
  let titles = 0;
  let items = 0;
  for (const main of DDC_MAINS) {
    titles += ddc[main]?.[0] ?? 0;
    items += ddc[main]?.[1] ?? 0;
  }
  return [titles, items];
}

/** The media and kinds of the collection matrix, in print order. */
export const MATRIX_MEDIA = Object.freeze(['print', 'electronic'] as const);
export const MATRIX_KINDS = Object.freeze(['fiction', 'nonfiction', 'reference'] as const);

export type MatrixMedium = (typeof MATRIX_MEDIA)[number];
export type MatrixKind = (typeof MATRIX_KINDS)[number];

/** Titles and copies by medium and kind: six rows `[medium, kind, titles, items]`. */
export function matrixTable(c: CollectionCounters): [MatrixMedium, MatrixKind, number, number][] {
  const matrix = part(c.matrix, 'the collection matrix');
  const rows: [MatrixMedium, MatrixKind, number, number][] = [];
  for (const medium of MATRIX_MEDIA) {
    for (const kind of MATRIX_KINDS) {
      const p = matrix[`${medium}.${kind}`];
      rows.push([medium, kind, p?.[0] ?? 0, p?.[1] ?? 0]);
    }
  }
  return rows;
}

/** The additions table: the stock on the day before the three years, then the titles added in each year. */
export function additionsTable(c: CollectionCounters, days: CollectionDays): [string | number, number][] {
  const start = part(c.windowStart, 'the starting collection');
  const added = part(c.additions, 'the additions');
  return [[days.windowBefore, start], ...days.windowYears.map((y, k): [number, number] => [y, added[k]!])];
}

/** The share of additions over the three years: `[added, start, value]` (value null without a starting collection). */
export function additionsShare(c: CollectionCounters): { added: number; start: number; value: number | null; cut: boolean } {
  const start = part(c.windowStart, 'the starting collection');
  const added = part(c.additions, 'the additions').reduce((a, b) => a + b, 0);
  if (start === 0) return { added, start, value: null, cut: false };
  const share = shareOf(added, start);
  return { added, start, value: share.value, cut: share.cut };
}

// ---- values -------------------------------------------------------------------------------------------------------

/** A percentage of `n` out of `d` (null with `nullNote` when d = 0), the truncation noted. */
function percent(n: number, d: number, notes: NoteRef[], nullNote: NoteRef | null): Pick<AccredMetricValue, 'value' | 'numerator' | 'denominator' | 'notes'> {
  if (d === 0) return { value: null, notes: nullNote === null ? notes : [...notes, nullNote] };
  const share = shareOf(n, d);
  return { value: share.value, numerator: n, denominator: d, notes: share.cut ? [...notes, note('accred.note.truncated')] : notes };
}

function additionsValue(c: CollectionCounters, s: CollectionScope): AccredMetricValue {
  const { notes, tooMany } = undatedNotes(c, s.settings);
  const share = additionsShare(c);
  const out: AccredMetricValue = {
    value: share.value,
    unit: 'percent',
    basis: 'live',
    notes: share.value === null ? [...notes, note('accred.note.k6_no_start')] : share.cut ? [...notes, note('accred.note.truncated')] : notes,
    detail: { reportId: 'accreditation.annex.additions', params: { periodId: s.periodId } },
    table: additionsTable(c, s.days),
    facts: { undated: c.undatedItems, live: c.liveItems },
  };
  if (share.value !== null) {
    out.numerator = share.added;
    out.denominator = share.start;
  }
  if (tooMany) out.suggest = false;
  return out;
}

function periodAdditionsValue(c: CollectionCounters, s: CollectionScope): AccredMetricValue {
  const { notes, tooMany } = undatedNotes(c, s.settings);
  const out: AccredMetricValue = {
    ...percent(part(c.periodAdditions, 'the additions of the period'), part(c.periodStart, 'the stock before the period'), notes, null),
    unit: 'percent',
    basis: 'live',
    facts: { undated: c.undatedItems, live: c.liveItems },
  };
  if (tooMany) out.suggest = false;
  return out;
}

function localWorkValue(c: CollectionCounters, s: CollectionScope): AccredMetricValue {
  const detail = { reportId: 'collection.title_list', params: { asOf: s.days.D, localWorkOnly: true } };
  if (part(c.anyLocalKind, 'the local works') === false) {
    return { value: null, unit: 'count', basis: 'live', notes: [note('accred.note.l6_manual')], detail, facts: { elements: [] } };
  }
  const found = part(c.localKinds, 'the local works');
  const counted = s.paramsOf('collection.local_work_kinds')['countedKinds'];
  const elements = Array.isArray(counted) ? (counted as unknown[]).filter((k): k is string => typeof k === 'string' && found.includes(k)) : localKindOrder(found);
  return { value: elements.length, unit: 'count', basis: 'live', notes: [], detail, facts: { elements } };
}

function referenceKindsValue(c: CollectionCounters, s: CollectionScope): AccredMetricValue {
  const elements = referenceKindOrder(part(c.referenceKinds, 'the reference kinds'));
  const facts: Record<string, readonly string[]> = { elements };
  const named = s.paramsOf('collection.reference_kinds')['namedKinds'];
  if (Array.isArray(named)) {
    const names = (named as unknown[]).filter((k): k is string => typeof k === 'string');
    facts['namedPresent'] = names.filter((k) => elements.includes(k));
    facts['namedMissing'] = names.filter((k) => !elements.includes(k));
  }
  return { value: elements.length, unit: 'count', basis: 'live', notes: [], facts };
}

function enrichmentNotes(s: CollectionScope): NoteRef[] {
  return s.settings.textbookCollectionTypeCodes.length === 0 ? [note('accred.note.snp_textbook_default')] : [];
}

/**
 * The value of collection metric `id` from the finished counters (every metric of the provider but the share of the
 * collection used, which also reads the usage table: {@link collectionUsedValue}).
 *
 * @throws TypeError for another id, or when the pass did not count what `id` needs
 */
export function collectionMetricValue(id: CollectionMetricId, c: CollectionCounters, s: CollectionScope): AccredMetricValue {
  const D = s.days.D;
  const live = { unit: 'count' as const, basis: 'live' as const };
  switch (id) {
    case 'collection.titles': {
      const notes: NoteRef[] = [];
      if (c.noCopies > 0) notes.push(note('accred.note.electronic_counted', { count: c.noCopies }));
      if (c.placeholders > 0) notes.push(note('accred.note.replacement_records', { count: c.placeholders }));
      if (c.undatedItems > 0) notes.push(note('accred.note.items_without_received_date', { count: c.undatedItems }));
      return {
        value: c.titles,
        ...live,
        notes,
        detail: { reportId: 'collection.title_list', params: { asOf: D } },
        facts: { electronicNoItems: c.noCopies, replacementRecords: c.placeholders, undatedItems: c.undatedItems },
      };
    }
    case 'collection.fiction_pct':
      return {
        ...percent(part(c.fiction, 'the fiction titles'), c.titles, [], note('accred.note.collection_empty')),
        unit: 'percent',
        basis: 'live',
        detail: { reportId: 'collection.title_list', params: { asOf: D, fictionOnly: true } },
        facts: { rule: fictionRule(s.settings) },
      };
    case 'collection.titles_window_start':
      return { value: part(c.windowStart, 'the starting collection'), ...live, notes: [] };
    case 'collection.title_additions_3y_pct':
      return additionsValue(c, s);
    case 'collection.undated_items':
      if (c.liveItems === 0) return { value: null, ...live, notes: [note('accred.note.collection_empty')], facts: { live: 0, pct: null } };
      return {
        value: c.undatedItems,
        ...live,
        notes: c.undatedItems > 0 ? [note('accred.note.items_without_received_date', { count: c.undatedItems })] : [],
        facts: { live: c.liveItems, pct: shareOf(c.undatedItems, c.liveItems).value },
      };
    case 'collection.k7_organisation': {
      const processed = part(c.processed, 'the processed copies');
      const facts = { live: c.liveItems, processed, threshold: s.settings.k7ThresholdPct, scanners: s.scanners };
      const detail = { reportId: 'collection.data_quality', params: {} };
      if (c.liveItems === 0) return { value: null, unit: 'percent', basis: 'live', notes: [note('accred.note.collection_empty')], detail, facts };
      return { value: shareOf(processed, c.liveItems).value, numerator: processed, denominator: c.liveItems, unit: 'percent', basis: 'live', notes: [], detail, facts };
    }
    case 'collection.local_work_kinds':
      return localWorkValue(c, s);
    case 'collection.ddc_printed_recap':
      return {
        value: ddcTotals(c)[0],
        ...live,
        notes: [],
        detail: { reportId: 'accreditation.annex.ddc', params: { periodId: s.periodId } },
        table: ddcTable(c),
      };
    case 'collection.profile_matrix':
      return {
        value: c.titles,
        ...live,
        notes: [],
        detail: { reportId: 'accreditation.annex.collection_matrix', params: { periodId: s.periodId } },
        table: matrixTable(c),
      };
    case 'collection.live_items':
      return { value: c.liveItems, ...live, notes: [] };
    case 'collection.enrichment_fiction_pct': {
      const fiction = part(c.enrichmentFiction, 'the fiction enrichment titles');
      const enrichment = part(c.enrichment, 'the enrichment titles');
      return { ...percent(fiction, enrichment, enrichmentNotes(s), null), unit: 'percent', basis: 'live', facts: { fiction, enrichment } };
    }
    case 'collection.enrichment_titles':
      return { value: part(c.enrichment, 'the enrichment titles'), ...live, notes: enrichmentNotes(s) };
    case 'collection.reference_kinds':
      return referenceKindsValue(c, s);
    case 'collection.serial_titles_recent':
      return { value: part(c.serials, 'the serial titles'), ...live, notes: [note('accred.note.snp_serials_approx')] };
    case 'collection.titles_period_start':
      return { value: part(c.periodStart, 'the stock before the period'), ...live, notes: [] };
    case 'collection.title_additions_period_pct':
      return periodAdditionsValue(c, s);
    case 'usage.collection_used_pct':
      throw new TypeError('collection metrics: the share of the collection used reads the usage table (collectionUsedValue)');
  }
}

/** The words of the units of use in the documents. */
const USED_UNIT_WORDS = Object.freeze({ titles: 'judul', items: 'eksemplar' } as const);

/**
 * The share of the collection used in the period: the titles (or copies, by the setting) used, from the period's span
 * cell of the usage table, out of the titles (or copies) in stock at `D`. The unit is always noted.
 */
export function collectionUsedValue(c: CollectionCounters, used: ResolvedCell, s: AccredSettings): AccredMetricValue {
  const unit = s.usedUnit;
  const base = unit === 'items' ? c.liveItems : c.titles;
  const notes = [note('accred.note.usage_unit', { unit: USED_UNIT_WORDS[unit] })];
  const facts = { unit, used: used.value, base };
  if (used.value === null) return { value: null, unit: 'percent', basis: 'none', notes: [...notes, note('accred.note.usage_no_data')], facts };
  return {
    ...percent(used.value, base, notes, note('accred.note.collection_empty')),
    unit: 'percent',
    basis: used.source === 'manual' ? 'manual' : 'imported',
    facts,
  };
}
