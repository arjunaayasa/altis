import type { DB } from '@altis/db';
import { ITEM_STATUSES, localDate, type ItemStatus } from '@altis/shared';
import type { Kysely } from 'kysely';
import { acqDateOf, type AcqInput } from './acq-date.js';
import type { ItemStockFacts, RecordStockFacts } from './stock.js';

// The stock reader: the facts the stock rules (stock.ts) need of every title, read by id keyset a batch at a time.
// Per batch it reads the records, then with IN lists over their ids: their copies, the copies' history, the SLiMS
// legacy map of the records and their attachments. It never reads the search tables (they are rebuilt at will).
//
// A record the SLiMS migration made carries the source's input date as `created_at`; when that date was empty or
// invalid, the migration stored its own clock instead, and a placeholder record (made for copies whose record was
// missing in the source) always has the migration's clock. So a migrated or placeholder record whose `created_at` lies
// inside the time span of the migration run that mapped it has no known creation date, and its copies are not dated
// by it. The legacy map has no index on its target, so it is read only for the records whose `created_at` falls
// inside the span of some migration run (a handful of runs, read once per call): a record outside every span cannot
// be one of those, and a placeholder is always inside its run's span.

/** The largest batch one call reads. */
export const STOCK_SCAN_MAX_LIMIT = 500;

/** The migration map's entities of migrated records: a SLiMS record, and the placeholder of a missing one. */
const RECORD_ENTITIES = ['biblio', 'biblio_missing'] as const;

const STATUSES: ReadonlySet<string> = new Set(ITEM_STATUSES);
const isStatus = (s: string | null): s is ItemStatus => s !== null && STATUSES.has(s);

const FIRST_EVENT_TYPES: ReadonlySet<string> = new Set(['created', 'imported', 'migrated']);

interface Span {
  from: number;
  /** null: the run has not finished. */
  to: number | null;
}

const within = (at: number, s: Span): boolean => at >= s.from && (s.to === null || at <= s.to);

/**
 * One batch of at most `limit` titles (1-500) after id `after` (null: from the first), in id order, with their facts;
 * `next` is the id to continue after, null when the scan is complete. With `branchId`, only that branch's copies are
 * attached and only titles with at least one of them are read. Archived titles and copies are included: the stock
 * rules decide what counts at a date.
 *
 * @throws RangeError for a `limit` outside 1-500
 */
