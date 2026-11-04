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

// The records API of Phase 2 Task 16 (spec §3.1–§3.3, §12.2; S4, S15; Review Focus 4) on the engine picked by
// ALTIS_TEST_DB: the store routes answer `{id, version, warnings?}` only, field errors are VALIDATION_FAILED with
// paths, and every write publishes `catalog.record.changed`.

const ctx = testDbContext();
let h: TestDbHandle;

/** In the past: an audit entry may not be dated ahead of the real clock. */
const NOW = Date.UTC(2026, 9, 21, 9, 0, 5);
const CONFIG = sampleConfig();
const SID = '__Host-altis_sid';
const RECORDS = '/api/v1/catalog/records';

interface Client {
  get(p: string): Promise<AgentReply>;
  send(method: 'post' | 'patch' | 'put' | 'delete', p: string, body?: unknown, key?: string): Promise<AgentReply>;
}

const code = (res: AgentReply): string | undefined => (res.json as { code?: string } | undefined)?.code;
const errors = (res: AgentReply): { path: string; code: string }[] => (res.json as { errors?: { path: string; code: string }[] }).errors ?? [];
const stored = (res: AgentReply): { id: string; version: number; warnings?: { path: string; code: string }[] } =>
  res.json as { id: string; version: number; warnings?: { path: string; code: string }[] };

