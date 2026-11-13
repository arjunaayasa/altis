import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations } from '@altis/db';
import { runWorkPath } from '@altis/platform';
import { newId } from '@altis/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { createApp } from '../../src/app.js';
import { createAgent, type AgentReply } from '../agent.js';
import { recordingLogger, sampleConfig } from '../support.js';
import { seedStaff, sessionCookieFor, sessionCsrfFor } from '../support-auth.js';

// The routes of the read-only SLiMS usage import (spec §11.2, §5.2) on the engine picked by ALTIS_TEST_DB: both need
// `accreditation.workspace.manage` and a re-authentication within 5 minutes; the connection test answers 200 either way;
// a start takes a dump upload of its starter, creates the run and its job and audits the start once; a second start while
// an import runs joins it; an unknown period is 404; an import run stays out of the catalogue's run list for a reader
// without the accreditation management permission.

const ctx = testDbContext();
let h: TestDbHandle;

/** In the past: an audit entry may not be dated ahead of the real clock. */
const NOW = Date.UTC(2026, 10, 12, 9, 0, 5);
const CONFIG = sampleConfig();
const SID = '__Host-altis_sid';
const API = '/api/v1/accreditation';
/** A database on the loopback's discard port: the connection fails at once, without the network. */
const UNREACHABLE = { host: '127.0.0.1', port: 9, user: 'baca', password: 'Rahasia-SLiMS-9', database: 'slims', tls: false };

interface Client {
  userId: string;
  get(p: string): Promise<AgentReply>;
  post(p: string, body?: unknown): Promise<AgentReply>;
}

const code = (res: AgentReply): string | undefined => (res.json as { code?: string } | undefined)?.code;
const errors = (res: AgentReply): { path: string; code: string }[] => (res.json as { errors?: { path: string; code: string }[] }).errors ?? [];

