// The paginated PDF layout of the report exports and the accreditation documents, on top of the PDF writer: blocks
// (headings, wrapped paragraphs, key-value rows, tables, checklists, signature blocks, JPEG pictures) flow from the
// top of the printable area and start a new page when they do not fit. Every page gets the header and a numbered
// footer when the document is written, because the page count is only known then.
//
// The standard fonts are not embedded and use WinAnsi, so a character outside WinAnsi (Arabic, Javanese, CJK, emoji)
// prints as `?`. A table row with a cell that lost letters or digits of a writing system other than Latin gets one
// small extra line with the caller's note (for example "see the XLSX/CSV") and is counted in `nonLatinRows`; a
// character WinAnsi has (`é`), one that transliterates (`ā` → `a`), a modifier letter of romanisation (`ʿ` → `‘`) and
// an invisible format character (a zero-width space, dropped) are no loss, and a symbol or emoji that prints as `?` is
// no text of another script. Paragraphs are not counted. All sizes are PDF points (1/72 in). Pure apart from node:zlib.

import { textWidth } from './afm.js';
import type { PdfFont } from './afm.js';
import { PdfDocument } from './pdf.js';
import type { PdfColor, PdfImage, PdfPage } from './pdf.js';
import { toWinAnsi } from './winansi.js';

export type PaperSize = 'A4' | 'F4' | 'A5' | 'Roll58' | 'Roll80';

/**
 * The paper sizes in millimetres, portrait (F4 is the Indonesian folio). `Roll58` and `Roll80` are receipt rolls, 58 and 80
 * mm wide: each page is cut to its content (with its bottom margin), so a receipt printer feeds no blank paper; the
 * height is the longest a page may get, past which the content goes on on the next page.
 */
export const PAPER_SIZES_MM: Readonly<Record<PaperSize, { readonly width: number; readonly height: number }>> =
  Object.freeze({
    A4: Object.freeze({ width: 210, height: 297 }),
    F4: Object.freeze({ width: 215, height: 330 }),
    // ---- Komunitas (circulation core): letters on A5 and on receipt rolls ----
    A5: Object.freeze({ width: 148, height: 210 }),
    Roll58: Object.freeze({ width: 58, height: 2000 }),
    Roll80: Object.freeze({ width: 80, height: 2000 }),
  });

export interface PdfLayoutOptions {
  paper: PaperSize;
  orientation: 'portrait' | 'landscape';
  /** Page margins in millimetres (default 15 each). The header and the footer are drawn inside them. */
  marginsMm?: { top: number; right: number; bottom: number; left: number };
  /** The document information title (not printed). */
  title?: string;
  /** Printed at the top of every page: `left` in bold on the left, `right` on the right. */
  header?: { left: string; right?: string } | null;
  /** The footer text of page `page` of `pages` (1-based); default `"<page>/<pages>"`. */
  footer?: (page: number, pages: number) => string;
  /** The small line printed under a table row that lost text of another writing system to WinAnsi. */
  nonLatinNote: string;
}

export interface PdfTableColumn {
  header: string;
  /** The column's share of the printable width (default 1, > 0). */
  weight?: number;
  /** Default `left`; the header cell is aligned the same way. */
  align?: 'left' | 'right' | 'center';
}

export type PdfCell = string | number | null;

/** One line of a checklist: the label, whether the item is there, and an optional detail (a file name). */
export interface PdfChecklistItem {
  label: string;
  present: boolean;
  detail?: string;
}

/** One signature block: "<place>, <date>" above the role, then the space to sign, the name and the id line. */
export interface PdfSignatureBlock {
  place?: string;
  date?: string;
  role: string;
  name?: string;
  idLine?: string;
  /** Draws an outlined box for the stamp in the space to sign. */
  stamp?: boolean;
}

type Align = 'left' | 'right' | 'center';

const PT_PER_MM = 72 / 25.4;
const DEFAULT_MARGIN_MM = 15;
/** The smallest printable width and height a page may keep after its margins, header and footer. */
const MIN_AREA_PT = 72;
/** Line height as a multiple of the font size; the baseline sits one font size below the top of its line. */
const LEADING = 1.25;

const REGULAR: PdfFont = 'Helvetica';
const BOLD: PdfFont = 'Helvetica-Bold';

const BODY_SIZE = 10;
const HEADING_SIZE: Readonly<Record<1 | 2 | 3, number>> = { 1: 16, 2: 13, 3: 11 };
const HEADING_SPACE_BEFORE: Readonly<Record<1 | 2 | 3, number>> = { 1: 10, 2: 8, 3: 6 };
const HEADING_SPACE_AFTER = 4;
/** A heading only goes where this much of the following text fits under it too (three body lines). */
const HEADING_KEEP_NEXT = 3 * BODY_SIZE * LEADING;
/** The space after a block. */
const BLOCK_GAP = 6;

