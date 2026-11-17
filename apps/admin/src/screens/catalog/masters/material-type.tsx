import { RDA_CARRIER_TYPES, RDA_CONTENT_TYPES, RDA_MEDIA_TYPES, isUlid } from '@altis/shared';
import type { StoreResponse } from '@altis/shared/api/catalog/common';
import {
  EMPTY_TEMPLATE,
  MaterialTypeBody,
  MaterialTypePatchBody,
  type CollectionTypeView,
  type CustomFieldView,
  type LanguageView,
  type MasterListResponse,
  type MaterialTypeView,
} from '@altis/shared/api/catalog/masters';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useRouterState } from '@tanstack/react-router';
import { useState, type BaseSyntheticEvent } from 'react';
import { useForm, useWatch, type UseFormReturn } from 'react-hook-form';
import { Field, Notice, ProblemAlert, RootError, SELECT_CLASS } from '@/components/form-field';
import { BackLink, Callout, FORM_FULL, FormBar, FormSection, LoadingState, PageError, PageHead } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useLocale, useT } from '@/i18n';
import { holds } from '@/lib/access';
import { ApiError, api } from '@/lib/api';
import { useDirtyGuard } from '@/lib/dirty-forms';
import { FORM_PARSE } from '@/lib/form-errors';
import { useApiQuery, useMe } from '@/lib/me';
import { changedFields, isFieldProblem, orderValue, putFieldErrors, serverIssues, useCount, zodIssues, type ErrorMessage } from './master-table';
import { TemplateEditor, templateBody, templateValues, type MaterialTypeValues } from './template-editor';

/**
 * A material type (Phase 2 spec §13, §2.2, §3.8; plan Task 27): `/admin/catalog/masters/material-types/new` adds one
 * (`POST catalog/material-types`), `/admin/catalog/masters/material-types/$id` edits it (`PATCH …/:id` with its
 * version and only what changed; the template is sent whole). There is no `GET …/:id`: the page finds the row in the
 * list (archived ones included).
 *
 * The form: code and names, the MARC leader type (06) and level (07), the default RDA content, media and carrier
 * types (selects from the official lists, shown as they are), the schema.org and DCMI types (the JSON-LD and OAI
 * types), the order, and the template (template-editor.tsx). A value outside the offered lists (a migrated type) is
 * kept and shown as "(nilai lain)". Without `catalog.masters.manage` the page is read only.
 */

/** MARC 21 leader/06, type of record: the code and its MARC name (shown as it is, D2-06). */
const MARC_TYPES: readonly (readonly [string, string])[] = [
  ['a', 'Language material'],
  ['c', 'Notated music'],
  ['d', 'Manuscript notated music'],
  ['e', 'Cartographic material'],
  ['f', 'Manuscript cartographic material'],
  ['g', 'Projected medium'],
  ['i', 'Nonmusical sound recording'],
  ['j', 'Musical sound recording'],
  ['k', 'Two-dimensional nonprojectable graphic'],
  ['m', 'Computer file'],
  ['o', 'Kit'],
  ['p', 'Mixed materials'],
  ['r', 'Three-dimensional artifact or naturally occurring object'],
  ['t', 'Manuscript language material'],
];

/** MARC 21 leader/07, bibliographic level. */
const MARC_LEVELS: readonly (readonly [string, string])[] = [
  ['a', 'Monographic component part'],
  ['b', 'Serial component part'],
  ['c', 'Collection'],
  ['d', 'Subunit'],
  ['i', 'Integrating resource'],
  ['m', 'Monograph/Item'],
  ['s', 'Serial'],
];

/** The schema.org types the OPAC's JSON-LD uses (§9.4). */
const SCHEMA_TYPES: readonly (readonly [string, string])[] = ['Book', 'Thesis', 'Periodical', 'Map', 'AudioObject', 'VideoObject', 'CreativeWork'].map(
  (s) => [s, s] as const,
);

/** The DCMI Type Vocabulary (OAI-PMH `dc:type`). */
const DCMI_TYPES: readonly (readonly [string, string])[] = [
  'Collection',
  'Dataset',
  'Event',
  'Image',
  'InteractiveResource',
  'MovingImage',
  'PhysicalObject',
  'Service',
  'Software',
  'Sound',
  'StillImage',
  'Text',
].map((s) => [s, s] as const);

/** The RDA lists as `[code, official term]`. */
const RDA_OPTIONS = {
  contentType: RDA_CONTENT_TYPES.map((e) => [e.code, e.term] as const),
  mediaType: RDA_MEDIA_TYPES.map((e) => [e.code, e.term] as const),
  carrierType: RDA_CARRIER_TYPES.map((e) => [e.code, e.term] as const),
} as const;

