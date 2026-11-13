import { KomunitasPlaceholder } from '@/components/komunitas/screen-placeholder';

/**
 * Placeholder of the accreditation workspace (`/admin/accreditation` and `/admin/accreditation/$periodId?tab=`): the
 * period, its status and the tabs. The route, this export name and the lazy chunk are final; the owning task
 * replaces the body.
 */
export function AccreditationScreen() {
  return <KomunitasPlaceholder screen="accreditation" />;
}
