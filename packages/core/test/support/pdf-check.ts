// Test-only structural checker of the PDFs src/print writes (Phase 2 Task 7, acceptance K13). It walks the file object
// by object, as a strict reader would. It checks:
// - the header and that every stream's /Length ends exactly at `endstream`;
// - that every xref entry points at its own `n 0 obj` and that /Size counts the objects;
// - that `startxref` points at `xref`;
// - the catalog → pages → page → font/XObject/content tree;
// - every image XObject: a DCTDecode JPEG whose /Width, /Height and /ColorSpace match its own JPEG frame header (read
//   here independently of src/print/jpeg.ts) and which ends with the JPEG end marker.
// It then reads each page's content stream back into rectangles, lines, text runs and picture placements with absolute
// positions, so a test can check where things were drawn. The writer emits a small fixed set of operators, and
// anything else is refused here. It is not a general PDF parser.

import { inflateSync } from 'node:zlib';

/** A rectangle path and the operator that painted it (`f` fill, `S` stroke, `B` both, `n` none). */
export interface PdfRect {
  x: number;
  y: number;
  w: number;
  h: number;
  paint: 'f' | 'S' | 'B' | 'n';
  /** The line width in effect when it was painted. */
  lineWidth: number;
}

/** A stroked straight line (`m` … `l` … `S`) and the line width in effect when it was painted. */
export interface PdfLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  lineWidth: number;
}

/** One `Do` of an image XObject: its resource name, its object number and the box it fills (absolute). */
export interface PdfImagePlacement {
  name: string;
  object: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** An image XObject of the file. */
export interface CheckedImage {
  object: number;
  width: number;
  height: number;
  colorSpace: 'DeviceGray' | 'DeviceRGB';
  bitsPerComponent: number;
  filter: 'DCTDecode';
  /** The stream bytes: the JPEG file. */
  data: Uint8Array;
}

/** One `Tj`: its start point (absolute), its font's BaseFont, its size and its text decoded from WinAnsi. */
export interface PdfText {
  x: number;
  y: number;
  font: string;
  size: number;
  text: string;
}

export interface CheckedPage {
  width: number;
  height: number;
  /** The page's /MediaBox as written: [0, 0, width, height]. */
  mediaBox: number[];
  /** The BaseFont of each font resource of the page, in resource order. */
  fonts: string[];
  /** The resource names of the page's XObjects (image XObjects only). */
  xobjects: string[];
  rects: PdfRect[];
  lines: PdfLine[];
  texts: PdfText[];
  images: PdfImagePlacement[];
  /** The decoded content stream. */
  content: string;
}

export interface CheckedPdf {
  /** The number of objects (xref /Size − 1). */
  objects: number;
  pages: CheckedPage[];
  /** Every image XObject of the file, in object order. */
  images: CheckedImage[];
  title: string | null;
  producer: string | null;
}

/** The 14 standard Type 1 fonts every PDF reader has. */
const STANDARD_FONTS = new Set([
  'Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic', 'Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique',
  'Helvetica-BoldOblique', 'Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique', 'Symbol', 'ZapfDingbats',
]);

type PdfValue =
  | { t: 'num'; v: number }
  | { t: 'name'; v: string }
  | { t: 'str'; v: number[] }
  | { t: 'ref'; v: number }
  | { t: 'arr'; v: PdfValue[] }
  | { t: 'dict'; v: Map<string, PdfValue> }
  | { t: 'bool'; v: boolean }
  | { t: 'null' }
  | { t: 'op'; v: string };

const WHITE = ' \t\r\n\f\0';
const DELIMITERS = '()<>[]{}/%';

/** A reader of PDF tokens and values over a latin1 string (one character per byte). */
class Lexer {
  i = 0;
  constructor(private readonly s: string) {}

  done(): boolean {
    this.skipWhite();
    return this.i >= this.s.length;
  }

  private skipWhite(): void {
    while (this.i < this.s.length && WHITE.includes(this.s[this.i]!)) this.i++;
  }

  private regular(): string {
    const start = this.i;
    while (this.i < this.s.length && !WHITE.includes(this.s[this.i]!) && !DELIMITERS.includes(this.s[this.i]!)) this.i++;
    return this.s.slice(start, this.i);
  }

