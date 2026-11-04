import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations } from '@altis/db';
import { newId, normalizeKey } from '@altis/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { createApp } from '../../src/app.js';
import { createAgent, type AgentReply } from '../agent.js';
import { recordingLogger, sampleConfig } from '../support.js';
import { seedStaff, sessionCookieFor, sessionCsrfFor } from '../support-auth.js';

// The items API of Phase 2 Task 17 (spec §3.4, §12.2, §12.3; K2, K4; M2, M8, S15) on the engine picked by
// ALTIS_TEST_DB: branch-scoped writes (a holder at branch A is refused at branch B), the by-barcode lookup by query,
// the store routes' compact answers, the batch's lock row made by its `prepare`, and the bulk summary.

const ctx = testDbContext();
let h: TestDbHandle;

/** In the past: an audit entry may not be dated ahead of the real clock. */
const NOW = Date.UTC(2026, 9, 22, 9, 0, 5);
const CONFIG = sampleConfig();
const SID = '__Host-altis_sid';
const API = '/api/v1';

interface Client {
  get(p: string): Promise<AgentReply>;
  send(method: 'post' | 'patch' | 'put' | 'delete', p: string, body?: unknown, key?: string): Promise<AgentReply>;
}

const code = (res: AgentReply): string | undefined => (res.json as { code?: string } | undefined)?.code;
const errors = (res: AgentReply): { path: string; code: string }[] => (res.json as { errors?: { path: string; code: string }[] }).errors ?? [];

