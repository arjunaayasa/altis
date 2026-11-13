import type { JSX } from 'react';
import { KomunitasPlaceholder } from '@/components/komunitas/screen-placeholder';

/**
 * Placeholder of the workspace tab Populasi & Sarana: the school population and the facilities of the period. This
 * export name and its props are final; the owning task replaces the body.
 */
export function PopulationTab(props: { periodId: string }): JSX.Element {
  return (
    <div data-period-id={props.periodId}>
      <KomunitasPlaceholder screen="tab_population" level={2} />
    </div>
  );
}