describe.skipIf(!ctx.available)(`SLiMS usage import API [${engineLabel()}]`, () => {
  let dataDir: string;
  let app: ReturnType<typeof createApp>;
  let manager: Client;
  let other: Client;
  let stale: Client;
  let reader: Client;
  let periodId: string;

  async function signedIn(username: string, permissions: string[], o: { reauth?: boolean } = {}): Promise<Client> {
    const user = await seedStaff(h, { username, now: NOW, roles: [{ permissions: permissions as never }] });
    const token = await sessionCookieFor(h, user.id, { now: NOW, reauthAt: o.reauth === false ? null : NOW });
    const agent = createAgent(app, { headers: { origin: CONFIG.baseUrl } });
    agent.setCookie(SID, token);
    const csrf = { 'x-csrf-token': sessionCsrfFor(CONFIG, token) };
    return { userId: user.id, get: (p) => agent.get(p), post: (p, body) => agent.post(p, body ?? {}, csrf) };
  }

  /** A completed `accreditation.slims_dump` upload of `userId`, as the upload API leaves it (staged). */
  async function stagedUpload(userId: string, bytes: Uint8Array): Promise<string> {
    const id = newId(NOW);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    await h.db
      .insertInto('upload_sessions')
      .values({ id, owner: `staff:${userId}`, context: 'accreditation.slims_dump', size: bytes.byteLength, sha256, chunk_size: 262_144, received: bytes.byteLength, expires_at: NOW + 86_400_000 })
      .execute();
    await fsp.mkdir(path.join(dataDir, 'tmp', id), { recursive: true });
    await fsp.writeFile(path.join(dataDir, 'tmp', id, 'upload.bin'), bytes);
    await fsp.writeFile(path.join(dataDir, 'tmp', id, '.complete'), JSON.stringify({ size: bytes.byteLength, sha256, mime: 'text/plain' }));
    return id;
  }

  async function period(startsOn: string, endsOn: string): Promise<string> {
    const id = newId(NOW);
    await h.db
      .insertInto('accred_periods')
      .values({
        id,
        branch_id: null,
        name: `Periode ${startsOn}`,
        kind: 'school_year',
        starts_on: startsOn,
        ends_on: endsOn,
        instrument_id: 'test-sch',
        status: 'open',
        frozen_at: null,
        frozen_by: null,
        profile: '{}',
        students: null,
        teachers: null,
        edu_staff: null,
        classes: null,
        population_served: null,
        teachers_using: null,
        user_pcs: null,
        staff_pcs: null,
        ict_devices: null,
        scanners: null,
        floor_m2: null,
        bandwidth_mbps: null,
        hours_per_week: null,
        services: null,
        external_website_url: null,
        created_at: NOW,
        updated_at: NOW,
        created_by: null,
        updated_by: null,
        archived_at: null,
      })
      .execute();
    return id;
  }

  const startEntries = async (runId: string) =>
    (await h.db.selectFrom('audit_log').select(['actor_id', 'meta']).where('action', '=', 'accreditation.slims_usage.start').where('entity_id', '=', runId).orderBy('seq').execute()).map(
      (r) => ({ actor: r.actor_id, meta: JSON.parse(r.meta ?? 'null') as unknown }),
    );

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-api-slims-usage-')));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(dataDir, 'migrations'), migrations: PHASE1_MIGRATIONS });
    app = createApp({ state: { phase: 'ready', db: h, config: CONFIG }, version: '0.1.0', buildId: 'b', log: recordingLogger(), clock: () => NOW, dataDir });
    manager = await signedIn('pengelola_akreditasi', ['accreditation.workspace.manage', 'catalog.records.read']);
    other = await signedIn('wakil_akreditasi', ['accreditation.workspace.manage']);
    stale = await signedIn('tanpa_reauth', ['accreditation.workspace.manage'], { reauth: false });
    reader = await signedIn('pembaca_katalog', ['catalog.records.read']);
    periodId = await period('2025-07-01', '2026-06-30');
  });

  afterAll(async () => {
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    for (const table of ['jobs', 'locks', 'catalog_runs'] as const) await h.db.deleteFrom(table).execute();
  });

  it('the connection test and the start without a recent re-authentication → 401, nothing started', async () => {
    const test = await stale.post(`${API}/slims-usage/test-connection`, { db: UNREACHABLE });
    expect([test.status, code(test)]).toEqual([401, 'AUTH_REAUTH_REQUIRED']);
    const start = await stale.post(`${API}/periods/${periodId}/slims-usage`, { source: { kind: 'db', db: UNREACHABLE } });
    expect([start.status, code(start)]).toEqual([401, 'AUTH_REAUTH_REQUIRED']);
    expect(await h.db.selectFrom('catalog_runs').select('id').execute()).toEqual([]);
  });

  it('a reader without the management permission → 403', async () => {
    const test = await reader.post(`${API}/slims-usage/test-connection`, { db: UNREACHABLE });
    expect(test.status).toBe(403);
    const start = await reader.post(`${API}/periods/${periodId}/slims-usage`, { source: { kind: 'db', db: UNREACHABLE } });
    expect(start.status).toBe(403);
  });

  it('a database it cannot reach is a 200 answer with ok false and a short reason', async () => {
    const res = await manager.post(`${API}/slims-usage/test-connection`, { db: UNREACHABLE });
    expect(res.status, res.text).toBe(200);
    expect(res.json).toMatchObject({ ok: false, code: 'MIGRATION_SOURCE_UNREACHABLE' });
    expect((res.json as { reason: string }).reason).toMatch(/^[A-Za-z0-9_.:-]{1,100}$/);
    expect(res.text).not.toContain(UNREACHABLE.password);
  });

  it('a dump start takes the upload, moves the dump into the run folder, audits the start once; a second start joins the live import', async () => {
    const uploadId = await stagedUpload(manager.userId, new TextEncoder().encode('-- MySQL dump\n'));
    const res = await manager.post(`${API}/periods/${periodId}/slims-usage`, { source: { kind: 'dump', uploadId }, cutoverOn: '2026-01-15', unknownMemberGroup: 'student' });
    expect(res.status, res.text).toBe(201);
    const { runId, jobId } = res.json as { runId: string; jobId: string };
    expect(await h.db.selectFrom('upload_sessions').select('id').where('id', '=', uploadId).execute()).toEqual([]);
    expect((await fsp.stat(runWorkPath(dataDir, runId, 'dump.bin'))).isFile()).toBe(true);
    await expect(fsp.stat(path.join(dataDir, 'tmp', uploadId))).rejects.toMatchObject({ code: 'ENOENT' });
    const run = await h.db.selectFrom('catalog_runs').select(['kind', 'status', 'options', 'job_id']).where('id', '=', runId).executeTakeFirstOrThrow();
    expect(run.kind).toBe('slims_usage');
    expect(run.job_id).toBe(jobId);
    expect(JSON.parse(run.options)).toEqual({ sourceKind: 'dump', periodId, cutoverOn: '2026-01-15', unknownMemberGroup: 'student', dedupeMinutes: 60 });
    expect(await startEntries(runId)).toEqual([{ actor: manager.userId, meta: { sourceKind: 'dump', cutoverOn: '2026-01-15' } }]);

    // Another starter joins: the same run and job, their own start entry once.
    const joined = await other.post(`${API}/periods/${periodId}/slims-usage`, { source: { kind: 'db', db: UNREACHABLE } });
    expect([joined.status, joined.json]).toEqual([200, { runId, jobId, joined: true }]);
    const again = await other.post(`${API}/periods/${periodId}/slims-usage`, { source: { kind: 'db', db: UNREACHABLE } });
    expect(again.status).toBe(200);
    expect(await startEntries(runId)).toEqual([
      { actor: manager.userId, meta: { sourceKind: 'dump', cutoverOn: '2026-01-15' } },
      { actor: other.userId, meta: { joined: true } },
    ]);
    expect(await h.db.selectFrom('catalog_runs').select('id').execute()).toEqual([{ id: runId }]);
  });

  it('a database start keeps the password only in the job\'s sealed secret', async () => {
    const res = await manager.post(`${API}/periods/${periodId}/slims-usage`, { source: { kind: 'db', db: UNREACHABLE } });
    expect(res.status, res.text).toBe(201);
    const { runId, jobId } = res.json as { runId: string; jobId: string };
    const job = await h.db.selectFrom('jobs').select(['payload', 'secret_param', 'unique_key']).where('id', '=', jobId).executeTakeFirstOrThrow();
    expect(job.unique_key).toBe('accreditation.import_slims_usage');
    expect(job.secret_param).not.toBeNull();
    expect(job.payload).not.toContain(UNREACHABLE.password);
    expect(job.secret_param).not.toContain(UNREACHABLE.password);
    const run = await h.db.selectFrom('catalog_runs').select('options').where('id', '=', runId).executeTakeFirstOrThrow();
    expect(run.options).not.toContain(UNREACHABLE.password);
  });

  it('refusals: an unknown period → 404; another user\'s upload → source.uploadId not_found; nothing started', async () => {
    const unknown = await manager.post(`${API}/periods/${newId(NOW)}/slims-usage`, { source: { kind: 'db', db: UNREACHABLE } });
    expect([unknown.status, code(unknown)]).toEqual([404, 'NOT_FOUND']);
    const theirs = await stagedUpload(other.userId, new TextEncoder().encode('-- MySQL dump\n'));
    const taken = await manager.post(`${API}/periods/${periodId}/slims-usage`, { source: { kind: 'dump', uploadId: theirs } });
    expect([taken.status, errors(taken)]).toEqual([422, [{ path: 'source.uploadId', code: 'not_found' }]]);
    expect(await h.db.selectFrom('catalog_runs').select('id').execute()).toEqual([]);
    expect(await h.db.selectFrom('jobs').select('id').execute()).toEqual([]);
  });

  it('GET catalog/runs: a catalogue reader does not see an import run; a reader who also manages accreditation does', async () => {
    const res = await manager.post(`${API}/periods/${periodId}/slims-usage`, { source: { kind: 'db', db: UNREACHABLE } });
    const { runId } = res.json as { runId: string };
    const list = await reader.get('/api/v1/catalog/runs');
    expect(list.status).toBe(200);
    expect((list.json as { items: { id: string }[] }).items.map((r) => r.id)).not.toContain(runId);
    expect((await reader.get(`/api/v1/catalog/runs/${runId}`)).status).toBe(404);
    const own = await manager.get('/api/v1/catalog/runs');
    expect((own.json as { items: { id: string; kind: string }[] }).items.map((r) => [r.id, r.kind])).toEqual([[runId, 'slims_usage']]);
    expect((await manager.get(`/api/v1/catalog/runs/${runId}`)).status).toBe(200);
  });
});
