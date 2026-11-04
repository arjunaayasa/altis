import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations } from '@altis/db';
import { newId } from '@altis/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { AUTHORITIES_ROUTES } from '../../src/api/catalog/authorities.js';
import { CATALOG_ROUTES } from '../../src/api/catalog/index.js';
import { RECORDS_ROUTES } from '../../src/api/catalog/records.js';
import { SETTINGS_ROUTES } from '../../src/api/settings.js';
import { createApp } from '../../src/app.js';
import type { RouteDecl } from '../../src/http/route.js';
import { createAgent, type AgentReply } from '../agent.js';
import { recordingLogger, sampleConfig } from '../support.js';
import { seedStaff, sessionCookieFor, sessionCsrfFor } from '../support-auth.js';

// The authorities API of Phase 2 Task 13 (spec §3.5, §12.2; S12, S15, M3) on the engine picked by ALTIS_TEST_DB: the
// store routes answer `{id, version}` only, a rename or a merge queues `catalog.reindex` for the authority whose
// records changed, and the literal paths of each kind leave `catalog/records` and `catalog/config` to their own
// handlers.

const ctx = testDbContext();
let h: TestDbHandle;

/** In the past: an audit entry may not be dated ahead of the real clock. */
const NOW = Date.UTC(2026, 9, 22, 9, 0, 5);
const CONFIG = sampleConfig();
const SID = '__Host-altis_sid';
const API = '/api/v1/catalog';

interface Client {
  get(p: string): Promise<AgentReply>;
  send(method: 'post' | 'patch' | 'put' | 'delete', p: string, body?: unknown, key?: string): Promise<AgentReply>;
}

const code = (res: AgentReply): string | undefined => (res.json as { code?: string } | undefined)?.code;
const errors = (res: AgentReply): { path: string; code: string }[] => (res.json as { errors?: { path: string; code: string }[] }).errors ?? [];
const stored = (res: AgentReply): { id: string; version: number } => res.json as { id: string; version: number };

