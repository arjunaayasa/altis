// A small PDF 1.4 writer for the label sheets (Phase 2 spec §7, D2-16): pages with filled or stroked rectangles and
// single-line text in the standard Type 1 fonts Helvetica, Helvetica-Bold and Courier. The fonts use WinAnsiEncoding
// and are not embedded, so the release archive stays the same size. Content streams are Flate-compressed. Objects are
// written in number order with a classic xref table. No native module and no dependency. Pure apart from node:zlib.

import { deflateSync } from 'node:zlib';
import { PDF_FONTS } from './afm.js';
import type { PdfFont } from './afm.js';
import { toWinAnsi } from './winansi.js';

/** One page; coordinates are PDF points (1/72 in) from the bottom left corner of the page. */
export interface PdfPage {
  /** Draws `s` (converted to WinAnsi) with its baseline starting at (x, y). An empty text draws nothing. */
  text(x: number, y: number, s: string, o: { font: PdfFont; size: number }): void;
  /** A rectangle with its lower left corner at (x, y). Filled unless `stroke` is set without `fill`. */
  rect(x: number, y: number, w: number, h: number, o?: { fill?: boolean; stroke?: boolean }): void;
}

/** The smallest and largest page side PDF 1.4 allows (Appendix C: 3-14 400 units). */
const PAGE_MIN_PT = 3;
const PAGE_MAX_PT = 14_400;
/** The largest coordinate written; a sane bound far beyond any page. */
const COORD_MAX = 1e6;
/** Every content stream sets a thin line for strokes (label borders). */
export const PDF_LINE_WIDTH = 0.5;

/** The font resource name of each font, the same on every page. */
const FONT_RESOURCE: Readonly<Record<PdfFont, string>> = { Helvetica: 'F1', 'Helvetica-Bold': 'F2', Courier: 'F3' };

/** A number as PDF writes it: at most three decimals, no exponent and no `-0`. */
function pdfNumber(n: number, what: string): string {
  if (!Number.isFinite(n) || Math.abs(n) > COORD_MAX) {
    throw new RangeError(`pdf: ${what} ${n} is not a finite number between -${COORD_MAX} and ${COORD_MAX}`);
  }
  const rounded = Math.round(n * 1000) / 1000;
  return rounded === 0 ? '0' : String(rounded);
}

/** A WinAnsi literal string: `( ) \` escaped, bytes outside printable ASCII as octal escapes. */
function pdfLiteral(bytes: Uint8Array): string {
  let out = '(';
  for (const b of bytes) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) out += `\\${String.fromCharCode(b)}`;
    else if (b < 0x20 || b > 0x7e) out += `\\${b.toString(8).padStart(3, '0')}`;
    else out += String.fromCharCode(b);
  }
  return `${out})`;
}

/** A text string of the document information: UTF-16BE with its byte order mark, as a hex string. */
function pdfTextString(s: string): string {
  let hex = '<FEFF';
  for (let i = 0; i < s.length; i++) hex += s.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0');
  return `${hex}>`;
}

class Page implements PdfPage {
  readonly ops: string[] = [`${PDF_LINE_WIDTH} w`];

  constructor(
    readonly width: number,
    readonly height: number,
  ) {}

  text(x: number, y: number, s: string, o: { font: PdfFont; size: number }): void {
    if (!PDF_FONTS.includes(o.font)) throw new TypeError(`pdf: ${String(o.font)} is not a font of this writer`);
    if (!(o.size > 0)) throw new RangeError(`pdf: font size ${o.size}`);
    const at = `${pdfNumber(x, 'x')} ${pdfNumber(y, 'y')}`;
    const size = pdfNumber(o.size, 'font size');
    if (s === '') return;
    this.ops.push(`BT /${FONT_RESOURCE[o.font]} ${size} Tf ${at} Td ${pdfLiteral(toWinAnsi(s).bytes)} Tj ET`);
  }

