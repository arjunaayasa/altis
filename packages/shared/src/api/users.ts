/**
 * The users API vocabulary shared by the server and the admin SPA (spec §7.1, §7.2, §13.5 "Pengguna"). No Node
 * built-ins here: the browser bundles this module. Import it as `@altis/shared/api/users`.
 *
 * The maximum lengths are the column widths (L36). A username or e-mail that passes these schemas can still be
 * refused by the service (VALIDATION_FAILED): when the key it normalizes to is taken (`taken`), or longer than the
 * 191 code points of its `*_key` column (`too_big`: upper-casing can lengthen it, 64 × U+0390 becomes 192).
 */
import { z } from 'zod';
import type { Locale } from '../i18n/index.js';
import { emailField, localeField, passwordField, personNameField, ulidField, usernameField, versionField } from './common.js';

/** The states of a staff account; no 1b route sets `locked` (decision D23), enabling clears it. */
export const USER_STATUSES = Object.freeze(['active', 'disabled', 'locked'] as const);

export type UserStatus = (typeof USER_STATUSES)[number];

/** The most role assignments one request sets. */
export const MAX_ROLE_ASSIGNMENTS = 50;

/**
 * `GET users`. Query values arrive as text and are coerced (M5). `q` matches the username, the name or the e-mail
 * address (a substring, compared on the normalized key: case and full-width forms do not matter); `page` counts
 * from 1, `pageSize` is 10-100 (default 25).
 */
export const UserListQuery = z.strictObject({
  q: z.string().max(64).optional(),
  status: z.enum(USER_STATUSES).optional(),
  page: z.coerce.number().int().min(1).max(1_000_000).optional(),
  pageSize: z.coerce.number().int().min(10).max(100).optional(),
});

export type UserListQuery = z.infer<typeof UserListQuery>;

/**
 * `POST users`. `mustChangePassword` defaults to true (a password the admin chose is changed at the first login);
 * the password goes through the policy of `security.password_min_length` on the server.
 */
export const UserCreateBody = z.strictObject({
  username: usernameField,
  name: personNameField,
  email: emailField.nullable().optional(),
  password: passwordField,
  locale: localeField.nullable().optional(),
  mfaRequired: z.boolean().optional(),
  mustChangePassword: z.boolean().optional(),
});

export type UserCreateBody = z.infer<typeof UserCreateBody>;

/**
 * `PATCH users/:id`: `version` is the one the client read (CONFLICT_STALE otherwise); a field left out stays, `null`
 * clears `email` or `locale`. A user editing themselves leaves `mfaRequired` out (D24: AUTHZ_ESCALATION).
 */
export const UserPatchBody = z.strictObject({
  version: versionField,
  username: usernameField.optional(),
  name: personNameField.optional(),
  email: emailField.nullable().optional(),
  locale: localeField.nullable().optional(),
  mfaRequired: z.boolean().optional(),
});

export type UserPatchBody = z.infer<typeof UserPatchBody>;

/** One role assignment: a role, globally (`branchId: null`) or at one branch. */
export const RoleAssignment = z.strictObject({
  roleId: ulidField,
  branchId: ulidField.nullable(),
});

export type RoleAssignment = z.infer<typeof RoleAssignment>;

/** At most {@link MAX_ROLE_ASSIGNMENTS}, each (role, branch) pair once (a repeat is a `custom` issue at its index). */
const assignmentList = z
  .array(RoleAssignment)
  .max(MAX_ROLE_ASSIGNMENTS)
  .superRefine((list, ctx) => {
    const seen = new Set<string>();
    list.forEach((a, i) => {
      const pair = `${a.roleId}:${a.branchId ?? ''}`;
      if (seen.has(pair)) ctx.addIssue({ code: 'custom', path: [i], message: 'duplicate' });
      seen.add(pair);
    });
  });

/** `PUT users/:id/roles`: the user's complete list of assignments afterwards. */
export const UserRolesBody = z.strictObject({
  assignments: assignmentList,
});

export type UserRolesBody = z.infer<typeof UserRolesBody>;

/**
 * The test-profile route `PUT _test/branches/:branchId/user-roles` (S14, M18): the user's assignments at that branch
 * afterwards; their other assignments stay. A pair at another scope (global included) is AUTHZ_ESCALATION.
 */
export const BranchUserRolesBody = z.strictObject({
  userId: ulidField,
  assignments: assignmentList,
});

export type BranchUserRolesBody = z.infer<typeof BranchUserRolesBody>;

/** A role assignment as the users API shows it. */
export interface UserRoleRef {
  roleId: string;
  /** `super_admin`, `admin`, or a custom role's key. */
  key: string;
  name: string;
  /** null: global. */
  branchId: string | null;
}

/** A staff user in the list. `mfaRequired` is the user's own flag (a role may require 2FA too). */
export interface UserListItem {
  id: string;
  username: string;
  name: string;
  email: string | null;
  status: UserStatus;
  totpEnabled: boolean;
  mfaRequired: boolean;
  /** Epoch ms of the last completed login, or null. */
  lastLoginAt: number | null;
  /** By role key, then branch (global first). */
  roles: UserRoleRef[];
}

/** A staff user as `GET users/:id` and every write answers it. Never a hash or a secret. */
export interface UserDetail extends UserListItem {
  /** null: the library's language. */
  locale: Locale | null;
  mustChangePassword: boolean;
  /** The optimistic-concurrency counter a PATCH sends back. */
  version: number;
  createdAt: number;
  updatedAt: number;
}

/** `POST users/:id/reset-password`: shown once, never stored in clear (idempotency `none`). */
export interface TemporaryPasswordResponse {
  temporaryPassword: string;
}

/** `GET users`: one page, in username order. */
export interface UserListResponse {
  items: UserListItem[];
  total: number;
  page: number;
  pageSize: number;
}
