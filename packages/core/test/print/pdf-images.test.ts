import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import type { LabelProfile } from '@altis/shared/api/settings';
import { describe, expect, it } from 'vitest';
import { PdfDocument, buildLabelPdf } from '../../src/print/index.js';
import { JpegError } from '../../src/print/jpeg.js';
import { TINY_JPEG_BASELINE, TINY_JPEG_CMYK, TINY_JPEG_GRAY, TINY_JPEG_PROGRESSIVE } from '../fixtures/tiny.jpg.js';
import { checkPdf } from '../support/pdf-check.js';

// The PDF writer's additions for the report layout: JPEG pictures as DCTDecode image XObjects, straight lines, and the
// structural checker's report of images, XObjects, fonts and the MediaBox of every page. A document that uses neither
// pictures nor lines is written exactly as before, so the label sheets do not change.

const latin1 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('latin1');
const fromLatin1 = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, 'latin1'));

/**
 * The file with every Flate stream replaced by its inflated bytes (and without the stream /Length), cut before the
 * xref table: the whole document byte for byte, independent of the zlib build that compressed it.
 */
function canonical(bytes: Uint8Array): string {
  const s = latin1(bytes);
  const re = /<< \/Length (\d+) \/Filter \/FlateDecode >>\nstream\n/g;
  let out = '';
  let at = 0;
  for (let m = re.exec(s); m !== null; m = re.exec(s)) {
    const start = m.index + m[0].length;
    const end = start + Number(m[1]);
    out += `${s.slice(at, m.index)}<< /Filter /FlateDecode >>\nstream\n${latin1(inflateSync(bytes.subarray(start, end)))}`;
    at = end;
    re.lastIndex = end;
  }
  return out + s.slice(at, s.lastIndexOf('\nxref\n'));
}

const sha256 = (s: string): string => createHash('sha256').update(s, 'latin1').digest('hex');

describe('documents without pictures or lines', () => {
  it('a page of text and rectangles is written exactly as before', () => {
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
    expect(sha256(canonical(doc.toBytes()))).toBe('1c374e5d37d3d04c9f0b4f4dde2e17e6a6199a2af1bd36ea7e54510de72a8e85');
  });

  it('a label sheet is written exactly as before', () => {
    // A spine-and-barcode A4 sheet of 2 × 7 labels with borders, written out here so the check does not follow the seeds.
    const profile: LabelProfile = {
      id: 'spine-barcode-a4',
      name: 'Label punggung dan barkod A4 (2 × 7)',
      kind: 'spine_barcode',
      page: 'A4',
      marginMm: { t: 7, r: 7.5, b: 7, l: 7.5 },
      cols: 2,
      rows: 7,
      labelWMm: 95,
      labelHMm: 37,
      gapXMm: 5,
      gapYMm: 4,
      fontPt: 8,
      header: '',
      showLibraryName: true,
      symbology: null,
      titleMaxChars: 40,
      border: true,
    };
    const labels = Array.from({ length: 40 }, (_, i) => ({
      callNumber: i % 4 === 3 ? null : '899.221 TOE b',
      barcode: `B${String(i + 1).padStart(7, '0')}`,
      title: i % 2 ? 'Laskar Pelangi' : 'Ensiklopedia Flora dan Fauna Nusantara',
    }));
    const bytes = buildLabelPdf({ profile, labels, startPosition: 3, copies: 1, libraryName: 'Perpustakaan Contoh', symbology: 'code128' });
    expect(sha256(canonical(bytes))).toBe('546eef776989d3294a5db2f48553e839882f04737f073a203c039c60a5dde8e6');
  });
});

