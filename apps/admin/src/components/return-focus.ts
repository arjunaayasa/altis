import { useRef } from 'react';

/**
 * Where the focus goes when a dialog closes (WCAG 2.4.3): back to the element that had it when the dialog opened, as
 * Radix does, but never to `<body>` when that element is gone meanwhile (the action re-rendered its row or hid its
 * button): then to the page's main region (`#main` of the shell). `onClosed` runs once the focus is back, so a dialog
 * that follows (a secret shown after its confirmation) opens from there and returns there too.
 *
 * Spread the handlers on the Radix dialog's Content (`onOpenAutoFocus` only records the element, so the dialog's own
 * initial focus still applies).
 */
export function useReturnFocus(onClosed?: () => void): { onOpenAutoFocus(): void; onCloseAutoFocus(event: Event): void } {
  const opener = useRef<HTMLElement | null>(null);
  return {
    onOpenAutoFocus: () => {
      const active = document.activeElement;
      opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
    },
    onCloseAutoFocus: (event) => {
      event.preventDefault();
      const target = opener.current;
      opener.current = null;
      if (target !== null && target.isConnected) target.focus();
      else document.getElementById('main')?.focus();
      onClosed?.();
    },
  };
}
