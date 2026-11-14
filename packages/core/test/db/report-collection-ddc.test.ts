import { addDays, t } from '@altis/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import { NON_TOKEN_ROWS_MAX, collectionDdcRecapReport as def } from '../../src/reports/collection/ddc-recap.js';
import type { ReportRow } from '../../src/reports/types.js';
import { stockAt } from '../support/stock-fixture.js';
import { TODAY, addTitle, ctxFor, drain, openCollectionDb, rowsStarting, type CollectionDb } from './report-collection-support.js';

// The DDC recap over the stock fixture plus a title of class `2x7`: the Islamic expansion is a class of its own, an
// empty classification falls back to the call number, a non-DDC class number gets its own row under "Lainnya", the
// main classes add up to the number of titles in stock, divisions are labelled by their numbers, and a breakdown gives
// one row per class and group. Today's recap (grouped queries) and a recap of the same day through the stock scan agree.

const ctx = testDbContext();
const MAINS = ['000', '100', '200', '300', '400', '500', '600', '700', '800', '900', '2X', 'NON'];
const label = (main: string) => t('id', `vocab.ddc_main.${main}` as Parameters<typeof t>[1]);

describe.skipIf(!ctx.available)(`collection.ddc_recap [${engineLabel()}]`, () => {
  let c: CollectionDb;

  beforeAll(async () => {
    c = await openCollectionDb('report-ddc');
    await addTitle(c.db, c.branchId, {
      title: 'Akidah Akhlak',
      classification: '2x7',
      createdAt: stockAt('2024-05-06'),
      items: [{ barcode: 'DDC-0001', receivedDate: '2024-05-06', createdAt: stockAt('2024-05-06') }],
    });
  });

  afterAll(async () => {
    await c?.close();
  });

  const mainRow = (rows: readonly ReportRow[], main: string): ReportRow => {
    const found = rowsStarting(rows, main, label(main));
    expect(found, main).toHaveLength(1);
    return found[0]!;
  };

  it('counts 2X apart from 200, falls back to the call number, and lists the non-DDC class numbers under NON', async () => {
    const { rows, totals } = await drain(def, ctxFor(c, def, {}));
    expect(rows.map((r) => r[0])).toEqual([...MAINS, 'NON', 'NON']);
    expect(mainRow(rows, '2X')).toEqual(['2X', label('2X'), null, 2, 2]);
    expect(mainRow(rows, '200')).toEqual(['200', label('200'), null, 1, 1]);
    // `R 030 ENS e` (no classification) and the e-book `028`, which has no copies.
    expect(mainRow(rows, '000')).toEqual(['000', label('000'), null, 2, 1]);
    expect(mainRow(rows, 'NON')).toEqual(['NON', label('NON'), null, 2, 2]);
    expect(rows.slice(-2)).toEqual([
      ['NON', t('id', 'report.row.collection.no_class_token'), null, 1, 1],
      ['NON', 'PROG/2021', null, 1, 1],
    ]);
    // Each title once, under its record's class: the main classes add up to the totals row.
    const mains = rows.filter((r) => MAINS.includes(r[0] as string) && r[1] === label(r[0] as string));
    const sum = mains.reduce<[number, number]>((acc, r) => [acc[0] + (r[3] as number), acc[1] + (r[4] as number)], [0, 0]);
    expect(totals).toEqual([null, t('id', 'report.row.total'), null, 10, 8]);
    expect(sum).toEqual([10, 8]);
  });

  it('opens each main class into ten divisions labelled by their numbers', async () => {
    const { rows } = await drain(def, ctxFor(c, def, { divisions: true }));
    expect(rows).toHaveLength(10 * 11 + 2 + 2);
    expect(rows.slice(0, 3)).toEqual([
      ['000', label('000'), null, 2, 1],
      ['000-009', '000–009', null, 0, 0],
      ['010', '010–019', null, 0, 0],
    ]);
    expect(rowsStarting(rows, '020')).toEqual([['020', '020–029', null, 1, 0]]);
    expect(rowsStarting(rows, '030')).toEqual([['030', '030–039', null, 1, 1]]);
    expect(rowsStarting(rows, '890')).toEqual([['890', '890–899', null, 1, 1]]);
    expect(rowsStarting(rows, '800-809')).toEqual([['800-809', '800–809', null, 0, 0]]);
  });

  it('breaks each class down by material type, one row per class and group', async () => {
    const { rows, totals } = await drain(def, ctxFor(c, def, { breakdown: 'material_type' }));
    expect(rowsStarting(rows, '000')).toEqual([
      ['000', label('000'), 'Buku', 1, 1],
      ['000', label('000'), 'Buku elektronik', 1, 0],
    ]);
    // A class without titles keeps one row of zeros.
    expect(rowsStarting(rows, '100')).toEqual([['100', label('100'), null, 0, 0]]);
    expect(totals).toEqual([null, t('id', 'report.row.total'), null, 10, 8]);
  });

  it('breaks the classes down into fiction, nonfiction and reference', async () => {
    const { rows } = await drain(def, ctxFor(c, def, { breakdown: 'fnr' }));
    // The copy of `R 030 ENS e` is of collection type REF: the title is reference; the e-book is nonfiction.
    expect(rowsStarting(rows, '000')).toEqual([
      ['000', label('000'), t('id', 'report.group.fnr.nonfiction'), 1, 0],
      ['000', label('000'), t('id', 'report.group.fnr.reference'), 1, 1],
    ]);
  });

  it('filters by material type', async () => {
    const ebook = await c.db.selectFrom('material_types').select('id').where('code_key', '=', 'EBOOK').executeTakeFirstOrThrow();
    const { rows, totals } = await drain(def, ctxFor(c, def, { materialTypeId: ebook.id }));
    expect(mainRow(rows, '000')).toEqual(['000', label('000'), null, 1, 0]);
    expect(totals).toEqual([null, t('id', 'report.row.total'), null, 1, 0]);
  });

  it('answers the same recap for today from the grouped queries and from the stock scan', async () => {
    for (const params of [{}, { divisions: true }, { breakdown: 'material_type' }, { breakdown: 'fnr' }, { breakdown: 'medium' }, { breakdown: 'collection_type' }, { breakdown: 'language' }]) {
      const live = await drain(def, ctxFor(c, def, params));
      const scanned = await drain(def, ctxFor(c, def, { ...params, asOf: TODAY }, { today: addDays(TODAY, 1) }));
      expect(scanned.totals, JSON.stringify(params)).toBeNull();
      expect(scanned.rows, JSON.stringify(params)).toEqual([...live.rows, live.totals]);
    }
  });

  it('counts the stock at an earlier date through the scan', async () => {
    const { rows } = await drain(def, ctxFor(c, def, { asOf: '2025-01-31' }));
    // 423 (withdrawn on 2025-02-01) and 499.222 (lost in 2026) are still in the stock.
    expect(mainRow(rows, '400')).toEqual(['400', label('400'), null, 2, 2]);
    // 909 (undated) and 912 (lost in 2026).
    expect(mainRow(rows, '900')).toEqual(['900', label('900'), null, 2, 2]);
    // PROG/2021 was made in June 2025.
    expect(rowsStarting(rows, 'NON', 'PROG/2021')).toEqual([]);
    expect(rows.at(-1)).toEqual([null, t('id', 'report.row.total'), null, 11, 10]);
  });

  it('labels the rows in the language of the request', async () => {
    const { rows, totals } = await drain(def, ctxFor(c, def, {}, { locale: 'en' }));
    expect(rows[0]![1]).toBe(t('en', 'vocab.ddc_main.000'));
    expect(totals![1]).toBe(t('en', 'report.row.total'));
  });
});

