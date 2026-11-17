import { ITEM_STATUSES } from '@altis/shared';
import { ITEM_BULK_MAX, type ItemDetail, type ItemListItem, type ItemListResponse } from '@altis/shared/api/catalog/items';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { AddToPrintQueue } from '@/components/catalog/print-queue';
import { Badge, Field, Notice, SELECT_CLASS } from '@/components/form-field';
import { DenseTable, ErrorState, FilterField, FilterRow, PageHead, SelectionBar, SkeletonTable, type DenseColumn } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useT, type TKey } from '@/i18n';
import { ApiError, api } from '@/lib/api';
import { problemText } from '@/lib/form-errors';
import { useMe } from '@/lib/me';
import { useScannerInput } from '@/lib/scanner';
import { ItemStatusBadge } from '@/screens/circulation/common';
import { BulkPanel } from './bulk-dialog';
import {
  ITEMS_KEY,
  LocationOptions,
  branchLabel,
  fieldErrorsOf,
  invalidateAfterItemWrite,
  itemErrorKey,
  itemKey,
  locationPathLabel,
  useBranchLocations,
  useBranches,
  useCollectionTypeName,
  useCollectionTypes,
  useManagedBranches,
} from './item-form';
import { ITEMS_FILTER_KEYS, itemsSearchOf, type ItemsSearch } from './search';

/**
 * Eksemplar, the list (Phase 2 spec §13, §3.4; plan Task 25), `/admin/catalog/items`:
 *
 * - **Scan.** The field "Pindai atau ketik barkod" (Enter), and any scanner burst on the page (`useScannerInput`),
 *   look the barcode up with `GET catalog/items/by-barcode?barcode=` (M2: a query, so a barcode holding `/` travels as
 *   `%2F` and passes Apache's `AllowEncodedSlashes Off`) and open the item's page. The barcode goes as typed; the server
 *   normalises it (CR, LF and TAB removed, the ends trimmed, inner spaces collapsed to one, ASCII letters upper-cased).
 *   No such item, or a text that cannot be a barcode, is said at the field.
 * - **Filters** (in the URL, so the list comes back as it was): every branch for reading (`catalog.records.read` is
 *   global), a location of the chosen branch (its shelves included), the status and the collection type; a value
 *   that is not valid in the URL is ignored. `recordId` (from a record's items tab) narrows to one record.
 * - **The list**, by barcode, in keyset pages ("Muat lagi").
 * - **Selection** of the loaded rows: "Tambah ke antrean cetak" for anyone who may read (labels are printed with
 *   `catalog.records.read`), and "Ubah massal" ({@link BulkDialog}, ≤ {@link ITEM_BULK_MAX}) for a user who manages
 *   items at some branch, in its panel under the selection bar ({@link BulkPanel}). A filter change clears the selection.
 */

/** The query string of `filters` (fixed order), plus the page's cursor. */
function listPath(filters: ItemsSearch, cursor: string | null): string {
  const q = new URLSearchParams();
  for (const key of ITEMS_FILTER_KEYS) {
    const value = filters[key];
    if (value !== undefined) q.set(key, value);
  }
  q.set('limit', '50');
  if (cursor !== null) q.set('cursor', cursor);
  return `catalog/items?${q.toString()}`;
}

const NO_ITEMS: ItemListItem[] = [];