describe.skipIf(!ctx.available)(`authorities API [${engineLabel()}]`, () => {
  let dataDir: string;
  let app: ReturnType<typeof createApp>;
  let manager: Client;
  let reader: Client;
  let buku: string;
  let serial = 0;
  const unique = (base: string): string => `${base} ${(serial += 1)}`;

  function appWith(routes?: RouteDecl[]): ReturnType<typeof createApp> {
    return createApp({
      state: { phase: 'ready', db: h, config: CONFIG },
      version: '0.1.0',
      buildId: 'b',
      log: recordingLogger(),
      clock: () => NOW,
      ...(routes === undefined ? {} : { routes }),
    });
  }

  async function signedIn(username: string, permissions: string[], on: ReturnType<typeof createApp> = app): Promise<Client> {
    const user = await seedStaff(h, { username, now: NOW, roles: [{ permissions: permissions as never }] });
    const token = await sessionCookieFor(h, user.id, { now: NOW });
    const agent = createAgent(on);
    agent.setCookie(SID, token);
    const csrf = { 'x-csrf-token': sessionCsrfFor(CONFIG, token) };
    return {
      get: (p) => agent.get(p),
      send: (method, p, body, key) => agent[method](p, body, key === undefined ? csrf : { ...csrf, 'idempotency-key': key }),
    };
  }

  const create = async (kind: 'agents' | 'subjects' | 'publishers', body: Record<string, unknown>): Promise<string> => {
    const res = await manager.send('post', `${API}/${kind}`, body);
    expect(res.status, res.text).toBe(201);
    return stored(res).id;
  };
  const record = async (body: Record<string, unknown>): Promise<string> => {
    const res = await manager.send('post', `${API}/records`, { materialTypeId: buku, title: unique('Arus Balik'), ...body });
    expect(res.status, res.text).toBe(201);
    return stored(res).id;
  };
  const reindexJobs = async () =>
    (await h.db.selectFrom('jobs').select(['unique_key', 'payload', 'status']).where('type', '=', 'catalog.reindex').orderBy('id').execute()).map((j) => ({
      uniqueKey: j.unique_key,
      payload: JSON.parse(j.payload) as Record<string, unknown>,
      status: j.status,
    }));

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-api-authorities-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
    buku = (await h.db.selectFrom('material_types').select('id').where('code_key', '=', 'BUKU').executeTakeFirstOrThrow()).id;
    app = appWith();
    manager = await signedIn('kelola_otoritas', ['catalog.authorities.manage', 'catalog.records.manage', 'catalog.records.read']);
    reader = await signedIn('baca_otoritas', ['catalog.records.read']);
  });

  afterAll(async () => {
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  it('POST → 201 {id, version} only (S15); GET answers the view; the same key → 422 taken; a reader cannot write (403)', async () => {
    const res = await manager.send('post', `${API}/agents`, { type: 'person', name: 'Toer, Pramoedya Ananta', dates: '1925-2006' }, `ot-${newId()}`);
    expect(res.status, res.text).toBe(201);
    expect(res.json).toEqual({ id: expect.any(String), version: 0 });
    const id = stored(res).id;
    const view = await reader.get(`${API}/agents/${id}`);
    expect(view.status).toBe(200);
    expect(view.json).toMatchObject({ id, type: 'person', name: 'Toer, Pramoedya Ananta', dates: '1925-2006', usage: 0, archived: false, version: 0 });
    expect((await reader.get(`${API}/agents/${newId()}`)).status).toBe(404);

    const again = await manager.send('post', `${API}/agents`, { type: 'person', name: 'TOER,  Pramoedya Ananta', dates: '1925-2006' });
    expect(again.status).toBe(422);
    expect(errors(again)).toEqual([{ path: 'name', code: 'taken' }]);
    const denied = await reader.send('post', `${API}/agents`, { type: 'person', name: 'Tidak Boleh' });
    expect(denied.status).toBe(403);

    const list = await reader.get(`${API}/agents?q=pramoedya&type=person&limit=10`);
    expect(list.status, list.text).toBe(200);
    expect((list.json as { items: { id: string }[] }).items.map((i) => i.id)).toEqual([id]);
    expect((await reader.get(`${API}/agents?type=topic`)).status).toBe(422);
  });

  it('PATCH: a rename queues catalog.reindex with uniqueKey catalog.reindex:agent:<id>; a note only queues nothing', async () => {
    const id = await create('agents', { type: 'person', name: unique('Hamka') });
    const before = (await reindexJobs()).length;
    const noted = await manager.send('patch', `${API}/agents/${id}`, { version: 0, note: 'Ulama' });
    expect(noted.status, noted.text).toBe(200);
    expect(noted.json).toEqual({ id, version: 1 });
    expect(await reindexJobs()).toHaveLength(before);

    const renamed = await manager.send('patch', `${API}/agents/${id}`, { version: 1, name: unique('Karim Amrullah, Abdul Malik') });
    expect(renamed.json).toEqual({ id, version: 2 });
    const jobs = (await reindexJobs()).filter((j) => j.uniqueKey === `catalog.reindex:agent:${id}`);
    expect(jobs).toEqual([{ uniqueKey: `catalog.reindex:agent:${id}`, payload: { agentId: id }, status: 'queued' }]);

    const stale = await manager.send('patch', `${API}/agents/${id}`, { version: 0, note: 'x' });
    expect(stale.status).toBe(409);
    expect(code(stale)).toBe('CONFLICT_STALE');

    const subject = await create('subjects', { type: 'topic', term: unique('Sastra') });
    await manager.send('patch', `${API}/subjects/${subject}`, { version: 0, term: unique('Kesusastraan') });
    const publisher = await create('publishers', { name: unique('Balai Pustaka') });
    await manager.send('patch', `${API}/publishers/${publisher}`, { version: 0, name: unique('PT Balai Pustaka') });
    const keys = (await reindexJobs()).map((j) => j.uniqueKey);
    expect(keys).toContain(`catalog.reindex:subject:${subject}`);
    expect(keys).toContain(`catalog.reindex:publisher:${publisher}`);
  });

  it('C08: a PATCH of only a subject\'s classification or only a publisher\'s place queues the reindex (both are indexed)', async () => {
    const subject = await create('subjects', { type: 'topic', term: unique('Sastra Sunda') });
    const classed = await manager.send('patch', `${API}/subjects/${subject}`, { version: 0, classification: '899.232' });
    expect(classed.status, classed.text).toBe(200);
    const publisher = await create('publishers', { name: unique('Pustaka Jaya'), place: 'Bandung' });
    const moved = await manager.send('patch', `${API}/publishers/${publisher}`, { version: 0, place: 'Jakarta' });
    expect(moved.status, moved.text).toBe(200);
    const jobs = await reindexJobs();
    expect(jobs.filter((j) => j.uniqueKey === `catalog.reindex:subject:${subject}`)).toEqual([
      { uniqueKey: `catalog.reindex:subject:${subject}`, payload: { subjectId: subject }, status: 'queued' },
    ]);
    expect(jobs.filter((j) => j.uniqueKey === `catalog.reindex:publisher:${publisher}`)).toEqual([
      { uniqueKey: `catalog.reindex:publisher:${publisher}`, payload: { publisherId: publisher }, status: 'queued' },
    ]);
  });

  it('S12: merging agent A into B queues the reindex of B ({agentId: B}), whose scope selects the record moved from A', async () => {
    const a = await create('agents', { type: 'person', name: unique('Pram') });
    const b = await create('agents', { type: 'person', name: unique('Toer, Pram') });
    const moved = await record({ agents: [{ ref: { id: a }, role: 'aut', isMain: true }] });

    const res = await manager.send('post', `${API}/agents/${a}/merge`, { intoId: b, version: 0 });
    expect(res.status, res.text).toBe(200);
    expect(res.json).toEqual({ id: a, version: 1 });
    const jobs = await reindexJobs();
    expect(jobs.filter((j) => j.uniqueKey === `catalog.reindex:agent:${b}`)).toEqual([
      { uniqueKey: `catalog.reindex:agent:${b}`, payload: { agentId: b }, status: 'queued' },
    ]);
    expect(jobs.filter((j) => j.uniqueKey === `catalog.reindex:agent:${a}`)).toEqual([]);
    // The scope {agentId: B}: the records linked to B, the one moved from A among them.
    const scope = await h.db.selectFrom('record_agents').select('record_id').where('agent_id', '=', b).execute();
    expect(scope.map((r) => r.record_id)).toEqual([moved]);
    expect(await h.db.selectFrom('agents').select('merged_into').where('id', '=', a).executeTakeFirstOrThrow()).toEqual({ merged_into: b });

    const again = await manager.send('post', `${API}/agents/${b}/merge`, { intoId: a, version: 0 });
    expect(again.status).toBe(422);
    expect(code(again)).toBe('CATALOG_MERGE_INVALID');
    const org = await create('agents', { type: 'organization', name: unique('Lekra') });
    const mixed = await manager.send('post', `${API}/agents/${b}/merge`, { intoId: org, version: 0 });
    expect(code(mixed)).toBe('CATALOG_MERGE_INVALID');

    const p1 = await create('publishers', { name: unique('Penerbit A') });
    const p2 = await create('publishers', { name: unique('Penerbit B') });
    await record({ publisher: { id: p1 } });
    expect((await manager.send('post', `${API}/publishers/${p1}/merge`, { intoId: p2, version: 0 })).status).toBe(200);
    expect((await reindexJobs()).filter((j) => j.uniqueKey === `catalog.reindex:publisher:${p2}`)).toEqual([
      { uniqueKey: `catalog.reindex:publisher:${p2}`, payload: { publisherId: p2 }, status: 'queued' },
    ]);
  });

  it('DELETE an agent in use → 409 CATALOG_IN_USE (the count in detail); an unused one → 200 {id, version}', async () => {
    const used = await create('agents', { type: 'person', name: unique('Dini, Nh.') });
    await record({ agents: [{ ref: { id: used }, role: 'aut', isMain: true }] });
    const refused = await manager.send('delete', `${API}/agents/${used}`, { version: 0 });
    expect(refused.status).toBe(409);
    expect(code(refused)).toBe('CATALOG_IN_USE');
    expect((refused.json as { detail?: string }).detail).toContain('1');

    const free = await create('agents', { type: 'meeting', name: unique('Kongres Bahasa') });
    const archived = await manager.send('delete', `${API}/agents/${free}`, { version: 0 });
    expect(archived.status, archived.text).toBe(200);
    expect(archived.json).toEqual({ id: free, version: 1 });
    expect((await reader.get(`${API}/agents/${free}`)).json).toMatchObject({ archived: true });
  });

  it('PUT subjects/:id/relations writes the reciprocal; a relation to itself → 422 at relations.0.subjectId', async () => {
    const a = await create('subjects', { type: 'topic', term: unique('Kucing') });
    const b = await create('subjects', { type: 'topic', term: unique('Hewan') });
    const res = await manager.send('put', `${API}/subjects/${a}/relations`, { relations: [{ rel: 'bt', subjectId: b }], version: 0 });
    expect(res.status, res.text).toBe(200);
    expect(res.json).toEqual({ id: a, version: 1 });
    const other = (await reader.get(`${API}/subjects/${b}`)).json as { relations: { rel: string; subjectId: string }[]; cycles: string[][] };
    expect(other.relations).toMatchObject([{ rel: 'nt', subjectId: a }]);
    expect(other.cycles).toEqual([]);
    const self = await manager.send('put', `${API}/subjects/${a}/relations`, { relations: [{ rel: 'rt', subjectId: a }], version: 1 });
    expect(self.status).toBe(422);
    expect(errors(self)).toEqual([{ path: 'relations.0.subjectId', code: 'self' }]);
  });

  it('orphans: listed by kind; the archive answers {archived, skipped}', async () => {
    const orphan = await create('publishers', { name: unique('Penerbit Yatim') });
    const linked = await create('publishers', { name: unique('Penerbit Aktif') });
    await record({ publisher: { id: linked } });
    const list = await reader.get(`${API}/orphans?kind=publishers&limit=200`);
    expect(list.status, list.text).toBe(200);
    const ids = (list.json as { items: { id: string; type: null }[] }).items.map((i) => i.id);
    expect(ids).toContain(orphan);
    expect(ids).not.toContain(linked);
    expect((await reader.get(`${API}/orphans?kind=records`)).status).toBe(422);

    const res = await manager.send('post', `${API}/orphans/archive`, { kind: 'publishers', ids: [orphan, linked] });
    expect(res.status, res.text).toBe(200);
    expect(res.json).toEqual({ archived: 1, skipped: 1 });
  });

  it('M3: GET catalog/records and GET catalog/config reach their own handlers with the authority routes registered first', async () => {
    // No authority route has a parameter right after catalog/: each kind has literal paths.
    for (const d of AUTHORITIES_ROUTES) expect(d.path, d.id).toMatch(/^\/api\/v1\/catalog\/(agents|subjects|publishers|orphans)(\/|$)/);
    expect(AUTHORITIES_ROUTES).toHaveLength(21);
    expect(CATALOG_ROUTES.indexOf(AUTHORITIES_ROUTES[0]!)).toBeLessThan(CATALOG_ROUTES.indexOf(RECORDS_ROUTES[0]!));

    const first = appWith([...AUTHORITIES_ROUTES, ...RECORDS_ROUTES, ...SETTINGS_ROUTES]);
    for (const on of [first, app]) {
      const client = await signedIn(`m3_${newId().slice(-8).toLowerCase()}`, ['catalog.records.read'], on);
      const records = await client.get(`${API}/records?limit=1&sort=title`);
      expect(records.status, records.text).toBe(200);
      expect(Object.keys(records.json as object).sort()).toEqual(['items', 'nextCursor', 'page', 'total']);
      const config = await client.get(`${API}/config`);
      expect(config.status, config.text).toBe(200);
      expect(config.json).toMatchObject({ currency: 'IDR', barcodePatterns: expect.any(Array) });
    }
  });
});
