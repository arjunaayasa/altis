import { LOCALES, type Locale } from '@altis/shared';
import { localeField, personNameField } from '@altis/shared/api/common';
import type { MeUser } from '@altis/shared/api/auth';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useId, useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Field, NoticeAlert, ProblemAlert, RootError, describedBy } from '@/components/form-field';
import { PageHead } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useT, type AdminKey } from '@/i18n';
import { api } from '@/lib/api';
import { useDirtyGuard } from '@/lib/dirty-forms';
import { FORM_PARSE, applyServerErrors, hasFieldErrors } from '@/lib/form-errors';
import { useMe } from '@/lib/me';
import { refreshMe } from '@/lib/sign-in';

/**
 * "Profil saya" (spec §13.3, §13.5; Task 28): `/admin/profile` (name and language), and the frame its other pages
 * share (password.tsx, two-factor.tsx, sessions.tsx): the title and the links between the sections. While the
 * password must change first, the route gate lets only the password page through, so the links are hidden there.
 */

const SECTIONS: readonly { to: string; labelKey: AdminKey }[] = [
  { to: '/admin/profile', labelKey: 'profile.tab.general' },
  { to: '/admin/profile/password', labelKey: 'profile.tab.password' },
  { to: '/admin/profile/2fa', labelKey: 'profile.tab.2fa' },
  { to: '/admin/profile/sessions', labelKey: 'profile.tab.sessions' },
];

/** The frame of the profile pages. */
export function ProfilePage({ children }: { children: ReactNode }) {
  const t = useT();
  const me = useMe();
  const mustChange = me?.authenticated === true && me.mustChangePassword;
  return (
    <div className="grid max-w-5xl gap-6">
      <div className="grid gap-4">
        <PageHead title={t('profile.title')} />
        {!mustChange && (
          <nav aria-label={t('profile.sections')}>
            <ul className="flex flex-wrap gap-x-1 border-b">
              {SECTIONS.map((section) => (
                <li key={section.to}>
                  <Link
                    to={section.to}
                    activeOptions={{ exact: true }}
                    className="-mb-px block border-b-2 border-transparent px-2.5 py-2 text-sm font-semibold text-muted-foreground hover:text-foreground data-[status=active]:border-primary data-[status=active]:text-foreground"
                  >
                    {t(section.labelKey)}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        )}
      </div>
      <div className="grid min-w-0 gap-6">{children}</div>
    </div>
  );
}

/** A titled section of a profile page. */
export function ProfileSection({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      className="grid min-w-0 gap-x-8 gap-y-4 md:grid-cols-[200px_minmax(0,1fr)] lg:grid-cols-[220px_minmax(0,1fr)] [*+&]:border-t [*+&]:pt-6"
    >
      <header className="grid content-start gap-1">
        <h2 id={id} className="text-base font-bold">
          {title}
        </h2>
        {description !== undefined && <p className="text-sm text-muted-foreground">{description}</p>}
      </header>
      <div className="grid min-w-0 content-start gap-4">{children}</div>
    </section>
  );
}

/** The form: the shared name field (D35) and the language, `''` standing for the library's (sent as null). */
const ProfileForm = z.strictObject({ name: personNameField, locale: z.union([z.literal(''), localeField]) });

const SELECT_CLASS =
  'flex h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring aria-invalid:border-destructive md:text-sm';

/** `/admin/profile`. */
export function ProfileScreen() {
  const t = useT();
  const me = useMe();
  const user = me?.authenticated === true ? me.user : null;
  if (user === null || me === undefined) return null;
  return (
    <ProfilePage>
      <ProfileSection title={t('profile.account')} description={t('profile.account_hint')}>
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
          <dt className="text-muted-foreground">{t('profile.username')}</dt>
          <dd className="font-medium break-all">{user.username}</dd>
          <dt className="text-muted-foreground">{t('profile.email')}</dt>
          <dd className="break-all">{user.email ?? t('profile.email_none')}</dd>
        </dl>
      </ProfileSection>
      <ProfileDetails user={user} libraryLocale={me.library.locale} />
    </ProfilePage>
  );
}

/** Name and language (`PATCH auth/me`); the shell follows the saved language at once. */
function ProfileDetails({ user, libraryLocale }: { user: MeUser; libraryLocale: Locale }) {
  const t = useT();
  const queryClient = useQueryClient();
  const ids = { name: useId(), locale: useId() };
  const [saved, setSaved] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);
  const defaultValues: z.input<typeof ProfileForm> = { name: user.name, locale: user.locale ?? '' };
  const form = useForm({ resolver: zodResolver(ProfileForm, FORM_PARSE), defaultValues });
  const { errors, isSubmitting, isDirty } = form.formState;
  useDirtyGuard(isDirty);

  const submit = form.handleSubmit(async ({ name, locale }) => {
    setProblem(null);
    setSaved(false);
    try {
      await api('PATCH', 'auth/me', { name, locale: locale === '' ? null : locale });
      form.reset({ name, locale });
      await refreshMe(queryClient);
      setSaved(true);
    } catch (e) {
      if (hasFieldErrors(e)) return applyServerErrors(form, e);
      setProblem(e);
    }
  });

  const language = (locale: Locale): string => t(`palette.language.${locale}`);
  return (
    <ProfileSection title={t('profile.details')}>
      <form noValidate className="grid max-w-md gap-4" onSubmit={(e) => void submit(e)} onChange={() => setSaved(false)}>
        <Field id={ids.name} label={t('profile.name')} error={errors.name?.message}>
          <Input
            id={ids.name}
            autoComplete="name"
            aria-invalid={errors.name !== undefined}
            aria-describedby={describedBy(ids.name, { error: errors.name })}
            {...form.register('name')}
          />
        </Field>
        <Field id={ids.locale} label={t('profile.locale')} error={errors.locale?.message}>
          <select
            id={ids.locale}
            className={SELECT_CLASS}
            aria-invalid={errors.locale !== undefined}
            aria-describedby={describedBy(ids.locale, { error: errors.locale })}
            {...form.register('locale')}
          >
            <option value="">{t('profile.locale_library', { language: language(libraryLocale) })}</option>
            {LOCALES.map((locale) => (
              <option key={locale} value={locale}>
                {language(locale)}
              </option>
            ))}
          </select>
        </Field>
        <RootError message={errors.root?.['server']?.message} />
        <ProblemAlert error={problem} />
        {saved && <NoticeAlert tone="success">{t('profile.saved')}</NoticeAlert>}
        <div>
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? t('form.working') : t('profile.save')}
          </Button>
        </div>
      </form>
    </ProfileSection>
  );
}
