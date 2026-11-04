import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations } from '@altis/db';
import { newId } from '@altis/shared';
import type { LocationListResponse } from '@altis/shared/api/catalog/locations';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { createApp } from '../../src/app.js';
import { createAgent, type AgentReply } from '../agent.js';
import { recordingLogger, sampleConfig } from '../support.js';
import { seedStaff, sessionCookieFor, sessionCsrfFor, type SeedRole } from '../support-auth.js';

// The locations API of Phase 2 Task 14 (spec §2.2 `locations`, §3.6, §12.2, §12.3; D2-02; S15; Review Focus 2) on the
// engine picked by ALTIS_TEST_DB: the writes are branch-scoped (`branches/:branchId/locations`, `branchParam`), answer
// `{id, version}` only, and an object of another branch is 404.

const ctx = testDbContext();
let h: TestDbHandle;

/** In the past: an audit entry may not be dated ahead of the real clock. */
const NOW = Date.UTC(2026, 9, 22, 8, 30, 0);
const CONFIG = sampleConfig();
const SID = '__Host-altis_sid';
const LIST = '/api/v1/catalog/locations';

interface Client {
  get(p: string): Promise<AgentReply>;
  send(method: 'post' | 'patch' | 'put' | 'delete', p: string, body?: unknown, key?: string): Promise<AgentReply>;
}

const code = (res: AgentReply): string | undefined => (res.json as { code?: string } | undefined)?.code;
const errors = (res: AgentReply): { path: string; code: string }[] => (res.json as { errors?: { path: string; code: string }[] }).errors ?? [];
const stored = (res: AgentReply): { id: string; version: number } => res.json as { id: string; version: number };

