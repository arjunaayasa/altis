import { PasswordForgotBody } from '@altis/shared/api/auth';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link } from '@tanstack/react-router';
import { useId, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Field, NoticeAlert, ProblemAlert, RootError, describedBy } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { FORM_PARSE, applyServerErrors, hasFieldErrors } from '@/lib/form-errors';
import { SignInFrame, signInLinkClass } from './login';

/**
 * "Lupa kata sandi", `/admin/forgot-password` (spec §7.1 "Reset sandi"; Task 28). The server answers 202 for every
 * address (429 only from its own limits), so the page says the same thing whatever the address: if it belongs to an
 * active account, the link is on its way. The mail's link opens `/admin/reset-password#token=…` (reset.tsx).
 */
export function ForgotPasswordScreen() {
  const t = useT();
  const id = useId();
  const [sent, setSent] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);
  const form = useForm({ resolver: zodResolver(PasswordForgotBody, FORM_PARSE), defaultValues: { email: '' } });
  const { errors, isSubmitting } = form.formState;

  const submit = form.handleSubmit(async (body) => {
    setProblem(null);
    try {
      await api('POST', 'auth/password/forgot', body);
      setSent(true);
    } catch (e) {
      if (hasFieldErrors(e)) return applyServerErrors(form, e);
      setProblem(e);
    }
  });

  return (
    <SignInFrame title={t('login.forgot.title')} description={sent ? undefined : t('login.forgot.description')}>
      {sent ? (
        <NoticeAlert tone="success">{t('login.forgot.sent')}</NoticeAlert>
      ) : (
        <form noValidate className="grid gap-4" onSubmit={(e) => void submit(e)}>
          <Field id={id} label={t('login.forgot.email')} hint={t('login.forgot.no_email')} error={errors.email?.message}>
            <Input
              id={id}
              type="email"
              autoComplete="email"
              autoFocus
              spellCheck={false}
              aria-invalid={errors.email !== undefined}
              aria-describedby={describedBy(id, { hint: true, error: errors.email })}
              {...form.register('email')}
            />
          </Field>
          <RootError message={errors.root?.['server']?.message} />
          <ProblemAlert error={problem} />
          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? t('form.working') : t('login.forgot.submit')}
          </Button>
        </form>
      )}
      <p className="text-center">
        <Link to="/admin/login" className={signInLinkClass}>
          {t('login.back')}
        </Link>
      </p>
    </SignInFrame>
  );
}
