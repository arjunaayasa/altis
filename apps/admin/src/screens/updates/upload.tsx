import {
  PRECHECK_FAILURE_VIEWS,
  type PrecheckFailureView,
  type PrecheckReportView,
  type UpdateOpResponse,
  type UpdateUploadBody,
  type UpdateUploadDryRun,
} from '@altis/shared/api/updates';
import { CircleCheckIcon, CircleXIcon, InfoIcon, PackageCheckIcon, UploadIcon, XIcon } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { NoticeAlert, ProblemAlert } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useLocale, useT, type AdminKey, type Translate } from '@/i18n';
import { ApiError, OPS_PAGE_PATH, api } from '@/lib/api';
import { page } from '@/lib/page';
import { uploadFile } from '@/lib/upload';
import { useBytes } from '@/screens/backups/upload';
import { ProgressBar } from '@/screens/jobs/list';
import { SettingsSection } from '@/screens/settings/library';

/**
 * The parts of Pembaruan (screens/updates/updates.tsx; spec §13.3, §9.6; 1d Task 30) that both the release the update
 * check found and an uploaded package show, and "Unggah paket":
 *
 * - {@link PrecheckList}: the prechecks of a release (§9.6 step 2): each failure's shared `update.precheck.<failure>`
 *   text (with the stepping-stone release to install first, or why this edition does not cover it), the stepping-stone
 *   note, "pemulihan DB diperlukan bila gagal", the estimated maintenance time and the free space needed.
 * - {@link refusalText}: what the `reason` of a refused update means (UPDATE_PACKAGE_INVALID, UPDATE_PRECHECK_FAILED,
 *   UPDATE_NOT_ENTITLED).
 * - {@link PackageUploadPanel} (§9.6 step 7 "unggah berpotongan → verifikasi tanda tangan → masuk mulai langkah 2 (pra-cek,
 *   hak update) → reauth"; decision D1d-31): the release zip goes up through the adaptive chunked upload of
 *   lib/upload.ts (context `update`), then `POST updates/upload {uploadId, dryRun: true}` verifies its signature and
 *   runs its prechecks without beginning anything (reauth: the API client opens the password dialog when the server
 *   asks). The report is shown; "Pasang versi <v>" (only when every precheck passed) sends the same `uploadId` without
 *   `dryRun`, which begins the `update` op (preflight B5: the dry run left the upload in place), and the page loads the
 *   operations page `/admin/_update` with the `altis_ops` cookie the answer set. "Batal" drops the upload
 *   (`DELETE files/uploads/:id`, errors ignored: it expires on its own after 24 hours), and so does leaving the page
 *   before an install was asked for, so it does not hold one of the uploader's three slots; an upload an install may
 *   have begun with is never dropped (the op's `checking` step takes it). A dry run that failed or was cancelled (the
 *   password dialog cancelled, a refusal) keeps the completed upload: "Periksa lagi" checks it again without sending
 *   the file again. "Batalkan unggahan" (and leaving the page) aborts the upload; lib/upload.ts then deletes its
 *   session.
 */

const KNOWN_FAILURES: ReadonlySet<string> = new Set(PRECHECK_FAILURE_VIEWS);

const isKnownFailure = (value: string): value is PrecheckFailureView => KNOWN_FAILURES.has(value);

/** The text of a precheck failure: its shared `update.precheck.<failure>`, or the word as written for one unknown here. */
export function failureText(t: Translate, failure: string): string {
  return isKnownFailure(failure) ? t(`update.precheck.${failure}`) : failure;
}

/** The reasons of UPDATE_PACKAGE_INVALID (core's updates/package.ts), each with its explanation. */
const PACKAGE_REASONS: Readonly<Record<string, AdminKey>> = Object.freeze({
  entry: 'updates.upload.invalid.entry',
  hash: 'updates.upload.invalid.hash',
  bomb: 'updates.upload.invalid.bomb',
  signature: 'updates.upload.invalid.signature',
  manifest: 'updates.upload.invalid.manifest',
  keyset: 'updates.upload.invalid.keyset',
  version: 'updates.upload.invalid.version',
  mismatch: 'updates.upload.invalid.mismatch',
});

/**
 * The reasons of UPDATE_NOT_ENTITLED (`notEntitled`), each with its explanation: the edition seam (ruling R14). The
 * community edition covers every release, so it never answers them; a commercial edition may.
 */
