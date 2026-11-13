// Stub: replaced by a later change in this milestone.
// The metadata of `accreditation.dossier` is final; it renders nothing until the document writer fills it.
import { z } from 'zod';
import { PERIOD_PARAM, reportIdField, reportParam } from '../../reports/params.js';
import type { DocumentReport } from '../../reports/types.js';

/** The parts of the dossier a run makes: all of it, or the request letter alone. */
export const DOSSIER_PARTS = Object.freeze(['all', 'request_letter'] as const);

/** How the evidence ZIP is cut: one ZIP, or one ZIP per component inside one ZIP. */
export const DOSSIER_ZIP_MODES = Object.freeze(['combined', 'components'] as const);

/**
 * The evidence file without scores (a PDF, or a ZIP of it with the evidence files). Personal: it prints the names of
 * the staff, so its runs need a fresh re-authentication.
 */
export const dossierReport: DocumentReport = Object.freeze<DocumentReport>({
  id: 'accreditation.dossier',
  module: 'accreditation',
  kind: 'document',
  titleKey: 'report.accreditation.dossier.title',
  permission: 'accreditation.workspace.read',
  personal: true,
  formats: ['pdf', 'zip'],
  orientation: 'portrait',
  params: [PERIOD_PARAM, reportParam('part', 'status', { options: DOSSIER_PARTS }), reportParam('zipMode', 'status', { options: DOSSIER_ZIP_MODES })],
  paramsSchema: z.strictObject({
    periodId: reportIdField,
    part: z.enum(DOSSIER_PARTS).default('all'),
    zipMode: z.enum(DOSSIER_ZIP_MODES).default('combined'),
  }),
  render: async () => ({ done: true, rowCount: 0, nonLatinRows: 0, warnings: [] }),
});
