import type { EvidenceView } from '@altis/shared/api/accreditation';
import type { ReportRunView } from '@altis/shared/api/reports';
import { useQueryClient } from '@tanstack/react-query';
import { Tag, type TagTone } from '@/components/layout';
import { JobProgress } from '@/components/job-progress';
import { Button, buttonVariants } from '@/components/ui/button';
import { useDateTime } from '@/components/data-table';
import { useLocale, useT, type Translate } from '@/i18n';
import { isMessageKey } from '@/lib/form-errors';
import { useApiQuery } from '@/lib/me';
import { page } from '@/lib/page';
import { useBytes } from '@/screens/backups/upload';
import { confirmReauth, failureText } from '@/screens/reports/run-history';

/**
 * A report run of the Cetak tab (spec §10.9): the document or annex it makes, its status, the job's progress while it
 * runs, its warnings as sentences, why it failed in words (the Laporan screen's {@link failureText}), and its download.
 *
 * - The warnings are the codes the export wrote into the run (`component_over_limit:<component>:<bytes>`,
 *   `generated_too_large:<code>`, `file_missing:<file id>` for an evidence file gone from the storage, named by its
 *   file name from the period's evidence list, `report_withheld:<code>` for a drafted report the requester may not
 *   export); each is shown as a sentence, an unknown one with its code.
 * - A file is a plain same-origin link (the browser downloads it with the session cookie; the server audits each
 *   download). A run holding personal data (the evidence file, the simulation, the staff annex) is downloaded only right
 *   after a password confirmation: a link cannot open the dialog, so its button asks first and then loads the file.
 *   Whether a confirmation still counts is the Laporan screen's rule ({@link confirmReauth}): one made on this page in
 *   the last four minutes, on the page's own clock, never the session's `reauthUntil` read against the PC's clock.
 */

/** The file of a run. */
export const runDownloadHref = (id: string): string => `/api/v1/reports/runs/${encodeURIComponent(id)}/download`;

/** The query key of one run. */
export const reportRunKey = (id: string) => ['reports', 'runs', 'one', id] as const;

const COMPONENTS = new Set(['K', 'SP', 'L', 'T', 'F', 'G']);

/** A component of the evidence file by its code: `K (Koleksi Perpustakaan)`, the profile, or the code itself. */
export function componentLabel(t: Translate, code: string): string {
  if (COMPONENTS.has(code)) return `${code} (${t(`accred.component.${code as 'K' | 'SP' | 'L' | 'T' | 'F' | 'G'}`)})`;
  if (code === 'profil') return t('accreditation.print.component.profil');
  return code;
}

/** How a run's warnings are put in words: sizes, numbers, the component limit, and an evidence file's name by its id. */
export interface WarningWords {
  bytes(n: number): string;
  number(n: number): string;
  limitMb: number | null;
  /** The name of the period's evidence file `fileId`; null when the period's evidence list does not hold it. */
  fileName?(fileId: string): string | null;
}

/** A run's warning code as a sentence. */
export function warningText(t: Translate, o: WarningWords, code: string): string {
  const missing = /^file_missing:(.+)$/.exec(code);
  if (missing !== null) {
    const name = o.fileName?.(missing[1]!) ?? null;
    return name === null ? t('accreditation.print.warning.file_missing_unknown') : t('accreditation.print.warning.file_missing', { name });
  }
  const over = /^component_over_limit:([^:]+):(\d+)$/.exec(code);
  if (over !== null) {
    const params = { component: componentLabel(t, over[1]!), size: o.bytes(Number(over[2])) };
    return o.limitMb === null
      ? t('accreditation.print.warning.component_over', params)
      : t('accreditation.print.warning.component_over_limit', { ...params, limit: o.number(o.limitMb) });
  }
  const large = /^generated_too_large:(.+)$/.exec(code);
  if (large !== null) return t('accreditation.print.warning.generated_too_large', { code: large[1]! });
  const withheld = /^report_withheld:(.+)$/.exec(code);
  if (withheld !== null) return t('accreditation.print.warning.report_withheld', { code: withheld[1]! });
  return t('accreditation.print.warning.other', { code });
}

/** What a run makes: the definition's title and its format (for the evidence file: the PDF, a ZIP, the request letter). */
export function runTitle(t: Translate, run: Pick<ReportRunView, 'reportId' | 'format' | 'params'>): string {
  const key = `report.${run.reportId}.title`;
  const base = isMessageKey(key) ? t(key) : run.reportId;
  let variant: string;
  if (run.reportId === 'accreditation.dossier') {
    const params = run.params ?? {};
    if (params['part'] === 'request_letter') variant = t('accreditation.print.request_letter');
    else if (run.format === 'zip') variant = params['zipMode'] === 'components' ? t('accreditation.print.dossier.zip_components') : t('accreditation.print.dossier.zip');
    else variant = t(`vocab.report_format.${run.format}`);
  } else {
    variant = t(`vocab.report_format.${run.format}`);
  }
  return `${base} · ${variant}`;
}

