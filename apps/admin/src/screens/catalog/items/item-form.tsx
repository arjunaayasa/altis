import { ACQ_SOURCES, ITEM_TRANSITIONS, type AcqSource, type ItemStatus } from '@altis/shared';
import type { BranchItem, BranchListResponse, BranchView } from '@altis/shared/api/branches';
import { ItemPatchBody, type ItemLocationPath, type ItemView } from '@altis/shared/api/catalog/items';
import type { LocationListResponse, LocationView } from '@altis/shared/api/catalog/locations';
import type { CollectionTypeView, CustomFieldView, MasterListResponse, SupplierView } from '@altis/shared/api/catalog/masters';
import { issueCode } from '@altis/shared/api/common';
import type { CatalogConfigView } from '@altis/shared/api/settings';
import type { QueryClient } from '@tanstack/react-query';
import { useMemo, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Controller, type UseFormReturn } from 'react-hook-form';
import { Field, SELECT_CLASS, TEXTAREA_CLASS } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useLocale, useT, type TKey, type Translate } from '@/i18n';
import { holdsAt } from '@/lib/access';
import { ApiError, type FieldError } from '@/lib/api';
import { fieldErrorKey, problemText } from '@/lib/form-errors';
import { isWritableBranch } from '@/lib/branches';
import { useApiQuery, useMe } from '@/lib/me';
import { CustomFieldInputs } from '@/screens/catalog/records/custom-fields';
import { customBodyValue, customFormValue, type CustomFormValue } from '@/screens/catalog/records/draft-to-form';

/**
 * The item form and what every Eksemplar screen shares (Phase 2 spec §13, §2.5, §3.4; plan Task 25):
 *
 * - the reads behind the selects (`GET branches`, `GET catalog/config`, the collection types, suppliers and one
 *   branch's locations), each under one query key, archived rows included so that a row naming one still shows its
 *   name; the selects offer live rows only (plus the value the item holds);
 * - the branches where the user may manage items (`holdsAt(me, 'catalog.items.manage', id)`) and that the server marks
 *   writable (`isWritableBranch`: live and `active`): writes are offered there only, the server checks again
 *   (`branchParam`);
 * - the field messages of the items API's own check codes (`isbn_not_barcode`, `length`, `charset`, `duplicate`,
 *   `exhausted`, `invalid` at `locationId`, ...): `catalog.items.error.*`, since the shared `form.error.*` family
 *   has none;
 * - the edit form: its values (strings, as the inputs hold them), the patch of what changed (`''` → null), checked
 *   with the shared `ItemPatchBody` before anything is sent, and the fields, with the status select limited to
 *   `ITEM_TRANSITIONS[current]`;
 * - the item custom fields (spec §3.7: every live `entity=items` definition, `GET catalog/custom-fields?entity=items`),
 *   drawn by Task 24's custom-fields.tsx from values kept by code (a code may hold a `.`): a new item (quick add, the
 *   batch's template) sends the values given and is asked for a required one first, the item form patches the ones
 *   that changed (a cleared one as null). An archived field is not shown; its stored value stays (§3.7).
 */

// ---- query keys ------------------------------------------------------------------------------------------------------

/** Every items read lives under this key (a write invalidates it all). */
export const ITEMS_KEY = ['catalog', 'items'] as const;

/** `GET catalog/items/:id`. */
export const itemKey = (id: string) => [...ITEMS_KEY, 'detail', id] as const;

/**
 * Bibliografi's reads that show what an item write changes (a record's item counts, its `changed_at`): the records
 * list and every record's detail (the record editor around the items tab), under Task 24's keys.
 */
const RECORD_READS = [
  ['catalog', 'records', 'list'],
  ['catalog', 'records', 'detail'],
] as const;

/**
 * After an item write: every items read, and the records' reads above, are stale. The ones on screen read again at
 * once; the others when they are next shown.
 */
