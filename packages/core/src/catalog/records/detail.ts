import type { DB } from '@altis/db';
import type { RecordDetail, RecordWarningCode } from '@altis/shared/api/catalog/records';
import type { Kysely, Transaction } from 'kysely';
import { loadRecords } from './data.js';
import { recordNotFound } from './service.js';

// `GET catalog/records/:id` (Phase 2 plan Task 16): the staff view of one record for the editor. It is the staff load
// of loadRecordData (every attachment that is not archived, every item, every custom value) with the row's version,
// its master ids and source, the warnings of what is stored as not valid (an ISBN or ISSN with a wrong check digit,
// §3.2: shown on the form, never a refusal) and the item counts.

type Db = Kysely<DB> | Transaction<DB>;

/**
 * The detail of `id`.
 *
 * @throws DomainError NOT_FOUND
 */
export async function recordDetail(db: Db, id: string): Promise<RecordDetail> {
  const loaded = (await loadRecords(db, [id], { publicOnly: false, includeItems: true })).get(id);
  if (loaded === undefined) throw recordNotFound();
  const { row, data } = loaded;

  const stored = await db
    .selectFrom('record_identifiers')
    .select(['type', 'is_valid'])
    .where('record_id', '=', id)
    .orderBy('sort_order')
    .orderBy('id')
    .execute();
  const warnings: { path: string; code: RecordWarningCode }[] = [];
  stored.forEach((r, i) => {
    if (Number(r.is_valid) === 1) return;
    if (r.type === 'isbn') warnings.push({ path: `identifiers.${i}.value`, code: 'isbn_invalid' });
    else if (r.type === 'issn') warnings.push({ path: `identifiers.${i}.value`, code: 'issn_invalid' });
  });

  // Counted from the table: the items that are not archived, and of them the available ones.
  const counts = await db
    .selectFrom('items')
    .select(['status', (eb) => eb.fn.countAll().as('n')])
    .where('record_id', '=', id)
    .where('archived_at', 'is', null)
    .groupBy('status')
    .execute();
  const total = counts.reduce((n, c) => n + Number(c.n), 0);
  const available = counts.filter((c) => c.status === 'available').reduce((n, c) => n + Number(c.n), 0);

  return {
    ...data,
    version: Number(row.version),
    materialTypeId: row.material_type_id,
    languageId: row.language_id,
    source: row.source,
    custom: data.custom ?? {},
    warnings,
    itemCounts: { total, available },
  };
}
