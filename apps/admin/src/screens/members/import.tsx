import { MEMBER_IMPORT_MODES, type MemberImportMode, type MemberImportRefusal, type MemberImportWarning } from '@altis/shared';
import type { MemberImportCounts, MemberImportStartResponse, MemberImportView } from '@altis/shared/api/members';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { DownloadIcon, FlaskConicalIcon, PlayIcon, RotateCcwIcon } from 'lucide-react';
import { useId, useRef, useState, type FormEvent } from 'react';
import { Badge, Field, Notice, NoticeAlert, ProblemAlert } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useT, type TKey, type Translate } from '@/i18n';
import { holds } from '@/lib/access';
import { ApiError, api } from '@/lib/api';
import { useMe } from '@/lib/me';
import { uploadFile } from '@/lib/upload';
import { cn } from '@/lib/utils';
import { MasterTable, type MasterColumn } from '@/screens/catalog/masters/master-table';
import { newTransactionKey } from '@/screens/circulation/common';

/**
 * Impor Anggota (`/admin/anggota/impor`), a wizard of three steps:
 *
 * 1. **Unggah berkas:** a CSV with a header row (`member_no`, `name`, `member_type` required; the other columns
 *    optional, in any order), `,` or `;` as separator, UTF-8 or the Windows encoding Excel uses in Indonesia; and the
 *    mode: create new members only (a number that exists is refused) or also update the ones that exist (an empty cell
 *    keeps the stored value). The template can be downloaded.
 * 2. **Uji kering:** the file goes up (the staged context `members.import`) and a dry run reads and checks every row
 *    without writing: the counts (will create, will update, unchanged, refused per reason), the warnings and the first
 *    20 rows as the import reads them. A member type the file names but the library does not have refuses the row; it
 *    is never created.
 * 3. **Hasil:** "Jalankan impor" sends the same file again (a fresh upload: a dry run may have used the first) for the
 *    real run; its counts and, when rows were refused, the report (line number, member number and reason; kept 90
 *    days) to download.
 *
 * Each run is polled until it ends; leaving the page leaves it running on the server.
 */

const TEMPLATE_HEADER =
  'member_no;name;member_type;class_name;identity_no;gender;birth_date;email;phone;address;postal_code;mailing_address;institution;joined_on;expires_on;home_branch;notes;locale';

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

type Step = 'file' | 'dry_run' | 'result';

/** Polls an import run every 1.5 s until it ends. */
function useImportRun(id: string | null) {
  const me = useMe();
  return useQuery({
    queryKey: ['members', 'imports', id],
    queryFn: () => api<MemberImportView>('GET', `members/imports/${encodeURIComponent(id!)}`, undefined, { background: true }),
    enabled: me !== undefined && id !== null,
    refetchInterval: (q) => (q.state.data !== undefined && TERMINAL.has(q.state.data.status) ? false : 1500),
  });
}

