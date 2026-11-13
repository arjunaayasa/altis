import { createHash, randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations, withTx } from '@altis/db';
import { exportFilePath, reportExportPath, reportWorkDir, reportWorkPath, runWorkDir } from '@altis/platform';
import { newId } from '@altis/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { catalogHousekeepingJob } from '../../src/catalog/housekeeping.js';
import type { CatalogJobDeps } from '../../src/catalog/jobs-deps.js';
import type { KeyringEntry } from '../../src/crypto/secret-box.js';
import { localStorageDriver } from '../../src/files/serve.js';
import { cleanFiles } from '../../src/housekeeping/files.js';
import { claimById } from '../../src/jobs/claim.js';
import { enqueue } from '../../src/jobs/enqueue.js';
import { createJobRegistry } from '../../src/jobs/registry.js';
import { runSlice } from '../../src/jobs/slice.js';
import type { JobHandler, JobRegistry } from '../../src/jobs/types.js';
import { reportsHousekeepingJob } from '../../src/reports/housekeeping/index.js';
import { writeSettings } from '../../src/settings/service.js';

// The reports housekeeping with its real steps, and the catalogue's housekeeping and the files cleanup beside it: each
// sweep only touches its own folders. `reports.housekeeping` sweeps `exports/reports/` and `tmp/reports/` (an expired
// run's file and row, a file no run names after 24 hours, the work folder of a run that ended) and never the
// catalogue's `exports/<runId>.<ext>` or `tmp/<runId>/`; `catalog.housekeeping` and `files.cleanup` never look into the
// `reports/` sub-folders, so a long export's work folder survives all three. The unclaimed uploads of the community
// contexts are this job's, those of the catalogue contexts the catalogue's. While the clock looks wrong, only the steps
// that do not depend on an age run. A run whose job ended without ending it is ended as abandoned, and its work folder
// goes in the same pass. On the engine picked by ALTIS_TEST_DB.

