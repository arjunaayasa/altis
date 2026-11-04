import { PasswordChangeBody } from '@altis/shared/api/auth';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useId, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Field, NoticeAlert, ProblemAlert, RootError, describedBy } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useT } from '@/i18n';
import { ApiError, api, safeNext } from '@/lib/api';
import { useDirtyGuard } from '@/lib/dirty-forms';
import { FORM_PARSE, applyServerErrors, hasFieldErrors, passwordWeaknessKey } from '@/lib/form-errors';
import { useMe } from '@/lib/me';
import { refreshMe, validateNextSearch } from '@/lib/sign-in';
import { ProfilePage, ProfileSection } from './profile';

/**
 * "Ganti kata sandi", `/admin/profile/password` (spec §7.1; Task 28): the current password and the new one, typed
 * twice. The server keeps this session and ends every other one (the one exception of §7.1). It is also the page a
 * password that must change first leads to (the route gate lets nothing else through); once changed, the user goes
 * on to where the sign-in was headed (`?next=`, through safeNext, M11), else to Beranda.
 */

const PasswordForm = PasswordChangeBody.extend({ confirm: z.string() }).refine((v) => v.confirm === v.next, {
  path: ['confirm'],
  message: 'form.password.mismatch',
});

/** `/admin/profile/password`. */
export function PasswordScreen() {
  const t = useT();
  const me = useMe();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { next: afterwards } = validateNextSearch(useSearch({ strict: false }));
  const ids = { current: useId(), next: useId(), confirm: useId() };
  const [changed, setChanged] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);
  const form = useForm({ resolver: zodResolver(PasswordForm, FORM_PARSE), defaultValues: { current: '', next: '', confirm: '' } });
  const { errors, isSubmitting, isDirty } = form.formState;
  useDirtyGuard(isDirty);
  const mustChange = me?.authenticated === true && me.mustChangePassword;

  const submit = form.handleSubmit(async ({ current, next }) => {
    setProblem(null);
    setChanged(false);
    try {
      await api('POST', 'auth/password/change', { current, next });
      form.reset();
      if (mustChange) {
        await refreshMe(queryClient);
        await navigate({ href: safeNext(afterwards ?? null) });
        return;
      }
      setChanged(true);
    } catch (e) {
      if (hasFieldErrors(e)) return applyServerErrors(form, e);
      if (e instanceof ApiError && e.code === 'AUTH_INVALID_CREDENTIALS') {
        form.resetField('current');
        form.setError('current', { type: e.code, message: 'form.password.current_wrong' }, { shouldFocus: true });
        return;
      }
      if (e instanceof ApiError && e.code === 'PASSWORD_TOO_WEAK') {
        form.setError('next', { type: e.code, message: passwordWeaknessKey(e) }, { shouldFocus: true });
        return;
      }
      setProblem(e);
    }
  });

  return (
    <ProfilePage>
      {mustChange && <NoticeAlert>{t('error.AUTH_PASSWORD_CHANGE_REQUIRED')}</NoticeAlert>}
      <ProfileSection title={t('profile.password.title')} description={t('profile.password.description')}>
        <form noValidate className="grid max-w-md gap-4" onSubmit={(e) => void submit(e)}>
          <Field id={ids.current} label={t('profile.password.current')} error={errors.current?.message}>
            <Input
              id={ids.current}
              type="password"
              autoComplete="current-password"
              aria-invalid={errors.current !== undefined}
              aria-describedby={describedBy(ids.current, { error: errors.current })}
              {...form.register('current')}
            />
          </Field>
          <Field id={ids.next} label={t('profile.password.next')} hint={t('form.password.hint')} error={errors.next?.message}>
            <Input
              id={ids.next}
              type="password"
              autoComplete="new-password"
              aria-invalid={errors.next !== undefined}
              aria-describedby={describedBy(ids.next, { hint: true, error: errors.next })}
              {...form.register('next')}
            />
          </Field>
          <Field id={ids.confirm} label={t('profile.password.confirm')} error={errors.confirm?.message}>
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
          <ProblemAlert error={problem} />
          {changed && <NoticeAlert tone="success">{t('profile.password.changed')}</NoticeAlert>}
          <div>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? t('form.working') : t('profile.password.submit')}
            </Button>
          </div>
        </form>
      </ProfileSection>
    </ProfilePage>
  );
}
