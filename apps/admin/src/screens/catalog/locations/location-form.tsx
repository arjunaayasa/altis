import { LOCATION_KINDS, vocabKey, type LocationKind } from '@altis/shared';
import type { StoreResponse } from '@altis/shared/api/catalog/common';
import { LocationBody, LocationPatchBody, type LocationUpdateResponse, type LocationView } from '@altis/shared/api/catalog/locations';
import { useQueryClient } from '@tanstack/react-query';
import { useState, type BaseSyntheticEvent } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { CheckField, Field, ProblemAlert, RootError, SELECT_CLASS } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { useDirtyGuard } from '@/lib/dirty-forms';
import { FORM_PARSE } from '@/lib/form-errors';
import {
  changedFields,
  isFieldProblem,
  isStale,
  optionalText,
  orderValue,
  putFieldErrors,
  serverIssues,
  zodIssues,
  type ErrorMessage,
} from '@/screens/catalog/masters/master-table';
import { descendantsOf } from './tree';

/**
 * A location of the branch (Phase 2 spec §3.6; plan Task 27; the API of Task 14): its kind, where it sits (a room in
 * nothing, an area in a room, a shelf in a room or an area), code (unique within the branch), name, the shelf hint
 * (empty: the server cuts the name to 40 characters), a shelf's call-number range, OPAC visibility and order.
 *
 * - Create: `POST branches/:branchId/locations`. Edit: `PATCH branches/:branchId/locations/:id` with the version and
 *   only what changed (answers `{id, version}`, S15).
 * - "Di dalam" offers the live locations that may hold the chosen kind, never the location itself or anything below
 *   it; a kind change picks the first one when the current parent no longer fits.
 * - Field errors of the server land on their field, with their own message for `invalid_parent`, a kind its contents
 *   cannot sit in (`kind` `invalid`) and a call-number range that is not one (`classFrom`/`classTo` `invalid`).
 */

interface LocationValues {
  kind: LocationKind;
  parentId: string;
  code: string;
  name: string;
  shelfHint: string;
  classFrom: string;
  classTo: string;
  isPublic: boolean;
  sortOrder: string;
}

/** What a save changed, for the screen (the shelf map after a move). */
export interface LocationSaved {
  id: string | null;
  name: string;
  /** An edit's new parent or kind, when it changed one. */
  moved: { parentId?: string | null; kind?: LocationKind } | null;
  /** The locations whose map box the server cleared because the edit moved them to another room (Task 40). */
  boxesCleared: readonly string[];
}

const message: ErrorMessage = (path, code) => {
  if (path === 'parentId' && code === 'invalid_parent') return 'catalog.locations.error.invalid_parent';
  if (path === 'kind' && code === 'invalid') return 'catalog.locations.error.kind';
  if ((path === 'classFrom' || path === 'classTo') && code === 'invalid') return 'catalog.locations.error.class';
  return undefined;
};

/** The parents offered to a location of `kind`: rooms, and for a shelf also each room's areas (indented). */
export function parentOptions(rows: readonly LocationView[], kind: LocationKind, self: LocationView | null): { id: string; label: string }[] {
  if (kind === 'room') return [];
  const excluded = new Set(self === null ? [] : [self.id, ...descendantsOf(rows, self.id).map((d) => d.id)]);
  const current = self?.parentId ?? null;
  const usable = rows.filter((r) => (!r.archived || r.id === current) && !excluded.has(r.id));
  const out: { id: string; label: string }[] = [];
  const label = (r: LocationView): string => `${r.name} (${r.code})`;
  for (const room of usable.filter((r) => r.kind === 'room')) {
    out.push({ id: room.id, label: label(room) });
    if (kind === 'shelf') for (const area of usable.filter((a) => a.kind === 'area' && a.parentId === room.id)) out.push({ id: area.id, label: `— ${label(area)}` });
  }
  if (kind === 'shelf') for (const area of usable.filter((a) => a.kind === 'area' && !out.some((o) => o.id === a.id))) out.push({ id: area.id, label: `— ${label(area)}` });
  // The current parent stays visible even when it would no longer be offered (archived, or of another kind).
  const parent = rows.find((r) => r.id === current);
  if (parent !== undefined && !out.some((o) => o.id === parent.id)) out.push({ id: parent.id, label: label(parent) });
  return out;
}

