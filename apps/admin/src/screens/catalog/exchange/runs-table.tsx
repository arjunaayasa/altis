import { RUN_KINDS, vocabKey, type RunKind } from '@altis/shared';
import type { RunListResponse, RunView } from '@altis/shared/api/catalog/runs';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { createColumnHelper, tableFeatures, useTable } from '@tanstack/react-table';
import { useMemo, useState } from 'react';
import { DataTable, useDateTime } from '@/components/data-table';
import { Badge, Field, ProblemAlert, SELECT_CLASS } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n';
import { holds } from '@/lib/access';
import { api } from '@/lib/api';
import { useMe } from '@/lib/me';
import { RUNS_KEY, RunStatusBadge, formatLabel, runHref } from './summary-view';

/**
 * Impor/Ekspor, Riwayat (Phase 2 spec §13; plan Task 29): the catalog runs, newest first (`GET catalog/runs`, keyset
 * pages of {@link PAGE_SIZE}, "Muat lagi"), optionally of one kind. A migration run is not listed to anyone without
 * `catalog.migration.run` (the server's rule, P2-27), so that kind is offered only to its holders. Each row opens the
 * run's page, which follows a run that has work ahead (its job's progress) and shows its summary, report and file;
 * a run started from this screen refreshes the list when its job ends.
 */

const PAGE_SIZE = 50;

const features = tableFeatures({});
const column = createColumnHelper<typeof features, RunView>();
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

  const columns = useMemo(
    () =>
      column.columns([
        column.display({
          id: 'kind',
          header: t('catalog.exchange.runs.col.kind'),
          cell: (info) => (
            <span className="flex flex-wrap items-center gap-1 whitespace-nowrap">
              {t(vocabKey('run_kind', info.row.original.kind))}
              {info.row.original.dryRun && <Badge>{t('catalog.exchange.runs.dry_run')}</Badge>}
            </span>
          ),
        }),
        column.display({ id: 'status', header: t('catalog.exchange.runs.col.status'), cell: (info) => <RunStatusBadge status={info.row.original.status} /> }),
        column.display({
          id: 'format',
          header: t('catalog.exchange.runs.col.format'),
          cell: (info) => <span className="whitespace-nowrap">{formatLabel(t, info.row.original) ?? ''}</span>,
        }),
        column.accessor('createdAt', {
          header: t('catalog.exchange.runs.col.created'),
          cell: (info) => (
            <time dateTime={new Date(info.getValue()).toISOString()} className="whitespace-nowrap">
              {dateTime(info.getValue())}
            </time>
          ),
        }),
        column.accessor('finishedAt', {
          header: t('catalog.exchange.runs.col.finished'),
          cell: (info) => {
            const at = info.getValue();
            return at === null ? '' : (
              <time dateTime={new Date(at).toISOString()} className="whitespace-nowrap">
                {dateTime(at)}
              </time>
            );
          },
        }),
        column.display({
          id: 'open',
          header: () => <span className="sr-only">{t('table.actions')}</span>,
          cell: (info) => {
            const r = info.row.original;
            return (
              <Link
                to={runHref(r.id)}
                aria-label={t('catalog.exchange.runs.open_label', { kind: t(vocabKey('run_kind', r.kind)), date: dateTime(r.createdAt) })}
                className="text-primary underline-offset-4 hover:underline"
              >
                {t('catalog.exchange.runs.open')}
              </Link>
            );
          },
        }),
      ]),
    [t, dateTime],
  );
  const table = useTable({ features, columns, data: rows, getRowId: (r) => r.id });

  return (
    <section aria-label={t('catalog.exchange.runs.title')} className="flex flex-col gap-3">
      <div className="max-w-xs">
        <Field label={t('catalog.exchange.runs.kind')}>
          {(c) => (
            <select {...c} className={SELECT_CLASS} value={kind} onChange={(e) => setKind(e.target.value as RunKind | '')}>
              <option value="">{t('catalog.exchange.runs.kind_all')}</option>
              {kinds.map((k) => (
                <option key={k} value={k}>
                  {t(vocabKey('run_kind', k))}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      {list.isError && list.data === undefined ? (
        <ProblemAlert error={list.error} />
      ) : list.data === undefined ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t('shell.loading')}
        </p>
      ) : (
        <>
          <DataTable table={table} caption={t('catalog.exchange.runs.caption')} empty={t('catalog.exchange.runs.empty')} />
          {list.isFetchNextPageError && <ProblemAlert error={list.error} />}
          {list.hasNextPage && (
            <div>
              <Button type="button" variant="outline" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                {t('catalog.exchange.runs.load_more')}
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