export async function invalidateAfterItemWrite(queryClient: QueryClient): Promise<void> {
  await Promise.all([ITEMS_KEY, ...RECORD_READS].map((queryKey) => queryClient.invalidateQueries({ queryKey })));
}

// ---- shared reads --------------------------------------------------------------------------------------------------

/** `GET catalog/config`: barcode patterns, the currency, the default collection type. */
export function useCatalogConfig() {
  return useApiQuery<CatalogConfigView>({ queryKey: ['catalog', 'config'], path: 'catalog/config', staleTime: 60_000 });
}

/** `GET branches?includeArchived=true` (any signed-in staff user may read it). */
export function useBranches() {
  return useApiQuery<BranchListResponse>({ queryKey: ['branches', { includeArchived: true }], path: 'branches?includeArchived=true', staleTime: 60_000 });
}

export function useCollectionTypes() {
  return useApiQuery<MasterListResponse<CollectionTypeView>>({
    queryKey: ['catalog', 'collection-types', { includeArchived: true }],
    path: 'catalog/collection-types?includeArchived=true',
    staleTime: 60_000,
  });
}

export function useSuppliers(enabled = true) {
  return useApiQuery<MasterListResponse<SupplierView>>({
    queryKey: ['catalog', 'suppliers', { includeArchived: true }],
    path: 'catalog/suppliers?includeArchived=true',
    staleTime: 60_000,
    enabled,
  });
}

/** One branch's locations in tree order (archived ones included, for the names in rows and history); none without a branch. */
export function useBranchLocations(branchId: string | null) {
  return useApiQuery<LocationListResponse>({
    queryKey: ['catalog', 'locations', { branchId, includeArchived: true }],
    path: `catalog/locations?${new URLSearchParams({ branchId: branchId ?? '', includeArchived: 'true' }).toString()}`,
    enabled: branchId !== null,
    staleTime: 30_000,
  });
}

/**
 * The writable branches (live and active, L13) where `me` may manage items, in the server's order (the default branch
 * first).
 */
export function useManagedBranches(): BranchItem[] {
  const me = useMe();
  const branches = useBranches();
  return useMemo(
    () => (branches.data?.items ?? []).filter((b) => isWritableBranch(b) && holdsAt(me, 'catalog.items.manage', b.id)),
    [branches.data, me],
  );
}

/** The ids of the live branches the server marks inactive (L13): items there are shown, never written. */
export function useInactiveBranches(): ReadonlySet<string> {
  const branches = useBranches();
  return useMemo(
    () => new Set((branches.data?.items ?? []).filter((b: BranchView) => b.archivedAt === null && !isWritableBranch(b)).map((b) => b.id)),
    [branches.data],
  );
}

/**
 * The collection type a new item starts with: `preferred` (the record's material type template default,
 * `template.defaults.collectionTypeId`, spec §3.8) while it is live, else the catalog's default
 * (`catalog.defaultCollectionTypeId`) while it is live, else the first live one; `''` until they are known.
 */
export function useDefaultCollectionTypeId(preferred: string | null = null): string {
  const config = useCatalogConfig();
  const types = useCollectionTypes();
  const live = (types.data?.items ?? []).filter((c) => !c.archived);
  const wanted = config.data?.defaultCollectionTypeId ?? null;
  return live.find((c) => c.id === preferred)?.id ?? live.find((c) => c.id === wanted)?.id ?? live[0]?.id ?? '';
}

// ---- custom fields -------------------------------------------------------------------------------------------------

/** The custom values of an item form, by code. */
export type ItemCustomValues = Record<string, CustomFormValue>;

