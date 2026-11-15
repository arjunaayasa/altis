import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations, type AccredPeriodsTable } from '@altis/db';
import { newId } from '@altis/shared';
import type { Selectable } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { instrumentById } from '../../src/accreditation/instruments/index.js';
import type { AccredMetricId } from '../../src/accreditation/metric-ids.js';
import { stocktakeProvider } from '../../src/accreditation/providers/stocktake.js';
import { evaluateSnp } from '../../src/accreditation/scoring/snp.js';
import type { AccredInstrument, AccredMetricContext, AccredMetricValue } from '../../src/accreditation/types.js';
import { loadAccredSettings, type AccredSettings } from '../../src/settings/accreditation.js';

// The `stocktake` metric provider on the engine picked by ALTIS_TEST_DB, over a school year 2025-07-01 … 2026-06-30
// evaluated after it ended (the snapshot date 2026-06-30, the three-year window from 2023-07-01): a stocktake session
// that finished inside the window counts as a stock-take beside the register's activities, on the day it finished in
// the library's time zone (Asia/Jakarta); a session still under way, cancelled, or finished after the snapshot date does
// not; the recount standard passes once the last stock-take and the last weeding both fall in the window.

const ctx = testDbContext();
const NOW = Date.UTC(2026, 7, 1, 3, 0, 0);
const D = '2026-06-30';
const SMA = instrumentById('sch-sma-2025') as AccredInstrument;
const RECOUNT: AccredMetricId = 'registers.stocktake_weeding_3y';

describe.skipIf(!ctx.available)(`stocktake metric provider [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;
  let settings: AccredSettings;
  let branchId: string;
  const trail = { version: 0, created_at: NOW, created_by: null, updated_at: NOW, updated_by: null };

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-core-accred-stocktake-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(root, 'migrations'), migrations: PHASE1_MIGRATIONS });
    settings = { ...(await loadAccredSettings(h.db)), timezone: 'Asia/Jakarta' };
    branchId = newId(NOW);
    await h.db
      .insertInto('branches')
      .values({ id: branchId, code_key: 'PUSAT', code_display: 'PUSAT', name: 'Pusat', address: null, timezone: 'Asia/Jakarta', created_at: NOW, created_by: null, updated_at: NOW, updated_by: null })
      .execute();
  });

  afterAll(async () => {
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    for (const table of ['library_activities', 'stocktakes', 'accred_periods'] as const) await h.db.deleteFrom(table).execute();
  });

  async function period(): Promise<Selectable<AccredPeriodsTable>> {
    const row = {
      id: newId(NOW),
      branch_id: null,
      name: 'Tahun ajaran 2025/2026',
      kind: 'school_year',
      starts_on: '2025-07-01',
      ends_on: '2026-06-30',
      instrument_id: 'sch-sma-2025',
      status: 'open',
      frozen_at: null,
      frozen_by: null,
      profile: '{}',
      students: 108,
      teachers: 10,
      edu_staff: 5,
      classes: 3,
      population_served: null,
      teachers_using: 4,
      all_registered_confirmed: 0,
      user_pcs: 4,
      staff_pcs: 1,
      ict_devices: 5,
      scanners: 2,
      floor_m2: 120,
      bandwidth_mbps: 30,
      hours_per_week: 35,
      services: null,
      external_website_url: null,
      archived_at: null,
      ...trail,
    } satisfies Selectable<AccredPeriodsTable>;
    await h.db.insertInto('accred_periods').values(row).execute();
    return row;
  }

  async function compute(p: Selectable<AccredPeriodsTable>): Promise<AccredMetricValue> {
    const c: AccredMetricContext = {
      db: h.db,
      periodId: p.id,
      period: p,
      profile: {},
      instrument: SMA,
      D,
      today: '2026-08-01',
      settings,
      baseUrl: null,
      now: NOW,
      budgetLeftMs: () => 20_000,
      paramsOf: () => ({}),
    };
    const step = await stocktakeProvider.compute(c, [RECOUNT], null);
    if (!step.done) throw new Error('the stocktake provider answers in one call');
    return step.values.get(RECOUNT)!;
  }

  async function activity(kind: string, heldOn: string): Promise<void> {
    await h.db
      .insertInto('library_activities')
      .values({
        id: newId(NOW),
        branch_id: null,
        kind,
        title: `Kegiatan ${kind}`,
        held_on: heldOn,
        ended_on: null,
        participants: 1,
        partner: null,
        uses_library_facility: 0,
        external_speaker: 0,
        description: null,
        archived_at: null,
        ...trail,
      })
      .execute();
  }

  async function session(status: string, finishedAt: number | null, source = 'altis'): Promise<void> {
    await h.db
      .insertInto('stocktakes')
      .values({
        id: newId(NOW),
        branch_id: branchId,
        name: 'Sesi',
        scope: '{}',
        status,
        active_key: null,
        options: null,
        started_at: (finishedAt ?? NOW) - 86_400_000,
        started_by: null,
        finished_at: finishedAt,
        finished_by: null,
        minutes_file_id: null,
        report_file_id: null,
        source,
        ...trail,
      })
      .execute();
  }

  const recount = (v: AccredMetricValue) => evaluateSnp(SMA.snp.find((s) => s.code === 'SNP-S-07')!, v, null, null, { D }).outcome;

  it('the register alone: the old stock-take outside the window fails the standard', async () => {
    const p = await period();
    await activity('stocktake', '2022-08-01');
    await activity('weeding', '2024-08-12');
    const v = await compute(p);
    expect(v).toMatchObject({ value: 1, basis: 'register', facts: { lastStocktake: '2022-08-01', lastWeeding: '2024-08-12' } });
    expect(v.detail?.reportId).toBe('accreditation.annex.activities');
    expect(recount(v)).toBe('fail');
  });

  it('a session finished in the window is the last stock-take; sessions under way, cancelled or finished after D do not count', async () => {
    const p = await period();
    await activity('stocktake', '2022-08-01');
    await activity('weeding', '2024-08-12');
    await session('finished', Date.UTC(2025, 2, 10, 4, 0, 0));
    // Migrated from SLiMS, finished before the window: no count, but no harm.
    await session('finished', Date.UTC(2021, 0, 5, 4, 0, 0), 'migrated');
    await session('active', null);
    await session('cancelled', Date.UTC(2026, 0, 5, 4, 0, 0));
    // 2026-07-01 01:00 in Jakarta: after the snapshot date.
    await session('finished', Date.UTC(2026, 5, 30, 18, 0, 0));
    const v = await compute(p);
    expect(v).toMatchObject({ value: 2, basis: 'live', facts: { lastStocktake: '2025-03-10', lastWeeding: '2024-08-12' } });
    expect(recount(v)).toBe('pass');
  });

  it('a migrated session counts as a stock-take as well', async () => {
    const p = await period();
    await activity('weeding', '2025-01-20');
    await session('finished', Date.UTC(2024, 4, 2, 2, 0, 0), 'migrated');
    const v = await compute(p);
    expect(v).toMatchObject({ value: 2, basis: 'live', facts: { lastStocktake: '2024-05-02', lastWeeding: '2025-01-20' } });
    expect(recount(v)).toBe('pass');
  });
});
