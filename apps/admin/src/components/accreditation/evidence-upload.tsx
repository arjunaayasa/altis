import type { EvidenceEntity } from '@altis/shared';
import type { JSX } from 'react';
import { Button } from '@/components/ui/button';

/** Where an uploaded evidence file belongs: a period's indicator and evidence item, or a register row. */
export interface EvidenceUploadProps {
  periodId?: string;
  indicatorCode?: string;
  evidenceCode?: string;
  /** The register table of `entityId` (training certificates, partnership and document files). */
  entity?: EvidenceEntity;
  entityId?: string;
  label: string;
  /** Called once the evidence is stored. */
  onDone(): void;
}

/**
 * Uploads one evidence file (PDF, or an image converted to JPEG in the browser) in context `accreditation.evidence` and
 * records it. Until its task fills it, a disabled button with its label: the props and the export name are final, so
 * the workspace tabs that use it need no change.
 */
export function EvidenceUpload(props: EvidenceUploadProps): JSX.Element {
  return (
    <Button type="button" variant="outline" disabled>
      {props.label}
    </Button>
  );
}
