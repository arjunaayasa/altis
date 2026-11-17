import { vocabKey } from '@altis/shared';
import {
  CollectionTypeBody,
  CollectionTypePatchBody,
  LanguageBody,
  LanguagePatchBody,
  SupplierBody,
  SupplierPatchBody,
  type CollectionTypeView,
  type CustomFieldView,
  type LanguageView,
  type MaterialTypeView,
  type SupplierView,
} from '@altis/shared/api/catalog/masters';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useForm } from 'react-hook-form';
import { Badge, CheckField, Field, ProblemAlert, RootError, TEXTAREA_CLASS } from '@/components/form-field';
import { Callout, PageHead } from '@/components/layout';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger, WRAPPING_TABS } from '@/components/ui/tabs';
import { useT, type Translate } from '@/i18n';
import { holds } from '@/lib/access';
import { useDirtyGuard } from '@/lib/dirty-forms';
import { useMe } from '@/lib/me';
import { CustomFieldForm } from './custom-field-form';
import {
  MASTER_SEGMENT,
  MasterFormButtons,
  MasterTab,
  changedFields,
  optionalText,
  orderValue,
  useCount,
  useMasterSave,
  type MasterColumn,
  type MasterFormProps,
  type MasterKind,
} from './master-table';

/**
 * Data Induk (Phase 2 spec §13, §2.2, §3.7, §3.8; plan Task 27; the API of Task 12): a tab per master (Jenis Bahan,
 * Bahasa, Tipe Koleksi, Pemasok, Ruas Tambahan), each a table with create, edit and archive (master-table.tsx). The
 * tab lives in the URL (`?tab=languages`; Jenis Bahan without one), so a link can open it. A material type is edited
 * on its own page with the template editor (material-type.tsx); the others in a panel above their table. Anyone who reads the catalogue
 * sees the lists; changing them needs `catalog.masters.manage`.
 */

const TABS: readonly MasterKind[] = ['material-types', 'languages', 'collection-types', 'suppliers', 'custom-fields'];

/** The tab of `?tab=`; Jenis Bahan for none or anything unknown. */
function tabOf(raw: unknown): MasterKind {
  return typeof raw === 'string' && (TABS as readonly string[]).includes(raw) ? (raw as MasterKind) : 'material-types';
}

/** The code, plus "Diarsipkan" for an archived row. */
function codeCell(t: Translate, row: { code: string; archived: boolean }) {
  return (
    <span className="flex flex-wrap items-center gap-2">
      <span className="font-semibold">{row.code}</span>
      {row.archived && <Badge>{t('catalog.masters.badge.archived')}</Badge>}
    </span>
  );
}

