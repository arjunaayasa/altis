import type { DB } from '@altis/db';
import { isSystemRoleKey, permissionCatalog, systemRolePermissions, type Permission, type PermissionScope } from '@altis/shared';
import type { Kysely, Transaction } from 'kysely';

// What a staff user may do (spec §7.2), computed from their role assignments, deny by default:
//
// - a system role (`super_admin`, `admin`: `is_system = 1`) has the permissions the catalog gives it
//   (systemRolePermissions, decision D5), never what role_permissions holds; a custom role has its role_permissions
//   rows; a permission outside the catalog (a stale row, the test permission in a production build) grants nothing;
// - a global assignment (`scope_key = ''`) grants every permission of the role everywhere; a branch assignment grants
//   only the role's branch-scoped permissions, at that branch (a global permission cannot be held per branch);
// - `superAdmin` is a global assignment of the system role `super_admin`; `roleMfaRequired` is true when any held role
//   (at any scope) has `mfa_required = 1`.
//
// Permissions are recomputed per request from `staff_users.authz_version` (§7.2): the per-process cache below is keyed
// by it, so it never serves grants of an older version, and every rights change bumps the version
// (bumpAuthzVersion), which also ends the subject's remember-me tokens (controller ruling B9).

/** The permissions of one staff user. Shared between requests through the cache: never mutate it. */
export interface Grants {
  /** Held everywhere (global assignments). */
  global: ReadonlySet<Permission>;
  /** Branch-scoped permissions held at one branch only, by branch id (branch assignments). */
  branches: ReadonlyMap<string, ReadonlySet<Permission>>;
  /** A global assignment of the system role `super_admin`. */
  superAdmin: boolean;
  /** Some held role requires 2FA (`roles.mfa_required = 1`). */
  roleMfaRequired: boolean;
}

/** The scope of each catalog key (of the build profile), or undefined for a string outside the catalog. */
export function permissionScope(p: string): PermissionScope | undefined {
  return permissionCatalog().find((def) => def.key === p)?.scope;
}


/**
 * The grants of staff user `userId`, read with `db` (a transaction sees its own uncommitted assignments). An unknown
 * user, or one without roles, has none. The user's status is not looked at: the session layer refuses a disabled
 * account before it asks.
 */
export async function loadGrants(db: Kysely<DB> | Transaction<DB>, userId: string): Promise<Grants> {
  const assignments = await db
    .selectFrom('user_roles as ur')
    .innerJoin('roles as r', 'r.id', 'ur.role_id')
    .select(['ur.role_id', 'ur.scope_key', 'r.key', 'r.is_system', 'r.mfa_required'])
    .where('ur.user_id', '=', userId)
    .execute();

  const customIds = [...new Set(assignments.filter((a) => a.is_system !== 1).map((a) => a.role_id))];
  const customPermissions = new Map<string, Permission[]>();
  if (customIds.length > 0) {
    const rows = await db
      .selectFrom('role_permissions')
      .select(['role_id', 'permission'])
      .where('role_id', 'in', customIds)
      .execute();
    for (const row of rows) {
      if (permissionScope(row.permission) === undefined) continue;
      const list = customPermissions.get(row.role_id) ?? [];
      list.push(row.permission as Permission);
      customPermissions.set(row.role_id, list);
    }
  }

  const global = new Set<Permission>();
  const branches = new Map<string, Set<Permission>>();
  let superAdmin = false;
  let roleMfaRequired = false;
  for (const a of assignments) {
    const system = a.is_system === 1;
    let permissions: readonly Permission[];
    if (system) permissions = isSystemRoleKey(a.key) ? systemRolePermissions(a.key) : [];
    else permissions = customPermissions.get(a.role_id) ?? [];
    if (a.mfa_required === 1) roleMfaRequired = true;
    if (a.scope_key === '') {
      for (const p of permissions) global.add(p);
      if (system && a.key === 'super_admin') superAdmin = true;
      continue;
    }
    const scoped = permissions.filter((p) => permissionScope(p) === 'branch');
    if (scoped.length === 0) continue;
    let atBranch = branches.get(a.scope_key);
    if (atBranch === undefined) {
      atBranch = new Set();
      branches.set(a.scope_key, atBranch);
    }
    for (const p of scoped) atBranch.add(p);
  }
  return { global, branches, superAdmin, roleMfaRequired };
}

