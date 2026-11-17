import type { CollectionTypeView, MasterListResponse, MaterialTypeView } from '@altis/shared/api/catalog/masters';
import { BARCODE_SYMBOLOGIES, attachmentMaxMbField, dedupeThresholdField, type CatalogSettings } from '@altis/shared/api/settings';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm, useWatch, type UseFormReturn } from 'react-hook-form';
import { SideSection } from '@/components/layout';
import { CheckField, Field, Notice, SELECT_CLASS } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useLocale, useT } from '@/i18n';
import { holds, isSuperAdmin } from '@/lib/access';
import { api } from '@/lib/api';
import { useDirtyGuard } from '@/lib/dirty-forms';
import { FORM_PARSE, applyServerErrors, hasFieldErrors } from '@/lib/form-errors';
import { useApiQuery, useMe } from '@/lib/me';
import { BarcodePatternsEditor } from './catalog/barcode-patterns';
import { CatalogForm, catalogBody, catalogFormValues, changedElsewhere, errorAt, ownError, type CatalogFormValues } from './catalog/form';
import { LabelProfilesEditor, SYMBOLOGY_NAMES } from './catalog/label-profiles';
import { SruServersEditor } from './catalog/sru-servers';
import { SettingsFooter, SettingsLoader, SettingsPage, saveSettings, type SaveOutcome } from './library';

/**
 * Pengaturan › Katalog (Phase 2 spec §13 "Pengaturan › Katalog", §12.6, §6.2, §7; plan Task 28), `/admin/settings/catalog`:
 * the `catalog` group in one form, saved with one `PUT settings/catalog` whose body holds only the keys that changed
 * (a list that changed goes whole). Read with `system.settings.read`; without `system.settings.manage` every field is
 * disabled and there is no save, add or test button.
 *
 * - **Umum:** the MARC organization code (null: an export omits 003/040 `$a`, P2-32), the default material and
 *   collection types (selects over the masters, read with `catalog.records.read`; without it, or when they cannot be
 *   read, the stored choice can only be kept or cleared), the currency, the largest attachment and the duplicate
 *   threshold.
 * - **Barkod:** the symbology and the numbering patterns (catalog/barcode-patterns.tsx).
 * - **Profil label:** the sheet profiles with a schematic page preview (catalog/label-profiles.tsx).
 * - **Salin katalog (SRU):** the servers and their "Uji" (catalog/sru-servers.tsx); "Izinkan host privat", which only a
 *   super admin may change (M11: the server refuses anyone else's change with 403, so it is read-only for them, with
 *   the reason).
 *
 * The form checks everything first with the shared Zod schemas the server applies (catalog/form.ts; M1: 20 patterns and
 * 20 profiles at most, D35), and a 422 from the server lands on the field it names. Just before the PUT the group is
 * read once more: when another admin changed a setting this body writes since the page opened, nothing is sent (a list
 * goes whole, so the PUT would undo that change) and the page offers the newer settings. After a save the group is
 * read again (SettingsLoader's cycle) and `GET catalog/config` is made stale for the catalogue screens.
 */

type CatalogFormApi = UseFormReturn<CatalogFormValues, unknown, CatalogSettings>;

/** The query key of `GET catalog/config` (the catalogue screens read the patterns and profiles through it). */
const CATALOG_CONFIG_KEY = ['catalog', 'config'] as const;

/** A master as a default may name it. */
interface MasterOption {
  id: string;
  nameId: string;
  nameEn: string;
  archived: boolean;
}

/**
 * A select of the live masters (and the stored choice, even archived or unknown), `''` for none. Its value is
 * controlled: the options arrive after the form (the masters are read separately), and an uncontrolled select whose
 * chosen option is replaced falls back to its first option, so it would show "Tidak ada" for a stored choice.
 */
