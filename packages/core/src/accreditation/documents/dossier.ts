import { reportWorkPath, writeBytesAtomic } from '@altis/platform';
import { z } from 'zod';
import { PERIOD_PARAM, reportIdField, reportParam } from '../../reports/params.js';
import { ExportRunFailure } from '../../reports/export/state.js';
import type { DocumentCtx, DocumentReport, DocumentResume, DocumentStep } from '../../reports/types.js';
import type { AccredMetricId } from '../metric-ids.js';
import type { AccredMetricValue } from '../types.js';
import { annexPlan } from './annex-sections.js';
import { COLLECT_MARGIN_MS, collectRows, documentResults, loadDocPeriod, PDF_MIN_MS, profileFigures, readCollected, stateOf, tableReport } from './data.js';
import { buildComponentSheetsPdf, buildDossierPdf, buildProfilePdf } from './pdfs.js';
import { listPdfBuilder, sheetWorkName, writeZip, zipStart, zipStateSchema, zipUnits, type ZipMode } from './zip.js';

// The evidence file of a period (spec §10.9): a PDF without any score, the request letter alone, or a ZIP of the PDF
// with the evidence files (one ZIP, or one ZIP per component inside one ZIP). Personal: it prints the names of the
// staff, so its runs need a fresh re-authentication. Always in Indonesian.
//
// Rendering goes in three phases across slices:
// - `collect`: the rows of every annex part are gathered into the run's `rows.ndjson` (a part that reads the whole
//   stock goes on from its cursor in the next slice);
// - `pdf`: the whole PDF is laid out in one slice from the results, the profile's figures and those rows: the run's
//   file for a PDF, else `dossier.pdf` (combined ZIP) or the sheets of each component and the profile form
//   (`entry-1.pdf` … `entry-7.pdf`, per-component ZIP);
// - `zip`: the ZIP is written unit by unit (zip.ts), the reports the evidence items draft rendered on the way, except
//   those the run's `withheld` names.

/** The parts of the dossier a run makes: all of it, or the request letter alone. */
export const DOSSIER_PARTS = Object.freeze(['all', 'request_letter'] as const);

/** How the evidence ZIP is cut: one ZIP, or one ZIP per component inside one ZIP. */
export const DOSSIER_ZIP_MODES = Object.freeze(['combined', 'components'] as const);

const DossierParams = z.strictObject({
  periodId: reportIdField,
  part: z.enum(DOSSIER_PARTS).default('all'),
  zipMode: z.enum(DOSSIER_ZIP_MODES).default('combined'),
  // ---- Komunitas K5 (reports) ----
  /** The drafted reports the ZIP leaves out: its caller may not export them (set when the run starts). */
  withheld: z.array(z.string().max(64)).max(16).optional(),
});

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
/** The gathering of the annex rows: the part being read and the length of `rows.ndjson` (its cursor is the resume's). */
const collectState = z.strictObject({ index: count, bytes: count, rows: count });
/** The PDF phase: the length of `rows.ndjson` once every part was gathered. */
const pdfState = z.strictObject({ bytes: count });

const COMPONENTS = ['K', 'SP', 'L', 'T', 'F', 'G'] as const;

