import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeSettings } from '@altis/core';
import { PHASE1_MIGRATIONS, runMigrations, withTx } from '@altis/db';
import type { IsbnLookupResponse, SruSearchResponse } from '@altis/shared/api/catalog/copy';
import type { SruServer } from '@altis/shared/api/settings';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FAKE_SRU_ISBN, startFakeSru, type FakeSru } from '../../../../packages/core/test/support/fake-sru.js';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { createApp } from '../../src/app.js';
import { createAgent, type AgentReply } from '../agent.js';
import { recordingLogger, sampleConfig } from '../support.js';
import { seedStaff, sessionCookieFor, sessionCsrfFor } from '../support-auth.js';

// The copy-cataloguing API of Phase 2 Task 32 (spec §6.2-§6.3, §12.2, K7; M11, M13) on the engine picked by
// ALTIS_TEST_DB, against the local fake SRU server (`catalog.sru.allowPrivateHosts` on, so 127.0.0.1 is reachable):
// - `GET catalog/lookup/isbn/:isbn`: the local record first, else the enabled servers' candidates with duplicate
//   hints and each server's error; the per-user bucket `catalog_lookup` (30 a minute) → the 31st call is 429;
// - `GET catalog/sru/search`: one page of drafts from an enabled server; its failures are 422/502 problems;
// - `POST catalog/sru/test`: always 200 `{ok, code?, message?, version?}` (P2-17), on the same bucket (M11).

const ctx = testDbContext();
let h: TestDbHandle;

/** In the past: an audit entry may not be dated ahead of the real clock. The bucket's window holds the whole file. */
const NOW = Date.UTC(2026, 9, 22, 10, 0, 5);
const CONFIG = sampleConfig();
const SID = '__Host-altis_sid';
const LOOKUP = '/api/v1/catalog/lookup/isbn';
const SEARCH = '/api/v1/catalog/sru/search';
const TEST = '/api/v1/catalog/sru/test';
const INDEXES = { isbn: 'bath.isbn', title: 'dc.title', author: 'dc.creator', any: 'cql.serverChoice' };

interface Client {
  get(p: string): Promise<AgentReply>;
  post(p: string, body: unknown): Promise<AgentReply>;
}

const code = (res: AgentReply): string | undefined => (res.json as { code?: string } | undefined)?.code;
const errors = (res: AgentReply): { path: string; code: string }[] => (res.json as { errors?: { path: string; code: string }[] }).errors ?? [];

function server(id: string, url: string, o: { enabled?: boolean; version?: SruServer['version'] } = {}): SruServer {
  return { id, name: `Server ${id}`, url, version: o.version ?? '1.2', recordSchema: 'marcxml', indexes: INDEXES, enabled: o.enabled ?? true };
}

