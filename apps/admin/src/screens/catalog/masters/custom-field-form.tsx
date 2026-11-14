import { CUSTOM_FIELD_ENTITIES, CUSTOM_FIELD_TYPES, vocabKey, type CustomFieldEntity, type CustomFieldType } from '@altis/shared';
import { CustomFieldBody, CustomFieldPatchBody, type CustomFieldView } from '@altis/shared/api/catalog/masters';
import { PlusIcon, TrashIcon } from 'lucide-react';
import { useFieldArray, useForm, useWatch } from 'react-hook-form';
import { CheckField, Field, ProblemAlert, RootError, SELECT_CLASS } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useT } from '@/i18n';
import { useDirtyGuard } from '@/lib/dirty-forms';
import { fieldErrorText } from '@/lib/form-errors';
import { changedFields, optionalText, orderValue, useMasterSave, type ErrorMessage, type MasterFormProps } from './master-table';

/**
 * A custom field (Phase 2 spec §3.7; `POST`/`PATCH catalog/custom-fields`): for records or items, its value type, code,
 * labels in both languages, whether it is required, shown on the OPAC ("Informasi lain") and searchable, its order,
 * and for a `select`/`multiselect` field its options (`{value, labelId, labelEn}`, at least one, values distinct).
 *
 * The entity and the value type never change once the field exists (the strict patch refuses them): an edit shows
 * them as text. An edit sends only what changed, the options as a whole. Field errors of the server land on their
 * field: an option's `duplicate` value on that option, `options` `required`/`not_allowed` under the options.
 */

/** The value types whose value is one or more of the field's options. */
const CHOICE_TYPES: readonly CustomFieldType[] = ['select', 'multiselect'];

interface OptionValues {
  value: string;
  labelId: string;
  labelEn: string;
}

interface CustomFieldValues {
  entity: CustomFieldEntity;
  type: CustomFieldType;
  code: string;
  labelId: string;
  labelEn: string;
  options: OptionValues[];
  required: boolean;
  sortOrder: string;
  isPublic: boolean;
  isSearchable: boolean;
}

function valuesOf(row: CustomFieldView | null): CustomFieldValues {
  if (row === null) {
    return { entity: 'records', type: 'text', code: '', labelId: '', labelEn: '', options: [], required: false, sortOrder: '0', isPublic: false, isSearchable: false };
  }
  return {
    entity: row.entity,
    type: row.type,
    code: row.code,
    labelId: row.labelId,
    labelEn: row.labelEn ?? '',
    options: row.options.map((o) => ({ value: o.value, labelId: o.labelId, labelEn: o.labelEn ?? '' })),
    required: row.required,
    sortOrder: String(row.sortOrder),
    isPublic: row.isPublic,
    isSearchable: row.isSearchable,
  };
}

/** The editable fields as the API takes them (options only for a choice type). */
function bodyOf(v: CustomFieldValues): Record<string, unknown> {
  return {
    code: v.code.trim(),
    labelId: v.labelId.trim(),
    labelEn: optionalText(v.labelEn),
    ...(CHOICE_TYPES.includes(v.type)
      ? { options: v.options.map((o) => ({ value: o.value.trim(), labelId: o.labelId.trim(), labelEn: optionalText(o.labelEn) })) }
      : {}),
    required: v.required,
    sortOrder: orderValue(v.sortOrder),
    isPublic: v.isPublic,
    isSearchable: v.isSearchable,
  };
}

const OPTION_VALUE = /^options\.\d+\.value$/;

/** The messages of the checks without a `form.error.*` text. */
const message: ErrorMessage = (path, code) => {
  if (path === 'options' && code === 'required') return 'catalog.masters.options.required';
  if (path === 'options' && code === 'not_allowed') return 'catalog.masters.options.not_allowed';
  if (OPTION_VALUE.test(path) && code === 'duplicate') return 'catalog.masters.options.duplicate';
  return undefined;
};

/** An error on the options as a whole belongs to the field array's root. */
const fieldOf = (path: string): string | undefined => (path === 'options' ? 'options.root' : undefined);