function MasterSelect({
  form,
  name,
  label,
  hint,
  items,
  stored,
  unavailable,
  readOnly,
}: {
  form: CatalogFormApi;
  name: 'defaultMaterialTypeId' | 'defaultCollectionTypeId';
  label: string;
  hint: string;
  items: readonly MasterOption[] | undefined;
  stored: string | null;
  unavailable: boolean;
  readOnly: boolean;
}) {
  const t = useT();
  const locale = useLocale();
  const nameOf = (m: MasterOption): string => (locale === 'en' ? m.nameEn : m.nameId);
  const list = items ?? [];
  const known = stored === null ? undefined : list.find((m) => m.id === stored);
  const value = useWatch({ control: form.control, name });
  return (
    <Field label={label} hint={unavailable ? `${hint} ${t('catalog.settings.masters_unavailable')}` : hint} error={ownError(errorAt(form.formState.errors, name))}>
      {(c) => (
        <select {...c} className={SELECT_CLASS} {...form.register(name)} value={value} disabled={readOnly}>
          <option value="">{t('catalog.settings.default_none')}</option>
          {list
            .filter((m) => !m.archived)
            .map((m) => (
              <option key={m.id} value={m.id}>
                {nameOf(m)}
              </option>
            ))}
          {stored !== null && known?.archived === true && <option value={stored}>{t('catalog.settings.default_archived', { name: nameOf(known) })}</option>}
          {stored !== null && known === undefined && <option value={stored}>{t('catalog.settings.default_unknown', { id: stored })}</option>}
        </select>
      )}
    </Field>
  );
}

