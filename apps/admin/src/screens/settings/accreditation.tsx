import { KomunitasPlaceholder } from '@/components/komunitas/screen-placeholder';

/**
 * Placeholder of Pengaturan Akreditasi (`/admin/settings/accreditation`), the settings of group `accreditation`. The
 * route, this export name and the lazy chunk are final; the owning task replaces the body.
 */
export function AccreditationSettingsScreen() {
  return <KomunitasPlaceholder screen="accreditation_settings" />;
}
