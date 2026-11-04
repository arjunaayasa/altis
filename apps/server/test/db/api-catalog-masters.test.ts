import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations } from '@altis/db';
import { newId } from '@altis/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { createApp } from '../../src/app.js';
import { createAgent, type AgentReply } from '../agent.js';
import { recordingLogger, sampleConfig } from '../support.js';
import { seedStaff, sessionCookieFor, sessionCsrfFor } from '../support-auth.js';

// The masters API of Phase 2 Task 12 (spec §2.2, §2.6, §3.7, §3.8, §12.2; S15; Review Focus 2) on the engine picked by
// ALTIS_TEST_DB: five masters × list/create/update/archive. Lists need catalog.records.read, writes
// catalog.masters.manage; the store routes answer `{id, version}` only; a master in use cannot be archived (409
// CATALOG_IN_USE, the count in the detail since a problem never carries `meta`).

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
const items = <T = Record<string, unknown>>(res: AgentReply): T[] => (res.json as { items: T[] }).items;

/** A unique code suffix. */
const unique = (): string => newId().slice(-8);

/** The path and a valid create body of each master. */
const MASTERS: readonly { path: string; body: () => Record<string, unknown>; patch: Record<string, unknown> }[] = [
  {
    path: 'material-types',
    body: () => ({
      code: `MT-${unique()}`,
      nameId: 'Partitur',
      nameEn: 'Score',
      marcType: 'c',
      marcLevel: 'm',
      contentType: 'ntm',
      mediaType: 'n',
      carrierType: 'nc',
      schemaType: 'MusicComposition',
      dcmiType: 'Text',
      template: { fields: {}, defaults: {}, customFields: [] },
      sortOrder: 90,
    }),
    patch: { nameEn: 'Music score' },
  },
  { path: 'languages', body: () => ({ code: `l${unique().toLowerCase()}`, nameId: 'Bahasa uji', nameEn: 'Test language' }), patch: { nameEn: 'A test language' } },
  {
    path: 'collection-types',
    body: () => ({ code: `CT-${unique()}`, nameId: 'Hadiah', nameEn: 'Gift', loanable: true, selfService: false, sortOrder: 50 }),
    patch: { selfService: true },
  },
  { path: 'suppliers', body: () => ({ code: `SP-${unique()}`, name: 'CV Pustaka Uji', email: 'toko@example.test' }), patch: { phone: '0274-555' } },
  {
    path: 'custom-fields',
    body: () => ({
      entity: 'records',
      type: 'select',
      code: `cf_${unique().toLowerCase()}`,
      labelId: 'Jenjang',
      options: [{ value: 'sd', labelId: 'Sekolah dasar' }],
      required: false,
      sortOrder: 10,
      isPublic: true,
      isSearchable: false,
    }),
    patch: { labelEn: 'Level' },
  },
];

