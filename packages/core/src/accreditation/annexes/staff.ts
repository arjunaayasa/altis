import type { Locale } from '@altis/shared';
import { z } from 'zod';
import { PERIOD_PARAM, reportColumn, reportIdField, reportParam } from '../../reports/params.js';
import type { ReportColumn, ReportCtx, ReportRow, TableReport } from '../../reports/types.js';
import {
  activeStaff,
  annexPeriod,
  keyCursor,
  pageAfter,
  pageFixed,
  parseKeyCursor,
  periodDates,
  rowLabel,
  staffKey,
  staffRatios,
  vocabLabel,
  yesNo,
  type StaffRow,
} from '../providers/registers-metrics.js';
import { resolveWindow } from '../windows.js';

// The staff annex of an accreditation period, one section per export:
// - `staff`: the staff active at the period's end (the people the staff indicators count), by the day they started,
//   then id; the yes/no columns read "Ya"/"Tidak", the education adds "ilmu perpustakaan" when it is in library science;
// - `trainings`: the live trainings of those staff held in the period, or in the three periods (`window`), by date,
//   then id;
// - `ratio`: the staff ratios the indicators use (the trainings over the three periods, as the training indicator
//   counts them, whatever `window` says).
// Names and appointment references are personal data, so the annex is personal.

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

/** A staff member's education: the level, and library science when it is. */
function education(locale: Locale, s: StaffRow): string | null {
  const parts = [vocabLabel(locale, 'education_level', s.education_level), Number(s.education_library) === 1 ? rowLabel(locale, 'education_library') : null];
  const text = parts.filter((p): p is string => p !== null).join(', ');
  return text === '' ? null : text;
}

function staffRow(locale: Locale, s: StaffRow): ReportRow {
  return [
    s.name,
    s.position,
    vocabLabel(locale, 'staff_role', s.role),
    yesNo(locale, s.is_librarian),
    vocabLabel(locale, 'employment', s.employment),
    education(locale, s),
    yesNo(locale, s.library_training),
    yesNo(locale, s.competency_cert),
    yesNo(locale, s.association_member),
    s.appointment_ref,
    s.starts_on,
    s.ends_on,
  ];
}

async function staffAnnexRows(ctx: ReportCtx, cursor: string | null, limit: number): Promise<{ rows: ReportRow[]; nextCursor: string | null }> {
  const section = (ctx.params['section'] as (typeof STAFF_ANNEX_SECTIONS)[number] | undefined) ?? 'staff';
  const { period, D } = await annexPeriod(ctx);
  const staff = await activeStaff(ctx.db, period.ends_on);

  if (section === 'staff') {
    const { page, next } = pageAfter(staff, staffKey, parseKeyCursor(cursor), limit);
    return { rows: page.map((s) => staffRow(ctx.locale, s)), nextCursor: next };
  }

  if (section === 'ratio') {
    const q = await staffRatios(ctx.db, period, D, staff);
    const rows: ReportRow[] = [
      [rowLabel(ctx.locale, 'ratio.active_staff'), q.active],
      [rowLabel(ctx.locale, 'ratio.librarians'), q.librarians],
      [rowLabel(ctx.locale, 'ratio.population'), q.population],
      [rowLabel(ctx.locale, 'ratio.population_per_staff'), q.populationPerStaff],
      [rowLabel(ctx.locale, 'ratio.staff_pcs'), q.staffPcs],
      [rowLabel(ctx.locale, 'ratio.staff_pcs_pct'), q.staffPcsPct],
      [rowLabel(ctx.locale, 'ratio.trainings_3p'), q.trainings],
      [rowLabel(ctx.locale, 'ratio.training_avg_3p'), q.trainingAvg],
    ];
    const { page, next } = pageFixed(rows, cursor, limit);
    return { rows: page, nextCursor: next };
  }

  const after = parseKeyCursor(cursor);
  if (staff.length === 0) return { rows: [], nextCursor: null };
  const names = new Map(staff.map((s) => [s.id, s.name]));
  const w = resolveWindow(ctx.params['window'] === 'three_periods' ? 'three_periods' : 'period', periodDates(period), D);
  let q = ctx.db
    .selectFrom('staff_trainings')
    .select(['id', 'library_staff_id', 'title', 'organizer', 'held_on', 'hours'])
    .where('archived_at', 'is', null)
    .where('library_staff_id', 'in', [...names.keys()])
    .where('held_on', '>=', w.from)
    .where('held_on', '<=', w.to);
  if (after !== null) q = q.where((eb) => eb.or([eb('held_on', '>', after[0]), eb.and([eb('held_on', '=', after[0]), eb('id', '>', after[1])])]));
  const found = await q
    .orderBy('held_on')
    .orderBy('id')
    .limit(limit + 1)
    .execute();
  const page = found.slice(0, limit);
  const last = page[page.length - 1];
  return {
    rows: page.map((r) => [names.get(r.library_staff_id) ?? null, r.title, r.organizer, r.held_on, r.hours === null ? null : Number(r.hours)]),
    nextCursor: found.length > limit && last !== undefined ? keyCursor(last.held_on, last.id) : null,
  };
}

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
  rows: staffAnnexRows,
});
