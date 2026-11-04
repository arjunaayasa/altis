import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { claimById, createJobRegistry, exchangeJobs, localStorageDriver, runSlice, type CatalogJobDeps, type CoreLogger } from '@altis/core';
import { PHASE1_MIGRATIONS, runMigrations } from '@altis/db';
import { newId, normalizeKey, type Permission } from '@altis/shared';
import type { MarcJsonRecord } from '@altis/shared/api/catalog/exchange';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { createApp } from '../../src/app.js';
import { createAgent, type AgentReply } from '../agent.js';
import { recordingLogger, sampleConfig } from '../support.js';
import { seedStaff, sessionCookieFor, sessionCsrfFor, type SeedRole } from '../support-auth.js';

// The import, export and single-record MARC routes of Phase 2 Task 31 (spec §5.3, §5.4, §12.2, §12.3; S3, S11, M9) on
// the engine picked by ALTIS_TEST_DB:
// - an import takes the caller's staged upload (another user's → `uploadId` not_found) and answers 202 RunStarted; the
//   file is the run's `import.bin` after the COMMIT;
// - S3: a dry run, then `{fromRunId, dryRun: false}` → the real run reads the same `import.bin` without a new upload;
//   adopting it again, or another user's dry run → `{path: 'fromRunId', code: 'not_found'}`;
// - S11: `createItems` at a branch where the caller lacks `catalog.items.manage` → 403;
// - an export answers 202 RunStarted; the MARC of one record as ISO 2709, MARCXML or one MarcJsonRecord.

const ctx = testDbContext();
let h: TestDbHandle;

/** In the past: an audit entry may not be dated ahead of the real clock. */
const NOW = Date.UTC(2026, 9, 30, 10, 0, 0);
const CONFIG = sampleConfig();
const SID = '__Host-altis_sid';
const silent: CoreLogger = { info() {}, warn() {}, error() {} };
const CSV = 'title;year\r\nImpor Lewat API;2026\r\nKedua Lewat API;2025\r\n';

interface Client {
  userId: string;
  get(p: string): Promise<AgentReply>;
  post(p: string, body?: unknown): Promise<AgentReply>;
}

const code = (res: AgentReply): string | undefined => (res.json as { code?: string } | undefined)?.code;
const errors = (res: AgentReply): { path: string; code: string }[] => (res.json as { errors?: { path: string; code: string }[] }).errors ?? [];

