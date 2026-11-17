import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';

/**
 * Tabs that are links to the pages of one part of the admin (the settings groups, the profile, jobs and schedules):
 * one line under the page head, wrapping on a narrow screen, named by `label`. The tab of the page shown (its address,
 * exactly) is underlined in the accent and marked as the current page. Views of one page or list are `Tabs` instead.
 */
export function LinkTabs({ label, items }: { label: string; items: readonly { to: string; label: ReactNode }[] }) {
  return (
    <nav aria-label={label}>
      <ul className="flex flex-wrap gap-x-1 border-b">
        {items.map((item) => (
          <li key={item.to}>
            <Link
              to={item.to}
              activeOptions={{ exact: true }}
              className="-mb-px block border-b-2 border-transparent px-2.5 py-2 text-sm font-semibold text-muted-foreground hover:text-foreground data-[status=active]:border-primary data-[status=active]:text-foreground">
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
