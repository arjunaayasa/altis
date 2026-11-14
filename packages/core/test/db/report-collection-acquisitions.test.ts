import { newId, t } from '@altis/shared';
import { REPORT_EXPORT_CURSOR_MAX } from '@altis/shared/api/reports';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import { collectionAcquisitionsReport as def } from '../../src/reports/collection/acquisitions.js';
import { collectionDdcRecapReport } from '../../src/reports/collection/ddc-recap.js';
import type { ReportRow, TableReport } from '../../src/reports/types.js';
import { stockAt } from '../support/stock-fixture.js';
import { addTitle, ctxFor, drain, openCollectionDb, rowsStarting, seedBulk, type CollectionDb } from './report-collection-support.js';

// Acquisitions per year and DDC main class over the stock fixture. A copy is dated by the acquisition-date chain, and
// the time a migration ran is never an acquisition date: the migrated copies without dates, the copy of a placeholder
// record and the imported copy without dates are in the "tanpa tanggal" row, and the migration year holds only the
// copies dated in it. An ordered title is in no row at all. The matrix and the year's copies are answered by a scan of
// the stock that resumes through its cursor.

const ctx = testDbContext();
const UNDATED = t('id', 'report.undated');
const TOTAL = t('id', 'report.row.total');

/** A matrix row: the year (or label), then c000…c900, c2x, cnon, and the total. */
function matrixRow(year: string, counts: Partial<Record<'000' | '100' | '200' | '300' | '400' | '500' | '600' | '700' | '800' | '900' | '2x' | 'non', number>>): ReportRow {
  const cells = ['000', '100', '200', '300', '400', '500', '600', '700', '800', '900', '2x', 'non'].map((k) => counts[k as keyof typeof counts] ?? 0);
  return [year, ...cells, cells.reduce((a, b) => a + b, 0)];
}

