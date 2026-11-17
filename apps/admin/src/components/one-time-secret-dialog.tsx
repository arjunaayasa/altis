import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useT } from '@/i18n';
import { useDirtyGuard } from '@/lib/dirty-forms';
import { cn } from '@/lib/utils';
import { useReturnFocus } from './return-focus';

/**
 * A secret shown once (spec §7.1; Tasks 29 and 30): the temporary password of a reset, a new cron token. Asking again
 * costs another reauth, and the value it replaced is already invalid, so it is never lost by accident:
 * - only "Selesai" closes the dialog: not Escape, not a click outside;
 * - while it shows it counts as a form being filled (lib/dirty-forms.ts): a newer release on the server shows the
 *   banner instead of reloading the page under it (the screen guards the request before it, see its callers);
 * - it opens once the confirmation before it has closed (ConfirmDialog `onClosed`), so "Selesai" returns the focus
 *   to where the action started (return-focus.ts).
 *
 * The value lives only in the state of the screen that opened the dialog, which sets it back to null on close: Radix
 * unmounts the content, so nothing of it stays in the page, and it never enters the query cache (the request is not
 * a query, and idempotency `none` keeps the server from storing the answer).
 */
export function OneTimeSecretDialog({
  value,
  title,
  description,
  valueClassName,
  onClose,
}: {
  value: string | null;
  title: string;
  description: string;
  /** The look of the value (a password in large type, a token in small). */
  valueClassName?: string;
  onClose(): void;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const focus = useReturnFocus();
  useDirtyGuard(value !== null);

  const close = (): void => {
    setCopied(false);
    onClose();
  };

  const copy = async (): Promise<void> => {
    if (value === null) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      // No clipboard (an insecure context, or permission refused): the value is on screen to be copied by hand.
    }
  };

  return (
    <Dialog open={value !== null} onOpenChange={(open) => (open ? undefined : close())}>
      <DialogContent
        showCloseButton={false}
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
        onOpenAutoFocus={focus.onOpenAutoFocus}
        onCloseAutoFocus={focus.onCloseAutoFocus}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {value !== null && (
          <div className="flex flex-wrap items-center gap-2 rounded-md border bg-layer px-3 py-2">
            <code translate="no" className={cn('flex-1 font-mono break-all select-all', valueClassName)}>
              {value}
            </code>
            <Button type="button" variant="outline" size="sm" onClick={() => void copy()}>
              {t(copied ? 'users.temp_password.copied' : 'users.temp_password.copy')}
            </Button>
          </div>
        )}
        <DialogFooter>
          <Button type="button" onClick={close}>
            {t('users.temp_password.done')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
