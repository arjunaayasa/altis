import type { JSX } from 'react';
import { KomunitasPlaceholder } from '@/components/komunitas/screen-placeholder';

/**
 * Placeholder of the workspace tab Penggunaan Bulanan: the monthly usage table and the SLiMS statistics import. This
 * export name and its props are final; the owning task replaces the body.
 */
export function UsageTab(props: { periodId: string }): JSX.Element {
  return (
    <div data-period-id={props.periodId}>
      <KomunitasPlaceholder screen="tab_usage" level={2} />
    </div>
  );
}
