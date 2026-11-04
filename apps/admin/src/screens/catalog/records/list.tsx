import { isUlid } from '@altis/shared';
import { EXPORT_RECORD_IDS_MAX } from '@altis/shared/api/catalog/exchange';
import type { MasterListResponse, MaterialTypeView } from '@altis/shared/api/catalog/masters';
import { RECORD_SORTS, type RecordListItem, type RecordListResponse, type RecordSort } from '@altis/shared/api/catalog/records';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { createColumnHelper, tableFeatures, useTable } from '@tanstack/react-table';
import { BookIcon, DownloadIcon, PlusIcon, SearchIcon } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { AddToPrintQueue } from '@/components/catalog/print-queue';
import { DataTable, useDateTime } from '@/components/data-table';
import { Badge, CheckField, Field, Notice, ProblemAlert, SELECT_CLASS } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useLocale, useT, type Translate } from '@/i18n';
import { holds } from '@/lib/access';
import { api } from '@/lib/api';
import { useApiQuery, useMe } from '@/lib/me';

/**
 * Bibliografi, the record list (Phase 2 spec §13, §4.4, §4.5; plan Task 24): `GET catalog/records`.
 *
 * - The search (the syntax of §4.4) and the filters (material type, OPAC visibility, archived, items, the change
 *   range as local days) live in the URL search params, so a list can be bookmarked, shared and gone back to. The
 *   list's query key is those filters ({@link RecordsSearch}); a change navigates, and the list follows the URL.
 * - Paging: a search (with `q`, or the newest-first order) pages by `page` (≤ 50, top 1 000; §4.5), the other orders
 *   by the server's keyset `cursor`; both load more rows below ("Muat lagi").
 * - Selected rows go to the label print queue (`AddToPrintQueue`, records) or to "Ekspor terpilih" (M2): at most
 *   {@link EXPORT_SELECTION_MAX} ids (the `ExportBody` limit) are stored in `sessionStorage` under
 *   {@link EXPORT_SELECTION_KEY} as JSON `{ids, archived}` (`archived`: an archived record is among them, so the export
 *   form includes archived records by default), and Impor/Ekspor opens with `?export=selection`; 1 000 ULIDs (about
 *   28 KB) would pass the common URL and header limits, so they never travel in the URL. A storage that is blocked or
 *   full shows a notice instead. The selection belongs to the filters it was made under: another search starts empty.
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

const features = tableFeatures({});
const column = createColumnHelper<typeof features, RecordListItem>();
const NO_ROWS: RecordListItem[] = [];
const NO_SELECTION: ReadonlyMap<string, RecordListItem> = new Map();

/** The material type's name in the UI language. */
function typeName(t: Translate, types: readonly MaterialTypeView[] | undefined, id: string, locale: string): string {
  const type = types?.find((m) => m.id === id);
  if (type === undefined) return t('catalog.records.unknown_type');
  return locale === 'en' ? type.nameEn : type.nameId;
}

