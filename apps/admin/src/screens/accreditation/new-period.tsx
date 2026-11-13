import { KomunitasPlaceholder } from '@/components/komunitas/screen-placeholder';

/**
 * Placeholder of the new accreditation period form (`/admin/accreditation/new`). The route, this export name and the
 * lazy chunk are final; the owning task replaces the body.
 */
export function PeriodCreateScreen() {
  return <KomunitasPlaceholder screen="period_create" />;
}
