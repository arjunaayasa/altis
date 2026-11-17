import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { TONE_TEXT, type StatusTone } from './status';

/** Figures side by side with thin dividers (two per row on a narrow screen). */
export function StatStrip({ items, label, className }: { items: readonly { key: string; label: ReactNode; value: ReactNode; tone?: StatusTone; note?: ReactNode }[]; label?: string; className?: string }) {
  return (
    <dl aria-label={label} className={cn('grid grid-cols-2 overflow-hidden rounded-lg border sm:flex sm:flex-wrap', className)}>
      {items.map((item, i) => (
        <div
          key={item.key}
          className={cn('min-w-0 border-border px-3.5 py-2.5 sm:flex-[1_1_140px] sm:border-r sm:last:border-r-0', i % 2 === 0 && i < items.length - 1 && 'border-r', i < items.length - (items.length % 2 === 0 ? 2 : 1) && 'border-b sm:border-b-0')}>
          <dt className="text-xs text-muted-foreground">{item.label}</dt>
          <dd className={cn('text-lg leading-snug font-bold tabular-nums', item.tone !== undefined && TONE_TEXT[item.tone])}>
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
