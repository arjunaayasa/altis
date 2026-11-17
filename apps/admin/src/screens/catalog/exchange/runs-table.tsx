import { RUN_KINDS, vocabKey, type RunKind } from '@altis/shared';
import type { RunListResponse, RunView } from '@altis/shared/api/catalog/runs';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useId, useMemo, useState } from 'react';
import { useDateTime } from '@/components/data-table';
import { Badge, SELECT_CLASS } from '@/components/form-field';
import { DenseTable, ErrorState, FilterField, FilterRow, PageError, SkeletonTable, type DenseColumn } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n';
import { holds } from '@/lib/access';
import { api } from '@/lib/api';
import { useMe } from '@/lib/me';
import { RUNS_KEY, RUN_LINK, RunStatusBadge, formatLabel, runHref } from './summary-view';

/**
 * Impor/Ekspor, Riwayat (Phase 2 spec §13; plan Task 29): the catalog runs, newest first (`GET catalog/runs`, keyset
 * pages of {@link PAGE_SIZE}, "Muat lagi"), optionally of one kind. A migration run is not listed to anyone without
 * `catalog.migration.run` (the server's rule, P2-27), so that kind is offered only to its holders. Each row opens the
 * run's page, which follows a run that has work ahead (its job's progress) and shows its summary, report and file;
 * a run started from this screen refreshes the list when its job ends.
 */

const PAGE_SIZE = 50;

const NO_ROWS: RunView[] = [];

/** `GET catalog/runs` for `kind` from `cursor`. */
function listPath(kind: RunKind | '', cursor: string | null): string {
  const q = new URLSearchParams();
  if (kind !== '') q.set('kind', kind);
  q.set('limit', String(PAGE_SIZE));
  if (cursor !== null) q.set('cursor', cursor);
  return `catalog/runs?${q.toString()}`;
}

/** The runs table (see the top of this file). */
export function RunsTable() {
  const t = useT();
  const me = useMe();
  const dateTime = useDateTime();
  const ids = useId();
  const [kind, setKind] = useState<RunKind | ''>('');
  const kinds = RUN_KINDS.filter((k) => k !== 'migration' || holds(me, 'catalog.migration.run'));

  const list = useInfiniteQuery({
    queryKey: [...RUNS_KEY, 'list', { kind }],
    queryFn: ({ pageParam }) => api<RunListResponse>('GET', listPath(kind, pageParam)),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: me !== undefined,
  });
  const rows = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? NO_ROWS, [list.data]);

  const time = (at: number) => (
    <time dateTime={new Date(at).toISOString()} className="whitespace-nowrap">
      {dateTime(at)}
    </time>
  );
  const columns: DenseColumn<RunView>[] = [
    {
      id: 'kind',
      header: t('catalog.exchange.runs.col.kind'),
      cell: (r) => (
        <span className="flex flex-wrap items-center gap-1.5 whitespace-nowrap">
          {t(vocabKey('run_kind', r.kind))}
          {r.dryRun && <Badge>{t('catalog.exchange.runs.dry_run')}</Badge>}
        </span>
      ),
    },
    { id: 'status', header: t('catalog.exchange.runs.col.status'), cell: (r) => <RunStatusBadge status={r.status} /> },
    { id: 'format', header: t('catalog.exchange.runs.col.format'), className: 'whitespace-nowrap', cell: (r) => formatLabel(t, r) ?? '' },
    { id: 'created', header: t('catalog.exchange.runs.col.created'), cell: (r) => time(r.createdAt) },
    { id: 'finished', header: t('catalog.exchange.runs.col.finished'), cell: (r) => (r.finishedAt === null ? '' : time(r.finishedAt)) },
    {
      id: 'open',
      header: <span className="sr-only">{t('table.actions')}</span>,
      className: 'text-right whitespace-nowrap',
      cell: (r) => (
        <Link
          to={runHref(r.id)}
          aria-label={t('catalog.exchange.runs.open_label', { kind: t(vocabKey('run_kind', r.kind)), date: dateTime(r.createdAt) })}
          className={RUN_LINK}>
          {t('catalog.exchange.runs.open')}
        </Link>
      ),
    },
  ];

  return (
    <section aria-label={t('catalog.exchange.runs.title')} className="grid gap-5">
      <FilterRow label={t('catalog.exchange.runs.filters')}>
        <FilterField id={`${ids}-kind`} label={t('catalog.exchange.runs.kind')} className="max-w-xs">
          <select id={`${ids}-kind`} className={SELECT_CLASS} value={kind} onChange={(e) => setKind(e.target.value as RunKind | '')}>
            <option value="">{t('catalog.exchange.runs.kind_all')}</option>
            {kinds.map((k) => (
              <option key={k} value={k}>
                {t(vocabKey('run_kind', k))}
              </option>
            ))}
          </select>
        </FilterField>
      </FilterRow>
      {list.isError && list.data === undefined ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />
      ) : list.data === undefined ? (
        <SkeletonTable label={t('shell.loading')} columns={columns.length} />
      ) : (
        <div className="grid gap-3">
          <DenseTable caption={t('catalog.exchange.runs.caption')} columns={columns} rows={rows} rowKey={(r) => r.id} empty={t('catalog.exchange.runs.empty')} />
          {list.isFetchNextPageError && <PageError error={list.error} />}
          {list.hasNextPage && (
            <Button type="button" variant="outline" className="w-fit" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
              {t('catalog.exchange.runs.load_more')}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
