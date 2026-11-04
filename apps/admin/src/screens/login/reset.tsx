import { PasswordResetBody } from '@altis/shared/api/auth';
import { passwordField } from '@altis/shared/api/common';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link, useNavigate, useRouter } from '@tanstack/react-router';
import { useEffect, useId, useLayoutEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Field, ProblemAlert, RootError, describedBy } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useT } from '@/i18n';
import { ApiError, api } from '@/lib/api';
import { FORM_PARSE, applyServerErrors, hasFieldErrors, passwordWeaknessKey } from '@/lib/form-errors';
import { loginHref } from '@/lib/sign-in';
import { SignInFrame, signInLinkClass } from './login';

/**
 * The reset link, `/admin/reset-password#token=<token>` (spec §7.1 "Reset sandi"; Task 28). The token travels in the
 * fragment, which no request carries; the page reads it as it first renders and drops the fragment from the address
 * bar (`history.replaceState`, through the router's own history) right after, before anything else happens, so the
 * token stays out of the history, bookmarks, screenshots and the router's location. The new password must pass the
 * policy on the server; the reset creates no session, so the page ends on the sign-in page.
 */

/** The token read from the fragment, kept while the page is open (a remount finds the fragment already gone). */
let captured: string | null = null;

/** The token of `#token=` (kept in {@link captured}), else the one read already; null without one. */
function readResetToken(): string | null {
  const match = /^#(?:.*&)?token=([^&]*)/.exec(window.location.hash);
  if (match !== null) {
    try {
      captured = decodeURIComponent(match[1] ?? '');
    } catch {
      captured = null;
    }
  }
  return captured;
}

/**
 * Drops the fragment without a history entry: through the router's history, so its location forgets the token too,
 * written to the browser at once (`flush`; the router would otherwise wait a microtask). Not during render: the
 * router's history tells the router, which must not update while a component renders.
 */
function dropFragment(history: ReturnType<typeof useRouter>['history']): void {
  if (history.location.hash !== '') {
    history.replace(`${history.location.pathname}${history.location.search}`, history.location.state);
    history.flush();
  }
  // A history that does not drive the address bar (none in the app) still must not leave the token there.
  if (window.location.hash !== '') window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`);
}

const ResetForm = z
  .strictObject({ password: passwordField, confirm: z.string() })
  .refine((v) => v.confirm === v.password, { path: ['confirm'], message: 'form.password.mismatch' });

/** "Minta tautan baru": the way out of a missing, used or expired link. */
function RequestNewLink() {
  const t = useT();
  return (
    <Link to="/admin/forgot-password" className={signInLinkClass}>
      {t('login.reset.request_new')}
    </Link>
  );
}

/** `/admin/reset-password`. */
export function ResetPasswordScreen() {
  const t = useT();
  const navigate = useNavigate();
  const router = useRouter();
  const ids = { password: useId(), confirm: useId() };
  const [token] = useState(readResetToken);
  const [problem, setProblem] = useState<unknown>(null);
  const form = useForm({ resolver: zodResolver(ResetForm, FORM_PARSE), defaultValues: { password: '', confirm: '' } });
  const { errors, isSubmitting } = form.formState;
  useLayoutEffect(() => dropFragment(router.history), [router]);
  useEffect(
    () => () => {
      captured = null;
    },
    [],
  );

  const valid = token !== null && PasswordResetBody.shape.token.safeParse(token).success;

  const submit = form.handleSubmit(async ({ password }) => {
    if (token === null) return;
    setProblem(null);
    try {
      await api('POST', 'auth/password/reset', { token, password });
      captured = null;
      await navigate({ href: loginHref({}, 'password_reset'), replace: true });
    } catch (e) {
      if (hasFieldErrors(e)) return applyServerErrors(form, e);
      if (e instanceof ApiError && e.code === 'PASSWORD_TOO_WEAK') {
        form.setError('password', { type: e.code, message: passwordWeaknessKey(e) }, { shouldFocus: true });
        return;
      }
      setProblem(e);
    }
  });

  if (!valid) {
    return (
      <SignInFrame title={t('login.reset.title')}>
        <p className="text-sm">{t('login.reset.missing')}</p>
        <p className="text-center">
          <RequestNewLink />
        </p>
      </SignInFrame>
    );
  }

  const linkDead = problem instanceof ApiError && problem.code === 'AUTH_RESET_TOKEN_INVALID';
  return (
    <SignInFrame title={t('login.reset.title')} description={t('login.reset.description')}>
      <form noValidate className="grid gap-4" onSubmit={(e) => void submit(e)}>
        <Field id={ids.password} label={t('login.reset.password')} hint={t('form.password.hint')} error={errors.password?.message}>
          <Input
            id={ids.password}
            type="password"
            autoComplete="new-password"
            autoFocus
            aria-invalid={errors.password !== undefined}
            aria-describedby={describedBy(ids.password, { hint: true, error: errors.password })}
            {...form.register('password')}
          />
        </Field>
        <Field id={ids.confirm} label={t('login.reset.confirm')} error={errors.confirm?.message}>
          <Input
            id={ids.confirm}
            type="password"
            autoComplete="new-password"
            aria-invalid={errors.confirm !== undefined}
            aria-describedby={describedBy(ids.confirm, { error: errors.confirm })}
            {...form.register('confirm')}
          />
        </Field>
        <RootError message={errors.root?.['server']?.message} />
        <ProblemAlert error={problem}>{linkDead && <RequestNewLink />}</ProblemAlert>
        <Button type="submit" className="w-full" disabled={isSubmitting}>
          {isSubmitting ? t('form.working') : t('login.reset.submit')}
        </Button>
      </form>
      <p className="text-center">
        <Link to="/admin/login" className={signInLinkClass}>
          {t('login.back')}
        </Link>
      </p>
    </SignInFrame>
  );
}
