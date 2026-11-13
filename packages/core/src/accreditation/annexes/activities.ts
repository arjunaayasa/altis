// Stub: replaced by a later change in this milestone.
// The metadata of `accreditation.annex.activities` is final; its rows are empty until its provider fills them.
import { ACTIVITY_KINDS } from '@altis/shared';
import { z } from 'zod';
import { PERIOD_PARAM, reportColumn, reportIdField, reportParam } from '../../reports/params.js';
import type { TableReport } from '../../reports/types.js';

/** The span an activity list covers: the period, or the three periods ending with it. */
export const ANNEX_WINDOWS = Object.freeze(['period', 'three_periods'] as const);

/** The activities of the period (or the three periods), filtered by kind. */
export const annexActivitiesReport: TableReport = Object.freeze<TableReport>({
  id: 'accreditation.annex.activities',
  module: 'accreditation',
  kind: 'table',
  titleKey: 'report.accreditation.annex.activities.title',
  permission: 'accreditation.workspace.read',
  personal: false,
  formats: ['csv', 'xlsx', 'pdf'],
  orientation: 'portrait',
  params: [
    PERIOD_PARAM,
    reportParam('kinds', 'status', { multiple: true, options: ACTIVITY_KINDS, optionLabelPrefix: 'vocab.activity_kind.' }),
    reportParam('window', 'status', { options: ANNEX_WINDOWS }),
    reportParam('learning', 'bool'),
    reportParam('externalLiteracy', 'bool'),
  ],
  paramsSchema: z.strictObject({
    periodId: reportIdField,
    kinds: z.array(z.enum(ACTIVITY_KINDS)).min(1).max(ACTIVITY_KINDS.length).optional(),
    window: z.enum(ANNEX_WINDOWS).default('period'),
    learning: z.boolean().optional(),
    externalLiteracy: z.boolean().optional(),
  }),
  columns: [
    ...['kind', 'title'].map((key) => reportColumn(key, 'text')),
    reportColumn('held_on', 'date'),
    reportColumn('participants', 'int'),
    reportColumn('partner', 'text'),
  ],
  rows: async () => ({ rows: [], nextCursor: null }),
});
