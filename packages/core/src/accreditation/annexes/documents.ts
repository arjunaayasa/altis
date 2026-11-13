// Stub: replaced by a later change in this milestone.
// The metadata of `accreditation.annex.documents` is final; its rows are empty until its provider fills them.
import { DOCUMENT_KINDS } from '@altis/shared';
import { z } from 'zod';
import { PERIOD_PARAM, reportColumn, reportIdField, reportParam } from '../../reports/params.js';
import type { TableReport } from '../../reports/types.js';

/** The documents of the register current in the period, filtered by kind. */
export const annexDocumentsReport: TableReport = Object.freeze<TableReport>({
  id: 'accreditation.annex.documents',
  module: 'accreditation',
  kind: 'table',
  titleKey: 'report.accreditation.annex.documents.title',
  permission: 'accreditation.workspace.read',
  personal: false,
  formats: ['csv', 'xlsx', 'pdf'],
  orientation: 'landscape',
  params: [
    PERIOD_PARAM,
    reportParam('kinds', 'status', { multiple: true, options: DOCUMENT_KINDS, optionLabelPrefix: 'vocab.document_kind.' }),
  ],
  paramsSchema: z.strictObject({
    periodId: reportIdField,
    kinds: z.array(z.enum(DOCUMENT_KINDS)).min(1).max(DOCUMENT_KINDS.length).optional(),
  }),
  columns: [
    ...['kind', 'title', 'reference'].map((key) => reportColumn(key, 'text')),
    reportColumn('issued_on', 'date'),
    ...['issued_by', 'aspects'].map((key) => reportColumn(key, 'text')),
    reportColumn('valid_until', 'date'),
  ],
  rows: async () => ({ rows: [], nextCursor: null }),
});
