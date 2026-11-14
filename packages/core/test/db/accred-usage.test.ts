import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations, withTx } from '@altis/db';
import { endOfMonth, isDomainError, newId, type UsageMetric } from '@altis/shared';
import type { UsageGridView, UsagePutBody } from '@altis/shared/api/accreditation';
import type { KyselyPlugin } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { annexL14Report } from '../../src/accreditation/annexes/l14.js';
import { annexUsageMonthlyReport } from '../../src/accreditation/annexes/usage-monthly.js';
import { getPeriod, lastChangeOf, listPeriods } from '../../src/accreditation/periods/index.js';
import { getUsageGrid, getUsageGroups, putUsageCells, putUsageGroups, resolveUsage } from '../../src/accreditation/usage/index.js';
import { txCtx, type Actor, type TxCtx } from '../../src/context.js';
import type { ReportCtx, ReportRow, TableReport } from '../../src/reports/types.js';
import { loadAccredSettings } from '../../src/settings/accreditation.js';
import { writeSettings } from '../../src/settings/service.js';

// The monthly usage table below the routes, on the engine picked by ALTIS_TEST_DB: how a cell (a month, a metric and a
// group) is resolved from its sources (a manual cell first, then the SLiMS import, else no data), how the member types
// of the import count in the population groups through the mapping (read when the table is read, so a new mapping needs
// no new import), the manual cells a librarian writes (the period lock first, refused once the period is frozen), the
// mapping itself, the grid the workspace shows, and the two usage annexes.

const ctx = testDbContext();
/** In the past, and so is everything the cases write after it: an audit entry may not be dated ahead of the real clock. */
const NOW = Date.UTC(2026, 8, 1, 2, 0, 0);
const ACTOR: Actor = { type: 'staff', id: newId(NOW), ip: null };
const SPAN = { from: '2025-07-01', to: '2026-06-30' };

/** What a rejected promise rejected with: `{code, errors}` for VALIDATION_FAILED, `{code}` otherwise. */
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