describe.skipIf(!ctx.available)(`locations API [${engineLabel()}]`, () => {
  let dataDir: string;
  let app: ReturnType<typeof createApp>;
  let manager: Client;
  let reader: Client;
  let branchA: string;
  let branchB: string;
  let serial = 0;

  const at = (branchId: string, rest = ''): string => `/api/v1/branches/${branchId}/locations${rest}`;

  async function signedIn(username: string, roles: SeedRole[]): Promise<Client> {
    const user = await seedStaff(h, { username, now: NOW, roles });
    const token = await sessionCookieFor(h, user.id, { now: NOW });
    const agent = createAgent(app);
    agent.setCookie(SID, token);
    const csrf = { 'x-csrf-token': sessionCsrfFor(CONFIG, token) };
    return {
      get: (p) => agent.get(p),
      send: (method, p, body, key) => agent[method](p, body, key === undefined ? csrf : { ...csrf, 'idempotency-key': key }),
    };
  }

  /** Creates a location of `kind` in `branchId` through the API; its id. */
  async function create(branchId: string, kind: 'room' | 'area' | 'shelf', o: Record<string, unknown> = {}): Promise<string> {
    serial += 1;
    const res = await manager.send('post', at(branchId), { parentId: null, kind, code: `K-${serial}`, name: `Lokasi ${serial}`, isPublic: true, sortOrder: 0, ...o });
    expect(res.status, res.text).toBe(201);
    return stored(res).id;
  }

  async function seedBranch(code: string): Promise<string> {
    const id = newId();
    await h.db
      .insertInto('branches')
      .values({ id, code_key: code, code_display: code, name: `Cabang ${code}`, timezone: 'Asia/Jakarta', is_default: 0, created_at: NOW, updated_at: NOW })
      .execute();
    return id;
  }

  /** A record with one live item on `locationId` (Tasks 16 and 17 write them through their services). */
  async function seedItemOn(branchId: string, locationId: string): Promise<void> {
    const recordId = newId();
    const material = (await h.db.selectFrom('material_types').select('id').where('code_key', '=', 'BUKU').executeTakeFirstOrThrow()).id;
    const collection = (await h.db.selectFrom('collection_types').select('id').where('code_key', '=', 'UMUM').executeTakeFirstOrThrow()).id;
    await h.db
      .insertInto('records')
      .values({
        id: recordId,
        material_type_id: material,
        title: 'Di Rak',
        subtitle: null,
        responsibility: null,
        title_key: 'di rak',
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
    const itemId = newId();
    await h.db
      .insertInto('items')
      .values({
        id: itemId,
        record_id: recordId,
        branch_id: branchId,
        barcode_display: `B${itemId.slice(-10)}`,
        barcode_key: `B${itemId.slice(-10)}`,
        inventory_no: null,
        call_number: null,
        location_id: locationId,
        collection_type_id: collection,
        status: 'available',
        status_note: null,
        acq_source: null,
        order_no: null,
        order_date: null,
        received_date: null,
        invoice_date: null,
        supplier_id: null,
        invoice_no: null,
        price: null,
        currency: null,
        note: null,
        archived_at: null,
        created_at: NOW,
        created_by: null,
        updated_at: NOW,
        updated_by: null,
      })
      .execute();
  }

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-api-locations-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
    branchA = await seedBranch('ALFA');
    branchB = await seedBranch('BETA');
    app = createApp({ state: { phase: 'ready', db: h, config: CONFIG }, version: '0.1.0', buildId: 'b', log: recordingLogger(), clock: () => NOW });
    manager = await signedIn('kelola_lokasi', [{ permissions: ['catalog.locations.manage', 'catalog.records.read'] }]);
    reader = await signedIn('baca_lokasi', [{ permissions: ['catalog.records.read'] }]);
  });

  afterAll(async () => {
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  it('POST → 201 {id, version} only (S15); the replay of its Idempotency-Key answers the same; GET lists the tree', async () => {
    const key = `lokasi-${newId()}`;
    const body = { parentId: null, kind: 'room', code: 'LT1', name: 'Lantai 1', isPublic: true, sortOrder: 0 };
    const first = await manager.send('post', at(branchA), body, key);
    expect(first.status, first.text).toBe(201);
    expect(first.json).toEqual({ id: expect.any(String), version: 0 });
    const again = await manager.send('post', at(branchA), body, key);
    expect([again.status, again.json]).toEqual([201, first.json]);
    const room = stored(first).id;
    const shelf = await create(branchA, 'shelf', { parentId: room, code: 'R-800', name: 'Rak 800-899 Kesusastraan', classFrom: '800', classTo: '899' });

    const list = await reader.get(`${LIST}?branchId=${branchA}`);
    expect(list.status, list.text).toBe(200);
    const items = (list.json as LocationListResponse).items;
    expect(items.map((l) => [l.code, l.kind, l.parentId])).toEqual([
      ['LT1', 'room', null],
      ['R-800', 'shelf', room],
    ]);
    // The empty shelf hint is the name cut to 40 characters (§3.6).
    expect(items[1]).toMatchObject({ id: shelf, shelfHint: 'Rak 800-899 Kesusastraan', classFrom: '800', classTo: '899', itemCount: 0, archived: false });
    expect((await reader.get(`${LIST}?branchId=${branchB}`)).json).toEqual({ items: [] });
    expect((await reader.get(`${LIST}?branchId=nope`)).status).toBe(422);
  });

  it('a reader cannot write: 403', async () => {
    const res = await reader.send('post', at(branchA), { parentId: null, kind: 'room', code: 'X', name: 'X', isPublic: true, sortOrder: 0 });
    expect([res.status, code(res)]).toEqual([403, 'AUTHZ_DENIED']);
  });

  it('D2-02: a holder of catalog.locations.manage at branch A → 403 on branch B; a branch-A location through branches/B → 404', async () => {
    const branchOnly = await signedIn('lokasi_alfa', [{ permissions: ['catalog.locations.manage'], branchId: branchA }]);
    const body = { parentId: null, kind: 'room', code: 'CAB-A', name: 'Ruang Cabang A', isPublic: true, sortOrder: 0 };
    const own = await branchOnly.send('post', at(branchA), body);
    expect(own.status, own.text).toBe(201);
    const refused = await branchOnly.send('post', at(branchB), { ...body, code: 'CAB-B' });
    expect([refused.status, code(refused)]).toEqual([403, 'AUTHZ_DENIED']);
    expect(await h.db.selectFrom('locations').select('id').where('code_key', '=', 'CAB-B').execute()).toEqual([]);

    // The global manager may write in B, but a location of A is not there: 404, and nothing changes.
    const id = stored(own).id;
    const patch = await manager.send('patch', at(branchB, `/${id}`), { version: 0, name: 'Diambil' });
    expect([patch.status, code(patch)]).toEqual([404, 'NOT_FOUND']);
    const del = await manager.send('delete', at(branchB, `/${id}`), { version: 0 });
    expect([del.status, code(del)]).toEqual([404, 'NOT_FOUND']);
    const map = await manager.send('put', at(branchB, `/${id}/map`), { version: 0, floorPlanFileId: null });
    expect([map.status, code(map)]).toEqual([404, 'NOT_FOUND']);
    expect(await h.db.selectFrom('locations').select(['name', 'version']).where('id', '=', id).executeTakeFirstOrThrow()).toEqual({
      name: 'Ruang Cabang A',
      version: 0,
    });
    // The branch holder edits its own.
    const ok = await branchOnly.send('patch', at(branchA, `/${id}`), { version: 0, name: 'Ruang Baca' });
    expect([ok.status, ok.json]).toEqual([200, { id, version: 1 }]);
  });

  it('depth rules: a shelf in a shelf, or a parent of another branch → 422 invalid_parent', async () => {
    const room = await create(branchA, 'room');
    const shelf = await create(branchA, 'shelf', { parentId: room });
    const roomB = await create(branchB, 'room');
    for (const parentId of [shelf, roomB]) {
      const res = await manager.send('post', at(branchA), { parentId, kind: 'shelf', code: `S-${newId()}`.slice(0, 32), name: 'Rak', isPublic: true, sortOrder: 0 });
      expect([res.status, code(res), errors(res)]).toEqual([422, 'VALIDATION_FAILED', [{ path: 'parentId', code: 'invalid_parent' }]]);
    }
  });

  it('Review Focus 2: archiving a shelf holding an item, or a room holding a shelf → 409 CATALOG_IN_USE', async () => {
    const room = await create(branchA, 'room');
    const shelf = await create(branchA, 'shelf', { parentId: room });
    await seedItemOn(branchA, shelf);
    const busyShelf = await manager.send('delete', at(branchA, `/${shelf}`), { version: 0 });
    expect([busyShelf.status, code(busyShelf)]).toEqual([409, 'CATALOG_IN_USE']);
    const busyRoom = await manager.send('delete', at(branchA, `/${room}`), { version: 0 });
    expect([busyRoom.status, code(busyRoom)]).toEqual([409, 'CATALOG_IN_USE']);
    // An empty room archives.
    const empty = await create(branchA, 'room');
    const ok = await manager.send('delete', at(branchA, `/${empty}`), { version: 0 });
    expect([ok.status, ok.json]).toEqual([200, { id: empty, version: 1 }]);
    const stale = await manager.send('patch', at(branchA, `/${room}`), { version: 5, name: 'Basi' });
    expect([stale.status, code(stale)]).toEqual([409, 'CONFLICT_STALE']);
  });

  it('PUT …/map: the box bounds; a floor plan becomes the room’s public file and a new plan orphans the old one', async () => {
    const room = await create(branchA, 'room');
    const area = await create(branchA, 'area', { parentId: room });
    const outside = await manager.send('put', at(branchA, `/${area}/map`), { version: 0, box: { x: 500, y: 500, w: 501, h: 500 } });
    expect([outside.status, errors(outside)]).toEqual([422, [{ path: 'box.w', code: 'too_big' }]]);
    const inside = await manager.send('put', at(branchA, `/${area}/map`), { version: 0, box: { x: 500, y: 500, w: 500, h: 500 } });
    expect([inside.status, inside.json]).toEqual([200, { id: area, version: 1 }]);

    const plan = async (): Promise<string> => {
      const id = newId();
      await h.db
        .insertInto('files')
        .values({ id, original_name: 'denah.png', mime: 'image/png', size: 64, sha256: 'd'.repeat(64), context: 'catalog.floor_plan', owner_type: null, owner_id: null, access: 'staff', status: 'ok', created_at: NOW, created_by: null })
        .execute();
      return id;
    };
    const owner = (id: string) => h.db.selectFrom('files').select(['owner_type', 'owner_id', 'access']).where('id', '=', id).executeTakeFirstOrThrow();
    const first = await plan();
    const set1 = await manager.send('put', at(branchA, `/${room}/map`), { version: 0, floorPlanFileId: first });
    expect([set1.status, set1.json]).toEqual([200, { id: room, version: 1 }]);
    expect(await owner(first)).toEqual({ owner_type: 'locations', owner_id: room, access: 'public' });
    const second = await plan();
    const set2 = await manager.send('put', at(branchA, `/${room}/map`), { version: 1, floorPlanFileId: second });
    expect(set2.status, set2.text).toBe(200);
    expect(await owner(first)).toEqual({ owner_type: null, owner_id: null, access: 'staff' });
    expect(await owner(second)).toEqual({ owner_type: 'locations', owner_id: room, access: 'public' });

    const listed = ((await reader.get(`${LIST}?branchId=${branchA}`)).json as LocationListResponse).items;
    expect(listed.find((l) => l.id === room)).toMatchObject({ mapFileId: second, box: null, version: 2 });
    expect(listed.find((l) => l.id === area)).toMatchObject({ mapFileId: null, box: { x: 500, y: 500, w: 500, h: 500 } });
  });

  it('Task 40: a move to another room clears the boxes drawn on the old plan and names them in the answer', async () => {
    const room = await create(branchA, 'room');
    const other = await create(branchA, 'room');
    const area = await create(branchA, 'area', { parentId: room });
    const shelf = await create(branchA, 'shelf', { parentId: area });
    const drawn = await manager.send('put', at(branchA, `/${shelf}/map`), { version: 0, box: { x: 10, y: 10, w: 100, h: 50 } });
    expect(drawn.status, drawn.text).toBe(200);
    const res = await manager.send('patch', at(branchA, `/${area}`), { version: 0, parentId: other });
    expect([res.status, res.json]).toEqual([200, { id: area, version: 1, boxesCleared: [shelf] }]);
    const listed = ((await reader.get(`${LIST}?branchId=${branchA}`)).json as LocationListResponse).items;
    expect(listed.find((l) => l.id === shelf)).toMatchObject({ box: null, version: 2 });
  });

  it('a room turned non-public with an item below queues a catalog.reindex of that record (the facets of §4.6)', async () => {
    const room = await create(branchA, 'room');
    const shelf = await create(branchA, 'shelf', { parentId: room });
    await seedItemOn(branchA, shelf);
    const recordId = (await h.db.selectFrom('items').select('record_id').where('location_id', '=', shelf).executeTakeFirstOrThrow()).record_id;
    const res = await manager.send('patch', at(branchA, `/${room}`), { version: 0, isPublic: false });
    expect([res.status, res.json]).toEqual([200, { id: room, version: 1 }]);
    const jobs = await h.db.selectFrom('jobs').select('payload').where('type', '=', 'catalog.reindex').execute();
    expect(jobs.map((j) => JSON.parse(j.payload))).toContainEqual({ recordIds: [recordId] });
  });
});
