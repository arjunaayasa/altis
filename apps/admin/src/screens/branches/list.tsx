import type { BranchItem, BranchListResponse, BranchView } from '@altis/shared/api/branches';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { createColumnHelper, tableFeatures, useTable } from '@tanstack/react-table';
import { useMemo, useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { DataTable } from '@/components/data-table';
import { CheckField, Notice } from '@/components/form-field';
import { ErrorState, FilterRow, MoreMenu, MoreMenuItem, MoreMenuRule, PageHead, SkeletonTable, Tag } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n';
import { holds } from '@/lib/access';
import { api } from '@/lib/api';
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
  const navigate = useNavigate();
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
                <Link to={`/admin/branches/${encodeURIComponent(branch.id)}`} className="font-semibold text-accent-text underline-offset-4 hover:underline">
                  {branch.code}
                </Link>
              ) : (
                <span className="font-semibold">{branch.code}</span>
              )}
              {branch.isDefault && <Tag>{t('branches.default')}</Tag>}
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
          if (info.getValue() !== null) return <Tag>{t('branches.archived')}</Tag>;
          return <Tag tone="ok">{t('branches.active')}</Tag>;
        },
      }),
    ];
    if (!canManage) return column.columns(base);
    return column.columns([
      ...base,
      column.display({
        id: 'actions',
        header: () => <span className="sr-only">{t('table.actions')}</span>,
        cell: (info) => {
          const branch = info.row.original;
          return (
            <MoreMenu small label={t('branches.more_named', { name: branch.name })}>
              <MoreMenuItem onSelect={() => void navigate({ to: `/admin/branches/${encodeURIComponent(branch.id)}` })}>{t('branches.action.edit')}</MoreMenuItem>
              {!branch.isDefault && branch.archivedAt === null && (
                <>
                  <MoreMenuRule />
                  <MoreMenuItem danger onSelect={() => setArchiving(branch)}>
                    {t('branches.action.archive')}
                  </MoreMenuItem>
                </>
              )}
            </MoreMenu>
          );
        },
      }),
    ]);
  }, [t, canManage, navigate]);

  const table = useTable({ features, columns, data: branches.data?.items ?? NO_BRANCHES, getRowId: (branch) => branch.id });

  return (
    <div className="grid gap-6">
      <PageHead
        title={t('nav.branches')}
        intro={t('branches.intro')}
        actions={
          canManage ? (
            <Button asChild>
              <Link to="/admin/branches/new">{t('branches.add')}</Link>
            </Button>
          ) : undefined
        }
      />
      {notice !== null && <Notice kind="success">{notice}</Notice>}
      <FilterRow label={t('branches.filters')}>
        <CheckField label={t('branches.show_archived')} checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
      </FilterRow>
      {branches.isError && branches.data === undefined ? (
        <ErrorState error={branches.error} onRetry={() => void branches.refetch()} retrying={branches.isFetching} />
      ) : branches.data === undefined ? (
        <SkeletonTable label={t('shell.loading')} columns={canManage ? 6 : 5} rows={3} />
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
