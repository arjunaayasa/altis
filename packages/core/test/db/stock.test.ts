import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations } from '@altis/db';
import { newId } from '@altis/shared';
import type { KyselyPlugin } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { firstAcq, inStockAt, scanRecordStock, type RecordStockFacts } from '../../src/reports/stock/index.js';
import { STOCK_ITEM_KEYS, STOCK_TZ, seedStockFixture, stockAt, type StockFixture, type StockItemKey, type StockRecordKey } from '../support/stock-fixture.js';

// The stock reader over a real database: the facts of every title (its copies with their acquisition date and status
// history, its placeholder and public-file marks), read in id order a batch at a time, and the stock at a date they give.

const ctx = testDbContext();
const EBOOK = new Set(['EBOOK']);

/** The acquisition date and its basis each fixture copy must get. */
const EXPECTED_ACQ: Readonly<Record<StockItemKey, [string | null, string | null]>> = {
  received: ['2024-03-15', 'received'],
  inputOn: ['2023-07-20', 'input_on'],
  migratedValid: ['2022-05-10', 'record_created'],
  migratedInSpan: [null, null],
  created: ['2025-06-02', 'item_created'],
  imported: [null, null],
  onOrder: ['2026-02-01', 'item_created'],
  withdrawn: ['2019-08-01', 'received'],
  lost: ['2021-04-12', 'received'],
  syncLost: ['2018-01-09', 'input_on'],
  orphan: [null, null],
};

