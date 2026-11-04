import type { AuthorityKind, OrphansArchiveBody, OrphansArchiveResponse, OrphansResponse } from '@altis/shared/api/catalog/authorities';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { createColumnHelper, tableFeatures, useTable } from '@tanstack/react-table';
import { useMemo, useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { DataTable } from '@/components/data-table';
import { CheckField, Notice } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { problemText } from '@/lib/form-errors';
import { useMe } from '@/lib/me';
import { authorityHref, authorityKindKey, orphansKey, typeLabel } from './common';

/**
 * The orphans view of a tab of Otoritas (Phase 2 Task 26; spec §3.5 "Yatim", §13): the live authorities of the kind
 * that no record links to (`GET catalog/orphans?kind=`; a subject that stands in the thesaurus is not an orphan), and
 * their bulk archive (`POST catalog/orphans/archive`, one audit entry per request).
 *
 * - At most {@link MAX_SELECTED} ids go in one request (the API's limit): once that many are chosen the other boxes are
 *   disabled and a note says so; "Pilih semua" takes the first 500 shown.
 * - Only ids still shown are sent. The server archives the ones that are still orphans when it runs and skips the rest
 *   (a record may have started to use one meanwhile); the answer `{archived, skipped}` is shown, the selection
 *   cleared and the list read again.
 */

type Orphan = OrphansResponse['items'][number];

/** How many orphans one page holds (the API's largest page). */
const PAGE = 200;

/** The most ids one archive request takes (`OrphansArchiveBody`, spec §3.5). */
export const MAX_SELECTED = 500;

const features = tableFeatures({});
const column = createColumnHelper<typeof features, Orphan>();
const NO_ORPHANS: Orphan[] = [];

function orphansPath(kind: AuthorityKind, cursor: string | null): string {
  const q = new URLSearchParams({ kind, limit: String(PAGE) });
  if (cursor !== null) q.set('cursor', cursor);
  return `catalog/orphans?${q.toString()}`;
}

export function OrphansView({ kind, canManage }: { kind: AuthorityKind; canManage: boolean }) {
  const t = useT();
  const me = useMe();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<OrphansArchiveResponse | null>(null);

  const list = useInfiniteQuery({
    queryKey: orphansKey(kind),
    queryFn: ({ pageParam }) => api<OrphansResponse>('GET', orphansPath(kind, pageParam)),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    enabled: me !== undefined,
    refetchOnWindowFocus: false,
  });

  const items = useMemo(() => list.data?.pages.flatMap((page) => page.items) ?? NO_ORPHANS, [list.data]);
  /** The chosen ids that are shown, in the list's order: what an archive sends. */
  const chosen = useMemo(() => items.filter((o) => selected.has(o.id)).map((o) => o.id), [items, selected]);
  const full = chosen.length >= MAX_SELECTED;
  const allShown = Math.min(items.length, MAX_SELECTED);
  const allChosen = chosen.length > 0 && chosen.length === allShown;

  const toggle = (id: string, on: boolean): void => {
    setResult(null);
    setSelected((before) => {
      const next = new Set(before);
      if (on) {
        if (items.filter((o) => next.has(o.id)).length < MAX_SELECTED) next.add(id);
      } else next.delete(id);
      return next;
    });
  };
  const toggleAll = (on: boolean): void => {
    setResult(null);
    setSelected(on ? new Set(items.slice(0, MAX_SELECTED).map((o) => o.id)) : new Set());
  };

  const archive = async (): Promise<void> => {
    const body: OrphansArchiveBody = { kind, ids: chosen.slice(0, MAX_SELECTED) };
    const answer = await api<OrphansArchiveResponse>('POST', 'catalog/orphans/archive', body);
    setResult(answer);
    setSelected(new Set());
    await Promise.all([queryClient.invalidateQueries({ queryKey: orphansKey(kind) }), queryClient.invalidateQueries({ queryKey: authorityKindKey(kind) })]);
  };

  const columns = useMemo(() => {
    const label = column.accessor('label', {
      header: t(kind === 'subjects' ? 'catalog.authorities.col.term' : 'catalog.authorities.col.name'),
      cell: (info) => (
        <Link to={authorityHref(kind, info.row.original.id)} className="font-medium text-primary underline-offset-4 hover:underline">
          {info.getValue()}
        </Link>
      ),
    });
    const type = column.accessor('type', { header: t('catalog.authorities.col.type'), cell: (info) => typeLabel(t, info.getValue()) ?? '—' });
    const shown = kind === 'publishers' ? [label] : [label, type];
    if (!canManage) return column.columns(shown);
    const pick = column.display({
      id: 'select',
      header: () => <span className="sr-only">{t('catalog.authorities.orphans.col.select')}</span>,
      cell: (info) => {
        const o = info.row.original;
        const on = selected.has(o.id);
        return (
          <input
            type="checkbox"
            aria-label={t('catalog.authorities.orphans.select', { name: o.label })}
            className="size-4 accent-primary disabled:cursor-not-allowed disabled:opacity-50"
            checked={on}
            disabled={!on && full}
            onChange={(e) => toggle(o.id, e.target.checked)}
          />
        );
      },
    });
    return column.columns([pick, ...shown]);
    // The cells read the selection, its limit and (through `toggle`) the orphans shown.
  }, [t, kind, canManage, selected, full, items]);

  const table = useTable({ features, columns, data: items, getRowId: (o) => o.id });

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">{t('catalog.authorities.orphans.description')}</p>
      {result !== null && <Notice kind="success">{t('catalog.authorities.orphans.done', { archived: result.archived, skipped: result.skipped })}</Notice>}
      {list.isError && list.data === undefined ? (
        <Notice
          kind="error"
          action={
            <Button variant="outline" size="sm" onClick={() => void list.refetch()}>
              {t('table.retry')}
            </Button>
          }
        >
          {problemText(t, list.error)}
        </Notice>
      ) : list.data === undefined ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t('shell.loading')}
        </p>
      ) : (
        <>
          {canManage && items.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-3">
              <CheckField label={t('catalog.authorities.orphans.select_all')} checked={allChosen} onChange={(e) => toggleAll(e.target.checked)} />
              <div className="flex flex-wrap items-center gap-3">
                <span role="status" className="text-sm tabular-nums">
                  {t('catalog.authorities.orphans.selected', { count: chosen.length })}
                </span>
                <Button variant="destructive" disabled={chosen.length === 0} onClick={() => setConfirming(true)}>
                  {t('catalog.authorities.orphans.archive')}
                </Button>
              </div>
              {full && <p className="w-full text-sm text-muted-foreground">{t('catalog.authorities.orphans.limit')}</p>}
            </div>
          )}
          <DataTable table={table} caption={t('catalog.authorities.orphans.caption')} empty={t('catalog.authorities.orphans.empty')} />
          {list.isFetchNextPageError && <Notice kind="error">{problemText(t, list.error)}</Notice>}
          {list.hasNextPage && (
            <Button variant="outline" className="self-start" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
              {t(list.isFetchingNextPage ? 'shell.loading' : 'catalog.authorities.load_more')}
            </Button>
          )}
        </>
      )}
      {confirming && (
        <ConfirmDialog
          open
          destructive
          title={t('catalog.authorities.orphans.confirm.title', { count: chosen.length })}
          description={t('catalog.authorities.orphans.confirm.body')}
          confirmLabel={t('catalog.authorities.orphans.confirm.action')}
          onConfirm={archive}
          onClose={() => setConfirming(false)}
        />
      )}
    </div>
  );
}
