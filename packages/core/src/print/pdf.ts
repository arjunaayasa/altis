// A small PDF 1.4 writer for the label sheets and the report layout: pages with filled or stroked rectangles, straight
// lines, single-line text in the standard Type 1 fonts Helvetica, Helvetica-Bold and Courier, and JPEG pictures. The
// fonts use WinAnsiEncoding and are not embedded, so the release archive stays the same size. Content streams are
// Flate-compressed; a JPEG file is stored unchanged as a DCTDecode image XObject. Every page stays open for drawing
// until `toBytes()`, so a layout can number its pages once it knows how many there are. Objects are written in number
// order with a classic xref table; the pictures come after the pages, so a document without pictures or lines is
// written exactly as before they existed. No native module and no dependency. Pure apart from node:zlib.

import { deflateSync } from 'node:zlib';
import { PDF_FONTS } from './afm.js';
import type { PdfFont } from './afm.js';
import { jpegInfo } from './jpeg.js';
import { toWinAnsi } from './winansi.js';

/**
 * A picture added to one document (`PdfDocument.addJpeg`, or `addPixels` for decoded pixels), drawn on its pages with
 * `PdfPage.image`.
 */
export interface PdfImage {
  /** The size in pixels (a JPEG's from its frame header). */
  readonly width: number;
  readonly height: number;
  /** 1 = grey (DeviceGray), 3 = colour (DeviceRGB). */
  readonly components: 1 | 3;
}

/** One page; coordinates are PDF points (1/72 in) from the bottom left corner of the page. */
export interface PdfPage {
  /**
   * Draws `s` (converted to WinAnsi) with its baseline starting at (x, y). An empty text draws nothing. `color` (RGB,
   * each 0-1) paints it in that colour instead of black.
   */
  text(x: number, y: number, s: string, o: { font: PdfFont; size: number; color?: PdfColor }): void;
  /**
   * A rectangle with its lower left corner at (x, y). Filled unless `stroke` is set without `fill`; `color` (RGB, each
   * 0-1) is the fill colour instead of black.
   */
  rect(x: number, y: number, w: number, h: number, o?: { fill?: boolean; stroke?: boolean; color?: PdfColor }): void;
  /** A straight stroked line from (x1, y1) to (x2, y2), `PDF_LINE_WIDTH` wide unless `width` (points, > 0) is given. */
  line(x1: number, y1: number, x2: number, y2: number, o?: { width?: number }): void;
  /** Draws a picture of this document stretched over the box with its lower left corner at (x, y); `w`, `h` > 0. */
  image(img: PdfImage, x: number, y: number, w: number, h: number): void;
}

/** A colour as red, green and blue, each from 0 to 1. */
export type PdfColor = readonly [number, number, number];

