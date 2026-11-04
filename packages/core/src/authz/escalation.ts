import { DomainError, SUPER_ADMIN_ONLY_GRANTS, type Permission } from '@altis/shared';
import { can, grantSubset, permissionScope, type Grants } from './grants.js';

// Anti-escalation rules 1-5 of spec §7.2, enforced by the services (users, roles) before they write. Pure functions
// over grants the caller loaded; rule 6 (an active super admin must remain) needs the transaction:
// super-admin-guard.ts.
//
//   1. Creating or changing a role: every permission in it must be held by the editor; changing a role others hold
//      counts as granting it.
//   2. Assigning or revoking a role: its permissions ⊆ the assigner's, and only at the assigner's branch scope.
//   3. Managing another account (edit, disable, password/2FA reset, e-mail/username, mfa_required, its roles): the
//      account's permissions ⊆ the editor's. The same holds for changing roles.mfa_required.
//   4. Nobody changes their own roles.
//   5. system.update.run, system.backup.restore, system.config.manage, system.roles.manage, catalog.migration.run and
//      the super_admin role are granted by a super admin only (the routes add reauth and the audit entry).
//
// A refusal is DomainError AUTHZ_ESCALATION (403) with `meta.rule`; a system role edited beyond mfaRequired is
// ROLE_SYSTEM_READONLY, a global permission given a branch scope ROLE_SCOPE_INVALID. `meta` stays in the logs, the
// client only sees the code.

/** A role as the anti-escalation checks see it: for a system role, `permissions` is systemRolePermissions(key). */
export type RoleSnapshot = {
  id?: string;
  key: string;
  isSystem: boolean;
  permissions: Permission[];
  mfaRequired: boolean;
};

/** Who acts: a staff user and their grants. */
export type ActorAuthz = { id: string; grants: Grants };

const SUPER_ADMIN_ONLY: ReadonlySet<string> = new Set(SUPER_ADMIN_ONLY_GRANTS);

const DETAIL_ESCALATION =
  'Perubahan ini memberi atau mengubah hak yang tidak Anda miliki / This change grants or alters rights you do not hold';

function escalation(rule: 1 | 2 | 3 | 4 | 5, extra: Record<string, unknown> = {}): DomainError {
  return new DomainError('AUTHZ_ESCALATION', { detail: DETAIL_ESCALATION, meta: { rule, ...extra } });
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const x of sa) if (!sb.has(x)) return false;
  return true;
}

/**
 * Throws unless `actor` may write the role `before` (null: create) as `after`. Used for a create, an update
 * (permissions, name, mfaRequired) and a delete (`after` = `before`).
 *
 * - a system role may change only `mfaRequired`: its key, its system flag and its permissions stay; no role is
 *   created as, or turned into, a system role (`ROLE_SYSTEM_READONLY`);
 * - every permission of `before` ∪ `after` must be held globally by the actor (rule 1, and rule 3 for
 *   `mfaRequired`), else `AUTHZ_ESCALATION`; rule 3 on the role's holders when `mfaRequired` changes is updateRole's
 *   (it needs their grants: assertCanManageUser per holder);
 * - a permission of SUPER_ADMIN_ONLY_GRANTS in that union needs `actor.grants.superAdmin` (rule 5).
 *
 * @throws DomainError ROLE_SYSTEM_READONLY (409) or AUTHZ_ESCALATION (403)
 */
export function assertCanWriteRole(actor: ActorAuthz, before: RoleSnapshot | null, after: RoleSnapshot): void {
  if (after.isSystem || before?.isSystem === true) {
    const onlyMfa =
      before !== null &&
      before.isSystem &&
      after.isSystem &&
      after.key === before.key &&
      sameSet(after.permissions, before.permissions);
    if (!onlyMfa) {
      throw new DomainError('ROLE_SYSTEM_READONLY', {
        detail:
          'Peran sistem tidak bisa diubah selain kewajiban 2FA-nya / A system role cannot be changed except for its 2FA requirement',
        meta: { key: (before ?? after).key },
      });
    }
  }
  const union = new Set<Permission>([...(before?.permissions ?? []), ...after.permissions]);
  for (const p of union) if (!actor.grants.global.has(p)) throw escalation(1, { permission: p });
  if (!actor.grants.superAdmin) {
    for (const p of union) if (SUPER_ADMIN_ONLY.has(p)) throw escalation(5, { permission: p });
  }
}

/**
 * Throws unless `actor` may add `change.role` to `target` at `change.branchId` (null: global), or remove that
 * assignment:
 *
 * - rule 4: never to or from themselves;
 * - adding at a branch, every permission of the role must be branch-scoped (`ROLE_SCOPE_INVALID`): the global
 *   permissions are granted only through `scope_key = ''`. A removal is never refused for that: a role edited to carry
 *   a global permission after its branch assignment must stay revocable (§7.1);
 * - rule 2: the actor holds every permission of the role at that scope (globally, or at that branch);
 * - rule 5: the `super_admin` role, or a role with a permission of SUPER_ADMIN_ONLY_GRANTS, needs a super admin;
 * - rule 3: the target holds nothing the actor does not ({@link grantSubset}).
 *
 * @throws DomainError AUTHZ_ESCALATION (403) or ROLE_SCOPE_INVALID (422)
 */
export function assertCanAssign(
  actor: ActorAuthz,
  target: { id: string; grants: Grants },
  change: { role: RoleSnapshot; branchId: string | null; op: 'add' | 'remove' },
): void {
  const { role, branchId } = change;
  if (target.id === actor.id) throw escalation(4, { op: change.op });
  if (branchId !== null && change.op === 'add') {
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
  for (const p of role.permissions) if (!can(actor.grants, p, branchId)) throw escalation(2, { permission: p, branchId });
  if (!actor.grants.superAdmin) {
    if (role.key === 'super_admin') throw escalation(5, { role: role.key });
    for (const p of role.permissions) if (SUPER_ADMIN_ONLY.has(p)) throw escalation(5, { permission: p });
  }
  if (!grantSubset(target.grants, actor.grants)) throw escalation(3);
}

/**
 * Throws unless `actor` may manage the account `target` (rule 3: the target's grants ⊆ the actor's), and, when
 * `o.allowSelf` is false, unless the target is someone else (decision D24: one cannot disable, reset or lift the 2FA
 * requirement of oneself through the users routes).
 *
 * @throws DomainError AUTHZ_ESCALATION (403)
 */
export function assertCanManageUser(actor: ActorAuthz, target: { id: string; grants: Grants }, o: { allowSelf: boolean }): void {
  if (!o.allowSelf && target.id === actor.id) throw escalation(4);
  if (!grantSubset(target.grants, actor.grants)) throw escalation(3);
}
