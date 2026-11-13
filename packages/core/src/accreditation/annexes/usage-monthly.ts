// Stub: replaced by a later change in this milestone.
// The metadata of `accreditation.annex.usage_monthly` is final; its rows are empty until its provider fills them.
import { z } from 'zod';
import { PERIOD_PARAM, reportColumn, reportIdField } from '../../reports/params.js';
import type { TableReport } from '../../reports/types.js';

/** Per month: visits by group, loans and in-library uses, with the source of the figures. */
export const annexUsageMonthlyReport: TableReport = Object.freeze<TableReport>({
  id: 'accreditation.annex.usage_monthly',
  module: 'accreditation',
  kind: 'table',
  titleKey: 'report.accreditation.annex.usage_monthly.title',
  permission: 'accreditation.workspace.read',
  personal: false,
  formats: ['csv', 'xlsx', 'pdf'],
  orientation: 'landscape',
  params: [PERIOD_PARAM],
  paramsSchema: z.strictObject({ periodId: reportIdField }),
  columns: [
    reportColumn('month', 'text'),
    ...['visits_student', 'visits_teacher', 'visits_edu_staff', 'visits_public', 'visits_other', 'visits_guest', 'loans', 'in_library_uses'].map((key) => reportColumn(key, 'int')),
    reportColumn('source', 'text'),
  ],
  rows: async () => ({ rows: [], nextCursor: null }),
});