describe.skipIf(!ctx.available)(`records API [${engineLabel()}]`, () => {
  let dataDir: string;
  let app: ReturnType<typeof createApp>;
  let manager: Client;
  let reader: Client;
  let buku: string;
  let branchId: string;

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

  const create = async (body: Record<string, unknown> = {}): Promise<string> => {
    const res = await manager.send('post', RECORDS, { materialTypeId: buku, title: 'Laut Bercerita', ...body });
    expect(res.status, res.text).toBe(201);
    return stored(res).id;
  };

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-api-records-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
    branchId = newId();
    await h.db
      .insertInto('branches')
      .values({ id: branchId, code_key: 'PUSAT', code_display: 'PUSAT', name: 'Perpustakaan Pusat', timezone: 'Asia/Jakarta', is_default: 1, created_at: NOW, updated_at: NOW })
      .execute();
    buku = (await h.db.selectFrom('material_types').select('id').where('code_key', '=', 'BUKU').executeTakeFirstOrThrow()).id;
    app = createApp({ state: { phase: 'ready', db: h, config: CONFIG }, version: '0.1.0', buildId: 'b', log: recordingLogger(), clock: () => NOW });
    manager = await signedIn('kelola_katalog', ['catalog.records.manage', 'catalog.records.read']);
    reader = await signedIn('baca_katalog', ['catalog.records.read']);
  });

  afterAll(async () => {
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  it('POST → 201 {id, version} only (S15), the catalog.record.changed event exists; GET answers the detail', async () => {
    const res = await manager.send('post', RECORDS, {
      materialTypeId: buku,
      title: 'Laut Bercerita',
      identifiers: [{ type: 'isbn', value: '978-602-424-694-5' }],
      agents: [{ ref: { type: 'person', name: 'Chudori, Leila S.' }, role: 'aut', isMain: true }],
    });
    expect(res.status, res.text).toBe(201);
    expect(res.json).toEqual({ id: expect.any(String), version: 0 });
    const id = stored(res).id;
    const events = await h.db.selectFrom('events').select(['channel', 'payload']).where('type', '=', 'catalog.record.changed').execute();
    expect(events.filter((e) => e.channel === 'catalog' && JSON.parse(e.payload).id === id)).toHaveLength(1);

    const detail = await reader.get(`${RECORDS}/${id}`);
    expect(detail.status).toBe(200);
    expect(detail.json).toMatchObject({ id, version: 0, title: 'Laut Bercerita', agents: [{ name: 'Chudori, Leila S.', role: 'aut', isMain: true }], warnings: [] });
    expect((await reader.get(`${RECORDS}/${newId()}`)).status).toBe(404);
  });

  it('a reader cannot write: 403', async () => {
    const res = await reader.send('post', RECORDS, { materialTypeId: buku, title: 'Tidak Boleh' });
    expect(res.status).toBe(403);
  });

  it('S4: links → one public URL attachment and the warning invalid_url at links.1.url', async () => {
    const res = await manager.send('post', RECORDS, { materialTypeId: buku, title: 'Pulang', links: [{ url: 'https://a.example' }, { url: 'javascript:x' }] });
    expect(res.status).toBe(201);
    expect(res.json).toEqual({ id: expect.any(String), version: 0, warnings: [{ path: 'links.1.url', code: 'invalid_url' }] });
    const rows = await h.db.selectFrom('attachments').select(['kind', 'access', 'url']).where('record_id', '=', stored(res).id).execute();
    expect(rows).toEqual([{ kind: 'url', access: 'public', url: 'https://a.example/' }]);
  });

  it('S15: 60 000-byte summary and notes and 200 subjects with an Idempotency-Key → {id, version}; the replay answers the same', async () => {
    const big = 'é'.repeat(30_000); // 60 000 UTF-8 bytes
    const body = {
      materialTypeId: buku,
      title: 'Amba',
      summary: big,
      notes: big,
      subjects: Array.from({ length: 200 }, (_, i) => ({ ref: { type: 'topic', term: `Subjek Uji ${i}` }, isPrimary: i === 0 })),
    };
    const key = `rekam-${newId()}`;
    const first = await manager.send('post', RECORDS, body, key);
    expect(first.status, first.text).toBe(201);
    expect(first.json).toEqual({ id: expect.any(String), version: 0 });
    const again = await manager.send('post', RECORDS, body, key);
    expect(again.status).toBe(201);
    expect(again.json).toEqual(first.json);
    expect(await h.db.selectFrom('records').select('id').where('title', '=', 'Amba').execute()).toEqual([{ id: stored(first).id }]);
    expect(await h.db.selectFrom('record_subjects').select('subject_id').where('record_id', '=', stored(first).id).execute()).toHaveLength(200);
  });

  it('PATCH: a stale version → 409 CONFLICT_STALE; a required subtitle that is missing → 422 at subtitle', async () => {
    const id = await create({ title: 'Namaku Alam' });
    const ok = await manager.send('patch', `${RECORDS}/${id}`, { version: 0, edition: 'Cet. 2' });
    expect(ok.status, ok.text).toBe(200);
    expect(ok.json).toEqual({ id, version: 1 });
    const stale = await manager.send('patch', `${RECORDS}/${id}`, { version: 0, edition: 'Cet. 3' });
    expect(stale.status).toBe(409);
    expect(code(stale)).toBe('CONFLICT_STALE');

    const typeId = newId();
    await h.db
      .insertInto('material_types')
      .values({
        id: typeId,
        code_display: 'TESIS',
        code_key: normalizeKey('TESIS'),
        name_id: 'Tesis',
        name_en: 'Thesis',
        marc_type: 'a',
        template: JSON.stringify({ fields: { subtitle: 'required' }, defaults: {}, customFields: [] }),
        created_at: NOW,
        created_by: null,
        updated_at: NOW,
        updated_by: null,
      })
      .execute();
    const missing = await manager.send('post', RECORDS, { materialTypeId: typeId, title: 'Tanpa Anak Judul' });
    expect(missing.status).toBe(422);
    expect(errors(missing)).toEqual([{ path: 'subtitle', code: 'required' }]);
  });

  it('DELETE with one live item → 409 CATALOG_RECORD_HAS_ITEMS; restore; cover', async () => {
    const id = await create({ title: 'Si Anak Pintar' });
    const ct = (await h.db.selectFrom('collection_types').select('id').where('code_key', '=', 'UMUM').executeTakeFirstOrThrow()).id;
    const itemId = newId();
    await h.db
      .insertInto('items')
      .values({
        id: itemId,
        record_id: id,
        branch_id: branchId,
        barcode_display: 'B0099001',
        barcode_key: 'B0099001',
        collection_type_id: ct,
        status: 'available',
        inventory_no: null,
        call_number: null,
        location_id: null,
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
    const refused = await manager.send('delete', `${RECORDS}/${id}`, { version: 0 });
    expect(refused.status).toBe(409);
    expect(code(refused)).toBe('CATALOG_RECORD_HAS_ITEMS');
    expect((refused.json as { detail?: string }).detail).toContain('1');

    await h.db.updateTable('items').set({ archived_at: NOW, status: 'withdrawn' }).where('id', '=', itemId).execute();
    const archived = await manager.send('delete', `${RECORDS}/${id}`, { version: 0 });
    expect(archived.status, archived.text).toBe(200);
    expect(archived.json).toEqual({ id, version: 1 });
    const restored = await manager.send('post', `${RECORDS}/${id}/restore`, { version: 1 });
    expect(restored.json).toEqual({ id, version: 2 });

    const fileId = newId();
    await h.db
      .insertInto('files')
      .values({ id: fileId, original_name: 'sampul.jpg', mime: 'image/jpeg', size: 10, sha256: 'b'.repeat(64), context: 'catalog.cover', owner_type: null, owner_id: null, access: 'staff', status: 'ok', created_at: NOW, created_by: null })
      .execute();
    const cover = await manager.send('put', `${RECORDS}/${id}/cover`, { fileId, version: 2 });
    expect(cover.status, cover.text).toBe(200);
    expect(cover.json).toEqual({ id, version: 3 });
    expect(await h.db.selectFrom('files').select(['owner_type', 'owner_id', 'access']).where('id', '=', fileId).executeTakeFirstOrThrow()).toEqual({
      owner_type: 'records',
      owner_id: id,
      access: 'public',
    });
  });

  it('merge: Review Focus 4 through the API; the duplicate check finds the same ISBN (score 100)', async () => {
    const a = await create({ title: 'Rumah Kaca', identifiers: [{ type: 'isbn', value: '9789799731234' }] });
    const b = await create({ title: 'Rumah Kaca (2)' });
    const c = await create({ title: 'Rumah Kaca (3)' });
    expect((await manager.send('post', `${RECORDS}/${b}/merge`, { sourceId: a, version: 0 })).json).toEqual({ id: b, version: 1 });
    expect((await manager.send('post', `${RECORDS}/${c}/merge`, { sourceId: b, version: 0 })).json).toEqual({ id: c, version: 1 });
    expect(await h.db.selectFrom('records').select('merged_into').where('id', '=', a).executeTakeFirstOrThrow()).toEqual({ merged_into: c });
    const invalid = await manager.send('post', `${RECORDS}/${a}/merge`, { sourceId: c, version: 1 });
    expect(invalid.status).toBe(422);
    expect(code(invalid)).toBe('CATALOG_MERGE_INVALID');

    const dup = await manager.send('post', `${RECORDS}/duplicates`, { title: 'Apa saja', identifiers: [{ type: 'isbn', value: '978-979-973-123-4' }] });
    expect(dup.status, dup.text).toBe(200);
    expect(dup.json).toEqual({ threshold: 80, candidates: [{ recordId: c, title: 'Rumah Kaca (3)', year: null, score: 100, reasons: ['isbn'] }] });
  });

  it('GET list: keyset pages, filters; a query that is not valid → 422', async () => {
    const res = await reader.get(`${RECORDS}?limit=2&sort=title`);
    expect(res.status, res.text).toBe(200);
    const page = res.json as { items: { title: string }[]; nextCursor: string | null; total: number | null };
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toEqual(expect.any(String));
    expect(page.total).toBeNull();
    const next = await reader.get(`${RECORDS}?limit=2&sort=title&cursor=${encodeURIComponent(page.nextCursor!)}`);
    expect(next.status).toBe(200);
    expect((await reader.get(`${RECORDS}?limit=2&cursor=bukan-kursor`)).status).toBe(422);
    expect((await reader.get(`${RECORDS}?hidden=semua`)).status).toBe(422);
  });
});
