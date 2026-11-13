import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations, withTx } from '@altis/db';
import { reportExportPath } from '@altis/platform';
import { isDomainError, localDate, newId, t, type MessageKey, type Permission } from '@altis/shared';
import { REPORT_SCAN_PREVIEW_MAX_RECORDS, type ReportPreviewBody } from '@altis/shared/api/reports';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import type { CatalogJobDeps } from '../../src/catalog/jobs-deps.js';
import type { KeyringEntry } from '../../src/crypto/secret-box.js';
import { createJobRegistry } from '../../src/jobs/registry.js';
import type { JobHandler, JobRegistry } from '../../src/jobs/types.js';
import { reportsExportJob } from '../../src/reports/export/job.js';
import { reportColumn, reportParam } from '../../src/reports/params.js';
import { REPORTS, reportById } from '../../src/reports/registry.js';
import {
  getReportRun,
  listReportRuns,
  openReportRunDownload,
  previewReport,
  reportCatalogEntry,
  startReportRun,
  visibleReports,
  type ReportRunViewer,
} from '../../src/reports/runs/index.js';
import type { ReportDefinition, ReportRow, TableReport } from '../../src/reports/types.js';
import { loadAccredSettings, type AccredSettings } from '../../src/settings/accreditation.js';

// The report runs below the routes: which reports a user sees and may export, the paged preview (a report that scans
// the stock is refused above the record limit before any scan, and a scan that answers pages without rows is called
// again until rows come or its budget runs out), the start of a run (the definition's own strict schema, the stored
// `{def, pdf}`, its size limit, the row limits of XLSX and PDF before anything is written, the language of an
// accreditation file), the run views and the download's refusals and file name. On the engine picked by
// ALTIS_TEST_DB.

const ctx = testDbContext();
const NOW = Date.UTC(2026, 10, 14, 3, 0, 0);
const DAY = 86_400_000;
const keyring: KeyringEntry[] = [{ kid: 'k1', key: randomBytes(32).toString('base64url'), active: true }];
const silent = { info() {}, warn() {}, error() {} };

/** What a rejected promise rejected with: `{code, errors?, meta?}` for a DomainError; 'resolved' when it did not. */
async function failure(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => 'resolved',
    (e: unknown) => {
      if (!isDomainError(e)) throw e;
      const errors = e.meta?.['errors'];
      return { code: e.code, ...(errors === undefined ? {} : { errors }), ...(e.code === 'REPORT_TOO_LARGE' ? { meta: e.meta } : {}) };
    },
  );
}

/** A table report of `n` numbered rows with a strict schema, scanning the stock when `scan` says so. */
function localReport(o: { scan?: (params: Record<string, unknown>) => boolean; rows?: TableReport['rows']; totals?: TableReport['totals'] } = {}): TableReport {
  return {
    id: 'collection.local_test',
    module: 'collection',
    kind: 'table',
    titleKey: 'report.test.rows.title',
    permission: 'reports.statistics.read',
    personal: false,
    formats: ['csv', 'xlsx', 'pdf'],
    orientation: 'portrait',
    params: [reportParam('rows', 'int', { required: true, min: 0, max: 100 }), reportParam('asOf', 'asOf')],
    paramsSchema: z.strictObject({ rows: z.int().min(0).max(100), asOf: z.string().optional() }),
    columns: [reportColumn('n', 'int')],
    rows:
      o.rows ??
      (async (c, cursor, limit) => {
        const total = c.params['rows'] as number;
        const after = cursor === null ? 0 : Number(cursor);
        const last = Math.min(total, after + limit);
        const rows: ReportRow[] = [];
        for (let n = after + 1; n <= last; n += 1) rows.push([n]);
        return { rows, nextCursor: last < total ? String(last) : null };
      }),
    ...(o.totals === undefined ? {} : { totals: o.totals }),
    ...(o.scan === undefined ? {} : { scanBased: o.scan }),
  };
}

