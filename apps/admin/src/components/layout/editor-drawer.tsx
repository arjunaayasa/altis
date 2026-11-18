import { XIcon } from 'lucide-react';
import { Dialog } from 'radix-ui';
import type { FormEvent, ReactNode } from 'react';
import { useReturnFocus } from '@/components/return-focus';
import { Button } from '@/components/ui/button';

/**
 * The drawer in which one item of a list is edited (a slide of the home page's hero): a panel on the right of the
 * window, over a scrim, with the item's name as its heading, its fields in the middle (they scroll) and its buttons
 * at the foot. It is a modal dialog: the focus stays inside, Esc and the close button close it without keeping the
 * changes (`onClose`), a click on the scrim does not (the fields may hold a lot of typing), and on close the focus
 * goes back to the button that opened it. Its fields are a form of their own: Enter in a field and the submit button
 * in `footer` call `onSubmit`, and the page's form behind it is not submitted. Nothing in it is saved by itself: the
 * page's own Save does that.
 */
export function EditorDrawer({
  open,
  title,
  description,
  closeLabel,
  footer,
  children,
  onSubmit,
  onClose,
}: {
  open: boolean;
  title: string;
  description: string;
  /** The name of the close button. */
  closeLabel: string;
  /** The buttons at the foot: what else the item has on the left (a switch), Batal and the submit on the right. */
  footer: ReactNode;
  children: ReactNode;
  onSubmit(): void;
  onClose(): void;
}) {
  const focus = useReturnFocus();
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    // The drawer is drawn outside the page's form, but its events still pass through it.
    event.stopPropagation();
    onSubmit();
  };
  return (
    <Dialog.Root open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-(--scrim) data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          data-slot="editor-drawer"
          aria-modal="true"
          onOpenAutoFocus={focus.onOpenAutoFocus}
          onCloseAutoFocus={focus.onCloseAutoFocus}
          onInteractOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => {
            // A panel inside the drawer that closes on Esc itself (the photo crop) takes the key.
            if (event.target instanceof Element && event.target.closest('[data-own-escape]') !== null) event.preventDefault();
          }}
          className="fixed inset-y-0 right-0 z-50 flex w-[min(880px,100vw)] flex-col border-l bg-background text-foreground shadow-pop">
          <form noValidate className="flex min-h-0 flex-1 flex-col" onSubmit={submit}>
            <div className="flex items-center gap-3 border-b px-5 py-3">
              <div className="min-w-0">
                <Dialog.Title className="text-[17px] leading-snug font-bold">{title}</Dialog.Title>
                <Dialog.Description className="text-meta text-muted-foreground">{description}</Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <Button type="button" variant="ghost" size="icon" className="ml-auto shrink-0" aria-label={closeLabel}>
                  <XIcon aria-hidden="true" />
                </Button>
              </Dialog.Close>
            </div>
            <div className="grid min-h-0 flex-1 content-start gap-6 overflow-auto p-5 lg:grid-cols-2">{children}</div>
            <div className="flex flex-wrap items-center gap-2 border-t px-5 py-2.5">{footer}</div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
