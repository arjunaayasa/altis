// Stub: replaced by a later change in this milestone.
// The metadata of `accreditation.annex.staff` is final; its rows are empty until its provider fills them.
import { z } from 'zod';
import { PERIOD_PARAM, reportColumn, reportIdField, reportParam } from '../../reports/params.js';
import type { ReportColumn, TableReport } from '../../reports/types.js';

/** The parts of the staff annex. */
export const STAFF_ANNEX_SECTIONS = Object.freeze(['staff', 'trainings', 'ratio'] as const);

/** The span the trainings cover. */
const STAFF_ANNEX_WINDOWS = Object.freeze(['period', 'three_periods'] as const);

const STAFF_NAME = { table: 'library_staff', column: 'name' } as const;

/** The columns of each section; a staff member's name and appointment reference are personal data. */
const SECTION_COLUMNS: Readonly<Record<(typeof STAFF_ANNEX_SECTIONS)[number], readonly ReportColumn[]>> = Object.freeze({
  staff: Object.freeze([
    reportColumn('name', 'text', { source: STAFF_NAME }),
    ...['position', 'role', 'is_librarian', 'employment', 'education', 'library_training', 'competency_cert', 'association_member'].map((key) =>
      reportColumn(key, 'text'),
    ),
    reportColumn('appointment_ref', 'text', { source: { table: 'library_staff', column: 'appointment_ref' } }),
    reportColumn('starts_on', 'date'),
    reportColumn('ends_on', 'date'),
  ]),
  trainings: Object.freeze([
    reportColumn('name', 'text', { source: STAFF_NAME }),
    reportColumn('training', 'text'),
    reportColumn('organizer', 'text'),
    reportColumn('held_on', 'date'),
    reportColumn('hours', 'int'),
  ]),
  ratio: Object.freeze([reportColumn('label', 'text'), reportColumn('value', 'int')]),
});

/** The library staff, their trainings, or the staff ratios (one section per export). */
export const annexStaffReport: TableReport = Object.freeze<TableReport>({
  id: 'accreditation.annex.staff',
  module: 'accreditation',
  kind: 'table',
  titleKey: 'report.accreditation.annex.staff.title',
  permission: 'accreditation.workspace.read',
  personal: true,
  formats: ['csv', 'xlsx', 'pdf'],
  orientation: 'landscape',
  params: [
    PERIOD_PARAM,
    reportParam('section', 'status', { options: STAFF_ANNEX_SECTIONS }),
    reportParam('window', 'status', { options: STAFF_ANNEX_WINDOWS }),
  ],
  paramsSchema: z.strictObject({
    periodId: reportIdField,
    section: z.enum(STAFF_ANNEX_SECTIONS).default('staff'),
    window: z.enum(STAFF_ANNEX_WINDOWS).default('period'),
  }),
  columns: (params: Record<string, unknown>) => SECTION_COLUMNS[(params['section'] as (typeof STAFF_ANNEX_SECTIONS)[number] | undefined) ?? 'staff'],
  rows: async () => ({ rows: [], nextCursor: null }),
});
