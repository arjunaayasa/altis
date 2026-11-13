import { KomunitasPlaceholder } from '@/components/komunitas/screen-placeholder';

/**
 * Placeholder of Laporan: the report catalogue (`/admin/reports`), cards of the definitions the user may see,
 * grouped by module. The route, this export name and the lazy chunk are final; the owning task replaces the body.
 */
export function ReportsCatalogScreen() {
  return <KomunitasPlaceholder screen="reports_catalog" />;
}
