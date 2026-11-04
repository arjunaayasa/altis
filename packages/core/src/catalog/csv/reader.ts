// The CSV reader of the catalog imports (Phase 2 spec §5.2, decision P2-15, Review Focus 1, S9). Input is an untrusted
// file, pushed in byte chunks of any size; rows come out with their byte offsets, so a sliced import resumes exactly.
//
// - RFC 4180: cells separated by `,` or `;`, rows ended by CRLF, LF or a lone CR (old Mac Excel). A cell that starts
//   with `"` is quoted: `""` is a quote, and a separator or a line break inside stays in the cell. Lenient where Excel
//   is: a `"` inside an unquoted cell is a character, and text after a closing quote is appended to the cell.
// - A UTF-8 byte order mark at the start is skipped. A line holding no byte at all is not a row, but it keeps its
//   number: `line` counts the rows a spreadsheet shows (a line break inside quotes does not start a new one).
// - The separator is the one appearing more often outside quotes in the first line (`,` on a tie or when neither
//   appears), unless the caller names one.
// - Encoding (P2-15): when the first 64 KiB of the file is valid UTF-8 the file is UTF-8, and a later byte that is not
//   is read as U+FFFD with the row warning `invalid_bytes`. Otherwise the whole file is Windows-1252 (Excel's "CSV" on
//   an Indonesian or English Windows PC) with the file warning `encoding_cp1252`; its five undefined bytes are U+FFFD
//   with `invalid_bytes`. Mojibake is never stored silently: the import reports both warnings. (UTF-16 never gets
//   here: the `catalog.import` upload refuses a file holding NUL bytes.)
// - Bounded (S9): a row that passes CSV_ROW_MAX_BYTES (typically a quote never closed) becomes a row with no cells and
//   the error `row_too_long`. The reader drops what it holds for it, leaves the quoted state, and resumes after the
//   next line break (the error row ends there, so a resume from it is right). A quote still open at the end of the
//   file is the error `unclosed_quote`, never a cell that swallowed the rest of the file. Between calls the reader
//   keeps at most the 64 KiB sniff window and one row (≤ 1 MiB).
// - Rows come out once the format is known: at once for a file that is not UTF-8, after 64 KiB (or end()) otherwise.
// - Resume: the state after a row is `{byteOffset: row.endOffset, line: row.line, separator, encoding}` (state() gives
//   it for the last row returned). A reader created with `resume` reads the bytes from `byteOffset` on with that format
//   and numbers the next row `line + 1`.
// Pure; no I/O.

/** A row whose bytes pass this length is `row_too_long` (S9). */
export const CSV_ROW_MAX_BYTES = 1_048_576;

/** The bytes the encoding and the separator are detected from (P2-15). */
const SNIFF_BYTES = 65_536;

export type CsvSeparator = ',' | ';';
export type CsvEncoding = 'utf-8' | 'cp1252';

/** One row of the file. */
export interface CsvRow {
  /** The row's number in the file, 1-based, as a spreadsheet shows it (blank lines count, quoted line breaks do not). */
  line: number;
  /** The byte offset just after the row and its line break: where the next row starts. */
  endOffset: number;
  /** The cells, decoded; empty with an `error`. */
  cells: string[];
  /** The row could not be read: longer than CSV_ROW_MAX_BYTES, or a quote still open at the end of the file. */
  error?: 'row_too_long' | 'unclosed_quote';
  /** Bytes that are not valid in the file's encoding were read as U+FFFD. */
  warning?: 'invalid_bytes';
}

/** The format of the file, as detected (or as resumed). */
export interface CsvInfo {
  separator: CsvSeparator;
  encoding: CsvEncoding;
  /** The file starts with a UTF-8 byte order mark (false for a resumed reader, which never sees the start). */
  bom: boolean;
  warnings: 'encoding_cp1252'[];
}

/** Where to resume: the offset after the last row taken, the rows taken so far (its `line`), and the format. */
export interface CsvReaderState {
  byteOffset: number;
  line: number;
  separator: CsvSeparator;
  encoding: CsvEncoding;
}

