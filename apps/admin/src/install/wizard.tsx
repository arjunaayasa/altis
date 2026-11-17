import type { Locale } from '@altis/shared';
import type { InstallChecksResponse } from '@altis/shared/api/install';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import { installApi } from './api';
import { InstallLocaleProvider, installT, type InstallKey } from './i18n';
import { AdminStep } from './steps/admin';
import { ChecksStep, type Connection } from './steps/checks';
import { ClaimStep } from './steps/claim';
import { CronStep } from './steps/cron';
import { DatabaseStep } from './steps/database';
import { DoneStep } from './steps/done';
import { MigrateStep } from './steps/migrate';
import { ProfileStep } from './steps/profile';
import { ProblemAlert, StepHeading } from './ui';

/**
 * The web install wizard (spec §7.7, §9.5; plan Task 30), the page `install.html` of the release (the server serves
 * it at `/install` with the request's CSP nonce). Every process of the installation may answer any request, so the
 * wizard keeps nothing the server needs: on load it asks `GET checks`, which answers only to the claim's holder
 * (403 INSTALL_CLAIM_REQUIRED → step 0, the claim) and says where the install stands (`installState` → the step to
 * resume at). A 404 means the install is complete. A step answered 409 INSTALL_STEP_ORDER (another tab or process
 * moved the install on) asks `GET checks` again and goes where the install stands.
 *
 * The steps: 0 claim, 1 checks (the browser test, the exposure verdict, the hops and the base URL), 2 database then
 * the migrations, 3 profile, 4 super admin, 5 scheduler, 6 done.
 */

export type StepId = 'claim' | 'checks' | 'database' | 'migrate' | 'profile' | 'admin' | 'cron' | 'done';

/** The steps as the list shows them (numbers 0-6; the database and its migrations are one). */
const STEP_LIST: readonly { key: InstallKey; covers: readonly StepId[] }[] = [
  { key: 'step.claim', covers: ['claim'] },
  { key: 'step.checks', covers: ['checks'] },
  { key: 'step.database', covers: ['database', 'migrate'] },
  { key: 'step.profile', covers: ['profile'] },
  { key: 'step.admin', covers: ['admin'] },
  { key: 'step.cron', covers: ['cron'] },
  { key: 'step.done', covers: ['done'] },
];

/** The step to resume at for config.json's `installState` (null: no config.json yet). */
export function stepOf(installState: string | null): StepId {
  switch (installState) {
    case 'migrate':
    case 'profile':
    case 'admin':
    case 'cron':
      return installState;
    case 'complete':
      return 'done';
    default:
      return 'checks';
  }
}

type Phase = { kind: 'loading' } | { kind: 'claim'; cookieLost?: boolean } | { kind: 'installed' } | { kind: 'failed'; error: unknown } | { kind: 'step'; step: StepId };

const LOGIN_PATH = '/admin/login';

const LANGUAGES: readonly { locale: Locale; label: string }[] = [
  { locale: 'id', label: 'Bahasa Indonesia' },
  { locale: 'en', label: 'English' },
];

