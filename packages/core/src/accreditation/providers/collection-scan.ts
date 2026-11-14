import type { DB } from '@altis/db';
import { addDays, foldByDdc, LOCAL_WORK_KINDS, REFERENCE_KINDS } from '@altis/shared';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { decodeCursor, encodeCursor, isFiction, isReference, SCAN_MARGIN_MS, SCHOOL_LOCAL_WORKS } from '../../reports/collection/common.js';
import { reportFieldErrors } from '../../reports/runs/service.js';
import { acquisitionOf, firstAcq, inStockAt, liveAt, scanRecordStock, STOCK_SCAN_MAX_LIMIT, type ItemStockFacts, type RecordStockFacts } from '../../reports/stock/index.js';
import type { ReportCtx } from '../../reports/types.js';
import type { AccredSettings } from '../../settings/accreditation.js';
import type { AccredMetricId } from '../metric-ids.js';
import { resolveWindow, snapshotDate } from '../windows.js';

// The one pass of the collection metrics over the stock (spec §10.5, §10.6): every title is read once, by id keyset
// through the stock reader, and every counter the asked metrics need is added up on the way. The counters are plain
// JSON, so the pass stops between batches when the slice's budget runs low and goes on from the last title read: the
// evaluation keeps them in its resume state, an annex in its report cursor. The stock at a day, the acquisition date of
// a copy and the first acquisition of a title are the stock reader's rules; the fiction and reference rules are the
// collection reports' own, so a list of fiction titles and the fiction share agree.
//
// A title is an addition of a window when it is not archived, its first acquisition is a known day inside the window,
// and it was not in the stock on the day before the window. An undated copy (a migrated copy whose only date is the
// migration's own clock, an imported copy without dates) makes its title's first acquisition unknown, so such a title
// is in the stock at every date and never an addition; an ordered copy is never acquired; a title without copies is an
// addition by its creation only when it counts in the stock without copies at all (electronic, or a public file).

/** The parts of the pass a metric may need beyond the stock at the snapshot date (always counted). */
export type CollectionPart = 'fiction' | 'ddc' | 'matrix' | 'k7' | 'localWork' | 'enrichment' | 'referenceKinds' | 'serials' | 'threeYears' | 'period';

/** The ids the collection provider computes (its own and the share of the collection used). */
export type CollectionMetricId = Extract<AccredMetricId, `collection.${string}`> | 'usage.collection_used_pct';

const PARTS_OF: Readonly<Record<CollectionMetricId, readonly CollectionPart[]>> = Object.freeze({
  'collection.titles': [],
  'collection.fiction_pct': ['fiction'],
  'collection.titles_window_start': ['threeYears'],
  'collection.title_additions_3y_pct': ['threeYears'],
  'collection.undated_items': [],
  'collection.k7_organisation': ['k7'],
  'collection.local_work_kinds': ['localWork'],
  'collection.ddc_printed_recap': ['ddc'],
  'collection.profile_matrix': ['matrix'],
  'collection.live_items': [],
  'collection.enrichment_fiction_pct': ['enrichment'],
  'collection.enrichment_titles': ['enrichment'],
  'collection.reference_kinds': ['referenceKinds'],
  'collection.serial_titles_recent': ['serials'],
  'collection.titles_period_start': ['period'],
  'collection.title_additions_period_pct': ['period'],
  'usage.collection_used_pct': [],
});

/** True for an id the collection provider computes. */
export function isCollectionMetric(id: string): id is CollectionMetricId {
  return Object.hasOwn(PARTS_OF, id);
}

/** The parts the metrics `ids` need, once each. */
export function partsFor(ids: readonly CollectionMetricId[]): Set<CollectionPart> {
  return new Set(ids.flatMap((id) => PARTS_OF[id]));
}

// ---- the days -----------------------------------------------------------------------------------------------------

/** The days and spans the pass reads the stock at, for a period and its snapshot date `D` (every span ends by `D`). */
export interface CollectionDays {
  D: string;
  /** The three calendar years ending in the year the period ends: the day before them, their span, the years. */
  windowBefore: string;
  windowFrom: string;
  windowTo: string;
  windowYears: readonly [number, number, number];
  /** The period: the day before it starts and its span. */
  periodBefore: string;
  periodFrom: string;
  periodTo: string;
  /** The first day of the twelve months to `D`. */
  serialFrom: string;
}

