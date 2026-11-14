import { describe, expect, it } from 'vitest';
import { textWidth, toWinAnsi } from '../../src/print/index.js';
import { JpegError } from '../../src/print/jpeg.js';
import { PdfLayout } from '../../src/print/layout.js';
import type { PdfCell, PdfLayoutOptions, PdfTableColumn } from '../../src/print/layout.js';
import { TINY_JPEG_BASELINE, TINY_JPEG_CMYK } from '../fixtures/tiny.jpg.js';
import { checkPdf } from '../support/pdf-check.js';
import type { CheckedPage, CheckedPdf, PdfText } from '../support/pdf-check.js';

// The paginated PDF layout of the report exports and the accreditation documents: wrapped paragraphs, tables that split
// their width by weight and repeat their header row on every page, a header and an "X/Y" footer on every page,
// signature blocks, checklists, JPEG pictures, and the marking of table rows that lost characters to WinAnsi.

const PT = 72 / 25.4;
/** Widths are compared exactly (up to float noise); positions up to the 0.001 pt the writer rounds coordinates to. */
const EPS = 1e-6;
const POS = 1e-3;
const NOTE = 'teks non-Latin: lihat XLSX/CSV';
const A4 = { w: 210 * PT, h: 297 * PT };
const MARGIN = 15 * PT;
const PRINTABLE = A4.w - 2 * MARGIN;

const make = (o: Partial<PdfLayoutOptions> = {}): PdfLayout =>
  new PdfLayout({ paper: 'A4', orientation: 'portrait', nonLatinNote: NOTE, ...o });

const textsOf = (page: CheckedPage): string[] => page.texts.map((t) => t.text);
const allTexts = (pdf: CheckedPdf): string[] => pdf.pages.flatMap(textsOf);
const count = (list: readonly string[], s: string): number => list.filter((t) => t === s).length;
const width = (t: PdfText): number => textWidth(t.text, t.font as 'Helvetica', t.size);

/** Every text run of every page lies inside the page minus its margins. */
function expectInsideMargins(pdf: CheckedPdf, margin = MARGIN): void {
  for (const [k, page] of pdf.pages.entries()) {
    for (const t of page.texts) {
      const where = `page ${k + 1} "${t.text}"`;
      expect(t.x, where).toBeGreaterThanOrEqual(margin - POS);
      expect(t.x + width(t), where).toBeLessThanOrEqual(page.width - margin + POS);
      expect(t.y, where).toBeGreaterThanOrEqual(margin - POS);
      expect(t.y + t.size, where).toBeLessThanOrEqual(page.height - margin + POS);
    }
  }
}

/** The page (0-based) whose texts hold `s`; fails when none or several do. */
function pageOf(pdf: CheckedPdf, s: string): number {
  const pages = pdf.pages.flatMap((p, k) => (textsOf(p).includes(s) ? [k] : []));
  expect(pages, `pages holding "${s}"`).toHaveLength(1);
  return pages[0]!;
}

const WORDS = ['perpustakaan', 'sekolah', 'koleksi', 'Pérez', 'akreditasi', 'ensiklopedia', 'Nusantara', 'buku'];

function* titleRows(n: number): Generator<readonly PdfCell[]> {
  for (let i = 1; i <= n; i++) {
    const words = Array.from({ length: 2 + ((i * 7) % 23) }, (_, k) => WORDS[(i + k) % WORDS.length]!);
    yield [i, `Judul uji ${i} ${words.join(' ')}`, i % 5 === 0 ? null : (i % 4) + 1];
  }
}

const TITLE_COLUMNS: readonly PdfTableColumn[] = [
  { header: 'Nomor', weight: 1, align: 'right' },
  { header: 'Judul', weight: 6 },
  { header: 'Eksemplar', weight: 1.5, align: 'center' },
];