/** The scan field: Enter, the "Buka" button or a scanner burst anywhere on the page opens the item. */
function ScanField({ paused }: { paused: boolean }) {
  const t = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [fieldError, setFieldError] = useState<TKey | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const open = async (raw: string): Promise<void> => {
    if (raw.trim() === '' || busy) return;
    setFieldError(null);
    setNotice(null);
    setBusy(true);
    try {
      const found = await api<ItemDetail>('GET', `catalog/items/by-barcode?${new URLSearchParams({ barcode: raw }).toString()}`);
      queryClient.setQueryData(itemKey(found.id), found);
      await navigate({ href: `/admin/catalog/items/${encodeURIComponent(found.id)}` });
    } catch (e) {
      const onField = fieldErrorsOf(e).find((f) => f.path === 'barcode');
      if (onField !== undefined) setFieldError(itemErrorKey('barcode', onField.code));
      else if (e instanceof ApiError && e.status === 404) setNotice(t('catalog.items.scan.not_found', { barcode: raw.trim() }));
      else setNotice(problemText(t, e));
      input.current?.focus();
      input.current?.select();
    } finally {
      setBusy(false);
    }
  };

  // A barcode may be as short as 3 characters (spec §3.4: 3-64 printable ASCII), so a 3-key burst is a scan here too.
  useScannerInput({
    onScan: (code) => {
      if (paused) return;
      setValue(code);
      void open(code);
    },
    minLength: 3,
  });

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void open(value);
  };

  return (
    <form noValidate aria-label={t('catalog.items.scan.label')} className="grid max-w-2xl gap-3" onSubmit={submit}>
      <Field label={t('catalog.items.scan.label')} hint={t('catalog.items.scan.hint')} error={fieldError ?? undefined} className="min-w-0">
        {(c) => (
          <div className="flex gap-2">
            <Input
              {...c}
              ref={input}
              autoComplete="off"
              spellCheck={false}
              maxLength={200}
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setFieldError(null);
              }}
            />
            <Button type="submit" disabled={busy}>
              {t(busy ? 'catalog.items.scan.searching' : 'catalog.items.scan.open')}
            </Button>
          </div>
        )}
      </Field>
      {notice !== null && <Notice kind="error">{notice}</Notice>}
    </form>
  );
}

/** A change of filters: the values to set (`''` removes one), or null to remove them all. */
type FilterPatch = Partial<Record<keyof ItemsSearch, string>> | null;

/** The filter selects; each change goes to the URL at once. */
function Filters({ filters, onChange }: { filters: ItemsSearch; onChange(patch: FilterPatch): void }) {
  const t = useT();
  const branches = useBranches();
  const types = useCollectionTypes();
  const typeName = useCollectionTypeName();
  const locations = useBranchLocations(filters.branchId ?? null);
  const set = (patch: Partial<Record<keyof ItemsSearch, string>>): void => onChange(patch);
  const any = Object.keys(filters).length > 0;
  return (
    // The location's hint stands under its select: the filters line up by their labels, the actions by the controls.
    <FilterRow
      label={t('catalog.items.filters')}
      className="items-start"
      actions={
        filters.recordId !== undefined || any ? (
          <span className="flex min-h-8.5 flex-wrap items-center gap-2 sm:mt-6">
            {filters.recordId !== undefined && <span className="text-meta text-muted-foreground">{t('catalog.items.filter.record')}</span>}
            <Button type="button" variant="link" className="h-auto p-0" onClick={() => onChange(null)}>
              {t('catalog.items.filter.reset')}
            </Button>
          </span>
        ) : undefined
      }>
      <FilterField label={t('catalog.items.filter.branch')}>
        {(c) => (
          <select {...c} className={SELECT_CLASS} value={filters.branchId ?? ''} onChange={(e) => set({ branchId: e.target.value, locationId: '' })}>
            <option value="">{t('catalog.items.filter.branch_all')}</option>
            {(branches.data?.items ?? []).map((b) => (
              <option key={b.id} value={b.id}>
                {branchLabel(t, b)}
              </option>
            ))}
          </select>
        )}
      </FilterField>
      <FilterField label={t('catalog.items.filter.location')} hint={filters.branchId === undefined ? t('catalog.items.filter.location_hint') : undefined}>
        {(c) => (
          <select {...c} className={SELECT_CLASS} disabled={filters.branchId === undefined} value={filters.locationId ?? ''} onChange={(e) => set({ locationId: e.target.value })}>
            <option value="">{t('catalog.items.filter.location_all')}</option>
            <LocationOptions locations={locations.data?.items ?? []} keep={filters.locationId ?? null} />
          </select>
        )}
      </FilterField>
      <FilterField label={t('catalog.items.filter.status')}>
        {(c) => (
          <select {...c} className={SELECT_CLASS} value={filters.status ?? ''} onChange={(e) => set({ status: e.target.value })}>
            <option value="">{t('catalog.items.filter.status_all')}</option>
            {ITEM_STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`vocab.item_status.${s}`)}
              </option>
            ))}
          </select>
        )}
      </FilterField>
      <FilterField label={t('catalog.items.filter.collection_type')}>
        {(c) => (
          <select {...c} className={SELECT_CLASS} value={filters.collectionTypeId ?? ''} onChange={(e) => set({ collectionTypeId: e.target.value })}>
            <option value="">{t('catalog.items.filter.collection_type_all')}</option>
            {(types.data?.items ?? []).map((ct) => (
              <option key={ct.id} value={ct.id}>
                {ct.archived ? `${typeName(ct)} (${t('catalog.items.archived')})` : typeName(ct)}
              </option>
            ))}
          </select>
        )}
      </FilterField>
    </FilterRow>
  );
}