function valuesOf(location: LocationView | null, start: { kind: LocationKind; parentId: string | null }): LocationValues {
  if (location === null) {
    return { kind: start.kind, parentId: start.parentId ?? '', code: '', name: '', shelfHint: '', classFrom: '', classTo: '', isPublic: true, sortOrder: '0' };
  }
  return {
    kind: location.kind,
    parentId: location.parentId ?? '',
    code: location.code,
    name: location.name,
    shelfHint: location.shelfHint ?? '',
    classFrom: location.classFrom ?? '',
    classTo: location.classTo ?? '',
    isPublic: location.isPublic,
    sortOrder: String(location.sortOrder),
  };
}

/** The fields as the API takes them; the call-number range only for a shelf. */
function bodyOf(v: LocationValues): Record<string, unknown> {
  return {
    parentId: v.kind === 'room' || v.parentId === '' ? null : v.parentId,
    kind: v.kind,
    code: v.code.trim(),
    name: v.name.trim(),
    shelfHint: optionalText(v.shelfHint),
    ...(v.kind === 'shelf' ? { classFrom: optionalText(v.classFrom), classTo: optionalText(v.classTo) } : {}),
    isPublic: v.isPublic,
    sortOrder: orderValue(v.sortOrder),
  };
}

export function LocationForm({
  branchId,
  rows,
  location,
  start,
  canManage,
  onSaved,
  onCancel,
}: {
  branchId: string;
  /** The branch's locations (the parents offered). */
  rows: readonly LocationView[];
  /** Null: a new location. */
  location: LocationView | null;
  /** A new location's kind and parent. */
  start: { kind: LocationKind; parentId: string | null };
  canManage: boolean;
  onSaved(saved: LocationSaved): Promise<void>;
  onCancel(): void;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [base] = useState(() => valuesOf(location, start));
  const [problem, setProblem] = useState<unknown>(null);
  const form = useForm<LocationValues>({ defaultValues: base });
  const kind = useWatch({ control: form.control, name: 'kind' });
  const { errors, isDirty, isSubmitting } = form.formState;
  useDirtyGuard(isDirty);
  const disabled = !canManage;
  const parents = parentOptions(rows, kind, location);

  /** A kind whose parents do not include the current one moves the parent to the first that fits. */
  const kindChanged = (next: LocationKind): void => {
    const options = parentOptions(rows, next, location);
    const parent = form.getValues('parentId');
    if (next === 'room') form.setValue('parentId', '');
    else if (!options.some((o) => o.id === parent)) form.setValue('parentId', options[0]?.id ?? '');
  };

  const save = form.handleSubmit(async (values) => {
    setProblem(null);
    if (values.kind !== 'room' && values.parentId === '') {
      putFieldErrors(form, [{ path: 'parentId', code: 'required', message: 'form.error.required' }]);
      return;
    }
    const body = bodyOf(values);
    const fields = location === null ? body : changedFields(body, bodyOf(base));
    if (location !== null && Object.keys(fields).length === 0) {
      onCancel();
      return;
    }
    const parsed = location === null ? LocationBody.safeParse(fields, FORM_PARSE) : LocationPatchBody.safeParse({ version: location.version, ...fields }, FORM_PARSE);
    if (!parsed.success) {
      putFieldErrors(form, zodIssues(parsed.error.issues, message));
      return;
    }
    const collection = `branches/${encodeURIComponent(branchId)}/locations`;
    let boxesCleared: readonly string[] = [];
    try {
      if (location === null) await api<StoreResponse>('POST', collection, parsed.data);
      else boxesCleared = (await api<LocationUpdateResponse>('PATCH', `${collection}/${encodeURIComponent(location.id)}`, parsed.data)).boxesCleared ?? [];
    } catch (e) {
      if (isFieldProblem(e)) putFieldErrors(form, serverIssues(e, message));
      else setProblem(e);
      // Someone else changed it: the tree is read again, so the form opened again starts from the location as it is now.
      if (isStale(e)) await queryClient.invalidateQueries({ queryKey: ['catalog', 'locations'] });
      return;
    }
    form.reset(values);
    const moved: LocationSaved['moved'] = {};
    if ('parentId' in fields) moved.parentId = fields['parentId'] as string | null;
    if ('kind' in fields) moved.kind = fields['kind'] as LocationKind;
    await onSaved({ id: location?.id ?? null, name: values.name.trim(), moved: location !== null && Object.keys(moved).length > 0 ? moved : null, boxesCleared });
  });
  // An error on a path no input registers would hold the form invalid for good: every submission starts clean.
  const submit = (e?: BaseSyntheticEvent): Promise<void> => {
    form.clearErrors();
    return save(e);
  };

  return (
    <form noValidate className="grid max-w-3xl gap-4" onSubmit={(e) => void submit(e)}>
      <ProblemAlert error={problem} />
      <RootError message={errors.root?.['server']?.message} />
      <div className="grid gap-x-5 gap-y-4 sm:grid-cols-2">
        <Field label={t('catalog.locations.field.kind')} error={errors.kind}>
          {(c) => (
            <select {...c} className={SELECT_CLASS} disabled={disabled} {...form.register('kind', { onChange: (e: { target: { value: string } }) => kindChanged(e.target.value as LocationKind) })}>
              {LOCATION_KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(vocabKey('location_kind', k))}
                </option>
              ))}
            </select>
          )}
        </Field>
        {kind !== 'room' && (
          <Field
            label={t('catalog.locations.field.parent')}
            hint={parents.length === 0 ? t('catalog.locations.field.parent_none') : undefined}
            error={errors.parentId}>
            {(c) => (
              <select {...c} className={SELECT_CLASS} disabled={disabled} {...form.register('parentId')}>
                {parents.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}
      </div>
      <p className="-mt-2 text-xs text-muted-foreground">{t('catalog.locations.field.kind_hint')}</p>
      <div className="grid gap-x-5 gap-y-4 sm:grid-cols-2">
        <Field label={t('catalog.locations.field.code')} hint={t('catalog.locations.field.code_hint')} error={errors.code}>
          {(c) => <Input {...c} autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={32} disabled={disabled} {...form.register('code')} />}
        </Field>
        <Field label={t('catalog.locations.field.name')} error={errors.name}>
          {(c) => <Input {...c} autoComplete="off" maxLength={191} disabled={disabled} {...form.register('name')} />}
        </Field>
      </div>
      <Field label={t('catalog.locations.field.shelf_hint')} hint={t('catalog.locations.field.shelf_hint_hint')} error={errors.shelfHint}>
        {(c) => <Input {...c} autoComplete="off" maxLength={40} disabled={disabled} {...form.register('shelfHint')} />}
      </Field>
      {kind === 'shelf' && (
        <div className="grid gap-2">
          <div className="grid gap-x-5 gap-y-4 sm:grid-cols-2">
            <Field label={t('catalog.locations.field.class_from')} error={errors.classFrom}>
              {(c) => <Input {...c} autoComplete="off" spellCheck={false} maxLength={32} disabled={disabled} {...form.register('classFrom')} />}
            </Field>
            <Field label={t('catalog.locations.field.class_to')} error={errors.classTo}>
              {(c) => <Input {...c} autoComplete="off" spellCheck={false} maxLength={32} disabled={disabled} {...form.register('classTo')} />}
            </Field>
          </div>
          <p className="text-xs text-muted-foreground">{t('catalog.locations.field.class_hint')}</p>
        </div>
      )}
      <div className="grid items-end gap-x-5 gap-y-4 sm:grid-cols-2">
        <CheckField label={t('catalog.locations.field.is_public')} disabled={disabled} {...form.register('isPublic')} />
        <Field label={t('catalog.locations.field.sort_order')} error={errors.sortOrder} className="max-w-40">
          {(c) => <Input {...c} type="number" inputMode="numeric" min={0} step={1} disabled={disabled} {...form.register('sortOrder')} />}
        </Field>
      </div>
      <div className="flex flex-wrap gap-2">
        {canManage && (
          <Button type="submit" size="sm" disabled={isSubmitting}>
            {t(isSubmitting ? 'form.saving' : 'form.save')}
          </Button>
        )}
        <Button type="button" size="sm" variant="outline" className="bg-background" onClick={onCancel}>
          {t(canManage ? 'form.cancel' : 'catalog.locations.form.close')}
        </Button>
      </div>
    </form>
  );
}