/** The live item custom fields of `defs`, in their order (`sortOrder`, then code). */
export function liveItemCustomFields(defs: readonly CustomFieldView[]): CustomFieldView[] {
  return defs
    .filter((d) => d.entity === 'items' && !d.archived)
    .sort((a, b) => a.sortOrder - b.sortOrder || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
}

/** `GET catalog/custom-fields?entity=items`: the live item custom fields (none while unread or unreadable). */
export function useItemCustomFields(): { defs: CustomFieldView[]; settled: boolean } {
  const query = useApiQuery<MasterListResponse<CustomFieldView>>({
    queryKey: ['catalog', 'custom-fields', { entity: 'items' }],
    path: 'catalog/custom-fields?entity=items',
    staleTime: 60_000,
  });
  const defs = useMemo(() => liveItemCustomFields(query.data?.items ?? []), [query.data]);
  return { defs, settled: query.data !== undefined || query.isError };
}

const own = (o: object, key: string): boolean => Object.prototype.hasOwnProperty.call(o, key);

/** Each field's value as a body sends it (null: none). */
function customBodyValues(defs: readonly CustomFieldView[], values: ItemCustomValues): [string, unknown][] {
  return defs.map((def) => [def.code, customBodyValue(def, own(values, def.code) ? values[def.code] : undefined)]);
}

/** The `custom` of a new item (quick add, a batch's template): the values given; undefined when there is none. */
export function customCreateValues(defs: readonly CustomFieldView[], values: ItemCustomValues): Record<string, unknown> | undefined {
  const given = customBodyValues(defs, values).filter(([, v]) => v !== null);
  return given.length === 0 ? undefined : Object.fromEntries(given);
}

/** A `required` at `<prefix>custom.<code>` for each required field left empty (the server's create check). */
export function customRequiredErrors(defs: readonly CustomFieldView[], values: ItemCustomValues, prefix = ''): FieldError[] {
  return customBodyValues(defs, values)
    .filter(([code, v]) => v === null && defs.some((d) => d.code === code && d.required))
    .map(([code]) => ({ path: `${prefix}custom.${code}`, code: 'required' }));
}

/** The field an error path names (`<prefix>custom.<code>`, or below it), or null; a code may hold a `.`. */
export function customCodeAt(path: string, defs: readonly CustomFieldView[], prefix = ''): string | null {
  const head = `${prefix}custom.`;
  if (!path.startsWith(head)) return null;
  const rest = path.slice(head.length);
  const codes = defs.map((d) => d.code).filter((code) => rest === code || rest.startsWith(`${code}.`));
  return codes.sort((a, b) => b.length - a.length)[0] ?? null;
}

/** An item's stored custom values as the form holds them. */
export function customFormValuesOf(custom: Readonly<Record<string, unknown>>): ItemCustomValues {
  return Object.fromEntries(Object.entries(custom).map(([code, v]) => [code, customFormValue(v)]));
}

/** `values` with `code` set to `value` (an own key, whatever the code). */
export function withCustomValue(values: ItemCustomValues, code: string, value: CustomFormValue): ItemCustomValues {
  return Object.fromEntries([...Object.entries(values).filter(([c]) => c !== code), [code, value]]);
}

/** `errors` without `code`. */
export function withoutCustomError<T>(errors: Readonly<Record<string, T>>, code: string): Record<string, T> {
  return Object.fromEntries(Object.entries(errors).filter(([c]) => c !== code));
}

/**
 * Enter in a single-line field of a part that is not a `<form>` (the record editor holds the items tab inside its own
 * form) runs `action`, never the editor's submit.
 */
export function enterRuns(action: () => void) {
  return (event: KeyboardEvent<HTMLElement>): void => {
    const target = event.target as HTMLElement;
    if (event.key !== 'Enter' || !(target instanceof HTMLInputElement) || target.type === 'checkbox' || target.type === 'radio') return;
    event.preventDefault();
    action();
  };
}

// ---- labels ----------------------------------------------------------------------------------------------------------

/** `PUSAT · Perpustakaan Pusat`, with "(diarsipkan)" for an archived branch. */
export function branchLabel(t: Translate, b: Pick<BranchItem, 'code' | 'name' | 'archivedAt'>): string {
  return t(b.archivedAt === null ? 'catalog.items.branch_option' : 'catalog.items.branch_option_archived', { code: b.code, name: b.name });
}

/** A collection type's name in the UI language. */
export function useCollectionTypeName(): (c: Pick<CollectionTypeView, 'nameId' | 'nameEn'>) => string {
  const locale = useLocale();
  return (c) => (locale === 'en' ? c.nameEn : c.nameId);
}

/** `Ruang › Area › Rak` of an item row. */
export function locationPathLabel(p: ItemLocationPath): string {
  return [p.roomName, p.areaName, p.shelfName].filter((s): s is string => s !== null && s !== '').join(' › ');
}

/** Each location's full name (`Ruang Baca › Rak 800`), walking up its parents (a room has none; at most 3 levels). */
export function locationNames(locations: readonly LocationView[]): Map<string, string> {
  const byId = new Map(locations.map((l) => [l.id, l]));
  const names = new Map<string, string>();
  for (const l of locations) {
    const parts = [l.name];
    let parent = l.parentId === null ? undefined : byId.get(l.parentId);
    for (let depth = 0; parent !== undefined && depth < 3; depth += 1) {
      parts.unshift(parent.name);
      parent = parent.parentId === null ? undefined : byId.get(parent.parentId);
    }
    names.set(l.id, parts.join(' › '));
  }
  return names;
}

/** The `<option>`s of the live locations (tree order), plus `keep` (the value held) when it is not live. */
export function LocationOptions({ locations, keep }: { locations: readonly LocationView[]; keep?: string | null }): ReactNode {
  const t = useT();
  const names = locationNames(locations);
  const live = locations.filter((l) => !l.archived);
  const held = keep !== undefined && keep !== null && !live.some((l) => l.id === keep) ? keep : null;
  return (
    <>
      {live.map((l) => (
        <option key={l.id} value={l.id}>
          {names.get(l.id)}
        </option>
      ))}
      {held !== null && <option value={held}>{`${names.get(held) ?? held} (${t('catalog.items.archived')})`}</option>}
    </>
  );
}

/** An example barcode of a pattern: its first number (`B0000001`). */
export function patternExample(p: { prefix: string; digits: number; suffix: string }): string {
  return `${p.prefix}${'1'.padStart(p.digits, '0')}${p.suffix}`;
}

// ---- field errors ----------------------------------------------------------------------------------------------------

/** The items API's own check codes with a message of their own, whatever the field. */
const OWN_CODES: Readonly<Record<string, TKey>> = Object.freeze({
  isbn_not_barcode: 'catalog.items.error.isbn_not_barcode',
  length: 'catalog.items.error.length',
  charset: 'catalog.items.error.charset',
  duplicate: 'catalog.items.error.duplicate',
  exhausted: 'catalog.items.error.exhausted',
  // At `status`: the item cannot leave `withdrawn` while its record is archived.
  record_archived: 'catalog.items.error.revive_record_archived',
});

/**
 * The message key of a field error of the items API (or of the same check done here) at `path` (`.`-joined; a batch
 * names `template.<field>` and `barcodes.<i>`). The field decides what `invalid` means; any other code is the shared
 * `form.error.<code>`.
 */
export function itemErrorKey(path: string, code: string): TKey {
  const field = path.split('.').at(-1) ?? '';
  const barcode = field === 'barcode' || path.startsWith('barcodes');
  const own = Object.prototype.hasOwnProperty.call(OWN_CODES, code) ? OWN_CODES[code] : undefined;
  if (own !== undefined) return own;
  if (barcode && code === 'taken') return 'catalog.items.error.barcode_taken';
  if (barcode && code === 'too_small') return 'form.error.required';
  if (field === 'locationId' && code === 'invalid') return 'catalog.items.error.location_invalid';
  if (field === 'price') return 'catalog.items.error.price';
  if (field === 'currency') return 'catalog.items.error.currency';
  if (field === 'patternId' && code === 'not_found') return 'catalog.items.error.pattern_unknown';
  if (field === 'partsTotal') return 'catalog.items.error.parts_total';
  if (path === 'recordId' && code === 'archived') return 'catalog.items.error.record_archived';
  return fieldErrorKey(code);
}

/**
 * The sentence of a create's or a batch's problem: a field error at `recordId` (no field of those forms: the record
 * was archived or merged meanwhile) in its own words, else the problem's ({@link problemText}).
 */
export function createProblemText(t: Translate, e: unknown): string {
  const onRecord = fieldErrorsOf(e).find((f) => f.path === 'recordId');
  return onRecord === undefined ? problemText(t, e) : t(itemErrorKey(onRecord.path, onRecord.code));
}

/** The field errors of a VALIDATION_FAILED (`[]` for any other problem). */
export function fieldErrorsOf(e: unknown): FieldError[] {
  return e instanceof ApiError && e.code === 'VALIDATION_FAILED' ? (e.errors ?? []) : [];
}

/**
 * A fresh `Idempotency-Key` (§7.9) for one submission of a write that creates rows: sent again with the same body
 * after a lost answer, the server answers the first result instead of creating the items twice. `crypto.randomUUID`
 * needs a secure context, which a library's plain-HTTP intranet install is not; `getRandomValues` does not.
 */
export function newIdempotencyKey(prefix: string): string {
  const random = crypto.getRandomValues(new Uint8Array(16));
  return `${prefix}-${Array.from(random, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * The idempotency keys of one form: the same key while the same body is sent again (a retry after a lost answer),
 * a new one for another body (the server refuses a key reused with another body) and after a success (the same body
 * sent on purpose once more is a new request: three more items).
 */
export function useIdempotencyKeys(prefix: string): { keyFor(body: unknown): string; done(): void } {
  const last = useRef<{ body: string; key: string } | null>(null);
  return useMemo(
    () => ({
      keyFor(body: unknown): string {
        const text = JSON.stringify(body);
        if (last.current === null || last.current.body !== text) last.current = { body: text, key: newIdempotencyKey(prefix) };
        return last.current.key;
      },
      done(): void {
        last.current = null;
      },
    }),
    [prefix],
  );
}

// ---- the edit form -----------------------------------------------------------------------------------------------------

/** What the inputs hold: text everywhere (`''` = none), the status and the acquisition source as their codes. */
export interface ItemFormValues {
  barcode: string;
  collectionTypeId: string;
  status: ItemStatus;
  locationId: string;
  callNumber: string;
  inventoryNo: string;
  partsTotal: string;
  statusNote: string;
  acqSource: AcqSource | '';
  orderNo: string;
  orderDate: string;
  receivedDate: string;
  invoiceDate: string;
  supplierId: string;
  invoiceNo: string;
  price: string;
  currency: string;
  note: string;
  /** The custom values by code ({@link customFormValuesOf}). */
  custom: ItemCustomValues;
}

/** The fields of the form that are a single value (not the custom ones). */
export type ItemFormField = Exclude<keyof ItemFormValues, 'custom'>;

/** The form's values of `item`. */
export function formValuesOf(item: ItemView): ItemFormValues {
  return {
    barcode: item.barcode,
    collectionTypeId: item.collectionTypeId,
    status: item.status,
    locationId: item.locationId ?? '',
    callNumber: item.callNumber ?? '',
    inventoryNo: item.inventoryNo ?? '',
    partsTotal: String(item.partsTotal),
    statusNote: item.statusNote ?? '',
    acqSource: item.acqSource ?? '',
    orderNo: item.orderNo ?? '',
    orderDate: item.orderDate ?? '',
    receivedDate: item.receivedDate ?? '',
    invoiceDate: item.invoiceDate ?? '',
    supplierId: item.supplierId ?? '',
    invoiceNo: item.invoiceNo ?? '',
    price: item.price ?? '',
    currency: item.currency ?? '',
    note: item.note ?? '',
    custom: customFormValuesOf(item.custom),
  };
}

/** A single-line text as the API takes it: trimmed, empty → null. */
const line = (v: string): string | null => (v.trim() === '' ? null : v.trim());

/** A multi-line text: kept as written, blank → null. */
const text = (v: string): string | null => (v.trim() === '' ? null : v);

/** A select's value: `''` → null. */
const choice = (v: string): string | null => (v === '' ? null : v);

/**
 * The patch body of what changed from `base` (its version): each field compared in the API's form, so a value typed
 * back to what it was sends nothing; of the custom fields `customFields` (the live ones shown), each changed value
 * (a cleared one as null). The body is not checked here ({@link checkPatch}).
 */
export function patchOf(values: ItemFormValues, base: ItemView, customFields: readonly CustomFieldView[] = []): Record<string, unknown> {
  const from = formValuesOf(base);
  const body: Record<string, unknown> = { version: base.version };
  if (values.barcode !== from.barcode) body['barcode'] = values.barcode;
  if (values.collectionTypeId !== from.collectionTypeId) body['collectionTypeId'] = values.collectionTypeId;
  if (values.status !== from.status) body['status'] = values.status;
  if (values.partsTotal.trim() !== from.partsTotal) body['partsTotal'] = values.partsTotal.trim() === '' ? Number.NaN : Number(values.partsTotal.trim());
  const nullable: [ItemFormField, (v: string) => string | null][] = [
    ['locationId', choice],
    ['callNumber', line],
    ['inventoryNo', line],
    ['statusNote', line],
    ['acqSource', choice],
    ['orderNo', line],
    ['orderDate', choice],
    ['receivedDate', choice],
    ['invoiceDate', choice],
    ['supplierId', choice],
    ['invoiceNo', line],
    ['price', line],
    ['currency', (v) => line(v.toUpperCase())],
    ['note', text],
  ];
  for (const [field, read] of nullable) {
    const now = read(values[field]);
    if (now !== read(from[field])) body[field] = now;
  }
  const was = new Map(customBodyValues(customFields, from.custom));
  const changed = customBodyValues(customFields, values.custom).filter(([code, v]) => JSON.stringify(v) !== JSON.stringify(was.get(code)));
  if (changed.length > 0) body['custom'] = Object.fromEntries(changed);
  return body;
}

/**
 * `base` as the server holds it after `body` was saved with the answer's `version`, up to the server's own
 * normalising (an upper-cased barcode, a price with its two decimals): the form's next patch starts from it when the
 * read after the save fails. A custom value sent as null is gone, the others replace the stored ones.
 */
export function withPatch(base: ItemView, body: ItemPatchBody, version: number): ItemView {
  const next: ItemView = { ...base, version };
  for (const [field, value] of Object.entries(body)) {
    if (field !== 'version' && field !== 'custom' && value !== undefined) (next as unknown as Record<string, unknown>)[field] = value;
  }
  if (body.custom !== undefined) {
    const sent = body.custom;
    const kept = Object.entries(base.custom).filter(([code]) => !own(sent, code));
    next.custom = Object.fromEntries([...kept, ...Object.entries(sent).filter(([, v]) => v !== null)]);
  }
  return next;
}

/** `body` checked with the shared contract: the body to send, or the field errors (`{path, code}`) it would get. */
export function checkPatch(body: Record<string, unknown>): { ok: true; body: ItemPatchBody } | { ok: false; errors: FieldError[] } {
  const parsed = ItemPatchBody.safeParse(body);
  if (parsed.success) return { ok: true, body: body as ItemPatchBody };
  return { ok: false, errors: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), code: issueCode(issue) })) };
}

/** The statuses the select offers: the current one first, then its legal targets (§2.5). */
export function statusChoices(current: ItemStatus): ItemStatus[] {
  return [current, ...ITEM_TRANSITIONS[current]];
}

/** What the edit form needs to fill its selects, and the live item custom fields it shows. */
export interface ItemFormChoices {
  collectionTypes: readonly CollectionTypeView[];
  suppliers: readonly SupplierView[];
  locations: readonly LocationView[];
  currency: string;
  customFields: readonly CustomFieldView[];
}

/**
 * The fields of an item (every field of `ItemPatchBody`, the live custom fields included). `base` is the item the
 * form started from: its status decides the status choices, and an archived collection type, supplier or location it
 * holds stays selectable. `suggestion` is shown under the location while none is chosen. `customErrors` holds a
 * message key per custom code; `onCustomChange` hears which one was changed.
 */
export function ItemFields({
  form,
  base,
  choices,
  suggestion,
  customErrors,
  onCustomChange,
}: {
  form: UseFormReturn<ItemFormValues>;
  base: ItemView;
  choices: ItemFormChoices;
  suggestion: ItemView['suggestedLocation'];
  customErrors?: Readonly<Record<string, string>>;
  onCustomChange?(code: string): void;
}) {
  const t = useT();
  const typeName = useCollectionTypeName();
  const { register, formState, watch, setValue } = form;
  const errors = formState.errors;
  const locationId = watch('locationId');
  const liveTypes = choices.collectionTypes.filter((c) => !c.archived || c.id === base.collectionTypeId);
  const liveSuppliers = choices.suppliers.filter((s) => !s.archived || s.id === base.supplierId);
  return (
    <>
      <fieldset className="grid min-w-0 gap-4 sm:grid-cols-2">
        <legend className="mb-2 text-base font-semibold">{t('catalog.items.section.main')}</legend>
        <Field label={t('catalog.items.field.barcode')} hint={t('catalog.items.field.barcode_hint')} error={errors.barcode}>
          {(c) => <Input {...c} autoComplete="off" spellCheck={false} maxLength={200} className="font-mono" {...register('barcode')} />}
        </Field>
        <Field label={t('catalog.items.field.status')} hint={t('catalog.items.field.status_hint')} error={errors.status}>
          {(c) => (
            <select {...c} className={SELECT_CLASS} {...register('status')}>
              {statusChoices(base.status).map((s, i) => (
                <option key={s} value={s}>
                  {i === 0 ? t('catalog.items.field.status_current', { status: t(`vocab.item_status.${s}`) }) : t(`vocab.item_status.${s}`)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label={t('catalog.items.field.collection_type')} error={errors.collectionTypeId}>
          {(c) => (
            <select {...c} className={SELECT_CLASS} {...register('collectionTypeId')}>
              {liveTypes.map((ct) => (
                <option key={ct.id} value={ct.id}>
                  {typeName(ct)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <div className="grid content-start gap-2">
          <Field label={t('catalog.items.field.location')} error={errors.locationId}>
            {(c) => (
              <select {...c} className={SELECT_CLASS} {...register('locationId')}>
                <option value="">{t('catalog.items.field.location_none')}</option>
                <LocationOptions locations={choices.locations} keep={base.locationId} />
              </select>
            )}
          </Field>
          {locationId === '' && suggestion !== null && (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed px-3 py-2 text-sm">
              <span className="font-medium">
                {suggestion.shelfHint === null
                  ? t('catalog.items.suggest', { name: suggestion.name })
                  : t('catalog.items.suggest_with_hint', { name: suggestion.name, hint: suggestion.shelfHint })}
              </span>
              <span className="w-full text-xs text-muted-foreground">{t('catalog.items.suggest_note')}</span>
              <Button type="button" variant="outline" size="sm" onClick={() => setValue('locationId', suggestion.id, { shouldDirty: true })}>
                {t('catalog.items.suggest_use')}
              </Button>
            </div>
          )}
        </div>
        <Field label={t('catalog.items.field.call_number')} hint={t('catalog.items.field.call_number_hint')} error={errors.callNumber}>
          {(c) => <Input {...c} autoComplete="off" maxLength={64} {...register('callNumber')} />}
        </Field>
        <Field label={t('catalog.items.field.inventory_no')} error={errors.inventoryNo}>
          {(c) => <Input {...c} autoComplete="off" maxLength={64} {...register('inventoryNo')} />}
        </Field>
        <Field label={t('catalog.items.field.parts_total')} hint={t('catalog.items.field.parts_total_hint')} error={errors.partsTotal}>
          {(c) => <Input {...c} type="number" min={1} max={99} step={1} {...register('partsTotal')} />}
        </Field>
        <Field label={t('catalog.items.field.status_note')} error={errors.statusNote}>
          {(c) => <Input {...c} autoComplete="off" maxLength={191} {...register('statusNote')} />}
        </Field>
      </fieldset>

      <fieldset className="grid min-w-0 gap-4 sm:grid-cols-2">
        <legend className="mb-2 text-base font-semibold">{t('catalog.items.section.acquisition')}</legend>
        <Field label={t('catalog.items.field.acq_source')} error={errors.acqSource}>
          {(c) => (
            <select {...c} className={SELECT_CLASS} {...register('acqSource')}>
              <option value="">{t('catalog.items.not_set')}</option>
              {ACQ_SOURCES.map((s) => (
                <option key={s} value={s}>
                  {t(`vocab.acq_source.${s}`)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label={t('catalog.items.field.supplier')} error={errors.supplierId}>
          {(c) => (
            <select {...c} className={SELECT_CLASS} {...register('supplierId')}>
              <option value="">{t('catalog.items.not_set')}</option>
              {liveSuppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label={t('catalog.items.field.order_no')} error={errors.orderNo}>
          {(c) => <Input {...c} autoComplete="off" maxLength={64} {...register('orderNo')} />}
        </Field>
        <Field label={t('catalog.items.field.order_date')} error={errors.orderDate}>
          {(c) => <Input {...c} type="date" {...register('orderDate')} />}
        </Field>
        <Field label={t('catalog.items.field.invoice_no')} error={errors.invoiceNo}>
          {(c) => <Input {...c} autoComplete="off" maxLength={64} {...register('invoiceNo')} />}
        </Field>
        <Field label={t('catalog.items.field.invoice_date')} error={errors.invoiceDate}>
          {(c) => <Input {...c} type="date" {...register('invoiceDate')} />}
        </Field>
        <Field label={t('catalog.items.field.received_date')} error={errors.receivedDate}>
          {(c) => <Input {...c} type="date" {...register('receivedDate')} />}
        </Field>
        <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
          <Field label={t('catalog.items.field.price')} hint={t('catalog.items.field.price_hint')} error={errors.price}>
            {(c) => <Input {...c} inputMode="decimal" autoComplete="off" maxLength={16} {...register('price')} />}
          </Field>
          <Field label={t('catalog.items.field.currency')} hint={t('catalog.items.field.currency_hint', { currency: choices.currency })} error={errors.currency}>
            {(c) => <Input {...c} autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={3} placeholder={choices.currency} {...register('currency')} />}
          </Field>
        </div>
      </fieldset>

      <Field label={t('catalog.items.field.note')} error={errors.note}>
        {(c) => <textarea {...c} className={TEXTAREA_CLASS} {...register('note')} />}
      </Field>

      <Controller
        control={form.control}
        name="custom"
        render={({ field }) => (
          <CustomFieldInputs
            defs={choices.customFields}
            values={field.value}
            errors={customErrors}
            onChange={(code, value) => {
              field.onChange(withCustomValue(field.value, code, value));
              onCustomChange?.(code);
            }}
          />
        )}
      />
    </>
  );
}
