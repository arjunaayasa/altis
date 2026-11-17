import { FIELD_STATES, RECORD_FIELD_NAMES, vocabKey, type FieldState, type RecordFieldName } from '@altis/shared';
import type { CollectionTypeView, CustomFieldView, LanguageView, MaterialTypeTemplate } from '@altis/shared/api/catalog/masters';
import { useId } from 'react';
import { useWatch, type UseFormReturn } from 'react-hook-form';
import { Field, SELECT_CLASS } from '@/components/form-field';
import { TABLE } from '@/components/layout';
import { useLocale, useT } from '@/i18n';
import { fieldErrorText } from '@/lib/form-errors';
import { cn } from '@/lib/utils';

/**
 * The template of a material type (Phase 2 spec §3.8; plan Task 27): how the record editor and the server treat each
 * record field (`RECORD_FIELD_NAMES`: hidden, optional or required; the title is always required), the defaults of a
 * new record (language) and of its items (collection type), and the custom fields of records the editor shows, in
 * their order. The form keeps every field's state; {@link templateBody} sends only those that are not `optional`
 * (the default), so an unchanged template compares equal however it was stored.
 *
 * A default or a custom field that is archived stays selectable only while the stored template already names it (the
 * server accepts it then, Task 12): it is marked "(diarsipkan)", and a new one cannot be picked. Server errors under
 * `template.*` (`not_found`, `archived`, `duplicate`) land on their select or under the custom fields.
 */

/** The template as the form edits it: every field's state, the defaults as select values ('' = none). */
export interface TemplateValues {
  fields: Record<RecordFieldName, FieldState>;
  defaults: { collectionTypeId: string; languageId: string };
  customFields: string[];
}

/** A material type as its form edits it (numbers as their text). */
export interface MaterialTypeValues {
  code: string;
  nameId: string;
  nameEn: string;
  marcType: string;
  marcLevel: string;
  contentType: string;
  mediaType: string;
  carrierType: string;
  schemaType: string;
  dcmiType: string;
  sortOrder: string;
  template: TemplateValues;
}

/** The form's template of a stored one. */
export function templateValues(stored: MaterialTypeTemplate): TemplateValues {
  const fields = Object.fromEntries(RECORD_FIELD_NAMES.map((name) => [name, stored.fields[name] ?? 'optional'])) as Record<RecordFieldName, FieldState>;
  return {
    fields,
    defaults: { collectionTypeId: stored.defaults.collectionTypeId ?? '', languageId: stored.defaults.languageId ?? '' },
    customFields: [...stored.customFields],
  };
}

/** The template to send: only the fields that are not `optional`, in the spec's order; no empty default. */
export function templateBody(v: TemplateValues): MaterialTypeTemplate {
  const fields: MaterialTypeTemplate['fields'] = {};
  for (const name of RECORD_FIELD_NAMES) if (v.fields[name] !== 'optional') fields[name] = v.fields[name];
  const defaults: MaterialTypeTemplate['defaults'] = {};
  if (v.defaults.collectionTypeId !== '') defaults.collectionTypeId = v.defaults.collectionTypeId;
  if (v.defaults.languageId !== '') defaults.languageId = v.defaults.languageId;
  return { fields, defaults, customFields: [...v.customFields] };
}

/** A code as the server compares it (`normalizeKey`: NFKC, trimmed, inner spaces collapsed, upper case). */
const codeKey = (code: string): string => code.normalize('NFKC').trim().replace(/\s+/g, ' ').toUpperCase();

