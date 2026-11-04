import { countRows, normalizeDbError, type DB } from '@altis/db';
import {
  DomainError,
  isDomainError,
  isLocale,
  isSystemRoleKey,
  newId,
  normalizeKey,
  systemRolePermissions,
  type Permission,
} from '@altis/shared';
import type {
  RoleAssignment,
  UserCreateBody,
  UserDetail,
  UserListItem,
  UserListQuery,
  UserListResponse,
  UserPatchBody,
  UserRoleRef,
  UserStatus,
} from '@altis/shared/api/users';
import { sql, type Expression, type Kysely, type SqlBool, type Transaction } from 'kysely';
import { revokeSubject } from '../auth/sessions.js';
import { assertCanAssign, assertCanManageUser, type ActorAuthz, type RoleSnapshot } from '../authz/escalation.js';
import { bumpAuthzVersion, loadGrants, permissionScope, type Grants } from '../authz/grants.js';
import { guardSuperAdmins } from '../authz/super-admin-guard.js';
import { lockRoles } from '../roles/service.js';
import type { TxCtx } from '../context.js';

// The staff users service (spec §7.1, §7.2, §13.5 "Pengguna"), the domain side of the users routes and of the CLI's
// user commands (Task 24, decision D44).
//
// Who acts: a ServiceActor. A staff user (ActorAuthz: their id and the grants of their request) goes through the
// anti-escalation rules 2-5 of §7.2 (authz/escalation.ts); the CLI actor `{cli: true}` (an operator with shell access to
// the install) skips them, never rule 6 (S26). No function here hashes: the routes hash in `prepare`, before the
// transaction (S18), and pass the PHC string in.
//
// Lock order (controller ruling B4 / decision D14, and the login row lock of Task 15):
// - a transaction that can remove an active super admin (a disable, a role replacement) starts with guardSuperAdmins,
//   whose first statement locks the guard row of `roles`;
// - every write then locks the target's staff_users row (a write, `updated_at = updated_at`) before it reads
//   anything. A login re-reads the account under that same row lock before it creates a session, so a revocation
//   (disable, password or 2FA reset, role change, a 2FA requirement) either commits first, and the login sees it, or
//   waits for the login, and then deletes the session the login created (its DELETEs run after the lock was granted,
//   and on MySQL/MariaDB the transaction's read view starts after it too).
//
// Keys (spec §6.1): username and e-mail are stored as typed (`*_display`) and as normalizeKey (`*_key`, UNIQUE). A
// key that is taken → VALIDATION_FAILED `{path, code: 'taken'}`, a key longer than the 191 code points of its column
// (upper-casing can lengthen the text) → `{path, code: 'too_big'}`, both before any write: never a database error.
//
// Writes bump `version` (the optimistic-concurrency counter PATCH checks) and set `updated_at`/`updated_by`. Each
// write appends exactly one audit entry of its action in the caller's transaction; `meta` never holds a password, a
// hash, a secret or an e-mail address.

/** The operator of the CLI (Task 24): rules 2-5 do not apply to them, rule 6 does. */
export type CliActor = { cli: true };

/** Who calls a users service: a staff user with their grants, or the CLI. */
export type ServiceActor = ActorAuthz | CliActor;

/** What {@link createUser} takes: the validated body with the password already hashed by the route's `prepare`. */
export type CreateUserInput = Omit<UserCreateBody, 'password'> & { passwordHash: string };

type Db = Kysely<DB> | Transaction<DB>;

const STAFF = 'staff';
/** The width of `username_key` and `email_key`, in code points. */
const KEY_MAX = 191;
const DEFAULT_PAGE_SIZE = 25;

const DETAIL_ESCALATION =
  'Perubahan ini memberi atau mengubah hak yang tidak Anda miliki / This change grants or alters rights you do not hold';

interface FieldError {
  path: string;
  code: string;
}

function isCli(actor: ServiceActor): actor is CliActor {
  return (actor as CliActor).cli === true;
}

/** The trail value of `created_by`/`updated_by`: the staff user's id, null for the CLI. */
function trailOf(actor: ServiceActor): string | null {
  return isCli(actor) ? null : actor.id;
}

