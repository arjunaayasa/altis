import {
  REPORT_PAPERS,
  REPORT_RUN_TTL_DAYS,
  type ReportCatalogEntry,
  type ReportPaper,
  type ReportRunCreateBody,
  type ReportRunStarted,
  type ReportRunView,
} from '@altis/shared/api/reports';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useRef, useState } from 'react';
import { Field, Notice, ProblemAlert, SELECT_CLASS } from '@/components/form-field';
import { JobProgress, type JobOutcome } from '@/components/job-progress';
import { LAYER, Section } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { useLocale, useT } from '@/i18n';
import { ApiError, api } from '@/lib/api';
import { useApiQuery } from '@/lib/me';
import { cn } from '@/lib/utils';
import { RunFile, RunNotes, RunStatusBadge, confirmReauth, runsKey } from './run-history';

/**
 * The exports of a report's page (spec §4.15 "Ekspor", §6.3, §13): one button per format the definition writes
 * ("Ekspor CSV", "Ekspor XLSX", "Ekspor PDF"), with the paper of a PDF (A4 or F4) for a landscape report. An export
 * takes the filters of the form as they stand (checked first, like "Terapkan") and starts a run:
 *
 * - `POST reports/runs` for a report without personal data;
 * - for a report holding personal data, the password confirmation first (the reauth dialog), then
 *   `POST reports/runs/personal`; a cancelled confirmation starts nothing.
 *
 * The start carries an `Idempotency-Key` that stays the same while the body does (a retry after a lost answer gets the
 * same run back). A report too large for the format (422 `REPORT_TOO_LARGE`, refused before any work) says how many
 * rows it has and how many the format holds, read from the problem's detail (its numbers are not sent otherwise). A
 * filter the server refuses is marked on its field by the page. Then the run's job is followed (`JobProgress`, which
 * drives it from the page where no worker runs), and once it ended the run shows its status, its notes and its file,
 * and the run list is read again.
 */

/** The formats the generic export writes. */
const TABLE_FORMATS = ['csv', 'xlsx', 'pdf'] as const;

type TableFormat = (typeof TABLE_FORMATS)[number];

/** The numbers of a problem's `detail`, read from its first (Indonesian) half. */
function countsIn(detail: string | undefined): number[] {
  if (detail === undefined) return [];
  const own = detail.split(' / ', 1)[0] ?? '';
  return [...own.matchAll(/\d+/g)].map((m) => Number(m[0]));
}

/** The `Idempotency-Key` of a start: the same while the body stays the same, a fresh one for another body. */
function useStartKey(): { key(body: unknown): string; clear(): void } {
  const last = useRef<{ body: string; key: string } | null>(null);
  return {
    key(body) {
      const text = JSON.stringify(body);
      if (last.current?.body !== text) {
        const random = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
        last.current = { body: text, key: `report-run:${random}` };
      }
      return last.current.key;
    },
    clear() {
      last.current = null;
    },
  };
}

/** A started export: its job's progress, then its run. */
function StartedRun({
  entry,
  started,
  format,
  describe,
}: {
  entry: ReportCatalogEntry;
  started: ReportRunStarted;
  format: TableFormat;
  describe(params: Record<string, unknown> | null): string;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const headingId = useId();
  const [outcome, setOutcome] = useState<JobOutcome | null>(null);
  const run = useApiQuery<ReportRunView>({
    queryKey: [...runsKey(entry.id), 'detail', started.id],
    path: `reports/runs/${encodeURIComponent(started.id)}`,
    enabled: outcome !== null,
  });
  return (
    <section aria-labelledby={headingId} className={cn('grid max-w-3xl gap-3 rounded-lg border p-4', LAYER)}>
      <h3 id={headingId} className="text-sm font-bold">
        {t('reports.export.running', { format: format.toUpperCase() })}
      </h3>
      <JobProgress
        jobId={started.jobId}
        onDone={(status) => {
          setOutcome(status);
          void queryClient.invalidateQueries({ queryKey: runsKey(entry.id) });
        }}
      />
      {outcome === null && <p className="text-sm text-muted-foreground">{t('reports.export.leave_hint')}</p>}
      {run.isError && <ProblemAlert error={run.error} />}
      {run.data !== undefined && (
        <div className="grid gap-2">
          {/* The job's progress above already says how it ended: the run's own status only where it says otherwise. */}
          {run.data.status !== outcome && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <RunStatusBadge status={run.data.status} />
            </div>
          )}
          <RunNotes run={run.data} describe={entry.params.length > 0 ? describe : null} />
          <RunFile run={run.data} />
        </div>
      )}
    </section>
  );
}

