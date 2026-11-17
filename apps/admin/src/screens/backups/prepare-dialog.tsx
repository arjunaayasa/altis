import type { BackupItem, BackupPrepareBody, BackupPrepareResponse } from '@altis/shared/api/backups';
import type { DashboardResponse } from '@altis/shared/api/dashboard';
import type { EventItem } from '@altis/shared/api/events';
import { JOB_STATUS_VALUES, type JobStatusValue, type JobView } from '@altis/shared/api/jobs';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { CheckField, Field, Notice, NoticeAlert } from '@/components/form-field';
import { useReturnFocus } from '@/components/return-focus';
import { Callout } from '@/components/layout';
import { Button, buttonVariants } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useT, type AdminKey } from '@/i18n';
import { holds } from '@/lib/access';
import { ApiError, api } from '@/lib/api';
import { fieldErrorKey, problemText } from '@/lib/form-errors';
import { useApiQuery, useMe } from '@/lib/me';
import { useRealtime } from '@/lib/realtime';
import { DRIVE_IDLE_LIMIT, DRIVE_IDLE_MS, DRIVE_MIN_GAP_MS } from '@/screens/jobs/detail';
import { ProgressBar, isActive, jobKey, jobMessageText } from '@/screens/jobs/list';

/**
 * "Siapkan unduhan" of Cadangan (spec §9.9 "Download", §7.3; routes `backups.prepare_download`, `backups.download`,
 * `jobs.get`, `jobs.drive`, `jobs.cancel`; 1c Task 32): the dialog that has the server build an `.altisbak` archive of a
 * backup for the caller, then offers its download.
 *
 * 1. **The form.** A passphrase typed twice, at least 10 characters after NFKC (the server's rule, counted in code
 *    points), at most 512; or the explicit opt-in "Unduh tanpa enkripsi", which warns and hides the passphrase. Nothing
 *    is sent until the form is right. `POST backups/:id/prepare-download` is re-authenticated: the reauth dialog opens
 *    on top when the server asks (lib/api.ts), then the request goes again. A passphrase typed is never kept once the
 *    form is left.
 * 2. **A live preparation.** 409 BACKUP_PREPARE_IN_PROGRESS names the job still preparing this backup for the caller
 *    with other choices (its id is in the problem's detail): the dialog offers to wait for it (2b follows it, and its
 *    archive is the caller's to download) or, for a holder of `system.jobs.manage`, to cancel it.
 * 3. **Following the job.** `GET jobs/:id` (the caller created it), its `jobs.<id>` events (`job.progress`,
 *    `job.finished`), and a read every {@link FOLLOW_POLL_MS} while it runs. Where no runner is always on (the
 *    dashboard's `scheduler.runner.mode` is `external`, or unknown to the caller) the job is driven while the dialog is
 *    open (§10.2 `drive`: `POST jobs/:id/drive`, one slice ≤ 20 s per call, as the job page does): one call after the
 *    other while it moves (at least {@link DRIVE_MIN_GAP_MS} between their starts), {@link DRIVE_IDLE_MS} apart while
 *    it does not, not at all while the tab is hidden, and it stops after
 *    {@link DRIVE_IDLE_LIMIT} calls in a row that moved nothing ("Jalankan lagi" starts it again). Closing the dialog
 *    stops driving; the job itself goes on (worker, cron, or the dialog opened again).
 * 4. **Ready.** "Unduh arsip" links `GET /api/v1/backups/:id/download`: the browser downloads it (and resumes it with
 *    a Range request where it can). A failed job says so and offers "Siapkan lagi".
 */

/** How often a running job is read again besides its events (they are hints; a missed one costs this long). */
export const FOLLOW_POLL_MS = 5_000;

/**
 * Whether a failed drive call may pass if made again: no answer at all (the network), a 5xx (a host restarting its
 * process: 502/503), a 429, or a row busy for a moment (409 TX_CONFLICT). Any other refusal is the answer.
 */
function mayPass(e: unknown): boolean {
  return !(e instanceof ApiError) || e.status >= 500 || e.status === 429 || e.code === 'TX_CONFLICT';
}