const HEADER_SIZE = 8;
const FOOTER_SIZE = 7;
const FOOTER_MIN_SIZE = 4.5;
const FOOTER_LINES = 2;
/** The distance between the header (footer) text and its rule, and between the rule and the content. */
const RULE_GAP = 2;
const BAND_GAP = 8;

const TABLE_SIZE = 8;
const NOTE_SIZE = 6.5;
const CELL_PAD_X = 3;
const CELL_PAD_Y = 2;
const HEADER_RULE_WIDTH = 1;

const KEY_GAP = 8;
const KEY_MAX_SHARE = 0.4;
const ROW_GAP = 2;

const CHECK_BOX = 7;
const CHECK_GAP = 5;
const DETAIL_SIZE = 8;

const SIGN_SPACE = 56;
const SIGN_PAD = 6;
const SIGN_LINE_SHARE = 0.6;
/** The name line sits this far under the name's baseline, clear of its descenders. */
const SIGN_UNDERLINE_GAP = 2.5;
const STAMP_SIDE = 48;
const ID_SIZE = 9;
const SIGN_PER_ROW = 3;

const CAPTION_SIZE = 8;
const CAPTION_GAP = 3;

/** The text as printed: a tab is a space and CR LF, CR or LF break the line. */
function textLines(s: string): string[] {
  return s.replace(/\t/g, ' ').split(/\r\n|\r|\n/);
}

/**
 * How many letters or digits of a writing system other than Latin in `s` print as `?` (line breaks and tabs are
 * layout, not lost characters).
 */
function lostCharacters(s: string): number {
  return toWinAnsi(s.replace(/\r\n|\r|\n|\t/g, ' ')).otherScript;
}

/** Pieces of an over-long word, each at most `max` wide (one character at least). */
function breakWord(word: string, font: PdfFont, size: number, max: number): { text: string; width: number }[] {
  const pieces: { text: string; width: number }[] = [];
  let piece = '';
  let width = 0;
  for (const ch of word.normalize('NFC')) {
    const w = textWidth(ch, font, size);
    if (piece !== '' && width + w > max) {
      pieces.push({ text: piece, width });
      piece = '';
      width = 0;
    }
    piece += ch;
    width += w;
  }
  if (piece !== '') pieces.push({ text: piece, width });
  return pieces;
}

/**
 * `text` wrapped to lines at most `max` points wide: lines break on spaces, a word wider than a line is broken by
 * character, and the text's own line breaks are kept. Always at least one line (an empty text is one empty line).
 */
function wrapText(text: string, font: PdfFont, size: number, max: number): string[] {
  const out: string[] = [];
  const space = textWidth(' ', font, size);
  for (const paragraph of textLines(text)) {
    let line = '';
    let width = 0;
    for (const word of paragraph.split(' ')) {
      if (word === '') continue;
      const w = textWidth(word, font, size);
      if (line !== '' && width + space + w <= max) {
        line += ` ${word}`;
        width += space + w;
        continue;
      }
      if (line !== '') out.push(line);
      if (w <= max) {
        line = word;
        width = w;
        continue;
      }
      const pieces = breakWord(word, font, size, max);
      for (const p of pieces.slice(0, -1)) out.push(p.text);
      const last = pieces.at(-1)!;
      line = last.text;
      width = last.width;
    }
    out.push(line);
  }
  return out;
}

const cellText = (c: PdfCell | undefined): string =>
  c === null || c === undefined ? '' : typeof c === 'number' ? String(c) : c;

function finiteMm(n: number, what: string): number {
  if (!Number.isFinite(n) || n < 0) throw new RangeError(`pdf layout: ${what} ${n} is not a size in millimetres`);
  return n * PT_PER_MM;
}

function positiveSize(n: number, what: string): number {
  if (!Number.isFinite(n) || !(n > 0)) throw new RangeError(`pdf layout: ${what} ${n} is not positive`);
  return n;
}

/** The page header's lines: the bold left text and the right text beside it. */
interface Header {
  left: string[];
  right: string[];
}

/** A table being printed: its geometry and on which page its header row was last drawn. */
interface TableState {
  x: number[];
  widths: number[];
  aligns: Align[];
  header: string[][];
  headerHeight: number;
  note: string[];
  /** The note's lines and the padding under them. */
  noteHeight: number;
  /** The page count when the header row was last drawn (the page it is on). */
  headerPage: number;
}

