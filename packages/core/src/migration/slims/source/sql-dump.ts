import { textCell } from './clean-text.js';
import type { SlimsRow } from './types.js';

// The streaming reader of a SQL dump (spec §11.1: the output of mysqldump or phpMyAdmin; clean-room, written from the
// MySQL statement syntax). It reads the two statements the migration needs and steps over every other one:
//
//   CREATE [OR REPLACE] [TEMPORARY] TABLE [IF NOT EXISTS] name (columns, keys) options   → 'create' (column order, PK)
//   ALTER TABLE name ADD PRIMARY KEY (...), ...                                          → 'primaryKey' (phpMyAdmin
//                                                                                          declares keys at the end)
//   INSERT|REPLACE [LOW_PRIORITY|DELAYED|HIGH_PRIORITY] [IGNORE] [INTO] name [PARTITION (...)] [(columns)]
//     VALUES|VALUE (...), (...) ;                                                         → 'insert', 500 rows a time
//
// Values: 'strings' and "strings" with MySQL's backslash escapes and doubled quotes, NULL, TRUE/FALSE, numbers, hex
// (0x41, X'41'), bits (b'101', 0b101) and character set introducers (_binary, _utf8mb4, ...). Comments: `-- `, `#`
// and /* ... */, the conditional /*!40101 ... */ included (their content is not run). `DELIMITER` blocks (triggers,
// routines) are stepped over whole.
//
// The input is the dump's BYTES, one character per byte (a Latin-1 decoding, `buffer.toString('latin1')`), so a push
// may end anywhere, inside a UTF-8 sequence too, and no byte is lost before a value is decoded: a string value whose
// bytes are valid UTF-8 comes out as text, any other as a Uint8Array (textCell; the stages decode those as
// Windows-1252, §11.5 step 3). `_binary` values and hex literals are always bytes. A safe integer is a number; any
// other number keeps its text (as a DECIMAL column reads from the database).
//
// Bounded (S9): a string or hex literal, an identifier, a comment or a statement that passes DUMP_LITERAL_MAX
// characters without ending throws DumpParseError `literal_too_long`, naming the table of the INSERT it is in; the
// parser holds at most one statement's pending rows (a batch of 500) and the literal being read, never the dump.
// mysqldump's statements are shorter than 16 MiB (its net buffer cannot be larger).

/** The longest literal, comment or statement accepted (S9): 16 MiB. */
export const DUMP_LITERAL_MAX = 16 * 1024 * 1024;
/** The rows of one INSERT are handed over in events of at most this many. */
export const DUMP_INSERT_BATCH = 500;

/** Why a dump is refused. */
export type DumpParseErrorCode =
  /** A literal, identifier, comment or statement passed DUMP_LITERAL_MAX without ending (S9). */
  | 'literal_too_long'
  /** The dump ends inside a literal, a comment or a row. */
  | 'truncated'
  /** A statement the parser reads is malformed (a value that is not a literal, a missing parenthesis, ...). */
  | 'syntax'
  /** A row has more or fewer values than the table has columns. */
  | 'column_count'
  /** A table's rows cannot be named: no CREATE TABLE and no column list (raised by splitDump). */
  | 'columns_unknown'
  /** More tables, or a longer table list, than a split's checkpoint can carry (raised by splitDump). */
  | 'too_many_tables'
  /** A `.sql.gz` that does not decompress (raised by splitDump). */
  | 'gzip_invalid';

/** A dump that cannot be read as it is: nothing is guessed, the caller refuses the dump and reports why. */
export class DumpParseError extends Error {
  readonly code: DumpParseErrorCode;
  /** The table of the INSERT (or CREATE) being read, null between statements. */
  readonly table: string | null;

  constructor(code: DumpParseErrorCode, o: { table: string | null }) {
    super(`SQL dump refused: ${code}${o.table === null ? '' : ` (table ${o.table})`}`);
    this.name = 'DumpParseError';
    this.code = code;
    this.table = o.table;
  }
}

/** What the parser reports. */
export type DumpEvent =
  | { type: 'create'; table: string; columns: string[]; primaryKey: string[] }
  | { type: 'primaryKey'; table: string; primaryKey: string[] }
  /** `columns` is the INSERT's own column list (null without one); the rows are keyed by the columns in effect. */
  | { type: 'insert'; table: string; columns: string[] | null; rows: SlimsRow[] };

/** With `marks`, the end of every statement: `offset` is the number of characters (bytes) read up to just after it. */
export interface DumpMark {
  type: 'end';
  offset: number;
}

export interface SqlDumpParser<E = DumpEvent> {
  /** Reads the next piece of the dump; the events of every statement (or batch of rows) it completed. */
  push(text: string): E[];
  /** The dump ended: the events still pending (a last statement without its `;`). */
  end(): E[];
}

