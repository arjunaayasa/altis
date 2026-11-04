import { RDA_CARRIER_TYPES, RDA_CONTENT_TYPES, RDA_MEDIA_TYPES, type RdaTerm, type RecordFieldName } from '@altis/shared';
import type { CustomFieldView, LanguageView, MaterialTypeTemplate, MaterialTypeView } from '@altis/shared/api/catalog/masters';
import type { RecordDetail } from '@altis/shared/api/catalog/records';
import { useId, type ReactNode } from 'react';
import type { FieldPath, UseFieldArrayReturn, UseFormReturn } from 'react-hook-form';
import { CheckField, Field, SELECT_CLASS, TEXTAREA_CLASS } from '@/components/form-field';
import { Input } from '@/components/ui/input';
import { useLocale, useT, type TKey } from '@/i18n';
import { AgentPicker, errorAt } from './agent-picker';
import { CustomFieldsSection } from './custom-fields';
import { fieldState, shownCustomFields, type RecordFormValues } from './draft-to-form';
import { IdentifiersField } from './identifiers-field';
import { PublisherPicker } from './publisher-picker';
import { RelationsField } from './relations-field';
import { SubjectPicker } from './subject-picker';

/**
 * The sections of the record editor (Phase 2 spec §3.8, §13; plan Task 24), laid out by the material type's
 * template: a field the template hides is not rendered (and not sent, draft-to-form.tsx), a required one is marked
 * "(wajib)" with `aria-required` (the form checks it before sending, the server again). `title` is always required.
 * The labels of the template's fields are the shared `vocab.field.*` ones, so the template editor (Data Induk) and this
 * form name a field alike.
 *
 * On a new record, choosing another material type also takes its RDA codes and default language, unless the
 * librarian already chose them.
 */

/** The masters the sections offer. */
export interface EditorMasters {
  materialTypes: readonly MaterialTypeView[];
  languages: readonly LanguageView[];
  customFields: readonly CustomFieldView[];
}

type TextName = Extract<
  FieldPath<RecordFormValues>,
  | 'title'
  | 'subtitle'
  | 'responsibility'
  | 'edition'
  | 'materialDetail'
  | 'publicationPlace'
  | 'publicationYear'
  | 'publicationDateText'
  | 'physicalDesc'
  | 'series'
  | 'classification'
  | 'callNumber'
>;

/** A section of the form: a card with its heading; nothing when it holds no field. */
function Section({ title, children }: { title: string; children: ReactNode[] | ReactNode }) {
  const headingId = useId();
  const parts = (Array.isArray(children) ? children : [children]).filter((c) => c !== null && c !== false && c !== undefined);
  if (parts.length === 0) return null;
  return (
    <section aria-labelledby={headingId} className="grid min-w-0 gap-4 rounded-lg border bg-card p-4 sm:grid-cols-2">
      <h2 id={headingId} className="text-base font-semibold sm:col-span-2">
        {title}
      </h2>
      {parts}
    </section>
  );
}

/** The label of a field, "(wajib)" when required. */
function useLabel(): (key: TKey, required: boolean) => string {
  const t = useT();
  return (key, required) => (required ? t('catalog.records.required', { label: t(key) }) : t(key));
}

/** A one-line text field of the form. */
function TextField({
  form,
  name,
  labelKey,
  required,
  maxLength,
  wide,
  hint,
  inputMode,
}: {
  form: UseFormReturn<RecordFormValues>;
  name: TextName;
  labelKey: TKey;
  required: boolean;
  maxLength?: number;
  wide?: boolean;
  hint?: string;
  inputMode?: 'numeric';
}) {
  const label = useLabel();
  return (
    <Field label={label(labelKey, required)} error={errorAt(form.formState.errors, name)} className={wide === true ? 'sm:col-span-2' : undefined} {...(hint === undefined ? {} : { hint })}>
      {(c) => <Input {...c} autoComplete="off" maxLength={maxLength} inputMode={inputMode} aria-required={required || undefined} {...form.register(name)} />}
    </Field>
  );
}

