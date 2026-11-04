import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, countRows, runMigrations } from '@altis/db';
import { newId } from '@altis/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { createApp } from '../../src/app.js';
import { createAgent, type AgentReply } from '../agent.js';
import { recordingLogger, sampleConfig } from '../support.js';
import { seedStaff, sessionCookieFor, sessionCsrfFor } from '../support-auth.js';

// The branches API of Task 21 on the engine picked by ALTIS_TEST_DB (spec §6.5, §7.2; decision D6): `GET branches` is
// open to any signed-in staff user, the writes need `system.branches.manage`. A code is unique on its normalized key
// (`code_key`), a stale `version` is refused, the default branch (`PUSAT`) cannot be archived, and archiving keeps the
// branch's role assignments.

const ctx = testDbContext();
let h: TestDbHandle;

/** In the past: an audit entry may not be dated ahead of the real clock. */
const NOW = Date.UTC(2026, 9, 20, 9, 0, 5);
const CONFIG = sampleConfig();
/** baseUrl is https: the cookies carry the `__Host-` prefix. */
const SID = '__Host-altis_sid';
const BRANCHES = '/api/v1/branches';

interface BranchJson {
  id: string;
  code: string;
  name: string;
  address: string | null;
  timezone: string;
  isDefault: boolean;
  archivedAt: number | null;
  version: number;
  /** `GET branches` only (1d Task 23). */
  active?: boolean;
}

/** A browser signed in as one staff user. */
interface Client {
  userId: string;
  get(path: string): Promise<AgentReply>;
  post(path: string, body: unknown, key?: string): Promise<AgentReply>;
  patch(path: string, body: unknown): Promise<AgentReply>;
  delete(path: string): Promise<AgentReply>;
}

const code = (res: AgentReply): string | undefined => (res.json as { code?: string } | undefined)?.code;
const errors = (res: AgentReply): { path: string; code: string }[] => (res.json as { errors?: { path: string; code: string }[] }).errors ?? [];
const item = (res: AgentReply): BranchJson => res.json as BranchJson;
const items = (res: AgentReply): BranchJson[] => (res.json as { items: BranchJson[] }).items;

async function audits(action: string, entityId?: string) {
  let q = h.db.selectFrom('audit_log').select(['action', 'actor_type', 'actor_id', 'entity', 'entity_id', 'meta']).where('action', '=', action);
  if (entityId !== undefined) q = q.where('entity_id', '=', entityId);
  const rows = await q.orderBy('seq').execute();
  return rows.map((r) => ({ ...r, meta: JSON.parse(r.meta) as Record<string, unknown> }));
}

