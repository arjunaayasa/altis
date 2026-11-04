import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { newId } from '@altis/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import type { HousekeepingStepContext } from '../../src/catalog/housekeeping.js';
import type { CatalogJobDeps } from '../../src/catalog/jobs-deps.js';
import { dedupeScanJob, startDedupeScan } from '../../src/catalog/runs/dedupe-scan.js';
import { expiredExportsStep } from '../../src/catalog/runs/housekeeping.js';
import { catalogRunJobs } from '../../src/catalog/runs/jobs.js';
import { getRunView, listRuns, runExportFile, runReportFile } from '../../src/catalog/runs/queries.js';
import type { CoreLogger } from '../../src/context.js';
import type { KeyringEntry } from '../../src/crypto/secret-box.js';
import { localStorageDriver } from '../../src/files/serve.js';
import { claimById } from '../../src/jobs/claim.js';
import { createJobRegistry } from '../../src/jobs/registry.js';
import { runSlice } from '../../src/jobs/slice.js';
import type { JobRegistry } from '../../src/jobs/types.js';
import { SEARCH_TOKEN_VERSION } from '../../src/search/tokenize.js';
import { DAY, NOW, STAFF, openRecordsDb, type RecordsDb } from './catalog-records-support.js';

// Catalog runs and the duplicate scan (Phase 2 Task 19; spec §3.3, §5.4, §12.2; S2, S3; decision P2-27) on the engine
// picked by ALTIS_TEST_DB:
// - the run views: a migration run is hidden from a viewer without `catalog.migration.run`; newest first, by keyset;
// - `catalog.dedupe_scan`: groups by ISBN and by title key + year (no fuzzy matching) over live records, sliced by
//   keyset over the group keys, resumable after a kill, with a CSV report and a summary preview;
// - the housekeeping step `expired_exports`: expired export files, leftover export files, finished runs' work folders,
//   and runs whose job ended long ago without them.

const ctx = testDbContext();
const keyring: KeyringEntry[] = [{ kid: 'k1', key: randomBytes(32).toString('base64url'), active: true }];
const silent: CoreLogger = { info() {}, warn() {}, error() {} };
const HOUR = 3_600_000;
const BOM = '\uFEFF';

