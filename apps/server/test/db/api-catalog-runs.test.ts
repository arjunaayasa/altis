import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { catalogRunJobs, claimById, createJobRegistry, localStorageDriver, runSlice, type CatalogJobDeps } from '@altis/core';
import { PHASE1_MIGRATIONS, runMigrations } from '@altis/db';
import { exportFilePath } from '@altis/platform';
import { newId } from '@altis/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { createApp } from '../../src/app.js';
import { createAgent, type AgentReply } from '../agent.js';
import { recordingLogger, sampleConfig } from '../support.js';
import { seedStaff, sessionCookieFor, sessionCsrfFor } from '../support-auth.js';

// The catalog runs API of Phase 2 Task 19 (spec §3.3, §5.4, §12.2, §12.3; decision P2-27) on the engine picked by
// ALTIS_TEST_DB: the run list and views (a migration run is hidden from a viewer without `catalog.migration.run`), the
// report CSV, the export download (Range, `Content-Disposition: attachment`, one `catalog.export.download` entry per
// successful download, 410 CATALOG_RUN_EXPIRED once expired) and the start of a duplicate scan.

const ctx = testDbContext();
let h: TestDbHandle;

/** In the past: an audit entry may not be dated ahead of the real clock. */
const NOW = Date.UTC(2026, 9, 22, 9, 0, 5);
const DAY = 86_400_000;
const CONFIG = sampleConfig();
const SID = '__Host-altis_sid';
const RUNS = '/api/v1/catalog/runs';
const CONTENT = 'abcdefghijklmnopqrstuvwxyz';
const BOM = '\uFEFF';
const silent = { info() {}, warn() {}, error() {} };

interface Client {
  userId: string;
  token: string;
  get(p: string, headers?: Record<string, string>): Promise<AgentReply>;
  post(p: string, body?: unknown): Promise<AgentReply>;
}

const code = (res: AgentReply): string | undefined => (res.json as { code?: string } | undefined)?.code;