  /** The next value; with `ops`, a bare word other than true/false/null is an operator (content streams). */
  value(ops = false): PdfValue {
    this.skipWhite();
    const c = this.s[this.i];
    if (c === undefined) throw new Error('unexpected end');
    if (c === '<' && this.s[this.i + 1] === '<') return this.dict(ops);
    if (c === '<') return this.hex();
    if (c === '[') return this.array(ops);
    if (c === '(') return this.literal();
    if (c === '/') {
      this.i++;
      return { t: 'name', v: this.regular() };
    }
    const word = this.regular();
    if (word === '') throw new Error(`unexpected ${JSON.stringify(c)} at ${this.i}`);
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(word)) {
      const save = this.i;
      if (!ops && /^\d+$/.test(word)) {
        this.skipWhite();
        const gen = this.regular();
        this.skipWhite();
        if (/^\d+$/.test(gen) && this.regular() === 'R') return { t: 'ref', v: Number(word) };
        this.i = save;
      }
      return { t: 'num', v: Number(word) };
    }
    if (word === 'true' || word === 'false') return { t: 'bool', v: word === 'true' };
    if (word === 'null') return { t: 'null' };
    if (ops) return { t: 'op', v: word };
    throw new Error(`unexpected word ${JSON.stringify(word)}`);
  }

  private dict(ops: boolean): PdfValue {
    this.i += 2;
    const map = new Map<string, PdfValue>();
    for (;;) {
      this.skipWhite();
      if (this.s.startsWith('>>', this.i)) {
        this.i += 2;
        return { t: 'dict', v: map };
      }
      const key = this.value(ops);
      if (key.t !== 'name') throw new Error('a dictionary key is not a name');
      if (map.has(key.v)) throw new Error(`duplicate key /${key.v}`);
      map.set(key.v, this.value(ops));
    }
  }

  private array(ops: boolean): PdfValue {
    this.i++;
    const items: PdfValue[] = [];
    for (;;) {
      this.skipWhite();
      if (this.s[this.i] === ']') {
        this.i++;
        return { t: 'arr', v: items };
      }
      items.push(this.value(ops));
    }
  }

  private hex(): PdfValue {
    const end = this.s.indexOf('>', this.i);
    if (end < 0) throw new Error('unterminated hex string');
    const digits = this.s.slice(this.i + 1, end).replace(/\s+/g, '');
    if (!/^[0-9A-Fa-f]*$/.test(digits)) throw new Error('bad hex string');
    this.i = end + 1;
    const bytes: number[] = [];
    for (let k = 0; k < digits.length; k += 2) bytes.push(parseInt(digits.slice(k, k + 2).padEnd(2, '0'), 16));
    return { t: 'str', v: bytes };
  }

  private literal(): PdfValue {
    this.i++;
    const bytes: number[] = [];
    let depth = 0;
    for (;;) {
      const c = this.s[this.i++];
      if (c === undefined) throw new Error('unterminated string');
      if (c === '\\') {
        const e = this.s[this.i++];
        const simple: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12, '(': 40, ')': 41, '\\': 92 };
        if (e !== undefined && e in simple) bytes.push(simple[e]!);
        else if (e !== undefined && /[0-7]/.test(e)) {
          let oct = e;
          while (oct.length < 3 && /[0-7]/.test(this.s[this.i] ?? '')) oct += this.s[this.i++];
          bytes.push(parseInt(oct, 8) & 0xff);
        } else throw new Error(`bad escape \\${e ?? ''}`);
      } else if (c === '(') {
        depth++;
        bytes.push(40);
      } else if (c === ')') {
        if (depth === 0) return { t: 'str', v: bytes };
        depth--;
        bytes.push(41);
      } else bytes.push(c.charCodeAt(0));
    }
  }
}

function parseValue(text: string): PdfValue {
  const lexer = new Lexer(text);
  const value = lexer.value();
  if (!lexer.done()) throw new Error('trailing data after a value');
  return value;
}

function dictOf(value: PdfValue | undefined, what: string): Map<string, PdfValue> {
  if (value?.t !== 'dict') throw new Error(`${what} is not a dictionary`);
  return value.v;
}

