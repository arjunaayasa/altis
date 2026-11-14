import { isDomainError, newId, t, type Locale, type MessageKey } from '@altis/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import { annexAdditionsReport } from '../../src/accreditation/annexes/additions.js';
import { annexCollectionMatrixReport } from '../../src/accreditation/annexes/collection-matrix.js';
import { annexDdcReport } from '../../src/accreditation/annexes/ddc.js';
import { instrumentById } from '../../src/accreditation/instruments/index.js';
import type { AccredMetricId } from '../../src/accreditation/metric-ids.js';
import { readProfile } from '../../src/accreditation/periods/profile.js';
import { collectionProvider } from '../../src/accreditation/providers/collection.js';
import type { AccredMetricContext, AccredMetricValue } from '../../src/accreditation/types.js';
import type { ReportRow, TableReport } from '../../src/reports/types.js';
import { ctxFor, drain, openCollectionDb, seedBulk, type CollectionDb } from './report-collection-support.js';

// The three collection annexes of an accreditation period (school year 2025-07-01 … 2026-06-30, read after it ended,
// so the snapshot date is 2026-06-30) on the stock fixture: the printed titles and their copies by DDC class (the
// e-book left out), the collection by medium and kind, and the additions of 2024–2026 against the stock of 2023-12-31
// (the table of the period's three-year additions metric, row for row). The annexes scan the stock: a scan that runs
// out of budget answers no rows and a cursor, and goes on from it.

const ctx = testDbContext();
const NOW = Date.UTC(2026, 8, 1, 3, 0, 0);
const TODAY = '2026-09-01';

const label = (key: string, locale: Locale = 'id', params?: Record<string, string | number>): string => t(locale, key as MessageKey, params);

async function failure(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => 'resolved',
    (e: unknown) => {
      if (!isDomainError(e)) throw e;
      if (e.code === 'VALIDATION_FAILED') return { code: e.code, errors: e.meta?.['errors'] };
      return { code: e.code };
    },
  );
}

/** A school-year period 2025/2026 of the upper secondary instrument. */
async function addPeriod(c: CollectionDb): Promise<string> {
  const id = newId(NOW);
  await c.db
    .insertInto('accred_periods')
    .values({
      id,
      branch_id: null,
      name: 'Tahun pelajaran 2025/2026',
      kind: 'school_year',
      starts_on: '2025-07-01',
      ends_on: '2026-06-30',
      instrument_id: 'sch-sma-2025',
      status: 'open',
      frozen_at: null,
      frozen_by: null,
      profile: '{"schoolLevel":"sma_smk_ma"}',
      students: 400,
      teachers: 30,
      edu_staff: 10,
      all_registered_confirmed: 0,
      archived_at: null,
      version: 0,
      created_at: NOW,
      created_by: null,
      updated_at: NOW,
      updated_by: null,
    })
    .execute();
  return id;
}

/** The provider's values of `ids` for the period (one slice). */
async function metrics(c: CollectionDb, periodId: string, ids: readonly AccredMetricId[]): Promise<Map<AccredMetricId, AccredMetricValue>> {
  const p = await c.db.selectFrom('accred_periods').selectAll().where('id', '=', periodId).executeTakeFirstOrThrow();
  const mc: AccredMetricContext = {
    db: c.db,
    periodId,
    period: p,
    profile: readProfile(p.profile),
    instrument: instrumentById(p.instrument_id)!,
    D: '2026-06-30',
    today: TODAY,
    settings: c.settings,
    baseUrl: null,
    now: NOW,
    budgetLeftMs: () => 60_000,
    paramsOf: () => ({}),
  };
  const step = await collectionProvider.compute(mc, ids, null);
  if (!step.done) throw new Error('one slice was expected');
  return new Map(step.values);
}

async function rowsOf(c: CollectionDb, def: TableReport, periodId: string, o: { locale?: Locale; budget?: () => number } = {}): Promise<ReportRow[]> {
  const out = await drain(def, ctxFor(c, def, { periodId }, { today: TODAY, now: NOW, locale: o.locale, budget: o.budget }));
  expect(out.totals).toBeNull();
  return out.rows;
}