describe.skipIf(!ctx.available)(`scanRecordStock [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;
  let fx: StockFixture;
  let all: RecordStockFacts[];
  let otherBranchId: string;
  let otherRecordId: string;

  /** Every title, read in batches of `limit`. */
  async function scanAll(limit: number, branchId?: string | null): Promise<{ rows: RecordStockFacts[]; calls: number }> {
    const rows: RecordStockFacts[] = [];
    let after: string | null = null;
    let calls = 0;
    for (;;) {
      const page: { rows: RecordStockFacts[]; next: string | null } = await scanRecordStock(h.db, { tz: STOCK_TZ, after, limit, branchId });
      calls += 1;
      rows.push(...page.rows);
      if (page.next === null) return { rows, calls };
      expect(calls).toBeLessThan(100);
      after = page.next;
    }
  }

  const recordOf = (key: StockRecordKey): RecordStockFacts => {
    const r = all.find((x) => x.recordId === fx.records[key]);
    if (r === undefined) throw new Error(`no title ${key}`);
    return r;
  };
  const stockAtDate = (d: string): Set<string> => new Set(all.filter((r) => inStockAt(r, d, EBOOK)).map((r) => r.recordId));

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-core-stock-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(root, 'migrations'), migrations: PHASE1_MIGRATIONS });
    fx = await seedStockFixture(h.db);
    all = (await scanAll(500)).rows;
  });

  afterAll(async () => {
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  it('every copy gets the acquisition date of the chain; migration times never become one', () => {
    const got = Object.fromEntries(
      STOCK_ITEM_KEYS.map((key) => {
        const copy = all.flatMap((r) => r.items).find((i) => i.itemId === fx.items[key]);
        return [key, copy === undefined ? 'missing' : [copy.acqDate, copy.acqBasis]];
      }),
    );
    expect(got).toEqual(EXPECTED_ACQ);
  });

  it('reads every title once, in id order, with its copies and marks', () => {
    const ids = all.map((r) => r.recordId);
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids)).toEqual(new Set(Object.values(fx.records)));
    expect(recordOf('placeholder')).toMatchObject({ isPlaceholder: true, items: [expect.objectContaining({ itemId: fx.items.orphan })] });
    expect(all.filter((r) => r.isPlaceholder).map((r) => r.recordId)).toEqual([fx.records.placeholder]);
    expect(all.filter((r) => r.hasPublicFile).map((r) => r.recordId)).toEqual([fx.records.publicFile]);
    expect(recordOf('ebook')).toMatchObject({ materialTypeCode: 'EBOOK', createdOn: '2024-11-20', items: [] });
    expect(recordOf('received')).toMatchObject({ classification: '297', archived: false, materialTypeCode: 'BUKU' });
    expect(recordOf('migratedInSpan')).toMatchObject({ classification: null, callNumber: 'R 030 ENS e' });
    expect(recordOf('received').items[0]).toMatchObject({
      branchId: fx.branchId,
      status: 'available',
      barcodeKey: 'STK-0001',
      inventoryNo: 'INV/2024/001',
      receivedDate: '2024-03-15',
      price: 7_500_000,
      currency: 'IDR',
      acqSource: 'purchase',
      collectionTypeCode: 'UMUM',
      archivedOn: null,
    });
    expect(recordOf('migratedInSpan').items[0]).toMatchObject({ collectionTypeCode: 'REF' });
    expect(recordOf('withdrawn').items[0]).toMatchObject({ status: 'withdrawn', archivedOn: '2025-02-01' });
  });

  it('a record created at the time of its migration, or a placeholder, has no known creation date; others keep theirs', () => {
    expect(recordOf('migratedInSpan').createdOn).toBeNull();
    expect(recordOf('placeholder').createdOn).toBeNull();
    expect(recordOf('migratedValid').createdOn).toBe('2022-05-10');
    // An import's own time span is not a migration's.
    expect(recordOf('imported').createdOn).toBe('2025-04-15');
    expect(recordOf('received').createdOn).toBe('2024-03-18');
  });

  it('the status timeline holds every status-bearing event, oldest first, as local dates', () => {
    expect(recordOf('syncLost').items[0]?.statusTimeline).toEqual([
      { on: '2025-09-01', to: 'available' },
      { on: '2026-03-10', to: 'lost' },
    ]);
    expect(recordOf('lost').items[0]?.statusTimeline).toEqual([
      { on: '2021-04-13', to: 'available' },
      { on: '2025-12-20', to: 'missing' },
      { on: '2026-01-05', to: 'lost' },
    ]);
    expect(recordOf('withdrawn').items[0]?.statusTimeline).toEqual([
      { on: '2019-08-02', to: 'available' },
      { on: '2025-02-01', to: 'withdrawn' },
    ]);
  });

  it('the stock on 2025-01-31 and on 2025-02-01 differs by the withdrawn copy\'s title', () => {
    const before = stockAtDate('2025-01-31');
    const after = stockAtDate('2025-02-01');
    expect([...before].filter((id) => !after.has(id))).toEqual([fx.records.withdrawn]);
    expect([...after].filter((id) => !before.has(id))).toEqual([]);
  });

  it('the lost copy\'s title leaves the stock on 2026-01-05 (no other live copy)', () => {
    expect(stockAtDate('2026-01-04').has(fx.records.lost)).toBe(true);
    expect(stockAtDate('2026-01-05').has(fx.records.lost)).toBe(false);
  });

  it('a copy a re-sync marked lost counts on 2026-03-09 and not from 2026-03-10', () => {
    expect(stockAtDate('2026-03-09').has(fx.records.syncLost)).toBe(true);
    expect(stockAtDate('2026-03-10').has(fx.records.syncLost)).toBe(false);
    // Before the first run its first status (available) holds.
    expect(stockAtDate('2018-01-09').has(fx.records.syncLost)).toBe(true);
    expect(stockAtDate('2018-01-08').has(fx.records.syncLost)).toBe(false);
  });

  it('the ordered copy never counts and its title has no first acquisition', () => {
    for (const d of ['2026-02-01', '2026-06-30', '2030-01-01']) expect(stockAtDate(d).has(fx.records.onOrder)).toBe(false);
    expect(firstAcq(recordOf('onOrder'))).toBe('unknown');
  });

  it('a title with only a staff file, an archived public file or a public link never counts; a public file does', () => {
    for (const d of ['2025-03-04', '2026-01-01', '2030-01-01']) expect(stockAtDate(d).has(fx.records.staffFile)).toBe(false);
    expect(stockAtDate('2025-03-02').has(fx.records.publicFile)).toBe(false);
    expect(stockAtDate('2025-03-03').has(fx.records.publicFile)).toBe(true);
    expect(stockAtDate('2024-11-19').has(fx.records.ebook)).toBe(false);
    expect(stockAtDate('2024-11-20').has(fx.records.ebook)).toBe(true);
  });

  it('undated copies are in the stock at every date; their titles have no first acquisition', () => {
    for (const key of ['migratedInSpan', 'imported', 'placeholder'] as const) {
      expect(stockAtDate('1990-01-01').has(fx.records[key])).toBe(true);
      expect(firstAcq(recordOf(key))).toBe('unknown');
    }
  });

  it('first acquisitions of the dated titles', () => {
    expect(firstAcq(recordOf('received'))).toBe('2024-03-15');
    expect(firstAcq(recordOf('migratedValid'))).toBe('2022-05-10');
    expect(firstAcq(recordOf('withdrawn'))).toBe('2019-08-01');
    expect(firstAcq(recordOf('ebook'))).toBe('2024-11-20');
    expect(firstAcq(recordOf('publicFile'))).toBe('2025-03-03');
  });

  it('a paged scan (3 titles a page) yields the same titles as one page', async () => {
    const paged = await scanAll(3);
    expect(paged.calls).toBeGreaterThanOrEqual(Math.ceil(all.length / 3));
    expect(paged.rows).toEqual(all);
  });

  describe('one branch', () => {
    beforeAll(async () => {
      const at = stockAt('2020-01-01');
      otherBranchId = newId(at);
      await h.db
        .insertInto('branches')
        .values({ id: otherBranchId, code_key: 'LAIN', code_display: 'LAIN', name: 'Cabang Lain', address: null, timezone: STOCK_TZ, is_default: 0, created_at: at, created_by: null, updated_at: at, updated_by: null })
        .execute();
      const fixtureRecord = await h.db.selectFrom('records').selectAll().where('id', '=', fx.records.received).executeTakeFirstOrThrow();
      otherRecordId = newId(at);
      await h.db.insertInto('records').values({ ...fixtureRecord, id: otherRecordId, title: 'Buku Cabang Lain', version: 1 }).execute();
      const fixtureItem = await h.db.selectFrom('items').selectAll().where('id', '=', fx.items.received).executeTakeFirstOrThrow();
      // A copy of the other branch on a fixture title too, and one on its own title.
      for (const [recordId, barcode] of [
        [fx.records.migratedValid, 'LAIN-0001'],
        [otherRecordId, 'LAIN-0002'],
      ] as const) {
        await h.db
          .insertInto('items')
          .values({ ...fixtureItem, id: newId(at), record_id: recordId, branch_id: otherBranchId, barcode_display: barcode, barcode_key: barcode, version: 1 })
          .execute();
      }
    });

    it('attaches only that branch\'s copies and leaves out titles without one', async () => {
      const mine = (await scanAll(4, fx.branchId)).rows;
      const withItems = Object.values(fx.records).filter((id) => all.find((r) => r.recordId === id)!.items.length > 0);
      expect(new Set(mine.map((r) => r.recordId))).toEqual(new Set(withItems));
      expect(mine.flatMap((r) => r.items).every((i) => i.branchId === fx.branchId)).toBe(true);
      const other = (await scanAll(2, otherBranchId)).rows;
      expect(other.map((r) => r.recordId).sort()).toEqual([fx.records.migratedValid, otherRecordId].sort());
      expect(other.flatMap((r) => r.items).map((i) => i.barcodeKey).sort()).toEqual(['LAIN-0001', 'LAIN-0002']);
      // Without a branch, the title carries the copies of both.
      const both = (await scanAll(500)).rows.find((r) => r.recordId === fx.records.migratedValid);
      expect(both?.items.map((i) => i.branchId).sort()).toEqual([fx.branchId, otherBranchId].sort());
    });
  });

  it('never reads the search tables', async () => {
    const statements: string[] = [];
    const capture: KyselyPlugin = {
      transformQuery(args) {
        statements.push(h.db.getExecutor().compileQuery(args.node, args.queryId).sql);
        return args.node;
      },
      async transformResult(args) {
        return args.result;
      },
    };
    await scanRecordStock(h.db.withPlugin(capture), { tz: STOCK_TZ, after: null, limit: 500 });
    expect(statements.length).toBeGreaterThan(0);
    for (const sql of statements) expect(sql).not.toMatch(/search_/);
  });

  it('refuses a batch size outside 1-500', async () => {
    await expect(scanRecordStock(h.db, { tz: STOCK_TZ, after: null, limit: 0 })).rejects.toThrow(RangeError);
    await expect(scanRecordStock(h.db, { tz: STOCK_TZ, after: null, limit: 501 })).rejects.toThrow(RangeError);
  });
});