/** The days of the pass for the period `p` read at `D`. */
export function collectionDays(p: { startsOn: string; endsOn: string }, D: string): CollectionDays {
  const window = resolveWindow('three_calendar_years', p, D);
  const period = resolveWindow('period', p, D);
  const y = Number(p.endsOn.slice(0, 4));
  return {
    D,
    windowBefore: window.before ?? `${String(y - 3).padStart(4, '0')}-12-31`,
    windowFrom: window.from,
    windowTo: window.to,
    windowYears: [y - 2, y - 1, y],
    periodBefore: addDays(p.startsOn, -1),
    periodFrom: period.from,
    periodTo: period.to,
    serialFrom: resolveWindow('twelve_months', p, D).from,
  };
}

// ---- the counters -------------------------------------------------------------------------------------------------

/** The most distinct kinds (local works, reference works) the counters keep: more than every vocabulary holds. */
const KINDS_MAX = 64;

const count = z.int().min(0).max(Number.MAX_SAFE_INTEGER);
/** Titles and copies. */
const pair = z.tuple([count, count]);
const kinds = z.array(z.string().min(1).max(16)).max(KINDS_MAX);

/**
 * What the pass has counted so far. The stock at `D` is always counted; each optional part is present exactly when a
 * metric asked for it. Plain JSON: the resume state of the evaluation and the cursor of an annex.
 */
export const CollectionCounters = z.strictObject({
  /** Titles in stock at `D`; of them without any copy, and placeholders a migration made for orphan copies. */
  titles: count,
  noCopies: count,
  placeholders: count,
  /** Copies in stock at `D`; of them without an acquisition date. */
  liveItems: count,
  undatedItems: count,
  /** Titles in stock at `D` that are fiction. */
  fiction: count.optional(),
  /** Printed titles in stock at `D` and their copies, by DDC row key (main classes and divisions). */
  ddc: z.record(z.string().min(1).max(16), pair).optional(),
  /** Titles in stock at `D` and their copies by medium and kind (`print.fiction`, …). */
  matrix: z.record(z.string().min(1).max(32), pair).optional(),
  /** Copies in stock at `D` that are fully processed. */
  processed: count.optional(),
  /** The work kinds of school local works in stock at `D`, and whether any live title has a work kind at all. */
  localKinds: kinds.optional(),
  anyLocalKind: z.boolean().optional(),
  /** Enrichment titles in stock at `D` (no reference or textbook copy), and the fiction ones among them. */
  enrichment: count.optional(),
  enrichmentFiction: count.optional(),
  /** The reference kinds of titles in stock at `D`. */
  referenceKinds: kinds.optional(),
  /** Serial titles in stock at `D` with a copy acquired in the twelve months to `D`. */
  serials: count.optional(),
  /** The stock on the day before the three years, and the additions of each year. */
  windowStart: count.optional(),
  additions: z.tuple([count, count, count]).optional(),
  /** The stock on the day before the period, and the additions of the period. */
  periodStart: count.optional(),
  periodAdditions: count.optional(),
});

export type CollectionCounters = z.infer<typeof CollectionCounters>;

/** The fields of each part in the counters. */
const PART_FIELDS: Readonly<Record<CollectionPart, readonly (keyof CollectionCounters)[]>> = Object.freeze({
  fiction: ['fiction'],
  ddc: ['ddc'],
  matrix: ['matrix'],
  k7: ['processed'],
  localWork: ['localKinds', 'anyLocalKind'],
  enrichment: ['enrichment', 'enrichmentFiction'],
  referenceKinds: ['referenceKinds'],
  serials: ['serials'],
  threeYears: ['windowStart', 'additions'],
  period: ['periodStart', 'periodAdditions'],
});

