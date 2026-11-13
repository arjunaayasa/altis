import type { JSX } from 'react';
import { KomunitasPlaceholder } from '@/components/komunitas/screen-placeholder';

/**
 * Placeholder of the workspace tab Register: activities, staff and trainings, partnerships, budgets and documents.
 * This export name and its props are final; the owning task replaces the body.
 */
export function RegistersTab(props: { periodId: string }): JSX.Element {
  return (
    <div data-period-id={props.periodId}>
      <KomunitasPlaceholder screen="tab_registers" level={2} />
    </div>
  );
}
