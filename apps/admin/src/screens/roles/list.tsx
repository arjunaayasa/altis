import type { RoleItem, RoleListResponse } from '@altis/shared/api/roles';
import { Link } from '@tanstack/react-router';
import { createColumnHelper, tableFeatures, useTable } from '@tanstack/react-table';
import { PlusIcon } from 'lucide-react';
import { useMemo } from 'react';
import { DataTable } from '@/components/data-table';
import { Badge, Notice } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n';
import { holds, roleLabel } from '@/lib/access';
import { problemText } from '@/lib/form-errors';
import { useApiQuery, useMe } from '@/lib/me';

/**
 * Peran (spec §13.3, §7.2; `GET roles`): every role, the system roles first and marked "sistem" (their permissions
 * come from the catalog, decision D5), with the number of permissions and holders and whether the role requires 2FA.
 * Reading needs `system.users.read`; creating needs `system.roles.manage`.
 */

const features = tableFeatures({});
const column = createColumnHelper<typeof features, RoleItem>();
const NO_ROLES: RoleItem[] = [];

export function RolesListScreen() {
  const t = useT();
  const me = useMe();
  const canManage = holds(me, 'system.roles.manage');
  const roles = useApiQuery<RoleListResponse>({ queryKey: ['roles', 'list'], path: 'roles' });

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('name', {
          header: t('roles.col.name'),
          cell: (info) => {
            const role = info.row.original;
            return (
              <span className="flex flex-wrap items-center gap-2">
                <Link
                  to={`/admin/roles/${encodeURIComponent(role.id)}`}
                  className="font-medium text-primary underline-offset-4 hover:underline"
                >
                  {roleLabel(t, role)}
                </Link>
                {role.isSystem && <Badge tone="info">{t('roles.system')}</Badge>}
              </span>
            );
          },
        }),
        column.accessor('description', {
          header: t('roles.col.description'),
          cell: (info) => <span className="line-clamp-2 text-muted-foreground">{info.getValue() ?? '—'}</span>,
        }),
        column.accessor((role) => role.permissions.length, {
          id: 'permissions',
          header: t('roles.col.permissions'),
          cell: (info) => <span className="whitespace-nowrap">{t('roles.permission_count', { count: info.getValue() })}</span>,
        }),
        column.accessor('holders', {
          header: t('roles.col.holders'),
          cell: (info) => <span className="whitespace-nowrap">{t('roles.holder_count', { count: info.getValue() })}</span>,
        }),
        column.accessor('mfaRequired', {
          header: t('roles.col.mfa'),
          cell: (info) => t(info.getValue() ? 'form.yes' : 'form.no'),
        }),
      ]),
    [t],
  );

  const table = useTable({ features, columns, data: roles.data?.items ?? NO_ROLES, getRowId: (role) => role.id });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">{t('nav.roles')}</h1>
        {canManage && (
          <Button asChild>
            <Link to="/admin/roles/new">
              <PlusIcon aria-hidden="true" />
              {t('roles.add')}
            </Link>
          </Button>
        )}
      </div>
      {roles.isError ? (
        <Notice
          kind="error"
          action={
            <Button variant="outline" size="sm" onClick={() => void roles.refetch()}>
              {t('table.retry')}
            </Button>
          }
        >
          {problemText(t, roles.error)}
        </Notice>
      ) : roles.data === undefined ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t('shell.loading')}
        </p>
      ) : (
        <DataTable table={table} caption={t('roles.caption')} empty={t('roles.empty')} />
      )}
    </div>
  );
}
