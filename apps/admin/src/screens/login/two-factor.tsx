import { totpCodeField, type TwoFactorVerifyResponse } from '@altis/shared/api/auth';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useId, useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Field, ProblemAlert, RootError, describedBy } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useT } from '@/i18n';
import { ApiError, api } from '@/lib/api';
import { FORM_PARSE, applyServerErrors, hasFieldErrors } from '@/lib/form-errors';
import { forgetMe, loginHref, type SignInSearch } from '@/lib/sign-in';
import { RememberField, SignInFrame, signInLinkClass, useContinue, useSignInSearch } from './login';

/**
 * The second factor of a sign-in, `/admin/login/2fa` (spec §7.1; Task 28): a code of the authenticator app, or one of
 * the recovery codes, plus "remember me" (the remember-me token is issued only once the second factor passed). The
 * form also serves the re-enrolment step (recovery.tsx).
 *
 * The fifth wrong code deletes the pre-2FA session (S10), as does its 10-minute lifetime: the server then answers 401
 * AUTH_REQUIRED, and the page sends the user back to the password step with a notice saying why.
 */

/** A code as the authenticator app shows it (the same field the server checks, D35); apps show it as `123 456`. */
const CodeForm = z.strictObject({ value: z.string().transform((v) => v.replace(/[\s-]/g, '')).pipe(totpCodeField) });

/** A recovery code as typed (the server normalizes case, spaces and dashes). */
const RecoveryForm = z.strictObject({ value: z.string().trim().min(1).max(32) });

type Mode = 'code' | 'recovery';

/**
 * The form of one second factor (`mode`): its single field, its errors, and the request `send(value)` makes. A wrong
 * code empties the field and says so there; the end of the pre-2FA session goes back to the password step.
 */
export function SecondFactorForm({
  mode,
  search,
  submitLabel,
  send,
  children,
}: {
  mode: Mode;
  search: SignInSearch;
  submitLabel: string;
  send: (value: string) => Promise<TwoFactorVerifyResponse>;
  children?: ReactNode;
}) {
  const t = useT();
  const proceed = useContinue();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const id = useId();
  const [problem, setProblem] = useState<unknown>(null);
  const form = useForm({ resolver: zodResolver(mode === 'code' ? CodeForm : RecoveryForm, FORM_PARSE), defaultValues: { value: '' } });
  const { errors, isSubmitting } = form.formState;
  const error = errors.value;

  const submit = form.handleSubmit(async ({ value }) => {
    setProblem(null);
    try {
      const res = await send(value);
      await proceed(res, { next: search.next });
    } catch (e) {
      if (hasFieldErrors(e)) return applyServerErrors(form, e);
      if (e instanceof ApiError && e.code === 'AUTH_MFA_INVALID') {
        form.resetField('value');
        form.setError('value', { type: e.code, message: 'error.AUTH_MFA_INVALID' }, { shouldFocus: true });
        return;
      }
      if (e instanceof ApiError && e.code === 'AUTH_REQUIRED') {
        forgetMe(queryClient);
        await navigate({ href: loginHref(search, '2fa_ended'), replace: true });
        return;
      }
      setProblem(e);
    }
  });

  const code = mode === 'code';
  return (
    <form noValidate className="grid gap-4" onSubmit={(e) => void submit(e)}>
      <Field
        id={id}
        label={t(code ? 'login.2fa.code' : 'login.2fa.recovery_code')}
        hint={t(code ? 'login.2fa.code_hint' : 'login.2fa.recovery_hint')}
        error={error?.message}
      >
        <Input
          id={id}
          autoFocus
          autoComplete={code ? 'one-time-code' : 'off'}
          inputMode={code ? 'numeric' : 'text'}
          autoCapitalize={code ? undefined : 'characters'}
          spellCheck={false}
          maxLength={code ? 7 : 32}
          className={code ? 'font-mono tracking-[0.3em]' : 'font-mono'}
          aria-invalid={error !== undefined}
          aria-describedby={describedBy(id, { hint: true, error })}
          {...form.register('value')}
        />
      </Field>
      {children}
      <RootError message={errors.root?.['server']?.message} />
      <ProblemAlert error={problem} />
      <Button type="submit" className="w-full" disabled={isSubmitting}>
        {isSubmitting ? t('form.working') : submitLabel}
      </Button>
    </form>
  );
}

/** "Batal": signs the half-finished sign-in out and opens the password step again. */
export function CancelSignIn({ search }: { search: SignInSearch }) {
  const t = useT();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const cancel = async (): Promise<void> => {
    try {
      await api('POST', 'auth/logout');
    } catch {
      // A pre-2FA session that already ended is signed out as well.
    }
    forgetMe(queryClient);
    await navigate({ href: loginHref({ next: search.next }) });
  };
  return (
    <p className="text-center">
      <button type="button" className={signInLinkClass} onClick={() => void cancel()}>
        {t('login.cancel')}
      </button>
    </p>
  );
}

/** `/admin/login/2fa`. */
export function TwoFactorScreen() {
  const t = useT();
  const search = useSignInSearch();
  const rememberId = useId();
  const [mode, setMode] = useState<Mode>('code');
  const [remember, setRemember] = useState(search.remember === true);

  const send = (value: string): Promise<TwoFactorVerifyResponse> =>
    api<TwoFactorVerifyResponse>('POST', 'auth/2fa/verify', mode === 'code' ? { code: value, remember } : { recoveryCode: value, remember });

  return (
    <SignInFrame title={t('login.2fa.title')} description={t('login.2fa.description')}>
      <SecondFactorForm key={mode} mode={mode} search={search} submitLabel={t('login.2fa.submit')} send={send}>
        <RememberField id={rememberId} inputProps={{ checked: remember, onChange: (e) => setRemember(e.target.checked) }} />
      </SecondFactorForm>
      <p className="text-center">
        <button type="button" className={signInLinkClass} onClick={() => setMode(mode === 'code' ? 'recovery' : 'code')}>
          {t(mode === 'code' ? 'login.2fa.use_recovery' : 'login.2fa.use_code')}
        </button>
      </p>
      <CancelSignIn search={search} />
    </SignInFrame>
  );
}
