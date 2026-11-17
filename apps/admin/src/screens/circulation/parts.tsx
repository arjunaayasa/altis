import { EllipsisIcon } from 'lucide-react';
import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, type ComponentProps, type FormEvent, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

/**
 * The layout pieces the desk and the member screens share. They hold no state of their own and use only the theme's
 * tokens, so they follow the light and dark themes:
 *
 * - **Status in words.** {@link StatusText} and {@link Callout} colour a status green, amber or red, and always say it
 *   in words too: a colour never stands alone.
 * - **Inline panels** ({@link InlinePanel}) take the place of a dialog for anything that does not destroy data
 *   (extend a membership, suspend, a member type's form, a bulk action): they open in the page, on the neutral layer,
 *   move the focus to their first field, and give it back to what opened them when they close with the focus inside.
 * - **Dense tables** ({@link DenseTable}, or the {@link TABLE} classes for a table drawn by hand): a header on the
 *   neutral layer, thin row lines, tabular digits, optional group head rows.
 * - {@link StatStrip} (counts side by side with thin dividers), {@link FactList} (label left, value right),
 *   {@link MemberPhoto} (a 3:4 photo or the initials), {@link Steps} (a numbered wizard) and {@link Kbd}.
 */

export type StatusTone = 'ok' | 'warn' | 'bad';

/** The text colour of a status. */
export const TONE_TEXT: Readonly<Record<StatusTone, string>> = {
  ok: 'text-ok',
  warn: 'text-warn',
  bad: 'text-bad',
};

/** The surface (background and border) of a status box. */
export const TONE_SURFACE: Readonly<Record<StatusTone, string>> = {
  ok: 'border-ok-line bg-ok-bg',
  warn: 'border-warn-line bg-warn-bg',
  bad: 'border-bad-line bg-bad-bg',
};

/** The neutral second layer (side panels, inline panels, table heads). */
export const LAYER = 'bg-layer';

/** A status word in its colour; the word carries the meaning. */
export function StatusText({ tone, className, ...props }: ComponentProps<'span'> & { tone: StatusTone }) {
  return <span className={cn('font-semibold', TONE_TEXT[tone], className)} {...props} />;
}

export type TagTone = StatusTone | 'neutral' | 'accent';

const TAG_TONE: Readonly<Record<TagTone, string>> = {
  ok: 'bg-ok-bg text-ok',
  warn: 'bg-warn-bg text-warn',
  bad: 'bg-bad-bg text-bad',
  neutral: 'bg-layer-2 text-muted-foreground',
  accent: 'bg-accent-soft text-accent-text',
};

/** A short labelled state (a member's status, "Batas penuh"): a tinted chip whose word says the state. */
export function Tag({ tone = 'neutral', className, ...props }: ComponentProps<'span'> & { tone?: TagTone }) {
  return <span className={cn('inline-flex h-5.5 w-fit items-center rounded px-1.75 text-xs font-semibold whitespace-nowrap', TAG_TONE[tone], className)} {...props} />;
}

/** A titled note on the page: neutral, or a status (the title says which). */
export function Callout({
  tone,
  title,
  children,
  action,
  role,
  className,
}: {
  tone?: StatusTone;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  role?: 'alert' | 'status';
  className?: string;
}) {
  return (
    <div role={role} className={cn('grid gap-1 rounded-md border px-3.5 py-3 text-sm', tone === undefined ? cn('border-border', LAYER) : TONE_SURFACE[tone], className)}>
      <p className={cn('font-bold', tone !== undefined && TONE_TEXT[tone])}>{title}</p>
      {children !== undefined && <div className="grid gap-1 text-foreground">{children}</div>}
      {action !== undefined && <div className="mt-1.5 flex flex-wrap items-center gap-2">{action}</div>}
    </div>
  );
}

/**
 * A panel opened in the page instead of a dialog: a heading, its fields and its buttons, on the neutral layer. As a
 * form (`onSubmit`) it is labelled by its heading. On opening, the focus moves to the first field (or the element marked
 * `data-autofocus`); Esc inside it calls `onCancel`. When it closes (cancelled, Esc, saved) with the focus inside, the
 * focus goes back to the element that had it when the panel opened, as a dialog gives it back to its trigger; to the
 * page's main region (`#main` of the shell) when that element is gone meanwhile.
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
      if (root === null || !root.contains(document.activeElement)) return;
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
    onKeyDown: (e: React.KeyboardEvent) => {
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

/**
 * A keyboard key as a small label. On a button whose name already says the action, pass `hidden`: the key is then only
 * seen (the button carries `aria-keyshortcuts`), so its accessible name stays the action.
 */
export function Kbd({ children, className, hidden = false }: { children: ReactNode; className?: string; hidden?: boolean }) {
  return (
    <kbd
      aria-hidden={hidden ? true : undefined}
      className={cn('rounded border border-current/30 px-1.5 font-sans text-[11px] leading-normal font-semibold whitespace-nowrap opacity-80', className)}>
      {children}
    </kbd>
  );
}