/** Empty counters for `parts`. */
export function newCounters(parts: ReadonlySet<CollectionPart>): CollectionCounters {
  const c: CollectionCounters = { titles: 0, noCopies: 0, placeholders: 0, liveItems: 0, undatedItems: 0 };
  if (parts.has('fiction')) c.fiction = 0;
  if (parts.has('ddc')) c.ddc = {};
  if (parts.has('matrix')) c.matrix = {};
  if (parts.has('k7')) c.processed = 0;
  if (parts.has('localWork')) {
    c.localKinds = [];
    c.anyLocalKind = false;
  }
  if (parts.has('enrichment')) {
    c.enrichment = 0;
    c.enrichmentFiction = 0;
  }
  if (parts.has('referenceKinds')) c.referenceKinds = [];
  if (parts.has('serials')) c.serials = 0;
  if (parts.has('threeYears')) {
    c.windowStart = 0;
    c.additions = [0, 0, 0];
  }
  if (parts.has('period')) {
    c.periodStart = 0;
    c.periodAdditions = 0;
  }
  return c;
}

/** True when `c` holds exactly the parts `parts` (a state carried over from a slice that asked the same). */
export function holdsParts(c: CollectionCounters, parts: ReadonlySet<CollectionPart>): boolean {
  for (const [part, fields] of Object.entries(PART_FIELDS) as [CollectionPart, readonly (keyof CollectionCounters)[]][]) {
    for (const field of fields) if ((c[field] !== undefined) !== parts.has(part)) return false;
  }
  return true;
}

/** The largest resume state or cursor the pass hands on, in bytes of JSON. */
export const COLLECTION_STATE_MAX_BYTES = 32_000;

/**
 * `c` checked against its limit, to hand on.
 *
 * @throws Error when its JSON is over {@link COLLECTION_STATE_MAX_BYTES} (it cannot grow that far: every part is bounded)
 */
export function checkedCounters(c: CollectionCounters): CollectionCounters {
  const bytes = new TextEncoder().encode(JSON.stringify(c)).length;
  if (bytes > COLLECTION_STATE_MAX_BYTES) throw new Error(`collection pass: a state of ${bytes} bytes is over ${COLLECTION_STATE_MAX_BYTES}`);
  return c;
}

// ---- one batch ----------------------------------------------------------------------------------------------------

/** The settings the pass reads, as sets. */
interface PassRules {
  settings: AccredSettings;
  electronic: ReadonlySet<string>;
  reference: ReadonlySet<string>;
  /** Reference and textbook collection types: a title with such a copy is not an enrichment title. */
  notEnrichment: ReadonlySet<string>;
}

function passRules(settings: AccredSettings): PassRules {
  return {
    settings,
    electronic: new Set(settings.electronicMaterialTypeCodes),
    reference: new Set(settings.referenceCollectionTypeCodes),
    notEnrichment: new Set([...settings.referenceCollectionTypeCodes, ...settings.textbookCollectionTypeCodes]),
  };
}

/** The material type of serials (a serial title is approximated by it until serials have a module of their own). */
const SERIAL_MATERIAL_TYPE = 'BERSERI';

const filled = (s: string | null): boolean => s !== null && s.trim() !== '';

/** A copy fully processed: a barcode, a call number (its own or its title's), a classification and a location. */
function processed(i: ItemStockFacts, r: RecordStockFacts): boolean {
  return filled(i.barcodeKey) && (filled(i.callNumber) || filled(r.callNumber)) && filled(r.classification) && i.locationId !== null;
}

/** A title without copies that counts in the stock without them: electronic, or with a public file. */
function countsWithoutCopies(r: RecordStockFacts, rules: PassRules): boolean {
  return (r.materialTypeCode !== null && rules.electronic.has(r.materialTypeCode)) || r.hasPublicFile;
}

/**
 * The day title `r` was first acquired when that lies in `[from, to]`, else null (not an addition there). A title
 * archived later (weeded) was still added then; a title merged into another is that one's duplicate, never added.
 */
function addedIn(r: RecordStockFacts, from: string, to: string, rules: PassRules): string | null {
  if (r.merged) return null;
  if (r.items.length === 0 && !countsWithoutCopies(r, rules)) return null;
  const first = firstAcq(r);
  return first !== 'unknown' && first >= from && first <= to ? first : null;
}

function addPair(into: Record<string, [number, number]>, key: string, titles: number, items: number): void {
  const p = into[key];
  if (p === undefined) into[key] = [titles, items];
  else into[key] = [p[0] + titles, p[1] + items];
}

