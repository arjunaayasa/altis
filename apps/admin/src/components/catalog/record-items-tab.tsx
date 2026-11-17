import { ItemCreateBody, type ItemListItem, type ItemListResponse } from '@altis/shared/api/catalog/items';
import { issueCode } from '@altis/shared/api/common';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { createColumnHelper, tableFeatures, useTable } from '@tanstack/react-table';
import { useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { DataTable } from '@/components/data-table';
import { Badge, Field, Notice, SELECT_CLASS } from '@/components/form-field';
import { ErrorState, LAYER, SkeletonTable } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useT, type TKey } from '@/i18n';
import { api, type FieldError } from '@/lib/api';
import { problemText } from '@/lib/form-errors';
import { useApiQuery } from '@/lib/me';
import { BatchDialog } from '@/screens/catalog/items/batch-dialog';
import {
  ITEMS_KEY,
  LocationOptions,
  branchLabel,
  createProblemText,
  customCodeAt,
  customCreateValues,
  customRequiredErrors,
  enterRuns,
  fieldErrorsOf,
  invalidateAfterItemWrite,
  itemErrorKey,
  locationPathLabel,
  useBranchLocations,
  useCollectionTypeName,
  useCollectionTypes,
  useDefaultCollectionTypeId,
  useIdempotencyKeys,
  useItemCustomFields,
  useManagedBranches,
  withCustomValue,
  withoutCustomError,
  type ItemCustomValues,
} from '@/screens/catalog/items/item-form';
import { isUlid } from '@/screens/catalog/items/search';
import { CustomFieldInputs } from '@/screens/catalog/records/custom-fields';
import { ItemStatusBadge } from '@/screens/circulation/common';

/**
 * The items tab of the record editor (Phase 2 spec §13 "tab eksemplar"; plan Task 25):
 *
 * - **The list** of the record's items at every branch (`GET catalog/items?recordId=`, archived ones too, by barcode),
 *   each barcode a link to its item page. Up to {@link TAB_LIMIT} rows; a record with more links to Eksemplar's list
 *   filtered on it.
 * - **Quick add** (`POST branches/:branchId/items`): branch, barcode, collection type (the record's material type
 *   template default, else the catalog's default: `useDefaultCollectionTypeId`), location, and the live item custom
 *   fields (§3.7; a required one is asked for before sending); a new item is `available` with one part (P2-31). The
 *   barcode goes as typed (the server normalises it: CR, LF and TAB removed, the ends trimmed, inner spaces collapsed,
 *   ASCII letters upper-cased). After a success the barcode is emptied and the branch, the location and the custom
 *   values stay, for the next copy.
 * - **"Tambah banyak dengan pola barkod"**: {@link BatchDialog}.
 *
 * Writes are offered only at the live branches where the user may manage items (`holdsAt(me, 'catalog.items.manage',
 * id)`); a reader without any sees the list only. The server checks again (`branchParam`).
 *
 * A host may hold this tab inside its own `<form>` (forms do not nest), so quick add is not a `<form>`: it is a
 * `role="form"` group whose Enter (in a text field) adds the item and never submits an enclosing form.
 */
export interface RecordItemsTabProps {
  recordId: string;
  /**
   * The collection type new items start with (quick add, batch): the template default of the saved record's material
   * type (`template.defaults.collectionTypeId`, C22); one that is not live falls back to the catalog's default.
   */
  defaultCollectionTypeId?: string | null;
}

/** The most rows the tab reads at once (the list query's own maximum). */
const TAB_LIMIT = 200;

const features = tableFeatures({});
const column = createColumnHelper<typeof features, ItemListItem>();
const NO_ITEMS: ItemListItem[] = [];

