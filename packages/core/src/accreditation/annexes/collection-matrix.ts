// Stub: replaced by a later change in this milestone.
// The metadata of `accreditation.annex.collection_matrix` is final; its rows are empty until its provider fills them.
import { z } from 'zod';
import { PERIOD_PARAM, reportColumn, reportIdField } from '../../reports/params.js';
import type { TableReport } from '../../reports/types.js';

/** Titles and copies by medium (print, electronic) and kind (fiction, non-fiction, reference). */
export const annexCollectionMatrixReport: TableReport = Object.freeze<TableReport>({
  id: 'accreditation.annex.collection_matrix',
  module: 'accreditation',
  kind: 'table',
  titleKey: 'report.accreditation.annex.collection_matrix.title',
  permission: 'accreditation.workspace.read',
  personal: false,
  formats: ['csv', 'xlsx', 'pdf'],
  orientation: 'portrait',
  params: [PERIOD_PARAM],
  paramsSchema: z.strictObject({ periodId: reportIdField }),
  columns: [
    ...['medium', 'kind'].map((key) => reportColumn(key, 'text')),
    ...['titles', 'items'].map((key) => reportColumn(key, 'int')),
  ],
  scanBased: () => true,
  rows: async () => ({ rows: [], nextCursor: null }),
});