export function Wizard() {
  const [locale, setLocale] = useState<Locale>('id');
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [checks, setChecks] = useState<InstallChecksResponse | null>(null);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [next, setNext] = useState(LOGIN_PATH);
  /** Bumped by "run the checks again": the checks step starts over with fresh checks. */
  const [round, setRound] = useState(0);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const t = useCallback((key: InstallKey, params?: Readonly<Record<string, string | number>>) => installT(locale, key, params), [locale]);

  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = installT(locale, 'app.title');
  }, [locale]);

  /**
   * Asks `GET checks` where the install stands and goes there (`resume`: always; otherwise only when that is another
   * step than the one shown). True when the wizard moved. `afterClaim`: the claim was just accepted, so a claim still
   * missing means the browser refused the `altis_install` cookie (a `Secure` cookie on an `http:` page, C19).
   */
  const locate = useCallback(async (resume: boolean, afterClaim = false): Promise<boolean> => {
    const current = phaseRef.current;
    try {
      const answer = await installApi<InstallChecksResponse>('GET', 'checks');
      setChecks(answer);
      const step = stepOf(answer.installState);
      if (!resume && current.kind === 'step' && current.step === step) return false;
      setPhase({ kind: 'step', step });
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.code === 'INSTALL_CLAIM_REQUIRED') setPhase({ kind: 'claim', cookieLost: afterClaim });
      else if (error instanceof ApiError && error.status === 404) setPhase({ kind: 'installed' });
      else if (resume || current.kind !== 'step') setPhase({ kind: 'failed', error });
      else return false;
      return true;
    }
  }, []);

  useEffect(() => {
    void locate(true);
  }, [locate]);

  /**
   * What a step does with a failed request before it shows it: the claim gone (403 INSTALL_CLAIM_REQUIRED) → the claim
   * step; the install complete (404) → said so; 409 INSTALL_STEP_ORDER → wherever the install stands. True when the
   * wizard moved (the step shows nothing more).
   */
  const recover = useCallback(
    async (error: unknown): Promise<boolean> => {
      if (!(error instanceof ApiError)) return false;
      if (error.code === 'INSTALL_CLAIM_REQUIRED') {
        setPhase({ kind: 'claim' });
        return true;
      }
      if (error.status === 404) {
        setPhase({ kind: 'installed' });
        return true;
      }
      if (error.code === 'INSTALL_STEP_ORDER') return locate(false);
      return false;
    },
    [locate],
  );

  const goTo = useCallback((step: StepId) => setPhase({ kind: 'step', step }), []);
  const advance = useCallback((installState: string) => goTo(stepOf(installState)), [goTo]);

  const rerunChecks = useCallback(async () => {
    try {
      const answer = await installApi<InstallChecksResponse>('GET', 'checks');
      setChecks(answer);
      setRound((n) => n + 1);
      const step = stepOf(answer.installState);
      if (step !== 'checks') goTo(step);
    } catch (error) {
      if (!(await recover(error))) setPhase({ kind: 'failed', error });
    }
  }, [goTo, recover]);

  const current = phase.kind === 'step' ? phase.step : phase.kind === 'claim' ? 'claim' : null;
  const index = current === null ? -1 : STEP_LIST.findIndex((s) => s.covers.includes(current));

  let body: ReactNode;
  if (phase.kind === 'loading') {
    body = <p className="text-sm text-muted-foreground">{t('app.loading')}</p>;
  } else if (phase.kind === 'claim') {
    body = <ClaimStep cookieLost={phase.cookieLost === true} onClaimed={() => void locate(true, true)} />;
  } else if (phase.kind === 'installed') {
    body = (
      <div className="space-y-4">
        <StepHeading title={t('app.installed.title')} intro={t('app.installed.body')} />
        <Button asChild>
          <a href={LOGIN_PATH}>{t('app.go_login')}</a>
        </Button>
      </div>
    );
  } else if (phase.kind === 'failed') {
    body = (
      <div className="space-y-4">
        <StepHeading title={t('app.unavailable.title')} />
        <ProblemAlert error={phase.error} />
        <Button type="button" onClick={() => void locate(true)}>
          {t('app.retry')}
        </Button>
      </div>
    );
  } else {
    body = (
      <StepView
        step={phase.step}
        checks={checks}
        connection={connection}
        round={round}
        next={next}
        onConnection={(c) => {
          setConnection(c);
          goTo('database');
        }}
        onRerun={rerunChecks}
        goTo={goTo}
        advance={advance}
        recover={recover}
        onFinished={(to) => {
          setNext(to);
          goTo('done');
        }}
      />
    );
  }

  return (
    <InstallLocaleProvider locale={locale}>
      <div className="min-h-screen bg-layer text-foreground">
        <header className="border-b bg-background">
          <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div>
              <h1 className="text-base font-bold">{t('app.title')}</h1>
              <p className="text-xs text-muted-foreground">{t('app.subtitle')}</p>
            </div>
            <div role="group" aria-label={t('app.language')} className="flex gap-1">
              {LANGUAGES.map((l) => (
                <Button
                  key={l.locale}
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="aria-pressed:bg-accent-soft aria-pressed:text-accent-text"
                  aria-pressed={l.locale === locale}
                  onClick={() => setLocale(l.locale)}
                >
                  {l.label}
                </Button>
              ))}
            </div>
          </div>
        </header>
        <main className="mx-auto grid max-w-3xl gap-4 px-4 py-6">
          {index < 0 ? null : (
            <nav aria-label={t('app.steps_label')}>
              <p className="mb-2 text-xs text-muted-foreground">{t('app.step_of', { n: index + 1, total: STEP_LIST.length })}</p>
              <ol className="flex flex-wrap gap-1.5">
                {STEP_LIST.map((s, i) => (
                  <li
                    key={s.key}
                    aria-current={i === index ? 'step' : undefined}
                    className={cn(
                      'rounded px-2 py-1 text-xs',
                      i === index ? 'bg-accent-soft font-bold text-accent-text' : i < index ? 'text-foreground' : 'text-muted-foreground',
                    )}
                  >
                    {i}. {t(s.key)}
                  </li>
                ))}
              </ol>
            </nav>
          )}
          <div className="grid gap-6 rounded-lg border bg-background p-4 sm:p-6">{body}</div>
        </main>
      </div>
    </InstallLocaleProvider>
  );
}

interface StepViewProps {
  step: StepId;
  checks: InstallChecksResponse | null;
  connection: Connection | null;
  round: number;
  next: string;
  onConnection(c: Connection): void;
  onRerun(): Promise<void>;
  goTo(step: StepId): void;
  advance(installState: string): void;
  recover(error: unknown): Promise<boolean>;
  onFinished(next: string): void;
}

/** The step `step` (the checks again when the database step has no connection to configure). */
function StepView(p: StepViewProps) {
  const runtime = p.checks?.runtime ?? 'standalone';
  switch (p.step) {
    case 'claim':
    case 'checks':
      return p.checks === null ? null : <ChecksStep key={p.round} checks={p.checks} onRerun={p.onRerun} onContinue={p.onConnection} />;
    case 'database':
      if (p.connection === null || p.checks === null) {
        return p.checks === null ? null : <ChecksStep key={p.round} checks={p.checks} onRerun={p.onRerun} onContinue={p.onConnection} />;
      }
      return <DatabaseStep runtime={runtime} connection={p.connection} onConfigured={() => p.goTo('migrate')} recover={p.recover} />;
    case 'migrate':
      return <MigrateStep onDone={() => p.goTo('profile')} recover={p.recover} />;
    case 'profile':
      return <ProfileStep onDone={p.advance} recover={p.recover} />;
    case 'admin':
      return <AdminStep onDone={p.advance} recover={p.recover} />;
    case 'cron':
      return <CronStep runtime={runtime} onFinished={p.onFinished} recover={p.recover} />;
    case 'done':
      return <DoneStep next={p.next} />;
  }
}