describe.skipIf(!ctx.available)(`catalog import/export API [${engineLabel()}]`, () => {
  let dataDir: string;
  let app: ReturnType<typeof createApp>;
  let owner: Client;
  let other: Client;
  let branchA: string;
  let branchB: string;
  const deps = (): CatalogJobDeps => ({ dataDir, baseUrl: CONFIG.baseUrl, keyring: CONFIG.keyring, storage: localStorageDriver(dataDir), log: silent });
  const registry = createJobRegistry(exchangeJobs(deps));

  async function signedIn(username: string, roles: SeedRole[]): Promise<Client> {
    const user = await seedStaff(h, { username, now: NOW, roles });
    const token = await sessionCookieFor(h, user.id, { now: NOW, reauthAt: NOW });
    const agent = createAgent(app);
    agent.setCookie(SID, token);
    const csrf = { 'x-csrf-token': sessionCsrfFor(CONFIG, token) };
    return { userId: user.id, get: (p) => agent.get(p, undefined, csrf), post: (p, body) => agent.post(p, body, csrf) };
  }

  /** A completed `catalog.import` upload of `userId` holding `bytes`, as files/uploads/:id/complete leaves it. */
  async function stagedUpload(userId: string, bytes: Uint8Array): Promise<string> {
    const id = newId(NOW);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    await h.db
      .insertInto('upload_sessions')
      .values({ id, owner: `staff:${userId}`, context: 'catalog.import', size: bytes.byteLength, sha256, chunk_size: 262_144, received: bytes.byteLength, expires_at: NOW + 86_400_000 })
      .execute();
    await fsp.mkdir(path.join(dataDir, 'tmp', id), { recursive: true });
    await fsp.writeFile(path.join(dataDir, 'tmp', id, 'upload.bin'), bytes);
    await fsp.writeFile(path.join(dataDir, 'tmp', id, '.complete'), JSON.stringify({ size: bytes.byteLength, sha256, mime: 'text/plain' }));
    return id;
  }

  /** Claims and runs job `id` until it ends (as any process would). */
  async function runToEnd(id: string): Promise<string> {
    for (let i = 0; i < 100; i += 1) {
      const job = await claimById(h, registry, id, { worker: 'test', now: NOW });
      if (job === null) throw new Error(`job ${id} cannot be claimed`);
      const r = await runSlice(h, registry, job, { mode: 'worker', budgetMs: 20_000, keyring: CONFIG.keyring, log: silent, clock: () => NOW, env: {} });
      if (r.outcome !== 'continued') return r.outcome;
    }
    throw new Error('no end');
  }

  const run = (id: string) => h.db.selectFrom('catalog_runs').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
  const options = (o: Record<string, unknown> = {}) => ({ matchOn: 'none', onMatch: 'skip', onDuplicate: 'report', createItems: false, dryRun: true, ...o });
  const exists = async (...p: string[]): Promise<boolean> =>
    fsp.stat(path.join(dataDir, ...p)).then(
      () => true,
      () => false,
    );

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-api-exchange-')));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(dataDir, 'migrations'), migrations: PHASE1_MIGRATIONS });
    branchA = newId(NOW);
    branchB = newId(NOW);
    for (const [id, code] of [
      [branchA, 'PUSAT'],
      [branchB, 'CABANG'],
    ] as const) {
      await h.db.insertInto('branches').values({ id, code_key: code, code_display: code, name: `Cabang ${code}`, timezone: 'Asia/Jakarta', created_at: NOW, updated_at: NOW }).execute();
    }
    app = createApp({ state: { phase: 'ready', db: h, config: CONFIG }, version: '0.1.0', buildId: 'b', log: recordingLogger(), clock: () => NOW, dataDir });
    owner = await signedIn('kepala_impor', [{ key: 'super_admin' }]);
    other = await signedIn('wakil_impor', [{ key: 'super_admin' }]);
  }, 60_000);

  afterAll(async () => {
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    for (const table of ['jobs', 'locks', 'catalog_runs', 'migration_map', 'items'] as const) await h.db.deleteFrom(table).execute();
    await h.db.deleteFrom('records').execute();
  });

  it('an import takes the staged upload → 202 RunStarted, `catalog.import.start` once; the file is the run’s import.bin', async () => {
    const uploadId = await stagedUpload(owner.userId, Buffer.from(CSV, 'utf8'));
    const res = await owner.post('/api/v1/catalog/imports', { uploadId, ...options() });
    expect(res.status, res.text).toBe(202);
    const { runId, jobId } = res.json as { runId: string; jobId: string };
    expect((await run(runId)).job_id).toBe(jobId);
    expect(await h.db.selectFrom('upload_sessions').select('id').where('id', '=', uploadId).execute()).toEqual([]);
    expect(await exists('tmp', runId, 'import.bin')).toBe(true);
    expect(await exists('tmp', uploadId)).toBe(false);
    const audit = await h.db.selectFrom('audit_log').select(['actor_id', 'meta']).where('action', '=', 'catalog.import.start').where('entity_id', '=', runId).execute();
    expect(audit.map((a) => a.actor_id)).toEqual([owner.userId]);
    expect(JSON.parse(audit[0]!.meta ?? '{}')).toMatchObject({ dryRun: true, format: null, matchOn: 'none', createItems: false, adoptedFrom: null });

    expect(await runToEnd(jobId)).toBe('succeeded');
    expect(await run(runId)).toMatchObject({ status: 'succeeded', format: 'csv-records', dry_run: 1 });
  });

  it('another user’s upload, a missing one, or both uploadId and fromRunId → 422 with the field', async () => {
    const theirs = await stagedUpload(other.userId, Buffer.from(CSV, 'utf8'));
    const res = await owner.post('/api/v1/catalog/imports', { uploadId: theirs, ...options() });
    expect([res.status, code(res), errors(res)]).toEqual([422, 'VALIDATION_FAILED', [{ path: 'uploadId', code: 'not_found' }]]);
    const both = await owner.post('/api/v1/catalog/imports', { uploadId: theirs, fromRunId: newId(NOW), ...options() });
    expect([both.status, errors(both)]).toEqual([422, [{ path: 'fromRunId', code: 'exclusive' }]]);
    const neither = await owner.post('/api/v1/catalog/imports', options());
    expect([neither.status, errors(neither)]).toEqual([422, [{ path: 'uploadId', code: 'required' }]]);
  });

  it('S3: a dry run, then {fromRunId, dryRun: false} reads the same import.bin without a new upload; once only, own runs only', async () => {
    const uploadId = await stagedUpload(owner.userId, Buffer.from(CSV, 'utf8'));
    const dry = await owner.post('/api/v1/catalog/imports', { uploadId, ...options() });
    expect(dry.status, dry.text).toBe(202);
    const dryRun = dry.json as { runId: string; jobId: string };
    expect(await runToEnd(dryRun.jobId)).toBe('succeeded');
    expect(await h.db.selectFrom('records').select('id').execute()).toEqual([]);

    // Another user cannot adopt it.
    const stranger = await other.post('/api/v1/catalog/imports', { fromRunId: dryRun.runId, ...options({ dryRun: false }) });
    expect([stranger.status, errors(stranger)]).toEqual([422, [{ path: 'fromRunId', code: 'not_found' }]]);

    const real = await owner.post('/api/v1/catalog/imports', { fromRunId: dryRun.runId, ...options({ dryRun: false }) });
    expect(real.status, real.text).toBe(202);
    const realRun = real.json as { runId: string; jobId: string };
    expect(await exists('tmp', realRun.runId, 'import.bin')).toBe(true);
    expect(await exists('tmp', dryRun.runId)).toBe(false);
    expect(JSON.parse((await run(realRun.runId)).options)).toMatchObject({ adoptedFrom: dryRun.runId, stagingId: null });
    expect(JSON.parse((await run(dryRun.runId)).options)).toMatchObject({ adoptedBy: realRun.runId });
    expect((await run(realRun.runId)).format).toBe('csv-records');
    expect(await runToEnd(realRun.jobId)).toBe('succeeded');
    expect((await h.db.selectFrom('records').select('title').orderBy('title').execute()).map((r) => r.title)).toEqual(['Impor Lewat API', 'Kedua Lewat API']);

    // Adopted once: a second real run from the same dry run is refused.
    const again = await owner.post('/api/v1/catalog/imports', { fromRunId: dryRun.runId, ...options({ dryRun: false }) });
    expect([again.status, errors(again)]).toEqual([422, [{ path: 'fromRunId', code: 'not_found' }]]);
  });

  it('S11: createItems at a branch where the caller lacks catalog.items.manage → 403; at their own branch → 202', async () => {
    const perms: Permission[] = ['catalog.import.run'];
    const clerk = await signedIn('petugas_cabang', [{ permissions: perms }, { permissions: ['catalog.items.manage'], branchId: branchA }]);
    const uploadB = await stagedUpload(clerk.userId, Buffer.from(CSV, 'utf8'));
    const denied = await clerk.post('/api/v1/catalog/imports', { uploadId: uploadB, ...options({ createItems: true, branchId: branchB }) });
    expect([denied.status, code(denied)]).toEqual([403, 'AUTHZ_DENIED']);
    // Nothing was taken: the upload can still be used.
    expect(await h.db.selectFrom('upload_sessions').select('id').where('id', '=', uploadB).execute()).toHaveLength(1);
    const csvItems = await clerk.post('/api/v1/catalog/imports', { uploadId: uploadB, ...options({ format: 'csv-items', branchId: branchB }) });
    expect([csvItems.status, code(csvItems)]).toEqual([403, 'AUTHZ_DENIED']);
    const allowed = await clerk.post('/api/v1/catalog/imports', { uploadId: uploadB, ...options({ createItems: true, branchId: branchA }) });
    expect(allowed.status, allowed.text).toBe(202);
  });

  it('an export → 202 RunStarted, `catalog.export.start`; the job writes the file the runs route serves', async () => {
    const res = await owner.post('/api/v1/catalog/exports', { format: 'csv-records', filter: { includeArchived: true } });
    expect(res.status, res.text).toBe(202);
    const { runId, jobId } = res.json as { runId: string; jobId: string };
    expect(await run(runId)).toMatchObject({ kind: 'export', format: 'csv-records', status: 'queued', job_id: jobId });
    const audit = await h.db.selectFrom('audit_log').select('meta').where('action', '=', 'catalog.export.start').where('entity_id', '=', runId).execute();
    expect(audit.map((a) => JSON.parse(a.meta ?? '{}') as unknown)).toEqual([{ format: 'csv-records', filters: ['includeArchived'], recordIds: 0 }]);
    expect(await runToEnd(jobId)).toBe('succeeded');
    const download = await owner.get(`/api/v1/catalog/runs/${runId}/download`);
    expect(download.status, download.text).toBe(200);
    expect(download.text).toContain('"record_id","title"');
  });

  it('GET catalog/records/:id/marc: ISO 2709, MARCXML, one MarcJsonRecord; 404 for no record', async () => {
    const buku = await h.db.selectFrom('material_types').select('id').where('code_key', '=', normalizeKey('BUKU')).executeTakeFirstOrThrow();
    const id = newId(NOW);
    await h.db
      .insertInto('records')
      .values({
        id,
        material_type_id: buku.id,
        title: 'Satu Cantuman',
        title_key: 'satu cantuman',
        publication_year: '2024',
        source: 'manual',
        changed_at: NOW,
        created_at: NOW,
        updated_at: NOW,
      })
      .execute();
    const mrc = await owner.get(`/api/v1/catalog/records/${id}/marc?format=mrc`);
    expect([mrc.status, mrc.headers.get('content-type'), mrc.headers.get('x-content-type-options')]).toEqual([200, 'application/marc', 'nosniff']);
    expect(mrc.headers.get('content-disposition')).toMatch(new RegExp(`^attachment; filename="altis-${id}\\.mrc"`));
    expect(mrc.text.endsWith('\x1d')).toBe(true);
    const xml = await owner.get(`/api/v1/catalog/records/${id}/marc?format=xml`);
    expect([xml.status, xml.headers.get('content-type')]).toEqual([200, 'application/marcxml+xml; charset=utf-8']);
    expect(xml.text).toContain(`<controlfield tag="001">${id}</controlfield>`);
    const json = await owner.get(`/api/v1/catalog/records/${id}/marc?format=json`);
    expect([json.status, json.headers.get('content-type')]).toEqual([200, 'application/json; charset=utf-8']);
    const rec = JSON.parse(json.text) as MarcJsonRecord;
    expect(rec.leader).toHaveLength(24);
    expect(rec.fields).toEqual(expect.arrayContaining([{ '001': id }, { '245': { ind1: '0', ind2: '0', subfields: [{ a: 'Satu Cantuman.' }] } }]));
    const missing = await owner.get(`/api/v1/catalog/records/${newId(NOW)}/marc?format=json`);
    expect([missing.status, code(missing)]).toEqual([404, 'NOT_FOUND']);
    const bad = await owner.get(`/api/v1/catalog/records/${id}/marc?format=pdf`);
    expect(bad.status).toBe(422);
  });
});