/** Saves the CSV template (the header row only) as a file. */
function downloadTemplate(): void {
  const blob = new Blob([`${TEMPLATE_HEADER}\r\n`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'template-anggota.csv';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function refusalText(t: Translate, reason: MemberImportRefusal): string {
  return t(`vocab.member_import_refusal.${reason}`);
}

function warningText(t: Translate, warning: MemberImportWarning): string {
  return t(`vocab.member_import_warning.${warning}`);
}

/** The counts of a run as cards, then the refusals and warnings by reason. */
function Counts({ counts, dryRun }: { counts: MemberImportCounts; dryRun: boolean }) {
  const t = useT();
  const cards: [TKey, number, string][] = [
    [dryRun ? 'members.import.count.will_create' : 'members.import.count.created', counts.inserted, 'text-success-foreground'],
    [dryRun ? 'members.import.count.will_update' : 'members.import.count.updated', counts.updated, ''],
    ['members.import.count.unchanged', counts.unchanged, 'text-muted-foreground'],
    ['members.import.count.refused', counts.refused, 'text-destructive'],
  ];
  const refusals = Object.entries(counts.refusedBy).filter(([, n]) => (n ?? 0) > 0) as [MemberImportRefusal, number][];
  const warnings = Object.entries(counts.warnings).filter(([, n]) => (n ?? 0) > 0) as [MemberImportWarning, number][];
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">{t('members.import.rows', { count: counts.rows })}</p>
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {cards.map(([key, n, cls]) => (
          <div key={key} className="rounded-lg border bg-card p-3">
            <dt className="text-sm text-muted-foreground">{t(key)}</dt>
            <dd className={cn('text-2xl font-semibold', n > 0 && cls)}>{n}</dd>
          </div>
        ))}
      </dl>
      {refusals.length > 0 && (
        <div className="rounded-lg border p-3">
          <p className="mb-1 text-sm font-medium">{t('members.import.refusals')}</p>
          <ul className="grid gap-1 text-sm">
            {refusals.map(([reason, n]) => (
              <li key={reason} className="flex justify-between gap-2">
                <span>{refusalText(t, reason)}</span>
                <span className="font-medium">{n}</span>
              </li>
            ))}
          </ul>
          {refusals.some(([reason]) => reason === 'unknown_member_type') && <p className="mt-2 text-xs text-muted-foreground">{t('members.import.unknown_type_hint')}</p>}
        </div>
      )}
      {warnings.length > 0 && (
        <div className="rounded-lg border border-warning-foreground/30 bg-warning p-3 text-warning-foreground">
          <p className="mb-1 text-sm font-medium">{t('members.import.warnings')}</p>
          <ul className="grid gap-1 text-sm">
            {warnings.map(([w, n]) => (
              <li key={w} className="flex justify-between gap-2">
                <span>{warningText(t, w)}</span>
                <span className="font-medium">{n}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** A run in progress, failed, or done (its counts, and the sample rows of a dry run). */
function RunView({ run }: { run: MemberImportView | undefined }) {
  const t = useT();
  if (run === undefined || !TERMINAL.has(run.status)) {
    return (
      <p role="status" aria-busy="true" className="rounded-lg border bg-card p-4 text-sm">
        {t(run?.status === 'running' ? 'members.import.running' : 'members.import.queued')}
      </p>
    );
  }
  if (run.status !== 'succeeded' || run.counts === null) {
    const code = run.errorCode;
    return <Notice kind="error">{code === null ? t('members.import.failed') : t(`error.${code}` as TKey)}</Notice>;
  }
  const columns: MasterColumn<MemberImportView['sample'][number] & { id: string }>[] = [
    { id: 'line', header: t('members.import.col.line'), cell: (r) => String(r.line) },
    { id: 'no', header: t('members.col.member_no'), cell: (r) => <span className="font-mono">{r.memberNo}</span> },
    { id: 'name', header: t('members.col.name'), cell: (r) => r.name },
    { id: 'type', header: t('members.col.type'), cell: (r) => <span className={cn(r.refusal === 'unknown_member_type' && 'font-medium text-destructive')}>{r.memberType}</span> },
    { id: 'class', header: t('members.col.class'), cell: (r) => r.className ?? '—' },
    {
      id: 'state',
      header: t('members.import.col.state'),
      cell: (r) =>
        r.refusal !== null ? (
          <Badge tone="danger">{refusalText(t, r.refusal)}</Badge>
        ) : r.warnings.length > 0 ? (
          <Badge tone="warning">{r.warnings.map((w) => warningText(t, w)).join(', ')}</Badge>
        ) : (
          <Badge tone="info">{t('members.import.row_ok')}</Badge>
        ),
    },
  ];
  return (
    <div className="flex flex-col gap-4">
      <Counts counts={run.counts} dryRun={run.dryRun} />
      {run.dryRun && run.sample.length > 0 && (
        <MasterTable caption={t('members.import.sample')} columns={columns} rows={run.sample.map((r) => ({ ...r, id: String(r.line) }))} empty={t('members.import.sample_empty')} />
      )}
      {run.reportAvailable && (
        <Button asChild variant="outline" className="w-fit">
          <a href={`/api/v1/members/imports/${encodeURIComponent(run.id)}/report`} download>
            <DownloadIcon aria-hidden="true" />
            {t('members.import.report')}
          </a>
        </Button>
      )}
    </div>
  );
}

export function MemberImportScreen() {
  const t = useT();
  const me = useMe();
  const ids = useId();
  const queryClient = useQueryClient();
  const canRun = holds(me, 'members.import.run');
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<MemberImportMode>('create_only');
  const [step, setStep] = useState<Step>('file');
  const [dryRunId, setDryRunId] = useState<string | null>(null);
  const [realRunId, setRealRunId] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [problem, setProblem] = useState<unknown>(null);
  const [fileError, setFileError] = useState<TKey | null>(null);
  const [busy, setBusy] = useState(false);
  const dryRun = useImportRun(dryRunId);
  const realRun = useImportRun(realRunId);

  /** Uploads the file and starts a run; returns its id, or null after a problem (said on the page). */
  const start = async (dry: boolean): Promise<string | null> => {
    if (file === null) return null;
    setProblem(null);
    setFileError(null);
    setBusy(true);
    setProgress(0);
    try {
      const { uploadId } = await uploadFile(file, { context: 'members.import', onProgress: (sent, total) => setProgress(total === 0 ? 100 : Math.round((sent / total) * 100)) });
      const started = await api<MemberImportStartResponse>('POST', 'members/imports', { uploadId, format: 'csv-members', mode, dryRun: dry }, { idempotencyKey: newTransactionKey('member-import') });
      return started.id;
    } catch (e) {
      if (e instanceof ApiError && e.code === 'MEMBER_IMPORT_FORMAT') setFileError('error.MEMBER_IMPORT_FORMAT');
      else setProblem(e);
      return null;
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const runDry = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (file === null) {
      setFileError('members.import.no_file');
      return;
    }
    const id = await start(true);
    if (id !== null) {
      setDryRunId(id);
      setRealRunId(null);
      setStep('dry_run');
    }
  };

  const runReal = async (): Promise<void> => {
    const id = await start(false);
    if (id !== null) {
      setRealRunId(id);
      setStep('result');
    }
  };

  const restart = (): void => {
    setStep('file');
    setFile(null);
    setDryRunId(null);
    setRealRunId(null);
    setProblem(null);
    setFileError(null);
    if (fileInput.current !== null) fileInput.current.value = '';
    void queryClient.invalidateQueries({ queryKey: ['members'] });
  };

  const steps: [Step, TKey][] = [
    ['file', 'members.import.step.file'],
    ['dry_run', 'members.import.step.dry_run'],
    ['result', 'members.import.step.result'],
  ];
  const dryDone = dryRun.data !== undefined && dryRun.data.status === 'succeeded';
  const realDone = realRun.data !== undefined && TERMINAL.has(realRun.data.status);

  return (
    <div className="flex max-w-5xl flex-col gap-4">
      <h1 className="text-2xl font-semibold">{t('nav.members.import')}</h1>
      <ol aria-label={t('members.import.steps')} className="flex flex-wrap gap-2 text-sm">
        {steps.map(([s, key], i) => (
          <li
            key={s}
            aria-current={step === s ? 'step' : undefined}
            className={cn('rounded-full border px-3 py-1', step === s ? 'border-primary bg-primary/10 font-medium text-primary' : 'text-muted-foreground')}>
            {i + 1}. {t(key)}
          </li>
        ))}
      </ol>
      {!canRun && <ProblemAlert error={new ApiError(403, 'AUTHZ_DENIED')} />}
      <ProblemAlert error={problem} />

      {step === 'file' && (
        <form noValidate onSubmit={(e) => void runDry(e)} className="flex flex-col gap-4">
          <fieldset disabled={!canRun || busy} className="grid gap-4 rounded-lg border bg-card p-4">
            <legend className="px-1 text-sm font-semibold">{t('members.import.step.file')}</legend>
            <p className="text-sm text-muted-foreground">{t('members.import.intro')}</p>
            <Field label={t('members.import.file')} hint={t('members.import.file_hint')} error={fileError ?? undefined}>
              {(c) => (
                <Input
                  {...c}
                  ref={fileInput}
                  type="file"
                  accept=".csv,text/csv,text/plain"
                  onChange={(e) => {
                    setFile(e.target.files?.[0] ?? null);
                    setFileError(null);
                  }}
                />
              )}
            </Field>
            <Button type="button" variant="link" className="w-fit px-0" onClick={downloadTemplate}>
              <DownloadIcon aria-hidden="true" />
              {t('members.import.template')}
            </Button>
            <fieldset className="grid gap-2">
              <legend className="mb-1 text-sm font-medium">{t('members.import.mode')}</legend>
              {MEMBER_IMPORT_MODES.map((m) => (
                <label key={m} className="flex items-start gap-2 text-sm">
                  <input type="radio" name={`${ids}-mode`} value={m} checked={mode === m} onChange={() => setMode(m)} className="mt-0.5 size-4 accent-primary" />
                  <span>
                    <span className="font-medium">{t(`vocab.member_import_mode.${m}`)}</span>
                    <span className="block text-xs text-muted-foreground">{t(`members.import.mode_hint.${m}`)}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            {progress !== null && (
              <p role="status" className="text-sm text-muted-foreground">
                {t('members.import.uploading', { percent: progress })}
              </p>
            )}
            <div>
              <Button type="submit" disabled={busy}>
                <FlaskConicalIcon aria-hidden="true" />
                {t('members.import.dry_run')}
              </Button>
            </div>
          </fieldset>
        </form>
      )}

      {step === 'dry_run' && (
        <section className="flex flex-col gap-4" aria-label={t('members.import.step.dry_run')}>
          <NoticeAlert>{t('members.import.dry_run_note', { name: file?.name ?? '' })}</NoticeAlert>
          <RunView run={dryRun.data} />
          {dryRun.isError && <Notice kind="error">{t('members.import.poll_failed')}</Notice>}
          {progress !== null && (
            <p role="status" className="text-sm text-muted-foreground">
              {t('members.import.uploading', { percent: progress })}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={!dryDone || busy || !canRun} onClick={() => void runReal()}>
              <PlayIcon aria-hidden="true" />
              {t('members.import.run')}
            </Button>
            <Button type="button" variant="outline" disabled={busy} onClick={restart}>
              <RotateCcwIcon aria-hidden="true" />
              {t('members.import.other_file')}
            </Button>
          </div>
        </section>
      )}

      {step === 'result' && (
        <section className="flex flex-col gap-4" aria-label={t('members.import.step.result')}>
          {!realDone && <NoticeAlert>{t('members.import.leave_ok')}</NoticeAlert>}
          <RunView run={realRun.data} />
          {realRun.isError && <Notice kind="error">{t('members.import.poll_failed')}</Notice>}
          {realDone && (
            <div className="flex flex-wrap gap-2">
              <Button asChild>
                <Link to="/admin/anggota">{t('members.import.view_members')}</Link>
              </Button>
              <Button type="button" variant="outline" onClick={restart}>
                <RotateCcwIcon aria-hidden="true" />
                {t('members.import.another')}
              </Button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