describe.skipIf(!ctx.available)(`branches API [${engineLabel()}]`, () => {
  let dataDir: string;
  let app: ReturnType<typeof createApp>;
  let pusatId: string;
  let manager: Client;
  let norole: Client;
  let usersAdmin: Client;
  let anonymous: ReturnType<typeof createAgent>;
  /** Branch codes are unique per run of a test: the tests share one database. */
  let serial = 0;
  const fresh = (prefix = 'br'): string => `${prefix}-${(serial += 1)}`;

  async function signedIn(username: string, roles: Parameters<typeof seedStaff>[1]['roles']): Promise<Client> {
    const user = await seedStaff(h, { username, now: NOW, ...(roles === undefined ? {} : { roles }) });
    const token = await sessionCookieFor(h, user.id, { now: NOW });
    const agent = createAgent(app);
    agent.setCookie(SID, token);
    const csrf = { 'x-csrf-token': sessionCsrfFor(CONFIG, token) };
    return {
      userId: user.id,
      get: (p) => agent.get(p),
      post: (p, body, key) => agent.post(p, body, key === undefined ? csrf : { ...csrf, 'idempotency-key': key }),
      patch: (p, body) => agent.patch(p, body, csrf),
      delete: (p) => agent.delete(p, undefined, csrf),
    };
  }

  const create = (body: Record<string, unknown> = {}, who: Client = manager) =>
    who.post(BRANCHES, { code: fresh(), name: 'Cabang Uji', timezone: 'Asia/Jakarta', ...body });

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-branches-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
    // What `install` seeds: the default branch.
    pusatId = newId();
    await h.db
      .insertInto('branches')
      .values({ id: pusatId, code_key: 'PUSAT', code_display: 'PUSAT', name: 'Perpustakaan Pusat', timezone: 'Asia/Jakarta', is_default: 1, created_at: NOW, updated_at: NOW })
      .execute();
    app = createApp({
      state: { phase: 'ready', db: h, config: CONFIG },
      version: '0.1.0',
      buildId: 'b',
      log: recordingLogger(),
      clock: () => NOW,
    });
    manager = await signedIn('kelola_cabang', [{ permissions: ['system.branches.manage'] }]);
    norole = await signedIn('tanpa_peran', []);
    usersAdmin = await signedIn('kelola_pengguna', [{ permissions: ['system.users.manage', 'system.users.read'] }]);
    anonymous = createAgent(app);
  });

  afterAll(async () => {
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  describe('GET branches', () => {
    it('is open to a signed-in staff user with no role: 200, the default branch first', async () => {
      const res = await norole.get(BRANCHES);
      expect(res.status).toBe(200);
      const list = items(res);
      expect(list[0]).toEqual({
        id: pusatId,
        code: 'PUSAT',
        name: 'Perpustakaan Pusat',
        address: null,
        timezone: 'Asia/Jakarta',
        isDefault: true,
        archivedAt: null,
        version: 0,
        // The community edition has no branch limit, so every live branch is active
        active: true,
      });
      expect(list.filter((b) => b.isDefault)).toHaveLength(1);
    });

    it('anonymous → 401 AUTH_REQUIRED', async () => {
      const res = await anonymous.get(BRANCHES);
      expect(res.status).toBe(401);
      expect(code(res)).toBe('AUTH_REQUIRED');
    });

    it('lists active branches ordered by code, and the archived ones only with includeArchived=true', async () => {
      const a = item(await create({ code: 'ord-b' }));
      const b = item(await create({ code: 'ord-a' }));
      expect((await manager.delete(`${BRANCHES}/${a.id}`)).status).toBe(200);

      const active = items(await norole.get(BRANCHES));
      const codes = active.map((x) => x.code);
      expect(codes).toContain('ord-a');
      expect(codes).not.toContain('ord-b');
      expect(active.every((x) => x.archivedAt === null)).toBe(true);
      expect(codes.indexOf('ord-a')).toBeGreaterThan(0); // after PUSAT

      for (const flag of ['true', '1']) {
        const all = items(await norole.get(`${BRANCHES}?includeArchived=${flag}`));
        expect(all.map((x) => x.id)).toEqual(expect.arrayContaining([a.id, b.id, pusatId]));
        expect(all.find((x) => x.id === a.id)!.archivedAt).toEqual(expect.any(Number));
        // An archived branch is never active, a live one always is (active = archivedAt === null)
        expect(all.find((x) => x.id === a.id)!.active).toBe(false);
        expect(all.find((x) => x.id === b.id)!.active).toBe(true);
        expect(all.every((x) => x.active === (x.archivedAt === null))).toBe(true);
      }
      const none = items(await norole.get(`${BRANCHES}?includeArchived=false`));
      expect(none.map((x) => x.id)).not.toContain(a.id);
    });

    it('refuses an unknown or malformed query with 422', async () => {
      const bad = await norole.get(`${BRANCHES}?includeArchived=maybe`);
      expect(bad.status).toBe(422);
      expect(code(bad)).toBe('VALIDATION_FAILED');
      expect(errors(bad)[0]?.path).toBe('includeArchived');
      expect((await norole.get(`${BRANCHES}?page=2`)).status).toBe(422);
    });
  });

  describe('POST branches', () => {
    it('creates a branch: 201, code_key upper case, code_display as typed, one branches.create entry', async () => {
      const res = await manager.post(BRANCHES, { code: 'cab-1', name: '  Cabang Satu ', address: 'Jl. Merdeka 1', timezone: 'Asia/Makassar' });
      expect(res.status).toBe(201);
      const created = item(res);
      expect(created).toEqual({
        id: expect.any(String),
        code: 'cab-1',
        name: 'Cabang Satu',
        address: 'Jl. Merdeka 1',
        timezone: 'Asia/Makassar',
        isDefault: false,
        archivedAt: null,
        version: 0,
      });

      const row = await h.db.selectFrom('branches').selectAll().where('id', '=', created.id).executeTakeFirstOrThrow();
      expect(row.code_key).toBe('CAB-1');
      expect(row.code_display).toBe('cab-1');
      expect(row.is_default).toBe(0);
      expect(row.archived_at).toBeNull();
      expect(row.created_by).toBe(manager.userId);
      expect(row.updated_by).toBe(manager.userId);
      expect(Number(row.created_at)).toBe(NOW);

      const entries = await audits('branches.create', created.id);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ actor_type: 'staff', actor_id: manager.userId, entity: 'branches', entity_id: created.id });
    });

    it("the same code again, 'CAB-1 ' (any case, any padding) → 422 {path: 'code', code: 'taken'}, nothing written", async () => {
      const before = await countRows(h.db.selectFrom('branches'));
      const entries = (await audits('branches.create')).length;
      for (const dup of ['CAB-1 ', 'Cab-1', 'ＣＡＢ-１']) {
        const res = await create({ code: dup });
        expect(res.status).toBe(422);
        expect(code(res)).toBe('VALIDATION_FAILED');
        expect(errors(res)).toEqual([{ path: 'code', code: 'taken' }]);
      }
      expect(await countRows(h.db.selectFrom('branches'))).toBe(before);
      expect((await audits('branches.create')).length).toBe(entries);
    });

    it('PUSAT is taken too, and address may be null or absent', async () => {
      expect(errors(await create({ code: 'pusat' }))).toEqual([{ path: 'code', code: 'taken' }]);
      const withNull = item(await create({ address: null }));
      expect(withNull.address).toBeNull();
      const without = await create();
      expect(without.status).toBe(201);
      expect(item(without).address).toBeNull();
    });

    it('two requests for one new code at once: one 201, the other 422 taken', async () => {
      const same = fresh('race');
      const [a, b] = await Promise.all([create({ code: same }), create({ code: same.toUpperCase() })]);
      expect([a.status, b.status].sort()).toEqual([201, 422]);
      const loser = a.status === 422 ? a : b;
      expect(errors(loser)).toEqual([{ path: 'code', code: 'taken' }]);
      expect(await countRows(h.db.selectFrom('branches').where('code_key', '=', same.toUpperCase()))).toBe(1);
    });

    it('refuses bad input with 422 and the field path: code, name, timezone, address, unknown keys', async () => {
      const cases: [Record<string, unknown>, string][] = [
        [{ code: 'a b' }, 'code'],
        [{ code: '' }, 'code'],
        [{ code: 'x'.repeat(33) }, 'code'],
        [{ name: '   ' }, 'name'],
        [{ name: 'x'.repeat(192) }, 'name'],
        [{ timezone: 'Mars/Olympus' }, 'timezone'],
        [{ address: 'x'.repeat(1001) }, 'address'],
        [{ isDefault: true }, ''],
      ];
      for (const [patch, path] of cases) {
        const res = await create(patch);
        expect(res.status, JSON.stringify(patch)).toBe(422);
        expect(errors(res)[0]?.path, JSON.stringify(patch)).toBe(path);
      }
      const missing = await manager.post(BRANCHES, { code: fresh() });
      expect(missing.status).toBe(422);
      expect(errors(missing).map((e) => e.path).sort()).toEqual(['name', 'timezone']);
    });

    it('with an Idempotency-Key a replay answers the stored response and creates one branch', async () => {
      const body = { code: fresh('idem'), name: 'Sekali', timezone: 'Asia/Jakarta' };
      const key = `branches-${newId()}`;
      const first = await manager.post(BRANCHES, body, key);
      const second = await manager.post(BRANCHES, body, key);
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(second.json).toEqual(first.json);
      expect(second.headers.get('idempotent-replayed')).toBe('true');
      expect(await countRows(h.db.selectFrom('branches').where('code_key', '=', body.code.toUpperCase()))).toBe(1);
      expect(await audits('branches.create', item(first).id)).toHaveLength(1);
    });
  });

  describe('PATCH branches/:id', () => {
    it('a stale version → 409 CONFLICT_STALE and the row is untouched', async () => {
      const b = item(await create());
      const res = await manager.patch(`${BRANCHES}/${b.id}`, { version: 5, name: 'Lama' });
      expect(res.status).toBe(409);
      expect(code(res)).toBe('CONFLICT_STALE');
      const row = await h.db.selectFrom('branches').select(['name', 'version']).where('id', '=', b.id).executeTakeFirstOrThrow();
      expect(row).toMatchObject({ name: 'Cabang Uji', version: 0 });
      expect(await audits('branches.update', b.id)).toHaveLength(0);
    });

    it('changes the given fields only: version + 1, code_key follows code, null clears the address, one branches.update entry', async () => {
      const b = item(await create({ address: 'Alamat lama' }));
      const res = await manager.patch(`${BRANCHES}/${b.id}`, { version: 0, name: 'Nama Baru', code: ' Baru-9 ' });
      expect(res.status).toBe(200);
      expect(item(res)).toEqual({ ...b, name: 'Nama Baru', code: 'Baru-9', version: 1 });
      const row = await h.db.selectFrom('branches').selectAll().where('id', '=', b.id).executeTakeFirstOrThrow();
      expect(row).toMatchObject({ code_key: 'BARU-9', code_display: 'Baru-9', updated_by: manager.userId, version: 1 });

      const cleared = await manager.patch(`${BRANCHES}/${b.id}`, { version: 1, address: null, timezone: 'Asia/Jayapura' });
      expect(item(cleared)).toMatchObject({ address: null, timezone: 'Asia/Jayapura', name: 'Nama Baru', code: 'Baru-9', version: 2 });

      const entries = await audits('branches.update', b.id);
      expect(entries.map((e) => e.meta['changed'])).toEqual([['code', 'name'], ['address', 'timezone']]);
      expect(entries[0]).toMatchObject({ actor_id: manager.userId, entity: 'branches' });
    });

    it('a code of another branch → 422 taken; the branch\'s own key (a case change) is fine', async () => {
      const a = item(await create({ code: fresh('own') }));
      const b = item(await create({ code: fresh('other') }));
      const taken = await manager.patch(`${BRANCHES}/${a.id}`, { version: 0, code: b.code.toUpperCase() });
      expect(taken.status).toBe(422);
      expect(errors(taken)).toEqual([{ path: 'code', code: 'taken' }]);
      const unchanged = await h.db.selectFrom('branches').select(['code_key', 'version']).where('id', '=', a.id).executeTakeFirstOrThrow();
      expect(unchanged).toMatchObject({ code_key: a.code.toUpperCase(), version: 0 });

      const recase = await manager.patch(`${BRANCHES}/${a.id}`, { version: 0, code: a.code.toUpperCase() });
      expect(recase.status).toBe(200);
      expect(item(recase).code).toBe(a.code.toUpperCase());
    });

    it('two PATCHes on the same version: one 200, the other 409', async () => {
      const b = item(await create());
      const [x, y] = await Promise.all([
        manager.patch(`${BRANCHES}/${b.id}`, { version: 0, name: 'Satu' }),
        manager.patch(`${BRANCHES}/${b.id}`, { version: 0, name: 'Dua' }),
      ]);
      expect([x.status, y.status].sort()).toEqual([200, 409]);
      const row = await h.db.selectFrom('branches').select('version').where('id', '=', b.id).executeTakeFirstOrThrow();
      expect(Number(row.version)).toBe(1);
      expect(await audits('branches.update', b.id)).toHaveLength(1);
    });

    it('an unknown branch → 404 NOT_FOUND; a malformed id or key → 422', async () => {
      const gone = await manager.patch(`${BRANCHES}/${newId()}`, { version: 0, name: 'Hantu' });
      expect(gone.status).toBe(404);
      expect(code(gone)).toBe('NOT_FOUND');
      expect((await manager.patch(`${BRANCHES}/tidak-valid`, { version: 0 })).status).toBe(422);
      const b = item(await create());
      expect((await manager.patch(`${BRANCHES}/${b.id}`, { name: 'Tanpa versi' })).status).toBe(422);
      expect((await manager.patch(`${BRANCHES}/${b.id}`, { version: 0, isDefault: true })).status).toBe(422);
    });
  });

  describe('DELETE branches/:id (archive)', () => {
    it('the default branch → 409 BRANCH_DEFAULT_ARCHIVE, nothing changes', async () => {
      const res = await manager.delete(`${BRANCHES}/${pusatId}`);
      expect(res.status).toBe(409);
      expect(code(res)).toBe('BRANCH_DEFAULT_ARCHIVE');
      const row = await h.db.selectFrom('branches').select(['archived_at', 'version']).where('id', '=', pusatId).executeTakeFirstOrThrow();
      expect(row.archived_at).toBeNull();
      expect(await audits('branches.archive', pusatId)).toHaveLength(0);
    });

    it('another branch → 200 with archivedAt, branches.archive written, hidden from GET unless includeArchived=true', async () => {
      const b = item(await create({ code: fresh('arsip') }));
      const res = await manager.delete(`${BRANCHES}/${b.id}`);
      expect(res.status).toBe(200);
      expect(item(res)).toEqual({ ...b, archivedAt: NOW, version: 1 });

      const row = await h.db.selectFrom('branches').selectAll().where('id', '=', b.id).executeTakeFirstOrThrow();
      expect(Number(row.archived_at)).toBe(NOW);
      expect(row.updated_by).toBe(manager.userId);
      const entries = await audits('branches.archive', b.id);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ actor_id: manager.userId, entity: 'branches', entity_id: b.id });

      expect(items(await manager.get(BRANCHES)).map((x) => x.id)).not.toContain(b.id);
      const all = items(await manager.get(`${BRANCHES}?includeArchived=true`));
      expect(all.find((x) => x.id === b.id)?.archivedAt).toBe(NOW);
    });

    it('archiving keeps the branch\'s role assignments', async () => {
      const b = item(await create({ code: fresh('peran') }));
      const holder = await seedStaff(h, { username: `pemegang_${b.id.slice(-6)}`, now: NOW, roles: [{ permissions: ['test.branch.manage'], branchId: b.id }] });
      const before = await countRows(h.db.selectFrom('user_roles').where('branch_id', '=', b.id));
      expect(before).toBe(1);
      expect((await manager.delete(`${BRANCHES}/${b.id}`)).status).toBe(200);
      expect(await countRows(h.db.selectFrom('user_roles').where('branch_id', '=', b.id))).toBe(1);
      const user = await h.db.selectFrom('staff_users').select(['status', 'authz_version']).where('id', '=', holder.id).executeTakeFirstOrThrow();
      expect(user).toMatchObject({ status: 'active', authz_version: 1 });
    });

    it('an archived branch again → 200, archived_at kept, the entry marks it', async () => {
      const b = item(await create({ code: fresh('dua') }));
      expect((await manager.delete(`${BRANCHES}/${b.id}`)).status).toBe(200);
      const again = await manager.delete(`${BRANCHES}/${b.id}`);
      expect(again.status).toBe(200);
      expect(item(again)).toMatchObject({ id: b.id, archivedAt: NOW, version: 1 });
      const entries = await audits('branches.archive', b.id);
      expect(entries.map((e) => e.meta['alreadyArchived'] ?? false)).toEqual([false, true]);
    });

    it('an unknown branch → 404; a malformed id → 422', async () => {
      const gone = await manager.delete(`${BRANCHES}/${newId()}`);
      expect(gone.status).toBe(404);
      expect(code(gone)).toBe('NOT_FOUND');
      expect((await manager.delete(`${BRANCHES}/xyz`)).status).toBe(422);
    });
  });

  describe('permission', () => {
    it('a user without system.branches.manage gets 403 AUTHZ_DENIED on every write, and nothing changes', async () => {
      const target = item(await create({ code: fresh('izin') }));
      const branches = await countRows(h.db.selectFrom('branches'));
      const entries = await countRows(h.db.selectFrom('audit_log').where('action', 'like', 'branches.%'));

      for (const who of [norole, usersAdmin]) {
        const post = await create({}, who);
        const patch = await who.patch(`${BRANCHES}/${target.id}`, { version: 0, name: 'Dilarang' });
        const del = await who.delete(`${BRANCHES}/${target.id}`);
        for (const res of [post, patch, del]) {
          expect(res.status).toBe(403);
          expect(code(res)).toBe('AUTHZ_DENIED');
        }
      }
      expect(await countRows(h.db.selectFrom('branches'))).toBe(branches);
      expect(await countRows(h.db.selectFrom('audit_log').where('action', 'like', 'branches.%'))).toBe(entries);
      const row = await h.db.selectFrom('branches').select(['name', 'archived_at']).where('id', '=', target.id).executeTakeFirstOrThrow();
      expect(row).toMatchObject({ name: 'Cabang Uji', archived_at: null });
    });

    it('a user who may manage branches but holds no other permission can still list them', async () => {
      expect((await manager.get(BRANCHES)).status).toBe(200);
      expect((await usersAdmin.get(BRANCHES)).status).toBe(200);
    });
  });
});
