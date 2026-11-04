import { isHttpUrl, type StoreResponse } from '@altis/shared/api/catalog/common';
import { issueCode } from '@altis/shared/api/common';
import { EMPTY_TEMPLATE, type CustomFieldView, type LanguageView, type MasterListResponse, type MaterialTypeView } from '@altis/shared/api/catalog/masters';
import { RecordCreateBody, RecordPatchBody, type RecordDetail } from '@altis/shared/api/catalog/records';
import type { CatalogConfigView } from '@altis/shared/api/settings';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useRouterState, useSearch } from '@tanstack/react-router';
import { ArchiveIcon, ArchiveRestoreIcon, ArrowLeftIcon, XIcon } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { useFieldArray, useForm, useWatch, type UseFormReturn } from 'react-hook-form';
import { AttachmentsPanel } from '@/components/catalog/attachments-panel';
import { RecordItemsTab } from '@/components/catalog/record-items-tab';
import { IsbnLookupButton, SruCopyDialog, type CopyPick } from '@/components/catalog/sru-dialog';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Badge, Notice, NoticeAlert, ProblemAlert, RefetchProblem, RootError } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useT, type TKey } from '@/i18n';
import { holds } from '@/lib/access';
import { ApiError, api } from '@/lib/api';
import { useDirtyGuard } from '@/lib/dirty-forms';
import { applyServerErrors, problemText } from '@/lib/form-errors';
import { useApiQuery, useMe } from '@/lib/me';
import { useScannerInput } from '@/lib/scanner';
import { CoverField } from './cover-field';
import {
  TEMPLATE_FIELD_KEYS,
  bodyPathToFormPath,
  detailToFormValues,
  draftToFormValues,
  emptyFormValues,
  fieldState,
  formToCreateBody,
  formToPatchBody,
  templateRequiredErrors,
  withCustomRows,
  type BodyContext,
  type FormFieldError,
  type RecordFormValues,
} from './draft-to-form';
import { DuplicatesPanel } from './duplicates-panel';
import { RecordFormSections, type EditorMasters } from './editor-sections';
import { MarcTab } from './marc-tab';

/**
 * The record editor (Phase 2 spec §3.1, §3.3, §3.8, §6.2, §6.3, §13; plan Task 24): `/admin/catalog/records/new`
 * (`POST catalog/records`) and `/admin/catalog/records/:id` (`PATCH catalog/records/:id`, with the record's `version`
 * and only what changed).
 *
 * - The sections follow the material type's template (editor-sections.tsx): a hidden field is neither shown nor sent,
 *   a required one is marked and checked here before anything is sent, as the server checks it again. The form checks
 *   the body with the contract's own schema too; the server's field errors land on their fields
 *   (`applyServerErrors`; draft-to-form.tsx maps identifier and custom paths).
 * - Every write answers `StoreResponse` only (S15): after a save the screen reads the record again with GET. A create
 *   opens the new record's page ("Cantuman disimpan."). CONFLICT_STALE (someone saved in between) shows a notice whose
 *   "Muat ulang cantuman" reads the record again and drops the unsaved change.
 * - Copy cataloguing (a new record): the ISBN field takes a scanner burst (`useScannerInput`: it lands in the first
 *   empty ISBN row, wherever the focus was), `IsbnLookupButton` looks the first ISBN up ("Sudah ada di katalog" →
 *   a link and "Tambah eksemplar"; or candidates), "Salin dari SRU" opens `SruCopyDialog`. A picked draft fills the
 *   form through `draftToFormValues` (new authorities as references, `marcExtra`, the links, `source`); with "tambah
 *   eksemplar sekarang" the saved record opens on its items tab.
 * - The live duplicate check (duplicates-panel.tsx), the cover (cover-field.tsx), the attachments (`AttachmentsPanel`),
 *   the items (`RecordItemsTab`) and the MARC tab (marc-tab.tsx). The other tabs hold no part of the form: the form
 *   stays mounted (hidden) while another tab is open, so nothing typed is lost.
 * - `useDirtyGuard` while the form holds unsaved changes. Archive and restore send `{version}` too.
 * - Without `catalog.records.manage`, or for a merged record, everything is read only.
 */

