import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { CARD } from './card';
import { TONE_TEXT, type StatusTone } from './status';

/** One figure of a {@link StatRow}. */
export interface StatRowItem {
  key: string;
  label: ReactNode;
  /** The figure, already formatted. */
  value: ReactNode;
  /** A fact about the figure ("9 anggota", "dari buku tamu"), or a link to its list. Never a trend. */
  note?: ReactNode;
}

/**
 * The summary row of a page: one card of up to four cells with thin rules between them, each a label, a figure
 * (24 px, tabular digits) and a factual note. Two cells per row on a narrow screen. The figures are plain: no icon,
 * no colour, no trend arrow or chip.
 */
export function StatRow({ items, label, className }: { items: readonly StatRowItem[]; label?: string; className?: string }) {
  const cells = items.slice(0, 4);
  return (
    <dl data-slot="stat-row" aria-label={label} className={cn(CARD, 'grid grid-cols-2 overflow-hidden lg:auto-cols-fr lg:grid-flow-col lg:grid-cols-none', className)}>
      {cells.map((item, i) => (
        <div key={item.key} className={cn('min-w-0 px-4 py-3', i % 2 === 1 && 'border-l', i >= 2 && 'max-lg:border-t', i > 0 && 'lg:border-l')}>
          <dt className="text-meta text-muted-foreground">{item.label}</dt>
          <dd className="text-2xl leading-tight font-bold tabular-nums">{item.value}</dd>
          {item.note !== undefined && <dd className="text-meta text-muted-foreground">{item.note}</dd>}
        </div>
      ))}
    </dl>
  );
}

/** Figures side by side with thin dividers (two per row on a narrow screen); smaller than a {@link StatRow}. */
export function StatStrip({ items, label, className }: { items: readonly { key: string; label: ReactNode; value: ReactNode; tone?: StatusTone; note?: ReactNode }[]; label?: string; className?: string }) {
  return (
    <dl aria-label={label} className={cn(CARD, 'grid grid-cols-2 overflow-hidden sm:flex sm:flex-wrap', className)}>
      {items.map((item, i) => (
        <div
          key={item.key}
          className={cn('min-w-0 border-border px-4 py-2.5 sm:flex-[1_1_140px] sm:border-r sm:last:border-r-0', i % 2 === 0 && i < items.length - 1 && 'border-r', i < items.length - (items.length % 2 === 0 ? 2 : 1) && 'border-b sm:border-b-0')}>
          <dt className="text-meta text-muted-foreground">{item.label}</dt>
          <dd className={cn('text-xl leading-snug font-bold tabular-nums', item.tone !== undefined && TONE_TEXT[item.tone])}>
            {item.value}
            {item.note !== undefined && <span className="ml-1.5 text-xs font-semibold">{item.note}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Label-value lines with thin rules between them: the label left, the value right. */
export function FactList({ items, className }: { items: readonly { key: string; label: ReactNode; value: ReactNode; tone?: StatusTone }[]; className?: string }) {
  return (
    <dl className={cn('grid text-sm', className)}>
      {items.map((item) => (
        <div key={item.key} className="flex justify-between gap-3 border-t py-2">
          <dt className="text-muted-foreground">{item.label}</dt>
          <dd className={cn('text-right font-semibold tabular-nums', item.tone !== undefined && TONE_TEXT[item.tone])}>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
