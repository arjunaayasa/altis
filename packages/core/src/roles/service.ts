import { countRows, type DB } from '@altis/db';
import {
  DomainError,
  SYSTEM_ROLE_KEYS,
  isSystemRoleKey,
  newId,
  normalizeKey,
  permissionCatalog,
  systemRolePermissions,
  type Permission,
} from '@altis/shared';
import type { PermissionItem, RoleCreateBody, RoleItem, RolePatchBody } from '@altis/shared/api/roles';
import type { Kysely, Transaction } from 'kysely';
import { assertCanManageUser, assertCanWriteRole, type ActorAuthz, type RoleSnapshot } from '../authz/escalation.js';
import { bumpAuthzVersion, loadGrants } from '../authz/grants.js';
import type { TxCtx } from '../context.js';

// Roles and the permission catalog (spec §7.2, §13.5 "Peran", route catalog `permissions.list`, `roles.*`).
//
// - The system roles `super_admin` and `admin` are rows seeded by ensureSystemRoles (decision D5). Their permissions
//   are computed from the catalog, never stored; only `mfaRequired` of theirs may change (ROLE_SYSTEM_READONLY
//   otherwise), and they are never deleted.
// - A custom role's key is `normalizeKey(name)` (decision D25) and follows a rename; a key another role has is
//   VALIDATION_FAILED `{path: 'name', code: 'taken'}` (decision D10). A permission row outside the catalog of the
//   build profile (a stale row) is not shown, as loadGrants does not grant it.
// - Every write runs assertCanWriteRole (anti-escalation rules 1, 3 for `mfaRequired`, and 5) on the role before and
//   after. A change of `mfaRequired` also runs rule 3 on every holder (§7.2: "Aturan yang sama berlaku untuk mengubah
//   roles.mfa_required"): each holder's grants ⊆ the editor's (assertCanManageUser), so an admin cannot lift the 2FA
//   requirement of an account it may not manage through a role they share. A change of a role's rights (its permissions, or its `mfaRequired`) bumps the `authz_version` of every
//   holder (bumpAuthzVersion: their next request recomputes their grants and rotates the session, and their
//   remember-me tokens go, ruling B9). A role someone holds is never deleted (ROLE_IN_USE): revoking the assignments
//   first is what revokes the holders' sessions (spec §7.1).
// - updateRole and deleteRole take the role row's lock as the first statement of the transaction (a no-op locking
//   UPDATE, as guardSuperAdmins does), so the reads after it see what a concurrent writer of that row committed, on
//   MySQL/MariaDB REPEATABLE READ too: a concurrent edit is CONFLICT_STALE and an assignment made meanwhile is
//   ROLE_IN_USE rather than a foreign-key failure.
// - Each write appends exactly one audit entry (`roles.create`, `roles.update`, `roles.delete`) through its TxCtx;
//   `meta` names keys, permissions and flags, never a description's text.

type Db = Kysely<DB> | Transaction<DB>;

/** A `roles` row as this service reads it. */
interface RoleRow {
  id: string;
  key: string;
  name: string;
  description: string | null;
  is_system: number;
  mfa_required: number;
  version: number;
}

const ROLE_COLUMNS = ['id', 'key', 'name', 'description', 'is_system', 'mfa_required', 'version'] as const;

/** The width of `roles.key` (key191), in characters. */
const KEY_MAX = 191;


/** The catalog keys among `held`, in catalog order (a string outside the catalog is dropped). */
function inCatalogOrder(held: Iterable<string>): Permission[] {
  const set = new Set(held);
  return permissionCatalog()
    .map((def) => def.key)
    .filter((key) => set.has(key));
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const sb = new Set(b);
  return a.length === sb.size && a.every((x) => sb.has(x));
}

/** `''` (after the schema's trim) clears a description, as null does. */
function cleanDescription(d: string | null): string | null {
  return d === null || d === '' ? null : d;
}

function notFound(): DomainError {
  return new DomainError('NOT_FOUND', { detail: 'Peran tidak ditemukan / Role not found' });
}

function readonlySystemRole(key: string): DomainError {
  return new DomainError('ROLE_SYSTEM_READONLY', {
    detail:
      'Peran sistem tidak bisa diubah selain kewajiban 2FA-nya / A system role cannot be changed except for its 2FA requirement',
    meta: { key },
  });
}