describe('PdfLayout tables', () => {
  it('a 120-row table spans pages with the header row first on each page and "halaman X/Y" footers', () => {
    const layout = make({
      title: 'Daftar judul uji',
      header: { left: 'Perpustakaan Contoh · Daftar Judul', right: 'per 2026-11-01' },
      footer: (p, n) => `halaman ${p}/${n}`,
    });
    layout.heading('Daftar Judul', 1);
    expect(layout.table(TITLE_COLUMNS, titleRows(120))).toEqual({ rows: 120, nonLatinRows: 0 });
    const n = layout.pages;
    expect(n).toBeGreaterThan(2);
    const pdf = checkPdf(layout.toBytes());
    expect(pdf.pages).toHaveLength(n);
    expect(pdf.title).toBe('Daftar judul uji');
    for (const [k, page] of pdf.pages.entries()) {
      const texts = textsOf(page);
      expect(texts).toContain(`halaman ${k + 1}/${n}`);
      expect(count(texts, 'Nomor'), `header cells on page ${k + 1}`).toBe(1);
      expect(texts).toContain('Perpustakaan Contoh · Daftar Judul');
      expect(texts).toContain('per 2026-11-01');
      // The header row is above every data row of its page.
      const headerY = page.texts.find((t) => t.text === 'Nomor')!.y;
      for (const t of page.texts.filter((t) => t.text.startsWith('Judul uji'))) expect(t.y).toBeLessThan(headerY);
    }
    // Every row is printed once (the first line of its title).
    const texts = allTexts(pdf);
    for (let i = 1; i <= 120; i++) {
      expect(texts.filter((t) => t.startsWith(`Judul uji ${i} `) || t === `Judul uji ${i}`), `row ${i}`).toHaveLength(1);
    }
    expectInsideMargins(pdf);
  });

  it('every page of an F4 landscape document has the MediaBox [0 0 935.43 609.45]', () => {
    const layout = new PdfLayout({ paper: 'F4', orientation: 'landscape', nonLatinNote: NOTE });
    layout.table([{ header: 'Baris' }], Array.from({ length: 90 }, (_, i) => [`baris ${i + 1}`]));
    const pdf = checkPdf(layout.toBytes());
    expect(pdf.pages.length).toBeGreaterThan(1);
    for (const page of pdf.pages) {
      const [x0, y0, x1, y1] = page.mediaBox;
      expect([x0, y0]).toEqual([0, 0]);
      expect(Math.abs(x1! - 935.43)).toBeLessThanOrEqual(0.01);
      expect(Math.abs(y1! - 609.45)).toBeLessThanOrEqual(0.01);
    }
    expectInsideMargins(pdf);
  });

  it('A4 portrait pages are 595.28 × 841.89 and landscape swaps them', () => {
    const portrait = checkPdf(make().toBytes()).pages[0]!;
    expect([portrait.width, portrait.height]).toEqual([595.276, 841.89]);
    const landscape = checkPdf(make({ orientation: 'landscape' }).toBytes()).pages[0]!;
    expect([landscape.width, landscape.height]).toEqual([841.89, 595.276]);
  });

  it('splits the printable width by weight and aligns cells left, right or centre', () => {
    const layout = make();
    layout.table(
      [
        { header: 'Kiri', weight: 1 },
        { header: 'Kanan', weight: 2, align: 'right' },
        { header: 'Tengah', weight: 1, align: 'center' },
      ],
      [['a', 1234, 'c']],
    );
    const page = checkPdf(layout.toBytes()).pages[0]!;
    const quarter = PRINTABLE / 4;
    const a = page.texts.find((t) => t.text === 'a')!;
    const b = page.texts.find((t) => t.text === '1234')!;
    const c = page.texts.find((t) => t.text === 'c')!;
    expect(a.x).toBeGreaterThan(MARGIN);
    expect(a.x).toBeLessThan(MARGIN + 10);
    // The right-aligned number ends a few points before the end of the second column (three quarters across).
    const bEnd = b.x + width(b);
    expect(bEnd).toBeLessThan(MARGIN + 3 * quarter);
    expect(bEnd).toBeGreaterThan(MARGIN + 3 * quarter - 10);
    // The centred cell is centred in the last quarter.
    expect(Math.abs(c.x + width(c) / 2 - (MARGIN + 3.5 * quarter))).toBeLessThan(0.01);
  });

  it('prints an empty table as its header row, and refuses bad columns or rows', () => {
    const layout = make();
    expect(layout.table([{ header: 'Kosong' }], [])).toEqual({ rows: 0, nonLatinRows: 0 });
    expect(allTexts(checkPdf(layout.toBytes()))).toContain('Kosong');
    const other = make();
    expect(() => other.table([], [])).toThrow(RangeError);
    expect(() => other.table([{ header: 'a', weight: 0 }], [])).toThrow(RangeError);
    expect(() => other.table([{ header: 'a', weight: Number.NaN }], [])).toThrow(RangeError);
    expect(() => other.table([{ header: 'a' }], [['x', 'y']])).toThrow(RangeError);
  });

  it('a row taller than a page continues on the next page under a repeated header row', () => {
    const layout = make();
    const long = Array.from({ length: 900 }, (_, i) => `kata${i + 1}`).join(' ');
    layout.table([{ header: 'Kunci', weight: 1 }, { header: 'Isi panjang', weight: 1 }], [['k1', long], ['k2', 'pendek']]);
    const pdf = checkPdf(layout.toBytes());
    expect(pdf.pages.length).toBeGreaterThan(1);
    for (const page of pdf.pages) expect(count(textsOf(page), 'Kunci')).toBe(1);
    const words = allTexts(pdf).flatMap((t) => t.split(' ')).filter((w) => w.startsWith('kata'));
    expect(words).toEqual(Array.from({ length: 900 }, (_, i) => `kata${i + 1}`));
    expectInsideMargins(pdf);
  });

  it('a marked row taller than a page prints its note once, under its last line', () => {
    const layout = make();
    const long = `تفسير ${Array.from({ length: 900 }, (_, i) => `kata${i + 1}`).join(' ')}`;
    expect(layout.table([{ header: 'Isi' }], [[long]]).nonLatinRows).toBe(1);
    const pdf = checkPdf(layout.toBytes());
    expect(count(allTexts(pdf), NOTE)).toBe(1);
    const k = pdf.pages.findIndex((p) => textsOf(p).includes(NOTE));
    expect(k).toBe(pdf.pages.length - 1);
    const page = pdf.pages[k]!;
    const last = page.texts.find((t) => t.text.endsWith('kata900'))!;
    expect(page.texts.find((t) => t.text === NOTE)!.y).toBeLessThan(last.y);
    expectInsideMargins(pdf);
  });

  it('never leaves a header row alone at the bottom of a page', () => {
    for (let filler = 50; filler <= 70; filler++) {
      const layout = make();
      for (let k = 0; k < filler; k++) layout.paragraph(`isi ${k}`);
      layout.table([{ header: 'Kolom tunggal' }], [['baris pertama'], ['baris kedua']]);
      const pdf = checkPdf(layout.toBytes());
      for (const page of pdf.pages.filter((p) => textsOf(p).includes('Kolom tunggal'))) {
        expect(textsOf(page).some((t) => t.startsWith('baris')), `after ${filler} lines`).toBe(true);
      }
      expectInsideMargins(pdf);
    }
  });
});