export interface SqlDumpParserOptions {
  /**
   * The columns of tables whose CREATE TABLE this parser will not see (a resumed split starts after it). Rows of an
   * INSERT without a column list are keyed by these, or by the table's CREATE TABLE, or else by position (`'1'`...).
   */
  columns?: ReadonlyMap<string, readonly string[]>;
  /** Also report the end of each statement ({@link DumpMark}), for a caller that checkpoints between statements. */
  marks?: boolean;
}

// ---------------------------------------------------------------------------------------------------------------------
// Tokens

const T_WORD = 0; // a bare word: keyword, identifier, number, 0x hex
const T_IDENT = 1; // a `quoted` identifier
const T_STR = 2; // a string literal (its bytes, one character each); `prefix` x, b or n for X'', B'', N''
const T_PUNCT = 3; // one character of anything else

interface Token {
  kind: number;
  value: string;
  prefix: string | null;
}

const LEX_NONE = 0;
const LEX_WORD = 1;
const LEX_STR = 2;
const LEX_IDENT = 3;
const LEX_LINE_COMMENT = 4;
const LEX_BLOCK_COMMENT = 5;
const LEX_DELIMITER_LINE = 6; // the rest of a `DELIMITER x` line
const LEX_DELIMITER_BLOCK = 7; // lines up to `DELIMITER ;`

function isSpace(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x0b || c === 0x0c;
}

function isWordChar(c: number): boolean {
  return (c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || c === 0x5f || c === 0x24 || c >= 0x80;
}

/** MySQL's backslash escapes; any other escaped character stands for itself, `\%` and `\_` keep their backslash. */
function unescaped(c: number): string {
  switch (c) {
    case 0x30:
      return String.fromCharCode(0);
    case 0x62:
      return String.fromCharCode(8);
    case 0x6e:
      return '\n';
    case 0x72:
      return '\r';
    case 0x74:
      return '\t';
    case 0x5a:
      return String.fromCharCode(0x1a);
    case 0x25:
      return '\\%';
    case 0x5f:
      return '\\_';
    default:
      return String.fromCharCode(c);
  }
}

/** True when no character of `s` is above `max`. */
function allBelow(s: string, max: number): boolean {
  for (let i = 0; i < s.length; i += 1) if (s.charCodeAt(i) > max) return false;
  return true;
}
const INTEGER = /^\d+$/;
const NUMBER = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const EXPONENT_OPEN = /^\d+(?:\.\d*)?[eE]$/;
const HEX_WORD = /^0x([0-9a-fA-F]*)$/;
const BIT_WORD = /^0b([01]+)$/;
const HEX_DIGITS = /^[0-9a-fA-F]*$/;
const BITS = /^[01]*$/;

/** Bytes written as one character each (a Latin-1 string) as bytes. */
function latin1Bytes(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'latin1'));
}

/** An identifier's text (UTF-8, from its bytes). */
function identText(s: string): string {
  return allBelow(s, 0x7f) ? s : Buffer.from(s, 'latin1').toString('utf8');
}

/** The value of a string literal: text when its bytes are valid UTF-8, else the bytes. */
function textValue(s: string): string | Uint8Array {
  return allBelow(s, 0x7f) ? s : textCell(latin1Bytes(s));
}

function hexBytes(digits: string): Uint8Array {
  return new Uint8Array(Buffer.from(digits.length % 2 === 1 ? `0${digits}` : digits, 'hex'));
}

function bitsValue(bits: string): number | Uint8Array {
  if (bits.length <= 53) return bits === '' ? 0 : parseInt(bits, 2);
  const padded = bits.padStart(Math.ceil(bits.length / 8) * 8, '0');
  const out = new Uint8Array(padded.length / 8);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(padded.slice(i * 8, i * 8 + 8), 2);
  return out;
}

/** Sets `key` as an own enumerable property (also `__proto__`, which an assignment would take as the prototype). */
function setOwn(row: SlimsRow, key: string, value: SlimsRow[string]): void {
  if (key === '__proto__') Object.defineProperty(row, key, { value, enumerable: true, writable: true, configurable: true });
  else row[key] = value;
}

// ---------------------------------------------------------------------------------------------------------------------
// Statements

const ST_IDLE = 0;
const ST_SKIP = 1; // a statement the parser does not read: up to its `;`
const ST_COLLECT = 2; // CREATE or ALTER: its tokens up to the `;`
const ST_INSERT_HEAD = 3; // INSERT ... up to VALUES
const ST_VALUES = 4; // expecting `(`
const ST_TUPLE = 5; // inside `( ... )`
const ST_AFTER_TUPLE = 6; // expecting `,` or `;`