export interface CsvReader {
  /** The rows ended by `bytes` (a copy is kept of what is still needed). */
  push(bytes: Uint8Array): CsvRow[];
  /** The rows left at the end of the file. */
  end(): CsvRow[];
  /** The detected format. @throws Error before it is known (before the first row comes out, or end()). */
  info(): CsvInfo;
  /** The resume state after the last row returned. @throws Error before the format is known. */
  state(): CsvReaderState;
  /** The bytes the reader holds between calls: the sniff window, the unfinished row. */
  held(): number;
}

const QUOTE = 0x22;
const COMMA = 0x2c;
const SEMICOLON = 0x3b;
const CR = 0x0d;
const LF = 0x0a;
const BOM = [0xef, 0xbb, 0xbf] as const;

// Parser modes.
const M_START = 0; // at the start of a cell
const M_PLAIN = 1; // in an unquoted cell
const M_QUOTED = 2; // in a quoted cell
const M_CLOSED = 3; // just after a `"` in a quoted cell: a doubled quote, or the closing one
const M_AFTER_CR = 4; // a row ended by CR: an LF may follow
const M_SKIP = 5; // a row too long: skipping to the next line break
const M_SKIP_CR = 6; // skipping, after a CR

/** Windows-1252 0x80-0x9F; 0xFFFD for the five bytes it leaves undefined (0x81, 0x8D, 0x8F, 0x90, 0x9D). */
const CP1252_HIGH: readonly number[] = [
  0x20ac, 0xfffd, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0xfffd, 0x017d, 0xfffd,
  0xfffd, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0xfffd, 0x017e, 0x0178,
];

const utf8Fatal = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const utf8Lenient = new TextDecoder('utf-8', { ignoreBOM: true });

/** `bytes` as UTF-8; `bad` when an invalid sequence was read as U+FFFD. */
function decodeUtf8(bytes: Uint8Array): { text: string; bad: boolean } {
  try {
    return { text: utf8Fatal.decode(bytes), bad: false };
  } catch {
    return { text: utf8Lenient.decode(bytes), bad: true };
  }
}

/** `bytes` as Windows-1252; `bad` when one of its undefined bytes was read as U+FFFD. */
function decodeCp1252(bytes: Uint8Array): { text: string; bad: boolean } {
  let text = '';
  let bad = false;
  const units: number[] = [];
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    let unit = b;
    if (b >= 0x80 && b <= 0x9f) {
      unit = CP1252_HIGH[b - 0x80]!;
      if (unit === 0xfffd) bad = true;
    }
    units.push(unit);
    if (units.length === 4096) {
      text += String.fromCharCode(...units);
      units.length = 0;
    }
  }
  if (units.length > 0) text += String.fromCharCode(...units);
  return { text, bad };
}

