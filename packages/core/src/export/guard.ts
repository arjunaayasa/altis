// The formula guard of the one exporter (spec §7.4): the CSV and the XLSX writer pass every text cell through it, so
// that a value someone typed (a title, a name, an entity id) can never become a formula when a librarian opens the
// file in a spreadsheet, or edits the cell there. A text that starts with `=`, `+`, `-`, `@`, TAB or CR, or with the
// full-width `＝ ＋ － ＠` (U+FF1D, U+FF0B, U+FF0D, U+FF20, which spreadsheets fold to the ASCII forms), gets a `'` in
// front of it: the spreadsheet then shows the text as typed and never evaluates it. Pure.

/** The starts a spreadsheet reads as a formula: `= + - @`, TAB, CR, and the full-width `＝ ＋ － ＠`. */
const FORMULA_START = /^[=+\-@\t\r＝＋－＠]/;

/** `text`, with a `'` in front when it starts like a formula (see the module comment); any other text as it is. */
export function formulaGuard(text: string): string {
  return FORMULA_START.test(text) ? `'${text}` : text;
}
