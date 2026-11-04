import type { BranchItem, BranchListResponse, BranchView } from '@altis/shared/api/branches';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { createColumnHelper, tableFeatures, useTable } from '@tanstack/react-table';
import { PlusIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { DataTable } from '@/components/data-table';
import { Badge, CheckField, Notice } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n';
import { holds } from '@/lib/access';
import { api } from '@/lib/api';
import { problemText } from '@/lib/form-errors';
import { useApiQuery, useMe } from '@/lib/me';

/**
 * Cabang (spec §13.3, §6.5; `GET branches`): the library's branches, the default one first. Any signed-in staff user
 * may read the list; adding, editing and archiving need `system.branches.manage`. Archiving (`DELETE branches/:id`)
 * asks first, and the default branch has no archive action (the server refuses it: BRANCH_DEFAULT_ARCHIVE).
 * Archived branches are shown on request. The `POST`, `PATCH` and `DELETE` answers carry no `active` flag: the list is
 * read again after every write.
 */

const features = tableFeatures({});
const column = createColumnHelper<typeof features, BranchView>();
const NO_BRANCHES: BranchView[] = [];

export function BranchesListScreen() {
  const t = useT();
  const me = useMe();
  const queryClient = useQueryClient();
  const canManage = holds(me, 'system.branches.manage');
  const [showArchived, setShowArchived] = useState(false);
  const [archiving, setArchiving] = useState<BranchItem | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const branches = useApiQuery<BranchListResponse>({
    queryKey: ['branches', { includeArchived: showArchived }],
    path: showArchived ? 'branches?includeArchived=true' : 'branches',
  });

  const archive = async (branch: BranchItem): Promise<void> => {
    await api('DELETE', `branches/${encodeURIComponent(branch.id)}`);
    setNotice(t('branches.done.archived', { name: branch.name }));
    await queryClient.invalidateQueries({ queryKey: ['branches'] });
  };

  const columns = useMemo(() => {
    const base = [
      column.accessor('code', {
        header: t('branches.col.code'),
        cell: (info) => {
          const branch = info.row.original;
          return (
            <span className="flex flex-wrap items-center gap-2">
              {canManage ? (
                <Link
                  to={`/admin/branches/${encodeURIComponent(branch.id)}`}
                  className="font-medium text-primary underline-offset-4 hover:underline"
                >
                  {branch.code}
                </Link>
              ) : (
                <span className="font-medium">{branch.code}</span>
              )}
              {branch.isDefault && <Badge tone="info">{t('branches.default')}</Badge>}
            </span>
          );
        },
      }),
      column.accessor('name', { header: t('branches.col.name') }),
      column.accessor('address', {
        header: t('branches.col.address'),
        cell: (info) => <span className="line-clamp-2 text-muted-foreground">{info.getValue() ?? '—'}</span>,
      }),
      column.accessor('timezone', { header: t('branches.col.timezone') }),
      column.accessor('archivedAt', {
        header: t('branches.col.status'),
        cell: (info) => {
          if (info.getValue() !== null) return <Badge tone="neutral">{t('branches.archived')}</Badge>;
          return <Badge tone="info">{t('branches.active')}</Badge>;
        },
      }),
    ];
    if (!canManage) return column.columns(base);
    return column.columns([
      ...base,
      column.display({
        id: 'actions',
        header: t('table.actions'),
        cell: (info) => {
          const branch = info.row.original;
          return (
            <div className="flex flex-wrap gap-1">
              <Button asChild variant="outline" size="sm">
                <Link to={`/admin/branches/${encodeURIComponent(branch.id)}`}>{t('branches.action.edit')}</Link>
              </Button>
              {!branch.isDefault && branch.archivedAt === null && (
                <Button variant="outline" size="sm" onClick={() => setArchiving(branch)}>
                  {t('branches.action.archive')}
                </Button>
              )}
            </div>
          );
        },
      }),
    ]);
  }, [t, canManage]);

  const table = useTable({ features, columns, data: branches.data?.items ?? NO_BRANCHES, getRowId: (branch) => branch.id });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">{t('nav.branches')}</h1>
        {canManage && (
          <Button asChild>
            <Link to="/admin/branches/new">
              <PlusIcon aria-hidden="true" />
              {t('branches.add')}
            </Link>
          </Button>
        )}
      </div>
      <CheckField label={t('branches.show_archived')} checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
      {notice !== null && <Notice kind="success">{notice}</Notice>}
      {branches.isError ? (
        <Notice
          kind="error"
          action={
            <Button variant="outline" size="sm" onClick={() => void branches.refetch()}>
              {t('table.retry')}
            </Button>
          }
        >
          {problemText(t, branches.error)}
        </Notice>
      ) : branches.data === undefined ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t('shell.loading')}
        </p>
      ) : (
        <DataTable table={table} caption={t('branches.caption')} empty={t('branches.empty')} />
      )}
      {archiving !== null && (
        <ConfirmDialog
          open
          destructive
          title={t('branches.confirm.archive.title', { name: archiving.name })}
          description={t('branches.confirm.archive.body')}
          confirmLabel={t('branches.action.archive')}
          onConfirm={() => archive(archiving)}
          onClose={() => setArchiving(null)}
        />
      )}
    </div>
  );
}
