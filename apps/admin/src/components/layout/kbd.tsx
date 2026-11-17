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

/** A function key or Esc named in a sentence: F1 to F12, or Esc. */
const KEY_IN_TEXT = /\b(F(?:1[0-2]|[1-9])|Esc)\b/;

/**
 * A translated sentence with the keys it names (`Tekan F6 untuk …`) drawn as {@link Kbd}; the words stay one text for
 * the reader and for a screen reader.
 */
export function KeyText({ text }: { text: string }) {
  return <>{text.split(KEY_IN_TEXT).map((part, i) => (i % 2 === 1 ? <Kbd key={i}>{part}</Kbd> : part))}</>;
}
