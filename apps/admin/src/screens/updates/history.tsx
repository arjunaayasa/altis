import type { ReleaseLogView, UpdateHistoryResponse } from '@altis/shared/api/updates';
import { useInfiniteQuery } from '@tanstack/react-query';
import { createColumnHelper, tableFeatures, useTable } from '@tanstack/react-table';
import { useMemo, type ReactNode } from 'react';
import { DataTable, useDateTime } from '@/components/data-table';
import { ErrorState, SideSection, SkeletonTable, Tag, type TagTone } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { useT, type Translate } from '@/i18n';
import { api } from '@/lib/api';
import { useMe } from '@/lib/me';

/**
 * "Riwayat" of Pembaruan (spec §13.3, §9.6 step 7 "catat di `releases_log`"; 1d Task 30): `GET updates/history`, the
 * `releases_log` rows newest first, a page at a time ("Muat lebih banyak" sends the previous page's `nextBefore`).
 * Each row: when it started, the action (the shared `ops.kind.update` / `ops.kind.rollback`), the versions it went
 * from and to, its status (the shared `ops.state.<status>`), when it ended, and the `pre_update` backup it made.
 */

/** The React Query key of the history (Pembaruan reads it again on a `system.update` hint that is not progress). */
export const UPDATES_HISTORY_KEY = ['updates-history'] as const;

/** The `releases_log` statuses (ReleaseLogView.status), each with its badge tone. */
const STATUS_TONE: Readonly<Record<string, TagTone>> = Object.freeze({
  running: 'neutral',
  done: 'ok',
  aborted: 'warn',
  rolled_back: 'warn',
  restored: 'warn',
  restore_failed: 'bad',
  failed: 'bad',
});

const ACTIONS: ReadonlySet<string> = new Set(['update', 'rollback']);

const own = (table: object, key: string): boolean => Object.prototype.hasOwnProperty.call(table, key);

/** The label of a row's action: the op kind it was, or the word as written for one this build does not know. */
function actionText(t: Translate, action: string): string {
  return ACTIONS.has(action) ? t(`ops.kind.${action as 'update' | 'rollback'}`) : action;
}

/** The label of a row's status: the op state it ended in, or the word as written for one this build does not know. */
function statusText(t: Translate, status: string): string {
  return own(STATUS_TONE, status) ? t(`ops.state.${status as 'done'}`) : status;
}

const features = tableFeatures({});
const column = createColumnHelper<typeof features, ReleaseLogView>();
const NO_ITEMS: ReleaseLogView[] = [];

/** The history section. */
export function UpdateHistory() {
  const t = useT();
  const me = useMe();
  const dateTime = useDateTime();
  const history = useInfiniteQuery({
    queryKey: UPDATES_HISTORY_KEY,
    queryFn: ({ pageParam }) =>
      api<UpdateHistoryResponse>('GET', pageParam === null ? 'updates/history' : `updates/history?before=${encodeURIComponent(pageParam)}`),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextBefore,
    enabled: me !== undefined,
  });
  const items = useMemo(() => history.data?.pages.flatMap((p) => p.items) ?? NO_ITEMS, [history.data]);

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('startedAt', {
          header: t('updates.history.started'),
          cell: (info) => (
            <time dateTime={new Date(info.getValue()).toISOString()} className="whitespace-nowrap">
              {dateTime(info.getValue())}
            </time>
          ),
        }),
        column.accessor('action', {
          header: t('updates.history.action'),
          cell: (info) => actionText(t, info.getValue()),
        }),
        column.accessor('version', {
          header: t('updates.history.version'),
          cell: (info) => {
            const row = info.row.original;
            return (
              <span translate="no" className="font-mono whitespace-nowrap">
                {row.fromVersion === null ? row.version : t('updates.history.versions', { from: row.fromVersion, to: row.version })}
              </span>
            );
          },
        }),
        column.accessor('status', {
          header: t('updates.history.status'),
          cell: (info) => {
            const status = info.getValue();
            return <Tag tone={own(STATUS_TONE, status) ? STATUS_TONE[status] : 'neutral'}>{statusText(t, status)}</Tag>;
          },
        }),
        column.accessor('finishedAt', {
          header: t('updates.history.finished'),
          cell: (info) => {
            const at = info.getValue();
            return at === null ? (
              '—'
            ) : (
              <time dateTime={new Date(at).toISOString()} className="whitespace-nowrap">
                {dateTime(at)}
              </time>
            );
          },
        }),
        column.accessor('backupId', {
          header: t('updates.history.backup'),
          cell: (info) => {
            const id = info.getValue();
            return id === null ? (
              '—'
            ) : (
              <span translate="no" className="font-mono text-xs break-all">
                {id}
              </span>
            );
          },
        }),
      ]),
    [t, dateTime],
  );

  const table = useTable({ features, columns, data: items, getRowId: (item) => item.id });

  let content: ReactNode;
  if (history.data === undefined) {
    content = history.isError ? (
      <ErrorState error={history.error} onRetry={() => void history.refetch()} retrying={history.isFetching} />
    ) : (
      <SkeletonTable label={t('shell.loading')} columns={6} rows={3} />
    );
  } else {
    content = <DataTable table={table} caption={t('updates.history.caption')} empty={t('updates.history.empty')} />;
  }

  return (
    <SideSection title={t('updates.history.title')}>
      {content}
      {history.hasNextPage && (
        <div>
          <Button type="button" variant="outline" size="sm" disabled={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>
            {t('updates.history.more')}
          </Button>
        </div>
      )}
    </SideSection>
  );
}
