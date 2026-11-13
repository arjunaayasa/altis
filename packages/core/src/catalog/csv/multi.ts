// The cells of the catalog's CSV formats (Phase 2 spec §5.2): multi-values joined with `|` (`\|` for a literal pipe),
// and the helpers the row codecs (records, items, SLiMS) share to read a cell into a draft field. Only splitMulti and
// joinMulti are in the barrel; the rest stays internal to this folder (M14).

import { TEXT_MAX_BYTES, utf8Length } from '@altis/shared/api/catalog/common';

/** A problem with one cell (or, with `column: ''`, with the row): the cell's field is left out of the result. */
export interface CsvFieldError {
  column: string;
  code: 'required' | 'too_big' | 'too_small' | 'invalid_format' | 'invalid_value' | 'invalid' | 'too_many_cells' | 'unknown_column' | 'duplicate_column';
}

/**
 * The values of a multi-value cell: split on `|`, where `\|` is a literal pipe (a backslash before anything else is
 * itself); each value trimmed, empty ones dropped. The same rule as `coerceCustomValues` reads a multiselect cell with.
 */
export function splitMulti(cell: string): string[] {
  const values: string[] = [];
  let current = '';
  for (let i = 0; i < cell.length; i++) {
    const c = cell[i];
    if (c === '\\' && cell[i + 1] === '|') {
      current += '|';
      i++;
    } else if (c === '|') {
      values.push(current);
      current = '';
    } else current += c;
  }
  values.push(current);
  return values.map((v) => v.trim()).filter((v) => v !== '');
}

/**
 * The cell of `values` (each trimmed by the reader): joined with `|`, a pipe inside a value written `\|`. A value that
 * ends in a backslash gets a space before the next `|`, so the backslash does not escape it (splitMulti trims it).
 */
export function joinMulti(values: readonly string[]): string {
  return values.map((v, i) => v.replace(/\|/g, '\\|') + (i < values.length - 1 && v.endsWith('\\') ? ' ' : '')).join('|');
}

// ---- reading a cell ------------------------------------------------------------------------------------------------

/** The starts csvCell guards with a `'` (`= + - @`, TAB, CR, and the full-width forms U+FF1D, U+FF0B, U+FF0D, U+FF20). */
const GUARDED_START = /^'[=+\-@\t\r\uff1d\uff0b\uff0d\uff20]/;

/**
 * The cell without the `'` csvCell puts before a formula start, so an ALTIS export reads back as it was written
 * (`'=1+1` → `=1+1`). A `'` before anything else is kept (`'Tis`).
 */
export function unguard(cell: string): string {
  return GUARDED_START.test(cell) ? cell.slice(1) : cell;
}

/** One line of text: control characters become spaces, whitespace is collapsed, the ends trimmed. */
export function oneLine(s: string): string {
  return s.replace(/\p{Cc}+/gu, ' ').replace(/\s+/gu, ' ').trim();
}

