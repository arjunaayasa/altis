import type { CustomFieldView, MaterialTypeTemplate } from '@altis/shared/api/catalog/masters';
import { useEffect, useId } from 'react';
import { Controller, useFieldArray, type UseFormReturn } from 'react-hook-form';
import { Field, SELECT_CLASS, TEXTAREA_CLASS } from '@/components/form-field';
import { Input } from '@/components/ui/input';
import { useLocale, useT } from '@/i18n';
import { fieldErrorText } from '@/lib/form-errors';
import { ErrorText, errorAt } from './agent-picker';
import { emptyCustomValue, shownCustomFields, type CustomFormValue, type RecordFormValues } from './draft-to-form';

/**
 * The custom fields of a record (Phase 2 spec §3.7, §3.8; plan Task 24): the live fields of `GET
 * catalog/custom-fields?entity=records` that the material type's template shows (`customFields`), in their order,
 * each by its type: text, long text, number, date, a choice or several, yes/no, a web address. A required one is
 * marked; the server checks every value against the definitions again.
 *
 * The form keeps them as `customValues.<i>` rows (a code may hold a `.`, which a form path cannot); a field the
 * template starts to show (another material type was chosen) gets an empty row here.
 *
 * {@link CustomFieldInputs} draws the same fields from plain values by code, for the forms that are not this record
 * form: the item forms (quick add, batch, the item page), whose fields are every live `entity=items` definition.
 */
