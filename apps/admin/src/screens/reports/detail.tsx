import { KomunitasPlaceholder } from '@/components/komunitas/screen-placeholder';

/**
 * Placeholder of one report (`/admin/reports/$reportId`): its filters, the paged preview, printing and the exports.
 * The route, this export name and the lazy chunk are final; the owning task replaces the body.
 */
export function ReportDetailScreen() {
  return <KomunitasPlaceholder screen="report_detail" />;
}