/** The search box: its own text until "Cari" puts it in the URL. */
function SearchBox({ initial, onSearch }: { initial: string; onSearch(q: string): void }) {
  const t = useT();
  const [text, setText] = useState(initial);
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    onSearch(text);
  };
  return (
    <form role="search" noValidate className="flex flex-col gap-2" onSubmit={submit}>
      <Field label={t('catalog.records.list.search_label')} hint={t('catalog.records.list.search_hint')}>
        {(c) => (
          <div className="flex gap-2">
            <Input {...c} type="search" maxLength={Q_MAX} autoComplete="off" spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} />
            <Button type="submit">
              <SearchIcon aria-hidden="true" />
              {t('catalog.records.list.search_button')}
            </Button>
          </div>
        )}
      </Field>
    </form>
  );
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
  const [selection, setSelection] = useState<{ key: string; rows: ReadonlyMap<string, RecordListItem> }>({ key: searchKey, rows: NO_SELECTION });
  const [notice, setNotice] = useState<'too_many' | 'blocked' | null>(null);
  const selected = selection.key === searchKey ? selection.rows : NO_SELECTION;

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
  const rows = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? NO_ROWS, [list.data]);
  const first = list.data?.pages[0];
  const last = list.data?.pages.at(-1);

  const update = (patch: Partial<Record<keyof RecordsSearch, unknown>>): void => {
    setNotice(null);
    // From the latest search, not this render's: two changes in a row both land.
    void navigate({ to: '/admin/catalog/records', search: (prev: Record<string, unknown>) => compact(parseRecordsSearch({ ...prev, ...patch })) });
  };

  const toggle = (row: RecordListItem, on: boolean): void => {
    setNotice(null);
    const next = new Map(selected);
    if (on) next.set(row.id, row);
    else next.delete(row.id);
    setSelection({ key: searchKey, rows: next });
  };
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const toggleAll = (on: boolean): void => {
    setNotice(null);
    const next = new Map(selected);
    for (const r of rows) {
      if (on) next.set(r.id, r);
      else next.delete(r.id);
    }
    setSelection({ key: searchKey, rows: next });
  };

  const exportSelected = (): void => {
    const result = storeExportSelection([...selected.keys()], [...selected.values()].some((r) => r.archived));
    if (result !== 'stored') {
      setNotice(result);
      return;
    }
    void navigate({ to: '/admin/catalog/exchange', search: { export: 'selection' } });
  };

  const columns = useMemo(
    () =>
      column.columns([
        column.display({
          id: 'select',
          header: () => (
            <input
              type="checkbox"
              aria-label={t('catalog.records.list.select_all')}
              className="size-4 accent-primary"
              checked={allSelected}
              disabled={rows.length === 0}
              onChange={(e) => toggleAll(e.target.checked)}
            />
          ),
          cell: (info) => (
            <input
              type="checkbox"
              aria-label={t('catalog.records.list.select_row', { title: info.row.original.title })}
              className="size-4 accent-primary"
              checked={selected.has(info.row.original.id)}
              onChange={(e) => toggle(info.row.original, e.target.checked)}
            />
          ),
        }),
        column.display({
          id: 'cover',
          header: () => <span className="sr-only">{t('catalog.records.col.cover')}</span>,
          cell: (info) =>
            info.row.original.coverFileId === null ? (
              <span className="flex h-12 w-9 items-center justify-center rounded border bg-muted text-muted-foreground" title={t('catalog.records.list.no_cover')}>
                <BookIcon className="size-4" aria-hidden="true" />
              </span>
            ) : (
              <img
                src={`/files/${encodeURIComponent(info.row.original.coverFileId)}`}
                alt=""
                loading="lazy"
                width={36}
                height={48}
                className="h-12 w-9 rounded border object-cover"
              />
            ),
        }),
        column.display({
          id: 'title',
          header: t('catalog.records.col.title'),
          cell: (info) => {
            const r = info.row.original;
            return (
              <span className="flex min-w-48 flex-col gap-0.5">
                <Link to={`/admin/catalog/records/${encodeURIComponent(r.id)}`} className="font-medium text-primary underline-offset-4 hover:underline">
                  {r.title}
                </Link>
                {r.subtitle !== null && <span className="text-muted-foreground">{r.subtitle}</span>}
                {r.mainAgent !== null && <span className="text-muted-foreground">{r.mainAgent}</span>}
                {(r.archived || !r.opacVisible) && (
                  <span className="flex flex-wrap gap-1">
                    {r.archived && <Badge tone="warning">{t('catalog.records.badge.archived')}</Badge>}
                    {!r.opacVisible && <Badge>{t('catalog.records.badge.hidden')}</Badge>}
                  </span>
                )}
              </span>
            );
          },
        }),
        column.display({
          id: 'type',
          header: t('catalog.records.col.type'),
          cell: (info) => <span className="whitespace-nowrap">{typeName(t, types.data?.items, info.row.original.materialTypeId, locale)}</span>,
        }),
        column.accessor('year', { header: t('catalog.records.col.year'), cell: (info) => info.getValue() ?? '' }),
        column.accessor('callNumber', {
          header: t('catalog.records.col.call_number'),
          cell: (info) => <span className="font-mono text-xs whitespace-nowrap">{info.getValue() ?? ''}</span>,
        }),
        column.accessor('itemCount', {
          header: t('catalog.records.col.items'),
          cell: (info) => <span className="tabular-nums">{info.getValue()}</span>,
        }),
        column.accessor('changedAt', {
          header: t('catalog.records.col.changed'),
          cell: (info) => (
            <time dateTime={new Date(info.getValue()).toISOString()} className="whitespace-nowrap">
              {dateTime(info.getValue())}
            </time>
          ),
        }),
      ]),
    // toggle and toggleAll read the selection, the rows and the search key: all deps here.
    [t, dateTime, locale, types.data, selected, rows, allSelected, searchKey],
  );

  const table = useTable({ features, columns, data: rows, getRowId: (r) => r.id });

  const sorts = sortsFor(search.q);
  const sort = search.sort !== undefined && sorts.includes(search.sort) ? search.sort : sorts[0];
  const number = new Intl.NumberFormat(locale === 'en' ? 'en-GB' : 'id-ID');
  const searchMode = first !== undefined && first.page !== null;
  const atPageLimit = searchMode && last !== undefined && last.page === SEARCH_PAGES_MAX && (last.total ?? 0) > SEARCH_PAGES_MAX * PAGE_SIZE;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">{t('catalog.records.list.title')}</h1>
        {canManage && (
          <Button asChild>
            <Link to="/admin/catalog/records/new">
              <PlusIcon aria-hidden="true" />
              {t('catalog.records.list.new')}
            </Link>
          </Button>
        )}
      </div>

      <SearchBox key={search.q ?? ''} initial={search.q ?? ''} onSearch={(q) => update({ q: q.trim() === '' ? undefined : q })} />

      <section aria-label={t('catalog.records.list.filters')} className="grid gap-4 rounded-lg border bg-card p-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label={t('catalog.records.filter.type')}>
          {(c) => (
            <select {...c} className={SELECT_CLASS} value={search.materialTypeId ?? ''} onChange={(e) => update({ materialTypeId: e.target.value === '' ? undefined : e.target.value })}>
              <option value="">{t('catalog.records.filter.type_all')}</option>
              {(types.data?.items ?? []).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.archived ? t('catalog.records.field.archived_option', { name: locale === 'en' ? m.nameEn : m.nameId }) : locale === 'en' ? m.nameEn : m.nameId}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label={t('catalog.records.filter.hidden')}>
          {(c) => (
            <select {...c} className={SELECT_CLASS} value={search.hidden ?? ''} onChange={(e) => update({ hidden: e.target.value === '' ? undefined : e.target.value })}>
              <option value="">{t('catalog.records.filter.hidden_all')}</option>
              <option value="only">{t('catalog.records.filter.hidden_only')}</option>
              <option value="exclude">{t('catalog.records.filter.hidden_exclude')}</option>
            </select>
          )}
        </Field>
        <Field label={t('catalog.records.filter.items')}>
          {(c) => (
            <select
              {...c}
              className={SELECT_CLASS}
              value={search.hasItems === undefined ? '' : String(search.hasItems)}
              onChange={(e) => update({ hasItems: e.target.value === '' ? undefined : e.target.value })}
            >
              <option value="">{t('catalog.records.filter.items_all')}</option>
              <option value="true">{t('catalog.records.filter.items_yes')}</option>
              <option value="false">{t('catalog.records.filter.items_no')}</option>
            </select>
          )}
        </Field>
        <Field label={t('catalog.records.filter.sort')}>
          {(c) => (
            <select {...c} className={SELECT_CLASS} value={sort} onChange={(e) => update({ sort: e.target.value === sorts[0] ? undefined : e.target.value })}>
              {sorts.map((s) => (
                <option key={s} value={s}>
                  {t(`catalog.records.sort.${s}`)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label={t('catalog.records.filter.changed_from')}>
          {(c) => <Input {...c} type="date" value={search.changedFrom ?? ''} onChange={(e) => update({ changedFrom: e.target.value === '' ? undefined : e.target.value })} />}
        </Field>
        <Field label={t('catalog.records.filter.changed_to')}>
          {(c) => <Input {...c} type="date" value={search.changedTo ?? ''} onChange={(e) => update({ changedTo: e.target.value === '' ? undefined : e.target.value })} />}
        </Field>
        <CheckField
          className="self-end"
          label={t('catalog.records.filter.archived')}
          checked={search.archived === true}
          onChange={(e) => update({ archived: e.target.checked ? true : undefined })}
        />
        {Object.keys(search).length > 0 && (
          <div className="self-end">
            <Button type="button" variant="outline" onClick={() => void navigate({ to: '/admin/catalog/records', search: {} })}>
              {t('catalog.records.filter.clear')}
            </Button>
          </div>
        )}
      </section>

      {selected.size > 0 && (
        <section aria-label={t('catalog.records.list.selection_actions')} className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
          <span className="font-medium">{t('catalog.records.list.selected', { count: number.format(selected.size) })}</span>
          <AddToPrintQueue entries={[...selected.values()].map((r) => ({ kind: 'record' as const, id: r.id, label: r.title }))} />
          {canExport && (
            <Button type="button" size="sm" variant="outline" onClick={exportSelected}>
              <DownloadIcon aria-hidden="true" />
              {t('catalog.records.list.export_selected')}
            </Button>
          )}
          <Button type="button" size="sm" variant="ghost" onClick={() => setSelection({ key: searchKey, rows: NO_SELECTION })}>
            {t('catalog.records.list.clear_selection')}
          </Button>
        </section>
      )}
      {notice === 'too_many' && <Notice kind="error">{t('catalog.records.list.export_too_many', { max: number.format(EXPORT_SELECTION_MAX) })}</Notice>}
      {notice === 'blocked' && <Notice kind="error">{t('catalog.records.list.export_blocked')}</Notice>}

      {list.isError && list.data === undefined ? (
        <ProblemAlert error={list.error} />
      ) : list.data === undefined ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t('shell.loading')}
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {searchMode && first.total !== null && (
            <p className="text-sm text-muted-foreground">
              {first.total >= TOTAL_CAP
                ? t('catalog.records.list.total_many', { count: number.format(TOTAL_CAP) })
                : t('catalog.records.list.total', { count: number.format(first.total) })}
            </p>
          )}
          <DataTable table={table} caption={t('catalog.records.list.caption')} empty={t('catalog.records.list.empty')} />
          {list.isFetchNextPageError && <ProblemAlert error={list.error} />}
          {list.hasNextPage && (
            <div>
              <Button type="button" variant="outline" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                {t('catalog.records.list.load_more')}
              </Button>
            </div>
          )}
          {atPageLimit && <p className="text-sm text-muted-foreground">{t('catalog.records.list.page_limit', { count: number.format(SEARCH_PAGES_MAX * PAGE_SIZE) })}</p>}
        </div>
      )}
    </div>
  );
}
