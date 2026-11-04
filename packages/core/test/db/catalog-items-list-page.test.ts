import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import { itemListPageQuery, listItems } from '../../src/catalog/items/list.js';
import { openItemsDb, seedItem, seedRecord, type ItemsDb } from './catalog-items-support.js';

// The admin items list's page (Task 17; Phase 2 Task 39, K9): the page is chosen from `items` alone, in barcode order
// (the unique index), and the record and the branch are joined to that page only. Joined in one statement, MySQL and
// MariaDB start at the two-row `branches` table and sort every item ("Using temporary; Using filesort"): the perf seed
// measured GET catalog/items at 693 ms p95 on MariaDB 10.6 with 150 000 items (budget 200 ms). The plan is the same
// with a few dozen items, so it is pinned here on the MySQL family; the paging itself on every engine.

const ctx = testDbContext();
const mysqlFamily = ctx.engine.startsWith('mysql') || ctx.engine.startsWith('mariadb');
const barcode = (i: number): string => `PLN-${String(i).padStart(3, '0')}`;

describe.skipIf(!ctx.available)(`the items list's page [${engineLabel()}]`, () => {
  let db: ItemsDb;
  let recordId: string;

  beforeAll(async () => {
    db = await openItemsDb('items-list-page');
    recordId = await seedRecord(db, { title: 'Jejak Langkah' });
    // Inserted out of barcode order, in both branches.
    for (const i of Array.from({ length: 60 }, (_, k) => (k * 37) % 60)) {
      await seedItem(db, recordId, { barcode: barcode(i), ...(i % 2 === 1 ? { branchId: db.otherBranchId } : {}) });
    }
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  it('pages through every item in barcode order across both branches, with the record and the branch joined', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let n = 0; n < 5; n += 1) {
      const page = await listItems(db.h.db, { limit: 25, ...(cursor === undefined ? {} : { cursor }) });
      seen.push(...page.items.map((i) => i.barcode));
      for (const item of page.items) {
        expect(item.record).toEqual({ id: recordId, title: 'Jejak Langkah' });
        expect(item.branch.code).toBe(Number(item.barcode.slice(4)) % 2 === 1 ? 'UTARA' : 'PUSAT');
      }
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(Array.from({ length: 60 }, (_, i) => barcode(i)));
    const odd = await listItems(db.h.db, { branchId: db.otherBranchId, limit: 5 });
    expect(odd.items.map((i) => i.barcode)).toEqual([1, 3, 5, 7, 9].map(barcode));
  });

  it.runIf(mysqlFamily)('MySQL/MariaDB: the page is a derived table read in barcode index order, sorting nothing; only that page is joined', async () => {
    const plan = (await itemListPageQuery(db.h.db, { limit: 50 }).explain()) as Record<string, unknown>[];
    const derived = plan.filter((row) => row['select_type'] === 'DERIVED');
    expect(derived).toHaveLength(1);
    expect(derived[0]).toMatchObject({ table: 'p', key: 'uq_items_barcode_key' });
    expect(String(derived[0]!['Extra'] ?? '')).not.toMatch(/filesort|temporary/i);
    // The outer statement reads `items` by primary key for the page's rows only.
    expect(plan.find((row) => row['table'] === 'i')).toMatchObject({ type: 'eq_ref', key: 'PRIMARY' });
  });
});