function useColumns() {
  const t = useT();
  const count = useCount();
  const code = { id: 'code', header: t('catalog.masters.col.code'), cell: (r: { code: string; archived: boolean }) => codeCell(t, r) };
  const nameId = { id: 'nameId', header: t('catalog.masters.col.name_id'), cell: (r: { nameId: string }) => r.nameId };
  const nameEn = { id: 'nameEn', header: t('catalog.masters.col.name_en'), cell: (r: { nameEn: string }) => r.nameEn };
  const usage = (header: string) => ({ id: 'usage', header, className: 'text-right', headClassName: 'text-right', cell: (r: { usage: number }) => <span>{count(r.usage)}</span> });

  const materialTypes: MasterColumn<MaterialTypeView>[] = [
    code,
    nameId,
    nameEn,
    { id: 'marc', header: t('catalog.masters.col.marc'), className: 'whitespace-nowrap', cell: (r) => <span>{`${r.marcType} / ${r.marcLevel}`}</span> },
    {
      id: 'rda',
      header: t('catalog.masters.col.rda'),
      className: 'whitespace-nowrap',
      cell: (r) => <span>{`${r.contentType} / ${r.mediaType} / ${r.carrierType}`}</span>,
    },
    usage(t('catalog.masters.col.records')),
  ];
  const languages: MasterColumn<LanguageView>[] = [code, nameId, nameEn, usage(t('catalog.masters.col.records'))];
  const collectionTypes: MasterColumn<CollectionTypeView>[] = [
    code,
    nameId,
    nameEn,
    {
      id: 'lending',
      header: t('catalog.masters.col.lending'),
      cell: (r) => (
        <span className="flex flex-wrap gap-1">
          {r.loanable ? <Badge>{t('catalog.masters.badge.loanable')}</Badge> : <Badge tone="warning">{t('catalog.masters.badge.not_loanable')}</Badge>}
          {r.loanable && r.selfService && <Badge>{t('catalog.masters.badge.self_service')}</Badge>}
        </span>
      ),
    },
    usage(t('catalog.masters.col.items')),
  ];
  const suppliers: MasterColumn<SupplierView>[] = [
    code,
    { id: 'name', header: t('catalog.masters.col.name'), cell: (r) => r.name },
    {
      id: 'contact',
      header: t('catalog.masters.col.contact'),
      cell: (r) => (
        <span className="flex flex-col text-muted-foreground">
          {[r.contactName, r.phone, r.email].filter((v): v is string => v !== null).map((v) => (
            <span key={v}>{v}</span>
          ))}
        </span>
      ),
    },
    usage(t('catalog.masters.col.items')),
  ];
  const customFields: MasterColumn<CustomFieldView>[] = [
    code,
    {
      id: 'label',
      header: t('catalog.masters.col.label'),
      cell: (r) => (
        <span className="flex flex-col">
          <span>{r.labelId}</span>
          {r.labelEn !== null && <span className="text-muted-foreground">{r.labelEn}</span>}
        </span>
      ),
    },
    { id: 'entity', header: t('catalog.masters.col.entity'), cell: (r) => t(vocabKey('custom_field_entity', r.entity)) },
    { id: 'type', header: t('catalog.masters.col.type'), cell: (r) => t(vocabKey('custom_field_type', r.type)) },
    {
      id: 'flags',
      header: t('catalog.masters.col.flags'),
      cell: (r) => (
        <span className="flex flex-wrap gap-1">
          {r.required && <Badge>{t('catalog.masters.badge.required')}</Badge>}
          {r.isPublic && <Badge>{t('catalog.masters.badge.public')}</Badge>}
          {r.isSearchable && <Badge>{t('catalog.masters.badge.searchable')}</Badge>}
        </span>
      ),
    },
    usage(t('catalog.masters.col.values')),
  ];
  return { materialTypes, languages, collectionTypes, suppliers, customFields };
}

