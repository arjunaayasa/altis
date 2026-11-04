import { describe, expect, it } from 'vitest';
import { PdfDocument } from '../../src/print/index.js';
import { checkPdf } from '../support/pdf-check.js';

// Phase 2 spec §7, D2-16 and K13: a pure-TS PDF 1.4 writer. It uses the standard Type 1 fonts in WinAnsiEncoding,
// without embedding them, and writes a correct xref table, which test/support/pdf-check.ts verifies.

const latin1 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('latin1');
const fromLatin1 = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, 'latin1'));

function sample(): PdfDocument {
  const doc = new PdfDocument({ title: 'Label \u{6771}\u{4EAC} (A4)' });
  const a4 = doc.addPage(595.28, 841.89);
  a4.text(72, 700, 'Hello (world) \\ back', { font: 'Helvetica', size: 12 });
  a4.text(72, 680, 'Bold', { font: 'Helvetica-Bold', size: 9.5 });
  a4.rect(10, 20, 30, 40);
  a4.rect(11, 21, 31, 41, { stroke: true });
  a4.rect(12, 22, 32, 42, { fill: true, stroke: true });
  a4.rect(13, 23, 33, 43, { fill: false });
  const small = doc.addPage(200, 100);
  small.text(5, 5, 'Caf\u{E9} \u{6771} \u{20AC}', { font: 'Courier', size: 8 });
  return doc;
}

describe('PdfDocument', () => {
  it('writes a PDF 1.4 file that passes the structural check and reads back', () => {
    const bytes = sample().toBytes();
    expect(latin1(bytes.subarray(0, 9))).toBe('%PDF-1.4\n');
    const pdf = checkPdf(bytes);
    expect(pdf.pages.map((p) => [p.width, p.height])).toEqual([
      [595.28, 841.89],
      [200, 100],
    ]);
    expect(pdf.pages[0]!.texts).toEqual([
      { x: 72, y: 700, font: 'Helvetica', size: 12, text: 'Hello (world) \\ back' },
      { x: 72, y: 680, font: 'Helvetica-Bold', size: 9.5, text: 'Bold' },
    ]);
    expect(pdf.pages[0]!.rects).toEqual([
      { x: 10, y: 20, w: 30, h: 40, paint: 'f', lineWidth: 0.5 },
      { x: 11, y: 21, w: 31, h: 41, paint: 'S', lineWidth: 0.5 },
      { x: 12, y: 22, w: 32, h: 42, paint: 'B', lineWidth: 0.5 },
      { x: 13, y: 23, w: 33, h: 43, paint: 'n', lineWidth: 0.5 },
    ]);
    expect(pdf.pages[1]!.texts).toEqual([{ x: 5, y: 5, font: 'Courier', size: 8, text: 'Caf\u{E9} ? \u{20AC}' }]);
    expect(pdf.title).toBe('Label \u{6771}\u{4EAC} (A4)');
    expect(pdf.producer).toBe('ALTIS');
  });

  it('compresses the content streams and embeds no font', () => {
    const text = latin1(sample().toBytes());
    expect(text).toContain('/Filter /FlateDecode');
    expect(text).not.toMatch(/FontFile|FontDescriptor/);
    for (const font of ['Helvetica', 'Helvetica-Bold', 'Courier']) expect(text).toContain(`/BaseFont /${font} `);
  });

  it('is deterministic and can be written again after more pages', () => {
    expect(sample().toBytes()).toEqual(sample().toBytes());
    const doc = sample();
    expect(checkPdf(doc.toBytes()).pages).toHaveLength(2);
    doc.addPage(100, 100).text(1, 1, 'x', { font: 'Helvetica', size: 5 });
    expect(checkPdf(doc.toBytes()).pages).toHaveLength(3);
  });

  it('writes numbers with at most three decimals and never -0, and draws nothing for an empty text', () => {
    const doc = new PdfDocument();
    const page = doc.addPage(100, 100);
    page.rect(1 / 3, -0, 2 / 3, 1e-9);
    page.text(1, 1, '', { font: 'Helvetica', size: 5 });
    const [read] = checkPdf(doc.toBytes()).pages;
    expect(read!.rects).toEqual([{ x: 0.333, y: 0, w: 0.667, h: 0, paint: 'f', lineWidth: 0.5 }]);
    expect(read!.texts).toEqual([]);
    expect(read!.content).not.toMatch(/-0(?![.\d])|e[+-]?\d/);
  });

  it('leaves the document information without a title when none is given', () => {
    const doc = new PdfDocument();
    doc.addPage(100, 100);
    const pdf = checkPdf(doc.toBytes());
    expect(pdf.title).toBeNull();
    expect(pdf.pages[0]!.rects).toEqual([]);
  });

  it('refuses a document without pages, a page size outside 3-14 400 pt and non-finite numbers', () => {
    expect(() => new PdfDocument().toBytes()).toThrow(/no page/);
    const doc = new PdfDocument();
    for (const [w, h] of [
      [0, 100],
      [100, 2],
      [14_401, 100],
      [Number.NaN, 100],
      [100, Number.POSITIVE_INFINITY],
    ] as const) {
      expect(() => doc.addPage(w, h)).toThrow(RangeError);
    }
    const page = doc.addPage(100, 100);
    expect(() => page.rect(Number.NaN, 0, 1, 1)).toThrow(RangeError);
    expect(() => page.rect(0, 0, Number.POSITIVE_INFINITY, 1)).toThrow(RangeError);
    expect(() => page.rect(0, 0, 1e10, 1)).toThrow(RangeError);
    expect(() => page.text(0, Number.NaN, 'x', { font: 'Helvetica', size: 5 })).toThrow(RangeError);
    expect(() => page.text(0, 0, 'x', { font: 'Helvetica', size: 0 })).toThrow(RangeError);
    expect(() => page.text(0, 0, 'x', { font: 'Times-Roman' as 'Helvetica', size: 5 })).toThrow(TypeError);
  });
});

describe('the structural check (pdf-check) catches a broken file', () => {
  const good = latin1(sample().toBytes());
  // The table itself, not the `startxref` keyword after it.
  const xrefAt = good.lastIndexOf('\nxref\n') + 1;

  it('passes the untouched file', () => {
    expect(() => checkPdf(fromLatin1(good))).not.toThrow();
  });

  it('an xref offset that does not point at its object', () => {
    const entry1 = good.indexOf('\n', good.indexOf('\n', xrefAt + 5) + 1) + 1;
    const offset = Number(good.slice(entry1, entry1 + 10));
    const broken = good.slice(0, entry1) + String(offset + 1).padStart(10, '0') + good.slice(entry1 + 10);
    expect(() => checkPdf(fromLatin1(broken))).toThrow(/xref entry 1/);
  });

  it('a wrong /Size', () => {
    const broken = good.replace(/\/Size (\d+)/, (_, n: string) => `/Size ${Number(n) + 1}`);
    expect(() => checkPdf(fromLatin1(broken))).toThrow();
  });

  it('a startxref that does not point at xref', () => {
    const broken = good.replace(/startxref\n(\d+)/, (_, n: string) => `startxref\n${Number(n) - 1}`);
    expect(() => checkPdf(fromLatin1(broken))).toThrow(/startxref/);
  });

  it('a stream /Length that does not end at endstream', () => {
    const broken = good.replace(/\/Length (\d+)/, (_, n: string) => `/Length ${Number(n) + 1}`);
    expect(() => checkPdf(fromLatin1(broken))).toThrow();
  });
});
