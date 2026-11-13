import type { DataPath } from '@altis/platform';
import { REPORT_XLSX_MAX_ROWS, type ReportColumnType } from '@altis/shared/api/reports';
import { z } from 'zod';
import { openZipWriter, zipWriterCheckpointSchema, type ZipWriter, type ZipWriterCheckpoint } from '../archive/zip-writer.js';
import type { ReportRow } from '../reports/types.js';
import { stripInvalidXmlChars, xmlAttr, xmlEscape } from '../xml/index.js';
import { formulaGuard } from './guard.js';

// The XLSX writer of the one exporter (spec §4.15 "CSV/XLSX", §7.4): a workbook of one sheet, written row batch by
// row batch across job slices, clean-room over the shared resumable ZIP writer.
//
//   [Content_Types].xml, _rels/.rels, xl/workbook.xml (the one sheet), xl/_rels/workbook.xml.rels, xl/styles.xml
//                  (font 0 normal, font 1 bold; cell format 0 normal, 1 bold): whole deflate entries, written at open
//   xl/worksheets/sheet1.xml
//                  the open deflate entry: written at open up to the header row (the header row frozen, the column
//                  widths, the header cells in bold), then one deflate segment per appendRows() call, and closed with
//                  the end of the sheet by finish()
//
// Cells: a `text` or `date` column's value is an inline string (`t="inlineStr"`) of the text with the characters XML
// forbids dropped and then the formula guard applied (a string cell is never evaluated, but a librarian who edits it
// would make it a formula); dates are `YYYY-MM-DD` text. An `int`, `money` or `percent` column's value is a number
// (`<v>`), as ALTIS computed it: these are never text someone typed. A number that is not finite, and null, leave the
// cell out; a text in a number column is written as text, under the guard. A text longer than the 32 767 characters a
// cell holds is cut there (the CSV export keeps it whole). Widths: `widthChars`, else by type (text 30, int 10, money
// 14, date 12, percent 8), never below the header's length + 2.

const SHEET_ENTRY = 'xl/worksheets/sheet1.xml';
const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CONTENT_TYPES_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';
const SHEET_TAIL = '</sheetData></worksheet>';
/** The widest column Excel accepts, in characters. */
const WIDTH_MAX = 255;
/** The most columns a sheet has (A … XFD). */
const COLUMNS_MAX = 16_384;
const SHEET_NAME_MAX = 31;
/** The most characters (UTF-16 units) a spreadsheet cell holds; a longer text opens as a damaged file. */
const CELL_TEXT_MAX = 32_767;

const DEFAULT_WIDTHS: Readonly<Record<ReportColumnType, number>> = { text: 30, int: 10, money: 14, date: 12, percent: 8 };
const NUMBER_TYPES: ReadonlySet<ReportColumnType> = new Set<ReportColumnType>(['int', 'money', 'percent']);
const COLUMN_TYPES: ReadonlySet<string> = new Set(Object.keys(DEFAULT_WIDTHS));

export interface XlsxColumn {
  header: string;
  type: ReportColumnType;
  /** The column's width in characters (default by type); never below the header's length + 2. */
  widthChars?: number;
}

/** Where an XLSX export goes on: the archive's checkpoint (inside the sheet entry) and the data rows written. */
export interface XlsxCheckpoint {
  zip: ZipWriterCheckpoint;
  rows: number;
}

export interface XlsxWriter {
  /**
   * Appends the rows (each in the order of the columns, at most as many cells as columns) as one deflate segment.
   *
   * @throws XlsxTooManyRowsError, before writing any of them, when the sheet would hold more than `maxRows` data rows;
   *   TypeError for a row that is not an array of cells or has more cells than columns; the ZIP writer's errors
   */
  appendRows(rows: readonly ReportRow[]): Promise<void>;
  /** The durable state, after fsync (a copy; JSON-safe). */
  checkpoint(): Promise<XlsxCheckpoint>;
  /** Closes the sheet and the archive; the file's size and the data rows written. */
  finish(): Promise<{ size: number; rows: number }>;
}

/** A sheet would get more data rows than an XLSX export holds. */
export class XlsxTooManyRowsError extends Error {
  /** The data rows the sheet would have had. */
  readonly rows: number;
  readonly max: number;

  constructor(rows: number, max: number) {
    super(`XLSX sheet limit reached: ${rows} rows, at most ${max}`);
    this.name = 'XlsxTooManyRowsError';
    this.rows = rows;
    this.max = max;
  }
}

/** The shape of an {@link XlsxCheckpoint} (strict), for a job payload that carries one. */
export const xlsxCheckpointSchema = z.strictObject({
  zip: zipWriterCheckpointSchema,
  rows: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});

