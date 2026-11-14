import { ITEM_STATUSES } from '@altis/shared';
import { ITEM_BULK_MAX, type ItemDetail, type ItemListItem, type ItemListResponse } from '@altis/shared/api/catalog/items';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { createColumnHelper, tableFeatures, useTable } from '@tanstack/react-table';
import { ScanBarcodeIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { AddToPrintQueue } from '@/components/catalog/print-queue';
import { DataTable } from '@/components/data-table';
import { Badge, Field, Notice, ProblemAlert, SELECT_CLASS } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useT, type TKey } from '@/i18n';
import { ApiError, api } from '@/lib/api';
import { problemText } from '@/lib/form-errors';
import { useMe } from '@/lib/me';
import { useScannerInput } from '@/lib/scanner';
import { ItemStatusBadge } from '@/screens/circulation/common';
import { BulkDialog } from './bulk-dialog';
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
 *   items at some branch. A filter change clears the selection.
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

const features = tableFeatures({});
const column = createColumnHelper<typeof features, ItemListItem>();
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
    <form noValidate aria-label={t('catalog.items.scan.label')} className="flex flex-col gap-2 rounded-lg border bg-card p-4" onSubmit={submit}>
      <div className="flex flex-wrap items-end gap-2">
        <Field label={t('catalog.items.scan.label')} hint={t('catalog.items.scan.hint')} error={fieldError ?? undefined} className="min-w-0 flex-1">
          {(c) => (
            <Input
              {...c}
              ref={input}
              autoComplete="off"
              spellCheck={false}
              maxLength={200}
              className="font-mono"
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setFieldError(null);
              }}
            />
          )}
        </Field>
        <Button type="submit" disabled={busy} className="mb-6">
          <ScanBarcodeIcon aria-hidden="true" />
          {t(busy ? 'catalog.items.scan.searching' : 'catalog.items.scan.open')}
        </Button>
      </div>
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
    <section aria-label={t('catalog.items.filters')} className="grid gap-4 rounded-lg border bg-card p-4 sm:grid-cols-2 lg:grid-cols-4">
      <Field label={t('catalog.items.filter.branch')}>
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
      </Field>
      <Field label={t('catalog.items.filter.location')} hint={filters.branchId === undefined ? t('catalog.items.filter.location_hint') : undefined}>
        {(c) => (
          <select
            {...c}
            className={SELECT_CLASS}
            disabled={filters.branchId === undefined}
            value={filters.locationId ?? ''}
            onChange={(e) => set({ locationId: e.target.value })}
          >
            <option value="">{t('catalog.items.filter.location_all')}</option>
            <LocationOptions locations={locations.data?.items ?? []} keep={filters.locationId ?? null} />
          </select>
        )}
      </Field>
      <Field label={t('catalog.items.filter.status')}>
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
      </Field>
      <Field label={t('catalog.items.filter.collection_type')}>
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
      </Field>
      {(filters.recordId !== undefined || any) && (
        <div className="flex flex-wrap items-center gap-3 text-sm sm:col-span-2 lg:col-span-4">
          {filters.recordId !== undefined && <span className="text-muted-foreground">{t('catalog.items.filter.record')}</span>}
          <Button type="button" variant="outline" size="sm" onClick={() => onChange(null)}>
            {t('catalog.items.filter.reset')}
          </Button>
        </div>
      )}
    </section>
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
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkApplied, setBulkApplied] = useState(false);

  // Another filter is another list: what was selected in the old one is not shown any more.
  useEffect(() => {
    setSelected(new Map());
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

  const columns = useMemo(() => {
    const toggle = (row: ItemListItem, on: boolean): void => {
      setSelected((old) => {
        const next = new Map(old);
        if (on) next.set(row.id, row);
        else next.delete(row.id);
        return next;
      });
    };
    const toggleAll = (on: boolean): void => setSelected(on ? new Map(items.map((i) => [i.id, i])) : new Map());
    const all = items.length > 0 && items.every((i) => selected.has(i.id));
    return column.columns([
      column.display({
        id: 'select',
        header: () => (
          <input
            type="checkbox"
            aria-label={t('catalog.items.select_all')}
            className="size-4 accent-primary"
            checked={all}
            ref={(el) => {
              if (el !== null) el.indeterminate = !all && selected.size > 0;
            }}
            onChange={(e) => toggleAll(e.target.checked)}
          />
        ),
        cell: (info) => (
          <input
            type="checkbox"
            aria-label={t('catalog.items.select_row', { barcode: info.row.original.barcode })}
            className="size-4 accent-primary"
            checked={selected.has(info.row.original.id)}
            onChange={(e) => toggle(info.row.original, e.target.checked)}
          />
        ),
      }),
      column.accessor('barcode', {
        header: t('catalog.items.col.barcode'),
        cell: (info) => (
          <Link
            to={`/admin/catalog/items/${encodeURIComponent(info.row.original.id)}`}
            className="font-mono font-medium whitespace-nowrap text-primary underline-offset-4 hover:underline"
          >
            {info.getValue()}
          </Link>
        ),
      }),
      column.display({ id: 'title', header: t('catalog.items.col.title'), cell: (info) => <span className="break-words">{info.row.original.record.title}</span> }),
      column.display({ id: 'branch', header: t('catalog.items.col.branch'), cell: (info) => info.row.original.branch.code }),
      column.display({
        id: 'location',
        header: t('catalog.items.col.location'),
        cell: (info) => {
          const path = info.row.original.locationPath;
          return path === null ? <span className="text-muted-foreground">{t('catalog.items.no_location')}</span> : locationPathLabel(path);
        },
      }),
      column.accessor('callNumber', {
        header: t('catalog.items.col.call_number'),
        cell: (info) => <span className="whitespace-nowrap">{info.getValue() ?? '—'}</span>,
      }),
      column.display({
        id: 'collectionType',
        header: t('catalog.items.col.collection_type'),
        cell: (info) => typeNames.get(info.row.original.collectionTypeId) ?? '—',
      }),
      column.display({
        id: 'status',
        header: t('catalog.items.col.status'),
        cell: (info) => {
          const row = info.row.original;
          return (
            <span className="flex flex-wrap gap-1">
              <ItemStatusBadge status={row.status} circulation={row.circulation} />
              {row.archived && <Badge tone="danger">{t('catalog.items.archived')}</Badge>}
            </span>
          );
        },
      }),
    ]);
  }, [t, items, selected, typeNames]);

  const table = useTable({ features, columns, data: items, getRowId: (item) => item.id });
  const chosen = useMemo(() => [...selected.values()], [selected]);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t('catalog.items.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('catalog.items.description')}</p>
      </header>

      <ScanField paused={bulkOpen} />
      <Filters filters={filters} onChange={setFilters} />

      {chosen.length > 0 && (
        <div role="region" aria-label={t('catalog.items.selected', { count: chosen.length })} className="flex flex-wrap items-center gap-3 rounded-md border bg-muted/40 px-3 py-2 text-sm">
          <span className="font-medium">{t('catalog.items.selected', { count: chosen.length })}</span>
          <AddToPrintQueue entries={chosen.map((i) => ({ kind: 'item' as const, id: i.id, label: i.barcode }))} />
          {managed.length > 0 && (
            <Button type="button" size="sm" disabled={chosen.length > ITEM_BULK_MAX} onClick={() => setBulkOpen(true)}>
              {t('catalog.items.bulk.open')}
            </Button>
          )}
          <Button type="button" variant="ghost" size="sm" onClick={() => setSelected(new Map())}>
            {t('catalog.items.selection_clear')}
          </Button>
          {managed.length > 0 && chosen.length > ITEM_BULK_MAX && (
            <span className="w-full text-muted-foreground">{t('catalog.items.bulk.too_many', { max: ITEM_BULK_MAX })}</span>
          )}
        </div>
      )}

      {list.isError && list.data === undefined ? (
        <ProblemAlert error={list.error}>
          <Button variant="outline" size="sm" className="mt-2" onClick={() => void list.refetch()}>
            {t('table.retry')}
          </Button>
        </ProblemAlert>
      ) : list.data === undefined ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t('shell.loading')}
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {list.isError && <Notice kind="error">{problemText(t, list.error)}</Notice>}
          <DataTable table={table} caption={t('catalog.items.caption')} empty={t('catalog.items.empty')} />
          {list.hasNextPage ? (
            <div>
              <Button variant="outline" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                {t(list.isFetchingNextPage ? 'shell.loading' : 'catalog.items.load_more')}
              </Button>
            </div>
          ) : (
            items.length > 0 && <p className="text-sm text-muted-foreground">{t('catalog.items.end')}</p>
          )}
        </div>
      )}

      <BulkDialog
        open={bulkOpen}
        items={chosen}
        onApplied={() => setBulkApplied(true)}
        onClose={() => {
          setBulkOpen(false);
          if (bulkApplied) {
            setBulkApplied(false);
            setSelected(new Map());
            void invalidateAfterItemWrite(queryClient);
          }
        }}
      />
    </div>
  );
}
