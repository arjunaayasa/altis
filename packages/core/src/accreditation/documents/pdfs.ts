import type { ReportRow } from '../../reports/types.js';
import type { DocumentCtx } from '../../reports/types.js';
import type { ComposedResults } from '../evaluate/compose.js';
import type { AccredMetricId } from '../metric-ids.js';
import type { AccredMetricValue } from '../types.js';
import { annexPlan, MATRIX_ANNEX, writeAnnexes, type AnnexSpec } from './annex-sections.js';
import { columnsOf, documentLayout, tableReport, type DocPeriod } from './data.js';
import { sheetItems, writeIkSheets } from './ik-sheets.js';
import { writeProfileForm } from './profile-form.js';
import { writeCertificateName } from './sections/certificate-name.js';
import { writeCover } from './sections/cover.js';
import { writeRequestLetter } from './sections/request-letter.js';
import { writeSnp } from './sections/snp.js';
import { writeStatement } from './sections/statement.js';
import { HEADINGS } from './texts.js';

// The PDFs of the evidence file: the whole file (or its request letter alone), the indicator sheets of one component
// and the profile form, for the per-component ZIPs. Each is laid out in one call, from the results, the profile's
// figures and the annex rows gathered before.

/** What a PDF was: its bytes, its pages and the table rows that lost characters. */
export interface BuiltPdf {
  bytes: Uint8Array;
  pages: number;
  nonLatinRows: number;
}

/** The annex rows by the index of their part in the plan. */
export type AnnexRows = (index: number) => readonly ReportRow[];

/** The collection matrix the profile form prints, from the annex rows (null when the plan has none). */
function matrixOf(plan: readonly AnnexSpec[], rows: AnnexRows): Parameters<typeof writeProfileForm>[3]['matrix'] {
  const index = plan.findIndex((s) => s.reportId === MATRIX_ANNEX);
  if (index < 0) return null;
  const spec = plan[index]!;
  return { columns: columnsOf(tableReport(spec.reportId), spec.params), rows: rows(index) };
}

/**
 * The evidence file of `p`: sections 1–8 for a school instrument (cover, request letter and submission form, the
 * statement of 1 000 titles, the certificate name, the profile form, the indicator sheets, the statistical annex, the
 * school standards); for the statistics mode the cover, the profile form, the register lists and the statistical
 * annex; with `part: 'request_letter'`, section 2 alone.
 */
export async function buildDossierPdf(
  ctx: DocumentCtx,
  p: DocPeriod,
  o: { part: 'all' | 'request_letter'; results: ComposedResults; figures: ReadonlyMap<AccredMetricId, AccredMetricValue>; rows: AnnexRows },
): Promise<BuiltPdf> {
  const layout = documentLayout(ctx, p, { title: HEADINGS.dossier });
  if (o.part === 'request_letter') {
    writeRequestLetter(layout, ctx, p);
  } else if (p.school) {
    const plan = annexPlan(p);
    writeCover(layout, p);
    layout.pageBreak();
    writeRequestLetter(layout, ctx, p);
    layout.pageBreak();
    writeStatement(layout, ctx, p, o.results.prerequisites, { names: true });
    layout.pageBreak();
    writeCertificateName(layout, ctx, p);
    layout.pageBreak();
    await writeProfileForm(layout, ctx, p, { figures: o.figures, matrix: matrixOf(plan, o.rows) });
    layout.pageBreak();
    writeIkSheets(layout, sheetItems(p.instrument, o.results));
    layout.pageBreak();
    writeAnnexes(layout, plan, o.rows, { register: false });
    layout.pageBreak();
    writeSnp(layout, o.results.snp);
  } else {
    const plan = annexPlan(p);
    writeCover(layout, p);
    layout.pageBreak();
    await writeProfileForm(layout, ctx, p, { figures: o.figures, matrix: matrixOf(plan, o.rows) });
    layout.pageBreak();
    writeAnnexes(layout, plan, o.rows, { register: true });
    layout.pageBreak();
    writeAnnexes(layout, plan, o.rows, { register: false });
  }
  const bytes = layout.toBytes();
  return { bytes, pages: layout.pages, nonLatinRows: layout.nonLatinRows };
}

/** The indicator sheets of one component of `p` (`00-lembar-<folder>.pdf`). */
export function buildComponentSheetsPdf(ctx: DocumentCtx, p: DocPeriod, results: ComposedResults, component: string): BuiltPdf {
  const layout = documentLayout(ctx, p, { title: HEADINGS.sheets });
  writeIkSheets(layout, sheetItems(p.instrument, results, new Set([component])));
  const bytes = layout.toBytes();
  return { bytes, pages: layout.pages, nonLatinRows: layout.nonLatinRows };
}

/** The profile form of `p` alone (`00-lembar-profil.pdf`). */
export async function buildProfilePdf(ctx: DocumentCtx, p: DocPeriod, o: { figures: ReadonlyMap<AccredMetricId, AccredMetricValue>; rows: AnnexRows }): Promise<BuiltPdf> {
  const layout = documentLayout(ctx, p, { title: HEADINGS.profile });
  await writeProfileForm(layout, ctx, p, { figures: o.figures, matrix: matrixOf(annexPlan(p), o.rows) });
  const bytes = layout.toBytes();
  return { bytes, pages: layout.pages, nonLatinRows: layout.nonLatinRows };
}
