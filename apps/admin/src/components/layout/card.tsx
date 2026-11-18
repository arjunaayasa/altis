import { createContext, useContext, useId, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** Whether what is drawn stands inside a card already: a part that would draw its own box then draws none. */
const InCard = createContext(false);

/** True inside a {@link Card} (or a part that is a card itself). */
export function useInCard(): boolean {
  return useContext(InCard);
}

/** Marks its children as standing inside a card. */
export function InCardScope({ children }: { children: ReactNode }) {
  return <InCard.Provider value={true}>{children}</InCard.Provider>;
}

/** The box of a card: the background of the page's content, a thin border, 6 px corners. No shadow. */
export const CARD = 'min-w-0 rounded-lg border bg-background';

/** A card with its own padding, for a small form or a note drawn by hand (16 px inside). */
export const PANEL = 'min-w-0 rounded-lg border bg-background p-4';

/** The classes of a card's head and of its title, for a card drawn by hand (a region with its own heading id). */
export const CARD_HEAD = 'flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b px-4 py-3';
export const CARD_TITLE = 'text-heading font-semibold';

/**
 * The head of a {@link Card}: its title (an `h2` of 15 px) with a short line under it, and something small on the
 * right (a legend, a link, a small button). A thin rule separates it from the card's content.
 */
export function CardHead({ title, description, aside, id, className }: { title: ReactNode; description?: ReactNode; aside?: ReactNode; id?: string; className?: string }) {
  return (
    <div data-slot="card-head" className={cn('flex items-center gap-3 border-b px-4 py-3', className)}>
      <div className="min-w-0">
        <h2 id={id} className="text-heading font-semibold">
          {title}
        </h2>
        {description !== undefined && <p className="text-meta text-muted-foreground">{description}</p>}
      </div>
      {aside !== undefined && <div className="ml-auto flex shrink-0 items-center gap-3 text-meta">{aside}</div>}
    </div>
  );
}

/** The padded content of a {@link Card} (16 px). Rows, a toolbar or a table go in the card directly instead. */
export function CardBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('p-4', className)}>{children}</div>;
}

/**
 * A card: a bordered box for one part of a page. With `title` it is a region named by its head ({@link CardHead});
 * without one, give `label` when the card should be a named region (a toolbar and its table). Its children sit edge
 * to edge, so a `TableToolbar`, a `BulkBar`, a table, `SettingRow`s or `FormSection`s line up with the card's border;
 * plain content goes in a {@link CardBody}. Cards are never nested.
 */
export function Card({
  title,
  description,
  aside,
  label,
  className,
  children,
}: {
  title?: ReactNode;
  description?: ReactNode;
  aside?: ReactNode;
  /** The region's name when the card has no title. */
  label?: string;
  className?: string;
  children?: ReactNode;
}) {
  const id = useId();
  const titled = title !== undefined;
  const named = titled || label !== undefined;
  const Box = named ? 'section' : 'div';
  return (
    <Box data-slot="card" aria-labelledby={titled ? id : undefined} aria-label={titled ? undefined : label} className={cn(CARD, className)}>
      {titled && <CardHead id={id} title={title} description={description} aside={aside} />}
      <InCardScope>{children}</InCardScope>
    </Box>
  );
}