export function CustomFieldsSection({
  form,
  template,
  defs,
}: {
  form: UseFormReturn<RecordFormValues>;
  template: MaterialTypeTemplate;
  defs: readonly CustomFieldView[];
}) {
  const t = useT();
  const locale = useLocale();
  const { control, register, getValues } = form;
  const { fields, append } = useFieldArray({ control, name: 'customValues' });
  const shown = shownCustomFields(template, defs);
  const errors = form.formState.errors;

  // A field shown by the template but without a row yet (the material type changed): give it one. The rows are read
  // from the form's values, not from `fields`, which may still be the previous ones right after a reset.
  useEffect(() => {
    const rows = getValues('customValues');
    const missing = shown.filter((d) => !rows.some((r) => r.code === d.code));
    if (missing.length > 0) append(missing.map((d) => ({ code: d.code, value: emptyCustomValue(d) })));
  });

  if (shown.length === 0) return null;
  return (
    <fieldset className="grid min-w-0 gap-4 sm:grid-cols-2">
      <legend className="mb-1 text-sm font-medium">{t('catalog.records.section.custom')}</legend>
      {shown.map((def) => {
        const index = fields.findIndex((f) => f.code === def.code);
        if (index < 0) return null;
        const name = `customValues.${index}.value` as const;
        const plain = locale === 'en' ? (def.labelEn ?? def.labelId) : def.labelId;
        const label = def.required ? t('catalog.records.required', { label: plain }) : plain;
        const error = errorAt(errors, name);
        const optionLabel = (o: CustomFieldView['options'][number]): string => (locale === 'en' ? (o.labelEn ?? o.labelId) : o.labelId);
        switch (def.type) {
          case 'longtext':
            return (
              <Field key={def.id} label={label} error={error} className="sm:col-span-2">
                {(c) => <textarea {...c} className={TEXTAREA_CLASS} aria-required={def.required || undefined} {...register(name)} />}
              </Field>
            );
          case 'select':
            return (
              <Field key={def.id} label={label} error={error}>
                {(c) => (
                  <select {...c} className={SELECT_CLASS} aria-required={def.required || undefined} {...register(name)}>
                    <option value="">{t('catalog.records.field.none')}</option>
                    {def.options.map((o) => (
                      <option key={o.value} value={o.value}>
                        {optionLabel(o)}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            );
          case 'boolean':
            return (
              <Field key={def.id} label={label} error={error}>
                {(c) => (
                  <select {...c} className={SELECT_CLASS} aria-required={def.required || undefined} {...register(name)}>
                    <option value="">{t('catalog.records.field.none')}</option>
                    <option value="true">{t('form.yes')}</option>
                    <option value="false">{t('form.no')}</option>
                  </select>
                )}
              </Field>
            );
          case 'multiselect':
            return <MultiSelect key={def.id} form={form} name={name} label={label} def={def} optionLabel={optionLabel} error={error} />;
          default: {
            const type = def.type === 'number' ? 'number' : def.type === 'date' ? 'date' : def.type === 'url' ? 'url' : 'text';
            return (
              <Field key={def.id} label={label} error={error}>
                {(c) => (
                  <Input
                    {...c}
                    type={type}
                    step={type === 'number' ? 'any' : undefined}
                    maxLength={def.type === 'url' ? 2000 : def.type === 'text' ? 1000 : undefined}
                    autoComplete="off"
                    aria-required={def.required || undefined}
                    {...register(name)}
                  />
                )}
              </Field>
            );
          }
        }
      })}
    </fieldset>
  );
}

/** A `multiselect` field: one checkbox per option, its value the list of the ticked ones. */
function MultiSelect({
  form,
  name,
  label,
  def,
  optionLabel,
  error,
}: {
  form: UseFormReturn<RecordFormValues>;
  name: `customValues.${number}.value`;
  label: string;
  def: CustomFieldView;
  optionLabel(o: CustomFieldView['options'][number]): string;
  error: ReturnType<typeof errorAt>;
}) {
  const errorId = useId();
  return (
    <Controller
      control={form.control}
      name={name}
      render={({ field }) => {
        const picked = Array.isArray(field.value) ? field.value : field.value === '' ? [] : [field.value];
        const toggle = (value: string, on: boolean): void => field.onChange(on ? [...picked, value] : picked.filter((v) => v !== value));
        return (
          <fieldset className="grid content-start gap-2" aria-invalid={error === undefined ? undefined : true} aria-describedby={error === undefined ? undefined : errorId}>
            <legend className="mb-1 text-sm font-medium">{label}</legend>
            {def.options.map((o) => (
              <label key={o.value} className="flex items-center gap-2 text-sm">
                <input type="checkbox" className="size-4 accent-primary" checked={picked.includes(o.value)} onChange={(e) => toggle(o.value, e.target.checked)} />
                {optionLabel(o)}
              </label>
            ))}
            <ErrorText id={errorId} error={error} />
          </fieldset>
        );
      }}
    />
  );
}

/** The custom values of a form that keeps them by code (not in a react-hook-form path). */
export type CustomValuesByCode = Readonly<Record<string, CustomFormValue>>;

/**
 * The custom fields `defs` (live ones, in the given order) drawn from `values` by code, each by its type as in
 * {@link CustomFieldsSection}; `onChange` gets the field's new value. `errors` holds a message key per code.
 */
export function CustomFieldInputs({
  defs,
  values,
  errors = {},
  disabled = false,
  onChange,
}: {
  defs: readonly CustomFieldView[];
  values: CustomValuesByCode;
  errors?: Readonly<Partial<Record<string, string>>>;
  disabled?: boolean;
  onChange(code: string, value: CustomFormValue): void;
}) {
  const t = useT();
  const locale = useLocale();
  if (defs.length === 0) return null;
  return (
    <fieldset className="grid min-w-0 gap-4 sm:grid-cols-2">
      <legend className="mb-1 text-sm font-medium">{t('catalog.records.section.custom')}</legend>
      {defs.map((def) => {
        const plain = locale === 'en' ? (def.labelEn ?? def.labelId) : def.labelId;
        const label = def.required ? t('catalog.records.required', { label: plain }) : plain;
        const error = Object.prototype.hasOwnProperty.call(errors, def.code) ? errors[def.code] : undefined;
        const value = Object.prototype.hasOwnProperty.call(values, def.code) ? values[def.code]! : emptyCustomValue(def);
        const text = Array.isArray(value) ? (value[0] ?? '') : value;
        const optionLabel = (o: CustomFieldView['options'][number]): string => (locale === 'en' ? (o.labelEn ?? o.labelId) : o.labelId);
        const set = (next: CustomFormValue): void => onChange(def.code, next);
        switch (def.type) {
          case 'longtext':
            return (
              <Field key={def.id} label={label} error={error} className="sm:col-span-2">
                {(c) => (
                  <textarea
                    {...c}
                    className={TEXTAREA_CLASS}
                    aria-required={def.required || undefined}
                    disabled={disabled}
                    value={text}
                    onChange={(e) => set(e.target.value)}
                  />
                )}
              </Field>
            );
          case 'select':
          case 'boolean':
            return (
              <Field key={def.id} label={label} error={error}>
                {(c) => (
                  <select {...c} className={SELECT_CLASS} aria-required={def.required || undefined} disabled={disabled} value={text} onChange={(e) => set(e.target.value)}>
                    <option value="">{t('catalog.records.field.none')}</option>
                    {def.type === 'boolean' ? (
                      <>
                        <option value="true">{t('form.yes')}</option>
                        <option value="false">{t('form.no')}</option>
                      </>
                    ) : (
                      def.options.map((o) => (
                        <option key={o.value} value={o.value}>
                          {optionLabel(o)}
                        </option>
                      ))
                    )}
                  </select>
                )}
              </Field>
            );
          case 'multiselect':
            return <MultiSelectInput key={def.id} def={def} label={label} value={value} error={error} disabled={disabled} optionLabel={optionLabel} onChange={set} />;
          default: {
            const type = def.type === 'number' ? 'number' : def.type === 'date' ? 'date' : def.type === 'url' ? 'url' : 'text';
            return (
              <Field key={def.id} label={label} error={error}>
                {(c) => (
                  <Input
                    {...c}
                    type={type}
                    step={type === 'number' ? 'any' : undefined}
                    maxLength={def.type === 'url' ? 2000 : def.type === 'text' ? 1000 : undefined}
                    autoComplete="off"
                    aria-required={def.required || undefined}
                    disabled={disabled}
                    value={text}
                    onChange={(e) => set(e.target.value)}
                  />
                )}
              </Field>
            );
          }
        }
      })}
    </fieldset>
  );
}

/** A `multiselect` field of {@link CustomFieldInputs}: one checkbox per option. */
function MultiSelectInput({
  def,
  label,
  value,
  error,
  disabled,
  optionLabel,
  onChange,
}: {
  def: CustomFieldView;
  label: string;
  value: CustomFormValue;
  error: string | undefined;
  disabled: boolean;
  optionLabel(o: CustomFieldView['options'][number]): string;
  onChange(value: string[]): void;
}) {
  const t = useT();
  const errorId = useId();
  const picked = Array.isArray(value) ? value : value === '' ? [] : [value];
  const message = error === undefined ? undefined : fieldErrorText(t, { message: error });
  return (
    <fieldset className="grid content-start gap-2" aria-invalid={message === undefined ? undefined : true} aria-describedby={message === undefined ? undefined : errorId}>
      <legend className="mb-1 text-sm font-medium">{label}</legend>
      {def.options.map((o) => (
        <label key={o.value} className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4 accent-primary"
            disabled={disabled}
            checked={picked.includes(o.value)}
            onChange={(e) => onChange(e.target.checked ? [...picked, o.value] : picked.filter((v) => v !== o.value))}
          />
          {optionLabel(o)}
        </label>
      ))}
      {message !== undefined && (
        <p id={errorId} className="text-sm text-destructive">
          {message}
        </p>
      )}
    </fieldset>
  );
}
