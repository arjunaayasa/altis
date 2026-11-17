import type { BackupItem, BackupUploadResponse } from '@altis/shared/api/backups';
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Notice, NoticeAlert } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { FileInput } from '@/components/file-input';
import { useLocale, useT } from '@/i18n';
import { ApiError, api } from '@/lib/api';
import { problemText } from '@/lib/form-errors';
import { uploadFile } from '@/lib/upload';
import { ProgressBar } from '@/screens/jobs/list';

/**
 * "Unggah" of Cadangan (spec §13.3 "Backup", §9.10 "eksternal", §7.5; routes `files.uploads.*`, `backups.upload`;
 * 1c Task 32): an `.altisbak` archive goes up through the adaptive chunked upload of lib/upload.ts (Task 16: the chunk
 * shrinks to what the host lets through, a busy upload is sent again, the server completes it in O(1), ruling R1c-4),
 * with the hashing and the sending shown as progress; then `POST backups/upload {uploadId}` (`system.backup.restore`,
 * re-authenticated: the reauth dialog opens when the server asks) makes it an `external` backup of the list, which
 * "Pulihkan" restores.
 *
 * - A `POST backups/upload` that meets 409 TX_CONFLICT `upload_busy` (the upload's lock is still held, as by a
 *   completion that has not let go yet) is sent again after 1, 2, 4, 8 and 16 s, as lib/upload.ts does for its own
 *   requests.
 * - A registration that fails otherwise (the reauth dialog was cancelled, a refusal) keeps the completed upload:
 *   "Coba lagi" registers it again without sending the file again (a staged upload lives 24 hours).
 * - "Batalkan unggahan" (and leaving the page) aborts the upload; lib/upload.ts then deletes its session.
 */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/** `bytes` in binary units (1 KB = 1024 B), one decimal at most, in the UI language (as the dashboard shows sizes). */
export function useBytes(): (bytes: number) => string {
  const locale = useLocale();
  return useCallback(
    (bytes: number) => {
      let value = bytes;
      let unit = 0;
      while (value >= 1024 && unit < UNITS.length - 1) {
        value /= 1024;
        unit += 1;
      }
      const n = new Intl.NumberFormat(locale === 'en' ? 'en-GB' : 'id-ID', { maximumFractionDigits: unit === 0 ? 0 : 1 }).format(value);
      return `${n} ${UNITS[unit]}`;
    },
    [locale],
  );
}

/** The waits before each new try of a busy registration (409 TX_CONFLICT `upload_busy`). */
const BUSY_RETRY_MS: readonly number[] = [1000, 2000, 4000, 8000, 16000];

/** Resolves after `ms`, or rejects with the signal's reason once it aborts. */
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason as Error);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason as Error);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

const isBusy = (e: unknown): boolean => e instanceof ApiError && e.status === 409 && e.code === 'TX_CONFLICT' && e.reason === 'upload_busy';

/** `POST backups/upload {uploadId}`, sent again while the upload is busy. */
async function registerUpload(uploadId: string, signal: AbortSignal): Promise<BackupItem> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await api<BackupUploadResponse>('POST', 'backups/upload', { uploadId }, { signal });
    } catch (e) {
      if (signal.aborted) throw signal.reason;
      if (!isBusy(e) || attempt >= BUSY_RETRY_MS.length) throw e;
      await wait(BUSY_RETRY_MS[attempt]!, signal);
    }
  }
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'hashing' | 'sending'; done: number; total: number }
  | { kind: 'registering' };

type Outcome = { kind: 'success' | 'error' | 'info'; text: string } | null;