const ctx = testDbContext();
const NOW = Date.UTC(2026, 10, 14, 20, 50, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const keyring: KeyringEntry[] = [{ kid: 'k1', key: randomBytes(32).toString('base64url'), active: true }];
const silent = { info() {}, warn() {}, error() {} };

describe.skipIf(!ctx.available)(`reports.housekeeping [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;
  let dataDir: string;
  let staff: string;

  const deps = (): CatalogJobDeps => ({ dataDir, baseUrl: 'https://perpus.example.sch.id', keyring, storage: localStorageDriver(dataDir), log: silent });

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-core-reports-sweep-')));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(root, 'migrations'), migrations: PHASE1_MIGRATIONS });
    staff = newId(NOW - 30 * DAY);
    await h.db
      .insertInto('staff_users')
      .values({ id: staff, username_key: 'pustakawan', username_display: 'pustakawan', name: 'Pustakawan', password_hash: 'x', status: 'active', created_at: NOW, updated_at: NOW })
      .execute();
  });

  afterAll(async () => {
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    for (const table of ['report_runs', 'catalog_runs', 'jobs', 'files', 'locks'] as const) await h.db.deleteFrom(table).execute();
    await h.db.deleteFrom('settings').where('key', '=', 'system.clock_anomaly').execute();
    dataDir = await fsp.mkdtemp(path.join(root, 'data-'));
  });

  // ---- running the jobs ----

  /** Enqueues `handler`'s job (the schedule's window) and runs its slices until it ends; the job's end. */
  async function runJob(handler: JobHandler<unknown>): Promise<{ status: string; message: string | null }> {
    const reg: JobRegistry = createJobRegistry([handler]);
    const { id } = await withTx(h, (trx) => enqueue(trx, reg, { type: handler.type, payload: { windowStart: NOW - DAY, windowEnd: NOW } }, { now: NOW, keyring }));
    for (let slices = 0; slices < 20; slices += 1) {
      const job = await claimById(h, reg, id, { worker: 'test', now: NOW });
      if (job === null) throw new Error(`job ${id} cannot be claimed`);
      const r = await runSlice(h, reg, job, { mode: 'worker', budgetMs: 20_000, keyring, log: silent, clock: () => NOW, env: {} });
      if (r.outcome !== 'continued') {
        const row = await h.db.selectFrom('jobs').select(['status', 'progress_message']).where('id', '=', id).executeTakeFirstOrThrow();
        return { status: row.status, message: row.progress_message };
      }
    }
    throw new Error('no end after 20 slices');
  }

  const reportsHousekeeping = () => runJob(reportsHousekeepingJob(deps) as JobHandler<unknown>);
  const catalogHousekeeping = () => runJob(catalogHousekeepingJob(deps) as JobHandler<unknown>);
  async function filesCleanup(): Promise<void> {
    const { next } = await cleanFiles(h, { dataDir, now: NOW, from: null, budgetLeft: () => true, owner: `job:${newId()}`, log: silent });
    expect(next).toBeNull();
  }

  // ---- seeding ----

  /** A job row in `status`; its id. */
  async function jobRow(status: string): Promise<string> {
    const id = newId(NOW - DAY);
    await h.db
      .insertInto('jobs')
      .values({
        id,
        type: 'reports.export',
        payload: '{}',
        secret_param: null,
        status,
        run_at: NOW - DAY,
        max_attempts: 5,
        unique_key: null,
        lock_token: null,
        locked_by: null,
        locked_until: null,
        progress_message: null,
        last_error: null,
        created_by: null,
        created_at: NOW - DAY,
        updated_at: NOW - DAY,
        finished_at: status === 'queued' || status === 'running' ? null : NOW - HOUR,
      })
      .execute();
    return id;
  }

  /** A report run in `status`, created `ageMs` ago; its id. */
  async function reportRun(o: { status: string; ageMs: number; format?: string; expiresAt?: number | null; jobId?: string | null }): Promise<string> {
    const at = NOW - o.ageMs;
    const id = newId(at);
    const ended = !['queued', 'running'].includes(o.status);
    await h.db
      .insertInto('report_runs')
      .values({
        id,
        report_id: 'test.rows',
        format: o.format ?? 'xlsx',
        locale: 'id',
        params: '{"def":{"rows":3}}',
        personal: 0,
        status: o.status,
        row_count: null,
        non_latin_rows: null,
        output_name: null,
        output_size: null,
        error_code: null,
        job_id: o.jobId ?? null,
        expires_at: o.expiresAt ?? null,
        created_at: at,
        created_by: staff,
        finished_at: ended ? at : null,
      })
      .execute();
    return id;
  }

  /** A catalogue run of `kind` in `status`; its id. */
  async function catalogRun(o: { kind: 'import' | 'export'; status: string; ageMs: number; expiresAt?: number | null }): Promise<string> {
    const at = NOW - o.ageMs;
    const id = newId(at);
    const ended = !['queued', 'running'].includes(o.status);
    await h.db
      .insertInto('catalog_runs')
      .values({
        id,
        kind: o.kind,
        status: o.status,
        dry_run: 0,
        format: o.kind === 'export' ? 'csv-records' : 'marc21',
        options: '{}',
        summary: '{}',
        report_file_id: null,
        output_name: o.kind === 'export' ? `${id}.csv` : null,
        output_size: null,
        expires_at: o.expiresAt ?? null,
        job_id: null,
        created_at: at,
        created_by: null,
        finished_at: ended ? at : null,
      })
      .execute();
    return id;
  }

  async function writeFile(p: string, content = 'x'): Promise<string> {
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, content);
    return p;
  }

  const exists = (p: string) =>
    fsp.stat(p).then(
      () => true,
      () => false,
    );

  const runStatus = async (id: string) => (await h.db.selectFrom('report_runs').select(['status', 'error_code', 'finished_at']).where('id', '=', id).executeTakeFirst()) ?? null;

  /**
   * The two-way fixture: a catalogue export that expired (its file in `exports/`), a live catalogue run's work folder
   * 25 hours old, a report run that expired (its XLSX in `exports/reports/`), a report PDF no run names 25 hours old, a
   * running report run 25 hours old with its work folder (its job live), and a failed report run's work folder.
   */
  async function twoWayFixture() {
    const catalogExport = await catalogRun({ kind: 'export', status: 'succeeded', ageMs: 8 * DAY, expiresAt: NOW - HOUR });
    const catalogLive = await catalogRun({ kind: 'import', status: 'running', ageMs: 25 * HOUR });
    const expired = await reportRun({ status: 'succeeded', ageMs: 8 * DAY, format: 'xlsx', expiresAt: NOW - HOUR });
    const orphanPdf = newId(NOW - 25 * HOUR);
    const running = await reportRun({ status: 'running', ageMs: 25 * HOUR, jobId: await jobRow('running') });
    const failed = await reportRun({ status: 'failed', ageMs: 2 * HOUR });
    return {
      catalogExportFile: await writeFile(exportFilePath(dataDir, catalogExport, 'csv')),
      catalogWork: await writeFile(path.join(runWorkDir(dataDir, catalogLive), 'import.bin')),
      expired,
      expiredFile: await writeFile(reportExportPath(dataDir, expired, 'xlsx')),
      orphanPdf: await writeFile(reportExportPath(dataDir, orphanPdf, 'pdf')),
      runningWork: await writeFile(reportWorkPath(dataDir, running, 'rows.ndjson')),
      failedWork: await writeFile(reportWorkPath(dataDir, failed, 'output.part')),
      failed,
      running,
    };
  }

  describe('each sweep keeps to its own folders', () => {
    it('reports.housekeeping removes the expired report file and run, the row-less PDF and the failed run’s folder; it keeps the running run’s folder and both catalogue paths', async () => {
      const f = await twoWayFixture();
      expect(await reportsHousekeeping()).toEqual({ status: 'succeeded', message: null });
      expect(await exists(f.expiredFile)).toBe(false);
      expect(await runStatus(f.expired)).toBeNull();
      expect(await exists(f.orphanPdf)).toBe(false);
      expect(await exists(reportWorkDir(dataDir, f.failed))).toBe(false);
      expect(await exists(f.runningWork)).toBe(true);
      expect(await runStatus(f.running)).toMatchObject({ status: 'running' });
      expect(await exists(f.catalogExportFile)).toBe(true);
      expect(await exists(f.catalogWork)).toBe(true);
    });

    it('catalog.housekeeping and then files.cleanup remove the expired catalogue export and keep every path under reports/', async () => {
      const f = await twoWayFixture();
      expect(await catalogHousekeeping()).toEqual({ status: 'succeeded', message: null });
      await filesCleanup();
      expect(await exists(f.catalogExportFile)).toBe(false);
      for (const p of [f.expiredFile, f.orphanPdf, f.runningWork, f.failedWork]) expect(await exists(p), p).toBe(true);
      expect(await runStatus(f.expired)).toMatchObject({ status: 'succeeded' });
    });

    it('a running report run’s work folder 25 hours old survives the files cleanup, the catalogue’s and the reports’ housekeeping', async () => {
      const f = await twoWayFixture();
      await filesCleanup();
      await catalogHousekeeping();
      await reportsHousekeeping();
      expect(await exists(f.runningWork)).toBe(true);
    });

    it('a finished run’s file of another format, a failed run’s file and a temporary sibling 25 hours old go; a fresh row-less file stays', async () => {
      const succeeded = await reportRun({ status: 'succeeded', ageMs: HOUR, format: 'csv', expiresAt: NOW + 6 * DAY });
      const failed = await reportRun({ status: 'failed', ageMs: HOUR, format: 'pdf' });
      const kept = await writeFile(reportExportPath(dataDir, succeeded, 'csv'));
      const otherFormat = await writeFile(reportExportPath(dataDir, succeeded, 'pdf'));
      const failedFile = await writeFile(reportExportPath(dataDir, failed, 'pdf'));
      const fresh = await writeFile(reportExportPath(dataDir, newId(NOW - HOUR), 'zip'));
      const temp = await writeFile(path.join(path.dirname(kept), `.${path.basename(kept)}.tmp-4242-0123456789ab`));
      const old = new Date(NOW - 25 * HOUR);
      await fsp.utimes(temp, old, old);
      await reportsHousekeeping();
      expect(await exists(kept)).toBe(true);
      expect(await exists(otherFormat)).toBe(false);
      expect(await exists(failedFile)).toBe(false);
      expect(await exists(fresh)).toBe(true);
      expect(await exists(temp)).toBe(false);
    });

    it('a run that ended without a file is removed once it is 7 days old', async () => {
      const old = await reportRun({ status: 'failed', ageMs: 8 * DAY });
      const recent = await reportRun({ status: 'failed', ageMs: 6 * DAY });
      await reportsHousekeeping();
      expect(await runStatus(old)).toBeNull();
      expect(await runStatus(recent)).toMatchObject({ status: 'failed' });
    });
  });

  describe('orphan uploads', () => {
    const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

    /** A completed upload of `context` created `ageMs` ago, with its blob; claimed when `owner` is given. */
    async function upload(context: string, ageMs: number, owner?: { type: string; id: string }): Promise<string> {
      const id = newId(NOW - ageMs);
      const data = new Uint8Array(randomBytes(64));
      await h.db
        .insertInto('files')
        .values({
          id,
          original_name: 'bukti.pdf',
          mime: 'application/pdf',
          size: data.byteLength,
          sha256: sha(data),
          context,
          owner_type: owner?.type ?? null,
          owner_id: owner?.id ?? null,
          access: 'staff',
          status: 'ok',
          created_at: NOW - ageMs,
          created_by: staff,
        })
        .execute();
      await localStorageDriver(dataDir).put(id, data, { size: data.byteLength, sha256: sha(data) });
      return id;
    }

    const present = async (id: string) =>
      (await h.db.selectFrom('files').select('id').where('id', '=', id).executeTakeFirst()) !== undefined && (await localStorageDriver(dataDir).stat(id)) !== null;

    it('an unclaimed evidence file 25 hours old is the reports housekeeping’s, never the catalogue’s; a claimed one stays', async () => {
      const evidence = await upload('accreditation.evidence', 25 * HOUR);
      const claimed = await upload('accreditation.evidence', 25 * HOUR, { type: 'accred_evidence', id: newId() });
      const young = await upload('accreditation.evidence', 23 * HOUR);
      await catalogHousekeeping();
      expect(await present(evidence)).toBe(true);
      await reportsHousekeeping();
      expect(await present(evidence)).toBe(false);
      expect(await present(claimed)).toBe(true);
      expect(await present(young)).toBe(true);
    });

    it('an unclaimed cover 25 hours old is the catalogue housekeeping’s, never the reports’', async () => {
      const cover = await upload('catalog.cover', 25 * HOUR);
      await reportsHousekeeping();
      expect(await present(cover)).toBe(true);
      await catalogHousekeeping();
      expect(await present(cover)).toBe(false);
    });
  });

  describe('runs whose job ended', () => {
    it('ends a running run whose job failed and a queued run 25 hours old whose job row is gone, and removes their folders; a live job’s run is untouched', async () => {
      const deadJob = await reportRun({ status: 'running', ageMs: 2 * HOUR, jobId: await jobRow('dead') });
      const goneJob = await reportRun({ status: 'queued', ageMs: 25 * HOUR, jobId: newId(NOW - 25 * HOUR) });
      const youngNoJob = await reportRun({ status: 'queued', ageMs: 23 * HOUR, jobId: newId(NOW - 23 * HOUR) });
      const live = await reportRun({ status: 'running', ageMs: 2 * HOUR, jobId: await jobRow('running') });
      for (const id of [deadJob, goneJob, youngNoJob, live]) await writeFile(reportWorkPath(dataDir, id, 'rows.ndjson'));
      await reportsHousekeeping();
      for (const id of [deadJob, goneJob]) {
        expect(await runStatus(id)).toEqual({ status: 'failed', error_code: 'abandoned', finished_at: NOW });
        expect(await exists(reportWorkDir(dataDir, id))).toBe(false);
      }
      for (const id of [youngNoJob, live]) {
        expect(await runStatus(id)).toMatchObject({ error_code: null, finished_at: null });
        expect(await exists(reportWorkDir(dataDir, id))).toBe(true);
      }
      expect((await runStatus(live))?.status).toBe('running');
      expect((await runStatus(youngNoJob))?.status).toBe('queued');
    });
  });

  describe('while the clock looks wrong', () => {
    it('the age-based steps do nothing (expired runs, report files, orphan uploads); the abandoned runs and the work folders still run', async () => {
      await withTx(h, (trx) => writeSettings(trx, { 'system.clock_anomaly': { detectedAt: NOW, maxSeen: NOW + DAY } }, { keyring: [], now: NOW, actorId: null }));
      const f = await twoWayFixture();
      const abandoned = await reportRun({ status: 'running', ageMs: 2 * HOUR, jobId: await jobRow('dead') });
      const abandonedWork = await writeFile(reportWorkPath(dataDir, abandoned, 'output.part'));
      const sha = createHash('sha256').update('bukti').digest('hex');
      const evidence = newId(NOW - 25 * HOUR);
      await h.db
        .insertInto('files')
        .values({ id: evidence, original_name: 'bukti.pdf', mime: 'application/pdf', size: 5, sha256: sha, context: 'accreditation.evidence', owner_type: null, owner_id: null, access: 'staff', status: 'ok', created_at: NOW - 25 * HOUR, created_by: staff })
        .execute();
      expect(await reportsHousekeeping()).toEqual({ status: 'succeeded', message: 'date_jobs_postponed' });
      expect(await exists(f.expiredFile)).toBe(true);
      expect(await runStatus(f.expired)).toMatchObject({ status: 'succeeded' });
      expect(await exists(f.orphanPdf)).toBe(true);
      expect((await h.db.selectFrom('files').select('owner_type').where('id', '=', evidence).executeTakeFirst())?.owner_type).toBeNull();
      expect(await exists(reportWorkDir(dataDir, f.failed))).toBe(false);
      expect(await runStatus(abandoned)).toMatchObject({ status: 'failed', error_code: 'abandoned' });
      expect(await exists(abandonedWork)).toBe(false);
      expect(await exists(f.runningWork)).toBe(true);
    });
  });
});
