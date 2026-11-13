import { LOCALES } from '@altis/shared';
import { localeField, timezoneField } from '@altis/shared/api/common';
import {
  LIBRARY_TYPES,
  LibrarySettingsBody,
  type LibrarySettings,
  type SettingsGroupName,
  type SettingsPutResponse,
  type SettingsView,
} from '@altis/shared/api/settings';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useId, useMemo, useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Field, NoticeAlert, ProblemAlert, RefetchProblem, RootError, SELECT_CLASS, TEXTAREA_CLASS } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useT, type AdminKey } from '@/i18n';
import { holds } from '@/lib/access';
import { api } from '@/lib/api';
import { useDirtyGuard } from '@/lib/dirty-forms';
import { FORM_PARSE, applyServerErrors, hasFieldErrors } from '@/lib/form-errors';
import { useApiQuery, useMe } from '@/lib/me';
import { refreshMe } from '@/lib/sign-in';

/**
 * Pengaturan (spec §13.3, §6.5; decisions D26, D41): `/admin/settings` (the library's profile), and the frame its
 * other pages share (email.tsx, security.tsx, opac.tsx, and Phase 2's catalog.tsx): the title, the links between the
 * groups, and the load/save cycle of a group.
 *
 * - Each group is read with `GET settings/<group>` and saved with its own `PUT settings/<group>`, which answers only
 *   the keys that changed ({@link SettingsPutResponse}), so after a save the group is read again and the form starts
 *   over from what the server now stores ({@link saveSettings}).
 * - A form sends only the fields that differ from what was loaded (a key left out keeps its value, `null` clears a
 *   text back to its default).
 * - Reading needs `system.settings.read`; without `system.settings.manage` the fields are shown disabled and there
 *   is no save button (the server refuses the PUT anyway). `PUT settings/security` asks for the password first: the
 *   API client opens the reauth dialog.
 */

const SECTIONS: readonly { to: string; labelKey: AdminKey }[] = [
  { to: '/admin/settings', labelKey: 'settings.tab.library' },
  { to: '/admin/settings/email', labelKey: 'settings.tab.email' },
  { to: '/admin/settings/security', labelKey: 'settings.tab.security' },
  { to: '/admin/settings/opac', labelKey: 'settings.tab.opac' },
  // ---- Phase 2 (catalog): Task 28 ----
  { to: '/admin/settings/catalog', labelKey: 'catalog.settings.tab' },
  // ---- Komunitas K1 (settings) ----
  { to: '/admin/settings/accreditation', labelKey: 'settings.tab.accreditation' },
];

