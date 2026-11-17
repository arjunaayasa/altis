/**
 * The member import's look at a file before anything is sent: the browser reads its head so the mapping step can show
 * what the server will make of it. The server stays the judge (it reads the whole file again); these rules follow it:
 *
 * - The encoding is UTF-8 when the bytes are valid UTF-8, else Windows-1252 (Excel's "CSV" on an Indonesian PC); a
 *   UTF-8 byte order mark is dropped.
 * - The separator is the one appearing more often outside quotes in the first line, `,` on a tie.
 * - A cell starting with `"` is quoted: `""` is a quote, and a separator or a line break inside stays in the cell.
 * - The first row is the header; column names are matched without regard to case, an empty header cell is ignored, an
 *   unknown or repeated column refuses the file, and `member_no`, `name` and `member_type` are required.
 * - Rows whose cells are all empty are not counted.
 */

/** The columns of the `csv-members` format, in the template's order. */
export const MEMBER_CSV_COLUMNS = Object.freeze([
  'member_no',
  'name',
  'member_type',
  'class_name',
  'identity_no',
  'gender',
  'birth_date',
  'email',
  'phone',
  'address',
  'postal_code',
  'mailing_address',
  'institution',
  'joined_on',
  'expires_on',
  'home_branch',
  'notes',
  'locale',
] as const);

export type MemberCsvColumn = (typeof MEMBER_CSV_COLUMNS)[number];

const REQUIRED: readonly MemberCsvColumn[] = ['member_no', 'name', 'member_type'];

export interface CsvHead {
  encoding: 'utf-8' | 'windows-1252';
  separator: ',' | ';';
  /** The header row's cells, trimmed. */
  header: string[];
  /** The first data rows (`sampleRows`), their cells as written (unquoted). */
  rows: string[][];
  /** The line number of each of `rows` in the file (the header is line 1). */
  lines: number[];
  /** The data rows with at least one cell that is not empty. */
  total: number;
}

/** The file's text and the encoding it was read with. */
export function decodeCsv(bytes: Uint8Array): { text: string; encoding: CsvHead['encoding'] } {
  let text: string;
  let encoding: CsvHead['encoding'] = 'utf-8';
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    text = new TextDecoder('windows-1252').decode(bytes);
    encoding = 'windows-1252';
  }
  return { text: text.startsWith('﻿') ? text.slice(1) : text, encoding };
}

/** The separator of the first line: the one appearing more often outside quotes, `,` on a tie. */
function separatorOf(text: string): ',' | ';' {
  let quoted = false;
  let commas = 0;
  let semicolons = 0;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === '\n' || ch === '\r')) break;
    else if (!quoted && ch === ',') commas += 1;
    else if (!quoted && ch === ';') semicolons += 1;
  }
  return semicolons > commas ? ';' : ',';
}

/** The rows of a CSV text with their first line numbers. Throws on a quote that is never closed. */
function parseCsv(text: string, sep: string): { cells: string[]; line: number }[] {
  const out: { cells: string[]; line: number }[] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let atStart = true;
  let line = 1;
  let rowLine = 1;
  const endCell = (): void => {
    cells.push(cell);
    cell = '';
    atStart = true;
  };
  const endRow = (): void => {
    endCell();
    out.push({ cells, line: rowLine });
    cells = [];
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else {
        if (ch === '\n') line += 1;
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && atStart) {
      quoted = true;
      atStart = false;
    } else if (ch === sep) endCell();
    else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      endRow();
      line += 1;
      rowLine = line;
    } else {
      cell += ch;
      atStart = false;
    }
  }
  if (quoted) throw new Error('unclosed quote');
  if (cell !== '' || cells.length > 0) endRow();
  return out;
}

/** The head of a member CSV (see the top of this file). Throws when the file is empty or cannot be read. */
export function readCsvHead(bytes: Uint8Array, sampleRows = 5): CsvHead {
  const { text, encoding } = decodeCsv(bytes);
  const separator = separatorOf(text);
  const records = parseCsv(text, separator);
  const first = records[0];
  if (first === undefined || first.cells.every((c) => c.trim() === '')) throw new Error('empty');
  const data = records.slice(1).filter((r) => r.cells.some((c) => c.trim() !== ''));
  return {
    encoding,
    separator,
    header: first.cells.map((c) => c.trim()),
    rows: data.slice(0, sampleRows).map((r) => r.cells),
    lines: data.slice(0, sampleRows).map((r) => r.line),
    total: data.length,
  };
}

/** What each header cell fills, and why the file would be refused: the required columns missing, unknown or repeated ones. */
export function checkMemberCsvHeader(header: readonly string[]): {
  columns: (MemberCsvColumn | 'unknown' | 'duplicate' | null)[];
  missing: MemberCsvColumn[];
  unknown: string[];
  duplicate: string[];
  ok: boolean;
} {
  const seen = new Set<string>();
  const unknown: string[] = [];
  const duplicate: string[] = [];
  const columns = header.map((raw) => {
    const name = raw.trim().toLowerCase();
    if (name === '') return null;
    if (!(MEMBER_CSV_COLUMNS as readonly string[]).includes(name)) {
      unknown.push(raw.trim());
      return 'unknown' as const;
    }
    if (seen.has(name)) {
      duplicate.push(raw.trim());
      return 'duplicate' as const;
    }
    seen.add(name);
    return name as MemberCsvColumn;
  });
  const missing = REQUIRED.filter((c) => !seen.has(c));
  return { columns, missing, unknown, duplicate, ok: missing.length === 0 && unknown.length === 0 && duplicate.length === 0 };
}