describe('the report catalogue a user sees', () => {
  const holder = (...held: Permission[]) => (p: Permission) => held.includes(p);

  it('the statistics permission sees the collection reports (and, in the test profile, the test ones), no accreditation one', () => {
    const ids = visibleReports(holder('reports.statistics.read')).map((d) => d.id);
    expect(ids.filter((id) => id.startsWith('collection.'))).toHaveLength(8);
    expect(ids.filter((id) => id.startsWith('accreditation.'))).toEqual([]);
    expect(ids.filter((id) => id.startsWith('test.'))).toEqual(['test.rows', 'test.personal', 'test.document']);
  });

  it('the accreditation workspace sees the ten annexes and the three documents, no collection report', () => {
    const defs = visibleReports(holder('accreditation.workspace.read'));
    expect(defs.filter((d) => d.kind === 'table').map((d) => d.id)).toHaveLength(10);
    expect(defs.filter((d) => d.kind === 'document').map((d) => d.id)).toEqual(['accreditation.dossier', 'accreditation.self_assessment', 'accreditation.statement_1000']);
    expect(defs.some((d) => d.module === 'collection')).toBe(false);
  });

  it('an entry exports only a table report whose export permission is held; columns null when the parameters shape them', () => {
    const rows = reportById('test.rows')!;
    expect(reportCatalogEntry(rows, holder('reports.statistics.read'))).toMatchObject({
      id: 'test.rows',
      kind: 'table',
      canExport: true,
      formats: ['csv', 'xlsx', 'pdf'],
      columns: [
        { key: 'n', labelKey: 'report.column.n', type: 'int' },
        { key: 'text', labelKey: 'report.column.text', type: 'text' },
        { key: 'amount', labelKey: 'report.column.amount', type: 'money' },
      ],
    });
    expect(reportCatalogEntry(rows, holder()).canExport).toBe(false);
    expect(reportCatalogEntry(reportById('test.document')!, holder('reports.statistics.read'))).toMatchObject({ kind: 'document', canExport: false, columns: null });
    const shaped = REPORTS.find((d) => d.kind === 'table' && typeof d.columns === 'function')!;
    expect(reportCatalogEntry(shaped, () => true).columns).toBeNull();
  });
});

