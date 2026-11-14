import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import { liveItemSql } from '../../src/reports/collection/common.js';
import { stockAt } from '../support/stock-fixture.js';
import { TODAY, addTitle, openCollectionDb, type CollectionDb } from './report-collection-support.js';

// The SQL form of "this copy is in the stock today" that every report of today's collection filters on: not withdrawn,
// not on order, not lost, and acquired by the day, that is by its receiving date, or without one by the date entered
// in the source system, or undated (in the stock at every date). Written so that a count over the whole collection
// reads each copy once: SQLite given `received_date is null or received_date <= day` read the copies through the
// receiving-date index, one table lookup per copy.

const ctx = testDbContext();
const LATER = '2026-07-01';
const EARLIER = '2026-06-01';

describe.skipIf(!ctx.available)(`the stock condition of today's copies [${engineLabel()}]`, () => {
  let c: CollectionDb;

  beforeAll(async () => {
    c = await openCollectionDb('report-stock-sql', { fixture: false });
    const at = stockAt('2024-02-01');
    const copy = (barcode: string, o: { receivedDate?: string | null; inputOn?: string | null; status?: string; archivedAt?: number | null }) => ({
      barcode,
      createdAt: at,
      receivedDate: o.receivedDate ?? null,
      inputOn: o.inputOn ?? null,
      ...(o.status === undefined ? {} : { status: o.status }),
      ...(o.archivedAt === undefined ? {} : { archivedAt: o.archivedAt }),
    });
    await addTitle(c.db, c.branchId, {
      title: 'Kondisi Stok',
      classification: '500',
      createdAt: at,
      items: [
        copy('S-01', { receivedDate: EARLIER }),
        copy('S-02', { receivedDate: TODAY }),
        copy('S-03', { receivedDate: LATER }),
        copy('S-04', { inputOn: EARLIER }),
        copy('S-05', { inputOn: TODAY }),
        copy('S-06', { inputOn: LATER }),
        copy('S-07', {}),
        copy('S-08', { receivedDate: LATER, inputOn: EARLIER }),
        copy('S-09', { receivedDate: EARLIER, inputOn: LATER }),
        copy('S-10', { receivedDate: EARLIER, status: 'on_order' }),
        copy('S-11', { receivedDate: EARLIER, status: 'lost' }),
        copy('S-12', { receivedDate: EARLIER, status: 'withdrawn', archivedAt: at }),
        copy('S-13', { status: 'repair' }),
      ],
    });
  });

  afterAll(async () => {
    await c?.close();
  });

  it('a copy is in the stock by its receiving date, else by the date entered in the source system, else undated', async () => {
    const rows = await c.db.selectFrom('items as i').select('i.barcode_display').where(liveItemSql('i', TODAY)).orderBy('i.barcode_key').execute();
    expect(rows.map((r) => r.barcode_display)).toEqual(['S-01', 'S-02', 'S-04', 'S-05', 'S-07', 'S-09', 'S-13']);
    const before = await c.db.selectFrom('items as i').select('i.barcode_display').where(liveItemSql('i', EARLIER)).orderBy('i.barcode_key').execute();
    expect(before.map((r) => r.barcode_display)).toEqual(['S-01', 'S-04', 'S-07', 'S-09', 'S-13']);
  });

  it.runIf(ctx.engine === 'sqlite')('SQLite counts the stock in one pass over the copies, not through the receiving-date index', async () => {
    const count = c.db
      .selectFrom('items as i')
      .innerJoin('records as r', 'r.id', 'i.record_id')
      .where(liveItemSql('i', TODAY))
      .where('r.archived_at', 'is', null)
      .select(sql<number>`count(*)`.as('n'));
    const plan = (await count.explain(undefined, sql`query plan`)).map((r) => String(r['detail'])).join('\n');
    expect(plan).not.toContain('ix_items_received_date');
    expect(plan).not.toContain('MULTI-INDEX OR');
    expect(Number((await count.executeTakeFirstOrThrow()).n)).toBe(7);
  });
});
