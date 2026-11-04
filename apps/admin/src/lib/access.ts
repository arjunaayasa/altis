import { SUPER_ADMIN_ONLY_GRANTS, SYSTEM_ROLE_KEYS, type Permission } from '@altis/shared';
import type { MeResponse } from '@altis/shared/api/auth';
import type { RoleItem } from '@altis/shared/api/roles';
import type { Translate } from '@/i18n';

/**
 * What the signed-in user may do, as the screens show it (spec §7.2). This only decides what the UI offers: the
 * server checks every request again (deny by default, anti-escalation rules 1-6), so a stale `me` costs a refusal,
 * never a right.
 */

type Me = MeResponse | undefined;

const SUPER_ADMIN_ONLY: ReadonlySet<string> = new Set(SUPER_ADMIN_ONLY_GRANTS);

/** True when `me` is fully signed in and holds `permission` globally (a super admin holds every one). */
export function holds(me: Me, permission: Permission): boolean {
  if (me === undefined || !me.authenticated || me.stage !== 'full') return false;
  return me.superAdmin || me.permissions.includes(permission);
}

/**
 * True when `me` may use `permission` at the branch `branchId` (Phase 2: `catalog.items.manage`,
 * `catalog.locations.manage`): a global holder or a super admin anywhere, otherwise a grant of the role assigned at that
 * branch (`me.branchPermissions[branchId]`). Only an own key of `branchPermissions` counts (a branch id from a URL
 * never reads the prototype).
 */
export function holdsAt(me: Me, permission: Permission, branchId: string): boolean {
  if (holds(me, permission)) return true;
  if (me === undefined || !me.authenticated || me.stage !== 'full') return false;
  if (!Object.prototype.hasOwnProperty.call(me.branchPermissions, branchId)) return false;
  return me.branchPermissions[branchId]?.includes(permission) ?? false;
}

/** True when `me` is a fully signed-in super admin. */
export function isSuperAdmin(me: Me): boolean {
  return me !== undefined && me.authenticated && me.stage === 'full' && me.superAdmin;
}

/** The id of the signed-in user, or null. */
export function meId(me: Me): string | null {
  return me !== undefined && me.authenticated ? me.user.id : null;
}

/**
 * Whether `me` may put `permission` into a role (rule 1: one grants only what one holds; rule 5: the permissions of
 * SUPER_ADMIN_ONLY_GRANTS, `system.roles.manage` included, only a super admin grants).
 */
export function grantable(me: Me, permission: Permission): 'ok' | 'not_held' | 'super_admin_only' {
  if (!holds(me, permission)) return 'not_held';
  if (!isSuperAdmin(me) && SUPER_ADMIN_ONLY.has(permission)) return 'super_admin_only';
  return 'ok';
}

/**
 * Whether `me` may assign `role` to someone else, or revoke it (rules 2 and 5): every permission of the role held,
 * none that only a super admin grants, and the `super_admin` role (and so the `admin` role, which holds
 * `system.roles.manage`) only by a super admin. Rule 3 (the account's rights ⊆ the assigner's) is the server's.
 */
export function assignable(me: Me, role: Pick<RoleItem, 'key' | 'permissions'>): 'ok' | 'not_held' | 'super_admin_only' {
  if (isSuperAdmin(me)) return 'ok';
  if (role.key === 'super_admin') return 'super_admin_only';
  let verdict: 'ok' | 'not_held' | 'super_admin_only' = 'ok';
  for (const p of role.permissions) {
    const g = grantable(me, p);
    if (g === 'super_admin_only') return g;
    if (g === 'not_held') verdict = g;
  }
  return verdict;
}

/**
 * The name of a role as the UI shows it: the system roles by their fixed, translated names (`role.super_admin`,
 * `role.admin`; decision D5), a custom role by its own name. A custom role's key is its normalized (upper-cased)
 * name, so it never equals a system key.
 */
export function roleLabel(t: Translate, role: { key: string; name: string }): string {
  return (SYSTEM_ROLE_KEYS as readonly string[]).includes(role.key) ? t(`role.${role.key as 'admin' | 'super_admin'}`) : role.name;
}
