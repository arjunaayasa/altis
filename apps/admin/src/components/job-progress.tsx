import type { DashboardResponse } from '@altis/shared/api/dashboard';
import type { EventItem } from '@altis/shared/api/events';
import { JOB_STATUS_VALUES, type JobStatusValue, type JobView } from '@altis/shared/api/jobs';
import { useQueryClient } from '@tanstack/react-query';
import { useContext, useEffect, useRef, useState } from 'react';
import { Notice, NoticeAlert } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n';
import { meId } from '@/lib/access';
import { ApiError, api } from '@/lib/api';
import { problemText } from '@/lib/form-errors';
import { useApiQuery, useMe } from '@/lib/me';
import { RealtimeContext, useRealtime } from '@/lib/realtime';
import { JobStatusBadge, ProgressBar, hearsJob, isActive, jobKey, jobMessageText } from '@/screens/jobs/list';

/**
 * A job's progress, for the screens that start one (Phase 2: the import and export wizard, the SLiMS migration, the
 * index rebuild of Diagnostik, the duplicate scan): the status, a progress bar and the job's message, until the job
 * ends; then `onDone(status)` once.
 *
 * - **Live:** once the job was read, the component listens on `jobs.<id>` (lib/realtime.ts; subscribed only then,
 *   because a channel the caller may not read refuses the whole poll, §10.7) when the caller may read that channel:
 *   the job's creator or a holder of `system.jobs.read` ({@link hearsJob}). A holder of an interactive job's handler
 *   permission reads the job (C26/E22b: Diagnostik's rebuild the boot queued) but not its channel. A
 *   `job.progress`/`job.finished` event moves the bar and the status at once; inside the shell the job's query is also
 *   made stale and read again.
 * - **Polling fallback:** `GET jobs/:id` while the job has work ahead, every {@link JOB_POLL_MS} without a realtime
 *   client or without the job's channel, and every {@link JOB_POLL_FALLBACK_MS} with both (the stream may be down or
 *   refused); never after the end.
 * - **Drive:** where no worker runs the jobs (`scheduler.runner.mode` is not `worker`, §10.2), an `interactive` job
 *   (M33) of the caller, or one whose handler permission the caller holds (the job then carries its `payload`, C34),
 *   is advanced from the page with `POST jobs/:id/drive`, one slice after the other, as the backup download dialog
 *   does. A minute without movement stops the loop with a notice and "Jalankan sekarang" to start it again.
 */

/** The polling interval without a realtime client. */
export const JOB_POLL_MS = 2_000;
/** The polling interval with a realtime client: a fallback for a stream that is down or refused. */
export const JOB_POLL_FALLBACK_MS = 10_000;
/** The pause after a drive call that moved nothing. */
const DRIVE_IDLE_MS = 5_000;
/** The drive calls in a row that moved nothing (about a minute of them) after which the loop stops. */
const DRIVE_IDLE_LIMIT = 12;
/** Drive calls start at least this far apart. */
const DRIVE_MIN_GAP_MS = 1_000;

/** How a job ended. */
export type JobOutcome = Exclude<JobStatusValue, 'queued' | 'running'>;

export interface JobProgressProps {
  jobId: string;
  /** Called once when the job has ended: `succeeded`, `dead` (failed for good) or `cancelled`. */
  onDone(status: JobOutcome): void;
}

/** The progress of the job `jobId`; another job id starts afresh (its own subscription, drive loop and `onDone`). */
export function JobProgress({ jobId, onDone }: JobProgressProps) {
  return <Follow key={jobId} jobId={jobId} onDone={onDone} />;
}

/** `old` with what a `job.progress`/`job.finished` event says (its payload is `{status, progress?}`). */
function applyJobEvent(old: JobView | undefined, e: EventItem): JobView | undefined {
  if (old === undefined || (e.type !== 'job.progress' && e.type !== 'job.finished')) return old;
  const next = { ...old };
  const { status, progress } = e.payload;
  if (typeof status === 'string' && (JOB_STATUS_VALUES as readonly string[]).includes(status)) next.status = status as JobStatusValue;
  if (typeof progress === 'number' && Number.isFinite(progress)) next.progress = Math.max(0, Math.min(100, progress));
  return next;
}