describe('non-Latin rows', () => {
  it('marks and counts only the row that lost characters; a transliterated or WinAnsi accent is no loss', () => {
    const layout = make();
    const result = layout.table([{ header: 'Judul' }], [['تفسير الجلالين'], ['Pérez'], ['Laskar Pelangi'], ['Tafsīr al-Jalālayn']]);
    expect(result).toEqual({ rows: 4, nonLatinRows: 1 });
    expect(layout.nonLatinRows).toBe(1);
    const page = checkPdf(layout.toBytes()).pages[0]!;
    const texts = textsOf(page);
    expect(count(texts, NOTE)).toBe(1);
    expect(texts.some((t) => t === 'Pérez' || t === 'Perez')).toBe(true);
    expect(texts).toContain('Tafsir al-Jalalayn');
    // The note sits under the Arabic row and above the next row.
    const y = (s: string): number => page.texts.find((t) => t.text === s)!.y;
    const arabic = page.texts.find((t) => t.text.includes('?'))!;
    expect(y(NOTE)).toBeLessThan(arabic.y);
    expect(y(NOTE)).toBeGreaterThan(y('Pérez'));
  });

  it('a romanised title, an invisible character or a symbol is no text of another script: such rows are neither marked nor counted', () => {
    const layout = make();
    const rows = [['Tafs\u012br al-Qur\u02be\u0101n'], ['Mu\u1e25ammad \u02bfAbduh'], ['Sejarah\u200bIndonesia'], ['Kitab\ufeff'], ['Belajar \u{1F680}'], ['\u062a\u0641\u0633\u064a\u0631']];
    expect(layout.table([{ header: 'Judul' }], rows)).toEqual({ rows: 6, nonLatinRows: 1 });
    const texts = textsOf(checkPdf(layout.toBytes()).pages[0]!);
    expect(count(texts, NOTE)).toBe(1);
    for (const printed of ['Tafsir al-Qur\u2019an', 'Muhammad \u2018Abduh', 'SejarahIndonesia', 'Kitab', 'Belajar ?']) expect(texts).toContain(printed);
  });

  it('counts a row once however many of its cells lost characters, adds up over tables, and ignores paragraphs', () => {
    const layout = make();
    layout.paragraph('صحيح البخاري');
    expect(layout.nonLatinRows).toBe(0);
    const columns = [{ header: 'Judul' }, { header: 'Pengarang' }];
    expect(layout.table(columns, [['صحيح البخاري', 'البخاري'], ['Laskar Pelangi', 'Andrea Hirata']]).nonLatinRows).toBe(1);
    expect(layout.table(columns, [['Pérez', '東京']]).nonLatinRows).toBe(1);
    expect(layout.nonLatinRows).toBe(2);
    expect(count(allTexts(checkPdf(layout.toBytes())), NOTE)).toBe(2);
  });
});

