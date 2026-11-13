// Stub: replaced by a later change in this milestone.
// The metadata of `accreditation.annex.additions` is final; its rows are empty until its provider fills them.
import { z } from 'zod';
import { PERIOD_PARAM, reportColumn, reportIdField } from '../../reports/params.js';
import type { TableReport } from '../../reports/types.js';

/** The starting collection, the titles added per year of the three-year window, and their share. */
export const annexAdditionsReport: TableReport = Object.freeze<TableReport>({
  id: 'accreditation.annex.additions',
  module: 'accreditation',
  kind: 'table',
  titleKey: 'report.accreditation.annex.additions.title',
  permission: 'accreditation.workspace.read',
  personal: false,
  formats: ['csv', 'xlsx', 'pdf'],
  orientation: 'portrait',
  params: [PERIOD_PARAM],
  paramsSchema: z.strictObject({ periodId: reportIdField }),
  columns: [
    reportColumn('label', 'text'),
    reportColumn('titles', 'int'),
    reportColumn('pct', 'percent'),
  ],
  scanBased: () => true,
  rows: async () => ({ rows: [], nextCursor: null }),
});