/** The column letters of the 0-based column `i` (A, …, Z, AA, …). */
function columnLetters(i: number): string {
  let out = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
  return out;
}

/** A sheet name Excel accepts: without `[ ] : * ? / \` and control characters, no `'` at its ends, at most 31 UTF-16 units. */
function xlsxSheetName(name: string): string {
  const cleaned = stripInvalidXmlChars(name)
    .replace(/[[\]:*?/\\]|\p{Cc}/gu, '')
    .replace(/^'+|'+$/g, '');
  let out = '';
  for (const ch of cleaned) {
    if (out.length + ch.length > SHEET_NAME_MAX) break;
    out += ch;
  }
  out = out.replace(/'+$/, '');
  return out.trim() === '' ? 'Sheet1' : out;
}

/**
 * An inline-string cell: the text without the characters XML forbids, then under the formula guard, cut to the
 * 32 767 characters a spreadsheet cell holds (never inside a surrogate pair).
 */
function textCell(ref: string, text: string, style: string): string {
  let shown = formulaGuard(stripInvalidXmlChars(text));
  if (shown.length > CELL_TEXT_MAX) {
    const end = /[\ud800-\udbff]/.test(shown.charAt(CELL_TEXT_MAX - 1)) ? CELL_TEXT_MAX - 1 : CELL_TEXT_MAX;
    shown = shown.slice(0, end);
  }
  return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${xmlEscape(shown)}</t></is></c>`;
}

function cellXml(ref: string, type: ReportColumnType, value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '';
    return NUMBER_TYPES.has(type) ? `<c r="${ref}"><v>${String(value)}</v></c>` : textCell(ref, String(value), '');
  }
  if (typeof value === 'string') return textCell(ref, value, '');
  throw new TypeError(`XlsxWriter.appendRows: cell ${ref} is neither text, a number nor null`);
}

function checkedColumns(columns: unknown): XlsxColumn[] {
  if (!Array.isArray(columns) || columns.length === 0 || columns.length > COLUMNS_MAX) {
    throw new TypeError(`openXlsxWriter: columns must be 1 to ${COLUMNS_MAX} columns`);
  }
  return columns.map((c: unknown, i) => {
    const col = c as Partial<XlsxColumn> | null;
    if (typeof col !== 'object' || col === null || typeof col.header !== 'string' || typeof col.type !== 'string' || !COLUMN_TYPES.has(col.type)) {
      throw new TypeError(`openXlsxWriter: column ${i} needs a header and a type (text, int, money, date, percent)`);
    }
    if (col.widthChars !== undefined && (typeof col.widthChars !== 'number' || !Number.isFinite(col.widthChars) || col.widthChars <= 0)) {
      throw new TypeError(`openXlsxWriter: column ${i} has a width that is not a positive number`);
    }
    return { header: col.header, type: col.type, ...(col.widthChars === undefined ? {} : { widthChars: col.widthChars }) };
  });
}

function width(c: XlsxColumn): number {
  const header = [...stripInvalidXmlChars(c.header)].length + 2;
  return Math.min(WIDTH_MAX, Math.max(c.widthChars ?? DEFAULT_WIDTHS[c.type], header));
}

function contentTypes(): string {
  const sheet = 'application/vnd.openxmlformats-officedocument.spreadsheetml';
  return (
    `${XML_DECLARATION}<Types xmlns="${CONTENT_TYPES_NS}">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    `<Override PartName="/xl/workbook.xml" ContentType="${sheet}.sheet.main+xml"/>` +
    `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="${sheet}.worksheet+xml"/>` +
    `<Override PartName="/xl/styles.xml" ContentType="${sheet}.styles+xml"/>` +
    '</Types>'
  );
}

function packageRels(): string {
  return (
    `${XML_DECLARATION}<Relationships xmlns="${PACKAGE_REL_NS}">` +
    `<Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/>` +
    '</Relationships>'
  );
}

function workbook(sheetName: string): string {
  return (
    `${XML_DECLARATION}<workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}">` +
    '<bookViews><workbookView/></bookViews>' +
    `<sheets><sheet name="${xmlAttr(sheetName)}" sheetId="1" r:id="rId1"/></sheets>` +
    '</workbook>'
  );
}

function workbookRels(): string {
  return (
    `${XML_DECLARATION}<Relationships xmlns="${PACKAGE_REL_NS}">` +
    `<Relationship Id="rId1" Type="${REL_NS}/worksheet" Target="worksheets/sheet1.xml"/>` +
    `<Relationship Id="rId2" Type="${REL_NS}/styles" Target="styles.xml"/>` +
    '</Relationships>'
  );
}