describe.skipIf(!ctx.available)(`report runs [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;
  let dataDir: string;
  let registry: JobRegistry;
  let settings: AccredSettings;
  let staff: string;
  let other: string;
  let buku: string;
  const o = () => ({ locale: 'id' as const, tz: 'Asia/Jakarta', now: NOW, settings });

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-core-report-runs-')));
    dataDir = path.join(root, 'data');
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(root, 'migrations'), migrations: PHASE1_MIGRATIONS });
    const deps = (): CatalogJobDeps & { appVersion: string } => ({ dataDir, baseUrl: 'https://perpus.example.sch.id', keyring, storage: {} as never, log: silent, appVersion: '0.1.0' });
    registry = createJobRegistry([reportsExportJob(deps) as JobHandler<unknown>]);
    settings = await loadAccredSettings(h.db);
    staff = newId(NOW);
    other = newId(NOW);
    for (const [id, name] of [
      [staff, 'pustakawan'],
      [other, 'operator'],
    ] as const) {
      await h.db.insertInto('staff_users').values({ id, username_key: name, username_display: name, name, password_hash: 'x', status: 'active', created_at: NOW, updated_at: NOW }).execute();
    }
    buku = (await h.db.selectFrom('material_types').select('id').where('code_key', '=', 'BUKU').executeTakeFirstOrThrow()).id;
  });

  afterAll(async () => {
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Exactly `n` live records (and one archived one, which never counts). */
  async function liveRecords(n: number): Promise<void> {
    await h.db.deleteFrom('records').execute();
    const rows = Array.from({ length: n + 1 }, (_, i) => ({
      id: newId(NOW),
      material_type_id: buku,
      title: `Judul ${i}`,
      title_key: `judul ${i}`,
      changed_at: NOW,
      archived_at: i === n ? NOW : null,
      created_at: NOW,
      updated_at: NOW,
    }));
    for (let i = 0; i < rows.length; i += 250) await h.db.insertInto('records').values(rows.slice(i, i + 250)).execute();
  }

  const preview = (def: ReportDefinition, body: ReportPreviewBody) => previewReport(h.db, def, body, o());

  describe('previewReport', () => {
    it('pages a table report: its columns, the rows from the cursor, the next cursor, the totals on the first page only', async () => {
      const totals = vi.fn(async () => ['total', 3] as ReportRow);
      const def = localReport({ totals });
      expect(await preview(def, { params: { rows: 3 }, limit: 2 })).toEqual({
        columns: [{ key: 'n', labelKey: 'report.column.n', type: 'int' }],
        rows: [[1], [2]],
        nextCursor: '2',
        totals: ['total', 3],
      });
      expect(await preview(def, { params: { rows: 3 }, cursor: '2', limit: 2 })).toEqual({
        columns: [{ key: 'n', labelKey: 'report.column.n', type: 'int' }],
        rows: [[3]],
        nextCursor: null,
        totals: null,
      });
      expect(totals).toHaveBeenCalledTimes(1);
    });

    it('refuses parameters the definition refuses, at params.<name>, and a document report as not previewable', async () => {
      expect(await failure(preview(localReport(), { params: { rows: -1 } }))).toMatchObject({ code: 'VALIDATION_FAILED', errors: [{ path: 'params.rows' }] });
      expect(await failure(preview(localReport(), { params: { rows: 1, extra: true } }))).toMatchObject({ code: 'VALIDATION_FAILED', errors: [{ path: 'params' }] });
      expect(await failure(preview(reportById('test.document')!, { params: {} }))).toEqual({
        code: 'VALIDATION_FAILED',
        errors: [{ path: 'reportId', code: 'not_previewable' }],
      });
    });

    it(`a scan-based report over ${REPORT_SCAN_PREVIEW_MAX_RECORDS} live records is export-only, refused before any scan`, async () => {
      await liveRecords(REPORT_SCAN_PREVIEW_MAX_RECORDS + 1);
      const rows = vi.fn(async () => ({ rows: [[1]] as ReportRow[], nextCursor: null }));
      expect(await failure(preview(localReport({ scan: () => true, rows }), { params: { rows: 1 } }))).toEqual({
        code: 'VALIDATION_FAILED',
        errors: [{ path: 'params', code: 'export_only' }],
      });
      expect(rows).not.toHaveBeenCalled();
      // The same report without its scan (the live stock: an `asOf` of today is no scan) is answered.
      const today = localDate('Asia/Jakarta', NOW);
      const scanAsOf = (p: Record<string, unknown>) => p['asOf'] !== undefined;
      expect((await preview(localReport({ scan: scanAsOf, rows }), { params: { rows: 1, asOf: today } })).rows).toEqual([[1]]);
      expect(await failure(preview(localReport({ scan: scanAsOf, rows }), { params: { rows: 1, asOf: '2025-12-31' } }))).toMatchObject({
        errors: [{ path: 'params', code: 'export_only' }],
      });
    });

    it('up to the limit a scan-based report is answered: a page without rows while its scan runs is followed by its rows', async () => {
      const one = await h.db.selectFrom('records').select('id').where('archived_at', 'is', null).executeTakeFirstOrThrow();
      await h.db.updateTable('records').set({ archived_at: NOW }).where('id', '=', one.id).execute();
      const atLimit = vi.fn(async () => ({ rows: [[1]] as ReportRow[], nextCursor: null }));
      expect((await preview(localReport({ scan: () => true, rows: atLimit }), { params: { rows: 1 } })).rows).toEqual([[1]]);
      await liveRecords(3);
      const cursors: (string | null)[] = [];
      const rows: TableReport['rows'] = async (_c, cursor) => {
        cursors.push(cursor);
        return cursor === null ? { rows: [], nextCursor: 'scan' } : { rows: [[1], [2], [3]], nextCursor: null };
      };
      expect(await preview(localReport({ scan: () => true, rows }), { params: { rows: 3 } })).toMatchObject({ rows: [[1], [2], [3]], nextCursor: null });
      expect(cursors).toEqual([null, 'scan']);
    });

    it('a scan that does not bring rows within the budget is export-only', async () => {
      await liveRecords(3);
      let clock = 0;
      vi.spyOn(performance, 'now').mockImplementation(() => (clock += 3_000));
      const rows = vi.fn(async () => ({ rows: [] as ReportRow[], nextCursor: 'scan' }));
      expect(await failure(preview(localReport({ scan: () => true, rows }), { params: { rows: 3 } }))).toEqual({
        code: 'VALIDATION_FAILED',
        errors: [{ path: 'params', code: 'export_only' }],
      });
      expect(rows.mock.calls.length).toBeGreaterThan(0);
      expect(rows.mock.calls.length).toBeLessThan(5);
    });

    it('a page whose cursor is too long to come back in a preview body is export-only', async () => {
      const rows = async () => ({ rows: [[1]] as ReportRow[], nextCursor: 'x'.repeat(1025) });
      expect(await failure(preview(localReport({ rows }), { params: { rows: 1 } }))).toMatchObject({ errors: [{ path: 'params', code: 'export_only' }] });
    });
  });

  describe('startReportRun', () => {
    beforeEach(async () => {
      await h.db.deleteFrom('report_runs').execute();
      await h.db.deleteFrom('jobs').execute();
    });

    const start = (def: ReportDefinition, x: { format: 'csv' | 'xlsx' | 'pdf' | 'zip'; params: Record<string, unknown>; pdf?: { paper: 'A4' | 'F4' }; locale?: 'id' | 'en' }) =>
      withTx(h, (trx) => startReportRun(trx, def, { locale: x.locale ?? 'id', createdBy: staff, now: NOW, registry, keyring, ...x }));

    const runRow = (id: string) => h.db.selectFrom('report_runs').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    const runCount = async () => (await h.db.selectFrom('report_runs').select('id').execute()).length;

    it('a strict definition takes the body its schema allows; the run stores {def, pdf} and queues its export job', async () => {
      const started = await start(localReport(), { format: 'pdf', params: { rows: 5 }, pdf: { paper: 'F4' }, locale: 'en' });
      const run = await runRow(started.id);
      expect(JSON.parse(run.params)).toEqual({ def: { rows: 5 }, pdf: { paper: 'F4' } });
      expect(run).toMatchObject({
        report_id: 'collection.local_test',
        format: 'pdf',
        locale: 'en',
        personal: 0,
        status: 'queued',
        job_id: started.jobId,
        created_by: staff,
        expires_at: null,
        finished_at: null,
      });
      expect(Number(run.created_at)).toBe(NOW);
      const job = await h.db.selectFrom('jobs').select(['type', 'payload', 'unique_key', 'created_by']).where('id', '=', started.jobId).executeTakeFirstOrThrow();
      expect({ ...job, payload: JSON.parse(job.payload) as unknown }).toEqual({ type: 'reports.export', payload: { runId: started.id }, unique_key: null, created_by: staff });
    });

    it('two runs of the same report are two runs with two jobs', async () => {
      const a = await start(localReport(), { format: 'csv', params: { rows: 1 } });
      const b = await start(localReport(), { format: 'csv', params: { rows: 1 } });
      expect(new Set([a.id, b.id, a.jobId, b.jobId]).size).toBe(4);
    });

    it('a personal definition stores personal 1; an accreditation one is stored Indonesian whatever the requester reads', async () => {
      const personal = await start(reportById('test.personal')!, { format: 'csv', params: {}, locale: 'en' });
      expect(await runRow(personal.id)).toMatchObject({ personal: 1, locale: 'en' });
      const annex = await start(reportById('accreditation.annex.budgets')!, { format: 'xlsx', params: { periodId: newId() }, locale: 'en' });
      expect(await runRow(annex.id)).toMatchObject({ personal: 0, locale: 'id' });
    });

    it('a document definition starts too (its own routes use this function)', async () => {
      const doc = await start(reportById('test.document')!, { format: 'zip', params: {} });
      expect(await runRow(doc.id)).toMatchObject({ report_id: 'test.document', format: 'zip', status: 'queued' });
    });

    it('refuses a format the definition lacks, its own parameter errors, and nothing is written', async () => {
      expect(await failure(start(reportById('test.document')!, { format: 'csv', params: {} }))).toEqual({ code: 'VALIDATION_FAILED', errors: [{ path: 'format', code: 'invalid_value' }] });
      expect(await failure(start(localReport(), { format: 'csv', params: { rows: 'lima' } }))).toMatchObject({ errors: [{ path: 'params.rows' }] });
      expect(await runCount()).toBe(0);
    });

    it('over the row limit of its format (PDF 10 000, XLSX 100 000): REPORT_TOO_LARGE {rows, max, format} and no run', async () => {
      const rows = reportById('test.rows')!;
      expect(await failure(start(rows, { format: 'pdf', params: { rows: 10_001 } }))).toEqual({ code: 'REPORT_TOO_LARGE', meta: { rows: 10_001, max: 10_000, format: 'pdf' } });
      expect(await failure(start(rows, { format: 'xlsx', params: { rows: 100_001 } }))).toEqual({ code: 'REPORT_TOO_LARGE', meta: { rows: 100_001, max: 100_000, format: 'xlsx' } });
      expect(await runCount()).toBe(0);
      // At the limit, a CSV of any size, and a count the definition cannot give, start.
      await start(rows, { format: 'pdf', params: { rows: 10_000 } });
      await start(rows, { format: 'csv', params: { rows: 100_001 } });
      await start(rows, { format: 'pdf', params: { rows: 10_001, countless: true } });
      expect(await runCount()).toBe(3);
    });

    it('stored parameters over 8 000 bytes of JSON are too big; 8 000 bytes are not', async () => {
      const rows = reportById('test.rows')!;
      expect(await failure(start(rows, { format: 'csv', params: { rows: 5, texts: textsOfStoredBytes(8_001) } }))).toEqual({
        code: 'VALIDATION_FAILED',
        errors: [{ path: 'params', code: 'too_big' }],
      });
      expect(await runCount()).toBe(0);
      const ok = await start(rows, { format: 'csv', params: { rows: 5, texts: textsOfStoredBytes(8_000) } });
      expect(Buffer.byteLength((await runRow(ok.id)).params)).toBe(8_000);
    });
  });

  describe('the run views', () => {
    const viewer = (staffId: string, seeAll = false): ReportRunViewer => ({ staffId, seeAll });
    let mine: string;
    let theirs: string;

    beforeAll(async () => {
      await h.db.deleteFrom('report_runs').execute();
      mine = await seedRun({ createdBy: staff, status: 'succeeded', at: NOW - 2_000, params: { def: { rows: 5 }, pdf: { paper: 'F4' }, warnings: ['test_warning'] }, format: 'pdf' });
      theirs = await seedRun({ createdBy: other, status: 'succeeded', at: NOW - 1_000, params: { def: { rows: 7 } }, format: 'csv' });
    });

    async function seedRun(x: { createdBy: string; status: string; at: number; params: unknown; format: string; personal?: boolean; expiresAt?: number | null }): Promise<string> {
      const id = newId(x.at);
      await h.db
        .insertInto('report_runs')
        .values({
          id,
          report_id: 'test.rows',
          format: x.format,
          locale: 'id',
          params: JSON.stringify(x.params),
          personal: x.personal === true ? 1 : 0,
          status: x.status,
          row_count: 5,
          non_latin_rows: 0,
          output_name: `${id}.${x.format}`,
          output_size: null,
          error_code: null,
          job_id: null,
          expires_at: x.expiresAt === undefined ? x.at + 7 * DAY : x.expiresAt,
          created_at: x.at,
          created_by: x.createdBy,
          finished_at: x.at,
        })
        .execute();
      return id;
    }

    it('the creator sees their run in full; the jobs permission sees another’s without its parameters, never downloadable', async () => {
      expect(await getReportRun(h.db, mine, viewer(staff))).toMatchObject({
        id: mine,
        mine: true,
        params: { rows: 5 },
        paper: 'F4',
        warnings: ['test_warning'],
        downloadable: true,
      });
      expect(await getReportRun(h.db, mine, viewer(other, true))).toMatchObject({ id: mine, mine: false, params: null, paper: null, warnings: [], downloadable: false });
      expect(await failure(getReportRun(h.db, mine, viewer(other)))).toMatchObject({ code: 'NOT_FOUND' });
    });

    it('lists the viewer’s own runs, or every run (scope all) with the jobs permission, newest first and in pages', async () => {
      expect((await listReportRuns(h.db, viewer(staff), {})).runs.map((r) => r.id)).toEqual([mine]);
      expect((await listReportRuns(h.db, viewer(staff), { scope: 'all' })).runs.map((r) => r.id)).toEqual([mine]);
      const first = await listReportRuns(h.db, viewer(other, true), { scope: 'all', limit: '1' });
      expect(first.runs.map((r) => [r.id, r.mine])).toEqual([[theirs, true]]);
      const second = await listReportRuns(h.db, viewer(other, true), { scope: 'all', limit: '1', cursor: first.nextCursor! });
      expect([second.runs.map((r) => [r.id, r.params]), second.nextCursor]).toEqual([[[mine, null]], null]);
      expect((await listReportRuns(h.db, viewer(other, true), { scope: 'all', reportId: 'test.personal' })).runs).toEqual([]);
      expect(await failure(listReportRuns(h.db, viewer(staff), { cursor: 'bukan-kursor' }))).toEqual({ code: 'VALIDATION_FAILED', errors: [{ path: 'cursor', code: 'invalid' }] });
    });

    describe('openReportRunDownload', () => {
      const all = () => true;
      const download = (id: string, x: { staffId?: string; seeAll?: boolean; reauthFresh?: boolean; holds?: (p: Permission) => boolean; now?: number } = {}) =>
        openReportRunDownload(h.db, id, { staffId: x.staffId ?? staff, seeAll: x.seeAll ?? false, reauthFresh: x.reauthFresh ?? false, holds: x.holds ?? all }, x.now ?? NOW, dataDir);

      async function placeFile(id: string, ext: 'csv' | 'pdf', content: string): Promise<void> {
        const file = reportExportPath(dataDir, id, ext);
        await fsp.mkdir(path.dirname(file), { recursive: true });
        await fsp.writeFile(file, content);
      }

      it('serves the creator the file, named by the report title in the run language and the day it was asked for', async () => {
        await placeFile(mine, 'pdf', '%PDF-1.4 laporan');
        expect(await download(mine)).toEqual({
          path: reportExportPath(dataDir, mine, 'pdf'),
          size: 16,
          fileName: `${localTitle('id')}-${localDate('Asia/Jakarta', NOW - 2_000)}.pdf`,
          mime: 'application/pdf',
          runId: mine,
          reportId: 'test.rows',
          format: 'pdf',
        });
      });

      it('refuses another staff member, the creator without the export permission, a stale personal run, a missing or expired file', async () => {
        await placeFile(theirs, 'csv', 'n\r\n1\r\n');
        expect(await failure(download(theirs, { seeAll: true }))).toMatchObject({ code: 'AUTHZ_DENIED' });
        expect(await failure(download(theirs))).toMatchObject({ code: 'NOT_FOUND' });
        expect(await failure(download(mine, { holds: () => false }))).toMatchObject({ code: 'AUTHZ_DENIED' });
        const personal = await seedRun({ createdBy: staff, status: 'succeeded', at: NOW, params: { def: {} }, format: 'csv', personal: true });
        await placeFile(personal, 'csv', 'nama\r\n');
        expect(await failure(download(personal))).toMatchObject({ code: 'AUTH_REAUTH_REQUIRED' });
        expect((await download(personal, { reauthFresh: true })).runId).toBe(personal);
        const running = await seedRun({ createdBy: staff, status: 'running', at: NOW, params: { def: {} }, format: 'csv', expiresAt: null });
        expect(await failure(download(running))).toMatchObject({ code: 'NOT_FOUND' });
        const missing = await seedRun({ createdBy: staff, status: 'succeeded', at: NOW, params: { def: {} }, format: 'csv' });
        expect(await failure(download(missing))).toMatchObject({ code: 'NOT_FOUND' });
        expect(await failure(download(mine, { now: NOW - 2_000 + 7 * DAY }))).toMatchObject({ code: 'REPORT_RUN_EXPIRED' });
        expect(await failure(download(newId()))).toMatchObject({ code: 'NOT_FOUND' });
      });
    });
  });
});

/** The title of `test.rows` in `locale`. */
function localTitle(locale: 'id' | 'en'): string {
  return t(locale, 'report.test.rows.title' as MessageKey);
}

/**
 * `texts` of `test.rows` whose stored parameters `{"def":{"rows":5,"texts":[…]}}` are exactly `bytes` bytes of JSON:
 * strings of 200 three-byte characters, then one ASCII string that makes up the rest.
 */
function textsOfStoredBytes(bytes: number): string[] {
  const size = (texts: string[]) => Buffer.byteLength(JSON.stringify({ def: { rows: 5, texts } }));
  const wide = '字'.repeat(200);
  const narrow = 'a'.repeat(200);
  const texts: string[] = [];
  while (size([...texts, wide, '']) <= bytes) texts.push(wide);
  while (size([...texts, narrow, '']) <= bytes) texts.push(narrow);
  const rest = bytes - size([...texts, '']);
  texts.push(rest > 200 ? `字${'a'.repeat(rest - 3)}` : 'a'.repeat(rest));
  expect(size(texts)).toBe(bytes);
  expect(texts.length).toBeLessThanOrEqual(20);
  return texts;
}