/**
 * A page of a receipt roll while its content is laid out: the drawing is kept, measured from the top of a page as long
 * as the paper allows, and replayed onto a page cut to the content's length when the file is written (every drawing
 * moved down by the length cut off), so the written page holds only what is printed.
 */
class RollPage implements PdfPage {
  readonly #ops: ((page: PdfPage, cut: number) => void)[] = [];

  text(x: number, y: number, s: string, o: { font: PdfFont; size: number; color?: PdfColor }): void {
    this.#ops.push((page, cut) => page.text(x, y - cut, s, o));
  }

  rect(x: number, y: number, w: number, h: number, o?: { fill?: boolean; stroke?: boolean; color?: PdfColor }): void {
    this.#ops.push((page, cut) => page.rect(x, y - cut, w, h, o));
  }

  line(x1: number, y1: number, x2: number, y2: number, o?: { width?: number }): void {
    this.#ops.push((page, cut) => page.line(x1, y1 - cut, x2, y2 - cut, o));
  }

  image(img: PdfImage, x: number, y: number, w: number, h: number): void {
    this.#ops.push((page, cut) => page.image(img, x, y - cut, w, h));
  }

  /** Draws the kept content on `page`, `cut` points lower. */
  replay(page: PdfPage, cut: number): void {
    for (const op of this.#ops) op(page, cut);
  }
}

/** A paginated document; see the top of this file. Methods add blocks in order; `toBytes()` writes the file once. */
export class PdfLayout {
  readonly #doc: PdfDocument;
  readonly #pageList: PdfPage[] = [];
  readonly #width: number;
  readonly #height: number;
  readonly #margins: { top: number; right: number; bottom: number; left: number };
  readonly #left: number;
  readonly #printable: number;
  readonly #contentTop: number;
  readonly #contentBottom: number;
  readonly #header: Header | null;
  readonly #footer: (page: number, pages: number) => string;
  readonly #note: string;
  /** A receipt roll: the pages are cut to their content when the file is written (RollPage). */
  readonly #roll: boolean;
  /** The cursor where each page before the current one was left (how far down its content goes). */
  readonly #ends: number[] = [];
  #page: PdfPage;
  /** The top of the next block on the current page. */
  #y: number;
  /** Nothing is drawn on the current page yet. */
  #empty = true;
  #nonLatinRows = 0;
  #bytes: Uint8Array | null = null;