/** The tabs of a stored record; `?tab=` opens one. */
const TABS = ['data', 'items', 'attachments', 'marc'] as const;

type Tab = (typeof TABS)[number];

const parseTab = (v: unknown): Tab => ((TABS as readonly unknown[]).includes(v) ? (v as Tab) : 'data');

/** The query key of a record's detail. */
const detailKey = (id: string) => ['catalog', 'records', 'detail', id] as const;

/** What the editor needs of the masters and the settings. */
interface LoadedMasters extends EditorMasters {
  config: CatalogConfigView;
}

/** The masters, the custom fields and the catalogue settings, once all four have come. */
function useEditorMasters(): { data: LoadedMasters | undefined; error: unknown } {
  const types = useApiQuery<MasterListResponse<MaterialTypeView>>({
    queryKey: ['catalog', 'material-types', { includeArchived: true }],
    path: 'catalog/material-types?includeArchived=true',
    staleTime: 60_000,
  });
  const languages = useApiQuery<MasterListResponse<LanguageView>>({
    queryKey: ['catalog', 'languages', { includeArchived: true }],
    path: 'catalog/languages?includeArchived=true',
    staleTime: 60_000,
  });
  const custom = useApiQuery<MasterListResponse<CustomFieldView>>({
    queryKey: ['catalog', 'custom-fields', { entity: 'records' }],
    path: 'catalog/custom-fields?entity=records',
    staleTime: 60_000,
  });
  const config = useApiQuery<CatalogConfigView>({ queryKey: ['catalog', 'config'], path: 'catalog/config', staleTime: 60_000 });
  const error = [types, languages, custom, config].find((q) => q.isError && q.data === undefined)?.error ?? null;
  if (types.data === undefined || languages.data === undefined || custom.data === undefined || config.data === undefined) return { data: undefined, error };
  return {
    data: { materialTypes: types.data.items, languages: languages.data.items, customFields: custom.data.items, config: config.data },
    error: null,
  };
}

/** The issue code a field shows: `required` for an empty required text, else the check's own. */
function formIssueCode(issue: { code: string; params?: Record<string, unknown> | undefined; origin?: unknown; minimum?: unknown }): string {
  if (issue.code === 'too_small' && issue.origin === 'string' && Number(issue.minimum) <= 1) return 'required';
  return issueCode(issue);
}

/** The contract's own field errors of `body` (D35: the form checks with the server's schema). */
function contractErrors(result: { success: true } | { success: false; error: { issues: readonly { code: string; path: readonly PropertyKey[] }[] } }): FormFieldError[] {
  if (result.success) return [];
  return result.error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), code: formIssueCode(issue) }));
}

/** The form fields that show an error (the rest goes to the form's own message). */
const SHOWN_LISTS = new Set(['identifiers', 'agents', 'subjects', 'relations', 'customValues', 'links']);

/**
 * Puts field errors (the form's own, or the server's VALIDATION_FAILED) on the form: each body path mapped to its
 * field; a path the form does not show (a hidden field, `source`, `marcExtra`, an unknown custom code) becomes the
 * form's own error.
 */
function showFieldErrors(form: UseFormReturn<RecordFormValues>, errors: readonly FormFieldError[], values: RecordFormValues, ctx: BodyContext): void {
  const hidden = new Set<string>();
  for (const [field, spec] of Object.entries(TEMPLATE_FIELD_KEYS)) {
    if (fieldState(ctx.template, field as keyof typeof TEMPLATE_FIELD_KEYS) === 'hidden') for (const key of spec.keys) hidden.add(key);
  }
  const mapped = errors.map(({ path, code }) => {
    // The publisher picker shows one error for the whole reference (`publisher.name`, `publisher.place`).
    const formPath = path.startsWith('publisher.') ? 'publisher' : bodyPathToFormPath(path, values);
    const head = formPath?.split('.', 1)[0] ?? '';
    const shown = formPath !== null && !hidden.has(head) && head !== 'source' && head !== 'marcExtra' && (SHOWN_LISTS.has(head) || !formPath.includes('.'));
    return { path: shown ? formPath : '', code };
  });
  applyServerErrors(form, new ApiError(422, 'VALIDATION_FAILED', { errors: mapped }));
}

