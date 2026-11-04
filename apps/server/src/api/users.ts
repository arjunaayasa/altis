import {
  adminResetPassword,
  adminResetTotp,
  checkPasswordPolicy,
  createUser,
  getUser,
  listUsers,
  replaceUserRoles,
  setUserStatus,
  temporaryPassword,
  updateUser,
  type ActorAuthz,
} from '@altis/core';
import { ulidField } from '@altis/shared/api/common';
import {
  UserCreateBody,
  UserListQuery,
  UserPatchBody,
  UserRolesBody,
  type TemporaryPasswordResponse,
} from '@altis/shared/api/users';
import { z } from 'zod';
import { route, type RouteContext, type RouteDecl } from '../http/route.js';

// The users routes of Task 19 (spec §7.1-7.3, §13.5 "Pengguna", route catalog): HTTP only, the rules live in core's
// users service (D1).
//
// - Reading needs `system.users.read`, every write `system.users.manage` (D7: `.manage` does not imply `.read`).
// - `users.create` and `users.password.reset` hash in `prepare`, outside any transaction (S18): the first checks the
//   password policy (`security.password_min_length`) and hashes the body's password, the second hashes a new
//   temporaryPassword(), which the route answers once (idempotency `none`, `Cache-Control: no-store`). A temporary
//   password skips the minimum-length setting (80 random bits, changed at the next login; M9).
// - Every write runs in the handler transaction (`rc.tx()`, whose audits count for the audit-once check), with the
//   request's staff user and grants as the actor, and answers the resulting UserDetail (201 for a create).
// - Disable, the resets and the role replacement need a re-authentication within 5 minutes (§7.3).
// - 1d Task 19 (D36/M32): `users.disable` and `users.roles.put` are `system` routes (route mode, http/edition-gate.ts):
//   revoking access is a security action an edition's gate must never refuse.

const USERS = '/api/v1/users';

const IdParams = z.strictObject({ id: ulidField });

/** The acting staff user and the grants of this request (step 7). */
export function actorOf(rc: RouteContext<unknown, unknown, unknown>): ActorAuthz {
  const auth = rc.auth;
  // Unreachable: every route here declares a permission, which step 9 refuses without a session.
  if (auth === null) throw new TypeError('users routes run with a session');
  return { id: auth.subjectId, grants: auth.grants };
}

/** GET users. */
const usersList = route({
  id: 'users.list',
  method: 'GET',
  path: USERS,
  permission: 'system.users.read',
  idempotency: 'none',
  audit: null,
  query: UserListQuery,
  handler: async (rc) => ({ body: await listUsers(rc.db.db, rc.query) }),
});

/** GET users/:id. */
const usersGet = route({
  id: 'users.get',
  method: 'GET',
  path: `${USERS}/:id`,
  permission: 'system.users.read',
  idempotency: 'none',
  audit: null,
  params: IdParams,
  handler: async (rc) => ({ body: await getUser(rc.db.db, rc.params.id) }),
});

/** POST users. */
const usersCreate = route({
  id: 'users.create',
  method: 'POST',
  path: USERS,
  permission: 'system.users.manage',
  idempotency: 'store',
  audit: 'users.create',
  body: UserCreateBody,
  prepare: async (rc) => {
    const minLength = await rc.services.settings.get<number>(rc.db.db, 'security.password_min_length');
    checkPasswordPolicy(rc.body.password, { minLength });
    return rc.services.hasher.hash(rc.body.password);
  },
  handler: async (rc) => {
    // Everything but the password: the service only ever sees its hash.
    const { username, name, email, locale, mfaRequired, mustChangePassword } = rc.body;
    const user = await createUser(rc.tx(), actorOf(rc), {
      username,
      name,
      email,
      locale,
      mfaRequired,
      mustChangePassword,
      passwordHash: rc.prepared as string,
    });
    return { status: 201, body: user };
  },
});

/** PATCH users/:id. */
const usersUpdate = route({
  id: 'users.update',
  method: 'PATCH',
  path: `${USERS}/:id`,
  permission: 'system.users.manage',
  idempotency: 'store',
  audit: 'users.update',
  params: IdParams,
  body: UserPatchBody,
  handler: async (rc) => ({ body: await updateUser(rc.tx(), actorOf(rc), rc.params.id, rc.body) }),
});

/** POST users/:id/disable. */
const usersDisable = route({
  id: 'users.disable',
  method: 'POST',
  path: `${USERS}/:id/disable`,
  permission: 'system.users.manage',
  reauth: true,
  mode: 'system',
  idempotency: 'store',
  audit: 'users.disable',
  params: IdParams,
  handler: async (rc) => ({ body: await setUserStatus(rc.tx(), actorOf(rc), rc.params.id, 'disabled') }),
});

/** POST users/:id/enable. */
const usersEnable = route({
  id: 'users.enable',
  method: 'POST',
  path: `${USERS}/:id/enable`,
  permission: 'system.users.manage',
  idempotency: 'store',
  audit: 'users.enable',
  params: IdParams,
  handler: async (rc) => ({ body: await setUserStatus(rc.tx(), actorOf(rc), rc.params.id, 'active') }),
});

/** POST users/:id/reset-password. */
const usersPasswordReset = route({
  id: 'users.password.reset',
  method: 'POST',
  path: `${USERS}/:id/reset-password`,
  permission: 'system.users.manage',
  reauth: true,
  idempotency: 'none',
  audit: 'users.password.reset',
  params: IdParams,
  prepare: async (rc) => {
    const password = temporaryPassword();
    return { password, hash: await rc.services.hasher.hash(password) };
  },
  handler: async (rc) => {
    const prepared = rc.prepared as { password: string; hash: string };
    await adminResetPassword(rc.tx(), actorOf(rc), rc.params.id, { passwordHash: prepared.hash });
    const body: TemporaryPasswordResponse = { temporaryPassword: prepared.password };
    return { body, headers: { 'Cache-Control': 'no-store' } };
  },
});

/** POST users/:id/reset-2fa. */
const users2faReset = route({
  id: 'users.2fa.reset',
  method: 'POST',
  path: `${USERS}/:id/reset-2fa`,
  permission: 'system.users.manage',
  reauth: true,
  idempotency: 'none',
  audit: 'users.2fa.reset',
  params: IdParams,
  handler: async (rc) => {
    const tx = rc.tx();
    await adminResetTotp(tx, actorOf(rc), rc.params.id);
    return { body: await getUser(tx.trx, rc.params.id) };
  },
});

/** PUT users/:id/roles. A `system` route (D36/M32): revoking roles is a security action. */
const usersRolesPut = route({
  id: 'users.roles.put',
  method: 'PUT',
  path: `${USERS}/:id/roles`,
  permission: 'system.users.manage',
  reauth: true,
  mode: 'system',
  idempotency: 'store',
  audit: 'users.roles.update',
  params: IdParams,
  body: UserRolesBody,
  handler: async (rc) => ({ body: await replaceUserRoles(rc.tx(), actorOf(rc), rc.params.id, rc.body.assignments) }),
});

/** The routes of this file, in the order of the route catalog. */
export const USERS_ROUTES: RouteDecl[] = [
  usersList,
  usersGet,
  usersCreate,
  usersUpdate,
  usersDisable,
  usersEnable,
  usersPasswordReset,
  users2faReset,
  usersRolesPut,
];