/** The frame of the settings pages: the title and the links between the groups. */
export function SettingsPage({ children }: { children: ReactNode }) {
  const t = useT();
  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold">{t('nav.settings')}</h1>
        <nav aria-label={t('settings.sections')}>
          <ul className="flex flex-wrap gap-1 border-b">
            {SECTIONS.map((section) => (
              <li key={section.to}>
                <Link
                  to={section.to}
                  activeOptions={{ exact: true }}
                  className="-mb-px block border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground hover:text-foreground data-[status=active]:border-primary data-[status=active]:font-medium data-[status=active]:text-foreground"
                >
                  {t(section.labelKey)}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </header>
      {children}
    </div>
  );
}

/** A titled part of a settings page. */
export function SettingsSection({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-4 rounded-lg border bg-card p-5 text-card-foreground">
      <header className="flex flex-col gap-1">
        <h2 id={id} className="text-lg font-semibold">
          {title}
        </h2>
        {description !== undefined && <p className="text-sm text-muted-foreground">{description}</p>}
      </header>
      {children}
    </section>
  );
}

/** The query key of a group's `GET settings/<group>`. */
export const settingsKey = (group: SettingsGroupName) => ['settings', group] as const;

/**
 * `PUT settings/<group>` with `body`, then the group read afresh: the PUT answers only the names of the settings that
 * changed, never their values.
 */
export async function saveSettings<G extends SettingsGroupName>(
  queryClient: QueryClient,
  group: G,
  body: unknown,
): Promise<{ changed: string[]; view: SettingsView[G] }> {
  const { changed } = await api<SettingsPutResponse>('PUT', `settings/${group}`, body);
  const view = await queryClient.fetchQuery({
    queryKey: settingsKey(group),
    queryFn: () => api<SettingsView[G]>('GET', `settings/${group}`),
    staleTime: 0,
  });
  return { changed, view };
}

/**
 * Loads a group and renders `children` with it once it came: the form, and whether the signed-in user may change
 * it. While loading, a status line; a read that failed before any data came, its message and a retry. Once the data
 * is there it stays: a failed background refetch only adds a notice above the form (RefetchProblem).
 */
export function SettingsLoader<G extends SettingsGroupName>({
  group,
  children,
}: {
  group: G;
  children: (view: SettingsView[G], canManage: boolean) => ReactNode;
}) {
  const t = useT();
  const me = useMe();
  const query = useApiQuery<SettingsView[G]>({ queryKey: [...settingsKey(group)], path: `settings/${group}` });
  // The data wins over an error: a failed background refetch keeps the form and what was typed (RefetchProblem).
  if (query.data === undefined) {
    if (query.isError) {
      return (
        <ProblemAlert error={query.error}>
          <Button variant="outline" size="sm" className="mt-2" onClick={() => void query.refetch()}>
            {t('table.retry')}
          </Button>
        </ProblemAlert>
      );
    }
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {t('shell.loading')}
      </p>
    );
  }
  const canManage = holds(me, 'system.settings.manage');
  return (
    <>
      <RefetchProblem query={query} />
      {!canManage && <p className="rounded-md border bg-muted/50 px-3 py-2 text-sm">{t('settings.read_only')}</p>}
      {children(query.data, canManage)}
    </>
  );
}

/** What the last save of a form did. */
export type SaveOutcome = 'saved' | 'unchanged' | null;

/**
 * The bottom of a settings form: its errors and outcome, and the save button (only for a user who may save).
 * `rootError` is the form's `root.server` message key.
 */
export function SettingsFooter({
  canManage,
  busy,
  outcome,
  problem,
  rootError,
  note,
}: {
  canManage: boolean;
  busy: boolean;
  outcome: SaveOutcome;
  problem: unknown;
  rootError: string | undefined;
  note?: string;
}) {
  const t = useT();
  return (
    <>
      <RootError message={rootError} />
      <ProblemAlert error={problem} />
      {outcome === 'saved' && <NoticeAlert tone="success">{t('form.saved')}</NoticeAlert>}
      {outcome === 'unchanged' && <NoticeAlert>{t('settings.unchanged')}</NoticeAlert>}
      {canManage && (
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={busy}>
            {t(busy ? 'form.saving' : 'form.save')}
          </Button>
          {note !== undefined && <p className="text-xs text-muted-foreground">{note}</p>}
        </div>
      )}
    </>
  );
}

/**
 * A whole number within the bounds of `bound` (a shared body schema's `z.int().min().max()`, so the form checks what
 * the server checks); any failure, an empty input included, reads `form.number_range` (the field's hint shows the
 * range).
 */
export function wholeNumberIn(bound: { minValue: number | null; maxValue: number | null }) {
  const error = 'form.number_range' satisfies AdminKey;
  return z
    .int({ error })
    .min(bound.minValue ?? Number.MIN_SAFE_INTEGER, { error })
    .max(bound.maxValue ?? Number.MAX_SAFE_INTEGER, { error });
}

/** A text that is blank (or only spaces) is sent as null: the setting goes back to its default. */
export function blankToNull(value: string): string | null {
  return value.trim() === '' ? null : value;
}

/** The IANA zones this browser knows, for the time zone suggestions (empty where `Intl` cannot list them). */
function timeZones(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return [];
  }
}

// ---- Profil perpustakaan ---------------------------------------------------------------------------------------

/** `name` as the server checks it; `type` with `''` for "not chosen" (sent as null); the address as typed. */
const LibraryForm = z.strictObject({
  name: LibrarySettingsBody.shape.name.unwrap(),
  type: z.union([z.literal(''), z.enum(LIBRARY_TYPES)]),
  address: z.string().max(1000),
  timezone: timezoneField,
  locale: localeField,
});

type LibraryInput = z.input<typeof LibraryForm>;
type LibraryOutput = z.output<typeof LibraryForm>;

function libraryValues(view: LibrarySettings): LibraryInput {
  return { name: view.name, type: view.type ?? '', address: view.address ?? '', timezone: view.timezone, locale: view.locale };
}

