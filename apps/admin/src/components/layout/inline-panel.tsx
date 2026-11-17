import { useEffect, useId, useLayoutEffect, useRef, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { LAYER } from './status';

/**
 * A panel opened in the page instead of a dialog: a heading, its fields and its buttons, on the neutral layer. As a
 * form (`onSubmit`) it is labelled by its heading. On opening, the focus moves to the first field (or the element marked
 * `data-autofocus`); Esc inside it calls `onCancel`. When it closes (cancelled, Esc, saved) with the focus inside, or
 * with the focus on nothing (a browser drops it from a button disabled while saving), the focus goes back to the element
 * that had it when the panel opened, as a dialog gives it back to its trigger; to the page's main region (`#main` of
 * the shell) when that element is gone meanwhile.
 */
export function InlinePanel({
  title,
  children,
  onSubmit,
  onCancel,
  className,
  focusOnOpen = true,
}: {
  title: ReactNode;
  children: ReactNode;
  onSubmit?(event: FormEvent<HTMLFormElement>): void;
  onCancel?(): void;
  className?: string;
  focusOnOpen?: boolean;
}) {
  const headingId = useId();
  const box = useRef<HTMLElement | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  // Before the first field takes the focus: who had it. Its cleanup runs while the panel is still in the page.
  useLayoutEffect(() => {
    const root = box.current;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body && root?.contains(active) !== true) opener.current = active;
    return () => {
      const now = document.activeElement;
      if (root === null || (now !== null && now !== document.body && !root.contains(now))) return;
      const target = opener.current;
      if (target !== null && target.isConnected && !root.contains(target)) target.focus();
      else document.getElementById('main')?.focus();
    };
  }, []);
  useEffect(() => {
    if (!focusOnOpen) return;
    const root = box.current;
    if (root === null) return;
    const first = root.querySelector<HTMLElement>('[data-autofocus]') ?? root.querySelector<HTMLElement>('input:not([type=hidden]):not([disabled]),select:not([disabled]),textarea:not([disabled]),button:not([disabled])');
    first?.focus();
    // Only when it opens: a re-render must not pull the focus back.
  }, [focusOnOpen]);
  const props = {
    'aria-labelledby': headingId,
    className: cn('grid gap-3.5 rounded-lg border p-4', LAYER, className),
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === 'Escape' && onCancel !== undefined) {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      }
    },
  };
  const heading = (
    <h2 id={headingId} className="text-sm font-bold">
      {title}
    </h2>
  );
  if (onSubmit !== undefined) {
    return (
      <form
        noValidate
        ref={(el) => {
          box.current = el;
        }}
        onSubmit={onSubmit}
        {...props}>
        {heading}
        {children}
      </form>
    );
  }
  return (
    <section
      ref={(el) => {
        box.current = el;
      }}
      {...props}>
      {heading}
      {children}
    </section>
  );
}
