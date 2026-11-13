import type { JSX } from 'react';
import { KomunitasPlaceholder } from '@/components/komunitas/screen-placeholder';

/**
 * Placeholder of the workspace tab Kepatuhan SNP: the checks of the school library standard. This export name and
 * its props are final; the owning task replaces the body.
 */
export function SnpTab(props: { periodId: string }): JSX.Element {
  return (
    <div data-period-id={props.periodId}>
      <KomunitasPlaceholder screen="tab_snp" level={2} />
    </div>
  );
}