describe('PdfLayout text', () => {
  it('wraps a 2 000-character paragraph inside the printable width without losing a word', () => {
    const layout = make();
    const text = Array.from({ length: 400 }, (_, i) => WORDS[i % WORDS.length]!).join(' ').slice(0, 2000);
    expect(text).toHaveLength(2000);
    layout.paragraph(text);
    const pdf = checkPdf(layout.toBytes());
    const runs = pdf.pages.flatMap((p) => p.texts).filter((t) => t.size === 10);
    expect(runs.length).toBeGreaterThan(5);
    for (const t of runs) expect(width(t)).toBeLessThanOrEqual(PRINTABLE + EPS);
    expect(runs.map((t) => t.text).join(' ')).toBe(text);
    expectInsideMargins(pdf);
  });

  it('breaks a word longer than the line by character, and keeps line breaks of the text', () => {
    const layout = make();
    const word = 'x'.repeat(400);
    layout.paragraph(`${word}\nbaris kedua`);
    const runs = checkPdf(layout.toBytes()).pages[0]!.texts.filter((t) => t.size === 10);
    expect(runs.length).toBeGreaterThan(2);
    for (const t of runs) expect(width(t)).toBeLessThanOrEqual(PRINTABLE + EPS);
    expect(runs.slice(0, -1).map((t) => t.text).join('')).toBe(word);
    expect(runs.at(-1)!.text).toBe('baris kedua');
  });

  it('a long paragraph flows onto further pages inside the margins', () => {
    const layout = make({ marginsMm: { top: 20, right: 25, bottom: 20, left: 25 } });
    layout.paragraph(Array.from({ length: 3000 }, (_, i) => WORDS[i % WORDS.length]!).join(' '));
    expect(layout.pages).toBeGreaterThan(1);
    const pdf = checkPdf(layout.toBytes());
    expect(pdf.pages).toHaveLength(layout.pages);
    for (const page of pdf.pages) {
      for (const t of page.texts) {
        expect(t.x).toBeGreaterThanOrEqual(25 * PT - POS);
        expect(t.x + width(t)).toBeLessThanOrEqual(page.width - 25 * PT + POS);
        expect(t.y).toBeGreaterThanOrEqual(20 * PT - POS);
        expect(t.y + t.size).toBeLessThanOrEqual(page.height - 20 * PT + POS);
      }
    }
  });

  it('aligns paragraph lines, prints bold text and sizes headings by level', () => {
    const layout = make();
    layout.heading('Judul satu', 1);
    layout.heading('Judul dua', 2);
    layout.heading('Judul tiga', 3);
    layout.paragraph('kanan', { align: 'right' });
    layout.paragraph('tengah', { align: 'center', bold: true, size: 12 });
    const page = checkPdf(layout.toBytes()).pages[0]!;
    const find = (s: string): PdfText => page.texts.find((t) => t.text === s)!;
    expect([find('Judul satu').size, find('Judul dua').size, find('Judul tiga').size]).toEqual([16, 13, 11]);
    expect(find('Judul satu').font).toBe('Helvetica-Bold');
    const right = find('kanan');
    expect(Math.abs(right.x + width(right) - (A4.w - MARGIN))).toBeLessThan(0.01);
    const centre = find('tengah');
    expect(centre.font).toBe('Helvetica-Bold');
    expect(centre.size).toBe(12);
    expect(Math.abs(centre.x + width(centre) / 2 - A4.w / 2)).toBeLessThan(0.01);
  });

  it('keeps a heading on the page of the text that follows it', () => {
    for (let filler = 50; filler <= 75; filler++) {
      const layout = make();
      for (let k = 0; k < filler; k++) layout.paragraph(`isi ${k}`);
      layout.heading('Bagian berikut', 2);
      layout.paragraph('kalimat pertama bagian berikut');
      const pdf = checkPdf(layout.toBytes());
      expect(pageOf(pdf, 'Bagian berikut'), `after ${filler} lines`).toBe(pageOf(pdf, 'kalimat pertama bagian berikut'));
    }
  });

  it('prints key-value rows with the key in bold on the line of its value', () => {
    const layout = make();
    layout.keyValues([
      ['Nama perpustakaan', 'Perpustakaan Contoh'],
      ['NPP', '3171012D1000001'],
    ]);
    const page = checkPdf(layout.toBytes()).pages[0]!;
    const key = page.texts.find((t) => t.text === 'NPP')!;
    const value = page.texts.find((t) => t.text === '3171012D1000001')!;
    expect(key.font).toBe('Helvetica-Bold');
    expect(value.font).toBe('Helvetica');
    expect(value.y).toBe(key.y);
    expect(value.x).toBeGreaterThan(key.x + width(key));
  });
});

