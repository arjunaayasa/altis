import { countDistinctGrouped, countGrouped, datePrefix, sumGrouped } from '@altis/db';
import { reportWorkPath, writeBytesAtomic } from '@altis/platform';
import { DDC_MAINS, addDays, ddcClassOf, t, type MessageKey } from '@altis/shared';
import { sql, type SqlBool } from 'kysely';
import { z } from 'zod';
import { budgetRows } from '../../accreditation/providers/registers-metrics.js';
import { PdfLayout, type PdfCell, type PdfTableColumn } from '../../print/layout.js';
import { SCAN_MARGIN_MS, localDayStart, stockCopies } from '../collection/common.js';
import { sumOf } from '../circulation/common.js';
import { dateInWords } from '../export/describe.js';
import { ExportRunFailure } from '../export/state.js';
import { reportIdField, reportParam, reportYearField } from '../params.js';
import { STOCK_SCAN_MAX_LIMIT, acquisitionOf, firstAcq, scanRecordStock, type RecordStockFacts } from '../stock/index.js';
import type { DocumentCtx, DocumentReport, DocumentResume, DocumentStep, ReportCtx } from '../types.js';
import { PERIOD_FILTER, yearOrPeriodSpan, type ReportSpan } from '../window.js';

// The annual report of the library: one PDF for a year (`year`, this year by default) or an accreditation period
// (`periodId`, a school year), in the run's language, holding no personal data (the approval block leaves the names to
// be written by hand), so that the library can print it, have it signed and keep it as its yearly report (the
// accreditation workspace offers it beside the indicator of routine reports). Its sections:
//
// - the collection in the stock at the end of the span (or today while the span runs), titles and copies by DDC main
//   class, by the stock rules every collection report shares;
// - the additions of the span: titles whose first copy came in within it and copies that came in within it, by the
//   acquisition-date chain (an undated copy is never an addition; their number is printed);
// - the members registered and valid at that day and those who joined within the span, by member type;
// - visits (people, a voided visit not at all), loans (a voided loan not at all), returns and in-library uses, per
//   month of the span;
// - the activities held within the span, by kind; the library staff serving within it, counted (never named); the
//   budget of each calendar year the span touches;
// - an approval block for the head of the library and the head of the parent institution.
//
// Two phases: the stock is scanned across slices (its running counts are the resume state), then the rest is read and
// the PDF laid out in one slice.

/** The classes of the collection tables, in order: the ten DDC main classes, 2X and the others. */
const CLASSES = DDC_MAINS;

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const perClass = z.array(count).length(CLASSES.length);
const ScanState = z.strictObject({ titles: perClass, items: perClass, addedTitles: perClass, addedItems: perClass, undated: count });
type ScanState = z.infer<typeof ScanState>;

const zeros = (): number[] => CLASSES.map(() => 0);
const START: ScanState = { titles: zeros(), items: zeros(), addedTitles: zeros(), addedItems: zeros(), undated: 0 };

/** A PDF is begun in a slice that already scanned only with this much budget left. */
const PDF_MIN_MS = 8_000;

/** A shared text in the run's language. */
const tx = (ctx: ReportCtx, key: string, params?: Readonly<Record<string, string | number>>): string => t(ctx.locale, key as MessageKey, params);

/** The day the stock and the members are counted at: the span's end, or today while it lies ahead. */
const asOfDay = (span: ReportSpan, today: string): string => (span.to <= today ? span.to : today);

/** Adds a batch of the stock scan to `s`. */
function addBatch(s: ScanState, batch: readonly RecordStockFacts[], span: ReportSpan, D: string, electronic: ReadonlySet<string>): void {
  for (const r of batch) {
    const k = CLASSES.indexOf(ddcClassOf(r.classification, r.callNumber).main);
    const copies = stockCopies(r, D, electronic, { branchId: null });
    if (copies !== null) {
      s.titles[k]! += 1;
      s.items[k]! += copies.length;
      s.undated += copies.filter((i) => acquisitionOf(i)?.date === null).length;
    }
    if (r.merged) continue;
    // A title without copies is an addition as it is in the stock: when it is electronic or has a public file.
    const counted = r.items.length > 0 || (r.materialTypeCode !== null && electronic.has(r.materialTypeCode)) || r.hasPublicFile;
    const first = firstAcq(r);
    if (counted && first !== 'unknown' && first >= span.from && first <= span.to) s.addedTitles[k]! += 1;
    for (const i of r.items) {
      const date = acquisitionOf(i)?.date ?? null;
      if (date !== null && date >= span.from && date <= span.to) s.addedItems[k]! += 1;
    }
  }
}

