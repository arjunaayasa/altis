import { t as sharedT } from '@altis/shared';
import type { CronTestResponse, FinishResponse } from '@altis/shared/api/install';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api';
import { installApi } from '../api';
import { useInstallLocale, useInstallT, type InstallKey } from '../i18n';
import { ProblemAlert, StepHeading } from '../ui';

// Step 5, the scheduler (spec §9.5 step 6), then step 6 through `POST finish`. `POST cron/test` gives the crontab line
// (this Node binary, the nodevenv one on cPanel) and the curl line (with the cron token), each with a copy button,
// whether a scheduler is required (Passenger and LiteSpeed run no worker) and whether a scheduler call was seen.
// The guidance follows the runtime: cPanel/LiteSpeed required (the CLI line first, curl as the alternative), aaPanel
// (PM2) optional as a Shell Script task with the curl line, Docker/PC optional. "Uji penjadwal" asks again. `finish`
// refused with CRON_NOT_DETECTED shows the guidance with the refusal.

/** How long "Tersalin" stays on a copy button. */
const COPIED_MS = 2000;

/** The guidance for `runtime`. */
export function cronGuidanceKey(runtime: string): InstallKey {
  if (runtime === 'passenger' || runtime === 'litespeed') return 'cron.guidance.cpanel';
  if (runtime === 'pm2') return 'cron.guidance.aapanel';
  return 'cron.guidance.other';
}

function CommandLine({ id, label, text, note }: { id: string; label: string; text: string; note?: string }) {
  const t = useInstallT();
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copyText = async (): Promise<void> => {
    try {
      if (navigator.clipboard === undefined) throw new Error('no clipboard');
      await navigator.clipboard.writeText(text);
      setCopy('copied');
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopy('idle'), COPIED_MS);
    } catch {
      setCopy('failed');
    }
  };

  return (
    <div className="space-y-1.5">
      <p id={`${id}-label`} className="text-sm font-medium">
        {label}
      </p>
      <div className="flex items-start gap-2">
        <code id={id} aria-labelledby={`${id}-label`} className="block min-w-0 flex-1 rounded-md bg-muted px-3 py-2 font-mono text-xs break-all select-all">
          {text}
        </code>
        <Button type="button" size="sm" variant="outline" aria-describedby={id} onClick={() => void copyText()}>
          {copy === 'copied' ? t('cron.copied') : t('cron.copy')}
        </Button>
      </div>
      {copy === 'failed' ? <p className="text-xs text-destructive">{t('cron.copy_failed')}</p> : null}
      {note === undefined ? null : <p className="text-xs text-muted-foreground">{note}</p>}
    </div>
  );
}

export function CronStep({
  runtime,
  onFinished,
  recover,
}: {
  runtime: string;
  onFinished(next: string): void;
  recover(error: unknown): Promise<boolean>;
}) {
  const t = useInstallT();
  const locale = useInstallLocale();
  const [status, setStatus] = useState<CronTestResponse | null>(null);
  const [busy, setBusy] = useState<'test' | 'finish' | null>('test');
  const [error, setError] = useState<unknown>(null);

  const test = useCallback(async () => {
    setBusy('test');
    setError(null);
    try {
      setStatus(await installApi<CronTestResponse>('POST', 'cron/test'));
    } catch (failure) {
      if (!(await recover(failure))) setError(failure);
    } finally {
      setBusy(null);
    }
  }, [recover]);

  useEffect(() => {
    void test();
  }, [test]);

  const finish = async (): Promise<void> => {
    setBusy('finish');
    setError(null);
    try {
      const answer = await installApi<FinishResponse>('POST', 'finish');
      onFinished(answer.next);
    } catch (failure) {
      if (!(await recover(failure))) setError(failure);
      setBusy(null);
    }
  };

  const guidance = t(cronGuidanceKey(runtime));
  const time = (at: number): string => new Date(at).toLocaleTimeString(locale === 'id' ? 'id-ID' : 'en-US');
  let detection: string | null = null;
  if (status !== null) {
    if (!status.detected) detection = t('cron.not_detected');
    else if (status.mode === 'worker') detection = t('cron.detected.worker');
    else if (status.mode === 'cron_cli' && status.at !== null) detection = t('cron.detected.cron_cli', { time: time(status.at) });
    else if (status.mode === 'cron_http' && status.at !== null) detection = t('cron.detected.cron_http', { time: time(status.at) });
    else detection = t('cron.detected.worker');
  }
  const notDetected = error instanceof ApiError && error.code === 'CRON_NOT_DETECTED';

  return (
    <div className="space-y-6">
      <StepHeading title={t('cron.title')} intro={t('cron.intro')} />
      {status === null ? null : (
        <>
          <p className="text-sm font-medium">{status.required ? t('cron.required') : t('cron.optional')}</p>
          <p className="text-sm">{guidance}</p>
          <CommandLine id="install-cron-line" label={t('cron.cron_line')} text={status.cronLine} />
          <CommandLine id="install-curl-line" label={t('cron.curl_line')} text={status.curlLine} note={t('cron.secret_note')} />
        </>
      )}
      <div className="space-y-2" aria-live="polite">
        {busy === 'test' ? <p className="text-sm text-muted-foreground">{t('cron.testing')}</p> : null}
        {busy !== 'test' && detection !== null ? <p className="text-sm">{detection}</p> : null}
      </div>
      {notDetected ? (
        <Alert variant="destructive">
          <AlertTitle>{t('cron.not_detected_title')}</AlertTitle>
          <AlertDescription>
            <p>{sharedT(locale, 'error.CRON_NOT_DETECTED')}</p>
            <p>{guidance}</p>
          </AlertDescription>
        </Alert>
      ) : error === null ? null : (
        <ProblemAlert error={error} />
      )}
      <div className="flex flex-wrap gap-2 border-t pt-4">
        <Button type="button" variant="outline" disabled={busy !== null} onClick={() => void test()}>
          {t('cron.test')}
        </Button>
        <Button type="button" disabled={busy !== null || status === null} onClick={() => void finish()}>
          {busy === 'finish' ? t('cron.finishing') : t('cron.finish')}
        </Button>
      </div>
    </div>
  );
}
