import { LOCALES, type Locale } from '@altis/shared';
import { OPAC_ACCENTS, OpacSettingsBody, oaiAdminEmailField, type OpacSettings } from '@altis/shared/api/settings';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm, useWatch, type Control } from 'react-hook-form';
import { z } from 'zod';
import { CheckField, Field, SELECT_CLASS, TEXTAREA_CLASS } from '@/components/form-field';
import { Callout } from '@/components/layout';
import { Input } from '@/components/ui/input';
import { useT } from '@/i18n';
import { useDirtyGuard } from '@/lib/dirty-forms';
import { FORM_PARSE, applyServerErrors, hasFieldErrors } from '@/lib/form-errors';
import { SettingsFooter, SettingsLoader, SettingsPage, SettingsSection, blankToNull, saveSettings, wholeNumberIn, type SaveOutcome } from './library';

/**
 * Pengaturan → Tampilan OPAC (spec §13.3 "penampilan OPAC"; `PUT settings/opac`): the welcome text of the OPAC home
 * page in each language (blank: none) and the accent colour of its theme. The OPAC reads them through the settings
 * cache, so another process shows a change within its 30 s.
 *
 * Phase 2 (spec §13 "Pengaturan › OPAC (tambahan)", §9, §10, §12.6; plan Task 28) adds to the same form and the same
 * PUT: the search results per page, the new titles of the home page, whether search engines may index the OPAC, the
 * shelf map of the record page, and OAI-PMH (on, and its admin e-mail). Without an e-mail OAI-PMH answers 503, so the
 * form warns while it is on without one, as Diagnostik and the dashboard do. Its copy is in i18n/catalog/settings.ts.
 */

/** The longest welcome text the server keeps (the settings registry's limit, through the shared body schema). */
const WELCOME_MAX = OpacSettingsBody.shape.welcome.unwrap().shape.id.unwrap().unwrap().maxLength ?? 1000;

// ---- Phase 2 (catalog): Task 28 ----
/** The bounds of the two numbers, from the shared body schema (the settings registry's limits). */
const RESULTS_PER_PAGE = OpacSettingsBody.shape.resultsPerPage.unwrap();
const NEW_TITLES = OpacSettingsBody.shape.newTitlesCount.unwrap();
/** The longest OAI-PMH admin e-mail (the shared field's limit). */
const OAI_EMAIL_MAX = oaiAdminEmailField.maxLength ?? 191;

const OpacForm = z.strictObject({
  welcome: z.strictObject({ id: z.string().max(WELCOME_MAX), en: z.string().max(WELCOME_MAX) }),
  accent: z.enum(OPAC_ACCENTS),
  // ---- Phase 2 (catalog): Task 28 ----
  resultsPerPage: wholeNumberIn(RESULTS_PER_PAGE),
  newTitlesCount: wholeNumberIn(NEW_TITLES),
  indexable: z.boolean(),
  showShelfMap: z.boolean(),
  oai: z.strictObject({ enabled: z.boolean(), adminEmail: z.string().trim().pipe(oaiAdminEmailField) }),
});

type OpacInput = z.input<typeof OpacForm>;
type OpacValues = z.output<typeof OpacForm>;

function opacValues(view: OpacSettings): OpacInput {
  return {
    welcome: { id: view.welcome.id ?? '', en: view.welcome.en ?? '' },
    accent: view.accent,
    resultsPerPage: view.resultsPerPage,
    newTitlesCount: view.newTitlesCount,
    indexable: view.indexable,
    showShelfMap: view.showShelfMap,
    oai: { enabled: view.oai.enabled, adminEmail: view.oai.adminEmail },
  };
}

/** OAI-PMH is on without an admin e-mail: it answers 503 (spec §10), so the form says so while that is what it holds. */
function OaiWarning({ control }: { control: Control<OpacInput, unknown, OpacValues> }) {
  const t = useT();
  const [enabled, adminEmail] = useWatch({ control, name: ['oai.enabled', 'oai.adminEmail'] });
  if (!enabled || adminEmail.trim() !== '') return null;
  return (
    <Callout role="status" tone="warn" title={t('catalog.settings.opac.oai_warning')} />
  );
}

/** The PUT body: only what differs from `view`. */
function opacBody(values: OpacValues, view: OpacSettings): OpacSettingsBody {
  const body: OpacSettingsBody = {};
  const welcome: Partial<Record<Locale, string | null>> = {};
  for (const locale of LOCALES) {
    const text = blankToNull(values.welcome[locale]);
    if (text !== view.welcome[locale]) welcome[locale] = text;
  }
  if (Object.keys(welcome).length > 0) body.welcome = welcome;
  if (values.accent !== view.accent) body.accent = values.accent;
  // ---- Phase 2 (catalog): Task 28 ----
  if (values.resultsPerPage !== view.resultsPerPage) body.resultsPerPage = values.resultsPerPage;
  if (values.newTitlesCount !== view.newTitlesCount) body.newTitlesCount = values.newTitlesCount;
  if (values.indexable !== view.indexable) body.indexable = values.indexable;
  if (values.showShelfMap !== view.showShelfMap) body.showShelfMap = values.showShelfMap;
  const oai: NonNullable<OpacSettingsBody['oai']> = {};
  if (values.oai.enabled !== view.oai.enabled) oai.enabled = values.oai.enabled;
  if (values.oai.adminEmail !== view.oai.adminEmail) oai.adminEmail = values.oai.adminEmail;
  if (Object.keys(oai).length > 0) body.oai = oai;
  return body;
}

