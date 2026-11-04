import type { EventItem } from '@altis/shared/api/events';
import { JOB_STATUS_VALUES, type JobStatusValue, type JobView } from '@altis/shared/api/jobs';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { ArrowLeftIcon, PlayIcon, RotateCcwIcon, SquareIcon, XIcon } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useDateTime } from '@/components/data-table';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { JOB_POLL_MS } from '@/components/job-progress';
import { Notice, NoticeAlert, ProblemAlert } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n';
import { holds, meId } from '@/lib/access';
import { ApiError, api, inBackground } from '@/lib/api';
import { problemText } from '@/lib/form-errors';
import { useApiQuery, useMe } from '@/lib/me';
import { useRealtime } from '@/lib/realtime';
import { JobStatusBadge, ProgressBar, hearsJob, isActive, jobKey, jobMessageText, jobTypeLabel } from './list';

/**
 * A job's page (spec §13.3 "detail, ulangi/batalkan (§10.5)", §10.2; routes `jobs.get`, `jobs.retry`, `jobs.cancel`,
 * `jobs.drive`; decision C34): what the job is doing, live, and what the caller may do with it.
 *
 * - **Live progress:** while the page is open it reads the job's channel `jobs.<id>` (lib/realtime.ts `useRealtime`;
 *   subscribed only once the job was read, because the channel of a job the caller may not see is a 403 for the
 *   whole poll, §10.7). A `job.progress` or `job.finished` event moves the bar and the status at once from its payload
 *   (`{status, progress?}`); the shell also makes the job's query stale, so the page then reads the whole job again.
 *   The channel is the creator's and `system.jobs.read`'s ({@link hearsJob}); a holder of an interactive job's handler
 *   permission, whom `GET jobs/:id` also answers (C26/E22b), is not subscribed and reads the job again every
 *   {@link JOB_POLL_MS} while it has work ahead (and the tab is visible) instead. Those reads are the page's own, not
 *   the user's, so they go out in the background ({@link inBackground}): a page left open on a job that never moves
 *   (backing off, its runner stuck) must not keep the session alive past its idle limit (§7.1). The page's first read
 *   stays the user's.
 * - **Ulangi** (`POST jobs/:id/retry`): for a holder of `system.jobs.manage`, on a failed or cancelled job whose
 *   handler allows a retry from the API (`retryable: 'api'`; an `origin-only` job is retried only where it started,
 *   §10.5). **Batalkan** (`POST jobs/:id/cancel`, after a confirmation): for the same holder while the job has work
 *   ahead, disabled when the job says it is not `cancellable` (past its point of no return, or a cancel already
 *   asked). The server also checks the handler's permission and answers 403 for a job type the caller may not touch.
 * - **Jalankan sekarang** (`POST jobs/:id/drive`, §10.2 mode `drive`): for an `interactive` job (its handler lets
 *   drive advance it, M33) where no runner is always on (`auth/me`'s `client.runner` is `external`, which every staff
 *   user gets, 1d T31-RUNNER-MODE-FOR-ALL-STAFF; unknown counts as not), the creator of an unfinished job, or a holder
 *   of its handler's permission (the job then shows its `payload`, C34), may advance it from this page: one drive call
 *   after the other, each one slice of ≤ 20 s, their starts at least {@link DRIVE_MIN_GAP_MS} apart, while the page
 *   stays open
 *   ("Hentikan" or leaving the page stops it). A call that changed nothing (the job is not due yet, or another runner
 *   holds it) waits {@link DRIVE_IDLE_MS} before the next, and while the tab is hidden it waits until the tab is
 *   visible again; after {@link DRIVE_IDLE_LIMIT} such calls in a row the loop stops and says so (each call is a write
 *   that keeps the session alive: an unattended page must not defeat the session idle timeout for hours, §7.1), and
 *   "Jalankan sekarang" starts it again.
 *   A job only the background runner may run is never offered; should the server still answer 409
 *   `JOB_NOT_INTERACTIVE` (a release that changed in between), the loop ends, says so, and hides the button for the
 *   rest of the visit.
 */

