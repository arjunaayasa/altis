import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations } from '@altis/db';
import { newId } from '@altis/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { createApp } from '../../src/app.js';
import { ALL_ROUTES } from '../../src/routes.js';
import { createAgent, type Agent, type AgentReply } from '../agent.js';
import { recordingLogger, sampleConfig } from '../support.js';
import { seedStaff, sessionCookieFor } from '../support-auth.js';

// `GET catalog/records/counts` on the engine picked by ALTIS_TEST_DB: under the permission of the list
// (`catalog.records.read`) it answers how many records each saved view of the list holds and how many the filters of
// the request hold, and every number is the number of rows `GET catalog/records` lists for the same filters. Without
// the permission it is 403, without a session 401, and a parameter it does not know (a search text) is 422.

const ctx = testDbContext();
let h: TestDbHandle;

const NOW = Date.UTC(2026, 10, 2, 9, 0, 5);
const CONFIG = sampleConfig();
const SID = '__Host-altis_sid';
const RECORDS = '/api/v1/catalog/records';
const COUNTS = `${RECORDS}/counts`;

const code = (res: AgentReply): string | undefined => (res.json as { code?: string } | undefined)?.code;

describe.skipIf(!ctx.available)(`records counts API [${engineLabel()}]`, () => {
  let dataDir: string;
  let app: ReturnType<typeof createApp>;
  let reader: Agent;
  let outsider: Agent;
  let buku: string;
  let majalah: string;

  async function signedIn(username: string, permissions: string[]): Promise<Agent> {
    const user = await seedStaff(h, { username, now: NOW, roles: [{ permissions: permissions as never }] });
    const agent = createAgent(app);
    agent.setCookie(SID, await sessionCookieFor(h, user.id, { now: NOW }));
    return agent;
  }

  async function seedRecord(title: string, o: { archived?: boolean; hidden?: boolean; type?: string; changedAt?: number } = {}): Promise<string> {
    const id = newId();
    await h.db
      .insertInto('records')
      .values({
        id,
        material_type_id: o.type ?? buku,
        title,
        title_key: title.toLowerCase(),
        source: 'manual',
        opac_visible: o.hidden === true ? 0 : 1,
        changed_at: o.changedAt ?? NOW,
        archived_at: o.archived === true ? NOW : null,
        created_at: NOW,
        created_by: null,
        updated_at: NOW,
        updated_by: null,
      })
      .execute();
    return id;
  }

  /** How many rows the list answers for `query` (every page of it). */
  async function listed(query: string): Promise<number> {
    let n = 0;
    let cursor: string | null = null;
    do {
      const res: AgentReply = await reader.get(`${RECORDS}?limit=2${query === '' ? '' : `&${query}`}${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`);
      expect(res.status, res.text).toBe(200);
      const body = res.json as { items: unknown[]; nextCursor: string | null };
      n += body.items.length;
      cursor = body.nextCursor;
    } while (cursor !== null);
    return n;
  }

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-api-records-counts-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
    await h.db
      .insertInto('branches')
      .values({ id: newId(), code_key: 'PUSAT', code_display: 'PUSAT', name: 'Perpustakaan Pusat', timezone: 'Asia/Jakarta', is_default: 1, created_at: NOW, updated_at: NOW })
      .execute();
    const types = await h.db.selectFrom('material_types').select(['id', 'code_key']).execute();
    buku = types.find((t) => t.code_key === 'BUKU')!.id;
    majalah = types.find((t) => t.id !== buku)!.id;
    app = createApp({ state: { phase: 'ready', db: h, config: CONFIG }, version: '0.1.0', buildId: 'b', log: recordingLogger(), clock: () => NOW });
    reader = await signedIn('baca_katalog', ['catalog.records.read']);
    outsider = await signedIn('tanpa_katalog', ['members.read']);
    await seedRecord('Atlas Dunia');
    await seedRecord('Kamus Besar');
    await seedRecord('Ensiklopedia Anak', { changedAt: NOW - 10 * 86_400_000 });
    await seedRecord('Majalah Sekolah', { type: majalah });
    await seedRecord('Naskah Tersembunyi', { hidden: true });
    await seedRecord('Majalah Tersembunyi', { hidden: true, type: majalah });
    await seedRecord('Atlas Lama', { archived: true });
    await seedRecord('Kamus Lama', { archived: true, hidden: true });
  });

  afterAll(async () => {
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  it('is declared under the permission of the list, before the routes of one record', () => {
    const list = ALL_ROUTES.find((d) => d.id === 'catalog.records.list')!;
    const counts = ALL_ROUTES.find((d) => d.id === 'catalog.records.counts')!;
    expect(counts).toMatchObject({ method: 'GET', path: COUNTS, permission: list.permission, audit: null });
    const ids = ALL_ROUTES.map((d) => d.id);
    expect(ids.indexOf('catalog.records.counts')).toBeLessThan(ids.indexOf('catalog.records.get'));
  });

  it('answers the count of every saved view and of the filters asked for, each the number of rows the list holds', async () => {
    const res = await reader.get(COUNTS);
    expect(res.status, res.text).toBe(200);
    // No record has an item here, so "without items" is every live record.
    expect(res.json).toEqual({ views: { all: 6, no_items: 6, hidden: 2, archived: 2 }, total: 6 });
    expect(await listed('')).toBe(6);
    expect(await listed('hasItems=false')).toBe(6);
    expect(await listed('hidden=only')).toBe(2);
    expect(await listed('archived=true')).toBe(2);

    for (const [query, total] of [
      ['hidden=only', 2],
      ['hidden=exclude', 4],
      ['archived=true', 2],
      ['archived=true&hidden=only', 1],
      ['hasItems=true', 0],
      [`materialTypeId=${majalah}`, 2],
      [`materialTypeId=${majalah}&hidden=exclude`, 1],
      [`changedFrom=${NOW - 86_400_000}`, 5],
      [`changedTo=${NOW - 86_400_000}`, 1],
    ] as const) {
      const filtered = await reader.get(`${COUNTS}?${query}`);
      expect(filtered.status, filtered.text).toBe(200);
      expect(filtered.json, query).toEqual({ views: { all: 6, no_items: 6, hidden: 2, archived: 2 }, total });
      expect(await listed(query), query).toBe(total);
    }
  });

  it('a caller without catalog.records.read → 403, as for the list; without a session → 401', async () => {
    const list = await outsider.get(RECORDS);
    const counts = await outsider.get(`${COUNTS}?hidden=only`);
    expect(list.status).toBe(403);
    expect(counts.status).toBe(403);
    expect(code(counts)).toBe(code(list));
    expect(JSON.stringify(counts.json)).not.toMatch(/"views"|"total"/);

    const anonymous = await createAgent(app).get(COUNTS);
    expect(anonymous.status).toBe(401);
    expect(JSON.stringify(anonymous.json)).not.toMatch(/"views"|"total"/);
  });

  it('a parameter it does not count by (a search text, an order, a page) → 422', async () => {
    for (const query of ['q=atlas', 'sort=title', 'limit=5', 'hidden=all']) {
      const res = await reader.get(`${COUNTS}?${query}`);
      expect(res.status, query).toBe(422);
      expect(code(res), query).toBe('VALIDATION_FAILED');
    }
  });
});
