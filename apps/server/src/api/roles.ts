import { createRole, deleteRole, getRole, listPermissions, listRoles, updateRole } from '@altis/core';
import {
  RoleCreateBody,
  RoleIdParams,
  RolePatchBody,
  type PermissionListResponse,
  type RoleListResponse,
} from '@altis/shared/api/roles';
import { route, type RouteDecl } from '../http/route.js';
import { actorOf } from './users.js';

// The roles and permissions routes of Task 20 (spec §7.2, §13.5 "Peran", route catalog):
//
// - `permissions.list`, `roles.list`, `roles.get` need `system.users.read` (decision D7: `.manage` implies nothing);
// - `roles.create`, `roles.update`, `roles.delete` need `system.roles.manage` and a reauth within 5 minutes (§7.3),
//   are idempotent (`store`) and audit their own action, written by the core service in the handler transaction. The
//   services run anti-escalation rules 1, 3 and 5 against the session's grants (step 7); update and delete start with
//   the role's row lock, so the handler runs nothing on the transaction before them.

const API = '/api/v1';

/** GET permissions. */
const permissionsList = route({
  id: 'permissions.list',
  method: 'GET',
  path: `${API}/permissions`,
  permission: 'system.users.read',
  idempotency: 'none',
  audit: null,
  handler: async () => {
    const body: PermissionListResponse = { items: listPermissions() };
    return { body };
  },
});

/** GET roles. */
const rolesList = route({
  id: 'roles.list',
  method: 'GET',
  path: `${API}/roles`,
  permission: 'system.users.read',
  idempotency: 'none',
  audit: null,
  handler: async (rc) => {
    const body: RoleListResponse = { items: await listRoles(rc.db.db) };
    return { body };
  },
});

/** GET roles/:id. */
const rolesGet = route({
  id: 'roles.get',
  method: 'GET',
  path: `${API}/roles/:id`,
  permission: 'system.users.read',
  idempotency: 'none',
  audit: null,
  params: RoleIdParams,
  handler: async (rc) => ({ body: await getRole(rc.db.db, rc.params.id) }),
});

/** POST roles. */
const rolesCreate = route({
  id: 'roles.create',
  method: 'POST',
  path: `${API}/roles`,
  permission: 'system.roles.manage',
  reauth: true,
  idempotency: 'store',
  audit: 'roles.create',
  body: RoleCreateBody,
  handler: async (rc) => ({ status: 201, body: await createRole(rc.tx(), actorOf(rc), rc.body) }),
});

/** PATCH roles/:id. */
const rolesUpdate = route({
  id: 'roles.update',
  method: 'PATCH',
  path: `${API}/roles/:id`,
  permission: 'system.roles.manage',
  reauth: true,
  idempotency: 'store',
  audit: 'roles.update',
  params: RoleIdParams,
  body: RolePatchBody,
  handler: async (rc) => ({ body: await updateRole(rc.tx(), actorOf(rc), rc.params.id, rc.body) }),
});

/** DELETE roles/:id. */
const rolesDelete = route({
  id: 'roles.delete',
  method: 'DELETE',
  path: `${API}/roles/:id`,
  permission: 'system.roles.manage',
  reauth: true,
  idempotency: 'store',
  audit: 'roles.delete',
  params: RoleIdParams,
  handler: async (rc) => ({ body: await deleteRole(rc.tx(), actorOf(rc), rc.params.id) }),
});

/** The routes of this file, in the order of the route catalog. */
export const ROLE_ROUTES: RouteDecl[] = [permissionsList, rolesList, rolesGet, rolesCreate, rolesUpdate, rolesDelete];
