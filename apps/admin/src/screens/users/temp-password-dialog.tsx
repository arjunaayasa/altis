import { OneTimeSecretDialog } from '@/components/one-time-secret-dialog';
import { useT } from '@/i18n';

/**
 * The temporary password of `POST users/:id/reset-password` (§7.1), shown once (components/one-time-secret-dialog.tsx:
 * only "Selesai" closes it, and while it shows a newer release does not reload the page). The value lives only in the
 * state of the screen that opened the dialog, which sets it back to null on close.
 */
export function TempPasswordDialog({ password, userName, onClose }: { password: string | null; userName: string; onClose(): void }) {
  const t = useT();
  return (
    <OneTimeSecretDialog
      value={password}
      title={t('users.temp_password.title')}
      description={t('users.temp_password.body', { name: userName })}
      valueClassName="text-lg tracking-wide"
      onClose={onClose}
    />
  );
}
