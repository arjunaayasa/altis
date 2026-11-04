import { isDomainError, newId, systemRolePermissions, type ErrorCode, type Permission } from '@altis/shared';
import { describe, expect, it } from 'vitest';
import {
  assertCanAssign,
  assertCanManageUser,
  assertCanWriteRole,
  type ActorAuthz,
  type RoleSnapshot,
} from '../src/authz/escalation.js';
import { can, grantSubset, type Grants } from '../src/authz/grants.js';

// Anti-escalation rules 1-5 of spec §7.2, on literal grant fixtures (no database). Rule 6 (the last active super
// admin) needs a transaction: test/db/super-admin-guard.test.ts.

const B = newId();
const C = newId();

function grants(global: readonly Permission[], branches: Record<string, readonly Permission[]> = {}, superAdmin = false): Grants {
  return {
    global: new Set(global),
    branches: new Map(Object.entries(branches).map(([branchId, ps]) => [branchId, new Set(ps)])),
    superAdmin,
    roleMfaRequired: false,
  };
}

const NONE = grants([]);
const ADMIN_GRANTS = grants(systemRolePermissions('admin'));
const SUPER_GRANTS = grants(systemRolePermissions('super_admin'), {}, true);
const BRANCH_ADMIN_GRANTS = grants([], { [B]: ['test.branch.manage'] });

const actor = (g: Grants): ActorAuthz => ({ id: newId(), grants: g });
const admin = actor(ADMIN_GRANTS);
const superAdmin = actor(SUPER_GRANTS);
const branchAdmin = actor(BRANCH_ADMIN_GRANTS);

const target = (g: Grants = NONE) => ({ id: newId(), grants: g });

const customRole = (permissions: Permission[], o: Partial<RoleSnapshot> = {}): RoleSnapshot => ({
  id: newId(),
  key: 'PUSTAKAWAN',
  isSystem: false,
  permissions,
  mfaRequired: false,
  ...o,
});

const systemRole = (key: 'super_admin' | 'admin', o: Partial<RoleSnapshot> = {}): RoleSnapshot => ({
  id: newId(),
  key,
  isSystem: true,
  permissions: [...systemRolePermissions(key)],
  mfaRequired: false,
  ...o,
});

/** The code of the DomainError `fn` throws, or null when it returns; anything else is rethrown. */
function codeOf(fn: () => void): ErrorCode | null {
  try {
    fn();
    return null;
  } catch (error) {
    if (isDomainError(error)) return error.code;
    throw error;
  }
}

describe('fixtures', () => {
  it('the literal admin grants lack exactly the three super-admin-only system permissions', () => {
    for (const p of ['system.update.run', 'system.backup.restore', 'system.config.manage'] as const) {
      expect(ADMIN_GRANTS.global.has(p)).toBe(false);
      expect(SUPER_GRANTS.global.has(p)).toBe(true);
    }
    expect(ADMIN_GRANTS.global.has('system.users.manage')).toBe(true);
    expect(ADMIN_GRANTS.global.has('system.roles.manage')).toBe(true);
  });
});

describe('can / grantSubset', () => {
  it('can: a global permission counts at every branch; a branch permission only at its branch', () => {
    const g = grants(['system.users.read'], { [B]: ['test.branch.manage'] });
    expect(can(g, 'system.users.read')).toBe(true);
    expect(can(g, 'system.users.read', B)).toBe(true);
    expect(can(g, 'system.users.read', null)).toBe(true);
    expect(can(g, 'test.branch.manage', B)).toBe(true);
    expect(can(g, 'test.branch.manage', C)).toBe(false);
    expect(can(g, 'test.branch.manage')).toBe(false);
    expect(can(g, 'test.branch.manage', null)).toBe(false);
    expect(can(g, 'system.users.manage', B)).toBe(false);
  });

  it('grantSubset: global into global, branch into the same branch or global', () => {
    expect(grantSubset(NONE, NONE)).toBe(true);
    expect(grantSubset(ADMIN_GRANTS, SUPER_GRANTS)).toBe(true);
    expect(grantSubset(SUPER_GRANTS, ADMIN_GRANTS)).toBe(false);
    expect(grantSubset(ADMIN_GRANTS, ADMIN_GRANTS)).toBe(true);
    expect(grantSubset(BRANCH_ADMIN_GRANTS, grants(['test.branch.manage']))).toBe(true);
    expect(grantSubset(BRANCH_ADMIN_GRANTS, grants([], { [C]: ['test.branch.manage'] }))).toBe(false);
    expect(grantSubset(grants(['test.branch.manage']), BRANCH_ADMIN_GRANTS)).toBe(false);
    expect(grantSubset(grants(['system.users.read']), NONE)).toBe(false);
  });
});