/** VALIDATION_FAILED on `name` (decision D10: `{path, code}`, never the value). */
function nameInvalid(code: 'taken' | 'too_big'): DomainError {
  return new DomainError('VALIDATION_FAILED', {
    detail: 'Data yang dikirim tidak valid / The submitted data is not valid',
    meta: { errors: [{ path: 'name', code }] },
  });
}

/** The key of a custom role named `name`. @throws VALIDATION_FAILED `too_big` when NFKC makes it wider than the column */
function keyOf(name: string): string {
  const key = normalizeKey(name);
  if ([...key].length > KEY_MAX) throw nameInvalid('too_big');
  return key;
}

/** @throws VALIDATION_FAILED `{path: 'name', code: 'taken'}` when a role other than `exceptId` has `key` */
async function assertKeyFree(trx: Transaction<DB>, key: string, exceptId: string | null): Promise<void> {
  let q = trx.selectFrom('roles').select('id').where('key', '=', key);
  if (exceptId !== null) q = q.where('id', '!=', exceptId);
  if ((await q.executeTakeFirst()) !== undefined) throw nameInvalid('taken');
}

async function readRole(db: Db, id: string): Promise<RoleRow | undefined> {
  const row = await db.selectFrom('roles').select(ROLE_COLUMNS).where('id', '=', id).executeTakeFirst();
  return row === undefined ? undefined : { ...row, is_system: Number(row.is_system), mfa_required: Number(row.mfa_required), version: Number(row.version) };
}

/** The permissions of a role: computed from the catalog for a system role, its role_permissions rows otherwise. */
async function permissionsOf(db: Db, row: RoleRow): Promise<Permission[]> {
  if (row.is_system === 1) return isSystemRoleKey(row.key) ? [...systemRolePermissions(row.key)] : [];
  const rows = await db.selectFrom('role_permissions').select('permission').where('role_id', '=', row.id).execute();
  return inCatalogOrder(rows.map((r) => r.permission));
}

/** The number of staff users holding role `roleId`, at any scope (one user counts once). */
function countHolders(db: Db, roleId: string): Promise<number> {
  return countRows(
    db.selectFrom('staff_users').where('id', 'in', db.selectFrom('user_roles').select('user_id').where('role_id', '=', roleId)),
  );
}

/** The ids of the staff users holding role `roleId` (each once). */
async function holderIds(trx: Transaction<DB>, roleId: string): Promise<string[]> {
  const rows = await trx.selectFrom('user_roles').select('user_id').where('role_id', '=', roleId).execute();
  return [...new Set(rows.map((r) => r.user_id))];
}

function snapshot(row: RoleRow, permissions: Permission[]): RoleSnapshot {
  return { id: row.id, key: row.key, isSystem: row.is_system === 1, permissions, mfaRequired: row.mfa_required === 1 };
}

function toItem(row: RoleRow, permissions: Permission[], holders: number): RoleItem {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    isSystem: row.is_system === 1,
    mfaRequired: row.mfa_required === 1,
    permissions,
    holders,
    version: row.version,
  };
}

/** The first statement of a write to role `id`: a no-op locking UPDATE of its row (see the top of this file). */
async function lockRole(trx: Transaction<DB>, id: string): Promise<void> {
  await trx
    .updateTable('roles')
    .set((eb) => ({ updated_at: eb.ref('updated_at') }))
    .where('id', '=', id)
    .execute();
}

/**
 * Locks the rows of the roles `ids` (each once, in id order, one statement each so the order is the same on every
 * engine) with lockRole's no-op UPDATE. An assignment takes it before it writes `user_roles` (T20): on PostgreSQL the
 * foreign-key check of that INSERT only takes FOR KEY SHARE on the role, which does not conflict with updateRole's
 * lock, so without this an edit of the role committed meanwhile would miss the new holder and never bump them.
 */
export async function lockRoles(trx: Transaction<DB>, ids: readonly string[]): Promise<void> {
  for (const id of [...new Set(ids)].sort()) await lockRole(trx, id);
}

/** Where the system roles go in a listing: `super_admin`, `admin`, then any other row (custom roles last). */
function rank(row: RoleRow): number {
  if (row.is_system !== 1) return SYSTEM_ROLE_KEYS.length + 1;
  const i = (SYSTEM_ROLE_KEYS as readonly string[]).indexOf(row.key);
  return i < 0 ? SYSTEM_ROLE_KEYS.length : i;
}

/** The permission catalog of the build profile, in its order (`GET permissions`). */
export function listPermissions(): PermissionItem[] {
  return permissionCatalog().map(({ key, scope, module }) => ({ key, scope, module }));
}

