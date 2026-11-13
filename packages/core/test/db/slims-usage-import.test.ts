import fsp from 'node:fs/promises';
import path from 'node:path';
import { withTx, type ForeignMysql } from '@altis/db';
import { runWorkDir, runWorkPath } from '@altis/platform';
import { newId } from '@altis/shared';
import type { SlimsUsageStartBody } from '@altis/shared/api/accreditation';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import { __setSlimsUsageConnect } from '../../src/accreditation/slims-usage/source.js';
import { SLIMS_USAGE_UNIQUE_KEY } from '../../src/accreditation/slims-usage/start.js';
import { testSlimsUsageConnection } from '../../src/accreditation/slims-usage/test-connection.js';
import { USAGE_SOURCE_NOTE } from '../../src/accreditation/slims-usage/report.js';
import { expiredExportsStep } from '../../src/catalog/runs/housekeeping.js';
import { getRunView, listRuns } from '../../src/catalog/runs/queries.js';
import { localStorageDriver } from '../../src/files/serve.js';
import { requestCancel } from '../../src/jobs/service.js';
import { writeSettings } from '../../src/settings/service.js';
import { fakeForeignMysql, fixtureMysqlTables, type FakeForeignMysql } from '../fixtures/slims-fake.js';
import { generateSlimsFixture, type FixtureData } from '../support/slims-fixture/generate.js';
import { generateUsage, type UsageExpectation, type UsageFixtureOptions } from '../support/slims-fixture/generate-usage.js';
import { SLIMS_FIXTURE_SEED } from '../support/slims-fixture/index.js';
import { NOW, expectRowsMatch, keyring, usageHarness, workFolderExists, type StatRow, type UsageHarness } from './slims-usage-support.js';

// The read-only SLiMS usage import (spec §11.2, §10.7) on the engine picked by ALTIS_TEST_DB, against the synthetic
// SLiMS fixture with its usage rows and their hand count: monthly loans and visits (raw and without repeats), distinct
// borrowers and visitors, per span titles and copies used, members active per type, by SLiMS type, deleted members and
// guests; the same through a database connection; the cut-over; a re-import that replaces only the imported rows; a
// cancel or a failure that leaves the usage tables as they were; the member type groups; the run's visibility and its
// end by the catalogue housekeeping; the connection test.

const ctx = testDbContext();
const PERIOD = { startsOn: '2025-07-01', endsOn: '2026-06-30' };

/** The fixture with its usage rows for `o`: the dump, the data (for the fake server) and the hand count. */
function fixture(o: UsageFixtureOptions = {}): { dump: Buffer; data: FixtureData; expected: UsageExpectation } {
  const hooked: { data?: FixtureData; expected?: UsageExpectation } = {};
  const out = generateSlimsFixture(SLIMS_FIXTURE_SEED, {
    transform: (plain) => {
      const usage = generateUsage(plain, { period: PERIOD, ...o });
      const rows = new Map(plain.rows);
      for (const [table, added] of Object.entries(usage.rows)) rows.set(table, [...(rows.get(table) ?? []), ...added]);
      hooked.data = { ...plain, rows };
      hooked.expected = usage.expected;
      return hooked.data;
    },
  });
  return { dump: out.dump, data: hooked.data!, expected: hooked.expected! };
}

/** The fake server over `data`, answering the connection test's MIN/MAX of a dated column too. */
function fakeServer(data: FixtureData): FakeForeignMysql & { connectWithMonths: FakeForeignMysql['connect'] } {
  const tables = fixtureMysqlTables(data);
  const fake = fakeForeignMysql(tables);
  const connectWithMonths: FakeForeignMysql['connect'] = async (cfg, o) => {
    const inner = await fake.connect(cfg, o);
    const conn: ForeignMysql = {
      async query(sql, params) {
        if (sql !== 'SELECT MIN(??) AS lo, MAX(??) AS hi FROM ?? WHERE ?? >= ?') return inner.query(sql, params);
        const [column, , table, , from] = params as [string, string, string, string, string];
        const values = tables
          .get(table)!
          .rows.map((r) => r[column])
          .filter((v): v is string => typeof v === 'string' && v >= from)
          .sort();
        return [{ lo: values[0] ?? null, hi: values[values.length - 1] ?? null }];
      },
      close: () => inner.close(),
    };
    return conn;
  };
  return Object.assign(fake, { connectWithMonths });
}

