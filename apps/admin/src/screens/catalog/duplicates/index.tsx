import type { RunListResponse, RunStarted, RunView } from '@altis/shared/api/catalog/runs';
import { useQueryClient } from '@tanstack/react-query';
import { FileTextIcon, ScanSearchIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { useDateTime } from '@/components/data-table';
import { Badge, Notice, ProblemAlert } from '@/components/form-field';
import { JobProgress } from '@/components/job-progress';
import { Button, buttonVariants } from '@/components/ui/button';
import { useLocale, useT } from '@/i18n';
import { holds } from '@/lib/access';
import { api } from '@/lib/api';
import { useApiQuery, useMe } from '@/lib/me';
import { RUNS_KEY, dedupeSummaryOf, isRunActive, reportHref, runKey } from '../exchange/summary-view';
import { Compare } from './compare';

/**
 * Duplikat (Phase 2 spec §3.3, §13; plan Task 29; `catalog.records.manage`, which the scan and the merge need):
 *
 * - **The scan:** the last duplicate scan (`GET catalog/runs?kind=dedupe_scan&limit=1`) shows on opening. "Pindai
 *   katalog" starts one (`POST catalog/dedupe-scans`; the server answers the live scan when one is running), and
 *   `JobProgress` follows its job (driven from the page where no worker runs), then its run is read. A scan still
 *   running when the page opens is followed the same way.
 * - **The groups:** the run summary's `preview` (the first groups, up to 200 of at most 20 records; same ISBN, or same
 *   title and year, never fuzzy), with the counts, and the CSV report for the full list (`GET catalog/runs/:id/report`).
 * - **Compare** (compare.tsx): two live records of a group side by side, and the merge after a confirmation. A merge
 *   made here marks its group "Selesai" once one live record is left (this page remembers its merges per scan; the
 *   next scan starts from the catalogue as it is).
 */

/** The last scan: newest first, one row. */
const LAST_SCAN_PATH = 'catalog/runs?kind=dedupe_scan&limit=1';
const LAST_SCAN_KEY = [...RUNS_KEY, 'list', { kind: 'dedupe_scan', limit: 1 }] as const;

/** A scan's groups (from its summary) with the table and the comparison of one group. */
function ScanResult({ run }: { run: RunView }) {
  const t = useT();
  const locale = useLocale();
  const dateTime = useDateTime();
  const headingId = useId();
  const [open, setOpen] = useState<number | null>(null);
  // The merges made on this page for this scan: source id → target id.
  const [merged, setMerged] = useState<Record<string, string>>({});
  const number = new Intl.NumberFormat(locale === 'en' ? 'en-GB' : 'id-ID');
  const summary = dedupeSummaryOf(run.summary);

  if (run.status !== 'succeeded' || summary === null) {
    return isRunActive(run.status) ? null : <Notice kind="error">{t('catalog.duplicates.failed')}</Notice>;
  }
  const total = summary.groups.isbn + summary.groups.title_year;
  const groups = summary.preview;
  const liveIn = (ids: readonly string[]): number => ids.filter((id) => !Object.prototype.hasOwnProperty.call(merged, id)).length;
  return (
    <div className="grid gap-4">
      <div className="grid gap-2 text-sm">
        {run.finishedAt !== null && <p className="text-muted-foreground">{t('catalog.duplicates.last_scan', { date: dateTime(run.finishedAt) })}</p>}
        <p>
          {t('catalog.duplicates.counts', {
            isbn: number.format(summary.groups.isbn),
            titles: number.format(summary.groups.title_year),
            records: number.format(summary.records),
          })}
        </p>
        {groups.length < total && <p className="text-muted-foreground">{t('catalog.duplicates.preview_note', { shown: number.format(groups.length), total: number.format(total) })}</p>}
        {run.reportFileId !== null && (
          <div>
            <a href={reportHref(run.id)} download className={buttonVariants({ variant: 'outline', size: 'sm' })}>
              <FileTextIcon aria-hidden="true" />
              {t('catalog.duplicates.report')}
            </a>
          </div>
        )}
      </div>
      <section aria-labelledby={headingId} className="grid gap-2">
        <h2 id={headingId} className="text-lg font-semibold">
          {t('catalog.duplicates.groups')}
        </h2>
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <caption className="sr-only">{t('catalog.duplicates.groups')}</caption>
            <thead className="bg-muted/50 text-left">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium whitespace-nowrap text-muted-foreground">
                  {t('catalog.duplicates.col.group')}
                </th>
                <th scope="col" className="px-3 py-2 font-medium whitespace-nowrap text-muted-foreground">
                  {t('catalog.duplicates.col.reason')}
                </th>
                <th scope="col" className="px-3 py-2 font-medium whitespace-nowrap text-muted-foreground">
                  {t('catalog.duplicates.col.records')}
                </th>
                <th scope="col" className="px-3 py-2">
                  <span className="sr-only">{t('table.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {groups.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-3 py-6 text-center text-muted-foreground">
                    {t('catalog.duplicates.empty')}
                  </td>
                </tr>
              ) : (
                groups.map((g, i) => (
                  <tr key={i} className={open === i ? 'border-t bg-muted/40 align-top' : 'border-t align-top'}>
                    <td className="px-3 py-2 tabular-nums">{i + 1}</td>
                    <td className="px-3 py-2">
                      <span className="flex flex-wrap items-center gap-1">
                        {t(`catalog.duplicates.reason.${g.reason}`)}
                        {liveIn(g.recordIds) <= 1 && <Badge tone="info">{t('catalog.duplicates.group_done')}</Badge>}
                      </span>
                    </td>
                    <td className="px-3 py-2 tabular-nums">{g.recordIds.length}</td>
                    <td className="px-3 py-2 text-right">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        aria-label={t('catalog.duplicates.compare_label', { n: String(i + 1) })}
                        aria-pressed={open === i}
                        onClick={() => setOpen(open === i ? null : i)}
                      >
                        {t('catalog.duplicates.compare')}
                      </Button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
      {open !== null && groups[open] !== undefined && (
        <Compare
          key={`${run.id}:${open}`}
          n={open + 1}
          recordIds={groups[open].recordIds}
          merged={merged}
          onMerged={(source, target) => setMerged((m) => ({ ...m, [source]: target }))}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}

/** A scan with work ahead: its job's progress, then its run. */
function FollowScan({ started, onDone }: { started: RunStarted; onDone(): void }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [ended, setEnded] = useState(false);
  const run = useApiQuery<RunView>({ queryKey: runKey(started.runId), path: `catalog/runs/${encodeURIComponent(started.runId)}`, enabled: ended });
  return (
    <div className="grid gap-4">
      <section aria-label={t('catalog.duplicates.scanning')} className="grid gap-2 rounded-lg border p-4">
        <JobProgress
          jobId={started.jobId}
          onDone={() => {
            setEnded(true);
            onDone();
            void queryClient.invalidateQueries({ queryKey: RUNS_KEY });
          }}
        />
        {!ended && <p className="text-sm text-muted-foreground">{t('catalog.duplicates.leave_hint')}</p>}
      </section>
      {run.isError && <ProblemAlert error={run.error} />}
      {run.data !== undefined && <ScanResult run={run.data} />}
    </div>
  );
}

export function DuplicatesScreen() {
  const t = useT();
  const me = useMe();
  const canManage = holds(me, 'catalog.records.manage');
  const last = useApiQuery<RunListResponse>({ queryKey: LAST_SCAN_KEY, path: LAST_SCAN_PATH, enabled: canManage });
  const [started, setStarted] = useState<RunStarted | null>(null);
  /** The followed scan whose job has ended (its run is being read or shown). */
  const [ended, setEnded] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);
  const lastRun = last.data?.items[0];
  // A scan started here, else the last one while it still has work ahead.
  const following: RunStarted | null =
    started ?? (lastRun !== undefined && isRunActive(lastRun.status) && lastRun.jobId !== null ? { runId: lastRun.id, jobId: lastRun.jobId } : null);
  const busy = posting || (following !== null && ended !== following.runId);

  const scan = async (): Promise<void> => {
    if (busy) return;
    setProblem(null);
    setPosting(true);
    try {
      const next = await api<RunStarted>('POST', 'catalog/dedupe-scans', {});
      setStarted(next);
    } catch (e) {
      setProblem(e);
    } finally {
      setPosting(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex max-w-2xl flex-col gap-1">
          <h1 className="text-2xl font-semibold">{t('nav.catalog.duplicates')}</h1>
          <p className="text-sm text-muted-foreground">{t('catalog.duplicates.description')}</p>
        </div>
        {canManage && (last.data !== undefined || last.isError) && (
          <Button type="button" disabled={busy} onClick={() => void scan()}>
            <ScanSearchIcon aria-hidden="true" />
            {t(lastRun === undefined && started === null ? 'catalog.duplicates.scan' : 'catalog.duplicates.scan_again')}
          </Button>
        )}
      </header>
      {!canManage ? (
        <Notice kind="error">{t('error.AUTHZ_DENIED')}</Notice>
      ) : (
        <>
          <ProblemAlert error={problem} />
          {last.isError && last.data === undefined ? (
            <ProblemAlert error={last.error} />
          ) : last.data === undefined ? (
            <p role="status" className="text-sm text-muted-foreground">
              {t('shell.loading')}
            </p>
          ) : following !== null ? (
            <FollowScan key={following.runId} started={following} onDone={() => setEnded(following.runId)} />
          ) : lastRun === undefined ? (
            <p className="text-sm text-muted-foreground">{t('catalog.duplicates.never')}</p>
          ) : (
            <ScanResult key={lastRun.id} run={lastRun} />
          )}
        </>
      )}
    </div>
  );
}