function OpacSettingsForm({ initial, canManage }: { initial: OpacSettings; canManage: boolean }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [view, setView] = useState(initial);
  const [outcome, setOutcome] = useState<SaveOutcome>(null);
  const [problem, setProblem] = useState<unknown>(null);
  const form = useForm<OpacInput, unknown, OpacValues>({ resolver: zodResolver(OpacForm, FORM_PARSE), defaultValues: opacValues(initial) });
  const { errors, isDirty, isSubmitting } = form.formState;
  useDirtyGuard(isDirty);
  const readOnly = !canManage;
  const discard = (): void => {
    form.reset();
    setOutcome(null);
    setProblem(null);
  };

  const submit = form.handleSubmit(async (values) => {
    setProblem(null);
    setOutcome(null);
    const body = opacBody(values, view);
    if (Object.keys(body).length === 0) {
      form.reset(opacValues(view));
      setOutcome('unchanged');
      return;
    }
    try {
      const saved = await saveSettings(queryClient, 'opac', body);
      setView(saved.view);
      form.reset(opacValues(saved.view));
      setOutcome('saved');
    } catch (e) {
      if (hasFieldErrors(e)) applyServerErrors(form, e);
      else setProblem(e);
    }
  });

  return (
    <form noValidate className="grid gap-4" onSubmit={(e) => void submit(e)} onChange={() => setOutcome(null)}>
      <SettingsSection title={t('settings.tab.opac')} intro={t('settings.opac.description')}>
        <Field label={t('settings.opac.accent')} hint={t('settings.opac.accent_hint')} error={errors.accent}>
          {(c) => (
            <select {...c} className={SELECT_CLASS} {...form.register('accent')} disabled={readOnly}>
              {OPAC_ACCENTS.map((accent) => (
                <option key={accent} value={accent}>
                  {t(`settings.opac.accent.${accent}`)}
                </option>
              ))}
            </select>
          )}
        </Field>
        {LOCALES.map((locale) => (
          <Field
            wide
            key={locale}
            label={t('settings.opac.welcome', { language: t(`palette.language.${locale}`) })}
            hint={t('settings.opac.welcome_hint')}
            error={errors.welcome?.[locale]}
          >
            {(c) => (
              <textarea
                {...c}
                rows={4}
                className={TEXTAREA_CLASS}
                maxLength={WELCOME_MAX}
                {...form.register(`welcome.${locale}`)}
                disabled={readOnly}
              />
            )}
          </Field>
        ))}
        {/* ---- Phase 2 (catalog): Task 28 ---- */}
      </SettingsSection>
      <SettingsSection title={t('catalog.settings.opac.search_title')}>
            <Field
              label={t('catalog.settings.opac.results_per_page')}
              hint={t('catalog.settings.opac.results_per_page_hint', { min: RESULTS_PER_PAGE.minValue ?? '', max: RESULTS_PER_PAGE.maxValue ?? '' })}
              error={errors.resultsPerPage}
            >
              {(c) => (
                <Input
                  {...c}
                  type="number"
                  inputMode="numeric"
                  min={RESULTS_PER_PAGE.minValue ?? undefined}
                  max={RESULTS_PER_PAGE.maxValue ?? undefined}
                  {...form.register('resultsPerPage', { valueAsNumber: true })}
                  disabled={readOnly}
                />
              )}
            </Field>
            <Field
              label={t('catalog.settings.opac.new_titles')}
              hint={t('catalog.settings.opac.new_titles_hint', { min: NEW_TITLES.minValue ?? '', max: NEW_TITLES.maxValue ?? '' })}
              error={errors.newTitlesCount}
            >
              {(c) => (
                <Input
                  {...c}
                  type="number"
                  inputMode="numeric"
                  min={NEW_TITLES.minValue ?? undefined}
                  max={NEW_TITLES.maxValue ?? undefined}
                  {...form.register('newTitlesCount', { valueAsNumber: true })}
                  disabled={readOnly}
                />
              )}
            </Field>
            <CheckField
              label={t('catalog.settings.opac.indexable')}
              hint={t('catalog.settings.opac.indexable_hint')}
              {...form.register('indexable')}
              disabled={readOnly}
            />
            <CheckField
              label={t('catalog.settings.opac.show_shelf_map')}
              hint={t('catalog.settings.opac.show_shelf_map_hint')}
              {...form.register('showShelfMap')}
              disabled={readOnly}
            />
      </SettingsSection>
      <SettingsSection title={t('catalog.settings.opac.oai_title')}>
            <CheckField
              label={t('catalog.settings.opac.oai_enabled')}
              hint={t('catalog.settings.opac.oai_enabled_hint', { path: '/oai' })}
              {...form.register('oai.enabled')}
              disabled={readOnly}
            />
            <Field label={t('catalog.settings.opac.oai_admin_email')} hint={t('catalog.settings.opac.oai_admin_email_hint')} error={errors.oai?.adminEmail}>
              {(c) => <Input {...c} type="email" autoComplete="email" maxLength={OAI_EMAIL_MAX} {...form.register('oai.adminEmail')} disabled={readOnly} />}
            </Field>
            <OaiWarning control={form.control} />
      </SettingsSection>
        <SettingsFooter canManage={canManage} busy={isSubmitting} dirty={isDirty} onDiscard={discard} outcome={outcome} problem={problem} rootError={errors.root?.['server']?.message} />
    </form>
  );
}

/** `/admin/settings/opac`. */
export function OpacSettingsScreen() {
  return (
    <SettingsPage>
      <SettingsLoader group="opac">{(view, canManage) => <OpacSettingsForm initial={view} canManage={canManage} />}</SettingsLoader>
    </SettingsPage>
  );
}