function num(d: Map<string, PdfValue>, key: string, what: string): number {
  const v = d.get(key);
  if (v?.t !== 'num') throw new Error(`${what} /${key} is not a number`);
  return v.v;
}

function name(d: Map<string, PdfValue>, key: string, what: string): string {
  const v = d.get(key);
  if (v?.t !== 'name') throw new Error(`${what} /${key} is not a name`);
  return v.v;
}

function ref(d: Map<string, PdfValue>, key: string, what: string): number {
  const v = d.get(key);
  if (v?.t !== 'ref') throw new Error(`${what} /${key} is not a reference`);
  return v.v;
}

/** A text string of the document information: UTF-16BE with a BOM, else PDFDocEncoding (read as latin1 here). */
function textString(bytes: number[]): string {
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    let s = '';
    for (let k = 2; k + 1 < bytes.length; k += 2) s += String.fromCharCode((bytes[k]! << 8) | bytes[k + 1]!);
    return s;
  }
  return String.fromCharCode(...bytes);
}

const WINDOWS_1252 = new TextDecoder('windows-1252');

/** Decodes a WinAnsi string (the 1252 code page); a byte WinAnsi leaves undefined is refused. */
function winAnsiText(bytes: number[]): string {
  for (const b of bytes) {
    if (b < 0x20 || b === 0x7f || [0x81, 0x8d, 0x8f, 0x90, 0x9d].includes(b)) throw new Error(`byte ${b} is not WinAnsi`);
  }
  return WINDOWS_1252.decode(Uint8Array.from(bytes));
}

interface RawObject {
  offset: number;
  value: PdfValue;
  stream: Uint8Array | null;
}

const STREAM_MARK = '\nstream\n';
const STREAM_END = '\nendstream\nendobj\n';
const OBJ_END = '\nendobj\n';

/** Walks the objects from the header to `xref`, checking each stream's /Length. */
function readObjects(bytes: Uint8Array, s: string): { objects: Map<number, RawObject>; xrefAt: number } {
  if (!s.startsWith('%PDF-1.4\n')) throw new Error('no %PDF-1.4 header');
  const binaryLine = /^%([\x80-\xff]{4,})\n/.exec(s.slice(9, 40));
  if (!binaryLine) throw new Error('no binary comment line after the header');
  let pos = 9 + binaryLine[0].length;
  const objects = new Map<number, RawObject>();
  while (!s.startsWith('xref\n', pos)) {
    const head = /^(\d+) 0 obj\n/.exec(s.slice(pos, pos + 24));
    if (!head) throw new Error(`no object or xref at byte ${pos}`);
    const n = Number(head[1]);
    if (objects.has(n)) throw new Error(`object ${n} twice`);
    const bodyStart = pos + head[0].length;
    const objEnd = s.indexOf(OBJ_END, bodyStart);
    const streamAt = s.indexOf(STREAM_MARK, bodyStart);
    if (streamAt >= 0 && (objEnd < 0 || streamAt < objEnd)) {
      const value = parseValue(s.slice(bodyStart, streamAt));
      const length = num(dictOf(value, `object ${n}`), 'Length', `object ${n}`);
      const dataStart = streamAt + STREAM_MARK.length;
      if (!s.startsWith(STREAM_END, dataStart + length)) throw new Error(`object ${n}: /Length ${length} does not end at endstream`);
      objects.set(n, { offset: pos, value, stream: bytes.subarray(dataStart, dataStart + length) });
      pos = dataStart + length + STREAM_END.length;
    } else {
      if (objEnd < 0) throw new Error(`object ${n} has no endobj`);
      objects.set(n, { offset: pos, value: parseValue(s.slice(bodyStart, objEnd)), stream: null });
      pos = objEnd + OBJ_END.length;
    }
  }
  return { objects, xrefAt: pos };
}