describe.skipIf(!ctx.available)(`catalog runs API [${engineLabel()}]`, () => {
  let dataDir: string;
  let app: ReturnType<typeof createApp>;
  const clock = { now: NOW };
  let exporter: Client;
  let reader: Client;
  let manager: Client;
  let migrator: Client;
  let buku: string;

  async function signedIn(username: string, permissions: string[]): Promise<Client> {
    const user = await seedStaff(h, { username, now: NOW, roles: [{ permissions: permissions as never }] });
    const token = await sessionCookieFor(h, user.id, { now: NOW });
    const agent = createAgent(app, { headers: { origin: CONFIG.baseUrl } });
    agent.setCookie(SID, token);
    const csrf = { 'x-csrf-token': sessionCsrfFor(CONFIG, token) };
    return {
      userId: user.id,
      token,
      get: (p, headers) => agent.get(p, undefined, headers),
      post: (p, body) => agent.post(p, body ?? {}, csrf),
    };
  }

  /** A run row as its job leaves it; its id. */
  async function runRow(o: {
    kind: 'import' | 'export' | 'migration' | 'dedupe_scan';
    status?: string;
    format?: string | null;
    outputName?: string | null;
    outputSize?: number | null;
    expiresAt?: number | null;
    createdAt?: number;
  }): Promise<string> {
    const createdAt = o.createdAt ?? NOW - DAY;
    const id = newId(createdAt);
    const live = o.status === 'queued' || o.status === 'running';
    await h.db
      .insertInto('catalog_runs')
      .values({
        id,
        kind: o.kind,
        status: o.status ?? 'succeeded',
        dry_run: 0,
        format: o.format ?? null,
        options: '{}',
        summary: '{}',
        report_file_id: null,
        output_name: o.outputName ?? null,
        output_size: o.outputSize ?? null,
        expires_at: o.expiresAt ?? null,
        job_id: null,
        created_at: createdAt,
        created_by: null,
        finished_at: live ? null : createdAt,
      })
      .execute();
    return id;
  }

  /** A finished `csv-records` export of {@link CONTENT}, expiring 7 days after NOW; its id. */
  async function exportRun(): Promise<string> {
    const id = await runRow({ kind: 'export', format: 'csv-records', outputName: 'ekspor.csv', outputSize: CONTENT.length, expiresAt: NOW + 7 * DAY });
    const file = exportFilePath(dataDir, id, 'csv');
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, CONTENT);
    return id;
  }

  /** The `catalog.export.download` entries of run `id`: actor and meta. */
  const downloads = async (id: string) =>
    (
      await h.db
        .selectFrom('audit_log')
        .select(['actor_id', 'entity', 'meta'])
        .where('action', '=', 'catalog.export.download')
        .where('entity_id', '=', id)
        .orderBy('seq')
        .execute()
    ).map((r) => ({ actor: r.actor_id, entity: r.entity, meta: JSON.parse(r.meta ?? 'null') as unknown }));

  /** A live record (title key, year, ISBN keys); its id. */
  async function record(title: string, year: string, isbns: string[] = [], key = title.toLowerCase()): Promise<string> {
    const id = newId();
    await h.db
      .insertInto('records')
      .values({
        id,
        material_type_id: buku,
        title,
        subtitle: null,
        responsibility: null,
        title_key: key,
        edition: null,
        material_detail: null,
        publisher_id: null,
        publication_place: null,
        publication_year: year,
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
        archived_at: null,
        created_at: NOW,
        created_by: null,
        updated_at: NOW,
        updated_by: null,
      })
      .execute();
    for (const [i, value] of isbns.entries()) {
      await h.db
        .insertInto('record_identifiers')
        .values({ id: newId(), record_id: id, type: 'isbn', value_display: value, value_key: value, qualifier: null, is_valid: 1, sort_order: i })
        .execute();
    }
    return id;
  }

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-api-runs-')));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(dataDir, 'migrations'), migrations: PHASE1_MIGRATIONS });
    buku = (await h.db.selectFrom('material_types').select('id').where('code_key', '=', 'BUKU').executeTakeFirstOrThrow()).id;
    app = createApp({ state: { phase: 'ready', db: h, config: CONFIG }, version: '0.1.0', buildId: 'b', log: recordingLogger(), clock: () => clock.now, dataDir });
    exporter = await signedIn('ekspor_katalog', ['catalog.export.run', 'catalog.records.read']);
    reader = await signedIn('baca_katalog', ['catalog.records.read']);
    manager = await signedIn('kelola_katalog', ['catalog.records.manage', 'catalog.records.read']);
    migrator = await signedIn('migrasi_katalog', ['catalog.migration.run', 'catalog.records.read']);
  });

  afterAll(async () => {
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    clock.now = NOW;
  });

  describe('GET catalog/runs/:id/download', () => {
    it('serves the file as an attachment with Range; one catalog.export.download {format, bytes} per successful download', async () => {
      const id = await exportRun();
      const full = await exporter.get(`${RUNS}/${id}/download`);
      expect(full.status, full.text).toBe(200);
      expect(full.text).toBe(CONTENT);
      expect(full.headers.get('content-type')).toMatch(/^text\/csv/);
      expect(full.headers.get('content-disposition')).toBe(`attachment; filename="altis-katalog-${id}.csv"; filename*=UTF-8''altis-katalog-${id}.csv`);
      expect(full.headers.get('content-length')).toBe(String(CONTENT.length));
      expect(full.headers.get('accept-ranges')).toBe('bytes');
      expect(full.headers.get('x-content-type-options')).toBe('nosniff');
      expect(full.headers.get('cache-control')).toBe('private, no-store');
      const etag = full.headers.get('etag');
      expect(etag).toBe(`"${id}-${CONTENT.length}"`);

      const part = await exporter.get(`${RUNS}/${id}/download`, { range: 'bytes=2-5' });
      expect(part.status).toBe(206);
      expect(part.text).toBe('cdef');
      expect(part.headers.get('content-range')).toBe(`bytes 2-5/${CONTENT.length}`);
      expect(part.headers.get('content-length')).toBe('4');
      const tail = await exporter.get(`${RUNS}/${id}/download`, { range: 'bytes=-3', 'if-range': etag! });
      expect([tail.status, tail.text]).toEqual([206, 'xyz']);
      // An If-Range of another version: the whole file.
      const other = await exporter.get(`${RUNS}/${id}/download`, { range: 'bytes=-3', 'if-range': '"lain"' });
      expect([other.status, other.text]).toEqual([200, CONTENT]);

      expect(await downloads(id)).toEqual([
        { actor: exporter.userId, entity: 'catalog_runs', meta: { format: 'csv-records', bytes: 26 } },
        { actor: exporter.userId, entity: 'catalog_runs', meta: { format: 'csv-records', bytes: 4 } },
        { actor: exporter.userId, entity: 'catalog_runs', meta: { format: 'csv-records', bytes: 3 } },
        { actor: exporter.userId, entity: 'catalog_runs', meta: { format: 'csv-records', bytes: 26 } },
      ]);

      // A range past the end: 416, nothing audited.
      const past = await exporter.get(`${RUNS}/${id}/download`, { range: 'bytes=100-' });
      expect([past.status, code(past)]).toEqual([416, 'RANGE_NOT_SATISFIABLE']);
      expect(await downloads(id)).toHaveLength(4);

      // From expires_at on: 410 CATALOG_RUN_EXPIRED, nothing audited.
      // (The run reaches its expiry rather than the clock moving on 7 days, which would end the session.)
      await h.db.updateTable('catalog_runs').set({ expires_at: NOW }).where('id', '=', id).execute();
      const gone = await exporter.get(`${RUNS}/${id}/download`);
      expect([gone.status, code(gone)]).toEqual([410, 'CATALOG_RUN_EXPIRED']);
      expect(await downloads(id)).toHaveLength(4);
    });

    it('no output file yet, a missing file, not an export → 404; without catalog.export.run → 403; HEAD and a cross-site request are refused', async () => {
      const running = await runRow({ kind: 'export', status: 'running', format: 'marc21' });
      expect([(await exporter.get(`${RUNS}/${running}/download`)).status]).toEqual([404]);
      const lost = await runRow({ kind: 'export', format: 'marc21', outputName: 'x.mrc', outputSize: 10, expiresAt: NOW + DAY });
      const missing = await exporter.get(`${RUNS}/${lost}/download`);
      expect([missing.status, code(missing)]).toEqual([404, 'NOT_FOUND']);
      const scan = await runRow({ kind: 'dedupe_scan' });
      expect((await exporter.get(`${RUNS}/${scan}/download`)).status).toBe(404);

      const id = await exportRun();
      const denied = await reader.get(`${RUNS}/${id}/download`);
      expect([denied.status, code(denied)]).toEqual([403, 'AUTHZ_DENIED']);
      const head = await app.request(`${RUNS}/${id}/download`, { method: 'HEAD', headers: { cookie: `${SID}=${exporter.token}`, origin: CONFIG.baseUrl } });
      expect(head.status).toBe(404);
      const cross = await exporter.get(`${RUNS}/${id}/download`, { origin: 'https://jahat.example' });
      expect([cross.status, code(cross)]).toEqual([403, 'ORIGIN_DENIED']);
      expect(await downloads(id)).toEqual([]);
      expect(await downloads(running)).toEqual([]);
    });

    it('an empty export file is served whole whatever the Range (no byte to range over): 200, no Content-Range', async () => {
      const id = await runRow({ kind: 'export', format: 'marc21', outputName: 'kosong.mrc', outputSize: 0, expiresAt: NOW + DAY });
      const file = exportFilePath(dataDir, id, 'mrc');
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, '');
      for (const range of ['bytes=-3', 'bytes=0-']) {
        const res = await exporter.get(`${RUNS}/${id}/download`, { range });
        expect([res.status, res.text], range).toEqual([200, '']);
        expect(res.headers.get('content-range'), range).toBeNull();
        expect(res.headers.get('content-length'), range).toBe('0');
      }
      expect(await downloads(id)).toEqual([
        { actor: exporter.userId, entity: 'catalog_runs', meta: { format: 'marc21', bytes: 0 } },
        { actor: exporter.userId, entity: 'catalog_runs', meta: { format: 'marc21', bytes: 0 } },
      ]);
    });
  });

  describe('runs, the report and the duplicate scan', () => {
    const deps = (): CatalogJobDeps => ({ dataDir, baseUrl: CONFIG.baseUrl, keyring: CONFIG.keyring, storage: localStorageDriver(dataDir), log: silent });

    /** Runs job `jobId` with the catalog run handlers until it ends; its last outcome. */
    async function runJob(jobId: string): Promise<string> {
      const reg = createJobRegistry(catalogRunJobs(deps));
      for (let i = 0; i < 20; i += 1) {
        const job = await claimById(h, reg, jobId, { worker: 'test', now: NOW });
        if (job === null) throw new Error('not claimable');
        const r = await runSlice(h, reg, job, { mode: 'worker', budgetMs: 20_000, keyring: CONFIG.keyring, log: silent, clock: () => NOW, env: {} });
        if (r.outcome !== 'continued') return r.outcome;
      }
      throw new Error('no end');
    }

    it('POST catalog/dedupe-scans → 202 {runId, jobId} (a second joins the live scan); the job groups; the report streams the CSV', async () => {
      const isbn = '9786020000001';
      const a = await record('Gadis Kretek', '2012', [isbn]);
      const b = await record('Gadis Kretek (edisi khusus)', '2015', [isbn], 'gadis kretek edisi khusus');
      const c = await record('Cantik Itu Luka', '2002');
      const d = await record('Cantik Itu Luka', '2002');
      const e = await record('Cantik Itu Luka', '2002');

      const denied = await reader.post('/api/v1/catalog/dedupe-scans');
      expect(denied.status).toBe(403);
      const res = await manager.post('/api/v1/catalog/dedupe-scans');
      expect(res.status, res.text).toBe(202);
      const started = res.json as { runId: string; jobId: string };
      expect(started).toEqual({ runId: expect.any(String), jobId: expect.any(String) });
      const again = await manager.post('/api/v1/catalog/dedupe-scans');
      expect([again.status, again.json]).toEqual([202, started]);
      // One run: the second request's run was dropped (the earlier tests' rows have no creator).
      expect(await h.db.selectFrom('catalog_runs').select('id').where('kind', '=', 'dedupe_scan').where('created_by', '=', manager.userId).execute()).toEqual([
        { id: started.runId },
      ]);
      const strict = await manager.post('/api/v1/catalog/dedupe-scans', { extra: 1 });
      expect([strict.status, code(strict)]).toEqual([422, 'VALIDATION_FAILED']);

      // Before the job ran: no report yet.
      expect((await reader.get(`${RUNS}/${started.runId}/report`)).status).toBe(404);
      expect(await runJob(started.jobId)).toBe('succeeded');

      const view = await reader.get(`${RUNS}/${started.runId}`);
      expect(view.status).toBe(200);
      expect(view.json).toMatchObject({
        id: started.runId,
        kind: 'dedupe_scan',
        status: 'succeeded',
        jobId: started.jobId,
        createdBy: manager.userId,
        summary: {
          groups: { isbn: 1, title_year: 1 },
          records: 5,
          preview: [
            { reason: 'isbn', recordIds: [a, b].sort() },
            { reason: 'title_year', recordIds: [c, d, e].sort() },
          ],
        },
      });

      const report = await reader.get(`${RUNS}/${started.runId}/report`);
      expect(report.status, report.text).toBe(200);
      expect(report.headers.get('content-type')).toMatch(/^text\/csv/);
      expect(report.headers.get('content-disposition')).toMatch(/^attachment; /);
      expect(report.headers.get('x-content-type-options')).toBe('nosniff');
      // The body starts with a BOM, which a text decoding drops: Content-Length counts its 3 bytes.
      expect(report.text.startsWith(`"group","reason","record_id","title","year","isbn"\r\n`)).toBe(true);
      const lines = report.text.split('\r\n').slice(1, -1);
      expect(lines).toHaveLength(5);
      expect(lines).toContain(`"1","isbn","${a}","Gadis Kretek","2012","${isbn}"`);
      expect(lines.filter((l) => l.startsWith('"2","title_year",'))).toHaveLength(3);
      expect(Number(report.headers.get('content-length'))).toBe(Buffer.byteLength(BOM + report.text, 'utf8'));
      // The report route audits nothing (a read).
      expect(await h.db.selectFrom('audit_log').select('seq').where('entity_id', '=', started.runId).execute()).toEqual([]);
    });

    it('a catalog.records.read holder lists runs without the migration run; GET of it and its report → 404; a migration holder sees it', async () => {
      const mig = await runRow({ kind: 'migration', createdAt: NOW - 2_000 });
      const imp = await runRow({ kind: 'import', format: 'marc21', createdAt: NOW - 1_000 });
      const list = await reader.get(`${RUNS}?limit=200`);
      expect(list.status).toBe(200);
      const ids = (list.json as { items: { id: string; kind: string }[] }).items.map((r) => r.id);
      expect(ids).toContain(imp);
      expect(ids).not.toContain(mig);
      expect((list.json as { items: { kind: string }[] }).items.some((r) => r.kind === 'migration')).toBe(false);
      expect((await reader.get(`${RUNS}?kind=migration`)).json).toEqual({ items: [], nextCursor: null });
      expect((await reader.get(`${RUNS}/${mig}`)).status).toBe(404);
      expect((await reader.get(`${RUNS}/${mig}/report`)).status).toBe(404);

      const all = await migrator.get(`${RUNS}?limit=200`);
      expect((all.json as { items: { id: string }[] }).items.map((r) => r.id)).toContain(mig);
      expect((await migrator.get(`${RUNS}/${mig}`)).json).toMatchObject({ id: mig, kind: 'migration' });

      const older = await runRow({ kind: 'import', format: 'csv-records', createdAt: NOW - 3_000 });
      const imports = await reader.get(`${RUNS}?kind=import&limit=1`);
      expect(imports.json).toMatchObject({ items: [{ id: imp, kind: 'import', format: 'marc21' }], nextCursor: expect.any(String) });
      const next = await reader.get(`${RUNS}?kind=import&limit=1&cursor=${(imports.json as { nextCursor: string }).nextCursor}`);
      expect(next.json).toMatchObject({ items: [{ id: older, kind: 'import' }], nextCursor: null });
      const bad = await reader.get(`${RUNS}?cursor=bukan-kursor`);
      expect([bad.status, code(bad)]).toEqual([422, 'VALIDATION_FAILED']);
      expect((await reader.get(`${RUNS}/${newId()}`)).status).toBe(404);
      expect((await reader.get(`${RUNS}/bukan-ulid`)).status).toBe(422);
    });
  });
});
