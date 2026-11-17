import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * A keyboard key as a small label. On a button whose name already says the action, pass `hidden`: the key is then only
 * seen (the button carries `aria-keyshortcuts`), so its accessible name stays the action.
 */
export function Kbd({ children, className, hidden = false }: { children: ReactNode; className?: string; hidden?: boolean }) {
  return (
    <kbd
      aria-hidden={hidden ? true : undefined}
      className={cn('rounded border border-current/30 px-1.5 font-sans text-[11px] leading-normal font-semibold whitespace-nowrap opacity-80', className)}>
      {children}
    </kbd>
  );
}