export function RecordItemsTab({ recordId, defaultCollectionTypeId = null }: RecordItemsTabProps): ReactNode {
  const t = useT();
  const queryClient = useQueryClient();
  const managed = useManagedBranches();
  const types = useCollectionTypes();
  const typeName = useCollectionTypeName();
  const titleId = useId();
  const [batchOpen, setBatchOpen] = useState(false);
  const valid = isUlid(recordId);

  const list = useApiQuery<ItemListResponse>({
    queryKey: [...ITEMS_KEY, 'record', recordId],
    path: `catalog/items?${new URLSearchParams({ recordId, limit: String(TAB_LIMIT) }).toString()}`,
    enabled: valid,
  });
  const items = list.data?.items ?? NO_ITEMS;
  const typeNames = useMemo(() => new Map((types.data?.items ?? []).map((ct) => [ct.id, typeName(ct)])), [types.data, typeName]);

  /** After a write: this tab's list, Eksemplar's lists and the record around the tab (its item counts) read again. */
  const refresh = (): void => void invalidateAfterItemWrite(queryClient);

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('barcode', {
          header: t('catalog.items.col.barcode'),
          cell: (info) => (
            <Link
              to="/admin/catalog/items/$itemId"
              params={{ itemId: info.row.original.id }}
              className="font-semibold whitespace-nowrap text-accent-text underline-offset-4 hover:underline">
              {info.getValue()}
            </Link>
          ),
        }),
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
      ]),
    [t, typeNames],
  );
  const table = useTable({ features, columns, data: items, getRowId: (item) => item.id });

  return (
    <section aria-labelledby={titleId} className="grid gap-5">
      <div className="grid max-w-[75ch] gap-1">
        <h2 id={titleId} className="text-base font-bold">
          {t('catalog.items.tab.title')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('catalog.items.tab.description')}</p>
      </div>

      {!valid ? null : list.data === undefined ? (
        list.isError ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />
        ) : (
          <SkeletonTable label={t('shell.loading')} rows={3} />
        )
      ) : (
        <div className="grid gap-3">
          {list.isError && <Notice kind="error">{problemText(t, list.error)}</Notice>}
          <DataTable table={table} caption={t('catalog.items.tab.title')} empty={t('catalog.items.tab.empty')} />
          {list.data.nextCursor !== null && (
            <Link to="/admin/catalog/items" search={{ recordId }} className="w-fit text-sm font-semibold text-accent-text underline-offset-4 hover:underline">
              {t('catalog.items.tab.more')}
            </Link>
          )}
        </div>
      )}

      {valid && managed.length > 0 && (
        <>
          <QuickAdd recordId={recordId} preferredType={defaultCollectionTypeId} onAdded={refresh} />
          <div>
            <Button type="button" variant="outline" aria-pressed={batchOpen} onClick={() => setBatchOpen(!batchOpen)}>
              {t('catalog.items.batch.open')}
            </Button>
          </div>
          <BatchDialog
            open={batchOpen}
            recordId={recordId}
            defaultCollectionTypeId={defaultCollectionTypeId}
            onCreated={refresh}
            onClose={() => setBatchOpen(false)}
          />
        </>
      )}
    </section>
  );
}

type QuickField = 'branch' | 'barcode' | 'collectionTypeId' | 'locationId';

const QUICK_FIELDS: readonly string[] = ['barcode', 'collectionTypeId', 'locationId'];