export function ItemsListScreen() {
  const t = useT();
  const me = useMe();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const raw = useSearch({ strict: false }) as Record<string, unknown>;
  const filtersKey = JSON.stringify(itemsSearchOf(raw));
  const filters = useMemo(() => JSON.parse(filtersKey) as ItemsSearch, [filtersKey]);
  const managed = useManagedBranches();
  const types = useCollectionTypes();
  const typeName = useCollectionTypeName();
  const [selected, setSelected] = useState<ReadonlyMap<string, ItemListItem>>(new Map());
  const [panel, setPanel] = useState<string | null>(null);
  const [bulkApplied, setBulkApplied] = useState(false);
  const selectAll = useRef<HTMLInputElement>(null);

  // Another filter is another list: what was selected in the old one is not shown any more.
  useEffect(() => {
    setSelected(new Map());
    setPanel(null);
  }, [filtersKey]);

  const list = useInfiniteQuery({
    queryKey: [...ITEMS_KEY, 'list', filters],
    queryFn: ({ pageParam }) => api<ItemListResponse>('GET', listPath(filters, pageParam)),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    enabled: me !== undefined,
    // A list being read does not change under the reader's eyes (every loaded page would be read again).
    refetchOnWindowFocus: false,
  });

  const items = useMemo(() => list.data?.pages.flatMap((page) => page.items) ?? NO_ITEMS, [list.data]);
  const typeNames = useMemo(() => new Map((types.data?.items ?? []).map((ct) => [ct.id, typeName(ct)])), [types.data, typeName]);

  /**
   * A filter change, applied to the search the router holds at that moment (not to the last render's: two changes in
   * a row keep both). The router writes the search (a value that would read back as a number or JSON is quoted).
   */
  const setFilters = (patch: FilterPatch): void => {
    void navigate({
      to: '/admin/catalog/items',
      replace: true,
      search: (prev: Record<string, unknown>) => {
        if (patch === null) return {};
        const next: Record<string, unknown> = { ...itemsSearchOf(prev) };
        for (const [key, value] of Object.entries(patch)) next[key] = value === '' ? undefined : value;
        return itemsSearchOf(next);
      },
    });
  };

  const choose = (next: ReadonlyMap<string, ItemListItem>): void => {
    if (next.size === 0) setPanel(null);
    setSelected(next);
  };
  const toggle = (row: ItemListItem, on: boolean): void => {
    const next = new Map(selected);
    if (on) next.set(row.id, row);
    else next.delete(row.id);
    choose(next);
  };
  const all = items.length > 0 && items.every((i) => selected.has(i.id));
  const chosen = useMemo(() => [...selected.values()], [selected]);
  const filtered = Object.keys(filters).length > 0;

  /** The bulk panel closed: after a change, the selection is done with and the lists read again. */
  const closeBulk = (): void => {
    setPanel(null);
    if (bulkApplied) {
      setBulkApplied(false);
      choose(new Map());
      void invalidateAfterItemWrite(queryClient);
    }
  };

  const columns: DenseColumn<ItemListItem>[] = [
    {
      id: 'select',
      headClassName: 'w-px',
      header: (
        <input
          ref={(el) => {
            selectAll.current = el;
            if (el !== null) el.indeterminate = !all && selected.size > 0;
          }}
          type="checkbox"
          aria-label={t('catalog.items.select_all')}
          className="size-4 align-middle accent-primary"
          checked={all}
          onChange={(e) => choose(e.target.checked ? new Map(items.map((i) => [i.id, i])) : new Map())}
        />
      ),
      cell: (row) => (
        <input
          type="checkbox"
          aria-label={t('catalog.items.select_row', { barcode: row.barcode })}
          className="size-4 align-middle accent-primary"
          checked={selected.has(row.id)}
          onChange={(e) => toggle(row, e.target.checked)}
        />
      ),
    },
    {
      id: 'barcode',
      header: t('catalog.items.col.barcode'),
      cell: (row) => (
        <Link to={`/admin/catalog/items/${encodeURIComponent(row.id)}`} className="font-semibold whitespace-nowrap text-accent-text underline-offset-4 hover:underline">
          {row.barcode}
        </Link>
      ),
    },
    { id: 'title', header: t('catalog.items.col.title'), cell: (row) => <span className="break-words">{row.record.title}</span> },
    { id: 'branch', header: t('catalog.items.col.branch'), cell: (row) => row.branch.code },
    {
      id: 'location',
      header: t('catalog.items.col.location'),
      cell: (row) => (row.locationPath === null ? <span className="text-muted-foreground">{t('catalog.items.no_location')}</span> : locationPathLabel(row.locationPath)),
    },
    { id: 'callNumber', header: t('catalog.items.col.call_number'), className: 'whitespace-nowrap', cell: (row) => row.callNumber ?? '—' },
    { id: 'collectionType', header: t('catalog.items.col.collection_type'), cell: (row) => typeNames.get(row.collectionTypeId) ?? '—' },
    {
      id: 'status',
      header: t('catalog.items.col.status'),
      cell: (row) => (
        <span className="flex flex-wrap gap-1">
          <ItemStatusBadge status={row.status} circulation={row.circulation} />
          {row.archived && <Badge tone="danger">{t('catalog.items.archived')}</Badge>}
        </span>
      ),
    },
  ];

  return (
    <div className="grid gap-6">
      <PageHead title={t('catalog.items.title')} intro={t('catalog.items.description')} />

      <ScanField paused={panel !== null} />
      <Filters filters={filters} onChange={setFilters} />

      {list.isError && list.data === undefined ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />
      ) : list.data === undefined ? (
        <SkeletonTable label={t('shell.loading')} columns={8} />
      ) : (
        <div className="grid gap-3">
          {list.isError && <Notice kind="error">{problemText(t, list.error)}</Notice>}
          <SelectionBar
            count={chosen.length}
            label={t('catalog.items.selected', { count: chosen.length })}
            actions={managed.length > 0 && chosen.length <= ITEM_BULK_MAX ? [{ id: 'bulk', label: t('catalog.items.bulk.open') }] : []}
            open={panel}
            onOpenChange={(id) => (id === null ? closeBulk() : setPanel(id))}
            onClear={() => choose(new Map())}
            clearLabel={t('catalog.items.selection_clear')}
            focusAfter={selectAll}
            extra={
              <>
                <AddToPrintQueue entries={chosen.map((i) => ({ kind: 'item' as const, id: i.id, label: i.barcode }))} />
                {managed.length > 0 && chosen.length > ITEM_BULK_MAX && (
                  <>
                    <Button type="button" size="sm" variant="ghost" disabled>
                      {t('catalog.items.bulk.open')}
                    </Button>
                    <span className="w-full text-meta text-muted-foreground">{t('catalog.items.bulk.too_many', { max: ITEM_BULK_MAX })}</span>
                  </>
                )}
              </>
            }>
            {panel === 'bulk' && <BulkPanel items={chosen} onApplied={() => setBulkApplied(true)} onClose={closeBulk} />}
          </SelectionBar>
          <DenseTable
            caption={t('catalog.items.caption')}
            columns={columns}
            rows={items}
            rowKey={(row) => row.id}
            rowClassName={(row) => (selected.has(row.id) ? 'bg-accent-soft' : undefined)}
            empty={
              <span className="flex flex-wrap items-center gap-2">
                {t('catalog.items.empty')}
                {filtered && (
                  <Button type="button" variant="link" className="h-auto p-0" onClick={() => setFilters(null)}>
                    {t('catalog.items.filter.reset')}
                  </Button>
                )}
              </span>
            }
          />
          {list.hasNextPage ? (
            <div>
              <Button variant="outline" size="sm" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                {t(list.isFetchingNextPage ? 'shell.loading' : 'catalog.items.load_more')}
              </Button>
            </div>
          ) : (
            items.length > 0 && <p className="text-sm text-muted-foreground">{t('catalog.items.end')}</p>
          )}
        </div>
      )}
    </div>
  );
}