// ---- the figures read in the last slice ------------------------------------------------------------------------------

interface Figures {
  members: { types: { name: string; registered: number; valid: number; joined: number }[] };
  usage: { months: { month: string; visits: number; guests: number; loans: number; returns: number; uses: number }[]; borrowers: number };
  activities: { kind: string; held: number; participants: number }[];
  staff: { serving: number; librarians: number; libraryEducation: number; certified: number };
  budgets: { year: number; library: number | null; collection: number | null; currency: string | null }[];
}

/** The members registered and valid at `D` and joined within the span, by member type. */
async function membersOf(ctx: ReportCtx, span: ReportSpan, D: string): Promise<Figures['members']> {
  const dayAfter = localDayStart(ctx.tz, addDays(D, 1));
  const present = () =>
    ctx.db
      .selectFrom('members as m')
      .where('m.joined_on', '<=', D)
      .where((eb) => eb.or([eb('m.archived_at', 'is', null), eb('m.archived_at', '>=', dayAfter)]))
      .where((eb) => eb.or([eb('m.anonymized_at', 'is', null), eb('m.anonymized_at', '>=', dayAfter)]));
  const registered = await countGrouped(present(), { t: 'm.member_type_id' });
  const valid = await countGrouped(
    present().where((eb) => eb.or([eb('m.expires_on', 'is', null), eb('m.expires_on', '>=', D)])),
    { t: 'm.member_type_id' },
  );
  const joined = await countGrouped(ctx.db.selectFrom('members as m').where('m.joined_on', '>=', span.from).where('m.joined_on', '<=', span.to), { t: 'm.member_type_id' });
  const types = await ctx.db.selectFrom('member_types').select(['id', 'name_id', 'name_en', 'sort_order']).execute();
  const of = (list: readonly { t: string | number | null; count: number }[], id: string): number => list.find((g) => g.t === id)?.count ?? 0;
  return {
    types: [...types]
      .sort((a, b) => Number(a.sort_order) - Number(b.sort_order) || a.name_id.localeCompare(b.name_id))
      .map((ty) => ({ name: ctx.locale === 'en' ? (ty.name_en ?? ty.name_id) : ty.name_id, registered: of(registered, ty.id), valid: of(valid, ty.id), joined: of(joined, ty.id) }))
      .filter((r) => r.registered + r.valid + r.joined > 0),
  };
}

/** Visits, loans, returns and in-library uses per month of the span, and the distinct borrowers. */
async function usageOf(ctx: ReportCtx, span: ReportSpan): Promise<Figures['usage']> {
  const notVoided = sql<SqlBool>`(l.outcome is null or l.outcome <> 'voided')`;
  const visits = await sumGrouped(
    ctx.db.selectFrom('visits as v').where('v.visited_on', '>=', span.from).where('v.visited_on', '<=', span.to).where('v.voided_at', 'is', null),
    { m: datePrefix('v.visited_on', 'month'), g: 'v.accred_group' },
    'v.headcount',
  );
  const loansQuery = () => ctx.db.selectFrom('loans as l').where('l.loaned_on', '>=', span.from).where('l.loaned_on', '<=', span.to).where(notVoided);
  const loans = await countGrouped(loansQuery(), { m: datePrefix('l.loaned_on', 'month') });
  const returns = await countGrouped(
    ctx.db.selectFrom('loans as l').where('l.returned_on', '>=', span.from).where('l.returned_on', '<=', span.to).where('l.outcome', '=', 'returned'),
    { m: datePrefix('l.returned_on', 'month') },
  );
  const uses = await countGrouped(ctx.db.selectFrom('item_uses as u').where('u.used_on', '>=', span.from).where('u.used_on', '<=', span.to), {
    m: datePrefix('u.used_on', 'month'),
  });
  const borrowers = (await countDistinctGrouped(loansQuery(), {}, 'l.member_id'))[0]?.count ?? 0;
  const inMonth = <T extends { m: string | number | null }>(list: readonly T[], month: string): T[] => list.filter((g) => g.m === month);
  return {
    months: span.months.map((month) => {
      const v = inMonth(visits, month);
      return {
        month,
        visits: sumOf(v.map((g) => g.sum)),
        guests: sumOf(v.filter((g) => g.g === 'guest').map((g) => g.sum)),
        loans: sumOf(inMonth(loans, month).map((g) => g.count)),
        returns: sumOf(inMonth(returns, month).map((g) => g.count)),
        uses: sumOf(inMonth(uses, month).map((g) => g.count)),
      };
    }),
    borrowers,
  };
}

