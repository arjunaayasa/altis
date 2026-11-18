import { isUlid } from '@altis/shared';
import { EXPORT_RECORD_IDS_MAX } from '@altis/shared/api/catalog/exchange';
import type { MasterListResponse, MaterialTypeView } from '@altis/shared/api/catalog/masters';
import { RECORD_BULK_MAX, RECORD_SORTS, type RecordCountsResponse, type RecordListItem, type RecordListResponse, type RecordSort } from '@altis/shared/api/catalog/records';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { SearchIcon } from 'lucide-react';
import { useId, useMemo, useRef, useState } from 'react';
import { AddToPrintQueue } from '@/components/catalog/print-queue';
import { useDateTime } from '@/components/data-table';
import { Badge, Field, Notice, ProblemAlert } from '@/components/form-field';
import {
  Card,
  ChipButton,
  ChipSelect,
  ChipToggle,
  DenseTable,
  EmptyState,
  ErrorState,
  FilterTabs,
  PageHead,
  SelectionBar,
  SkeletonTable,
  TableToolbar,
  type DenseColumn,
  type FilterTab,
} from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useLocale, useT, type Translate } from '@/i18n';
import { holds } from '@/lib/access';
import { api } from '@/lib/api';
import { useApiQuery, useMe } from '@/lib/me';
import { RecordBulkPanel } from './bulk-dialog';

/**
 * Bibliografi, the record list (Phase 2 spec §13, §4.4, §4.5; plan Task 24): `GET catalog/records`.
 *
 * - The search (the syntax of §4.4) and the filters (material type, OPAC visibility, archived, items, the change
 *   range as local days) live in the URL search params, so a list can be bookmarked, shared and gone back to. The
 *   list's query key is those filters ({@link RecordsSearch}); a change navigates, and the list follows the URL.
 * - The saved views are tabs above the card, each with the number of records it lists (`GET catalog/records/counts`,
 *   `views`; no number while it is not known). The filters are chips in the card's toolbar: one in use shows its value.
 * - Paging: a search (with `q`, or the newest-first order) pages by `page` (≤ 50, top 1 000; §4.5), the other orders
 *   by the server's keyset `cursor`; both load more rows below ("Muat lagi"). The foot says how many rows are loaded
 *   and of how many ("Menampilkan 50 dari 1.234 cantuman"): a search carries its total, the other orders read it from
 *   `GET catalog/records/counts` (`total`, for the filters in use); while it is not known, only the rows loaded.
 * - Selected rows go to the label print queue (`AddToPrintQueue`, records) or to "Ekspor terpilih" (M2): at most
 *   {@link EXPORT_SELECTION_MAX} ids (the `ExportBody` limit) are stored in `sessionStorage` under
 *   {@link EXPORT_SELECTION_KEY} as JSON `{ids, archived}` (`archived`: an archived record is among them, so the export
 *   form includes archived records by default), and Impor/Ekspor opens with `?export=selection`; 1 000 ULIDs (about
 *   28 KB) would pass the common URL and header limits, so they never travel in the URL. A storage that is blocked or
 *   full shows a notice instead. The selection belongs to the filters it was made under: another search starts empty.
 * - "Ubah data akreditasi" (for a user who manages records) sets the accreditation fields of the selected records at
 *   once, in its panel under the selection bar ({@link RecordBulkPanel}, at most {@link RECORD_BULK_MAX}).
 */

/** Where "Ekspor terpilih" leaves the selected ids for Impor/Ekspor (Task 29 reads it once, then clears it). */
export const EXPORT_SELECTION_KEY = 'altis.exportSelection';

/** The most ids one export takes (`ExportBody.filter.recordIds`). */
export const EXPORT_SELECTION_MAX = EXPORT_RECORD_IDS_MAX;

/**
 * Stores `ids` for Impor/Ekspor (M2), with `archived` when an archived record is among them: `too_many` above
 * {@link EXPORT_SELECTION_MAX} (nothing stored), `blocked` when the browser refuses `sessionStorage` (a private
 * window, a policy, a full quota).
 */