/** The upload card: pick an archive, send it, register it; `onUploaded` gets the new backup. */
export function UploadPanel({ onUploaded }: { onUploaded(item: BackupItem): void }) {
  const t = useT();
  const bytes = useBytes();
  const fileId = useId();
  const titleId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [outcome, setOutcome] = useState<Outcome>(null);
  /** A completed upload whose registration failed: "Coba lagi" registers it again. */
  const [unregistered, setUnregistered] = useState<string | null>(null);
  const run = useRef<AbortController | null>(null);
  useEffect(() => () => run.current?.abort(), []);

  const busy = phase.kind !== 'idle';

  /** Runs `work` under a fresh AbortController, with the outcome shown at the end. */
  const under = async (work: (signal: AbortSignal) => Promise<void>): Promise<void> => {
    const controller = new AbortController();
    run.current = controller;
    setOutcome(null);
    try {
      await work(controller.signal);
    } catch (e) {
      setOutcome(controller.signal.aborted ? { kind: 'info', text: t('backups.upload.cancelled') } : { kind: 'error', text: problemText(t, e) });
    } finally {
      if (run.current === controller) run.current = null;
      setPhase({ kind: 'idle' });
    }
  };

  const register = async (uploadId: string, signal: AbortSignal): Promise<void> => {
    setPhase({ kind: 'registering' });
    let item: BackupItem;
    try {
      item = await registerUpload(uploadId, signal);
    } catch (e) {
      if (!signal.aborted) setUnregistered(uploadId);
      throw e;
    }
    setUnregistered(null);
    setFile(null);
    if (input.current !== null) input.current.value = '';
    setOutcome({ kind: 'success', text: t('backups.upload.done') });
    onUploaded(item);
  };

  const start = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (busy) return;
    if (file === null) {
      setOutcome({ kind: 'error', text: t('backups.upload.choose') });
      return;
    }
    setUnregistered(null);
    void under(async (signal) => {
      setPhase({ kind: 'hashing', done: 0, total: file.size });
      const { uploadId } = await uploadFile(file, {
        context: 'backup',
        signal,
        onHashProgress: (done, total) => setPhase(done >= total ? { kind: 'sending', done: 0, total } : { kind: 'hashing', done, total }),
        onProgress: (done, total) => setPhase({ kind: 'sending', done, total }),
      });
      await register(uploadId, signal);
    });
  };

  const retryRegister = (): void => {
    if (busy || unregistered === null) return;
    const uploadId = unregistered;
    void under((signal) => register(uploadId, signal));
  };

  const progress = phase.kind === 'hashing' || phase.kind === 'sending' ? phase : null;
  const pct = progress === null || progress.total === 0 ? 0 : (progress.done / progress.total) * 100;

  return (
    <section aria-labelledby={titleId} className="grid min-w-0 content-start gap-3">
      <h2 id={titleId} className="text-base font-bold">
        {t('backups.upload.title')}
      </h2>
      <p className="text-sm text-muted-foreground">{t('backups.upload.description')}</p>
      <form noValidate className="grid gap-3" onSubmit={start}>
        <div className="grid gap-1.5">
          <Label htmlFor={fileId} className="text-meta">
            {t('backups.upload.file')}
          </Label>
          <FileInput
            id={fileId}
            ref={input}
            chosen={file?.name ?? null}
            accept=".altisbak,application/octet-stream"
            disabled={busy}
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setOutcome(null);
            }}
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="outline" disabled={busy}>
            {t('backups.upload.submit')}
          </Button>
          {busy && (
            <Button type="button" variant="outline" onClick={() => run.current?.abort()}>
              {t('backups.upload.cancel')}
            </Button>
          )}
        </div>
      </form>
      {progress !== null && (
        <div className="grid gap-1">
          <div className="flex items-baseline justify-between gap-2 text-sm">
            <span className="font-semibold">{t(progress.kind === 'hashing' ? 'backups.upload.hashing' : 'backups.upload.sending')}</span>
            <span className="tabular-nums">{Math.round(pct)} %</span>
          </div>
          <ProgressBar value={pct} label={t(progress.kind === 'hashing' ? 'backups.upload.hashing' : 'backups.upload.sending')} />
          <p className="text-xs text-muted-foreground tabular-nums">
            {t('backups.upload.amount', { done: bytes(progress.done), total: bytes(progress.total) })}
          </p>
        </div>
      )}
      {phase.kind === 'registering' && (
        <p role="status" className="text-sm text-muted-foreground">
          {t('backups.upload.registering')}
        </p>
      )}
      {outcome !== null &&
        (outcome.kind === 'info' ? (
          <NoticeAlert>{outcome.text}</NoticeAlert>
        ) : (
          <Notice
            kind={outcome.kind}
            action={
              outcome.kind === 'error' && unregistered !== null && !busy ? (
                <Button variant="outline" size="sm" onClick={retryRegister}>
                  {t('table.retry')}
                </Button>
              ) : undefined
            }
          >
            {outcome.text}
          </Notice>
        ))}
    </section>
  );
}