describe.skipIf(!ctx.available)(`copy cataloguing API [${engineLabel()}]`, () => {
  let dataDir: string;
  let app: ReturnType<typeof createApp>;
  let fake: FakeSru;
  let manager: Client;
  let reader: Client;
  let settingsAdmin: Client;
  let busy: Client;
  let buku: string;

  async function signedIn(username: string, permissions: string[]): Promise<Client> {
    const user = await seedStaff(h, { username, now: NOW, roles: [{ permissions: permissions as never }] });
    const token = await sessionCookieFor(h, user.id, { now: NOW });
    const agent = createAgent(app);
    agent.setCookie(SID, token);
    const csrf = { 'x-csrf-token': sessionCsrfFor(CONFIG, token) };
    return { get: (p) => agent.get(p), post: (p, body) => agent.post(p, body, csrf) };
  }

  /** Sets the SRU servers and whether private hosts are allowed. */
  async function setSru(servers: SruServer[], allowPrivateHosts = true): Promise<void> {
    await withTx(h, (trx) =>
      writeSettings(trx, { 'catalog.sru.servers': servers, 'catalog.sru.allowPrivateHosts': allowPrivateHosts }, { keyring: CONFIG.keyring, now: NOW, actorId: null }),
    );
  }

  /** A record through the records API (indexed at once); its id. */
  async function createRecord(body: Record<string, unknown>): Promise<string> {
    const res = await manager.post('/api/v1/catalog/records', { materialTypeId: buku, ...body });
    expect(res.status, res.text).toBe(201);
    return (res.json as { id: string }).id;
  }

  const sruRequests = (): number => fake.requests.filter((r) => r.path.startsWith('/sru')).length;

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-api-copy-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
    buku = (await h.db.selectFrom('material_types').select('id').where('code_key', '=', 'BUKU').executeTakeFirstOrThrow()).id;
    fake = await startFakeSru();
    app = createApp({ state: { phase: 'ready', db: h, config: CONFIG }, version: '0.1.0', buildId: 'b', log: recordingLogger(), clock: () => NOW });
    manager = await signedIn('salin_katalog', ['catalog.records.manage', 'catalog.records.read']);
    reader = await signedIn('baca_katalog', ['catalog.records.read']);
    settingsAdmin = await signedIn('atur_sistem', ['system.settings.manage']);
    busy = await signedIn('sibuk', ['catalog.records.manage', 'system.settings.manage']);
    await setSru([server('perpusnas', `${fake.url}/sru`), server('loc', `${fake.url}/sru`, { enabled: false })]);
  });

  afterAll(async () => {
    await fake?.close();
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  it('K7: an ISBN lookup → 1 candidate with the draft title from the enabled server; the disabled one is not asked', async () => {
    const before = sruRequests();
    const res = await manager.get(`${LOOKUP}/978-602-03-3295-6`);
    expect(res.status, res.text).toBe(200);
    const body = res.json as IsbnLookupResponse;
    expect(body).toEqual({
      isbn13: FAKE_SRU_ISBN,
      local: null,
      candidates: [{ source: 'sru:perpusnas', draft: expect.objectContaining({ title: 'Laskar pelangi', materialTypeCode: 'BUKU', items: [] }), duplicate: null }],
      errors: [],
    });
    expect(sruRequests()).toBe(before + 1);
  });

  it('an invalid ISBN → 422 {path: isbn, code: invalid}; a reader without catalog.records.manage → 403', async () => {
    const bad = await manager.get(`${LOOKUP}/12345`);
    expect(bad.status).toBe(422);
    expect(code(bad)).toBe('VALIDATION_FAILED');
    expect(errors(bad)).toEqual([{ path: 'isbn', code: 'invalid' }]);
    expect((await reader.get(`${LOOKUP}/${FAKE_SRU_ISBN}`)).status).toBe(403);
  });

  it('with a local record holding the ISBN → `local` is set and no server is asked', async () => {
    const id = await createRecord({ title: 'Sang Pemimpi', identifiers: [{ type: 'isbn', value: '979-3062-92-4' }] });
    const before = sruRequests();
    const res = await manager.get(`${LOOKUP}/9789793062921`);
    expect(res.status, res.text).toBe(200);
    expect(res.json).toEqual({ isbn13: '9789793062921', local: { recordId: id, title: 'Sang Pemimpi' }, candidates: [], errors: [] });
    expect(sruRequests()).toBe(before);
  });

  it('each candidate carries its duplicate hint: a stored record with the same title, year, author and publisher', async () => {
    const id = await createRecord({
      title: 'Edensor',
      publicationYear: '2007',
      publisher: { name: 'Bentang Pustaka' },
      agents: [{ ref: { type: 'person', name: 'Hirata, Andrea' }, role: 'aut', isMain: true }],
    });
    const res = await manager.get(`${LOOKUP}/9789793062938`);
    expect(res.status, res.text).toBe(200);
    const body = res.json as IsbnLookupResponse;
    expect(body.local).toBeNull();
    expect(body.candidates).toHaveLength(1);
    expect(body.candidates[0]!.draft.title).toBe('Edensor');
    expect(body.candidates[0]!.duplicate).toEqual({ recordId: id, score: 100 });
  });

  it('a private address with allowPrivateHosts false → 200 with errors[0].code CATALOG_OUTBOUND_BLOCKED, nothing sent', async () => {
    await setSru([server('perpusnas', `${fake.url}/sru`)], false);
    try {
      const before = fake.requests.length;
      const res = await manager.get(`${LOOKUP}/${FAKE_SRU_ISBN}`);
      expect(res.status, res.text).toBe(200);
      const body = res.json as IsbnLookupResponse;
      expect(body.candidates).toEqual([]);
      expect(body.errors[0]).toEqual({ source: 'sru:perpusnas', code: 'CATALOG_OUTBOUND_BLOCKED' });
      expect(fake.requests.length).toBe(before);
    } finally {
      await setSru([server('perpusnas', `${fake.url}/sru`), server('loc', `${fake.url}/sru`, { enabled: false })]);
    }
  });

  it('M13: with 5 enabled servers, no more than 3 requests are open at once; one candidate, no error', async () => {
    const own = await startFakeSru();
    try {
      await setSru([1, 2, 3, 4, 5].map((n) => server(`s${n}`, `${own.url}/sru?delay=300`)));
      const res = await manager.get(`${LOOKUP}/${FAKE_SRU_ISBN}`);
      expect(res.status, res.text).toBe(200);
      const body = res.json as IsbnLookupResponse;
      expect(own.requests.filter((r) => r.path.startsWith('/sru')).length).toBe(5);
      expect(own.maxOpenRequests()).toBe(3);
      expect(body.errors).toEqual([]);
      expect(body.candidates.map((c) => c.source)).toEqual(['sru:s1']);
    } finally {
      await own.close();
      await setSru([server('perpusnas', `${fake.url}/sru`), server('loc', `${fake.url}/sru`, { enabled: false })]);
    }
  });

  it('catalog.isbn.arsyaEnabled is accepted and ignored: only the SRU servers are asked, no error (ruling R23)', async () => {
    const arsya = (on: boolean) =>
      withTx(h, (trx) => writeSettings(trx, { 'catalog.isbn.arsyaEnabled': on }, { keyring: CONFIG.keyring, now: NOW, actorId: null }));
    await arsya(true);
    try {
      const res = await manager.get(`${LOOKUP}/${FAKE_SRU_ISBN}`);
      expect(res.status, res.text).toBe(200);
      const body = res.json as IsbnLookupResponse;
      expect(body.candidates.map((c) => c.source)).toEqual(['sru:perpusnas']);
      expect(body.errors).toEqual([]);
    } finally {
      await arsya(false);
    }
  });

  it('the 31st lookup within a minute → 429 with Retry-After; sru/test shares the bucket (M11)', async () => {
    // An ISBN the route refuses is not counted.
    expect((await busy.get(`${LOOKUP}/12345`)).status).toBe(422);
    // A local hit: no server is asked, so the 30 calls are quick.
    for (let i = 0; i < 30; i++) {
      const ok = await busy.get(`${LOOKUP}/9789793062921`);
      expect(ok.status, `call ${i + 1}`).toBe(200);
    }
    const refused = await busy.get(`${LOOKUP}/9789793062921`);
    expect(refused.status).toBe(429);
    expect(code(refused)).toBe('AUTH_TOO_MANY_ATTEMPTS');
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    const test = await busy.post(TEST, { url: `${fake.url}/sru`, version: '1.2' });
    expect(test.status).toBe(429);
    // Another user's bucket is untouched.
    expect((await manager.get(`${LOOKUP}/9789793062921`)).status).toBe(200);
  });

  it('SRU search by title returns drafts, each with its duplicate hint', async () => {
    const res = await manager.get(`${SEARCH}?server=perpusnas&index=title&q=pemimpi`);
    expect(res.status, res.text).toBe(200);
    const body = res.json as SruSearchResponse;
    expect(body.total).toBe(1);
    expect(body.start).toBe(1);
    expect(body.records.map((r) => r.draft.title)).toEqual(['Sang pemimpi']);
    // "Sang Pemimpi" is stored with that ISBN (an earlier case): score 100.
    expect(body.records[0]!.duplicate).toEqual({ recordId: expect.any(String), score: 100 });

    const paged = await manager.get(`${SEARCH}?server=perpusnas&index=author&q=Hirata&start=3`);
    expect(paged.status, paged.text).toBe(200);
    expect(paged.json).toMatchObject({ total: 3, start: 3, records: [{ draft: { title: 'Edensor' } }] });
  });

  it('SRU search: an unknown server or a disabled one → 422 at server; a diagnostic → 502 CATALOG_SRU_INVALID; a failure → 502 CATALOG_OUTBOUND_FAILED; a blocked address → 422', async () => {
    const unknown = await manager.get(`${SEARCH}?server=tidak-ada&index=title&q=x`);
    expect(unknown.status).toBe(422);
    expect(errors(unknown)).toEqual([{ path: 'server', code: 'not_found' }]);
    const disabled = await manager.get(`${SEARCH}?server=loc&index=title&q=x`);
    expect(disabled.status).toBe(422);
    expect(errors(disabled)).toEqual([{ path: 'server', code: 'disabled' }]);

    await setSru([server('diag', `${fake.url}/diag`), server('rusak', `${fake.url}/status/500`), server('bukan', `${fake.url}/redirect/0`)]);
    try {
      const diag = await manager.get(`${SEARCH}?server=diag&index=isbn&q=1`);
      expect(diag.status).toBe(502);
      expect(code(diag)).toBe('CATALOG_SRU_INVALID');
      // L09 (§6.2): the 502 carries the server's diagnostic, cut to 200 characters, as its detail.
      const detail = (diag.json as { detail?: unknown }).detail;
      expect(detail).toMatch(/^Unsupported index: this server does not support/);
      expect(String(detail).length).toBeLessThanOrEqual(200);
      const failed = await manager.get(`${SEARCH}?server=rusak&index=isbn&q=1`);
      expect(failed.status).toBe(502);
      expect(code(failed)).toBe('CATALOG_OUTBOUND_FAILED');
      // An answer that is not SRU: 502 CATALOG_SRU_INVALID with no detail (the message there is ours, not the server's).
      const notSru = await manager.get(`${SEARCH}?server=bukan&index=isbn&q=1`);
      expect([notSru.status, code(notSru)]).toEqual([502, 'CATALOG_SRU_INVALID']);
      expect(notSru.json).not.toHaveProperty('detail');
      await setSru([server('diag', `${fake.url}/diag`)], false);
      const blocked = await manager.get(`${SEARCH}?server=diag&index=isbn&q=1`);
      expect(blocked.status).toBe(422);
      expect(code(blocked)).toBe('CATALOG_OUTBOUND_BLOCKED');
    } finally {
      await setSru([server('perpusnas', `${fake.url}/sru`), server('loc', `${fake.url}/sru`, { enabled: false })]);
    }
    expect((await reader.get(`${SEARCH}?server=perpusnas&index=title&q=x`)).status).toBe(403);
  });

  it('SRU test (P2-17): 200 ok with the reported version, or 200 with the failure; URL credentials → 422; only system.settings.manage', async () => {
    expect(await settingsAdmin.post(TEST, { url: `${fake.url}/sru`, version: '1.1' })).toMatchObject({ status: 200, json: { ok: true, version: '1.1' } });
    const diag = await settingsAdmin.post(TEST, { url: `${fake.url}/diag`, version: '1.2' });
    expect(diag.status).toBe(200);
    expect(diag.json).toMatchObject({ ok: false, code: 'CATALOG_SRU_INVALID', message: expect.stringMatching(/^Unsupported index/) });
    const missing = await settingsAdmin.post(TEST, { url: `${fake.url}/status/404`, version: '1.2' });
    expect(missing.json).toEqual({ ok: false, code: 'CATALOG_OUTBOUND_FAILED', message: 'status 404' });

    await setSru([], false);
    try {
      const blocked = await settingsAdmin.post(TEST, { url: `${fake.url}/sru`, version: '1.2' });
      expect(blocked.status).toBe(200);
      expect(blocked.json).toEqual({ ok: false, code: 'CATALOG_OUTBOUND_BLOCKED' });
    } finally {
      await setSru([server('perpusnas', `${fake.url}/sru`), server('loc', `${fake.url}/sru`, { enabled: false })]);
    }

    const credentials = await settingsAdmin.post(TEST, { url: fake.url.replace('http://', 'http://ani:rahasia@') + '/sru', version: '1.2' });
    expect(credentials.status).toBe(422);
    expect(errors(credentials)).toEqual([{ path: 'url', code: 'invalid_url' }]);
    expect((await manager.post(TEST, { url: `${fake.url}/sru`, version: '1.2' })).status).toBe(403);
  });
});
