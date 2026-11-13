import type { JSX } from 'react';
import { KomunitasPlaceholder } from '@/components/komunitas/screen-placeholder';

/**
 * Placeholder of the workspace tab Indikator: every indicator with its suggestion, answer, notes and evidence
 * checklist. This export name and its props are final; the owning task replaces the body.
 */
export function IndicatorsTab(props: { periodId: string }): JSX.Element {
  return (
    <div data-period-id={props.periodId}>
      <KomunitasPlaceholder screen="tab_indicators" level={2} />
    </div>
  );
}