// More class numbers outside DDC than get a row of their own: the first ones in order keep their rows, the others share
// one row, and "Lainnya" still counts them all; the scan, which meets them in another order, ends with the same rows.
describe.skipIf(!ctx.available)(`collection.ddc_recap with many class numbers outside DDC [${engineLabel()}]`, () => {
  let c: CollectionDb;

  beforeAll(async () => {
    c = await openCollectionDb('report-ddc-tokens', { fixture: false });
    // Written in reverse order, so the scan (by record id) meets the last numbers first.
    for (let k = NON_TOKEN_ROWS_MAX + 5; k >= 1; k -= 1) {
      const code = `X-${String(k).padStart(3, '0')}`;
      await addTitle(c.db, c.branchId, { title: `Lokal ${code}`, classification: code, items: [{ barcode: `TOK-${code}` }] });
    }
  }, 120_000);

  afterAll(async () => {
    await c?.close();
  });

  it('keeps a row for the first class numbers and one shared row for the rest', async () => {
    const live = await drain(def, ctxFor(c, def, {}));
    const tokens = live.rows.filter((r) => r[0] === 'NON' && r[1] !== label('NON'));
    expect(tokens).toHaveLength(NON_TOKEN_ROWS_MAX + 1);
    expect(tokens[0]).toEqual(['NON', 'X-001', null, 1, 1]);
    expect(tokens[NON_TOKEN_ROWS_MAX - 1]).toEqual(['NON', `X-${String(NON_TOKEN_ROWS_MAX).padStart(3, '0')}`, null, 1, 1]);
    expect(tokens.at(-1)).toEqual(['NON', t('id', 'report.row.collection.other_tokens'), null, 5, 5]);
    expect(mainRowOf(live.rows, 'NON')).toEqual(['NON', label('NON'), null, NON_TOKEN_ROWS_MAX + 5, NON_TOKEN_ROWS_MAX + 5]);
    const scanned = await drain(def, ctxFor(c, def, { asOf: TODAY }, { today: addDays(TODAY, 1) }));
    expect(scanned.rows).toEqual([...live.rows, live.totals]);
  });

  it('refuses a cursor it did not answer', async () => {
    await expect(def.rows(ctxFor(c, def, {}), 'not a cursor', 10)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(def.rows(ctxFor(c, def, { asOf: '2025-01-31' }), '{"o":3}', 10)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

// One class number outside DDC written with another case, accents or an invisible character: MySQL and MariaDB group
// those spellings together (their comparison ignores case and accents) and keep any one of them, PostgreSQL and SQLite
// keep them apart. Every engine, today and through the scan, counts them under the same one row.
describe.skipIf(!ctx.available)(`collection.ddc_recap with one class number outside DDC in several spellings [${engineLabel()}]`, () => {
  let c: CollectionDb;

  beforeAll(async () => {
    c = await openCollectionDb('report-ddc-spellings', { fixture: false });
    const spellings = ['Ref', 'REF', 'réf', 'RÉF', 'ref​', 'Lokal'];
    for (const [k, classification] of spellings.entries()) {
      await addTitle(c.db, c.branchId, { title: `Rujukan ${k}`, classification, items: [{ barcode: `SPL-${k}` }] });
    }
  });

  afterAll(async () => {
    await c?.close();
  });

  it('counts every spelling under one upper-case row, the same today and through the scan', async () => {
    const live = await drain(def, ctxFor(c, def, {}));
    expect(live.rows.filter((r) => r[0] === 'NON' && r[1] !== label('NON'))).toEqual([
      ['NON', 'LOKAL', null, 1, 1],
      ['NON', 'REF', null, 5, 5],
    ]);
    expect(mainRowOf(live.rows, 'NON')).toEqual(['NON', label('NON'), null, 6, 6]);
    const scanned = await drain(def, ctxFor(c, def, { asOf: TODAY }, { today: addDays(TODAY, 1) }));
    expect(scanned.rows).toEqual([...live.rows, live.totals]);
  });
});

function mainRowOf(rows: readonly ReportRow[], main: string): ReportRow | undefined {
  return rows.find((r) => r[0] === main && r[1] === label(main));
}
