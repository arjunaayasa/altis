import type { ReportCatalogEntry, ReportCatalogResponse } from '@altis/shared/api/reports';
import { Link } from '@tanstack/react-router';
import { EmptyState, ErrorState, LoadingState, PageHead, Section, Tag } from '@/components/layout';
import { useLocale, useT, type TKey, type Translate } from '@/i18n';
import { isMessageKey } from '@/lib/form-errors';
import { useApiQuery } from '@/lib/me';
import { LibraryStatistics } from '@/screens/dashboard-library';

/**
 * Laporan, the report catalogue (`/admin/reports`; spec §6.3 "Kartu per modul"): `GET reports/catalog` lists the
 * definitions whose permission the user holds (the server decides), and the screen shows one card per module, in a
 * fixed order (Koleksi, then Akreditasi), each a titled part of the page listing its reports by title, one ruled line
 * each, with a link to the report's page. A tag says when a report holds personal data (its exports and downloads ask
 * for the password), when it is a document (made in the accreditation workspace) and when the user may preview it but
 * not export it. Above the cards stands "Statistik perpustakaan" (screens/dashboard-library.tsx): the library's
 * figures of the year, one card per module the user reads.
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
const MODULES = [
  'collection',
  'accreditation',
  'members',
  'visits',
  'circulation',
  'stocktake',
  // ---- Komunitas K5 (reports) ----
  'library',
  'system',
] as const satisfies readonly ReportCatalogEntry['module'][];

/** A report's title: its shared text, or its id when this build has none. */
export function reportTitle(t: Translate, entry: Pick<ReportCatalogEntry, 'id' | 'titleKey'>): string {
  return isMessageKey(entry.titleKey) ? t(entry.titleKey as TKey) : entry.id;
}

/** The tags of a report: personal data, a document, no export. */
export function ReportBadges({ entry }: { entry: ReportCatalogEntry }) {
  const t = useT();
  return (
    <>
      {entry.personal && <Tag tone="warn">{t('reports.badge.personal')}</Tag>}
      {entry.kind === 'document' && <Tag>{t('reports.badge.document')}</Tag>}
      {entry.kind === 'table' && !entry.canExport && <Tag>{t('reports.badge.preview_only')}</Tag>}
    </>
  );
}

/** The part of the page of one module: its name, how many reports, and one ruled line per report. */
function ModuleSection({ module, entries }: { module: (typeof MODULES)[number]; entries: ReportCatalogEntry[] }) {
  const t = useT();
  const locale = useLocale();
  const number = new Intl.NumberFormat(locale === 'en' ? 'en-GB' : 'id-ID');
  return (
    <div data-report-module={module} className="contents">
      <Section title={t(`reports.module.${module}`)} aside={t('reports.catalog.count', { count: number.format(entries.length) })}>
        <ul className="grid border-t text-sm">
          {entries.map((entry) => (
            <li key={entry.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b py-2">
              <Link to={reportHref(entry.id)} className="font-semibold text-accent-text underline-offset-4 hover:underline">
                {reportTitle(t, entry)}
              </Link>
              <ReportBadges entry={entry} />
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

/** The report catalogue (see the top of this file). */
export function ReportsCatalogScreen() {
  const t = useT();
  const catalog = useReportCatalog();
  const reports = catalog.data?.reports ?? [];
  const groups = MODULES.map((module) => ({ module, entries: reports.filter((r) => r.module === module) })).filter((g) => g.entries.length > 0);

  return (
    <div className="grid gap-6">
      <PageHead title={t('reports.catalog.title')} intro={t('reports.catalog.description')} />
      <LibraryStatistics />
      {catalog.isError && catalog.data === undefined ? (
        <ErrorState error={catalog.error} onRetry={() => void catalog.refetch()} retrying={catalog.isFetching} />
      ) : catalog.data === undefined ? (
        <LoadingState lines={8} />
      ) : groups.length === 0 ? (
        <EmptyState title={t('reports.catalog.empty')} />
      ) : (
        <div className="grid items-start gap-x-10 gap-y-8 lg:grid-cols-2">
          {groups.map((g) => (
            <ModuleSection key={g.module} module={g.module} entries={g.entries} />
          ))}
        </div>
      )}
    </div>
  );
}