function styles(): string {
  const font = '<sz val="11"/><name val="Calibri"/><family val="2"/>';
  return (
    `${XML_DECLARATION}<styleSheet xmlns="${MAIN_NS}">` +
    `<fonts count="2"><font>${font}</font><font><b/>${font}</font></fonts>` +
    '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>'
  );
}

/** The sheet up to and with the header row. */
function sheetHead(columns: readonly XlsxColumn[], letters: readonly string[]): string {
  const cols = columns.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${width(c)}" customWidth="1"/>`).join('');
  const header = columns.map((c, i) => textCell(`${letters[i]}1`, c.header, ' s="1"')).join('');
  return (
    `${XML_DECLARATION}<worksheet xmlns="${MAIN_NS}" xmlns:r="${REL_NS}">` +
    '<sheetViews><sheetView workbookViewId="0">' +
    '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
    '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/>' +
    '</sheetView></sheetViews>' +
    `<cols>${cols}</cols>` +
    `<sheetData><row r="1">${header}</row>`
  );
}

/**
 * Opens the XLSX file `path` (its central-directory sidecar is `central`) for writing: a new workbook (checkpoint null:
 * every part but the sheet, and the sheet up to its header row, are written at once) or the one `o.checkpoint`
 * describes. `columns` and `sheetName` are the same for every writer of one file.
 *
 * @throws TypeError for columns that are not 1 to 16 384 columns of a header and a known type, a `maxRows` that is not a
 *   positive integer, or a checkpoint that checkpoint() cannot have returned; the ZIP writer's errors
 */
export async function openXlsxWriter(
  path: DataPath,
  central: DataPath,
  o: { columns: readonly XlsxColumn[]; sheetName: string; checkpoint: XlsxCheckpoint | null; maxRows?: number },
): Promise<XlsxWriter> {
  const columns = checkedColumns(o?.columns);
  if (typeof o.sheetName !== 'string') throw new TypeError('openXlsxWriter: sheetName must be a string');
  const maxRows = o.maxRows ?? REPORT_XLSX_MAX_ROWS;
  if (!Number.isSafeInteger(maxRows) || maxRows < 1) throw new TypeError('openXlsxWriter: maxRows must be a positive integer');
  const letters = columns.map((_, i) => columnLetters(i));

  let zip: ZipWriter;
  let rows: number;
  if (o.checkpoint === null) {
    zip = await openZipWriter(path, central, { checkpoint: null });
    for (const [name, xml] of [
      ['[Content_Types].xml', contentTypes()],
      ['_rels/.rels', packageRels()],
      ['xl/workbook.xml', workbook(xlsxSheetName(o.sheetName))],
      ['xl/_rels/workbook.xml.rels', workbookRels()],
      ['xl/styles.xml', styles()],
    ] as const) {
      await zip.addEntry(name, Buffer.from(xml, 'utf8'), { method: 8 });
    }
    await zip.beginEntry(SHEET_ENTRY, { method: 8 });
    await zip.write(Buffer.from(sheetHead(columns, letters), 'utf8'));
    rows = 0;
  } else {
    const parsed = xlsxCheckpointSchema.safeParse(o.checkpoint);
    if (!parsed.success || parsed.data.zip.open?.name !== SHEET_ENTRY || parsed.data.zip.open.method !== 8 || parsed.data.rows > maxRows) {
      throw new TypeError('openXlsxWriter: the checkpoint is not one of an XLSX sheet in progress');
    }
    zip = await openZipWriter(path, central, { checkpoint: parsed.data.zip });
    rows = parsed.data.rows;
  }

  return {
    async appendRows(batch) {
      if (!Array.isArray(batch)) throw new TypeError('XlsxWriter.appendRows: rows must be an array');
      if (batch.length === 0) return;
      const total = rows + batch.length;
      if (total > maxRows) throw new XlsxTooManyRowsError(total, maxRows);
      let xml = '';
      for (const [i, row] of batch.entries()) {
        if (!Array.isArray(row) || row.length > columns.length) {
          throw new TypeError(`XlsxWriter.appendRows: row ${rows + i + 1} must be an array of at most ${columns.length} cells`);
        }
        const r = rows + i + 2; // the header is row 1
        let cells = '';
        for (const [c, value] of row.entries()) cells += cellXml(`${letters[c]}${r}`, columns[c]!.type, value);
        xml += `<row r="${r}">${cells}</row>`;
      }
      await zip.write(Buffer.from(xml, 'utf8'));
      rows = total;
    },
    async checkpoint() {
      return { zip: await zip.checkpoint(), rows };
    },
    async finish() {
      await zip.write(Buffer.from(SHEET_TAIL, 'utf8'));
      await zip.endEntry();
      const { size } = await zip.finish();
      return { size, rows };
    },
  };
}