class Parser {
  private buf = '';
  /** The offset (in characters, bytes) of buf[0] in the dump. */
  private base = 0;
  private lex = LEX_NONE;
  /** The text of the word, literal, identifier or DELIMITER line being read, in pieces. */
  private parts: string[] = [];
  private partsLength = 0;
  private quote = 0;
  private escapePending = false;
  private quotePending = false;
  private prefix: string | null = null;
  private starPending = false;
  /** Where the comment being read began (its bound, S9). */
  private commentStart = 0;
  /** Where the current statement began; -1 between statements. */
  private statementStart = -1;

  private state = ST_IDLE;
  private collected: Token[] = [];
  private head: Token[] = [];
  private depth = 0;
  private table: string | null = null;
  private insertColumns: string[] | null = null;
  private rowKeys: readonly string[] | null = null;
  private values: SlimsRow[string][] = [];
  private expectValue = true;
  private sign: string | null = null;
  private introducer: string | null = null;
  private pending: SlimsRow[] = [];

  private readonly known = new Map<string, readonly string[]>();
  private out: (DumpEvent | DumpMark)[] = [];
  private failed = false;
  private ended = false;

  constructor(private readonly o: SqlDumpParserOptions) {
    for (const [table, columns] of o.columns ?? []) this.known.set(table, [...columns]);
  }

  push(text: string): (DumpEvent | DumpMark)[] {
    if (this.ended) throw new TypeError('SqlDumpParser.push: the parser has ended');
    if (this.failed) throw new TypeError('SqlDumpParser.push: the parser failed before');
    if (typeof text !== 'string' || !allBelow(text, 0xff)) {
      throw new TypeError('SqlDumpParser.push: the text must hold the dump bytes, one character per byte (Latin-1)');
    }
    return this.guarded(() => {
      this.buf += text;
      this.scan(false);
    });
  }

  end(): (DumpEvent | DumpMark)[] {
    if (this.ended) return [];
    if (this.failed) throw new TypeError('SqlDumpParser.end: the parser failed before');
    this.ended = true;
    return this.guarded(() => {
      this.scan(true);
      this.finish();
    });
  }

  private guarded(fn: () => void): (DumpEvent | DumpMark)[] {
    try {
      fn();
    } catch (error) {
      this.failed = true;
      throw error;
    }
    const out = this.out;
    this.out = [];
    return out;
  }

  private fail(code: DumpParseErrorCode): never {
    throw new DumpParseError(code, { table: this.table });
  }

  /** S9: the statement in progress may not pass DUMP_LITERAL_MAX characters. */
  private checkStatement(at: number): void {
    if (this.statementStart >= 0 && at - this.statementStart > DUMP_LITERAL_MAX) this.fail('literal_too_long');
  }

  private beginToken(at: number): void {
    if (this.statementStart < 0) this.statementStart = at;
  }

  private addPart(s: string, at: number): void {
    if (s.length === 0) return;
    this.parts.push(s);
    this.partsLength += s.length;
    if (this.partsLength > DUMP_LITERAL_MAX) this.fail('literal_too_long');
    this.checkStatement(at);
  }

