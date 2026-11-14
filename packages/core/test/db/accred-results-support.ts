import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations, withTx } from '@altis/db';
import { newId } from '@altis/shared';
import type { AccredProfile } from '@altis/shared/api/accreditation';
import type { KyselyPlugin } from 'kysely';
import { testDb, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { enqueueEvaluate } from '../../src/accreditation/evaluate/index.js';
import { evaluateJob } from '../../src/accreditation/evaluate/job.js';
import { instrumentById } from '../../src/accreditation/instruments/index.js';
import { ACCRED_METRICS, ACCRED_PROVIDER_IDS, metricsOfProvider, type AccredMetricId, type AccredProviderId } from '../../src/accreditation/metric-ids.js';
import type { AccredInstrument, AccredMetricProvider, AccredMetricValue } from '../../src/accreditation/types.js';
import type { CatalogJobDeps } from '../../src/catalog/jobs-deps.js';
import { txCtx, type Actor, type TxCtx } from '../../src/context.js';
import type { KeyringEntry } from '../../src/crypto/secret-box.js';
import { localStorageDriver, type StorageDriver } from '../../src/files/serve.js';
import { claimById } from '../../src/jobs/claim.js';
import { createJobRegistry } from '../../src/jobs/registry.js';
import { runSlice } from '../../src/jobs/slice.js';
import type { JobHandler, JobRegistry, SliceResult } from '../../src/jobs/types.js';

// What the evaluation and freeze tests share (accred-evaluate, accred-freeze, accred-freeze-race): a migrated database
// with a staff member, a DATA_DIR of its own, periods seeded straight into the table an hour before the real clock,
// the evaluation job over the providers a test chooses (fake ones that answer every metric, or the real ones), driven
// slice by slice through the queue's claim path, and a capture of the SQL a transaction runs.

export const KEYRING: KeyringEntry[] = [{ kid: 'k1', key: randomBytes(32).toString('base64url'), active: true }];
const silent = { info() {}, warn() {}, error() {} };

/** When the seeded rows were written: before every evaluation of the tests (which runs on the real clock). */
export const SEEDED_AT = Date.now() - 3_600_000;

export const SMA = instrumentById('sch-sma-2025') as AccredInstrument;
export const TEST_SCH = instrumentById('test-sch') as AccredInstrument;

export interface AccredDb {
  h: TestDbHandle;
  root: string;
  dataDir: string;
  staffId: string;
  actor: Actor;
  storage: StorageDriver;
  /** A job registry whose evaluation runs over `providers`. */
  registry(providers: readonly AccredMetricProvider[]): JobRegistry;
  close(): Promise<void>;
}

/** A migrated database, its DATA_DIR and a staff member. */
export async function openAccredDb(prefix: string): Promise<AccredDb> {
  const h = await testDb();
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), `altis-${prefix}-`)));
  const dataDir = path.join(root, 'data');
  await fsp.mkdir(path.join(dataDir, 'tmp'), { recursive: true });
  await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(root, 'migrations'), migrations: PHASE1_MIGRATIONS });
  const staffId = newId(SEEDED_AT);
  await h.db
    .insertInto('staff_users')
    .values({ id: staffId, username_key: 'pustakawan', username_display: 'pustakawan', name: 'Pustakawan', password_hash: 'x', status: 'active', created_at: SEEDED_AT, updated_at: SEEDED_AT })
    .execute();
  const storage = localStorageDriver(dataDir);
  const deps = (): CatalogJobDeps & { appVersion: string } => ({
    dataDir,
    baseUrl: 'https://perpus.sma-contoh.sch.id',
    keyring: KEYRING,
    storage,
    log: silent,
    appVersion: '0.1.0',
  });
  return {
    h,
    root,
    dataDir,
    staffId,
    actor: { type: 'staff', id: staffId, ip: null },
    storage,
    registry: (providers) => createJobRegistry([evaluateJob(deps, { providers }) as JobHandler<unknown>]),
    async close() {
      await h.close();
      await fsp.rm(root, { recursive: true, force: true });
    },
  };
}

