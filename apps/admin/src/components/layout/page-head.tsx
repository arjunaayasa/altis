import { Link } from '@tanstack/react-router';
import { ArrowLeftIcon } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { CARD, CARD_HEAD, CARD_TITLE, InCardScope, useInCard } from './card';

interface PageHeaderProps {
  title: ReactNode;
  /** One sentence under the title. */
  description?: ReactNode;
  /** The older name of `description`. */
  intro?: ReactNode;
  /** The page's buttons, on the right (under the title on a narrow screen). */
  actions?: ReactNode;
  titleId?: string;
  className?: string;
}

/**
 * A page header: the title (the page's `h1`, 21 px) and one sentence under it on the left, the actions on the right.
 * On a narrow screen the actions go under the text. Nothing sits above the title, and the title carries no icon.
 */
export function PageHeader({ title, description, intro, actions, titleId, className }: PageHeaderProps) {
  const sentence = description ?? intro;
  return (
    <div data-slot="page-header" className={cn('flex flex-col gap-3 lg:flex-row lg:items-start lg:gap-4', className)}>
      <div className="min-w-0">
        <h1 id={titleId} className="text-title font-bold">
          {title}
        </h1>
        {sentence !== undefined && <p className="mt-0.5 max-w-[76ch] text-muted-foreground">{sentence}</p>}
      </div>
      {actions !== undefined && <div className="flex shrink-0 flex-wrap items-center gap-2 lg:ml-auto">{actions}</div>}
    </div>
  );
}

/** The older name of {@link PageHeader}. */
export const PageHead = PageHeader;

/**
 * The way back to the list a detail page belongs to, above its {@link PageHeader}: a back arrow and the list's name.
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
 * The heading of a part of a page (`h2`, 15 px): the title left and, on the same line, something small about it on
 * the right (a period such as "30 hari terakhir", a legend, a link or a small button). Give `id` to label a region.
 */
export function SectionHead({ title, id, aside, className }: { title: ReactNode; id?: string; aside?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-wrap items-baseline justify-between gap-2', className)}>
      <h2 id={id} className="text-heading font-semibold">
        {title}
      </h2>
      {aside !== undefined && <div className="flex flex-wrap items-center gap-2 text-meta text-muted-foreground">{aside}</div>}
    </div>
  );
}

/** A part of a page: a region named by its {@link SectionHead}, its content 12 px below. */
export function Section({ title, aside, children, className }: { title: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  const id = useId();
  const inCard = useInCard();
  if (!inCard) {
    return (
      <section data-slot="card" data-section="" aria-labelledby={id} className={cn(CARD, 'grid content-start', className)}>
        <div data-slot="card-head" className={CARD_HEAD}>
          <h2 id={id} className={CARD_TITLE}>
            {title}
          </h2>
          {aside !== undefined && <div className="flex flex-wrap items-center gap-2 text-meta text-muted-foreground">{aside}</div>}
        </div>
        <InCardScope>{children}</InCardScope>
      </section>
    );
  }
  return (
    <section aria-labelledby={id} className={cn('grid min-w-0 content-start gap-3', className)}>
      <SectionHead id={id} title={title} aside={aside} />
      {children}
    </section>
  );
}
