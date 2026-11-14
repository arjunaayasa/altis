import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations, withTx, type TableName } from '@altis/db';
import { isDomainError, newId } from '@altis/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { enqueueEvaluate } from '../../src/accreditation/evaluate/index.js';
import { evaluateJob } from '../../src/accreditation/evaluate/job.js';
import { freezePeriod } from '../../src/accreditation/freeze.js';
import { ACCRED_METRIC_PROVIDERS } from '../../src/accreditation/providers/index.js';
import { loadTables } from '../../src/restore/load.js';
import type { CatalogJobDeps } from '../../src/catalog/jobs-deps.js';
import { txCtx, type Actor } from '../../src/context.js';
import { localStorageDriver, type StorageDriver } from '../../src/files/serve.js';
import { claimById } from '../../src/jobs/claim.js';
import { createJobRegistry } from '../../src/jobs/registry.js';
import { runSlice } from '../../src/jobs/slice.js';
import type { JobHandler, JobRegistry } from '../../src/jobs/types.js';
import { reportsExportJob } from '../../src/reports/export/job.js';
import { reportById } from '../../src/reports/registry.js';
import { startReportRun } from '../../src/reports/runs/index.js';
import {
  KEYRING,
  beginRestore,
  loadedChecksums,
  manifestChecksums,
  restoreHarness,
  restoreParams,
  seedInstallation,
  serverBackup,
  stepUntil,
} from '../fixtures/restore-support.js';
import { GOLDEN_BASE_URL, seedSmaContoh, type GoldenFixture } from '../support/accreditation-golden.js';

// A backup and a restore of an installation with every table of the reports and the accreditation workspace filled,
// on the engine picked by ALTIS_TEST_DB (SQLite restores in place in a test build): the golden school dataset (periods,
// answers, usage, member type groups, the five registers with trainings), its evaluation, an evidence file, a frozen
// snapshot and a report run. After the restore:
// - every table the backup holds has the backup's checksum again, the accreditation and register tables among them;
// - the report runs and the computed results, which are volatile, are empty;
// - a freeze of a period evaluated before the backup is refused as stale (409 ACCRED_RESULTS_STALE) until the period is
//   evaluated again, and then succeeds.
// The SQLite → MariaDB and SQLite → PostgreSQL pairs of the same flow run on the owner's machine.

vi.mock('@altis/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@altis/platform')>();
  return { ...actual, ensureHeadroom: async () => {} };
});

const ctx = testDbContext();
const INSTALL_ID = newId();
const silent = { info() {}, warn() {}, error() {} };

/** The data tables of the reports and the accreditation workspace (backed up and restored). */
const K1_DATA_TABLES = [
  'accred_periods',
  'accred_answers',
  'accred_snapshots',
  'accred_evidence',
  'usage_stats',
  'usage_group_map',
  'library_activities',
  'library_staff',
  'staff_trainings',
  'library_partnerships',
  'library_budgets',
  'library_documents',
] as const satisfies readonly TableName[];
/** The volatile tables of the same: never backed up, empty after a restore. */
const K1_VOLATILE_TABLES = ['report_runs', 'accred_results'] as const satisfies readonly TableName[];

