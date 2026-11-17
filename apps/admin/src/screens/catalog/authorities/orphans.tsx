import type { AuthorityKind, OrphansArchiveBody, OrphansArchiveResponse, OrphansResponse } from '@altis/shared/api/catalog/authorities';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useMemo, useRef, useState, type FormEvent } from 'react';
import { Notice } from '@/components/form-field';
import { DenseTable, ErrorState, InlinePanel, PageError, SelectionBar, SkeletonTable, type DenseColumn } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { useMe } from '@/lib/me';
import { AUTHORITY_LINK, authorityHref, authorityKindKey, orphansKey, typeLabel } from './common';

/**
 * The orphans view of a tab of Otoritas (Phase 2 Task 26; spec §3.5 "Yatim", §13): the live authorities of the kind
 * that no record links to (`GET catalog/orphans?kind=`; a subject that stands in the thesaurus is not an orphan), and
 * their bulk archive (`POST catalog/orphans/archive`, one audit entry per request).
 *
 * - The selected orphans show a selection bar above the table; its "Arsipkan terpilih" opens a panel under the bar
 *   that asks in words before anything is archived.
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
  const [panel, setPanel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);
  const [result, setResult] = useState<OrphansArchiveResponse | null>(null);
  const selectAll = useRef<HTMLInputElement>(null);

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

  const archive = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (busy || chosen.length === 0) return;
    setBusy(true);
    setProblem(null);
    try {
      const body: OrphansArchiveBody = { kind, ids: chosen.slice(0, MAX_SELECTED) };
      const answer = await api<OrphansArchiveResponse>('POST', 'catalog/orphans/archive', body);
      setResult(answer);
      setPanel(null);
      setSelected(new Set());
      await Promise.all([queryClient.invalidateQueries({ queryKey: orphansKey(kind) }), queryClient.invalidateQueries({ queryKey: authorityKindKey(kind) })]);
    } catch (err) {
      setProblem(err);
    } finally {
      setBusy(false);
    }
  };
  const closePanel = (): void => {
    if (busy) return;
    setPanel(null);
    setProblem(null);
  };

  const label: DenseColumn<Orphan> = {
    id: 'label',
    header: t(kind === 'subjects' ? 'catalog.authorities.col.term' : 'catalog.authorities.col.name'),
    cell: (o) => (
      <Link to={authorityHref(kind, o.id)} className={AUTHORITY_LINK}>
        {o.label}
      </Link>
    ),
  };
  const type: DenseColumn<Orphan> = { id: 'type', header: t('catalog.authorities.col.type'), cell: (o) => typeLabel(t, o.type) ?? '—' };
  const pick: DenseColumn<Orphan> = {
    id: 'select',
    header: (
      <input
        ref={selectAll}
        type="checkbox"
        aria-label={t('catalog.authorities.orphans.select_all')}
        className="size-4 align-middle accent-primary"
        checked={allChosen}
        disabled={items.length === 0}
        onChange={(e) => toggleAll(e.target.checked)}
      />
    ),
    headClassName: 'w-px',
    cell: (o) => {
      const on = selected.has(o.id);
      return (
        <input
          type="checkbox"
          aria-label={t('catalog.authorities.orphans.select', { name: o.label })}
          className="size-4 align-middle accent-primary disabled:cursor-not-allowed disabled:opacity-50"
          checked={on}
          disabled={!on && full}
          onChange={(e) => toggle(o.id, e.target.checked)}
        />
      );
    },
  };
  const shown = kind === 'publishers' ? [label] : [label, type];
  const columns = canManage ? [pick, ...shown] : shown;

  return (
    <div className="grid gap-5">
      <p className="max-w-[75ch] text-sm text-muted-foreground">{t('catalog.authorities.orphans.description')}</p>
      {result !== null && <Notice kind="success">{t('catalog.authorities.orphans.done', { archived: result.archived, skipped: result.skipped })}</Notice>}
      {list.isError && list.data === undefined ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />
      ) : list.data === undefined ? (
        <SkeletonTable label={t('shell.loading')} columns={columns.length} />
      ) : (
        <div className="grid gap-3">
          {canManage && (
            <SelectionBar
              count={chosen.length}
              label={t('catalog.authorities.orphans.selected', { count: chosen.length })}
              actions={[{ id: 'archive', label: t('catalog.authorities.orphans.archive') }]}
              open={panel}
              onOpenChange={(id) => {
                setProblem(null);
                setPanel(id);
              }}
              onClear={() => {
                setPanel(null);
                setProblem(null);
                toggleAll(false);
              }}
              focusAfter={selectAll}>
              {full && <p className="text-meta text-muted-foreground">{t('catalog.authorities.orphans.limit')}</p>}
              {panel === 'archive' && (
                <InlinePanel title={t('catalog.authorities.orphans.confirm.title', { count: chosen.length })} onSubmit={(e) => void archive(e)} onCancel={closePanel}>
                  <p className="max-w-[75ch] text-sm">{t('catalog.authorities.orphans.confirm.body')}</p>
                  <PageError error={problem} />
                  <div className="flex flex-wrap gap-2">
                    <Button type="submit" size="sm" variant="destructive" disabled={busy}>
                      {t('catalog.authorities.orphans.confirm.action')}
                    </Button>
                    <Button type="button" size="sm" variant="outline" disabled={busy} onClick={closePanel}>
                      {t('form.cancel')}
                    </Button>
                  </div>
                </InlinePanel>
              )}
            </SelectionBar>
          )}
          <DenseTable
            caption={t('catalog.authorities.orphans.caption')}
            columns={columns}
            rows={items}
            rowKey={(o) => o.id}
            rowClassName={(o) => (selected.has(o.id) ? 'bg-accent-soft' : undefined)}
            empty={t('catalog.authorities.orphans.empty')}
          />
          {list.isFetchNextPageError && <PageError error={list.error} />}
          {list.hasNextPage && (
            <Button variant="outline" className="w-fit" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
              {t(list.isFetchingNextPage ? 'shell.loading' : 'catalog.authorities.load_more')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