describe('assertCanWriteRole (rules 1, 3, 5)', () => {
  it('admin creates a role with system.update.run -> AUTHZ_ESCALATION', () => {
    expect(codeOf(() => assertCanWriteRole(admin, null, customRole(['system.update.run'])))).toBe('AUTHZ_ESCALATION');
  });

  it('admin creates a role with permissions admin holds -> OK', () => {
    expect(codeOf(() => assertCanWriteRole(admin, null, customRole(['system.users.read', 'system.audit.read'])))).toBeNull();
  });

  it('admin edits a custom role adding system.users.manage, which admin holds -> OK', () => {
    const before = customRole(['system.users.read']);
    const after = { ...before, permissions: [...before.permissions, 'system.users.manage' as const] };
    expect(codeOf(() => assertCanWriteRole(admin, before, after))).toBeNull();
  });

  it('removing a permission the editor does not hold is a change of it too (rule 1: the union is checked)', () => {
    const before = customRole(['system.users.read', 'system.update.run']);
    const after = { ...before, permissions: ['system.users.read' as const] };
    expect(codeOf(() => assertCanWriteRole(admin, before, after))).toBe('AUTHZ_ESCALATION');
    expect(codeOf(() => assertCanWriteRole(superAdmin, before, after))).toBeNull();
  });

  it('a permission held only at a branch is not enough to put it in a role', () => {
    expect(codeOf(() => assertCanWriteRole(branchAdmin, null, customRole(['test.branch.manage'])))).toBe('AUTHZ_ESCALATION');
    expect(codeOf(() => assertCanWriteRole(actor(grants(['test.branch.manage'])), null, customRole(['test.branch.manage'])))).toBeNull();
  });

  it('rule 5: system.roles.manage (held by admin) can only be granted by a super admin', () => {
    expect(codeOf(() => assertCanWriteRole(admin, null, customRole(['system.roles.manage'])))).toBe('AUTHZ_ESCALATION');
    expect(codeOf(() => assertCanWriteRole(superAdmin, null, customRole(['system.roles.manage'])))).toBeNull();
    // ...and a role that already carries it cannot be edited by a non-super-admin either.
    const before = customRole(['system.roles.manage', 'system.users.read']);
    expect(codeOf(() => assertCanWriteRole(admin, before, { ...before, permissions: ['system.users.read'] }))).toBe(
      'AUTHZ_ESCALATION',
    );
  });

  it('rule 5 asks for the super_admin role itself: holding every permission through a custom role is not enough', () => {
    const allButSuper = actor(grants(systemRolePermissions('super_admin')));
    expect(codeOf(() => assertCanWriteRole(allButSuper, null, customRole(['system.config.manage'])))).toBe('AUTHZ_ESCALATION');
  });

  it('admin toggles mfaRequired of the super_admin snapshot -> AUTHZ_ESCALATION', () => {
    const before = systemRole('super_admin');
    expect(codeOf(() => assertCanWriteRole(admin, before, { ...before, mfaRequired: true }))).toBe('AUTHZ_ESCALATION');
  });

  it('super admin toggles mfaRequired of the super_admin snapshot -> OK', () => {
    const before = systemRole('super_admin');
    expect(codeOf(() => assertCanWriteRole(superAdmin, before, { ...before, mfaRequired: true }))).toBeNull();
    const admins = systemRole('admin', { mfaRequired: true });
    expect(codeOf(() => assertCanWriteRole(superAdmin, admins, { ...admins, mfaRequired: false }))).toBeNull();
  });

  it('editing the permissions of a system role -> ROLE_SYSTEM_READONLY, whoever edits', () => {
    const before = systemRole('admin');
    const fewer = { ...before, permissions: before.permissions.filter((p) => p !== 'system.users.manage') };
    const more = { ...before, permissions: [...before.permissions, 'system.update.run' as const] };
    expect(codeOf(() => assertCanWriteRole(superAdmin, before, fewer))).toBe('ROLE_SYSTEM_READONLY');
    expect(codeOf(() => assertCanWriteRole(superAdmin, before, more))).toBe('ROLE_SYSTEM_READONLY');
    expect(codeOf(() => assertCanWriteRole(admin, before, more))).toBe('ROLE_SYSTEM_READONLY');
  });

  it('a system role keeps its key and stays a system role; no role becomes or is created as a system role', () => {
    const sa = systemRole('super_admin');
    expect(codeOf(() => assertCanWriteRole(superAdmin, sa, { ...sa, key: 'SUPER_ADMIN' }))).toBe('ROLE_SYSTEM_READONLY');
    expect(codeOf(() => assertCanWriteRole(superAdmin, sa, { ...sa, isSystem: false }))).toBe('ROLE_SYSTEM_READONLY');
    const custom = customRole(['system.users.read']);
    expect(codeOf(() => assertCanWriteRole(superAdmin, custom, { ...custom, isSystem: true }))).toBe('ROLE_SYSTEM_READONLY');
    expect(codeOf(() => assertCanWriteRole(superAdmin, null, systemRole('admin')))).toBe('ROLE_SYSTEM_READONLY');
  });

  it('the order of the permissions of a system role does not matter', () => {
    const before = systemRole('admin');
    const shuffled = { ...before, permissions: [...before.permissions].reverse(), mfaRequired: true };
    expect(codeOf(() => assertCanWriteRole(superAdmin, before, shuffled))).toBeNull();
  });
});