export interface ExportPanelProps {
  entry: ReportCatalogEntry;
  /** The filters of the form as the definition takes them, or null when a field is in error (then marked). */
  collect(): Record<string, unknown> | null;
  /** Marks the server's field errors of a refused start on the form; false when the problem names no filter. */
  markFieldErrors(e: unknown): boolean;
  /** Says the parameters of a run in words. */
  describe(params: Record<string, unknown> | null): string;
}

/** The export section (see the top of this file). */
export function ExportPanel({ entry, collect, markFieldErrors, describe }: ExportPanelProps) {
  const t = useT();
  const locale = useLocale();
  const queryClient = useQueryClient();
  const startKey = useStartKey();
  const [paper, setPaper] = useState<ReportPaper>('A4');
  const [posting, setPosting] = useState(false);
  /** A start is under way (the password dialog included): another press waits for it. */
  const busy = useRef(false);
  const [problem, setProblem] = useState<unknown>(null);
  const [fieldsMarked, setFieldsMarked] = useState(false);
  const [tooLarge, setTooLarge] = useState<string | null>(null);
  const [started, setStarted] = useState<{ run: ReportRunStarted; format: TableFormat } | null>(null);
  const formats = TABLE_FORMATS.filter((f) => entry.formats.includes(f));
  const offersPaper = entry.orientation === 'landscape' && formats.includes('pdf');
  const number = new Intl.NumberFormat(locale === 'en' ? 'en-GB' : 'id-ID');

  const start = async (format: TableFormat): Promise<void> => {
    if (busy.current) return;
    setProblem(null);
    setTooLarge(null);
    const params = collect();
    setFieldsMarked(params === null);
    if (params === null) return;
    busy.current = true;
    setPosting(true);
    try {
      if (entry.personal && !(await confirmReauth(queryClient))) return;
      const body: ReportRunCreateBody = { reportId: entry.id, format, params, ...(format === 'pdf' && offersPaper ? { pdf: { paper } } : {}) };
      const run = await api<ReportRunStarted>('POST', entry.personal ? 'reports/runs/personal' : 'reports/runs', body, { idempotencyKey: startKey.key(body) });
      startKey.clear();
      setStarted({ run, format });
      void queryClient.invalidateQueries({ queryKey: runsKey(entry.id) });
    } catch (e) {
      const [rows, max] = e instanceof ApiError && e.code === 'REPORT_TOO_LARGE' ? countsIn(e.detail) : [];
      if (rows !== undefined && max !== undefined) {
        setTooLarge(t('reports.export.too_large', { rows: number.format(rows), max: number.format(max), format: format.toUpperCase() }));
      } else if (markFieldErrors(e)) {
        setFieldsMarked(true);
      } else {
        setProblem(e);
      }
    } finally {
      busy.current = false;
      setPosting(false);
    }
  };

  return (
    <Section title={t('reports.export.title')}>
      {entry.personal && <p className="max-w-[75ch] text-sm">{t('reports.export.personal_hint')}</p>}
      <div className="flex flex-wrap items-end gap-3">
        {offersPaper && (
          <Field label={t('reports.export.paper')} className="w-48">
            {(c) => (
              <select {...c} className={SELECT_CLASS} value={paper} onChange={(e) => setPaper(e.target.value as ReportPaper)}>
                {REPORT_PAPERS.map((p) => (
                  <option key={p} value={p}>
                    {t(`reports.export.paper.${p}`)}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}
        <div className="flex flex-wrap gap-2">
          {formats.map((f) => (
            <Button key={f} type="button" variant="outline" disabled={posting} onClick={() => void start(f)}>
              {t(`reports.export.${f}`)}
            </Button>
          ))}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{t('reports.export.hint', { days: REPORT_RUN_TTL_DAYS })}</p>
      {fieldsMarked && (
        <p role="alert" className="text-meta font-semibold text-bad">
          {t('reports.params.check')}
        </p>
      )}
      {tooLarge !== null && <Notice kind="error">{tooLarge}</Notice>}
      <ProblemAlert error={problem} />
      {started !== null && <StartedRun key={started.run.id} entry={entry} started={started.run} format={started.format} describe={describe} />}
    </Section>
  );
}