function validationFailed(errors: FieldError[]): DomainError {
  return new DomainError('VALIDATION_FAILED', {
    detail: 'Data yang dikirim tidak valid / The submitted data is not valid',
    meta: { errors },
  });
}

function notFound(): DomainError {
  return new DomainError('NOT_FOUND', { detail: 'Pengguna tidak ditemukan / User not found' });
}

function escalation(meta: Record<string, unknown>): DomainError {
  return new DomainError('AUTHZ_ESCALATION', { detail: DETAIL_ESCALATION, meta });
}

/** normalizeKey(value), or a `too_big` entry in `errors` (and null) when it does not fit a key column. */
function keyOf(path: 'username' | 'email', value: string, errors: FieldError[]): string | null {
  const key = normalizeKey(value);
  // Code points, as the column counts them (M21); a key of at most KEY_MAX UTF-16 units always fits.
  if (key.length > KEY_MAX && Array.from(key).length > KEY_MAX) {
    errors.push({ path, code: 'too_big' });
    return null;
  }
  return key;
}

/** The VALIDATION_FAILED `taken` a UNIQUE_VIOLATION on a key column stands for (a concurrent insert), or null. */
function takenFrom(error: unknown): DomainError | null {
  const normalized = normalizeDbError(error);
  if (!isDomainError(normalized) || normalized.code !== 'UNIQUE_VIOLATION') return null;
  const constraint = String(normalized.meta?.['constraint'] ?? '');
  if (constraint.includes('username_key')) return validationFailed([{ path: 'username', code: 'taken' }]);
  if (constraint.includes('email_key')) return validationFailed([{ path: 'email', code: 'taken' }]);
  return null;
}

/** Whether another account than `exceptId` holds `key` in `column`. */
async function keyTaken(trx: Transaction<DB>, column: 'username_key' | 'email_key', key: string, exceptId?: string): Promise<boolean> {
  let q = trx.selectFrom('staff_users').select('id').where(column, '=', key);
  if (exceptId !== undefined) q = q.where('id', '<>', exceptId);
  return (await q.executeTakeFirst()) !== undefined;
}

/**
 * The row lock of the target (see the top of this file): a write that changes nothing. Run it before any read of
 * the transaction (after guardSuperAdmins where that applies).
 */
async function lockUser(trx: Transaction<DB>, id: string): Promise<void> {
  await trx
    .updateTable('staff_users')
    .set((eb) => ({ updated_at: eb.ref('updated_at') }))
    .where('id', '=', id)
    .execute();
}

const USER_COLUMNS = [
  'id',
  'username_key',
  'username_display',
  'name',
  'email_key',
  'email_display',
  'status',
  'locale',
  'totp_enabled',
  'mfa_required',
  'must_change_password',
  'last_login_at',
  'version',
  'created_at',
  'updated_at',
] as const;

type UserRow = Awaited<ReturnType<typeof readUser>>;

function readUser(db: Db, id: string) {
  return db.selectFrom('staff_users').select(USER_COLUMNS).where('id', '=', id).executeTakeFirst();
}

/** The user `id`, or NOT_FOUND. */
async function userRow(db: Db, id: string): Promise<NonNullable<UserRow>> {
  const row = await readUser(db, id);
  if (row === undefined) throw notFound();
  return row;
}

/** The role assignments of `userIds`, by user. */
async function rolesOf(db: Db, userIds: readonly string[]): Promise<Map<string, UserRoleRef[]>> {
  const out = new Map<string, UserRoleRef[]>();
  if (userIds.length === 0) return out;
  const rows = await db
    .selectFrom('user_roles as ur')
    .innerJoin('roles as r', 'r.id', 'ur.role_id')
    .select(['ur.user_id', 'ur.role_id', 'ur.branch_id', 'r.key', 'r.name'])
    .where('ur.user_id', 'in', [...userIds])
    .orderBy('r.key')
    .orderBy('ur.scope_key')
    .execute();
  for (const r of rows) {
    const list = out.get(r.user_id) ?? [];
    list.push({ roleId: r.role_id, key: r.key, name: r.name, branchId: r.branch_id });
    out.set(r.user_id, list);
  }
  return out;
}