export function TemplateEditor({
  form,
  disabled,
  languages,
  collectionTypes,
  customFields,
}: {
  form: UseFormReturn<MaterialTypeValues>;
  disabled: boolean;
  /** The languages, archived ones included. */
  languages: readonly LanguageView[];
  /** The collection types, archived ones included. */
  collectionTypes: readonly CollectionTypeView[];
  /** The custom fields of records, archived ones included. */
  customFields: readonly CustomFieldView[];
}) {
  const t = useT();
  const locale = useLocale();
  const ids = useId();
  const errors = form.formState.errors.template;
  const defaults = form.formState.defaultValues?.template;
  const chosen = useWatch({ control: form.control, name: 'template.customFields' });
  const chosenKeys = new Set(chosen.map(codeKey));

  /** Live rows, plus an archived one the stored template names (marked). */
  const offered = <R extends { id: string; archived: boolean }>(rows: readonly R[], stored: string | undefined): R[] =>
    rows.filter((r) => !r.archived || r.id === stored);
  const named = (r: { nameId: string; nameEn: string; archived: boolean; code: string }): string => {
    const name = `${locale === 'en' ? r.nameEn : r.nameId} (${r.code})`;
    return r.archived ? t('catalog.masters.mt.archived_option', { name }) : name;
  };

  const fieldLabel = (f: CustomFieldView): string => {
    const name = `${locale === 'en' ? (f.labelEn ?? f.labelId) : f.labelId} (${f.code})`;
    return f.archived ? t('catalog.masters.mt.archived_option', { name }) : name;
  };
  const storedFields = new Set((defaults?.customFields ?? []).filter((c): c is string => typeof c === 'string').map(codeKey));
  const shownFields = customFields.filter((f) => !f.archived || storedFields.has(codeKey(f.code)) || chosenKeys.has(codeKey(f.code)));
  const unknownCodes = chosen.filter((c) => !customFields.some((f) => codeKey(f.code) === codeKey(c)));

  const toggle = (code: string, on: boolean): void => {
    const rest = chosen.filter((c) => codeKey(c) !== codeKey(code));
    form.setValue('template.customFields', on ? [...rest, code] : rest, { shouldDirty: true });
    form.clearErrors('template.customFields');
  };

  // The errors under the custom fields: on the list itself, or on one of its codes (by its index in the template).
  const listErrors = errors?.customFields;
  const customErrors: { key: string; code: string | null; text: string }[] = [];
  if (listErrors !== undefined) {
    if (listErrors.root !== undefined) customErrors.push({ key: 'root', code: null, text: fieldErrorText(t, listErrors.root) ?? '' });
    if (typeof listErrors.message === 'string') customErrors.push({ key: 'list', code: null, text: fieldErrorText(t, listErrors) ?? '' });
    for (const [index, error] of Object.entries(listErrors)) {
      if (!/^\d+$/.test(index) || error === undefined || error === null || typeof error !== 'object') continue;
      customErrors.push({ key: index, code: chosen[Number(index)] ?? null, text: fieldErrorText(t, error as { type?: string; message?: string }) ?? '' });
    }
  }

  return (
    <div className="grid gap-6">
      <div className={TABLE.wrap}>
        <table className={TABLE.table}>
          <caption className="sr-only">{t('catalog.masters.mt.template_caption')}</caption>
          <thead>
            <tr>
              <th scope="col" className={TABLE.th}>
                {t('catalog.masters.mt.col.field')}
              </th>
              <th scope="col" className={TABLE.th}>
                {t('catalog.masters.mt.col.state')}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row" className={cn(TABLE.td, 'text-left font-normal')}>
                {t('catalog.masters.mt.title_field')}
              </th>
              <td className={cn(TABLE.td, 'text-muted-foreground')}>{t('catalog.masters.mt.title_always')}</td>
            </tr>
            {RECORD_FIELD_NAMES.map((name) => {
              const id = `${ids}-${name}`;
              const error = fieldErrorText(t, errors?.fields?.[name]);
              return (
                <tr key={name}>
                  <th scope="row" className={cn(TABLE.td, 'py-1.5 text-left align-middle font-normal')}>
                    <label htmlFor={id}>{t(vocabKey('field', name))}</label>
                  </th>
                  <td className={cn(TABLE.td, 'py-1.5')}>
                    <select
                      id={id}
                      className={`${SELECT_CLASS} max-w-48`}
                      disabled={disabled}
                      aria-invalid={error === undefined ? undefined : true}
                      aria-describedby={error === undefined ? undefined : `${id}-error`}
                      {...form.register(`template.fields.${name}`)}>
                      {FIELD_STATES.map((state) => (
                        <option key={state} value={state}>
                          {t(vocabKey('field_state', state))}
                        </option>
                      ))}
                    </select>
                    {error !== undefined && (
                      <p id={`${id}-error`} className="mt-1 text-meta font-semibold text-bad">
                        {error}
                      </p>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <fieldset className="grid gap-x-5 gap-y-4 sm:grid-cols-2">
        <legend className="mb-3 text-sm font-bold">{t('catalog.masters.mt.defaults')}</legend>
        <Field label={t('catalog.masters.mt.default_language')} error={errors?.defaults?.languageId}>
          {(c) => (
            <select {...c} className={SELECT_CLASS} disabled={disabled} {...form.register('template.defaults.languageId')}>
              <option value="">{t('catalog.masters.mt.default_none')}</option>
              {offered(languages, defaults?.defaults?.languageId).map((l) => (
                <option key={l.id} value={l.id}>
                  {named(l)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label={t('catalog.masters.mt.default_collection_type')} error={errors?.defaults?.collectionTypeId}>
          {(c) => (
            <select {...c} className={SELECT_CLASS} disabled={disabled} {...form.register('template.defaults.collectionTypeId')}>
              <option value="">{t('catalog.masters.mt.default_none')}</option>
              {offered(collectionTypes, defaults?.defaults?.collectionTypeId).map((c) => (
                <option key={c.id} value={c.id}>
                  {named(c)}
                </option>
              ))}
            </select>
          )}
        </Field>
      </fieldset>

      <fieldset className="grid gap-3" aria-describedby={`${ids}-custom-hint`}>
        <legend className="mb-1 text-sm font-bold">{t('catalog.masters.mt.custom_fields')}</legend>
        <p id={`${ids}-custom-hint`} className="text-xs text-muted-foreground">
          {t('catalog.masters.mt.custom_fields_hint')}
        </p>
        {shownFields.length === 0 && unknownCodes.length === 0 && <p className="text-sm text-muted-foreground">{t('catalog.masters.mt.custom_none')}</p>}
        <div className="grid gap-2 sm:grid-cols-2">
          {shownFields.map((f) => (
            <CustomFieldCheck
              key={f.id}
              label={fieldLabel(f)}
              checked={chosenKeys.has(codeKey(f.code))}
              disabled={disabled || (f.archived && !chosenKeys.has(codeKey(f.code)))}
              onChange={(on) => toggle(f.code, on)}
            />
          ))}
          {unknownCodes.map((code) => (
            <CustomFieldCheck key={`code-${code}`} label={code} checked disabled={disabled} onChange={(on) => toggle(code, on)} />
          ))}
        </div>
        {customErrors.map((e) => (
          <p key={e.key} className="text-meta font-semibold text-bad">
            {e.code !== null && <span>{e.code}: </span>}
            <span>{e.text}</span>
          </p>
        ))}
      </fieldset>
    </div>
  );
}

function CustomFieldCheck({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled: boolean; onChange(on: boolean): void }) {
  const id = useId();
  return (
    <div className="flex items-start gap-2">
      <input
        id={id}
        type="checkbox"
        className="mt-0.5 size-4 shrink-0 accent-primary focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <label htmlFor={id} className="text-sm leading-snug">
        {label}
      </label>
    </div>
  );
}