/** A new material type: a printed book's defaults (the seed's `BUKU`). */
const NEW_VALUES: MaterialTypeValues = {
  code: '',
  nameId: '',
  nameEn: '',
  marcType: 'a',
  marcLevel: 'm',
  contentType: 'txt',
  mediaType: 'n',
  carrierType: 'nc',
  schemaType: 'Book',
  dcmiType: 'Text',
  sortOrder: '0',
  template: templateValues(EMPTY_TEMPLATE),
};

function valuesOf(row: MaterialTypeView): MaterialTypeValues {
  return {
    code: row.code,
    nameId: row.nameId,
    nameEn: row.nameEn,
    marcType: row.marcType,
    marcLevel: row.marcLevel,
    contentType: row.contentType,
    mediaType: row.mediaType,
    carrierType: row.carrierType,
    schemaType: row.schemaType,
    dcmiType: row.dcmiType,
    sortOrder: String(row.sortOrder),
    template: templateValues(row.template),
  };
}

/** The body of `values` (a create body; a patch takes its changed fields). */
function bodyOf(v: MaterialTypeValues): Record<string, unknown> {
  return {
    code: v.code.trim(),
    nameId: v.nameId.trim(),
    nameEn: v.nameEn.trim(),
    marcType: v.marcType,
    marcLevel: v.marcLevel,
    contentType: v.contentType,
    mediaType: v.mediaType,
    carrierType: v.carrierType,
    schemaType: v.schemaType,
    dcmiType: v.dcmiType,
    template: templateBody(v.template),
    sortOrder: orderValue(v.sortOrder),
  };
}

/** The messages of the template checks without a `form.error.*` text. */
const message: ErrorMessage = (path, code) => (path.startsWith('template.customFields') && code === 'duplicate' ? 'catalog.masters.error.duplicate_code' : undefined);

/** The lists the form offers (archived rows included: a stored value may name one). */
interface Lists {
  languages: readonly LanguageView[];
  collectionTypes: readonly CollectionTypeView[];
  customFields: readonly CustomFieldView[];
}

/** The fields chosen from a fixed list of codes. */
type CodeName = 'marcType' | 'marcLevel' | 'contentType' | 'mediaType' | 'carrierType' | 'schemaType' | 'dcmiType';

/**
 * A select of fixed codes, with the stored value kept when it is not among them. It watches its own value, so a change
 * elsewhere in the form does not render it again.
 */