describe('PdfLayout pages, header and footer', () => {
  it('prints "X/Y" on every page without a footer function, and the header on every page', () => {
    const layout = make({ header: { left: 'Kepala kiri' } });
    layout.paragraph('satu');
    layout.pageBreak();
    layout.paragraph('dua');
    const pdf = checkPdf(layout.toBytes());
    expect(pdf.pages.map((p) => textsOf(p).filter((t) => /^\d+\/\d+$/.test(t)))).toEqual([['1/2'], ['2/2']]);
    expect(pdf.pages.map((p) => count(textsOf(p), 'Kepala kiri'))).toEqual([1, 1]);
  });

  it('a page break on a page with nothing on it adds no page', () => {
    const layout = make();
    layout.pageBreak();
    expect(layout.pages).toBe(1);
    layout.paragraph('a');
    layout.pageBreak();
    layout.pageBreak();
    layout.paragraph('b');
    expect(layout.pages).toBe(2);
    const pdf = checkPdf(layout.toBytes());
    expect(pageOf(pdf, 'b')).toBe(1);
  });

  it('writes the same bytes twice and refuses more content once written', () => {
    const layout = make();
    layout.paragraph('isi');
    const first = layout.toBytes();
    expect(layout.toBytes()).toEqual(first);
    expect(() => layout.paragraph('lagi')).toThrow(/written/);
    expect(layout.pages).toBe(1);
  });

  it('refuses margins that leave no room and an unknown paper size', () => {
    expect(() => make({ marginsMm: { top: 150, right: 15, bottom: 150, left: 15 } })).toThrow(RangeError);
    expect(() => make({ marginsMm: { top: 15, right: -1, bottom: 15, left: 15 } })).toThrow(RangeError);
    expect(() => make({ paper: 'A3' as 'A4' })).toThrow(RangeError);
  });
});

