import { totpCodeField, type RecoveryCodesResponse, type TwoFactorSetupResponse } from '@altis/shared/api/auth';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { CopyIcon, DownloadIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Field, NoticeAlert, ProblemAlert, RootError, describedBy } from '@/components/form-field';
import { QrCode } from '@/components/qr-code';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useT } from '@/i18n';
import { ApiError, api } from '@/lib/api';
import { useDirtyGuard } from '@/lib/dirty-forms';
import { FORM_PARSE, applyServerErrors, hasFieldErrors } from '@/lib/form-errors';
import { useMe } from '@/lib/me';
import { forgetMe, holdMe, loginHref, type SignInNotice } from '@/lib/sign-in';
import { SignInFrame, useSignInSearch } from './login';
import { CancelSignIn } from './two-factor';

/**
 * Enrolling 2FA (spec §7.1; Task 28): the forced enrolment of the sign-in, `/admin/login/setup-2fa` (stage
 * `mfa_setup`), and the pieces "Profil saya" reuses (screens/profile/two-factor.tsx).
 *
 * `POST auth/2fa/setup` gives a secret: the page shows its QR code (components/qr-code.tsx) and the secret as text, in
 * groups of four, to type in. A code of the app enables it (`POST auth/2fa/enable`), which answers the 10 recovery
 * codes and ends every session of the user, the current one included (S11, D22). The codes are shown once (component
 * state only: nothing keeps them; leaving the page drops them) with "copy" and "download", then "Masuk lagi" opens the
 * sign-in page.
 */

