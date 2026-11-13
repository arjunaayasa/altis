// Stub: replaced by a later change in this milestone.
// The metadata of `accreditation.annex.budgets` is final; its rows are empty until its provider fills them.
import { z } from 'zod';
import { PERIOD_PARAM, reportColumn, reportIdField } from '../../reports/params.js';
import type { TableReport } from '../../reports/types.js';

/** The library's and the parent institution's budgets of the budget years, and the library's share. */
export const annexBudgetsReport: TableReport = Object.freeze<TableReport>({
  id: 'accreditation.annex.budgets',
  module: 'accreditation',
  kind: 'table',
  titleKey: 'report.accreditation.annex.budgets.title',
  permission: 'accreditation.workspace.read',
  personal: false,
  formats: ['csv', 'xlsx', 'pdf'],
  orientation: 'landscape',
  params: [PERIOD_PARAM],
  paramsSchema: z.strictObject({ periodId: reportIdField }),
  columns: [
    reportColumn('year', 'text'),
    ...['library', 'parent', 'parent_nonpersonnel', 'collection', 'community'].map((key) => reportColumn(key, 'money')),
    reportColumn('pct', 'percent'),
  ],
  rows: async () => ({ rows: [], nextCursor: null }),
});