describe.skipIf(!ctx.available)(`collection.acquisitions [${engineLabel()}]`, () => {
  let c: CollectionDb;

  beforeAll(async () => {
    c = await openCollectionDb('report-acquisitions');
  });

  afterAll(async () => {
    await c?.close();
  });

  it('counts titles in the year of their first acquisition; undated ones apart; an ordered title nowhere', async () => {
    const { rows, totals } = await drain(def, ctxFor(c, def, { yearFrom: 2017, yearTo: 2026 }));
    expect(totals).toBeNull();
    expect(rows).toEqual([
      matrixRow('2017', {}),
      matrixRow('2018', { '400': 1 }),
      matrixRow('2019', { '400': 1 }),
      matrixRow('2020', {}),
      matrixRow('2021', { '900': 1 }),
      matrixRow('2022', { '2x': 1 }),
      matrixRow('2023', { '800': 1 }),
      matrixRow('2024', { '000': 1, '200': 1 }),
      // The migration ran on 2025-09-01: this year holds only the title made here and the one with a public file.
      matrixRow('2025', { '500': 1, non: 1 }),
      // The title on order since 2026-02-01 is not an acquisition.
      matrixRow('2026', {}),
      matrixRow(UNDATED, { '000': 1, '900': 1, non: 1 }),
      matrixRow(TOTAL, { '000': 2, '200': 1, '400': 2, '500': 1, '800': 1, '900': 2, '2x': 1, non: 2 }),
    ]);
  });

  it('counts copies in the year of their acquisition', async () => {
    const { rows } = await drain(def, ctxFor(c, def, { yearFrom: 2024, yearTo: 2026, unit: 'items' }));
    expect(rows).toEqual([
      matrixRow('2024', { '200': 1 }),
      matrixRow('2025', { non: 1 }),
      matrixRow('2026', {}),
      matrixRow(UNDATED, { '000': 1, '900': 1, non: 1 }),
      matrixRow(TOTAL, { '000': 1, '200': 1, '900': 1, non: 2 }),
    ]);
  });

  it('spans the years found when no range is given', async () => {
    const { rows } = await drain(def, ctxFor(c, def, { unit: 'items' }));
    expect(rows.map((r) => r[0])).toEqual(['2018', '2019', '2020', '2021', '2022', '2023', '2024', '2025', UNDATED, TOTAL]);
  });

  it('counts only the copies of the source asked for', async () => {
    const { rows } = await drain(def, ctxFor(c, def, { unit: 'items', acqSource: 'purchase', yearFrom: 2024, yearTo: 2024 }));
    expect(rows).toEqual([matrixRow('2024', { '200': 1 }), matrixRow(UNDATED, {}), matrixRow(TOTAL, { '200': 1 })]);
  });

  it('lists the copies of the detail year with the basis of their acquisition date', async () => {
    const detail = await drain(def, ctxFor(c, def, { detailYear: 2024 }));
    expect(detail.rows).toEqual([
      ['STK-0001', 'تفسير الجلالين', '200', 'Umum', '2024-03-15', t('id', 'report.acq_basis.received'), 75_000, t('id', 'vocab.acq_source.purchase'), null],
    ]);
    const migrated = await drain(def, ctxFor(c, def, { detailYear: 2022 }));
    expect(migrated.rows).toEqual([['STK-0003', 'Fikih Ibadah Praktis', '2X', 'Umum', '2022-05-10', t('id', 'report.acq_basis.record_created'), null, null, null]]);
    const entered = await drain(def, ctxFor(c, def, { detailYear: 2023 }, { locale: 'en' }));
    expect(entered.rows).toEqual([['STK-0002', 'Laskar Pelangi', '800', 'General', '2023-07-20', t('en', 'report.acq_basis.input_on'), null, null, null]]);
    expect(rowsStarting((await drain(def, ctxFor(c, def, { detailYear: 2026 }))).rows, 'STK-0007')).toEqual([]);
  });

  it('a weeded and archived title stays in the year it was acquired; a cancelled order is in no row; a copy received late is in the year it arrived', async () => {
    const weeded = await addTitle(c.db, c.branchId, {
      title: 'Kimia Kurikulum Lama',
      classification: '540',
      createdAt: stockAt('2018-05-02'),
      archivedAt: stockAt('2025-03-02'),
      items: [{ barcode: 'ACQ-0001', status: 'withdrawn', receivedDate: '2018-05-01', createdAt: stockAt('2018-05-02'), archivedAt: stockAt('2025-03-01') }],
    });
    const cancelled = await addTitle(c.db, c.branchId, {
      title: 'Fisika Kelas XII',
      classification: '530',
      createdAt: stockAt('2025-03-01'),
      items: [{ barcode: 'ACQ-0002', status: 'withdrawn', createdAt: stockAt('2025-03-01'), archivedAt: stockAt('2025-05-01') }],
    });
    const late = await addTitle(c.db, c.branchId, {
      title: 'Geografi Kelas X',
      classification: '910',
      createdAt: stockAt('2024-12-10'),
      items: [{ barcode: 'ACQ-0003', status: 'available', createdAt: stockAt('2024-12-10') }],
    });
    const events = async (itemId: string, entries: readonly [string, string, string][]): Promise<void> => {
      await c.db.deleteFrom('item_events').where('item_id', '=', itemId).execute();
      for (const [on, type, to] of entries) {
        await c.db
          .insertInto('item_events')
          .values({ id: newId(stockAt(on)), item_id: itemId, at: stockAt(on), type, from_status: null, to_status: to, from_location_id: null, to_location_id: null, actor_type: 'staff', actor_id: null, meta: '{"fields":["status"]}' })
          .execute();
      }
    };
    try {
      await events(weeded.itemIds[0]!, [
        ['2018-05-02', 'created', 'available'],
        ['2025-03-01', 'archived', 'withdrawn'],
      ]);
      await events(cancelled.itemIds[0]!, [
        ['2025-03-01', 'created', 'on_order'],
        ['2025-05-01', 'archived', 'withdrawn'],
      ]);
      await events(late.itemIds[0]!, [
        ['2024-12-10', 'created', 'on_order'],
        ['2025-01-20', 'status', 'available'],
      ]);
      // The fixture alone: in titles 2024 {000: 1, 200: 1} and 2025 {500: 1, non: 1}; in copies 2024 {200: 1} and 2025 {non: 1}.
      const expected = {
        titles: [matrixRow('2018', { '400': 1, '500': 1 }), matrixRow('2024', { '000': 1, '200': 1 }), matrixRow('2025', { '500': 1, '900': 1, non: 1 })],
        items: [matrixRow('2018', { '400': 1, '500': 1 }), matrixRow('2024', { '200': 1 }), matrixRow('2025', { '900': 1, non: 1 })],
      };
      for (const unit of ['titles', 'items'] as const) {
        const { rows } = await drain(def, ctxFor(c, def, { yearFrom: 2018, yearTo: 2025, unit }));
        expect(['2018', '2024', '2025'].map((year) => rows.find((r) => r[0] === year)), unit).toEqual(expected[unit]);
      }
      const detail = await drain(def, ctxFor(c, def, { detailYear: 2025 }));
      expect(rowsStarting(detail.rows, 'ACQ-0003')).toEqual([['ACQ-0003', 'Geografi Kelas X', '900', 'Umum', '2025-01-20', t('id', 'report.acq_basis.received'), null, null, null]]);
      expect(rowsStarting(detail.rows, 'ACQ-0002')).toEqual([]);
    } finally {
      for (const x of [weeded, cancelled, late]) {
        await c.db.deleteFrom('item_events').where('item_id', 'in', x.itemIds).execute();
        await c.db.deleteFrom('items').where('id', 'in', x.itemIds).execute();
        await c.db.deleteFrom('records').where('id', '=', x.recordId).execute();
      }
    }
  });

  it('refuses a range whose first year is after its last', () => {
    expect(def.paramsSchema.safeParse({ yearFrom: 2025, yearTo: 2024 }).success).toBe(false);
  });
});

