import { PAGE_KINDS, PAGE_STATUSES, type PageKind, type PageStatus } from '@altis/shared';
import type { PageListItem, PageListResponse } from '@altis/shared/api/opac-pages';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { createColumnHelper, tableFeatures, useTable } from '@tanstack/react-table';
import { useId, useMemo, useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { DataTable, useDateTime } from '@/components/data-table';
import { Notice, ProblemAlert, RefetchProblem, SELECT_CLASS } from '@/components/form-field';
import { ErrorState, FilterField, FilterRow, MoreMenu, MoreMenuItem, MoreMenuRule, PageHead, SkeletonTable, Tag } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger, WRAPPING_TABS } from '@/components/ui/tabs';
import { useT } from '@/i18n';
import { holds } from '@/lib/access';
import { ApiError, api } from '@/lib/api';
import { useApiQuery, useMe } from '@/lib/me';
import { PAGES_KEY, kindOf, newPageTarget, opacPath, pageHref, pagesListHref } from './shared';

/**
 * Halaman & Berita, the list (Phase 2 spec §9.5, §13; plan Task 20): the live pages of one kind (`GET opac/pages?kind=`,
 * newest first, 50 at a time by the server's cursor), on a tab per kind (`?kind=news` in the address), optionally of
 * one status. Each row links to its editor and can be archived (`DELETE opac/pages/:id` with its version, after a
 * confirmation; the write answers `{id, version}` only, so the list is read again). A published page dated in the
 * future is marked scheduled. Every route needs `opac.pages.manage`: without it the screen says so and asks nothing.
 */

const features = tableFeatures({});
const column = createColumnHelper<typeof features, PageListItem>();
const NO_PAGES: PageListItem[] = [];

/** The status filter: one status, or every one. */
type StatusFilter = PageStatus | 'all';

/** The status tag of a row: draft, published, or published but dated in the future (scheduled). */
function StatusBadge({ page, now }: { page: PageListItem; now: number }) {
  const t = useT();
  if (page.status === 'draft') return <Tag>{t('vocab.page_status.draft')}</Tag>;
  if (page.publishedAt !== null && page.publishedAt > now) return <Tag tone="warn">{t('pages.scheduled')}</Tag>;
  return <Tag tone="ok">{t('vocab.page_status.published')}</Tag>;
}