describe.skipIf(!ctx.available)(`backup and restore with every accreditation and report table filled [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;
  let dataDir: string;
  let fx: GoldenFixture;
  let staff: Actor;
  let staffId: string;
  let storage: StorageDriver;
  let registry: JobRegistry;
  let evidenceFile: { id: string; sha256: string };

  const rowsOf = async (table: TableName): Promise<number> =>
    Number((await h.db.selectFrom(table as 'records').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n);

  /** Runs job `jobId` slice by slice to its end; its last outcome. */
  async function runToEnd(jobId: string): Promise<string> {
    for (let i = 0; i < 500; i += 1) {
      const job = await claimById(h, registry, jobId, { worker: 'test', now: Date.now() });
      if (job === null) throw new Error(`job ${jobId} cannot be claimed`);
      const r = await runSlice(h, registry, job, { mode: 'worker', budgetMs: 20_000, keyring: KEYRING, log: silent, clock: () => Date.now(), env: {} });
      if (r.outcome !== 'continued') return r.outcome;
    }
    throw new Error(`job ${jobId} did not end`);
  }

  /** Evaluates `periodId` with the real providers, to its end. */
  async function evaluate(periodId: string): Promise<void> {
    // Every change made a moment ago lies strictly before the evaluation's start.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const { jobId } = await withTx(h, (trx) => enqueueEvaluate(trx, periodId, { now: Date.now(), createdBy: staffId, registry, keyring: KEYRING }));
    expect(await runToEnd(jobId)).toBe('succeeded');
  }

  const freeze = (periodId: string) => withTx(h, (trx) => freezePeriod(txCtx(trx, Date.now(), staff), periodId, {}, Date.now()));

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-k1-restore-')));
    dataDir = path.join(root, 'data');
    await fsp.mkdir(path.join(dataDir, 'tmp'), { recursive: true });
    await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
    const seeded = await seedInstallation(h, { dataDir, installId: INSTALL_ID });
    staffId = seeded.users[0]!.id;
    staff = { type: 'staff', id: staffId, ip: null };
    storage = localStorageDriver(dataDir);
    const deps = (): CatalogJobDeps & { appVersion: string } => ({ dataDir, baseUrl: GOLDEN_BASE_URL, keyring: KEYRING, storage, log: silent, appVersion: '0.1.0' });
    registry = createJobRegistry([evaluateJob(deps, { providers: ACCRED_METRIC_PROVIDERS }) as JobHandler<unknown>, reportsExportJob(deps) as JobHandler<unknown>]);

    fx = await seedSmaContoh(h);
    // An evidence file of the upper secondary period, with its stored blob.
    const bytes = Buffer.from('%PDF-1.4\n% surat keputusan pendirian perpustakaan\n%%EOF\n', 'latin1');
    const fileId = newId();
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    await storage.put(fileId, bytes, { size: bytes.byteLength, sha256 });
    evidenceFile = { id: fileId, sha256 };
    const at = Date.parse('2026-06-01T10:00:00+07:00');
    await h.db
      .insertInto('files')
      .values({ id: fileId, original_name: 'sk-pendirian.pdf', mime: 'application/pdf', size: bytes.byteLength, sha256, context: 'accreditation.evidence', access: 'staff', status: 'ok', created_at: at, created_by: staffId })
      .execute();
    const evidenceId = newId(at);
    await h.db
      .insertInto('accred_evidence')
      .values({ id: evidenceId, period_id: fx.periods.sma, indicator_code: 'SCH-F1', evidence_code: 'founding_decree', entity: null, entity_id: null, file_id: fileId, caption: 'SK pendirian', sort_order: 0, created_at: at, created_by: staffId })
      .execute();
    await h.db.updateTable('files').set({ owner_type: 'accred_evidence', owner_id: evidenceId }).where('id', '=', fileId).execute();

    // The upper secondary and lower secondary periods evaluated; the first frozen; a report run written.
    await evaluate(fx.periods.sma);
    await evaluate(fx.periods.smp);
    await freeze(fx.periods.sma);
    const def = reportById('accreditation.annex.budgets')!;
    const run = await withTx(h, (trx) => startReportRun(trx, def, { format: 'csv', params: { periodId: fx.periods.sma }, locale: 'id', createdBy: staffId, now: Date.now(), registry, keyring: KEYRING }));
    expect(await runToEnd(run.jobId)).toBe('succeeded');
  }, 300_000);

  afterAll(async () => {
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  it('every accreditation, register, usage and report table holds rows before the backup', async () => {
    for (const table of [...K1_DATA_TABLES, ...K1_VOLATILE_TABLES]) expect([table, (await rowsOf(table)) > 0]).toEqual([table, true]);
  });

  it('after the restore the data checksums are the backup’s, the report runs and results are empty, and a freeze needs a fresh evaluation', async () => {
    const { backupId, manifest } = await serverBackup(h, { dataDir, installId: INSTALL_ID, includeFiles: true });
    // The backup holds every data table of the workspace and none of the volatile ones.
    const loaded = loadTables(manifest);
    for (const table of K1_DATA_TABLES) expect([table, loaded.includes(table)]).toEqual([table, true]);
    for (const table of K1_VOLATILE_TABLES) expect([table, loaded.includes(table)]).toEqual([table, false]);

    // Changes after the backup the restore must undo: a register row, an answer, a usage cell, a staff name, the
    // evidence row and its snapshot.
    const now = Date.now();
    await h.db.deleteFrom('library_activities').where('kind', '=', 'needs_survey').execute();
    await h.db.deleteFrom('accred_answers').where('period_id', '=', fx.periods.smp).where('indicator_code', '=', 'SCH-SP1').execute();
    await h.db.updateTable('usage_stats').set({ value: 999, updated_at: now }).where('metric', '=', 'loans').where('group_key', '=', '').execute();
    await h.db.updateTable('library_staff').set({ name: 'Nama Sesudah Cadangan', updated_at: now }).where('id', '=', fx.staff.head).execute();
    await h.db.deleteFrom('accred_snapshots').execute();
    await h.db.updateTable('accred_periods').set({ status: 'open', frozen_at: null, frozen_by: null }).where('id', '=', fx.periods.sma).execute();
    expect(await loadedChecksums(h, manifest, ['notifications'])).not.toEqual(manifestChecksums(manifest, ['notifications']));

    const harness = restoreHarness({ dataDir, config: h.config, dbDataDir: h.dataDir, live: h, installId: INSTALL_ID });
    try {
      const opId = await beginRestore(harness, restoreParams(backupId));
      const status = await stepUntil(harness, dataDir);
      expect(status).toMatchObject({ opId, kind: 'restore', state: 'done', terminal: true, error: null });
    } finally {
      await harness.close();
    }

    // The data as backed up (notifications: the archive's plus the restore's own).
    expect(await loadedChecksums(h, manifest, ['notifications'])).toEqual(manifestChecksums(manifest, ['notifications']));
    for (const table of K1_DATA_TABLES) expect([table, (await rowsOf(table)) > 0]).toEqual([table, true]);
    expect((await h.db.selectFrom('accred_periods').select('status').where('id', '=', fx.periods.sma).executeTakeFirstOrThrow()).status).toBe('frozen');
    // The evidence file's blob came back with the backup.
    const chunks: Buffer[] = [];
    for await (const c of (await storage.get(evidenceFile.id))!) chunks.push(Buffer.from(c));
    expect(createHash('sha256').update(Buffer.concat(chunks)).digest('hex')).toBe(evidenceFile.sha256);
    // The volatile tables are empty.
    for (const table of K1_VOLATILE_TABLES) expect([table, await rowsOf(table)]).toEqual([table, 0]);

    // A freeze of the period evaluated before the backup: its results are gone, so it is stale.
    const stale = await freeze(fx.periods.smp).then(
      () => 'frozen',
      (e: unknown) => (isDomainError(e) ? { code: e.code, status: e.status } : e),
    );
    expect(stale).toEqual({ code: 'ACCRED_RESULTS_STALE', status: 409 });
    expect((await h.db.selectFrom('accred_periods').select('status').where('id', '=', fx.periods.smp).executeTakeFirstOrThrow()).status).toBe('open');

    // Evaluated again, it freezes.
    await evaluate(fx.periods.smp);
    const frozen = await freeze(fx.periods.smp);
    expect(frozen.id).toMatch(/^[0-9A-Z]{26}$/);
    const snapshot = await h.db.selectFrom('accred_snapshots').select(['period_id', 'na', 'grade']).where('id', '=', frozen.id).executeTakeFirstOrThrow();
    expect(snapshot).toEqual({ period_id: fx.periods.smp, na: '73.20', grade: 'C' });
  }, 300_000);
});
