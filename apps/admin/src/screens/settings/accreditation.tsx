import type { CollectionTypeView, MasterListResponse, MaterialTypeView } from '@altis/shared/api/catalog/masters';
import type { PageListResponse } from '@altis/shared/api/opac-pages';
import { USED_UNITS, type AccreditationSettingsView } from '@altis/shared/api/settings';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useForm, useWatch, type UseFormReturn } from 'react-hook-form';
import { CheckField, Field, Notice, SELECT_CLASS } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useLocale, useT, type AdminKey } from '@/i18n';
import { holds } from '@/lib/access';
import { api } from '@/lib/api';
import { useDirtyGuard } from '@/lib/dirty-forms';
import { FORM_PARSE, applyServerErrors, hasFieldErrors } from '@/lib/form-errors';
import { useApiQuery, useMe } from '@/lib/me';
import { ChipListField } from './accreditation/chip-list';
import {
  AccredForm,
  BOUNDS,
  LIST_SCHEMAS,
  PAGE_KEYS,
  UNKNOWN_GROUP_CHOICES,
  accredFormValues,
  accreditationBody,
  changedElsewhere,
  listMax,
  settingsOf,
  type AccredFormInput,
  type AccredFormOutput,
  type ChipListName,
  type PageKey,
} from './accreditation/form';
import { SettingsFooter, SettingsLoader, SettingsPage, SettingsSection, saveSettings, type SaveOutcome } from './library';

/**
 * Pengaturan › Akreditasi, `/admin/settings/accreditation`: the sixteen settings of the `accreditation` group in one
 * form, saved with one `PUT settings/accreditation` whose body holds only the settings that changed (a list and the
 * website features go whole). Read with `system.settings.read`; without `system.settings.manage` every field is
 * disabled and there is no save button.
 *
 * - **Tahun ajaran dan data:** the first month of the school year, and the day the library started working in ALTIS
 *   (empty: the server takes the first month with an ALTIS visit or loan that was not migrated).
 * - **Penggolongan koleksi:** the code and prefix lists as chips (accreditation/chip-list.tsx: Enter or "Tambah" adds an
 *   entry, normalised as the server stores it), with the masters' codes offered while typing for a user who reads the
 *   catalogue; and whether collection use counts titles or copies.
 * - **Ambang perhitungan:** the processed-collection threshold and the largest share of copies without an acquisition
 *   date, checked against the shared bounds before anything is sent.
 * - **Situs web perpustakaan:** an OPAC page for each assessed website feature, picked from `GET opac/pages` by a user
 *   who manages pages (`opac.pages.manage`, the route's own permission), typed as a page id by anyone else; and up to
 *   five social media addresses.
 * - **Berkas bukti:** the largest evidence file and the per-component size limit.
 * - **Kunjungan dan impor SLiMS:** whether repeated visits from SLiMS data are left out, and the group the visits and
 *   loans of members deleted in SLiMS count in ("Otomatis": students in a school library, none elsewhere).
 *
 * Just before the PUT the group is read once more: when another admin changed a setting this body writes since the
 * page opened, nothing is sent (a list goes whole, so the PUT would undo that change) and the page offers the newer
 * settings. After a save the form starts over from what the server now stores.
 */

type AccredFormApi = UseFormReturn<AccredFormInput, unknown, AccredFormOutput>;

const PAGE_LABEL: Readonly<Record<PageKey, AdminKey>> = {
  profilePageId: 'accreditation.settings.page.profile',
  servicesPageId: 'accreditation.settings.page.services',
  contactPageId: 'accreditation.settings.page.contact',
  databasesPageId: 'accreditation.settings.page.databases',
  faqPageId: 'accreditation.settings.page.faq',
};

/** The static OPAC pages a website feature may point to (one request: a library has a handful). */
const PAGES_PATH = 'opac/pages?kind=page&limit=200';

/** The month names of the UI language, January first. */
function monthNames(locale: string): string[] {
  const format = new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'id-ID', { month: 'long', timeZone: 'UTC' });
  return Array.from({ length: 12 }, (_, i) => format.format(Date.UTC(2000, i, 1)));
}