export function CustomFieldForm({ row, canManage, onSaved, onCancel }: MasterFormProps<CustomFieldView>) {
  const t = useT();
  const form = useForm<CustomFieldValues>({ defaultValues: valuesOf(row) });
  const { fields: options, append, remove } = useFieldArray({ control: form.control, name: 'options' });
  const type = useWatch({ control: form.control, name: 'type' });
  // ---- Komunitas K2 (members): a member's custom field is never public nor searchable ----
  const forMembers = useWatch({ control: form.control, name: 'entity' }) === 'members';
  const { errors, isDirty, isSubmitting } = form.formState;
  useDirtyGuard(isDirty);
  const base = valuesOf(row);
  const { submit, problem } = useMasterSave({
    kind: 'custom-fields',
    form,
    row,
    message,
    fieldOf,
    schema: { create: CustomFieldBody, patch: CustomFieldPatchBody },
    body: (v) => (row === null ? { entity: v.entity, type: v.type, ...bodyOf(v) } : changedFields(bodyOf(v), bodyOf(base))),
    onSaved,
    onUnchanged: onCancel,
  });
  const disabled = !canManage;
  const choice = CHOICE_TYPES.includes(type);
  const optionsError = errors.options?.root;

  return (
    <form noValidate className="grid gap-4" onSubmit={(e) => void submit(e)}>
      <ProblemAlert error={problem} />
      <RootError message={errors.root?.['server']?.message} />
      {row === null ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('catalog.masters.field.entity')} error={errors.entity}>
            {(c) => (
              <select {...c} className={SELECT_CLASS} disabled={disabled} {...form.register('entity')}>
                {CUSTOM_FIELD_ENTITIES.map((e) => (
                  <option key={e} value={e}>
                    {t(vocabKey('custom_field_entity', e))}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label={t('catalog.masters.field.type')} error={errors.type}>
            {(c) => (
              <select {...c} className={SELECT_CLASS} disabled={disabled} {...form.register('type')}>
                {CUSTOM_FIELD_TYPES.map((v) => (
                  <option key={v} value={v}>
                    {t(vocabKey('custom_field_type', v))}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
      ) : (
        <div className="grid gap-1">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">{t('catalog.masters.field.entity')}</dt>
            <dd>{t(vocabKey('custom_field_entity', row.entity))}</dd>
            <dt className="text-muted-foreground">{t('catalog.masters.field.type')}</dt>
            <dd>{t(vocabKey('custom_field_type', row.type))}</dd>
          </dl>
          <p className="text-xs text-muted-foreground">{t('catalog.masters.field.fixed_hint')}</p>
        </div>
      )}
      <Field label={t('catalog.masters.field.code')} hint={t('catalog.masters.field.code_hint')} error={errors.code}>
        {(c) => <Input {...c} autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={32} disabled={disabled} {...form.register('code')} />}
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('catalog.masters.field.label_id')} error={errors.labelId}>
          {(c) => <Input {...c} autoComplete="off" maxLength={191} disabled={disabled} {...form.register('labelId')} />}
        </Field>
        <Field label={t('catalog.masters.field.label_en')} error={errors.labelEn}>
          {(c) => <Input {...c} autoComplete="off" maxLength={191} disabled={disabled} {...form.register('labelEn')} />}
        </Field>
      </div>
      {choice && (
        <fieldset className="grid gap-3 rounded-md border p-3">
          <legend className="px-1 text-sm font-medium">{t('catalog.masters.options.legend')}</legend>
          <p className="text-xs text-muted-foreground">{t('catalog.masters.options.hint')}</p>
          {options.length === 0 && <p className="text-sm text-muted-foreground">{t('catalog.masters.options.none')}</p>}
          {options.map((option, i) => {
            const n = i + 1;
            const own = errors.options?.[i];
            return (
              <div key={option.id} className="grid items-start gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
                <Field label={t('catalog.masters.options.value', { n })} error={own?.value}>
                  {(c) => <Input {...c} autoComplete="off" maxLength={191} disabled={disabled} {...form.register(`options.${i}.value`)} />}
                </Field>
                <Field label={t('catalog.masters.options.label_id', { n })} error={own?.labelId}>
                  {(c) => <Input {...c} autoComplete="off" maxLength={191} disabled={disabled} {...form.register(`options.${i}.labelId`)} />}
                </Field>
                <Field label={t('catalog.masters.options.label_en', { n })} error={own?.labelEn}>
                  {(c) => <Input {...c} autoComplete="off" maxLength={191} disabled={disabled} {...form.register(`options.${i}.labelEn`)} />}
                </Field>
                {canManage && (
                  <Button type="button" variant="ghost" size="icon" className="sm:mt-6" aria-label={t('catalog.masters.options.remove', { n })} onClick={() => remove(i)}>
                    <TrashIcon aria-hidden="true" />
                  </Button>
                )}
              </div>
            );
          })}
          {optionsError !== undefined && (
            <p role="alert" className="text-sm text-destructive">
              {fieldErrorText(t, optionsError)}
            </p>
          )}
          {canManage && (
            <div>
              <Button type="button" variant="outline" size="sm" onClick={() => append({ value: '', labelId: '', labelEn: '' })}>
                <PlusIcon aria-hidden="true" />
                {t('catalog.masters.options.add')}
              </Button>
            </div>
          )}
        </fieldset>
      )}
      <div className="grid gap-3">
        <CheckField label={t('catalog.masters.field.required')} hint={t('catalog.masters.field.required_hint')} disabled={disabled} {...form.register('required')} />
        {!forMembers && (
          <>
            <CheckField label={t('catalog.masters.field.is_public')} hint={t('catalog.masters.field.is_public_hint')} disabled={disabled} {...form.register('isPublic')} />
            <CheckField
              label={t('catalog.masters.field.is_searchable')}
              hint={t('catalog.masters.field.is_searchable_hint')}
              disabled={disabled}
              {...form.register('isSearchable')}
            />
          </>
        )}
      </div>
      <Field label={t('catalog.masters.field.sort_order')} hint={t('catalog.masters.field.sort_order_hint')} error={errors.sortOrder} className="max-w-40">
        {(c) => <Input {...c} type="number" inputMode="numeric" min={0} step={1} disabled={disabled} {...form.register('sortOrder')} />}
      </Field>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          {t(canManage ? 'form.cancel' : 'catalog.masters.close')}
        </Button>
        {canManage && (
          <Button type="submit" disabled={isSubmitting}>
            {t(isSubmitting ? 'form.saving' : 'form.save')}
          </Button>
        )}
      </DialogFooter>
    </form>
  );
}