/** `/admin/catalog/masters` (`?tab=`). */
export function MastersScreen() {
  const t = useT();
  const me = useMe();
  const navigate = useNavigate();
  const tab = tabOf((useSearch({ strict: false }) as Record<string, unknown>)['tab']);
  const canManage = holds(me, 'catalog.masters.manage');
  const columns = useColumns();

  return (
    <div className="grid gap-6">
      <PageHead title={t('nav.catalog.masters')} />
      {!canManage && <Callout title={t('catalog.masters.read_only')} />}
      <Tabs
        value={tab}
        onValueChange={(value) => void navigate({ to: '/admin/catalog/masters', search: tabOf(value) === 'material-types' ? {} : { tab: tabOf(value) } })}>
        <TabsList aria-label={t('catalog.masters.tabs_label')} className={WRAPPING_TABS.list}>
          {TABS.map((kind) => (
            <TabsTrigger key={kind} value={kind} className={WRAPPING_TABS.trigger}>
              {t(`catalog.masters.tab.${MASTER_SEGMENT[kind]}`)}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="material-types">
          <MasterTab kind="material-types" canManage={canManage} columns={columns.materialTypes} />
        </TabsContent>
        <TabsContent value="languages">
          <MasterTab kind="languages" canManage={canManage} columns={columns.languages} form={LanguageForm} />
        </TabsContent>
        <TabsContent value="collection-types">
          <MasterTab kind="collection-types" canManage={canManage} columns={columns.collectionTypes} form={CollectionTypeForm} />
        </TabsContent>
        <TabsContent value="suppliers">
          <MasterTab kind="suppliers" canManage={canManage} columns={columns.suppliers} form={SupplierForm} />
        </TabsContent>
        <TabsContent value="custom-fields">
          <MasterTab kind="custom-fields" canManage={canManage} columns={columns.customFields} form={CustomFieldForm} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ---- the panel forms -----------------------------------------------------------------------------------------------

/** The classes of a panel form, and of its rows of fields. */
const FORM = 'grid max-w-3xl gap-4';
const FIELDS = 'grid gap-x-5 gap-y-4 sm:grid-cols-2';

interface LanguageValues {
  code: string;
  nameId: string;
  nameEn: string;
}

const languageBody = (v: LanguageValues) => ({ code: v.code.trim(), nameId: v.nameId.trim(), nameEn: v.nameEn.trim() });

function LanguageForm({ row, canManage, onSaved, onCancel }: MasterFormProps<LanguageView>) {
  const t = useT();
  const base: LanguageValues = row === null ? { code: '', nameId: '', nameEn: '' } : { code: row.code, nameId: row.nameId, nameEn: row.nameEn };
  const form = useForm<LanguageValues>({ defaultValues: base });
  const { errors, isDirty, isSubmitting } = form.formState;
  useDirtyGuard(isDirty);
  const { submit, problem } = useMasterSave({
    kind: 'languages',
    form,
    row,
    schema: { create: LanguageBody, patch: LanguagePatchBody },
    body: (v) => (row === null ? languageBody(v) : changedFields(languageBody(v), languageBody(base))),
    onSaved,
    onUnchanged: onCancel,
  });
  const disabled = !canManage;
  return (
    <form noValidate className={FORM} onSubmit={(e) => void submit(e)}>
      <ProblemAlert error={problem} />
      <RootError message={errors.root?.['server']?.message} />
      <Field label={t('catalog.masters.field.code')} hint={t('catalog.masters.field.language_code_hint')} error={errors.code}>
        {(c) => <Input {...c} autoComplete="off" spellCheck={false} maxLength={32} disabled={disabled} {...form.register('code')} />}
      </Field>
      <div className={FIELDS}>
        <Field label={t('catalog.masters.field.name_id')} error={errors.nameId}>
          {(c) => <Input {...c} autoComplete="off" maxLength={191} disabled={disabled} {...form.register('nameId')} />}
        </Field>
        <Field label={t('catalog.masters.field.name_en')} error={errors.nameEn}>
          {(c) => <Input {...c} autoComplete="off" maxLength={191} disabled={disabled} {...form.register('nameEn')} />}
        </Field>
      </div>
      <MasterFormButtons canManage={canManage} busy={isSubmitting} onCancel={onCancel} />
    </form>
  );
}

interface CollectionTypeValues {
  code: string;
  nameId: string;
  nameEn: string;
  loanable: boolean;
  selfService: boolean;
  sortOrder: string;
}

const collectionTypeBody = (v: CollectionTypeValues) => ({
  code: v.code.trim(),
  nameId: v.nameId.trim(),
  nameEn: v.nameEn.trim(),
  loanable: v.loanable,
  selfService: v.selfService,
  sortOrder: orderValue(v.sortOrder),
});

function CollectionTypeForm({ row, canManage, onSaved, onCancel }: MasterFormProps<CollectionTypeView>) {
  const t = useT();
  const base: CollectionTypeValues =
    row === null
      ? { code: '', nameId: '', nameEn: '', loanable: true, selfService: true, sortOrder: '0' }
      : { code: row.code, nameId: row.nameId, nameEn: row.nameEn, loanable: row.loanable, selfService: row.selfService, sortOrder: String(row.sortOrder) };
  const form = useForm<CollectionTypeValues>({ defaultValues: base });
  const { errors, isDirty, isSubmitting } = form.formState;
  useDirtyGuard(isDirty);
  const { submit, problem } = useMasterSave({
    kind: 'collection-types',
    form,
    row,
    schema: { create: CollectionTypeBody, patch: CollectionTypePatchBody },
    body: (v) => (row === null ? collectionTypeBody(v) : changedFields(collectionTypeBody(v), collectionTypeBody(base))),
    onSaved,
    onUnchanged: onCancel,
  });
  const disabled = !canManage;
  return (
    <form noValidate className={FORM} onSubmit={(e) => void submit(e)}>
      <ProblemAlert error={problem} />
      <RootError message={errors.root?.['server']?.message} />
      <Field label={t('catalog.masters.field.code')} hint={t('catalog.masters.field.code_hint')} error={errors.code}>
        {(c) => <Input {...c} autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={32} disabled={disabled} {...form.register('code')} />}
      </Field>
      <div className={FIELDS}>
        <Field label={t('catalog.masters.field.name_id')} error={errors.nameId}>
          {(c) => <Input {...c} autoComplete="off" maxLength={191} disabled={disabled} {...form.register('nameId')} />}
        </Field>
        <Field label={t('catalog.masters.field.name_en')} error={errors.nameEn}>
          {(c) => <Input {...c} autoComplete="off" maxLength={191} disabled={disabled} {...form.register('nameEn')} />}
        </Field>
      </div>
      <div className="grid gap-3">
        <CheckField label={t('catalog.masters.field.loanable')} disabled={disabled} {...form.register('loanable')} />
        <CheckField label={t('catalog.masters.field.self_service')} hint={t('catalog.masters.field.self_service_hint')} disabled={disabled} {...form.register('selfService')} />
      </div>
      <Field label={t('catalog.masters.field.sort_order')} hint={t('catalog.masters.field.sort_order_hint')} error={errors.sortOrder} className="max-w-40">
        {(c) => <Input {...c} type="number" inputMode="numeric" min={0} step={1} disabled={disabled} {...form.register('sortOrder')} />}
      </Field>
      <MasterFormButtons canManage={canManage} busy={isSubmitting} onCancel={onCancel} />
    </form>
  );
}

interface SupplierValues {
  code: string;
  name: string;
  contactName: string;
  phone: string;
  email: string;
  address: string;
  note: string;
}

const supplierBody = (v: SupplierValues) => ({
  code: v.code.trim(),
  name: v.name.trim(),
  contactName: optionalText(v.contactName),
  phone: optionalText(v.phone),
  email: optionalText(v.email),
  address: optionalText(v.address),
  note: optionalText(v.note),
});

function SupplierForm({ row, canManage, onSaved, onCancel }: MasterFormProps<SupplierView>) {
  const t = useT();
  const base: SupplierValues =
    row === null
      ? { code: '', name: '', contactName: '', phone: '', email: '', address: '', note: '' }
      : {
          code: row.code,
          name: row.name,
          contactName: row.contactName ?? '',
          phone: row.phone ?? '',
          email: row.email ?? '',
          address: row.address ?? '',
          note: row.note ?? '',
        };
  const form = useForm<SupplierValues>({ defaultValues: base });
  const { errors, isDirty, isSubmitting } = form.formState;
  useDirtyGuard(isDirty);
  const { submit, problem } = useMasterSave({
    kind: 'suppliers',
    form,
    row,
    schema: { create: SupplierBody, patch: SupplierPatchBody },
    body: (v) => (row === null ? supplierBody(v) : changedFields(supplierBody(v), supplierBody(base))),
    onSaved,
    onUnchanged: onCancel,
  });
  const disabled = !canManage;
  return (
    <form noValidate className={FORM} onSubmit={(e) => void submit(e)}>
      <ProblemAlert error={problem} />
      <RootError message={errors.root?.['server']?.message} />
      <div className={FIELDS}>
        <Field label={t('catalog.masters.field.code')} hint={t('catalog.masters.field.code_hint')} error={errors.code}>
          {(c) => <Input {...c} autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={32} disabled={disabled} {...form.register('code')} />}
        </Field>
        <Field label={t('catalog.masters.field.name')} error={errors.name}>
          {(c) => <Input {...c} autoComplete="off" maxLength={191} disabled={disabled} {...form.register('name')} />}
        </Field>
      </div>
      <p className="text-xs text-muted-foreground">{t('catalog.masters.field.contact_hint')}</p>
      <div className={FIELDS}>
        <Field label={t('catalog.masters.field.contact_name')} error={errors.contactName}>
          {(c) => <Input {...c} autoComplete="off" maxLength={191} disabled={disabled} {...form.register('contactName')} />}
        </Field>
        <Field label={t('catalog.masters.field.phone')} error={errors.phone}>
          {(c) => <Input {...c} type="tel" autoComplete="off" maxLength={64} disabled={disabled} {...form.register('phone')} />}
        </Field>
        <Field label={t('catalog.masters.field.email')} error={errors.email} className="sm:col-span-2">
          {(c) => <Input {...c} type="email" autoComplete="off" maxLength={191} disabled={disabled} {...form.register('email')} />}
        </Field>
        <Field label={t('catalog.masters.field.address')} error={errors.address} className="sm:col-span-2">
          {(c) => <textarea {...c} className={TEXTAREA_CLASS} disabled={disabled} {...form.register('address')} />}
        </Field>
        <Field label={t('catalog.masters.field.note')} error={errors.note} className="sm:col-span-2">
          {(c) => <textarea {...c} className={TEXTAREA_CLASS} disabled={disabled} {...form.register('note')} />}
        </Field>
      </div>
      <MasterFormButtons canManage={canManage} busy={isSubmitting} onCancel={onCancel} />
    </form>
  );
}