/**
 * Every role: the system roles first (`super_admin`, `admin`), then the custom roles by key. The holders are counted
 * per role through countRows (ruling L19; a grouped count cannot go through it): a library has a handful of roles.
 */
export async function listRoles(db: Db): Promise<RoleItem[]> {
  const rows = (await db.selectFrom('roles').select(ROLE_COLUMNS).execute()).map(
    (r): RoleRow => ({ ...r, is_system: Number(r.is_system), mfa_required: Number(r.mfa_required), version: Number(r.version) }),
  );
  rows.sort((a, b) => rank(a) - rank(b) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  // role_permissions holds the custom roles' rows only (a system role's permissions are computed).
  const stored = new Map<string, string[]>();
  for (const r of await db.selectFrom('role_permissions').select(['role_id', 'permission']).execute()) {
    const list = stored.get(r.role_id) ?? [];
    list.push(r.permission);
    stored.set(r.role_id, list);
  }
  const items: RoleItem[] = [];
  for (const row of rows) {
    let permissions: Permission[];
    if (row.is_system === 1) permissions = isSystemRoleKey(row.key) ? [...systemRolePermissions(row.key)] : [];
    else permissions = inCatalogOrder(stored.get(row.id) ?? []);
    items.push(toItem(row, permissions, await countHolders(db, row.id)));
  }
  return items;
}

/** Role `id`. @throws DomainError NOT_FOUND */
export async function getRole(db: Db, id: string): Promise<RoleItem> {
  const row = await readRole(db, id);
  if (row === undefined) throw notFound();
  return toItem(row, await permissionsOf(db, row), await countHolders(db, id));
}

/**
 * Creates a custom role keyed `normalizeKey(body.name)`, by `actor` (rules 1 and 5), in `tx`; audits `roles.create`.
 *
 * @throws DomainError AUTHZ_ESCALATION; VALIDATION_FAILED `{path: 'name', code: 'taken' | 'too_big'}`
 */
export async function createRole(tx: TxCtx, actor: ActorAuthz, body: RoleCreateBody): Promise<RoleItem> {
  const key = keyOf(body.name);
  const permissions = inCatalogOrder(body.permissions);
  const mfaRequired = body.mfaRequired ?? false;
  assertCanWriteRole(actor, null, { key, isSystem: false, permissions, mfaRequired });
  await assertKeyFree(tx.trx, key, null);

  const row: RoleRow = {
    id: newId(),
    key,
    name: body.name,
    description: cleanDescription(body.description ?? null),
    is_system: 0,
    mfa_required: mfaRequired ? 1 : 0,
    version: 0,
  };
  await tx.trx
    .insertInto('roles')
    .values({
      ...row,
      created_at: tx.now,
      created_by: actor.id,
      updated_at: tx.now,
      updated_by: actor.id,
    })
    .execute();
  if (permissions.length > 0) {
    await tx.trx
      .insertInto('role_permissions')
      .values(permissions.map((permission) => ({ role_id: row.id, permission })))
      .execute();
  }
  await tx.audit({ action: 'roles.create', entity: 'roles', entityId: row.id, meta: { key, permissions, mfaRequired } });
  return toItem(row, permissions, 0);
}

/**
 * Changes role `id` as `body` says, by `actor`, in `tx` (call it first in the transaction: it starts with the role's
 * row lock). A system role may change only `mfaRequired`, and a change of `mfaRequired` needs every holder's grants
 * within the actor's (rule 3). When the permissions or `mfaRequired` change, every holder's
 * `authz_version` goes up by one (and their remember-me tokens go). Audits `roles.update` with the changed fields.
 *
 * @throws DomainError NOT_FOUND; CONFLICT_STALE (`body.version` is not the row's); ROLE_SYSTEM_READONLY;
 *   AUTHZ_ESCALATION; VALIDATION_FAILED `{path: 'name', code: 'taken' | 'too_big'}`
 */
export async function updateRole(tx: TxCtx, actor: ActorAuthz, id: string, body: RolePatchBody): Promise<RoleItem> {
  const { trx } = tx;
  await lockRole(trx, id);
  const row = await readRole(trx, id);
  if (row === undefined) throw notFound();
  if (row.version !== body.version) {
    throw new DomainError('CONFLICT_STALE', { detail: 'Peran sudah diubah orang lain / The role was changed by someone else' });
  }
  const system = row.is_system === 1;
  const permissionsBefore = await permissionsOf(trx, row);
  const before = snapshot(row, permissionsBefore);

  const name = body.name ?? row.name;
  const description = body.description === undefined ? row.description : cleanDescription(body.description);
  if (system && (name !== row.name || description !== row.description)) throw readonlySystemRole(row.key);
  const key = system || name === row.name ? row.key : keyOf(name);
  const permissions = body.permissions === undefined ? permissionsBefore : inCatalogOrder(body.permissions);
  const mfaRequired = body.mfaRequired ?? before.mfaRequired;
  assertCanWriteRole(actor, before, { id, key, isSystem: system, permissions, mfaRequired });
  if (mfaRequired !== before.mfaRequired) {
    // Rule 3 for roles.mfa_required: every account the change affects is one the editor may manage.
    for (const holder of await holderIds(trx, id)) {
      assertCanManageUser(actor, { id: holder, grants: await loadGrants(trx, holder) }, { allowSelf: true });
    }
  }
  if (key !== row.key) await assertKeyFree(trx, key, id);

  const updated = await trx
    .updateTable('roles')
    .set((eb) => ({
      key,
      name,
      description,
      mfa_required: mfaRequired ? 1 : 0,
      updated_at: tx.now,
      updated_by: actor.id,
      version: eb('version', '+', 1),
    }))
    .where('id', '=', id)
    .where('version', '=', body.version)
    .executeTakeFirst();
  if (Number(updated.numUpdatedRows) !== 1) {
    throw new DomainError('CONFLICT_STALE', { detail: 'Peran sudah diubah orang lain / The role was changed by someone else' });
  }

  const permissionsChanged = !sameSet(permissions, permissionsBefore);
  if (permissionsChanged && !system) {
    await trx.deleteFrom('role_permissions').where('role_id', '=', id).execute();
    if (permissions.length > 0) {
      await trx
        .insertInto('role_permissions')
        .values(permissions.map((permission) => ({ role_id: id, permission })))
        .execute();
    }
  }
  const mfaChanged = mfaRequired !== before.mfaRequired;
  const holders = await holderIds(trx, id);
  if (permissionsChanged || mfaChanged) await bumpAuthzVersion(trx, holders);

  const changed: string[] = [];
  if (name !== row.name) changed.push('name');
  if (description !== row.description) changed.push('description');
  if (permissionsChanged) changed.push('permissions');
  if (mfaChanged) changed.push('mfaRequired');
  await tx.audit({
    action: 'roles.update',
    entity: 'roles',
    entityId: id,
    meta: {
      key,
      changed,
      added: permissions.filter((p) => !permissionsBefore.includes(p)),
      removed: permissionsBefore.filter((p) => !permissions.includes(p)),
      ...(name === row.name ? {} : { name: { from: row.name, to: name } }),
      ...(mfaChanged ? { mfaRequired: { from: before.mfaRequired, to: mfaRequired } } : {}),
    },
  });
  const after: RoleRow = { ...row, key, name, description, mfa_required: mfaRequired ? 1 : 0, version: row.version + 1 };
  return toItem(after, permissions, holders.length);
}

/**
 * Deletes the custom role `id`, which nobody holds, by `actor` (rule 1: the actor holds all its permissions; rule 5),
 * in `tx` (call it first in the transaction: it starts with the role's row lock). Audits `roles.delete`.
 *
 * @returns the role as it was
 * @throws DomainError NOT_FOUND; ROLE_SYSTEM_READONLY (a system role); ROLE_IN_USE (someone holds it);
 *   AUTHZ_ESCALATION
 */
export async function deleteRole(tx: TxCtx, actor: ActorAuthz, id: string): Promise<RoleItem> {
  const { trx } = tx;
  await lockRole(trx, id);
  const row = await readRole(trx, id);
  if (row === undefined) throw notFound();
  if (row.is_system === 1) throw readonlySystemRole(row.key);
  const holders = await countHolders(trx, id);
  if (holders > 0) {
    throw new DomainError('ROLE_IN_USE', {
      detail: 'Peran masih dipegang pengguna / The role is still assigned to someone',
      meta: { holders },
    });
  }
  const permissions = await permissionsOf(trx, row);
  const before = snapshot(row, permissions);
  assertCanWriteRole(actor, before, before);

  await trx.deleteFrom('role_permissions').where('role_id', '=', id).execute();
  await trx.deleteFrom('roles').where('id', '=', id).execute();
  await tx.audit({ action: 'roles.delete', entity: 'roles', entityId: id, meta: { key: row.key, permissions } });
  return toItem(row, permissions, 0);
}
