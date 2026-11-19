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
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Field, NoticeAlert, ProblemAlert, RefetchProblem, RootError, SELECT_CLASS, TEXTAREA_CLASS } from '@/components/form-field';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Card, ErrorState, FormBar, LinkTabs, LoadingState, PageHead, SETTING_BLOCK, SaveBar, SettingRowsScope, useSettingRows } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useT, type AdminKey } from '@/i18n';
import { holds } from '@/lib/access';
import { api } from '@/lib/api';
import { useDirtyGuard } from '@/lib/dirty-forms';
import { useUnsavedNavigationQuestion } from '@/lib/dirty-navigation';
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
 * - A group is drawn as cards ({@link SettingsSection}), one setting per row: its name and a sentence on the left, its
 *   control on the right. Its forms share one bar that stays at the bottom of the window ({@link SettingsPage}):
 *   "Simpan" saves every form of the group that holds changes (all of them when none does, so each says that nothing
 *   changed), "Buang" puts back what was loaded. Enter in a field still saves that field's own form.
 * - Going to another group, or anywhere else in the admin, while a form holds unsaved changes asks first
 *   (lib/dirty-navigation.ts); closing the tab is the browser's own question.
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
  // ---- Komunitas (circulation core) ----
  { to: '/admin/settings/circulation', labelKey: 'settings.tab.circulation' },
  // ---- Komunitas K2 (visits, privacy) ----
  { to: '/admin/settings/kunjungan', labelKey: 'visits.settings.tab' },
  { to: '/admin/settings/privasi', labelKey: 'visits.settings.privacy_tab' },
];

/** One form of the page, as the page's save bar knows it. */
interface SettingsFormHandle {
  dirty: boolean;
  busy: boolean;
  /** Submits the form (its own checks, its own `PUT`). */
  save(): void;
  /** Puts back what was loaded. */
  discard(): void;
}

/** The forms of the settings page being shown; null outside a {@link SettingsPage} (a form then keeps its own button). */
const SettingsForms = createContext<{ register(id: string, form: SettingsFormHandle | null): void } | null>(null);

/**
 * The frame of the settings pages: the page head, the links between the groups (a list down the left on a wide
 * screen, one line of links under the head on a narrow one; the current group marked), the group's cards, and one
 * bar at the bottom of the window for every form of the group (see the top of this file).
 */
export function SettingsPage({ children }: { children: ReactNode }) {
  const t = useT();
  const [forms, setForms] = useState<ReadonlyMap<string, SettingsFormHandle>>(new Map());
  const register = useCallback((id: string, form: SettingsFormHandle | null) => {
    setForms((prev) => {
      const next = new Map(prev);
      if (form === null) next.delete(id);
      else next.set(id, form);
      return next;
    });
  }, []);
  const scope = useMemo(() => ({ register }), [register]);
  const question = useUnsavedNavigationQuestion();
  const all = [...forms.values()];
  const dirty = all.filter((f) => f.dirty);
  const busy = all.some((f) => f.busy);
  return (
    <div className="grid gap-4">
      <PageHead title={t('nav.settings')} intro={t('settings.intro')} />
      <div className="grid items-start gap-4 lg:grid-cols-[200px_minmax(0,1fr)] lg:gap-6">
        <LinkTabs side label={t('settings.sections')} items={SECTIONS.map((section) => ({ to: section.to, label: t(section.labelKey) }))} />
        <div className="grid max-w-4xl min-w-0 gap-4">
          <SettingsForms.Provider value={scope}>{children}</SettingsForms.Provider>
        </div>
      </div>
      {all.length > 0 && (
        <SaveBar message={dirty.length > 0 ? t('settings.unsaved') : undefined}>
          <Button type="button" variant="ghost" disabled={busy || dirty.length === 0} onClick={() => dirty.forEach((f) => f.discard())}>
            {t('settings.discard')}
          </Button>
          <Button type="button" disabled={busy} onClick={() => (dirty.length > 0 ? dirty : all).forEach((f) => f.save())}>
            {t(busy ? 'form.saving' : 'form.save')}
          </Button>
        </SaveBar>
      )}
      <ConfirmDialog
        open={question !== null}
        destructive
        title={t('settings.unsaved.title')}
        description={t('settings.unsaved.body')}
        confirmLabel={t('settings.unsaved.leave')}
        onConfirm={async () => question?.leave()}
        onClose={() => question?.stay()}
      />
    </div>
  );
}

