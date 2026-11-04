import type { TwoFactorVerifyResponse } from '@altis/shared/api/auth';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { SignInFrame, useSignInSearch } from './login';
import { CancelSignIn, SecondFactorForm } from './two-factor';

/**
 * The re-enrolment step, `/admin/login/recovery` (spec §7.1; decision D15; Task 28). A session in stage `recovery`
 * (`totp_reenroll`, e.g. after a restore) passes only with a recovery code, which moves it to the forced enrolment
 * (`/admin/login/setup-2fa`). No remember-me here: the choice is not carried across the enrolment (D36).
 */
export function RecoveryScreen() {
  const t = useT();
  const search = useSignInSearch();
  const send = (value: string): Promise<TwoFactorVerifyResponse> => api<TwoFactorVerifyResponse>('POST', 'auth/2fa/verify', { recoveryCode: value });
  return (
    <SignInFrame title={t('login.recovery.title')} description={t('login.recovery.description')}>
      <SecondFactorForm mode="recovery" search={search} submitLabel={t('login.recovery.submit')} send={send} />
      <CancelSignIn search={search} />
    </SignInFrame>
  );
}