// The scan stops when the slice's budget runs out and answers a page without rows whose cursor carries the scan's key
// and the counts so far; continued page by page, the answer is the same as in one call.
describe.skipIf(!ctx.available)(`collection scans resumed through their cursor [${engineLabel()}]`, () => {
  let c: CollectionDb;

  beforeAll(async () => {
    c = await openCollectionDb('report-acquisitions-resume');
    await seedBulk(c.db, c.branchId, 1_100, { prefix: 'RES' });
  }, 120_000);

  afterAll(async () => {
    await c?.close();
  });

  const cases: [string, TableReport, Record<string, unknown>][] = [
    ['acquisitions in titles', def, {}],
    ['acquisitions in copies', def, { unit: 'items', yearFrom: 2015, yearTo: 2026 }],
    ['acquisitions of a detail year', def, { detailYear: 2019 }],
    ['the DDC recap at an earlier date', collectionDdcRecapReport, { asOf: '2025-01-31' }],
    ['the DDC recap with divisions and a breakdown', collectionDdcRecapReport, { asOf: '2025-01-31', divisions: true, breakdown: 'fnr' }],
  ];

  it.each(cases)('%s: a budget that stops after every batch gives the rows of one long call', async (_name, report, params) => {
    const whole = await drain(report, ctxFor(c, report, params));
    expect(whole.rows.length).toBeGreaterThan(0);
    const sliced = await drain(report, ctxFor(c, report, params, { budget: () => 0 }));
    expect(sliced.rows).toEqual(whole.rows);
    // 1 100 titles and the fixture: at least three batches of the scan.
    expect(sliced.pages).toBeGreaterThanOrEqual(3);
    for (const cursor of sliced.cursors) expect(cursor.length).toBeLessThanOrEqual(REPORT_EXPORT_CURSOR_MAX);
  });
});
