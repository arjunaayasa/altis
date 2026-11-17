import {
  AUDIENCES,
  LOCAL_WORKS,
  LOCAL_WORK_KINDS,
  RDA_CARRIER_TYPES,
  RDA_CONTENT_TYPES,
  RDA_MEDIA_TYPES,
  REFERENCE_KINDS,
  type RdaTerm,
  type RecordFieldName,
} from '@altis/shared';
import type { CustomFieldView, LanguageView, MaterialTypeTemplate, MaterialTypeView } from '@altis/shared/api/catalog/masters';
import type { RecordDetail } from '@altis/shared/api/catalog/records';
import { Children, useId, type ReactNode } from 'react';
import type { FieldPath, UseFieldArrayReturn, UseFormReturn } from 'react-hook-form';
import { CheckField, Field, SELECT_CLASS, TEXTAREA_CLASS } from '@/components/form-field';
import { Input } from '@/components/ui/input';
import { useLocale, useT, type TKey } from '@/i18n';
import { AgentPicker, errorAt, useLegend } from './agent-picker';
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
 *
 * The section "Akreditasi" holds the four fields the accreditation report reads (Sasaran pembaca, Karya lokal and its
 * Jenis karya, Jenis referensi), each a value of its shared vocabulary or none. No template hides them. Changing only
 * them does not count a migrated record as edited in ALTIS (the server keeps it in the SLiMS re-sync), and the section
 * says so.
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

/**
 * A part of the editor's form, as the layout's `FormSection` draws one: its title (and a sentence) on the left, above on
 * a narrow screen, its content on the right, a thin rule above every part but the first; nothing when it holds no
 * field. The fields go in two columns (the editor keeps a side column for the cover and the duplicate check), as a
 * fieldset named by the title. A part made of one list field (`list`: the agents, the identifiers, the relations, the
 * custom fields) holds that field's own fieldset, named by the same words, instead of a second one. `introId` lets the
 * sentence describe that list.
 */
export function EditorSection({
  title,
  intro,
  introId,
  list = false,
  children,
}: {
  title: string;
  intro?: ReactNode;
  introId?: string;
  list?: boolean;
  children: ReactNode;
}) {
  const headingId = useId();
  const parts = Children.toArray(children);
  if (parts.length === 0) return null;
  return (
    <section
      aria-labelledby={headingId}
      className="grid gap-x-8 gap-y-4 border-t py-5 first:border-t-0 first:pt-1 md:grid-cols-[180px_minmax(0,1fr)] xl:grid-cols-[200px_minmax(0,1fr)]">
      <div className="grid content-start gap-1">
        <h2 id={headingId} className="text-base font-bold">
          {title}
        </h2>
        {intro !== undefined && (
          <p id={introId} className="text-sm text-muted-foreground">
            {intro}
          </p>
        )}
      </div>
      {list ? (
        <div className="grid min-w-0 content-start gap-4">{parts}</div>
      ) : (
        <fieldset className="grid min-w-0 content-start gap-x-5 gap-y-4 sm:grid-cols-2">
          <legend className="sr-only">{title}</legend>
          {parts}
        </fieldset>
      )}
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
  const agentsHint = useId();
  const identifiersHint = useId();
  const agentsTitle = useLegend('vocab.field.agents', fieldState(template, 'agents') === 'required');
  const identifiersTitle = useLegend('vocab.field.identifiers', fieldState(template, 'identifiers') === 'required');
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
      <EditorSection title={t('catalog.records.section.title')}>
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
      </EditorSection>

      {shown('agents') && (
        <EditorSection list title={agentsTitle} intro={t('catalog.records.agents.hint')} introId={agentsHint}>
          <AgentPicker form={form} required={required('agents')} hintId={agentsHint} />
        </EditorSection>
      )}

      <EditorSection title={t('catalog.records.section.publication')}>
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
      </EditorSection>

      {shown('identifiers') && (
        <EditorSection list title={identifiersTitle} intro={t('catalog.records.identifiers.hint')} introId={identifiersHint}>
          <IdentifiersField form={form} array={identifiers} required={required('identifiers')} warnings={identifierWarnings} hintId={identifiersHint} />
        </EditorSection>
      )}

      <EditorSection title={t('catalog.records.section.subjects')}>
        {shown('subjects') && (
          <div className="sm:col-span-2">
            <SubjectPicker form={form} required={required('subjects')} />
          </div>
        )}
        {shown('classification') && <TextField form={form} name="classification" labelKey="vocab.field.classification" required={required('classification')} maxLength={64} />}
        {shown('call_number') && <TextField form={form} name="callNumber" labelKey="vocab.field.call_number" required={required('call_number')} maxLength={64} />}
      </EditorSection>

      <EditorSection title={t('catalog.records.section.content')}>
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
      </EditorSection>

      <EditorSection list title={t('catalog.records.section.relations')}>
        <RelationsField form={form} selfId={selfId} incoming={incoming} />
      </EditorSection>

      <CustomSection form={form} template={template} defs={masters.customFields} />

      <AccreditationSection form={form} />

      <EditorSection title={t('catalog.records.section.opac')}>
        <CheckField label={t('catalog.records.field.opac_visible')} {...register('opacVisible')} />
        <CheckField label={t('catalog.records.field.promoted')} {...register('promoted')} />
      </EditorSection>
    </>
  );
}

