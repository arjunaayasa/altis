import type { AccredPeriodsTable } from '@altis/db';
import { openRead, openReadWrite, type DataPath } from '@altis/platform';
import { t, type MessageKey } from '@altis/shared';
import type { AccredProfile } from '@altis/shared/api/accreditation';
import type { ReportCell } from '@altis/shared/api/reports';
import type { Selectable } from 'kysely';
import type { z } from 'zod';
import { PdfLayout, type PdfCell, type PdfTableColumn } from '../../print/layout.js';
import { dateInWords } from '../../reports/export/describe.js';
import { ExportRunFailure } from '../../reports/export/state.js';
import { collectionDataQualityReport } from '../../reports/collection/data-quality.js';
import { collectionItemListReport } from '../../reports/collection/item-list.js';
import { collectionTitleListReport } from '../../reports/collection/title-list.js';
import { libraryAnnualReport } from '../../reports/library/annual-report.js';
import { parseDefParams } from '../../reports/runs/service.js';
import type { DocumentCtx, DocumentReport, DocumentResume, ReportColumn, ReportCtx, ReportRow, TableReport } from '../../reports/types.js';
import { annexActivitiesReport } from '../annexes/activities.js';
import { annexAdditionsReport } from '../annexes/additions.js';
import { annexBudgetsReport } from '../annexes/budgets.js';
import { annexCollectionMatrixReport } from '../annexes/collection-matrix.js';
import { annexDdcReport } from '../annexes/ddc.js';
import { annexDocumentsReport } from '../annexes/documents.js';
import { annexL14Report } from '../annexes/l14.js';
import { annexPartnershipsReport } from '../annexes/partnerships.js';
import { annexStaffReport } from '../annexes/staff.js';
import { annexUsageMonthlyReport } from '../annexes/usage-monthly.js';
import { composeResults, metricParamsOf, type ComposedResults } from '../evaluate/compose.js';
import { readStoredResults } from '../evaluate/results.js';
import { instrumentById } from '../instruments/index.js';
import type { AccredMetricId } from '../metric-ids.js';
import { readProfile } from '../periods/profile.js';
import { registersProvider } from '../providers/registers.js';
import { usageProvider } from '../providers/usage.js';
import type { AccredInstrument, AccredMetricContext, AccredMetricProvider, AccredMetricValue } from '../types.js';
import { snapshotDate } from '../windows.js';
import { footerText, headerText, SOURCE_UNVERIFIED, WORDS } from './texts.js';

// What the accreditation documents read and how they print it: the period with its profile and instrument, the
// figures of the library profile, the rows of the reports they print (gathered across slices into the run's
// `rows.ndjson`), the page layout every document shares (A4 portrait, the library and its number in the header, the
// release, instrument with its source status, period, print date and page number in the footer), and the formatting
// of numbers, money and dates (always Indonesian).
//
// The documents never compose results themselves: the score, the answers, the gaps, the prerequisites and the missing
// evidence come from `composeResults`, the one composition of a period's results that `getResults` and the freeze read
// too. (The documents call it directly: `getResults` lives beside the freeze, which reads the report registry, and the
// registry holds the documents, so importing it from here would make a module cycle that breaks loading.)
//
// The reports a document prints (annexes, generated evidence lists) are looked up in a table of their own definitions
// here, not in the report registry, for the same reason.

/** A period as a document prints it. */
export interface DocPeriod {
  id: string;
  row: Selectable<AccredPeriodsTable>;
  profile: AccredProfile;
  instrument: AccredInstrument;
  /** The snapshot date: the period's end, or the run's day while the end lies ahead. */
  D: string;
  /** The instrument has indicators (a school instrument), so it prints sheets, forms and standards. */
  school: boolean;
  /** `library.name`. */
  libraryName: string;
  /** The library is a school library (`library.type`). */
  schoolLibrary: boolean;
}

/**
 * The period of the run (`params.periodId`), live, with an instrument this build has.
 *
 * @throws ExportRunFailure `not_found` when the period was archived (or its instrument is unknown) after the run started
 */
export async function loadDocPeriod(ctx: DocumentCtx): Promise<DocPeriod> {
  const id = String(ctx.params['periodId']);
  const row = await ctx.db.selectFrom('accred_periods').selectAll().where('id', '=', id).where('archived_at', 'is', null).executeTakeFirst();
  const instrument = row === undefined ? null : instrumentById(row.instrument_id);
  if (row === undefined || instrument === null) throw new ExportRunFailure('not_found');
  return {
    id,
    row,
    profile: readProfile(row.profile),
    instrument,
    D: snapshotDate(row.ends_on, ctx.today),
    school: instrument.components.length > 0,
    libraryName: ctx.libraryName,
    schoolLibrary: ctx.settings.libraryType === 'sekolah',
  };
}

