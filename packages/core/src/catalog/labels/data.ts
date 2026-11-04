import type { DB } from '@altis/db';
import { DomainError } from '@altis/shared';
import type { Kysely, Transaction } from 'kysely';
import type { LabelData } from '../../print/index.js';

// What the labels of one print show (Phase 2 spec §7; plan Task 36): one LabelData per item, read for
// `POST catalog/labels`, which builds the sheet with print/buildLabelPdf.
//
// - `itemIds`: those items, in the order given. An id that is unknown or names an archived item is skipped.
// - `recordIds`: the live items of each record, record by record in the order given and by barcode within a record. A
//   record without a live item (an unknown, archived or merged one included) is skipped.
// - A repeated id counts once (its first place), and is not counted as skipped.
// - The call number is the item's, else the record's (§7). A blank one counts as none. The title is the record's.
// - At most 1 000 ids, and at most 1 000 labels after records are expanded (422 `CATALOG_LABEL_LIMIT`, `meta.max`).
//   The id check comes before any query. The expansion is read with a LIMIT of one more row than is left, so records
//   with very many items cost no more than one row past the limit.
//
// Reads only, on the handle or transaction it is given, with the query builder; IN lists of at most 500 ids. Nothing
// is kept between calls.

type Db = Kysely<DB> | Transaction<DB>;

/** The most ids, and the most labels, one print takes (spec §7). */
const LABEL_MAX = 1000;
/** Ids per IN list. */
const ID_BATCH = 500;

interface LabelRow {
  record_id: string;
  barcode_display: string;
  call_number: string | null;
  record_call_number: string | null;
  title: string;
}

function labelLimit(): DomainError {
  return new DomainError('CATALOG_LABEL_LIMIT', {
    detail: `Paling banyak ${LABEL_MAX} label sekali cetak / At most ${LABEL_MAX} labels in one print`,
    meta: { max: LABEL_MAX },
  });
}

/** null for a value that is absent or blank. */
const present = (s: string | null): string | null => (s === null || s.trim() === '' ? null : s);

const labelOf = (r: LabelRow): LabelData => ({
  callNumber: present(r.call_number) ?? present(r.record_call_number),
  barcode: r.barcode_display,
  title: r.title,
});

/** The live items with their records' fields; `column` picks the items by their own id or by their record's. */
function liveItems(db: Db, column: 'i.id' | 'i.record_id', ids: readonly string[]) {
  return db
    .selectFrom('items as i')
    .innerJoin('records as r', 'r.id', 'i.record_id')
    .select(['i.id', 'i.record_id', 'i.barcode_display', 'i.call_number', 'r.call_number as record_call_number', 'r.title'])
    .where(column, 'in', [...ids])
    .where('i.archived_at', 'is', null);
}

async function itemLabels(db: Db, ids: readonly string[]): Promise<{ labels: LabelData[]; skipped: number }> {
  const found = new Map<string, LabelData>();
  for (let i = 0; i < ids.length; i += ID_BATCH) {
    for (const row of await liveItems(db, 'i.id', ids.slice(i, i + ID_BATCH)).execute()) found.set(row.id, labelOf(row));
  }
  const labels = ids.flatMap((id) => {
    const label = found.get(id);
    return label === undefined ? [] : [label];
  });
  return { labels, skipped: ids.length - labels.length };
}

async function recordLabels(db: Db, ids: readonly string[]): Promise<{ labels: LabelData[]; skipped: number }> {
  const byRecord = new Map<string, LabelData[]>();
  let count = 0;
  for (let i = 0; i < ids.length; i += ID_BATCH) {
    const rows = await liveItems(db, 'i.record_id', ids.slice(i, i + ID_BATCH))
      .orderBy('i.barcode_key')
      .limit(LABEL_MAX - count + 1)
      .execute();
    count += rows.length;
    if (count > LABEL_MAX) throw labelLimit();
    for (const row of rows) {
      const labels = byRecord.get(row.record_id);
      if (labels === undefined) byRecord.set(row.record_id, [labelOf(row)]);
      else labels.push(labelOf(row));
    }
  }
  return {
    labels: ids.flatMap((id) => byRecord.get(id) ?? []),
    skipped: ids.filter((id) => !byRecord.has(id)).length,
  };
}

/**
 * The labels of the items `itemIds`, or of the live items of the records `recordIds` (see the top of this file), and
 * how many of the ids gave no label.
 *
 * @throws DomainError `CATALOG_LABEL_LIMIT` (`meta.max` 1000) for more than 1 000 ids, or records whose live items
 *   make more than 1 000 labels
 * @throws TypeError when both lists are given
 */
export async function labelDataFor(
  db: Db,
  o: { itemIds?: readonly string[]; recordIds?: readonly string[] },
): Promise<{ labels: LabelData[]; skipped: number }> {
  if (o.itemIds !== undefined && o.recordIds !== undefined) throw new TypeError('labelDataFor: itemIds or recordIds, not both');
  const ids = o.itemIds ?? o.recordIds ?? [];
  if (ids.length > LABEL_MAX) throw labelLimit();
  const distinct = [...new Set(ids)];
  return o.itemIds !== undefined ? itemLabels(db, distinct) : recordLabels(db, distinct);
}
