import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { LAYER } from './status';

/**
 * Dense tables: a header 34 px high on the neutral layer, rows 40 px high with thin lines between them, tabular
 * digits, optional group head rows. A table stands on its own (a bordered box) or directly inside a `Card`, under
 * the card's head or toolbar: there it drops its own border and runs edge to edge. The older
 * `DataTable` (components/data-table.tsx, for TanStack tables) draws with the same {@link TABLE} classes.
 */

/** The classes of a dense table drawn by hand (the same look as {@link DenseTable}). */
export const TABLE = Object.freeze({
  // Positioned, so a screen-reader-only label in a column scrolled out of view stays inside (it would widen the page).
  wrap: 'relative overflow-x-auto rounded-lg border bg-background [[data-slot=card]>&]:rounded-none [[data-slot=card]>&]:border-0 [[data-slot=card]>*+&]:border-t [[data-slot=card]>&:last-child]:rounded-b-lg',
  table: 'w-full border-collapse text-sm tabular-nums',
  th: 'h-8.5 border-b bg-layer-2 px-3 py-0 text-left text-fine font-semibold whitespace-nowrap text-muted-foreground first:pl-4 last:pr-4',
  td: 'h-10 border-b px-3 py-2.25 align-top first:pl-4 last:pr-4 [tr:last-child>&]:border-b-0',
  group: cn('border-b px-4 py-2 [tr:last-child>&]:border-b-0', LAYER),
  empty: 'px-4 py-7 text-muted-foreground',
  /** A row that can take the focus (keyboard row actions): the focused row takes the selection colour. */
  focusRow: 'outline-none focus:bg-primary-soft focus-visible:shadow-[inset_2px_0_0_var(--color-primary)]',
});

export interface DenseColumn<T> {
  id: string;
  header: ReactNode;
  cell(row: T): ReactNode;
  className?: string;
  /** The header's own classes (alignment). */
  headClassName?: string;
}

/**
 * A dense table: a screen-reader caption, a header on the neutral layer, one line per row and a row for "nothing
 * here". With `groupOf`, consecutive rows of the same group are preceded by a head row (`groupHead`) across all columns.
 */
export function DenseTable<T>({
  caption,
  columns,
  rows,
  rowKey,
  empty,
  rowClassName,
  groupOf,
  groupHead,
}: {
  caption: string;
  columns: readonly DenseColumn<T>[];
  rows: readonly T[];
  rowKey(row: T): string;
  empty: ReactNode;
  rowClassName?(row: T): string | undefined;
  groupOf?(row: T): string;
  groupHead?(row: T): ReactNode;
}) {
  let lastGroup: string | null = null;
  return (
    <div className={TABLE.wrap}>
      <table className={TABLE.table}>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.id} scope="col" className={cn(TABLE.th, c.headClassName)}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className={TABLE.empty}>
                {empty}
              </td>
            </tr>
          ) : (
            rows.flatMap((row) => {
              const out: ReactNode[] = [];
              if (groupOf !== undefined && groupHead !== undefined) {
                const group = groupOf(row);
                if (group !== lastGroup) {
                  lastGroup = group;
                  out.push(
                    <tr key={`group-${group}`}>
                      <th scope="colgroup" colSpan={columns.length} className={cn(TABLE.group, 'text-left font-normal')}>
                        {groupHead(row)}
                      </th>
                    </tr>,
                  );
                }
              }
              out.push(
                <tr key={rowKey(row)} className={rowClassName?.(row)}>
                  {columns.map((c) => (
                    <td key={c.id} className={cn(TABLE.td, c.className)}>
                      {c.cell(row)}
                    </td>
                  ))}
                </tr>,
              );
              return out;
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

/** The table's shape while the first page loads (said once to screen readers). */
export function SkeletonTable({ label, columns = 6, rows = 6 }: { label: string; columns?: number; rows?: number }) {
  return (
    <>
      <p role="status" className="sr-only">
        {label}
      </p>
      <div aria-hidden="true" className={TABLE.wrap}>
        <table className={TABLE.table}>
          <tbody>
            {Array.from({ length: rows }, (_, r) => (
              <tr key={r}>
                {Array.from({ length: columns }, (_, c) => (
                  <td key={c} className={TABLE.td}>
                    <span className={cn(SKELETON_BAR, c === 0 ? 'w-4' : c === 1 ? 'w-40' : 'w-20')} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** One grey bar of a loading shape (its width is the caller's). */
export const SKELETON_BAR = 'block h-3 animate-pulse rounded-sm bg-layer-2 motion-reduce:animate-none';
