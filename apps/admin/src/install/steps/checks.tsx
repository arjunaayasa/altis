import { XFF_PROBE_FORGED, type ProbeResultBody } from '@altis/shared/api/diagnostics';
import { PREFLIGHT_CHECKS, type InstallChecksResponse, type PreflightCheck, type PreflightCheckName } from '@altis/shared/api/install';
import { useEffect, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { probeResultBody, runBrowserProbes, type ProbeResults } from '@/lib/probes';
import { installCsrf } from '../api';
import { formatBytes, useInstallLocale, useInstallT, type InstallKey } from '../i18n';
import { Field, ProblemAlert, Section, Status, StepHeading, describedBy, type Tone } from '../ui';

// Step 1, the checks (spec §9.5 step 1): the server's mandatory checks with how to fix each one, the runtime and the
// aaPanel "Default" project warning, then the browser test (lib/probes.ts) against /install/api/probe: polling, SSE,
// methods, chunk size, the X-Forwarded-For test with the suggested hops and the client IP they give (to confirm), the
// exposure test (blocking: a file of the data or app folder served through the web leaves no way forward), and the
// base URL proof. The base URL is location.origin, confirmed by the user; a path is refused. What the step found goes
// to the database step, which sends it with `POST config`.

/** What the checks step hands to the database step (the parts of `POST config` it decided). */
export interface Connection {
  baseUrl: string;
  hops: number;
  probe: { nonce: string; hmac: string; results: ProbeResultBody };
}

/** `trustProxy.hops` accepts 0-10. */
const HOPS_MAX = 10;

type ProbeState = { status: 'running' } | { status: 'done'; results: ProbeResults } | { status: 'failed'; error: unknown };

/** The base URL as typed: its origin, or why it is refused. */
export function checkBaseUrl(value: string, origin: string): { ok: true; origin: string } | { ok: false; key: InstallKey } {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return { ok: false, key: 'checks.base_url.invalid' };
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '') return { ok: false, key: 'checks.base_url.invalid' };
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '' || /[?#]/.test(value.trim())) return { ok: false, key: 'checks.base_url.path' };
  if (url.origin !== origin) return { ok: false, key: 'checks.base_url.mismatch' };
  return { ok: true, origin: url.origin };
}

/** The client IP `hops` would give, as far as the clean poll tells (null: not known here). */
export function ipForHops(results: ProbeResults, hops: number): string | null {
  if (results.suggestedHops !== null && hops === results.suggestedHops) return results.ipAtSuggested === '' ? null : results.ipAtSuggested;
  const chain = results.xff.cleanXff;
  return hops >= 1 && hops <= chain.length ? chain[chain.length - hops]! : null;
}

/**
 * Whether `hops` would take the forged poll's forged entry as the client IP (decision C22's `spoofable`, for the hops
 * being chosen here; the forged poll's own `forgedDerived` used the server's pre-install hops).
 */
export function spoofableAt(results: ProbeResults, hops: number): boolean {
  const chain = results.xff.forgedXff;
  return hops >= 1 && hops <= chain.length && chain[chain.length - hops] === XFF_PROBE_FORGED;
}

function checkTone(check: PreflightCheck): Tone {
  if (check.ok) return 'ok';
  return check.level === 'error' ? 'error' : 'warn';
}

export function ChecksStep({ checks, onRerun, onContinue }: { checks: InstallChecksResponse; onRerun(): Promise<void>; onContinue(c: Connection): void }) {
  const t = useInstallT();
  const locale = useInstallLocale();
  const [probes, setProbes] = useState<ProbeState>({ status: 'running' });
  const [hops, setHops] = useState(0);
  const [confirmed, setConfirmed] = useState(false);
  const [baseUrl, setBaseUrl] = useState(() => location.origin);
  const [rerunning, setRerunning] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    runBrowserProbes({ base: '/install/api/probe', csrf: installCsrf, exposure: checks.exposure.candidates, signal: controller.signal }).then(
      (results) => {
        setProbes({ status: 'done', results });
        setHops(Math.min(HOPS_MAX, results.suggestedHops ?? 0));
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setProbes({ status: 'failed', error });
      },
    );
    return () => controller.abort();
  }, [checks]);

  const rerun = async (): Promise<void> => {
    setRerunning(true);
    try {
      await onRerun();
    } finally {
      setRerunning(false);
    }
  };

  const base = checkBaseUrl(baseUrl, location.origin);
  const baseError = base.ok ? null : t(base.key, { origin: location.origin });
  const results = probes.status === 'done' ? probes.results : null;
  const exposure = results?.exposure ?? null;
  const exposed = exposure?.status === 'exposed';
  const ip = results === null ? null : ipForHops(results, hops);
  // Hops that take the forged entry as the client IP would let anyone pick their address past the per-IP limits (P15,
  // A3): they cannot be confirmed.
  const spoofable = results !== null && spoofableAt(results, hops);
  const ready =
    checks.preflight.ok &&
    results !== null &&
    results.polling &&
    exposure?.status === 'ok' &&
    results.baseUrlProof !== null &&
    base.ok &&
    !spoofable &&
    confirmed;

  const proceed = (): void => {
    if (!ready || results === null || results.baseUrlProof === null || !base.ok) return;
    onContinue({ baseUrl: base.origin, hops, probe: { ...results.baseUrlProof, results: probeResultBody(results) } });
  };

  const blocked = (results?.methods === undefined ? [] : (['put', 'patch', 'delete'] as const).filter((m) => !results.methods[m])).map((m) => m.toUpperCase());

  return (
    <div className="space-y-6">
      <StepHeading title={t('checks.title')} intro={t('checks.intro')} />
      <p className="text-sm">{t('checks.runtime', { runtime: t(`runtime.${checks.runtime}` as InstallKey) })}</p>
      {checks.panelWarning === 'aapanel_default' ? (
        <Alert>
          <AlertDescription>
            <p>{t('checks.aapanel_default')}</p>
          </AlertDescription>
        </Alert>
      ) : null}

      <Section title={t('checks.mandatory')}>
        <ul className="space-y-3">
          {PREFLIGHT_CHECKS.map((name: PreflightCheckName) => {
            const check = checks.preflight.checks[name];
            const tone = checkTone(check);
            return (
              <li key={name} className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Status tone={tone}>{t(`checks.status.${tone}`)}</Status>
                  <span className="text-sm font-semibold">{t(`checks.name.${name}`)}</span>
                  <span className="text-xs text-muted-foreground">{check.detail}</span>
                </div>
                {check.ok ? null : <p className="text-sm text-muted-foreground">{t(`checks.fix.${name}`)}</p>}
              </li>
            );
          })}
        </ul>
        {checks.preflight.ok ? null : (
          <Alert variant="destructive">
            <AlertDescription>
              <p>{t('checks.blocked_preflight')}</p>
            </AlertDescription>
          </Alert>
        )}
      </Section>

      <Section title={t('checks.browser.title')}>
        {probes.status === 'running' ? <p className="text-sm text-muted-foreground">{t('checks.browser.running')}</p> : null}
        {probes.status === 'failed' ? <ProblemAlert error={probes.error} /> : null}
        {results === null ? null : (
          <dl className="grid gap-2 text-sm sm:grid-cols-[auto_1fr] sm:gap-x-4">
            <dt className="font-semibold">{t('checks.browser.polling')}</dt>
            <dd>{results.polling ? t('checks.browser.works') : t('checks.browser.fails')}</dd>
            <dt className="font-semibold">{t('checks.browser.sse')}</dt>
            <dd>{results.sse ? t('checks.browser.works') : t('checks.browser.sse_off')}</dd>
            <dt className="font-semibold">{t('checks.browser.methods')}</dt>
            <dd>{blocked.length === 0 ? t('checks.browser.works') : t('checks.browser.methods_blocked', { methods: blocked.join(', ') })}</dd>
            <dt className="font-semibold">{t('checks.browser.chunk')}</dt>
            <dd>{results.chunkBytes === null ? t('checks.browser.chunk_none') : formatBytes(locale, results.chunkBytes)}</dd>
          </dl>
        )}
      </Section>

      {results === null ? null : (
        <Section title={t('checks.exposure.title')}>
          {exposure?.status === 'ok' ? <p className="text-sm">{t('checks.exposure.ok')}</p> : null}
          {exposed ? (
            <Alert variant="destructive">
              <AlertDescription>
                <p>{t('checks.exposure.exposed')}</p>
              </AlertDescription>
            </Alert>
          ) : null}
          {exposure === null || exposure.status === 'error' ? (
            <Alert variant="destructive">
              <AlertDescription>
                <p>{t('checks.exposure.error')}</p>
              </AlertDescription>
            </Alert>
          ) : null}
          {results.baseUrlProof === null ? (
            <Alert variant="destructive">
              <AlertDescription>
                <p>{t('checks.base_url.proof_failed')}</p>
              </AlertDescription>
            </Alert>
          ) : null}
        </Section>
      )}

      {results === null || exposed ? null : (
        <Section title={t('checks.network.title')}>
          {results.suggestedHops === null ? (
            <p className="text-sm">{t('checks.network.no_suggestion')}</p>
          ) : (
            <p className="text-sm">
              {results.ipAtSuggested
                ? t(results.suggestedHops === 1 ? 'checks.network.suggestion_one' : 'checks.network.suggestion', { hops: results.suggestedHops, ip: results.ipAtSuggested })
                : t(results.suggestedHops === 1 ? 'checks.network.suggestion_no_ip_one' : 'checks.network.suggestion_no_ip', { hops: results.suggestedHops })}
            </p>
          )}
          {spoofable ? (
            <p id="install-hops-spoofable" className="text-sm font-semibold text-bad">
              {t('checks.network.spoofable')}
            </p>
          ) : null}
          <Field id="install-hops" label={t('checks.network.hops')}>
            <Input
              id="install-hops"
              type="number"
              min={0}
              max={HOPS_MAX}
              step={1}
              value={hops}
              onChange={(e) => {
                const value = Number(e.target.value);
                setHops(Number.isInteger(value) ? Math.min(HOPS_MAX, Math.max(0, value)) : 0);
                setConfirmed(false);
              }}
              className="w-24"
            />
          </Field>
          {ip === null ? (
            <p className="text-sm">{t('checks.network.ip_unknown')}</p>
          ) : hops === results.suggestedHops ? null : (
            <p className="text-sm">{t(hops === 1 ? 'checks.network.ip_for_hops_one' : 'checks.network.ip_for_hops', { hops, ip })}</p>
          )}
          <div className="flex items-start gap-2">
            <input
              id="install-ip-confirm"
              type="checkbox"
              className="mt-0.5 size-4"
              checked={confirmed && !spoofable}
              disabled={spoofable}
              onChange={(e) => setConfirmed(e.target.checked)}
              aria-describedby={[spoofable ? 'install-hops-spoofable' : null, ip === null ? null : 'install-ip-confirm-hint'].filter((id) => id !== null).join(' ') || undefined}
            />
            <div className="grid gap-1">
              <label htmlFor="install-ip-confirm" className="text-sm font-semibold">
                {ip === null ? t('checks.network.confirm_hops') : t('checks.network.confirm')}
              </label>
              {ip === null ? null : (
                <p id="install-ip-confirm-hint" className="text-xs text-muted-foreground">
                  {t('checks.network.confirm_hint')}
                </p>
              )}
            </div>
          </div>
        </Section>
      )}

      {exposed ? null : (
        <Section title={t('checks.base_url.title')}>
          <Field
            id="install-base-url"
            label={t('checks.base_url.label')}
            hint={t('checks.base_url.hint')}
            error={baseError}
          >
            <Input
              id="install-base-url"
              type="url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              aria-describedby={describedBy('install-base-url', { hint: true, error: baseError })}
              aria-invalid={!base.ok}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
        </Section>
      )}

      <div className="flex flex-wrap gap-2 border-t pt-4">
        {exposed ? null : (
          <Button type="button" disabled={!ready} onClick={proceed}>
            {t('app.next')}
          </Button>
        )}
        <Button type="button" variant="outline" disabled={rerunning || probes.status === 'running'} onClick={() => void rerun()}>
          {t('checks.rerun')}
        </Button>
      </div>
    </div>
  );
}