describe.skipIf(!ctx.available)(`catalog runs and the duplicate scan [${engineLabel()}]`, () => {
  let db: RecordsDb;
  let deps: () => CatalogJobDeps;
  let buku: string;

  beforeAll(async () => {
    db = await openRecordsDb('catalog-runs');
    deps = () => ({ dataDir: db.dataDir, baseUrl: 'https://perpus.example.sch.id', keyring, storage: localStorageDriver(db.dataDir), log: silent });
    buku = await db.materialTypeId('BUKU');
  });

  afterAll(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    for (const table of ['catalog_runs', 'jobs', 'locks', 'record_identifiers', 'files'] as const) await db.h.db.deleteFrom(table).execute();
    await db.h.db.deleteFrom('records').execute();
  });

  // ---------------------------------------------------------------------------------------------------------------
  // Seeding

  /** A record with `title` (its key given), `year` and the ISBN keys `isbns`; archived when asked. Its id. */
  async function record(o: { title: string; key?: string; year?: string | null; isbns?: string[]; archived?: boolean }): Promise<string> {
    const id = newId();
    await db.h.db
      .insertInto('records')
      .values({
        id,
        material_type_id: buku,
        title: o.title,
        subtitle: null,
        responsibility: null,
        title_key: o.key ?? o.title.toLowerCase(),
        edition: null,
        material_detail: null,
        publisher_id: null,
        publication_place: null,
        publication_year: o.year ?? null,
        publication_date_text: null,
        physical_desc: null,
        series: null,
        classification: null,
        call_number: null,
        language_id: null,
        content_type: null,
        media_type: null,
        carrier_type: null,
        summary: null,
        notes: null,
        cover_file_id: null,
        source: 'manual',
        merged_into: null,
        changed_at: NOW,
        archived_at: o.archived === true ? NOW : null,
        created_at: NOW,
        created_by: null,
        updated_at: NOW,
        updated_by: null,
      })
      .execute();
    for (const [i, key] of (o.isbns ?? []).entries()) {
      await db.h.db
        .insertInto('record_identifiers')
        .values({ id: newId(), record_id: id, type: 'isbn', value_display: key, value_key: key, qualifier: null, is_valid: 1, sort_order: i })
        .execute();
    }
    return id;
  }

  /** A run row as its job leaves it. Its id. */
  async function runRow(o: {
    kind: 'import' | 'export' | 'migration' | 'dedupe_scan';
    status?: string;
    createdAt?: number;
    finishedAt?: number | null;
    dryRun?: boolean;
    format?: string | null;
    outputName?: string | null;
    outputSize?: number | null;
    expiresAt?: number | null;
    jobId?: string | null;
    reportFileId?: string | null;
    summary?: Record<string, unknown>;
  }): Promise<string> {
    const createdAt = o.createdAt ?? NOW;
    const id = newId(createdAt);
    await db.h.db
      .insertInto('catalog_runs')
      .values({
        id,
        kind: o.kind,
        status: o.status ?? 'succeeded',
        dry_run: o.dryRun === true ? 1 : 0,
        format: o.format ?? null,
        options: JSON.stringify({ note: 'opsi' }),
        summary: JSON.stringify(o.summary ?? {}),
        report_file_id: o.reportFileId ?? null,
        output_name: o.outputName ?? null,
        output_size: o.outputSize ?? null,
        expires_at: o.expiresAt ?? null,
        job_id: o.jobId ?? null,
        created_at: createdAt,
        created_by: STAFF,
        finished_at: o.finishedAt === undefined ? (o.status === 'queued' || o.status === 'running' ? null : createdAt) : o.finishedAt,
      })
      .execute();
    return id;
  }

  /** A job row of `status`, finished at `finishedAt` when terminal. Its id. */
  async function jobRow(status: string, finishedAt: number | null = null): Promise<string> {
    const id = newId();
    await db.h.db
      .insertInto('jobs')
      .values({
        id,
        type: 'catalog.import',
        payload: '{}',
        status,
        run_at: NOW,
        max_attempts: 5,
        created_at: NOW - 10 * DAY,
        updated_at: finishedAt ?? NOW,
        finished_at: finishedAt,
      })
      .execute();
    return id;
  }

  const exists = (p: string) =>
    fsp.stat(p).then(
      () => true,
      () => false,
    );

  /** Writes `exports/<name>` with `content`; its path. */
  async function exportFile(name: string, content = 'judul,tahun\r\n'): Promise<string> {
    const file = path.join(db.dataDir, 'exports', name);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, content);
    return file;
  }

  /** Writes `tmp/<id>/import.bin`; the folder. */
  async function workFolder(id: string): Promise<string> {
    const dir = path.join(db.dataDir, 'tmp', id);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'import.bin'), 'x');
    return dir;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // The run views

  describe('listRuns and getRunView (P2-27)', () => {
    it('a viewer without catalog.migration.run sees no migration run: not in the list, 404 alone', async () => {
      const imp = await runRow({ kind: 'import', createdAt: NOW - 3 * HOUR, format: 'marc21', summary: { created: 3 } });
      const mig = await runRow({ kind: 'migration', createdAt: NOW - 2 * HOUR });
      const exp = await runRow({ kind: 'export', createdAt: NOW - HOUR, format: 'csv-records', outputName: 'x.csv', outputSize: 12, expiresAt: NOW + DAY });

      const reader = await listRuns(db.h.db, { limit: 50 }, { migration: false });
      expect(reader.items.map((r) => r.id)).toEqual([exp, imp]);
      expect(reader.nextCursor).toBeNull();
      const migrator = await listRuns(db.h.db, { limit: 50 }, { migration: true });
      expect(migrator.items.map((r) => r.id)).toEqual([exp, mig, imp]);
      expect(await listRuns(db.h.db, { kind: 'migration', limit: 50 }, { migration: false })).toEqual({ items: [], nextCursor: null });
      expect((await listRuns(db.h.db, { kind: 'migration', limit: 50 }, { migration: true })).items.map((r) => r.id)).toEqual([mig]);

      await expect(getRunView(db.h.db, mig, { migration: false })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect((await getRunView(db.h.db, mig, { migration: true })).kind).toBe('migration');
      await expect(getRunView(db.h.db, newId(), { migration: true })).rejects.toMatchObject({ code: 'NOT_FOUND' });

      expect(await getRunView(db.h.db, imp, { migration: false })).toEqual({
        id: imp,
        kind: 'import',
        status: 'succeeded',
        dryRun: false,
        format: 'marc21',
        options: { note: 'opsi' },
        summary: { created: 3 },
        reportFileId: null,
        outputName: null,
        outputSize: null,
        expiresAt: null,
        jobId: null,
        jobStatus: null,
        createdAt: NOW - 3 * HOUR,
        createdBy: STAFF,
        finishedAt: NOW - 3 * HOUR,
      });
      expect(await getRunView(db.h.db, exp, { migration: false })).toMatchObject({ outputName: 'x.csv', outputSize: 12, expiresAt: NOW + DAY });
    });

    it('C17: a run carries its job\'s status (null without a job row), so a live run whose job ended shows as no longer live', async () => {
      const queued = await runRow({ kind: 'migration', status: 'queued', createdAt: NOW - 3 * HOUR, jobId: await jobRow('queued') });
      const cancelled = await runRow({ kind: 'migration', status: 'running', createdAt: NOW - 2 * HOUR, jobId: await jobRow('cancelled', NOW - HOUR) });
      const gone = await runRow({ kind: 'import', status: 'running', createdAt: NOW - HOUR, jobId: newId(NOW - HOUR) });
      const listed = await listRuns(db.h.db, { limit: 50 }, { migration: true });
      expect(listed.items.map((r) => [r.id, r.jobStatus])).toEqual([
        [gone, null],
        [cancelled, 'cancelled'],
        [queued, 'queued'],
      ]);
      const migrations = await listRuns(db.h.db, { kind: 'migration', limit: 1 }, { migration: true });
      expect(migrations.items.map((r) => [r.id, r.jobStatus])).toEqual([[cancelled, 'cancelled']]);
      const next = await listRuns(db.h.db, { kind: 'migration', limit: 1, cursor: migrations.nextCursor! }, { migration: true });
      expect(next.items.map((r) => [r.id, r.jobStatus])).toEqual([[queued, 'queued']]);
      expect((await getRunView(db.h.db, cancelled, { migration: true })).jobStatus).toBe('cancelled');
      expect((await getRunView(db.h.db, gone, { migration: true })).jobStatus).toBeNull();
    });

    it('newest first by keyset (created_at, id), with the kind filter; a cursor that does not parse → VALIDATION_FAILED', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 5; i += 1) ids.push(await runRow({ kind: i % 2 === 0 ? 'import' : 'dedupe_scan', createdAt: NOW - (10 - i) * HOUR }));
      // Two runs at the same instant: the id breaks the tie.
      const same = [await runRow({ kind: 'import', createdAt: NOW }), await runRow({ kind: 'import', createdAt: NOW })].sort();
      const newestFirst = [same[1]!, same[0]!, ...[...ids].reverse()];

      const pages: string[][] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = await listRuns(db.h.db, { limit: 3, ...(cursor === undefined ? {} : { cursor }) }, { migration: false });
        pages.push(page.items.map((r) => r.id));
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      }
      expect(pages).toEqual([newestFirst.slice(0, 3), newestFirst.slice(3, 6), newestFirst.slice(6)]);
      const scans = await listRuns(db.h.db, { kind: 'dedupe_scan', limit: 50 }, { migration: false });
      expect(scans.items.map((r) => r.id)).toEqual([ids[3], ids[1]]);

      for (const bad of ['x', '12.nope', `-1.${ids[0]}`, `1.${ids[0]}.2`]) {
        await expect(listRuns(db.h.db, { limit: 3, cursor: bad }, { migration: false })).rejects.toMatchObject({
          code: 'VALIDATION_FAILED',
          meta: { errors: [{ path: 'cursor', code: 'invalid' }] },
        });
      }
    });

    it('runReportFile: the run’s own staff CSV; none, another owner’s file or a hidden migration → NOT_FOUND', async () => {
      const fileOf = async (ownerId: string): Promise<string> => {
        const id = newId();
        await db.h.db
          .insertInto('files')
          .values({ id, original_name: `report-${ownerId}.csv`, mime: 'text/csv', size: 10, sha256: 'a'.repeat(64), context: 'catalog.report', owner_type: 'catalog_runs', owner_id: ownerId, access: 'staff', status: 'ok', created_at: NOW, created_by: null })
          .execute();
        return id;
      };
      const run = await runRow({ kind: 'dedupe_scan' });
      const file = await fileOf(run);
      await db.h.db.updateTable('catalog_runs').set({ report_file_id: file }).where('id', '=', run).execute();
      expect(await runReportFile(db.h.db, run, { migration: false })).toEqual({ fileId: file, originalName: `report-${run}.csv`, size: 10 });

      const none = await runRow({ kind: 'dedupe_scan' });
      await expect(runReportFile(db.h.db, none, { migration: false })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      const foreign = await runRow({ kind: 'import', reportFileId: await fileOf(none) });
      await expect(runReportFile(db.h.db, foreign, { migration: false })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      const mig = await runRow({ kind: 'migration' });
      await db.h.db.updateTable('catalog_runs').set({ report_file_id: await fileOf(mig) }).where('id', '=', mig).execute();
      await expect(runReportFile(db.h.db, mig, { migration: false })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect((await runReportFile(db.h.db, mig, { migration: true })).size).toBe(10);
    });

    it('runExportFile: an export with its file → format and extension; expired → CATALOG_RUN_EXPIRED; no file yet or not an export → NOT_FOUND', async () => {
      const csv = await runRow({ kind: 'export', format: 'csv-items', outputName: 'a.csv', outputSize: 99, expiresAt: NOW + DAY });
      expect(await runExportFile(db.h.db, csv, NOW)).toEqual({ runId: csv, format: 'csv-items', ext: 'csv', size: 99 });
      for (const [format, ext] of [
        ['marc21', 'mrc'],
        ['marcxml', 'xml'],
        ['marcjson', 'jsonl'],
        ['csv-records', 'csv'],
      ] as const) {
        const id = await runRow({ kind: 'export', format, outputName: 'f', outputSize: 1, expiresAt: NOW + DAY });
        expect((await runExportFile(db.h.db, id, NOW)).ext, format).toBe(ext);
      }
      // expires_at is the end: at that instant the file is gone (410), whether or not housekeeping removed it yet.
      await expect(runExportFile(db.h.db, csv, NOW + DAY)).rejects.toMatchObject({ code: 'CATALOG_RUN_EXPIRED' });
      const removed = await runRow({ kind: 'export', format: 'marc21', outputName: null, outputSize: 5, expiresAt: NOW - HOUR });
      await expect(runExportFile(db.h.db, removed, NOW)).rejects.toMatchObject({ code: 'CATALOG_RUN_EXPIRED' });
      const running = await runRow({ kind: 'export', status: 'running', format: 'marc21' });
      await expect(runExportFile(db.h.db, running, NOW)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      // Only a succeeded export's file is served, whatever its row names.
      const failed = await runRow({ kind: 'export', status: 'failed', format: 'marc21', outputName: 'f.mrc', outputSize: 5, expiresAt: NOW + DAY });
      await expect(runExportFile(db.h.db, failed, NOW)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      const scan = await runRow({ kind: 'dedupe_scan', outputName: 'x', expiresAt: NOW + DAY });
      await expect(runExportFile(db.h.db, scan, NOW)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(runExportFile(db.h.db, newId(), NOW)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  // The duplicate scan

  describe('catalog.dedupe_scan', () => {
    const registry = (o?: { rangeRows?: number }): JobRegistry => createJobRegistry([dedupeScanJob(deps, o)]);

    /** Starts a scan as the staff actor; `{runId, jobId}`. */
    const start = (reg: JobRegistry) => db.run((tx) => startDedupeScan(tx, reg, { keyring }));

    /** Claims job `id` and runs one slice of `budgetMs`; its outcome. */
    async function slice(reg: JobRegistry, id: string, budgetMs = 20_000): Promise<string> {
      const job = await claimById(db.h, reg, id, { worker: 'test', now: NOW });
      if (job === null) throw new Error(`job ${id} cannot be claimed`);
      const r = await runSlice(db.h, reg, job, { mode: 'worker', budgetMs, keyring, log: silent, clock: () => NOW, env: {} });
      return r.outcome;
    }

    /** Runs job `id` to its end; how many slices it took. */
    async function runToEnd(reg: JobRegistry, id: string, budgetMs = 20_000): Promise<number> {
      for (let n = 1; n <= 200; n += 1) {
        const outcome = await slice(reg, id, budgetMs);
        if (outcome !== 'continued') {
          expect(outcome).toBe('succeeded');
          return n;
        }
      }
      throw new Error('no end after 200 slices');
    }

    /** The report CSV of run `runId`, read through its stored file. */
    async function reportOf(runId: string): Promise<string> {
      const { fileId } = await runReportFile(db.h.db, runId, { migration: false });
      const stream = await deps().storage.get(fileId);
      if (stream === null) throw new Error('no report content');
      const parts: Buffer[] = [];
      for await (const part of stream) parts.push(Buffer.from(part));
      return Buffer.concat(parts).toString('utf8');
    }

    /** The data rows of a report (header and the BOM checked). */
    function rowsOf(csv: string): string[][] {
      expect(csv.startsWith(`${BOM}"group","reason","record_id","title","year","isbn"\r\n`)).toBe(true);
      const lines = csv.slice(BOM.length).split('\r\n').slice(1, -1);
      return lines.map((line) => line.slice(1, -1).split('","'));
    }

    /** The seeded catalogue: 2 records with one ISBN, 3 with one title + year, and records that must not group. */
    async function seedCatalogue() {
      const isbn = '9789799731234';
      const a = await record({ title: 'Bumi Manusia', year: '1980', isbns: [isbn] });
      const b = await record({ title: 'Bumi Manusia (cetak ulang)', key: 'bumi manusia cetak ulang', year: '2005', isbns: [isbn, '9780000000002'] });
      const c = await record({ title: 'Laskar Pelangi', year: '2005', isbns: ['9789793062792'] });
      const d = await record({ title: 'Laskar  Pelangi', key: 'laskar pelangi', year: '2005' });
      const e = await record({ title: '=Laskar Pelangi', key: 'laskar pelangi', year: '2005' });
      // Not grouped: another year, an archived record (ISBN and title), records without a year.
      await record({ title: 'Laskar Pelangi', year: '2008' });
      await record({ title: 'Bumi Manusia', year: '1980', isbns: [isbn], archived: true });
      await record({ title: 'Laskar Pelangi', year: '2005', archived: true });
      await record({ title: 'Ronggeng Dukuh Paruk', year: null });
      await record({ title: 'Ronggeng Dukuh Paruk', year: null });
      return { isbn, a, b, c, d, e };
    }

    it('2 records with one ISBN and 3 with one title + year → 2 groups, a 5-row report, the summary and the preview', async () => {
      const s = await seedCatalogue();
      const reg = registry();
      const { runId, jobId } = await start(reg);
      const queued = await db.h.db.selectFrom('catalog_runs').selectAll().where('id', '=', runId).executeTakeFirstOrThrow();
      expect(queued).toMatchObject({ kind: 'dedupe_scan', status: 'queued', job_id: jobId, created_by: STAFF });
      const job = await db.h.db.selectFrom('jobs').select(['type', 'unique_key', 'created_by', 'payload']).where('id', '=', jobId).executeTakeFirstOrThrow();
      expect(job).toMatchObject({ type: 'catalog.dedupe_scan', unique_key: 'catalog.dedupe_scan', created_by: STAFF });
      expect(JSON.parse(job.payload)).toEqual({ runId });

      expect(await runToEnd(reg, jobId)).toBe(1);
      const view = await getRunView(db.h.db, runId, { migration: false });
      expect(view).toMatchObject({ status: 'succeeded', finishedAt: NOW, reportFileId: expect.any(String) });
      expect(view.summary).toEqual({
        groups: { isbn: 1, title_year: 1 },
        records: 5,
        preview: [
          { reason: 'isbn', recordIds: [s.a, s.b].sort() },
          { reason: 'title_year', recordIds: [s.c, s.d, s.e].sort() },
        ],
      });
      const rows = rowsOf(await reportOf(runId));
      expect(rows).toHaveLength(5);
      const byId = (id: string) => rows.find((r) => r[2] === id);
      expect(byId(s.a)).toEqual(['1', 'isbn', s.a, 'Bumi Manusia', '1980', s.isbn]);
      expect(byId(s.b)).toEqual(['1', 'isbn', s.b, 'Bumi Manusia (cetak ulang)', '2005', s.isbn]);
      expect(byId(s.c)).toEqual(['2', 'title_year', s.c, 'Laskar Pelangi', '2005', '9789793062792']);
      expect(byId(s.d)).toEqual(['2', 'title_year', s.d, 'Laskar  Pelangi', '2005', '']);
      // A title that starts like a formula is neutralised by csvCell.
      expect(byId(s.e)).toEqual(['2', 'title_year', s.e, "'=Laskar Pelangi", '2005', '']);
      // The work folder is gone with the scan.
      expect(await exists(path.join(db.dataDir, 'tmp', runId))).toBe(false);
    });

    it('sliced by keyset over the group keys (one range per slice) → the same groups and report', async () => {
      await seedCatalogue();
      // More groups than ranges of one row: every ISBN key and title key is its own range.
      for (let i = 0; i < 4; i += 1) {
        const key = `97800000001${i}0`;
        await record({ title: `Seri ${i}`, year: '2010', isbns: [key] });
        await record({ title: `Seri ${i} jilid`, key: `seri ${i} jilid`, year: '2011', isbns: [key] });
      }
      const reg = registry({ rangeRows: 1 });
      const { runId, jobId } = await start(reg);
      const slices = await runToEnd(reg, jobId, 1);
      expect(slices).toBeGreaterThan(10);
      const view = await getRunView(db.h.db, runId, { migration: false });
      expect(view.summary).toMatchObject({ groups: { isbn: 5, title_year: 1 }, records: 13 });
      const rows = rowsOf(await reportOf(runId));
      expect(rows).toHaveLength(13);
      expect([...new Set(rows.map((r) => r[0]))]).toEqual(['1', '2', '3', '4', '5', '6']);
      expect(rows.filter((r) => r[1] === 'title_year')).toHaveLength(3);
    });

    it('resumes after a kill: bytes past the checkpoint are cut, a work file shorter than it restarts the scan', async () => {
      await seedCatalogue();
      const reg = registry({ rangeRows: 1 });
      const { runId, jobId } = await start(reg);
      // A few slices, then bytes a killed slice wrote after its last checkpoint.
      for (let i = 0; i < 4; i += 1) expect(await slice(reg, jobId, 1)).toBe('continued');
      const work = path.join(db.dataDir, 'tmp', runId, 'groups.ndjson');
      await fsp.appendFile(work, '["99","isbn","X","Sisa","1999",""]\n');
      expect(await slice(reg, jobId, 1)).toBe('continued');
      // A work file that lost bytes the checkpoint counts (a crash of the machine): the scan starts again.
      await fsp.truncate(work, 3);
      await runToEnd(reg, jobId, 1);
      const rows = rowsOf(await reportOf(runId));
      expect(rows).toHaveLength(5);
      expect(rows.some((r) => r[2] === 'X')).toBe(false);
      expect((await getRunView(db.h.db, runId, { migration: false })).summary).toMatchObject({ groups: { isbn: 1, title_year: 1 }, records: 5 });
    });

    it('a second start while a scan is live joins it (one run, one job); a cancel ends the run cancelled', async () => {
      await seedCatalogue();
      const reg = registry({ rangeRows: 1 });
      const first = await start(reg);
      const second = await start(reg);
      expect(second).toEqual(first);
      expect(await db.h.db.selectFrom('catalog_runs').select('id').execute()).toEqual([{ id: first.runId }]);

      expect(await slice(reg, first.jobId, 1)).toBe('continued');
      expect((await getRunView(db.h.db, first.runId, { migration: false })).status).toBe('running');
      await db.h.db.updateTable('jobs').set({ cancel_requested: 1 }).where('id', '=', first.jobId).execute();
      expect(await slice(reg, first.jobId, 1)).toBe('cancelled');
      const view = await getRunView(db.h.db, first.runId, { migration: false });
      expect(view).toMatchObject({ status: 'cancelled', finishedAt: NOW, reportFileId: null });
      expect(await exists(path.join(db.dataDir, 'tmp', first.runId))).toBe(false);
      // The key is free again: a new scan is a new run.
      const third = await start(reg);
      expect(third.runId).not.toBe(first.runId);
    });

    it('the handler: catalog.dedupe_scan, catalog.records.manage, heavy, driven from the page; catalogRunJobs lists it', () => {
      expect(dedupeScanJob(deps)).toMatchObject({
        type: 'catalog.dedupe_scan',
        permission: 'catalog.records.manage',
        retryable: 'origin-only',
        cpuHeavy: true,
        interactive: true,
      });
      expect(catalogRunJobs(deps).map((j) => j.type)).toEqual(['catalog.dedupe_scan']);
    });

    it('a slice of a run that ended meanwhile (or is gone) does nothing and succeeds', async () => {
      const reg = registry();
      const { runId, jobId } = await start(reg);
      await db.h.db.updateTable('catalog_runs').set({ status: 'failed', finished_at: NOW }).where('id', '=', runId).execute();
      expect(await runToEnd(reg, jobId)).toBe(1);
      expect((await getRunView(db.h.db, runId, { migration: false })).status).toBe('failed');
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  // The housekeeping step

  describe('the housekeeping step expired_exports (§5.4, S2)', () => {
    /** Runs the step from `cursor` with `budgetMs` left; its answer. */
    function step(now: number, cursor: string | null = null, budgetMs = 20_000) {
      const c: HousekeepingStepContext = {
        h: db.h,
        now,
        deps: deps(),
        cursor,
        budgetLeftMs: () => budgetMs,
        enqueue: async () => {
          throw new Error('the step queues nothing');
        },
      };
      return expiredExportsStep.run(c);
    }

    const runOf = (id: string) => db.h.db.selectFrom('catalog_runs').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

    it('removes an expired export file (output_name → null), keeps a live one; removes the work folder of a run that failed 8 days ago, not that of a dry run that succeeded 2 days ago', async () => {
      const now = NOW;
      const expired = await runRow({ kind: 'export', format: 'csv-records', createdAt: now - 8 * DAY, outputName: 'e.csv', outputSize: 13, expiresAt: now - HOUR });
      const expiredFile = await exportFile(`${expired}.csv`);
      const live = await runRow({ kind: 'export', format: 'marc21', createdAt: now - DAY, outputName: 'l.mrc', outputSize: 13, expiresAt: now + 6 * DAY });
      const liveFile = await exportFile(`${live}.mrc`);
      const failed = await runRow({ kind: 'import', status: 'failed', createdAt: now - 9 * DAY, finishedAt: now - 8 * DAY });
      const failedDir = await workFolder(failed);
      const dry = await runRow({ kind: 'import', status: 'succeeded', dryRun: true, createdAt: now - 3 * DAY, finishedAt: now - 2 * DAY });
      const dryDir = await workFolder(dry);
      const runningJob = await jobRow('running');
      const running = await runRow({ kind: 'import', status: 'running', createdAt: now - 20 * DAY, jobId: runningJob });
      const runningDir = await workFolder(running);
      // A tmp folder no run names (an upload session's): not this step's.
      const upload = newId(now - 30 * DAY);
      const uploadDir = await workFolder(upload);

      expect(await step(now)).toEqual({ done: true, cursor: null });
      expect(await exists(expiredFile)).toBe(false);
      expect(await runOf(expired)).toMatchObject({ output_name: null, output_size: null, expires_at: now - HOUR, status: 'succeeded' });
      expect(await exists(liveFile)).toBe(true);
      expect(await runOf(live)).toMatchObject({ output_name: 'l.mrc', output_size: 13 });
      expect(await exists(failedDir)).toBe(false);
      expect(await exists(dryDir)).toBe(true);
      expect(await exists(runningDir)).toBe(true);
      expect(await exists(uploadDir)).toBe(true);

      // Idempotent: a second pass changes nothing more.
      expect(await step(now)).toEqual({ done: true, cursor: null });
      expect(await exists(liveFile)).toBe(true);
      expect(await exists(dryDir)).toBe(true);
    });

    it('leftover export files: a finished export without output, or one no run names (after 24 h), goes; a running export keeps its file', async () => {
      const now = NOW;
      const failed = await runRow({ kind: 'export', status: 'failed', format: 'marcxml', createdAt: now - 2 * DAY, finishedAt: now - DAY });
      const failedFile = await exportFile(`${failed}.xml`);
      const running = await runRow({ kind: 'export', status: 'running', format: 'marcxml', createdAt: now - HOUR, jobId: await jobRow('running') });
      const runningFile = await exportFile(`${running}.xml`);
      const orphanOld = await exportFile(`${newId(now - 2 * DAY)}.csv`);
      const orphanNew = await exportFile(`${newId(now - HOUR)}.csv`);
      const stranger = await exportFile('catatan.txt');

      expect(await step(now)).toEqual({ done: true, cursor: null });
      expect(await exists(failedFile)).toBe(false);
      expect(await exists(runningFile)).toBe(true);
      expect(await exists(orphanOld)).toBe(false);
      expect(await exists(orphanNew)).toBe(true);
      expect(await exists(stranger)).toBe(true);
    });

    it('a live run whose job ended more than 7 days ago is ended (dead → failed, cancelled → cancelled), then its folder goes; a recent end is left', async () => {
      const now = NOW;
      const deadOld = await runRow({ kind: 'import', status: 'running', createdAt: now - 20 * DAY, jobId: await jobRow('dead', now - 8 * DAY), summary: { read: 400 } });
      const deadOldDir = await workFolder(deadOld);
      const cancelledOld = await runRow({ kind: 'migration', status: 'queued', createdAt: now - 20 * DAY, jobId: await jobRow('cancelled', now - 9 * DAY) });
      const deadNew = await runRow({ kind: 'import', status: 'running', createdAt: now - 3 * DAY, jobId: await jobRow('dead', now - DAY) });
      const deadNewDir = await workFolder(deadNew);
      const lost = await runRow({ kind: 'import', status: 'queued', createdAt: now - 8 * DAY, jobId: newId(now - 8 * DAY) });
      const fresh = await runRow({ kind: 'import', status: 'queued', createdAt: now - HOUR, jobId: newId(now - HOUR) });

      expect(await step(now)).toEqual({ done: true, cursor: null });
      expect(await runOf(deadOld)).toMatchObject({ status: 'failed', finished_at: now - 8 * DAY, summary: JSON.stringify({ read: 400 }) });
      expect(await exists(deadOldDir)).toBe(false);
      expect(await runOf(cancelledOld)).toMatchObject({ status: 'cancelled', finished_at: now - 9 * DAY });
      expect(await runOf(deadNew)).toMatchObject({ status: 'running', finished_at: null });
      expect(await exists(deadNewDir)).toBe(true);
      // A job that is gone: ended at the time of this pass, its folder kept 7 days from now.
      expect(await runOf(lost)).toMatchObject({ status: 'failed', finished_at: now });
      expect(await runOf(fresh)).toMatchObject({ status: 'queued', finished_at: null });
    });

    it('C17: a migration run whose job ended (cancelled while queued, dead) is ended at once: its finish audited, the index ready, its folder gone', async () => {
      const now = NOW;
      const cancelledJob = await jobRow('cancelled', now - HOUR);
      const cancelled = await runRow({ kind: 'migration', status: 'running', createdAt: now - 2 * HOUR, jobId: cancelledJob });
      const cancelledDir = await workFolder(cancelled);
      const dead = await runRow({ kind: 'migration', status: 'queued', dryRun: true, createdAt: now - 3 * HOUR, jobId: await jobRow('dead', now - 2 * HOUR) });
      const importDead = await runRow({ kind: 'import', status: 'running', createdAt: now - 3 * HOUR, jobId: await jobRow('dead', now - 2 * HOUR) });
      const liveJob = await jobRow('queued');
      const live = await runRow({ kind: 'migration', status: 'running', createdAt: now - HOUR, jobId: liveJob });
      await db.h.db.deleteFrom('search_state').execute();
      // As the run's take recorded it (pipeline.ts): its index held documents of this token format.
      await db.h.db.insertInto('search_state').values({ id: 1, status: 'building', docs: 0, job_id: cancelledJob, built_at: null, token_version: SEARCH_TOKEN_VERSION }).execute();
      const seq = Number((await db.h.db.selectFrom('audit_head').select('last_seq').executeTakeFirstOrThrow()).last_seq);

      expect(await step(now)).toEqual({ done: true, cursor: null });
      expect(await runOf(cancelled)).toMatchObject({ status: 'cancelled', finished_at: now - HOUR });
      expect(await exists(cancelledDir)).toBe(false);
      expect(await runOf(dead)).toMatchObject({ status: 'failed', finished_at: now - 2 * HOUR });
      // An import keeps its 7 days (its dead job can be retried through the API); a live job's run stays live.
      expect(await runOf(importDead)).toMatchObject({ status: 'running', finished_at: null });
      expect(await runOf(live)).toMatchObject({ status: 'running', finished_at: null });
      expect(await db.h.db.selectFrom('search_state').select(['status', 'job_id', 'built_at', 'token_version']).execute()).toEqual([
        { status: 'ready', job_id: null, built_at: now, token_version: SEARCH_TOKEN_VERSION },
      ]);
      const entries = await db.h.db.selectFrom('audit_log').select(['action', 'actor_type', 'entity_id', 'meta']).where('seq', '>', seq).orderBy('seq').execute();
      expect(entries.map((e) => [e.action, e.actor_type, e.entity_id, JSON.parse(e.meta).status])).toEqual(
        [
          ['catalog.migration.finish', 'system', cancelled, 'cancelled'],
          ['catalog.migration.finish', 'system', dead, 'failed'],
        ].sort((a, b) => (a[2]! < b[2]! ? -1 : 1)),
      );
      // Idempotent: a second pass ends nothing more and audits nothing more.
      expect(await step(now)).toEqual({ done: true, cursor: null });
      expect(await db.h.db.selectFrom('audit_log').select('seq').where('seq', '>', seq).execute()).toHaveLength(2);
    });

    it('stops when the budget runs out with a cursor of its phase, and the next call continues from it', async () => {
      const now = NOW;
      const files: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const id = await runRow({ kind: 'export', format: 'csv-records', createdAt: now - 8 * DAY, outputName: 'o.csv', outputSize: 13, expiresAt: now - HOUR });
        files.push(await exportFile(`${id}.csv`));
      }
      const dirs: string[] = [];
      for (let i = 0; i < 3; i += 1) dirs.push(await workFolder(await runRow({ kind: 'import', status: 'failed', createdAt: now - 10 * DAY, finishedAt: now - 9 * DAY })));

      let answer = await step(now, null, 0);
      const cursors: string[] = [];
      for (let n = 0; !answer.done; n += 1) {
        expect(n).toBeLessThan(50);
        expect(typeof answer.cursor).toBe('string');
        expect(answer.cursor!.length).toBeLessThanOrEqual(1024);
        cursors.push(answer.cursor!);
        answer = await step(now, answer.cursor, 0);
      }
      expect(cursors.length).toBeGreaterThanOrEqual(5);
      for (const f of files) expect(await exists(f)).toBe(false);
      for (const d of dirs) expect(await exists(d)).toBe(false);
      // A cursor this step did not write (another release's phase) starts it over: nothing is left to do.
      expect(await step(now, 'nonsense:x')).toEqual({ done: true, cursor: null });
    });

    it('writes no audit entry (housekeeping, not an action of anyone)', async () => {
      const before = await db.h.db.selectFrom('audit_log').select('seq').execute();
      const id = await runRow({ kind: 'export', format: 'csv-records', outputName: 'o.csv', outputSize: 1, expiresAt: NOW - HOUR });
      await exportFile(`${id}.csv`);
      await step(NOW);
      expect((await runOf(id)).output_name).toBeNull();
      expect(await db.h.db.selectFrom('audit_log').select('seq').execute()).toHaveLength(before.length);
    });
  });
});
