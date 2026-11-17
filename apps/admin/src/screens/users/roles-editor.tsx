import type { BranchListResponse } from '@altis/shared/api/branches';
import type { PermissionListResponse, RoleItem, RoleListResponse } from '@altis/shared/api/roles';
import type { RoleAssignment, UserDetail } from '@altis/shared/api/users';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useMemo, useState } from 'react';
import { Badge, Notice, SELECT_CLASS } from '@/components/form-field';
import { SectionHead } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { useT } from '@/i18n';
import { assignable, roleLabel } from '@/lib/access';
import { api } from '@/lib/api';
import { useDirtyGuard } from '@/lib/dirty-forms';
import { problemText } from '@/lib/form-errors';
import { useApiQuery, useMe } from '@/lib/me';

/**
 * The role assignments of one staff user (spec §7.2, §13.3 "peran per cabang"; `PUT users/:id/roles`): each pairs a
 * role with a scope, global or one branch of `GET branches`. The list is edited here and saved whole.
 *
 * What is offered follows §7.2 (the server checks it again, AUTHZ_ESCALATION otherwise):
 * - rule 4: nobody edits their own roles, so on one's own page the list is read-only;
 * - rules 2 and 5: only roles whose permissions the signed-in user holds, none that only a super admin grants; so
 *   `super_admin` and `admin` (which holds `system.roles.manage`) are offered to super admins only, and an assignment
 *   of such a role has no remove button for anyone else;
 * - a role with a global permission is assigned globally only (ROLE_SCOPE_INVALID otherwise): its branch options are
 *   disabled. The permission scopes come from `GET permissions`.
 */

type Assignment = RoleAssignment;

const pairOf = (a: Assignment): string => `${a.roleId}:${a.branchId ?? ''}`;

function sameList(a: readonly Assignment[], b: readonly Assignment[]): boolean {
  return a.length === b.length && a.every((x, i) => pairOf(x) === pairOf(b[i]!));
}