describe.skipIf(!ctx.available)(`collection annexes of accreditation [${engineLabel()}]`, () => {
  describe('on the stock fixture', () => {
    let c: CollectionDb;
    let periodId: string;

    beforeAll(async () => {
      c = await openCollectionDb('core-accred-annexes-collection');
      periodId = await addPeriod(c);
    });

    afterAll(async () => {
      await c?.close();
    });

    it('ddc: the printed titles and their copies by class with the divisions that hold any, the e-book left out', async () => {
      const main = (key: string) => label(`vocab.ddc_main.${key}`);
      const rows = await rowsOf(c, annexDdcReport, periodId);
      expect(rows).toEqual([
        ['000', main('000'), 1, 1],
        ['030', '030–039', 1, 1],
        ['100', main('100'), 0, 0],
        ['200', main('200'), 1, 1],
        ['290', '290–299', 1, 1],
        ['300', main('300'), 0, 0],
        ['400', main('400'), 0, 0],
        ['500', main('500'), 1, 0],
        ['500-509', '500–509', 1, 0],
        ['600', main('600'), 0, 0],
        ['700', main('700'), 0, 0],
        ['800', main('800'), 1, 1],
        ['890', '890–899', 1, 1],
        ['900', main('900'), 1, 1],
        ['900-909', '900–909', 1, 1],
        ['2X', main('2X'), 1, 1],
        ['NON', main('NON'), 2, 2],
        [null, label('report.row.total'), 8, 7],
      ]);
      const recap = await metrics(c, periodId, ['collection.ddc_printed_recap', 'collection.titles']);
      expect(recap.get('collection.ddc_printed_recap')?.value).toBe(8);
      expect(recap.get('collection.titles')?.value).toBe(9);
      expect(recap.get('collection.ddc_printed_recap')?.table).toEqual(rows.slice(0, -1).map((r) => [r[0], r[2], r[3]]));
    });

    it('collection_matrix: titles and copies by medium and kind, with the group labels', async () => {
      const g = (key: string) => label(`report.group.${key}`);
      expect(await rowsOf(c, annexCollectionMatrixReport, periodId)).toEqual([
        [g('medium.print'), g('fnr.fiction'), 0, 0],
        [g('medium.print'), g('fnr.nonfiction'), 7, 6],
        [g('medium.print'), g('fnr.reference'), 1, 1],
        [g('medium.electronic'), g('fnr.fiction'), 0, 0],
        [g('medium.electronic'), g('fnr.nonfiction'), 1, 0],
        [g('medium.electronic'), g('fnr.reference'), 0, 0],
        [label('report.row.total'), null, 9, 7],
      ]);
    });

    it('additions: the rows of the three-year additions metric, the total and its share', async () => {
      const rows = await rowsOf(c, annexAdditionsReport, periodId);
      expect(rows).toEqual([
        [label('report.row.accred_collection.start', 'id', { date: '2023-12-31' }), 8, null],
        [label('report.row.accred_collection.year', 'id', { year: 2024 }), 2, null],
        [label('report.row.accred_collection.year', 'id', { year: 2025 }), 2, null],
        [label('report.row.accred_collection.year', 'id', { year: 2026 }), 0, null],
        [label('report.row.accred_collection.total'), 4, 50],
      ]);
      const threeYears = (await metrics(c, periodId, ['collection.title_additions_3y_pct'])).get('collection.title_additions_3y_pct')!;
      expect(rows.slice(0, 4).map((r) => r[1])).toEqual((threeYears.table ?? []).map((r) => r[1]));
      expect(rows[4]).toEqual([expect.any(String), threeYears.numerator, threeYears.value]);
    });

    it('the labels follow the report language', async () => {
      const rows = await rowsOf(c, annexAdditionsReport, periodId, { locale: 'en' });
      expect(rows[0]![0]).toBe(label('report.row.accred_collection.start', 'en', { date: '2023-12-31' }));
      expect(rows[0]![0]).not.toBe(label('report.row.accred_collection.start', 'id', { date: '2023-12-31' }));
      const matrix = await rowsOf(c, annexCollectionMatrixReport, periodId, { locale: 'en' });
      expect(matrix[0]!.slice(0, 2)).toEqual([label('report.group.medium.print', 'en'), label('report.group.fnr.fiction', 'en')]);
    });

    it('an unknown period → params.periodId not_found', async () => {
      const missing = { code: 'VALIDATION_FAILED', errors: [{ path: 'params.periodId', code: 'not_found' }] };
      for (const def of [annexDdcReport, annexCollectionMatrixReport, annexAdditionsReport]) {
        expect(await failure(drain(def, ctxFor(c, def, { periodId: newId(NOW) }, { today: TODAY, now: NOW })))).toEqual(missing);
      }
    });
  });

  describe('a scan over several slices', () => {
    let c: CollectionDb;
    let periodId: string;

    beforeAll(async () => {
      c = await openCollectionDb('core-accred-annexes-scan', { fixture: false });
      await seedBulk(c.db, c.branchId, 1100, { prefix: 'IRIS' });
      periodId = await addPeriod(c);
    });

    afterAll(async () => {
      await c?.close();
    });

    it('each annex answers its cursor while the budget is out and the same rows as one long call', async () => {
      for (const def of [annexDdcReport, annexCollectionMatrixReport, annexAdditionsReport]) {
        const whole = await drain(def, ctxFor(c, def, { periodId }, { today: TODAY, now: NOW }));
        const sliced = await drain(def, ctxFor(c, def, { periodId }, { today: TODAY, now: NOW, budget: () => 0 }));
        expect(whole.pages, def.id).toBe(1);
        expect(sliced.pages, def.id).toBe(3);
        for (const cursor of sliced.cursors) expect(cursor.length).toBeLessThanOrEqual(32_000);
        expect(sliced.rows, def.id).toEqual(whole.rows);
      }
      const total = (await drain(annexDdcReport, ctxFor(c, annexDdcReport, { periodId }, { today: TODAY, now: NOW }))).rows.at(-1);
      expect(total?.slice(2)).toEqual([1100, 1100]);
    });
  });
});