/** The classes of a dense table drawn by hand (the same look as {@link DenseTable}). */
export const TABLE = Object.freeze({
  // Positioned, so a screen-reader-only label in a column scrolled out of view stays inside (it would widen the page).
  wrap: 'relative overflow-x-auto rounded-lg border',
  table: 'w-full border-collapse text-sm tabular-nums',
  th: cn('border-b px-3 py-2 text-left text-xs font-semibold whitespace-nowrap text-muted-foreground', LAYER),
  td: 'border-b px-3 py-2.5 align-top [tr:last-child>&]:border-b-0',
  group: cn('border-b px-3 py-2 [tr:last-child>&]:border-b-0', LAYER),
  empty: 'px-3 py-7 text-muted-foreground',
  /** A row that can take the focus (keyboard row actions): the focused row takes the selection colour. */
  focusRow: 'outline-none focus:bg-accent-soft focus-visible:shadow-[inset_2px_0_0_var(--color-primary)]',
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

/** The first letters of the first two words of a name (`Siti Aminah` → `SA`). */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter((w) => w !== '');
  return words
    .slice(0, 2)
    .map((w) => Array.from(w)[0]!.toUpperCase())
    .join('');
}

/**
 * A member's photo at 3:4 (60 × 80, or 96 × 128 for `lg`), or the initials on the neutral layer when there is none.
 * The photo is decorative next to the name, so it has no text of its own unless `alt` is given.
 */
export function MemberPhoto({ name, fileId, size = 'sm', alt }: { name: string; fileId: string | null; size?: 'sm' | 'lg'; alt?: string }) {
  const box = size === 'lg' ? 'h-32 w-24 text-2xl' : 'h-20 w-15 text-base';
  if (fileId !== null) {
    return <img src={`/files/${encodeURIComponent(fileId)}`} alt={alt ?? ''} className={cn('shrink-0 rounded border object-cover', box)} />;
  }
  return (
    <span aria-hidden={alt === undefined ? true : undefined} role={alt === undefined ? undefined : 'img'} aria-label={alt} className={cn('grid shrink-0 place-items-center rounded border bg-layer-2 font-bold text-muted-foreground', box)}>
      {initials(name)}
    </span>
  );
}

/** A wizard's numbered steps; the current one is marked (`aria-current="step"`), the ones before it as done. */
export function Steps({ steps, current, label, doneLabel }: { steps: readonly string[]; current: number; label: string; doneLabel: string }) {
  return (
    <ol aria-label={label} className="flex flex-wrap gap-x-6 gap-y-1.5 text-sm">
      {steps.map((text, i) => {
        const state = i === current ? 'current' : i < current ? 'done' : 'next';
        return (
          <li key={text} aria-current={state === 'current' ? 'step' : undefined} className={cn('flex items-center gap-2', state === 'current' ? 'font-bold text-foreground' : state === 'done' ? 'text-muted-foreground' : 'text-muted-foreground/80')}>
            <span
              className={cn(
                'inline-grid size-5.5 place-items-center rounded-full border text-xs font-bold tabular-nums',
                state === 'current' && 'border-primary bg-primary text-primary-foreground',
                state === 'done' && 'border-ok-line text-ok',
              )}>
              {i + 1}
            </span>
            {text}
            {state === 'done' && <span className="sr-only"> ({doneLabel})</span>}
          </li>
        );
      })}
    </ol>
  );
}

/** The row of labelled filters above a list: one row on a wide screen (search wider), two columns on a narrow one. */
export const FILTER_ROW = 'grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(220px,2fr)_repeat(3,minmax(130px,1fr))]';

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

/** The action chosen in an open {@link MoreMenu}, run once the menu has closed and given the focus back. */
const MoreMenuChoice = createContext<{ current: (() => void) | null }>({ current: null });

/**
 * The ⋯ button of a row or a page head: the shared dropdown menu (arrow keys, Home/End, Esc, type-ahead; the focus
 * returns to the button when it closes), its list drawn over the page so a table's scroll box never clips it. The
 * chosen action runs once the focus is back on the button, so an inline panel or a dialog it opens gives the focus
 * back there when it closes.
 */
export function MoreMenu({ label, small = false, children }: { label: string; small?: boolean; children: ReactNode }) {
  const choice = useRef<(() => void) | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <MoreMenuChoice.Provider value={choice}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button ref={trigger} type="button" variant={small ? 'ghost' : 'outline'} size="icon" className={small ? 'size-8' : undefined} aria-label={label}>
            <EllipsisIcon aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="min-w-52"
          onCloseAutoFocus={(event) => {
            const run = choice.current;
            choice.current = null;
            if (run === null) return;
            event.preventDefault();
            trigger.current?.focus();
            run();
          }}>
          {children}
        </DropdownMenuContent>
      </DropdownMenu>
    </MoreMenuChoice.Provider>
  );
}

/** One action of a {@link MoreMenu} (Enter, Space or a click chooses it), red when it destroys data. */
export function MoreMenuItem({ danger = false, onSelect, children, ...props }: { danger?: boolean; onSelect(): void; children: ReactNode; 'aria-label'?: string }) {
  const choice = useContext(MoreMenuChoice);
  return (
    <DropdownMenuItem
      variant={danger ? 'destructive' : 'default'}
      className="h-8 px-2.5 whitespace-nowrap"
      onSelect={() => {
        choice.current = onSelect;
      }}
      {...props}>
      {children}
    </DropdownMenuItem>
  );
}

/** A thin rule between groups of a {@link MoreMenu}. */
export function MoreMenuRule() {
  return <DropdownMenuSeparator />;
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
                    <span className={cn('block h-3 animate-pulse rounded bg-layer-2 motion-reduce:animate-none', c === 0 ? 'w-4' : c === 1 ? 'w-40' : 'w-20')} />
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