describe.skipIf(!ctx.available)(`masters API [${engineLabel()}]`, () => {
  let dataDir: string;
  let app: ReturnType<typeof createApp>;
  let manager: Client;
  let reader: Client;
  let cataloguer: Client;
  let buku: string;

  async function signedIn(username: string, permissions: string[]): Promise<Client> {
    const user = await seedStaff(h, { username, now: NOW, roles: [{ permissions: permissions as never }] });
    const token = await sessionCookieFor(h, user.id, { now: NOW });
    const agent = createAgent(app);
    agent.setCookie(SID, token);
    const csrf = { 'x-csrf-token': sessionCsrfFor(CONFIG, token) };
    return {
      get: (p) => agent.get(p),
      send: (method, p, body, key) => agent[method](p, body, key === undefined ? csrf : { ...csrf, 'idempotency-key': key }),
    };
  }

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-api-masters-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
    buku = (await h.db.selectFrom('material_types').select('id').where('code_key', '=', 'BUKU').executeTakeFirstOrThrow()).id;
    app = createApp({ state: { phase: 'ready', db: h, config: CONFIG }, version: '0.1.0', buildId: 'b', log: recordingLogger(), clock: () => NOW });
    manager = await signedIn('kelola_induk', ['catalog.masters.manage', 'catalog.records.read']);
    reader = await signedIn('baca_induk', ['catalog.records.read']);
    cataloguer = await signedIn('katalogisasi', ['catalog.records.manage', 'catalog.records.read']);
  });

  afterAll(async () => {
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  it('GET material-types: the 8 seeded types in seed order; every list answers {items} to a reader', async () => {
    const res = await reader.get(`${API}/material-types`);
    expect(res.status, res.text).toBe(200);
    expect(items<{ code: string }>(res).map((m) => m.code)).toEqual(['BUKU', 'EBOOK', 'KARYA-ILMIAH', 'BERSERI', 'PETA', 'AUDIO', 'VIDEO', 'CAMPURAN']);
    expect(items(res)[0]).toMatchObject({ id: buku, code: 'BUKU', template: { fields: {}, defaults: {}, customFields: [] }, usage: 0, archived: false, version: 0 });
    for (const m of MASTERS) {
      const list = await reader.get(`${API}/${m.path}`);
      expect(list.status, `${m.path}: ${list.text}`).toBe(200);
      expect(Array.isArray(items(list))).toBe(true);
    }
    expect(items<{ code: string }>(await reader.get(`${API}/languages?q=jawa`)).map((l) => l.code)).toEqual(['jav']);
    expect((await reader.get(`${API}/languages?includeArchived=perhaps`)).status).toBe(422);
  });

  it('POST → 201 {id, version} only (S15), listed after; PATCH → 200 {id, version + 1}; a reader cannot write (403)', async () => {
    for (const m of MASTERS) {
      const body = m.body();
      expect((await reader.send('post', `${API}/${m.path}`, body)).status, m.path).toBe(403);
      const created = await manager.send('post', `${API}/${m.path}`, body);
      expect(created.status, `${m.path}: ${created.text}`).toBe(201);
      expect(created.json).toEqual({ id: expect.any(String), version: 0 });
      const { id } = stored(created);
      expect(items<{ id: string }>(await reader.get(`${API}/${m.path}`)).map((x) => x.id), m.path).toContain(id);

      const patched = await manager.send('patch', `${API}/${m.path}/${id}`, { version: 0, ...m.patch });
      expect(patched.status, `${m.path}: ${patched.text}`).toBe(200);
      expect(patched.json).toEqual({ id, version: 1 });
      const listed = items<{ id: string }>(await reader.get(`${API}/${m.path}`)).find((x) => x.id === id);
      expect(listed, m.path).toMatchObject({ ...m.patch, version: 1 });

      const stale = await manager.send('patch', `${API}/${m.path}/${id}`, { version: 0, ...m.patch });
      expect(stale.status, m.path).toBe(409);
      expect(code(stale)).toBe('CONFLICT_STALE');

      const archived = await manager.send('delete', `${API}/${m.path}/${id}`, { version: 1 });
      expect(archived.status, `${m.path}: ${archived.text}`).toBe(200);
      expect(archived.json).toEqual({ id, version: 2 });
      expect(items<{ id: string }>(await reader.get(`${API}/${m.path}`)).map((x) => x.id), m.path).not.toContain(id);
      expect(items<{ id: string; archived: boolean }>(await reader.get(`${API}/${m.path}?includeArchived=true`)).find((x) => x.id === id), m.path).toMatchObject({
        archived: true,
      });
      expect((await manager.send('patch', `${API}/${m.path}/${newId()}`, { version: 0, ...m.patch })).status, m.path).toBe(404);
    }
  });

  it('a taken code → 422 [{path: code, code: taken}]; an Idempotency-Key replays a create', async () => {
    const taken = await manager.send('post', `${API}/collection-types`, { code: ' umum ', nameId: 'Umum lagi', nameEn: 'General again', loanable: true, selfService: true, sortOrder: 1 });
    expect(taken.status).toBe(422);
    expect(errors(taken)).toEqual([{ path: 'code', code: 'taken' }]);

    const body = { code: 'gor', nameId: 'Gorontalo', nameEn: 'Gorontalo' };
    const key = `induk-${newId()}`;
    const first = await manager.send('post', `${API}/languages`, body, key);
    expect(first.status, first.text).toBe(201);
    const again = await manager.send('post', `${API}/languages`, body, key);
    expect(again.status).toBe(201);
    expect(again.json).toEqual(first.json);
    expect(await h.db.selectFrom('languages').select('id').where('code_key', '=', 'GOR').execute()).toEqual([{ id: stored(first).id }]);
  });

  it('Review Focus 2: DELETE BUKU with one live record → 409 CATALOG_IN_USE (count 1 in the detail), nothing archived; an unused master → 200', async () => {
    const record = await cataloguer.send('post', `${API}/records`, { materialTypeId: buku, title: 'Bumi Manusia' });
    expect(record.status, record.text).toBe(201);
    expect(items<{ id: string; usage: number }>(await reader.get(`${API}/material-types`)).find((m) => m.id === buku)?.usage).toBe(1);

    const refused = await manager.send('delete', `${API}/material-types/${buku}`, { version: 0 });
    expect(refused.status).toBe(409);
    expect(code(refused)).toBe('CATALOG_IN_USE');
    expect((refused.json as { detail?: string }).detail).toMatch(/\b1\b/);
    expect(refused.json).not.toHaveProperty('meta');
    expect(await h.db.selectFrom('material_types').select(['archived_at', 'version']).where('id', '=', buku).executeTakeFirstOrThrow()).toEqual({ archived_at: null, version: 0 });

    const peta = (await h.db.selectFrom('material_types').select('id').where('code_key', '=', 'PETA').executeTakeFirstOrThrow()).id;
    const archived = await manager.send('delete', `${API}/material-types/${peta}`, { version: 0 });
    expect(archived.status, archived.text).toBe(200);
    expect(archived.json).toEqual({ id: peta, version: 1 });
  });

  it('a template with fields {subtitle: required} round-trips; an unknown custom code → 422 at template.customFields.0', async () => {
    const template = { fields: { subtitle: 'required' }, defaults: {}, customFields: [] };
    const body = { ...MASTERS[0]!.body(), template };
    const created = await manager.send('post', `${API}/material-types`, body);
    expect(created.status, created.text).toBe(201);
    const { id } = stored(created);
    expect(items<{ id: string }>(await reader.get(`${API}/material-types`)).find((m) => m.id === id)).toMatchObject({ template });

    // The records service now follows the template: a record of this type without a subtitle is refused.
    const missing = await cataloguer.send('post', `${API}/records`, { materialTypeId: id, title: 'Tanpa Anak Judul' });
    expect(missing.status).toBe(422);
    expect(errors(missing)).toEqual([{ path: 'subtitle', code: 'required' }]);

    const unknown = await manager.send('patch', `${API}/material-types/${id}`, { version: 0, template: { ...template, customFields: ['tidak_ada'] } });
    expect(unknown.status).toBe(422);
    expect(errors(unknown)).toEqual([{ path: 'template.customFields.0', code: 'not_found' }]);
  });

  it('custom fields: a select without options → 422 options required; entity or type in a patch → 422; archived even with values', async () => {
    const base = MASTERS[4]!.body();
    const noOptions = await manager.send('post', `${API}/custom-fields`, { ...base, options: undefined });
    expect(noOptions.status).toBe(422);
    expect(errors(noOptions)).toEqual([{ path: 'options', code: 'required' }]);

    const created = await manager.send('post', `${API}/custom-fields`, base);
    expect(created.status, created.text).toBe(201);
    const { id } = stored(created);
    for (const extra of [{ entity: 'items' }, { type: 'text' }]) {
      const refused = await manager.send('patch', `${API}/custom-fields/${id}`, { version: 0, ...extra });
      expect(refused.status).toBe(422);
      expect(errors(refused)).toEqual([{ path: '', code: 'unrecognized_keys' }]);
    }

    const record = await cataloguer.send('post', `${API}/records`, { materialTypeId: buku, title: 'Ronggeng Dukuh Paruk', custom: { [base.code as string]: 'sd' } });
    expect(record.status, record.text).toBe(201);
    expect(items<{ id: string; usage: number }>(await reader.get(`${API}/custom-fields?entity=records`)).find((f) => f.id === id)?.usage).toBe(1);

    // Made searchable while it holds a value: that record's index must be rebuilt, so a catalog.reindex is queued.
    const searchable = await manager.send('patch', `${API}/custom-fields/${id}`, { version: 0, isSearchable: true });
    expect(searchable.status, searchable.text).toBe(200);
    const jobs = await h.db.selectFrom('jobs').select('payload').where('type', '=', 'catalog.reindex').execute();
    expect(jobs.map((j) => JSON.parse(j.payload) as unknown)).toEqual([{ recordIds: [stored(record).id] }]);

    const archived = await manager.send('delete', `${API}/custom-fields/${id}`, { version: 1 });
    expect(archived.status, archived.text).toBe(200);
    expect(archived.json).toEqual({ id, version: 2 });
    expect(await h.db.selectFrom('custom_values').select('field_id').where('field_id', '=', id).execute()).toEqual([{ field_id: id }]);
  });
});