const DB_CFG = { host: 'slims.sekolah.test', port: 3306, user: 'baca', password: 'Rahasia-SLiMS-9', database: 'slims', tls: false };

describe.skipIf(!ctx.available)(`SLiMS usage import [${engineLabel()}]`, () => {
  let t: UsageHarness;
  let base: { dump: Buffer; data: FixtureData; expected: UsageExpectation };
  let periodId: string;

  beforeAll(async () => {
    t = await usageHarness('slims-usage-import');
    base = fixture();
    periodId = await t.period(PERIOD.startsOn, PERIOD.endsOn);
  });

  afterAll(async () => {
    __setSlimsUsageConnect(null);
    await t?.close();
  });

  beforeEach(async () => {
    for (const table of ['jobs', 'locks', 'catalog_runs', 'usage_stats', 'usage_group_map', 'audit_log'] as const) await t.h.db.deleteFrom(table).execute();
    await t.h.db.deleteFrom('settings').where('key', '=', 'visits.dedupeMinutes').execute();
  });

  afterEach(() => {
    __setSlimsUsageConnect(null);
  });

  /** A dump import of `bytes` from `period` run to its end in one slice; the run id. */
  async function importDump(bytes: Buffer, body: Partial<SlimsUsageStartBody> = {}, period = periodId): Promise<{ runId: string; jobId: string }> {
    const uploadId = await t.upload(bytes);
    const started = await t.start(period, { source: { kind: 'dump', uploadId }, ...body });
    expect(started.joined).toBe(false);
    expect(await t.runToEnd(started.jobId)).toBe('succeeded');
    return started;
  }

  const finishEntries = async (runId: string) =>
    (
      await t.h.db
        .selectFrom('audit_log')
        .select(['actor_type', 'meta'])
        .where('action', '=', 'accreditation.slims_usage.finish')
        .where('entity_id', '=', runId)
        .execute()
    ).map((r) => ({ actor: r.actor_type, meta: JSON.parse(r.meta ?? 'null') as unknown }));

  async function reportText(runId: string): Promise<string> {
    const fileId = (await t.run(runId)).report_file_id;
    if (fileId === null) throw new Error('no report');
    const chunks: Buffer[] = [];
    for await (const c of (await localStorageDriver(t.dataDir).get(fileId))!) chunks.push(Buffer.from(c));
    return Buffer.concat(chunks).toString('utf8');
  }

  it('a dump import stores every month, metric and group of the hand count, and the span metrics of the three period spans', async () => {
    const { runId } = await importDump(base.dump);
    const rows = await t.stats();
    expectRowsMatch(rows, base.expected);
    const groups = new Set(rows.map((r) => r.group_key));
    for (const type of base.expected.memberTypes) expect(groups.has(`slims_type:${type.id}`), `slims_type:${type.id}`).toBe(true);
    for (const key of ['member_unknown', 'guest', '', 'ddc:8', 'ddc:2X', 'ddc:NON']) expect(groups.has(key), key).toBe(true);
    expect(base.expected.memberUnknown.visits).toBeGreaterThan(0);

    const run = await t.run(runId);
    expect(run.status).toBe('succeeded');
    const written = rows.filter((r) => r.source === 'slims').length;
    expect(await finishEntries(runId)).toEqual([{ actor: 'system', meta: { status: 'succeeded', months: base.expected.months.length, rows: written } }]);
    const summary = JSON.parse(run.summary) as { rows: Record<string, number>; totals: Record<string, number>; memberUnknown: Record<string, number> };
    expect(summary.rows['visitor_count']).toBe(base.expected.rows.visitor_count);
    expect(summary.rows['loan']).toBe(base.expected.rows.loan);
    expect(summary.memberUnknown).toEqual(base.expected.memberUnknown);
    const report = await reportText(runId);
    expect(report).toContain(USAGE_SOURCE_NOTE);
    expect(report).toContain(`"month","${base.expected.months[0]}",`);
    expect(report).toContain(`"member_unknown","visits","${base.expected.memberUnknown.visits}"`);
    // Every work file went with the run's end.
    expect(await workFolderExists(t.dataDir, runId)).toBe(false);
    // The options keep what the period page reads, never the hashing key or a password.
    expect(JSON.parse(run.options)).toEqual({ sourceKind: 'dump', periodId, cutoverOn: null, dedupeMinutes: 60 });
  });

  it('the same import through a database connection stores identical rows, and the password reaches only the connection', async () => {
    await importDump(base.dump);
    const fromDump = (await t.stats()).filter((r) => r.source === 'slims');
    await t.h.db.deleteFrom('usage_stats').execute();
    const server = fakeServer(base.data);
    __setSlimsUsageConnect(server.connect);
    const started = await t.start(periodId, { source: { kind: 'db', db: DB_CFG } });
    const payloadText = (await t.h.db.selectFrom('jobs').select('payload').where('id', '=', started.jobId).executeTakeFirstOrThrow()).payload;
    expect(payloadText).not.toContain(DB_CFG.password);
    expect((await t.run(started.runId)).options).not.toContain(DB_CFG.password);
    expect(await t.runToEnd(started.jobId)).toBe('succeeded');
    expect(server.opened.map((o) => o.cfg.password)).toEqual([DB_CFG.password]);
    expect((await t.stats()).filter((r) => r.source === 'slims')).toEqual(fromDump);
    // No statement carried a member id, a name or anything else of the fixture's people.
    const sent = JSON.stringify(server.log);
    for (const value of base.expected.personalValues) expect(sent.includes(value), value).toBe(false);
  });

  it('sliced one step at a time, and with a slice replayed after its work files were written but its state was not, the counts stay the same', async () => {
    const uploadId = await t.upload(base.dump);
    const started = await t.start(periodId, { source: { kind: 'dump', uploadId } });
    const statePath = runWorkPath(t.dataDir, started.runId, 'usage-state.json');
    const replayed = new Set<string>();
    const slicesIn = new Map<string, number>();
    for (let i = 0; i < 5_000; i += 1) {
      const before = await t.payload(started.jobId);
      const phase = before.phase ?? '';
      slicesIn.set(phase, (slicesIn.get(phase) ?? 0) + 1);
      // The second slice in `visits` and in `aggregate`: it runs, then the state and the payload are put back as a crash
      // between its appends and its save would have left them, and the next slice does its work again.
      const replay = (phase === 'visits' || phase === 'aggregate') && !replayed.has(phase) && slicesIn.get(phase) === 2;
      const saved = replay ? await fsp.readFile(statePath) : null;
      const r = await t.slice(started.jobId, 0);
      if (r.outcome !== 'continued') {
        expect(r.outcome).toBe('succeeded');
        break;
      }
      if (saved !== null) {
        await fsp.writeFile(statePath, saved);
        await t.h.db.updateTable('jobs').set({ payload: JSON.stringify(before) }).where('id', '=', started.jobId).execute();
        replayed.add(phase);
      }
    }
    expect([...replayed].sort()).toEqual(['aggregate', 'visits']);
    expect((await t.run(started.runId)).status).toBe('succeeded');
    expectRowsMatch(await t.stats(), base.expected);
  });

  it('with the repeat window set to 0, every check-in is kept: deduplicated visits equal the raw visits in every month', async () => {
    const zero = fixture({ dedupeMinutes: 0 });
    await withTx(t.h, (trx) => writeSettings(trx, { 'visits.dedupeMinutes': 0 }, { keyring, now: NOW, actorId: null }));
    const { runId } = await importDump(zero.dump);
    expect(JSON.parse((await t.run(runId)).options)).toMatchObject({ dedupeMinutes: 0 });
    const rows = await t.stats();
    expectRowsMatch(rows, zero.expected);
    const raw = rows.filter((r) => r.metric === 'visits').map((r) => [r.span_from, r.group_key, r.value]);
    const deduped = rows.filter((r) => r.metric === 'visits_deduped').map((r) => [r.span_from, r.group_key, r.value]);
    expect(deduped).toEqual(raw);
  });

  it('a cut-over on 2026-01-15: SLiMS rows dated on or after it are not counted, and the January row ends on 2026-01-14', async () => {
    const cut = fixture({ cutoverOn: '2026-01-15' });
    const { runId } = await importDump(cut.dump, { cutoverOn: '2026-01-15' });
    const rows = (await t.stats()).filter((r) => r.source === 'slims');
    expectRowsMatch(rows, cut.expected, '2026-01-15');
    expect(cut.expected.months[cut.expected.months.length - 1]).toBe('2026-01');
    const january = rows.filter((r) => r.span_from === '2026-01-01');
    expect(january.length).toBeGreaterThan(0);
    expect(new Set(january.map((r) => r.span_to))).toEqual(new Set(['2026-01-14']));
    expect(rows.some((r) => r.span_from >= '2026-02-01' && r.span_to.slice(0, 7) === r.span_from.slice(0, 7))).toBe(false);
    const summary = JSON.parse((await t.run(runId)).summary) as { dropped: { afterCutover: Record<string, number> } };
    expect(summary.dropped.afterCutover).toEqual(Object.fromEntries(Object.entries(cut.expected.dropped.afterCutover).filter(([, n]) => n > 0)));
  });

  it('a re-import with changed source data replaces the imported rows it covers and never touches manual rows', async () => {
    const manual: StatRow[] = [
      { source: 'manual', metric: 'titles_used', span_from: PERIOD.startsOn, span_to: PERIOD.endsOn, group_key: '', value: 77 },
      { source: 'manual', metric: 'visits', span_from: '2024-03-01', span_to: '2024-03-31', group_key: '', value: 999 },
    ];
    await t.h.db
      .insertInto('usage_stats')
      .values(manual.map((r) => ({ ...r, branch_key: '', run_id: null, updated_at: NOW, updated_by: t.staffId })))
      .execute();
    await importDump(base.dump);
    const changed = fixture({ months: 30 });
    await importDump(changed.dump);
    const rows = await t.stats();
    expect(rows.filter((r) => r.source === 'manual')).toEqual(manual);
    const slims = rows.filter((r) => r.source === 'slims');
    // Months the second import covers (2023-07 to 2025-12) and the period spans are its own; the later months are the
    // first import's, untouched.
    const covered = (r: StatRow): boolean => r.span_to <= '2025-12-31' || changed.expected.spans.some((s) => s.from === r.span_from && s.to === r.span_to);
    expectRowsMatch(slims.filter(covered), changed.expected);
    const later = slims.filter((r) => !covered(r));
    expect(later.length).toBeGreaterThan(0);
    for (const r of later) expect(r.value, `${r.metric} ${r.span_from} [${r.group_key}]`).toBe(base.expected.cell(r.span_from.slice(0, 7), r.metric, r.group_key));
  });

  describe('atomicity: a cancel or a failure before the write leaves the usage tables as they were', () => {
    async function snapshot(): Promise<string> {
      const stats = await t.h.db.selectFrom('usage_stats').selectAll().orderBy('source').orderBy('metric').orderBy('span_from').orderBy('span_to').orderBy('group_key').execute();
      const groups = await t.h.db.selectFrom('usage_group_map').selectAll().orderBy('group_key').execute();
      return JSON.stringify({ stats, groups });
    }

    async function seedBefore(): Promise<void> {
      await t.h.db
        .insertInto('usage_stats')
        .values([
          { source: 'slims', metric: 'visits', span_from: '2024-03-01', span_to: '2024-03-31', branch_key: '', group_key: '', value: 5, run_id: newId(NOW), updated_at: NOW, updated_by: null },
          { source: 'manual', metric: 'loans', span_from: '2024-03-01', span_to: '2024-03-31', branch_key: '', group_key: '', value: 3, run_id: null, updated_at: NOW, updated_by: t.staffId },
        ])
        .execute();
      await t.h.db.insertInto('usage_group_map').values({ group_key: 'slims_type:1', label: 'Siswa', accred_group: 'other', updated_at: NOW, updated_by: t.staffId }).execute();
    }

    /** Starts a dump import and runs it one step per slice until its payload names a phase in `until`. */
    async function startedUntil(until: readonly string[]): Promise<{ runId: string; jobId: string }> {
      const uploadId = await t.upload(base.dump);
      const started = await t.start(periodId, { source: { kind: 'dump', uploadId } });
      for (let i = 0; i < 5_000; i += 1) {
        if (until.includes((await t.payload(started.jobId)).phase ?? '')) return started;
        expect((await t.slice(started.jobId, 0)).outcome).toBe('continued');
      }
      throw new Error('the phase never came');
    }

    it('cancelled after the visits phase: the run is cancelled, its work is gone, and the tables are byte for byte as before', async () => {
      await seedBefore();
      const before = await snapshot();
      const { runId, jobId } = await startedUntil(['reads', 'aggregate']);
      expect((await t.slice(jobId, 0, { cancel: true })).outcome).toBe('cancelled');
      expect((await t.run(runId)).status).toBe('cancelled');
      expect(await snapshot()).toBe(before);
      expect(await workFolderExists(t.dataDir, runId)).toBe(false);
      expect(await finishEntries(runId)).toEqual([{ actor: 'system', meta: { status: 'cancelled', months: 0, rows: 0 } }]);
    });

    it('a failure injected in the aggregate step: the run fails, its work is gone, and the tables are byte for byte as before', async () => {
      await seedBefore();
      const before = await snapshot();
      const { runId, jobId } = await startedUntil(['aggregate']);
      expect((await t.slice(jobId, 0)).outcome).toBe('continued');
      // A month's check-ins lost from the work folder: the step cannot count them.
      const dir = runWorkDir(t.dataDir, runId);
      const months = (await fsp.readdir(dir)).filter((n) => /^usage-visits-\d{4}-\d{2}\.bin$/.test(n)).sort();
      await fsp.rm(path.join(dir, months[months.length - 1]!));
      expect((await t.slice(jobId, 0)).outcome).toBe('succeeded');
      const run = await t.run(runId);
      expect(run.status).toBe('failed');
      expect(JSON.parse(run.summary)).toMatchObject({ phase: 'aggregate', failure: 'work_missing' });
      expect(await snapshot()).toBe(before);
      expect(await workFolderExists(t.dataDir, runId)).toBe(false);
      expect(await finishEntries(runId)).toEqual([{ actor: 'system', meta: { status: 'failed', months: 0, rows: 0 } }]);
    });
  });

  describe('member type groups', () => {
    const groupsNow = async () =>
      Object.fromEntries((await t.h.db.selectFrom('usage_group_map').select(['group_key', 'label', 'accred_group']).execute()).map((r) => [r.group_key, [r.label, r.accred_group]]));

    it('a first import guesses the group of every type from its name, and gives the deleted members the default group', async () => {
      await importDump(base.dump);
      expect(await groupsNow()).toEqual({
        'slims_type:1': ['Siswa', 'student'],
        'slims_type:2': ['Guru', 'teacher'],
        'slims_type:3': ['Staf TU', 'edu_staff'],
        'slims_type:4': ['Umum', 'public'],
        member_unknown: ['', null],
      });
    });

    it('the mapping of the start overwrites a type\'s group, a group edited before is kept otherwise, and the deleted members get the group the start named', async () => {
      await t.h.db
        .insertInto('usage_group_map')
        .values([
          { group_key: 'slims_type:1', label: 'Siswa lama', accred_group: 'other', updated_at: NOW, updated_by: t.staffId },
          { group_key: 'slims_type:2', label: 'Guru', accred_group: 'other', updated_at: NOW, updated_by: t.staffId },
        ])
        .execute();
      await importDump(base.dump, { memberTypeGroups: { '2': 'public', '4': null }, unknownMemberGroup: 'teacher' });
      expect(await groupsNow()).toEqual({
        'slims_type:1': ['Siswa', 'other'],
        'slims_type:2': ['Guru', 'public'],
        'slims_type:3': ['Staf TU', 'edu_staff'],
        'slims_type:4': ['Umum', null],
        member_unknown: ['', 'teacher'],
      });
    });
  });

  describe('runs', () => {
    it('a second start while an import runs joins it; a mapping key that cannot name a group and an unknown period are refused', async () => {
      const uploadId = await t.upload(base.dump);
      const first = await t.start(periodId, { source: { kind: 'dump', uploadId } });
      const again = await t.start(await t.period('2024-07-01', '2025-06-30'), { source: { kind: 'db', db: DB_CFG } });
      expect(again).toEqual({ runId: first.runId, jobId: first.jobId, joined: true, endedRunIds: [] });
      expect((await t.h.db.selectFrom('jobs').select('unique_key').where('id', '=', first.jobId).executeTakeFirstOrThrow()).unique_key).toBe(SLIMS_USAGE_UNIQUE_KEY);
      await t.h.db.deleteFrom('jobs').execute();
      await expect(t.start(periodId, { source: { kind: 'db', db: DB_CFG }, memberTypeGroups: { 'a b': 'student' } })).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
        meta: { errors: [{ path: 'memberTypeGroups.a b', code: 'invalid' }] },
      });
      await expect(t.start(newId(NOW), { source: { kind: 'db', db: DB_CFG } })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('a start ends an import left running without a live job, as its job ended, and audits its end', async () => {
      const uploadId = await t.upload(base.dump);
      const first = await t.start(periodId, { source: { kind: 'dump', uploadId } });
      await withTx(t.h, (trx) => requestCancel(trx, first.jobId, NOW));
      const second = await t.start(periodId, { source: { kind: 'db', db: DB_CFG } });
      expect(second.joined).toBe(false);
      expect(second.endedRunIds).toEqual([first.runId]);
      expect((await t.run(first.runId)).status).toBe('cancelled');
      expect(await finishEntries(first.runId)).toEqual([{ actor: 'system', meta: { status: 'cancelled', months: 0, rows: 0 } }]);
    });

    it('a usage import run is hidden from a viewer without the accreditation management permission', async () => {
      const uploadId = await t.upload(base.dump);
      const { runId } = await t.start(periodId, { source: { kind: 'dump', uploadId } });
      const reader = await listRuns(t.h.db, { limit: 50 }, { migration: true });
      expect(reader.items.map((r) => r.id)).not.toContain(runId);
      expect(await listRuns(t.h.db, { kind: 'slims_usage', limit: 50 }, { migration: true, slimsUsage: false })).toEqual({ items: [], nextCursor: null });
      await expect(getRunView(t.h.db, runId, { migration: true })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect((await listRuns(t.h.db, { limit: 50 }, { migration: false, slimsUsage: true })).items.map((r) => r.id)).toEqual([runId]);
      expect((await getRunView(t.h.db, runId, { migration: false, slimsUsage: true })).kind).toBe('slims_usage');
    });

    it('the catalogue housekeeping ends an import whose job was cancelled at once, removes its work folder and audits its end', async () => {
      const uploadId = await t.upload(base.dump);
      const { runId, jobId } = await t.start(periodId, { source: { kind: 'dump', uploadId } });
      expect(await fsp.stat(runWorkPath(t.dataDir, runId, 'dump.bin')).then(() => true)).toBe(true);
      await withTx(t.h, (trx) => requestCancel(trx, jobId, NOW));
      const result = await expiredExportsStep.run({
        h: t.h,
        now: NOW + 1_000,
        deps: t.deps(),
        cursor: null,
        budgetLeftMs: () => 10_000,
        enqueue: async () => {},
      });
      expect(result.done).toBe(true);
      expect((await t.run(runId)).status).toBe('cancelled');
      expect(await workFolderExists(t.dataDir, runId)).toBe(false);
      expect(await finishEntries(runId)).toEqual([{ actor: 'system', meta: { status: 'cancelled', months: 0, rows: 0 } }]);
    });
  });

  describe('connection test', () => {
    it('answers the usage tables with their rows, the member types with their guessed groups, and the first and last month of use', async () => {
      const server = fakeServer(base.data);
      __setSlimsUsageConnect(server.connectWithMonths);
      // The first month any loan or visit row names (a history row of a loan counted elsewhere included).
      const dated = [
        ...(base.data.rows.get('loan') ?? []).map((r) => r['loan_date']),
        ...(base.data.rows.get('loan_history') ?? []).map((r) => r['loan_date']),
        ...(base.data.rows.get('visitor_count') ?? []).map((r) => r['checkin_date']),
      ].filter((v): v is string => typeof v === 'string' && v >= '1970-01-02');
      const firstMonth = dated.sort()[0]!.slice(0, 7);
      const answer = await testSlimsUsageConnection(DB_CFG);
      expect(answer).toEqual({
        ok: true,
        tables: expect.arrayContaining([
          { name: 'loan', rows: base.expected.rows.loan },
          { name: 'visitor_count', rows: base.expected.rows.visitor_count },
          { name: 'member', rows: base.expected.rows.member },
        ]),
        memberTypes: [
          { id: '1', name: 'Siswa', guess: 'student' },
          { id: '2', name: 'Guru', guess: 'teacher' },
          { id: '3', name: 'Staf TU', guess: 'edu_staff' },
          { id: '4', name: 'Umum', guess: 'public' },
        ],
        months: { first: firstMonth, last: base.expected.months[base.expected.months.length - 1] },
      });
      expect(answer.ok && answer.tables.every((tb) => tb.name !== 'biblio_attachment')).toBe(true);
      expect(server.closed).toBe(1);
    });

    it('a server it cannot reach is an answer: ok false, the unreachable code and a short reason', async () => {
      __setSlimsUsageConnect(async () => {
        throw Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:3306'), { code: 'ECONNREFUSED' });
      });
      expect(await testSlimsUsageConnection(DB_CFG)).toEqual({ ok: false, code: 'MIGRATION_SOURCE_UNREACHABLE', reason: 'refused' });
    });
  });
});
