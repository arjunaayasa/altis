import { createHash, randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { localStorageDriver, writeSettings } from '@altis/core';
import { PHASE1_MIGRATIONS, runMigrations, withTx } from '@altis/db';
import { newId } from '@altis/shared';
import type { AttachmentListResponse } from '@altis/shared/api/catalog/attachments';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { createApp } from '../../src/app.js';
import { createAgent, type AgentReply } from '../agent.js';
import { recordingLogger, sampleConfig } from '../support.js';
import { seedStaff, sessionCookieFor, sessionCsrfFor } from '../support-auth.js';

// The attachments API of Phase 2 Task 18 (spec §8, §12.2, K12; S15) on the engine picked by ALTIS_TEST_DB:
// - `POST catalog/records/:id/attachments` claims a completed `catalog.attachment` upload (or stores a link) and
//   answers `{id, version}` only; `PATCH catalog/attachments/:id` and `DELETE catalog/attachments/:id` ({version})
//   answer the same; `GET catalog/records/:id/attachments` lists the live ones for the panel (with their versions);
// - `files.access` follows the attachment's access, so a visitor reads a public attachment of a published record from
//   `/files/:id`, is refused a staff one, and gets 404 once its record is hidden;
// - every write moves the record's `changed_at` and publishes `catalog.record.changed`;
// - `catalog.attachment.maxMb` refuses a larger upload when it is declared (UPLOAD_TOO_LARGE).

const ctx = testDbContext();
let h: TestDbHandle;

/** In the past: an audit entry may not be dated ahead of the real clock. */
const NOW = Date.UTC(2026, 9, 22, 9, 0, 5);
const CONFIG = sampleConfig();
const SID = '__Host-altis_sid';
const RECORDS = '/api/v1/catalog/records';
const ATTACHMENTS = '/api/v1/catalog/attachments';
const MIB = 1024 * 1024;

interface Client {
  get(p: string): Promise<AgentReply>;
  send(method: 'post' | 'patch' | 'put' | 'delete', p: string, body?: unknown, key?: string): Promise<AgentReply>;
}

const sha = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');
const code = (res: AgentReply): string | undefined => (res.json as { code?: string } | undefined)?.code;
const errors = (res: AgentReply): { path: string; code: string }[] => (res.json as { errors?: { path: string; code: string }[] }).errors ?? [];
const stored = (res: AgentReply): { id: string; version: number } => res.json as { id: string; version: number };

describe.skipIf(!ctx.available)(`attachments API [${engineLabel()}]`, () => {
  let root: string;
  let dataDir: string;
  let app: ReturnType<typeof createApp>;
  let manager: Client;
  let reader: Client;
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

  /** A visitor's GET (no cookie). */
  const visitor = (p: string): Promise<AgentReply> => createAgent(app).get(p);

  /** A record through the API (published unless `opacVisible` is false); its id. */
  async function record(o: { opacVisible?: boolean } = {}): Promise<string> {
    const res = await manager.send('post', RECORDS, { materialTypeId: buku, title: 'Ronggeng Dukuh Paruk', ...(o.opacVisible === false ? { opacVisible: false } : {}) });
    expect(res.status, res.text).toBe(201);
    return stored(res).id;
  }

  /** A completed `catalog.attachment` upload nobody owns yet (its blob and its `files` row, as completion leaves it). */
  async function upload(data: Uint8Array = new Uint8Array(randomBytes(300)), context = 'catalog.attachment'): Promise<string> {
    const id = newId();
    await localStorageDriver(dataDir).put(id, data, { size: data.byteLength, sha256: sha(data) });
    await h.db
      .insertInto('files')
      .values({
        id,
        original_name: 'bab-1.pdf',
        mime: 'application/pdf',
        size: data.byteLength,
        sha256: sha(data),
        context,
        owner_type: null,
        owner_id: null,
        access: 'staff',
        status: 'ok',
        created_at: NOW,
        created_by: null,
      })
      .execute();
    return id;
  }

  const list = async (recordId: string): Promise<AttachmentListResponse['items']> => {
    const res = await reader.get(`${RECORDS}/${recordId}/attachments`);
    expect(res.status, res.text).toBe(200);
    return (res.json as AttachmentListResponse).items;
  };

  const changedEvents = async (recordId: string): Promise<number> =>
    (await h.db.selectFrom('events').select('payload').where('type', '=', 'catalog.record.changed').execute()).filter(
      (e) => (JSON.parse(e.payload) as { id?: string }).id === recordId,
    ).length;

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-api-attachments-')));
    dataDir = path.join(root, 'data');
    await fsp.mkdir(dataDir);
    await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
    buku = (await h.db.selectFrom('material_types').select('id').where('code_key', '=', 'BUKU').executeTakeFirstOrThrow()).id;
    app = createApp({ state: { phase: 'ready', db: h, config: CONFIG }, version: '0.1.0', buildId: 'b', log: recordingLogger(), clock: () => NOW, dataDir });
    manager = await signedIn('kelola_lampiran', ['catalog.records.manage', 'catalog.records.read']);
    reader = await signedIn('baca_lampiran', ['catalog.records.read']);
  });

  afterAll(async () => {
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  it('a file attachment: 201 {id, version} only (S15); the list shows it with its file; a visitor reads the public file', async () => {
    const recordId = await record();
    const data = new Uint8Array(randomBytes(400));
    const fileId = await upload(data);
    const before = await changedEvents(recordId);
    const res = await manager.send('post', `${RECORDS}/${recordId}/attachments`, { kind: 'file', fileId, title: 'Bab 1', access: 'public' });
    expect(res.status, res.text).toBe(201);
    expect(res.json).toEqual({ id: expect.any(String), version: 0 });
    const id = stored(res).id;

    expect(await list(recordId)).toEqual([
      {
        id,
        recordId,
        kind: 'file',
        fileId,
        url: null,
        title: 'Bab 1',
        description: null,
        access: 'public',
        mime: 'application/pdf',
        size: 400,
        readCount: 0,
        sortOrder: 0,
        version: 0,
        memberTypeIds: [],
      },
    ]);
    const file = await h.db.selectFrom('files').select(['owner_type', 'owner_id', 'access']).where('id', '=', fileId).executeTakeFirstOrThrow();
    expect(file).toEqual({ owner_type: 'attachments', owner_id: id, access: 'public' });
    expect(await changedEvents(recordId)).toBe(before + 1);

    // K12: a public attachment is visible to an anonymous caller; Range gives 206 (media).
    const anonymous = await visitor(`/files/${fileId}`);
    expect([anonymous.status, anonymous.headers.get('cache-control')]).toEqual([200, 'public, max-age=86400']);
    const part = await createAgent(app).get(`/files/${fileId}`, undefined, { range: 'bytes=0-99' });
    expect([part.status, part.headers.get('content-range')]).toEqual([206, 'bytes 0-99/400']);
  });

  it('a link: http(s) only (VALIDATION_FAILED at url); a file of another context or owned already is refused at fileId', async () => {
    const recordId = await record();
    const link = await manager.send('post', `${RECORDS}/${recordId}/attachments`, { kind: 'url', url: 'https://repositori.example/bab-2.pdf', title: 'Bab 2', access: 'staff' });
    expect(link.status, link.text).toBe(201);
    const bad = await manager.send('post', `${RECORDS}/${recordId}/attachments`, { kind: 'url', url: 'javascript:alert(1)', title: 'Jahat', access: 'public' });
    expect([bad.status, code(bad)]).toEqual([422, 'VALIDATION_FAILED']);
    expect(errors(bad).map((e) => e.path)).toEqual(['url']);
    // A file attachment takes no url, and a kind it does not know is refused.
    const mixed = await manager.send('post', `${RECORDS}/${recordId}/attachments`, { kind: 'file', fileId: await upload(), url: 'https://a.example', title: 'X', access: 'public' });
    expect([mixed.status, code(mixed)]).toEqual([422, 'VALIDATION_FAILED']);
    const unknownKind = await manager.send('post', `${RECORDS}/${recordId}/attachments`, { kind: 'video', title: 'X', access: 'public' });
    expect([unknownKind.status, code(unknownKind)]).toEqual([422, 'VALIDATION_FAILED']);

    const cover = await manager.send('post', `${RECORDS}/${recordId}/attachments`, { kind: 'file', fileId: await upload(undefined, 'catalog.cover'), title: 'X', access: 'public' });
    expect([cover.status, errors(cover)]).toEqual([422, [{ path: 'fileId', code: 'invalid' }]]);
    const taken = await upload();
    expect((await manager.send('post', `${RECORDS}/${recordId}/attachments`, { kind: 'file', fileId: taken, title: 'A', access: 'public' })).status).toBe(201);
    const again = await manager.send('post', `${RECORDS}/${await record()}/attachments`, { kind: 'file', fileId: taken, title: 'B', access: 'public' });
    expect([again.status, errors(again)]).toEqual([422, [{ path: 'fileId', code: 'invalid' }]]);
    const missing = await manager.send('post', `${RECORDS}/${recordId}/attachments`, { kind: 'file', fileId: newId(), title: 'C', access: 'public' });
    expect([missing.status, errors(missing)]).toEqual([422, [{ path: 'fileId', code: 'not_found' }]]);
    expect((await manager.send('post', `${RECORDS}/${newId()}/attachments`, { kind: 'url', url: 'https://a.example', title: 'D', access: 'public' })).status).toBe(404);
  });

  it('PATCH to staff: files.access follows; a visitor is refused the file (401); a stale version → 409 CONFLICT_STALE', async () => {
    const recordId = await record();
    const fileId = await upload();
    const id = stored(await manager.send('post', `${RECORDS}/${recordId}/attachments`, { kind: 'file', fileId, title: 'Bab 3', access: 'public' })).id;
    const changed = await manager.send('patch', `${ATTACHMENTS}/${id}`, { version: 0, access: 'staff', title: 'Bab 3 (staf)', description: 'Hanya untuk staf' });
    expect(changed.status, changed.text).toBe(200);
    expect(changed.json).toEqual({ id, version: 1 });
    expect((await h.db.selectFrom('files').select('access').where('id', '=', fileId).executeTakeFirstOrThrow()).access).toBe('staff');
    expect(await list(recordId)).toMatchObject([{ id, title: 'Bab 3 (staf)', description: 'Hanya untuk staf', access: 'staff', version: 1 }]);
    const refused = await visitor(`/files/${fileId}`);
    expect([refused.status, code(refused)]).toEqual([401, 'AUTH_REQUIRED']);

    const stale = await manager.send('patch', `${ATTACHMENTS}/${id}`, { version: 0, title: 'Lama' });
    expect([stale.status, code(stale)]).toEqual([409, 'CONFLICT_STALE']);
    expect((await manager.send('patch', `${ATTACHMENTS}/${newId()}`, { version: 0, title: 'Tidak ada' })).status).toBe(404);
  });

  it('DELETE {version} archives: gone from the list, the file is staff; a replay with the same key answers the same', async () => {
    const recordId = await record();
    const fileId = await upload();
    const id = stored(await manager.send('post', `${RECORDS}/${recordId}/attachments`, { kind: 'file', fileId, title: 'Bab 4', access: 'public' })).id;
    const key = `arsip-${newId()}`;
    const archived = await manager.send('delete', `${ATTACHMENTS}/${id}`, { version: 0 }, key);
    expect(archived.status, archived.text).toBe(200);
    expect(archived.json).toEqual({ id, version: 1 });
    const replay = await manager.send('delete', `${ATTACHMENTS}/${id}`, { version: 0 }, key);
    expect([replay.status, replay.json]).toEqual([200, { id, version: 1 }]);
    expect(await list(recordId)).toEqual([]);
    const row = await h.db.selectFrom('attachments').select(['access', 'archived_at']).where('id', '=', id).executeTakeFirstOrThrow();
    expect([row.access, row.archived_at]).toEqual(['staff', NOW]);
    expect((await h.db.selectFrom('files').select('access').where('id', '=', fileId).executeTakeFirstOrThrow()).access).toBe('staff');
    expect((await visitor(`/files/${fileId}`)).status).toBe(401);
    // Editing an archived attachment is NOT_FOUND.
    expect((await manager.send('patch', `${ATTACHMENTS}/${id}`, { version: 1, title: 'Arsip' })).status).toBe(404);
  });

  it('K12: a public attachment of a hidden record is 404 to a visitor, and the list still shows it to staff', async () => {
    const recordId = await record({ opacVisible: false });
    const fileId = await upload();
    expect((await manager.send('post', `${RECORDS}/${recordId}/attachments`, { kind: 'file', fileId, title: 'Rahasia', access: 'public' })).status).toBe(201);
    const res = await visitor(`/files/${fileId}`);
    expect([res.status, code(res)]).toEqual([404, 'NOT_FOUND']);
    expect(await list(recordId)).toMatchObject([{ title: 'Rahasia', access: 'public' }]);
  });

  it('a reader lists (200) but cannot write (403); a visitor cannot list (401); an unknown record → 404', async () => {
    const recordId = await record();
    expect((await reader.get(`${RECORDS}/${recordId}/attachments`)).status).toBe(200);
    expect((await reader.send('post', `${RECORDS}/${recordId}/attachments`, { kind: 'url', url: 'https://a.example', title: 'A', access: 'public' })).status).toBe(403);
    expect((await visitor(`${RECORDS}/${recordId}/attachments`)).status).toBe(401);
    expect((await reader.get(`${RECORDS}/${newId()}/attachments`)).status).toBe(404);
  });

  it('catalog.attachment.maxMb = 1: declaring a 2 MB upload → 413 UPLOAD_TOO_LARGE; 1 MB is accepted', async () => {
    await withTx(h, (trx) => writeSettings(trx, { 'catalog.attachment.maxMb': 1 }, { now: NOW, actorId: null, keyring: CONFIG.keyring }));
    try {
      const big = await manager.send('post', '/api/v1/files/uploads', { context: 'catalog.attachment', size: 2 * MIB, sha256: '0'.repeat(64) });
      expect([big.status, code(big)]).toEqual([413, 'UPLOAD_TOO_LARGE']);
      const ok = await manager.send('post', '/api/v1/files/uploads', { context: 'catalog.attachment', size: MIB, sha256: '0'.repeat(64) });
      expect(ok.status, ok.text).toBe(201);
      await h.db.deleteFrom('upload_sessions').where('id', '=', (ok.json as { id: string }).id).execute();
    } finally {
      await withTx(h, (trx) => writeSettings(trx, { 'catalog.attachment.maxMb': 200 }, { now: NOW, actorId: null, keyring: CONFIG.keyring }));
    }
  });
});