/**
 * A titled card of a settings page: its title and a sentence in the head, then its settings, one row each (a `Field`
 * or a `CheckField` drawn inside is a row; anything else takes {@link SETTING_BLOCK} for the same rule and sides).
 */
export function SettingsSection({ title, intro, aside, children }: { title: string; intro?: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <Card title={title} description={intro} aside={aside}>
      {/* The first row's rule lies on the head's own. */}
      <div data-slot="settings-rows" className="-mt-px grid min-w-0">
        <SettingRowsScope>{children}</SettingRowsScope>
      </div>
    </Card>
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
    if (query.isError) return <ErrorState title={t('settings.load_failed')} error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} />;
    return <LoadingState />;
  }
  const canManage = holds(me, 'system.settings.manage');
  return (
    <>
      <RefetchProblem query={query} />
      {!canManage && <NoticeAlert>{t('settings.read_only')}</NoticeAlert>}
      {children(query.data, canManage)}
    </>
  );
}

/** What the last save of a form did. */
export type SaveOutcome = 'saved' | 'unchanged' | null;

/**
 * The end of a settings form: its errors and the outcome of its last save, in the form's card. Inside a
 * {@link SettingsPage} the form is saved from the page's bar, which this registers the form with (`dirty`, and
 * `onDiscard` to put back what was loaded); anywhere else it keeps a save button of its own. `rootError` is the
 * form's `root.server` message key.
 */
export function SettingsFooter({
  canManage,
  busy,
  dirty,
  onDiscard,
  outcome,
  problem,
  rootError,
  note,
}: {
  canManage: boolean;
  busy: boolean;
  dirty: boolean;
  onDiscard(): void;
  outcome: SaveOutcome;
  problem: unknown;
  rootError: string | undefined;
  note?: string;
}) {
  const t = useT();
  const id = useId();
  const page = useContext(SettingsForms);
  // Inside a card it is one more block of the card; after the cards of a form it stands on its own.
  const inCard = useSettingRows();
  const marker = useRef<HTMLSpanElement>(null);
  const discard = useRef(onDiscard);
  discard.current = onDiscard;
  const register = page?.register;
  useEffect(() => {
    if (register === undefined || !canManage) return undefined;
    register(id, {
      dirty,
      busy,
      save: () => marker.current?.closest('form')?.requestSubmit(),
      discard: () => discard.current(),
    });
    return () => register(id, null);
  }, [register, id, canManage, dirty, busy]);
  const said = rootError !== undefined || (problem !== null && problem !== undefined) || outcome !== null || (canManage && (note !== undefined || page === null));
  return (
    <>
      <span ref={marker} hidden />
      {said && (
        <div className={inCard ? SETTING_BLOCK : 'grid min-w-0 gap-3'} data-slot="settings-outcome">
          <RootError message={rootError} />
          <ProblemAlert error={problem} />
          {outcome === 'saved' && <NoticeAlert tone="success">{t('form.saved')}</NoticeAlert>}
          {outcome === 'unchanged' && <NoticeAlert>{t('settings.unchanged')}</NoticeAlert>}
          {canManage && page !== null && note !== undefined && <p className="text-meta text-muted-foreground">{note}</p>}
          {canManage && page === null && (
            <FormBar className="border-t-0 pt-0">
              <Button type="submit" disabled={busy}>
                {t(busy ? 'form.saving' : 'form.save')}
              </Button>
              {note !== undefined && <p className="text-xs text-muted-foreground">{note}</p>}
            </FormBar>
          )}
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
    <SettingsSection title={t('settings.tab.library')} intro={t('settings.library.description')}>
      <form noValidate className="grid" onSubmit={(e) => void submit(e)} onChange={() => setOutcome(null)}>
        <Field label={t('settings.library.name')} error={errors.name}>
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
        <Field wide label={t('settings.library.address')} error={errors.address}>
          {(c) => <textarea {...c} className={TEXTAREA_CLASS} maxLength={1000} {...form.register('address')} disabled={readOnly} />}
        </Field>
        <Field label={t('settings.library.timezone')} hint={t('branches.field.timezone_hint')} error={errors.timezone}>
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
        <SettingsFooter
          canManage={canManage}
          busy={isSubmitting}
          dirty={isDirty}
          onDiscard={() => {
            form.reset();
            setOutcome(null);
            setProblem(null);
          }}
          outcome={outcome}
          problem={problem}
          rootError={errors.root?.['server']?.message}
        />
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
