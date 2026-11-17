import type { ClaimResponse } from '@altis/shared/api/install';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ApiError } from '@/lib/api';
import { installApi } from '../api';
import { formatWait, useInstallLocale, useInstallT } from '../i18n';
import { Field, ProblemAlert, StepHeading } from '../ui';

// Step 0, the claim (spec §7.7, §9.5 step 0): the install code that the server wrote to DATA_DIR/install-code.txt (and
// printed to stdout) is exchanged for the `altis_install` cookie. The code is typed in any case, with spaces or dashes;
// it is shown grouped 5-5-5-5-6 and sent normalized as the server reads it (Crockford base32: I and L are 1, O is 0).
// The server allows 5 attempts per 15 minutes per visitor: a 429 says how long to wait.

/** The length of an install code (26 Crockford base32 characters, 130 bits). */
export const INSTALL_CODE_LENGTH = 26;
/** How the code is grouped on screen (spec §7.7: 5-5-5-5-6). */
const GROUPS = [5, 5, 5, 5, 6] as const;
/** What a 429 says when it names no wait: the server's window (15 minutes). */
const DEFAULT_WAIT_S = 900;

/** `input` as the server reads a code: upper case, no spaces or dashes, I/L → 1, O → 0, at most 26 characters. */
export function normalizeInstallCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0')
    .replace(/[^0-9A-Z]/g, '')
    .slice(0, INSTALL_CODE_LENGTH);
}

/** A normalized code grouped 5-5-5-5-6 (as far as it goes). */
export function groupInstallCode(code: string): string {
  const parts: string[] = [];
  let at = 0;
  for (const size of GROUPS) {
    if (at >= code.length) break;
    parts.push(code.slice(at, at + size));
    at += size;
  }
  return parts.join('-');
}

export function ClaimStep({ onClaimed, cookieLost = false }: { onClaimed(): void; cookieLost?: boolean }) {
  const t = useInstallT();
  const locale = useInstallLocale();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (code.length !== INSTALL_CODE_LENGTH || busy) return;
    setBusy(true);
    setError(null);
    try {
      await installApi<ClaimResponse>('POST', 'claim', { code });
      onClaimed();
    } catch (failure) {
      setError(failure);
    } finally {
      // The form stays when the claim did not hold (claim.cookie_lost): it can be sent again.
      setBusy(false);
    }
  };

  let problem = null;
  if (error === null && cookieLost) {
    problem = (
      <p role="alert" className="text-sm font-semibold text-bad">
        {t('claim.cookie_lost')}
      </p>
    );
  } else if (error instanceof ApiError && error.code === 'INSTALL_CODE_INVALID') {
    problem = (
      <p role="alert" className="text-sm font-semibold text-bad">
        {t('claim.invalid')}
      </p>
    );
  } else if (error instanceof ApiError && error.code === 'AUTH_TOO_MANY_ATTEMPTS') {
    problem = (
      <p role="alert" className="text-sm font-semibold text-bad">
        {t('claim.too_many', { time: formatWait(locale, error.retryAfterS ?? DEFAULT_WAIT_S) })}
      </p>
    );
  } else if (error !== null) {
    problem = <ProblemAlert error={error} />;
  }

  return (
    <div className="space-y-6">
      <StepHeading title={t('claim.title')} intro={t('claim.intro')} />
      <section className="grid gap-2 rounded-md border bg-layer px-3.5 py-3 text-sm">
        <h3 className="font-bold">{t('claim.where.title')}</h3>
        <p>{t('claim.where.file')}</p>
        <p>{t('claim.where.file_manager')}</p>
        <p>{t('claim.where.console')}</p>
        <p className="text-muted-foreground">{t('claim.where.expiry')}</p>
      </section>
      <form className="space-y-4" onSubmit={(e) => void submit(e)} noValidate>
        <Field id="install-code" label={t('claim.code')} hint={t('claim.code_hint')}>
          <Input
            id="install-code"
            name="code"
            value={groupInstallCode(code)}
            onChange={(e) => setCode(normalizeInstallCode(e.target.value))}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXXX"
            aria-describedby="install-code-hint"
            className="font-mono sm:tracking-wider"
          />
        </Field>
        {problem}
        <Button type="submit" disabled={busy || code.length !== INSTALL_CODE_LENGTH}>
          {busy ? t('claim.submitting') : t('claim.submit')}
        </Button>
      </form>
    </div>
  );
}