/** Checks the xref table, the trailer and `startxref`; answers the trailer dictionary. */
function checkXref(s: string, objects: Map<number, RawObject>, xrefAt: number): Map<string, PdfValue> {
  const head = /^xref\n0 (\d+)\n/.exec(s.slice(xrefAt, xrefAt + 32));
  if (!head) throw new Error('no xref subsection header');
  const size = Number(head[1]);
  const entriesAt = xrefAt + head[0].length;
  for (let n = 0; n < size; n++) {
    const entry = s.slice(entriesAt + 20 * n, entriesAt + 20 * (n + 1));
    const m = /^(\d{10}) (\d{5}) ([fn])(?: \r| \n|\r\n)$/.exec(entry);
    if (!m) throw new Error(`xref entry ${n} is not 20 bytes of the form "oooooooooo ggggg n"`);
    if (n === 0) {
      if (entry.slice(0, 18) !== '0000000000 65535 f') throw new Error('xref entry 0 is not the free list head');
      continue;
    }
    const offset = Number(m[1]);
    if (m[2] !== '00000' || m[3] !== 'n') throw new Error(`xref entry ${n} is not in use with generation 0`);
    if (!s.startsWith(`${n} 0 obj\n`, offset)) throw new Error(`xref entry ${n} (${offset}) does not point at "${n} 0 obj"`);
    if (objects.get(n)?.offset !== offset) throw new Error(`xref entry ${n} is not object ${n}'s offset`);
  }
  if (objects.size !== size - 1) throw new Error(`/Size ${size} for ${objects.size} objects`);
  const tail = s.slice(entriesAt + 20 * size);
  const m = /^trailer\n([\s\S]*)\nstartxref\n(\d+)\n%%EOF\n?$/.exec(tail);
  if (!m) throw new Error('no trailer, startxref and %%EOF after the xref table');
  if (Number(m[2]) !== xrefAt) throw new Error(`startxref ${m[2]} does not point at xref (${xrefAt})`);
  const trailer = dictOf(parseValue(m[1]!), 'the trailer');
  if (num(trailer, 'Size', 'the trailer') !== size) throw new Error('trailer /Size is not the xref size');
  return trailer;
}

const CONTENT_OPERANDS: Readonly<Record<string, readonly PdfValue['t'][]>> = {
  w: ['num'],
  re: ['num', 'num', 'num', 'num'],
  m: ['num', 'num'],
  l: ['num', 'num'],
  f: [],
  S: [],
  B: [],
  n: [],
  q: [],
  Q: [],
  cm: ['num', 'num', 'num', 'num', 'num', 'num'],
  Do: ['name'],
  BT: [],
  ET: [],
  Tf: ['name', 'num'],
  Td: ['num', 'num'],
  Tj: ['str'],
};

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** `m` × `ctm` (PDF row-vector convention): the CTM after `m cm`. */
function concat(m: Matrix, ctm: Matrix): Matrix {
  const [a, b, c, d, e, f] = m;
  const [A, B, C, D, E, F] = ctm;
  return [a * A + b * C, a * B + b * D, c * A + d * C, c * B + d * D, e * A + f * C + E, e * B + f * D + F];
}

const isIdentity = (m: Matrix): boolean => m.every((v, k) => v === IDENTITY[k]);

interface ContentResources {
  fonts: Map<string, string>;
  /** XObject resource name → object number. */
  xobjects: Map<string, number>;
}

