import type { ItemStatus } from '@altis/shared';
import type { AcqBasis } from './acq-date.js';

// The stock at a date D (dates are `YYYY-MM-DD` strings in the library's time zone, compared as text). A copy is in
// the stock at D when it was acquired by D (or its acquisition date is unknown), was not withdrawn by D, and was
// neither on order nor lost at D. A copy that never left its order (still on order, or an order cancelled) was never
// acquired; one made here on order is acquired the day it left the order, not the day it was ordered. A title is in
// the stock when it was not archived by D and has such a copy; a title without any copy counts from its creation when
// it is electronic or has a public file; a title merged into another never counts (its copies moved there). Every test
// reads what held at D, so a title weeded later still counts at the dates before. The first acquisition of a title
// decides whether it is an addition: one undated copy makes it unknown, and copies never acquired do not count.

/** One copy as the stock rules read it. */
export interface ItemStockFacts {
  itemId: string;
  recordId: string;
  branchId: string;
  /** The current status. */
  status: ItemStatus;
  /** The acquisition date of the chain (acq-date.ts); null when unknown. */
  acqDate: string | null;
  acqBasis: AcqBasis | null;
  /** The local date of `items.archived_at` (withdrawn); null for a live copy. */
  archivedOn: string | null;
  /** Every history row that set a status, oldest first, as local dates. */
  statusTimeline: readonly { on: string; to: ItemStatus }[];
  collectionTypeId: string | null;
  collectionTypeCode: string | null;
  locationId: string | null;
  barcodeKey: string | null;
  callNumber: string | null;
  inventoryNo: string | null;
  receivedDate: string | null;
  /** In the currency's minor unit. */
  price: number | null;
  currency: string | null;
  acqSource: string | null;
  supplierId: string | null;
}

/** One title and its copies as the stock rules read them. */
export interface RecordStockFacts {
  recordId: string;
  /** Archived now (a merged record is archived too). */
  archived: boolean;
  /** The local date of `records.archived_at`; null when not archived (an archived title without it: at every date). */
  archivedOn: string | null;
  /** Merged into another record (`records.merged_into`): a duplicate, never counted on its own. */
  merged: boolean;
  /** The local date of `records.created_at`; null when unknown (the time a migration created it). */
  createdOn: string | null;
  /** The material type's normalised code. */
  materialTypeCode: string | null;
  classification: string | null;
  callNumber: string | null;
  languageId: string | null;
  localWork: string | null;
  localWorkKind: string | null;
  referenceKind: string | null;
  audience: string | null;
  /** A live attachment of kind file with public access. */
  hasPublicFile: boolean;
  /** The placeholder a migration made for copies whose record was missing in the source. */
  isPlaceholder: boolean;
  items: readonly ItemStockFacts[];
}

/**
 * The status of copy `i` in force at `D`: that of the last status entry on or before `D`; when `D` is before every
 * entry, that of the first one (a migrated or imported copy's first status holds from before the run); without any
 * entry, its current status.
 */
export function statusAt(i: ItemStockFacts, D: string): ItemStatus {
  const timeline = i.statusTimeline;
  const first = timeline[0];
  if (first === undefined) return i.status;
  let status = first.to;
  for (const entry of timeline) {
    if (entry.on > D) break;
    status = entry.to;
  }
  return status;
}

/** True when copy `i` is lost at `D`. */
export function lostAt(i: ItemStockFacts, D: string): boolean {
  return statusAt(i, D) === 'lost';
}

/**
 * True when copy `i` is withdrawn at `D`: archived on or before `D`, or withdrawn in its status history at `D`. Before
 * its first history row, a copy that came in withdrawn (a copy weeded in the source system before a migration, which
 * archived it at the migration's own time) was withdrawn already, unless an archive date earlier than that row says
 * when it left.
 */
export function withdrawnAt(i: ItemStockFacts, D: string): boolean {
  if (i.archivedOn !== null && i.archivedOn <= D) return true;
  const first = i.statusTimeline[0];
  if (first === undefined) return false;
  if (D < first.on) return first.to === 'withdrawn' && (i.archivedOn === null || i.archivedOn >= first.on);
  return statusAt(i, D) === 'withdrawn';
}

/** When copy `i` entered the stock, and what that date is read from. */
export interface Acquisition {
  /** null: on an unknown day (an undated copy). */
  date: string | null;
  basis: AcqBasis | null;
}

/**
 * When copy `i` entered the stock, or null when it never did: it is on order, or its order ended without it ever
 * being in the stock (cancelled: on order, then withdrawn). A copy made here on order without a receiving date is
 * acquired the day its status first left the order (it was received then), not the day it was ordered.
 */
export function acquisitionOf(i: ItemStockFacts): Acquisition | null {
  if (i.status === 'on_order') return null;
  const timeline = i.statusTimeline;
  if (timeline[0]?.to === 'on_order') {
    const arrived = timeline.find((e) => e.to !== 'on_order' && e.to !== 'withdrawn');
    if (arrived === undefined) return null;
    if (i.acqBasis === 'item_created' && i.acqDate !== null) return { date: arrived.on > i.acqDate ? arrived.on : i.acqDate, basis: 'received' };
  }
  return { date: i.acqDate, basis: i.acqBasis };
}

/** True when copy `i` is in the stock at `D`. */
export function liveAt(i: ItemStockFacts, D: string): boolean {
  const acquired = acquisitionOf(i);
  if (acquired === null) return false;
  if (acquired.date !== null && acquired.date > D) return false;
  if (withdrawnAt(i, D)) return false;
  const status = statusAt(i, D);
  return status !== 'lost' && status !== 'on_order';
}

/** True when title `r` is out of the catalogue at `D`: merged into another, or archived on or before `D`. */
export function titleGoneAt(r: RecordStockFacts, D: string): boolean {
  return r.merged || (r.archived && (r.archivedOn === null || r.archivedOn <= D));
}

/**
 * True when title `r` is in the stock at `D`: not archived by `D` (never when merged), and a copy is live at `D`; or,
 * for a title without any copy, it is electronic (its material type code is in `electronicCodes`) or has a public file,
 * and it existed at `D` (an unknown creation date counts at every date).
 */
export function inStockAt(r: RecordStockFacts, D: string, electronicCodes: ReadonlySet<string>): boolean {
  if (titleGoneAt(r, D)) return false;
  if (r.items.length > 0) return r.items.some((i) => liveAt(i, D));
  const counted = (r.materialTypeCode !== null && electronicCodes.has(r.materialTypeCode)) || r.hasPublicFile;
  return counted && (r.createdOn === null || r.createdOn <= D);
}

/**
 * The first acquisition of title `r`: the earliest acquisition date ({@link acquisitionOf}) of its copies that were
 * acquired (withdrawn ones included; an ordered copy, or a cancelled order, never was), or for a title without copies
 * its creation date. `'unknown'` when one of those copies is undated, when no copy was ever acquired, or when a title
 * without copies has no known creation date: such a title is never an addition.
 */
export function firstAcq(r: RecordStockFacts): string | 'unknown' {
  if (r.items.length === 0) return r.createdOn ?? 'unknown';
  let first: string | null = null;
  for (const i of r.items) {
    const acquired = acquisitionOf(i);
    if (acquired === null) continue;
    if (acquired.date === null) return 'unknown';
    if (first === null || acquired.date < first) first = acquired.date;
  }
  return first ?? 'unknown';
}
