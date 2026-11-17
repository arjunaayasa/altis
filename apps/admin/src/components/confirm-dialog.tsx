import { AlertDialog } from 'radix-ui';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n';
import { problemText } from '@/lib/form-errors';
import { useReturnFocus } from './return-focus';

/**
 * "Are you sure?" before an action that cannot simply be taken back (disable a user, reset a password, archive a
 * branch, delete a role). An alert dialog (Radix): focus starts on Batal, a click outside does not close it, and on
 * close the focus goes back where it was (or to the main region when the action removed that element). While
 * `onConfirm` runs, the buttons wait; a failure stays in the dialog with its localized message, a success closes it.
 * When the server asks for the password first (AUTH_REAUTH_REQUIRED), the reauth dialog opens on top and the action
 * goes on afterwards (lib/api.ts). It is the one dialog a destructive action may ask in (the layout README): the title
 * names the action and its object, the description its consequence, the confirm button repeats the verb.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  destructive = false,
  onConfirm,
  onClose,
  onClosed,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  /** The action; its rejection is shown in the dialog. */
  onConfirm(): Promise<void>;
  onClose(): void;
  /** Once the dialog is gone and the focus is back where it was (return-focus.ts): what follows the action. */
  onClosed?(): void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const focus = useReturnFocus(onClosed);

  const close = (): void => {
    if (busy) return;
    setError(null);
    onClose();
  };

  const confirm = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      setBusy(false);
      onClose();
    } catch (e) {
      setBusy(false);
      setError(problemText(t, e));
    }
  };

  return (
    <AlertDialog.Root open={open} onOpenChange={(next) => (next ? undefined : close())}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-50 bg-(--scrim) data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <AlertDialog.Content
          onOpenAutoFocus={focus.onOpenAutoFocus}
          onCloseAutoFocus={focus.onCloseAutoFocus}
          className="fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-3.5 rounded-lg border bg-background p-5 text-foreground shadow-pop duration-200 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 sm:max-w-120">
          <div className="grid gap-1.5">
            <AlertDialog.Title className="text-base leading-snug font-bold">{title}</AlertDialog.Title>
            <AlertDialog.Description className="text-sm text-muted-foreground">{description}</AlertDialog.Description>
          </div>
          {error !== null && (
            <p role="alert" className="rounded-md border border-bad-line bg-bad-bg px-3.5 py-2.5 text-sm font-semibold text-bad">
              {error}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <Button variant="outline" disabled={busy}>
                {t('form.cancel')}
              </Button>
            </AlertDialog.Cancel>
            <Button variant={destructive ? 'destructive' : 'default'} disabled={busy} onClick={() => void confirm()}>
              {confirmLabel}
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
