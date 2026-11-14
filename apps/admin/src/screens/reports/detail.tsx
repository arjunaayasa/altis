import type { ReportCatalogEntry } from '@altis/shared/api/reports';
import { Link, useParams, useSearch } from '@tanstack/react-router';
import { ArrowLeftIcon } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Badge, NoticeAlert, ProblemAlert } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n';
import { ReportBadges, reportTitle, useReportCatalog } from './catalog';
import { ExportPanel } from './export-panel';
import {
  ParamForm,
  emptyValues,
  paramsOf,
  serverParamErrors,
  useDescribeParams,
  useParamOptions,
  valuesFromSearch,
  type ParamErrors,
  type ParamValue,
} from './param-form';
import { PreviewSection, useReportPreview, type AppliedParams } from './preview-table';
import { RunHistory } from './run-history';

/**
 * One report (`/admin/reports/$reportId`; spec §4.15, §6.3): the definition as `GET reports/catalog` lists it to the
 * user, then for a table report its filters (param-form.tsx), its exports (export-panel.tsx), its paged preview with
 * "Cetak" (preview-table.tsx), and the user's own runs of it (run-history.tsx). A document report (the accreditation
 * dossier, the self-assessment, the statement) is made in the accreditation workspace: its page says so, links there
 * and lists the user's runs of it. A report the user may not open, or that does not exist, is "not found" either way.
 *
 * The filters start empty, or with the values the page address gives (`?periodId=…`), so a link from elsewhere can
 * open a report on a period or a date. "Terapkan" checks them and reads the preview; an export takes them as they
 * stand. A field the server refuses (on the preview or on an export start) is marked where the user typed it.
 */

/** The report page (see the top of this file). */
export function ReportDetailScreen() {
  const t = useT();
  const { reportId = '' } = useParams({ strict: false }) as { reportId?: string };
  const search = useSearch({ strict: false }) as Readonly<Record<string, unknown>>;
  const catalog = useReportCatalog();
  const entry = catalog.data?.reports.find((r) => r.id === reportId);

  if (catalog.isError) {
    return (
      <Frame>
        <ProblemAlert error={catalog.error}>
          <Button variant="outline" size="sm" className="mt-2" onClick={() => void catalog.refetch()}>
            {t('table.retry')}
          </Button>
        </ProblemAlert>
      </Frame>
    );
  }
  if (catalog.data === undefined) {
    return (
      <Frame>
        <p role="status" className="text-sm text-muted-foreground">
          {t('shell.loading')}
        </p>
      </Frame>
    );
  }
  if (entry === undefined) {
    return (
      <Frame>
        <h1 className="text-2xl font-semibold">{t('reports.catalog.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('reports.detail.not_found')}</p>
      </Frame>
    );
  }
  return <ReportPage key={entry.id} entry={entry} search={search} />;
}

/** The back link and the page's column. */
function Frame({ children }: { children: ReactNode }) {
  const t = useT();
  return (
    <div className="flex flex-col gap-6">
      <Link to="/admin/reports" className="inline-flex items-center gap-1 self-start text-sm text-primary underline-offset-4 hover:underline">
        <ArrowLeftIcon className="size-4" aria-hidden="true" />
        {t('reports.detail.back')}
      </Link>
      {children}
    </div>
  );
}

function ReportPage({ entry, search }: { entry: ReportCatalogEntry; search: Readonly<Record<string, unknown>> }) {
  const t = useT();
  const title = reportTitle(t, entry);
  const options = useParamOptions(entry);
  const describe = useDescribeParams(entry, options);
  const [values, setValues] = useState<Record<string, ParamValue>>(() => ({ ...emptyValues(entry), ...valuesFromSearch(entry, search) }));
  const [errors, setErrors] = useState<ParamErrors>({});
  const [applied, setApplied] = useState<AppliedParams | null>(null);
  const preview = useReportPreview(entry.id, applied);
  const table = entry.kind === 'table';

  // A filter the server refused on the preview is marked on its field.
  const previewError = preview.error;
  useEffect(() => {
    const marked = serverParamErrors(entry, previewError);
    if (marked !== null) setErrors(marked);
  }, [entry, previewError]);

  /** The filters as the definition takes them, or null after marking the fields in error. */
  const collect = (): Record<string, unknown> | null => {
    const result = paramsOf(entry, values);
    setErrors(result.errors);
    return Object.keys(result.errors).length === 0 ? result.params : null;
  };

  const change = (name: string, value: ParamValue): void => {
    setValues((current) => ({ ...current, [name]: value }));
    setErrors((current) => Object.fromEntries(Object.entries(current).filter(([key]) => key !== name && !key.startsWith(`${name}.`))));
  };

  const apply = (): void => {
    const params = collect();
    if (params !== null) setApplied((current) => ({ params, n: (current?.n ?? 0) + 1 }));
  };

  const reset = (): void => {
    setValues(emptyValues(entry));
    setErrors({});
  };

  const markFieldErrors = (e: unknown): boolean => {
    const marked = serverParamErrors(entry, e);
    if (marked === null) return false;
    setErrors(marked);
    return true;
  };

  return (
    <Frame>
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">{title}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <Badge>{t(`reports.module.${entry.module}`)}</Badge>
          <ReportBadges entry={entry} />
        </div>
      </header>
      {table ? (
        <>
          <ParamForm entry={entry} values={values} errors={errors} options={options} onChange={change} onApply={apply} onReset={reset} />
          {entry.canExport ? (
            <ExportPanel entry={entry} collect={collect} markFieldErrors={markFieldErrors} describe={describe} />
          ) : (
            <NoticeAlert>{t('reports.export.no_permission')}</NoticeAlert>
          )}
          <PreviewSection entry={entry} title={title} query={preview} applied={applied !== null} filters={describe(applied?.params ?? null)} />
        </>
      ) : (
        <NoticeAlert>
          <span>{t('reports.detail.document')}</span>{' '}
          <Link to="/admin/accreditation" className="text-primary underline-offset-4 hover:underline">
            {t('reports.detail.document_link')}
          </Link>
        </NoticeAlert>
      )}
      <RunHistory entry={entry} describe={describe} />
    </Frame>
  );
}
