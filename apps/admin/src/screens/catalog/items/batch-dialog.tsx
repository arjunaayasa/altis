import { ITEM_STATUSES, type ItemStatus } from '@altis/shared';
import { ITEM_BATCH_MAX, ItemBatchBody, type ItemBatchResponse } from '@altis/shared/api/catalog/items';
import { issueCode } from '@altis/shared/api/common';
import { useId, useState } from 'react';
import { Field, Notice, SELECT_CLASS } from '@/components/form-field';
import { useReturnFocus } from '@/components/return-focus';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useT, type TKey } from '@/i18n';
import { api, type FieldError } from '@/lib/api';
import { CustomFieldInputs } from '@/screens/catalog/records/custom-fields';
import {
  LocationOptions,
  branchLabel,
  createProblemText,
  customCodeAt,
  customCreateValues,
  customRequiredErrors,
  fieldErrorsOf,
  itemErrorKey,
  patternExample,
  useBranchLocations,
  useCatalogConfig,
  useCollectionTypeName,
  useCollectionTypes,
  useDefaultCollectionTypeId,
  useIdempotencyKeys,
  useItemCustomFields,
  useManagedBranches,
  withCustomValue,
  withoutCustomError,
  type ItemCustomValues,
} from './item-form';

/**
 * "Tambah banyak dengan pola barkod" of a record's items tab (Phase 2 spec §3.4, §13; plan Task 25):
 * `POST branches/:branchId/items/batch` with `count` (1-{@link ITEM_BATCH_MAX}) items numbered by a barcode pattern of
 * `GET catalog/config`, all made from one template (collection type, status, location, the live item custom fields:
 * a required one is asked for before sending).
 *
 * - The branch select offers only the branches where the user may manage items (`holdsAt`).
 * - The body is checked with the shared `ItemBatchBody` first. The server numbers from the highest matching barcode
 *   in use (B4); a barcode it found taken at insert is skipped and reported, and the next number used. The answer
 *   lists the barcodes made and the ones skipped; both are shown.
 * - The request carries an `Idempotency-Key`: sent again after a lost answer, the same batch is not made twice.
 * - Field errors land on their fields (`template.<field>` on the template's, `template.custom.<code>` on its custom
 *   field): an exhausted pattern on the pattern.
 */

type BatchField = 'branch' | 'patternId' | 'count' | 'collectionTypeId' | 'status' | 'locationId';

/** The form field of a batch error path (`template.collectionTypeId` → `collectionTypeId`); null for none. */
function fieldOf(path: string): BatchField | null {
  const field = path.startsWith('template.') ? path.slice('template.'.length) : path;
  return field === 'patternId' || field === 'count' || field === 'collectionTypeId' || field === 'status' || field === 'locationId' ? field : null;
}