/** Reads a content stream back into rectangles, lines, text runs and picture placements (absolute positions). */
function readContent(
  content: string,
  resources: ContentResources,
): { rects: PdfRect[]; lines: PdfLine[]; texts: PdfText[]; images: PdfImagePlacement[] } {
  const lexer = new Lexer(content);
  const rects: PdfRect[] = [];
  const lines: PdfLine[] = [];
  const texts: PdfText[] = [];
  const images: PdfImagePlacement[] = [];
  let operands: PdfValue[] = [];
  let pending: Omit<PdfRect, 'paint' | 'lineWidth'>[] = [];
  let segments: Omit<PdfLine, 'lineWidth'>[] = [];
  let point: [number, number] | null = null;
  let lineWidth = 1;
  let ctm: Matrix = IDENTITY;
  const saved: { lineWidth: number; ctm: Matrix }[] = [];
  let inText = false;
  let font: string | null = null;
  let size = 0;
  let lineX = 0;
  let lineY = 0;
  /** Paths and text are drawn in page space only; the writer transforms nothing but pictures. */
  const pageSpace = (op: string): void => {
    if (!isIdentity(ctm)) throw new Error(`${op} under a transformed CTM`);
  };
  while (!lexer.done()) {
    const token = lexer.value(true);
    if (token.t !== 'op') {
      operands.push(token);
      continue;
    }
    const want = CONTENT_OPERANDS[token.v];
    if (want === undefined) throw new Error(`unexpected operator ${token.v}`);
    if (operands.length !== want.length || operands.some((o, k) => o.t !== want[k])) throw new Error(`bad operands for ${token.v}`);
    const nums = operands.map((o) => (o.t === 'num' ? o.v : NaN));
    if (inText && ['re', 'm', 'l', 'f', 'S', 'B', 'n', 'q', 'Q', 'cm', 'Do'].includes(token.v)) {
      throw new Error(`${token.v} inside BT`);
    }
    switch (token.v) {
      case 'w':
        lineWidth = nums[0]!;
        break;
      case 're':
        pageSpace('re');
        pending.push({ x: nums[0]!, y: nums[1]!, w: nums[2]!, h: nums[3]! });
        break;
      case 'm':
        pageSpace('m');
        point = [nums[0]!, nums[1]!];
        break;
      case 'l':
        if (point === null) throw new Error('l without a current point');
        segments.push({ x1: point[0], y1: point[1], x2: nums[0]!, y2: nums[1]! });
        point = [nums[0]!, nums[1]!];
        break;
      case 'f':
      case 'S':
      case 'B':
      case 'n':
        if (pending.length === 0 && segments.length === 0) throw new Error(`${token.v} without a path`);
        if (segments.length > 0 && token.v !== 'S') throw new Error(`${token.v} of a line path`);
        for (const r of pending) rects.push({ ...r, paint: token.v, lineWidth });
        for (const s of segments) lines.push({ ...s, lineWidth });
        pending = [];
        segments = [];
        point = null;
        break;
      case 'q':
        if (pending.length > 0 || point !== null) throw new Error('q inside a path');
        saved.push({ lineWidth, ctm });
        break;
      case 'Q': {
        const state = saved.pop();
        if (state === undefined) throw new Error('Q without q');
        if (pending.length > 0 || point !== null) throw new Error('Q inside a path');
        ({ lineWidth, ctm } = state);
        break;
      }
      case 'cm':
        if (saved.length === 0) throw new Error('cm outside a saved graphics state');
        ctm = concat(nums as Matrix, ctm);
        break;
      case 'Do': {
        const resource = (operands[0] as { v: string }).v;
        const object = resources.xobjects.get(resource);
        if (object === undefined) throw new Error(`XObject /${resource} is not a page resource`);
        const [a, b, c, d, e, f] = ctm;
        if (b !== 0 || c !== 0 || !(a > 0) || !(d > 0)) throw new Error(`/${resource} is drawn rotated, skewed or flipped`);
        images.push({ name: resource, object, x: e, y: f, w: a, h: d });
        break;
      }
      case 'BT':
        if (inText) throw new Error('nested BT');
        pageSpace('BT');
        inText = true;
        font = null;
        lineX = 0;
        lineY = 0;
        break;
      case 'ET':
        if (!inText) throw new Error('ET without BT');
        inText = false;
        break;
      case 'Tf': {
        const resource = (operands[0] as { v: string }).v;
        const base = resources.fonts.get(resource);
        if (base === undefined) throw new Error(`font /${resource} is not a page resource`);
        font = base;
        size = nums[1]!;
        break;
      }
      case 'Td':
        if (!inText) throw new Error('Td outside BT');
        lineX += nums[0]!;
        lineY += nums[1]!;
        break;
      case 'Tj':
        if (!inText || font === null) throw new Error('Tj outside BT or without a font');
        texts.push({ x: lineX, y: lineY, font, size, text: winAnsiText((operands[0] as { v: number[] }).v) });
        break;
    }
    operands = [];
  }
  if (operands.length > 0 || pending.length > 0 || point !== null || inText || saved.length > 0) {
    throw new Error('the content stream ends in the middle');
  }
  return { rects, lines, texts, images };
}