describe.skipIf(!ctx.available)(`accreditation monthly usage [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-core-accred-usage-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(root, 'migrations'), migrations: PHASE1_MIGRATIONS });
  });

  afterAll(async () => {
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await h.db.deleteFrom('usage_stats').execute();
    await h.db.deleteFrom('usage_group_map').execute();
    await h.db.deleteFrom('catalog_runs').execute();
    // Every period of an earlier case leaves the stage: the last change of a period reads the periods overlapping it.
    await h.db.updateTable('accred_periods').set({ archived_at: NOW - 2000 }).where('archived_at', 'is', null).execute();
    await settings({ 'library.type': 'sekolah', 'accreditation.visits.dedupeLegacy': true, 'accreditation.unknownMemberGroup.default': 'auto' });
  });

  const run = <T>(fn: (tx: TxCtx) => Promise<T>, at = NOW): Promise<T> => withTx(h, (trx) => fn(txCtx(trx, at, ACTOR)));

  async function settings(patch: Record<string, unknown>): Promise<void> {
    await withTx(h, (trx) => writeSettings(trx, patch, { keyring: [], now: NOW, actorId: null }));
  }

  /** An open school-year period 2025/2026 of the test profile's school instrument, seeded straight into the table. */
  async function period(o: { startsOn?: string; endsOn?: string; status?: 'open' | 'frozen'; population?: [number, number, number] } = {}): Promise<string> {
    const id = newId(NOW);
    const [students, teachers, eduStaff] = o.population ?? [100, 20, 5];
    await h.db
      .insertInto('accred_periods')
      .values({
        id,
        branch_id: null,
        name: 'Tahun pelajaran 2025/2026',
        kind: 'school_year',
        starts_on: o.startsOn ?? SPAN.from,
        ends_on: o.endsOn ?? SPAN.to,
        instrument_id: 'test-sch',
        status: o.status ?? 'open',
        frozen_at: o.status === 'frozen' ? NOW : null,
        frozen_by: null,
        profile: '{"schoolLevel":"sma_smk_ma"}',
        students,
        teachers,
        edu_staff: eduStaff,
        all_registered_confirmed: 0,
        archived_at: null,
        version: 0,
        created_at: NOW - 1000,
        created_by: null,
        updated_at: NOW - 1000,
        updated_by: null,
      })
      .execute();
    return id;
  }

  /** A row of the SLiMS import: a month (`2025-08`) or a span of its own. */
  async function slims(metric: UsageMetric, span: string | { from: string; to: string }, key: string, value: number): Promise<void> {
    const from = typeof span === 'string' ? `${span}-01` : span.from;
    const to = typeof span === 'string' ? endOfMonth(span) : span.to;
    await h.db
      .insertInto('usage_stats')
      .values({ source: 'slims', metric, span_from: from, span_to: to, branch_key: '', group_key: key, value, run_id: null, updated_at: NOW - 500, updated_by: null })
      .execute();
  }

  async function map(key: string, group: string | null, label = 'Tipe'): Promise<void> {
    await h.db.insertInto('usage_group_map').values({ group_key: key, label, accred_group: group, updated_at: NOW - 500, updated_by: null }).execute();
  }

  const put = (periodId: string, cells: UsagePutBody['cells'], at = NOW) => run((tx) => putUsageCells(tx, periodId, { cells }, at), at);

  const resolved = async (span = SPAN) => resolveUsage(h.db, span, await loadAccredSettings(h.db));

  const manualRows = () =>
    h.db
      .selectFrom('usage_stats')
      .select(['metric', 'span_from', 'span_to', 'branch_key', 'group_key', 'value', 'run_id', 'updated_at', 'updated_by'])
      .where('source', '=', 'manual')
      .orderBy('metric')
      .orderBy('span_from')
      .orderBy('group_key')
      .execute()
      .then((rows) => rows.map((r) => ({ ...r, value: Number(r.value), updated_at: Number(r.updated_at) })));

  describe('a cell: manual first, then the SLiMS import, else no data', () => {
    it('a month with manual and SLiMS visits reads the manual cell; a month with only SLiMS reads SLiMS; a month with neither reads none', async () => {
      const id = await period();
      await slims('visits_deduped', '2025-08', '', 40);
      await slims('visits', '2025-08', '', 44);
      await slims('visits_deduped', '2025-09', '', 30);
      await put(id, [{ metric: 'visits', month: '2025-08', groupKey: '', value: 50 }]);
      const t = await resolved();
      expect(t.months).toEqual(['2025-07', '2025-08', '2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06']);
      expect(t.cell('visits', '2025-08', 'total')).toEqual({ value: 50, source: 'manual', spanTo: null });
      expect(t.cell('visits', '2025-09', 'total')).toEqual({ value: 30, source: 'slims', spanTo: null });
      expect(t.cell('visits', '2025-10', 'total')).toEqual({ value: null, source: 'none', spanTo: null });
    });

    it('the visits counted: a SLiMS month counts its visits without repeats while that setting is on, its raw visits otherwise; a manual cell its visits', async () => {
      await slims('visits_deduped', '2025-08', '', 60);
      await slims('visits', '2025-08', '', 70);
      await slims('visits_deduped', '2025-09', '', 20);
      await slims('visits', '2025-09', '', 25);
      const id = await period();
      await put(id, [{ metric: 'visits', month: '2025-09', groupKey: '', value: 65 }]);
      let t = await resolved();
      expect([t.cell('visits', '2025-08', 'total').value, t.cell('visits', '2025-09', 'total').value]).toEqual([60, 65]);
      // The raw metric itself still reads its own rows.
      expect(t.cell('visits_deduped', '2025-08', 'total')).toEqual({ value: 60, source: 'slims', spanTo: null });
      await settings({ 'accreditation.visits.dedupeLegacy': false });
      t = await resolved();
      expect([t.cell('visits', '2025-08', 'total').value, t.cell('visits', '2025-09', 'total').value]).toEqual([70, 65]);
    });

    it('a cut-over month: the SLiMS row ending the day before the cut-over is the month cell, with the end of its span', async () => {
      await slims('visits_deduped', { from: '2026-01-01', to: '2026-01-14' }, '', 12);
      await slims('loans', { from: '2026-01-01', to: '2026-01-14' }, '', 7);
      await slims('loans', '2025-12', '', 30);
      const t = await resolved();
      expect(t.cell('visits', '2026-01', 'total')).toEqual({ value: 12, source: 'slims', spanTo: '2026-01-14' });
      expect(t.cell('loans', '2026-01', 'total')).toEqual({ value: 7, source: 'slims', spanTo: '2026-01-14' });
      expect(t.cell('loans', '2025-12', 'total')).toEqual({ value: 30, source: 'slims', spanTo: null });
    });

    it('the groups: a member type through the mapping, deleted members through their row or the default, guests apart, the total only from the total', async () => {
      await map('slims_type:1', 'student', 'Siswa');
      await map('slims_type:2', 'teacher', 'Guru');
      await map('slims_type:4', null, 'Alumni');
      for (const [key, value] of [
        ['slims_type:1', 30],
        ['slims_type:2', 8],
        ['slims_type:3', 2],
        ['slims_type:4', 5],
        ['member_unknown', 4],
        ['guest', 6],
        ['ddc:3', 99],
      ] as const) {
        await slims('loans', '2025-08', key, value);
      }
      let t = await resolved();
      // No `member_unknown` row on a school library: the deleted members count as students.
      expect(t.cell('loans', '2025-08', 'student')).toEqual({ value: 34, source: 'slims', spanTo: null });
      expect(t.cell('loans', '2025-08', 'teacher').value).toBe(8);
      expect(t.cell('loans', '2025-08', 'edu_staff')).toEqual({ value: null, source: 'none', spanTo: null });
      expect(t.cell('loans', '2025-08', 'guest').value).toBe(6);
      // A type without a mapping row and a type mapped to nothing are not counted in any group.
      expect(t.cell('loans', '2025-08', 'unmapped').value).toBe(7);
      // Without a total row, the total is the sum of every group (the class rows are no group).
      expect(t.cell('loans', '2025-08', 'total')).toEqual({ value: 55, source: 'slims', spanTo: null });
      expect(t.memberUnknown('loans')).toBe(4);

      await slims('loans', '2025-08', '', 60);
      await map('member_unknown', null, '');
      t = await resolved();
      expect(t.cell('loans', '2025-08', 'total').value).toBe(60);
      expect(t.cell('loans', '2025-08', 'student').value).toBe(30);
      expect(t.cell('loans', '2025-08', 'unmapped').value).toBe(11);
      expect(t.memberUnknown('loans')).toBe(0);
    });

    it('a library that is not a school counts deleted members nowhere unless their row says otherwise', async () => {
      await settings({ 'library.type': 'umum' });
      await slims('visits_deduped', '2025-08', 'member_unknown', 9);
      let t = await resolved();
      expect(t.cell('visits', '2025-08', 'student').value).toBeNull();
      expect(t.cell('visits', '2025-08', 'unmapped').value).toBe(9);
      await map('member_unknown', 'public', '');
      t = await resolved();
      expect(t.cell('visits', '2025-08', 'public').value).toBe(9);
      expect(t.memberUnknown('visits')).toBe(9);
    });

    it('a manual group cell wins over the SLiMS rows mapped to that group; other groups keep their source', async () => {
      await map('slims_type:1', 'student');
      await map('slims_type:2', 'teacher');
      await slims('visits_deduped', '2025-08', 'slims_type:1', 40);
      await slims('visits_deduped', '2025-08', 'slims_type:2', 10);
      const id = await period();
      await put(id, [{ metric: 'visits', month: '2025-08', groupKey: 'grp:student', value: 45 }]);
      const t = await resolved();
      expect(t.cell('visits', '2025-08', 'student')).toEqual({ value: 45, source: 'manual', spanTo: null });
      expect(t.cell('visits', '2025-08', 'teacher')).toEqual({ value: 10, source: 'slims', spanTo: null });
      expect(t.cell('visits', '2025-08', 'total')).toEqual({ value: 55, source: 'manual', spanTo: null });
    });

    it('months with data: any cell of the visits counted, a zero included; other months and other metrics do not count', async () => {
      await slims('visits_deduped', '2025-07', '', 0);
      await slims('visits_deduped', '2025-08', 'guest', 3);
      await slims('visits', '2025-09', '', 5);
      await slims('loans', '2025-10', '', 5);
      await slims('visits_deduped', '2026-07', '', 5);
      const id = await period();
      await put(id, [{ metric: 'visits', month: '2025-11', groupKey: 'grp:teacher', value: 0 }]);
      const t = await resolved();
      expect(t.monthsWithData('visits')).toBe(3);
      expect(t.monthsWithData('loans')).toBe(1);
      expect(t.monthsWithData('visits_deduped')).toBe(2);
    });

    it('a span metric reads only the rows of exactly that span, a manual one before the import', async () => {
      await map('slims_type:1', 'student');
      await map('slims_type:2', 'teacher');
      await slims('members_active', SPAN, 'slims_type:1', 110);
      await slims('members_active', SPAN, 'slims_type:2', 18);
      await slims('members_active', { from: '2024-07-01', to: '2025-06-30' }, 'slims_type:1', 90);
      await slims('distinct_visitors', SPAN, '', 100);
      await slims('distinct_visitors', '2025-08', '', 40);
      const t = await resolved();
      expect(t.spanValue('members_active', SPAN)).toEqual({ value: 128, source: 'slims', spanTo: '2026-06-30' });
      expect(t.spanValue('members_active', SPAN, 'student').value).toBe(110);
      expect(t.spanValue('distinct_visitors', SPAN)).toEqual({ value: 100, source: 'slims', spanTo: '2026-06-30' });
      expect(t.spanValue('titles_used', SPAN)).toEqual({ value: null, source: 'none', spanTo: null });
      const id = await period();
      await put(id, [{ metric: 'distinct_visitors', month: null, groupKey: '', value: 120 }]);
      expect((await resolved()).spanValue('distinct_visitors', SPAN)).toEqual({ value: 120, source: 'manual', spanTo: '2026-06-30' });
    });
  });

  describe('putUsageCells', () => {
    it('writes manual cells over a month or the whole period, removes one with a null value, touches the period and audits the count', async () => {
      const id = await period();
      await put(id, [
        { metric: 'visits', month: '2025-08', groupKey: 'grp:student', value: 45 },
        { metric: 'loans', month: '2026-02', groupKey: '', value: 12 },
        { metric: 'titles_used', month: null, groupKey: '', value: 300 },
      ]);
      expect(await manualRows()).toEqual([
        { metric: 'loans', span_from: '2026-02-01', span_to: '2026-02-28', branch_key: '', group_key: '', value: 12, run_id: null, updated_at: NOW, updated_by: ACTOR.id },
        { metric: 'titles_used', span_from: '2025-07-01', span_to: '2026-06-30', branch_key: '', group_key: '', value: 300, run_id: null, updated_at: NOW, updated_by: ACTOR.id },
        { metric: 'visits', span_from: '2025-08-01', span_to: '2025-08-31', branch_key: '', group_key: 'grp:student', value: 45, run_id: null, updated_at: NOW, updated_by: ACTOR.id },
      ]);
      const touched = await h.db.selectFrom('accred_periods').select(['updated_at', 'version']).where('id', '=', id).executeTakeFirstOrThrow();
      expect([Number(touched.updated_at), Number(touched.version)]).toEqual([NOW, 0]);

      await put(id, [
        { metric: 'loans', month: '2026-02', groupKey: '', value: null },
        { metric: 'visits', month: '2025-08', groupKey: 'grp:student', value: 50 },
      ], NOW + 10);
      expect((await manualRows()).map((r) => [r.metric, r.group_key, r.value, r.updated_at])).toEqual([
        ['titles_used', '', 300, NOW],
        ['visits', 'grp:student', 50, NOW + 10],
      ]);
      const entries = await h.db.selectFrom('audit_log').select(['action', 'entity', 'entity_id', 'meta']).where('entity_id', '=', id).orderBy('seq').execute();
      expect(entries.map((e) => [e.action, e.entity, JSON.parse(e.meta) as unknown])).toEqual([
        ['accreditation.usage.update', 'accred_periods', { cells: 3 }],
        ['accreditation.usage.update', 'accred_periods', { cells: 2 }],
      ]);
    });

    it('refuses a month outside the period, a monthly metric without a month, a span-only metric with a month and the same cell twice; nothing is written', async () => {
      const id = await period();
      expect(
        await failure(
          put(id, [
            { metric: 'visits', month: '2025-06', groupKey: '', value: 1 },
            { metric: 'visits', month: '2025-07', groupKey: '', value: 1 },
            { metric: 'loans', month: null, groupKey: '', value: 1 },
            { metric: 'members_active', month: '2025-08', groupKey: '', value: 1 },
            { metric: 'visits', month: '2026-07', groupKey: 'guest', value: 1 },
            { metric: 'visits', month: '2025-07', groupKey: '', value: 2 },
          ]),
        ),
      ).toEqual({
        code: 'VALIDATION_FAILED',
        errors: [
          { path: 'cells.0.month', code: 'out_of_period' },
          { path: 'cells.2.month', code: 'required' },
          { path: 'cells.3.month', code: 'invalid' },
          { path: 'cells.4.month', code: 'out_of_period' },
          { path: 'cells.5', code: 'duplicate' },
        ],
      });
      expect(await manualRows()).toEqual([]);
    });

    it('a frozen period → ACCRED_PERIOD_FROZEN; an unknown or archived period → NOT_FOUND', async () => {
      const frozen = await period({ status: 'frozen' });
      expect(await failure(put(frozen, [{ metric: 'visits', month: '2025-08', groupKey: '', value: 1 }]))).toEqual({ code: 'ACCRED_PERIOD_FROZEN' });
      expect(await failure(put(newId(NOW), [{ metric: 'visits', month: '2025-08', groupKey: '', value: 1 }]))).toEqual({ code: 'NOT_FOUND' });
      const archived = await period();
      await h.db.updateTable('accred_periods').set({ archived_at: NOW }).where('id', '=', archived).execute();
      expect(await failure(put(archived, [{ metric: 'visits', month: '2025-08', groupKey: '', value: 1 }]))).toEqual({ code: 'NOT_FOUND' });
      expect(await manualRows()).toEqual([]);
    });

    it('takes the period lock as its first statement', async () => {
      const id = await period();
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
      await withTx({ ...h, db: h.db.withPlugin(capture) }, (trx) =>
        putUsageCells(txCtx(trx, NOW, ACTOR), id, { cells: [{ metric: 'visits', month: '2025-08', groupKey: '', value: 3 }] }, NOW),
      );
      const list = statements.filter((sql) => !/^\s*(begin|start|set|savepoint|release|commit|rollback)\b/i.test(sql));
      expect(list.length).toBeGreaterThan(1);
      expect(list[0]).toMatch(/^update ["`]accred_periods["`] set ["`]version["`] = ["`]version["`] where/);
    });

    it('a cell removed through the previous school year makes the next one stale: its reading interest reads that year', async () => {
      const next = await period();
      const previous = await period({ startsOn: '2024-07-01', endsOn: '2025-06-30' });
      await put(previous, [{ metric: 'visits', month: '2024-09', groupKey: '', value: 30 }], NOW - 100);
      // The next year was computed after that cell was written.
      const meta = { status: 'ready', startedAt: NOW - 50, jobId: newId(NOW), computedAt: NOW - 50, durationMs: 1 };
      await h.db.insertInto('accred_results').values({ period_id: next, indicator_code: '_meta', payload: JSON.stringify(meta), computed_at: NOW - 50 }).execute();
      expect((await getPeriod(h.db, next, NOW)).stale).toBe(false);

      await put(previous, [{ metric: 'visits', month: '2024-09', groupKey: '', value: null }], NOW);
      expect(await manualRows()).toEqual([]);
      expect(await lastChangeOf(h.db, next)).toBe(NOW);
      expect((await getPeriod(h.db, next, NOW)).stale).toBe(true);
      expect((await listPeriods(h.db)).periods.find((p) => p.id === next)).toMatchObject({ stale: true });
    });

    it('a cell removed through a period with free dates that shares a month with another makes that one stale: both read the whole month', async () => {
      // P reads 2026-03 whole (its last month), and Q starts inside that month.
      const p = await period({ startsOn: '2025-03-10', endsOn: '2026-03-09' });
      const q = await period({ startsOn: '2026-03-10', endsOn: '2027-03-09' });
      await put(q, [{ metric: 'visits', month: '2026-03', groupKey: '', value: 30 }], NOW - 100);
      const meta = { status: 'ready', startedAt: NOW - 50, jobId: newId(NOW), computedAt: NOW - 50, durationMs: 1 };
      await h.db.insertInto('accred_results').values({ period_id: p, indicator_code: '_meta', payload: JSON.stringify(meta), computed_at: NOW - 50 }).execute();
      expect((await getPeriod(h.db, p, NOW)).stale).toBe(false);
      expect((await resolved({ from: '2025-03-10', to: '2026-03-09' })).cell('visits', '2026-03', 'total').value).toBe(30);

      await put(q, [{ metric: 'visits', month: '2026-03', groupKey: '', value: null }], NOW);
      expect(await manualRows()).toEqual([]);
      expect(await lastChangeOf(h.db, p)).toBe(NOW);
      expect((await getPeriod(h.db, p, NOW)).stale).toBe(true);
      expect((await listPeriods(h.db)).periods.find((x) => x.id === p)).toMatchObject({ stale: true });
    });

    it('a cell removed through a period that ends inside the first month of the twelve months read before another makes that one stale', async () => {
      // The reading interest of P compares it with the twelve months from 2024-03-10, read from 2024-03-01.
      const p = await period({ startsOn: '2025-03-10', endsOn: '2026-03-09' });
      const before = await period({ startsOn: '2023-03-05', endsOn: '2024-03-04' });
      await put(before, [{ metric: 'visits', month: '2024-03', groupKey: '', value: 12 }], NOW - 100);
      const meta = { status: 'ready', startedAt: NOW - 50, jobId: newId(NOW), computedAt: NOW - 50, durationMs: 1 };
      await h.db.insertInto('accred_results').values({ period_id: p, indicator_code: '_meta', payload: JSON.stringify(meta), computed_at: NOW - 50 }).execute();
      expect((await getPeriod(h.db, p, NOW)).stale).toBe(false);

      await put(before, [{ metric: 'visits', month: '2024-03', groupKey: '', value: null }], NOW);
      expect(await lastChangeOf(h.db, p)).toBe(NOW);
      expect((await getPeriod(h.db, p, NOW)).stale).toBe(true);
      expect((await listPeriods(h.db)).periods.find((x) => x.id === p)).toMatchObject({ stale: true });
    });

    it('removing the only cell still moves the last change of the period forward', async () => {
      const id = await period();
      await put(id, [{ metric: 'visits', month: '2025-08', groupKey: '', value: 3 }], NOW - 100);
      const before = await lastChangeOf(h.db, id);
      expect(before).not.toBeNull();
      await put(id, [{ metric: 'visits', month: '2025-08', groupKey: '', value: null }], NOW);
      expect(await manualRows()).toEqual([]);
      const after = await lastChangeOf(h.db, id);
      expect(after!).toBeGreaterThan(before!);
    });
  });

  describe('the member-type mapping', () => {
    it('changes the group of known types, creates the deleted-members row, refuses an unknown type; a frozen period does not stop it', async () => {
      await period({ status: 'frozen' });
      await map('slims_type:2', 'teacher', 'Guru');
      await map('slims_type:10', 'public', 'Umum');
      await run((tx) =>
        putUsageGroups(tx, { groups: [{ groupKey: 'slims_type:2', accredGroup: 'public' }, { groupKey: 'member_unknown', accredGroup: 'student' }] }, NOW),
      );
      expect(await getUsageGroups(h.db)).toEqual({
        groups: [
          { groupKey: 'slims_type:2', label: 'Guru', accredGroup: 'public', updatedAt: NOW },
          { groupKey: 'slims_type:10', label: 'Umum', accredGroup: 'public', updatedAt: NOW - 500 },
          { groupKey: 'member_unknown', label: null, accredGroup: 'student', updatedAt: NOW },
        ],
      });
      const entry = await h.db
        .selectFrom('audit_log')
        .select(['entity', 'entity_id', 'meta'])
        .where('action', '=', 'accreditation.usage_groups.update')
        .orderBy('seq', 'desc')
        .executeTakeFirstOrThrow();
      expect([entry.entity, entry.entity_id, JSON.parse(entry.meta) as unknown]).toEqual(['usage_group_map', null, { count: 2 }]);

      expect(
        await failure(
          run((tx) =>
            putUsageGroups(tx, { groups: [{ groupKey: 'member_unknown', accredGroup: null }, { groupKey: 'slims_type:3', accredGroup: 'student' }] }, NOW + 5),
          ),
        ),
      ).toEqual({ code: 'VALIDATION_FAILED', errors: [{ path: 'groups.1.groupKey', code: 'not_found' }] });
      expect((await getUsageGroups(h.db)).groups.find((g) => g.groupKey === 'member_unknown')).toMatchObject({ accredGroup: 'student', updatedAt: NOW });
    });
  });

  describe('the grid', () => {
    it('the months, metrics and groups of a period, every cell with its source, the span cells and the last import', async () => {
      const id = await period();
      await map('slims_type:1', 'student');
      await slims('visits', '2025-08', 'slims_type:1', 40);
      await slims('visits', '2025-08', 'slims_type:9', 3);
      await slims('visits', { from: '2026-01-01', to: '2026-01-14' }, 'guest', 2);
      await slims('members_active', SPAN, 'slims_type:1', 110);
      await put(id, [{ metric: 'loans', month: '2025-09', groupKey: '', value: 12 }]);
      const runId = newId(NOW - 300);
      await h.db
        .insertInto('catalog_runs')
        .values({
          id: runId,
          kind: 'slims_usage',
          status: 'succeeded',
          dry_run: 0,
          format: null,
          options: JSON.stringify({ sourceKind: 'dump', periodId: id, cutoverOn: '2026-01-15', dedupeMinutes: 60 }),
          summary: '{}',
          report_file_id: null,
          output_name: null,
          output_size: null,
          expires_at: null,
          job_id: null,
          created_at: NOW - 400,
          created_by: null,
          finished_at: NOW - 300,
        })
        .execute();

      const grid: UsageGridView = await getUsageGrid(h.db, id, await loadAccredSettings(h.db));
      expect(grid.months).toHaveLength(12);
      expect(grid.metrics).toEqual([
        'visits',
        'visits_deduped',
        'visits_online',
        'loans',
        'in_library_uses',
        'distinct_visitors',
        'distinct_borrowers',
        'titles_used',
        'items_used',
        'members_active',
      ]);
      expect(grid.groups).toEqual([
        { key: '', label: null, accredGroup: null },
        { key: 'grp:student', label: null, accredGroup: 'student' },
        { key: 'grp:teacher', label: null, accredGroup: 'teacher' },
        { key: 'grp:edu_staff', label: null, accredGroup: 'edu_staff' },
        { key: 'grp:public', label: null, accredGroup: 'public' },
        { key: 'grp:other', label: null, accredGroup: 'other' },
        { key: 'guest', label: null, accredGroup: 'guest' },
        { key: 'unmapped', label: null, accredGroup: null },
      ]);
      const cell = (metric: string, month: string | null, groupKey: string) => grid.cells.find((c) => c.metric === metric && c.month === month && c.groupKey === groupKey);
      expect(cell('visits', '2025-08', 'grp:student')).toEqual({ metric: 'visits', month: '2025-08', groupKey: 'grp:student', value: 40, source: 'slims', spanTo: null });
      expect(cell('visits', '2025-08', 'unmapped')).toMatchObject({ value: 3, source: 'slims' });
      expect(cell('visits', '2025-08', '')).toMatchObject({ value: 43, source: 'slims' });
      expect(cell('visits', '2026-01', 'guest')).toMatchObject({ value: 2, source: 'slims', spanTo: '2026-01-14' });
      expect(cell('loans', '2025-09', '')).toMatchObject({ value: 12, source: 'manual' });
      expect(cell('loans', '2025-10', '')).toMatchObject({ value: null, source: 'none', spanTo: null });
      expect(cell('members_active', null, '')).toEqual({ metric: 'members_active', month: null, groupKey: '', value: 110, source: 'slims', spanTo: '2026-06-30' });
      expect(cell('members_active', null, 'grp:student')).toMatchObject({ value: 110 });
      // A metric of the whole period has no month cells; a monthly metric no span cell.
      expect(cell('members_active', '2025-08', '')).toBeUndefined();
      expect(cell('loans', null, '')).toBeUndefined();
      expect(grid.lastImport).toEqual({ runId, finishedAt: NOW - 300, cutoverOn: '2026-01-15' });
    });

    it('a period with free dates reads its first and last months, which start and end inside them', async () => {
      const id = await period({ startsOn: '2025-03-10', endsOn: '2026-03-09' });
      await h.db.updateTable('accred_periods').set({ kind: 'custom', instrument_id: 'general-stats' }).where('id', '=', id).execute();
      await put(id, [
        { metric: 'visits', month: '2025-03', groupKey: '', value: 77 },
        { metric: 'visits', month: '2025-04', groupKey: '', value: 55 },
        { metric: 'visits', month: '2026-03', groupKey: '', value: 12 },
      ]);
      await slims('loans', '2025-03', '', 9);
      const grid = await getUsageGrid(h.db, id, await loadAccredSettings(h.db));
      const total = (metric: string, month: string) => grid.cells.find((c) => c.metric === metric && c.month === month && c.groupKey === '');
      expect(grid.months[0]).toBe('2025-03');
      expect(grid.months[grid.months.length - 1]).toBe('2026-03');
      expect(total('visits', '2025-03')).toMatchObject({ value: 77, source: 'manual' });
      expect(total('visits', '2025-04')).toMatchObject({ value: 55, source: 'manual' });
      expect(total('visits', '2026-03')).toMatchObject({ value: 12, source: 'manual' });
      expect(total('loans', '2025-03')).toMatchObject({ value: 9, source: 'slims' });
      // The resolved table the metrics and the annexes read, too.
      const usage = await resolved({ from: '2025-03-10', to: '2026-03-09' });
      expect([usage.cell('visits', '2025-03', 'total').value, usage.cell('visits', '2026-03', 'total').value]).toEqual([77, 12]);
    });

    it('an unknown period → NOT_FOUND; without rows the grid has no unmapped group and no import', async () => {
      expect(await failure(getUsageGrid(h.db, newId(NOW), await loadAccredSettings(h.db)))).toEqual({ code: 'NOT_FOUND' });
      const grid = await getUsageGrid(h.db, await period(), await loadAccredSettings(h.db));
      expect(grid.groups.map((g) => g.key)).not.toContain('unmapped');
      expect(grid.cells.every((c) => c.source === 'none' && c.value === null)).toBe(true);
      expect(grid.lastImport).toBeNull();
    });
  });

  describe('the usage annexes', () => {
    const reportCtx = async (periodId: string): Promise<ReportCtx> => ({
      db: h.db,
      locale: 'id',
      tz: 'Asia/Jakarta',
      now: NOW,
      today: '2026-09-01',
      settings: await loadAccredSettings(h.db),
      params: { periodId },
      budgetLeftMs: () => 10_000,
    });

    async function drain(report: TableReport, periodId: string): Promise<{ rows: ReportRow[]; totals: ReportRow | null; count: number | null }> {
      const rc = await reportCtx(periodId);
      const count = report.count === undefined ? null : await report.count(rc);
      const rows: ReportRow[] = [];
      let cursor: string | null = null;
      do {
        const page = await report.rows(rc, cursor, 5);
        rows.push(...page.rows);
        cursor = page.nextCursor;
      } while (cursor !== null);
      return { rows, totals: report.totals === undefined ? null : await report.totals(rc), count };
    }

    async function seedUsage(): Promise<string> {
      await map('slims_type:1', 'student');
      await map('slims_type:2', 'teacher');
      await map('slims_type:3', 'public');
      await slims('visits_deduped', '2025-08', 'slims_type:1', 40);
      await slims('visits_deduped', '2025-08', 'slims_type:2', 10);
      await slims('visits_deduped', '2025-08', 'slims_type:3', 4);
      await slims('visits_deduped', '2025-08', 'guest', 6);
      await slims('loans', '2025-08', '', 21);
      await slims('visits_deduped', { from: '2026-01-01', to: '2026-01-14' }, 'slims_type:1', 12);
      const id = await period({ population: [100, 20, 5] });
      await put(id, [
        { metric: 'visits', month: '2025-09', groupKey: 'grp:edu_staff', value: 3 },
        { metric: 'in_library_uses', month: '2025-09', groupKey: '', value: 9 },
      ]);
      return id;
    }

    it('l14: a row per month with the three groups, their sum, the population, the monthly share and the source; the totals row prints the divisor', async () => {
      const id = await seedUsage();
      const { rows, totals, count } = await drain(annexL14Report, id);
      expect([rows.length, count]).toEqual([12, 12]);
      expect(rows[0]).toEqual(['2025-07', null, null, null, null, 125, null, 'Tidak ada data']);
      expect(rows[1]).toEqual(['2025-08', 40, 10, null, 50, 125, 40, 'Impor SLiMS']);
      expect(rows[2]).toEqual(['2025-09', null, null, 3, 3, 125, 2, 'Isian manual']);
      expect(rows[6]).toEqual(['2026-01', 12, null, null, 12, 125, 9, 'Impor SLiMS s.d. 2026-01-14']);
      // Three months with data: the divisor is 10 × 3 ÷ 12 rounded up = 3; 65 × 100 ÷ (3 × 125) = 17.3 → 17.
      expect(totals).toEqual(['Jumlah; pembagi 3 bulan sekolah (10 × 3 ÷ 12, dibulatkan ke atas)', 52, 10, 3, 65, 125, 17, 'Isian manual, Impor SLiMS']);
    });

    it('usage_monthly: a row per month with the visits of every group, the loans, the uses in the library and the source; the totals row prints the divisor', async () => {
      const id = await seedUsage();
      const { rows, totals } = await drain(annexUsageMonthlyReport, id);
      expect(rows).toHaveLength(12);
      expect(rows[1]).toEqual(['2025-08', 40, 10, null, 4, null, 6, 21, null, 'Impor SLiMS']);
      expect(rows[2]).toEqual(['2025-09', null, null, 3, null, null, null, null, 9, 'Isian manual']);
      expect(rows[3]).toEqual(['2025-10', null, null, null, null, null, null, null, null, 'Tidak ada data']);
      expect(totals).toEqual(['Jumlah; pembagi 3 bulan sekolah (10 × 3 ÷ 12, dibulatkan ke atas)', 52, 10, 3, 4, null, 6, 21, 9, 'Isian manual, Impor SLiMS']);
    });

    it('outside a school the divisor is the months with data; without data the totals row says so', async () => {
      await settings({ 'library.type': 'umum' });
      await slims('visits_deduped', '2025-08', '', 40);
      await slims('visits_deduped', '2025-09', 'guest', 21);
      const id = await period();
      await h.db.updateTable('accred_periods').set({ instrument_id: 'general-stats' }).where('id', '=', id).execute();
      const { rows, totals } = await drain(annexUsageMonthlyReport, id);
      expect(rows[2]).toEqual(['2025-09', null, null, null, null, null, 21, null, null, 'Impor SLiMS']);
      expect(totals).toEqual(['Jumlah; pembagi 2 bulan berdata', null, null, null, null, null, 21, null, null, 'Impor SLiMS']);

      await h.db.deleteFrom('usage_stats').execute();
      expect((await drain(annexUsageMonthlyReport, id)).totals![0]).toBe('Jumlah; belum ada data penggunaan');
      expect((await drain(annexL14Report, id)).totals).toEqual(['Jumlah; belum ada data penggunaan', null, null, null, null, 125, null, 'Tidak ada data']);
    });

    it('an unknown period → params.periodId not_found, from its rows and from its count', async () => {
      const missing = { code: 'VALIDATION_FAILED', errors: [{ path: 'params.periodId', code: 'not_found' }] };
      expect(await failure(drain(annexL14Report, newId(NOW)))).toEqual(missing);
      expect(await failure(reportCtx(newId(NOW)).then((rc) => annexUsageMonthlyReport.count!(rc)))).toEqual(missing);
    });
  });
});