export function RolesEditor({ user, canManage, isSelf }: { user: UserDetail; canManage: boolean; isSelf: boolean }) {
  const t = useT();
  const me = useMe();
  const queryClient = useQueryClient();
  const ids = { heading: useId(), role: useId(), scope: useId(), scopeHint: useId() };
  const editable = canManage && !isSelf;

  const roles = useApiQuery<RoleListResponse>({ queryKey: ['roles', 'list'], path: 'roles' });
  const branches = useApiQuery<BranchListResponse>({ queryKey: ['branches', { includeArchived: true }], path: 'branches?includeArchived=true' });
  const catalog = useApiQuery<PermissionListResponse>({ queryKey: ['permissions'], path: 'permissions', staleTime: Infinity });

  const server = useMemo(() => user.roles.map((r): Assignment => ({ roleId: r.roleId, branchId: r.branchId })), [user.roles]);
  const [list, setList] = useState<Assignment[]>(server);
  const [base, setBase] = useState<Assignment[]>(server);
  // A newer list from the server (a refetch, or the answer of our own save) replaces an unedited one.
  if (base !== server && sameList(list, base)) {
    setBase(server);
    setList(server);
  }
  const dirty = !sameList(list, base);
  useDirtyGuard(dirty);

  const [roleId, setRoleId] = useState('');
  const [scope, setScope] = useState('');
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const roleById = new Map((roles.data?.items ?? []).map((r) => [r.id, r]));
  const scopeOf = new Map((catalog.data?.items ?? []).map((p) => [p.key, p.scope]));
  const branchById = new Map((branches.data?.items ?? []).map((b) => [b.id, b]));
  const globalOnly = (role: RoleItem): boolean => role.permissions.some((p) => scopeOf.get(p) !== 'branch');
  const offered = (roles.data?.items ?? []).filter((r) => assignable(me, r) === 'ok');
  const selected = roleById.get(roleId);
  const selectedGlobalOnly = selected !== undefined && globalOnly(selected);
  const activeBranches = (branches.data?.items ?? []).filter((b) => b.archivedAt === null);

  const scopeText = (branchId: string | null): string => {
    if (branchId === null) return t('users.roles.global');
    const branch = branchById.get(branchId);
    if (branch === undefined) return branchId;
    return branch.archivedAt === null ? branch.name : t('users.roles.archived_branch', { name: branch.name });
  };

  const nameOf = (a: Assignment): string => {
    const role = roleById.get(a.roleId) ?? user.roles.find((r) => r.roleId === a.roleId);
    return role === undefined ? a.roleId : roleLabel(t, role);
  };

  const chooseRole = (next: string): void => {
    setRoleId(next);
    setMessage(null);
    const role = roleById.get(next);
    if (role !== undefined && globalOnly(role)) setScope('');
  };

  const add = (): void => {
    if (selected === undefined) return;
    const assignment: Assignment = { roleId: selected.id, branchId: selectedGlobalOnly || scope === '' ? null : scope };
    if (list.some((a) => pairOf(a) === pairOf(assignment))) {
      setMessage({ kind: 'error', text: t('users.roles.duplicate') });
      return;
    }
    setList([...list, assignment]);
    setRoleId('');
    setScope('');
    setMessage(null);
  };

  const save = async (): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      const updated = await api<UserDetail>('PUT', `users/${encodeURIComponent(user.id)}/roles`, { assignments: list });
      queryClient.setQueryData(['users', 'detail', user.id], updated);
      void queryClient.invalidateQueries({ queryKey: ['users', 'list'] });
      void queryClient.invalidateQueries({ queryKey: ['roles'] });
      const saved = updated.roles.map((r): Assignment => ({ roleId: r.roleId, branchId: r.branchId }));
      setList(saved);
      setBase(saved);
      setMessage({ kind: 'success', text: t('users.roles.saved') });
    } catch (e) {
      setMessage({ kind: 'error', text: problemText(t, e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby={ids.heading} className="grid gap-3 border-t pt-5">
      <div className="grid max-w-[75ch] gap-1">
        <SectionHead id={ids.heading} title={t('users.roles.title')} />
        <p className="text-sm text-muted-foreground">{t('users.roles.description')}</p>
        {isSelf && canManage && <p className="text-sm">{t('users.roles.self')}</p>}
      </div>

      {list.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('users.roles.none')}</p>
      ) : (
        <ul className="grid divide-y rounded-lg border">
          {list.map((a) => {
            const name = nameOf(a);
            const where = scopeText(a.branchId);
            const role = roleById.get(a.roleId);
            const verdict = role === undefined ? 'not_held' : assignable(me, role);
            return (
              <li key={pairOf(a)} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                <span className="min-w-0 font-medium [overflow-wrap:anywhere]">{name}</span>
                {/* A branch name can be long ("… (diarsipkan)" too): it wraps inside the badge on a 375 px phone. */}
                <Badge tone="neutral" className="min-w-0 whitespace-normal [overflow-wrap:anywhere]">
                  {where}
                </Badge>
                {editable &&
                  (verdict === 'ok' ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="ml-auto"
                      aria-label={t('users.roles.remove', { role: name, scope: where })}
                      onClick={() => setList(list.filter((x) => x !== a))}
                    >
                      {t('users.roles.remove_short')}
                    </Button>
                  ) : (
                    <span className="ml-auto text-xs text-muted-foreground">
                      {t(verdict === 'super_admin_only' ? 'users.roles.super_admin_only' : 'users.roles.not_held')}
                    </span>
                  ))}
              </li>
            );
          })}
        </ul>
      )}

      {editable && (
        <div className="grid gap-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid min-w-48 flex-1 gap-1.5">
              <Label htmlFor={ids.role} className="text-meta">{t('users.roles.role')}</Label>
              <select id={ids.role} className={SELECT_CLASS} value={roleId} onChange={(e) => chooseRole(e.target.value)}>
                <option value="">{t('users.roles.choose')}</option>
                {offered.map((r) => (
                  <option key={r.id} value={r.id}>
                    {roleLabel(t, r)}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid min-w-48 flex-1 gap-1.5">
              <Label htmlFor={ids.scope} className="text-meta">{t('users.roles.scope')}</Label>
              <select
                id={ids.scope}
                className={SELECT_CLASS}
                value={scope}
                aria-describedby={selectedGlobalOnly ? ids.scopeHint : undefined}
                onChange={(e) => setScope(e.target.value)}
              >
                <option value="">{t('users.roles.global_option')}</option>
                {activeBranches.map((b) => (
                  <option key={b.id} value={b.id} disabled={selectedGlobalOnly}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>
            <Button type="button" variant="outline" disabled={selected === undefined} onClick={add}>
              {t('users.roles.add')}
            </Button>
          </div>
          {selectedGlobalOnly && (
            <p id={ids.scopeHint} className="text-xs text-muted-foreground">
              {t('users.roles.global_only')}
            </p>
          )}
          <div>
            <Button type="button" disabled={!dirty || busy} onClick={() => void save()}>
              {t('users.roles.save')}
            </Button>
          </div>
        </div>
      )}

      {message !== null && <Notice kind={message.kind}>{message.text}</Notice>}
    </section>
  );
}