/** A job id inside a problem's detail (a ULID). */
const ULID_IN_TEXT = /\b([0-9A-HJKMNP-TV-Z]{26})\b/;

/** The longest passphrase the server takes (UTF-16 units). */
const PASSPHRASE_MAX = 512;
/** The shortest passphrase the server takes, in code points after NFKC. */
const PASSPHRASE_MIN = 10;

/** The number of code points of `s` (a surrogate pair counts once). */
function codePoints(s: string): number {
  return Array.from(s).length;
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

/** The dialog for `backup` (kept by the list between openings); its content starts afresh at every opening. */
export function PrepareDownloadDialog({ backup, open, onClose }: { backup: BackupItem | null; open: boolean; onClose(): void }) {
  const t = useT();
  const focus = useReturnFocus();
  return (
    <Dialog open={open && backup !== null} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent closeLabel={t('backups.prepare.close')} onOpenAutoFocus={focus.onOpenAutoFocus} onCloseAutoFocus={focus.onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>{t('backups.prepare.title')}</DialogTitle>
          <DialogDescription>{t('backups.prepare.description')}</DialogDescription>
        </DialogHeader>
        {backup !== null && <PrepareBody backupId={backup.id} />}
      </DialogContent>
    </Dialog>
  );
}

/** The form, then the job it started (or the live job it waits for). */
function PrepareBody({ backupId }: { backupId: string }) {
  const [jobId, setJobId] = useState<string | null>(null);
  if (jobId !== null) return <PrepareFollow jobId={jobId} backupId={backupId} onAgain={() => setJobId(null)} />;
  return <PrepareForm backupId={backupId} onStarted={setJobId} />;
}

type FieldErrors = Partial<Record<'passphrase' | 'again', AdminKey>>;

function PrepareForm({ backupId, onStarted }: { backupId: string; onStarted(jobId: string): void }) {
  const t = useT();
  const me = useMe();
  const ids = { passphrase: useId(), again: useId(), error: useId() };
  const inputs = { passphrase: useRef<HTMLInputElement>(null), again: useRef<HTMLInputElement>(null) };
  const [passphrase, setPassphrase] = useState('');
  const [again, setAgain] = useState('');
  const [unencrypted, setUnencrypted] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The job still preparing this backup for the caller with other choices (409 BACKUP_PREPARE_IN_PROGRESS). */
  const [live, setLive] = useState<string | null>(null);

  /** The form's own checks; the first field in error gets the focus. */
  const check = (): boolean => {
    const found: FieldErrors = {};
    if (!unencrypted) {
      if (codePoints(passphrase.normalize('NFKC')) < PASSPHRASE_MIN) found.passphrase = 'backups.prepare.too_short';
      else if (passphrase.length > PASSPHRASE_MAX) found.passphrase = 'backups.prepare.too_long';
      else if (again !== passphrase) found.again = 'backups.prepare.mismatch';
    }
    setErrors(found);
    const first = found.passphrase !== undefined ? inputs.passphrase : found.again !== undefined ? inputs.again : null;
    first?.current?.focus();
    return first === null;
  };

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setError(null);
    setNotice(null);
    setLive(null);
    if (!check()) return;
    setBusy(true);
    try {
      const body: BackupPrepareBody = unencrypted ? { unencrypted: true } : { passphrase };
      const started = await api<BackupPrepareResponse>('POST', `backups/${encodeURIComponent(backupId)}/prepare-download`, body);
      onStarted(started.jobId);
    } catch (e) {
      const liveJob = e instanceof ApiError && e.code === 'BACKUP_PREPARE_IN_PROGRESS' ? ULID_IN_TEXT.exec(e.detail ?? '')?.[1] : undefined;
      const passphraseError = e instanceof ApiError && e.code === 'VALIDATION_FAILED' ? e.errors?.find((f) => f.path === 'passphrase') : undefined;
      if (liveJob !== undefined) {
        setLive(liveJob);
      } else if (passphraseError !== undefined && !unencrypted) {
        setErrors({ passphrase: passphraseError.code === 'too_small' ? 'backups.prepare.too_short' : fieldErrorKey(passphraseError.code) });
        inputs.passphrase.current?.focus();
      } else {
        setError(problemText(t, e));
      }
    } finally {
      setBusy(false);
    }
  };

  const cancelLive = async (): Promise<void> => {
    if (live === null) return;
    setBusy(true);
    setError(null);
    try {
      const after = await api<JobView>('POST', `jobs/${encodeURIComponent(live)}/cancel`);
      if (after.status === 'cancelled') {
        setLive(null);
        setNotice(t('backups.prepare.cancelled'));
      } else {
        setNotice(t('backups.prepare.cancel_requested'));
      }
    } catch (e) {
      setError(problemText(t, e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form noValidate className="grid gap-4" onSubmit={(e) => void submit(e)} aria-describedby={error === null ? undefined : ids.error}>
      {!unencrypted && (
        <>
          <Field id={ids.passphrase} label={t('backups.prepare.passphrase')} hint={t('backups.prepare.passphrase_hint')} error={errors.passphrase}>
            {(c) => (
              <Input
                {...c}
                ref={inputs.passphrase}
                type="password"
                autoComplete="new-password"
                value={passphrase}
                onChange={(e) => {
                  setPassphrase(e.target.value);
                  setErrors({});
                }}
              />
            )}
          </Field>
          <Field id={ids.again} label={t('backups.prepare.passphrase_again')} error={errors.again}>
            {(c) => (
              <Input
                {...c}
                ref={inputs.again}
                type="password"
                autoComplete="new-password"
                value={again}
                onChange={(e) => {
                  setAgain(e.target.value);
                  setErrors((current) => ({ ...(current.passphrase === undefined ? {} : { passphrase: current.passphrase }) }));
                }}
              />
            )}
          </Field>
        </>
      )}
      <CheckField
        label={t('backups.prepare.unencrypted')}
        hint={t('backups.prepare.unencrypted_hint')}
        checked={unencrypted}
        onChange={(e) => {
          setUnencrypted(e.target.checked);
          setErrors({});
        }}
      />
      {unencrypted && (
        <Callout tone="warn" title={t('backups.prepare.unencrypted_warning')} />
      )}
      {live !== null && (
        <Callout title={t('backups.prepare.in_progress', { job: live })}>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" disabled={busy} onClick={() => onStarted(live)}>
              {t('backups.prepare.wait')}
            </Button>
            {holds(me, 'system.jobs.manage') && (
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void cancelLive()}>
                {t('backups.prepare.cancel_job')}
              </Button>
            )}
            <Link to={`/admin/jobs/${encodeURIComponent(live)}`} className="text-sm font-semibold text-accent-text underline-offset-4 hover:underline">
              {t('backups.prepare.open_job')}
            </Link>
          </div>
        </Callout>
      )}
      {notice !== null && <NoticeAlert tone="success">{notice}</NoticeAlert>}
      {error !== null && (
        <p id={ids.error} role="alert" className="text-meta font-semibold text-bad">
          {error}
        </p>
      )}
      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline">
            {t('backups.prepare.close')}
          </Button>
        </DialogClose>
        <Button type="submit" disabled={busy}>
          {t('backups.prepare.submit')}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Follows (and, without a runner that is always on, drives) the job `jobId` until its archive is ready. */
function PrepareFollow({ jobId, backupId, onAgain }: { jobId: string; backupId: string; onAgain(): void }) {
  const t = useT();
  const queryClient = useQueryClient();
  const path = `jobs/${encodeURIComponent(jobId)}`;
  const query = useApiQuery<JobView>({
    queryKey: jobKey(jobId),
    path,
    // Reads nobody asked for (the dialog may stay open unattended): they never keep the session alive (§7.1).
    request: { background: true },
    // A refusal is the answer; only a lost connection is worth asking again.
    retry: (count, e) => !(e instanceof ApiError) && count < 2,
    // Read again while the job runs; not once it ended, nor once it was refused (gone, or not the caller's).
    refetchInterval: (q) =>
      q.state.data === undefined ? (q.state.error instanceof ApiError ? false : FOLLOW_POLL_MS) : isActive(q.state.data) ? FOLLOW_POLL_MS : false,
  });
  const job = query.data;
  // Subscribed once the job was read: a channel the caller may not read is a 403 for the whole poll (§10.7).
  useRealtime(job === undefined ? [] : [`jobs.${jobId}`], (e) => {
    queryClient.setQueryData<JobView>(jobKey(jobId), (old) => applyJobEvent(old, e));
  });

  const dashboard = useApiQuery<DashboardResponse>({
    queryKey: ['dashboard'],
    path: 'dashboard',
    staleTime: 60_000,
    request: { background: true },
  });
  const modeKnown = dashboard.data !== undefined || dashboard.isError;
  const external = modeKnown && dashboard.data?.scheduler?.runner.mode !== 'worker';
  const canStart = job !== undefined && isActive(job);
  /** The drive loop stopped after a minute without movement ("Jalankan lagi" starts it again). */
  const [idle, setIdle] = useState(false);
  /**
   * The drive loop stopped on a failure: its text ('' silently: the job is not interactive), and whether it may pass
   * (no answer, a 5xx while the host restarts, a 429, a busy row: "Jalankan lagi" starts the loop again).
   */
  const [stopped, setStopped] = useState<{ text: string; again: boolean } | null>(null);

  useEffect(() => {
    if (!external || !canStart || idle || stopped !== null) return;
    const run = new AbortController();
    void (async () => {
      let last: JobView | undefined;
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
        setStopped(e instanceof ApiError && e.code === 'JOB_NOT_INTERACTIVE' ? { text: '', again: false } : { text: problemText(t, e), again: mayPass(e) });
      }
    })();
    return () => run.abort();
  }, [external, canStart, idle, stopped, path, jobId, queryClient, t]);

  const close = (
    <DialogFooter>
      <DialogClose asChild>
        <Button type="button" variant="outline">
          {t('backups.prepare.close')}
        </Button>
      </DialogClose>
    </DialogFooter>
  );

  if (job === undefined) {
    return (
      <div className="grid gap-4">
        {query.isError ? (
          <Notice kind="error">{problemText(t, query.error)}</Notice>
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            {t('shell.loading')}
          </p>
        )}
        {close}
      </div>
    );
  }

  if (job.status === 'succeeded') {
    return (
      <div className="grid gap-4">
        <NoticeAlert tone="success">{t('backups.prepare.ready')}</NoticeAlert>
        <a href={`/api/v1/backups/${encodeURIComponent(backupId)}/download`} download className={buttonVariants({ className: 'self-start' })}>
          {t('backups.prepare.download')}
        </a>
        <p className="text-sm text-muted-foreground">{t('backups.prepare.ready_hint')}</p>
        {close}
      </div>
    );
  }

  if (!isActive(job)) {
    return (
      <div className="grid gap-4">
        <Notice
          kind="error"
          action={
            <Button type="button" variant="outline" size="sm" onClick={onAgain}>
              {t('backups.prepare.again')}
            </Button>
          }
        >
          {t('backups.prepare.failed')}
        </Notice>
        {job.lastError !== null && <p className="font-mono text-xs break-all text-muted-foreground">{job.lastError}</p>}
        {close}
      </div>
    );
  }

  const message = jobMessageText(t, job);
  return (
    <div className="grid gap-4">
      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-2 text-sm">
          <span role="status">{t('backups.prepare.working')}</span>
          <span className="tabular-nums">{Math.round(job.progress)} %</span>
        </div>
        <ProgressBar value={job.progress} label={t('backups.prepare.progress')} />
        {message !== null && <p className="text-sm text-muted-foreground">{message}</p>}
      </div>
      {external && stopped === null && !idle && <p className="text-sm text-muted-foreground">{t('backups.prepare.drive_hint')}</p>}
      {idle && (
        <NoticeAlert>
          <span>{t('backups.prepare.idle')}</span>{' '}
          <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={() => setIdle(false)}>
            {t('backups.prepare.resume')}
          </Button>
        </NoticeAlert>
      )}
      {stopped !== null && stopped.text !== '' && (
        <Notice
          kind="error"
          action={
            stopped.again ? (
              <Button type="button" variant="outline" size="sm" onClick={() => setStopped(null)}>
                {t('backups.prepare.resume')}
              </Button>
            ) : undefined
          }
        >
          {stopped.text}
        </Notice>
      )}
      {close}
    </div>
  );
}