/** Adds `kind` to the kept kinds (bounded). */
function keepKind(list: string[], kind: string): void {
  if (!list.includes(kind) && list.length < KINDS_MAX) list.push(kind);
}

/** Adds one batch of titles to the counters. */
function visit(c: CollectionCounters, batch: readonly RecordStockFacts[], days: CollectionDays, rules: PassRules): void {
  const { D } = days;
  const s = rules.settings;
  const printed: { classification: string | null; callNumber: string | null; value: [number, number] }[] = [];
  for (const r of batch) {
    if (c.anyLocalKind === false && !r.archived && r.localWorkKind !== null) c.anyLocalKind = true;
    if (c.windowStart !== undefined && c.additions !== undefined) {
      if (inStockAt(r, days.windowBefore, rules.electronic)) c.windowStart += 1;
      else {
        const added = addedIn(r, days.windowFrom, days.windowTo, rules);
        const year = added === null ? -1 : Number(added.slice(0, 4)) - days.windowYears[0];
        if (year === 0 || year === 1 || year === 2) c.additions[year] += 1;
      }
    }
    if (c.periodStart !== undefined && c.periodAdditions !== undefined) {
      if (inStockAt(r, days.periodBefore, rules.electronic)) c.periodStart += 1;
      else if (addedIn(r, days.periodFrom, days.periodTo, rules) !== null) c.periodAdditions += 1;
    }

    if (!inStockAt(r, D, rules.electronic)) continue;
    const live = r.items.filter((i) => liveAt(i, D));
    const electronic = r.materialTypeCode !== null && rules.electronic.has(r.materialTypeCode);
    c.titles += 1;
    if (r.items.length === 0) c.noCopies += 1;
    if (r.isPlaceholder) c.placeholders += 1;
    c.liveItems += live.length;
    c.undatedItems += live.filter((i) => i.acqDate === null).length;

    const fiction = c.fiction !== undefined || c.matrix !== undefined || c.enrichment !== undefined ? isFiction(r, D, s) : false;
    if (c.fiction !== undefined && fiction) c.fiction += 1;
    if (c.ddc !== undefined && !electronic) printed.push({ classification: r.classification, callNumber: r.callNumber, value: [1, live.length] });
    if (c.matrix !== undefined) {
      const medium = electronic ? 'electronic' : 'print';
      const kind = isReference(r, D, s) ? 'reference' : fiction ? 'fiction' : 'nonfiction';
      addPair(c.matrix, `${medium}.${kind}`, 1, 0);
      for (const i of live) {
        const own = i.collectionTypeCode !== null && rules.reference.has(i.collectionTypeCode) ? 'reference' : fiction ? 'fiction' : 'nonfiction';
        addPair(c.matrix, `${medium}.${own}`, 0, 1);
      }
    }
    if (c.processed !== undefined) c.processed += live.filter((i) => processed(i, r)).length;
    if (c.localKinds !== undefined && r.localWork !== null && SCHOOL_LOCAL_WORKS.includes(r.localWork) && r.localWorkKind !== null) {
      keepKind(c.localKinds, r.localWorkKind);
    }
    if (c.enrichment !== undefined && c.enrichmentFiction !== undefined) {
      if (!live.some((i) => i.collectionTypeCode !== null && rules.notEnrichment.has(i.collectionTypeCode))) {
        c.enrichment += 1;
        if (fiction) c.enrichmentFiction += 1;
      }
    }
    if (c.referenceKinds !== undefined && r.referenceKind !== null) keepKind(c.referenceKinds, r.referenceKind);
    if (c.serials !== undefined && r.materialTypeCode === SERIAL_MATERIAL_TYPE) {
      const recent = r.items.some((i) => {
        const acquired = acquisitionOf(i)?.date ?? null;
        return acquired !== null && acquired >= days.serialFrom && acquired <= D;
      });
      if (recent) c.serials += 1;
    }
  }
  if (c.ddc !== undefined && printed.length > 0) {
    const ddc = c.ddc;
    const folded = foldByDdc(printed, (acc: [number, number] | undefined, v): [number, number] => (acc === undefined ? [v[0], v[1]] : [acc[0] + v[0], acc[1] + v[1]]), {
      divisions: true,
      nonTokens: false,
    });
    for (const [key, [titles, items]] of folded) addPair(ddc, key, titles, items);
  }
}

