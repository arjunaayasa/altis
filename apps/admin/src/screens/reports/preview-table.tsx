import {
  REPORT_PREVIEW_MAX_LIMIT,
  reportOutputLocale,
  type ReportCatalogEntry,
  type ReportCell,
  type ReportColumnType,
  type ReportColumnView,
  type ReportPreviewBody,
  type ReportPreviewResponse,
} from '@altis/shared/api/reports';
import { useInfiniteQuery, type InfiniteData, type UseInfiniteQueryResult } from '@tanstack/react-query';
import { PrinterIcon } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDateTime } from '@/components/data-table';
import { NoticeAlert, ProblemAlert } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { I18nProvider, useLocale, useT, type TKey } from '@/i18n';
import { ApiError, api } from '@/lib/api';
import { isMessageKey } from '@/lib/form-errors';
import { useMe } from '@/lib/me';
import { cn } from '@/lib/utils';
import { reportTitle } from './catalog';
import { serverParamErrors, useDescribeParams, useParamOptions } from './param-form';
// ---- Komunitas K5 (reports) ----
import { PreviewChart } from './preview-chart';
import './print.css';

/**
 * The paged preview of a report's page (spec §4.15 "Pratinjau", §6.3): `POST reports/:reportId/preview` with the
 * applied filters, {@link REPORT_PREVIEW_MAX_LIMIT} rows a page; "Muat lagi" sends the last page's cursor and appends
 * the next page; the totals row (the first page's) closes the table. The columns are the answer's (a definition's
 * columns may depend on its parameters), labelled with the shared report texts; cells are formatted by their column's
 * type (numbers, money in major units, whole percents, `YYYY-MM-DD` dates), text cells keep their own script direction
 * (`dir="auto"`: Arabic titles read right to left).
 *
 * The table and its printed copy are in the language of the report's output (`reportOutputLocale`), as the server
 * writes the cells and the export: an accreditation annex always in Indonesian, the language of the files handed to the
 * assessors, whatever the reader reads (its heads, title, filters in words, printed line, dates and numbers); any other
 * report in the UI language. The section around them (its heading, the count of rows, the buttons, the refusals) is
 * in the UI language. The table and the copy say their language (`lang`).
 *
 * - A report that would scan too much for a preview is refused with 422 `{path: 'params', code: 'export_only'}`: the
 *   screen says so (`report.export_only`) and the export stays offered, on a later page too (a list whose rest needs
 *   the scan of a large library: the rows shown stay). A refused filter is marked on its field by the
 *   page (param-form.tsx `serverParamErrors`); here a line says to check the marked filters.
 * - **Cetak** prints the rows on screen through the print stylesheet (print.css): a copy of the table is put at the
 *   end of the page for the print only, with the library's name, the report's title, its filters in words and who
 *   printed it when, and the rest of the page is left out of the print. More rows than shown are in the PDF export,
 *   which the copy says when there is a next page. The copy is hidden from the screen and from assistive technology.
 */

/** The filters a preview runs with; `n` counts the "Terapkan" presses, so pressing it again reads afresh. */
export interface AppliedParams {
  params: Record<string, unknown>;
  n: number;
}

type PreviewQuery = UseInfiniteQueryResult<InfiniteData<ReportPreviewResponse, string | null>, Error>;