// ---- formatting ------------------------------------------------------------------------------------------------------

const INTEGER = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 2 });

/** A number in Indonesian (`1.000`, `6,2`). */
export function numberText(n: number): string {
  return INTEGER.format(n);
}

/** A money amount in major units (`6.500.000`), with its currency when known. */
export function moneyText(major: number, currency?: string | null): string {
  const text = INTEGER.format(major);
  return currency === undefined || currency === null || currency === '' ? text : `${currency} ${text}`;
}

/** A calendar date in words (`30 Juni 2026`); `—` without one. */
export function dateText(date: string | null | undefined): string {
  return date === null || date === undefined || date === '' ? WORDS.none : dateInWords('id', date);
}

/** A text or `—`. */
export function orNone(text: string | number | null | undefined): string {
  if (text === null || text === undefined) return WORDS.none;
  const s = String(text).trim();
  return s === '' ? WORDS.none : s;
}

/** A shared message in Indonesian. */
export function msg(key: string, params?: Readonly<Record<string, string | number>>): string {
  return t('id', key as MessageKey, params);
}

/** The source status an instrument prints beside its decree: none for an official text. */
export function sourceStatusText(instrument: AccredInstrument): string | null {
  if (instrument.sourceStatus === 'P') return null;
  return instrument.sourceStatus === 'P-copy' ? msg('accred.source.copy') : SOURCE_UNVERIFIED;
}

/** The text of a report cell of type `type`, as the documents print it. */
export function cellText(type: ReportColumn['type'], cell: ReportCell | undefined): PdfCell {
  if (cell === null || cell === undefined) return null;
  if (typeof cell === 'number') {
    if (type === 'money') return moneyText(cell);
    if (type === 'percent') return `${numberText(cell)} %`;
    if (type === 'int') return numberText(cell);
    return String(cell);
  }
  return cell;
}

// ---- layout ----------------------------------------------------------------------------------------------------------

/**
 * A page layout for a document of period `p`: A4 portrait; the header is the library and its number unless another is
 * given; the footer names the release, the instrument and its source status, the period, the print date and the page.
 */
export function documentLayout(ctx: DocumentCtx, p: DocPeriod, o: { title: string; header?: { left: string; right?: string } }): PdfLayout {
  const footer = { version: ctx.appVersion, decree: p.instrument.decree, status: sourceStatusText(p.instrument), period: p.row.name, date: dateText(ctx.today) };
  return new PdfLayout({
    paper: 'A4',
    orientation: 'portrait',
    title: o.title,
    header: o.header ?? { left: headerText(p.libraryName, p.profile.npp ?? null) },
    footer: (page, pages) => footerText(footer, page, pages),
    nonLatinNote: msg('report.non_latin_note'),
  });
}

/** The columns that hold long texts (a title, a label) and get the most room. */
const WIDE_COLUMNS: ReadonlySet<string> = new Set(['title', 'label', 'training', 'scope']);

/** Prints `rows` of a report with `columns` (headers in Indonesian, cells formatted by type); "Tidak ada baris." when empty. */
export function printReportTable(layout: PdfLayout, columns: readonly ReportColumn[], rows: readonly ReportRow[], o: { skip?: number } = {}): void {
  const skip = o.skip ?? 0;
  if (rows.length === 0) {
    layout.paragraph(WORDS.emptyTable, { size: 9 });
    return;
  }
  const shown = columns.slice(skip);
  const pdfColumns: PdfTableColumn[] = shown.map((c) => ({
    header: msg(c.labelKey),
    weight: c.widthChars ?? (WIDE_COLUMNS.has(c.key) ? 7 : c.type === 'text' ? 3 : 1.6),
    align: c.type === 'text' || c.type === 'date' ? 'left' : 'right',
  }));
  layout.table(
    pdfColumns,
    rows.map((r) => shown.map((c, k) => cellText(c.type, r[k + skip]))),
  );
}

// ---- results ---------------------------------------------------------------------------------------------------------

