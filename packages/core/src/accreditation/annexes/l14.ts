// Stub: replaced by a later change in this milestone.
// The metadata of `accreditation.annex.l14` is final; its rows are empty until its provider fills them.
import { z } from 'zod';
import { PERIOD_PARAM, reportColumn, reportIdField } from '../../reports/params.js';
import type { TableReport } from '../../reports/types.js';

/** Per month: the school community's visits by group, the population, the share and the source of the figures. */
export const annexL14Report: TableReport = Object.freeze<TableReport>({
  id: 'accreditation.annex.l14',
  module: 'accreditation',
  kind: 'table',
  titleKey: 'report.accreditation.annex.l14.title',
  permission: 'accreditation.workspace.read',
  personal: false,
  formats: ['csv', 'xlsx', 'pdf'],
  orientation: 'landscape',
  params: [PERIOD_PARAM],
  paramsSchema: z.strictObject({ periodId: reportIdField }),
  columns: [
    reportColumn('month', 'text'),
    ...['student', 'teacher', 'edu_staff', 'school_visits', 'population'].map((key) => reportColumn(key, 'int')),
    reportColumn('pct', 'percent'),
    reportColumn('source', 'text'),
  ],
  rows: async () => ({ rows: [], nextCursor: null }),
});
