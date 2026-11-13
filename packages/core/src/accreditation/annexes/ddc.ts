// Stub: replaced by a later change in this milestone.
// The metadata of `accreditation.annex.ddc` is final; its rows are empty until its provider fills them.
import { z } from 'zod';
import { PERIOD_PARAM, reportColumn, reportIdField } from '../../reports/params.js';
import type { TableReport } from '../../reports/types.js';

/** Printed titles and copies per DDC class (with divisions), `2X` and the other classes, at the period's snapshot date. */
export const annexDdcReport: TableReport = Object.freeze<TableReport>({
  id: 'accreditation.annex.ddc',
  module: 'accreditation',
  kind: 'table',
  titleKey: 'report.accreditation.annex.ddc.title',
  permission: 'accreditation.workspace.read',
  personal: false,
  formats: ['csv', 'xlsx', 'pdf'],
  orientation: 'portrait',
  params: [PERIOD_PARAM],
  paramsSchema: z.strictObject({ periodId: reportIdField }),
  columns: [
    ...['class', 'label'].map((key) => reportColumn(key, 'text')),
    ...['titles', 'items'].map((key) => reportColumn(key, 'int')),
  ],
  scanBased: () => true,
  rows: async () => ({ rows: [], nextCursor: null }),
});
