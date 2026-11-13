import { addDays, t, type MessageKey } from '@altis/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import { collectionSummaryReport as def } from '../../src/reports/collection/summary.js';
import { REPORTS } from '../../src/reports/registry.js';
import { previewReport } from '../../src/reports/runs/preview.js';
import type { ReportRow, TableReport } from '../../src/reports/types.js';
import { STOCK_TZ } from '../support/stock-fixture.js';
import { NOW, TODAY, addLocation, ctxFor, drain, openCollectionDb, rowsStarting, seedBulk, type CollectionDb } from './report-collection-support.js';

// The collection summary over the stock fixture: titles (all, with copies, without copies, electronic), copies by
// status, titles by material type, copies by collection type and by location, at a date. A title leaves the stock the
// day its last copy is withdrawn or declared lost; an e-book without copies counts as electronic. Today's summary
// (grouped queries) and the summary of the same day through the stock scan agree.

const ctx = testDbContext();
const section = (key: string) => t('id', `report.summary.section.${key}` as MessageKey);
const row = (key: string) => t('id', `report.row.collection.${key}` as MessageKey);

describe.skipIf(!ctx.available)(`collection.summary [${engineLabel()}]`, () => {
  let c: CollectionDb;

  beforeAll(async () => {
    c = await openCollectionDb('report-summary');
  });

  afterAll(async () => {
    await c?.close();
  });

  const titlesRow = (rows: readonly ReportRow[], key: string): ReportRow => {
    const found = rowsStarting(rows, section('titles'), row(key));
    expect(found, key).toHaveLength(1);
    return found[0]!;
  };

  it('counts today’s titles and copies by every part of the summary', async () => {
    const { rows, totals } = await drain(def, ctxFor(c, def, {}));
    expect(totals).toBeNull();
    expect(rows).toEqual([
      [section('titles'), row('titles_all'), 9, 7],
      [section('titles'), row('titles_with_items'), 7, 7],
      [section('titles'), row('titles_without_items'), 2, 0],
      [section('titles'), row('titles_electronic'), 1, 0],
      [section('items_by_status'), t('id', 'vocab.item_status.processing'), 0, 0],
      [section('items_by_status'), t('id', 'vocab.item_status.available'), 7, 7],
      [section('items_by_status'), t('id', 'vocab.item_status.not_for_loan'), 0, 0],
      [section('items_by_status'), t('id', 'vocab.item_status.repair'), 0, 0],
      [section('items_by_status'), t('id', 'vocab.item_status.missing'), 0, 0],
      [section('titles_by_material_type'), 'Buku', 8, 7],
      [section('titles_by_material_type'), 'Buku elektronik', 1, 0],
      [section('items_by_collection_type'), 'Umum', 6, 6],
      [section('items_by_collection_type'), 'Referensi', 1, 1],
      [section('items_by_location'), row('no_location'), 7, 7],
    ]);
  });

  it('counts the withdrawn copy’s title up to the day before its withdrawal', async () => {
    const before = await drain(def, ctxFor(c, def, { asOf: '2025-01-31' }));
    const after = await drain(def, ctxFor(c, def, { asOf: '2025-02-01' }));
    expect(titlesRow(before.rows, 'titles_all')).toEqual([section('titles'), row('titles_all'), 10, 9]);
    expect(titlesRow(after.rows, 'titles_all')).toEqual([section('titles'), row('titles_all'), 9, 8]);
  });

  it('drops the lost copy’s title on the day it is declared lost; the day before it counts as missing', async () => {
    const before = await drain(def, ctxFor(c, def, { asOf: '2026-01-04' }));
    const after = await drain(def, ctxFor(c, def, { asOf: '2026-01-05' }));
    expect(titlesRow(before.rows, 'titles_all')[2]).toBe(11);
    expect(titlesRow(after.rows, 'titles_all')[2]).toBe(10);
    expect(rowsStarting(before.rows, section('items_by_status'), t('id', 'vocab.item_status.missing'))).toEqual([
      [section('items_by_status'), t('id', 'vocab.item_status.missing'), 1, 1],
    ]);
  });

  it('counts the e-book without copies as an electronic title', async () => {
    const { rows } = await drain(def, ctxFor(c, def, { asOf: '2024-12-01' }));
    expect(titlesRow(rows, 'titles_electronic')).toEqual([section('titles'), row('titles_electronic'), 1, 0]);
    expect(titlesRow(rows, 'titles_without_items')).toEqual([section('titles'), row('titles_without_items'), 1, 0]);
  });

  it('answers the same summary for today from the grouped queries and from the stock scan', async () => {
    for (const params of [{}, { branchId: c.branchId }]) {
      const live = await drain(def, ctxFor(c, def, params));
      const scanned = await drain(def, ctxFor(c, def, { ...params, asOf: TODAY }, { today: addDays(TODAY, 1) }));
      expect(scanned.rows, JSON.stringify(params)).toEqual(live.rows);
    }
  });

  it('leaves the titles without copies out of a branch’s summary', async () => {
    const { rows } = await drain(def, ctxFor(c, def, { branchId: c.branchId }));
    expect(titlesRow(rows, 'titles_all')).toEqual([section('titles'), row('titles_all'), 7, 7]);
    expect(titlesRow(rows, 'titles_without_items')).toEqual([section('titles'), row('titles_without_items'), 0, 0]);
  });

  it('pages the rows', async () => {
    const whole = await drain(def, ctxFor(c, def, {}));
    const paged = await drain(def, ctxFor(c, def, {}), 4);
    expect(paged.pages).toBeGreaterThan(3);
    expect(paged.rows).toEqual(whole.rows);
  });
});

// Not binding here (the budget is measured on the performance seed): the first preview page of every collection
// report on a catalogue of 5 000 titles, each in well under the preview's budget.
describe.skipIf(!ctx.available)(`collection reports on 5 000 titles [${engineLabel()}]`, () => {
  let c: CollectionDb;

  beforeAll(async () => {
    c = await openCollectionDb('report-collection-perf', { fixture: false });
    const locationId = await addLocation(c.db, c.branchId, 'R1', 'Ruang Baca');
    await seedBulk(c.db, c.branchId, 5_000, { prefix: 'PERF', locationId });
  }, 120_000);

  afterAll(async () => {
    await c?.close();
  });

  it('answers the first preview page of each collection report', async () => {
    const collection = REPORTS.filter((d): d is TableReport => d.id.startsWith('collection.') && d.kind === 'table');
    expect(collection).toHaveLength(8);
    const timings: Record<string, number> = {};
    for (const report of collection) {
      const started = performance.now();
      const page = await previewReport(c.db, report, { params: {} }, { locale: 'id', tz: STOCK_TZ, now: NOW, settings: c.settings });
      timings[report.id] = Math.round(performance.now() - started);
      // The catalogue has no attachments and no incomplete copies.
      const empty = report.id === 'collection.attachment_downloads' || report.id === 'collection.data_quality';
      expect(page.rows.length > 0, report.id).toBe(!empty);
    }
    for (const [id, ms] of Object.entries(timings)) expect(ms, id).toBeLessThan(15_000);
  }, 180_000);
});