/** The rows of one kind and status, paged by the server's cursor (a new kind or status starts again: see the key). */
function PagesTable({ kind, status }: { kind: PageKind; status: StatusFilter }) {
  const t = useT();
  const dateTime = useDateTime();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  /** The cursor of each sheet seen so far (the first has none); the last is the one shown. */
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [archiving, setArchiving] = useState<PageListItem | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const cursor = cursors[cursors.length - 1] ?? null;

  const query = new URLSearchParams({ kind });
  if (status !== 'all') query.set('status', status);
  if (cursor !== null) query.set('cursor', cursor);
  const list = useApiQuery<PageListResponse>({ queryKey: [...PAGES_KEY, 'list', { kind, status, cursor }], path: `opac/pages?${query.toString()}` });

  const archive = async (page: PageListItem): Promise<void> => {
    await api('DELETE', `opac/pages/${encodeURIComponent(page.id)}`, { version: page.version });
    setNotice(t('pages.archive.done', { title: page.title }));
    await queryClient.invalidateQueries({ queryKey: PAGES_KEY });
  };

  const columns = useMemo(() => {
    const now = Date.now();
    const titleOf = (page: PageListItem): string => (page.title === '' ? t('pages.untitled') : page.title);
    const yesNo = (value: boolean) => <span className={value ? undefined : 'text-muted-foreground'}>{t(value ? 'form.yes' : 'form.no')}</span>;
    return column.columns([
      column.accessor('title', {
        header: t('pages.col.title'),
        cell: (info) => (
          <Link to={pageHref(info.row.original.id)} className="font-semibold text-accent-text underline-offset-4 hover:underline">
            {titleOf(info.row.original)}
          </Link>
        ),
      }),
      column.accessor('slug', {
        header: t('pages.col.address'),
        cell: (info) => <span className="whitespace-nowrap text-muted-foreground">{opacPath(info.row.original.kind, info.getValue())}</span>,
      }),
      column.accessor('status', { header: t('pages.col.status'), cell: (info) => <StatusBadge page={info.row.original} now={now} /> }),
      column.accessor('publishedAt', {
        header: t('pages.col.published'),
        cell: (info) => {
          const at = info.getValue();
          return at === null ? <span className="text-muted-foreground">—</span> : <span className="whitespace-nowrap">{dateTime(at)}</span>;
        },
      }),
      column.accessor('showInNav', { header: t('pages.col.menu'), cell: (info) => yesNo(info.getValue()) }),
      column.accessor('hasEnglish', { header: t('pages.col.english'), cell: (info) => yesNo(info.getValue()) }),
      column.display({
        id: 'actions',
        header: () => <span className="sr-only">{t('table.actions')}</span>,
        cell: (info) => {
          const page = info.row.original;
          return (
            <MoreMenu small label={t('pages.action.more_named', { title: titleOf(page) })}>
              <MoreMenuItem aria-label={t('pages.action.edit_label', { title: titleOf(page) })} onSelect={() => void navigate({ to: pageHref(page.id) })}>
                {t('pages.action.edit')}
              </MoreMenuItem>
              <MoreMenuRule />
              <MoreMenuItem
                danger
                aria-label={t('pages.action.archive_label', { title: titleOf(page) })}
                onSelect={() => {
                  setNotice(null);
                  setArchiving(page);
                }}>
                {t('pages.action.archive')}
              </MoreMenuItem>
            </MoreMenu>
          );
        },
      }),
    ]);
  }, [t, dateTime, navigate]);

  const table = useTable({ features, columns, data: list.data?.items ?? NO_PAGES, getRowId: (page) => page.id });
  const sheet = cursors.length;
  const next = list.data?.nextCursor ?? null;

  return (
    <div className="grid gap-3">
      {notice !== null && <Notice kind="success">{notice}</Notice>}
      {list.data === undefined ? (
        list.isError ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />
        ) : (
          <SkeletonTable label={t('shell.loading')} rows={4} />
        )
      ) : (
        <>
          <RefetchProblem query={list} />
          <DataTable table={table} caption={t(`pages.caption.${kind}`)} empty={t(`pages.empty.${kind}`)} />
          {(sheet > 1 || next !== null) && (
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <p className="text-meta text-muted-foreground">{t('pages.paging', { page: sheet })}</p>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={sheet <= 1} onClick={() => setCursors((c) => c.slice(0, -1))}>
                  {t('table.prev')}
                </Button>
                <Button variant="outline" size="sm" disabled={next === null} onClick={() => next !== null && setCursors((c) => [...c, next])}>
                  {t('table.next')}
                </Button>
              </div>
            </div>
          )}
        </>
      )}
      <ConfirmDialog
        open={archiving !== null}
        destructive
        title={t('pages.archive.title', { title: archiving === null ? '' : archiving.title === '' ? t('pages.untitled') : archiving.title })}
        description={t('pages.archive.body')}
        confirmLabel={t('pages.action.archive')}
        onConfirm={async () => {
          if (archiving !== null) await archive(archiving);
        }}
        onClose={() => setArchiving(null)}
      />
    </div>
  );
}

export function PagesListScreen() {
  const t = useT();
  const me = useMe();
  const canManage = holds(me, 'opac.pages.manage');
  const navigate = useNavigate();
  const kind = kindOf(useSearch({ strict: false }));
  const [status, setStatus] = useState<StatusFilter>('all');
  const statusId = useId();

  return (
    <div className="grid gap-6">
      <PageHead
        title={t('nav.opac.pages')}
        intro={t('pages.description')}
        actions={
          canManage ? (
            <Button asChild>
              <Link {...newPageTarget(kind)}>{t(`pages.add.${kind}`)}</Link>
            </Button>
          ) : undefined
        }
      />
      {/* Every route of the area needs the permission: say so before anything is asked. */}
      {!canManage ? (
        <ProblemAlert error={new ApiError(403, 'AUTHZ_DENIED')} />
      ) : (
        <Tabs value={kind} onValueChange={(value) => void navigate({ href: pagesListHref(value as PageKind) })} className="gap-0">
          <TabsList aria-label={t('pages.kinds')} className={WRAPPING_TABS.list}>
            {PAGE_KINDS.map((k) => (
              <TabsTrigger key={k} value={k} className={WRAPPING_TABS.trigger}>
                {t(`vocab.page_kind.${k}`)}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value={kind} className="grid gap-3 pt-4">
            <FilterRow label={t('pages.filters')}>
              <FilterField id={statusId} label={t('pages.filter.status')} className="max-w-60">
                <select id={statusId} className={SELECT_CLASS} value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
                  <option value="all">{t('pages.filter.all')}</option>
                  {PAGE_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {t(`vocab.page_status.${s}`)}
                    </option>
                  ))}
                </select>
              </FilterField>
            </FilterRow>
            <PagesTable key={`${kind}:${status}`} kind={kind} status={status} />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
