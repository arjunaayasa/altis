import { ConfirmDialog } from '@/components/confirm-dialog';
import { useT } from '@/i18n';
import { dirtyForms } from '@/lib/dirty-forms';

/**
 * "Perubahan belum disimpan": asked in the accreditation workspace before something unmounts a form that holds unsaved
 * changes (lib/dirty-forms.ts): another tab or period, a link out of the workspace, or "Impor dari SLiMS" in place of
 * the usage grid. `onLeave` goes on without saving; `onStay` (Batal, Esc) keeps the page as it is.
 */
export function UnsavedChangesDialog({ open, onLeave, onStay }: { open: boolean; onLeave(): void; onStay(): void }) {
  const t = useT();
  return (
    <ConfirmDialog
      open={open}
      destructive
      title={t('accreditation.unsaved.title')}
      description={t('accreditation.unsaved.body')}
      confirmLabel={t('accreditation.unsaved.leave')}
      onConfirm={async () => onLeave()}
      onClose={onStay}
    />
  );
}

/** Whether a form of the page holds unsaved changes right now, so that a step that would drop them asks first. */
export const hasUnsavedChanges = (): boolean => dirtyForms.count() > 0;
