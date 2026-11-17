import { TwoFactorDisableBody, totpCodeField, type RecoveryCodesResponse } from '@altis/shared/api/auth';
import { passwordField } from '@altis/shared/api/common';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Field, NoticeAlert, ProblemAlert, RootError, describedBy } from '@/components/form-field';
import { SideSection, StatusText } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useT } from '@/i18n';
import { ApiError, api } from '@/lib/api';
import { useDirtyGuard } from '@/lib/dirty-forms';
import { FORM_PARSE, applyServerErrors, hasFieldErrors } from '@/lib/form-errors';
import { useMe } from '@/lib/me';
import { holdMe } from '@/lib/sign-in';
import { RecoveryCodes, SignInAgainButton, TwoFactorEnrolment, useEnabled } from '@/screens/login/setup-2fa';
import { ProfilePage } from './profile';

/**
 * "Verifikasi dua langkah" of Profil saya, `/admin/profile/2fa` (spec §7.1; Task 28).
 *
 * - Off: the enrolment (QR code and the secret as text, then a code). Enabling answers the 10 recovery codes, shown
 *   once, and ends every session, this one included (S11, D22): the page ends with "Masuk lagi".
 * - On: new recovery codes (`POST auth/2fa/recovery-codes`, behind the reauth dialog), shown once; and turning 2FA off
 *   with the password and a code, which ends every session likewise. When 2FA is required for the account (its own
 *   flag or a role), there is nothing to turn off.
 *
 * Codes live in component state only: leaving the page drops them, and nothing shows them again.
 */

const DisableForm = TwoFactorDisableBody.extend({
  password: passwordField,
  code: z.string().transform((v) => v.replace(/[\s-]/g, '')).pipe(totpCodeField),
});

/** `/admin/profile/2fa`. */
export function ProfileTwoFactorScreen() {
  const t = useT();
  const me = useMe();
  const [enabledCodes, enabled] = useEnabled();
  const [disabled, setDisabled] = useState(false);
  const user = me?.authenticated === true ? me.user : null;
  if (user === null) return null;

  if (enabledCodes !== null || disabled) {
    return (
      <ProfilePage>
        <SideSection title={t('profile.2fa.title')}>
          {enabledCodes !== null && <RecoveryCodes codes={enabledCodes} />}
          <NoticeAlert>{t(enabledCodes !== null ? 'twofa.signed_out' : 'profile.2fa.disabled')}</NoticeAlert>
          <div>
            <SignInAgainButton notice={enabledCodes !== null ? '2fa_enabled' : '2fa_disabled'} />
          </div>
        </SideSection>
      </ProfilePage>
    );
  }

  return (
    <ProfilePage>
      <SideSection title={t('profile.2fa.title')}>
        <p className="text-sm">
          {user.totpEnabled ? <StatusText tone="ok">{t('profile.2fa.on')}</StatusText> : <span>{t('profile.2fa.off')}</span>}
        </p>
        {!user.totpEnabled && (
          <>
            <p className="text-sm text-muted-foreground">{t('profile.2fa.enable_note')}</p>
            <TwoFactorEnrolment onEnabled={enabled} />
          </>
        )}
      </SideSection>
      {user.totpEnabled && (
        <>
          <NewRecoveryCodes />
          <SideSection title={t('profile.2fa.disable_title')} intro={user.mfaRequired ? undefined : t('profile.2fa.disable_description')}>
            {user.mfaRequired ? <p className="text-sm">{t('profile.2fa.required')}</p> : <DisableTwoFactor onDisabled={() => setDisabled(true)} />}
          </SideSection>
        </>
      )}
    </ProfilePage>
  );
}

/**
 * New recovery codes: the reauth dialog first (the API client opens it on 401 AUTH_REAUTH_REQUIRED), then the codes.
 * From the request on (its answer may be the first to come from a newer release) until "Selesai", the page counts as
 * a form being filled, so it is not reloaded under the codes (the old ones are already revoked).
 */
function NewRecoveryCodes() {
  const t = useT();
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);
  useDirtyGuard(busy || codes !== null);

  const create = async (): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      setCodes((await api<RecoveryCodesResponse>('POST', 'auth/2fa/recovery-codes')).codes);
    } catch (e) {
      // Closing the reauth dialog cancels the action: nothing to report.
      if (!(e instanceof ApiError && e.code === 'AUTH_REAUTH_REQUIRED')) setProblem(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SideSection title={t('profile.2fa.codes_title')} intro={codes === null ? t('profile.2fa.codes_description') : undefined}>
      {codes === null ? (
        <>
          <ProblemAlert error={problem} />
          <div>
            <Button type="button" variant="outline" onClick={() => void create()} disabled={busy}>
              {busy ? t('form.working') : t('profile.2fa.codes_submit')}
            </Button>
          </div>
        </>
      ) : (
        <>
          <RecoveryCodes codes={codes} />
          <div>
            <Button type="button" onClick={() => setCodes(null)}>
              {t('codes.done')}
            </Button>
          </div>
        </>
      )}
    </SideSection>
  );
}

/** Turning 2FA off: the password and a code (§7.1). Every session ends, this one included (S11). */
function DisableTwoFactor({ onDisabled }: { onDisabled: () => void }) {
  const t = useT();
  const queryClient = useQueryClient();
  const ids = { password: useId(), code: useId() };
  const [problem, setProblem] = useState<unknown>(null);
  const form = useForm({ resolver: zodResolver(DisableForm, FORM_PARSE), defaultValues: { password: '', code: '' } });
  const { errors, isSubmitting } = form.formState;

  const submit = form.handleSubmit(async (body) => {
    setProblem(null);
    try {
      await api('POST', 'auth/2fa/disable', body);
      holdMe(queryClient);
      onDisabled();
    } catch (e) {
      if (hasFieldErrors(e)) return applyServerErrors(form, e);
      if (e instanceof ApiError && e.code === 'AUTH_INVALID_CREDENTIALS') {
        form.resetField('password');
        form.setError('password', { type: e.code, message: 'form.password.wrong' }, { shouldFocus: true });
        return;
      }
      if (e instanceof ApiError && e.code === 'AUTH_MFA_INVALID') {
        form.resetField('code');
        form.setError('code', { type: e.code, message: 'error.AUTH_MFA_INVALID' }, { shouldFocus: true });
        return;
      }
      setProblem(e);
    }
  });

  return (
    <form noValidate className="grid max-w-md gap-4" onSubmit={(e) => void submit(e)}>
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
      <Field id={ids.code} label={t('login.2fa.code')} hint={t('login.2fa.code_hint')} error={errors.code?.message}>
        <Input
          id={ids.code}
          autoComplete="one-time-code"
          inputMode="numeric"
          maxLength={7}
          spellCheck={false}
          className="max-w-40 font-mono tracking-[0.3em]"
          aria-invalid={errors.code !== undefined}
          aria-describedby={describedBy(ids.code, { hint: true, error: errors.code })}
          {...form.register('code')}
        />
      </Field>
      <RootError message={errors.root?.['server']?.message} />
      <ProblemAlert error={problem} />
      <div>
        <Button type="submit" variant="destructive" disabled={isSubmitting}>
          {isSubmitting ? t('form.working') : t('profile.2fa.disable_submit')}
        </Button>
      </div>
    </form>
  );
}