export async function scanRecordStock(
  db: Kysely<DB>,
  o: { tz: string; after: string | null; limit: number; branchId?: string | null },
): Promise<{ rows: RecordStockFacts[]; next: string | null }> {
  if (!Number.isSafeInteger(o.limit) || o.limit < 1 || o.limit > STOCK_SCAN_MAX_LIMIT) {
    throw new RangeError(`scanRecordStock: limit ${o.limit} is outside 1-${STOCK_SCAN_MAX_LIMIT}`);
  }
  const branchId = o.branchId ?? null;

  let recordQuery = db
    .selectFrom('records as r')
    .leftJoin('material_types as mt', 'mt.id', 'r.material_type_id')
    .select([
      'r.id',
      'r.archived_at',
      'r.merged_into',
      'r.created_at',
      'mt.code_key as material_type_code',
      'r.classification',
      'r.call_number',
      'r.language_id',
      'r.local_work',
      'r.local_work_kind',
      'r.reference_kind',
      'r.audience',
    ])
    .orderBy('r.id')
    .limit(o.limit);
  if (o.after !== null) recordQuery = recordQuery.where('r.id', '>', o.after);
  if (branchId !== null) {
    recordQuery = recordQuery.where(({ exists, selectFrom }) =>
      exists(selectFrom('items as bi').select('bi.id').whereRef('bi.record_id', '=', 'r.id').where('bi.branch_id', '=', branchId)),
    );
  }
  const records = await recordQuery.execute();
  const last = records[records.length - 1];
  const next = records.length === o.limit && last !== undefined ? last.id : null;
  if (records.length === 0) return { rows: [], next };
  const ids = records.map((r) => r.id);

  let itemQuery = db
    .selectFrom('items as i')
    .leftJoin('collection_types as ct', 'ct.id', 'i.collection_type_id')
    .select([
      'i.id',
      'i.record_id',
      'i.branch_id',
      'i.status',
      'i.archived_at',
      'i.created_at',
      'i.received_date',
      'i.input_on',
      'i.collection_type_id',
      'ct.code_key as collection_type_code',
      'i.location_id',
      'i.barcode_key',
      'i.call_number',
      'i.inventory_no',
      'i.price',
      'i.currency',
      'i.acq_source',
      'i.supplier_id',
    ])
    .where('i.record_id', 'in', ids)
    .orderBy('i.record_id')
    .orderBy('i.id');
  if (branchId !== null) itemQuery = itemQuery.where('i.branch_id', '=', branchId);
  const items = await itemQuery.execute();

  // The history of those copies, oldest first (by time, then id).
  let eventQuery = db
    .selectFrom('item_events as e')
    .innerJoin('items as i', 'i.id', 'e.item_id')
    .select(['e.item_id', 'e.at', 'e.type', 'e.to_status'])
    .where('i.record_id', 'in', ids)
    .orderBy('e.at')
    .orderBy('e.id');
  if (branchId !== null) eventQuery = eventQuery.where('i.branch_id', '=', branchId);
  const firstEvent = new Map<string, string>();
  const timelines = new Map<string, { on: string; to: ItemStatus }[]>();
  for (const e of await eventQuery.execute()) {
    if (!firstEvent.has(e.item_id)) firstEvent.set(e.item_id, e.type);
    if (!isStatus(e.to_status)) continue;
    let timeline = timelines.get(e.item_id);
    if (timeline === undefined) timelines.set(e.item_id, (timeline = []));
    timeline.push({ on: localDate(o.tz, Number(e.at)), to: e.to_status });
  }

  // Records created inside the span of the migration run that mapped them, and the placeholders.
  const runs = await db.selectFrom('catalog_runs').select(['id', 'created_at', 'finished_at']).where('kind', '=', 'migration').execute();
  const spans = new Map<string, Span>(runs.map((r) => [r.id, { from: Number(r.created_at), to: r.finished_at === null ? null : Number(r.finished_at) }]));
  const createdAt = new Map(records.map((r) => [r.id, Number(r.created_at)]));
  const candidates = records.filter((r) => [...spans.values()].some((s) => within(Number(r.created_at), s))).map((r) => r.id);
  const inSpan = new Set<string>();
  const placeholders = new Set<string>();
  if (candidates.length > 0) {
    const maps = await db
      .selectFrom('migration_map')
      .select(['target_id', 'entity', 'run_id'])
      .where('entity', 'in', RECORD_ENTITIES)
      .where('target_id', 'in', candidates)
      .execute();
    for (const m of maps) {
      if (m.entity === 'biblio_missing') placeholders.add(m.target_id);
      const span = spans.get(m.run_id);
      const at = createdAt.get(m.target_id);
      if (span !== undefined && at !== undefined && within(at, span)) inSpan.add(m.target_id);
    }
  }

  const attachments = await db
    .selectFrom('attachments')
    .select('record_id')
    .where('record_id', 'in', ids)
    .where('kind', '=', 'file')
    .where('access', '=', 'public')
    .where('archived_at', 'is', null)
    .where('file_id', 'is not', null)
    .execute();
  const publicFile = new Set(attachments.map((a) => a.record_id));

  const itemsOf = new Map<string, ItemStockFacts[]>();
  for (const i of items) {
    const first = firstEvent.get(i.id);
    const acqInput: AcqInput = {
      receivedDate: i.received_date,
      inputOn: i.input_on,
      firstEventType: first !== undefined && FIRST_EVENT_TYPES.has(first) ? (first as AcqInput['firstEventType']) : null,
      recordCreatedAt: createdAt.get(i.record_id) ?? null,
      recordCreatedInMigrationSpan: inSpan.has(i.record_id),
      itemCreatedAt: Number(i.created_at),
      tz: o.tz,
    };
    const acq = acqDateOf(acqInput);
    let list = itemsOf.get(i.record_id);
    if (list === undefined) itemsOf.set(i.record_id, (list = []));
    list.push({
      itemId: i.id,
      recordId: i.record_id,
      branchId: i.branch_id,
      status: i.status as ItemStatus,
      acqDate: acq.date,
      acqBasis: acq.basis,
      archivedOn: i.archived_at === null ? null : localDate(o.tz, Number(i.archived_at)),
      statusTimeline: timelines.get(i.id) ?? [],
      collectionTypeId: i.collection_type_id,
      collectionTypeCode: i.collection_type_code ?? null,
      locationId: i.location_id,
      barcodeKey: i.barcode_key,
      callNumber: i.call_number,
      inventoryNo: i.inventory_no,
      receivedDate: i.received_date,
      price: i.price === null ? null : Number(i.price),
      currency: i.currency,
      acqSource: i.acq_source,
      supplierId: i.supplier_id,
    });
  }

  const rows: RecordStockFacts[] = [];
  for (const r of records) {
    const recordItems = itemsOf.get(r.id) ?? [];
    if (branchId !== null && recordItems.length === 0) continue;
    rows.push({
      recordId: r.id,
      archived: r.archived_at !== null,
      archivedOn: r.archived_at === null ? null : localDate(o.tz, Number(r.archived_at)),
      merged: r.merged_into !== null,
      createdOn: inSpan.has(r.id) ? null : localDate(o.tz, Number(r.created_at)),
      materialTypeCode: r.material_type_code ?? null,
      classification: r.classification,
      callNumber: r.call_number,
      languageId: r.language_id,
      localWork: r.local_work,
      localWorkKind: r.local_work_kind,
      referenceKind: r.reference_kind,
      audience: r.audience,
      hasPublicFile: publicFile.has(r.id),
      isPlaceholder: placeholders.has(r.id),
      items: recordItems,
    });
  }
  return { rows, next };
}