export function BatchDialog({
  open,
  recordId,
  defaultCollectionTypeId = null,
  onCreated,
  onClose,
}: {
  open: boolean;
  recordId: string;
  /** The record's template default collection type (C22; see `useDefaultCollectionTypeId`). */
  defaultCollectionTypeId?: string | null;
  /** After items were made (the lists read again). */
  onCreated(): void;
  onClose(): void;
}) {
  const t = useT();
  const focus = useReturnFocus();
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent closeLabel={t('catalog.items.batch.close')} onOpenAutoFocus={focus.onOpenAutoFocus} onCloseAutoFocus={focus.onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>{t('catalog.items.batch.title')}</DialogTitle>
          <DialogDescription>{t('catalog.items.batch.description', { max: ITEM_BATCH_MAX })}</DialogDescription>
        </DialogHeader>
        {open && <BatchBody recordId={recordId} preferredType={defaultCollectionTypeId} onCreated={onCreated} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function BatchBody({ recordId, preferredType, onCreated, onClose }: { recordId: string; preferredType: string | null; onCreated(): void; onClose(): void }) {
  const t = useT();
  const ids = { branch: useId(), pattern: useId(), count: useId(), type: useId(), status: useId(), location: useId(), created: useId(), skipped: useId() };
  const managed = useManagedBranches();
  const config = useCatalogConfig();
  const types = useCollectionTypes();
  const typeName = useCollectionTypeName();
  const defaultType = useDefaultCollectionTypeId(preferredType);
  const customFields = useItemCustomFields().defs;
  const keys = useIdempotencyKeys('items-batch');
  const patterns = config.data?.barcodePatterns ?? [];

  const [chosenBranch, setBranch] = useState('');
  const [chosenPattern, setPattern] = useState('');
  const [count, setCount] = useState('1');
  const [chosenType, setType] = useState('');
  const [status, setStatus] = useState<ItemStatus>('available');
  const [locationId, setLocationId] = useState('');
  const [custom, setCustom] = useState<ItemCustomValues>({});
  const [errors, setErrors] = useState<Partial<Record<BatchField, TKey>>>({});
  const [customErrors, setCustomErrors] = useState<Record<string, TKey>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ItemBatchResponse | null>(null);

  // What the selects show: the choice made, else the first branch, the first pattern and the default type.
  const branch = managed.some((b) => b.id === chosenBranch) ? chosenBranch : (managed[0]?.id ?? '');
  const patternId = patterns.some((p) => p.id === chosenPattern) ? chosenPattern : (patterns[0]?.id ?? '');
  const collectionTypeId = chosenType !== '' ? chosenType : defaultType;
  const locations = useBranchLocations(branch === '' ? null : branch);

  const errorOf = (field: BatchField): TKey | undefined => errors[field];

  /** Puts field errors on their fields (the first per field wins); false when one names no field here. */
  const place = (found: readonly FieldError[]): boolean => {
    const next: Partial<Record<BatchField, TKey>> = {};
    const nextCustom: Record<string, TKey> = {};
    let all = true;
    for (const { path, code } of found) {
      const customCode = customCodeAt(path, customFields, 'template.');
      if (customCode !== null) {
        if (!Object.prototype.hasOwnProperty.call(nextCustom, customCode)) nextCustom[customCode] = code === 'required' ? 'form.error.required' : itemErrorKey(path, code);
        continue;
      }
      const field = path === 'branch' ? 'branch' : fieldOf(path);
      if (field === null) {
        all = false;
        continue;
      }
      next[field] ??= field === 'count' ? 'catalog.items.error.count' : code === 'required' ? 'form.error.required' : itemErrorKey(path, code);
    }
    setErrors(next);
    setCustomErrors(nextCustom);
    return all;
  };

  const create = async (): Promise<void> => {
    if (busy) return;
    setProblem(null);
    setErrors({});
    setCustomErrors({});
    const template: ItemBatchBody['template'] = { collectionTypeId, status, partsTotal: 1 };
    if (locationId !== '') template.locationId = locationId;
    const customBody = customCreateValues(customFields, custom);
    if (customBody !== undefined) template.custom = customBody;
    const body = { recordId, count: /^\d{1,3}$/.test(count.trim()) ? Number(count.trim()) : Number.NaN, patternId, template };
    // The checks of the contract, first: nothing is sent that the server would refuse for its shape.
    const found: FieldError[] = [];
    if (branch === '') found.push({ path: 'branch', code: 'required' });
    if (collectionTypeId === '') found.push({ path: 'template.collectionTypeId', code: 'required' });
    found.push(...customRequiredErrors(customFields, custom, 'template.'));
    const parsed = ItemBatchBody.safeParse(body);
    if (!parsed.success) for (const issue of parsed.error.issues) found.push({ path: issue.path.join('.'), code: issueCode(issue) });
    if (found.length > 0) {
      place(found);
      return;
    }
    setBusy(true);
    try {
      const answer = await api<ItemBatchResponse>('POST', `branches/${encodeURIComponent(branch)}/items/batch`, body, { idempotencyKey: keys.keyFor({ branch, body }) });
      keys.done();
      setResult(answer);
      onCreated();
    } catch (e) {
      const fieldErrors = fieldErrorsOf(e);
      if (fieldErrors.length === 0 || !place(fieldErrors)) setProblem(createProblemText(t, e));
    } finally {
      setBusy(false);
    }
  };

  if (result !== null) {
    return (
      <div className="flex flex-col gap-3">
        <section className="flex flex-col gap-1">
          <h3 id={ids.created} className="text-sm font-semibold">
            {t('catalog.items.batch.created', { count: result.created.length })}
          </h3>
          <ul aria-labelledby={ids.created} className="flex max-h-48 flex-wrap gap-x-4 gap-y-1 overflow-y-auto font-mono text-sm">
            {result.created.map((c) => (
              <li key={c.id}>{c.barcode}</li>
            ))}
          </ul>
        </section>
        {result.skipped.length > 0 && (
          <section className="flex flex-col gap-1">
            <h3 id={ids.skipped} className="text-sm font-semibold">
              {t('catalog.items.batch.skipped', { count: result.skipped.length })}
            </h3>
            <p className="text-xs text-muted-foreground">{t('catalog.items.batch.skipped_hint')}</p>
            <ul aria-labelledby={ids.skipped} className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-sm">
              {result.skipped.map((s) => (
                <li key={s.barcode}>{s.barcode}</li>
              ))}
            </ul>
          </section>
        )}
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            {t('catalog.items.batch.done')}
          </Button>
        </DialogFooter>
      </div>
    );
  }

  if (config.data !== undefined && patterns.length === 0) return <Notice kind="error">{t('catalog.items.batch.no_patterns')}</Notice>;

  return (
    <div className="flex flex-col gap-4">
      {problem !== null && <Notice kind="error">{problem}</Notice>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id={ids.branch} label={t('catalog.items.filter.branch')} hint={t('catalog.items.quick.branch_hint')} error={errorOf('branch')}>
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
        <Field id={ids.pattern} label={t('catalog.items.batch.pattern')} error={errorOf('patternId')}>
          {(c) => (
            <select {...c} className={SELECT_CLASS} disabled={busy} value={patternId} onChange={(e) => setPattern(e.target.value)}>
              {patterns.map((p) => (
                <option key={p.id} value={p.id}>
                  {t('catalog.items.batch.pattern_option', { name: p.name, example: patternExample(p) })}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field id={ids.count} label={t('catalog.items.batch.count')} error={errorOf('count')}>
          {(c) => <Input {...c} type="number" min={1} max={ITEM_BATCH_MAX} step={1} disabled={busy} value={count} onChange={(e) => setCount(e.target.value)} />}
        </Field>
        <Field id={ids.type} label={t('catalog.items.field.collection_type')} error={errorOf('collectionTypeId')}>
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
        <Field id={ids.status} label={t('catalog.items.field.status')} error={errorOf('status')}>
          {(c) => (
            <select {...c} className={SELECT_CLASS} disabled={busy} value={status} onChange={(e) => setStatus(e.target.value as ItemStatus)}>
              {ITEM_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(`vocab.item_status.${s}`)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field id={ids.location} label={t('catalog.items.field.location')} error={errorOf('locationId')}>
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
      <DialogFooter>
        <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
          {t('form.cancel')}
        </Button>
        <Button type="button" disabled={busy} onClick={() => void create()}>
          {t(busy ? 'catalog.items.batch.creating' : 'catalog.items.batch.create')}
        </Button>
      </DialogFooter>
    </div>
  );
}