/** The `rg` operator of `c` (fill colour), each component clamped to 0-1. */
function fillColor(c: PdfColor): string {
  const part = (v: number): string => {
    if (!Number.isFinite(v)) throw new RangeError(`pdf: colour component ${v} is not finite`);
    return String(Math.round(Math.min(1, Math.max(0, v)) * 1000) / 1000);
  };
  return `${part(c[0])} ${part(c[1])} ${part(c[2])} rg`;
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

/** A picture of one document: its place in the document's list (resource `/Im<index + 1>`) and its bytes. */
class JpegImage implements PdfImage {
  constructor(
    readonly owner: object,
    readonly index: number,
    readonly data: Uint8Array,
    readonly width: number,
    readonly height: number,
    readonly components: 1 | 3,
    /** How `data` is packed: a JPEG as it is, or deflated RGB samples. */
    readonly filter: 'DCTDecode' | 'FlateDecode' = 'DCTDecode',
    /** The deflated alpha samples of a picture that is not opaque (its soft mask), or null. */
    readonly mask: Uint8Array | null = null,
  ) {}
}

/** A positive finite size (a line width, a picture's width or height). */
function positive(n: number, what: string): string {
  if (!(n > 0)) throw new RangeError(`pdf: ${what} ${n} is not positive`);
  return pdfNumber(n, what);
}

/** Content operators are joined into one flat string per this many; it keeps a long report small in memory. */
const OPS_PER_CHUNK = 64;

class Page implements PdfPage {
  /** The joined chunks of the content stream, then the operators not joined yet. */
  readonly #chunks: string[] = [];
  #ops: string[] = [`${PDF_LINE_WIDTH} w`];
  /** The pictures this page draws, by their index in the document. */
  readonly images = new Set<number>();

  constructor(
    readonly owner: object,
    readonly width: number,
    readonly height: number,
  ) {}

  text(x: number, y: number, s: string, o: { font: PdfFont; size: number; color?: PdfColor }): void {
    if (!PDF_FONTS.includes(o.font)) throw new TypeError(`pdf: ${String(o.font)} is not a font of this writer`);
    if (!(o.size > 0)) throw new RangeError(`pdf: font size ${o.size}`);
    const at = `${pdfNumber(x, 'x')} ${pdfNumber(y, 'y')}`;
    const size = pdfNumber(o.size, 'font size');
    if (s === '') return;
    const op = `BT /${FONT_RESOURCE[o.font]} ${size} Tf ${at} Td ${pdfLiteral(toWinAnsi(s).bytes)} Tj ET`;
    // A colour is set inside a saved graphics state, so later drawing keeps black.
    this.#push(o.color === undefined ? op : `q ${fillColor(o.color)} ${op} Q`);
  }

  rect(x: number, y: number, w: number, h: number, o?: { fill?: boolean; stroke?: boolean; color?: PdfColor }): void {
    const stroke = o?.stroke ?? false;
    const fill = o?.fill ?? !stroke;
    const path = [pdfNumber(x, 'x'), pdfNumber(y, 'y'), pdfNumber(w, 'width'), pdfNumber(h, 'height')].join(' ');
    const op = `${path} re ${fill && stroke ? 'B' : fill ? 'f' : stroke ? 'S' : 'n'}`;
    this.#push(o?.color === undefined ? op : `q ${fillColor(o.color)} ${op} Q`);
  }

  line(x1: number, y1: number, x2: number, y2: number, o?: { width?: number }): void {
    const path = `${pdfNumber(x1, 'x')} ${pdfNumber(y1, 'y')} m ${pdfNumber(x2, 'x')} ${pdfNumber(y2, 'y')} l S`;
    const width = o?.width ?? PDF_LINE_WIDTH;
    const w = positive(width, 'line width');
    // Another width is set inside a saved graphics state, so later strokes keep the page's width.
    this.#push(width === PDF_LINE_WIDTH ? path : `q ${w} w ${path} Q`);
  }

  image(img: PdfImage, x: number, y: number, w: number, h: number): void {
    if (!(img instanceof JpegImage) || img.owner !== this.owner) {
      throw new TypeError('pdf: the picture was not added to this document');
    }
    const box = `${positive(w, 'picture width')} 0 0 ${positive(h, 'picture height')} ${pdfNumber(x, 'x')} ${pdfNumber(y, 'y')}`;
    this.images.add(img.index);
    this.#push(`q ${box} cm /Im${img.index + 1} Do Q`);
  }

  /** The content stream: the operators, one per line. */
  content(): string {
    return [...this.#chunks, ...this.#ops].join('\n');
  }

  #push(op: string): void {
    this.#ops.push(op);
    if (this.#ops.length === OPS_PER_CHUNK) {
      this.#chunks.push(this.#ops.join('\n'));
      this.#ops = [];
    }
  }
}

const ascii = (s: string): Uint8Array => Buffer.from(s, 'latin1');

/** A PDF 1.4 document built page by page; `toBytes()` writes the whole file. */
export class PdfDocument {
  readonly #title: string | null;
  readonly #pages: Page[] = [];
  readonly #images: JpegImage[] = [];
  /** Identifies this document's pictures, so a page never draws another document's picture. */
  readonly #owner = {};

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
    const page = new Page(this.#owner, widthPt, heightPt);
    this.#pages.push(page);
    return page;
  }

  /**
   * Adds a JPEG file as a picture of this document (a copy of the bytes is kept). Throws `JpegError` for a file a PDF
   * reader could not show as an 8-bit grey or RGB picture (see `jpegInfo`), CMYK included.
   */
  addJpeg(bytes: Uint8Array): PdfImage {
    const info = jpegInfo(bytes);
    const img = new JpegImage(this.#owner, this.#images.length, bytes.slice(), info.width, info.height, info.components);
    this.#images.push(img);
    return img;
  }

  /**
   * Adds decoded pixels (8-bit RGBA, row by row from the top left, alpha not premultiplied: what the PNG decoder
   * gives) as a picture of this document. Its transparency is kept, as a soft mask, so the picture can stand on a
   * coloured band.
   */
  addPixels(image: { width: number; height: number; data: Uint8Array }): PdfImage {
    const { width, height, data } = image;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || data.byteLength !== width * height * 4) {
      throw new TypeError('pdf: the pixels are not width x height RGBA');
    }
    const rgb = new Uint8Array(width * height * 3);
    const alpha = new Uint8Array(width * height);
    let opaque = true;
    for (let i = 0, p = 0; i < data.byteLength; i += 4, p += 1) {
      rgb[p * 3] = data[i]!;
      rgb[p * 3 + 1] = data[i + 1]!;
      rgb[p * 3 + 2] = data[i + 2]!;
      alpha[p] = data[i + 3]!;
      if (alpha[p] !== 255) opaque = false;
    }
    const img = new JpegImage(this.#owner, this.#images.length, deflateSync(rgb), width, height, 3, 'FlateDecode', opaque ? null : deflateSync(alpha));
    this.#images.push(img);
    return img;
  }

  /**
   * The file. Objects: 1 catalog, 2 page tree, 3 information, 4-6 the fonts, then each page and its content stream,
   * then the pictures, then the soft masks of the pictures that have one. Writing does not change the document, so pages may be added and the file written again.
   */
  toBytes(): Uint8Array {
    if (this.#pages.length === 0) throw new Error('pdf: a document needs at least one page (no page was added)');
    const fontObject = (font: PdfFont): number => 4 + PDF_FONTS.indexOf(font);
    const firstPage = 4 + PDF_FONTS.length;
    const pageObject = (k: number): number => firstPage + 2 * k;
    const imageObject = (index: number): number => firstPage + 2 * this.#pages.length + index;
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
      const used = [...page.images].sort((a, b) => a - b);
      const xobjects = used.map((index) => `/Im${index + 1} ${imageObject(index)} 0 R`).join(' ');
      const resources = `<< /Font << ${fontDict} >>${used.length === 0 ? '' : ` /XObject << ${xobjects} >>`} >>`;
      const contents = `${pageObject(k) + 1} 0 R`;
      bodies.push(`<< /Type /Page /Parent 2 0 R /MediaBox ${box} /Resources ${resources} /Contents ${contents} >>`);
      const data = deflateSync(ascii(page.content()));
      bodies.push({ dict: `<< /Length ${data.length} /Filter /FlateDecode >>`, data });
    });
    const masked = this.#images.filter((img) => img.mask !== null);
    const maskObject = (img: JpegImage): number => imageObject(this.#images.length) + masked.indexOf(img);
    for (const img of this.#images) {
      const colorSpace = img.components === 1 ? 'DeviceGray' : 'DeviceRGB';
      const dict =
        `<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace /${colorSpace}` +
        ` /BitsPerComponent 8${img.mask === null ? '' : ` /SMask ${maskObject(img)} 0 R`} /Length ${img.data.length} /Filter /${img.filter} >>`;
      bodies.push({ dict, data: img.data });
    }
    for (const img of masked) {
      const dict =
        `<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace /DeviceGray` +
        ` /BitsPerComponent 8 /Length ${img.mask!.length} /Filter /FlateDecode >>`;
      bodies.push({ dict, data: img.mask! });
    }

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