/** The pause after a drive call that moved nothing. */
export const DRIVE_IDLE_MS = 5_000;
/** The drive calls in a row that moved nothing (about a minute of them) after which the loop stops. */
export const DRIVE_IDLE_LIMIT = 12;
/** Drive calls start at least this far apart: a call that came back quickly with movement (a short slice) is not followed at once. */
export const DRIVE_MIN_GAP_MS = 1_000;

/** The job's id from the route (`/admin/jobs/$jobId`). */
function useJobId(): string {
  const { jobId = '' } = useParams({ strict: false }) as { jobId?: string };
  return jobId;
}

/** `old` with what a `job.progress`/`job.finished` event says (its payload is `{status, progress?}`). */
function applyEvent(old: JobView | undefined, e: EventItem): JobView | undefined {
  if (old === undefined || (e.type !== 'job.progress' && e.type !== 'job.finished')) return old;
  const next = { ...old };
  const { status, progress } = e.payload;
  if (typeof status === 'string' && (JOB_STATUS_VALUES as readonly string[]).includes(status)) next.status = status as JobStatusValue;
  if (typeof progress === 'number' && Number.isFinite(progress)) next.progress = Math.max(0, Math.min(100, progress));
  return next;
}

/** Resolves after `ms`, or at once when `signal` aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/** Resolves once the document is visible (at once when it is), or when `signal` aborts. */
function whenVisible(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (!document.hidden || signal.aborted) {
      resolve();
      return;
    }
    function check(): void {
      if (document.hidden && !signal.aborted) return;
      document.removeEventListener('visibilitychange', check);
      signal.removeEventListener('abort', check);
      resolve();
    }
    document.addEventListener('visibilitychange', check);
    signal.addEventListener('abort', check);
  });
}

function BackLink() {
  const t = useT();
  return (
    <Link to="/admin/jobs" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
      <ArrowLeftIcon className="size-4" aria-hidden="true" />
      {t('jobs.detail.back')}
    </Link>
  );
}

/** One row of the facts list. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[12rem_1fr] sm:gap-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-sm break-words">{children}</dd>
    </div>
  );
}

type Outcome = { kind: 'success' | 'error' | 'info'; text: string } | null;

/**
 * `/admin/jobs/$jobId`. The router keeps this screen mounted when only the job id changes (a notification link, the
 * browser's history), so the page of one job is keyed by its id: its state (a 409, a notice, a confirmation) and its
 * drive loop end with it, and the next job's page starts afresh.
 */
export function JobDetailScreen() {
  const id = useJobId();
  return <JobDetail key={id} id={id} />;
}

