import type { ItemStatus } from '@altis/shared';
import type { AcqBasis } from './acq-date.js';

// The stock at a date D (dates are `YYYY-MM-DD` strings in the library's time zone, compared as text). A copy is in
// the stock at D when it was acquired by D (or its acquisition date is unknown), was not withdrawn by D, is not on
// order and was not lost at D. A title is in the stock when it is not archived and has such a copy; a title without
// any copy counts from its creation when it is electronic or has a public file. The first acquisition of a title
// decides whether it is an addition: one undated copy, or nothing but ordered copies, makes it unknown.

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
  archived: boolean;
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

/** True when copy `i` is in the stock at `D`. */
export function liveAt(i: ItemStockFacts, D: string): boolean {
  if (i.status === 'on_order') return false;
  if (i.acqDate !== null && i.acqDate > D) return false;
  if (i.archivedOn !== null && i.archivedOn <= D) return false;
  return !lostAt(i, D);
}

/**
 * True when title `r` is in the stock at `D`: not archived, and a copy is live at `D`; or, for a title without any
 * copy, it is electronic (its material type code is in `electronicCodes`) or has a public file, and it existed at `D`
 * (an unknown creation date counts at every date).
 */
export function inStockAt(r: RecordStockFacts, D: string, electronicCodes: ReadonlySet<string>): boolean {
  if (r.archived) return false;
  if (r.items.length > 0) return r.items.some((i) => liveAt(i, D));
  const counted = (r.materialTypeCode !== null && electronicCodes.has(r.materialTypeCode)) || r.hasPublicFile;
  return counted && (r.createdOn === null || r.createdOn <= D);
}

/**
 * The first acquisition of title `r`: the earliest acquisition date of its copies that are not on order (withdrawn
 * ones included; an ordered copy has not been acquired), or for a title without copies its creation date.
 * `'unknown'` when one of those copies is undated, when every copy is on order, or when a title without copies has no
 * known creation date: such a title is never an addition.
 */
export function firstAcq(r: RecordStockFacts): string | 'unknown' {
  if (r.items.length === 0) return r.createdOn ?? 'unknown';
  let first: string | null = null;
  for (const i of r.items) {
    if (i.status === 'on_order') continue;
    if (i.acqDate === null) return 'unknown';
    if (first === null || i.acqDate < first) first = i.acqDate;
  }
  return first ?? 'unknown';
}
