import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Field, describedBy } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useT, type AdminKey } from '@/i18n';
import { ApiError, api, reauth } from '@/lib/api';
import { problemText } from '@/lib/form-errors';
import { useMe } from '@/lib/me';
import { useReturnFocus } from './return-focus';

/** A field's error: the message key, as the other forms set it (lib/form-errors.ts). */
type FieldErrors = Partial<Record<'password' | 'code', AdminKey>>;

/** The six digits of an authenticator code (the shared `totpCodeField`). */
const SIX_DIGITS = /^\d{6}$/;

/** `errors` without the error of `field` (it is being typed again). */
function cleared(errors: FieldErrors, field: keyof FieldErrors): FieldErrors {
  const next = { ...errors };
  delete next[field];
  return next;
}

/**
 * Re-authentication (spec §7.3). A sensitive action answered with 401 AUTH_REAUTH_REQUIRED makes the API client call
 * `reauth.request()`: this dialog registers that handler, asks for the password (plus the authenticator code when
 * 2FA is enabled, `me.user.totpEnabled`), sends `POST auth/reauth`, and lets the client repeat the action. Closing it
 * cancels the action. Like every other form it checks its fields itself, in the user's language (`noValidate`: no
 * browser tooltip in the browser's language): an empty password, a code that is not six digits. A refusal says why
 * (a 429 with how long to wait, lib/form-errors.ts) and empties the code field. Nothing typed here is kept once the
 * dialog closes.
 */
export function ReauthDialog() {
  const t = useT();
  const me = useMe();
  const totp = me?.authenticated === true && me.user.totpEnabled;
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef<{ resolve(): void; reject(reason: Error): void } | null>(null);
  const inputs = { password: useRef<HTMLInputElement>(null), code: useRef<HTMLInputElement>(null) };
  const ids = { password: useId(), code: useId(), error: useId() };
  const focus = useReturnFocus();

  useEffect(
    () =>
      reauth.setHandler(
        () =>
          new Promise<void>((resolve, reject) => {
            pending.current = { resolve, reject };
            setOpen(true);
          }),
      ),
    [],
  );

  const close = (): void => {
    setOpen(false);
    setPassword('');
    setCode('');
    setErrors({});
    setError(null);
  };

  const cancel = (): void => {
    pending.current?.reject(new Error('reauth cancelled'));
    pending.current = null;
    close();
  };

  /** The fields' own checks; the first field in error gets the focus. */
  const check = (): boolean => {
    const found: FieldErrors = {};
    if (password === '') found.password = 'form.error.required';
    if (totp && code === '') found.code = 'form.error.required';
    else if (totp && !SIX_DIGITS.test(code)) found.code = 'form.error.invalid_format';
    setErrors(found);
    const first = found.password !== undefined ? inputs.password : found.code !== undefined ? inputs.code : null;
    first?.current?.focus();
    return first === null;
  };

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setError(null);
    if (!check()) return;
    setBusy(true);
    try {
      await api('POST', 'auth/reauth', totp ? { password, code } : { password });
      pending.current?.resolve();
      pending.current = null;
      close();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'AUTH_REQUIRED') return cancel();
      // A code is good for one try: a wrong one (or one refused with the password) is typed again.
      setCode('');
      setError(problemText(t, e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : cancel())}>
      <DialogContent showCloseButton={false} onOpenAutoFocus={focus.onOpenAutoFocus} onCloseAutoFocus={focus.onCloseAutoFocus}>
        <form noValidate className="grid gap-4" onSubmit={(e) => void submit(e)} aria-describedby={error === null ? undefined : ids.error}>
          <DialogHeader>
            <DialogTitle>{t('reauth.title')}</DialogTitle>
            <DialogDescription>{t('reauth.description')}</DialogDescription>
          </DialogHeader>
          <Field id={ids.password} label={t('reauth.password')} error={errors.password}>
            <Input
              id={ids.password}
              ref={inputs.password}
              type="password"
              autoComplete="current-password"
              required
              aria-invalid={errors.password === undefined ? undefined : true}
              aria-describedby={describedBy(ids.password, { error: errors.password })}
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setErrors((current) => cleared(current, 'password'));
              }}
            />
          </Field>
          {totp && (
            <Field id={ids.code} label={t('reauth.code')} hint={t('reauth.code_hint')} error={errors.code}>
              <Input
                id={ids.code}
                ref={inputs.code}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                required
                aria-invalid={errors.code === undefined ? undefined : true}
                aria-describedby={describedBy(ids.code, { hint: true, error: errors.code })}
                value={code}
                onChange={(e) => {
                  setCode(e.target.value.replace(/\D/g, ''));
                  setErrors((current) => cleared(current, 'code'));
                }}
              />
            </Field>
          )}
          {error !== null && (
            <p id={ids.error} role="alert" className="text-meta font-semibold text-bad">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={cancel}>
              {t('reauth.cancel')}
            </Button>
            <Button type="submit" disabled={busy}>
              {t('reauth.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