function BackLink() {
  const t = useT();
  return (
    <Link to="/admin/catalog/records" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
      <ArrowLeftIcon className="size-4" aria-hidden="true" />
      {t('catalog.records.back')}
    </Link>
  );
}

/**
 * A scan that may be an ISBN (or the EAN-13 printed with it): digits, then digits, `X`, hyphens or spaces, 10 to 17
 * characters in all. An item barcode (`B0001234567`) is not one and never lands in the ISBN field.
 */
const ISBN_SCAN = /^\d[\dXx -]{9,16}$/;

/** Listens for a barcode scanner while mounted (the data tab is open and the record may be changed, §6.3). */
function IsbnScanner({ onScan }: { onScan(code: string): void }) {
  // An ISBN has 10 or 13 characters: a shorter burst is a fast typist, not a scan.
  useScannerInput({ onScan, minLength: 10 });
  return null;
}

/** The links a copied draft carries (S4): stored as public attachments on create; any but http(s) is skipped. */
function CopiedLinks({ form }: { form: UseFormReturn<RecordFormValues> }) {
  const t = useT();
  const { fields, remove } = useFieldArray({ control: form.control, name: 'links' });
  if (fields.length === 0) return null;
  return (
    <section className="grid gap-2 rounded-lg border bg-card p-4">
      <h2 className="text-base font-semibold">{t('catalog.records.section.links')}</h2>
      <p className="text-xs text-muted-foreground">{t('catalog.records.links.hint')}</p>
      <ul className="grid gap-1 text-sm">
        {fields.map((link, i) => (
          <li key={link.id} className="flex items-center gap-2">
            <span className={isHttpUrl(link.url) ? 'break-all' : 'break-all text-muted-foreground line-through'}>{link.url}</span>
            {link.title !== undefined && <span className="text-muted-foreground">{link.title}</span>}
            <Button type="button" variant="ghost" size="icon" className="ml-auto size-8" aria-label={t('catalog.records.links.remove', { url: link.url })} onClick={() => remove(i)}>
              <XIcon aria-hidden="true" />
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

interface EditorProps {
  /** The stored record (its latest read), or null for a new one. */
  record: RecordDetail | null;
  masters: LoadedMasters;
  canManage: boolean;
  initialTab: Tab;
  /** The page was opened right after the record was created. */
  created: boolean;
  /** Reads the record again (S15) and answers it. */
  reload(): Promise<RecordDetail>;
}

/** The type a new record starts with: the default material type, else the first live one. */
function defaultType(m: LoadedMasters): MaterialTypeView | undefined {
  const live = m.materialTypes.filter((t) => !t.archived);
  return live.find((t) => t.id === m.config.defaultMaterialTypeId) ?? live[0];
}

function RecordEditor({ record, masters, canManage, initialTab, created, reload }: EditorProps) {
  const t = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isNew = record === null;
  const editable = canManage && (record === null || record.mergedInto === null);
  const templateOf = (id: string) => masters.materialTypes.find((m) => m.id === id)?.template ?? EMPTY_TEMPLATE;
  const valuesOf = (d: RecordDetail): RecordFormValues => withCustomRows(detailToFormValues(d), templateOf(d.materialTypeId), masters.customFields);

  const [initial] = useState<RecordFormValues>(() => {
    if (record !== null) return valuesOf(record);
    const type = defaultType(masters);
    return withCustomRows(emptyFormValues(type), type?.template ?? EMPTY_TEMPLATE, masters.customFields);
  });
  const form = useForm<RecordFormValues>({ defaultValues: initial });
  /** The record as loaded (the base of a patch). */
  const base = useRef(initial);
  const [version, setVersion] = useState(record?.version ?? 0);
  const identifiers = useFieldArray({ control: form.control, name: 'identifiers' });
  const materialTypeId = useWatch({ control: form.control, name: 'materialTypeId' });
  const identifierRows = useWatch({ control: form.control, name: 'identifiers' });
  const template = templateOf(materialTypeId);
  const ctx: BodyContext = { template, customFields: masters.customFields };
  const { isDirty, isSubmitting } = form.formState;
  useDirtyGuard(isDirty);

  const [tab, setTab] = useState<Tab>(record === null ? 'data' : initialTab);
  const [problem, setProblem] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [notice, setNotice] = useState<'saved' | 'archived' | 'restored' | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [sruOpen, setSruOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [addItemNow, setAddItemNow] = useState(false);
  const [existing, setExisting] = useState<string | null>(null);

  const firstIsbn = identifierRows.find((r) => r.type === 'isbn' && r.value.trim() !== '')?.value.trim() ?? '';
  const recordPath = record === null ? '' : `catalog/records/${encodeURIComponent(record.id)}`;

  /** The form shows `fresh` (nothing unsaved) and patches from it. */
  const resetTo = (fresh: RecordDetail): void => {
    const values = valuesOf(fresh);
    form.reset(values);
    base.current = values;
    setVersion(fresh.version);
  };

  /** After a write of the editor's own beside the form (cover, archive, restore): its `version`, and the fresh record. */
  const afterOwnWrite = async (newVersion: number): Promise<void> => {
    setVersion(newVersion);
    const fresh = await reload();
    // A form being filled keeps what was typed; its next save carries the version of this write.
    if (!form.formState.isDirty) resetTo(fresh);
  };

  const submit = async (values: RecordFormValues): Promise<void> => {
    setProblem(null);
    setNotice(null);
    setStale(false);
    const createBody = formToCreateBody(values, ctx);
    const patchBody = record === null ? null : formToPatchBody(values, base.current, version, ctx);
    const checked = record === null ? RecordCreateBody.safeParse(createBody) : RecordPatchBody.safeParse(patchBody);
    const errors = [...contractErrors(checked), ...templateRequiredErrors(values, ctx)];
    if (errors.length > 0) {
      showFieldErrors(form, errors, values, ctx);
      return;
    }
    try {
      if (record === null) {
        const r = await api<StoreResponse>('POST', 'catalog/records', createBody);
        await queryClient.invalidateQueries({ queryKey: ['catalog', 'records', 'list'] });
        form.reset(values);
        await navigate({ href: `/admin/catalog/records/${encodeURIComponent(r.id)}${addItemNow ? '?tab=items' : ''}`, state: { created: true } });
        return;
      }
      if (patchBody !== null && Object.keys(patchBody).length > 1) {
        const r = await api<StoreResponse>('PATCH', recordPath, patchBody);
        // Saved: even if the read below fails, the next save starts from these values and this version.
        base.current = values;
        setVersion(r.version);
        form.reset(values);
        await queryClient.invalidateQueries({ queryKey: ['catalog', 'records', 'list'] });
      }
      resetTo(await reload());
      setNotice('saved');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'CONFLICT_STALE') {
        setStale(true);
        return;
      }
      if (e instanceof ApiError && e.code === 'VALIDATION_FAILED') showFieldErrors(form, e.errors ?? [], values, ctx);
      setProblem(problemText(t, e));
    }
  };

  const onSubmit = (e: FormEvent<HTMLFormElement>): void => {
    // Errors set from a previous answer (a list's, the form's own) would hold the next submission back.
    form.clearErrors();
    void form.handleSubmit(submit)(e);
  };

  const reloadStale = async (): Promise<void> => {
    try {
      resetTo(await reload());
      setStale(false);
      setProblem(null);
    } catch (e) {
      setProblem(problemText(t, e));
    }
  };

  const pick = (c: CopyPick): void => {
    const values = draftToFormValues(c.draft, { ...masters, defaultMaterialTypeId: masters.config.defaultMaterialTypeId }, c.source);
    form.reset(withCustomRows(values, templateOf(values.materialTypeId), masters.customFields), { keepDefaultValues: true });
    const server = c.source.startsWith('sru:') ? masters.config.sruServers.find((s) => `sru:${s.id}` === c.source)?.name : undefined;
    setCopied(server ?? c.source);
    setAddItemNow(c.addItemNow === true);
    setExisting(null);
    setSruOpen(false);
  };

  /** A scan lands in the first empty ISBN row (a new row when there is none). */
  const onScan = (raw: string): void => {
    const code = raw.trim();
    if (!ISBN_SCAN.test(code) || fieldState(template, 'identifiers') === 'hidden') return;
    const rows = form.getValues('identifiers');
    const i = rows.findIndex((r) => r.type === 'isbn' && r.value.trim() === '');
    if (i >= 0) form.setValue(`identifiers.${i}.value`, code, { shouldDirty: true });
    else identifiers.append({ type: 'isbn', value: code, qualifier: '' });
  };

  const identifierWarnings = new Map<string, string>();
  const otherWarnings: string[] = [];
  for (const w of record?.warnings ?? []) {
    const m = /^identifiers\.(\d+)\.value$/.exec(w.path);
    const stored = m === null ? undefined : record?.identifiers[Number(m[1])];
    if (stored !== undefined) identifierWarnings.set(stored.value.trim(), w.code);
    else otherWarnings.push(w.code);
  }

  const formPart = (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
      <form noValidate className="flex min-w-0 flex-col gap-4" onSubmit={onSubmit}>
        <fieldset disabled={!editable} className="flex min-w-0 flex-col gap-4">
          <RecordFormSections
            form={form}
            masters={masters}
            template={template}
            identifiers={identifiers}
            identifierWarnings={identifierWarnings}
            isNew={isNew}
            selfId={record?.id ?? null}
            incoming={record?.relations.filter((r) => r.direction === 'in') ?? []}
          />
          {isNew && <CopiedLinks form={form} />}
          <RootError message={form.formState.errors.root?.['server']?.message} />
          {problem !== null && <Notice kind="error">{problem}</Notice>}
          {editable && (
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={isSubmitting}>
                {t(isSubmitting ? 'form.saving' : 'form.save')}
              </Button>
              <Button asChild variant="outline">
                <Link to="/admin/catalog/records">{t('form.cancel')}</Link>
              </Button>
            </div>
          )}
        </fieldset>
      </form>
      <aside className="flex min-w-0 flex-col gap-4">
        {record !== null && (
          <CoverField recordId={record.id} title={record.title} coverFileId={record.coverFileId} version={version} canManage={editable} onChanged={afterOwnWrite} />
        )}
        {isNew && <p className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">{t('catalog.records.cover.after_save')}</p>}
        {editable && <DuplicatesPanel control={form.control} excludeId={record?.id ?? null} />}
      </aside>
    </div>
  );

  return (
    <>
      {/* While "Salin dari SRU" is open, a scan belongs to the dialog, not to the form behind it. */}
      {editable && tab === 'data' && !sruOpen && <IsbnScanner onScan={onScan} />}
      {created && notice === null && !stale && <Notice kind="success">{t('catalog.records.created')}</Notice>}
      {notice === 'saved' && <Notice kind="success">{t('catalog.records.saved')}</Notice>}
      {notice === 'archived' && <Notice kind="success">{t('catalog.records.archived_done')}</Notice>}
      {notice === 'restored' && <Notice kind="success">{t('catalog.records.restored_done')}</Notice>}
      {stale && (
        <Notice
          kind="error"
          action={
            <Button type="button" variant="outline" size="sm" onClick={() => void reloadStale()}>
              {t('catalog.records.stale_reload')}
            </Button>
          }
        >
          {t('catalog.records.stale')}
        </Notice>
      )}
      {!canManage && <p className="rounded-md border bg-muted/50 px-3 py-2 text-sm">{t('catalog.records.read_only')}</p>}
      {record?.mergedInto != null && (
        <p className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/50 px-3 py-2 text-sm">
          {t('catalog.records.merged')}
          <Link to={`/admin/catalog/records/${encodeURIComponent(record.mergedInto)}`} className="text-primary underline-offset-4 hover:underline">
            {t('catalog.records.merged_link')}
          </Link>
        </p>
      )}
      {record?.archived === true && record.mergedInto === null && (
        <p className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/50 px-3 py-2 text-sm">{t('catalog.records.archived_notice')}</p>
      )}
      {otherWarnings.length > 0 && (
        <NoticeAlert>
          <p className="font-medium">{t('catalog.records.warnings')}</p>
          <ul className="list-disc pl-5">
            {otherWarnings.map((code, i) => (
              <li key={`${code}-${i}`}>{t(`catalog.records.warning.${code}` as TKey)}</li>
            ))}
          </ul>
        </NoticeAlert>
      )}
      {record !== null && editable && (
        <div className="flex flex-wrap gap-2">
          {record.archived ? (
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                void (async () => {
                  setProblem(null);
                  try {
                    const r = await api<StoreResponse>('POST', `${recordPath}/restore`, { version });
                    await queryClient.invalidateQueries({ queryKey: ['catalog', 'records', 'list'] });
                    await afterOwnWrite(r.version);
                    setNotice('restored');
                  } catch (e) {
                    if (e instanceof ApiError && e.code === 'CONFLICT_STALE') setStale(true);
                    else setProblem(problemText(t, e));
                  }
                })()
              }
            >
              <ArchiveRestoreIcon aria-hidden="true" />
              {t('catalog.records.restore')}
            </Button>
          ) : (
            <Button type="button" variant="outline" onClick={() => setConfirm(true)}>
              <ArchiveIcon aria-hidden="true" />
              {t('catalog.records.archive')}
            </Button>
          )}
        </div>
      )}
      {record !== null && (
        <ConfirmDialog
          open={confirm}
          title={t('catalog.records.archive_title')}
          description={t('catalog.records.archive_description')}
          confirmLabel={t('catalog.records.archive')}
          destructive
          onConfirm={async () => {
            const r = await api<StoreResponse>('DELETE', recordPath, { version });
            await queryClient.invalidateQueries({ queryKey: ['catalog', 'records', 'list'] });
            await afterOwnWrite(r.version);
            setNotice('archived');
          }}
          onClose={() => setConfirm(false)}
        />
      )}
      {isNew && editable && (
        <section aria-label={t('catalog.records.copy.label')} className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 p-3">
          <p className="w-full text-sm text-muted-foreground">{t('catalog.records.copy.hint')}</p>
          <IsbnLookupButton isbn={firstIsbn} onPick={pick} onExisting={setExisting} />
          <Button type="button" variant="outline" onClick={() => setSruOpen(true)}>
            {t('catalog.records.copy.sru')}
          </Button>
          <SruCopyDialog open={sruOpen} onOpenChange={setSruOpen} onPick={pick} {...(firstIsbn === '' ? {} : { initialIsbn: firstIsbn })} />
        </section>
      )}
      {existing !== null && (
        <div role="status" className="flex flex-wrap items-center gap-3 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
          <span className="font-medium">{t('catalog.records.existing')}</span>
          <Link to={`/admin/catalog/records/${encodeURIComponent(existing)}`} className="text-primary underline-offset-4 hover:underline">
            {t('catalog.records.existing_open')}
          </Link>
          <Link to={`/admin/catalog/records/${encodeURIComponent(existing)}`} search={{ tab: 'items' }} className="text-primary underline-offset-4 hover:underline">
            {t('catalog.records.existing_add_item')}
          </Link>
        </div>
      )}
      {copied !== null && (
        <NoticeAlert>
          {t('catalog.records.copy.filled', { source: copied })}
          {/* M13: "Tambah eksemplar sekarang" was ticked; the save opens the new record on its items tab. */}
          {addItemNow && ` ${t('catalog.sru.add_item_after_save')}`}
        </NoticeAlert>
      )}

      {record === null ? (
        formPart
      ) : (
        <Tabs value={tab} onValueChange={(v) => setTab(parseTab(v))}>
          <TabsList aria-label={t('catalog.records.tabs')} className="flex-wrap">
            <TabsTrigger value="data">{t('catalog.records.tab.data')}</TabsTrigger>
            <TabsTrigger value="items">{t('catalog.records.tab.items', { count: record.itemCounts.total })}</TabsTrigger>
            <TabsTrigger value="attachments">{t('catalog.records.tab.attachments')}</TabsTrigger>
            <TabsTrigger value="marc">{t('catalog.records.tab.marc')}</TabsTrigger>
          </TabsList>
          {/* The form stays mounted while another tab is open: nothing typed is lost. */}
          <TabsContent value="data" forceMount className="data-[state=inactive]:hidden">
            {formPart}
          </TabsContent>
          <TabsContent value="items">
            {/* New items start with the saved type's template default collection type (C22), not the form's unsaved one. */}
            <RecordItemsTab recordId={record.id} defaultCollectionTypeId={templateOf(record.materialTypeId).defaults.collectionTypeId ?? null} />
          </TabsContent>
          <TabsContent value="attachments">
            <AttachmentsPanel recordId={record.id} />
          </TabsContent>
          <TabsContent value="marc">
            <MarcTab recordId={record.id} />
          </TabsContent>
        </Tabs>
      )}
    </>
  );
}

/** `/admin/catalog/records/new`. */
export function RecordCreateScreen() {
  const t = useT();
  const me = useMe();
  const canManage = holds(me, 'catalog.records.manage');
  const masters = useEditorMasters();
  const live = masters.data?.materialTypes.filter((m) => !m.archived) ?? [];
  return (
    <div className="flex flex-col gap-4">
      <BackLink />
      <h1 className="text-2xl font-semibold">{t('catalog.records.new.title')}</h1>
      {/* The server would refuse (and record the refusal): say so before anything is typed. */}
      {!canManage && <ProblemAlert error={new ApiError(403, 'AUTHZ_DENIED')} />}
      {masters.data === undefined ? (
        masters.error !== null ? (
          <ProblemAlert error={masters.error} />
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            {t('shell.loading')}
          </p>
        )
      ) : live.length === 0 ? (
        <Notice kind="error">{t('catalog.records.no_types')}</Notice>
      ) : (
        <RecordEditor
          record={null}
          masters={masters.data}
          canManage={canManage}
          initialTab="data"
          created={false}
          reload={() => Promise.reject(new Error('RecordEditor: a new record has nothing to read again'))}
        />
      )}
    </div>
  );
}

/** `/admin/catalog/records/:id` (`?tab=items|attachments|marc` opens that tab). */
export function RecordEditScreen() {
  const t = useT();
  const me = useMe();
  const queryClient = useQueryClient();
  const canManage = holds(me, 'catalog.records.manage');
  const { recordId = '' } = useParams({ strict: false }) as { recordId?: string };
  const initialTab = parseTab((useSearch({ strict: false }) as Record<string, unknown>)['tab']);
  const created = useRouterState({ select: (s) => s.location.state.created === true });
  const path = `catalog/records/${encodeURIComponent(recordId)}`;
  const detail = useApiQuery<RecordDetail>({ queryKey: detailKey(recordId), path });
  const masters = useEditorMasters();
  const reload = (): Promise<RecordDetail> => queryClient.fetchQuery({ queryKey: detailKey(recordId), queryFn: () => api<RecordDetail>('GET', path), staleTime: 0 });
  const record = detail.data;

  return (
    <div className="flex flex-col gap-4">
      <BackLink />
      {record === undefined ? (
        detail.isError ? (
          <Notice kind="error">{problemText(t, detail.error)}</Notice>
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            {t('shell.loading')}
          </p>
        )
      ) : (
        <>
          <div className="flex flex-col gap-1">
            <h1 className="text-2xl font-semibold">{record.title}</h1>
            {(record.subtitle !== undefined || record.archived || !record.opacVisible || record.mergedInto !== null) && (
              <p className="flex flex-wrap items-center gap-2 text-muted-foreground">
                {record.subtitle !== undefined && <span>{record.subtitle}</span>}
                {record.mergedInto !== null && <Badge tone="warning">{t('catalog.records.badge.merged')}</Badge>}
                {record.archived && <Badge tone="warning">{t('catalog.records.badge.archived')}</Badge>}
                {!record.opacVisible && <Badge>{t('catalog.records.badge.hidden')}</Badge>}
              </p>
            )}
          </div>
          <RefetchProblem query={detail} />
          {masters.data === undefined ? (
            masters.error !== null ? (
              <ProblemAlert error={masters.error} />
            ) : (
              <p role="status" className="text-sm text-muted-foreground">
                {t('shell.loading')}
              </p>
            )
          ) : (
            <RecordEditor key={record.id} record={record} masters={masters.data} canManage={canManage} initialTab={initialTab} created={created} reload={reload} />
          )}
        </>
      )}
    </div>
  );
}