  private takeParts(): string {
    const s = this.parts.length === 1 ? this.parts[0]! : this.parts.join('');
    this.parts = [];
    this.partsLength = 0;
    return s;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // The lexer: consumes `buf` as far as it can decide, keeping at most a short undecided tail.

  private scan(final: boolean): void {
    const buf = this.buf;
    const n = buf.length;
    let i = 0;
    scan: while (i < n) {
      switch (this.lex) {
        case LEX_NONE: {
          const c = buf.charCodeAt(i);
          if (isSpace(c)) {
            i += 1;
            continue;
          }
          if (c === 0x23) {
            this.startComment(LEX_LINE_COMMENT, i);
            i += 1;
            continue;
          }
          if (c === 0x2d) {
            if (i + 1 >= n && !final) break scan;
            if (i + 1 < n && buf.charCodeAt(i + 1) === 0x2d) {
              if (i + 2 >= n && !final) break scan;
              if (i + 2 >= n || buf.charCodeAt(i + 2) <= 0x20) {
                this.startComment(LEX_LINE_COMMENT, i);
                i += 2;
                continue;
              }
            }
            this.punct(c, i);
            i += 1;
            continue;
          }
          if (c === 0x2f) {
            if (i + 1 >= n && !final) break scan;
            if (i + 1 < n && buf.charCodeAt(i + 1) === 0x2a) {
              this.startComment(LEX_BLOCK_COMMENT, i);
              this.starPending = false;
              i += 2;
              continue;
            }
            this.punct(c, i);
            i += 1;
            continue;
          }
          if (c === 0x27 || c === 0x22) {
            this.beginToken(this.base + i);
            this.lex = LEX_STR;
            this.quote = c;
            this.prefix = null;
            i += 1;
            continue;
          }
          if (c === 0x60) {
            this.beginToken(this.base + i);
            this.lex = LEX_IDENT;
            i += 1;
            continue;
          }
          if (isWordChar(c)) {
            this.beginToken(this.base + i);
            this.lex = LEX_WORD;
            continue;
          }
          this.punct(c, i);
          i += 1;
          continue;
        }

        case LEX_WORD: {
          let j = i;
          while (j < n && isWordChar(buf.charCodeAt(j))) j += 1;
          this.addPart(buf.slice(i, j), this.base + j);
          i = j;
          if (j >= n) {
            if (!final) break scan;
            this.endWord(-1, i);
            continue;
          }
          const c = buf.charCodeAt(j);
          if (c === 0x2e || c === 0x2b || c === 0x2d) {
            const word = this.parts.join('');
            if ((c === 0x2e && INTEGER.test(word)) || (c !== 0x2e && EXPONENT_OPEN.test(word))) {
              this.addPart(buf[j]!, this.base + j + 1);
              i = j + 1;
              continue;
            }
          }
          this.endWord(c, i);
          if ((this.lex as number) === LEX_STR) i += 1; // X'..', B'..', N'..': the quote opened the literal
          continue;
        }

        case LEX_STR: {
          const q = this.quote;
          if (this.quotePending) {
            this.quotePending = false;
            if (buf.charCodeAt(i) === q) {
              this.addPart(String.fromCharCode(q), this.base + i + 1);
              i += 1;
              continue;
            }
            this.endString();
            continue;
          }
          if (this.escapePending) {
            this.escapePending = false;
            this.addPart(unescaped(buf.charCodeAt(i)), this.base + i + 1);
            i += 1;
            continue;
          }
          let j = i;
          for (; j < n; j += 1) {
            const c = buf.charCodeAt(j);
            if (c === q || c === 0x5c) break;
          }
          this.addPart(buf.slice(i, j), this.base + j);
          if (j >= n) {
            i = j;
            continue;
          }
          if (buf.charCodeAt(j) === 0x5c) {
            if (j + 1 < n) {
              this.addPart(unescaped(buf.charCodeAt(j + 1)), this.base + j + 2);
              i = j + 2;
            } else {
              this.escapePending = true;
              i = j + 1;
            }
            continue;
          }
          if (j + 1 < n) {
            if (buf.charCodeAt(j + 1) === q) {
              this.addPart(String.fromCharCode(q), this.base + j + 2);
              i = j + 2;
              continue;
            }
            i = j + 1;
            this.endString();
            continue;
          }
          i = j + 1;
          if (final) this.endString();
          else this.quotePending = true;
          continue;
        }

        case LEX_IDENT: {
          if (this.quotePending) {
            this.quotePending = false;
            if (buf.charCodeAt(i) === 0x60) {
              this.addPart('`', this.base + i + 1);
              i += 1;
              continue;
            }
            this.endIdent();
            continue;
          }
          const j = buf.indexOf('`', i);
          if (j < 0) {
            this.addPart(buf.slice(i), this.base + n);
            i = n;
            continue;
          }
          this.addPart(buf.slice(i, j), this.base + j);
          if (j + 1 < n) {
            if (buf.charCodeAt(j + 1) === 0x60) {
              this.addPart('`', this.base + j + 2);
              i = j + 2;
              continue;
            }
            i = j + 1;
            this.endIdent();
            continue;
          }
          i = j + 1;
          if (final) this.endIdent();
          else this.quotePending = true;
          continue;
        }

        case LEX_LINE_COMMENT: {
          const j = buf.indexOf('\n', i);
          if (j < 0) {
            i = n;
            this.checkComment(this.base + n);
            continue;
          }
          i = j + 1;
          this.lex = LEX_NONE;
          continue;
        }

        case LEX_BLOCK_COMMENT: {
          if (this.starPending) {
            this.starPending = false;
            if (buf.charCodeAt(i) === 0x2f) {
              i += 1;
              this.lex = LEX_NONE;
              continue;
            }
          }
          const j = buf.indexOf('*/', i);
          if (j < 0) {
            this.starPending = buf.charCodeAt(n - 1) === 0x2a;
            i = n;
            this.checkComment(this.base + n);
            continue;
          }
          i = j + 2;
          this.checkComment(this.base + i);
          this.lex = LEX_NONE;
          continue;
        }

        case LEX_DELIMITER_LINE:
        case LEX_DELIMITER_BLOCK: {
          const j = buf.indexOf('\n', i);
          const end = j < 0 ? n : j;
          this.addPart(buf.slice(i, end), this.base + end);
          if (j < 0) {
            i = n;
            continue;
          }
          i = j + 1;
          this.endDelimiterLine(this.base + i);
          continue;
        }

        default:
          throw new Error(`SqlDumpParser: unknown lexer state ${this.lex}`);
      }
    }
    if (this.statementStart >= 0) this.checkStatement(this.base + i);
    this.buf = buf.slice(i);
    this.base += i;
  }

  private startComment(lex: number, at: number): void {
    this.lex = lex;
    this.commentStart = this.base + at;
  }

  private checkComment(at: number): void {
    if (at - this.commentStart > DUMP_LITERAL_MAX) this.fail('literal_too_long');
    this.checkStatement(at);
  }

  /** The word ends before character `next` (-1: the dump ended); a quote right after x, b or n opens a literal. */
  private endWord(next: number, at: number): void {
    const word = this.takeParts();
    if (next === 0x27 && /^[xXbBnN]$/.test(word)) {
      this.lex = LEX_STR;
      this.quote = 0x27;
      this.prefix = word.toLowerCase();
      return;
    }
    this.lex = LEX_NONE;
    if (this.state === ST_IDLE && this.statementStart >= 0 && /^delimiter$/i.test(word)) {
      this.lex = LEX_DELIMITER_LINE;
      return;
    }
    this.token({ kind: T_WORD, value: word, prefix: null }, this.base + at);
  }

  private endString(): void {
    this.lex = LEX_NONE;
    const prefix = this.prefix;
    this.prefix = null;
    this.token({ kind: T_STR, value: this.takeParts(), prefix }, -1);
  }

  private endIdent(): void {
    this.lex = LEX_NONE;
    this.token({ kind: T_IDENT, value: identText(this.takeParts()), prefix: null }, -1);
  }

  private punct(c: number, i: number): void {
    this.beginToken(this.base + i);
    this.checkStatement(this.base + i + 1);
    this.token({ kind: T_PUNCT, value: String.fromCharCode(c), prefix: null }, this.base + i + 1);
  }

  /** A line of a DELIMITER statement or block ended at `at` (just after its line feed). */
  private endDelimiterLine(at: number): void {
    const line = this.takeParts().trim();
    if (this.lex === LEX_DELIMITER_LINE) {
      const delimiter = line.split(/\s+/)[0] ?? '';
      this.lex = delimiter === ';' || delimiter === '' ? LEX_NONE : LEX_DELIMITER_BLOCK;
      if (this.lex === LEX_NONE) this.endStatement(at);
      return;
    }
    if (/^delimiter\s+;$/i.test(line)) {
      this.lex = LEX_NONE;
      this.endStatement(at);
    }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // The statement machine: one token at a time. `end` is the offset just after a punctuation token (-1 for others).

  private token(t: Token, end: number): void {
    switch (this.state) {
      case ST_IDLE:
        this.startStatement(t, end);
        return;
      case ST_SKIP:
        if (t.kind === T_PUNCT && t.value === ';') this.endStatement(end);
        return;
      case ST_COLLECT:
        if (t.kind === T_PUNCT && t.value === ';') {
          this.readCollected();
          this.endStatement(end);
          return;
        }
        this.collected.push(t);
        return;
      case ST_INSERT_HEAD:
        this.insertHead(t, end);
        return;
      case ST_VALUES:
        if (t.kind === T_PUNCT && t.value === '(') {
          this.values = [];
          this.expectValue = true;
          this.state = ST_TUPLE;
          return;
        }
        this.fail('syntax');
        return;
      case ST_TUPLE:
        this.tupleToken(t);
        return;
      case ST_AFTER_TUPLE:
        if (t.kind === T_PUNCT && t.value === ',') {
          this.state = ST_VALUES;
          return;
        }
        this.flush();
        if (t.kind === T_PUNCT && t.value === ';') {
          this.endStatement(end);
          return;
        }
        this.state = ST_SKIP; // ON DUPLICATE KEY UPDATE ...
        return;
      default:
        throw new Error(`SqlDumpParser: unknown state ${this.state}`);
    }
  }

  private startStatement(t: Token, end: number): void {
    if (t.kind === T_PUNCT && t.value === ';') {
      this.endStatement(end);
      return;
    }
    const word = t.kind === T_WORD ? t.value.toUpperCase() : '';
    if (word === 'INSERT' || word === 'REPLACE') {
      this.state = ST_INSERT_HEAD;
      this.head = [];
      this.depth = 0;
      return;
    }
    if (word === 'CREATE' || word === 'ALTER') {
      this.state = ST_COLLECT;
      this.collected = [t];
      return;
    }
    this.state = ST_SKIP;
  }

  private endStatement(end: number): void {
    this.state = ST_IDLE;
    this.statementStart = -1;
    this.table = null;
    this.insertColumns = null;
    this.rowKeys = null;
    this.collected = [];
    this.head = [];
    if (this.o.marks === true && end >= 0) this.out.push({ type: 'end', offset: end });
  }

  private insertHead(t: Token, end: number): void {
    if (t.kind === T_PUNCT) {
      if (t.value === ';') {
        this.endStatement(end); // an INSERT without VALUES
        return;
      }
      if (t.value === '(') this.depth += 1;
      if (t.value === ')') this.depth -= 1;
    }
    if (t.kind === T_WORD && this.depth === 0) {
      const word = t.value.toUpperCase();
      if (word === 'VALUES' || word === 'VALUE') {
        this.readInsertHead();
        this.state = ST_VALUES;
        return;
      }
      if (word === 'SELECT' || word === 'SET' || word === 'TABLE' || word === 'WITH') {
        this.state = ST_SKIP; // INSERT ... SELECT / SET: not data the dump carries as rows
        return;
      }
    }
    this.head.push(t);
  }

  /** INSERT|REPLACE [modifiers] [INTO] name [PARTITION (...)] [(columns)] */
  private readInsertHead(): void {
    const h = this.head;
    let k = 0;
    while (k < h.length && h[k]!.kind === T_WORD && /^(LOW_PRIORITY|DELAYED|HIGH_PRIORITY|IGNORE|INTO)$/i.test(h[k]!.value)) k += 1;
    const name = readName(h, k);
    if (name === null) this.fail('syntax');
    this.table = name.name;
    k = name.next;
    if (k < h.length && h[k]!.kind === T_WORD && /^PARTITION$/i.test(h[k]!.value)) {
      const close = closingParen(h, k + 1);
      if (close < 0) this.fail('syntax');
      k = close + 1;
    }
    let columns: string[] | null = null;
    if (k < h.length && isPunct(h[k]!, '(')) {
      const close = closingParen(h, k);
      if (close < 0) this.fail('syntax');
      columns = [];
      for (let m = k + 1; m < close; m += 1) {
        const tok = h[m]!;
        if (tok.kind === T_IDENT || tok.kind === T_WORD) columns.push(nameOf(tok));
        else if (!isPunct(tok, ',')) this.fail('syntax');
      }
      k = close + 1;
    }
    if (k !== h.length) this.fail('syntax');
    this.insertColumns = columns;
    this.rowKeys = columns ?? this.known.get(name.name) ?? null;
  }

  private tupleToken(t: Token): void {
    if (!this.expectValue) {
      if (isPunct(t, ',')) {
        this.expectValue = true;
        return;
      }
      if (isPunct(t, ')')) {
        this.endRow();
        return;
      }
      this.fail('syntax');
    }
    if (this.introducer !== null) {
      const charset = this.introducer;
      this.introducer = null;
      let raw: Uint8Array | null = null;
      if (t.kind === T_STR && t.prefix === null) raw = latin1Bytes(t.value);
      else if (t.kind === T_STR && t.prefix === 'x' && HEX_DIGITS.test(t.value)) raw = hexBytes(t.value);
      else if (t.kind === T_WORD && HEX_WORD.test(t.value)) raw = hexBytes(HEX_WORD.exec(t.value)![1]!);
      if (raw === null) this.fail('syntax');
      this.value(charset === '_binary' ? raw : charset === '_latin1' ? Buffer.from(raw).toString('latin1') : textCell(raw));
      return;
    }
    if (this.sign !== null) {
      const sign = this.sign;
      this.sign = null;
      if (t.kind !== T_WORD || !NUMBER.test(t.value)) this.fail('syntax');
      this.value(numberValue(t.value, sign === '-'));
      return;
    }
    switch (t.kind) {
      case T_STR:
        if (t.prefix === null || t.prefix === 'n') this.value(textValue(t.value));
        else if (t.prefix === 'x' && HEX_DIGITS.test(t.value) && t.value.length % 2 === 0) this.value(hexBytes(t.value));
        else if (t.prefix === 'b' && BITS.test(t.value)) this.value(bitsValue(t.value));
        else this.fail('syntax');
        return;
      case T_WORD: {
        const word = t.value;
        const upper = word.toUpperCase();
        if (upper === 'NULL') this.value(null);
        else if (upper === 'TRUE') this.value(1);
        else if (upper === 'FALSE') this.value(0);
        else if (NUMBER.test(word)) this.value(numberValue(word, false));
        else if (HEX_WORD.test(word)) this.value(hexBytes(HEX_WORD.exec(word)![1]!));
        else if (BIT_WORD.test(word)) this.value(bitsValue(BIT_WORD.exec(word)![1]!));
        else if (/^_[a-z0-9]+$/i.test(word)) this.introducer = word.toLowerCase();
        else this.fail('syntax');
        return;
      }
      case T_PUNCT:
        if (t.value === '-' || t.value === '+') {
          this.sign = t.value;
          return;
        }
        if (t.value === ')' && this.values.length === 0) {
          this.endRow();
          return;
        }
        this.fail('syntax');
        return;
      default:
        this.fail('syntax');
    }
  }

  private value(v: SlimsRow[string]): void {
    this.values.push(v);
    this.expectValue = false;
  }

  private endRow(): void {
    const values = this.values;
    this.values = [];
    const keys = this.rowKeys;
    if (keys !== null && keys.length !== values.length) this.fail('column_count');
    const row: SlimsRow = {};
    for (let m = 0; m < values.length; m += 1) setOwn(row, keys === null ? String(m + 1) : keys[m]!, values[m]!);
    this.pending.push(row);
    if (this.pending.length >= DUMP_INSERT_BATCH) this.flush();
    this.state = ST_AFTER_TUPLE;
  }

  private flush(): void {
    if (this.pending.length === 0 || this.table === null) return;
    this.out.push({ type: 'insert', table: this.table, columns: this.insertColumns === null ? null : [...this.insertColumns], rows: this.pending });
    this.pending = [];
  }

  /** A CREATE or ALTER statement whose `;` was read (or the dump's end). */
  private readCollected(): void {
    const t = this.collected;
    if (t.length === 0 || t[0]!.kind !== T_WORD) return;
    if (/^CREATE$/i.test(t[0]!.value)) this.readCreate(t);
    else this.readAlter(t);
  }

  private readCreate(t: Token[]): void {
    let k = 1;
    if (isWord(t[k], 'OR') && isWord(t[k + 1], 'REPLACE')) k += 2;
    if (isWord(t[k], 'TEMPORARY')) k += 1;
    if (!isWord(t[k], 'TABLE')) return; // CREATE VIEW, DATABASE, TRIGGER, ...
    k += 1;
    if (isWord(t[k], 'IF') && isWord(t[k + 1], 'NOT') && isWord(t[k + 2], 'EXISTS')) k += 3;
    const name = readName(t, k);
    if (name === null) return;
    k = name.next;
    if (!isPunct(t[k], '(')) return; // CREATE TABLE ... LIKE / AS SELECT: no column list here
    const close = closingParen(t, k);
    if (close < 0) return;
    const columns: string[] = [];
    let primaryKey: string[] = [];
    for (const def of splitTopLevel(t, k + 1, close)) {
      const first = def[0];
      if (first === undefined) continue;
      if (first.kind === T_WORD) {
        const word = first.value.toUpperCase();
        if (word === 'PRIMARY') {
          primaryKey = keyColumns(def);
          continue;
        }
        if (word === 'CONSTRAINT') {
          const at = def.findIndex((d) => isWord(d, 'PRIMARY'));
          if (at >= 0) primaryKey = keyColumns(def.slice(at));
          continue;
        }
        if (/^(KEY|INDEX|UNIQUE|FULLTEXT|SPATIAL|FOREIGN|CHECK|PERIOD|SYSTEM)$/.test(word)) continue;
      }
      if (first.kind !== T_WORD && first.kind !== T_IDENT) continue;
      columns.push(nameOf(first));
      for (let m = 1; m + 1 < def.length; m += 1) {
        if (isWord(def[m], 'PRIMARY') && isWord(def[m + 1], 'KEY')) primaryKey = [nameOf(first)];
      }
    }
    this.known.set(name.name, columns);
    this.out.push({ type: 'create', table: name.name, columns, primaryKey });
  }

  /** ALTER [ONLINE] [IGNORE] TABLE name spec, spec, ...: only `ADD [CONSTRAINT [x]] PRIMARY KEY (...)` is read. */
  private readAlter(t: Token[]): void {
    let k = 1;
    while (isWord(t[k], 'ONLINE') || isWord(t[k], 'IGNORE')) k += 1;
    if (!isWord(t[k], 'TABLE')) return;
    const name = readName(t, k + 1);
    if (name === null) return;
    for (const spec of splitTopLevel(t, name.next, t.length)) {
      if (!isWord(spec[0], 'ADD')) continue;
      const at = spec.findIndex((d) => isWord(d, 'PRIMARY'));
      if (at > 0 && isWord(spec[at + 1], 'KEY')) {
        this.out.push({ type: 'primaryKey', table: name.name, primaryKey: keyColumns(spec.slice(at)) });
      }
    }
  }

  /** The dump ended (after the final scan). */
  private finish(): void {
    if (this.quotePending) {
      this.quotePending = false;
      if (this.lex === LEX_STR) this.endString();
      else if (this.lex === LEX_IDENT) this.endIdent();
    }
    if (this.lex === LEX_STR || this.lex === LEX_IDENT || this.lex === LEX_BLOCK_COMMENT || this.escapePending) {
      this.fail('truncated');
    }
    if (this.lex === LEX_WORD) this.endWord(-1, 0);
    if (this.lex === LEX_DELIMITER_LINE || this.lex === LEX_DELIMITER_BLOCK) {
      this.endDelimiterLine(this.base);
      this.lex = LEX_NONE;
    }
    const end = this.base;
    switch (this.state) {
      case ST_IDLE:
      case ST_SKIP:
      case ST_INSERT_HEAD:
        break;
      case ST_COLLECT:
        this.readCollected();
        break;
      case ST_AFTER_TUPLE:
        this.flush();
        break;
      default:
        this.fail('truncated');
    }
    if (this.state !== ST_IDLE) this.endStatement(end);
  }
}

function isPunct(t: Token | undefined, value: string): boolean {
  return t !== undefined && t.kind === T_PUNCT && t.value === value;
}

function isWord(t: Token | undefined, upper: string): boolean {
  return t !== undefined && t.kind === T_WORD && t.value.toUpperCase() === upper;
}

/** The name a word or quoted identifier token stands for (a bare word's bytes read as UTF-8). */
function nameOf(t: Token): string {
  return t.kind === T_WORD ? identText(t.value) : t.value;
}

/** A table name at `k` (`name`, `db`.`name`, `db.name`): the last part, and the index after it. */
function readName(t: readonly Token[], k: number): { name: string; next: number } | null {
  const first = t[k];
  if (first === undefined || (first.kind !== T_IDENT && first.kind !== T_WORD)) return null;
  let name = nameOf(first);
  let next = k + 1;
  while (isPunct(t[next], '.') && (t[next + 1]?.kind === T_IDENT || t[next + 1]?.kind === T_WORD)) {
    name = nameOf(t[next + 1]!);
    next += 2;
  }
  return { name, next };
}

/** The index of the `)` closing the `(` at `open`, or -1. */
function closingParen(t: readonly Token[], open: number): number {
  if (!isPunct(t[open], '(')) return -1;
  let depth = 0;
  for (let m = open; m < t.length; m += 1) {
    if (isPunct(t[m], '(')) depth += 1;
    else if (isPunct(t[m], ')')) {
      depth -= 1;
      if (depth === 0) return m;
    }
  }
  return -1;
}

/** The tokens from `from` to `to` (exclusive), split at the commas outside parentheses. */
function splitTopLevel(t: readonly Token[], from: number, to: number): Token[][] {
  const out: Token[][] = [[]];
  let depth = 0;
  for (let m = from; m < to; m += 1) {
    const tok = t[m]!;
    if (isPunct(tok, '(')) depth += 1;
    if (isPunct(tok, ')')) depth -= 1;
    if (depth === 0 && isPunct(tok, ',')) out.push([]);
    else out[out.length - 1]!.push(tok);
  }
  return out;
}

/** The columns of the first parenthesised list of a key definition (prefix lengths and ASC/DESC left out). */
function keyColumns(def: readonly Token[]): string[] {
  const open = def.findIndex((d) => isPunct(d, '('));
  if (open < 0) return [];
  const close = closingParen(def, open);
  if (close < 0) return [];
  const columns: string[] = [];
  let depth = 0;
  for (let m = open + 1; m < close; m += 1) {
    const tok = def[m]!;
    if (isPunct(tok, '(')) depth += 1;
    else if (isPunct(tok, ')')) depth -= 1;
    else if (depth === 0 && (tok.kind === T_IDENT || tok.kind === T_WORD) && !/^(ASC|DESC)$/i.test(tok.value)) {
      const previous = def[m - 1];
      if (previous === undefined || isPunct(previous, '(') || isPunct(previous, ',')) columns.push(nameOf(tok));
    }
  }
  return columns;
}

/** A numeric literal: a safe integer as a number, anything else (decimals, exponents, big integers) as its text. */
function numberValue(text: string, negative: boolean): number | string {
  if (INTEGER.test(text)) {
    const n = Number(text);
    if (Number.isSafeInteger(n)) return negative ? (n === 0 ? 0 : -n) : n;
  }
  return negative ? `-${text}` : text;
}

/**
 * A streaming reader of a mysqldump or phpMyAdmin dump (see the module comment). Feed it the dump's bytes in pieces of
 * any size, one character per byte; each call returns the events the piece completed.
 *
 * @throws (from push and end) DumpParseError for a dump that cannot be read as it is; TypeError for text holding a
 *   character above U+00FF, or a call after the parser ended or failed
 */
export function createSqlDumpParser(o?: SqlDumpParserOptions & { marks?: false }): SqlDumpParser<DumpEvent>;
export function createSqlDumpParser(o: SqlDumpParserOptions & { marks: true }): SqlDumpParser<DumpEvent | DumpMark>;
export function createSqlDumpParser(o?: SqlDumpParserOptions): SqlDumpParser<DumpEvent | DumpMark>;
export function createSqlDumpParser(o: SqlDumpParserOptions = {}): SqlDumpParser<DumpEvent | DumpMark> {
  const parser = new Parser(o);
  return {
    push: (text) => parser.push(text),
    end: () => parser.end(),
  };
}
