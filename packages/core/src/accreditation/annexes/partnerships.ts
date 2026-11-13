// Stub: replaced by a later change in this milestone.
// The metadata of `accreditation.annex.partnerships` is final; its rows are empty until its provider fills them.
import { z } from 'zod';
import { PERIOD_PARAM, reportColumn, reportIdField } from '../../reports/params.js';
import type { TableReport } from '../../reports/types.js';

/** The written partnerships valid in the period. */
export const annexPartnershipsReport: TableReport = Object.freeze<TableReport>({
  id: 'accreditation.annex.partnerships',
  module: 'accreditation',
  kind: 'table',
  titleKey: 'report.accreditation.annex.partnerships.title',
  permission: 'accreditation.workspace.read',
  personal: false,
  formats: ['csv', 'xlsx', 'pdf'],
  orientation: 'portrait',
  params: [PERIOD_PARAM],
  paramsSchema: z.strictObject({ periodId: reportIdField }),
  columns: [
    ...['partner', 'kind'].map((key) => reportColumn(key, 'text')),
    ...['starts_on', 'ends_on'].map((key) => reportColumn(key, 'date')),
    reportColumn('scope', 'text'),
  ],
  rows: async () => ({ rows: [], nextCursor: null }),
});