  rect(x: number, y: number, w: number, h: number, o?: { fill?: boolean; stroke?: boolean }): void {
    const stroke = o?.stroke ?? false;
    const fill = o?.fill ?? !stroke;
    const path = [pdfNumber(x, 'x'), pdfNumber(y, 'y'), pdfNumber(w, 'width'), pdfNumber(h, 'height')].join(' ');
    this.ops.push(`${path} re ${fill && stroke ? 'B' : fill ? 'f' : stroke ? 'S' : 'n'}`);
  }
}

const ascii = (s: string): Uint8Array => Buffer.from(s, 'latin1');

/** A PDF 1.4 document built page by page; `toBytes()` writes the whole file. */
export class PdfDocument {
  readonly #title: string | null;
  readonly #pages: Page[] = [];

  constructor(o?: { title?: string }) {
    this.#title = o?.title ?? null;
  }

  /** Adds a page of `widthPt` × `heightPt` points (3-14 400 each). */
  addPage(widthPt: number, heightPt: number): PdfPage {
    for (const side of [widthPt, heightPt]) {
      if (!(side >= PAGE_MIN_PT && side <= PAGE_MAX_PT)) {
        throw new RangeError(`pdf: page side ${side} is outside ${PAGE_MIN_PT}-${PAGE_MAX_PT} pt`);
      }
    }
    const page = new Page(widthPt, heightPt);
    this.#pages.push(page);
    return page;
  }

  /**
   * The file. Objects: 1 catalog, 2 page tree, 3 information, 4-6 the fonts, then each page and its content stream.
   * Writing does not change the document, so pages may be added and the file written again.
   */
  toBytes(): Uint8Array {
    if (this.#pages.length === 0) throw new Error('pdf: a document needs at least one page (no page was added)');
    const fontObject = (font: PdfFont): number => 4 + PDF_FONTS.indexOf(font);
    const firstPage = 4 + PDF_FONTS.length;
    const pageObject = (k: number): number => firstPage + 2 * k;
    const fontDict = PDF_FONTS.map((f) => `/${FONT_RESOURCE[f]} ${fontObject(f)} 0 R`).join(' ');

    const kids = this.#pages.map((_, k) => `${pageObject(k)} 0 R`).join(' ');
    const title = this.#title === null ? '' : ` /Title ${pdfTextString(this.#title)}`;
    const bodies: (string | { dict: string; data: Uint8Array })[] = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      `<< /Type /Pages /Kids [${kids}] /Count ${this.#pages.length} >>`,
      `<< /Producer (ALTIS)${title} >>`,
      ...PDF_FONTS.map((f) => `<< /Type /Font /Subtype /Type1 /BaseFont /${f} /Encoding /WinAnsiEncoding >>`),
    ];
    this.#pages.forEach((page, k) => {
      const box = `[0 0 ${pdfNumber(page.width, 'width')} ${pdfNumber(page.height, 'height')}]`;
      const resources = `<< /Font << ${fontDict} >> >>`;
      const contents = `${pageObject(k) + 1} 0 R`;
      bodies.push(`<< /Type /Page /Parent 2 0 R /MediaBox ${box} /Resources ${resources} /Contents ${contents} >>`);
      const data = deflateSync(ascii(page.ops.join('\n')));
      bodies.push({ dict: `<< /Length ${data.length} /Filter /FlateDecode >>`, data });
    });

    const chunks: Uint8Array[] = [];
    let length = 0;
    const put = (bytes: Uint8Array): void => {
      chunks.push(bytes);
      length += bytes.length;
    };
    put(ascii('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'));
    const offsets: number[] = [];
    bodies.forEach((body, k) => {
      offsets.push(length);
      if (typeof body === 'string') put(ascii(`${k + 1} 0 obj\n${body}\nendobj\n`));
      else {
        put(ascii(`${k + 1} 0 obj\n${body.dict}\nstream\n`));
        put(body.data);
        put(ascii('\nendstream\nendobj\n'));
      }
    });
    const xrefAt = length;
    const entries = offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n\r\n`).join('');
    put(ascii(`xref\n0 ${bodies.length + 1}\n0000000000 65535 f\r\n${entries}`));
    put(ascii(`trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`));

    const out = new Uint8Array(length);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }
}