/** The page of the job `id`. */
function JobDetail({ id }: { id: string }) {
  const t = useT();
  const me = useMe();
  const dateTime = useDateTime();
  const queryClient = useQueryClient();
  const factsId = useId();
  const path = `jobs/${encodeURIComponent(id)}`;
  // A refusal (404 for a job the caller may not see) is the answer; only a lost connection is worth asking again.
  const query = useApiQuery<JobView>({
    queryKey: jobKey(id),
    path,
    retry: (count, e) => !(e instanceof ApiError) && count < 2,
  });
  const job = query.data;

  // Without the job's channel (below), the job is read again while it has work ahead: in the background, because
  // nobody asked for these reads and they must not keep the session alive (§7.1). A read still on its way is not
  // cancelled for the next one, and a hidden tab is not read (as TanStack Query's own interval would not).
  const polls = job !== undefined && isActive(job) && !hearsJob(me, job);
  const { refetch } = query;
  useEffect(() => {
    if (!polls) return;
    const timer = setInterval(() => {
      if (!document.hidden) inBackground(() => void refetch({ cancelRefetch: false }));
    }, JOB_POLL_MS);
    return () => clearInterval(timer);
  }, [polls, refetch]);

  // Only a job whose channel the caller may read: one refused channel refuses the tab's whole poll (§10.7).
  useRealtime(job === undefined || !hearsJob(me, job) ? [] : [`jobs.${id}`], (e) => {
    queryClient.setQueryData<JobView>(jobKey(id), (old) => applyEvent(old, e));
  });

  const [outcome, setOutcome] = useState<Outcome>(null);
  const [busy, setBusy] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);

  // ---- drive (Jalankan sekarang) -------------------------------------------------------------------------------
  const [driving, setDriving] = useState(false);
  const [notInteractive, setNotInteractive] = useState(false);
  const driveRun = useRef<AbortController | null>(null);
  useEffect(() => () => driveRun.current?.abort(), []);

  const manage = holds(me, 'system.jobs.manage');
  const mine = job !== undefined && job.createdBy !== null && job.createdBy === meId(me);
  const mayDrive =
    job !== undefined && job.interactive && isActive(job) && !notInteractive && (mine || Object.prototype.hasOwnProperty.call(job, 'payload'));
  const externalRunner = me !== undefined && me.authenticated && me.client?.runner === 'external';
  const offerDrive = mayDrive && externalRunner;

  const stopDriving = (): void => {
    driveRun.current?.abort();
  };

  const drive = async (): Promise<void> => {
    if (driveRun.current !== null) return;
    const run = new AbortController();
    driveRun.current = run;
    setDriving(true);
    setOutcome(null);
    try {
      let last = queryClient.getQueryData<JobView>(jobKey(id));
      let idle = 0;
      while (!run.signal.aborted) {
        const began = Date.now();
        const next = await api<JobView>('POST', `${path}/drive`, undefined, { signal: run.signal });
        queryClient.setQueryData<JobView>(jobKey(id), next);
        if (!isActive(next)) break;
        const moved = last === undefined || next.updatedAt !== last.updatedAt || next.status !== last.status || next.progress !== last.progress;
        last = next;
        if (moved) {
          idle = 0;
          const elapsed = Date.now() - began;
          if (elapsed < DRIVE_MIN_GAP_MS) await pause(DRIVE_MIN_GAP_MS - elapsed, run.signal);
          continue;
        }
        idle += 1;
        if (idle >= DRIVE_IDLE_LIMIT) {
          setOutcome({ kind: 'info', text: t('jobs.drive.idle') });
          break;
        }
        await pause(DRIVE_IDLE_MS, run.signal);
        await whenVisible(run.signal);
      }
    } catch (e) {
      if (run.signal.aborted) return;
      if (e instanceof ApiError && e.code === 'JOB_NOT_INTERACTIVE') setNotInteractive(true);
      setOutcome({ kind: 'error', text: problemText(t, e) });
    } finally {
      if (driveRun.current === run) driveRun.current = null;
      setDriving(false);
    }
  };

  // ---- retry and cancel --------------------------------------------------------------------------------------------
  const afterChange = (next: JobView): void => {
    queryClient.setQueryData<JobView>(jobKey(id), next);
    void queryClient.invalidateQueries({ queryKey: ['jobs', 'list'] });
  };

  const retry = async (): Promise<void> => {
    setBusy(true);
    setOutcome(null);
    try {
      afterChange(await api<JobView>('POST', `${path}/retry`));
      setOutcome({ kind: 'success', text: t('jobs.retry.done') });
    } catch (e) {
      setOutcome({ kind: 'error', text: problemText(t, e) });
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (): Promise<void> => {
    const next = await api<JobView>('POST', `${path}/cancel`);
    afterChange(next);
    setOutcome({ kind: 'success', text: t(next.status === 'cancelled' ? 'jobs.cancel.done' : 'jobs.cancel.requested') });
  };

  // ---- render ------------------------------------------------------------------------------------------------------
  if (job === undefined) {
    return (
      <div className="flex max-w-3xl flex-col gap-6">
        <BackLink />
        {query.isError ? (
          query.error instanceof ApiError && query.error.code === 'NOT_FOUND' ? (
            <Notice kind="error">{t('jobs.detail.not_found')}</Notice>
          ) : (
            <ProblemAlert error={query.error}>
              <Button variant="outline" size="sm" className="mt-2" onClick={() => void query.refetch()}>
                {t('table.retry')}
              </Button>
            </ProblemAlert>
          )
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            {t('shell.loading')}
          </p>
        )}
      </div>
    );
  }

  const offerRetry = manage && job.retryable === 'api' && (job.status === 'dead' || job.status === 'cancelled');
  const offerCancel = manage && isActive(job);
  const by = job.createdBy === null ? t('jobs.detail.by_system') : mine ? t('jobs.detail.by_you') : job.createdBy;
  const hasPayload = Object.prototype.hasOwnProperty.call(job, 'payload');
  const message = jobMessageText(t, job);

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <BackLink />
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">{jobTypeLabel(t, job.type)}</h1>
          <JobStatusBadge status={job.status} />
        </div>
        <p className="font-mono text-xs text-muted-foreground">{job.type}</p>
      </header>

      <section className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-2 text-sm">
          <span className="font-medium">{t('jobs.detail.progress')}</span>
          <span className="tabular-nums">{Math.round(job.progress)} %</span>
        </div>
        <ProgressBar value={job.progress} label={t('jobs.detail.progress')} />
        {message !== null && <p className="text-sm text-muted-foreground">{message}</p>}
      </section>

      {(offerRetry || offerCancel || offerDrive || driving) && (
        <div className="flex flex-wrap gap-2">
          {offerRetry && (
            <Button disabled={busy} onClick={() => void retry()}>
              <RotateCcwIcon aria-hidden="true" />
              {t('jobs.retry')}
            </Button>
          )}
          {(offerDrive || driving) &&
            (driving ? (
              <Button variant="outline" onClick={stopDriving}>
                <SquareIcon aria-hidden="true" />
                {t('jobs.drive.stop')}
              </Button>
            ) : (
              <Button onClick={() => void drive()}>
                <PlayIcon aria-hidden="true" />
                {t('jobs.drive')}
              </Button>
            ))}
          {offerCancel && (
            <Button variant="outline" disabled={busy || !job.cancellable} onClick={() => setConfirmCancel(true)}>
              <XIcon aria-hidden="true" />
              {t('jobs.cancel')}
            </Button>
          )}
        </div>
      )}
      {offerCancel && !job.cancellable && <p className="text-sm text-muted-foreground">{t('jobs.cancel.unavailable')}</p>}
      {driving ? (
        <NoticeAlert>{t('jobs.drive.running')}</NoticeAlert>
      ) : (
        offerDrive && <p className="text-sm text-muted-foreground">{t('jobs.drive.hint')}</p>
      )}
      {outcome !== null &&
        (outcome.kind === 'info' ? <NoticeAlert>{outcome.text}</NoticeAlert> : <Notice kind={outcome.kind}>{outcome.text}</Notice>)}

      <section aria-labelledby={factsId} className="flex flex-col gap-3 rounded-lg border bg-card p-4">
        <h2 id={factsId} className="sr-only">
          {t('jobs.detail.facts')}
        </h2>
        <dl className="flex flex-col gap-3">
          <Fact label={t('jobs.detail.id')}>
            <span className="font-mono text-xs">{job.id}</span>
          </Fact>
          <Fact label={t('jobs.detail.attempts')}>{t('jobs.attempts', { attempts: job.attempts, max: job.maxAttempts })}</Fact>
          <Fact label={t('jobs.detail.created_by')}>
            <span className={job.createdBy !== null && !mine ? 'font-mono text-xs' : undefined}>{by}</span>
          </Fact>
          <Fact label={t('jobs.detail.created')}>{dateTime(job.createdAt)}</Fact>
          <Fact label={t('jobs.detail.run_at')}>{dateTime(job.runAt)}</Fact>
          <Fact label={t('jobs.detail.updated')}>{dateTime(job.updatedAt)}</Fact>
          {job.finishedAt !== null && <Fact label={t('jobs.detail.finished')}>{dateTime(job.finishedAt)}</Fact>}
          {job.lastError !== null && (
            <Fact label={t('jobs.detail.last_error')}>
              <span className="font-mono text-xs break-all">{job.lastError}</span>
            </Fact>
          )}
          {hasPayload && (
            <Fact label={t('jobs.detail.payload')}>
              <details>
                <summary className="cursor-pointer text-primary">{t('jobs.detail.payload_show')}</summary>
                <pre className="mt-1 overflow-x-auto rounded bg-muted p-2 text-xs break-all whitespace-pre-wrap">
                  {JSON.stringify(job.payload, null, 2)}
                </pre>
              </details>
            </Fact>
          )}
        </dl>
      </section>

      <ConfirmDialog
        open={confirmCancel}
        title={t('jobs.cancel.title')}
        description={t('jobs.cancel.description')}
        confirmLabel={t('jobs.cancel.confirm')}
        destructive
        onConfirm={cancel}
        onClose={() => setConfirmCancel(false)}
      />
    </div>
  );
}
