import { Link } from '@tanstack/react-router';
import { ArrowLeftIcon } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** A page head: the title (and a sentence under it) left, the actions right. */
export function PageHead({ title, intro, actions, titleId }: { title: ReactNode; intro?: ReactNode; actions?: ReactNode; titleId?: string }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
      <div className="grid max-w-[75ch] min-w-0 gap-1">
        <h1 id={titleId} className="text-xl leading-tight font-bold">
          {title}
        </h1>
        {intro !== undefined && <p className="text-sm text-muted-foreground">{intro}</p>}
      </div>
      {actions !== undefined && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/**
 * The way back to the list a detail page belongs to, above its {@link PageHead}: a back arrow and the list's name.
 * `search` brings back the list's own view (its tab or kind, `?kind=news`).
 */
export function BackLink({ to, search, children }: { to: string; search?: object; children: ReactNode }) {
  return (
    <Link to={to} search={search} className="inline-flex w-fit items-center gap-1 text-meta font-semibold text-muted-foreground hover:text-foreground">
      <ArrowLeftIcon className="size-4" aria-hidden="true" />
      {children}
    </Link>
  );
}

/**
 * The heading of a part of a page (`h2`, 16 px): the title left and, on the same line, something small about it on
 * the right (a period such as "30 hari terakhir", a legend, a link or a small button). Give `id` to label a region.
 */
export function SectionHead({ title, id, aside, className }: { title: ReactNode; id?: string; aside?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-wrap items-baseline justify-between gap-2', className)}>
      <h2 id={id} className="text-base leading-snug font-bold">
        {title}
      </h2>
      {aside !== undefined && <div className="flex flex-wrap items-center gap-2 text-meta text-muted-foreground">{aside}</div>}
    </div>
  );
}

/** A part of a page: a region named by its {@link SectionHead}, its content 12 px below. */
export function Section({ title, aside, children, className }: { title: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={cn('grid min-w-0 content-start gap-3', className)}>
      <SectionHead id={id} title={title} aside={aside} />
      {children}
    </section>
  );
}