/** The frame header of a JPEG file: walks the marker segments from the start to the first SOF0-SOF2. */
function jpegFrame(data: Uint8Array): { width: number; height: number; components: number } {
  if (data[0] !== 0xff || data[1] !== 0xd8) throw new Error('the image data is not a JPEG file');
  if (data[data.length - 2] !== 0xff || data[data.length - 1] !== 0xd9) throw new Error('the JPEG data does not end with EOI');
  let p = 2;
  while (p + 4 <= data.length) {
    if (data[p] !== 0xff) throw new Error(`no JPEG marker at byte ${p}`);
    const marker = data[p + 1]!;
    if (marker === 0xff) {
      p++;
      continue;
    }
    if (marker >= 0xc0 && marker <= 0xc2) {
      return { height: (data[p + 5]! << 8) | data[p + 6]!, width: (data[p + 7]! << 8) | data[p + 8]!, components: data[p + 9]! };
    }
    if (marker === 0xda) break;
    p += 2 + ((data[p + 2]! << 8) | data[p + 3]!);
  }
  throw new Error('no JPEG frame header before the first scan');
}

/** Checks an image XObject against the JPEG it holds. */
function checkImage(n: number, o: RawObject): CheckedImage {
  const what = `image object ${n}`;
  const d = dictOf(o.value, what);
  if (o.stream === null) throw new Error(`${what} is not a stream`);
  if (name(d, 'Type', what) !== 'XObject' || name(d, 'Subtype', what) !== 'Image') throw new Error(`${what} is not an image XObject`);
  const filter = name(d, 'Filter', what);
  if (filter !== 'DCTDecode') throw new Error(`${what} /Filter /${filter} is not /DCTDecode`);
  const width = num(d, 'Width', what);
  const height = num(d, 'Height', what);
  const colorSpace = name(d, 'ColorSpace', what);
  const bitsPerComponent = num(d, 'BitsPerComponent', what);
  if (bitsPerComponent !== 8) throw new Error(`${what} /BitsPerComponent ${bitsPerComponent}`);
  if (colorSpace !== 'DeviceGray' && colorSpace !== 'DeviceRGB') throw new Error(`${what} /ColorSpace /${colorSpace}`);
  const frame = jpegFrame(o.stream);
  if (width !== frame.width) throw new Error(`${what} /Width ${width} is not the JPEG width ${frame.width}`);
  if (height !== frame.height) throw new Error(`${what} /Height ${height} is not the JPEG height ${frame.height}`);
  if (frame.components !== (colorSpace === 'DeviceGray' ? 1 : 3)) {
    throw new Error(`${what} /ColorSpace /${colorSpace} does not match ${frame.components} JPEG components`);
  }
  return { object: n, width, height, colorSpace, bitsPerComponent, filter, data: o.stream };
}

/**
 * Checks `bytes` as a PDF 1.4 file of the shape src/print writes and reads it back; throws an Error naming the first
 * problem.
 */
