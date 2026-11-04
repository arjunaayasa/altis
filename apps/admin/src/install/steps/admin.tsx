import type { AdminBody, InstallStateResponse } from '@altis/shared/api/install';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ApiError } from '@/lib/api';
import { installApi } from '../api';
import { useInstallT, type InstallKey } from '../i18n';
import { Field, ProblemAlert, StepHeading, describedBy } from '../ui';

// Step 4, the first super admin (spec §9.5 step 4): the password policy is the server's (at least 10 characters, no
// common password; its refusal names the reason), the two passwords must match, and the step says that 2FA is offered
// after the first sign-in → `POST admin`.

const FIELD_LABELS: Readonly<Record<string, InstallKey>> = {
  username: 'admin.username',
  name: 'admin.name',
  email: 'admin.email',
  password: 'admin.password',
};

const POLICY_REASONS = new Set(['too_short', 'too_long', 'common']);

export function AdminStep({ onDone, recover }: { onDone(installState: string): void; recover(error: unknown): Promise<boolean> }) {
  const t = useInstallT();
  const [username, setUsername] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [mismatch, setMismatch] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const mismatchText = mismatch ? t('admin.password_mismatch') : null;

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    if (password !== confirm) {
      setMismatch(true);
      return;
    }
    setMismatch(false);
    const body: AdminBody = { username: username.trim(), name: name.trim(), password };
    if (email.trim() !== '') body.email = email.trim();
    setBusy(true);
    setError(null);
    try {
      const answer = await installApi<InstallStateResponse>('POST', 'admin', body);
      onDone(answer.installState);
    } catch (failure) {
      if (!(await recover(failure))) setError(failure);
      setBusy(false);
    }
  };

  let problem = null;
  if (error instanceof ApiError && error.code === 'PASSWORD_TOO_WEAK' && error.reason !== undefined && POLICY_REASONS.has(error.reason)) {
    problem = (
      <p role="alert" className="text-sm text-destructive">
        {t(`admin.password.${error.reason}` as InstallKey)}
      </p>
    );
  } else if (error instanceof ApiError && error.code === 'VALIDATION_FAILED' && (error.errors?.length ?? 0) > 0) {
    const fields = [...new Set(error.errors!.map((e) => e.path.split('.')[0] ?? ''))].map((f) => (FIELD_LABELS[f] === undefined ? f : t(FIELD_LABELS[f]!)));
    problem = (
      <p role="alert" className="text-sm text-destructive">
        {t('admin.field_invalid', { fields: fields.join(', ') })}
      </p>
    );
  } else if (error !== null) {
    problem = <ProblemAlert error={error} />;
  }

  return (
    <div className="space-y-6">
      <StepHeading title={t('admin.title')} intro={t('admin.intro')} />
      <form className="grid gap-4" onSubmit={(e) => void submit(e)} noValidate>
        <Field id="install-admin-username" label={t('admin.username')} hint={t('admin.username_hint')}>
          <Input
            id="install-admin-username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            spellCheck={false}
            aria-describedby="install-admin-username-hint"
            required
          />
        </Field>
        <Field id="install-admin-name" label={t('admin.name')}>
          <Input id="install-admin-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required />
        </Field>
        <Field id="install-admin-email" label={t('admin.email')} hint={t('admin.email_hint')}>
          <Input
            id="install-admin-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            aria-describedby="install-admin-email-hint"
          />
        </Field>
        <Field id="install-admin-password" label={t('admin.password')} hint={t('admin.password_hint')}>
          <Input
            id="install-admin-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            aria-describedby="install-admin-password-hint"
            required
          />
        </Field>
        <Field id="install-admin-password-confirm" label={t('admin.password_confirm')} error={mismatchText}>
          <Input
            id="install-admin-password-confirm"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            aria-invalid={mismatch}
            aria-describedby={describedBy('install-admin-password-confirm', { error: mismatchText })}
            required
          />
        </Field>
        <p className="rounded-md bg-muted p-3 text-sm">{t('admin.two_factor_note')}</p>
        {problem}
        <div className="border-t pt-4">
          <Button type="submit" disabled={busy || username.trim() === '' || name.trim() === '' || password === ''}>
            {t('admin.save')}
          </Button>
        </div>
      </form>
    </div>
  );
}
