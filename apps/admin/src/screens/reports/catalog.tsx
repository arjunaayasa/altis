import type { ReportCatalogEntry, ReportCatalogResponse } from '@altis/shared/api/reports';
import { Link } from '@tanstack/react-router';
import { FileTextIcon } from 'lucide-react';
import { useId } from 'react';
import { Badge, ProblemAlert } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { useLocale, useT, type TKey, type Translate } from '@/i18n';
import { isMessageKey } from '@/lib/form-errors';
import { useApiQuery } from '@/lib/me';

/**
 * Laporan, the report catalogue (`/admin/reports`; spec §6.3 "Kartu per modul"): `GET reports/catalog` lists the
 * definitions whose permission the user holds (the server decides), and the screen shows one card per module, in a
 * fixed order (Koleksi, then Akreditasi), each listing its reports by title with a link to the report's page. A badge
 * says when a report holds personal data (its exports and downloads ask for the password), when it is a document (made
 * in the accreditation workspace) and when the user may preview it but not export it.
 */

/** The query of the catalogue, shared with a report's page. */
export const REPORT_CATALOG_KEY = ['reports', 'catalog'] as const;

/** `GET reports/catalog`. */
export function useReportCatalog() {
  return useApiQuery<ReportCatalogResponse>({ queryKey: REPORT_CATALOG_KEY, path: 'reports/catalog', staleTime: 60_000 });
}

/** The page of a report. */
export const reportHref = (id: string): string => `/admin/reports/${encodeURIComponent(id)}`;

/** The modules, in the order of their cards. */
const MODULES = ['collection', 'accreditation', 'members', 'visits', 'circulation', 'stocktake'] as const satisfies readonly ReportCatalogEntry['module'][];

/** A report's title: its shared text, or its id when this build has none. */
export function reportTitle(t: Translate, entry: Pick<ReportCatalogEntry, 'id' | 'titleKey'>): string {
  return isMessageKey(entry.titleKey) ? t(entry.titleKey as TKey) : entry.id;
}

/** The badges of a report: personal data, a document, no export. */
export function ReportBadges({ entry }: { entry: ReportCatalogEntry }) {
  const t = useT();
  return (
    <>
      {entry.personal && <Badge tone="warning">{t('reports.badge.personal')}</Badge>}
      {entry.kind === 'document' && <Badge tone="info">{t('reports.badge.document')}</Badge>}
      {entry.kind === 'table' && !entry.canExport && <Badge>{t('reports.badge.preview_only')}</Badge>}
    </>
  );
}

/** The card of one module. */
function ModuleCard({ module, entries }: { module: (typeof MODULES)[number]; entries: ReportCatalogEntry[] }) {
  const t = useT();
  const locale = useLocale();
  const headingId = useId();
  const number = new Intl.NumberFormat(locale === 'en' ? 'en-GB' : 'id-ID');
  return (
    <section data-report-module={module} aria-labelledby={headingId} className="flex flex-col gap-3 rounded-lg border bg-card p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h2 id={headingId} className="text-lg font-semibold">
          {t(`reports.module.${module}`)}
        </h2>
        <span className="text-xs text-muted-foreground">{t('reports.catalog.count', { count: number.format(entries.length) })}</span>
      </div>
      <ul className="grid gap-1">
        {entries.map((entry) => (
          <li key={entry.id} className="flex flex-wrap items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent">
            <FileTextIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <Link to={reportHref(entry.id)} className="text-sm font-medium text-primary underline-offset-4 hover:underline">
              {reportTitle(t, entry)}
            </Link>
            <ReportBadges entry={entry} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The report catalogue (see the top of this file). */
export function ReportsCatalogScreen() {
  const t = useT();
  const catalog = useReportCatalog();
  const reports = catalog.data?.reports ?? [];
  const groups = MODULES.map((module) => ({ module, entries: reports.filter((r) => r.module === module) })).filter((g) => g.entries.length > 0);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">{t('reports.catalog.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('reports.catalog.description')}</p>
      </header>
      {catalog.isError ? (
        <ProblemAlert error={catalog.error}>
          <Button variant="outline" size="sm" className="mt-2" onClick={() => void catalog.refetch()}>
            {t('table.retry')}
          </Button>
        </ProblemAlert>
      ) : catalog.data === undefined ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t('shell.loading')}
        </p>
      ) : groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('reports.catalog.empty')}</p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {groups.map((g) => (
            <ModuleCard key={g.module} module={g.module} entries={g.entries} />
          ))}
        </div>
      )}
    </div>
  );
}