describe('assertCanAssign (rules 2, 3, 4, 5 and the scope)', () => {
  it('a branch admin assigns a role with system.users.read: ROLE_SCOPE_INVALID at branch B, AUTHZ_ESCALATION globally', () => {
    const role = customRole(['system.users.read']);
    expect(codeOf(() => assertCanAssign(branchAdmin, target(), { role, branchId: B, op: 'add' }))).toBe('ROLE_SCOPE_INVALID');
    expect(codeOf(() => assertCanAssign(branchAdmin, target(), { role, branchId: null, op: 'add' }))).toBe('AUTHZ_ESCALATION');
  });

  it('the same branch admin assigns {test.branch.manage}: OK at B, AUTHZ_ESCALATION at C and globally', () => {
    const role = customRole(['test.branch.manage']);
    expect(codeOf(() => assertCanAssign(branchAdmin, target(), { role, branchId: B, op: 'add' }))).toBeNull();
    expect(codeOf(() => assertCanAssign(branchAdmin, target(), { role, branchId: B, op: 'remove' }))).toBeNull();
    expect(codeOf(() => assertCanAssign(branchAdmin, target(), { role, branchId: C, op: 'add' }))).toBe('AUTHZ_ESCALATION');
    expect(codeOf(() => assertCanAssign(branchAdmin, target(), { role, branchId: null, op: 'add' }))).toBe('AUTHZ_ESCALATION');
  });

  it('a global holder of a branch permission may assign it at any branch', () => {
    const role = customRole(['test.branch.manage']);
    expect(codeOf(() => assertCanAssign(admin, target(), { role, branchId: C, op: 'add' }))).toBeNull();
    expect(codeOf(() => assertCanAssign(admin, target(), { role, branchId: null, op: 'add' }))).toBeNull();
  });

  it('a system role at a branch scope -> ROLE_SCOPE_INVALID (its global permissions cannot be scoped)', () => {
    expect(codeOf(() => assertCanAssign(superAdmin, target(), { role: systemRole('admin'), branchId: B, op: 'add' }))).toBe(
      'ROLE_SCOPE_INVALID',
    );
  });

  it('the scope check is for adding only: a role that gained a global permission after its branch assignment can still be revoked there', () => {
    const role = customRole(['system.audit.read']);
    expect(codeOf(() => assertCanAssign(superAdmin, target(), { role, branchId: B, op: 'add' }))).toBe('ROLE_SCOPE_INVALID');
    expect(codeOf(() => assertCanAssign(superAdmin, target(), { role, branchId: B, op: 'remove' }))).toBeNull();
    expect(codeOf(() => assertCanAssign(superAdmin, target(), { role: systemRole('admin'), branchId: B, op: 'remove' }))).toBeNull();
    // Rule 2 still holds for the removal: the remover holds every permission of the role at that branch.
    expect(codeOf(() => assertCanAssign(branchAdmin, target(), { role, branchId: B, op: 'remove' }))).toBe('AUTHZ_ESCALATION');
  });

  it('an actor assigning to themselves -> AUTHZ_ESCALATION (rule 4), even a super admin, even a removal', () => {
    const role = customRole(['system.users.read']);
    for (const op of ['add', 'remove'] as const) {
      expect(codeOf(() => assertCanAssign(superAdmin, { id: superAdmin.id, grants: SUPER_GRANTS }, { role, branchId: null, op }))).toBe(
        'AUTHZ_ESCALATION',
      );
    }
  });

  it('rule 5 for the super_admin role itself decides on its own: every permission held, no super-admin-only one in the role -> still refused', () => {
    // Every permission, through a custom role: rule 2 passes for any role, and the snapshot below carries no
    // permission, so neither rule 2 nor the SUPER_ADMIN_ONLY_GRANTS loop can be what refuses it.
    const everything = actor(grants(systemRolePermissions('super_admin')));
    const bare = systemRole('super_admin', { permissions: [] });
    try {
      assertCanAssign(everything, target(), { role: bare, branchId: null, op: 'add' });
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: 'AUTHZ_ESCALATION', meta: { rule: 5, role: 'super_admin' } });
    }
    expect(codeOf(() => assertCanAssign(everything, target(), { role: systemRole('admin', { permissions: [] }), branchId: null, op: 'add' }))).toBeNull();
  });

  it('admin assigns super_admin -> AUTHZ_ESCALATION; super admin -> OK', () => {
    const role = systemRole('super_admin');
    expect(codeOf(() => assertCanAssign(admin, target(), { role, branchId: null, op: 'add' }))).toBe('AUTHZ_ESCALATION');
    expect(codeOf(() => assertCanAssign(superAdmin, target(), { role, branchId: null, op: 'add' }))).toBeNull();
  });

  it('rule 5: a role with system.roles.manage is assigned by a super admin only, although admin holds it', () => {
    const role = customRole(['system.roles.manage']);
    expect(codeOf(() => assertCanAssign(admin, target(), { role, branchId: null, op: 'add' }))).toBe('AUTHZ_ESCALATION');
    expect(codeOf(() => assertCanAssign(superAdmin, target(), { role, branchId: null, op: 'add' }))).toBeNull();
  });

  it('the admin role carries system.roles.manage, so only a super admin assigns or revokes it (rule 5)', () => {
    const role = systemRole('admin');
    for (const [who, op] of [
      [target(), 'add'],
      [target(ADMIN_GRANTS), 'remove'],
    ] as const) {
      try {
        assertCanAssign(admin, who, { role, branchId: null, op });
        expect.unreachable();
      } catch (error) {
        expect(error).toMatchObject({ code: 'AUTHZ_ESCALATION', meta: { rule: 5 } });
      }
      expect(codeOf(() => assertCanAssign(superAdmin, who, { role, branchId: null, op }))).toBeNull();
    }
  });

  it('admin assigns a custom role of permissions admin holds (none of rule 5) -> OK, add and remove', () => {
    const role = customRole(['system.users.manage', 'system.audit.read']);
    expect(codeOf(() => assertCanAssign(admin, target(), { role, branchId: null, op: 'add' }))).toBeNull();
    expect(codeOf(() => assertCanAssign(admin, target(grants(['system.users.manage'])), { role, branchId: null, op: 'remove' }))).toBeNull();
  });

  it('rule 3: the target must not hold more than the actor, even for a role the actor may give', () => {
    const role = customRole(['system.users.read']);
    expect(codeOf(() => assertCanAssign(admin, target(SUPER_GRANTS), { role, branchId: null, op: 'add' }))).toBe('AUTHZ_ESCALATION');
    expect(codeOf(() => assertCanAssign(admin, target(SUPER_GRANTS), { role, branchId: null, op: 'remove' }))).toBe(
      'AUTHZ_ESCALATION',
    );
    const elsewhere = target(grants([], { [C]: ['test.branch.manage'] }));
    const branchRole = customRole(['test.branch.manage']);
    expect(codeOf(() => assertCanAssign(branchAdmin, elsewhere, { role: branchRole, branchId: B, op: 'add' }))).toBe(
      'AUTHZ_ESCALATION',
    );
  });
});