/** The PUT body: only what differs from `view`. */
function libraryBody(values: LibraryOutput, view: LibrarySettings): LibrarySettingsBody {
  const body: LibrarySettingsBody = {};
  if (values.name !== view.name) body.name = values.name;
  const type = values.type === '' ? null : values.type;
  if (type !== view.type) body.type = type;
  const address = blankToNull(values.address);
  if (address !== view.address) body.address = address;
  if (values.timezone !== view.timezone) body.timezone = values.timezone;
  if (values.locale !== view.locale) body.locale = values.locale;
  return body;
}

function LibrarySettingsForm({ initial, canManage }: { initial: LibrarySettings; canManage: boolean }) {
  const t = useT();
  const queryClient = useQueryClient();
  const zonesId = useId();
  const zones = useMemo(timeZones, []);
  const [view, setView] = useState(initial);
  const [outcome, setOutcome] = useState<SaveOutcome>(null);
  const [problem, setProblem] = useState<unknown>(null);
  const form = useForm<LibraryInput, unknown, LibraryOutput>({ resolver: zodResolver(LibraryForm, FORM_PARSE), defaultValues: libraryValues(initial) });
  const { errors, isDirty, isSubmitting } = form.formState;
  useDirtyGuard(isDirty);
  const readOnly = !canManage;

  const submit = form.handleSubmit(async (values) => {
    setProblem(null);
    setOutcome(null);
    const body = libraryBody(values, view);
    if (Object.keys(body).length === 0) {
      form.reset(libraryValues(view));
      setOutcome('unchanged');
      return;
    }
    try {
      const saved = await saveSettings(queryClient, 'library', body);
      setView(saved.view);
      form.reset(libraryValues(saved.view));
      setOutcome('saved');
      // The shell shows the library's name, and its language for users without one of their own.
      if (body.name !== undefined || body.locale !== undefined) await refreshMe(queryClient);
    } catch (e) {
      if (hasFieldErrors(e)) applyServerErrors(form, e);
      else setProblem(e);
    }
  });

  return (
    <SettingsSection title={t('settings.tab.library')} description={t('settings.library.description')}>
      <form noValidate className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => void submit(e)} onChange={() => setOutcome(null)}>
        <Field label={t('settings.library.name')} error={errors.name} className="sm:col-span-2">
          {(c) => <Input {...c} autoComplete="organization" maxLength={191} {...form.register('name')} disabled={readOnly} />}
        </Field>
        <Field label={t('settings.library.type')} error={errors.type}>
          {(c) => (
            <select {...c} className={SELECT_CLASS} {...form.register('type')} disabled={readOnly}>
              <option value="">{t('settings.library.type.none')}</option>
              {LIBRARY_TYPES.map((type) => (
                <option key={type} value={type}>
                  {t(`settings.library.type.${type}`)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label={t('settings.library.locale')} hint={t('settings.library.locale_hint')} error={errors.locale}>
          {(c) => (
            <select {...c} className={SELECT_CLASS} {...form.register('locale')} disabled={readOnly}>
              {LOCALES.map((locale) => (
                <option key={locale} value={locale}>
                  {t(`palette.language.${locale}`)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label={t('settings.library.address')} error={errors.address} className="sm:col-span-2">
          {(c) => <textarea {...c} className={TEXTAREA_CLASS} maxLength={1000} {...form.register('address')} disabled={readOnly} />}
        </Field>
        <Field label={t('settings.library.timezone')} hint={t('branches.field.timezone_hint')} error={errors.timezone} className="sm:col-span-2">
          {(c) => (
            <>
              <Input {...c} list={zonesId} autoComplete="off" spellCheck={false} maxLength={64} {...form.register('timezone')} disabled={readOnly} />
              <datalist id={zonesId}>
                {zones.map((zone) => (
                  <option key={zone} value={zone} />
                ))}
              </datalist>
            </>
          )}
        </Field>
        <div className="grid gap-4 sm:col-span-2">
          <SettingsFooter
            canManage={canManage}
            busy={isSubmitting}
            outcome={outcome}
            problem={problem}
            rootError={errors.root?.['server']?.message}
          />
        </div>
      </form>
    </SettingsSection>
  );
}

/** `/admin/settings`: the library's profile. */
export function LibrarySettingsScreen() {
  return (
    <SettingsPage>
      <SettingsLoader group="library">{(view, canManage) => <LibrarySettingsForm initial={view} canManage={canManage} />}</SettingsLoader>
    </SettingsPage>
  );
}