describe('PdfLayout signature blocks, checklists and pictures', () => {
  const blocks = [
    { place: 'Jakarta', date: '1 November 2026', role: 'Kepala Sekolah', name: 'Dra. Siti Aminah', idLine: 'NIP. 19700101 199003 2 001', stamp: true },
    { role: 'Kepala Perpustakaan' },
  ];

  it('puts both signature blocks on one page, wherever the page is', () => {
    for (let filler = 40; filler <= 75; filler += 1) {
      const layout = make();
      for (let k = 0; k < filler; k++) layout.paragraph(`isi ${k}`);
      layout.signatureBlocks(blocks);
      const pdf = checkPdf(layout.toBytes());
      expect(pageOf(pdf, 'Kepala Sekolah'), `after ${filler} lines`).toBe(pageOf(pdf, 'Kepala Perpustakaan'));
      expectInsideMargins(pdf);
    }
  });

  it('prints the place and date, the name, the id line, a stamp box and an empty name line', () => {
    const layout = make();
    layout.signatureBlocks(blocks);
    const page = checkPdf(layout.toBytes()).pages[0]!;
    const texts = textsOf(page);
    for (const s of ['Jakarta, 1 November 2026', 'Kepala Sekolah', 'Dra. Siti Aminah', 'NIP. 19700101 199003 2 001', 'Kepala Perpustakaan']) {
      expect(texts).toContain(s);
    }
    // The stamp box is a stroked rectangle; the block without a name has a line to sign on.
    expect(page.rects.filter((r) => r.paint === 'S')).toHaveLength(1);
    const role = page.texts.find((t) => t.text === 'Kepala Perpustakaan')!;
    const signLine = page.lines.filter(
      (l) => l.y1 === l.y2 && l.y1 < role.y && l.y1 > role.y - 120 && l.x2 - l.x1 < PRINTABLE / 2 && l.x1 <= role.x && l.x2 >= role.x,
    );
    expect(signLine).toHaveLength(1);
  });

  it('a checklist prints the caller\'s present and missing words, glyph-free', () => {
    const items = [
      { label: 'Foto ruang baca', present: true, detail: 'foto-ruang-baca.jpg' },
      { label: 'SK penetapan kepala perpustakaan', present: false },
    ];
    const layout = make();
    layout.checklist(items);
    layout.checklist(items, { presentLabel: 'present', missingLabel: 'missing' });
    const pdf = checkPdf(layout.toBytes());
    const texts = allTexts(pdf);
    for (const s of ['ada', 'belum', 'present', 'missing', 'Foto ruang baca', 'SK penetapan kepala perpustakaan', 'foto-ruang-baca.jpg']) {
      expect(texts).toContain(s);
    }
    for (const t of texts) expect(toWinAnsi(t).replaced, t).toBe(0);
  });

  it('places a JPEG picture as one DCTDecode XObject scaled into its box, with its caption', () => {
    const layout = make();
    layout.image(TINY_JPEG_BASELINE, { maxWidthMm: 80, maxHeightMm: 60, caption: 'Ruang baca' });
    const pdf = checkPdf(layout.toBytes());
    expect(pdf.images).toHaveLength(1);
    expect(pdf.images[0]).toMatchObject({ filter: 'DCTDecode', width: 2, height: 1 });
    const [placed] = pdf.pages[0]!.images;
    expect(placed!.w).toBeCloseTo(80 * PT, 3);
    expect(placed!.h).toBeCloseTo(40 * PT, 3);
    expect(placed!.x).toBeGreaterThanOrEqual(MARGIN - POS);
    expect(placed!.x + placed!.w).toBeLessThanOrEqual(A4.w - MARGIN + POS);
    const caption = pdf.pages[0]!.texts.find((t) => t.text === 'Ruang baca')!;
    expect(caption.y).toBeLessThan(placed!.y);
  });

  it('fits a picture into the printable area when its box is larger', () => {
    const layout = make();
    layout.image(TINY_JPEG_BASELINE, { maxWidthMm: 500, maxHeightMm: 500 });
    const [placed] = checkPdf(layout.toBytes()).pages[0]!.images;
    expect(placed!.w).toBeCloseTo(PRINTABLE, 3);
    expect(placed!.h).toBeCloseTo(PRINTABLE / 2, 3);
  });

  it('refuses a CMYK picture', () => {
    const layout = make();
    expect(() => layout.image(TINY_JPEG_CMYK, { maxWidthMm: 50, maxHeightMm: 50 })).toThrow(JpegError);
    try {
      layout.image(TINY_JPEG_CMYK, { maxWidthMm: 50, maxHeightMm: 50 });
    } catch (e) {
      expect((e as JpegError).reason).toBe('cmyk');
    }
  });
});
