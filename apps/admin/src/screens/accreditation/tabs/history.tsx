import type { JSX } from 'react';
import { KomunitasPlaceholder } from '@/components/komunitas/screen-placeholder';

/**
 * Placeholder of the workspace tab Riwayat: the frozen snapshots of the period. This export name and its props are
 * final; the owning task replaces the body.
 */
export function HistoryTab(props: { periodId: string }): JSX.Element {
  return (
    <div data-period-id={props.periodId}>
      <KomunitasPlaceholder screen="tab_history" level={2} />
    </div>
  );
}