/** Runs `fn` in a transaction as the staff member, at `now` (default the real clock). */
export function inTx<T>(db: AccredDb, fn: (tx: TxCtx) => Promise<T>, now = Date.now()): Promise<T> {
  return withTx(db.h, (trx) => fn(txCtx(trx, now, db.actor)));
}

export interface PeriodSeed {
  instrumentId?: string;
  status?: 'open' | 'frozen';
  profile?: AccredProfile;
  students?: number | null;
  teachers?: number | null;
  eduStaff?: number | null;
  classes?: number | null;
  ictDevices?: number | null;
  bandwidthMbps?: number | null;
  floorM2?: number | null;
  at?: number;
}

/** An open school-year period 2025/2026 (of `sch-sma-2025` unless named), written at SEEDED_AT; its id. */
export async function seedPeriod(db: AccredDb, o: PeriodSeed = {}): Promise<string> {
  const at = o.at ?? SEEDED_AT;
  const id = newId(at);
  await db.h.db
    .insertInto('accred_periods')
    .values({
      id,
      branch_id: null,
      name: 'Tahun pelajaran 2025/2026',
      kind: 'school_year',
      starts_on: '2025-07-01',
      ends_on: '2026-06-30',
      instrument_id: o.instrumentId ?? 'sch-sma-2025',
      status: o.status ?? 'open',
      frozen_at: o.status === 'frozen' ? at : null,
      frozen_by: null,
      profile: JSON.stringify(o.profile ?? { schoolLevel: 'sma_smk_ma', npp: '3201010D1000004' }),
      students: o.students ?? null,
      teachers: o.teachers ?? null,
      edu_staff: o.eduStaff ?? null,
      classes: o.classes ?? null,
      ict_devices: o.ictDevices ?? null,
      bandwidth_mbps: o.bandwidthMbps ?? null,
      floor_m2: o.floorM2 ?? null,
      all_registered_confirmed: 0,
      archived_at: null,
      version: 0,
      created_at: at,
      created_by: null,
      updated_at: at,
      updated_by: null,
    })
    .execute();
  return id;
}

/** Queues the evaluation of `periodId` on `registry`, as the route does. */
export function enqueue(db: AccredDb, registry: JobRegistry, periodId: string): Promise<{ jobId: string; existing: boolean }> {
  return withTx(db.h, (trx) => enqueueEvaluate(trx, periodId, { now: Date.now(), createdBy: db.staffId, registry, keyring: KEYRING }));
}

/** Claims and runs job `jobId` slice by slice until it stops continuing (or `maxSlices` ran); the outcomes. */
export async function drive(
  db: AccredDb,
  registry: JobRegistry,
  jobId: string,
  o: { maxSlices?: number; budgetMs?: number } = {},
): Promise<SliceResult['outcome'][]> {
  const outcomes: SliceResult['outcome'][] = [];
  for (let i = 1; i <= (o.maxSlices ?? 100); i += 1) {
    const job = await claimById(db.h, registry, jobId, { worker: 'test', now: Date.now() });
    if (job === null) throw new Error(`job ${jobId} cannot be claimed`);
    const r = await runSlice(db.h, registry, job, { mode: 'worker', budgetMs: o.budgetMs ?? 20_000, keyring: KEYRING, log: silent, clock: () => Date.now(), env: {} });
    outcomes.push(r.outcome);
    if (r.outcome !== 'continued') return outcomes;
  }
  return outcomes;
}

/** Evaluates `periodId` over `providers` to its end; the outcomes. */
export async function evaluateNow(db: AccredDb, periodId: string, providers: readonly AccredMetricProvider[]): Promise<SliceResult['outcome'][]> {
  // A change a test made a moment ago lies strictly before the evaluation's start.
  await new Promise((resolve) => setTimeout(resolve, 5));
  const registry = db.registry(providers);
  const { jobId } = await enqueue(db, registry, periodId);
  return drive(db, registry, jobId);
}

