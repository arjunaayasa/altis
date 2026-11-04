import { LoginBody, type LoginResponse } from '@altis/shared/api/auth';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { LibraryIcon } from 'lucide-react';
import { useCallback, useId, useState, type ComponentProps, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { Field, NoticeAlert, ProblemAlert, RootError, describedBy } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useT } from '@/i18n';
import { ApiError, api } from '@/lib/api';
import { FORM_PARSE, applyServerErrors, hasFieldErrors } from '@/lib/form-errors';
import { useMe } from '@/lib/me';
import { continueAt, refreshMe, validateSignInSearch, type SignInSearch } from '@/lib/sign-in';
import { cn } from '@/lib/utils';

/**
 * The sign-in page, `/admin/login` (spec §7.1, §13.3 "Login"; Task 28), and the pieces the other sign-in pages share.
 * Signing in sends `LoginBody`; the answer's stage decides the next page (lib/sign-in.ts `continueAt`): the 2FA step,
 * the forced enrolment, the re-enrolment, the password change, or `safeNext(next)` (M11). A refused attempt clears the
 * password and says why (a 429 with how long to wait); the wording never tells whether the account exists.
 */

/** The query of the sign-in page, as its route validated it. */
export function useSignInSearch(): SignInSearch {
  return validateSignInSearch(useSearch({ strict: false }));
}

/** Moves a session on once a sign-in step answered: `auth/me` afresh (the new session and its CSRF token), then on. */
export function useContinue(): (res: Pick<LoginResponse, 'stage' | 'mustChangePassword'>, search: SignInSearch) => Promise<void> {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return useCallback(
    async (res, search) => {
      await refreshMe(queryClient);
      await navigate({ href: continueAt(res, search) });
    },
    [queryClient, navigate],
  );
}

/** The frame of every sign-in page: the library's name, then a card with the page's title and content. */
export function SignInFrame({ title, description, wide = false, children }: { title: string; description?: string; wide?: boolean; children: ReactNode }) {
  const me = useMe();
  return (
    <main className="flex min-h-dvh items-start justify-center bg-muted/40 px-4 py-10 sm:items-center">
      <div className={cn('w-full', wide ? 'max-w-lg' : 'max-w-sm')}>
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <LibraryIcon className="size-8 text-primary" aria-hidden="true" />
          <p className="text-sm font-medium text-muted-foreground">{me?.library.name ?? 'ALTIS'}</p>
        </div>
        <section className="flex flex-col gap-5 rounded-lg border bg-card p-6 text-card-foreground shadow-sm">
          <header className="flex flex-col gap-1">
            <h1 className="text-xl font-semibold">{title}</h1>
            {description !== undefined && <p className="text-sm text-muted-foreground">{description}</p>}
          </header>
          {children}
        </section>
      </div>
    </main>
  );
}

/** A link in the style of the sign-in pages. */
export const signInLinkClass = 'text-sm text-primary underline-offset-4 hover:underline focus-visible:underline';

/** The remember-me checkbox with its warning (the password step and the 2FA step). */
export function RememberField({ id, inputProps }: { id: string; inputProps: ComponentProps<'input'> }) {
  const t = useT();
  return (
    <div className="flex items-start gap-2">
      <input id={id} type="checkbox" className="mt-0.5 size-4 shrink-0 accent-primary" aria-describedby={`${id}-hint`} {...inputProps} />
      <div className="grid gap-1">
        <Label htmlFor={id} className="leading-snug font-normal">
          {t('login.remember')}
        </Label>
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {t('login.remember_hint')}
        </p>
      </div>
    </div>
  );
}

/** `/admin/login`. */
export function LoginScreen() {
  const t = useT();
  const search = useSignInSearch();
  const proceed = useContinue();
  const [problem, setProblem] = useState<unknown>(null);
  const ids = { username: useId(), password: useId(), remember: useId() };
  const form = useForm({
    resolver: zodResolver(LoginBody, FORM_PARSE),
    defaultValues: { username: '', password: '', remember: false },
  });
  const { errors, isSubmitting } = form.formState;

  const submit = form.handleSubmit(async (body) => {
    setProblem(null);
    try {
      const res = await api<LoginResponse>('POST', 'auth/login', body);
      await proceed(res, { ...search, remember: body.remember === true ? true : undefined });
    } catch (e) {
      if (hasFieldErrors(e)) return applyServerErrors(form, e);
      if (e instanceof ApiError && e.code === 'AUTH_INVALID_CREDENTIALS') {
        form.resetField('password');
        form.setFocus('password');
      }
      setProblem(e);
    }
  });

  return (
    <SignInFrame title={t('login.title')} description={t('login.subtitle')}>
      {search.notice !== undefined && <NoticeAlert>{t(`login.notice.${search.notice}`)}</NoticeAlert>}
      <form noValidate className="grid gap-4" onSubmit={(e) => void submit(e)}>
        <Field id={ids.username} label={t('login.username')} error={errors.username?.message}>
          <Input
            id={ids.username}
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            autoFocus
            aria-invalid={errors.username !== undefined}
            aria-describedby={describedBy(ids.username, { error: errors.username })}
            {...form.register('username')}
          />
        </Field>
        <Field id={ids.password} label={t('login.password')} error={errors.password?.message}>
          <Input
            id={ids.password}
            type="password"
            autoComplete="current-password"
            aria-invalid={errors.password !== undefined}
            aria-describedby={describedBy(ids.password, { error: errors.password })}
            {...form.register('password')}
          />
        </Field>
        <RememberField id={ids.remember} inputProps={form.register('remember')} />
        <RootError message={errors.root?.['server']?.message} />
        <ProblemAlert error={problem} />
        <Button type="submit" className="w-full" disabled={isSubmitting}>
          {isSubmitting ? t('form.working') : t('login.submit')}
        </Button>
      </form>
      <p className="text-center">
        <Link to="/admin/forgot-password" className={signInLinkClass}>
          {t('login.forgot_link')}
        </Link>
      </p>
    </SignInFrame>
  );
}