export function storeExportSelection(ids: readonly string[], archived = false): 'stored' | 'too_many' | 'blocked' {
  if (ids.length > EXPORT_SELECTION_MAX) return 'too_many';
  try {
    sessionStorage.setItem(EXPORT_SELECTION_KEY, JSON.stringify({ ids, archived }));
    return 'stored';
  } catch {
    return 'blocked';
  }
}

/** The list's search params: the filters as the URL keeps them (dates as local `YYYY-MM-DD` days). */
export interface RecordsSearch {
  q?: string;
  materialTypeId?: string;
  hidden?: 'only' | 'exclude';
  archived?: true;
  hasItems?: boolean;
  changedFrom?: string;
  changedTo?: string;
  sort?: RecordSort;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** `RecordListQuery.q` is at most 500 characters. */
const Q_MAX = 500;
/** Rows per request. */
const PAGE_SIZE = 50;
/** A search pages to 50 pages at most (§4.5). */
const SEARCH_PAGES_MAX = 50;
/** A search counts its total up to 10 000 (§4.5). */
const TOTAL_CAP = 10_000;

/**
 * The search params of the list, from what the router parsed (it reads `true`, `false` and numbers as JSON): anything
 * unknown or malformed is dropped, so a hand-written URL never reaches the server as a 422.
 */
export function parseRecordsSearch(raw: Record<string, unknown>): RecordsSearch {
  const out: RecordsSearch = {};
  // A hand-written `?q=2005` or `?q=true` comes back from the router as a number or a boolean: still a search text.
  const rawQ = raw['q'];
  const q = typeof rawQ === 'string' || typeof rawQ === 'number' || typeof rawQ === 'boolean' ? String(rawQ).trim() : '';
  if (q !== '') out.q = q.slice(0, Q_MAX);
  const type = raw['materialTypeId'];
  if (typeof type === 'string' && isUlid(type)) out.materialTypeId = type;
  const hidden = raw['hidden'];
  if (hidden === 'only' || hidden === 'exclude') out.hidden = hidden;
  if (raw['archived'] === true || raw['archived'] === 'true') out.archived = true;
  const hasItems = raw['hasItems'];
  if (hasItems === true || hasItems === 'true') out.hasItems = true;
  if (hasItems === false || hasItems === 'false') out.hasItems = false;
  for (const key of ['changedFrom', 'changedTo'] as const) {
    const day = raw[key];
    if (typeof day === 'string' && DAY.test(day)) out[key] = day;
  }
  const sort = raw['sort'];
  if (typeof sort === 'string' && (RECORD_SORTS as readonly string[]).includes(sort)) out.sort = sort as RecordSort;
  return out;
}

/** Epoch ms of a local day's first (`start`) or last (`end`) millisecond; undefined for no or a bad day. */
function dayBound(day: string | undefined, edge: 'start' | 'end'): number | undefined {
  if (day === undefined) return undefined;
  const ms = new Date(`${day}T${edge === 'start' ? '00:00:00' : '23:59:59.999'}`).getTime();
  return Number.isNaN(ms) ? undefined : ms;
}

/** Which page to load: the first, a search page, or the page after a keyset cursor. */
type PageParam = null | { page: number } | { cursor: string };

/** `GET catalog/records` for `s` and `page`, its parameters in a fixed order. */
function listPath(s: RecordsSearch, page: PageParam): string {
  const q = new URLSearchParams();
  if (s.q !== undefined) q.set('q', s.q);
  if (s.materialTypeId !== undefined) q.set('materialTypeId', s.materialTypeId);
  if (s.hidden !== undefined) q.set('hidden', s.hidden);
  if (s.archived === true) q.set('archived', 'true');
  if (s.hasItems !== undefined) q.set('hasItems', String(s.hasItems));
  const from = dayBound(s.changedFrom, 'start');
  if (from !== undefined) q.set('changedFrom', String(from));
  const to = dayBound(s.changedTo, 'end');
  if (to !== undefined) q.set('changedTo', String(to));
  if (s.sort !== undefined) q.set('sort', s.sort);
  q.set('limit', String(PAGE_SIZE));
  if (page !== null && 'cursor' in page) q.set('cursor', page.cursor);
  if (page !== null && 'page' in page) q.set('page', String(page.page));
  return `catalog/records?${q.toString()}`;
}

/** `GET catalog/records/counts` for the filters of `s` (no search text, no order). */
function countsPath(s: RecordsSearch): string {
  const q = new URLSearchParams();
  if (s.materialTypeId !== undefined) q.set('materialTypeId', s.materialTypeId);
  if (s.hidden !== undefined) q.set('hidden', s.hidden);
  if (s.archived === true) q.set('archived', 'true');
  if (s.hasItems !== undefined) q.set('hasItems', String(s.hasItems));
  const from = dayBound(s.changedFrom, 'start');
  if (from !== undefined) q.set('changedFrom', String(from));
  const to = dayBound(s.changedTo, 'end');
  if (to !== undefined) q.set('changedTo', String(to));
  const query = q.toString();
  return query === '' ? 'catalog/records/counts' : `catalog/records/counts?${query}`;
}

/** The page after `last`: by cursor, or the next search page while there are more (and not past page 50). */
function nextPage(last: RecordListResponse): PageParam | undefined {
  if (last.nextCursor !== null) return { cursor: last.nextCursor };
  if (last.page === null || last.total === null) return undefined;
  const shown = last.page * PAGE_SIZE;
  return shown < Math.min(last.total, SEARCH_PAGES_MAX * PAGE_SIZE) && last.page < SEARCH_PAGES_MAX ? { page: last.page + 1 } : undefined;
}

/** `s` without its undefined keys (the query key and the URL hold only what is set). */
function compact(s: RecordsSearch): RecordsSearch {
  return Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined)) as RecordsSearch;
}