/** A per-process cache of {@link loadGrants}; see {@link createGrantsCache}. */
export interface GrantsCache {
  /**
   * The grants of `userId` at `authzVersion`: from the cache when this version was loaded before, otherwise loaded
   * with `db` and kept. Read `authzVersion` before the grants, so that a version is never paired with grants older
   * than it. Through a transaction handle the grants are loaded and never cached (nor served from the cache): what
   * a transaction reads may still roll back (a bump of the version included), and the next real change commits the
   * same version (T11), as createSettingsCache does.
   */
  get(db: Kysely<DB> | Transaction<DB>, userId: string, authzVersion: number): Promise<Grants>;
  /**
   * Drops every entry (1c Task 15): a restore raised the data epoch, so the `authz_version` numbers of the cache may
   * now name other grants (the restored database counts its versions again from its own state).
   */
  clear(): void;
}

/**
 * An LRU cache of grants keyed `${userId}:${authzVersion}`, at most `max` entries (default 500). Safe to keep per
 * process (P6: "cache memori hanya untuk data yang aman bila basi"): a rights change bumps the version, so a stale
 * entry is simply never asked for again. Concurrent requests for one key share one load; a failed load is dropped.
 */
export function createGrantsCache(o: { max?: number } = {}): GrantsCache {
  const max = o.max ?? 500;
  if (!Number.isSafeInteger(max) || max < 1) throw new TypeError(`createGrantsCache: max must be a positive integer, got ${max}`);
  const entries = new Map<string, Promise<Grants>>();
  return {
    get(db, userId, authzVersion) {
      if ((db as { isTransaction?: unknown }).isTransaction === true) return loadGrants(db, userId);
      const key = `${userId}:${authzVersion}`;
      const cached = entries.get(key);
      if (cached !== undefined) {
        // Map keeps insertion order: re-inserting makes the entry the most recently used.
        entries.delete(key);
        entries.set(key, cached);
        return cached;
      }
      const loading = loadGrants(db, userId);
      entries.set(key, loading);
      while (entries.size > max) entries.delete(entries.keys().next().value!);
      loading.catch(() => {
        if (entries.get(key) === loading) entries.delete(key);
      });
      return loading;
    },
    clear() {
      entries.clear();
    },
  };
}

/** True when `g` holds `p` globally, or at `branchId` when one is given. */
export function can(g: Grants, p: Permission, branchId?: string | null): boolean {
  if (g.global.has(p)) return true;
  if (branchId === undefined || branchId === null) return false;
  return g.branches.get(branchId)?.has(p) === true;
}

/**
 * True when `outer` holds everything `inner` holds: each global permission of `inner` globally, each branch
 * permission of `inner` at that branch (or globally). Anti-escalation rule 3 asks it of the target and the actor.
 */
export function grantSubset(inner: Grants, outer: Grants): boolean {
  for (const p of inner.global) if (!outer.global.has(p)) return false;
  for (const [branchId, permissions] of inner.branches) {
    for (const p of permissions) if (!can(outer, p, branchId)) return false;
  }
  return true;
}

/** Ids per statement in {@link bumpAuthzVersion}. */
const BUMP_CHUNK = 500;

/**
 * Marks a change of the rights of `userIds` (roles assigned or revoked, a held role edited), in the caller's
 * transaction: `authz_version = authz_version + 1`, so the next request of each recomputes their grants and rotates
 * their session; and (controller ruling B9, decision D38) every remember-me token of theirs is deleted and the
 * `remember_selector` of their sessions cleared, so a remember cookie never restores a session with the old rights.
 * Duplicate ids count once; an empty list does nothing. A long list (every holder of an edited role) is sent in
 * chunks of {@link BUMP_CHUNK} ids, within the parameter limits of every engine.
 */
export async function bumpAuthzVersion(trx: Transaction<DB>, userIds: readonly string[]): Promise<void> {
  const unique = [...new Set(userIds)];
  for (let i = 0; i < unique.length; i += BUMP_CHUNK) {
    const ids = unique.slice(i, i + BUMP_CHUNK);
    await trx
      .updateTable('staff_users')
      .set((eb) => ({ authz_version: eb('authz_version', '+', 1) }))
      .where('id', 'in', ids)
      .execute();
    await trx.deleteFrom('remember_tokens').where('subject_type', '=', 'staff').where('subject_id', 'in', ids).execute();
    await trx
      .updateTable('sessions')
      .set({ remember_selector: null })
      .where('subject_type', '=', 'staff')
      .where('subject_id', 'in', ids)
      .where('remember_selector', 'is not', null)
      .execute();
  }
}
