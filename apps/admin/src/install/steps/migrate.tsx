import type { MigrateResponse, ProgressResponse } from '@altis/shared/api/install';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { installApi } from '../api';
import { useInstallT } from '../i18n';
import { ProblemAlert, StepHeading, sleep } from '../ui';

// Step 2, the tables (spec §9.5 step 2: "Browser memanggil POST install/api/migrate berulang (satu migrateUp() per
// panggilan, ≤ 20 detik) sampai selesai"): `GET progress` for the count, then `POST migrate` until it answers
// `done: true` (the server then writes the seeds and moves installState to `profile`). A call that applied nothing
// (another process holds the migration lock) waits a second before the next. The bar shows the migrations applied;
// a failure stops with its problem and "Coba lagi" goes on from where the database stands.

/** The wait after a call that applied nothing. */
const IDLE_WAIT_MS = 1000;

type State = { status: 'running' } | { status: 'done' } | { status: 'failed'; error: unknown };

export function MigrateStep({ onDone, recover }: { onDone(): void; recover(error: unknown): Promise<boolean> }) {
  const t = useInstallT();
  const [state, setState] = useState<State>({ status: 'running' });
  const [counts, setCounts] = useState<{ applied: number; total: number }>({ applied: 0, total: 0 });
  const run = useRef<AbortController | null>(null);

  const start = useCallback(() => {
    run.current?.abort();
    const controller = new AbortController();
    run.current = controller;
    const { signal } = controller;
    setState({ status: 'running' });
    void (async () => {
      try {
        const progress = await installApi<ProgressResponse>('GET', 'progress', undefined, { signal });
        const total = progress.migrations.total;
        let applied = progress.migrations.applied;
        setCounts({ applied, total });
        for (;;) {
          const answer = await installApi<MigrateResponse>('POST', 'migrate', undefined, { signal });
          if (answer.done) {
            setCounts({ applied: total, total });
            setState({ status: 'done' });
            return;
          }
          applied = Math.max(applied, total - answer.remaining);
          setCounts({ applied, total });
          if (answer.applied === null) await sleep(IDLE_WAIT_MS, signal);
        }
      } catch (error) {
        if (signal.aborted) return;
        if (!(await recover(error))) setState({ status: 'failed', error });
      }
    })();
  }, [recover]);

  useEffect(() => {
    start();
    return () => run.current?.abort();
  }, [start]);

  const percent = state.status === 'done' ? 100 : counts.total > 0 ? Math.min(99, Math.round((counts.applied / counts.total) * 100)) : 0;

  return (
    <div className="space-y-6">
      <StepHeading title={t('migrate.title')} intro={t('migrate.keep_open')} />
      <div className="space-y-2">
        <progress className="h-2 w-full overflow-hidden rounded-full accent-primary" value={percent} max={100} aria-label={t('migrate.progress_label')} />
        <p className="text-sm" aria-live="polite">
          {state.status === 'done' ? t('migrate.done') : t('migrate.running', { applied: counts.applied, total: counts.total })}
        </p>
      </div>
      {state.status === 'failed' ? (
        <div className="space-y-3">
          <p className="text-sm font-medium text-destructive">{t('migrate.failed')}</p>
          <ProblemAlert error={state.error} />
          <Button type="button" onClick={start}>
            {t('app.retry')}
          </Button>
        </div>
      ) : null}
      {state.status === 'done' ? (
        <div className="border-t pt-4">
          <Button type="button" onClick={onDone}>
            {t('app.next')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
