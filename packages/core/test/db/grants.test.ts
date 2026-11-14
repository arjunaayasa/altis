import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations, withTx } from '@altis/db';
import { MESSAGES, newId, permissionCatalog, systemRolePermissions, type Permission, type SystemRoleKey } from '@altis/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { bumpAuthzVersion, can, createGrantsCache, loadGrants, type Grants } from '../../src/authz/grants.js';
import { ensureSystemRoles } from '../../src/authz/system-roles.js';

// Grants (spec §7.2): what a staff user may do, computed from their role assignments. A system role's permissions
// come from the catalog, a custom role's from role_permissions; a global assignment (scope_key '') grants
// everything of the role everywhere, a branch assignment only the role's branch-scoped permissions at that branch.
// Plus the system role rows (decision D5) and the authz_version bump (controller ruling B9). On the engine picked by
// ALTIS_TEST_DB.

const ctx = testDbContext();
const NOW = 1_767_225_600_000;

describe.skipIf(!ctx.available)(`grants and system roles [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let dataDir: string;

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-core-grants-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
  });

  afterAll(async () => {
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await h.db.deleteFrom('remember_tokens').execute();
    await h.db.deleteFrom('sessions').execute();
    await h.db.deleteFrom('user_roles').execute();
    await h.db.deleteFrom('role_permissions').execute();
    await h.db.deleteFrom('roles').execute();
    await h.db.deleteFrom('staff_users').execute();
  });

  // ---- seeding helpers ---------------------------------------------------------------------------------------

  async function seedUser(): Promise<string> {
    const id = newId();
    await h.db
      .insertInto('staff_users')
      .values({
        id,
        username_key: `U${id}`,
        username_display: `u${id}`,
        name: 'Staf Uji',
        password_hash: '$scrypt$test',
        status: 'active',
        created_at: NOW,
        updated_at: NOW,
      })
      .execute();
    return id;
  }

  async function seedRole(permissions: readonly string[], o: { mfaRequired?: boolean } = {}): Promise<string> {
    const id = newId();
    await h.db
      .insertInto('roles')
      .values({ id, key: `ROLE_${id}`, name: `Peran ${id}`, mfa_required: o.mfaRequired === true ? 1 : 0, created_at: NOW, updated_at: NOW })
      .execute();
    for (const permission of permissions) await h.db.insertInto('role_permissions').values({ role_id: id, permission }).execute();
    return id;
  }

  async function systemRoleId(key: SystemRoleKey): Promise<string> {
    const row = await h.db.selectFrom('roles').select('id').where('key', '=', key).executeTakeFirstOrThrow();
    return row.id;
  }

  async function assign(userId: string, roleId: string, branchId: string | null = null): Promise<void> {
    await h.db
      .insertInto('user_roles')
      .values({ id: newId(), user_id: userId, role_id: roleId, branch_id: branchId, scope_key: branchId ?? '', created_at: NOW })
      .execute();
  }

  const seedSystemRoles = () => withTx(h, (trx) => ensureSystemRoles(trx, NOW));

  const authzVersion = async (userId: string) =>
    (await h.db.selectFrom('staff_users').select('authz_version').where('id', '=', userId).executeTakeFirstOrThrow()).authz_version;

  const sorted = (s: ReadonlySet<Permission>) => [...s].sort();

  // ---- loadGrants -----------------------------------------------------------------------------------------------

  describe('loadGrants', () => {
    it('a user with global admin -> global equals the admin set; not a super admin', async () => {
      await seedSystemRoles();
      const u = await seedUser();
      await assign(u, await systemRoleId('admin'));
      const g = await loadGrants(h.db, u);
      expect(sorted(g.global)).toEqual([...systemRolePermissions('admin')].sort());
      expect(g.global.has('test.branch.manage')).toBe(true);
      expect(g.global.has('system.update.run')).toBe(false);
      expect(g.branches.size).toBe(0);
      expect(g.superAdmin).toBe(false);
      expect(g.roleMfaRequired).toBe(false);
    });

    it('a user with global super_admin -> every catalog permission, superAdmin true', async () => {
      await seedSystemRoles();
      const u = await seedUser();
      await assign(u, await systemRoleId('super_admin'));
      const g = await loadGrants(h.db, u);
      expect(sorted(g.global)).toEqual([...systemRolePermissions('super_admin')].sort());
      expect(g.superAdmin).toBe(true);
    });

    it('the permissions of a system role come from the catalog, never from role_permissions', async () => {
      await seedSystemRoles();
      const adminId = await systemRoleId('admin');
      // A stray row (a restore of a tampered database) does not give admin what the catalog withholds.
      await h.db.insertInto('role_permissions').values({ role_id: adminId, permission: 'system.update.run' }).execute();
      const u = await seedUser();
      await assign(u, adminId);
      const g = await loadGrants(h.db, u);
      expect(g.global.has('system.update.run')).toBe(false);
      expect(sorted(g.global)).toEqual([...systemRolePermissions('admin')].sort());
    });

    it('a custom role {system.users.read} at global scope -> exactly that permission', async () => {
      const u = await seedUser();
      await assign(u, await seedRole(['system.users.read']));
      const g = await loadGrants(h.db, u);
      expect(sorted(g.global)).toEqual(['system.users.read']);
      expect(g.branches.size).toBe(0);
      expect(g.superAdmin).toBe(false);
    });

    it('permissions outside the catalog are ignored (deny by default)', async () => {
      const u = await seedUser();
      await assign(u, await seedRole(['system.users.read', 'system.everything', 'opac.secret.read']));
      expect(sorted((await loadGrants(h.db, u)).global)).toEqual(['system.users.read']);
    });

    it('a test.branch.manage role assigned at branch B -> can at B, not at C, not globally', async () => {
      const B = newId();
      const C = newId();
      const u = await seedUser();
      await assign(u, await seedRole(['test.branch.manage']), B);
      const g = await loadGrants(h.db, u);
      expect(g.global.size).toBe(0);
      expect(can(g, 'test.branch.manage', B)).toBe(true);
      expect(can(g, 'test.branch.manage', C)).toBe(false);
      expect(can(g, 'test.branch.manage')).toBe(false);
      expect([...g.branches.keys()]).toEqual([B]);
    });

    it('a branch assignment adds only the branch-scoped permissions of the role', async () => {
      const B = newId();
      const u = await seedUser();
      await assign(u, await seedRole(['test.branch.manage', 'system.users.read']), B);
      await seedSystemRoles();
      // Even a system role at a branch (never written by the services: ROLE_SCOPE_INVALID) grants nothing global.
      await assign(u, await systemRoleId('super_admin'), B);
      const g = await loadGrants(h.db, u);
      expect(g.global.size).toBe(0);
      // The custom role's test.branch.manage, and super_admin's branch-scoped keys: from Phase 2 (its spec §12.1) also
      // catalog.locations.manage and catalog.items.manage.
      const branchScoped = permissionCatalog()
        .filter((d) => d.scope === 'branch')
        .map((d) => d.key);
      // Members and circulation add the desk, circulation.desk.use.
      expect(branchScoped).toEqual(['catalog.locations.manage', 'catalog.items.manage', 'circulation.desk.use', 'test.branch.manage']);
      expect(sorted(g.branches.get(B)!)).toEqual([...branchScoped].sort());
      expect(can(g, 'system.users.read', B)).toBe(false);
      expect(g.superAdmin).toBe(false);
    });

    it('several roles add up, globally and per branch; roleMfaRequired when any held role requires 2FA', async () => {
      const B = newId();
      const C = newId();
      const u = await seedUser();
      await assign(u, await seedRole(['system.users.read']));
      await assign(u, await seedRole(['system.audit.read', 'test.branch.manage']));
      await assign(u, await seedRole(['test.branch.manage'], { mfaRequired: true }), B);
      await assign(u, await seedRole(['test.branch.manage']), C);
      const g = await loadGrants(h.db, u);
      expect(sorted(g.global)).toEqual(['system.audit.read', 'system.users.read', 'test.branch.manage']);
      expect([...g.branches.keys()].sort()).toEqual([B, C].sort());
      expect(g.roleMfaRequired).toBe(true);
    });

    it('a system role requiring 2FA sets roleMfaRequired', async () => {
      await seedSystemRoles();
      await h.db.updateTable('roles').set({ mfa_required: 1 }).where('key', '=', 'admin').execute();
      const u = await seedUser();
      await assign(u, await systemRoleId('admin'));
      expect((await loadGrants(h.db, u)).roleMfaRequired).toBe(true);
    });

    it('a user without roles, or an unknown user, has no grants', async () => {
      const u = await seedUser();
      for (const id of [u, newId()]) {
        const g = await loadGrants(h.db, id);
        expect(g.global.size).toBe(0);
        expect(g.branches.size).toBe(0);
        expect(g.superAdmin).toBe(false);
        expect(g.roleMfaRequired).toBe(false);
      }
    });

    it('reads inside a transaction see its own uncommitted assignments', async () => {
      const u = await seedUser();
      const role = await seedRole(['system.users.read']);
      const seen = await withTx(h, async (trx) => {
        await trx
          .insertInto('user_roles')
          .values({ id: newId(), user_id: u, role_id: role, branch_id: null, scope_key: '', created_at: NOW })
          .execute();
        return sorted((await loadGrants(trx, u)).global);
      });
      expect(seen).toEqual(['system.users.read']);
    });
  });

  // ---- cache and authz_version --------------------------------------------------------------------------------

  describe('createGrantsCache / bumpAuthzVersion', () => {
    it('returns the cached object for the same authzVersion and reloads after bumpAuthzVersion', async () => {
      const u = await seedUser();
      await assign(u, await seedRole(['system.users.read']));
      const cache = createGrantsCache();
      const v1 = await authzVersion(u);
      const g1 = await cache.get(h.db, u, v1);
      expect(sorted(g1.global)).toEqual(['system.users.read']);

      // A change without a bump is not seen: the version is the cache key.
      await assign(u, await seedRole(['system.audit.read']));
      expect(await cache.get(h.db, u, v1)).toBe(g1);

      await withTx(h, (trx) => bumpAuthzVersion(trx, [u]));
      const v2 = await authzVersion(u);
      expect(v2).toBe(v1 + 1);
      const g2 = await cache.get(h.db, u, v2);
      expect(g2).not.toBe(g1);
      expect(sorted(g2.global)).toEqual(['system.audit.read', 'system.users.read']);
      expect(await cache.get(h.db, u, v2)).toBe(g2);
    });

    it('concurrent gets of one key share one load', async () => {
      const u = await seedUser();
      const cache = createGrantsCache();
      const [a, b] = await Promise.all([cache.get(h.db, u, 1), cache.get(h.db, u, 1)]);
      expect(a).toBe(b);
    });

    it('1c Task 15: clear() drops every entry (a restore raised the data epoch): the next get loads again', async () => {
      const u = await seedUser();
      await assign(u, await seedRole(['system.users.read']));
      const cache = createGrantsCache();
      const g1 = await cache.get(h.db, u, 1);
      expect(await cache.get(h.db, u, 1)).toBe(g1);
      cache.clear();
      const g2 = await cache.get(h.db, u, 1);
      expect(g2).not.toBe(g1);
      expect(sorted(g2.global)).toEqual(['system.users.read']);
    });

    it('is an LRU of at most `max` entries', async () => {
      const [a, b, c] = [await seedUser(), await seedUser(), await seedUser()];
      const cache = createGrantsCache({ max: 2 });
      const ga = await cache.get(h.db, a, 1);
      const gb = await cache.get(h.db, b, 1);
      expect(await cache.get(h.db, a, 1)).toBe(ga); // a is now the most recently used
      await cache.get(h.db, c, 1); // evicts b
      expect(await cache.get(h.db, a, 1)).toBe(ga);
      expect(await cache.get(h.db, b, 1)).not.toBe(gb);
    });

    it('T11: a load through a transaction is never cached: a rolled-back bump cannot pin its grants to the version', async () => {
      const u = await seedUser();
      const cache = createGrantsCache();
      const v1 = Number(await authzVersion(u));
      const extra = await seedRole(['system.audit.read']);

      // A transaction bumps the version, assigns a role, reads the grants through the cache, and rolls back.
      const seen: Grants[] = [];
      await expect(
        withTx(h, async (trx) => {
          await trx
            .insertInto('user_roles')
            .values({ id: newId(), user_id: u, role_id: extra, branch_id: null, scope_key: '', created_at: NOW })
            .execute();
          await bumpAuthzVersion(trx, [u]);
          seen.push(await cache.get(trx, u, v1 + 1), await cache.get(trx, u, v1 + 1));
          throw new Error('rolled back');
        }),
      ).rejects.toThrow('rolled back');
      expect(sorted(seen[0]!.global)).toEqual(['system.audit.read']);
      expect(seen[1]).not.toBe(seen[0]); // loaded twice: nothing kept
      expect(Number(await authzVersion(u))).toBe(v1);

      // The real change commits the same version without that role: the cache must not serve the transaction's load.
      await withTx(h, (trx) => bumpAuthzVersion(trx, [u]));
      expect(Number(await authzVersion(u))).toBe(v1 + 1);
      expect(sorted((await cache.get(h.db, u, v1 + 1)).global)).toEqual([]);
    });

    it('a failed load is not cached', async () => {
      const u = await seedUser();
      await assign(u, await seedRole(['system.users.read']));
      const cache = createGrantsCache();
      let failNext = true;
      const flaky = h.db.withPlugin({
        transformQuery({ node }) {
          if (failNext) {
            failNext = false;
            throw new Error('connection lost');
          }
          return node;
        },
        transformResult: ({ result }) => Promise.resolve(result),
      });
      await expect(cache.get(flaky, u, 1)).rejects.toThrow('connection lost');
      expect(sorted((await cache.get(flaky, u, 1)).global)).toEqual(['system.users.read']);
    });

    it('bumpAuthzVersion([u]) leaves no remember_tokens row of u, clears remember_selector on its sessions, and nothing of others', async () => {
      const u = await seedUser();
      const other = await seedUser();
      const token = (subjectId: string, selector: string) => ({
        selector,
        validator_hash: 'a'.repeat(64),
        subject_type: 'staff',
        subject_id: subjectId,
        expires_at: NOW + 86_400_000,
      });
      const session = (subjectId: string, id: string, rememberSelector: string) => ({
        id,
        subject_type: 'staff',
        subject_id: subjectId,
        created_at: NOW,
        last_seen_at: NOW,
        expires_at: NOW + 3_600_000,
        remember_selector: rememberSelector,
      });
      await h.db
        .insertInto('remember_tokens')
        .values([token(u, 'U'.repeat(24)), token(u, 'V'.repeat(24)), token(other, 'W'.repeat(24))])
        .execute();
      await h.db
        .insertInto('sessions')
        .values([session(u, '1'.repeat(64), 'U'.repeat(24)), session(other, '2'.repeat(64), 'W'.repeat(24))])
        .execute();
      const [vu, vo] = [await authzVersion(u), await authzVersion(other)];

      await withTx(h, (trx) => bumpAuthzVersion(trx, [u]));

      const tokens = await h.db.selectFrom('remember_tokens').select(['selector', 'subject_id']).execute();
      expect(tokens).toEqual([{ selector: 'W'.repeat(24), subject_id: other }]);
      const sessions = await h.db.selectFrom('sessions').select(['id', 'remember_selector']).orderBy('id').execute();
      expect(sessions).toEqual([
        { id: '1'.repeat(64), remember_selector: null },
        { id: '2'.repeat(64), remember_selector: 'W'.repeat(24) },
      ]);
      expect(await authzVersion(u)).toBe(vu + 1);
      expect(await authzVersion(other)).toBe(vo);
    });

    it('bumpAuthzVersion bumps every listed user once, duplicates included, and accepts an empty list', async () => {
      const [a, b] = [await seedUser(), await seedUser()];
      const [va, vb] = [await authzVersion(a), await authzVersion(b)];
      await withTx(h, (trx) => bumpAuthzVersion(trx, [a, b, a]));
      expect([await authzVersion(a), await authzVersion(b)]).toEqual([va + 1, vb + 1]);
      await withTx(h, (trx) => bumpAuthzVersion(trx, []));
      expect([await authzVersion(a), await authzVersion(b)]).toEqual([va + 1, vb + 1]);
    });

    it('bumpAuthzVersion handles more ids than one statement takes (every holder of an edited role)', async () => {
      const ids = Array.from({ length: 1201 }, () => newId());
      for (let i = 0; i < ids.length; i += 200) {
        await h.db
          .insertInto('staff_users')
          .values(
            ids.slice(i, i + 200).map((id) => ({
              id,
              username_key: `U${id}`,
              username_display: `u${id}`,
              name: 'Staf Uji',
              password_hash: '$scrypt$test',
              status: 'active',
              created_at: NOW,
              updated_at: NOW,
            })),
          )
          .execute();
      }
      await withTx(h, (trx) => bumpAuthzVersion(trx, ids));
      const versions = await h.db.selectFrom('staff_users').select('authz_version').execute();
      expect(versions).toHaveLength(1201);
      expect(new Set(versions.map((v) => v.authz_version))).toEqual(new Set([2]));
    });
  });

  // ---- system roles ---------------------------------------------------------------------------------------------

  describe('ensureSystemRoles', () => {
    const roleRows = () =>
      h.db.selectFrom('roles').select(['key', 'name', 'is_system', 'mfa_required', 'created_at']).orderBy('key').execute();

    it('twice -> 2 rows; a mfa_required = 1 set in between stays 1', async () => {
      expect(await withTx(h, (trx) => ensureSystemRoles(trx, NOW))).toEqual({ created: ['super_admin', 'admin'] });
      expect(await roleRows()).toEqual([
        { key: 'admin', name: MESSAGES.id['role.admin'], is_system: 1, mfa_required: 0, created_at: NOW },
        { key: 'super_admin', name: MESSAGES.id['role.super_admin'], is_system: 1, mfa_required: 0, created_at: NOW },
      ]);
      await h.db.updateTable('roles').set({ mfa_required: 1 }).where('key', '=', 'super_admin').execute();

      expect(await withTx(h, (trx) => ensureSystemRoles(trx, NOW + 1000))).toEqual({ created: [] });
      const rows = await roleRows();
      expect(rows).toHaveLength(2);
      expect(rows.find((r) => r.key === 'super_admin')).toMatchObject({ mfa_required: 1, created_at: NOW });
      expect(rows.find((r) => r.key === 'admin')).toMatchObject({ mfa_required: 0 });
    });

    it('an unchanged row is not written (its version stays)', async () => {
      await seedSystemRoles();
      const before = await h.db.selectFrom('roles').select(['key', 'version', 'updated_at']).orderBy('key').execute();
      await withTx(h, (trx) => ensureSystemRoles(trx, NOW + 5000));
      expect(await h.db.selectFrom('roles').select(['key', 'version', 'updated_at']).orderBy('key').execute()).toEqual(before);
    });

    it('restores the fixed name and is_system of an existing row, keeping its id and mfa_required', async () => {
      await seedSystemRoles();
      const id = await systemRoleId('admin');
      await h.db.updateTable('roles').set({ name: 'Renamed', is_system: 0, mfa_required: 1 }).where('key', '=', 'admin').execute();
      expect(await withTx(h, (trx) => ensureSystemRoles(trx, NOW + 1000))).toEqual({ created: [] });
      const row = await h.db.selectFrom('roles').selectAll().where('key', '=', 'admin').executeTakeFirstOrThrow();
      expect(row).toMatchObject({ id, name: MESSAGES.id['role.admin'], is_system: 1, mfa_required: 1, updated_at: NOW + 1000 });
    });

    it('creates only the missing role', async () => {
      await seedSystemRoles();
      await h.db.deleteFrom('roles').where('key', '=', 'admin').execute();
      expect(await withTx(h, (trx) => ensureSystemRoles(trx, NOW))).toEqual({ created: ['admin'] });
      expect((await roleRows()).map((r) => r.key)).toEqual(['admin', 'super_admin']);
    });
  });
});