/** The orders offered: relevance only with a search text; the default first. */
function sortsFor(q: string | undefined): RecordSort[] {
  return q === undefined ? ['changed', 'newest', 'title'] : ['relevance', 'newest', 'title'];
}

const NO_ROWS: RecordListItem[] = [];
const NO_SELECTION: ReadonlyMap<string, RecordListItem> = new Map();

/** The material type's name in the UI language. */
function typeName(t: Translate, types: readonly MaterialTypeView[] | undefined, id: string, locale: string): string {
  const type = types?.find((m) => m.id === id);
  if (type === undefined) return t('catalog.records.unknown_type');
  return locale === 'en' ? type.nameEn : type.nameId;
}

/** `/admin/catalog/records`. */
export function RecordsListScreen() {
  const t = useT();
  const me = useMe();
  const locale = useLocale();
  const dateTime = useDateTime();
  const navigate = useNavigate();
  const search = compact(parseRecordsSearch(useSearch({ strict: false })));
  const searchKey = JSON.stringify(search);
  const canManage = holds(me, 'catalog.records.manage');
  const canExport = holds(me, 'catalog.export.run');
  const canImport = holds(me, 'catalog.import.run');
  const [selection, setSelection] = useState<{ key: string; rows: ReadonlyMap<string, RecordListItem> }>({ key: searchKey, rows: NO_SELECTION });
  const [notice, setNotice] = useState<'too_many' | 'blocked' | null>(null);
  const [panel, setPanel] = useState<string | null>(null);
  // The search box keeps its own text until "Cari" (or Enter) puts it in the URL; a new URL search starts it afresh.
  const [typed, setTyped] = useState<{ key: string; text: string }>({ key: search.q ?? '', text: search.q ?? '' });
  const selectAll = useRef<HTMLInputElement>(null);
  const selected = selection.key === searchKey ? selection.rows : NO_SELECTION;
  const text = typed.key === (search.q ?? '') ? typed.text : (search.q ?? '');

  const types = useApiQuery<MasterListResponse<MaterialTypeView>>({
    queryKey: ['catalog', 'material-types', { includeArchived: true }],
    path: 'catalog/material-types?includeArchived=true',
    staleTime: 60_000,
  });

  const list = useInfiniteQuery({
    queryKey: ['catalog', 'records', 'list', search],
    queryFn: ({ pageParam }) => api<RecordListResponse>('GET', listPath(search, pageParam)),
    initialPageParam: null as PageParam,
    getNextPageParam: nextPage,
    enabled: me !== undefined,
    // Every loaded page would be read again: a list being read does not change under the reader's eyes.
    refetchOnWindowFocus: false,
  });
  // The numbers of the views and of the filters in use; the search text and the order do not change them.
  const countsFilters = compact({ ...search, q: undefined, sort: undefined });
  const counts = useApiQuery<RecordCountsResponse>({
    queryKey: ['catalog', 'records', 'counts', countsFilters],
    path: countsPath(countsFilters),
    staleTime: 30_000,
  });
  const rangeId = useId();
  const rows = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? NO_ROWS, [list.data]);
  const first = list.data?.pages[0];
  const last = list.data?.pages.at(-1);

  const update = (patch: Partial<Record<keyof RecordsSearch, unknown>>): void => {
    setNotice(null);
    // From the latest search, not this render's: two changes in a row both land.
    void navigate({ to: '/admin/catalog/records', search: (prev: Record<string, unknown>) => compact(parseRecordsSearch({ ...prev, ...patch })) });
  };
  const clearFilters = (): void => void navigate({ to: '/admin/catalog/records', search: {} });

  const setRows = (next: ReadonlyMap<string, RecordListItem>): void => {
    setNotice(null);
    if (next.size === 0) setPanel(null);
    setSelection({ key: searchKey, rows: next });
  };
  const toggle = (row: RecordListItem, on: boolean): void => {
    const next = new Map(selected);
    if (on) next.set(row.id, row);
    else next.delete(row.id);
    setRows(next);
  };
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const toggleAll = (on: boolean): void => {
    const next = new Map(selected);
    for (const r of rows) {
      if (on) next.set(r.id, r);
      else next.delete(r.id);
    }
    setRows(next);
  };

  const exportSelected = (): void => {
    const result = storeExportSelection([...selected.keys()], [...selected.values()].some((r) => r.archived));
    if (result !== 'stored') {
      setNotice(result);
      return;
    }
    void navigate({ to: '/admin/catalog/exchange', search: { export: 'selection' } });
  };

  const columns: DenseColumn<RecordListItem>[] = [
    {
      id: 'select',
      headClassName: 'w-px',
      header: (
        <input
          ref={selectAll}
          type="checkbox"
          aria-label={t('catalog.records.list.select_all')}
          className="size-4 align-middle accent-primary"
          checked={allSelected}
          disabled={rows.length === 0}
          onChange={(e) => toggleAll(e.target.checked)}
        />
      ),
      cell: (r) => (
        <input
          type="checkbox"
          aria-label={t('catalog.records.list.select_row', { title: r.title })}
          className="size-4 align-middle accent-primary"
          checked={selected.has(r.id)}
          onChange={(e) => toggle(r, e.target.checked)}
        />
      ),
    },
    {
      id: 'cover',
      headClassName: 'w-px',
      header: <span className="sr-only">{t('catalog.records.col.cover')}</span>,
      cell: (r) =>
        r.coverFileId === null ? (
          <span className="block h-8 w-6 rounded-sm border bg-layer-2" title={t('catalog.records.list.no_cover')} />
        ) : (
          <img src={`/files/${encodeURIComponent(r.coverFileId)}`} alt="" loading="lazy" width={24} height={32} className="h-8 w-6 rounded-sm border object-cover" />
        ),
    },
    {
      id: 'title',
      header: t('catalog.records.col.title_only'),
      cell: (r) => (
        <span className="flex min-w-48 flex-wrap items-center gap-x-2 gap-y-0.5">
          <Link to={`/admin/catalog/records/${encodeURIComponent(r.id)}`} className="font-semibold text-foreground underline-offset-4 hover:text-accent-text hover:underline">
            {r.title}
          </Link>
          {r.subtitle !== null && <span className="text-muted-foreground">{r.subtitle}</span>}
          {r.archived && <Badge tone="warning">{t('catalog.records.badge.archived')}</Badge>}
          {!r.opacVisible && <Badge>{t('catalog.records.badge.hidden')}</Badge>}
        </span>
      ),
    },
    { id: 'author', header: t('catalog.records.col.author'), cell: (r) => r.mainAgent ?? '' },
    { id: 'type', header: t('catalog.records.col.type'), className: 'whitespace-nowrap', cell: (r) => typeName(t, types.data?.items, r.materialTypeId, locale) },
    { id: 'year', header: t('catalog.records.col.year'), cell: (r) => r.year ?? '' },
    { id: 'call', header: t('catalog.records.col.call_number'), className: 'font-mono text-meta whitespace-nowrap', cell: (r) => r.callNumber ?? '' },
    { id: 'items', header: t('catalog.records.col.items'), className: 'text-right', headClassName: 'text-right', cell: (r) => r.itemCount },
    {
      id: 'changed',
      header: t('catalog.records.col.changed'),
      cell: (r) => (
        <time dateTime={new Date(r.changedAt).toISOString()} className="whitespace-nowrap">
          {dateTime(r.changedAt)}
        </time>
      ),
    },
  ];

  const sorts = sortsFor(search.q);
  const sort = search.sort !== undefined && sorts.includes(search.sort) ? search.sort : sorts[0];
  const number = new Intl.NumberFormat(locale === 'en' ? 'en-GB' : 'id-ID');
  const searchMode = first !== undefined && first.page !== null;
  const atPageLimit = searchMode && last !== undefined && last.page === SEARCH_PAGES_MAX && (last.total ?? 0) > SEARCH_PAGES_MAX * PAGE_SIZE;
  const filtered = Object.keys(search).length > 0;
  const filterCount = Object.keys(search).filter((k) => k !== 'sort').length;
  const q = search.q;
  const nothingAtAll = !filtered && list.data !== undefined && rows.length === 0 && !list.hasNextPage;
  const typeLabel = (m: MaterialTypeView): string => (locale === 'en' ? m.nameEn : m.nameId);
  const clearButton = (
    <Button type="button" variant="link" className="h-auto p-0" onClick={clearFilters}>
      {t('catalog.records.filter.clear')}
    </Button>
  );

  // The saved views: each is one filter of the address on its own, so a view and the filter row never disagree.
  const view = Object.keys(search).every((k) => k === 'sort')
    ? 'all'
    : search.hasItems === false && filterCount === 1
      ? 'no_items'
      : search.hidden === 'only' && filterCount === 1
        ? 'hidden'
        : search.archived === true && filterCount === 1
          ? 'archived'
          : '';
  const viewCounts = counts.data?.views;
  const views: FilterTab[] = [
    { id: 'all', label: t('catalog.records.view.all'), count: viewCounts?.all, to: '/admin/catalog/records' },
    { id: 'no_items', label: t('catalog.records.filter.items_no'), count: viewCounts?.no_items, to: '/admin/catalog/records', search: { hasItems: false } },
    { id: 'hidden', label: t('catalog.records.view.hidden'), count: viewCounts?.hidden, to: '/admin/catalog/records', search: { hidden: 'only' } },
    { id: 'archived', label: t('catalog.records.view.archived'), count: viewCounts?.archived, to: '/admin/catalog/records', search: { archived: true } },
  ];

  // How many records the list holds in all: a search says so itself, the other orders ask the counts.
  const total = searchMode ? (first.total ?? undefined) : q === undefined ? counts.data?.total : undefined;
  const day = new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
  const dayText = (d: string): string => {
    const at = new Date(`${d}T00:00:00`);
    return Number.isNaN(at.getTime()) ? d : day.format(at);
  };
  const range =
    search.changedFrom !== undefined && search.changedTo !== undefined
      ? t('catalog.records.filter.changed_range', { from: dayText(search.changedFrom), to: dayText(search.changedTo) })
      : search.changedFrom !== undefined
        ? t('catalog.records.filter.changed_since', { from: dayText(search.changedFrom) })
        : search.changedTo !== undefined
          ? t('catalog.records.filter.changed_until', { to: dayText(search.changedTo) })
          : null;

  return (
    <div className="grid gap-4">
      <PageHead
        title={t('catalog.records.list.title')}
        intro={t('catalog.records.list.intro')}
        actions={
          canManage || canImport ? (
            <>
              {canImport && (
                <Button asChild variant="outline">
                  <Link to="/admin/catalog/exchange">{t('catalog.records.list.import')}</Link>
                </Button>
              )}
              {canManage && (
                <Button asChild>
                  <Link to="/admin/catalog/records/new">{t('catalog.records.list.new')}</Link>
                </Button>
              )}
            </>
          ) : undefined
        }
      />

      <FilterTabs label={t('catalog.records.view.label')} value={view} items={views} />

      <Card>
        <form
          noValidate
          aria-label={t('catalog.records.list.filters')}
          onSubmit={(e) => {
            e.preventDefault();
            update({ q: text.trim() === '' ? undefined : text });
          }}>
          <TableToolbar label={t('catalog.records.list.filters')} actions={filtered ? clearButton : undefined}>
            <div role="search" className="flex min-w-0 flex-[1_1_280px] gap-2">
              <span className="relative min-w-0 flex-1">
                <SearchIcon aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  type="search"
                  aria-label={t('catalog.records.list.search_label')}
                  aria-describedby={`${rangeId}-hint`}
                  placeholder={t('catalog.records.list.search_placeholder')}
                  maxLength={Q_MAX}
                  autoComplete="off"
                  spellCheck={false}
                  className="pl-8"
                  value={text}
                  onChange={(e) => setTyped({ key: search.q ?? '', text: e.target.value })}
                />
              </span>
              <Button type="submit" variant="outline">
                {t('catalog.records.list.search_button')}
              </Button>
            </div>
            <ChipSelect
              label={t('catalog.records.filter.type')}
              value={search.materialTypeId ?? ''}
              onChange={(v) => update({ materialTypeId: v === '' ? undefined : v })}
              options={[
                { value: '', label: t('catalog.records.filter.type_all') },
                ...(types.data?.items ?? []).map((m) => ({ value: m.id, label: m.archived ? t('catalog.records.field.archived_option', { name: typeLabel(m) }) : typeLabel(m) })),
              ]}
            />
            <ChipSelect
              label={t('catalog.records.filter.hidden')}
              value={search.hidden ?? ''}
              onChange={(v) => update({ hidden: v === '' ? undefined : v })}
              options={[
                { value: '', label: t('catalog.records.filter.hidden_all') },
                { value: 'only', label: t('catalog.records.filter.hidden_only') },
                { value: 'exclude', label: t('catalog.records.filter.hidden_exclude') },
              ]}
            />
            <ChipSelect
              label={t('catalog.records.filter.items')}
              value={search.hasItems === undefined ? '' : String(search.hasItems)}
              onChange={(v) => update({ hasItems: v === '' ? undefined : v })}
              options={[
                { value: '', label: t('catalog.records.filter.items_all') },
                { value: 'true', label: t('catalog.records.filter.items_yes') },
                { value: 'false', label: t('catalog.records.filter.items_no') },
              ]}
            />
            <Popover>
              <PopoverTrigger asChild>
                <ChipButton on={range !== null}>{range ?? t('catalog.records.filter.changed')}</ChipButton>
              </PopoverTrigger>
              <PopoverContent align="start" aria-labelledby={`${rangeId}-title`} className="grid gap-3">
                <p id={`${rangeId}-title`} className="font-semibold">
                  {t('catalog.records.filter.changed_title')}
                </p>
                <Field label={t('catalog.records.filter.changed_from')}>
                  {(c) => <Input {...c} type="date" value={search.changedFrom ?? ''} onChange={(e) => update({ changedFrom: e.target.value === '' ? undefined : e.target.value })} />}
                </Field>
                <Field label={t('catalog.records.filter.changed_to')}>
                  {(c) => <Input {...c} type="date" value={search.changedTo ?? ''} onChange={(e) => update({ changedTo: e.target.value === '' ? undefined : e.target.value })} />}
                </Field>
                {range !== null && (
                  <Button type="button" variant="link" className="h-auto justify-self-start p-0" onClick={() => update({ changedFrom: undefined, changedTo: undefined })}>
                    {t('catalog.records.filter.changed_clear')}
                  </Button>
                )}
              </PopoverContent>
            </Popover>
            <ChipToggle checked={search.archived === true} onChange={(on) => update({ archived: on ? true : undefined })}>
              {t('catalog.records.filter.archived')}
            </ChipToggle>
            <ChipSelect
              label={t('catalog.records.filter.sort')}
              value={sort ?? ''}
              on={false}
              showValue
              onChange={(v) => update({ sort: v === sorts[0] ? undefined : v })}
              options={sorts.map((o) => ({ value: o, label: t(`catalog.records.sort.${o}`) }))}
            />
          </TableToolbar>
          <p id={`${rangeId}-hint`} className="-mt-1 px-4 pb-3 text-meta text-muted-foreground">
            {t('catalog.records.list.search_hint')}
          </p>
          <button type="submit" className="sr-only" tabIndex={-1}>
            {t('table.filter_apply')}
          </button>
        </form>

      {list.isError && list.data === undefined ? (
        <div className="p-4">
          <ErrorState error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />
        </div>
      ) : list.data === undefined ? (
        <SkeletonTable label={t('shell.loading')} columns={8} />
      ) : nothingAtAll ? (
        <EmptyState
          title={t('catalog.records.list.empty_all')}
          actions={
            canManage || canImport ? (
              <>
                {canManage && (
                  <Button asChild>
                    <Link to="/admin/catalog/records/new">{t('catalog.records.list.new')}</Link>
                  </Button>
                )}
                {canImport && (
                  <Button asChild variant="outline">
                    <Link to="/admin/catalog/exchange">{t('catalog.records.list.import')}</Link>
                  </Button>
                )}
              </>
            ) : undefined
          }>
          <p>{t('catalog.records.list.empty_all_hint')}</p>
        </EmptyState>
      ) : (
        <>
          <SelectionBar
            count={selected.size}
            label={t('catalog.records.list.selected', { count: number.format(selected.size) })}
            actions={canManage && selected.size <= RECORD_BULK_MAX ? [{ id: 'accred', label: t('catalog.records.list.accred_bulk') }] : []}
            open={panel}
            onOpenChange={setPanel}
            onClear={() => setRows(NO_SELECTION)}
            clearLabel={t('catalog.records.list.clear_selection')}
            focusAfter={selectAll}
            extra={
              <>
                <AddToPrintQueue entries={[...selected.values()].map((r) => ({ kind: 'record' as const, id: r.id, label: r.title }))} />
                {canExport && (
                  <Button type="button" size="sm" variant="ghost" onClick={exportSelected}>
                    {t('catalog.records.list.export_selected')}
                  </Button>
                )}
                {canManage && selected.size > RECORD_BULK_MAX && (
                  <>
                    <Button type="button" size="sm" variant="ghost" disabled>
                      {t('catalog.records.list.accred_bulk')}
                    </Button>
                    <span className="w-full text-meta text-muted-foreground">{t('catalog.records.list.accred_bulk_too_many', { max: number.format(RECORD_BULK_MAX) })}</span>
                  </>
                )}
              </>
            }>
            {panel === 'accred' && <RecordBulkPanel records={[...selected.values()]} onClose={() => setPanel(null)} />}
            {notice === 'too_many' && <Notice kind="error">{t('catalog.records.list.export_too_many', { max: number.format(EXPORT_SELECTION_MAX) })}</Notice>}
            {notice === 'blocked' && <Notice kind="error">{t('catalog.records.list.export_blocked')}</Notice>}
          </SelectionBar>
          <DenseTable
            caption={t('catalog.records.list.caption')}
            columns={columns}
            rows={rows}
            rowKey={(r) => r.id}
            rowClassName={(r) => (selected.has(r.id) ? 'bg-accent-soft' : undefined)}
            empty={
              <span className="flex flex-wrap items-center gap-2">
                {t('catalog.records.list.empty')}
                {filtered && clearButton}
              </span>
            }
          />
          {list.isFetchNextPageError && (
            <div className="border-t p-4">
              <ProblemAlert error={list.error} />
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-2.5">
            <p className="text-meta text-muted-foreground" data-list-count="">
              {total === undefined
                ? t('catalog.records.list.shown', { count: number.format(rows.length) })
                : searchMode && total >= TOTAL_CAP
                  ? t('catalog.records.list.showing_many', { shown: number.format(rows.length), count: number.format(TOTAL_CAP) })
                  : t('catalog.records.list.showing', { shown: number.format(rows.length), count: number.format(Math.max(total, rows.length)) })}
            </p>
            {list.hasNextPage && (
              <Button type="button" variant="outline" size="sm" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                {t('catalog.records.list.load_more')}
              </Button>
            )}
          </div>
          {atPageLimit && <p className="border-t px-4 py-2.5 text-meta text-muted-foreground">{t('catalog.records.list.page_limit', { count: number.format(SEARCH_PAGES_MAX * PAGE_SIZE) })}</p>}
        </>
      )}
      </Card>
    </div>
  );
}