function listItem(r: NonNullable<UserRow>, roles: UserRoleRef[]): UserListItem {
  return {
    id: r.id,
    username: r.username_display,
    name: r.name,
    email: r.email_display,
    status: r.status as UserStatus,
    totpEnabled: Number(r.totp_enabled) === 1,
    mfaRequired: Number(r.mfa_required) === 1,
    lastLoginAt: r.last_login_at === null ? null : Number(r.last_login_at),
    roles,
  };
}

function detail(r: NonNullable<UserRow>, roles: UserRoleRef[]): UserDetail {
  return {
    ...listItem(r, roles),
    locale: r.locale !== null && isLocale(r.locale) ? r.locale : null,
    mustChangePassword: Number(r.must_change_password) === 1,
    version: Number(r.version),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

/** `s` with the LIKE wildcards (and the escape character `!`) escaped for `LIKE … ESCAPE '!'`. */
function escapeLike(s: string): string {
  return s.replace(/[!%_]/g, (c) => `!${c}`);
}

/**
 * One page of staff users in username order, with the total of the filter. `q` is a substring of the username key,
 * the e-mail key or the upper-cased name (normalizeKey(q); LIKE wildcards in it are literal). Upper-casing the name
 * is done by the database: every engine folds ASCII, not every one folds other letters.
 */
export async function listUsers(db: Db, q: UserListQuery): Promise<UserListResponse> {
  const page = q.page ?? 1;
  const pageSize = q.pageSize ?? DEFAULT_PAGE_SIZE;
  let base = db.selectFrom('staff_users');
  if (q.status !== undefined) base = base.where('status', '=', q.status);
  const needle = q.q === undefined ? '' : normalizeKey(q.q);
  if (needle !== '') {
    const pattern = `%${escapeLike(needle)}%`;
    const like = (e: Expression<string | null>) => sql<SqlBool>`${e} like ${pattern} escape '!'`;
    base = base.where((eb) =>
      eb.or([like(eb.ref('username_key')), like(eb.ref('email_key')), like(eb.fn<string>('upper', [eb.ref('name')]))]),
    );
  }
  const total = await countRows(base);
  const rows = await base
    .select(USER_COLUMNS)
    .orderBy('username_key')
    .orderBy('id')
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .execute();
  const roles = await rolesOf(db, rows.map((r) => r.id));
  return { items: rows.map((r) => listItem(r, roles.get(r.id) ?? [])), total, page, pageSize };
}

/**
 * The staff user `id` with their role assignments.
 * @throws DomainError NOT_FOUND
 */
export async function getUser(db: Db, id: string): Promise<UserDetail> {
  const row = await userRow(db, id);
  return detail(row, (await rolesOf(db, [id])).get(id) ?? []);
}

/**
 * Creates a staff user without roles, `active`, with `must_change_password` unless the body says false; audits
 * `users.create` (`meta.username`).
 *
 * @throws DomainError VALIDATION_FAILED (`username`/`email`: `taken`, `too_big`)
 */
export async function createUser(tx: TxCtx, actor: ServiceActor, body: CreateUserInput): Promise<UserDetail> {
  const { trx, now } = tx;
  const errors: FieldError[] = [];
  const usernameKey = keyOf('username', body.username, errors);
  const email = body.email ?? null;
  const emailKey = email === null ? null : keyOf('email', email, errors);
  if (usernameKey !== null && (await keyTaken(trx, 'username_key', usernameKey))) errors.push({ path: 'username', code: 'taken' });
  if (emailKey !== null && (await keyTaken(trx, 'email_key', emailKey))) errors.push({ path: 'email', code: 'taken' });
  if (errors.length > 0 || usernameKey === null) throw validationFailed(errors);

  const id = newId();
  const trail = trailOf(actor);
  try {
    await trx
      .insertInto('staff_users')
      .values({
        id,
        username_key: usernameKey,
        username_display: body.username,
        name: body.name,
        email_key: emailKey,
        email_display: email,
        password_hash: body.passwordHash,
        status: 'active',
        locale: body.locale ?? null,
        mfa_required: body.mfaRequired === true ? 1 : 0,
        must_change_password: body.mustChangePassword === false ? 0 : 1,
        created_at: now,
        created_by: trail,
        updated_at: now,
        updated_by: trail,
      })
      .execute();
  } catch (error) {
    throw takenFrom(error) ?? error;
  }
  await tx.audit({ action: 'users.create', entity: 'staff_users', entityId: id, meta: { username: body.username } });
  return getUser(trx, id);
}

/**
 * Changes the fields `body` names of the user `id` and audits `users.update` (`meta.fields`: the names of the fields
 * that changed). An e-mail change deletes the user's password-reset tokens (§7.1); `mfaRequired: true` revokes their
 * remember-me tokens without 2FA and the sessions carrying them (§7.1: "dicabut ... begitu 2FA ... diwajibkan").
 *
 * - someone else: rule 3 (their grants ⊆ the actor's);
 * - oneself: everything but `mfaRequired` (D24: AUTHZ_ESCALATION when the body carries it).
 *
 * @throws DomainError NOT_FOUND, CONFLICT_STALE (a `version` other than the row's), AUTHZ_ESCALATION,
 *   VALIDATION_FAILED (`username`/`email`: `taken`, `too_big`)
 */
export async function updateUser(tx: TxCtx, actor: ServiceActor, id: string, body: UserPatchBody): Promise<UserDetail> {
  const { trx, now } = tx;
  await lockUser(trx, id);
  const row = await userRow(trx, id);
  if (Number(row.version) !== body.version) {
    throw new DomainError('CONFLICT_STALE', {
      detail: 'Data pengguna sudah diubah orang lain; muat ulang / The user was changed meanwhile; reload',
    });
  }
  if (!isCli(actor)) {
    if (actor.id === id) {
      if (body.mfaRequired !== undefined) assertCanManageUser(actor, { id, grants: actor.grants }, { allowSelf: false });
    } else {
      assertCanManageUser(actor, { id, grants: await loadGrants(trx, id) }, { allowSelf: true });
    }
  }

  const errors: FieldError[] = [];
  const changed: string[] = [];
  const set: {
    username_key?: string;
    username_display?: string;
    name?: string;
    email_key?: string | null;
    email_display?: string | null;
    locale?: string | null;
    mfa_required?: 0 | 1;
  } = {};
  if (body.username !== undefined) {
    const key = keyOf('username', body.username, errors);
    if (key !== null && key !== row.username_key && (await keyTaken(trx, 'username_key', key, id))) {
      errors.push({ path: 'username', code: 'taken' });
    }
    if (key !== null) {
      set.username_key = key;
      set.username_display = body.username;
    }
    if (body.username !== row.username_display) changed.push('username');
  }
  if (body.name !== undefined) {
    set.name = body.name;
    if (body.name !== row.name) changed.push('name');
  }
  let emailChanged = false;
  if (body.email !== undefined) {
    const key = body.email === null ? null : keyOf('email', body.email, errors);
    if (key !== null && key !== row.email_key && (await keyTaken(trx, 'email_key', key, id))) {
      errors.push({ path: 'email', code: 'taken' });
    }
    set.email_key = key;
    set.email_display = body.email;
    emailChanged = key !== row.email_key;
    if (body.email !== row.email_display) changed.push('email');
  }
  if (body.locale !== undefined) {
    set.locale = body.locale;
    if (body.locale !== row.locale) changed.push('locale');
  }
  if (body.mfaRequired !== undefined) {
    set.mfa_required = body.mfaRequired ? 1 : 0;
    if (body.mfaRequired !== (Number(row.mfa_required) === 1)) changed.push('mfaRequired');
  }
  if (errors.length > 0) throw validationFailed(errors);

  try {
    await trx
      .updateTable('staff_users')
      .set({ ...set, version: Number(row.version) + 1, updated_at: now, updated_by: trailOf(actor) })
      .where('id', '=', id)
      .execute();
  } catch (error) {
    throw takenFrom(error) ?? error;
  }
  if (emailChanged) {
    await trx.deleteFrom('password_resets').where('subject_type', '=', STAFF).where('subject_id', '=', id).execute();
  }
  if (body.mfaRequired === true) await revokeSubject(trx, id, { rememberOnly: 'mfa_unbound' });
  await tx.audit({ action: 'users.update', entity: 'staff_users', entityId: id, meta: { fields: changed } });
  return getUser(trx, id);
}

/**
 * Enables (`active`, also from `locked`) or disables the user `id` and audits `users.enable` / `users.disable`.
 * Disabling revokes every session and remember-me token of the user, and runs under guardSuperAdmins as the first
 * statement of the transaction (rule 6, B4). Enabling a user who was not `active` revokes them too (§7.1
 * Pencabutan): a session or a 30-day remember-me token issued before the account was taken out of use never comes
 * back with it. Rules 3 and 4 (D24): not oneself.
 *
 * @throws DomainError NOT_FOUND, AUTHZ_ESCALATION, LAST_SUPER_ADMIN
 */
export async function setUserStatus(
  tx: TxCtx,
  actor: ServiceActor,
  id: string,
  status: 'active' | 'disabled',
): Promise<UserDetail> {
  const { trx, now } = tx;
  const change = async (): Promise<void> => {
    await lockUser(trx, id);
    const row = await userRow(trx, id);
    if (!isCli(actor)) assertCanManageUser(actor, { id, grants: await loadGrants(trx, id) }, { allowSelf: false });
    await trx
      .updateTable('staff_users')
      .set({ status, version: Number(row.version) + 1, updated_at: now, updated_by: trailOf(actor) })
      .where('id', '=', id)
      .execute();
    if (status === 'disabled' || row.status !== 'active') await revokeSubject(trx, id);
    await tx.audit({ action: status === 'disabled' ? 'users.disable' : 'users.enable', entity: 'staff_users', entityId: id });
  };
  if (status === 'disabled') await guardSuperAdmins(trx, change);
  else await change();
  return getUser(trx, id);
}

/**
 * Sets the password of the user `id` to `o.passwordHash` (the hash the route's `prepare` made of a new
 * temporaryPassword(); exempt from `security.password_min_length`, M9) with `must_change_password = 1`, revokes
 * every session and remember-me token of the user, deletes their password-reset tokens, and audits
 * `users.password.reset` (`meta` empty: never the password). Rules 3 and 4: not oneself.
 *
 * @throws DomainError NOT_FOUND, AUTHZ_ESCALATION
 */
export async function adminResetPassword(tx: TxCtx, actor: ServiceActor, id: string, o: { passwordHash: string }): Promise<void> {
  const { trx, now } = tx;
  await lockUser(trx, id);
  const row = await userRow(trx, id);
  if (!isCli(actor)) assertCanManageUser(actor, { id, grants: await loadGrants(trx, id) }, { allowSelf: false });
  await trx
    .updateTable('staff_users')
    .set({
      password_hash: o.passwordHash,
      must_change_password: 1,
      version: Number(row.version) + 1,
      updated_at: now,
      updated_by: trailOf(actor),
    })
    .where('id', '=', id)
    .execute();
  await revokeSubject(trx, id);
  await trx.deleteFrom('password_resets').where('subject_type', '=', STAFF).where('subject_id', '=', id).execute();
  await tx.audit({ action: 'users.password.reset', entity: 'staff_users', entityId: id });
}

/**
 * Removes the 2FA of the user `id` (§7.1 "Reset 2FA oleh admin"): no TOTP secret, `totp_enabled = 0`,
 * `totp_reenroll = 0`, the replay step back to 0, the recovery codes deleted, every session and remember-me token
 * revoked; audits `users.2fa.reset`. When 2FA is still required (the user's flag or a role) the next login enrols
 * again (`mfa_setup`). Rules 3 and 4: not oneself.
 *
 * @throws DomainError NOT_FOUND, AUTHZ_ESCALATION
 */
export async function adminResetTotp(tx: TxCtx, actor: ServiceActor, id: string): Promise<void> {
  const { trx, now } = tx;
  await lockUser(trx, id);
  const row = await userRow(trx, id);
  if (!isCli(actor)) assertCanManageUser(actor, { id, grants: await loadGrants(trx, id) }, { allowSelf: false });
  await trx
    .updateTable('staff_users')
    .set({
      totp_secret_enc: null,
      totp_enabled: 0,
      totp_reenroll: 0,
      totp_last_step: 0,
      version: Number(row.version) + 1,
      updated_at: now,
      updated_by: trailOf(actor),
    })
    .where('id', '=', id)
    .execute();
  await trx.deleteFrom('staff_recovery_codes').where('user_id', '=', id).execute();
  await revokeSubject(trx, id);
  await tx.audit({ action: 'users.2fa.reset', entity: 'staff_users', entityId: id });
}


/** The roles `ids` as the anti-escalation checks see them (a system role's permissions from the catalog), by id. */
async function roleSnapshots(trx: Transaction<DB>, ids: readonly string[]): Promise<Map<string, RoleSnapshot>> {
  const out = new Map<string, RoleSnapshot>();
  if (ids.length === 0) return out;
  const rows = await trx.selectFrom('roles').select(['id', 'key', 'is_system', 'mfa_required']).where('id', 'in', [...ids]).execute();
  const customIds = rows.filter((r) => Number(r.is_system) !== 1).map((r) => r.id);
  const custom = new Map<string, Permission[]>();
  if (customIds.length > 0) {
    const perms = await trx.selectFrom('role_permissions').select(['role_id', 'permission']).where('role_id', 'in', customIds).execute();
    for (const p of perms) {
      if (permissionScope(p.permission) === undefined) continue;
      const list = custom.get(p.role_id) ?? [];
      list.push(p.permission as Permission);
      custom.set(p.role_id, list);
    }
  }
  for (const r of rows) {
    const isSystem = Number(r.is_system) === 1;
    const permissions = isSystem ? (isSystemRoleKey(r.key) ? [...systemRolePermissions(r.key)] : []) : (custom.get(r.id) ?? []);
    out.set(r.id, { id: r.id, key: r.key, isSystem, permissions, mfaRequired: Number(r.mfa_required) === 1 });
  }
  return out;
}

/** ROLE_SCOPE_INVALID unless every permission of `role` may be held at a branch (for the CLI, which skips rules 2-5). */
function assertBranchScope(role: RoleSnapshot, branchId: string | null): void {
  if (branchId === null) return;
  for (const p of role.permissions) {
    if (permissionScope(p) !== 'branch') {
      throw new DomainError('ROLE_SCOPE_INVALID', {
        detail:
          'Peran dengan izin global hanya bisa ditugaskan secara global / A role with global permissions can only be assigned globally',
        meta: { permission: p },
      });
    }
  }
}

/** The (role, scope) identity of an assignment. */
function pairKey(roleId: string, branchId: string | null): string {
  return `${roleId}:${branchId ?? ''}`;
}

/**
 * Replaces the role assignments of the user `id` with `assignments` (a repeated pair counts once) and audits
 * `users.roles.update` with `meta {added, removed}` (`{role: <key>, branchId}` each):
 *
 * - with `o.onlyBranch` (the test route) only the user's assignments at that branch are considered, and a requested
 *   pair at another scope, global included, is AUTHZ_ESCALATION before any other check (S14);
 * - rule 4 first: never one's own;
 * - under guardSuperAdmins as the first statement of the transaction (rule 6, B4); then the locks of the requested
 *   roles (lockRoles, in id order: an edit of one of them committed meanwhile then sees this user as a holder and
 *   bumps them, T20), then the user's row lock. The order super_admin → roles → user matches updateRole's role →
 *   holders;
 * - rule 3 for the account (its grants ⊆ the actor's), even for a list that changes nothing;
 * - an unknown role or branch → VALIDATION_FAILED `{path: 'assignments.<i>.roleId' | '….branchId', code:
 *   'not_found'}`, an added pair at an archived branch → `code: 'archived'` (a kept one stays);
 * - every added and every removed pair through assertCanAssign (rules 2, 3, 5, ROLE_SCOPE_INVALID);
 * - a removal revokes every session and remember-me token of the user (§7.1); any change bumps their
 *   `authz_version` (bumpAuthzVersion, which deletes their remember-me tokens too, B9).
 *
 * @throws DomainError NOT_FOUND, AUTHZ_ESCALATION, ROLE_SCOPE_INVALID, VALIDATION_FAILED, LAST_SUPER_ADMIN
 */
export async function replaceUserRoles(
  tx: TxCtx,
  actor: ServiceActor,
  id: string,
  assignments: readonly RoleAssignment[],
  o: { onlyBranch?: string } = {},
): Promise<UserDetail> {
  const { trx, now } = tx;
  const only = o.onlyBranch;
  if (only !== undefined) {
    for (const a of assignments) if (a.branchId !== only) throw escalation({ rule: 2, branchId: a.branchId, onlyBranch: only });
  }
  if (!isCli(actor) && actor.id === id) throw escalation({ rule: 4 });

  await guardSuperAdmins(trx, async () => {
    await lockRoles(trx, assignments.map((a) => a.roleId));
    await lockUser(trx, id);
    await userRow(trx, id);
    let target: { id: string; grants: Grants } | null = null;
    if (!isCli(actor)) {
      // Rule 3 for the account as a whole, even when nothing changes (assertCanAssign asks it again per pair).
      target = { id, grants: await loadGrants(trx, id) };
      assertCanManageUser(actor, target, { allowSelf: false });
    }
    let currentQuery = trx.selectFrom('user_roles').select(['id', 'role_id', 'branch_id']).where('user_id', '=', id);
    if (only !== undefined) currentQuery = currentQuery.where('scope_key', '=', only);
    const current = await currentQuery.execute();

    const roles = await roleSnapshots(trx, [...new Set([...assignments.map((a) => a.roleId), ...current.map((c) => c.role_id)])]);
    const branchIds = [...new Set(assignments.map((a) => a.branchId).filter((b): b is string => b !== null))];
    const branches = new Map<string, boolean>();
    if (branchIds.length > 0) {
      const rows = await trx.selectFrom('branches').select(['id', 'archived_at']).where('id', 'in', branchIds).execute();
      for (const b of rows) branches.set(b.id, b.archived_at !== null);
    }

    const held = new Set(current.map((c) => pairKey(c.role_id, c.branch_id)));
    const wanted = new Set<string>();
    const added: { role: RoleSnapshot; branchId: string | null }[] = [];
    const errors: FieldError[] = [];
    assignments.forEach((a, i) => {
      const pair = pairKey(a.roleId, a.branchId);
      if (wanted.has(pair)) return;
      wanted.add(pair);
      const role = roles.get(a.roleId);
      if (role === undefined) errors.push({ path: `assignments.${i}.roleId`, code: 'not_found' });
      if (a.branchId !== null) {
        const archived = branches.get(a.branchId);
        if (archived === undefined) errors.push({ path: `assignments.${i}.branchId`, code: 'not_found' });
        else if (archived && !held.has(pair)) errors.push({ path: `assignments.${i}.branchId`, code: 'archived' });
      }
      if (role !== undefined && !held.has(pair)) added.push({ role, branchId: a.branchId });
    });
    if (errors.length > 0) throw validationFailed(errors);
    const removed = current
      .filter((c) => !wanted.has(pairKey(c.role_id, c.branch_id)))
      .map((c) => ({ rowId: c.id, role: roles.get(c.role_id)!, branchId: c.branch_id }));

    if (isCli(actor) || target === null) {
      for (const a of added) assertBranchScope(a.role, a.branchId);
    } else {
      for (const a of added) assertCanAssign(actor, target, { role: a.role, branchId: a.branchId, op: 'add' });
      for (const r of removed) assertCanAssign(actor, target, { role: r.role, branchId: r.branchId, op: 'remove' });
    }

    if (removed.length > 0) {
      await trx
        .deleteFrom('user_roles')
        .where(
          'id',
          'in',
          removed.map((r) => r.rowId),
        )
        .execute();
    }
    if (added.length > 0) {
      await trx
        .insertInto('user_roles')
        .values(
          added.map((a) => ({
            id: newId(),
            user_id: id,
            role_id: a.role.id!,
            branch_id: a.branchId,
            scope_key: a.branchId ?? '',
            created_at: now,
            created_by: trailOf(actor),
          })),
        )
        .execute();
    }
    if (removed.length > 0) await revokeSubject(trx, id);
    if (added.length > 0 || removed.length > 0) await bumpAuthzVersion(trx, [id]);
    await tx.audit({
      action: 'users.roles.update',
      entity: 'staff_users',
      entityId: id,
      meta: {
        added: added.map((a) => ({ role: a.role.key, branchId: a.branchId })),
        removed: removed.map((r) => ({ role: r.role.key, branchId: r.branchId })),
      },
    });
  });
  return getUser(trx, id);
}