async function figuresOf(ctx: ReportCtx, span: ReportSpan, D: string): Promise<Figures> {
  const activityRows = await ctx.db
    .selectFrom('library_activities')
    .select(['kind', 'participants'])
    .where('archived_at', 'is', null)
    .where('held_on', '>=', span.from)
    .where('held_on', '<=', span.to)
    .execute();
  const kinds = new Map<string, { held: number; participants: number }>();
  for (const a of activityRows) {
    const k = kinds.get(a.kind) ?? { held: 0, participants: 0 };
    k.held += 1;
    k.participants += a.participants === null ? 0 : Number(a.participants);
    kinds.set(a.kind, k);
  }
  const staffRows = await ctx.db
    .selectFrom('library_staff')
    .select(['is_librarian', 'education_library', 'competency_cert'])
    .where('archived_at', 'is', null)
    .where((eb) => eb.or([eb('starts_on', 'is', null), eb('starts_on', '<=', span.to)]))
    .where((eb) => eb.or([eb('ends_on', 'is', null), eb('ends_on', '>=', span.from)]))
    .execute();
  const years: number[] = [];
  for (let y = Number(span.from.slice(0, 4)); y <= Number(span.to.slice(0, 4)); y += 1) years.push(y);
  const budgets = await budgetRows(ctx.db, years);
  return {
    members: await membersOf(ctx, span, D),
    usage: await usageOf(ctx, span),
    activities: [...kinds.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([kind, k]) => ({ kind, ...k })),
    staff: {
      serving: staffRows.length,
      librarians: staffRows.filter((s) => Number(s.is_librarian) === 1).length,
      libraryEducation: staffRows.filter((s) => Number(s.education_library) === 1).length,
      certified: staffRows.filter((s) => Number(s.competency_cert) === 1).length,
    },
    budgets: years.map((year) => {
      const b = budgets.get(year);
      return { year, library: b === undefined ? null : b.library / 100, collection: b?.collection == null ? null : b.collection / 100, currency: b?.currency ?? null };
    }),
  };
}

// ---- the PDF -------------------------------------------------------------------------------------------------------

