import type { PdfLayout } from '../../print/layout.js';
import type { ReportRow } from '../../reports/types.js';
import { columnsOf, msg, printReportTable, tableReport, type DocPeriod } from './data.js';
import { ANNEX, HEADINGS, ROLES, WORDS } from './texts.js';

// The statistical annex of the evidence file (spec §10.9 item 7) and, in the statistics mode, its register lists
// (spec §10.2): each part is the rows of one annex report of the period, printed as that report's table. The annexes
// are gathered first (across slices when a report reads the whole stock), then printed with the rest of the document.
//
// A school instrument prints: printed books by DDC class, the collection by medium and kind, the additions of three
// years with a block approved by the head of library, the monthly use by the school community, the monthly usage, the
// staff and its ratios, the budgets of three years and the activities of the period by kind. The statistics mode
// prints its register lists (activities by kind, staff and trainings, partnerships, budgets, documents), then the DDC
// classes, the collection matrix, the additions and the monthly usage, and the monthly use by the school community
// only for a school whose population is filled.

/** One part of the annex: an annex report with its parameters. */
export interface AnnexSpec {
  reportId: string;
  params: Record<string, unknown>;
  /** The heading printed above the table (default: the report's title). */
  heading?: string;
  /** Printed under the register lists (statistics mode) rather than the statistical annex. */
  register?: true;
  /** The rows are activities: printed one table per kind (their first cell). */
  byKind?: true;
  /** The additions table: followed by the head of library's approval. */
  approval?: true;
}

const DDC = 'accreditation.annex.ddc';
/** The collection matrix annex: the profile form prints it too. */
export const MATRIX_ANNEX = 'accreditation.annex.collection_matrix';
const ADDITIONS = 'accreditation.annex.additions';
const L14 = 'accreditation.annex.l14';
const USAGE = 'accreditation.annex.usage_monthly';
const STAFF = 'accreditation.annex.staff';
const BUDGETS = 'accreditation.annex.budgets';
const ACTIVITIES = 'accreditation.annex.activities';
const PARTNERSHIPS = 'accreditation.annex.partnerships';
const DOCUMENTS = 'accreditation.annex.documents';

/** The school population of the period is filled (every part of it). */
function populationFilled(p: DocPeriod): boolean {
  return p.row.students !== null && p.row.teachers !== null && p.row.edu_staff !== null;
}

/** The annex parts of period `p`, in their printed order. */
export function annexPlan(p: DocPeriod): AnnexSpec[] {
  const periodId = p.id;
  const of = (reportId: string, params: Record<string, unknown> = {}, more: Omit<AnnexSpec, 'reportId' | 'params'> = {}): AnnexSpec => ({
    reportId,
    params: { periodId, ...params },
    ...more,
  });
  if (p.school) {
    return [
      of(DDC),
      of(MATRIX_ANNEX),
      of(ADDITIONS, {}, { approval: true }),
      of(L14),
      of(USAGE),
      of(STAFF, { section: 'staff' }, { heading: ANNEX.staffList }),
      of(STAFF, { section: 'ratio' }, { heading: ANNEX.ratios }),
      of(BUDGETS),
      of(ACTIVITIES, { window: 'period' }, { byKind: true }),
    ];
  }
  const plan: AnnexSpec[] = [
    of(ACTIVITIES, { window: 'period' }, { byKind: true, register: true }),
    of(STAFF, { section: 'staff' }, { heading: ANNEX.staffList, register: true }),
    of(STAFF, { section: 'trainings', window: 'period' }, { heading: ANNEX.trainings, register: true }),
    of(PARTNERSHIPS, {}, { register: true }),
    of(BUDGETS, {}, { register: true }),
    of(DOCUMENTS, {}, { register: true }),
    of(DDC),
    of(MATRIX_ANNEX),
    of(ADDITIONS, {}, { approval: true }),
    of(USAGE),
  ];
  if (p.schoolLibrary && populationFilled(p)) plan.push(of(L14));
  return plan;
}

/** The heading of a part. */
export function annexHeading(spec: AnnexSpec): string {
  return spec.heading ?? msg(tableReport(spec.reportId).titleKey);
}

/** Prints one part of the annex from its gathered rows. */
function writePart(layout: PdfLayout, spec: AnnexSpec, rows: readonly ReportRow[]): void {
  const def = tableReport(spec.reportId);
  const columns = columnsOf(def, { ...spec.params });
  layout.heading(annexHeading(spec), 2);
  if (spec.byKind === true) {
    if (rows.length === 0) layout.paragraph(WORDS.emptyTable, { size: 9 });
    const kinds = new Map<string, ReportRow[]>();
    for (const r of rows) {
      const kind = String(r[0] ?? WORDS.none);
      const list = kinds.get(kind) ?? [];
      list.push(r);
      kinds.set(kind, list);
    }
    for (const [kind, list] of kinds) {
      layout.heading(ANNEX.activitiesOf(kind), 3);
      printReportTable(layout, columns, list, { skip: 1 });
    }
    return;
  }
  printReportTable(layout, columns, rows);
  if (spec.approval === true) {
    layout.paragraph(WORDS.approvedBy, { size: 9 });
    layout.signatureBlocks([{ role: ROLES.libraryHead }]);
  }
}

/** Prints the parts of `plan` (the register lists or the statistical annex) under their section heading. */
export function writeAnnexes(layout: PdfLayout, plan: readonly AnnexSpec[], rowsOf: (index: number) => readonly ReportRow[], o: { register: boolean }): void {
  const parts = plan.map((spec, index) => ({ spec, index })).filter(({ spec }) => (spec.register === true) === o.register);
  if (parts.length === 0) return;
  layout.heading(o.register ? HEADINGS.registers : HEADINGS.annex, 1);
  for (const { spec, index } of parts) writePart(layout, spec, rowsOf(index));
}