async function renderDossier(ctx: DocumentCtx, resume: DocumentResume | null): Promise<DocumentStep> {
  const params = DossierParams.parse(ctx.params);
  const p = await loadDocPeriod(ctx);
  const plan = params.part === 'request_letter' ? [] : annexPlan(p);
  const rowsFile = reportWorkPath(ctx.dataDir, ctx.runId, 'rows.ndjson');
  const mode: ZipMode = p.school && params.zipMode === 'components' ? 'components' : 'combined';
  let phase = resume?.phase ?? 'collect';
  let bytes = 0;

  if (phase === 'collect') {
    const s = resume === null ? { index: 0, bytes: 0, rows: 0 } : stateOf(collectState, resume);
    let cursor = resume?.cursor ?? null;
    let { index, bytes: written, rows } = s;
    while (index < plan.length) {
      const spec = plan[index]!;
      const r = await collectRows(ctx, tableReport(spec.reportId), spec.params, rowsFile, { cursor, bytes: written, rows }, { tag: index });
      if (!r.done) return { done: false, resume: { phase: 'collect', cursor: r.state.cursor, state: { index, bytes: r.state.bytes, rows: r.state.rows } } };
      index += 1;
      cursor = null;
      written = r.state.bytes;
      rows = 0;
      if (index < plan.length && ctx.budgetLeftMs() < COLLECT_MARGIN_MS) return { done: false, resume: { phase: 'collect', cursor: null, state: { index, bytes: written, rows: 0 } } };
    }
    bytes = written;
    phase = 'pdf';
    if (plan.length > 0 && ctx.budgetLeftMs() < PDF_MIN_MS) return { done: false, resume: { phase: 'pdf', cursor: null, state: { bytes } } };
  } else if (phase === 'pdf') {
    bytes = stateOf(pdfState, resume!).bytes;
  }

  if (phase === 'pdf') {
    const collected = await readCollected(rowsFile, bytes);
    const rowsOf = (i: number) => collected.get(i) ?? [];
    const results = await documentResults(ctx, p);
    const figures: ReadonlyMap<AccredMetricId, AccredMetricValue> = params.part === 'request_letter' ? new Map() : await profileFigures(ctx, p);
    if (ctx.format === 'pdf') {
      const built = await buildDossierPdf(ctx, p, { part: params.part, results, figures, rows: rowsOf });
      await writeBytesAtomic(reportWorkPath(ctx.dataDir, ctx.runId, 'output.part'), built.bytes);
      return { done: true, rowCount: built.pages, nonLatinRows: built.nonLatinRows, warnings: [] };
    }
    if (mode === 'combined') {
      const built = await buildDossierPdf(ctx, p, { part: 'all', results, figures, rows: rowsOf });
      await writeBytesAtomic(reportWorkPath(ctx.dataDir, ctx.runId, 'dossier.pdf'), built.bytes);
    } else {
      for (const [i, code] of COMPONENTS.entries()) {
        await writeBytesAtomic(reportWorkPath(ctx.dataDir, ctx.runId, sheetWorkName(i + 1)), buildComponentSheetsPdf(ctx, p, results, code).bytes);
      }
      const profile = await buildProfilePdf(ctx, p, { figures, rows: rowsOf });
      await writeBytesAtomic(reportWorkPath(ctx.dataDir, ctx.runId, sheetWorkName(COMPONENTS.length + 1)), profile.bytes);
    }
    // The PDFs are kept before the ZIP starts: a list gathered next reuses `rows.ndjson`.
    return { done: false, resume: { phase: 'zip', cursor: null, state: zipStart(mode) } };
  }
  if (phase !== 'zip' || resume === null) throw new ExportRunFailure('internal');
  const zip = stateOf(zipStateSchema, resume);
  const r = await writeZip(ctx, await zipUnits(ctx.db, p, zip.mode, { withheld: params.withheld ?? [] }), zip, listPdfBuilder(ctx, p));
  if (r.done) return r;
  return { done: false, resume: { phase: 'zip', cursor: null, state: r.state } };
}

/**
 * The evidence file without scores (a PDF, or a ZIP of it with the evidence files). Personal: it prints the names of
 * the staff, so its runs need a fresh re-authentication.
 */
export const dossierReport: DocumentReport = Object.freeze<DocumentReport>({
  id: 'accreditation.dossier',
  module: 'accreditation',
  kind: 'document',
  titleKey: 'report.accreditation.dossier.title',
  permission: 'accreditation.workspace.read',
  personal: true,
  formats: ['pdf', 'zip'],
  orientation: 'portrait',
  params: [PERIOD_PARAM, reportParam('part', 'status', { options: DOSSIER_PARTS }), reportParam('zipMode', 'status', { options: DOSSIER_ZIP_MODES })],
  paramsSchema: DossierParams,
  render: renderDossier,
});