function render(ctx: DocumentCtx, span: ReportSpan, D: string, s: ScanState, f: Figures): PdfLayout {
  const locale = ctx.locale;
  const title = tx(ctx, 'report.library.annual_report.title');
  const printed = dateInWords(locale, ctx.today);
  const layout = new PdfLayout({
    paper: 'A4',
    orientation: 'portrait',
    title,
    header: { left: `${ctx.libraryName} · ${title}` },
    footer: (page, pages) => tx(ctx, 'report.footer', { date: printed, name: ctx.staffName, page, pages }),
    nonLatinNote: tx(ctx, 'report.non_latin_note'),
  });
  const numbers = new Intl.NumberFormat(locale === 'en' ? 'en-GB' : 'id-ID', { maximumFractionDigits: 2 });
  const n = (v: number | null): PdfCell => (v === null ? '—' : numbers.format(v));
  const months = new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'id-ID', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const monthName = (m: string): string => months.format(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1, 1));
  const total = tx(ctx, 'report.row.total');
  const cols = (...spec: [string, number, 'left' | 'right'][]): PdfTableColumn[] => spec.map(([key, weight, align]) => ({ header: tx(ctx, key), weight, align }));
  const empty = (): void => layout.paragraph(tx(ctx, 'report.annual.empty'), { size: 9 });

  layout.heading(title, 1);
  layout.paragraph(ctx.libraryName, { bold: true });
  layout.keyValues([
    [tx(ctx, 'report.annual.span'), `${dateInWords(locale, span.from)} – ${dateInWords(locale, span.to)}`],
    ...(span.periodName === null ? [] : [[tx(ctx, 'report.annual.period'), span.periodName] as [string, string]]),
    [tx(ctx, 'report.annual.as_of'), dateInWords(locale, D)],
  ]);
  layout.paragraph(tx(ctx, 'report.annual.note'), { size: 9 });

  // The collection and its additions, by class.
  const classRows = (a: readonly number[], b: readonly number[]): PdfCell[][] => [
    ...CLASSES.map((c, k) => [`${c === 'NON' ? '' : `${c} `}${tx(ctx, `vocab.ddc_main.${c}`)}`, n(a[k]!), n(b[k]!)]),
    [total, n(sumOf(a)), n(sumOf(b))],
  ];
  const classColumns = cols(['report.annual.col.class', 6, 'left'], ['report.annual.col.titles', 1.6, 'right'], ['report.annual.col.items', 1.6, 'right']);
  layout.heading(tx(ctx, 'report.annual.section.collection'), 2);
  layout.keyValues([
    [tx(ctx, 'report.annual.col.titles'), String(n(sumOf(s.titles)))],
    [tx(ctx, 'report.annual.col.items'), String(n(sumOf(s.items)))],
  ]);
  layout.table(classColumns, classRows(s.titles, s.items));
  layout.heading(tx(ctx, 'report.annual.section.additions'), 2);
  layout.keyValues([
    [tx(ctx, 'report.annual.col.titles'), String(n(sumOf(s.addedTitles)))],
    [tx(ctx, 'report.annual.col.items'), String(n(sumOf(s.addedItems)))],
  ]);
  layout.table(classColumns, classRows(s.addedTitles, s.addedItems));
  if (s.undated > 0) layout.paragraph(tx(ctx, 'report.annual.undated', { count: numbers.format(s.undated) }), { size: 9 });

  // Members.
  layout.heading(tx(ctx, 'report.annual.section.members'), 2);
  const m = f.members.types;
  layout.keyValues([
    [tx(ctx, 'report.annual.members.registered'), String(n(sumOf(m.map((r) => r.registered))))],
    [tx(ctx, 'report.annual.members.valid'), String(n(sumOf(m.map((r) => r.valid))))],
    [tx(ctx, 'report.annual.members.joined'), String(n(sumOf(m.map((r) => r.joined))))],
  ]);
  if (m.length === 0) empty();
  else
    layout.table(cols(['report.annual.col.member_type', 4, 'left'], ['report.annual.members.registered', 2, 'right'], ['report.annual.members.valid', 2, 'right'], ['report.annual.members.joined', 2, 'right']), [
      ...m.map((r) => [r.name, n(r.registered), n(r.valid), n(r.joined)]),
      [total, n(sumOf(m.map((r) => r.registered))), n(sumOf(m.map((r) => r.valid))), n(sumOf(m.map((r) => r.joined)))],
    ]);

  // Visits, loans and in-library use.
  layout.heading(tx(ctx, 'report.annual.section.usage'), 2);
  const u = f.usage.months;
  const sum = (key: 'visits' | 'guests' | 'loans' | 'returns' | 'uses'): number => sumOf(u.map((r) => r[key]));
  layout.keyValues([
    [tx(ctx, 'report.annual.col.visits'), String(n(sum('visits')))],
    [tx(ctx, 'report.annual.usage.guests'), String(n(sum('guests')))],
    [tx(ctx, 'report.annual.col.loans'), String(n(sum('loans')))],
    [tx(ctx, 'report.annual.usage.borrowers'), String(n(f.usage.borrowers))],
    [tx(ctx, 'report.annual.col.returns'), String(n(sum('returns')))],
    [tx(ctx, 'report.annual.col.uses'), String(n(sum('uses')))],
  ]);
  layout.table(
    cols(['report.annual.col.month', 3, 'left'], ['report.annual.col.visits', 2, 'right'], ['report.annual.col.loans', 2, 'right'], ['report.annual.col.returns', 2, 'right'], ['report.annual.col.uses', 2, 'right']),
    [...u.map((r) => [monthName(r.month), n(r.visits), n(r.loans), n(r.returns), n(r.uses)]), [total, n(sum('visits')), n(sum('loans')), n(sum('returns')), n(sum('uses'))]],
  );

  // Activities.
  layout.heading(tx(ctx, 'report.annual.section.activities'), 2);
  if (f.activities.length === 0) empty();
  else
    layout.table(cols(['report.annual.col.kind', 5, 'left'], ['report.annual.col.held', 2, 'right'], ['report.annual.col.participants', 2, 'right']), [
      ...f.activities.map((a) => [tx(ctx, `vocab.activity_kind.${a.kind}`), n(a.held), n(a.participants)]),
      [total, n(sumOf(f.activities.map((a) => a.held))), n(sumOf(f.activities.map((a) => a.participants)))],
    ]);

  // Staff, counted.
  layout.heading(tx(ctx, 'report.annual.section.staff'), 2);
  layout.keyValues([
    [tx(ctx, 'report.annual.staff.serving'), String(n(f.staff.serving))],
    [tx(ctx, 'report.annual.staff.librarians'), String(n(f.staff.librarians))],
    [tx(ctx, 'report.annual.staff.library_education'), String(n(f.staff.libraryEducation))],
    [tx(ctx, 'report.annual.staff.certified'), String(n(f.staff.certified))],
  ]);

  // Budget.
  layout.heading(tx(ctx, 'report.annual.section.budget'), 2);
  layout.table(
    cols(['report.annual.col.year', 2, 'left'], ['report.annual.col.currency', 1.5, 'left'], ['report.annual.col.library_budget', 3, 'right'], ['report.annual.col.collection_budget', 3, 'right']),
    f.budgets.map((b) => [String(b.year), b.currency ?? '—', n(b.library), n(b.collection)]),
  );

  // Approval: the roles and the room to sign; the names are written by hand.
  layout.heading(tx(ctx, 'report.annual.section.approval'), 2);
  layout.signatureBlocks([
    { role: tx(ctx, 'report.annual.approval.parent'), stamp: true },
    { role: tx(ctx, 'report.annual.approval.library') },
  ]);
  return layout;
}

