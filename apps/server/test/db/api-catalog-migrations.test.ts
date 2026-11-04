import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  __setSlimsSourceFactory,
  __setSlimsStages,
  claimById,
  cleanFiles,
  createJobRegistry,
  localStorageDriver,
  placeSlimsWork,
  requestCancel,
  runSlice,
  slimsJobs,
  type CatalogJobDeps,
  type CoreLogger,
} from '@altis/core';
import { PHASE1_MIGRATIONS, runMigrations, withTx } from '@altis/db';
import { newId } from '@altis/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { fakeCountingStage, fakeSlimsFactory, type FakeSlimsFactory } from '../../../../packages/core/test/fixtures/slims-fake.js';
import { createApp } from '../../src/app.js';
import { createAgent, type AgentReply } from '../agent.js';
import { recordingLogger, sampleConfig } from '../support.js';
import { seedStaff, sessionCookieFor, sessionCsrfFor } from '../support-auth.js';

// The SLiMS migration routes of Phase 2 Task 23 (spec §11.1–§11.2, §12.2, §12.3; decisions P2-17, D2-25; S3) on the
// engine picked by ALTIS_TEST_DB, with the source factory seam's fake source (B1): the connection test answers 200
// either way, both routes need a super admin's recent re-authentication (an admin lacks catalog.migration.run, K2), the
// start creates a run and its job (the password sealed in the job only), joins a live migration, refuses a real run
// into a catalogue with records, and takes a dump dry run's work over without a second upload.

const ctx = testDbContext();
let h: TestDbHandle;

/** In the past: an audit entry may not be dated ahead of the real clock. */
const NOW = Date.UTC(2026, 9, 29, 10, 0, 0);
const CONFIG = sampleConfig();
const SID = '__Host-altis_sid';
const API = '/api/v1/catalog/migrations/slims';
const silent: CoreLogger = { info() {}, warn() {}, error() {} };
const DB_SOURCE = { kind: 'db', host: 'slims.internal', port: 3306, user: 'baca', password: 'Rahasia-SLiMS-1', database: 'slims', tls: false };

interface Client {
  userId: string;
  post(p: string, body?: unknown): Promise<AgentReply>;
}

const code = (res: AgentReply): string | undefined => (res.json as { code?: string } | undefined)?.code;
const errors = (res: AgentReply): { path: string; code: string }[] => (res.json as { errors?: { path: string; code: string }[] }).errors ?? [];