/** Multi-line text without the C0 controls a TEXT column refuses (all but TAB, LF and CR) nor DEL. */
export function multiLine(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

/** The ISBD separators a value may end with. */
const ISBD_END = new Set(['/', ':', ';', '=', ',']);

/**
 * The ISBD separators a value may end with (` /`, ` :`, ` ;`, ` =`, `,`) and the blanks around them, removed. A loop
 * from the end: a regex `[…]+$` retries a long run of them from each of its starts (quadratic on a 1 MiB cell).
 */
export function trimIsbd(s: string): string {
  let end = s.length;
  while (end > 0) {
    const ch = s[end - 1]!;
    if (!ISBD_END.has(ch) && ch.trim() !== '') break;
    end--;
  }
  return s.slice(0, end);
}

/** Collects the errors of one row, each column and code once (a 1 MiB cell past a list's cap reports it once). */
export class CellReader {
  readonly errors: CsvFieldError[] = [];
  private readonly seen = new Set<string>();

  /** Records an error; undefined, so a reader can `return this.error(…)` for the field it leaves out. */
  error(column: string, code: CsvFieldError['code']): undefined {
    const key = `${code} ${column}`;
    if (!this.seen.has(key)) {
      this.seen.add(key);
      this.errors.push({ column, code });
    }
    return undefined;
  }

  /** A one-line value of at most `max` UTF-16 units (a VARCHAR column; the contract's `.max()`), or undefined. */
  short(column: string, raw: string, max: number): string | undefined {
    const v = oneLine(raw);
    if (v === '') return undefined;
    if (v.length > max) return this.error(column, 'too_big');
    return v;
  }

  /** A one-line TEXT value (a title): at most 60 000 UTF-8 bytes, or undefined. */
  line(column: string, raw: string): string | undefined {
    const v = oneLine(raw);
    if (v === '') return undefined;
    if (utf8Length(v) > TEXT_MAX_BYTES) return this.error(column, 'too_big');
    return v;
  }

  /** A multi-line TEXT value (summary, notes), kept as written: at most 60 000 UTF-8 bytes, or undefined. */
  text(column: string, raw: string): string | undefined {
    const v = multiLine(raw);
    if (v.trim() === '') return undefined;
    if (utf8Length(v) > TEXT_MAX_BYTES) return this.error(column, 'too_big');
    return v;
  }

  /** A master's code (`codeField`: 1-32 printable ASCII characters), or undefined. */
  code(column: string, raw: string): string | undefined {
    const v = oneLine(raw);
    if (v === '') return undefined;
    if (!/^[\x20-\x7E]+$/.test(v)) return this.error(column, 'invalid_format');
    if (v.length > 32) return this.error(column, 'too_big');
    return v;
  }

  /** A calendar date `YYYY-MM-DD` (a time after it is dropped when `withTime`), or undefined. */
  date(column: string, raw: string, o: { withTime?: boolean; zero?: boolean } = {}): string | undefined {
    let v = oneLine(raw);
    if (v === '' || (o.zero && /^0000-00-00(?:[ T]00:00:00)?$/.test(v))) return undefined;
    if (o.withTime) v = v.replace(/^(\d{4}-\d{2}-\d{2})[ T]\d{2}:\d{2}(?::\d{2})?$/, '$1');
    if (!isCalendarDate(v)) return this.error(column, 'invalid_format');
    return v;
  }

  /**
   * A price as the API's decimal string (`125000.50`: ≤ 13 integer digits, ≤ 2 decimals). A decimal comma followed by
   * one or two digits is read as a point (`12500,5`, as Excel writes it on an Indonesian PC); a group separator never
   * is (`125,000` is refused, not read as 125).
   */
  price(column: string, raw: string): string | undefined {
    const v = oneLine(raw);
    if (v === '') return undefined;
    const m = /^(\d{1,13})(?:[.,](\d{1,2}))?$/.exec(v);
    if (!m) return this.error(column, 'invalid_format');
    return m[2] === undefined ? m[1] : `${m[1]}.${m[2]}`;
  }

  /** One of `values` written in any case, or undefined. */
  oneOf<T extends string>(column: string, raw: string, values: readonly T[]): T | undefined {
    const v = oneLine(raw).toLowerCase();
    if (v === '') return undefined;
    if (!(values as readonly string[]).includes(v)) return this.error(column, 'invalid_value');
    return v as T;
  }
}

/** True for a real calendar day written `YYYY-MM-DD`. */
function isCalendarDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m === null) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

/** The year cell of a record: a bare year, or the date as written with its first year (`c1998` → 1998). */
export function readYear(r: CellReader, column: string, raw: string): { publicationYear?: string; publicationDateText?: string } {
  const v = oneLine(raw);
  if (v === '') return {};
  if (/^\d{4}$/.test(v)) return { publicationYear: v };
  const year = /(?<!\d)\d{4}(?!\d)/.exec(v)?.[0];
  if (v.length > 64) {
    r.error(column, 'too_big');
    return {};
  }
  return year === undefined ? { publicationDateText: v } : { publicationYear: year, publicationDateText: v };
}