/** A metric's fake value: `value` (default 3), the metric's unit, basis `manual`. */
export function fakeValue(id: AccredMetricId, value: number | null = 3, more: Partial<AccredMetricValue> = {}): AccredMetricValue {
  return { value, unit: ACCRED_METRICS[id].unit, basis: 'manual', notes: [], ...more };
}

/** The fake values the prerequisites pass with: 1 500 titles, the NPP, the founding decree. */
export const PASSING: Partial<Record<AccredMetricId, number>> = {
  'collection.titles': 1500,
  'period.npp_present': 1,
  'registers.founding_decree_registered': 1,
};

export interface FakeOptions {
  /** The value of a metric (default {@link fakeValue} with {@link PASSING}'s numbers, else 3). */
  value?: (id: AccredMetricId) => AccredMetricValue;
  /** A provider that answers "not done" this many times before its values (one slice each). */
  slices?: Partial<Record<AccredProviderId, number>>;
  /** A provider that throws. */
  throws?: AccredProviderId;
  /** Every call: provider id, the ids asked, the resume point given. */
  calls?: { provider: AccredProviderId; ids: readonly AccredMetricId[]; cursor: string | null }[];
}

/** One fake provider per provider of this edition (each with the real one's metrics), in the registry's order. */
export function fakeProviders(o: FakeOptions = {}): AccredMetricProvider[] {
  const valueOf = o.value ?? ((id: AccredMetricId) => fakeValue(id, PASSING[id] ?? 3));
  return ACCRED_PROVIDER_IDS.map((pid) => ({
    id: pid,
    metrics: metricsOfProvider(pid),
    async compute(_ctx, ids, resume) {
      o.calls?.push({ provider: pid, ids, cursor: resume?.cursor ?? null });
      if (o.throws === pid) throw new Error('fake provider failure');
      const done = resume === null ? 0 : Number(resume.cursor);
      if (done < (o.slices?.[pid] ?? 0)) return { done: false, resume: { cursor: String(done + 1), state: { pid } } };
      return { done: true, values: new Map(ids.map((id) => [id, valueOf(id)])) };
    },
  }));
}

/** The stored rows of `periodId` by code, parsed. */
export async function rowsOf(db: AccredDb, periodId: string): Promise<Map<string, unknown>> {
  const rows = await db.h.db.selectFrom('accred_results').select(['indicator_code', 'payload']).where('period_id', '=', periodId).execute();
  return new Map(rows.map((r) => [r.indicator_code, JSON.parse(r.payload) as unknown]));
}

/** Every indicator of `instr` answered `letter` by hand, written straight into the table at SEEDED_AT. */
export async function answerAll(db: AccredDb, periodId: string, instr: AccredInstrument, letter: 'a' | 'b' | 'c' | 'd'): Promise<void> {
  for (const c of instr.components) {
    for (const i of c.indicators) {
      await db.h.db
        .insertInto('accred_answers')
        .values({ period_id: periodId, indicator_code: `SCH-${i.code}`, answer: letter, mode: 'manual', note: null, updated_at: SEEDED_AT, updated_by: db.staffId })
        .execute();
    }
  }
}

/** A plugin that records the SQL of every statement, and the statements of a transaction that do work. */
export function sqlCapture(db: AccredDb): { plugin: KyselyPlugin; work(): string[] } {
  const statements: string[] = [];
  const plugin: KyselyPlugin = {
    transformQuery(args) {
      statements.push(db.h.db.getExecutor().compileQuery(args.node, args.queryId).sql);
      return args.node;
    },
    async transformResult(args) {
      return args.result;
    },
  };
  return { plugin, work: () => statements.filter((sql) => !/^\s*(begin|start|set|savepoint|release|commit|rollback)\b/i.test(sql)) };
}