  constructor(o: PdfLayoutOptions) {
    if (!Object.hasOwn(PAPER_SIZES_MM, o.paper)) throw new RangeError(`pdf layout: unknown paper size ${String(o.paper)}`);
    if (o.orientation !== 'portrait' && o.orientation !== 'landscape') {
      throw new RangeError(`pdf layout: unknown orientation ${String(o.orientation)}`);
    }
    if (typeof o.nonLatinNote !== 'string') throw new TypeError('pdf layout: nonLatinNote must be a text');
    const paper = PAPER_SIZES_MM[o.paper];
    const [w, h] = [paper.width * PT_PER_MM, paper.height * PT_PER_MM];
    [this.#width, this.#height] = o.orientation === 'portrait' ? [w, h] : [h, w];
    const d = DEFAULT_MARGIN_MM;
    const m = o.marginsMm ?? { top: d, right: d, bottom: d, left: d };
    this.#margins = {
      top: finiteMm(m.top, 'top margin'),
      right: finiteMm(m.right, 'right margin'),
      bottom: finiteMm(m.bottom, 'bottom margin'),
      left: finiteMm(m.left, 'left margin'),
    };
    this.#left = this.#margins.left;
    this.#printable = this.#width - this.#margins.left - this.#margins.right;
    if (!(this.#printable >= MIN_AREA_PT)) throw new RangeError('pdf layout: the margins leave no printable width');
    this.#header = o.header ? this.#wrapHeader(o.header) : null;
    const headerLines = this.#header ? Math.max(this.#header.left.length, this.#header.right.length) : 0;
    const headerBand = this.#header ? headerLines * HEADER_SIZE * LEADING + RULE_GAP + BAND_GAP : 0;
    const footerBand = FOOTER_LINES * FOOTER_SIZE * LEADING + RULE_GAP + BAND_GAP;
    this.#contentTop = this.#height - this.#margins.top - headerBand;
    this.#contentBottom = this.#margins.bottom + footerBand;
    if (!(this.#contentTop - this.#contentBottom >= MIN_AREA_PT)) {
      throw new RangeError('pdf layout: the margins, header and footer leave no printable height');
    }
    this.#footer = o.footer ?? ((page, pages) => `${page}/${pages}`);
    this.#note = o.nonLatinNote;
    this.#doc = new PdfDocument(o.title === undefined ? undefined : { title: o.title });
    this.#roll = o.paper === 'Roll58' || o.paper === 'Roll80';
    this.#page = this.#addPage();
    this.#y = this.#contentTop;
  }

  /** The number of pages so far. */
  get pages(): number {
    return this.#pageList.length;
  }

  /** Table rows that lost text of another writing system to WinAnsi, over every table so far. */
  get nonLatinRows(): number {
    return this.#nonLatinRows;
  }

  /** A bold heading (16, 13 or 11 pt), kept on the page of the first lines that follow it. */
  heading(text: string, level: 1 | 2 | 3): void {
    this.#open();
    if (level !== 1 && level !== 2 && level !== 3) throw new RangeError(`pdf layout: heading level ${String(level)}`);
    const size = HEADING_SIZE[level];
    const lines = wrapText(text, BOLD, size, this.#printable);
    const lead = size * LEADING;
    const before = this.#empty ? 0 : HEADING_SPACE_BEFORE[level];
    if (before + lines.length * lead + HEADING_SPACE_AFTER + HEADING_KEEP_NEXT > this.#room()) this.#breakPage();
    if (!this.#empty) this.#y -= before;
    for (const line of lines) this.#textLine(line, BOLD, size, 'left', this.#left, this.#printable);
    this.#y -= HEADING_SPACE_AFTER;
  }

  /** A paragraph wrapped to the printable width (default 10 pt, regular, left); it may continue on the next page. */
  paragraph(text: string, o?: { size?: number; bold?: boolean; align?: 'left' | 'center' | 'right' }): void {
    this.#open();
    const size = positiveSize(o?.size ?? BODY_SIZE, 'font size');
    const font = o?.bold ? BOLD : REGULAR;
    for (const line of wrapText(text, font, size, this.#printable)) {
      this.#textLine(line, font, size, o?.align ?? 'left', this.#left, this.#printable);
    }
    this.#y -= size * LEADING * 0.4;
  }

  /** Rows of a bold key and its value beside it; a row is kept on one page when it fits on one. */
  keyValues(rows: readonly (readonly [string, string])[]): void {
    this.#open();
    if (rows.length === 0) return;
    const size = BODY_SIZE;
    const lead = size * LEADING;
    const widest = Math.max(...rows.map(([key]) => textWidth(key, BOLD, size)));
    const keyWidth = Math.min(widest, this.#printable * KEY_MAX_SHARE);
    const valueX = this.#left + keyWidth + KEY_GAP;
    const valueWidth = this.#printable - keyWidth - KEY_GAP;
    for (const [key, value] of rows) {
      const keys = wrapText(key, BOLD, size, keyWidth);
      const values = wrapText(value, REGULAR, size, valueWidth);
      const n = Math.max(keys.length, values.length);
      if (n * lead > this.#room()) this.#breakPage();
      for (let i = 0; i < n; i++) {
        if (lead > this.#room()) this.#breakPage();
        const baseline = this.#y - size;
        if (keys[i]) this.#page.text(this.#left, baseline, keys[i]!, { font: BOLD, size });
        if (values[i]) this.#page.text(valueX, baseline, values[i]!, { font: REGULAR, size });
        this.#y -= lead;
        this.#empty = false;
      }
      this.#y -= ROW_GAP;
    }
    this.#y -= BLOCK_GAP;
  }

  /**
   * A table over the printable width, split between the columns by weight. Cells are wrapped; a row that does not fit
   * starts a new page (a row taller than a page continues on the next), and the header row is repeated at the top of
   * every page the table reaches. A row with a cell that lost text of another writing system to WinAnsi gets the note
   * line under it.
   * `rows` is read once, in order; a row may have fewer cells than columns (the rest are empty), not more.
   */
  table(columns: readonly PdfTableColumn[], rows: Iterable<readonly PdfCell[]>): { rows: number; nonLatinRows: number } {
    this.#open();
    if (columns.length === 0) throw new RangeError('pdf layout: a table needs at least one column');
    const weights = columns.map((c) => positiveSize(c.weight ?? 1, 'column weight'));
    const total = weights.reduce((a, b) => a + b, 0);
    const widths = weights.map((w) => (this.#printable * w) / total);
    const x: number[] = [];
    let at = this.#left;
    for (const w of widths) {
      x.push(at);
      at += w;
    }
    const lead = TABLE_SIZE * LEADING;
    const header = columns.map((c, k) => wrapText(c.header, BOLD, TABLE_SIZE, widths[k]! - 2 * CELL_PAD_X));
    const note = wrapText(this.#note, REGULAR, NOTE_SIZE, this.#printable - 2 * CELL_PAD_X);
    const t: TableState = {
      x,
      widths,
      aligns: columns.map((c) => c.align ?? 'left'),
      header,
      headerHeight: 2 * CELL_PAD_Y + Math.max(...header.map((h) => h.length)) * lead,
      note,
      noteHeight: note.length * NOTE_SIZE * LEADING + CELL_PAD_Y,
      headerPage: -1,
    };
    let count = 0;
    let marked = 0;
    for (const row of rows) {
      if (row.length > columns.length) {
        throw new RangeError(`pdf layout: table row ${count + 1} has ${row.length} cells for ${columns.length} columns`);
      }
      const texts = columns.map((_, k) => cellText(row[k]));
      const lost = texts.some((s) => lostCharacters(s) > 0);
      this.#tableRow(
        t,
        texts.map((s, k) => wrapText(s, REGULAR, TABLE_SIZE, widths[k]! - 2 * CELL_PAD_X)),
        lost,
      );
      count++;
      if (lost) marked++;
    }
    if (t.headerPage !== this.#pageList.length) {
      if (t.headerHeight > this.#room()) this.#breakPage();
      this.#tableHeader(t);
    }
    this.#y -= BLOCK_GAP;
    this.#nonLatinRows += marked;
    return { rows: count, nonLatinRows: marked };
  }

  /**
   * One line per item: a small box (filled when present, outlined when not), the status word, the label and its
   * detail under it. The status words are the caller's (default "ada" / "belum"); no symbol glyph is used, so the
   * list prints in the standard fonts.
   */
  checklist(items: readonly PdfChecklistItem[], o?: { presentLabel?: string; missingLabel?: string }): void {
    this.#open();
    const presentLabel = o?.presentLabel ?? 'ada';
    const missingLabel = o?.missingLabel ?? 'belum';
    const size = BODY_SIZE;
    const lead = size * LEADING;
    const detailLead = DETAIL_SIZE * LEADING;
    const statusX = this.#left + CHECK_BOX + CHECK_GAP;
    const statusWidth = Math.max(textWidth(presentLabel, BOLD, size), textWidth(missingLabel, BOLD, size));
    const labelX = statusX + statusWidth + CHECK_GAP * 2;
    const labelWidth = this.#left + this.#printable - labelX;
    if (!(labelWidth > size)) throw new RangeError('pdf layout: the checklist status words leave no room for labels');
    for (const item of items) {
      const labels = wrapText(item.label, REGULAR, size, labelWidth);
      const details = item.detail ? wrapText(item.detail, REGULAR, DETAIL_SIZE, labelWidth) : [];
      const height = labels.length * lead + details.length * detailLead;
      if (height > this.#room()) this.#breakPage();
      const top = this.#y;
      const boxY = top - size + (size - CHECK_BOX) / 2 - 1;
      this.#page.rect(this.#left, boxY, CHECK_BOX, CHECK_BOX, item.present ? { fill: true } : { stroke: true });
      this.#page.text(statusX, top - size, item.present ? presentLabel : missingLabel, { font: BOLD, size });
      for (const line of labels) this.#textLine(line, REGULAR, size, 'left', labelX, labelWidth);
      for (const line of details) this.#textLine(line, REGULAR, DETAIL_SIZE, 'left', labelX, labelWidth);
      this.#empty = false;
      this.#y -= ROW_GAP;
    }
    this.#y -= BLOCK_GAP;
  }

  /**
   * Signature blocks side by side (up to three per row; a row is never split over two pages): "<place>, <date>", the
   * role, the space to sign (with an outlined box for the stamp when `stamp` is set), the name in bold over a line (an
   * empty line when there is no name) and the id line.
   */
  signatureBlocks(blocks: readonly PdfSignatureBlock[]): void {
    this.#open();
    const size = BODY_SIZE;
    const lead = size * LEADING;
    const idLead = ID_SIZE * LEADING;
    for (let start = 0; start < blocks.length; start += SIGN_PER_ROW) {
      const row = blocks.slice(start, start + SIGN_PER_ROW);
      const width = this.#printable / row.length;
      const inner = width - 2 * SIGN_PAD;
      const laid = row.map((b) => {
        const placeDate = [b.place, b.date].filter((s): s is string => s !== undefined && s !== '').join(', ');
        return {
          block: b,
          placeDate: placeDate === '' ? [] : wrapText(placeDate, REGULAR, size, inner),
          role: wrapText(b.role, REGULAR, size, inner),
          name: b.name ? wrapText(b.name, BOLD, size, inner) : [''],
          id: b.idLine ? wrapText(b.idLine, REGULAR, ID_SIZE, inner) : [],
        };
      });
      // The blocks of a row share their lines: the roles, the space to sign and the names start at the same height in
      // every block (a place and date sit just above the role).
      const rows = (pick: (l: (typeof laid)[number]) => string[]): number => Math.max(...laid.map((l) => pick(l).length));
      const placeRows = rows((l) => l.placeDate);
      const roleRows = rows((l) => l.role);
      const height = (placeRows + roleRows + rows((l) => l.name)) * lead + SIGN_SPACE + rows((l) => l.id) * idLead;
      if (height > this.#room()) this.#breakPage();
      const top = this.#y;
      laid.forEach((l, k) => {
        const x = this.#left + k * width + SIGN_PAD;
        let y = top - (placeRows - l.placeDate.length) * lead;
        const line = (s: string, font: PdfFont, at: number): void => {
          const w = textWidth(s, font, at);
          if (s !== '') this.#page.text(x + (inner - w) / 2, y - at, s, { font, size: at });
          y -= at * LEADING;
        };
        for (const s of [...l.placeDate, ...l.role]) line(s, REGULAR, size);
        y -= (roleRows - l.role.length) * lead;
        if (l.block.stamp) {
          const side = Math.min(STAMP_SIDE, inner * 0.3, SIGN_SPACE - 4);
          this.#page.rect(x, y - SIGN_SPACE + (SIGN_SPACE - side) / 2, side, side, { stroke: true });
        }
        y -= SIGN_SPACE;
        const nameWidth = Math.max(...l.name.map((s) => textWidth(s, BOLD, size)));
        for (const s of l.name) line(s, BOLD, size);
        const underline = Math.min(inner, Math.max(nameWidth, inner * SIGN_LINE_SHARE));
        const lineY = y + lead - size - SIGN_UNDERLINE_GAP;
        this.#page.line(x + (inner - underline) / 2, lineY, x + (inner + underline) / 2, lineY);
        for (const s of l.id) line(s, REGULAR, ID_SIZE);
      });
      this.#y = top - height;
      this.#empty = false;
      this.#y -= BLOCK_GAP;
    }
  }

  /**
   * A JPEG picture, centred and scaled (up or down, keeping its proportions) to fit `maxWidthMm` × `maxHeightMm`
   * and the printable area, with an optional caption under it; picture and caption stay on one page. Throws
   * `JpegError` (`not_jpeg`, `cmyk`, `truncated`) before anything is drawn.
   */
  image(jpeg: Uint8Array, o: { maxWidthMm: number; maxHeightMm: number; caption?: string }): void {
    this.#open();
    const maxWidth = Math.min(positiveSize(o.maxWidthMm, 'picture width') * PT_PER_MM, this.#printable);
    const captionLines = o.caption ? wrapText(o.caption, REGULAR, CAPTION_SIZE, this.#printable) : [];
    const captionHeight = captionLines.length === 0 ? 0 : CAPTION_GAP + captionLines.length * CAPTION_SIZE * LEADING;
    const area = this.#contentTop - this.#contentBottom - captionHeight;
    const maxHeight = Math.min(positiveSize(o.maxHeightMm, 'picture height') * PT_PER_MM, Math.max(area, 1));
    const img = this.#doc.addJpeg(jpeg);
    const scale = Math.min(maxWidth / img.width, maxHeight / img.height);
    const [w, h] = [img.width * scale, img.height * scale];
    if (h + captionHeight > this.#room()) this.#breakPage();
    this.#page.image(img, this.#left + (this.#printable - w) / 2, this.#y - h, w, h);
    this.#y -= h;
    this.#empty = false;
    if (captionLines.length > 0) {
      this.#y -= CAPTION_GAP;
      for (const line of captionLines) this.#textLine(line, REGULAR, CAPTION_SIZE, 'center', this.#left, this.#printable);
    }
    this.#y -= BLOCK_GAP;
  }

  /** Starts a new page, unless nothing is drawn on the current one yet. */
  pageBreak(): void {
    this.#open();
    if (!this.#empty) this.#addPageAndMove();
  }

  /**
   * Draws the header and the footer on every page and writes the file; later calls answer the same bytes. A page of a
   * receipt roll is first cut to its content: the footer and the bottom margin follow right under it.
   */
  toBytes(): Uint8Array {
    if (this.#bytes !== null) return this.#bytes;
    const pages = this.#pageList.length;
    const ends = [...this.#ends, this.#y];
    this.#pageList.forEach((page, k) => {
      const cut = page instanceof RollPage ? Math.max(0, ends[k]! - this.#contentBottom) : 0;
      if (this.#header !== null) this.#drawHeader(page, this.#header);
      this.#drawFooter(page, this.#footer(k + 1, pages), cut);
      if (page instanceof RollPage) page.replay(this.#doc.addPage(this.#width, this.#height - cut), cut);
    });
    this.#bytes = this.#doc.toBytes();
    return this.#bytes;
  }

  #open(): void {
    if (this.#bytes !== null) throw new Error('pdf layout: the document is already written');
  }

  #addPage(): PdfPage {
    const page = this.#roll ? new RollPage() : this.#doc.addPage(this.#width, this.#height);
    this.#pageList.push(page);
    return page;
  }

  #addPageAndMove(): void {
    this.#ends.push(this.#y);
    this.#page = this.#addPage();
    this.#y = this.#contentTop;
    this.#empty = true;
  }

  /** A new page when something is on the current one; a block taller than a page then overflows its first page. */
  #breakPage(): void {
    if (!this.#empty) this.#addPageAndMove();
  }

  #room(): number {
    return this.#y - this.#contentBottom;
  }

  /** One line of text at the cursor, moving to a new page first when it does not fit. */
  #textLine(line: string, font: PdfFont, size: number, align: Align, x: number, width: number): void {
    const lead = size * LEADING;
    if (lead > this.#room()) this.#breakPage();
    if (line !== '') this.#page.text(alignedX(line, font, size, align, x, width), this.#y - size, line, { font, size });
    this.#y -= lead;
    this.#empty = false;
  }

  #tableRow(t: TableState, cells: string[][], lost: boolean): void {
    const lead = TABLE_SIZE * LEADING;
    const done = cells.map(() => 0);
    const linesLeft = (): number => Math.max(1, ...cells.map((c, k) => c.length - done[k]!));
    const fresh = this.#contentTop - this.#contentBottom - t.headerHeight;
    let started = false;
    for (;;) {
      const left = linesLeft();
      const full = 2 * CELL_PAD_Y + left * lead + (lost ? t.noteHeight : 0);
      if (t.headerPage !== this.#pageList.length) {
        const first = full <= fresh ? full : 2 * CELL_PAD_Y + lead;
        if (t.headerHeight + first > this.#room()) this.#breakPage();
        this.#tableHeader(t);
      }
      if (full <= this.#room()) {
        this.#tableChunk(t, cells, done, left, lost);
        return;
      }
      if (!started && full <= fresh) {
        // The whole row fits on a fresh page: move it there.
        this.#addPageAndMove();
        continue;
      }
      // A row taller than a page: as many lines as fit here, the rest (and the note) under the header of the next page.
      // A page that holds only the header always takes a line, so the table moves on whatever the sizes.
      const onlyHeader = this.#y === this.#contentTop - t.headerHeight;
      let fit = Math.min(Math.floor((this.#room() - 2 * CELL_PAD_Y) / lead), left - 1);
      if (fit < 1 && onlyHeader) {
        if (left === 1) {
          this.#tableChunk(t, cells, done, 1, lost);
          return;
        }
        fit = 1;
      }
      if (fit < 1) {
        this.#addPageAndMove();
        continue;
      }
      this.#tableChunk(t, cells, done, fit, false);
      started = true;
      this.#addPageAndMove();
    }
  }

  /** `count` lines of every cell from `done` on (advancing `done`), with the note line when `withNote`. */
  #tableChunk(t: TableState, cells: string[][], done: number[], count: number, withNote: boolean): void {
    const lead = TABLE_SIZE * LEADING;
    const top = this.#y;
    const cellBottom = top - 2 * CELL_PAD_Y - count * lead;
    cells.forEach((lines, k) => {
      const slice = lines.slice(done[k], done[k]! + count);
      slice.forEach((line, i) => {
        if (line === '') return;
        const x = alignedX(line, REGULAR, TABLE_SIZE, t.aligns[k]!, t.x[k]! + CELL_PAD_X, t.widths[k]! - 2 * CELL_PAD_X);
        this.#page.text(x, top - CELL_PAD_Y - i * lead - TABLE_SIZE, line, { font: REGULAR, size: TABLE_SIZE });
      });
      done[k] = done[k]! + slice.length;
    });
    let bottom = cellBottom;
    if (withNote) {
      t.note.forEach((line, i) => {
        if (line === '') return;
        const baseline = cellBottom - i * NOTE_SIZE * LEADING - NOTE_SIZE;
        this.#page.text(this.#left + CELL_PAD_X, baseline, line, { font: REGULAR, size: NOTE_SIZE });
      });
      bottom -= t.noteHeight;
    }
    const right = this.#left + this.#printable;
    // Column rules over the cells; the outer rules down to the bottom of the row (through the note line).
    for (const x of t.x.slice(1)) this.#page.line(x, top, x, cellBottom);
    this.#page.line(this.#left, top, this.#left, bottom);
    this.#page.line(right, top, right, bottom);
    this.#page.line(this.#left, bottom, right, bottom);
    this.#y = bottom;
    this.#empty = false;
  }

  #tableHeader(t: TableState): void {
    const lead = TABLE_SIZE * LEADING;
    const top = this.#y;
    const bottom = top - t.headerHeight;
    const right = this.#left + this.#printable;
    t.header.forEach((lines, k) => {
      lines.forEach((line, i) => {
        if (line === '') return;
        const x = alignedX(line, BOLD, TABLE_SIZE, t.aligns[k]!, t.x[k]! + CELL_PAD_X, t.widths[k]! - 2 * CELL_PAD_X);
        this.#page.text(x, top - CELL_PAD_Y - i * lead - TABLE_SIZE, line, { font: BOLD, size: TABLE_SIZE });
      });
    });
    this.#page.line(this.#left, top, right, top);
    for (const x of [...t.x, right]) this.#page.line(x, top, x, bottom);
    this.#page.line(this.#left, bottom, right, bottom, { width: HEADER_RULE_WIDTH });
    this.#y = bottom;
    this.#empty = false;
    t.headerPage = this.#pageList.length;
  }

  #wrapHeader(h: { left: string; right?: string }): Header {
    const right = h.right ?? '';
    const rightWidth = right === '' ? 0 : Math.min(textWidth(right, REGULAR, HEADER_SIZE), this.#printable * 0.45);
    const gap = right === '' ? 0 : 12;
    return {
      left: wrapText(h.left, BOLD, HEADER_SIZE, this.#printable - rightWidth - gap),
      right: right === '' ? [] : wrapText(right, REGULAR, HEADER_SIZE, rightWidth),
    };
  }

  #drawHeader(page: PdfPage, h: Header): void {
    const lead = HEADER_SIZE * LEADING;
    const top = this.#height - this.#margins.top;
    const right = this.#left + this.#printable;
    h.left.forEach((line, i) => {
      if (line !== '') page.text(this.#left, top - HEADER_SIZE - i * lead, line, { font: BOLD, size: HEADER_SIZE });
    });
    h.right.forEach((line, i) => {
      if (line === '') return;
      const x = right - textWidth(line, REGULAR, HEADER_SIZE);
      page.text(x, top - HEADER_SIZE - i * lead, line, { font: REGULAR, size: HEADER_SIZE });
    });
    const ruleY = top - Math.max(h.left.length, h.right.length) * lead - RULE_GAP;
    page.line(this.#left, ruleY, right, ruleY);
  }

  /**
   * The footer at the bottom of the page, wrapped to two lines; a longer text is printed smaller. `cut` lifts it by the
   * length a roll page loses at the bottom.
   */
  #drawFooter(page: PdfPage, text: string, cut: number): void {
    let size = FOOTER_SIZE;
    let lines = wrapText(text, REGULAR, size, this.#printable);
    while (lines.length > FOOTER_LINES && size > FOOTER_MIN_SIZE) {
      size -= 0.5;
      lines = wrapText(text, REGULAR, size, this.#printable);
    }
    lines = lines.slice(0, FOOTER_LINES);
    const lead = size * LEADING;
    const bottom = this.#margins.bottom + cut;
    lines.forEach((line, i) => {
      const baseline = bottom + (lines.length - 1 - i) * lead + (lead - size);
      if (line !== '') page.text(this.#left, baseline, line, { font: REGULAR, size });
    });
    const ruleY = bottom + FOOTER_LINES * FOOTER_SIZE * LEADING + RULE_GAP;
    page.line(this.#left, ruleY, this.#left + this.#printable, ruleY);
  }
}

/** The x of a line aligned in the box from `x`, `width` wide. */
function alignedX(line: string, font: PdfFont, size: number, align: Align, x: number, width: number): number {
  if (align === 'left') return x;
  const w = textWidth(line, font, size);
  return align === 'right' ? x + width - w : x + (width - w) / 2;
}