// ---- headers -------------------------------------------------------------------------------------------------------

/** The prefix of a custom-field column (`custom.<code>`). */
export const CUSTOM_PREFIX = 'custom.';

/** A custom-field code as a body carries it (`customValuesField`): printable ASCII, no blank at either end, ≤ 32. */
const CUSTOM_CODE_RE = /^[\x21-\x7E](?:[\x20-\x7E]*[\x21-\x7E])?$/;

/** Where each known column and each custom code stands in a header (the first of a repeated name). */
export interface HeaderIndex {
  known: Map<string, number>;
  custom: [code: string, index: number][];
  errors: CsvFieldError[];
}

/** The index of `header` over the column names `known` (matched trimmed, in any case); see {@link HeaderIndex}. */
export function indexHeader(header: readonly string[], known: readonly string[], required: string): HeaderIndex {
  const names = new Set(known);
  const index: HeaderIndex = { known: new Map(), custom: [], errors: [] };
  const seenCustom = new Set<string>();
  header.forEach((cell, i) => {
    const written = cell.trim();
    const name = written.toLowerCase();
    if (name.startsWith(CUSTOM_PREFIX)) {
      const code = written.slice(CUSTOM_PREFIX.length).trim();
      if (code.length > 32 || !CUSTOM_CODE_RE.test(code)) index.errors.push({ column: written, code: 'invalid_format' });
      else if (seenCustom.has(code)) index.errors.push({ column: written, code: 'duplicate_column' });
      else {
        seenCustom.add(code);
        index.custom.push([code, i]);
      }
    } else if (!names.has(name)) {
      if (written !== '') index.errors.push({ column: written, code: 'unknown_column' });
    } else if (index.known.has(name)) index.errors.push({ column: written, code: 'duplicate_column' });
    else index.known.set(name, i);
  });
  if (!index.known.has(required)) index.errors.push({ column: required, code: 'required' });
  return index;
}

/** {@link indexHeader}, once per header array (a file's rows share theirs). */
export function cachedHeaderIndex(cache: WeakMap<readonly string[], HeaderIndex>, header: readonly string[], known: readonly string[], required: string): HeaderIndex {
  let index = cache.get(header);
  if (index === undefined) {
    index = indexHeader(header, known, required);
    cache.set(header, index);
  }
  return index;
}

/** A non-empty cell past the header's last column: the row's cells are shifted (`too_many_cells`). */
export function hasExtraCells(cells: readonly string[], width: number): boolean {
  for (let i = width; i < cells.length; i++) if (cells[i]!.trim() !== '') return true;
  return false;
}

/** The custom values of a row: the non-empty `custom.<code>` cells as raw strings (S19), or undefined for none. */
export function customCells(index: HeaderIndex, cells: readonly string[]): Record<string, string> | undefined {
  // Entries, then Object.fromEntries: a `custom.__proto__` column stays an own key, never the prototype.
  const entries: [string, string][] = [];
  for (const [code, i] of index.custom) {
    const v = unguard(cells[i] ?? '');
    if (v.trim() !== '') entries.push([code, v]);
  }
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

/** The text of a stored custom value in a CSV cell: a multiselect joined, a boolean `1`/`0`, null empty. */
export function customValueText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return joinMulti(v.map((x) => String(x)));
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/**
 * `errors` in the order of the columns they name in `header` (left to right, as the file shows them); a row error
 * (`column: ''`) and a column the header lacks come first.
 */
export function inHeaderOrder(errors: CsvFieldError[], position: (column: string) => number): CsvFieldError[] {
  return errors
    .map((e, i) => ({ e, i, at: position(e.column) }))
    .sort((a, b) => a.at - b.at || a.i - b.i)
    .map((x) => x.e);
}