function CodeSelect({
  form,
  name,
  label,
  hint,
  options,
  disabled,
}: {
  form: UseFormReturn<MaterialTypeValues>;
  name: CodeName;
  label: string;
  hint?: string;
  options: readonly (readonly [string, string])[];
  disabled: boolean;
}) {
  const t = useT();
  const value = useWatch({ control: form.control, name });
  const error = form.formState.errors[name];
  const known = options.some(([code]) => code === value);
  return (
    <Field label={label} hint={hint} error={error}>
      {(c) => (
        <select {...c} className={SELECT_CLASS} disabled={disabled} {...form.register(name)}>
          {!known && value !== '' && <option value={value}>{t('catalog.masters.mt.other_value', { value })}</option>}
          {options.map(([code, term]) => (
            <option key={code} value={code}>
              {term === code ? code : `${code} — ${term}`}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

function MaterialTypeForm({
  row,
  canManage,
  lists,
  onSaved,
  onStale,
}: {
  row: MaterialTypeView | null;
  canManage: boolean;
  lists: Lists;
  onSaved(code: string): void;
  /** Reads the row again and starts the form over (after CONFLICT_STALE). */
  onStale(): Promise<void>;
}) {
  const t = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [base, setBase] = useState<MaterialTypeValues>(() => (row === null ? NEW_VALUES : valuesOf(row)));
  const [version, setVersion] = useState(row?.version ?? 0);
  const [problem, setProblem] = useState<unknown>(null);
  const form = useForm<MaterialTypeValues>({ defaultValues: base });
  const { errors, isDirty, isSubmitting } = form.formState;
  useDirtyGuard(isDirty);
  const disabled = !canManage;

  const save = form.handleSubmit(async (values) => {
    setProblem(null);
    const body = bodyOf(values);
    const fields = row === null ? body : changedFields(body, bodyOf(base));
    if (row !== null && Object.keys(fields).length === 0) return;
    const parsed = row === null ? MaterialTypeBody.safeParse(fields, FORM_PARSE) : MaterialTypePatchBody.safeParse({ version, ...fields }, FORM_PARSE);
    if (!parsed.success) {
      putFieldErrors(form, zodIssues(parsed.error.issues, message));
      return;
    }
    const code = typeof body['code'] === 'string' ? body['code'] : '';
    try {
      if (row === null) {
        const created = await api<StoreResponse>('POST', 'catalog/material-types', parsed.data);
        await queryClient.invalidateQueries({ queryKey: ['catalog', 'material-types'] });
        form.reset(values);
        await navigate({ href: `/admin/catalog/masters/material-types/${encodeURIComponent(created.id)}`, state: { created: true } });
        return;
      }
      const saved = await api<StoreResponse>('PATCH', `catalog/material-types/${encodeURIComponent(row.id)}`, parsed.data);
      setVersion(saved.version);
      setBase(values);
      form.reset(values);
      await queryClient.invalidateQueries({ queryKey: ['catalog', 'material-types'] });
      onSaved(code);
    } catch (e) {
      if (isFieldProblem(e)) putFieldErrors(form, serverIssues(e, message));
      else setProblem(e);
    }
  });
  // An error on a path no input registers (a template code) would hold the form invalid for good: start clean.
  const submit = (e?: BaseSyntheticEvent): Promise<void> => {
    form.clearErrors();
    return save(e);
  };

  const register = form.register;
  return (
    <form noValidate className="grid gap-3" onSubmit={(e) => void submit(e)}>
      {problem !== null && (
        <ProblemAlert error={problem}>
          {problem instanceof ApiError && problem.code === 'CONFLICT_STALE' && (
            <Button type="button" variant="outline" size="sm" className="mt-1" onClick={() => void onStale()}>
              {t('form.reload_data')}
            </Button>
          )}
        </ProblemAlert>
      )}
      <RootError message={errors.root?.['server']?.message} />

      <div>
        <FormSection title={t('catalog.masters.mt.section.identity')} disabled={disabled}>
          <Field label={t('catalog.masters.field.code')} hint={t('catalog.masters.field.code_hint')} error={errors.code}>
            {(c) => <Input {...c} autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={32} disabled={disabled} {...register('code')} />}
          </Field>
          <Field label={t('catalog.masters.field.sort_order')} hint={t('catalog.masters.field.sort_order_hint')} error={errors.sortOrder}>
            {(c) => <Input {...c} type="number" inputMode="numeric" min={0} step={1} disabled={disabled} {...register('sortOrder')} />}
          </Field>
          <Field label={t('catalog.masters.field.name_id')} error={errors.nameId}>
            {(c) => <Input {...c} autoComplete="off" maxLength={191} disabled={disabled} {...register('nameId')} />}
          </Field>
          <Field label={t('catalog.masters.field.name_en')} error={errors.nameEn}>
            {(c) => <Input {...c} autoComplete="off" maxLength={191} disabled={disabled} {...register('nameEn')} />}
          </Field>
        </FormSection>

        <FormSection title={t('catalog.masters.mt.section.description')} disabled={disabled}>
          <CodeSelect form={form} name="marcType" label={t('catalog.masters.mt.marc_type')} options={MARC_TYPES} disabled={disabled} />
          <CodeSelect form={form} name="marcLevel" label={t('catalog.masters.mt.marc_level')} options={MARC_LEVELS} disabled={disabled} />
          {(['contentType', 'mediaType', 'carrierType'] as const).map((name) => (
            <CodeSelect
              key={name}
              form={form}
              name={name}
              label={t(name === 'contentType' ? 'catalog.masters.mt.content_type' : name === 'mediaType' ? 'catalog.masters.mt.media_type' : 'catalog.masters.mt.carrier_type')}
              hint={name === 'contentType' ? t('catalog.masters.mt.rda_hint') : undefined}
              options={RDA_OPTIONS[name]}
              disabled={disabled}
            />
          ))}
          <CodeSelect form={form} name="schemaType" label={t('catalog.masters.mt.schema_type')} hint={t('catalog.masters.mt.types_hint')} options={SCHEMA_TYPES} disabled={disabled} />
          <CodeSelect form={form} name="dcmiType" label={t('catalog.masters.mt.dcmi_type')} options={DCMI_TYPES} disabled={disabled} />
        </FormSection>

        <FormSection title={t('catalog.masters.mt.section.template')} intro={t('catalog.masters.mt.template_hint')} className="md:grid-cols-1 lg:grid-cols-1">
          <div className={FORM_FULL}>
            <TemplateEditor form={form} disabled={disabled} languages={lists.languages} collectionTypes={lists.collectionTypes} customFields={lists.customFields} />
          </div>
        </FormSection>

        {canManage && (
          <FormBar>
            <Button type="submit" disabled={isSubmitting}>
              {t(isSubmitting ? 'form.saving' : 'form.save')}
            </Button>
            <Button asChild variant="outline">
              <Link to="/admin/catalog/masters">{t('form.cancel')}</Link>
            </Button>
          </FormBar>
        )}
      </div>
    </form>
  );
}

/** The lists the form needs, archived rows included; null until all came. */
function useLists(): { lists: Lists | null; error: unknown } {
  const languages = useApiQuery<MasterListResponse<LanguageView>>({
    queryKey: ['catalog', 'languages', { includeArchived: true }],
    path: 'catalog/languages?includeArchived=true',
  });
  const collectionTypes = useApiQuery<MasterListResponse<CollectionTypeView>>({
    queryKey: ['catalog', 'collection-types', { includeArchived: true }],
    path: 'catalog/collection-types?includeArchived=true',
  });
  const customFields = useApiQuery<MasterListResponse<CustomFieldView>>({
    queryKey: ['catalog', 'custom-fields', { entity: 'records', includeArchived: true }],
    path: 'catalog/custom-fields?entity=records&includeArchived=true',
  });
  const all = [languages, collectionTypes, customFields];
  const failed = all.find((q) => q.data === undefined && q.isError);
  if (languages.data === undefined || collectionTypes.data === undefined || customFields.data === undefined) return { lists: null, error: failed?.error ?? null };
  return {
    lists: { languages: languages.data.items, collectionTypes: collectionTypes.data.items, customFields: customFields.data.items.filter((f) => f.entity === 'records') },
    error: null,
  };
}

function Loading({ error }: { error: unknown }) {
  if (error !== null && error !== undefined) return <ProblemAlert error={error} />;
  return <LoadingState />;
}

/** `/admin/catalog/masters/material-types/new`. */
export function MaterialTypeCreateScreen() {
  const t = useT();
  const me = useMe();
  const canManage = holds(me, 'catalog.masters.manage');
  const { lists, error } = useLists();
  return (
    <div className="grid max-w-5xl gap-6">
      <BackLink to="/admin/catalog/masters">{t('catalog.masters.mt.back')}</BackLink>
      {/* The page shows once its lists came: the heading and the form together. */}
      {lists === null ? (
        <Loading error={error} />
      ) : (
        <>
          <PageHead title={t('catalog.masters.mt.new_title')} />
          {/* The server would refuse (and record the refusal): say so before anything is typed. */}
          {!canManage && <ProblemAlert error={new ApiError(403, 'AUTHZ_DENIED')} />}
          <MaterialTypeForm row={null} canManage={canManage} lists={lists} onSaved={() => undefined} onStale={async () => undefined} />
        </>
      )}
    </div>
  );
}

/** `/admin/catalog/masters/material-types/$id`. */
export function MaterialTypeEditScreen() {
  const t = useT();
  const me = useMe();
  const locale = useLocale();
  const count = useCount();
  const canManage = holds(me, 'catalog.masters.manage');
  const { id = '' } = useParams({ strict: false }) as { id?: string };
  const created = useRouterState({ select: (s) => s.location.state.created === true });
  const [saved, setSaved] = useState<string | null>(null);
  const [formKey, setFormKey] = useState(0);
  const types = useApiQuery<MasterListResponse<MaterialTypeView>>({
    queryKey: ['catalog', 'material-types', { includeArchived: true }],
    path: 'catalog/material-types?includeArchived=true',
  });
  const { lists, error } = useLists();
  const row = isUlid(id) ? types.data?.items.find((m) => m.id === id) : undefined;

  const reload = async (): Promise<void> => {
    await types.refetch();
    setSaved(null);
    setFormKey((k) => k + 1);
  };

  return (
    <div className="grid max-w-5xl gap-6">
      <BackLink to="/admin/catalog/masters">{t('catalog.masters.mt.back')}</BackLink>
      {types.data === undefined || (row !== undefined && lists === null) ? (
        <Loading error={types.data === undefined ? (types.isError ? types.error : null) : error} />
      ) : row === undefined || lists === null ? (
        <PageError title={t('catalog.masters.mt.not_found')} />
      ) : (
        <>
          <PageHead title={locale === 'en' ? row.nameEn : row.nameId} intro={t('catalog.masters.mt.usage', { count: count(row.usage) })} />
          {(saved !== null || created) && <Notice kind="success">{t('catalog.masters.done.saved.material_types', { code: saved ?? row.code })}</Notice>}
          {types.isRefetchError && <ProblemAlert error={types.error} />}
          {row.archived && <Callout title={t('catalog.masters.mt.archived_notice')} />}
          {!canManage && <Callout title={t('catalog.masters.mt.read_only')} />}
          <MaterialTypeForm key={`${row.id}:${formKey}`} row={row} canManage={canManage} lists={lists} onSaved={setSaved} onStale={reload} />
        </>
      )}
    </div>
  );
}
