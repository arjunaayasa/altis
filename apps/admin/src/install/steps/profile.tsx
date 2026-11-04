import type { Locale } from '@altis/shared';
import type { InstallStateResponse, ProfileBody } from '@altis/shared/api/install';
import { LIBRARY_TYPES } from '@altis/shared/api/settings';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { installApi } from '../api';
import { useInstallLocale, useInstallT, type InstallKey } from '../i18n';
import { CONTROL_CLASS, Field, ProblemAlert, Section, StepHeading, describedBy } from '../ui';

// Step 3, the library's profile (spec §9.5 step 3): name, type, address, time zone, language and the main branch
// (`PUSAT` and the library's name unless given) → `POST profile`.

/** Time zones offered while typing (Indonesia's three; any IANA name is accepted). */
const SUGGESTED_ZONES = ['Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura'] as const;
const FALLBACK_ZONE = 'Asia/Jakarta';

/** Whether `Intl` knows the time zone `zone`. */
export function isTimeZone(zone: string): boolean {
  if (zone.trim() === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone.trim() });
    return true;
  } catch {
    return false;
  }
}

/** The browser's time zone, or Asia/Jakarta. */
function browserZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isTimeZone(zone) && zone !== 'UTC' && zone !== 'Etc/UTC' ? zone : FALLBACK_ZONE;
  } catch {
    return FALLBACK_ZONE;
  }
}

export function ProfileStep({ onDone, recover }: { onDone(installState: string): void; recover(error: unknown): Promise<boolean> }) {
  const t = useInstallT();
  const uiLocale = useInstallLocale();
  const [name, setName] = useState('');
  const [type, setType] = useState('');
  const [address, setAddress] = useState('');
  const [timezone, setTimezone] = useState(browserZone);
  const [locale, setLocale] = useState<Locale>(uiLocale);
  const [branchCode, setBranchCode] = useState('');
  const [branchName, setBranchName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [touched, setTouched] = useState(false);

  const zoneOk = isTimeZone(timezone);
  const zoneError = zoneOk ? null : t('profile.timezone_invalid');
  const valid = name.trim() !== '' && zoneOk;

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setTouched(true);
    if (!valid || busy) return;
    const library: ProfileBody['library'] = { name: name.trim(), timezone: timezone.trim(), locale };
    if (type !== '') library.type = type as NonNullable<ProfileBody['library']['type']>;
    if (address.trim() !== '') library.address = address.trim();
    const branch: ProfileBody['branch'] = {};
    if (branchCode.trim() !== '') branch.code = branchCode.trim();
    if (branchName.trim() !== '') branch.name = branchName.trim();
    setBusy(true);
    setError(null);
    try {
      const answer = await installApi<InstallStateResponse>('POST', 'profile', { library, branch });
      onDone(answer.installState);
    } catch (failure) {
      if (!(await recover(failure))) setError(failure);
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <StepHeading title={t('profile.title')} />
      <form className="grid gap-4" onSubmit={(e) => void submit(e)} noValidate>
        <Field id="install-library-name" label={t('profile.name')}>
          <Input id="install-library-name" value={name} onChange={(e) => setName(e.target.value)} aria-invalid={touched && name.trim() === ''} required />
        </Field>
        <Field id="install-library-type" label={t('profile.type')}>
          <select id="install-library-type" className={`${CONTROL_CLASS} h-9`} value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">{t('profile.type.none')}</option>
            {LIBRARY_TYPES.map((k) => (
              <option key={k} value={k}>
                {t(`profile.type.${k}` as InstallKey)}
              </option>
            ))}
          </select>
        </Field>
        <Field id="install-library-address" label={t('profile.address')}>
          <textarea id="install-library-address" className={`${CONTROL_CLASS} min-h-20 py-2`} value={address} onChange={(e) => setAddress(e.target.value)} />
        </Field>
        <Field
          id="install-library-timezone"
          label={t('profile.timezone')}
          hint={t('profile.timezone_hint')}
          error={zoneError}
        >
          <Input
            id="install-library-timezone"
            list="install-zones"
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            aria-describedby={describedBy('install-library-timezone', { hint: true, error: zoneError })}
            aria-invalid={!zoneOk}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        <datalist id="install-zones">
          {SUGGESTED_ZONES.map((z) => (
            <option key={z} value={z} />
          ))}
        </datalist>
        <Field id="install-library-locale" label={t('profile.locale')}>
          <select id="install-library-locale" className={`${CONTROL_CLASS} h-9`} value={locale} onChange={(e) => setLocale(e.target.value === 'en' ? 'en' : 'id')}>
            <option value="id">{t('profile.locale.id')}</option>
            <option value="en">{t('profile.locale.en')}</option>
          </select>
        </Field>
        <Section title={t('profile.branch.title')}>
          <Field id="install-branch-code" label={t('profile.branch.code')} hint={t('profile.branch.code_hint')}>
            <Input
              id="install-branch-code"
              value={branchCode}
              placeholder="PUSAT"
              onChange={(e) => setBranchCode(e.target.value)}
              aria-describedby="install-branch-code-hint"
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <Field id="install-branch-name" label={t('profile.branch.name')} hint={t('profile.branch.name_hint')}>
            <Input id="install-branch-name" value={branchName} onChange={(e) => setBranchName(e.target.value)} aria-describedby="install-branch-name-hint" />
          </Field>
        </Section>
        {error === null ? null : <ProblemAlert error={error} />}
        <div className="border-t pt-4">
          <Button type="submit" disabled={busy || (touched && !valid)}>
            {t('profile.save')}
          </Button>
        </div>
      </form>
    </div>
  );
}
