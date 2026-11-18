import { useRouter } from '@tanstack/react-router';
import type { MouseEvent, ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** One tab of {@link FilterTabs}. With `to` it is a link (the filter lives in the address), else a button. */
export interface FilterTab {
  id: string;
  label: ReactNode;
  /** How many rows the filter holds, after the name in a quieter colour. */
  count?: number;
  to?: string;
  search?: object;
}

const TAB =
  '-mb-px inline-flex items-center gap-1 border-b-2 border-transparent py-2 font-medium whitespace-nowrap text-muted-foreground transition-colors duration-150 ease-out hover:text-foreground focus-visible:-outline-offset-2';
const TAB_CURRENT = 'border-primary font-semibold text-foreground';

/**
 * A tab that is a link. It moves through the router (and its unsaved-changes guard) but is marked as the current page
 * only when its filter is the one in use: a router `<Link>` marks every link to the page's own path, whatever its
 * search. A click with a modifier key is left to the browser (a new tab).
 */
function TabLink({ item, current, children }: { item: FilterTab & { to: string }; current: boolean; children: ReactNode }) {
  const router = useRouter();
  const target = { to: item.to, search: item.search ?? {} };
  const onClick = (e: MouseEvent<HTMLAnchorElement>): void => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    void router.navigate(target);
  };
  return (
    <a href={router.buildLocation(target).href} aria-current={current ? 'page' : undefined} className={cn(TAB, current && TAB_CURRENT)} onClick={onClick}>
      {children}
    </a>
  );
}

/**
 * The saved filters of a list as underlined tabs above its card ("Semua 28", "Tanpa sampul 3"): one line that scrolls
 * sideways on a narrow screen, the filter in use underlined in the accent. A tab with `to` is a link and the one in
 * use is marked `aria-current="page"`; a tab without one is a button (`aria-pressed`) that calls `onChange`.
 */
export function FilterTabs({ label, items, value, onChange, className }: { label: string; items: readonly FilterTab[]; value: string; onChange?(id: string): void; className?: string }) {
  const content = (item: FilterTab): ReactNode => (
    <>
      {item.label}
      {item.count !== undefined && <span className="font-normal text-muted-foreground tabular-nums">{item.count}</span>}
    </>
  );
  return (
    <nav data-slot="filter-tabs" aria-label={label} className={className}>
      <ul className="flex gap-6 overflow-x-auto border-b">
        {items.map((item) => {
          const current = item.id === value;
          return (
            <li key={item.id} className="shrink-0">
              {item.to !== undefined ? (
                <TabLink item={{ ...item, to: item.to }} current={current}>
                  {content(item)}
                </TabLink>
              ) : (
                <button type="button" aria-pressed={current} className={cn(TAB, current && TAB_CURRENT)} onClick={() => onChange?.(item.id)}>
                  {content(item)}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