/**
 * The results of `p` as the workspace reads them: the stored values with the current answers and evidence, the score
 * of the final answers (null for an unscored instrument), the prerequisites (from the evaluation's own row when the
 * prerequisites row is missing) and the missing evidence per component.
 */
export async function documentResults(ctx: DocumentCtx, p: DocPeriod): Promise<ComposedResults> {
  const stored = await readStoredResults(ctx.db, p.id);
  const composed = await composeResults(ctx.db, p.id, p.instrument, stored.rows);
  return { ...composed, prerequisites: composed.prerequisites ?? stored.meta?.prerequisites ?? null };
}

// ---- reports ---------------------------------------------------------------------------------------------------------

/** The table reports a document prints: the annexes and the reports behind the generated evidence items. */
const DOCUMENT_REPORTS: ReadonlyMap<string, TableReport> = new Map(
  [
    collectionTitleListReport,
    collectionItemListReport,
    collectionDataQualityReport,
    annexDdcReport,
    annexCollectionMatrixReport,
    annexAdditionsReport,
    annexL14Report,
    annexUsageMonthlyReport,
    annexStaffReport,
    annexBudgetsReport,
    annexActivitiesReport,
    annexPartnershipsReport,
    annexDocumentsReport,
  ].map((def) => [def.id, def]),
);

/** A table report a document prints, by id, or null for one this build does not have. */
export function documentReport(id: string): TableReport | null {
  return DOCUMENT_REPORTS.get(id) ?? null;
}

// ---- Komunitas K5 (reports) ----
/** The document reports an evidence item drafts (a signed document ALTIS drafts), which the evidence ZIP renders. */
const DRAFT_REPORTS: ReadonlyMap<string, DocumentReport> = new Map([libraryAnnualReport].map((def) => [def.id, def]));

/** A document report an evidence item drafts, by id, or null for any other id. */
export function draftReport(id: string): DocumentReport | null {
  return DRAFT_REPORTS.get(id) ?? null;
}

/** A table report a document prints, by id. @throws TypeError for any other id */
export function tableReport(id: string): TableReport {
  const def = documentReport(id);
  if (def === null) throw new TypeError(`accreditation documents: no table report ${id}`);
  return def;
}

/** The columns of `def` for `params` (its stored values). */
export function columnsOf(def: TableReport, params: Record<string, unknown>): readonly ReportColumn[] {
  return typeof def.columns === 'function' ? def.columns(params) : def.columns;
}

/** The context a report reads in for a document: the document's own, with the report's parameters after its schema. */
export function reportCtxFor(ctx: DocumentCtx, def: TableReport, params: Record<string, unknown>): { ctx: ReportCtx; params: Record<string, unknown> } {
  const parsed = parseDefParams(def, params);
  const rctx: ReportCtx = {
    db: ctx.db,
    locale: 'id',
    tz: ctx.tz,
    now: ctx.now,
    today: ctx.today,
    settings: ctx.settings,
    params: parsed,
    budgetLeftMs: () => ctx.budgetLeftMs(),
  };
  return { ctx: rctx, params: parsed };
}

/** Where a report's rows are being gathered into `rows.ndjson`: its cursor, the file's length and the rows so far. */
export interface CollectState {
  cursor: string | null;
  bytes: number;
  rows: number;
}

/** A PDF is begun in a slice that already did other work only with this much budget left. */
export const PDF_MIN_MS = 8_000;

/** The resume's state as `schema` reads it. @throws ExportRunFailure `internal` for a state the render did not write */
export function stateOf<T>(schema: z.ZodType<T>, resume: DocumentResume): T {
  const parsed = schema.safeParse(resume.state);
  if (!parsed.success) throw new ExportRunFailure('internal');
  return parsed.data;
}

/** The start of a gathering. */
export const COLLECT_START: CollectState = Object.freeze({ cursor: null, bytes: 0, rows: 0 });

/** The budget a gathering keeps for the rest of the slice. */
export const COLLECT_MARGIN_MS = 3_000;

/** One page of rows asked of a report. */
const PAGE = 500;

/**
 * Gathers the rows of `def` with `params` into `file` (one JSON line per row, `[tag, ...cells]`), from `state` on: the
 * file is cut back to `state.bytes` first, so a slice that died after writing more starts from what was recorded. Stops
 * when the report has no more rows (`done`), when more than `max` rows were gathered (`done`, `rows` over `max`), or
 * when less than {@link COLLECT_MARGIN_MS} is left of the slice (not done; the next call goes on).
 */