function CatalogSettingsForm({ initial, canManage }: { initial: CatalogSettings; canManage: boolean }) {
  const t = useT();
  const me = useMe();
  const queryClient = useQueryClient();
  const [view, setView] = useState(initial);
  const [outcome, setOutcome] = useState<SaveOutcome>(null);
  const [problem, setProblem] = useState<unknown>(null);
  /** The group as stored now, when a save found that someone else changed what it would write. */
  const [newer, setNewer] = useState<CatalogSettings | null>(null);
  const form = useForm<CatalogFormValues, unknown, CatalogSettings>({
    resolver: zodResolver(CatalogForm, FORM_PARSE),
    defaultValues: catalogFormValues(initial),
  });
  const { errors, isDirty, isSubmitting } = form.formState;
  useDirtyGuard(isDirty);
  const readOnly = !canManage;
  const superAdmin = isSuperAdmin(me);

  const mastersReadable = holds(me, 'catalog.records.read');
  const materialTypes = useApiQuery<MasterListResponse<MaterialTypeView>>({
    queryKey: ['catalog', 'material-types', { includeArchived: true }],
    path: 'catalog/material-types?includeArchived=true',
    enabled: mastersReadable,
    staleTime: 60_000,
  });
  const collectionTypes = useApiQuery<MasterListResponse<CollectionTypeView>>({
    queryKey: ['catalog', 'collection-types', { includeArchived: true }],
    path: 'catalog/collection-types?includeArchived=true',
    enabled: mastersReadable,
    staleTime: 60_000,
  });

  const submit = form.handleSubmit(async (next) => {
    setProblem(null);
    setOutcome(null);
    setNewer(null);
    const body = catalogBody(next, view);
    if (Object.keys(body).length === 0) {
      form.reset(catalogFormValues(view));
      setOutcome('unchanged');
      return;
    }
    try {
      // A list goes whole: if another admin changed what this body writes since the page opened, saving would undo it.
      const fresh = await api<CatalogSettings>('GET', 'settings/catalog');
      if (changedElsewhere(body, view, fresh)) {
        setNewer(fresh);
        return;
      }
      const saved = await saveSettings(queryClient, 'catalog', body);
      setView(saved.view);
      form.reset(catalogFormValues(saved.view));
      setOutcome('saved');
      void queryClient.invalidateQueries({ queryKey: CATALOG_CONFIG_KEY });
    } catch (e) {
      if (hasFieldErrors(e)) applyServerErrors(form, e);
      else setProblem(e);
    }
  });

  const fieldError = (path: string) => ownError(errorAt(errors, path));

  return (
    <form noValidate className="grid gap-6" onSubmit={(e) => void submit(e)} onChange={() => setOutcome(null)}>
      <p className="text-sm text-muted-foreground">{t('catalog.settings.description')}</p>

      <SideSection title={t('catalog.settings.general.title')}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('catalog.settings.marc_org_code')} hint={t('catalog.settings.marc_org_code_hint')} error={fieldError('marcOrgCode')}>
            {(c) => <Input {...c} className="font-mono" maxLength={16} autoComplete="off" spellCheck={false} {...form.register('marcOrgCode')} disabled={readOnly} />}
          </Field>
          <Field label={t('catalog.settings.currency')} hint={t('catalog.settings.currency_hint')} error={fieldError('currency')}>
            {(c) => (
              <Input {...c} className="w-24 font-mono uppercase" maxLength={3} autoComplete="off" spellCheck={false} {...form.register('currency')} disabled={readOnly} />
            )}
          </Field>
          <MasterSelect
            form={form}
            name="defaultMaterialTypeId"
            label={t('catalog.settings.default_material_type')}
            hint={t('catalog.settings.default_material_type_hint')}
            items={materialTypes.data?.items}
            stored={view.defaultMaterialTypeId}
            unavailable={!mastersReadable || materialTypes.isError}
            readOnly={readOnly}
          />
          <MasterSelect
            form={form}
            name="defaultCollectionTypeId"
            label={t('catalog.settings.default_collection_type')}
            hint={t('catalog.settings.default_collection_type_hint')}
            items={collectionTypes.data?.items}
            stored={view.defaultCollectionTypeId}
            unavailable={!mastersReadable || collectionTypes.isError}
            readOnly={readOnly}
          />
          <Field
            label={t('catalog.settings.attachment_max_mb')}
            hint={t('catalog.settings.attachment_max_mb_hint', { min: attachmentMaxMbField.minValue ?? '', max: attachmentMaxMbField.maxValue ?? '' })}
            error={fieldError('attachment.maxMb')}
          >
            {(c) => (
              <Input
                {...c}
                type="number"
                inputMode="numeric"
                min={attachmentMaxMbField.minValue ?? undefined}
                max={attachmentMaxMbField.maxValue ?? undefined}
                {...form.register('attachment.maxMb', { valueAsNumber: true })}
                disabled={readOnly}
              />
            )}
          </Field>
          <Field
            label={t('catalog.settings.dedupe_threshold')}
            hint={t('catalog.settings.dedupe_threshold_hint', { min: dedupeThresholdField.minValue ?? '', max: dedupeThresholdField.maxValue ?? '' })}
            error={fieldError('dedupe.threshold')}
          >
            {(c) => (
              <Input
                {...c}
                type="number"
                inputMode="numeric"
                min={dedupeThresholdField.minValue ?? undefined}
                max={dedupeThresholdField.maxValue ?? undefined}
                {...form.register('dedupe.threshold', { valueAsNumber: true })}
                disabled={readOnly}
              />
            )}
          </Field>
        </div>
      </SideSection>

      <SideSection title={t('catalog.settings.barcode.title')} intro={t('catalog.settings.barcode.description')}>
        <Field
          label={t('catalog.settings.barcode.symbology')}
          hint={t('catalog.settings.barcode.symbology_hint')}
          error={fieldError('barcode.symbology')}
          className="max-w-xs"
        >
          {(c) => (
            <select {...c} className={SELECT_CLASS} {...form.register('barcode.symbology')} disabled={readOnly}>
              {BARCODE_SYMBOLOGIES.map((symbology) => (
                <option key={symbology} value={symbology}>
                  {SYMBOLOGY_NAMES[symbology]}
                </option>
              ))}
            </select>
          )}
        </Field>
        <BarcodePatternsEditor form={form} readOnly={readOnly} />
      </SideSection>

      <SideSection title={t('catalog.settings.labels.title')} intro={t('catalog.settings.labels.description')}>
        <LabelProfilesEditor form={form} readOnly={readOnly} />
      </SideSection>

      <SideSection title={t('catalog.settings.sru.title')} intro={t('catalog.settings.sru.description')}>
        <SruServersEditor form={form} readOnly={readOnly} />
        <div className="grid gap-3 border-t pt-4">
          <CheckField
            label={t('catalog.settings.sru.allow_private')}
            hint={t('catalog.settings.sru.allow_private_hint')}
            {...form.register('sru.allowPrivateHosts')}
            disabled={readOnly || !superAdmin}
          />
          {!superAdmin && <p className="pl-6 text-xs font-semibold text-muted-foreground">{t('catalog.settings.sru.allow_private_super_only')}</p>}
        </div>
      </SideSection>

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
                form.reset(catalogFormValues(newer));
                setNewer(null);
              }}
            >
              {t('catalog.settings.load_newer')}
            </Button>
          }
        >
          {t('catalog.settings.changed_elsewhere')}
        </Notice>
      )}
      <SettingsFooter canManage={canManage} busy={isSubmitting} outcome={outcome} problem={problem} rootError={errors.root?.['server']?.message} />
    </form>
  );
}

/** `/admin/settings/catalog`. */
export function CatalogSettingsScreen() {
  return (
    <SettingsPage>
      <SettingsLoader group="catalog">{(view, canManage) => <CatalogSettingsForm initial={view} canManage={canManage} />}</SettingsLoader>
    </SettingsPage>
  );
}
