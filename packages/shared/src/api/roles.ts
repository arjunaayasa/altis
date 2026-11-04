/**
 * The roles and permissions API vocabulary shared by the server and the admin SPA (spec §7.2, §13.5 "Peran",
 * decision D35). No Node built-ins here: the browser bundles this module. Import it as `@altis/shared/api/roles`.
 *
 * - A custom role's key is `normalizeKey(name)` (decision D25), so two names that differ only in case, width or
 *   spacing are the same role; the server answers a taken key with VALIDATION_FAILED `{path: 'name', code: 'taken'}`.
 * - The system roles `super_admin` and `admin` are read-only but for `mfaRequired`; their permissions are computed
 *   from the catalog (decision D5) and listed as such.
 */
import { z } from 'zod';
import { permissionCatalog, type Permission, type PermissionScope } from '../permissions.js';
import { ulidField, versionField } from './common.js';

/** At most this many permissions in one role (the catalog has far fewer; this bounds the body). */
export const ROLE_PERMISSIONS_MAX = 100;

/** A key of the permission catalog of this build profile (`test.branch.manage` only under the test profile). */
export const permissionField = z.enum(permissionCatalog().map((def) => def.key) as [Permission, ...Permission[]]);

/** 1-100 characters, trimmed, with no control character (C0, DEL, C1). */
export const roleNameField = z.string().trim().min(1).max(100).regex(/^\P{Cc}*$/u);

/** At most 1000 characters, trimmed; null (or an empty text) clears it. */
export const roleDescriptionField = z.string().trim().max(1000).nullable();

/** Distinct catalog keys, at most {@link ROLE_PERMISSIONS_MAX}. */
export const rolePermissionsField = z
  .array(permissionField)
  .max(ROLE_PERMISSIONS_MAX)
  .refine((list) => new Set(list).size === list.length, { message: 'duplicate permission' });

/** The `:id` of `roles/:id`. */
export const RoleIdParams = z.strictObject({ id: ulidField });

export type RoleIdParams = z.infer<typeof RoleIdParams>;

/** `POST roles`. */
export const RoleCreateBody = z.strictObject({
  name: roleNameField,
  description: roleDescriptionField.optional(),
  permissions: rolePermissionsField,
  mfaRequired: z.boolean().optional(),
});

export type RoleCreateBody = z.infer<typeof RoleCreateBody>;

/** `PATCH roles/:id`: the role's current `version`, and the fields to change. */
export const RolePatchBody = z.strictObject({
  version: versionField,
  name: roleNameField.optional(),
  description: roleDescriptionField.optional(),
  permissions: rolePermissionsField.optional(),
  mfaRequired: z.boolean().optional(),
});

export type RolePatchBody = z.infer<typeof RolePatchBody>;

/** One role as the API shows it. */
export interface RoleItem {
  id: string;
  /** `super_admin`, `admin`, or the normalized name of a custom role. */
  key: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  /** Every holder must use 2FA ("2FA wajib per peran"). */
  mfaRequired: boolean;
  /** In catalog order; for a system role, computed from the catalog. */
  permissions: Permission[];
  /** The number of staff users holding the role (at any scope; one user counts once). */
  holders: number;
  /** The optimistic-concurrency counter a PATCH must send back. */
  version: number;
}

/** One entry of the permission catalog as the API shows it. */
export interface PermissionItem {
  key: Permission;
  scope: PermissionScope;
  /** The module the permission belongs to (`system`; `test` under the test profile). */
  module: string;
}

/** `GET permissions`: the catalog, in its order. */
export interface PermissionListResponse {
  items: PermissionItem[];
}

/** `GET roles`: the system roles first (`super_admin`, `admin`), then the custom roles by key. */
export interface RoleListResponse {
  items: RoleItem[];
}
