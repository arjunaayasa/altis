// Stub: replaced by a later change in this milestone.
// The metadata of `accreditation.self_assessment` is final; it renders nothing until the document writer fills it.
import { z } from 'zod';
import { PERIOD_PARAM, reportIdField } from '../../reports/params.js';
import type { DocumentReport } from '../../reports/types.js';

/** The internal simulation of the assessment, with the estimated score. Personal: it prints the names of the staff. */
export const selfAssessmentReport: DocumentReport = Object.freeze<DocumentReport>({
  id: 'accreditation.self_assessment',
  module: 'accreditation',
  kind: 'document',
  titleKey: 'report.accreditation.self_assessment.title',
  permission: 'accreditation.workspace.read',
  personal: true,
  formats: ['pdf'],
  orientation: 'portrait',
  params: [PERIOD_PARAM],
  paramsSchema: z.strictObject({ periodId: reportIdField }),
  render: async () => ({ done: true, rowCount: 0, nonLatinRows: 0, warnings: [] }),
});
