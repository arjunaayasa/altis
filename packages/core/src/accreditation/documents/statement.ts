// Stub: replaced by a later change in this milestone.
// The metadata of `accreditation.statement_1000` is final; it renders nothing until the document writer fills it.
import { z } from 'zod';
import { PERIOD_PARAM, reportIdField } from '../../reports/params.js';
import type { DocumentReport } from '../../reports/types.js';

/** The statement that the collection holds at least 1 000 titles, with the list of titles. It names no one. */
export const statement1000Report: DocumentReport = Object.freeze<DocumentReport>({
  id: 'accreditation.statement_1000',
  module: 'accreditation',
  kind: 'document',
  titleKey: 'report.accreditation.statement_1000.title',
  permission: 'accreditation.workspace.read',
  personal: false,
  formats: ['pdf'],
  orientation: 'portrait',
  params: [PERIOD_PARAM],
  paramsSchema: z.strictObject({ periodId: reportIdField }),
  render: async () => ({ done: true, rowCount: 0, nonLatinRows: 0, warnings: [] }),
});