async function renderAnnual(ctx: DocumentCtx, resume: DocumentResume | null): Promise<DocumentStep> {
  const span = await yearOrPeriodSpan(ctx);
  const D = asOfDay(span, ctx.today);
  let state: ScanState;
  if (resume === null) state = structuredClone(START);
  else {
    const parsed = ScanState.safeParse(resume.state);
    if (!parsed.success) throw new ExportRunFailure('internal');
    state = parsed.data;
  }
  if (resume === null || resume.phase === 'scan') {
    const electronic = new Set(ctx.settings.electronicMaterialTypeCodes);
    let after = resume?.cursor ?? null;
    for (let first = true; ; first = false) {
      if (!first && ctx.budgetLeftMs() < SCAN_MARGIN_MS) return { done: false, resume: { phase: 'scan', cursor: after, state } };
      const page = await scanRecordStock(ctx.db, { tz: ctx.tz, after, limit: STOCK_SCAN_MAX_LIMIT });
      addBatch(state, page.rows, span, D, electronic);
      after = page.next;
      if (after === null) break;
    }
    if (ctx.budgetLeftMs() < PDF_MIN_MS) return { done: false, resume: { phase: 'pdf', cursor: null, state } };
  } else if (resume.phase !== 'pdf') throw new ExportRunFailure('internal');
  const layout = render(ctx, span, D, state, await figuresOf(ctx, span, D));
  await writeBytesAtomic(reportWorkPath(ctx.dataDir, ctx.runId, 'output.part'), layout.toBytes());
  return { done: true, rowCount: layout.pages, nonLatinRows: layout.nonLatinRows, warnings: [] };
}

/** The annual report of the library (see the top of this file). */
export const libraryAnnualReport: DocumentReport = Object.freeze<DocumentReport>({
  id: 'library.annual_report',
  module: 'library',
  kind: 'document',
  titleKey: 'report.library.annual_report.title',
  permission: 'reports.statistics.read',
  personal: false,
  formats: ['pdf'],
  orientation: 'portrait',
  runRoutes: true,
  params: [reportParam('year', 'year', { min: 1900, max: 2100 }), PERIOD_FILTER],
  paramsSchema: z.strictObject({ year: reportYearField.optional(), periodId: reportIdField.optional() }),
  render: renderAnnual,
});