const ENTITLEMENT_REASONS: Readonly<Record<string, AdminKey>> = Object.freeze({
  released_after: 'updates.prechecks.released_after',
  no_license: 'updates.prechecks.no_license',
});

const own = (table: object, key: string): boolean => Object.prototype.hasOwnProperty.call(table, key);

/** What the `reason` of a refused update means, or null (another problem, or a reason this build does not know). */
export function refusalText(t: Translate, error: unknown): string | null {
  if (!(error instanceof ApiError) || error.reason === undefined) return null;
  const { code, reason } = error;
  if (code === 'UPDATE_PACKAGE_INVALID') return own(PACKAGE_REASONS, reason) ? t(PACKAGE_REASONS[reason]!) : null;
  if (code === 'UPDATE_NOT_ENTITLED') return own(ENTITLEMENT_REASONS, reason) ? t(ENTITLEMENT_REASONS[reason]!) : null;
  if (code === 'UPDATE_PRECHECK_FAILED') return isKnownFailure(reason) ? t(`update.precheck.${reason}`) : null;
  return null;
}

/** A refused update action: the code's message and, when the reason is known, what it means. */
export function RefusalAlert({ error }: { error: unknown }) {
  const t = useT();
  const reason = refusalText(t, error);
  return <ProblemAlert error={error}>{reason === null ? null : <p>{reason}</p>}</ProblemAlert>;
}