describe('JPEG pictures', () => {
  it('a picture is one DCTDecode image XObject holding the JPEG bytes unchanged, drawn where it was placed', () => {
    const doc = new PdfDocument();
    const page = doc.addPage(300, 200);
    const img = doc.addJpeg(TINY_JPEG_BASELINE);
    expect([img.width, img.height, img.components]).toEqual([2, 1, 3]);
    page.image(img, 10, 20, 100, 50);
    const pdf = checkPdf(doc.toBytes());
    expect(pdf.images).toHaveLength(1);
    const [image] = pdf.images;
    expect(image).toMatchObject({ filter: 'DCTDecode', width: 2, height: 1, colorSpace: 'DeviceRGB', bitsPerComponent: 8 });
    expect(Buffer.from(image!.data).equals(Buffer.from(TINY_JPEG_BASELINE))).toBe(true);
    expect(pdf.pages[0]!.images).toEqual([{ name: 'Im1', object: image!.object, x: 10, y: 20, w: 100, h: 50 }]);
    expect(pdf.pages[0]!.xobjects).toEqual(['Im1']);
  });

  it('a grey picture is DeviceGray, and a progressive one is accepted', () => {
    const doc = new PdfDocument();
    const page = doc.addPage(300, 200);
    page.image(doc.addJpeg(TINY_JPEG_GRAY), 0, 0, 20, 10);
    page.image(doc.addJpeg(TINY_JPEG_PROGRESSIVE), 0, 50, 20, 10);
    const pdf = checkPdf(doc.toBytes());
    expect(pdf.images.map((i) => [i.colorSpace, i.width, i.height])).toEqual([
      ['DeviceGray', 2, 1],
      ['DeviceRGB', 2, 1],
    ]);
    expect(pdf.pages[0]!.images.map((i) => i.name)).toEqual(['Im1', 'Im2']);
  });

  it('one picture drawn on two pages is stored once; a page without pictures names no XObject', () => {
    const doc = new PdfDocument();
    const img = doc.addJpeg(TINY_JPEG_BASELINE);
    const first = doc.addPage(100, 100);
    doc.addPage(100, 100).text(10, 10, 'no picture', { font: 'Helvetica', size: 8 });
    const third = doc.addPage(100, 100);
    first.image(img, 0, 0, 2, 1);
    third.image(img, 5, 5, 4, 2);
    const pdf = checkPdf(doc.toBytes());
    expect(pdf.images).toHaveLength(1);
    expect(pdf.pages.map((p) => p.images.length)).toEqual([1, 0, 1]);
    expect(pdf.pages.map((p) => p.xobjects)).toEqual([['Im1'], [], ['Im1']]);
  });

  it('refuses a CMYK file, and a picture of another document', () => {
    const doc = new PdfDocument();
    expect(() => doc.addJpeg(TINY_JPEG_CMYK)).toThrow(JpegError);
    const other = new PdfDocument().addJpeg(TINY_JPEG_BASELINE);
    const page = doc.addPage(100, 100);
    expect(() => page.image(other, 0, 0, 10, 10)).toThrow(TypeError);
    expect(() => page.image(doc.addJpeg(TINY_JPEG_BASELINE), 0, 0, 0, 10)).toThrow(RangeError);
  });

  it('keeps its own copy of the bytes', () => {
    const doc = new PdfDocument();
    const bytes = TINY_JPEG_BASELINE.slice();
    doc.addPage(100, 100).image(doc.addJpeg(bytes), 0, 0, 10, 5);
    bytes.fill(0);
    const [image] = checkPdf(doc.toBytes()).images;
    expect(Buffer.from(image!.data).equals(Buffer.from(TINY_JPEG_BASELINE))).toBe(true);
  });
});

describe('lines', () => {
  it('draws straight lines in the default width or in their own width, which does not leak to later strokes', () => {
    const doc = new PdfDocument();
    const page = doc.addPage(200, 200);
    page.line(10, 10, 190, 10);
    page.line(10, 20, 10, 180, { width: 1.5 });
    page.rect(30, 30, 10, 10, { stroke: true });
    const [read] = checkPdf(doc.toBytes()).pages;
    expect(read!.lines).toEqual([
      { x1: 10, y1: 10, x2: 190, y2: 10, lineWidth: 0.5 },
      { x1: 10, y1: 20, x2: 10, y2: 180, lineWidth: 1.5 },
    ]);
    expect(read!.rects).toEqual([{ x: 30, y: 30, w: 10, h: 10, paint: 'S', lineWidth: 0.5 }]);
  });

  it('refuses a non-finite coordinate or width', () => {
    const page = new PdfDocument().addPage(100, 100);
    expect(() => page.line(0, 0, Number.NaN, 1)).toThrow(RangeError);
    expect(() => page.line(0, 0, 1, 1, { width: 0 })).toThrow(RangeError);
  });
});

describe('the structural check reports fonts, MediaBox and XObjects, and catches a broken picture', () => {
  function withPicture(): string {
    const doc = new PdfDocument();
    const page = doc.addPage(595.28, 841.89);
    page.text(10, 10, 'x', { font: 'Courier', size: 8 });
    page.image(doc.addJpeg(TINY_JPEG_BASELINE), 10, 20, 100, 50);
    return latin1(doc.toBytes());
  }

  it('lists the three fonts and the MediaBox of every page', () => {
    const pdf = checkPdf(fromLatin1(withPicture()));
    expect(pdf.pages[0]!.fonts).toEqual(['Helvetica', 'Helvetica-Bold', 'Courier']);
    expect(pdf.pages[0]!.mediaBox).toEqual([0, 0, 595.28, 841.89]);
  });

  it('an image whose /Width is not the width in its JPEG header', () => {
    const broken = withPicture().replace('/Width 2 ', '/Width 3 ');
    expect(() => checkPdf(fromLatin1(broken))).toThrow(/Width/);
  });

  it('an image whose colour space does not match its JPEG components', () => {
    // Same length, so every offset stays right: the name is followed by the next key without a space.
    const broken = withPicture().replace('/ColorSpace /DeviceRGB /', '/ColorSpace /DeviceGray/');
    expect(() => checkPdf(fromLatin1(broken))).toThrow(/ColorSpace/);
  });

  it('a Do of an XObject the page does not name', () => {
    const broken = withPicture().replace('/XObject << /Im1 ', '/XObject << /Im9 ');
    expect(() => checkPdf(fromLatin1(broken))).toThrow(/Im1/);
  });
});