// ---- Komunitas K1 (catalogue accreditation fields) ----

/** The accreditation fields: the label of each and the vocabulary its values come from (Bibliografi's bulk change too). */
export const ACCRED_FIELDS = [
  { name: 'audience', labelKey: 'catalog.records.field.audience', list: 'audience', values: AUDIENCES },
  { name: 'localWork', labelKey: 'catalog.records.field.local_work', list: 'local_work', values: LOCAL_WORKS, hintKey: 'catalog.records.field.local_work_hint' },
  {
    name: 'localWorkKind',
    labelKey: 'catalog.records.field.local_work_kind',
    list: 'local_work_kind',
    values: LOCAL_WORK_KINDS,
    hintKey: 'catalog.records.field.local_work_kind_hint',
  },
  { name: 'referenceKind', labelKey: 'catalog.records.field.reference_kind', list: 'reference_kind', values: REFERENCE_KINDS },
] as const satisfies readonly {
  name: 'audience' | 'localWork' | 'localWorkKind' | 'referenceKind';
  labelKey: TKey;
  list: string;
  values: readonly string[];
  hintKey?: TKey;
}[];

/** The section of the accreditation fields: one select per field, `''` for none. */
function AccreditationSection({ form }: { form: UseFormReturn<RecordFormValues> }) {
  const t = useT();
  return (
    <EditorSection title={t('catalog.records.section.accreditation')} intro={t('catalog.records.section.accreditation_hint')}>
      {ACCRED_FIELDS.map((f) => (
        <Field key={f.name} label={t(f.labelKey)} error={errorAt(form.formState.errors, f.name)} {...('hintKey' in f ? { hint: t(f.hintKey) } : {})}>
          {(c) => (
            <select {...c} className={SELECT_CLASS} {...form.register(f.name)}>
              <option value="">{t('catalog.records.field.none')}</option>
              {f.values.map((value) => (
                <option key={value} value={value}>
                  {t(`vocab.${f.list}.${value}` as TKey)}
                </option>
              ))}
            </select>
          )}
        </Field>
      ))}
    </EditorSection>
  );
}

/** The custom fields, in a part of their own when the template shows any. */
function CustomSection({ form, template, defs }: { form: UseFormReturn<RecordFormValues>; template: MaterialTypeTemplate; defs: readonly CustomFieldView[] }) {
  const t = useT();
  if (shownCustomFields(template, defs).length === 0) return null;
  return (
    <EditorSection list title={t('catalog.records.section.custom')}>
      <CustomFieldsSection form={form} template={template} defs={defs} />
    </EditorSection>
  );
}