/** A release day (`YYYY-MM-DD`, a calendar day) as the UI language writes a date. */
export function useReleaseDay(): (ymd: string) => string {
  const locale = useLocale();
  return useCallback(
    (ymd: string) => {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
      if (m === null) return ymd;
      const tag = locale === 'en' ? 'en-GB' : 'id-ID';
      return new Intl.DateTimeFormat(tag, { dateStyle: 'long', timeZone: 'UTC' }).format(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    },
    [locale],
  );
}

/** The estimated maintenance time in whole minutes, at least one. */
const minutesOf = (ms: number): number => Math.max(1, Math.ceil(ms / 60_000));

/**
 * The prechecks of a release: "Semua pemeriksaan awal lolos" or each failure, then the notes. `id` names the whole
 * list (a button it explains points at it with `aria-describedby`); `latest` is the newest release the update check
 * saw, named beside the stepping-stone note.
 */
export function PrecheckList({ report, id, latest = null }: { report: PrecheckReportView; id?: string; latest?: string | null }) {
  const t = useT();
  const bytes = useBytes();
  const entitlement = report.notEntitled === null ? null : t(ENTITLEMENT_REASONS[report.notEntitled]!);
  return (
    <div id={id} className="flex flex-col gap-2 text-sm">
      {report.ok ? (
        <p className="flex items-start gap-2">
          <CircleCheckIcon className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
          <span>{t('updates.prechecks.ok')}</span>
        </p>
      ) : (
        <ul aria-label={t('updates.prechecks.label')} className="flex flex-col gap-1.5">
          {report.failures.map((failure) => (
            <li key={failure} className="flex items-start gap-2">
              <CircleXIcon className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
              <span>
                {failureText(t, failure)}
                {failure === 'min_upgrade_from' && <> {t('updates.prechecks.stepping_stone', { version: report.candidate.minUpgradeFrom })}</>}
                {failure === 'entitlement' && entitlement !== null && <> {entitlement}</>}
              </span>
            </li>
          ))}
        </ul>
      )}
      <ul className="flex flex-col gap-1.5 text-muted-foreground">
        {report.steppingStone && (
          <li className="flex items-start gap-2">
            <InfoIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>
              {t('update.precheck.stepping_stone')}
              {latest !== null && <> {t('updates.available.latest', { version: latest })}</>}
            </span>
          </li>
        )}
        {report.dbRestoreNeeded && (
          <li className="flex items-start gap-2 text-foreground">
            <InfoIcon className="mt-0.5 size-4 shrink-0 text-warning-foreground" aria-hidden="true" />
            <span className="font-medium">{t('update.precheck.db_restore_needed')}</span>
          </li>
        )}
        <li className="flex items-start gap-2">
          <InfoIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{t('update.precheck.estimate', { minutes: minutesOf(report.estimateMs) })}</span>
        </li>
        {report.headroomBytes > 0 && (
          <li className="flex items-start gap-2">
            <InfoIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>{t('updates.prechecks.headroom', { size: bytes(report.headroomBytes) })}</span>
          </li>
        )}
      </ul>
    </div>
  );
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'hashing' | 'sending'; done: number; total: number }
  | { kind: 'checking' }
  | { kind: 'applying' };

/** Deletes the completed upload `uploadId`: one try, errors ignored (it expires on its own after 24 hours). */
async function dropUpload(uploadId: string): Promise<void> {
  try {
    await api<void>('DELETE', `files/uploads/${uploadId}`);
  } catch {
    // Gone already, or the server is away: the staged upload expires by itself.
  }
}

/**
 * "Unggah paket pembaruan" (see the top of this file), for a holder of `system.update.run` while one-click updates are
 * offered (not in image mode, §9.8). `blocked`: an update or rollback op runs, so nothing can be installed now.
 */
export function PackageUploadPanel({ blocked }: { blocked: boolean }) {
  const t = useT();
  const day = useReleaseDay();
  const bytes = useBytes();
  const fileId = useId();
  const reportId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  /** A completed upload that is not installed yet: its dry run may be run again, or it may be installed. */
  const [uploaded, setUploaded] = useState<string | null>(null);
  const [report, setReport] = useState<UpdateUploadDryRun | null>(null);
  const [problem, setProblem] = useState<unknown>(null);
  const [cancelled, setCancelled] = useState(false);
  /** The install was asked for and the server began the update: nothing more to do here. */
  const [installed, setInstalled] = useState(false);
  const run = useRef<AbortController | null>(null);
  /**
   * The completed upload no install has been asked for: it goes with the panel (left behind, it would hold one of the
   * uploader's three slots for 24 hours). An upload an install may have begun with is never dropped: the op takes it.
   */
  const loose = useRef<string | null>(null);
  /** An upload an install request went out with and got no clear refusal for: the op may hold it now. */
  const handedOver = useRef<string | null>(null);
  useEffect(
    () => () => {
      run.current?.abort();
      if (loose.current !== null) void dropUpload(loose.current);
    },
    [],
  );

  const busy = phase.kind !== 'idle';

  /** Runs `work` under a fresh AbortController; a failure is shown (an abort says so). */
  const under = async (work: (signal: AbortSignal) => Promise<void>): Promise<void> => {
    const controller = new AbortController();
    run.current = controller;
    setProblem(null);
    setCancelled(false);
    try {
      await work(controller.signal);
    } catch (e) {
      if (controller.signal.aborted) setCancelled(true);
      // A 503 MAINTENANCE already took the page where it belongs (lib/api.ts).
      else if (!(e instanceof ApiError && e.code === 'MAINTENANCE')) setProblem(e);
    } finally {
      if (run.current === controller) run.current = null;
      setPhase({ kind: 'idle' });
    }
  };

  /** The dry run of `uploadId`: the package's signature and its prechecks, nothing begun. */
  const check = async (uploadId: string, signal: AbortSignal): Promise<void> => {
    setPhase({ kind: 'checking' });
    const body: UpdateUploadBody = { uploadId, dryRun: true };
    setReport(await api<UpdateUploadDryRun>('POST', 'updates/upload', body, { signal }));
  };

  const start = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (busy) return;
    if (file === null) {
      setFileError(true);
      input.current?.focus();
      return;
    }
    if (loose.current !== null) void dropUpload(loose.current);
    loose.current = null;
    setUploaded(null);
    setReport(null);
    setInstalled(false);
    void under(async (signal) => {
      setPhase({ kind: 'hashing', done: 0, total: file.size });
      const { uploadId } = await uploadFile(file, {
        context: 'update',
        signal,
        onHashProgress: (done, total) => setPhase(done >= total ? { kind: 'sending', done: 0, total } : { kind: 'hashing', done, total }),
        onProgress: (done, total) => setPhase({ kind: 'sending', done, total }),
      });
      loose.current = uploadId;
      setUploaded(uploadId);
      await check(uploadId, signal);
    });
  };

  const checkAgain = (): void => {
    if (busy || uploaded === null) return;
    const uploadId = uploaded;
    setReport(null);
    void under((signal) => check(uploadId, signal));
  };

  /** "Pasang versi <v>": the same upload without `dryRun` begins the update op; the operations page follows it. */
  const install = (): void => {
    if (busy || installed || uploaded === null || report === null || !report.precheck.ok) return;
    const uploadId = uploaded;
    const body: UpdateUploadBody = { uploadId };
    loose.current = null;
    void under(async (signal) => {
      setPhase({ kind: 'applying' });
      try {
        await api<UpdateOpResponse>('POST', 'updates/upload', body, { signal });
      } catch (e) {
        // The server's own refusal (problem+json, 4xx) of the first install with this upload: nothing began, and the
        // upload is still where it was. Anything else (no answer, an abort, a proxy's or a server error) may have begun
        // the op with it, so it is left alone from then on (it expires on its own).
        const refused = e instanceof ApiError && e.problemJson && e.status < 500;
        if (refused && handedOver.current !== uploadId) loose.current = uploadId;
        else handedOver.current = uploadId;
        throw e;
      }
      setInstalled(true);
      page.assign(OPS_PAGE_PATH);
    });
  };

  /** "Batal": the report and the upload go. */
  const discard = (): void => {
    if (busy || installed) return;
    if (loose.current !== null) void dropUpload(loose.current);
    loose.current = null;
    setUploaded(null);
    setReport(null);
    setProblem(null);
    setFile(null);
    if (input.current !== null) input.current.value = '';
  };

  const progress = phase.kind === 'hashing' || phase.kind === 'sending' ? phase : null;
  const pct = progress === null || progress.total === 0 ? 0 : (progress.done / progress.total) * 100;
  const progressLabel = progress === null ? '' : t(progress.kind === 'hashing' ? 'updates.upload.hashing' : 'updates.upload.sending');

  return (
    <SettingsSection title={t('updates.upload.title')} description={t('updates.upload.body')}>
      <form noValidate className="flex flex-col gap-3" onSubmit={start}>
        <div className="grid gap-2">
          <Label htmlFor={fileId}>{t('updates.upload.file')}</Label>
          <Input
            id={fileId}
            ref={input}
            type="file"
            accept=".zip,application/zip"
            disabled={busy}
            aria-invalid={fileError ? true : undefined}
            aria-describedby={fileError ? `${fileId}-error` : undefined}
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setFileError(false);
              setCancelled(false);
            }}
          />
          {fileError && (
            <p id={`${fileId}-error`} className="text-sm text-destructive">
              {t('updates.upload.choose')}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy}>
            <UploadIcon aria-hidden="true" />
            {t('updates.upload.submit')}
          </Button>
          {(progress !== null || phase.kind === 'checking') && (
            <Button type="button" variant="outline" onClick={() => run.current?.abort()}>
              <XIcon aria-hidden="true" />
              {t('updates.upload.cancel')}
            </Button>
          )}
        </div>
      </form>
      {progress !== null && (
        <div className="flex flex-col gap-1">
          <div className="flex items-baseline justify-between gap-2 text-sm">
            <span className="font-medium">{progressLabel}</span>
            <span className="tabular-nums">{Math.round(pct)} %</span>
          </div>
          <ProgressBar value={pct} label={progressLabel} />
          <p className="text-xs text-muted-foreground tabular-nums">
            {t('updates.upload.amount', { done: bytes(progress.done), total: bytes(progress.total) })}
          </p>
        </div>
      )}
      {phase.kind === 'checking' && (
        <p role="status" className="text-sm text-muted-foreground">
          {t('updates.upload.checking')}
        </p>
      )}
      {cancelled && <NoticeAlert>{t('updates.upload.cancelled')}</NoticeAlert>}
      {problem !== null && <RefusalAlert error={problem} />}
      {report !== null && (
        <div className="flex flex-col gap-3 rounded-md border p-3">
          <p className="flex items-start gap-2 text-sm font-medium">
            <PackageCheckIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>{t('updates.upload.report', { version: report.version, date: day(report.releasedAt) })}</span>
          </p>
          <PrecheckList id={reportId} report={report.precheck} />
          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={busy || installed || blocked || !report.precheck.ok} aria-describedby={reportId} onClick={install}>
              {t('updates.upload.apply', { version: report.version })}
            </Button>
            <Button type="button" variant="outline" disabled={busy || installed} onClick={discard}>
              {t('updates.upload.discard')}
            </Button>
          </div>
        </div>
      )}
      {report === null && uploaded !== null && !busy && (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-muted-foreground">{t('updates.upload.retry_hint')}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" onClick={checkAgain}>
              {t('updates.upload.retry')}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={discard}>
              {t('updates.upload.discard')}
            </Button>
          </div>
        </div>
      )}
    </SettingsSection>
  );
}