/** A failed drive call worth trying again: no answer, a 5xx while the host restarts, a 429, a busy row. */
function mayPass(e: unknown): boolean {
  return !(e instanceof ApiError) || e.status >= 500 || e.status === 429 || e.code === 'TX_CONFLICT';
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

function Follow({ jobId, onDone }: JobProgressProps) {
  const t = useT();
  const me = useMe();
  const queryClient = useQueryClient();
  const hub = useContext(RealtimeContext);
  const path = `jobs/${encodeURIComponent(jobId)}`;
  /** The pace of the reads of `job`: the fallback one only while its channel is read (lib/realtime.ts, §10.7). */
  const pollFor = (job: JobView | undefined): number => (hub === null || (job !== undefined && !hearsJob(me, job)) ? JOB_POLL_MS : JOB_POLL_FALLBACK_MS);
  const query = useApiQuery<JobView>({
    queryKey: jobKey(jobId),
    path,
    // Reads nobody asked for (the page may stay open unattended): they never keep the session alive (§7.1).
    request: { background: true },
    // A refusal is the answer; only a lost connection is worth asking again.
    retry: (count, e) => !(e instanceof ApiError) && count < 2,
    refetchInterval: (q) =>
      q.state.data === undefined
        ? q.state.error instanceof ApiError
          ? false
          : pollFor(undefined)
        : isActive(q.state.data)
          ? pollFor(q.state.data)
          : false,
  });
  const job = query.data;

  // Only a job whose channel the caller may read: one refused channel refuses the tab's whole poll (§10.7).
  useRealtime(job === undefined || !hearsJob(me, job) ? [] : [`jobs.${jobId}`], (e) => {
    queryClient.setQueryData<JobView>(jobKey(jobId), (old) => applyJobEvent(old, e));
  });

  // ---- the end: onDone once --------------------------------------------------------------------------------------
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  });
  const reported = useRef(false);
  const status = job?.status;
  useEffect(() => {
    if (status === undefined || status === 'queued' || status === 'running' || reported.current) return;
    reported.current = true;
    onDoneRef.current(status);
  }, [status]);

  // ---- drive -------------------------------------------------------------------------------------------------------
  const mine = job !== undefined && job.createdBy !== null && job.createdBy === meId(me);
  const mayDrive = job !== undefined && job.interactive && isActive(job) && (mine || Object.prototype.hasOwnProperty.call(job, 'payload'));
  const dashboard = useApiQuery<DashboardResponse>({
    queryKey: ['dashboard'],
    path: 'dashboard',
    enabled: mayDrive,
    staleTime: 60_000,
    request: { background: true },
  });
  // Unknown to a caller without `system.jobs.read` (no `scheduler`): drive, as the job page does.
  const modeKnown = dashboard.data !== undefined || dashboard.isError;
  const external = modeKnown && dashboard.data?.scheduler?.runner.mode !== 'worker';
  /** The loop stopped after a minute without movement. */
  const [idle, setIdle] = useState(false);
  /** The loop stopped on a failure: its text ('' to say nothing) and whether it may be tried again. */
  const [stopped, setStopped] = useState<{ text: string; again: boolean } | null>(null);
  const driving = mayDrive && external && !idle && stopped === null;

  useEffect(() => {
    if (!driving) return;
    const run = new AbortController();
    void (async () => {
      let last = queryClient.getQueryData<JobView>(jobKey(jobId));
      let still = 0;
      try {
        while (!run.signal.aborted) {
          const began = Date.now();
          const next = await api<JobView>('POST', `${path}/drive`, undefined, { signal: run.signal });
          if (run.signal.aborted) return;
          queryClient.setQueryData<JobView>(jobKey(jobId), next);
          if (!isActive(next)) return;
          const moved =
            last === undefined || next.updatedAt !== last.updatedAt || next.status !== last.status || next.progress !== last.progress;
          last = next;
          if (moved) {
            still = 0;
            const elapsed = Date.now() - began;
            if (elapsed < DRIVE_MIN_GAP_MS) await pause(DRIVE_MIN_GAP_MS - elapsed, run.signal);
            continue;
          }
          still += 1;
          if (still >= DRIVE_IDLE_LIMIT) {
            setIdle(true);
            return;
          }
          await pause(DRIVE_IDLE_MS, run.signal);
          await whenVisible(run.signal);
        }
      } catch (e) {
        if (run.signal.aborted) return;
        // A release that stopped letting this job be driven: say nothing, the runner will take it.
        setStopped(e instanceof ApiError && e.code === 'JOB_NOT_INTERACTIVE' ? { text: '', again: false } : { text: problemText(t, e), again: mayPass(e) });
      }
    })();
    return () => run.abort();
  }, [driving, path, jobId, queryClient, t]);

  // ---- render ------------------------------------------------------------------------------------------------------
  if (job === undefined) {
    if (query.isError) {
      const notFound = query.error instanceof ApiError && query.error.code === 'NOT_FOUND';
      return <Notice kind="error">{notFound ? t('jobs.detail.not_found') : problemText(t, query.error)}</Notice>;
    }
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {t('shell.loading')}
      </p>
    );
  }

  const progress = job.status === 'succeeded' ? 100 : job.progress;
  const message = jobMessageText(t, job);
  return (
    <div data-slot="job-progress" className="grid gap-2">
      <div className="flex items-center justify-between gap-2 text-sm">
        <span role="status">
          <JobStatusBadge status={job.status} />
        </span>
        <span className="tabular-nums">{Math.round(progress)} %</span>
      </div>
      <ProgressBar value={progress} label={t('jobs.detail.progress')} />
      {message !== null && <p className="text-sm text-muted-foreground">{message}</p>}
      {job.status === 'dead' && job.lastError !== null && <p className="font-mono text-xs break-all text-muted-foreground">{job.lastError}</p>}
      {driving && isActive(job) && <p className="text-sm text-muted-foreground">{t('jobs.drive.running')}</p>}
      {idle && isActive(job) && (
        <NoticeAlert>
          <span>{t('jobs.drive.idle')}</span>{' '}
          <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={() => setIdle(false)}>
            {t('jobs.drive')}
          </Button>
        </NoticeAlert>
      )}
      {stopped !== null && stopped.text !== '' && isActive(job) && (
        <Notice
          kind="error"
          action={
            stopped.again ? (
              <Button type="button" variant="outline" size="sm" onClick={() => setStopped(null)}>
                {t('table.retry')}
              </Button>
            ) : undefined
          }
        >
          {stopped.text}
        </Notice>
      )}
    </div>
  );
}