/** A free-text field (summary, notes). */
function LongField({ form, name, labelKey, required }: { form: UseFormReturn<RecordFormValues>; name: 'summary' | 'notes'; labelKey: TKey; required: boolean }) {
  const label = useLabel();
  return (
    <Field label={label(labelKey, required)} error={errorAt(form.formState.errors, name)} className="sm:col-span-2">
      {(c) => <textarea {...c} rows={4} className={TEXTAREA_CLASS} aria-required={required || undefined} {...form.register(name)} />}
    </Field>
  );
}

/** One of the three RDA codes, from its official list (terms shown as they are, D2-06). */
function RdaField({
  form,
  name,
  labelKey,
  terms,
  required,
}: {
  form: UseFormReturn<RecordFormValues>;
  name: 'contentType' | 'mediaType' | 'carrierType';
  labelKey: TKey;
  terms: readonly RdaTerm[];
  required: boolean;
}) {
  const t = useT();
  const label = useLabel();
  return (
    <Field label={label(labelKey, required)} error={errorAt(form.formState.errors, name)}>
      {(c) => (
        <select {...c} className={SELECT_CLASS} aria-required={required || undefined} {...form.register(name)}>
          <option value="">{t('catalog.records.field.none')}</option>
          {terms.map((r) => (
            <option key={r.code} value={r.code}>
              {`${r.term} (${r.code})`}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

export function RecordFormSections({
  form,
  masters,
  template,
  identifiers,
  identifierWarnings,
  isNew,
  selfId,
  incoming,
}: {
  form: UseFormReturn<RecordFormValues>;
  masters: EditorMasters;
  template: MaterialTypeTemplate;
  identifiers: UseFieldArrayReturn<RecordFormValues, 'identifiers'>;
  identifierWarnings: ReadonlyMap<string, string>;
  /** A new record: a change of material type brings its defaults. */
  isNew: boolean;
  selfId: string | null;
  incoming: RecordDetail['relations'];
}) {
  const t = useT();
  const locale = useLocale();
  const label = useLabel();
  const { register, getValues, getFieldState, setValue } = form;
  const errors = form.formState.errors;
  const state = (field: RecordFieldName) => fieldState(template, field);
  const shown = (field: RecordFieldName): boolean => state(field) !== 'hidden';
  const required = (field: RecordFieldName): boolean => state(field) === 'required';
  const name = (o: { nameId: string; nameEn: string }): string => (locale === 'en' ? o.nameEn : o.nameId);
  const currentType = getValues('materialTypeId');
  const types = masters.materialTypes.filter((m) => !m.archived || m.id === currentType);
  const currentLanguage = getValues('languageId');
  const languages = masters.languages.filter((l) => !l.archived || l.id === currentLanguage);

  /** A new record takes the new type's defaults where the librarian has not chosen yet. */
  const typeChanged = (id: string): void => {
    if (!isNew) return;
    const type = masters.materialTypes.find((m) => m.id === id);
    if (type === undefined) return;
    for (const key of ['contentType', 'mediaType', 'carrierType'] as const) if (!getFieldState(key).isDirty) setValue(key, type[key]);
    if (!getFieldState('languageId').isDirty) setValue('languageId', type.template.defaults.languageId ?? '');
  };

  return (
    <>
      <Section title={t('catalog.records.section.title')}>
        <Field label={label('catalog.records.field.material_type', true)} error={errorAt(errors, 'materialTypeId')}>
          {(c) => (
            <select {...c} className={SELECT_CLASS} aria-required="true" {...register('materialTypeId', { onChange: (e: { target: { value: string } }) => typeChanged(e.target.value) })}>
              {types.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.archived ? t('catalog.records.field.archived_option', { name: name(m) }) : name(m)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label={label('catalog.records.field.title', true)} error={errorAt(errors, 'title')} className="sm:col-span-2">
          {(c) => <Input {...c} autoComplete="off" aria-required="true" {...register('title')} />}
        </Field>
        {shown('subtitle') && <TextField form={form} name="subtitle" labelKey="vocab.field.subtitle" required={required('subtitle')} wide />}
        {shown('responsibility') && <TextField form={form} name="responsibility" labelKey="vocab.field.responsibility" required={required('responsibility')} wide />}
      </Section>

      {shown('agents') && (
        <section className="rounded-lg border bg-card p-4">
          <AgentPicker form={form} required={required('agents')} />
        </section>
      )}

      <Section title={t('catalog.records.section.publication')}>
        {shown('edition') && <TextField form={form} name="edition" labelKey="vocab.field.edition" required={required('edition')} maxLength={191} />}
        {shown('material_detail') && <TextField form={form} name="materialDetail" labelKey="vocab.field.material_detail" required={required('material_detail')} maxLength={191} />}
        {shown('publisher') && (
          <div className="sm:col-span-2">
            <PublisherPicker form={form} required={required('publisher')} />
          </div>
        )}
        {shown('publication_place') && <TextField form={form} name="publicationPlace" labelKey="vocab.field.publication_place" required={required('publication_place')} maxLength={191} />}
        {shown('publication_year') && <TextField form={form} name="publicationYear" labelKey="vocab.field.publication_year" required={required('publication_year')} maxLength={4} inputMode="numeric" />}
        {shown('publication_year') && (
          <TextField
            form={form}
            name="publicationDateText"
            labelKey="catalog.records.field.publication_date_text"
            required={false}
            maxLength={64}
            hint={t('catalog.records.field.publication_date_text_hint')}
          />
        )}
        {shown('physical_desc') && <TextField form={form} name="physicalDesc" labelKey="vocab.field.physical_desc" required={required('physical_desc')} maxLength={191} />}
        {shown('series') && <TextField form={form} name="series" labelKey="vocab.field.series" required={required('series')} maxLength={191} wide />}
      </Section>

      {shown('identifiers') && (
        <section className="rounded-lg border bg-card p-4">
          <IdentifiersField form={form} array={identifiers} required={required('identifiers')} warnings={identifierWarnings} />
        </section>
      )}

      <Section title={t('catalog.records.section.subjects')}>
        {shown('subjects') && (
          <div className="sm:col-span-2">
            <SubjectPicker form={form} required={required('subjects')} />
          </div>
        )}
        {shown('classification') && <TextField form={form} name="classification" labelKey="vocab.field.classification" required={required('classification')} maxLength={64} />}
        {shown('call_number') && <TextField form={form} name="callNumber" labelKey="vocab.field.call_number" required={required('call_number')} maxLength={64} />}
      </Section>

      <Section title={t('catalog.records.section.content')}>
        {shown('language') && (
          <Field label={label('vocab.field.language', required('language'))} error={errorAt(errors, 'languageId')}>
            {(c) => (
              <select {...c} className={SELECT_CLASS} aria-required={required('language') || undefined} {...register('languageId')}>
                <option value="">{t('catalog.records.field.none')}</option>
                {languages.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.archived ? t('catalog.records.field.archived_option', { name: name(l) }) : name(l)}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}
        {shown('rda') && <RdaField form={form} name="contentType" labelKey="catalog.records.field.content_type" terms={RDA_CONTENT_TYPES} required={required('rda')} />}
        {shown('rda') && <RdaField form={form} name="mediaType" labelKey="catalog.records.field.media_type" terms={RDA_MEDIA_TYPES} required={required('rda')} />}
        {shown('rda') && <RdaField form={form} name="carrierType" labelKey="catalog.records.field.carrier_type" terms={RDA_CARRIER_TYPES} required={required('rda')} />}
        {shown('summary') && <LongField form={form} name="summary" labelKey="vocab.field.summary" required={required('summary')} />}
        {shown('notes') && <LongField form={form} name="notes" labelKey="vocab.field.notes" required={required('notes')} />}
      </Section>

      <section className="rounded-lg border bg-card p-4">
        <RelationsField form={form} selfId={selfId} incoming={incoming} />
      </section>

      <CustomSection form={form} template={template} defs={masters.customFields} />

      <Section title={t('catalog.records.section.opac')}>
        <CheckField label={t('catalog.records.field.opac_visible')} {...register('opacVisible')} />
        <CheckField label={t('catalog.records.field.promoted')} {...register('promoted')} />
      </Section>
    </>
  );
}

/** The custom fields, in a card of their own when the template shows any. */
function CustomSection({ form, template, defs }: { form: UseFormReturn<RecordFormValues>; template: MaterialTypeTemplate; defs: readonly CustomFieldView[] }) {
  if (shownCustomFields(template, defs).length === 0) return null;
  return (
    <section className="rounded-lg border bg-card p-4">
      <CustomFieldsSection form={form} template={template} defs={defs} />
    </section>
  );
}