/** The parts joined into one array. */
function concatBytes(parts: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** The first bytes of a fresh reader, held until the format is known. */
class Sniffer {
  readonly chunks: Uint8Array[] = [];
  length = 0;
  /** An invalid UTF-8 sequence was seen in the window. */
  invalid = false;
  private readonly decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  // The separator count over the first line (outside quotes), found incrementally with the parser's quoting: a `"`
  // opens a quoted cell only at the start of a cell (or doubles one after a closing quote); elsewhere it is a
  // character. Both separators end a cell, the one to use being unknown yet.
  private sepDone = false;
  private started = false;
  /** Bytes of a leading BOM skipped so far; -1 once past the start of the file. */
  private bomAt = 0;
  private cell: 'start' | 'plain' | 'quoted' | 'closed' = 'start';
  private commas = 0;
  private semicolons = 0;

  add(bytes: Uint8Array): void {
    const copy = bytes.slice();
    const inWindow = copy.subarray(0, Math.max(0, Math.min(copy.length, SNIFF_BYTES - this.length)));
    this.chunks.push(copy);
    this.length += copy.length;
    if (!this.invalid && inWindow.length > 0) {
      try {
        this.decoder.decode(inWindow, { stream: true });
      } catch {
        this.invalid = true;
      }
    }
    if (!this.sepDone) this.countSeparators(inWindow);
  }

  private countSeparators(bytes: Uint8Array): void {
    for (let i = 0; i < bytes.length && !this.sepDone; i++) {
      const b = bytes[i]!;
      if (this.bomAt >= 0) {
        if (this.bomAt < BOM.length && b === BOM[this.bomAt]) {
          this.bomAt++; // the parser skips the BOM: the cell starts after it
          continue;
        }
        this.bomAt = -1;
      }
      if (!this.started) {
        if (b === CR || b === LF) continue; // blank lines before the header
        this.started = true;
      }
      if (this.cell === 'quoted') {
        if (b === QUOTE) this.cell = 'closed';
      } else if (b === COMMA || b === SEMICOLON) {
        if (b === COMMA) this.commas++;
        else this.semicolons++;
        this.cell = 'start';
      } else if (b === CR || b === LF) this.sepDone = true;
      else if (b === QUOTE && this.cell !== 'plain') this.cell = 'quoted';
      else this.cell = 'plain';
    }
  }

  /** The encoding, or null while it is not known yet. */
  encoding(eof: boolean): CsvEncoding | null {
    if (this.invalid) return 'cp1252';
    if (this.length >= SNIFF_BYTES) return 'utf-8';
    if (!eof) return null;
    try {
      this.decoder.decode(); // a sequence cut by the end of the file is invalid
      return 'utf-8';
    } catch {
      this.invalid = true;
      return 'cp1252';
    }
  }

  /** Whether the file starts with a BOM, or null while too few bytes have come. */
  bom(eof: boolean): boolean | null {
    const head: number[] = [];
    for (const c of this.chunks) {
      for (let i = 0; i < c.length && head.length < 3; i++) head.push(c[i]!);
      if (head.length === 3) break;
    }
    for (let i = 0; i < head.length; i++) if (head[i] !== BOM[i]) return false;
    if (head.length === 3) return true;
    return eof ? false : null;
  }

  /** The separator of the first line, or null while the line is not complete. */
  separator(eof: boolean): CsvSeparator | null {
    if (!this.sepDone && !eof && this.length < SNIFF_BYTES) return null;
    return this.semicolons > this.commas ? ';' : ',';
  }
}

class Reader implements CsvReader {
  private sniffer: Sniffer | null;
  private readonly forcedSeparator: CsvSeparator | undefined;
  private format: { separator: CsvSeparator; sep: number; encoding: CsvEncoding; bom: boolean } | null = null;
  private ended = false;

  /** The absolute offset of the next byte to parse. */
  private offset = 0;
  /** The rows (blank lines included) consumed so far: the last row's `line`. */
  private line = 0;
  /** The state after the last row returned. */
  private committed = { byteOffset: 0, line: 0 };

  private mode = M_START;
  /** The absolute offset of the unfinished row's first byte. */
  private rowStart = 0;
  /** In M_AFTER_CR: the row ended by the CR held no byte. */
  private blankBeforeCr = false;
  private cells: string[] = [];
  private cellsHeld = 0;
  private rowBad = false;
  private cell = new Uint8Array(4096);
  private cellLen = 0;

  constructor(o: { separator?: CsvSeparator; resume?: CsvReaderState }) {
    this.forcedSeparator = o.separator;
    if (o.resume) {
      const r = o.resume;
      this.sniffer = null;
      this.setFormat(r.separator, r.encoding, false);
      this.offset = r.byteOffset;
      this.rowStart = r.byteOffset;
      this.line = r.line;
      this.committed = { byteOffset: r.byteOffset, line: r.line };
    } else {
      this.sniffer = new Sniffer();
    }
  }

  private setFormat(separator: CsvSeparator, encoding: CsvEncoding, bom: boolean): void {
    this.format = { separator, sep: separator === ';' ? SEMICOLON : COMMA, encoding, bom };
  }

  push(bytes: Uint8Array): CsvRow[] {
    if (this.ended) throw new Error('CSV reader: push() after end()');
    const out: CsvRow[] = [];
    if (this.sniffer === null) {
      this.parse(bytes, out);
      return out;
    }
    this.sniffer.add(bytes);
    this.startWhenKnown(false, out);
    return out;
  }

  end(): CsvRow[] {
    if (this.ended) return [];
    const out: CsvRow[] = [];
    if (this.sniffer !== null) this.startWhenKnown(true, out);
    this.ended = true;
    this.finish(out);
    return out;
  }

  info(): CsvInfo {
    const f = this.known();
    return { separator: f.separator, encoding: f.encoding, bom: f.bom, warnings: f.encoding === 'cp1252' ? ['encoding_cp1252'] : [] };
  }

  state(): CsvReaderState {
    const f = this.known();
    return { byteOffset: this.committed.byteOffset, line: this.committed.line, separator: f.separator, encoding: f.encoding };
  }

  held(): number {
    return (this.sniffer?.length ?? 0) + this.cellLen + this.cellsHeld;
  }

  private known(): NonNullable<Reader['format']> {
    if (this.format === null) throw new Error('CSV reader: the format is not known yet (before the first row or end())');
    return this.format;
  }

  /** Once the sniffed bytes tell the format, sets it and parses them. */
  private startWhenKnown(eof: boolean, out: CsvRow[]): void {
    const s = this.sniffer!;
    const encoding = s.encoding(eof);
    const bom = s.bom(eof);
    const separator = this.forcedSeparator ?? s.separator(eof);
    if (encoding === null || bom === null || separator === null) return;
    this.setFormat(separator, encoding, bom);
    this.sniffer = null;
    const all = concatBytes(s.chunks, s.length);
    const start = bom ? 3 : 0;
    this.offset = start;
    this.rowStart = start;
    this.committed = { byteOffset: start, line: 0 };
    this.parse(all.subarray(start), out);
  }

  // ---- the parser -----------------------------------------------------------------------------------------------

  private append(bytes: Uint8Array, from: number, to: number): void {
    const n = to - from;
    if (n <= 0) return;
    const need = this.cellLen + n;
    if (need > this.cell.length) {
      let size = this.cell.length;
      while (size < need) size *= 2;
      const grown = new Uint8Array(size);
      grown.set(this.cell.subarray(0, this.cellLen));
      this.cell = grown;
    }
    this.cell.set(bytes.subarray(from, to), this.cellLen);
    this.cellLen = need;
  }

  private endCell(): void {
    const bytes = this.cell.subarray(0, this.cellLen);
    const { text, bad } = this.format!.encoding === 'utf-8' ? decodeUtf8(bytes) : decodeCp1252(bytes);
    if (bad) this.rowBad = true;
    this.cells.push(text);
    this.cellsHeld += this.cellLen;
    this.cellLen = 0;
  }

  /** Forgets the unfinished row, and gives back the memory a long one took. */
  private dropRow(): void {
    this.cells = [];
    this.cellsHeld = 0;
    this.cellLen = 0;
    this.rowBad = false;
    if (this.cell.length > SNIFF_BYTES) this.cell = new Uint8Array(4096);
  }

  /** Ends the row at `end` (the offset after its line break); a row of no byte is a blank line, counted only. */
  private emit(out: CsvRow[], end: number, blank: boolean, error?: CsvRow['error']): void {
    this.line++;
    if (!blank) {
      const row: CsvRow = error ? { line: this.line, endOffset: end, cells: [], error } : { line: this.line, endOffset: end, cells: this.cells };
      if (!error && this.rowBad) row.warning = 'invalid_bytes';
      out.push(row);
      this.committed = { byteOffset: end, line: this.line };
    }
    this.dropRow();
    this.rowStart = end;
    this.mode = M_START;
  }

  /** The row passed CSV_ROW_MAX_BYTES: drop it and skip to the next line break. */
  private tooLong(): void {
    this.dropRow();
    this.mode = M_SKIP;
  }

  private parse(bytes: Uint8Array, out: CsvRow[]): void {
    const sep = this.format!.sep;
    const base = this.offset; // the absolute offset of bytes[0]
    const n = bytes.length;
    let i = 0;
    while (i < n) {
      // The index of the first byte that would make the unfinished row too long.
      const capAt = this.rowStart + CSV_ROW_MAX_BYTES - base;
      const b = bytes[i]!;
      switch (this.mode) {
        case M_START:
        case M_PLAIN:
        case M_CLOSED: {
          if (b === LF || b === CR) {
            const blank = this.mode === M_START && base + i === this.rowStart;
            if (!blank) this.endCell();
            if (b === LF) this.emit(out, base + i + 1, blank);
            else {
              this.blankBeforeCr = blank;
              this.mode = M_AFTER_CR;
            }
            i++;
            break;
          }
          if (i >= capAt) {
            this.tooLong();
            break;
          }
          if (b === sep) {
            this.endCell();
            this.mode = M_START;
            i++;
          } else if (b === QUOTE && this.mode === M_START) {
            this.mode = M_QUOTED;
            i++;
          } else if (b === QUOTE && this.mode === M_CLOSED) {
            this.append(bytes, i, i + 1); // `""` inside quotes
            this.mode = M_QUOTED;
            i++;
          } else {
            // Plain bytes up to the next separator or line break, within the cap.
            let j = i + 1;
            const stop = Math.min(n, capAt);
            while (j < stop) {
              const c = bytes[j]!;
              if (c === sep || c === CR || c === LF) break;
              j++;
            }
            this.append(bytes, i, j);
            this.mode = M_PLAIN;
            i = j;
          }
          break;
        }
        case M_QUOTED: {
          let j = bytes.indexOf(QUOTE, i);
          if (j < 0) j = n;
          if (j > capAt) {
            this.tooLong();
            i = Math.max(i, capAt);
            break;
          }
          this.append(bytes, i, j);
          if (j < n) this.mode = M_CLOSED;
          i = j < n ? j + 1 : n;
          if (j < n && j >= capAt) this.tooLong(); // the closing quote itself is past the cap
          break;
        }
        case M_AFTER_CR: {
          if (b === LF) {
            this.emit(out, base + i + 1, this.blankBeforeCr);
            i++;
          } else this.emit(out, base + i, this.blankBeforeCr); // a lone CR; this byte starts the next row
          break;
        }
        case M_SKIP: {
          let j = i;
          while (j < n && bytes[j] !== LF && bytes[j] !== CR) j++;
          if (j === n) {
            i = n;
            break;
          }
          if (bytes[j] === LF) this.emit(out, base + j + 1, false, 'row_too_long');
          else this.mode = M_SKIP_CR;
          i = j + 1;
          break;
        }
        case M_SKIP_CR: {
          if (b === LF) {
            this.emit(out, base + i + 1, false, 'row_too_long');
            i++;
          } else this.emit(out, base + i, false, 'row_too_long');
          break;
        }
      }
    }
    this.offset = base + n;
  }

  /** The end of the file: the unfinished row, if any. */
  private finish(out: CsvRow[]): void {
    const end = this.offset;
    switch (this.mode) {
      case M_START:
        if (end > this.rowStart) {
          this.endCell();
          this.emit(out, end, false);
        }
        break;
      case M_PLAIN:
      case M_CLOSED:
        this.endCell();
        this.emit(out, end, false);
        break;
      case M_QUOTED:
        this.emit(out, end, false, 'unclosed_quote');
        break;
      case M_AFTER_CR:
        this.emit(out, end, this.blankBeforeCr);
        break;
      case M_SKIP:
      case M_SKIP_CR:
        this.emit(out, end, false, 'row_too_long');
        break;
    }
  }
}

/**
 * A CSV reader (see the top of this file). `separator` forces the separator of a fresh reader; `resume` continues a
 * file from a {@link CsvReaderState} with its format, the caller pushing the bytes from `resume.byteOffset` on.
 */
export function createCsvReader(o: { separator?: CsvSeparator; resume?: CsvReaderState } = {}): CsvReader {
  return new Reader(o);
}
