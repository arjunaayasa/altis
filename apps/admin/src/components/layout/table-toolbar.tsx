import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * The toolbar of a table inside its card: the search field and the filter buttons on the left, `actions` (export,
 * column choices) pushed to the right; it wraps on a narrow screen. A named group, so a screen reader says what the
 * controls belong to. Every control keeps an accessible name of its own (a visible label, or `aria-label` on a search
 * field whose placeholder is only an example).
 */
export function TableToolbar({ label, actions, className, children }: { label: string; actions?: ReactNode; className?: string; children?: ReactNode }) {
  return (
    <div data-slot="table-toolbar" role="group" aria-label={label} className={cn('flex flex-wrap items-center gap-2 px-4 py-3', className)}>
      {children}
      {actions !== undefined && <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