describe.skipIf(!ctx.available)(`items API [${engineLabel()}]`, () => {
  let dataDir: string;
  let app: ReturnType<typeof createApp>;
  let manager: Client;
  let branchHolder: Client;
  let reader: Client;
  let branchA: string;
  let branchB: string;
  let recordId: string;
  let umum: string;

  async function signedIn(username: string, roles: { permissions: string[]; branchId?: string }[]): Promise<Client> {
    const user = await seedStaff(h, { username, now: NOW, roles: roles.map((r) => ({ permissions: r.permissions as never, ...(r.branchId === undefined ? {} : { branchId: r.branchId }) })) });
    const token = await sessionCookieFor(h, user.id, { now: NOW });
    const agent = createAgent(app);
    agent.setCookie(SID, token);
    const csrf = { 'x-csrf-token': sessionCsrfFor(CONFIG, token) };
    return {
      get: (p) => agent.get(p),
      send: (method, p, body, key) => agent[method](p, body, key === undefined ? csrf : { ...csrf, 'idempotency-key': key }),
    };
  }

  const seedBranch = async (code: string, isDefault: 0 | 1): Promise<string> => {
    const id = newId();
    await h.db
      .insertInto('branches')
      .values({ id, code_key: normalizeKey(code), code_display: code, name: `Cabang ${code}`, timezone: 'Asia/Jakarta', is_default: isDefault, created_at: NOW, updated_at: NOW })
      .execute();
    return id;
  };

  const createItem = async (client: Client, branchId: string, barcode: string, extra: Record<string, unknown> = {}): Promise<AgentReply> =>
    client.send('post', `${API}/branches/${branchId}/items`, { recordId, barcode, collectionTypeId: umum, ...extra });

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-api-items-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
    branchA = await seedBranch('PUSAT', 1);
    branchB = await seedBranch('UTARA', 0);
    const buku = (await h.db.selectFrom('material_types').select('id').where('code_key', '=', 'BUKU').executeTakeFirstOrThrow()).id;
    umum = (await h.db.selectFrom('collection_types').select('id').where('code_key', '=', 'UMUM').executeTakeFirstOrThrow()).id;
    recordId = newId();
    await h.db
      .insertInto('records')
      .values({
        id: recordId,
        material_type_id: buku,
        title: 'Ronggeng Dukuh Paruk',
        subtitle: null,
        responsibility: null,
        title_key: 'ronggeng dukuh paruk',
        edition: null,
        material_detail: null,
        publisher_id: null,
        publication_place: null,
        publication_year: null,
        publication_date_text: null,
        physical_desc: null,
        series: null,
        classification: null,
        call_number: '899.221 TOH r',
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
    app = createApp({ state: { phase: 'ready', db: h, config: CONFIG }, version: '0.1.0', buildId: 'b', log: recordingLogger(), clock: () => NOW });
    manager = await signedIn('kelola_eksemplar', [{ permissions: ['catalog.items.manage', 'catalog.records.read'] }]);
    branchHolder = await signedIn('eksemplar_pusat', [{ permissions: ['catalog.records.read'] }, { permissions: ['catalog.items.manage'], branchId: branchA }]);
    reader = await signedIn('baca_eksemplar', [{ permissions: ['catalog.records.read'] }]);
  });

  afterAll(async () => {
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  it('POST → 201 {id, version} only (S15); the catalog.item.changed event exists; GET answers the detail with its history', async () => {
    const res = await createItem(manager, branchA, 'API-0001', { price: '125000.00' });
    expect(res.status, res.text).toBe(201);
    expect(res.json).toEqual({ id: expect.any(String), version: 0 });
    const id = (res.json as { id: string }).id;
    const events = await h.db.selectFrom('events').select(['channel', 'payload']).where('type', '=', 'catalog.item.changed').execute();
    expect(events.filter((e) => e.channel === 'catalog' && JSON.parse(e.payload).id === id)).toEqual([
      { channel: 'catalog', payload: JSON.stringify({ id, recordId }) },
    ]);
    const detail = await reader.get(`${API}/catalog/items/${id}`);
    expect(detail.status).toBe(200);
    expect(detail.json).toMatchObject({ id, barcode: 'API-0001', price: '125000.00', currency: 'IDR', status: 'available', loanable: true, history: [{ type: 'created' }] });
    expect((await reader.get(`${API}/catalog/items/${newId()}`)).status).toBe(404);
  });

  it('a holder of catalog.items.manage at branch A writes at A and gets 403 at B (K2)', async () => {
    expect((await createItem(branchHolder, branchA, 'API-A-01')).status).toBe(201);
    const refused = await createItem(branchHolder, branchB, 'API-B-01');
    expect(refused.status).toBe(403);
    expect(code(refused)).toBe('AUTHZ_DENIED');
    expect((await reader.send('post', `${API}/branches/${branchA}/items`, { recordId, barcode: 'API-R-01', collectionTypeId: umum })).status).toBe(403);
  });

  it('an item of another branch is 404 through the path of this branch; a location of another branch is invalid', async () => {
    const res = await createItem(manager, branchB, 'API-B-02');
    const id = (res.json as { id: string }).id;
    const patched = await manager.send('patch', `${API}/branches/${branchA}/items/${id}`, { version: 0, note: 'x' });
    expect(patched.status).toBe(404);
    const location = newId();
    await h.db
      .insertInto('locations')
      .values({ id: location, branch_id: branchB, parent_id: null, kind: 'shelf', code_display: 'RAK-U', code_key: 'RAK-U', name: 'Rak Utara', shelf_hint: null, class_from: null, class_to: null, map_file_id: null, map_x: null, map_y: null, map_w: null, map_h: null, archived_at: null, created_at: NOW, created_by: null, updated_at: NOW, updated_by: null })
      .execute();
    const bad = await createItem(manager, branchA, 'API-A-02', { locationId: location });
    expect(bad.status).toBe(422);
    expect(errors(bad)).toEqual([{ path: 'locationId', code: 'invalid' }]);
  });

  it("M2: GET catalog/items/by-barcode?barcode=B%2F01 finds the item 'B/01'; an ISBN is isbn_not_barcode; none → 404", async () => {
    const res = await createItem(manager, branchA, 'b/01');
    const id = (res.json as { id: string }).id;
    const found = await reader.get(`${API}/catalog/items/by-barcode?barcode=B%2F01`);
    expect(found.status, found.text).toBe(200);
    expect(found.json).toMatchObject({ id, barcode: 'B/01' });
    const isbn = await reader.get(`${API}/catalog/items/by-barcode?barcode=9786020332956`);
    expect(isbn.status).toBe(422);
    expect(errors(isbn)).toEqual([{ path: 'barcode', code: 'isbn_not_barcode' }]);
    expect((await reader.get(`${API}/catalog/items/by-barcode?barcode=TIDAK-ADA`)).status).toBe(404);
  });

  it('PATCH and DELETE answer {id, version}; an illegal status change → 409 ITEM_STATUS_TRANSITION', async () => {
    const id = ((await createItem(manager, branchA, 'API-0002')).json as { id: string }).id;
    const lost = await manager.send('patch', `${API}/branches/${branchA}/items/${id}`, { version: 0, status: 'lost' });
    expect(lost.status).toBe(409);
    expect(code(lost)).toBe('ITEM_STATUS_TRANSITION');
    const patched = await manager.send('patch', `${API}/branches/${branchA}/items/${id}`, { version: 0, status: 'repair' });
    expect(patched.status, patched.text).toBe(200);
    expect(patched.json).toEqual({ id, version: 1 });
    const archived = await manager.send('delete', `${API}/branches/${branchA}/items/${id}`, { version: 1 });
    expect(archived.status, archived.text).toBe(200);
    expect(archived.json).toEqual({ id, version: 2 });
    expect((await reader.get(`${API}/catalog/items/${id}`)).json).toMatchObject({ status: 'withdrawn', archived: true });
  });

  it('batch by pattern: prepare makes the lock row (M8); 201 with created and skipped; a replay answers the same', async () => {
    await h.db.deleteFrom('locks').where('name', '=', 'catalog.barcode:default').execute();
    const body = { recordId, count: 3, patternId: 'default', template: { collectionTypeId: umum } };
    const res = await manager.send('post', `${API}/branches/${branchA}/items/batch`, body, 'batch-key-0001');
    expect(res.status, res.text).toBe(201);
    expect(res.json).toEqual({
      created: [
        { id: expect.any(String), barcode: 'B0000001' },
        { id: expect.any(String), barcode: 'B0000002' },
        { id: expect.any(String), barcode: 'B0000003' },
      ],
      skipped: [],
    });
    const replay = await manager.send('post', `${API}/branches/${branchA}/items/batch`, body, 'batch-key-0001');
    expect(replay.status).toBe(201);
    expect(replay.json).toEqual(res.json);
    expect(await h.db.selectFrom('locks').select('name').where('name', '=', 'catalog.barcode:default').execute()).toHaveLength(1);
    const unknown = await manager.send('post', `${API}/branches/${branchA}/items/batch`, { ...body, patternId: 'tidak-ada' });
    expect(unknown.status).toBe(422);
    expect(errors(unknown)).toEqual([{ path: 'patternId', code: 'not_found' }]);
    expect(await h.db.selectFrom('locks').select('name').where('name', '=', 'catalog.barcode:tidak-ada').execute()).toEqual([]);
  });

  it('bulk: 200 {updated, refused}', async () => {
    const a = ((await createItem(manager, branchA, 'API-0003')).json as { id: string }).id;
    const b = ((await createItem(manager, branchA, 'API-0004', { status: 'on_order' })).json as { id: string }).id;
    const res = await manager.send('post', `${API}/branches/${branchA}/items/bulk`, { ids: [a, b], set: { status: 'repair' } });
    expect(res.status, res.text).toBe(200);
    expect(res.json).toEqual({ updated: 1, refused: [{ id: b, code: 'invalid_transition' }] });
  });

  it('GET catalog/items lists by keyset with the filters of the query', async () => {
    const page = await reader.get(`${API}/catalog/items?branchId=${branchA}&barcodePrefix=API-000&limit=2`);
    expect(page.status, page.text).toBe(200);
    const json = page.json as { items: { barcode: string }[]; nextCursor: string | null };
    expect(json.items.map((i) => i.barcode)).toEqual(['API-0001', 'API-0002']);
    const next = await reader.get(`${API}/catalog/items?branchId=${branchA}&barcodePrefix=API-000&limit=2&cursor=${encodeURIComponent(json.nextCursor!)}`);
    expect((next.json as { items: { barcode: string }[] }).items.map((i) => i.barcode)).toEqual(['API-0003', 'API-0004']);
  });
});