const isActive = (run: Pick<ReportRunView, 'status'>): boolean => run.status === 'queued' || run.status === 'running';

const STATUS_TONE: Readonly<Record<ReportRunView['status'], TagTone>> = { queued: 'neutral', running: 'neutral', succeeded: 'ok', failed: 'bad', cancelled: 'neutral' };

/** The download of a finished run: a link, or a button that confirms the password first for a personal run. */
function RunDownload({ run, title }: { run: ReportRunView; title: string }) {
  const t = useT();
  const queryClient = useQueryClient();
  const dateTime = useDateTime();
  const expired = run.expiresAt !== null && run.expiresAt <= Date.now();
  if (!run.downloadable) {
    return expired && run.expiresAt !== null ? (
      <span className="text-xs text-muted-foreground">{t('accreditation.print.runs.expired', { date: dateTime(run.expiresAt) })}</span>
    ) : null;
  }
  const href = runDownloadHref(run.id);
  const label = t('accreditation.print.runs.download_label', { title, date: dateTime(run.createdAt) });
  const download = async (): Promise<void> => {
    if (await confirmReauth(queryClient)) page.assign(href);
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      {run.personal ? (
        <Button type="button" size="sm" variant="outline" aria-label={label} onClick={() => void download()}>
          {t('accreditation.print.runs.download')}
        </Button>
      ) : (
        <a href={href} download aria-label={label} className={buttonVariants({ size: 'sm', variant: 'outline' })}>
          {t('accreditation.print.runs.download')}
        </a>
      )}
      {run.expiresAt !== null && <span className="text-xs text-muted-foreground">{t('accreditation.print.runs.expires', { date: dateTime(run.expiresAt) })}</span>}
    </div>
  );
}

export interface RunCardProps {
  run: ReportRunView;
  /** `accreditation.evidence.componentLimitMb`, for the sentence of a component over it (null: not known). */
  limitMb: number | null;
  /** The period's evidence files, to name a file a warning says is missing (undefined: not read yet). */
  evidence?: readonly EvidenceView[];
  /** The run's job has ended: read the run again. */
  onEnded(): void;
}

/** One run as a list item. */
export function RunCard({ run, limitMb, evidence, onEnded }: RunCardProps) {
  const t = useT();
  const locale = useLocale();
  const bytes = useBytes();
  const dateTime = useDateTime();
  const number = new Intl.NumberFormat(locale === 'en' ? 'en-GB' : 'id-ID');
  const title = runTitle(t, run);
  const fileName = (fileId: string): string | null => evidence?.find((e) => e.fileId === fileId)?.fileName ?? null;
  return (
    <li data-run-id={run.id} className="grid gap-2 border-b py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-semibold">{title}</span>
        <Tag tone={STATUS_TONE[run.status]}>{t(`vocab.report_run_status.${run.status}`)}</Tag>
      </div>
      <p className="text-xs text-muted-foreground">{t('accreditation.print.runs.made', { date: dateTime(run.createdAt) })}</p>
      {isActive(run) && run.jobId !== null && <JobProgress jobId={run.jobId} onDone={onEnded} />}
      {run.status === 'failed' && <p className="text-sm font-semibold text-bad">{t('accreditation.print.runs.failed', { reason: failureText(t, run.errorCode) })}</p>}
      {run.warnings.map((code) => (
        <p key={code} data-warning={code} className="rounded-md border border-warn-line bg-warn-bg px-3.5 py-2.5 text-sm">
          {warningText(t, { bytes, number: (n) => number.format(n), limitMb, fileName }, code)}
        </p>
      ))}
      {run.status === 'succeeded' && <RunDownload run={run} title={title} />}
    </li>
  );
}

/** A run just started on this page: read until its job ends. */
export function StartedRunCard({ runId, limitMb, evidence }: { runId: string; limitMb: number | null; evidence?: readonly EvidenceView[] }) {
  const t = useT();
  const queryClient = useQueryClient();
  const query = useApiQuery<ReportRunView>({ queryKey: reportRunKey(runId), path: `reports/runs/${encodeURIComponent(runId)}` });
  if (query.data === undefined) {
    return (
      <li data-run-id={runId} className="border-b py-3 text-sm text-muted-foreground">
        <span role="status">{t('shell.loading')}</span>
      </li>
    );
  }
  return (
    <RunCard
      run={query.data}
      limitMb={limitMb}
      evidence={evidence}
      onEnded={() => {
        void queryClient.invalidateQueries({ queryKey: reportRunKey(runId) });
        void queryClient.invalidateQueries({ queryKey: ['reports', 'runs', 'list'] });
      }}
    />
  );
}