/** The preview of `reportId` with `applied` (nothing before the first "Terapkan"). */
export function useReportPreview(reportId: string, applied: AppliedParams | null): PreviewQuery {
  const me = useMe();
  return useInfiniteQuery({
    queryKey: ['reports', 'preview', reportId, applied?.n ?? 0, applied?.params ?? null],
    queryFn: ({ pageParam, signal }) => {
      const body: ReportPreviewBody = { params: applied?.params ?? {}, ...(pageParam === null ? {} : { cursor: pageParam }), limit: REPORT_PREVIEW_MAX_LIMIT };
      return api<ReportPreviewResponse>('POST', `reports/${encodeURIComponent(reportId)}/preview`, body, { signal });
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: me !== undefined && applied !== null,
    // A preview is read when asked for: never again behind the user's back (a refetch would read every page again).
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    // A refusal is the answer; only a lost connection is worth asking again.
    retry: (count, e) => !(e instanceof ApiError) && count < 2,
  });
}

/** Whether `e` is the preview's refusal of a report too large to preview. */
export function isExportOnly(e: unknown): boolean {
  return e instanceof ApiError && e.code === 'VALIDATION_FAILED' && (e.errors ?? []).some((x) => x.path === 'params' && x.code === 'export_only');
}

const NUMERIC: ReadonlySet<ReportColumnType> = new Set<ReportColumnType>(['int', 'money', 'percent']);

/** Formats a cell by its column's type in the current language (the output's, under the section's provider). */
export function useCellFormat(): (type: ReportColumnType, cell: ReportCell) => string {
  const locale = useLocale();
  return useMemo(() => {
    const tag = locale === 'en' ? 'en-GB' : 'id-ID';
    const integer = new Intl.NumberFormat(tag, { maximumFractionDigits: 0 });
    const money = new Intl.NumberFormat(tag, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
    const percent = new Intl.NumberFormat(tag, { style: 'percent', maximumFractionDigits: 0 });
    const date = new Intl.DateTimeFormat(tag, { dateStyle: 'medium', timeZone: 'UTC' });
    return (type, cell) => {
      if (cell === null) return '';
      if (typeof cell === 'number' && Number.isFinite(cell)) {
        if (type === 'int') return integer.format(cell);
        if (type === 'money') return money.format(cell);
        if (type === 'percent') return percent.format(cell / 100);
        return String(cell);
      }
      if (type === 'date' && typeof cell === 'string') {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(cell);
        if (m !== null) return date.format(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
      }
      return String(cell);
    };
  }, [locale]);
}

/** A column's label: the shared report text, or its key when this build has none. */
function columnLabel(t: ReturnType<typeof useT>, c: ReportColumnView): string {
  return isMessageKey(c.labelKey) ? t(c.labelKey as TKey) : c.key;
}

/** The rows of a report as a table (on screen and in the printed copy), in the current language. */
export function ReportTable({
  columns,
  rows,
  totals,
  caption,
  className,
}: {
  columns: readonly ReportColumnView[];
  rows: readonly (readonly ReportCell[])[];
  totals: readonly ReportCell[] | null;
  caption: string;
  className?: string;
}) {
  const t = useT();
  const locale = useLocale();
  const format = useCellFormat();
  const cellClass = (c: ReportColumnView): string => cn('px-3 py-2', NUMERIC.has(c.type) && 'text-right tabular-nums whitespace-nowrap');
  const cells = (row: readonly ReportCell[], foot: boolean) =>
    columns.map((c, i) => {
      const value = row[i] ?? null;
      return (
        <td key={c.key} className={cn(cellClass(c), foot && 'font-semibold')} dir={c.type === 'text' ? 'auto' : undefined}>
          {format(c.type, value)}
        </td>
      );
    });
  return (
    <div className={cn('overflow-x-auto rounded-md border', className)}>
      <table lang={locale} className="w-full text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="bg-muted/50 text-left">
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" className={cn('px-3 py-2 font-medium whitespace-nowrap text-muted-foreground', NUMERIC.has(c.type) && 'text-right')}>
                {columnLabel(t, c)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={Math.max(1, columns.length)} className="px-3 py-6 text-center text-muted-foreground">
                {t('reports.preview.empty')}
              </td>
            </tr>
          ) : (
            rows.map((row, i) => (
              <tr key={i} className="border-t align-top">
                {cells(row, false)}
              </tr>
            ))
          )}
        </tbody>
        {totals !== null && (
          <tfoot className="border-t-2 bg-muted/30">
            <tr>{cells(totals, true)}</tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

/** The attribute on `<html>` that print.css reads while a report is printed. */
const PRINT_ATTRIBUTE = 'data-print';

/** The on-screen table of the preview, its caption naming the report in the current language. */
function ScreenTable({
  entry,
  columns,
  rows,
  totals,
}: {
  entry: ReportCatalogEntry;
  columns: readonly ReportColumnView[];
  rows: readonly (readonly ReportCell[])[];
  totals: readonly ReportCell[] | null;
}) {
  const t = useT();
  return <ReportTable columns={columns} rows={rows} totals={totals} caption={t('reports.preview.caption', { title: reportTitle(t, entry) })} />;
}

/**
 * The copy of the table that is printed (see the top of this file), wholly in the current language: the report's
 * title, the applied filters `params` in words and the printed line are said here in that language.
 */
function PrintCopy({
  entry,
  params,
  columns,
  rows,
  totals,
  more,
}: {
  entry: ReportCatalogEntry;
  params: Readonly<Record<string, unknown>> | null;
  columns: readonly ReportColumnView[];
  rows: readonly (readonly ReportCell[])[];
  totals: readonly ReportCell[] | null;
  more: boolean;
}) {
  const t = useT();
  const locale = useLocale();
  const me = useMe();
  const dateTime = useDateTime();
  // The option lists are those the filter form already read (the same queries): the copy names them in its language.
  const describe = useDescribeParams(entry, useParamOptions(entry));
  const [at] = useState(() => Date.now());
  const library = me?.library.name ?? '';
  const name = me?.authenticated === true ? me.user.name : '';
  const title = reportTitle(t, entry);
  const filters = describe(params);
  return createPortal(
    <div className="report-print-copy" lang={locale} data-report-print="" data-orientation={entry.orientation} aria-hidden="true">
      <header className="report-print-header">
        {library !== '' && <p>{library}</p>}
        <h1>{title}</h1>
        <p>{t('reports.print.filters', { filters })}</p>
        <p>{t('reports.print.printed', { date: dateTime(at), name })}</p>
        {more && <p>{t('reports.print.partial', { count: rows.length })}</p>}
      </header>
      <ReportTable columns={columns} rows={rows} totals={totals} caption={title} />
    </div>,
    document.body,
  );
}

/**
 * The preview section: what to do before the first "Terapkan", the table and "Muat lagi", the refusals, and "Cetak".
 * `params` are the applied filters (null before the first "Terapkan"), said in words on the printed copy.
 */
export function PreviewSection({ entry, query, params }: { entry: ReportCatalogEntry; query: PreviewQuery; params: Readonly<Record<string, unknown>> | null }) {
  const t = useT();
  const locale = useLocale();
  const output = reportOutputLocale(entry.module, locale);
  const applied = params !== null;
  const headingId = useId();
  const number = new Intl.NumberFormat(locale === 'en' ? 'en-GB' : 'id-ID');
  const pages = query.data?.pages;
  const rows = useMemo(() => pages?.flatMap((p) => p.rows) ?? [], [pages]);
  const first = pages?.[0];
  const columns = first?.columns ?? [];
  const totals = first?.totals ?? null;

  // ---- Cetak: the copy is on the page while a print is asked for, until the browser says it printed --------------
  const [printing, setPrinting] = useState(0);
  const print = useCallback(() => setPrinting((n) => n + 1), []);
  useEffect(() => {
    if (printing === 0) return;
    const root = document.documentElement;
    const done = (): void => {
      window.removeEventListener('afterprint', done);
      root.removeAttribute(PRINT_ATTRIBUTE);
      setPrinting(0);
    };
    root.setAttribute(PRINT_ATTRIBUTE, 'report');
    window.addEventListener('afterprint', done);
    window.print();
    return () => window.removeEventListener('afterprint', done);
  }, [printing]);
  useEffect(() => () => document.documentElement.removeAttribute(PRINT_ATTRIBUTE), []);

  let body;
  if (!applied) {
    body = <p className="text-sm text-muted-foreground">{t('reports.preview.hint')}</p>;
  } else if (query.isError && first === undefined) {
    body = isExportOnly(query.error) ? (
      <NoticeAlert>{t('report.export_only')}</NoticeAlert>
    ) : serverParamErrors(entry, query.error) !== null ? (
      <p role="alert" className="text-sm text-destructive">
        {t('reports.params.check')}
      </p>
    ) : (
      <ProblemAlert error={query.error} />
    );
  } else if (first === undefined) {
    body = (
      <p role="status" className="text-sm text-muted-foreground">
        {t('shell.loading')}
      </p>
    );
  } else {
    body = (
      <div className="flex flex-col gap-3">
        <I18nProvider locale={output}>
          <PreviewChart entry={entry} columns={columns} rows={rows} totals={totals} />
          <ScreenTable entry={entry} columns={columns} rows={rows} totals={totals} />
        </I18nProvider>
        {query.isFetchNextPageError && (isExportOnly(query.error) ? <NoticeAlert>{t('report.export_only')}</NoticeAlert> : <ProblemAlert error={query.error} />)}
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="text-muted-foreground">{t('reports.preview.shown', { count: number.format(rows.length) })}</span>
          {query.hasNextPage ? (
            <Button type="button" variant="outline" size="sm" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
              {t(query.isFetchingNextPage ? 'shell.loading' : 'reports.preview.load_more')}
            </Button>
          ) : (
            rows.length > 0 && <span className="text-muted-foreground">{t('reports.preview.end')}</span>
          )}
        </div>
      </div>
    );
  }

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={headingId} className="text-lg font-semibold">
          {t('reports.preview.title')}
        </h2>
        <Button type="button" variant="outline" size="sm" disabled={first === undefined || rows.length === 0} onClick={print} title={t('reports.preview.print_hint')}>
          <PrinterIcon aria-hidden="true" />
          {t('reports.preview.print')}
        </Button>
      </div>
      {body}
      {printing > 0 && first !== undefined && (
        <I18nProvider locale={output}>
          <PrintCopy entry={entry} params={params} columns={columns} rows={rows} totals={totals} more={query.hasNextPage} />
        </I18nProvider>
      )}
    </section>
  );
}