/** Copies `text`; false when the browser cannot (no Clipboard API outside https or localhost, or refused). */
async function copyText(text: string): Promise<boolean> {
  if (!('clipboard' in navigator)) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

const canCopy = (): boolean => typeof navigator !== 'undefined' && 'clipboard' in navigator;

/** A secret in groups of four characters (`ABCD EFGH …`), easier to type and to check. */
function grouped(secret: string): string {
  return secret.replace(/(.{4})(?=.)/g, '$1 ');
}

/**
 * The 10 recovery codes, shown once: a list, "copy all" (where the browser allows it) and a .txt download. While
 * they show, the page counts as a form being filled (lib/dirty-forms.ts): a newer release shows the banner instead of
 * reloading the page, which would lose codes that nothing shows again.
 */
export function RecoveryCodes({ codes }: { codes: readonly string[] }) {
  const t = useT();
  const me = useMe();
  useDirtyGuard(true);
  const headingId = useId();
  const [copied, setCopied] = useState<boolean | null>(null);
  const username = me?.authenticated === true ? me.user.username : '';
  const text = [t('codes.file_header', { library: me?.library.name ?? 'ALTIS', username }), '', ...codes, ''].join('\r\n');
  return (
    <section aria-labelledby={headingId} className="grid gap-3">
      <h2 id={headingId} className="text-base font-semibold">
        {t('codes.heading')}
      </h2>
      <p className="text-sm text-muted-foreground">{t('codes.description')}</p>
      <ol aria-label={t('codes.title')} className="grid grid-cols-2 gap-x-6 gap-y-1.5 rounded-md border bg-muted/50 p-4 font-mono text-sm">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-2">
        {canCopy() && (
          <Button type="button" variant="outline" size="sm" onClick={() => void copyText(text).then(setCopied)}>
            <CopyIcon aria-hidden="true" />
            {t('codes.copy')}
          </Button>
        )}
        <Button asChild variant="outline" size="sm">
          <a href={`data:text/plain;charset=utf-8,${encodeURIComponent(text)}`} download={t('codes.file_name')}>
            <DownloadIcon aria-hidden="true" />
            {t('codes.download')}
          </a>
        </Button>
      </div>
      {copied !== null && (
        <p role="status" className="text-sm text-muted-foreground">
          {t(copied ? 'codes.copied' : 'codes.copy_failed')}
        </p>
      )}
    </section>
  );
}

/** "Masuk lagi": the session is gone (S11), so the cached `auth/me` goes too, and the sign-in page tells why. */
export function SignInAgainButton({ notice, next }: { notice: SignInNotice; next?: string }) {
  const t = useT();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return (
    <Button
      type="button"
      onClick={() => {
        forgetMe(queryClient);
        void navigate({ href: loginHref(next === undefined ? {} : { next }, notice) });
      }}
    >
      {t('twofa.sign_in_again')}
    </Button>
  );
}

/** What enabling answered: the codes to show, and the end of every session (the shell is kept up meanwhile). */
export function useEnabled(): [string[] | null, (codes: string[]) => void] {
  const queryClient = useQueryClient();
  const [codes, setCodes] = useState<string[] | null>(null);
  return [
    codes,
    (next) => {
      holdMe(queryClient);
      setCodes(next);
    },
  ];
}

const EnableForm = z.strictObject({ code: z.string().transform((v) => v.replace(/[\s-]/g, '')).pipe(totpCodeField) });

/** The end of the session the enrolment runs in (401 AUTH_REQUIRED), when its page handles that itself. */
const sessionEnded = (e: unknown): boolean => e instanceof ApiError && e.code === 'AUTH_REQUIRED';

/**
 * The enrolment itself: start, scan or type the secret, confirm with a code; `onEnabled` gets the recovery codes.
 * `onSessionEnded` (the sign-in's enrolment) takes over when the session ended meanwhile (401 AUTH_REQUIRED: the
 * 10-minute pre-2FA session ran out while the user was scanning); without it the API client's redirect stands.
 */
export function TwoFactorEnrolment({ onEnabled, onSessionEnded }: { onEnabled: (codes: string[]) => void; onSessionEnded?: () => void }) {
  const t = useT();
  const codeId = useId();
  const [setup, setSetup] = useState<TwoFactorSetupResponse | null>(null);
  const [starting, setStarting] = useState(false);
  const [copied, setCopied] = useState<boolean | null>(null);
  const [problem, setProblem] = useState<unknown>(null);
  const form = useForm({ resolver: zodResolver(EnableForm, FORM_PARSE), defaultValues: { code: '' } });
  const { errors, isSubmitting } = form.formState;
  // From the start on, the page counts as a form being filled: a reload would lose the secret the user may already
  // have scanned, and the answer of `enable` (the recovery codes) may be the first to come from a newer release.
  useDirtyGuard(starting || setup !== null);

  const start = async (): Promise<void> => {
    setStarting(true);
    setProblem(null);
    try {
      setSetup(await api<TwoFactorSetupResponse>('POST', 'auth/2fa/setup'));
      setStarting(false);
    } catch (e) {
      if (onSessionEnded !== undefined && sessionEnded(e)) return onSessionEnded();
      setProblem(e);
      setStarting(false);
    }
  };

  const enable = form.handleSubmit(async ({ code }) => {
    setProblem(null);
    try {
      const res = await api<RecoveryCodesResponse>('POST', 'auth/2fa/enable', { code });
      onEnabled(res.codes);
    } catch (e) {
      if (hasFieldErrors(e)) return applyServerErrors(form, e);
      if (e instanceof ApiError && e.code === 'AUTH_MFA_INVALID') {
        form.resetField('code');
        form.setError('code', { type: e.code, message: 'error.AUTH_MFA_INVALID' }, { shouldFocus: true });
        return;
      }
      if (onSessionEnded !== undefined && sessionEnded(e)) return onSessionEnded();
      setProblem(e);
    }
  });

  if (setup === null) {
    return (
      <div className="grid gap-4">
        <ProblemAlert error={problem} />
        <div>
          <Button type="button" onClick={() => void start()} disabled={starting}>
            {starting ? t('form.working') : t('twofa.start')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-6">
      <div className="grid gap-3">
        <p className="text-sm">{t('twofa.step_scan')}</p>
        <QrCode text={setup.otpauthUri} label={t('twofa.qr_label')} className="size-48 rounded-md border bg-white" />
        <p className="text-sm text-muted-foreground">{t('twofa.secret_label')}</p>
        <div className="flex flex-wrap items-center gap-2">
          <code className="rounded-md border bg-muted/50 px-3 py-2 font-mono text-sm break-all select-all">{grouped(setup.secret)}</code>
          {canCopy() && (
            <Button type="button" variant="outline" size="sm" onClick={() => void copyText(setup.secret).then(setCopied)}>
              <CopyIcon aria-hidden="true" />
              {t('twofa.copy_secret')}
            </Button>
          )}
        </div>
        {copied !== null && (
          <p role="status" className="text-sm text-muted-foreground">
            {t(copied ? 'twofa.copied_secret' : 'codes.copy_failed')}
          </p>
        )}
      </div>
      <form noValidate className="grid gap-4" onSubmit={(e) => void enable(e)}>
        <p className="text-sm">{t('twofa.step_code')}</p>
        <Field id={codeId} label={t('login.2fa.code')} hint={t('login.2fa.code_hint')} error={errors.code?.message}>
          <Input
            id={codeId}
            autoComplete="one-time-code"
            inputMode="numeric"
            maxLength={7}
            spellCheck={false}
            className="max-w-40 font-mono tracking-[0.3em]"
            aria-invalid={errors.code !== undefined}
            aria-describedby={describedBy(codeId, { hint: true, error: errors.code })}
            {...form.register('code')}
          />
        </Field>
        <RootError message={errors.root?.['server']?.message} />
        <ProblemAlert error={problem} />
        <div>
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? t('form.working') : t('twofa.enable')}
          </Button>
        </div>
      </form>
    </div>
  );
}

/**
 * `/admin/login/setup-2fa`: the enrolment 2FA requires before the sign-in can finish. When the pre-2FA session ended
 * meanwhile, the sign-in page opens again saying why, keeping `next` (as the 2FA step does).
 */
export function SetupTwoFactorScreen() {
  const t = useT();
  const search = useSignInSearch();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [codes, enabled] = useEnabled();
  const ended = (): void => {
    forgetMe(queryClient);
    void navigate({ href: loginHref(search, '2fa_ended'), replace: true });
  };
  return (
    <SignInFrame title={t('login.setup.title')} description={codes === null ? t('login.setup.description') : undefined} wide>
      {codes === null ? (
        <>
          <TwoFactorEnrolment onEnabled={enabled} onSessionEnded={ended} />
          <CancelSignIn search={search} />
        </>
      ) : (
        <>
          <RecoveryCodes codes={codes} />
          <NoticeAlert>{t('twofa.signed_out')}</NoticeAlert>
          <SignInAgainButton notice="2fa_enabled" {...(search.next === undefined ? {} : { next: search.next })} />
        </>
      )}
    </SignInFrame>
  );
}
