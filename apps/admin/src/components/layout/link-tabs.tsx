import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Tabs that are links to the pages of one part of the admin (the settings groups, the profile, jobs and schedules):
 * one line under the page head, wrapping on a narrow screen, named by `label`. The tab of the page shown (its address,
 * exactly) is underlined in the accent and marked as the current page. Views of one page or list are `Tabs` instead.
 * With `side`, on a wide screen they are a list down the left of the page's content (a thin rule on its left, the
 * current page marked on that rule): for a part with many pages, such as the settings groups.
 */
export function LinkTabs({ label, items, side = false }: { label: string; items: readonly { to: string; label: ReactNode }[]; side?: boolean }) {
  return (
    <nav aria-label={label}>
      <ul className={cn('flex flex-wrap gap-x-6 border-b', side && 'lg:flex-col lg:border-b-0 lg:border-l')}>
        {items.map((item) => (
          <li key={item.to}>
            <Link
              to={item.to}
              activeOptions={{ exact: true }}
              className={cn(
                '-mb-px block border-b-2 border-transparent py-2 font-medium text-muted-foreground hover:text-foreground data-[status=active]:border-primary data-[status=active]:font-semibold data-[status=active]:text-foreground',
                side && 'lg:mb-0 lg:-ml-px lg:border-b-0 lg:border-l-2 lg:px-3 lg:py-1.5 lg:data-[status=active]:text-accent-text',
              )}>
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