describe('assertCanManageUser (rules 3 and 4)', () => {
  it('admin manages a super admin user -> AUTHZ_ESCALATION', () => {
    expect(codeOf(() => assertCanManageUser(admin, target(SUPER_GRANTS), { allowSelf: false }))).toBe('AUTHZ_ESCALATION');
  });

  it('admin manages another admin or a user without roles -> OK; a super admin manages anyone', () => {
    expect(codeOf(() => assertCanManageUser(admin, target(ADMIN_GRANTS), { allowSelf: false }))).toBeNull();
    expect(codeOf(() => assertCanManageUser(admin, target(), { allowSelf: false }))).toBeNull();
    expect(codeOf(() => assertCanManageUser(superAdmin, target(SUPER_GRANTS), { allowSelf: false }))).toBeNull();
  });

  it('a branch admin manages a user of their branch only', () => {
    expect(codeOf(() => assertCanManageUser(branchAdmin, target(BRANCH_ADMIN_GRANTS), { allowSelf: false }))).toBeNull();
    const other = target(grants([], { [C]: ['test.branch.manage'] }));
    expect(codeOf(() => assertCanManageUser(branchAdmin, other, { allowSelf: false }))).toBe('AUTHZ_ESCALATION');
  });

  it('self: refused unless allowSelf', () => {
    const self = { id: admin.id, grants: ADMIN_GRANTS };
    expect(codeOf(() => assertCanManageUser(admin, self, { allowSelf: false }))).toBe('AUTHZ_ESCALATION');
    expect(codeOf(() => assertCanManageUser(admin, self, { allowSelf: true }))).toBeNull();
  });
});

describe('errors', () => {
  it('a refusal is a 403 AUTHZ_ESCALATION DomainError naming the rule in meta, never in the message to the client', () => {
    try {
      assertCanWriteRole(admin, null, customRole(['system.update.run']));
      expect.unreachable();
    } catch (error) {
      expect(isDomainError(error)).toBe(true);
      expect(error).toMatchObject({ code: 'AUTHZ_ESCALATION', status: 403, meta: { rule: 1 } });
    }
    try {
      assertCanAssign(branchAdmin, target(), { role: customRole(['system.users.read']), branchId: B, op: 'add' });
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: 'ROLE_SCOPE_INVALID', status: 422 });
    }
  });
});
