import type { PeriodView } from '@altis/shared/api/accreditation';
import { Link } from '@tanstack/react-router';
import { useState, type JSX } from 'react';
import { ProblemAlert } from '@/components/form-field';
import { LAYER, StatusText, Tag } from '@/components/layout';
import { JobProgress, type JobOutcome } from '@/components/job-progress';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { periodPath, useFormats, useRefreshPeriods } from '@/screens/accreditation/data';

/** What `POST accreditation/periods/:id/evaluate` answers: the evaluation job (an already running one is joined). */
interface EvaluateStarted {
  jobId: string;
  existing: boolean;
}

/**
 * The status line of a period: when the catalogue was last synced from SLiMS (with the way to the migration wizard in
 * sync mode, which runs the sync for a user who may migrate), when the results were computed and whether something changed since ("basi"),
 * "Hitung ulang" with the evaluation's progress, and the reminder that catalogue edits are not tracked, so the results
 * are computed again by hand after them.
 *
 * Every reader of the workspace may start an evaluation. When its job ends, every period query is read again (the
 * period's time and stale mark, its results, the list).
 */
export function StatusLine({ period }: { period: PeriodView }): JSX.Element {
  const t = useT();
  const f = useFormats();
  const refresh = useRefreshPeriods();
  const [jobId, setJobId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);
  const [ended, setEnded] = useState<JobOutcome | null>(null);

  const start = async (): Promise<void> => {
    setBusy(true);
    setProblem(null);
    setEnded(null);
    try {
      const started = await api<EvaluateStarted>('POST', periodPath(period.id, '/evaluate'), {});
      setJobId(started.jobId);
    } catch (e) {
      setProblem(e);
    } finally {
      setBusy(false);
    }
  };

  const done = (status: JobOutcome): void => {
    // A finished evaluation needs no bar: the time below says it. A failed one keeps its progress and message.
    if (status === 'succeeded') setJobId(null);
    setEnded(status);
    void refresh();
  };

  const running = jobId !== null && ended === null;
  return (
    <section aria-label={t('accreditation.status.title')} className={cn('grid gap-2 rounded-lg border px-3.5 py-3 text-sm', LAYER)}>
      {period.catalogSyncedAt !== null && (
        <p>
          {t('accred.note.catalogue_synced', { date: f.dateTime(period.catalogSyncedAt) })}{' '}
          <Link to="/admin/catalog/migration" search={{ catalogMode: 'sync' }} className="font-semibold text-accent-text underline-offset-4 hover:underline">
            {t('accreditation.status.sync_link')}
          </Link>
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {period.computedAt === null ? (
          <span>{t('accreditation.status.never')}</span>
        ) : (
          <span>{t('accreditation.status.computed', { time: f.dateTime(period.computedAt) })}</span>
        )}
        {period.computedAt !== null && period.stale && (
          <Tag tone="warn" title={t('accreditation.status.stale_hint')}>
            {t('accreditation.status.stale')}
          </Tag>
        )}
        <Button type="button" size="sm" variant="outline" className="ml-auto bg-background" disabled={busy || running} onClick={() => void start()}>
          {t(busy || running ? 'accreditation.status.recomputing' : 'accreditation.status.recompute')}
        </Button>
      </div>
      <ProblemAlert error={problem} />
      {jobId !== null && <JobProgress jobId={jobId} onDone={done} />}
      {ended !== null && ended !== 'succeeded' && (
        <p role="status">
          <StatusText tone="bad">{t('accreditation.status.recompute_failed')}</StatusText>
        </p>
      )}
      <p className="text-meta text-muted-foreground">{t('accred.note.recompute_after_catalogue')}</p>
    </section>
  );
}
