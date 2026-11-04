// The one CSV exporter (spec §7.4 "Ekspor CSV/XLSX melalui satu eksportir"). Every export of the product writes its
// cells through csvCell, so that a value someone typed (a username, an entity id, a title) can never become a formula
// when a librarian opens the file in a spreadsheet (CSV injection):
//
// - every cell is quoted, an inner `"` doubled (RFC 4180), so a delimiter or a line break inside a value stays in it;
// - a cell whose text starts with `=`, `+`, `-`, `@`, TAB or CR, or with the full-width `＝ ＋ － ＠` (U+FF1D, U+FF0B,
//   U+FF0D, U+FF20, which spreadsheets fold to the ASCII forms), gets a `'` in front of it, inside the quotes: the
//   spreadsheet then shows the text as typed and never evaluates it;
// - `null`/`undefined` are an empty cell, an object or array its JSON text (which starts with `{` or `[`, never with a
//   formula character), anything else its string form, under the same prefix rule.
//
// A file starts with CSV_BOM: without it, Excel reads UTF-8 as the system code page (decision D28; Excel on
// Indonesian Windows also wants `;` as the delimiter, which csvRow takes).

/** The UTF-8 byte order mark (U+FEFF) a CSV file starts with. */
export const CSV_BOM = '﻿';

/** The starts a spreadsheet reads as a formula: `= + - @`, TAB, CR, and the full-width `＝ ＋ － ＠`. */
const FORMULA_START = /^[=+\-@\t\r＝＋－＠]/;

/** The text of a cell before quoting. */
function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') return JSON.stringify(v) ?? '';
  return String(v);
}

/**
 * One CSV cell: `v` as text (null/undefined empty, objects as JSON), prefixed with `'` when it starts like a formula,
 * then quoted with every `"` doubled.
 */
export function csvCell(v: unknown): string {
  let text = cellText(v);
  if (FORMULA_START.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

/** One CSV record: the cells of `values` (csvCell) joined by `delimiter`, ended by CRLF. */
export function csvRow(values: readonly unknown[], delimiter: ',' | ';'): string {
  return `${values.map(csvCell).join(delimiter)}\r\n`;
}
