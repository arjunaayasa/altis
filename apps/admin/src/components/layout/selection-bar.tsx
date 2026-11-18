import { useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n';

/** A bulk action of a {@link BulkBar}: its button in the bar opens its inline panel under the bar. */
export interface SelectionAction {
  id: string;
  label: string;
}

interface SelectionBarProps {
  /** How many rows are selected; the bar shows only while there is one. */
  count: number;
  /** The bar's text and its region's name ("3 anggota dipilih"); "3 dipilih" by default. */
  label?: string;
  /** The bulk actions with a panel, in their order. */
  actions?: readonly SelectionAction[];
  /** The action whose panel is open, or null. */
  open?: string | null;
  /** An action's button was pressed: its id to open its panel, null to close the open one (pressed again). */
  onOpenChange?(id: string | null): void;
  /** More buttons of the bar, for actions that need no panel ("Tambah ke antrean kartu"). */
  extra?: ReactNode;
  /** "Batal pilih": the screen empties its selection (and closes its panel). */
  onClear(): void;
  clearLabel?: string;
  /**
   * Where the focus goes when the bar goes away with the focus inside it (the selection was cleared, or the last
   * selected rows went away): the list's "select all" box, say. The page's main region (`#main`) otherwise.
   */
  focusAfter?: RefObject<HTMLElement | null>;
  /** The open action's `InlinePanel` (and a notice about the last bulk action), drawn under the bar. */
  children?: ReactNode;
}

/**
 * The bar over a list while rows are selected: a tinted region named by the selection count, one button per bulk
 * action, and "Batal pilih" at the end. Inside a `Card` (between the toolbar and the table) it runs edge to edge
 * with a rule above and below; on its own it is a bordered box. A bulk action never opens a dialog: its button (`aria-pressed`) opens the
 * action's inline panel under the bar, which takes the focus and gives it back to that button when it closes (Esc,
 * Batal, or once applied). Only an action that destroys data asks its question, in words, in its panel.
 */
export function BulkBar(props: SelectionBarProps) {
  if (props.count <= 0) return null;
  return <Bar {...props} />;
}

/** The older name of {@link BulkBar}. */
export const SelectionBar = BulkBar;

function Bar({ count, label, actions = [], open = null, onOpenChange, extra, onClear, clearLabel, focusAfter, children }: SelectionBarProps) {
  const t = useT();
  const root = useRef<HTMLDivElement>(null);
  const after = useRef(focusAfter);
  useLayoutEffect(() => {
    after.current = focusAfter;
  });
  // Its cleanup runs while the bar is still in the page: it sees whether the focus is inside.
  useLayoutEffect(() => {
    const box = root.current;
    return () => {
      const now = document.activeElement;
      if (box === null || (now !== null && now !== document.body && !box.contains(now))) return;
      const target = after.current?.current;
      if (target !== null && target !== undefined && target.isConnected && !box.contains(target)) target.focus();
      else document.getElementById('main')?.focus();
    };
  }, []);
  const text = label ?? t('table.selected', { count });
  return (
    <div ref={root} data-slot="bulk-bar" className="grid gap-3 [[data-slot=card]>&]:gap-0">
      <section
        aria-label={text}
        className="flex flex-wrap items-center gap-2 rounded-md border bg-primary-soft px-4 py-2 [[data-slot=card]>[data-slot=bulk-bar]>&]:rounded-none [[data-slot=card]>[data-slot=bulk-bar]>&]:border-x-0">
        <p role="status" className="mr-1 font-semibold">
          {text}
        </p>
        {actions.map((action) => (
          <Button
            key={action.id}
            type="button"
            size="sm"
            variant="outline"
            aria-pressed={open === action.id}
            className="aria-pressed:border-primary aria-pressed:text-accent-text"
            onClick={() => onOpenChange?.(open === action.id ? null : action.id)}>
            {action.label}
          </Button>
        ))}
        {extra}
        <span className="flex-1" />
        <Button type="button" size="sm" variant="ghost" className="text-foreground" onClick={onClear}>
          {clearLabel ?? t('table.clear_selection')}
        </Button>
      </section>
      {children}
    </div>
  );
}
