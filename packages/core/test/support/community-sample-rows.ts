import { TABLE_CLASSES, tableLoadOrder, type DB, type TableName } from '@altis/db';
import type { Kysely } from 'kysely';
import { catalogSampleRows, type CatalogTable } from '../../../db/test/fixtures/catalog-tables.js';
import { chargesSampleRows } from '../../../db/test/fixtures/komunitas-charges-tables.js';
import { circCoreSampleRows, type CircCoreTable } from '../../../db/test/fixtures/komunitas-circ-core-tables.js';
import { holdsSampleRows } from '../../../db/test/fixtures/komunitas-holds-tables.js';
import { k1SampleRows, type K1Table } from '../../../db/test/fixtures/komunitas-k1-tables.js';
import { circulationSampleRows, type CirculationTable } from '../../../db/test/fixtures/komunitas-members-circulation-tables.js';
import { noticesSampleRows } from '../../../db/test/fixtures/komunitas-notices-tables.js';
import { stocktakeSampleRows } from '../../../db/test/fixtures/komunitas-stocktake-tables.js';
import { visitsSampleRows, type VisitsTableName } from '../../../db/test/fixtures/komunitas-visits-tables.js';

// The sample rows of packages/db's table tests for every table past the Phase 1 core, written through Kysely on any
// dialect: the catalogue, the reports and accreditation workspace, members and circulation, holds, the circulation
// core (calendar, items read in place, clearance letters), visits, the member area, charges and payments, notices
// and stocktake. Each family numbers its ids from a fixed prefix, so two databases seeded alike hold the very same
// keys. The seeds of the migrations that carry new ids on each database (material types, languages, collection types,
// member types, the general loan rule) are removed first. The rows hang off one branch and one staff user the caller
// has made.

type AnyDb = Kysely<Record<string, Record<string, unknown>>>;

/** Ids `<prefix><n>` (26 characters), numbered from 1. */
function numbered(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}${String((n += 1)).padStart(26 - prefix.length, '0')}`;
}

/** Writes the sample rows (see the top of this file); answers the tables it filled. */
export async function seedCommunityRows(db: Kysely<DB>, o: { branchId: string; staffId: string }): Promise<TableName[]> {
  const any = db as unknown as AnyDb;
  const filled: string[] = [];
  const write = async (table: string, rows: readonly Record<string, unknown>[]): Promise<void> => {
    await any.insertInto(table).values([...rows]).execute();
    filled.push(table);
  };
  const base = { branchId: o.branchId, staffId: o.staffId };

  for (const t of ['material_types', 'languages', 'collection_types', 'member_types', 'policies'] as const) await db.deleteFrom(t).execute();

  // The catalogue: the backed-up tables, parents first.
  const catalog = catalogSampleRows({ ...base, newId: numbered('01JQ') });
  for (const t of tableLoadOrder((Object.keys(catalog) as CatalogTable[]).filter((x) => TABLE_CLASSES[x] === 'data')).order as CatalogTable[]) await write(t, catalog[t]);
  // Reports and accreditation: the backed-up tables, parents first.
  const k1 = k1SampleRows({ ...base, newId: numbered('01JR') });
  for (const t of tableLoadOrder((Object.keys(k1) as K1Table[]).filter((x) => TABLE_CLASSES[x] === 'data')).order as K1Table[]) await write(t, k1[t]);
  // Members and circulation, parents first.
  const circulation = circulationSampleRows({ ...base, newId: numbered('01JS') });
  for (const t of tableLoadOrder(Object.keys(circulation) as CirculationTable[]).order as CirculationTable[]) await write(t, circulation[t]);
  await write('holds', holdsSampleRows({ ...base, newId: numbered('01JT') }).holds);
  // The circulation core: the calendar, items read in place, clearance letters.
  const circCore = circCoreSampleRows({ ...base, newId: numbered('01JU') });
  for (const t of Object.keys(circCore) as CircCoreTable[]) await write(t, circCore[t]);
  const visits = visitsSampleRows({ ...base, newId: numbered('01JV') });
  for (const t of Object.keys(visits) as VisitsTableName[]) await write(t, visits[t]);
  // The member area: a bookmark of a sample member, a type list of a sample attachment.
  await write('member_bookmarks', [{ member_id: circulation.members[0]!.id, record_id: '01JU0000000000000000000001', created_at: 1767225600000 }]);
  await write('attachment_member_types', [{ attachment_id: catalog.attachments[0]!.id, member_type_id: '01JU0000000000000000000002' }]);
  const charges = chargesSampleRows({ ...base, newId: numbered('01JW') });
  for (const t of ['charges', 'charge_adjustments', 'payments', 'payment_allocations'] as const) await write(t, charges[t]);
  await write('notices', noticesSampleRows({ newId: numbered('01JX') }).notices);
  const stocktake = stocktakeSampleRows({ ...base, newId: numbered('01JY') });
  for (const t of ['stocktakes', 'stocktake_items', 'stocktake_unknown_codes'] as const) await write(t, stocktake[t]);
  return [...new Set(filled)] as TableName[];
}