export async function collectRows(
  ctx: DocumentCtx,
  def: TableReport,
  params: Record<string, unknown>,
  file: DataPath,
  state: CollectState,
  o: { tag: number; max?: number },
): Promise<{ done: boolean; state: CollectState }> {
  const r = reportCtxFor(ctx, def, params);
  const handle = await openReadWrite(file);
  let { cursor, bytes, rows } = state;
  try {
    await handle.truncate(bytes);
    for (let first = true; ; first = false) {
      if (!first && ctx.budgetLeftMs() < COLLECT_MARGIN_MS) return { done: false, state: { cursor, bytes, rows } };
      const page = await def.rows(r.ctx, cursor, PAGE);
      if (page.rows.length > 0) {
        const text = page.rows.map((row) => JSON.stringify([o.tag, ...row])).join('\n') + '\n';
        const buf = Buffer.from(text, 'utf8');
        await handle.write(buf, 0, buf.byteLength, bytes);
        bytes += buf.byteLength;
        rows += page.rows.length;
      }
      cursor = page.nextCursor;
      if (cursor === null || (o.max !== undefined && rows > o.max)) {
        await handle.sync();
        return { done: true, state: { cursor: null, bytes, rows } };
      }
    }
  } finally {
    await handle.sync().catch(() => undefined);
    await handle.close().catch(() => undefined);
  }
}

/** The rows of `file` (as {@link collectRows} wrote them, up to `bytes`) grouped by their tag. */
export async function readCollected(file: DataPath, bytes: number): Promise<Map<number, ReportRow[]>> {
  const out = new Map<number, ReportRow[]>();
  if (bytes === 0) return out;
  const handle = await openRead(file);
  let text: string;
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buf, 0, bytes, 0);
    if (bytesRead !== bytes) throw new ExportRunFailure('internal');
    text = buf.toString('utf8');
  } finally {
    await handle.close();
  }
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const [tag, ...cells] = JSON.parse(line) as [number, ...ReportCell[]];
    const list = out.get(tag) ?? [];
    list.push(cells);
    out.set(tag, list);
  }
  return out;
}

// ---- the library profile's figures -------------------------------------------------------------------------------------

/** The metrics the profile form prints (beside the period's own columns and the collection matrix). */
export const PROFILE_METRICS = Object.freeze({
  staff: 'registers.profile_staff',
  counts: 'registers.profile_counts',
  budget: 'registers.profile_budget',
  averages: 'usage.profile_averages',
  members: 'usage.members_active',
} as const satisfies Record<string, AccredMetricId>);

/** A provider's values for `ids`, computed now (both providers answer in one call). */
async function valuesOf(provider: AccredMetricProvider, mctx: AccredMetricContext, ids: readonly AccredMetricId[]): Promise<ReadonlyMap<AccredMetricId, AccredMetricValue>> {
  const step = await provider.compute(mctx, ids, null);
  if (!step.done) throw new ExportRunFailure('internal');
  return step.values;
}

/** The figures of the profile form of `p`: staff, counts, budget of the period's last year, monthly averages, members. */
export async function profileFigures(ctx: DocumentCtx, p: DocPeriod): Promise<ReadonlyMap<AccredMetricId, AccredMetricValue>> {
  const mctx: AccredMetricContext = {
    db: ctx.db,
    periodId: p.id,
    period: p.row,
    profile: p.profile,
    instrument: p.instrument,
    D: p.D,
    today: ctx.today,
    settings: ctx.settings,
    baseUrl: null,
    now: ctx.now,
    budgetLeftMs: () => ctx.budgetLeftMs(),
    paramsOf: metricParamsOf(p.instrument),
  };
  const out = new Map<AccredMetricId, AccredMetricValue>();
  for (const [k, v] of await valuesOf(registersProvider, mctx, [PROFILE_METRICS.staff, PROFILE_METRICS.counts, PROFILE_METRICS.budget])) out.set(k, v);
  for (const [k, v] of await valuesOf(usageProvider, mctx, [PROFILE_METRICS.averages, PROFILE_METRICS.members])) out.set(k, v);
  return out;
}

/** The bytes of a stored file, or null when it is gone. */
export async function storedBytes(ctx: DocumentCtx, fileId: string): Promise<Buffer | null> {
  const stream = await ctx.storage.get(fileId);
  if (stream === null) return null;
  const parts: Buffer[] = [];
  for await (const chunk of stream) parts.push(Buffer.from(chunk));
  return Buffer.concat(parts);
}