/** `list` in the order of `vocabulary`, the values it does not know last (by their text). */
export function inVocabularyOrder(list: readonly string[], vocabulary: readonly string[]): string[] {
  const rank = (k: string): number => {
    const n = vocabulary.indexOf(k);
    return n < 0 ? vocabulary.length : n;
  };
  return [...list].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
}

/** The work kinds in the order of their vocabulary. */
export const localKindOrder = (list: readonly string[]): string[] => inVocabularyOrder(list, LOCAL_WORK_KINDS);
/** The reference kinds in the order of their vocabulary. */
export const referenceKindOrder = (list: readonly string[]): string[] => inVocabularyOrder(list, REFERENCE_KINDS);

// ---- the pass -----------------------------------------------------------------------------------------------------

/**
 * Runs the pass from the title after `after` (null: from the first) with the counters so far, a batch at a time,
 * while the budget lasts (at least one batch, so it always moves on): done with the counters once every title is read,
 * or stopped after the last title read.
 */
export async function runCollectionPass(
  db: Kysely<DB>,
  o: { tz: string; days: CollectionDays; settings: AccredSettings; after: string | null; counters: CollectionCounters; budgetLeftMs: () => number },
): Promise<{ done: true; counters: CollectionCounters } | { done: false; after: string; counters: CollectionCounters }> {
  const rules = passRules(o.settings);
  let after = o.after;
  for (;;) {
    const batch = await scanRecordStock(db, { tz: o.tz, after, limit: STOCK_SCAN_MAX_LIMIT });
    visit(o.counters, batch.rows, o.days, rules);
    if (batch.next === null) return { done: true, counters: o.counters };
    after = batch.next;
    if (o.budgetLeftMs() < SCAN_MARGIN_MS) return { done: false, after, counters: checkedCounters(o.counters) };
  }
}

// ---- the annexes --------------------------------------------------------------------------------------------------

/** The cursor of an annex: the last title read and the counters so far. */
const annexCursor = z.strictObject({ k: z.string().min(1).max(26), a: CollectionCounters });

/** What an annex prints from: the period, its days and the finished counters. */
export interface AnnexCounts {
  periodId: string;
  days: CollectionDays;
  counters: CollectionCounters;
}

/**
 * One call of a collection annex's pass over the live period `ctx.params.periodId` from `cursor` (null: from the
 * start), counting `parts`: the finished counts, or the cursor to go on from (its rows are none until then).
 *
 * @throws DomainError `VALIDATION_FAILED` `{path: 'params.periodId', code: 'not_found'}` for an unknown or archived
 *   period; `{path: 'cursor', code: 'invalid'}` for a cursor this pass did not answer
 */
export async function annexPass(ctx: ReportCtx, cursor: string | null, parts: ReadonlySet<CollectionPart>): Promise<{ done: true; counts: AnnexCounts } | { done: false; cursor: string }> {
  const periodId = String(ctx.params['periodId']);
  const p = await ctx.db.selectFrom('accred_periods').select(['starts_on', 'ends_on']).where('id', '=', periodId).where('archived_at', 'is', null).executeTakeFirst();
  if (p === undefined) throw reportFieldErrors([{ path: 'params.periodId', code: 'not_found' }]);
  const days = collectionDays({ startsOn: p.starts_on, endsOn: p.ends_on }, snapshotDate(p.ends_on, ctx.today));
  const state = cursor === null ? { k: null, a: newCounters(parts) } : decodeCursor(cursor, annexCursor);
  if (!holdsParts(state.a, parts)) throw reportFieldErrors([{ path: 'cursor', code: 'invalid' }]);
  const pass = await runCollectionPass(ctx.db, { tz: ctx.tz, days, settings: ctx.settings, after: state.k, counters: state.a, budgetLeftMs: () => ctx.budgetLeftMs() });
  if (!pass.done) return { done: false, cursor: encodeCursor({ k: pass.after, a: pass.counters }) };
  return { done: true, counts: { periodId, days, counters: pass.counters } };
}
