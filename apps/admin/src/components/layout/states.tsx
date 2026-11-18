import { useId, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n';
import { cn } from '@/lib/utils';
import { PageError } from './callout';
import { SKELETON_BAR } from './table';

/**
 * The three states of a block whose data is read from the server, in the place the data would take: nothing there yet
 * ({@link EmptyState}), still loading ({@link LoadingState}, or `SkeletonTable` for a table) and failed
 * ({@link ErrorState}). A list whose filters match nothing keeps its table and says so in the table's empty row.
 */

/**
 * Nothing here yet: a heading that says so (15 px), a sentence on what to do, and the buttons that do it (the first
 * one the primary action). No picture, no icon. Inside a `Card` it takes the card's side padding.
 */
export function EmptyState({ title, children, actions, className }: { title: ReactNode; children?: ReactNode; actions?: ReactNode; className?: string }) {
  const id = useId();
  return (
    <section data-slot="empty-state" aria-labelledby={id} className={cn('grid gap-3 px-4 py-6 *:max-w-[62ch]', className)}>
      <h2 id={id} className="text-heading font-semibold">
        {title}
      </h2>
      {children !== undefined && <div className="grid gap-1 text-sm text-muted-foreground">{children}</div>}
      {actions !== undefined && <div className="flex flex-wrap gap-2">{actions}</div>}
    </section>
  );
}

const LINE_WIDTHS = ['w-1/2', 'w-3/4', 'w-2/3', 'w-5/6', 'w-1/3'] as const;

/**
 * Still loading (not a table: a form, a detail, a panel): grey lines in the place of the content, and the words
 * ("Memuat…") said once to screen readers.
 */
export function LoadingState({ label, lines = 4, className }: { label?: string; lines?: number; className?: string }) {
  const t = useT();
  return (
    <div aria-busy="true" className={cn('grid gap-3', className)}>
      <p role="status" className="sr-only">
        {label ?? t('shell.loading')}
      </p>
      <div aria-hidden="true" className="grid gap-3">
        {Array.from({ length: lines }, (_, i) => (
          <span key={i} className={cn(SKELETON_BAR, LINE_WIDTHS[i % LINE_WIDTHS.length])} />
        ))}
      </div>
    </div>
  );
}

/**
 * Loading failed: a red callout in the content's place with what failed ("Daftar gagal dimuat" by default), why, and
 * "Coba lagi". Data already on screen whose refresh failed is `RefetchProblem`'s case, not this one.
 */
export function ErrorState({ title, error, onRetry, retrying = false, className }: { title?: ReactNode; error: unknown; onRetry?(): void; retrying?: boolean; className?: string }) {
  const t = useT();
  return (
    <PageError
      title={title ?? t('table.load_failed')}
      error={error}
      className={className}
      action={
        onRetry === undefined ? undefined : (
          <Button type="button" variant="outline" size="sm" className="bg-background" disabled={retrying} onClick={onRetry}>
            {t('table.retry')}
          </Button>
        )
      }
    />
  );
}