export function checkPdf(bytes: Uint8Array): CheckedPdf {
  const s = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1');
  const { objects, xrefAt } = readObjects(bytes, s);
  const trailer = checkXref(s, objects, xrefAt);
  const get = (n: number, what: string): RawObject => {
    const o = objects.get(n);
    if (o === undefined) throw new Error(`${what} ${n} 0 R does not exist`);
    return o;
  };
  const catalog = dictOf(get(ref(trailer, 'Root', 'the trailer'), 'the root').value, 'the catalog');
  if (name(catalog, 'Type', 'the catalog') !== 'Catalog') throw new Error('the root is not a /Catalog');
  const pagesRef = ref(catalog, 'Pages', 'the catalog');
  const pagesDict = dictOf(get(pagesRef, 'the page tree').value, 'the page tree');
  if (name(pagesDict, 'Type', 'the page tree') !== 'Pages') throw new Error('the page tree is not /Pages');
  const kids = pagesDict.get('Kids');
  if (kids?.t !== 'arr') throw new Error('the page tree has no /Kids');
  if (num(pagesDict, 'Count', 'the page tree') !== kids.v.length) throw new Error('/Count is not the number of /Kids');
  const images = new Map<number, CheckedImage>();

  const pages = kids.v.map((kid, k): CheckedPage => {
    if (kid.t !== 'ref') throw new Error(`kid ${k} is not a reference`);
    const page = dictOf(get(kid.v, 'page').value, `page ${k}`);
    if (name(page, 'Type', `page ${k}`) !== 'Page') throw new Error(`page ${k} is not a /Page`);
    if (ref(page, 'Parent', `page ${k}`) !== pagesRef) throw new Error(`page ${k} /Parent is not the page tree`);
    const box = page.get('MediaBox');
    if (box?.t !== 'arr' || box.v.length !== 4 || box.v.some((v) => v.t !== 'num')) throw new Error(`page ${k} /MediaBox`);
    const mediaBox = box.v.map((v) => (v as { v: number }).v);
    const [x0, y0, x1, y1] = mediaBox as [number, number, number, number];
    if (x0 !== 0 || y0 !== 0 || !(x1 > 0) || !(y1 > 0)) throw new Error(`page ${k} /MediaBox is not [0 0 w h]`);
    const resources = dictOf(page.get('Resources'), `page ${k} /Resources`);
    for (const key of resources.keys()) {
      if (key !== 'Font' && key !== 'XObject') throw new Error(`page ${k} /Resources /${key} is not a font or an XObject`);
    }
    const xobjects = new Map<string, number>();
    if (resources.has('XObject')) {
      for (const [resource, xref] of dictOf(resources.get('XObject'), `page ${k} /XObject`)) {
        if (xref.t !== 'ref') throw new Error(`XObject /${resource} is not a reference`);
        const xobject = get(xref.v, 'XObject');
        if (!images.has(xref.v)) images.set(xref.v, checkImage(xref.v, xobject));
        xobjects.set(resource, xref.v);
      }
    }
    const fonts = new Map<string, string>();
    for (const [resource, fontRef] of dictOf(resources.get('Font'), `page ${k} /Font`)) {
      if (fontRef.t !== 'ref') throw new Error(`font /${resource} is not a reference`);
      const font = dictOf(get(fontRef.v, 'font').value, `font /${resource}`);
      if (name(font, 'Type', 'a font') !== 'Font' || name(font, 'Subtype', 'a font') !== 'Type1') throw new Error('not a Type1 font');
      const base = name(font, 'BaseFont', 'a font');
      if (!STANDARD_FONTS.has(base)) throw new Error(`/BaseFont /${base} is not a standard font`);
      if (name(font, 'Encoding', 'a font') !== 'WinAnsiEncoding') throw new Error(`/${base} is not WinAnsiEncoding`);
      if (font.has('FontFile') || font.has('FontDescriptor')) throw new Error(`/${base} is embedded`);
      fonts.set(resource, base);
    }
    const contents = get(ref(page, 'Contents', `page ${k}`), 'contents');
    if (contents.stream === null) throw new Error(`page ${k} /Contents is not a stream`);
    const filter = dictOf(contents.value, 'contents').get('Filter');
    let data: Uint8Array = contents.stream;
    if (filter !== undefined) {
      if (filter.t !== 'name' || filter.v !== 'FlateDecode') throw new Error('a content filter other than /FlateDecode');
      data = inflateSync(data);
    }
    const content = Buffer.from(data).toString('latin1');
    return {
      width: x1,
      height: y1,
      mediaBox,
      fonts: [...fonts.values()],
      xobjects: [...xobjects.keys()],
      content,
      ...readContent(content, { fonts, xobjects }),
    };
  });
  // Image XObjects no page draws are checked too.
  for (const [n, o] of objects) {
    if (images.has(n) || o.stream === null) continue;
    const d = dictOf(o.value, `object ${n}`);
    if (d.get('Subtype')?.t === 'name' && (d.get('Subtype') as { v: string }).v === 'Image') images.set(n, checkImage(n, o));
  }

  let title: string | null = null;
  let producer: string | null = null;
  if (trailer.has('Info')) {
    const info = dictOf(get(ref(trailer, 'Info', 'the trailer'), 'info').value, 'the document information');
    const t = info.get('Title');
    const p = info.get('Producer');
    if (t?.t === 'str') title = textString(t.v);
    if (p?.t === 'str') producer = textString(p.v);
  }
  return { objects: objects.size, pages, images: [...images.values()].sort((a, b) => a.object - b.object), title, producer };
}