/** The error at the `.`-joined `path` of the form's errors, or undefined. */
function errorAt(form: AccredFormApi, path: string): { type?: string; message?: string } | undefined {
  let node: unknown = form.formState.errors;
  for (const segment of path.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  if (typeof node !== 'object' || node === null) return undefined;
  const own = node as { type?: unknown; message?: unknown };
  return typeof own.type === 'string' || typeof own.message === 'string' ? (own as { type?: string; message?: string }) : undefined;
}

/** A whole number setting, with its bounds in the hint. */
function NumberField({
  form,
  name,
  label,
  hintKey,
  bound,
  readOnly,
}: {
  form: AccredFormApi;
  name: 'k7.processedThresholdPct' | 'undatedShareMaxPct' | 'evidence.maxMb' | 'evidence.componentLimitMb';
  label: string;
  hintKey: AdminKey;
  bound: { minValue: number | null; maxValue: number | null };
  readOnly: boolean;
}) {
  const t = useT();
  return (
    <Field label={label} hint={t(hintKey, { min: bound.minValue ?? '', max: bound.maxValue ?? '' })} error={errorAt(form, name)}>
      {(c) => (
        <Input
          {...c}
          type="number"
          inputMode="numeric"
          min={bound.minValue ?? undefined}
          max={bound.maxValue ?? undefined}
          className="w-32"
          {...form.register(name, { valueAsNumber: true })}
          disabled={readOnly}
        />
      )}
    </Field>
  );
}

/**
 * An OPAC page of a website feature: a select of the static pages (`pages`, when the user may read them), or the page
 * id typed (`pages` null). The stored page stays an option when it is not in the list (archived, or the list did not
 * come).
 */
function PageField({
  form,
  name,
  stored,
  pages,
  unavailable,
  readOnly,
}: {
  form: AccredFormApi;
  name: PageKey;
  stored: string;
  pages: PageListResponse['items'] | null;
  unavailable: boolean;
  readOnly: boolean;
}) {
  const t = useT();
  const path = `websiteFeatures.${name}` as const;
  // Controlled: the pages arrive after the form, and an uncontrolled select whose chosen option is added later would
  // fall back to its first option.
  const value = useWatch({ control: form.control, name: path });
  const label = t(PAGE_LABEL[name]);
  if (pages === null) {
    return (
      <Field label={label} hint={t('accreditation.settings.page.id_hint')} error={errorAt(form, path)}>
        {(c) => <Input {...c} className="font-mono" maxLength={26} autoComplete="off" spellCheck={false} {...form.register(path)} disabled={readOnly} />}
      </Field>
    );
  }
  const known = pages.some((p) => p.id === stored);
  return (
    <Field label={label} hint={unavailable ? t('accreditation.settings.page.unavailable') : undefined} error={errorAt(form, path)}>
      {(c) => (
        <select {...c} className={SELECT_CLASS} {...form.register(path)} value={value} disabled={readOnly}>
          <option value="">{t('accreditation.settings.page.none')}</option>
          {pages.map((p) => (
            <option key={p.id} value={p.id}>
              {p.status === 'draft' ? t('accreditation.settings.page.draft', { title: p.title, slug: p.slug }) : `${p.title} (/${p.slug})`}
            </option>
          ))}
          {stored !== '' && !known && <option value={stored}>{t('accreditation.settings.page.missing', { id: stored })}</option>}
        </select>
      )}
    </Field>
  );
}

/** The live codes of a master list, for the chips' suggestions. */
const liveCodes = (items: readonly { code: string; archived: boolean }[] | undefined): string[] => (items ?? []).filter((m) => !m.archived).map((m) => m.code);

/** The lists of the collection section: path, label and hint, and which master's codes it suggests. */
const COLLECTION_LISTS: readonly { name: ChipListName; labelKey: AdminKey; hintKey: AdminKey; master?: 'collection' | 'material' }[] = [
  {
    name: 'fiction.collectionTypeCodes',
    labelKey: 'accreditation.settings.fiction_collection_types',
    hintKey: 'accreditation.settings.fiction_collection_types_hint',
    master: 'collection',
  },
  { name: 'fiction.callNumberPrefixes', labelKey: 'accreditation.settings.fiction_call_number_prefixes', hintKey: 'accreditation.settings.fiction_call_number_prefixes_hint' },
  { name: 'fiction.ddcPrefixes', labelKey: 'accreditation.settings.fiction_ddc_prefixes', hintKey: 'accreditation.settings.fiction_ddc_prefixes_hint' },
  {
    name: 'referenceCollectionTypeCodes',
    labelKey: 'accreditation.settings.reference_collection_types',
    hintKey: 'accreditation.settings.reference_collection_types_hint',
    master: 'collection',
  },
  {
    name: 'textbookCollectionTypeCodes',
    labelKey: 'accreditation.settings.textbook_collection_types',
    hintKey: 'accreditation.settings.textbook_collection_types_hint',
    master: 'collection',
  },
  {
    name: 'electronicMaterialTypeCodes',
    labelKey: 'accreditation.settings.electronic_material_types',
    hintKey: 'accreditation.settings.electronic_material_types_hint',
    master: 'material',
  },
];

function AccreditationSettingsForm({ initial, canManage }: { initial: AccreditationSettingsView; canManage: boolean }) {
  const t = useT();
  const me = useMe();
  const locale = useLocale();
  const queryClient = useQueryClient();
  const [view, setView] = useState(initial);
  const [outcome, setOutcome] = useState<SaveOutcome>(null);
  const [problem, setProblem] = useState<unknown>(null);
  /** The group as stored now, when a save found that someone else changed what it would write. */
  const [newer, setNewer] = useState<AccreditationSettingsView | null>(null);
  const form = useForm<AccredFormInput, unknown, AccredFormOutput>({ resolver: zodResolver(AccredForm, FORM_PARSE), defaultValues: accredFormValues(initial) });
  const { errors, isDirty, isSubmitting } = form.formState;
  useDirtyGuard(isDirty);
  const readOnly = !canManage;
  const months = useMemo(() => monthNames(locale), [locale]);

  const pagesReadable = holds(me, 'opac.pages.manage');
  const pages = useApiQuery<PageListResponse>({ queryKey: ['opac', 'pages', 'accreditation-picker'], path: PAGES_PATH, enabled: pagesReadable, staleTime: 60_000 });
  const mastersReadable = holds(me, 'catalog.records.read');
  const collectionTypes = useApiQuery<MasterListResponse<CollectionTypeView>>({
    queryKey: ['catalog', 'collection-types', { includeArchived: true }],
    path: 'catalog/collection-types?includeArchived=true',
    enabled: mastersReadable,
    staleTime: 60_000,
  });
  const materialTypes = useApiQuery<MasterListResponse<MaterialTypeView>>({
    queryKey: ['catalog', 'material-types', { includeArchived: true }],
    path: 'catalog/material-types?includeArchived=true',
    enabled: mastersReadable,
    staleTime: 60_000,
  });
  const suggestions = { collection: liveCodes(collectionTypes.data?.items), material: liveCodes(materialTypes.data?.items) };
  // The select of pages for whoever may read them (the stored ids stay options until they came); a page id otherwise.
  const pageList = pagesReadable ? (pages.data?.items ?? []) : null;

  const submit = form.handleSubmit(async (values) => {
    setProblem(null);
    setOutcome(null);
    setNewer(null);
    const body = accreditationBody(settingsOf(values), view);
    if (Object.keys(body).length === 0) {
      form.reset(accredFormValues(view));
      setOutcome('unchanged');
      return;
    }
    try {
      // A list goes whole: if another admin changed what this body writes since the page opened, saving would undo it.
      const fresh = await api<AccreditationSettingsView>('GET', 'settings/accreditation');
      if (changedElsewhere(body, view, fresh)) {
        setNewer(fresh);
        return;
      }
      const saved = await saveSettings(queryClient, 'accreditation', body);
      setView(saved.view);
      form.reset(accredFormValues(saved.view));
      setOutcome('saved');
    } catch (e) {
      if (hasFieldErrors(e)) applyServerErrors(form, e);
      else setProblem(e);
    }
  });

  return (
    <form noValidate className="grid gap-6" onSubmit={(e) => void submit(e)} onChange={() => setOutcome(null)}>
      <p className="text-sm text-muted-foreground">{t('accreditation.settings.description')}</p>

      <SettingsSection title={t('accreditation.settings.section.period')}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label={t('accreditation.settings.school_year_start_month')}
            hint={t('accreditation.settings.school_year_start_month_hint')}
            error={errorAt(form, 'schoolYearStartMonth')}
          >
            {(c) => (
              <select {...c} className={SELECT_CLASS} {...form.register('schoolYearStartMonth', { valueAsNumber: true })} disabled={readOnly}>
                {months.map((name, i) => (
                  <option key={name} value={i + 1}>
                    {name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label={t('accreditation.settings.live_from')} hint={t('accreditation.settings.live_from_hint')} error={errorAt(form, 'liveFrom')}>
            {(c) => <Input {...c} type="date" className="w-48" {...form.register('liveFrom')} disabled={readOnly} />}
          </Field>
        </div>
      </SettingsSection>

      <SettingsSection title={t('accreditation.settings.section.collection')} description={t('accreditation.settings.section.collection_hint')}>
        <div className="grid gap-5 sm:grid-cols-2">
          {COLLECTION_LISTS.map((list) => (
            <ChipListField
              key={list.name}
              control={form.control}
              errors={errors}
              name={list.name}
              label={t(list.labelKey)}
              hint={t(list.hintKey)}
              readOnly={readOnly}
              {...(list.master === undefined ? {} : { suggestions: suggestions[list.master] })}
            />
          ))}
          <Field label={t('accreditation.settings.used_unit')} hint={t('accreditation.settings.used_unit_hint')} error={errorAt(form, 'usedUnit')}>
            {(c) => (
              <select {...c} className={SELECT_CLASS} {...form.register('usedUnit')} disabled={readOnly}>
                {USED_UNITS.map((unit) => (
                  <option key={unit} value={unit}>
                    {t(`accreditation.settings.used_unit.${unit}`)}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
      </SettingsSection>

      <SettingsSection title={t('accreditation.settings.section.thresholds')}>
        <div className="grid gap-4 sm:grid-cols-2">
          <NumberField
            form={form}
            name="k7.processedThresholdPct"
            label={t('accreditation.settings.processed_threshold')}
            hintKey="accreditation.settings.processed_threshold_hint"
            bound={BOUNDS.processedThresholdPct}
            readOnly={readOnly}
          />
          <NumberField
            form={form}
            name="undatedShareMaxPct"
            label={t('accreditation.settings.undated_share_max')}
            hintKey="accreditation.settings.undated_share_max_hint"
            bound={BOUNDS.undatedShareMaxPct}
            readOnly={readOnly}
          />
        </div>
      </SettingsSection>

      <SettingsSection title={t('accreditation.settings.section.website')} description={t('accreditation.settings.section.website_hint')}>
        <div className="grid gap-4 sm:grid-cols-2">
          {PAGE_KEYS.map((key) => (
            <PageField
              key={key}
              form={form}
              name={key}
              stored={view.websiteFeatures[key] ?? ''}
              pages={pageList}
              unavailable={pagesReadable && pages.isError}
              readOnly={readOnly}
            />
          ))}
          <ChipListField
            control={form.control}
            errors={errors}
            name="websiteFeatures.socialUrls"
            label={t('accreditation.settings.social_urls')}
            hint={t('accreditation.settings.social_urls_hint', { max: listMax(LIST_SCHEMAS['websiteFeatures.socialUrls']) })}
            readOnly={readOnly}
            mono={false}
          />
        </div>
      </SettingsSection>

      <SettingsSection title={t('accreditation.settings.section.evidence')}>
        <div className="grid gap-4 sm:grid-cols-2">
          <NumberField
            form={form}
            name="evidence.maxMb"
            label={t('accreditation.settings.evidence_max_mb')}
            hintKey="accreditation.settings.evidence_max_mb_hint"
            bound={BOUNDS.evidenceMb}
            readOnly={readOnly}
          />
          <NumberField
            form={form}
            name="evidence.componentLimitMb"
            label={t('accreditation.settings.component_limit_mb')}
            hintKey="accreditation.settings.component_limit_mb_hint"
            bound={BOUNDS.evidenceMb}
            readOnly={readOnly}
          />
        </div>
      </SettingsSection>

      <SettingsSection title={t('accreditation.settings.section.usage')}>
        <div className="grid gap-4">
          <CheckField
            label={t('accreditation.settings.dedupe_legacy')}
            hint={t('accreditation.settings.dedupe_legacy_hint')}
            {...form.register('visits.dedupeLegacy')}
            disabled={readOnly}
          />
          <Field
            label={t('accreditation.settings.unknown_group')}
            hint={t('accreditation.settings.unknown_group_hint')}
            error={errorAt(form, 'unknownMemberGroup.default')}
            className="max-w-md"
          >
            {(c) => (
              <select {...c} className={SELECT_CLASS} {...form.register('unknownMemberGroup.default')} disabled={readOnly}>
                {UNKNOWN_GROUP_CHOICES.map((choice) => (
                  <option key={choice} value={choice}>
                    {choice === 'auto' || choice === 'none' ? t(`accreditation.settings.unknown_group.${choice}`) : t(`vocab.accred_group.${choice}`)}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
      </SettingsSection>

      {newer !== null && (
        <Notice
          kind="error"
          action={
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setView(newer);
                form.reset(accredFormValues(newer));
                setNewer(null);
              }}
            >
              {t('accreditation.settings.load_newer')}
            </Button>
          }
        >
          {t('accreditation.settings.changed_elsewhere')}
        </Notice>
      )}
      <SettingsFooter canManage={canManage} busy={isSubmitting} outcome={outcome} problem={problem} rootError={errors.root?.['server']?.message} />
    </form>
  );
}

/** `/admin/settings/accreditation`. */
export function AccreditationSettingsScreen() {
  return (
    <SettingsPage>
      <SettingsLoader group="accreditation">{(view, canManage) => <AccreditationSettingsForm initial={view} canManage={canManage} />}</SettingsLoader>
    </SettingsPage>
  );
}
