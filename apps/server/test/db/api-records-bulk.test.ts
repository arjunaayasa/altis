import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations } from '@altis/db';
import { newId } from '@altis/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { createApp } from '../../src/app.js';
import { ALL_ROUTES } from '../../src/routes.js';
import { createAgent, type AgentReply } from '../agent.js';
import { recordingLogger, sampleConfig } from '../support.js';
import { seedStaff, sessionCookieFor, sessionCsrfFor } from '../support-auth.js';

// `POST catalog/records/bulk` on the engine picked by ALTIS_TEST_DB: sets the accreditation fields of up to 500
// records (an annotation: the records' `updated_by`, `updated_at` and `changed_at` stay), answers the compact
// `{updated, refused}` (stored for a replay), writes one `catalog.record.bulk_update` entry, and refuses a body that
// names no field, more than 500 ids or a field outside the four with 422; a caller without `catalog.records.manage`
// gets 403.

const ctx = testDbContext();
let h: TestDbHandle;

/** In the past: an audit entry may not be dated ahead of the real clock. */
const NOW = Date.UTC(2026, 10, 2, 9, 0, 5);
const MIGRATED_AT = NOW - 86_400_000;
const CONFIG = sampleConfig();
const SID = '__Host-altis_sid';
const RECORDS = '/api/v1/catalog/records';
const BULK = `${RECORDS}/bulk`;

interface Client {
  send(method: 'post' | 'patch', p: string, body?: unknown, key?: string): Promise<AgentReply>;
}

const code = (res: AgentReply): string | undefined => (res.json as { code?: string } | undefined)?.code;
const errors = (res: AgentReply): { path: string; code: string }[] => (res.json as { errors?: { path: string; code: string }[] }).errors ?? [];

describe.skipIf(!ctx.available)(`records bulk API [${engineLabel()}]`, () => {
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
    return { send: (method, p, body, key) => agent[method](p, body, key === undefined ? csrf : { ...csrf, 'idempotency-key': key }) };
  }

  /** A record as a migration leaves it (no staff editor, a day old); archived when asked. Its id. */
  async function seedRecord(title: string, o: { archived?: boolean } = {}): Promise<string> {
    const id = newId();
    await h.db
      .insertInto('records')
      .values({
        id,
        material_type_id: buku,
        title,
        title_key: title.toLowerCase(),
        source: 'slims:1',
        changed_at: MIGRATED_AT,
        archived_at: o.archived === true ? MIGRATED_AT : null,
        created_at: MIGRATED_AT,
        created_by: null,
        updated_at: MIGRATED_AT,
        updated_by: null,
      })
      .execute();
    return id;
  }

  const row = (id: string) => h.db.selectFrom('records').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
  const bulkEntries = async () =>
    (await h.db.selectFrom('audit_log').select('meta').where('action', '=', 'catalog.record.bulk_update').orderBy('seq').execute()).map((r) => JSON.parse(r.meta) as unknown);

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-api-records-bulk-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
    await h.db
      .insertInto('branches')
      .values({ id: newId(), code_key: 'PUSAT', code_display: 'PUSAT', name: 'Perpustakaan Pusat', timezone: 'Asia/Jakarta', is_default: 1, created_at: NOW, updated_at: NOW })
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

  it('is declared in the records routes, before the routes of one record', () => {
    const ids = ALL_ROUTES.map((d) => d.id);
    const at = ids.indexOf('catalog.records.bulk');
    expect(at).toBeGreaterThan(-1);
    for (const id of ['catalog.records.get', 'catalog.records.update', 'catalog.records.archive', 'catalog.records.restore', 'catalog.records.merge', 'catalog.records.cover']) {
      expect(at, id).toBeLessThan(ids.indexOf(id));
    }
  });

  it('[live, archived, unknown] → 200 {updated: 1, refused}, the live record an annotation; one audit entry; a replay answers the same', async () => {
    const live = await seedRecord('Atlas Dunia');
    const archived = await seedRecord('Atlas Lama', { archived: true });
    const unknown = newId();
    const before = (await bulkEntries()).length;
    const key = `massal-${newId()}`;
    const body = { ids: [live, archived, unknown], set: { referenceKind: 'atlas', audience: 'general' } };
    const res = await manager.send('post', BULK, body, key);
    expect(res.status, res.text).toBe(200);
    expect(res.json).toEqual({
      updated: 1,
      refused: [
        { id: archived, code: 'archived' },
        { id: unknown, code: 'not_found' },
      ],
    });
    const after = await row(live);
    expect(after).toMatchObject({ reference_kind: 'atlas', audience: 'general', version: 1, updated_by: null });
    expect(Number(after.updated_at)).toBe(MIGRATED_AT);
    expect(Number(after.changed_at)).toBe(MIGRATED_AT);
    expect(await row(archived)).toMatchObject({ reference_kind: null, version: 0 });
    expect((await bulkEntries()).slice(before)).toEqual([{ count: 1, fields: ['audience', 'referenceKind'] }]);

    const again = await manager.send('post', BULK, body, key);
    expect(again.status).toBe(200);
    expect(again.json).toEqual(res.json);
    expect((await row(live)).version).toBe(1);
    expect((await bulkEntries()).slice(before)).toHaveLength(1);
  });

  it('localWork and localWorkKind together', async () => {
    const id = await seedRecord('Antologi Puisi Guru');
    const res = await manager.send('post', BULK, { ids: [id], set: { localWork: 'teacher', localWorkKind: 'poetry' } });
    expect(res.status, res.text).toBe(200);
    expect(await row(id)).toMatchObject({ local_work: 'teacher', local_work_kind: 'poetry', updated_by: null });
  });

  it('501 ids → 422 at ids; set {} → 422 {path: set, code: required}; a field outside the four → 422; nothing changes', async () => {
    const id = await seedRecord('Kamus Ditolak');
    const many = [id, ...Array.from({ length: 500 }, () => newId())];
    const tooMany = await manager.send('post', BULK, { ids: many, set: { referenceKind: 'dictionary' } });
    expect(tooMany.status).toBe(422);
    expect(code(tooMany)).toBe('VALIDATION_FAILED');
    expect(errors(tooMany)).toEqual([{ path: 'ids', code: 'too_big' }]);

    const empty = await manager.send('post', BULK, { ids: [id], set: {} });
    expect(empty.status).toBe(422);
    expect(errors(empty)).toEqual([{ path: 'set', code: 'required' }]);

    const other = await manager.send('post', BULK, { ids: [id], set: { title: 'Bukan Ruas Ini' } });
    expect(other.status).toBe(422);
    expect(code(other)).toBe('VALIDATION_FAILED');

    const unknownCode = await manager.send('post', BULK, { ids: [id], set: { localWork: 'alumni' } });
    expect(unknownCode.status).toBe(422);
    expect(errors(unknownCode)).toEqual([{ path: 'set.localWork', code: 'invalid_value' }]);

    expect(await row(id)).toMatchObject({ reference_kind: null, title: 'Kamus Ditolak', version: 0 });
  });

  it('a caller without catalog.records.manage → 403, nothing changes', async () => {
    const id = await seedRecord('Ensiklopedia Terlarang');
    const res = await reader.send('post', BULK, { ids: [id], set: { referenceKind: 'encyclopedia' } });
    expect(res.status).toBe(403);
    expect(await row(id)).toMatchObject({ reference_kind: null, version: 0 });
  });
});
