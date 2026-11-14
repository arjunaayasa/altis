import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureSystemRoles, randomToken, sha256hex } from '@altis/core';
import { PHASE1_MIGRATIONS, runMigrations, withTx } from '@altis/db';
import { DEFAULT_LOCALE, newId, permissionCatalog, systemRolePermissions, t } from '@altis/shared';
import type { PermissionItem, RoleItem } from '@altis/shared/api/roles';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { createApp } from '../../src/app.js';
import { createAgent, type AgentReply } from '../agent.js';
import { recordingLogger, sampleConfig } from '../support.js';
import { seedStaff, sessionCookieFor, sessionCsrfFor, type SeedRole } from '../support-auth.js';

// The roles and permissions API of Task 20 (spec §7.2, §13.5 "Peran", route catalog) on the engine picked by
// ALTIS_TEST_DB: the permission catalog, the system roles read-only but for their 2FA switch, custom roles keyed by
// their normalized name, anti-escalation rules 1, 3 and 5 (A4), holders' `authz_version` bumped when a role's rights
// change, a held role never deleted, and every write behind a fresh reauth (§7.3).

const ctx = testDbContext();
let h: TestDbHandle;

const SEC = 1000;
const MIN = 60 * SEC;
/** In the past: an audit entry may not be dated ahead of the real clock. */
const NOW = Date.UTC(2026, 9, 20, 9, 0, 5);
const CONFIG = sampleConfig();
/** baseUrl is https: the session cookie is `__Host-altis_sid`. */
const SID = '__Host-altis_sid';
const PERMISSIONS = '/api/v1/permissions';
const ROLES = '/api/v1/roles';

function appAt() {
  return createApp({
    state: { phase: 'ready', db: h, config: CONFIG },
    version: '1.4.2',
    buildId: 'build-x',
    log: recordingLogger(),
    clock: () => NOW,
  });
}

interface Client {
  get(p: string): Promise<AgentReply>;
  post(p: string, body: unknown, headers?: Record<string, string>): Promise<AgentReply>;
  patch(p: string, body: unknown): Promise<AgentReply>;
  delete(p: string): Promise<AgentReply>;
}

/**
 * A browser signed in as `userId` (a full session made at NOW), re-authenticated at `reauthAt` (default NOW; null for
 * none). Every write carries the CSRF token of the session the jar holds at that moment (a rights change rotates it).
 */
async function as(userId: string, o: { reauthAt?: number | null } = {}): Promise<Client> {
  const token = await sessionCookieFor(h, userId, { now: NOW, reauthAt: o.reauthAt === undefined ? NOW : o.reauthAt });
  const agent = createAgent(appAt());
  agent.setCookie(SID, token);
  const csrf = (): Record<string, string> => ({ 'x-csrf-token': sessionCsrfFor(CONFIG, agent.cookies.get(SID)!) });
  return {
    get: (p) => agent.get(p),
    post: (p, body, headers = {}) => agent.post(p, body, { ...csrf(), ...headers }),
    patch: (p, body) => agent.patch(p, body, csrf()),
    delete: (p) => agent.delete(p, undefined, csrf()),
  };
}

const code = (res: AgentReply): string | undefined => (res.json as { code?: string } | undefined)?.code;
const errorsOf = (res: AgentReply): unknown => (res.json as { errors?: unknown } | undefined)?.errors;

async function seed(username: string, roles: SeedRole[] = []): Promise<string> {
  return (await seedStaff(h, { username, roles, now: NOW })).id;
}

async function roleRow(key: string) {
  return h.db.selectFrom('roles').selectAll().where('key', '=', key).executeTakeFirstOrThrow();
}

async function versionOf(roleId: string): Promise<number> {
  const row = await h.db.selectFrom('roles').select('version').where('id', '=', roleId).executeTakeFirstOrThrow();
  return Number(row.version);
}

async function authzVersion(userId: string): Promise<number> {
  const row = await h.db.selectFrom('staff_users').select('authz_version').where('id', '=', userId).executeTakeFirstOrThrow();
  return Number(row.authz_version);
}

/** A role assignment written straight into user_roles (no branch row is needed: `branch_id` has no foreign key). */
async function assign(userId: string, roleId: string, branchId: string | null = null): Promise<void> {
  await h.db
    .insertInto('user_roles')
    .values({ id: newId(), user_id: userId, role_id: roleId, branch_id: branchId, scope_key: branchId ?? '', created_at: NOW })
    .execute();
}

