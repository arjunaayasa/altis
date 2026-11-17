import { vocabKey, type ReportRunStatus } from '@altis/shared';
import type { ReportCatalogEntry, ReportRunListResponse, ReportRunView } from '@altis/shared/api/reports';
import { useInfiniteQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { createColumnHelper, tableFeatures, useTable } from '@tanstack/react-table';
import { useMemo } from 'react';
import { DataTable, useDateTime } from '@/components/data-table';
import { ProblemAlert } from '@/components/form-field';
import { ErrorState, Section, SkeletonTable, Tag, type TagTone } from '@/components/layout';
import { Button, buttonVariants } from '@/components/ui/button';
import { useLocale, useT, type Translate } from '@/i18n';
import { api, reauth } from '@/lib/api';
import { isMessageKey } from '@/lib/form-errors';
import { useMe } from '@/lib/me';
import { page } from '@/lib/page';

/**
 * "Ekspor Anda" of a report's page (spec §4.15, §6.3 "riwayat run sendiri"): the user's own runs of this report,
 * newest first (`GET reports/runs?reportId=`, keyset pages, "Muat lagi"), read again every few seconds while one of
 * them has work ahead. Each run shows when it was made, its format (and the paper of a PDF), its status, its rows,
 * the filters it ran with in words, the rows whose non-Latin text the PDF could not print ("N baris teks non-Latin:
 * lihat XLSX/CSV"), the warning codes its export wrote as sentences, why it failed, and its file until it expires.
 *
 * A file is a plain same-origin link (the browser downloads it with the session cookie; the server audits each
 * download). A run holding personal data is downloaded only right after a password confirmation: the link cannot
 * open the dialog, so its button asks first (`reauth.request()`) and then loads the file.
 */

/** The query key of a report's runs (the lists and each run). */
export const runsKey = (reportId: string) => ['reports', 'runs', reportId] as const;

/** The file of a run. */
export const runDownloadHref = (id: string): string => `/api/v1/reports/runs/${encodeURIComponent(id)}/download`;

/**
 * How long a password confirmation made on this page is taken as still counting: the server's window is five
 * minutes, and a minute is left for the request to reach it.
 */
const CONFIRMATION_COUNTS_MS = 240_000;

/**
 * When the password was last confirmed through {@link confirmReauth} in each app (its query client), on the page's
 * monotonic clock (`performance.now()`). Neither the wall clock nor the server's `reauthUntil` is used: a school PC's
 * clock may be far off, and a personal download refused by the server would leave the user on the server's answer.
 */
const confirmedAt = new WeakMap<QueryClient, number>();

/**
 * Makes sure the user confirmed their password recently, before a personal export starts or its file is loaded:
 * unless a confirmation made here less than four minutes ago still counts, opens the reauth dialog
 * (`reauth.request()`). Resolves false when the user cancels. (A JSON request refused for want of a fresh
 * confirmation opens the dialog by itself in the API client; a file link cannot, hence this pre-flight.)
 */
export async function confirmReauth(queryClient: QueryClient): Promise<boolean> {
  const last = confirmedAt.get(queryClient);
  if (last !== undefined && performance.now() - last < CONFIRMATION_COUNTS_MS) return true;
  try {
    await reauth.request();
  } catch {
    return false;
  }
  confirmedAt.set(queryClient, performance.now());
  return true;
}

/** Whether a run still has work ahead. */
export const isRunActive = (status: ReportRunStatus): boolean => status === 'queued' || status === 'running';

/** How often the list is read again while a run has work ahead. */
const ACTIVE_POLL_MS = 5_000;

const PAGE_SIZE = 20;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A size in bytes as the UI language writes it (kB, MB, GB). */
function sizeText(locale: string, bytes: number): string {
  const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte'] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return new Intl.NumberFormat(locale === 'en' ? 'en-GB' : 'id-ID', { style: 'unit', unit: units[unit], unitDisplay: 'short', maximumFractionDigits: 1 }).format(value);
}

/**
 * A warning code of a run as a sentence: `component_over_limit:<component>:<bytes>` (an evidence ZIP component over
 * its size limit), `generated_too_large:<list>` (a list too long for the ZIP), `file_missing:<file id>` (an evidence
 * file gone from the storage; this screen does not read the period's evidence, so the Cetak tab names it),
 * `report_withheld:<item>` (a drafted report left out: the requester may not export it), or any other code named as
 * it is.
 */
export function warningText(t: Translate, locale: string, code: string): string {
  const [kind, a, b] = code.split(':');
  if (kind === 'file_missing') return t('reports.warning.file_missing');
  if (kind === 'component_over_limit' && a !== undefined && b !== undefined && /^\d+$/.test(b)) {
    return t('reports.warning.component_over_limit', { component: a, size: sizeText(locale, Number(b)) });
  }
  if (kind === 'generated_too_large' && a !== undefined) return t('reports.warning.generated_too_large', { list: a });
  if (kind === 'report_withheld' && a !== undefined) return t('reports.warning.report_withheld', { code: a });
  return t('reports.warning.other', { code });
}

/**
 * Why a run failed, from its `error_code`: the export's own codes (`abandoned`: its job ended without it, `disk_full`,
 * `internal`), a registered error code (`REPORT_TOO_LARGE`), or else the code itself, named as a code.
 */
export function failureText(t: Translate, code: string | null): string {
  if (code === null || code === 'internal') return t('error.INTERNAL');
  if (code === 'abandoned') return t('reports.runs.failure.abandoned');
  if (code === 'disk_full') return t('error.DISK_QUOTA');
  const key = `error.${code}`;
  return isMessageKey(key) ? t(key) : t('reports.runs.failure.code', { code });
}

/** The status tag of a run: green once its file is made, red when it failed, neutral while it waits or runs. */
export function RunStatusBadge({ status }: { status: ReportRunStatus }) {
  const t = useT();
  const tone: TagTone = status === 'failed' ? 'bad' : status === 'succeeded' ? 'ok' : 'neutral';
  return <Tag tone={tone}>{t(vocabKey('report_run_status', status))}</Tag>;
}

/** The notes of a run: its filters, its rows of non-Latin text, its warnings, why it failed. */
export function RunNotes({ run, describe }: { run: ReportRunView; describe: ((params: Record<string, unknown> | null) => string) | null }) {
  const t = useT();
  const locale = useLocale();
  const number = new Intl.NumberFormat(locale === 'en' ? 'en-GB' : 'id-ID');
  return (
    <div className="grid gap-1 text-xs">
      {describe !== null && isRecord(run.params) && <span className="text-muted-foreground">{t('reports.runs.filters', { filters: describe(run.params) })}</span>}
      {(run.nonLatinRows ?? 0) > 0 && <span>{t('reports.runs.non_latin', { count: number.format(run.nonLatinRows ?? 0) })}</span>}
      {run.warnings.length > 0 && (
        <ul className="list-disc pl-4 font-semibold text-warn">
          {run.warnings.map((code, i) => (
            <li key={i}>{warningText(t, locale, code)}</li>
          ))}
        </ul>
      )}
      {run.status === 'failed' && <span className="font-semibold text-bad">{t('reports.runs.failed', { reason: failureText(t, run.errorCode) })}</span>}
    </div>
  );
}

/** The file of a run: its download (after a password confirmation when it is personal) and its expiry. */
export function RunFile({ run }: { run: ReportRunView }) {
  const t = useT();
  const queryClient = useQueryClient();
  const dateTime = useDateTime();
  if (isRunActive(run.status)) return <span className="text-xs text-muted-foreground">{t('reports.runs.not_ready')}</span>;
  if (run.status !== 'succeeded') return null;
  // The server says whether the file may be downloaded now (its expiry and the user's export permission).
  const expired = run.expiresAt !== null && run.expiresAt <= Date.now();
  if (!run.downloadable) {
    return expired && run.expiresAt !== null ? <span className="text-xs text-muted-foreground">{t('reports.runs.expired', { date: dateTime(run.expiresAt) })}</span> : null;
  }
  const href = runDownloadHref(run.id);
  const label = t('reports.runs.download_label', { format: t(vocabKey('report_format', run.format)), date: dateTime(run.createdAt) });
  const download = async (): Promise<void> => {
    if (await confirmReauth(queryClient)) page.assign(href);
  };
  return (
    <div className="grid justify-items-start gap-1">
      {run.personal ? (
        <Button type="button" size="sm" variant="outline" aria-label={label} onClick={() => void download()}>
          {t('reports.runs.download')}
        </Button>
      ) : (
        <a href={href} download aria-label={label} className={buttonVariants({ size: 'sm', variant: 'outline' })}>
          {t('reports.runs.download')}
        </a>
      )}
      {run.expiresAt !== null && <span className="text-xs text-muted-foreground">{t('reports.runs.expires', { date: dateTime(run.expiresAt) })}</span>}
    </div>
  );
}

/** A run's format, with the paper of a PDF. */
function RunFormat({ run }: { run: ReportRunView }) {
  const t = useT();
  return (
    <span className="grid gap-0.5">
      <span className="whitespace-nowrap">{t(vocabKey('report_format', run.format))}</span>
      {run.paper !== null && <span className="text-xs text-muted-foreground">{t('reports.runs.paper', { paper: run.paper })}</span>}
    </span>
  );
}

const features = tableFeatures({});
const column = createColumnHelper<typeof features, ReportRunView>();
const NO_RUNS: ReportRunView[] = [];

/** `GET reports/runs` of `reportId` from `cursor`. */
function listPath(reportId: string, cursor: string | null): string {
  const q = new URLSearchParams({ reportId, limit: String(PAGE_SIZE) });
  if (cursor !== null) q.set('cursor', cursor);
  return `reports/runs?${q.toString()}`;
}

/** The run list of a report's page (see the top of this file). */
export function RunHistory({ entry, describe }: { entry: ReportCatalogEntry; describe: (params: Record<string, unknown> | null) => string }) {
  const t = useT();
  const me = useMe();
  const locale = useLocale();
  const dateTime = useDateTime();
  const list = useInfiniteQuery({
    queryKey: [...runsKey(entry.id), 'list'],
    // Read again on its own while a run has work ahead: such reads never keep the session alive.
    queryFn: ({ pageParam }) => api<ReportRunListResponse>('GET', listPath(entry.id, pageParam), undefined, { background: true }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: me !== undefined,
    refetchInterval: (q) => (q.state.data?.pages.some((p) => p.runs.some((r) => isRunActive(r.status))) === true ? ACTIVE_POLL_MS : false),
  });
  const runs = useMemo(() => list.data?.pages.flatMap((p) => p.runs) ?? NO_RUNS, [list.data]);
  const withParams = entry.params.length > 0 ? describe : null;

  const columns = useMemo(() => {
    const number = new Intl.NumberFormat(locale === 'en' ? 'en-GB' : 'id-ID');
    return column.columns([
      column.accessor('createdAt', {
        header: t('reports.runs.col.created'),
        cell: (info) => (
          <time dateTime={new Date(info.getValue()).toISOString()} className="whitespace-nowrap">
            {dateTime(info.getValue())}
          </time>
        ),
      }),
      column.display({ id: 'format', header: t('reports.runs.col.format'), cell: (info) => <RunFormat run={info.row.original} /> }),
      column.display({ id: 'status', header: t('reports.runs.col.status'), cell: (info) => <RunStatusBadge status={info.row.original.status} /> }),
      column.accessor('rowCount', {
        header: t('reports.runs.col.rows'),
        cell: (info) => <span className="tabular-nums">{info.getValue() === null ? '' : number.format(info.getValue() ?? 0)}</span>,
      }),
      column.display({ id: 'notes', header: t('reports.runs.col.notes'), cell: (info) => <RunNotes run={info.row.original} describe={withParams} /> }),
      column.display({ id: 'file', header: t('reports.runs.col.file'), cell: (info) => <RunFile run={info.row.original} /> }),
    ]);
  }, [t, dateTime, withParams, locale]);
  const table = useTable({ features, columns, data: runs, getRowId: (r) => r.id });

  return (
    <Section title={t('reports.runs.title')}>
      {list.isError && list.data === undefined ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />
      ) : list.data === undefined ? (
        <SkeletonTable label={t('shell.loading')} rows={3} />
      ) : (
        <>
          <DataTable table={table} caption={t('reports.runs.caption')} empty={t('reports.runs.empty')} alignRight={['rowCount']} />
          {list.isFetchNextPageError && <ProblemAlert error={list.error} />}
          {list.hasNextPage && (
            <div>
              <Button type="button" variant="outline" size="sm" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                {t('reports.runs.load_more')}
              </Button>
            </div>
          )}
        </>
      )}
    </Section>
  );
}
