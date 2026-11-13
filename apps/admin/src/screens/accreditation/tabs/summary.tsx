import type { JSX } from 'react';
import { KomunitasPlaceholder } from '@/components/komunitas/screen-placeholder';

/**
 * Placeholder of the workspace tab Ringkasan: the prerequisites, the estimated score or its range, the components
 * and the largest gaps. This export name and its props are final; the owning task replaces the body.
 */
export function SummaryTab(props: { periodId: string }): JSX.Element {
  return (
    <div data-period-id={props.periodId}>
      <KomunitasPlaceholder screen="tab_summary" level={2} />
    </div>
  );
}