/** Quick add: one item of the record at a branch the user manages. */
function QuickAdd({ recordId, preferredType, onAdded }: { recordId: string; preferredType: string | null; onAdded(): void }) {
  const t = useT();
  const titleId = useId();
  const managed = useManagedBranches();
  const types = useCollectionTypes();
  const typeName = useCollectionTypeName();
  const defaultType = useDefaultCollectionTypeId(preferredType);
  const customFields = useItemCustomFields().defs;
  const keys = useIdempotencyKeys('items-create');
  const barcodeInput = useRef<HTMLInputElement>(null);

  const [chosenBranch, setBranch] = useState('');
  const [barcode, setBarcode] = useState('');
  const [chosenType, setType] = useState('');
  const [locationId, setLocationId] = useState('');
  const [custom, setCustom] = useState<ItemCustomValues>({});
  const [errors, setErrors] = useState<Partial<Record<QuickField, TKey>>>({});
  const [customErrors, setCustomErrors] = useState<Record<string, TKey>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // What the selects show: the choice made, else the first managed branch and the default type (template, catalog).
  const branch = managed.some((b) => b.id === chosenBranch) ? chosenBranch : (managed[0]?.id ?? '');
  const collectionTypeId = chosenType !== '' ? chosenType : defaultType;
  const locations = useBranchLocations(branch === '' ? null : branch);

  /** Puts field errors on their fields (the first per field wins); false when one names no field here. */
  const place = (found: readonly FieldError[]): boolean => {
    const next: Partial<Record<QuickField, TKey>> = {};
    const nextCustom: Record<string, TKey> = {};
    let all = true;
    for (const { path, code } of found) {
      const customCode = customCodeAt(path, customFields);
      if (customCode !== null) {
        if (!Object.prototype.hasOwnProperty.call(nextCustom, customCode)) nextCustom[customCode] = code === 'required' ? 'form.error.required' : itemErrorKey(path, code);
        continue;
      }
      const field = path === 'branch' ? 'branch' : QUICK_FIELDS.includes(path) ? (path as QuickField) : null;
      if (field === null) {
        all = false;
        continue;
      }
      next[field] ??= code === 'required' ? 'form.error.required' : itemErrorKey(path, code);
    }
    setErrors(next);
    setCustomErrors(nextCustom);
    if (next.barcode !== undefined) barcodeInput.current?.focus();
    return all;
  };

  const add = async (): Promise<void> => {
    if (busy) return;
    setProblem(null);
    setAdded(null);
    setErrors({});
    setCustomErrors({});
    const body: ItemCreateBody = { recordId, barcode, collectionTypeId, status: 'available', partsTotal: 1 };
    if (locationId !== '') body.locationId = locationId;
    const customBody = customCreateValues(customFields, custom);
    if (customBody !== undefined) body.custom = customBody;
    // The contract's checks first: nothing is sent that the server would refuse for its shape.
    const found: FieldError[] = [];
    if (branch === '') found.push({ path: 'branch', code: 'required' });
    if (barcode.trim() === '') found.push({ path: 'barcode', code: 'required' });
    if (collectionTypeId === '') found.push({ path: 'collectionTypeId', code: 'required' });
    found.push(...customRequiredErrors(customFields, custom));
    const parsed = ItemCreateBody.safeParse(body);
    if (!parsed.success) for (const issue of parsed.error.issues) found.push({ path: issue.path.join('.'), code: issueCode(issue) });
    if (found.length > 0) {
      if (!place(found)) setProblem(t('error.VALIDATION_FAILED'));
      return;
    }
    setBusy(true);
    try {
      await api('POST', `branches/${encodeURIComponent(branch)}/items`, body, { idempotencyKey: keys.keyFor({ branch, body }) });
      keys.done();
      setAdded(barcode.trim());
      setBarcode('');
      onAdded();
      barcodeInput.current?.focus();
    } catch (e) {
      const fieldErrors = fieldErrorsOf(e);
      if (fieldErrors.length === 0 || !place(fieldErrors)) setProblem(createProblemText(t, e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div role="form" aria-labelledby={titleId} className={`grid gap-3.5 rounded-lg border p-4 ${LAYER}`} onKeyDown={enterRuns(() => void add())}>
      <h3 id={titleId} className="text-sm font-bold">
        {t('catalog.items.quick.title')}
      </h3>
      {added !== null && <Notice kind="success">{t('catalog.items.quick.added', { barcode: added })}</Notice>}
      {problem !== null && <Notice kind="error">{problem}</Notice>}
      <div className="grid gap-x-5 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label={t('catalog.items.filter.branch')} hint={t('catalog.items.quick.branch_hint')} error={errors.branch}>
          {(c) => (
            <select
              {...c}
              className={SELECT_CLASS}
              disabled={busy}
              value={branch}
              onChange={(e) => {
                setBranch(e.target.value);
                setLocationId('');
              }}
            >
              {managed.map((b) => (
                <option key={b.id} value={b.id}>
                  {branchLabel(t, b)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label={t('catalog.items.field.barcode')} error={errors.barcode}>
          {(c) => (
            <Input
              {...c}
              ref={barcodeInput}
              autoComplete="off"
              spellCheck={false}
              maxLength={200}
              disabled={busy}
              value={barcode}
              onChange={(e) => {
                setBarcode(e.target.value);
                setAdded(null);
                setErrors((old) => ({ ...old, barcode: undefined }));
              }}
            />
          )}
        </Field>
        <Field label={t('catalog.items.field.collection_type')} error={errors.collectionTypeId}>
          {(c) => (
            <select {...c} className={SELECT_CLASS} disabled={busy} value={collectionTypeId} onChange={(e) => setType(e.target.value)}>
              {collectionTypeId === '' && <option value="">{t('catalog.items.choose')}</option>}
              {(types.data?.items ?? [])
                .filter((ct) => !ct.archived)
                .map((ct) => (
                  <option key={ct.id} value={ct.id}>
                    {typeName(ct)}
                  </option>
                ))}
            </select>
          )}
        </Field>
        <Field label={t('catalog.items.field.location')} error={errors.locationId}>
          {(c) => (
            <select {...c} className={SELECT_CLASS} disabled={busy} value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              <option value="">{t('catalog.items.field.location_none')}</option>
              <LocationOptions locations={locations.data?.items ?? []} />
            </select>
          )}
        </Field>
      </div>
      <CustomFieldInputs
        defs={customFields}
        values={custom}
        errors={customErrors}
        disabled={busy}
        onChange={(code, value) => {
          setCustom((old) => withCustomValue(old, code, value));
          setCustomErrors((old) => withoutCustomError(old, code));
        }}
      />
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" disabled={busy} onClick={() => void add()}>
          {t(busy ? 'catalog.items.quick.adding' : 'catalog.items.quick.add')}
        </Button>
      </div>
    </div>
  );
}
