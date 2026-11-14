import { writeBytesAtomic } from '@altis/platform';
import { localDate, t, type MessageKey } from '@altis/shared';
import type { ReportCell, ReportColumnType } from '@altis/shared/api/reports';
import { PdfLayout, type PdfCell, type PdfTableColumn } from '../../print/layout.js';
import { dateInWords, describeParams, localeTag } from './describe.js';
import { readEntries, runColumns } from './rows-phase.js';
import { workFile, type ExportRun, type FinishState, type WriteState } from './state.js';

// The write phase of a PDF export (spec §4.15): one layout built in one slice from the whole of `rows.ndjson` (at most
// 10 000 rows and the totals row), on the paper stored with the run (A4 by default) in the definition's orientation.
// Every page has the header "<library> · <report>" with the filters in words beside it, and the footer "printed <date>
// by <staff member> · page X/Y", all in the run's language. One table: money in the language's grouping, every other
// cell as the rows phase wrote it. A row whose text the PDF fonts cannot print gets the note "non-Latin text: see
// XLSX/CSV" and is counted in `non_latin_rows`. The file is written to `output.part` whole.
//
// The header repeats on every page, so it is kept short: at most 8 filter lines of at most 100 characters each (a cut
// line or list ends in "…"); the whole filters stay in the run's parameters.

/** The relative widths of the columns by type, when a column gives none (as the XLSX widths). */
const WEIGHTS: Readonly<Record<ReportColumnType, number>> = { text: 30, int: 10, money: 14, date: 12, percent: 8 };

const NUMBER_TYPES: ReadonlySet<ReportColumnType> = new Set<ReportColumnType>(['int', 'money', 'percent']);

/** The most filter lines the page header holds, and the most characters of one. */
const HEADER_FILTERS_MAX = 8;
const HEADER_FILTER_CHARS_MAX = 100;

/** The filter lines as the page header prints them (see the top of this file). */
function headerFilters(lines: readonly string[]): string[] {
  const clip = (line: string): string => {
    const chars = Array.from(line);
    return chars.length <= HEADER_FILTER_CHARS_MAX ? line : `${chars.slice(0, HEADER_FILTER_CHARS_MAX - 1).join('')}…`;
  };
  const kept = lines.slice(0, HEADER_FILTERS_MAX).map(clip);
  if (lines.length > HEADER_FILTERS_MAX) kept[HEADER_FILTERS_MAX - 1] = '…';
  return kept;
}

/** Builds the PDF of the run's rows into `output.part`; the counts and the size the run records. */
export async function writePdf(run: ExportRun, state: WriteState): Promise<FinishState> {
  const columns = runColumns(run);
  const { entries } = await readEntries(workFile(run, 'rows.ndjson'), 0, state.ndjsonBytes, Number.MAX_SAFE_INTEGER);
  // Money (major units) in the language's grouping, up to two decimals.
  const money = new Intl.NumberFormat(localeTag(run.locale), { maximumFractionDigits: 2, useGrouping: true });
  const cells = (row: readonly ReportCell[]): PdfCell[] => row.map((cell, k) => (typeof cell === 'number' && columns[k]?.type === 'money' ? money.format(cell) : cell));

  const title = t(run.locale, run.def.titleKey as MessageKey);
  const filters = headerFilters(await describeParams(run.def, run.stored.def, run.report));
  const printed = dateInWords(run.locale, localDate(run.report.tz, run.job.now()));
  const layout = new PdfLayout({
    paper: run.stored.pdf?.paper ?? 'A4',
    orientation: run.def.orientation,
    title,
    header: { left: `${run.libraryName} · ${title}`, ...(filters.length === 0 ? {} : { right: filters.join('\n') }) },
    footer: (page, pages) => t(run.locale, 'report.footer', { date: printed, name: run.staffName, page, pages }),
    nonLatinNote: t(run.locale, 'report.non_latin_note'),
  });
  const tableColumns: PdfTableColumn[] = columns.map((c) => ({
    header: t(run.locale, c.labelKey as MessageKey),
    weight: c.widthChars ?? WEIGHTS[c.type],
    align: NUMBER_TYPES.has(c.type) ? 'right' : 'left',
  }));
  layout.table(
    tableColumns,
    entries.map((e) => cells(e.cells)),
  );
  const bytes = layout.toBytes();
  await writeBytesAtomic(workFile(run, 'output.part'), bytes);
  return { rows: state.rows, nonLatinRows: layout.nonLatinRows, size: bytes.byteLength, warnings: [] };
}