describe.skipIf(!ctx.available)(`SLiMS migration API [${engineLabel()}]`, () => {
  let dataDir: string;
  let app: ReturnType<typeof createApp>;
  let owner: Client;
  let other: Client;
  let admin: Client;
  let stale: Client;
  let branchId: string;
  let factory: FakeSlimsFactory;
  const deps = (): CatalogJobDeps => ({ dataDir, baseUrl: CONFIG.baseUrl, keyring: CONFIG.keyring, storage: localStorageDriver(dataDir), log: silent });
  const registry = createJobRegistry(slimsJobs(deps));

  async function signedIn(username: string, role: 'super_admin' | 'admin', o: { reauth?: boolean } = {}): Promise<Client> {
    const user = await seedStaff(h, { username, now: NOW, roles: [{ key: role }] });
    const token = await sessionCookieFor(h, user.id, { now: NOW, reauthAt: o.reauth === false ? null : NOW });
    const agent = createAgent(app);
    agent.setCookie(SID, token);
    const csrf = { 'x-csrf-token': sessionCsrfFor(CONFIG, token) };
    return { userId: user.id, post: (p, body) => agent.post(p, body, csrf) };
  }

  /** A completed `context` upload of `userId` holding `bytes`, as files/uploads/:id/complete leaves it (staged). */
  async function stagedUpload(userId: string, context: 'slims.dump' | 'slims.files', bytes: Uint8Array): Promise<string> {
    const id = newId(NOW);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    await h.db
      .insertInto('upload_sessions')
      .values({ id, owner: `staff:${userId}`, context, size: bytes.byteLength, sha256, chunk_size: 262_144, received: bytes.byteLength, expires_at: NOW + 86_400_000 })
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
  const startBody = (o: Record<string, unknown> = {}) => ({ source: DB_SOURCE, branchId, allowNonEmpty: false, dryRun: true, ...o });

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-api-slims-')));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(dataDir, 'migrations'), migrations: PHASE1_MIGRATIONS });
    branchId = newId(NOW);
    await h.db
      .insertInto('branches')
      .values({ id: branchId, code_key: 'PUSAT', code_display: 'PUSAT', name: 'Perpustakaan Pusat', timezone: 'Asia/Jakarta', is_default: 1, created_at: NOW, updated_at: NOW })
      .execute();
    app = createApp({ state: { phase: 'ready', db: h, config: CONFIG }, version: '0.1.0', buildId: 'b', log: recordingLogger(), clock: () => NOW, dataDir });
    owner = await signedIn('kepala', 'super_admin');
    other = await signedIn('wakil', 'super_admin');
    admin = await signedIn('pengelola', 'admin');
    stale = await signedIn('lupa_reauth', 'super_admin', { reauth: false });
  });

  afterAll(async () => {
    __setSlimsSourceFactory(null);
    __setSlimsStages(null);
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    factory = fakeSlimsFactory();
    __setSlimsSourceFactory(factory);
    __setSlimsStages([fakeCountingStage('records', 'biblio')]);
    for (const table of ['jobs', 'locks', 'catalog_runs', 'migration_map', 'records'] as const) await h.db.deleteFrom(table).execute();
  });

  afterEach(() => {
    __setSlimsSourceFactory(null);
    __setSlimsStages(null);
  });

  it('test-connection, an unreachable host → 200 {ok: false, code: MIGRATION_SOURCE_UNREACHABLE, reason}', async () => {
    __setSlimsSourceFactory(fakeSlimsFactory({ unreachable: 'ECONNREFUSED' }));
    const res = await owner.post(`${API}/test-connection`, { source: DB_SOURCE });
    expect(res.status, res.text).toBe(200);
    expect(res.json).toEqual({ ok: false, code: 'MIGRATION_SOURCE_UNREACHABLE', reason: 'ECONNREFUSED' });
  });

  it('test-connection, a fake source and a fake detect → 200 {ok: true, version 9, tables, missing}; the password reached the source only', async () => {
    const res = await owner.post(`${API}/test-connection`, { source: DB_SOURCE });
    expect(res.status, res.text).toBe(200);
    expect(res.json).toEqual({
      ok: true,
      version: '9',
      tables: [
        { name: 'biblio', rows: 5 },
        { name: 'item', rows: -1 }, // the source does not know its count
        { name: 'mst_author', rows: 3 },
      ],
      missing: [],
    });
    expect(factory.calls.passwords).toEqual(['Rahasia-SLiMS-1']);
    expect(res.text).not.toContain('Rahasia');
  });

  it('test-connection, a source that is no SLiMS 8 or 9 → 200 {ok: false, code: MIGRATION_SOURCE_UNSUPPORTED}', async () => {
    __setSlimsSourceFactory(fakeSlimsFactory({ version: 'unknown' }));
    const res = await owner.post(`${API}/test-connection`, { source: DB_SOURCE });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: false, code: 'MIGRATION_SOURCE_UNSUPPORTED', version: 'unknown' });
  });

  it('both routes need a re-authentication within 5 minutes (401), and an admin is refused (403, K2)', async () => {
    for (const [p, body] of [
      [`${API}/test-connection`, { source: DB_SOURCE }],
      [API, startBody()],
    ] as const) {
      const late = await stale.post(p, body);
      expect([late.status, code(late)], p).toEqual([401, 'AUTH_REAUTH_REQUIRED']);
      const refused = await admin.post(p, body);
      expect([refused.status, code(refused)], p).toEqual([403, 'AUTHZ_DENIED']);
    }
    expect(factory.calls.openDb).toBe(0);
    expect(await h.db.selectFrom('catalog_runs').select('id').execute()).toEqual([]);
  });

  it('start: 201 {runId, jobId}; the run without the password, the job with it sealed; one catalog.migration.start', async () => {
    const seq = Number((await h.db.selectFrom('audit_head').select('last_seq').executeTakeFirstOrThrow()).last_seq);
    const res = await owner.post(API, startBody({ priceMode: 'minor', sourceName: 'kampus' }));
    expect(res.status, res.text).toBe(201);
    const started = res.json as { runId: string; jobId: string };
    expect(started).toEqual({ runId: expect.any(String), jobId: expect.any(String) });
    const r = await run(started.runId);
    expect([r.kind, r.status, Number(r.dry_run), r.job_id, r.created_by]).toEqual(['migration', 'queued', 1, started.jobId, owner.userId]);
    expect(r.options).not.toContain('Rahasia');
    expect(JSON.parse(r.options)).toMatchObject({ sourceKind: 'db', priceMode: 'minor', sourceName: 'kampus', db: { host: 'slims.internal', database: 'slims' } });
    const job = await h.db.selectFrom('jobs').select(['type', 'secret_param', 'unique_key', 'payload', 'created_by']).where('id', '=', started.jobId).executeTakeFirstOrThrow();
    expect([job.type, job.unique_key, job.created_by, job.secret_param === null]).toEqual(['catalog.migrate_slims', 'catalog.migrate_slims', owner.userId, false]);
    expect(job.secret_param).not.toContain('Rahasia');
    expect(JSON.parse(job.payload)).toEqual({ runId: started.runId, stage: 1, cursor: null });
    const entries = await h.db.selectFrom('audit_log').select(['action', 'entity', 'entity_id', 'meta']).where('seq', '>', seq).execute();
    expect(entries.map((e) => e.action)).toEqual(['catalog.migration.start']);
    expect(JSON.parse(entries[0]!.meta)).toEqual({ dryRun: true, sourceKind: 'db', priceMode: 'minor', sourceName: 'kampus', adoptedFrom: null });
    // The job runs to its end on the fake source, with the password from its secret.
    expect(await runToEnd(started.jobId)).toBe('succeeded');
    expect((await run(started.runId)).status).toBe('succeeded');
    expect(factory.calls.passwords).toEqual(['Rahasia-SLiMS-1']);
  });

  it('start while a migration is live joins it: 200 with its run and job, one job row', async () => {
    const first = await owner.post(API, startBody());
    expect(first.status).toBe(201);
    const again = await other.post(API, startBody({ dryRun: false }));
    expect(again.status, again.text).toBe(200);
    expect(again.json).toEqual({ ...(first.json as object), joined: true });
    expect(await h.db.selectFrom('jobs').select('id').execute()).toHaveLength(1);
    expect(await h.db.selectFrom('catalog_runs').select('id').execute()).toHaveLength(1);
  });

  it('a real run into a catalogue with a live record → 409 MIGRATION_TARGET_NOT_EMPTY; with the library name typed → 201', async () => {
    const buku = (await h.db.selectFrom('material_types').select('id').where('code_key', '=', 'BUKU').executeTakeFirstOrThrow()).id;
    await h.db
      .insertInto('records')
      .values({
        id: newId(NOW),
        material_type_id: buku,
        title: 'Hidup',
        subtitle: null,
        responsibility: null,
        title_key: 'hidup',
        edition: null,
        material_detail: null,
        publisher_id: null,
        publication_place: null,
        publication_year: null,
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
    const refused = await owner.post(API, startBody({ dryRun: false }));
    expect([refused.status, code(refused)]).toEqual([409, 'MIGRATION_TARGET_NOT_EMPTY']);
    const wrong = await owner.post(API, startBody({ dryRun: false, allowNonEmpty: true, confirmLibraryName: 'Bukan Ini' }));
    expect([wrong.status, code(wrong)]).toEqual([409, 'MIGRATION_TARGET_NOT_EMPTY']);
    expect(await h.db.selectFrom('jobs').select('id').execute()).toEqual([]);
    await h.db.deleteFrom('settings').where('key', '=', 'library.name').execute();
    await h.db
      .insertInto('settings')
      .values({ key: 'library.name', value: JSON.stringify('Perpustakaan Nusantara'), is_secret: 0, scope: 'data', updated_at: NOW, updated_by: null })
      .execute();
    const ok = await owner.post(API, startBody({ dryRun: false, allowNonEmpty: true, confirmLibraryName: ' Perpustakaan Nusantara ' }));
    expect(ok.status, ok.text).toBe(201);
  });

  it('field errors: no source → source required; another user\'s upload → source.uploadId not_found; an unknown branch', async () => {
    const none = await owner.post(API, { branchId, allowNonEmpty: false, dryRun: true });
    expect([none.status, errors(none)]).toEqual([422, [{ path: 'source', code: 'required' }]]);
    const theirs = await stagedUpload(other.userId, 'slims.dump', new TextEncoder().encode('-- dump\n'));
    const taken = await owner.post(API, startBody({ source: { kind: 'dump', uploadId: theirs } }));
    expect([taken.status, errors(taken)]).toEqual([422, [{ path: 'source.uploadId', code: 'not_found' }]]);
    const lost = await owner.post(API, startBody({ branchId: newId(NOW) }));
    expect([lost.status, errors(lost)]).toEqual([422, [{ path: 'branchId', code: 'not_found' }]]);
  });

  it('C25: the start moves the taken uploads into the run\'s folder after its COMMIT, so a files cleanup a day later keeps them', async () => {
    const dumpBytes = new TextEncoder().encode('-- MySQL dump\nCREATE TABLE biblio (biblio_id int);\n');
    const upload = await stagedUpload(owner.userId, 'slims.dump', dumpBytes);
    const files = await stagedUpload(owner.userId, 'slims.files', new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...new Array<number>(18).fill(0)]));
    const res = await owner.post(API, startBody({ source: { kind: 'dump', uploadId: upload }, filesUploadId: files }));
    expect(res.status, res.text).toBe(201);
    const started = res.json as { runId: string; jobId: string };
    // Before any slice: the uploads are the run's input already, in the folder its run id protects (S2).
    const workDir = path.join(dataDir, 'tmp', started.runId);
    expect((await fsp.readdir(workDir)).sort()).toEqual(['dump.bin', 'files.bin']);
    expect(Buffer.from(await fsp.readFile(path.join(workDir, 'dump.bin')))).toEqual(Buffer.from(dumpBytes));
    for (const id of [upload, files]) await expect(fsp.stat(path.join(dataDir, 'tmp', id))).rejects.toMatchObject({ code: 'ENOENT' });
    // The hourly files cleanup, a day and an hour later (the job still waits for its first slice): nothing goes.
    await cleanFiles(h, { dataDir, now: NOW + 25 * 3_600_000, from: { phase: 'tmp', after: null }, budgetLeft: () => true });
    expect((await fsp.readdir(workDir)).sort()).toEqual(['dump.bin', 'files.bin']);
    // The first slice takes the placed input as it is.
    expect(await runToEnd(started.jobId)).toBe('succeeded');
    expect((await run(started.runId)).status).toBe('succeeded');
    expect(factory.calls.split).toBe(2);

    // The hook and a first slice in another process placing the same upload at once: one renames, the other finds it done.
    const again = await stagedUpload(owner.userId, 'slims.dump', dumpBytes);
    const runId = newId(NOW);
    const place = (): Promise<void> => placeSlimsWork(dataDir, runId, { fromRunId: null, dumpStagingId: again, filesStagingId: null });
    await Promise.all([place(), place(), place()]);
    await place(); // and once more, with nothing left to move
    expect(await fsp.readdir(path.join(dataDir, 'tmp', runId))).toEqual(['dump.bin']);
    await expect(fsp.stat(path.join(dataDir, 'tmp', again))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('C16/C17: the next start ends a run whose job was cancelled while queued (or died), and removes its work folder after its COMMIT', async () => {
    const dumpBytes = new TextEncoder().encode('-- MySQL dump\nCREATE TABLE biblio (biblio_id int);\n');
    const upload = await stagedUpload(owner.userId, 'slims.dump', dumpBytes);
    const files = await stagedUpload(owner.userId, 'slims.files', new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...new Array<number>(18).fill(0)]));
    const res = await owner.post(API, startBody({ source: { kind: 'dump', uploadId: upload }, filesUploadId: files }));
    expect(res.status, res.text).toBe(201);
    const first = res.json as { runId: string; jobId: string };
    const firstWork = path.join(dataDir, 'tmp', first.runId);
    // The taken uploads and a partial split's staging, as a slice before the cancel left them.
    await fsp.writeFile(path.join(firstWork, 'biblio.ndjson'), '{"biblio_id":1}\n');
    expect((await fsp.readdir(firstWork)).sort()).toEqual(['biblio.ndjson', 'dump.bin', 'files.bin']);
    // Batalkan between two slices: the queued job ends at once, its run is still 'running'.
    expect(await withTx(h, (trx) => requestCancel(trx, first.jobId, NOW))).toBe('cancelled');
    const next = await owner.post(API, startBody());
    expect(next.status, next.text).toBe(201);
    const second = next.json as { runId: string; jobId: string };
    expect(second).toEqual({ runId: expect.any(String), jobId: expect.any(String) });
    expect((await run(first.runId)).status).toBe('cancelled');
    await expect(fsp.stat(firstWork)).rejects.toMatchObject({ code: 'ENOENT' });

    // A job that died (its lease ran out on its last attempt) leaves its run 'queued': the next start ends it failed.
    const secondWork = path.join(dataDir, 'tmp', second.runId);
    await fsp.mkdir(secondWork, { recursive: true });
    await fsp.writeFile(path.join(secondWork, 'report.ndjson'), '[]\n');
    await h.db.updateTable('jobs').set({ status: 'dead', unique_key: null, finished_at: NOW }).where('id', '=', second.jobId).execute();
    const third = await owner.post(API, startBody());
    expect(third.status, third.text).toBe(201);
    expect((await run(second.runId)).status).toBe('failed');
    await expect(fsp.stat(secondWork)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('S3: a dump dry run, then the real run with fromRunId: no upload, no split, the folder adopted; every other adoption → not_found', async () => {
    const upload = await stagedUpload(owner.userId, 'slims.dump', new TextEncoder().encode('-- MySQL dump\nCREATE TABLE biblio (biblio_id int);\n'));
    const files = await stagedUpload(owner.userId, 'slims.files', new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...new Array<number>(18).fill(0)]));
    const dry = await owner.post(API, startBody({ source: { kind: 'dump', uploadId: upload }, filesUploadId: files }));
    expect(dry.status, dry.text).toBe(201);
    const dryRun = dry.json as { runId: string; jobId: string };
    // The uploads were taken: their sessions are gone (the job moves their files into the run's folder).
    expect(await h.db.selectFrom('upload_sessions').select('id').where('id', 'in', [upload, files]).execute()).toEqual([]);
    expect(await runToEnd(dryRun.jobId)).toBe('succeeded');
    expect(factory.calls.split).toBe(2);
    expect((await run(dryRun.runId)).status).toBe('succeeded');
    const dryDir = path.join(dataDir, 'tmp', dryRun.runId);
    expect((await fsp.readdir(dryDir)).sort()).toEqual(['files.bin', 'report.csv', 'tables.json']);

    const real = await owner.post(API, { fromRunId: dryRun.runId, branchId, allowNonEmpty: false, dryRun: false });
    expect(real.status, real.text).toBe(201);
    const realRun = real.json as { runId: string; jobId: string };
    await expect(fsp.stat(dryDir)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fsp.readdir(path.join(dataDir, 'tmp', realRun.runId))).sort()).toEqual(['files.bin', 'report.csv', 'tables.json']);
    expect(JSON.parse((await run(realRun.runId)).options)).toMatchObject({ sourceKind: 'dump', adoptedFrom: dryRun.runId, files: 'zip', dumpStagingId: null });
    expect(JSON.parse((await run(dryRun.runId)).options)).toMatchObject({ adoptedBy: realRun.runId });
    expect(JSON.parse((await h.db.selectFrom('jobs').select('payload').where('id', '=', realRun.jobId).executeTakeFirstOrThrow()).payload)).toMatchObject({
      stage: 1,
    });
    expect(await runToEnd(realRun.jobId)).toBe('succeeded');
    expect(factory.calls.split).toBe(2); // the split stage was skipped
    expect((await run(realRun.runId)).status).toBe('succeeded');

    const notFound = async (res: Promise<AgentReply>): Promise<void> => {
      const r = await res;
      expect([r.status, errors(r)], r.text).toEqual([422, [{ path: 'fromRunId', code: 'not_found' }]]);
    };
    // A second adoption of the same dry run.
    await notFound(owner.post(API, { fromRunId: dryRun.runId, branchId, allowNonEmpty: true, confirmLibraryName: 'x', dryRun: true }));
    // Another user's dry run.
    const theirs = await other.post(API, startBody({ source: { kind: 'dump', uploadId: await stagedUpload(other.userId, 'slims.dump', new TextEncoder().encode('--\n')) } }));
    expect(theirs.status).toBe(201);
    const theirRun = (theirs.json as { runId: string; jobId: string }).runId;
    await runToEnd((theirs.json as { jobId: string }).jobId);
    await notFound(owner.post(API, { fromRunId: theirRun, branchId, allowNonEmpty: false, dryRun: true }));
    // A run that was not a dry run (the real run above).
    await notFound(owner.post(API, { fromRunId: realRun.runId, branchId, allowNonEmpty: false, dryRun: true }));
    // A dry run that finished 8 days ago.
    const old = await owner.post(API, startBody());
    const oldRun = (old.json as { runId: string; jobId: string });
    await runToEnd(oldRun.jobId);
    await h.db.updateTable('catalog_runs').set({ finished_at: NOW - 8 * 86_400_000 }).where('id', '=', oldRun.runId).execute();
    await notFound(owner.post(API, { fromRunId: oldRun.runId, source: DB_SOURCE, branchId, allowNonEmpty: false, dryRun: true }));
    // A database dry run is adopted only with the same database named again.
    const dbDry = await owner.post(API, startBody());
    const dbRun = dbDry.json as { runId: string; jobId: string };
    await runToEnd(dbRun.jobId);
    const missing = await owner.post(API, { fromRunId: dbRun.runId, branchId, allowNonEmpty: false, dryRun: true });
    expect([missing.status, errors(missing)]).toEqual([422, [{ path: 'source', code: 'required' }]]);
    const elsewhere = await owner.post(API, { fromRunId: dbRun.runId, source: { ...DB_SOURCE, database: 'lain' }, branchId, allowNonEmpty: false, dryRun: true });
    expect([elsewhere.status, errors(elsewhere)]).toEqual([422, [{ path: 'source', code: 'mismatch' }]]);
    const same = await owner.post(API, { fromRunId: dbRun.runId, source: DB_SOURCE, branchId, allowNonEmpty: false, dryRun: true });
    expect(same.status, same.text).toBe(201);
  });
});