/** A remember-me token row of `userId` (what bumpAuthzVersion deletes, ruling B9). */
async function rememberTokenFor(userId: string): Promise<void> {
  await h.db
    .insertInto('remember_tokens')
    .values({
      selector: randomToken(18), // 24 base64url characters
      validator_hash: sha256hex(newId()),
      subject_type: 'staff',
      subject_id: userId,
      mfa_bound: 1,
      expires_at: NOW + 30 * 24 * 60 * MIN,
    })
    .execute();
}

const rememberTokens = async (userId: string): Promise<number> =>
  (await h.db.selectFrom('remember_tokens').select('selector').where('subject_id', '=', userId).execute()).length;

async function audits(action: string) {
  const rows = await h.db
    .selectFrom('audit_log')
    .select(['actor_type', 'actor_id', 'entity', 'entity_id', 'meta'])
    .where('action', '=', action)
    .orderBy('seq')
    .execute();
  return rows.map((r) => ({ ...r, meta: JSON.parse(r.meta) as Record<string, unknown> }));
}

describe.skipIf(!ctx.available)(`roles and permissions API [${engineLabel()}]`, () => {
  let dataDir: string;
  /** Super admin, admin (system roles, global). */
  let sa: string;
  let ad: string;

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-roles-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
  });

  afterAll(async () => {
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await h.db.deleteFrom('sessions').execute();
    await h.db.deleteFrom('remember_tokens').execute();
    await h.db.deleteFrom('rate_limits').execute();
    await h.db.deleteFrom('idempotency_keys').execute();
    await h.db.deleteFrom('settings').execute();
    await h.db.deleteFrom('staff_users').execute(); // user_roles and recovery codes cascade
    await h.db.deleteFrom('role_permissions').execute();
    await h.db.deleteFrom('roles').execute();
    await h.db.deleteFrom('audit_log').execute();
    await h.db.updateTable('audit_head').set({ last_seq: 0, last_hash: '0'.repeat(64) }).where('id', '=', 1).execute();
    await withTx(h, (trx) => ensureSystemRoles(trx, NOW));
    sa = await seed('sa', [{ key: 'super_admin' }]);
    ad = await seed('ad', [{ key: 'admin' }]);
  });

  describe('GET permissions', () => {
    it('the catalog of the test profile: 45 items in catalog order, the last test.branch.manage with scope branch', async () => {
      const res = await (await as(ad)).get(PERMISSIONS);
      expect(res.status).toBe(200);
      const { items } = res.json as { items: PermissionItem[] };
      // The community edition: the Sistem group without system.license.* (19 keys).
      expect(items).toHaveLength(45);
      expect(items[0]).toEqual({ key: 'system.settings.read', scope: 'global', module: 'system' });
      expect(items.filter((i) => i.key.startsWith('system.license.'))).toEqual([]);
      // Phase 2 (its spec §12.1): the catalog's keys after Phase 1's, two of them branch-scoped.
      expect(items[19]).toEqual({ key: 'catalog.records.read', scope: 'global', module: 'catalog' });
      expect(items[23]).toEqual({ key: 'catalog.locations.manage', scope: 'branch', module: 'catalog' });
      expect(items[24]).toEqual({ key: 'catalog.items.manage', scope: 'branch', module: 'catalog' });
      expect(items[28]).toEqual({ key: 'opac.pages.manage', scope: 'global', module: 'opac' });
      // Reports and accreditation: three global keys after the catalogue's, before the test key.
      expect(items.slice(29, 32)).toEqual([
        { key: 'reports.statistics.read', scope: 'global', module: 'reports' },
        { key: 'accreditation.workspace.read', scope: 'global', module: 'accreditation' },
        { key: 'accreditation.workspace.manage', scope: 'global', module: 'accreditation' },
      ]);
      // Members and circulation: seven keys after them, the desk's branch-scoped.
      expect(items.slice(32, 39).map((i) => [i.key, i.scope, i.module])).toEqual([
        ['members.records.read', 'global', 'members'],
        ['members.records.manage', 'global', 'members'],
        ['members.types.manage', 'global', 'members'],
        ['members.import.run', 'global', 'members'],
        ['circulation.desk.use', 'branch', 'circulation'],
        ['circulation.policies.manage', 'global', 'circulation'],
        ['circulation.records.read', 'global', 'circulation'],
      ]);
      // Members extended and visits: five keys after them, visits and stations branch-scoped.
      expect(items.slice(39, 44).map((i) => [i.key, i.scope, i.module])).toEqual([
        ['members.export.run', 'global', 'members'],
        ['members.privacy.manage', 'global', 'members'],
        ['visits.records.read', 'global', 'visits'],
        ['visits.records.manage', 'branch', 'visits'],
        ['visits.stations.manage', 'branch', 'visits'],
      ]);
      expect(items[44]).toEqual({ key: 'test.branch.manage', scope: 'branch', module: 'test' });
      expect(items.map((i) => i.key)).toEqual(permissionCatalog().map((d) => d.key));
    });

    it('the reads need system.users.read (decision D7: system.roles.manage implies nothing) → 403 AUTHZ_DENIED', async () => {
      const st = await seed('st', [{ permissions: ['system.audit.read', 'system.roles.manage'] }]);
      const client = await as(st);
      const superAdmin = await roleRow('super_admin');
      for (const p of [PERMISSIONS, ROLES, `${ROLES}/${superAdmin.id}`]) {
        const res = await client.get(p);
        expect(res.status, p).toBe(403);
        expect(code(res)).toBe('AUTHZ_DENIED');
      }
    });
  });

  describe('GET roles, GET roles/:id', () => {
    it('super_admin and admin with isSystem and computed permissions, then custom roles with their holders', async () => {
      const superAdmin = await roleRow('super_admin');
      const custom = newId();
      await h.db
        .insertInto('roles')
        .values({ id: custom, key: 'PENGELOLA CABANG', name: 'Pengelola cabang', description: 'Per cabang', created_at: NOW, updated_at: NOW })
        .execute();
      await h.db.insertInto('role_permissions').values({ role_id: custom, permission: 'test.branch.manage' }).execute();
      const u1 = await seed('u1');
      const u2 = await seed('u2');
      const [b, c] = [newId(), newId()];
      await assign(u1, custom, b);
      await assign(u1, custom, c); // one holder at two branches counts once
      await assign(u2, custom, b);
      await seed('sa2', [{ key: 'super_admin' }]);

      const res = await (await as(ad)).get(ROLES);
      expect(res.status).toBe(200);
      const { items } = res.json as { items: RoleItem[] };
      expect(items.map((r) => r.key)).toEqual(['super_admin', 'admin', 'PENGELOLA CABANG']);
      expect(items[0]).toEqual({
        id: superAdmin.id,
        key: 'super_admin',
        name: t(DEFAULT_LOCALE, 'role.super_admin'),
        description: null,
        isSystem: true,
        mfaRequired: false,
        permissions: [...systemRolePermissions('super_admin')],
        holders: 2,
        version: 0,
      });
      expect(items[1]).toMatchObject({ key: 'admin', isSystem: true, permissions: [...systemRolePermissions('admin')], holders: 1 });
      expect(items[2]).toEqual({
        id: custom,
        key: 'PENGELOLA CABANG',
        name: 'Pengelola cabang',
        description: 'Per cabang',
        isSystem: false,
        mfaRequired: false,
        permissions: ['test.branch.manage'],
        holders: 2,
        version: 0,
      });

      const one = await (await as(ad)).get(`${ROLES}/${custom}`);
      expect(one.status).toBe(200);
      expect(one.json).toEqual(items[2]);
    });

    it('an unknown id → 404 NOT_FOUND; a malformed id → 422', async () => {
      const client = await as(ad);
      const missing = await client.get(`${ROLES}/${newId()}`);
      expect(missing.status).toBe(404);
      expect(code(missing)).toBe('NOT_FOUND');
      const malformed = await client.get(`${ROLES}/abc`);
      expect(malformed.status).toBe(422);
      expect(code(malformed)).toBe('VALIDATION_FAILED');
    });
  });

  describe('custom roles', () => {
    it('POST roles → 201 RoleItem keyed by the normalized name, created_by the actor, one roles.create entry', async () => {
      const res = await (await as(sa)).post(ROLES, {
        name: '  Pustakawan  sirkulasi ',
        description: 'Petugas meja sirkulasi',
        permissions: ['system.audit.read', 'system.users.read'],
        mfaRequired: true,
      });
      expect(res.status).toBe(201);
      const item = res.json as RoleItem;
      expect(item).toEqual({
        id: expect.any(String),
        key: 'PUSTAKAWAN SIRKULASI',
        name: 'Pustakawan  sirkulasi',
        description: 'Petugas meja sirkulasi',
        isSystem: false,
        mfaRequired: true,
        permissions: ['system.users.read', 'system.audit.read'], // catalog order
        holders: 0,
        version: 0,
      });
      const row = await roleRow('PUSTAKAWAN SIRKULASI');
      expect(row).toMatchObject({ id: item.id, created_by: sa, updated_by: sa });
      expect(Number(row.created_at)).toBe(NOW);
      expect(Number(row.is_system)).toBe(0);
      expect(Number(row.mfa_required)).toBe(1);
      const created = await audits('roles.create');
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({ actor_type: 'staff', actor_id: sa, entity: 'roles', entity_id: item.id });
      expect(created[0]!.meta).toMatchObject({ key: 'PUSTAKAWAN SIRKULASI', permissions: ['system.users.read', 'system.audit.read'] });
    });

    it('the same name twice (case and spacing aside) → 422 VALIDATION_FAILED {path: name, code: taken}', async () => {
      const client = await as(sa);
      expect((await client.post(ROLES, { name: 'Pustakawan', permissions: [] })).status).toBe(201);
      const again = await client.post(ROLES, { name: ' pustakawan', permissions: ['system.users.read'] });
      expect(again.status).toBe(422);
      expect(code(again)).toBe('VALIDATION_FAILED');
      expect(errorsOf(again)).toEqual([{ path: 'name', code: 'taken' }]);
      // A system key does not collide: custom keys are upper case.
      expect((await client.post(ROLES, { name: 'admin', permissions: [] })).status).toBe(201);
      expect((await audits('roles.create')).length).toBe(2);
    });

    it('a body outside the schema → 422: unknown or repeated permissions, an empty or over-long name, an unknown key', async () => {
      const client = await as(sa);
      const cases: [unknown, string][] = [
        [{ name: 'X', permissions: ['system.nope'] }, 'permissions.0'],
        [{ name: 'X', permissions: ['system.users.read', 'system.users.read'] }, 'permissions'],
        [{ name: '   ', permissions: [] }, 'name'],
        [{ name: 'x'.repeat(101), permissions: [] }, 'name'],
        [{ name: 'X', description: 'd'.repeat(1001), permissions: [] }, 'description'],
        [{ name: 'X', permissions: Array.from({ length: 101 }, () => 'system.users.read') }, 'permissions'],
        [{ name: 'X', permissions: [], isSystem: true }, ''],
      ];
      for (const [body, at] of cases) {
        const res = await client.post(ROLES, body);
        expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(422);
        expect((errorsOf(res) as { path: string }[]).map((e) => e.path)).toContain(at);
      }
      expect(await audits('roles.create')).toEqual([]);
    });

    it('PATCH: a stale version → 409 CONFLICT_STALE; a rename to a taken name → 422 taken; a rename alone bumps nobody', async () => {
      const client = await as(sa);
      const a = (await client.post(ROLES, { name: 'Alpha', permissions: ['system.users.read'] })).json as RoleItem;
      await client.post(ROLES, { name: 'Beta', permissions: [] });
      const holder = await seed('holder');
      await assign(holder, a.id);
      const before = await authzVersion(holder);

      const stale = await client.patch(`${ROLES}/${a.id}`, { version: a.version + 1, name: 'Gamma' });
      expect(stale.status).toBe(409);
      expect(code(stale)).toBe('CONFLICT_STALE');

      const taken = await client.patch(`${ROLES}/${a.id}`, { version: a.version, name: 'BETA' });
      expect(taken.status).toBe(422);
      expect(errorsOf(taken)).toEqual([{ path: 'name', code: 'taken' }]);

      const renamed = await client.patch(`${ROLES}/${a.id}`, { version: a.version, name: 'Alfa', description: 'Baru' });
      expect(renamed.status).toBe(200);
      expect(renamed.json).toMatchObject({ id: a.id, key: 'ALFA', name: 'Alfa', description: 'Baru', version: a.version + 1, holders: 1 });
      expect(await authzVersion(holder)).toBe(before);
      expect((await audits('roles.update')).length).toBe(1);
    });

    it("PATCH permissions → the holders' authz_version + 1 and their remember tokens gone; others untouched", async () => {
      const client = await as(sa);
      const role = (await client.post(ROLES, { name: 'Auditor', permissions: ['system.audit.read'] })).json as RoleItem;
      const [h1, h2, other] = [await seed('h1'), await seed('h2'), await seed('other')];
      await assign(h1, role.id);
      await assign(h2, role.id, newId());
      for (const u of [h1, h2, other]) await rememberTokenFor(u);
      const [v1, v2, vo] = [await authzVersion(h1), await authzVersion(h2), await authzVersion(other)];

      const res = await client.patch(`${ROLES}/${role.id}`, { version: role.version, permissions: ['system.audit.read', 'system.audit.export'] });
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ permissions: ['system.audit.read', 'system.audit.export'], version: role.version + 1, holders: 2 });
      expect(await authzVersion(h1)).toBe(v1 + 1);
      expect(await authzVersion(h2)).toBe(v2 + 1);
      expect(await authzVersion(other)).toBe(vo);
      expect(await rememberTokens(h1)).toBe(0);
      expect(await rememberTokens(h2)).toBe(0);
      expect(await rememberTokens(other)).toBe(1);
      const stored = await h.db.selectFrom('role_permissions').select('permission').where('role_id', '=', role.id).execute();
      expect(stored.map((r) => r.permission).sort()).toEqual(['system.audit.export', 'system.audit.read']);
      const updated = await audits('roles.update');
      expect(updated).toHaveLength(1);
      expect(updated[0]!.meta).toMatchObject({ added: ['system.audit.export'], removed: [] });
    });

    it('DELETE: a role with a holder → 409 ROLE_IN_USE; without holders → 200, the role and its permissions gone, roles.delete', async () => {
      const client = await as(sa);
      const held = (await client.post(ROLES, { name: 'Dipegang', permissions: ['system.users.read'] })).json as RoleItem;
      const free = (await client.post(ROLES, { name: 'Bebas', permissions: ['system.users.read'] })).json as RoleItem;
      await assign(await seed('pemegang'), held.id);

      const inUse = await client.delete(`${ROLES}/${held.id}`);
      expect(inUse.status).toBe(409);
      expect(code(inUse)).toBe('ROLE_IN_USE');

      const gone = await client.delete(`${ROLES}/${free.id}`);
      expect(gone.status).toBe(200);
      expect(gone.json).toMatchObject({ id: free.id, key: 'BEBAS', holders: 0 });
      expect(await h.db.selectFrom('roles').select('id').where('id', '=', free.id).execute()).toEqual([]);
      expect(await h.db.selectFrom('role_permissions').select('role_id').where('role_id', '=', free.id).execute()).toEqual([]);
      const deleted = await audits('roles.delete');
      expect(deleted).toHaveLength(1);
      expect(deleted[0]).toMatchObject({ actor_id: sa, entity: 'roles', entity_id: free.id });
      expect(deleted[0]!.meta).toMatchObject({ key: 'BEBAS' });

      const again = await client.delete(`${ROLES}/${free.id}`);
      expect(again.status).toBe(404);
    });

    it('an Idempotency-Key replays the stored 201 without a second role', async () => {
      const client = await as(sa);
      const key = 'roles-create-0001';
      const first = await client.post(ROLES, { name: 'Sekali', permissions: [] }, { 'idempotency-key': key });
      const second = await client.post(ROLES, { name: 'Sekali', permissions: [] }, { 'idempotency-key': key });
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(second.json).toEqual(first.json);
      expect(second.headers.get('idempotent-replayed')).toBe('true');
      expect(await h.db.selectFrom('roles').select('id').where('key', '=', 'SEKALI').execute()).toHaveLength(1);
      expect(await audits('roles.create')).toHaveLength(1);
    });

    it('writes need system.roles.manage: a user holding only system.users.read → 403 AUTHZ_DENIED', async () => {
      const reader = await seed('reader', [{ permissions: ['system.users.read'] }]);
      const res = await (await as(reader)).post(ROLES, { name: 'X', permissions: [] });
      expect(res.status).toBe(403);
      expect(code(res)).toBe('AUTHZ_DENIED');
    });
  });

  describe('A4: anti-escalation (rules 1, 3 and 5)', () => {
    it('admin creating a role with system.update.run → 403 AUTHZ_ESCALATION, nothing written', async () => {
      const res = await (await as(ad)).post(ROLES, { name: 'Pembaru', permissions: ['system.update.run'] });
      expect(res.status).toBe(403);
      expect(code(res)).toBe('AUTHZ_ESCALATION');
      expect(await h.db.selectFrom('roles').select('id').where('key', '=', 'PEMBARU').execute()).toEqual([]);
      expect(await audits('roles.create')).toEqual([]);
    });

    it('admin granting system.roles.manage (a super-admin-only grant it holds) → 403 AUTHZ_ESCALATION (rule 5)', async () => {
      const res = await (await as(ad)).post(ROLES, { name: 'Pengelola peran', permissions: ['system.roles.manage'] });
      expect(res.status).toBe(403);
      expect(code(res)).toBe('AUTHZ_ESCALATION');
    });

    it('admin may create and edit a role within its own rights', async () => {
      const client = await as(ad);
      const created = await client.post(ROLES, { name: 'Operator', permissions: ['system.users.read'] });
      expect(created.status).toBe(201);
      const role = created.json as RoleItem;
      const edited = await client.patch(`${ROLES}/${role.id}`, { version: role.version, permissions: ['system.users.read', 'system.users.manage'] });
      expect(edited.status).toBe(200);
    });

    it('admin editing or deleting a role that holds rights admin lacks → 403 AUTHZ_ESCALATION (rule 1)', async () => {
      const role = (await (await as(sa)).post(ROLES, { name: 'Konfigurator', permissions: ['system.config.manage'] })).json as RoleItem;
      const client = await as(ad);
      const rename = await client.patch(`${ROLES}/${role.id}`, { version: role.version, name: 'Konfigurasi' });
      expect(rename.status).toBe(403);
      expect(code(rename)).toBe('AUTHZ_ESCALATION');
      const drop = await client.patch(`${ROLES}/${role.id}`, { version: role.version, permissions: [] });
      expect(drop.status).toBe(403);
      const del = await client.delete(`${ROLES}/${role.id}`);
      expect(del.status).toBe(403);
      expect(code(del)).toBe('AUTHZ_ESCALATION');
      expect(await versionOf(role.id)).toBe(role.version);
    });

    it("admin toggling super_admin's mfaRequired → 403; super admin → 200 and every super admin's authz_version + 1", async () => {
      const sa2 = await seed('sa2', [{ key: 'super_admin' }]);
      const superAdmin = await roleRow('super_admin');
      const current = Number(superAdmin.version);
      const admin = await as(ad);
      for (const mfaRequired of [false, true]) {
        const res = await admin.patch(`${ROLES}/${superAdmin.id}`, { version: current, mfaRequired });
        expect(res.status).toBe(403);
        expect(code(res)).toBe('AUTHZ_ESCALATION');
      }
      const [vSa, vSa2, vAd] = [await authzVersion(sa), await authzVersion(sa2), await authzVersion(ad)];

      const res = await (await as(sa)).patch(`${ROLES}/${superAdmin.id}`, { version: current, mfaRequired: true });
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ key: 'super_admin', isSystem: true, mfaRequired: true, version: current + 1, holders: 2 });
      expect(Number((await roleRow('super_admin')).mfa_required)).toBe(1);
      expect(await authzVersion(sa)).toBe(vSa + 1);
      expect(await authzVersion(sa2)).toBe(vSa2 + 1);
      expect(await authzVersion(ad)).toBe(vAd);
      const updated = await audits('roles.update');
      expect(updated).toHaveLength(1);
      expect(updated[0]).toMatchObject({ actor_id: sa, entity: 'roles', entity_id: superAdmin.id });
      expect(updated[0]!.meta).toMatchObject({ key: 'super_admin', mfaRequired: { from: false, to: true } });
    });

    it("rule 3 for mfaRequired (§7.2): admin lifting 2FA on a custom role a super admin holds → 403, nothing changed; on one only its peers hold → 200", async () => {
      const role = (await (await as(sa)).post(ROLES, { name: 'Wajib 2FA', permissions: [], mfaRequired: true })).json as RoleItem;
      await assign(sa, role.id);
      const vSa = await authzVersion(sa);
      const admin = await as(ad);
      const lift = await admin.patch(`${ROLES}/${role.id}`, { version: role.version, mfaRequired: false });
      expect(lift.status).toBe(403);
      expect(code(lift)).toBe('AUTHZ_ESCALATION');
      expect(Number((await roleRow(role.key)).mfa_required)).toBe(1);
      expect(await versionOf(role.id)).toBe(role.version);
      expect(await authzVersion(sa)).toBe(vSa);
      expect(await audits('roles.update')).toEqual([]);
      // A rename of the same role changes no holder's rights: allowed.
      expect((await admin.patch(`${ROLES}/${role.id}`, { version: role.version, name: 'Wajib dua langkah' })).status).toBe(200);

      // Held by an account within admin's rights (and by admin itself): allowed.
      const peer = (await (await as(sa)).post(ROLES, { name: 'Wajib 2FA staf', permissions: [], mfaRequired: true })).json as RoleItem;
      await assign(await seed('staf', [{ permissions: ['system.users.read'] }]), peer.id);
      await assign(ad, peer.id);
      const ok = await admin.patch(`${ROLES}/${peer.id}`, { version: peer.version, mfaRequired: false });
      expect(ok.status).toBe(200);
      expect(ok.json).toMatchObject({ mfaRequired: false, holders: 2 });
    });

    it("admin switching 2FA on the admin role → 403 (rule 5: it holds system.roles.manage); super admin → 200, the admins bumped", async () => {
      const adminRole = await roleRow('admin');
      const version = Number(adminRole.version);
      const denied = await (await as(ad)).patch(`${ROLES}/${adminRole.id}`, { version, mfaRequired: true });
      expect(denied.status).toBe(403);
      expect(code(denied)).toBe('AUTHZ_ESCALATION');
      const [vAd, vSa] = [await authzVersion(ad), await authzVersion(sa)];

      const res = await (await as(sa)).patch(`${ROLES}/${adminRole.id}`, { version, mfaRequired: true });
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ key: 'admin', mfaRequired: true, permissions: [...systemRolePermissions('admin')], holders: 1 });
      expect(await authzVersion(ad)).toBe(vAd + 1);
      expect(await authzVersion(sa)).toBe(vSa);
    });
  });

  describe('system roles', () => {
    it('a super admin changing the permissions, the name or the description of admin → 409 ROLE_SYSTEM_READONLY', async () => {
      const adminRole = await roleRow('admin');
      const version = Number(adminRole.version);
      const client = await as(sa);
      for (const change of [{ permissions: ['system.users.read'] }, { name: 'Pengelola' }, { description: 'Diubah' }]) {
        const res = await client.patch(`${ROLES}/${adminRole.id}`, { version, ...change });
        expect(res.status, JSON.stringify(change)).toBe(409);
        expect(code(res)).toBe('ROLE_SYSTEM_READONLY');
      }
      expect(await versionOf(adminRole.id)).toBe(version);
      expect(await audits('roles.update')).toEqual([]);
    });

    it('deleting a system role → 409 ROLE_SYSTEM_READONLY, even without holders', async () => {
      await h.db.deleteFrom('staff_users').where('id', '=', ad).execute();
      const adminRole = await roleRow('admin');
      const res = await (await as(sa)).delete(`${ROLES}/${adminRole.id}`);
      expect(res.status).toBe(409);
      expect(code(res)).toBe('ROLE_SYSTEM_READONLY');
      expect(await h.db.selectFrom('roles').select('id').where('key', '=', 'admin').execute()).toHaveLength(1);
    });
  });

  describe('reauth (§7.3)', () => {
    it('every write route without a reauth within 5 minutes → 401 AUTH_REAUTH_REQUIRED', async () => {
      const role = (await (await as(sa)).post(ROLES, { name: 'Target', permissions: [] })).json as RoleItem;
      for (const reauthAt of [null, NOW - 5 * MIN - 1]) {
        const client = await as(sa, { reauthAt });
        const writes = [
          await client.post(ROLES, { name: 'Baru', permissions: [] }),
          await client.patch(`${ROLES}/${role.id}`, { version: role.version, name: 'Lain' }),
          await client.delete(`${ROLES}/${role.id}`),
        ];
        for (const res of writes) {
          expect(res.status).toBe(401);
          expect(code(res)).toBe('AUTH_REAUTH_REQUIRED');
        }
      }
      // Reads need none.
      expect((await (await as(sa, { reauthAt: null })).get(ROLES)).status).toBe(200);
      expect(await versionOf(role.id)).toBe(role.version);
      expect((await audits('roles.create')).length).toBe(1);
    });
  });
});
