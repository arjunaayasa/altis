import { LabelProfile as LabelProfileSchema } from '@altis/shared/api/settings';
import type { LabelProfile } from '@altis/shared/api/settings';
import { describe, expect, it } from 'vitest';
import { buildLabelPdf, pageSizeMm, splitCallNumber, textWidth } from '../../src/print/index.js';
import type { LabelData } from '../../src/print/index.js';
import { SETTINGS } from '../../src/settings/registry.js';
import { barsToModules, decodeCode128, decodeCode39 } from '../support/barcode-decode.js';
import { checkPdf } from '../support/pdf-check.js';
import type { CheckedPage, PdfRect, PdfText } from '../support/pdf-check.js';

// Phase 2 spec §7 and K13: label sheets for the three kinds (spine, barcode, both), the page margins respected, the
// title cut to titleMaxChars, startPosition and copies; 1 000 labels in under 5 s.

const PT = 72 / 25.4;
const EPS = 1e-3;

const SEEDED = SETTINGS['catalog.labelProfiles'].default as LabelProfile[];
const seeded = (id: string): LabelProfile => {
  const p = SEEDED.find((s) => s.id === id);
  if (p === undefined) throw new Error(`no seeded profile ${id}`);
  return p;
};
const SPINE = seeded('spine-a4');
const BARCODE = seeded('barcode-a4');
const BOTH = seeded('spine-barcode-a4');

const LONG_TITLE = 'Ensiklopedia Flora dan Fauna Nusantara untuk Pelajar Sekolah Menengah Atas';

/** `n` labels: barcodes B0000001…, call numbers of 3 and 6 parts and none, a short and a long title. */
function makeLabels(n: number): LabelData[] {
  return Array.from({ length: n }, (_, i) => ({
    callNumber: i % 5 === 4 ? null : i % 3 === 0 ? '899.221 TOE b c.2 v.3 extra' : '899.221 TOE b',
    barcode: `B${String(i + 1).padStart(7, '0')}`,
    title: i % 2 === 1 ? 'Laskar Pelangi' : LONG_TITLE,
  }));
}

type Input = Parameters<typeof buildLabelPdf>[0];

function build(profile: LabelProfile, o: Partial<Input> = {}): Uint8Array {
  return buildLabelPdf({
    profile,
    labels: makeLabels(30),
    startPosition: 1,
    copies: 1,
    libraryName: 'Perpustakaan Contoh',
    symbology: 'code128',
    ...o,
  });
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** The label slots of a page in PDF points (origin bottom left), row by row from the top left. */
function slots(profile: LabelProfile): Box[] {
  const page = pageSizeMm(profile.page);
  const out: Box[] = [];
  for (let row = 0; row < profile.rows; row++) {
    for (let col = 0; col < profile.cols; col++) {
      const left = profile.marginMm.l + col * (profile.labelWMm + profile.gapXMm);
      const top = profile.marginMm.t + row * (profile.labelHMm + profile.gapYMm);
      out.push({
        x0: left * PT,
        x1: (left + profile.labelWMm) * PT,
        y1: (page.h - top) * PT,
        y0: (page.h - top - profile.labelHMm) * PT,
      });
    }
  }
  return out;
}

const inside = (b: Box, x: number, y: number): boolean => x >= b.x0 - EPS && x <= b.x1 + EPS && y >= b.y0 - EPS && y <= b.y1 + EPS;

interface Slot {
  rects: PdfRect[];
  texts: PdfText[];
}

/** What each slot of a page holds; a mark outside every slot fails the test. */
function bySlot(page: CheckedPage, profile: LabelProfile): Slot[] {
  const boxes = slots(profile);
  const out: Slot[] = boxes.map(() => ({ rects: [], texts: [] }));
  const find = (x: number, y: number): number => {
    const k = boxes.findIndex((b) => inside(b, x, y));
    if (k < 0) throw new Error(`a mark at ${x}, ${y} is outside every label`);
    return k;
  };
  for (const r of page.rects) out[find(r.x + r.w / 2, r.y + r.h / 2)]!.rects.push(r);
  for (const t of page.texts) out[find(t.x, t.y)]!.texts.push(t);
  return out;
}

/** The bars of a slot (filled rectangles) read back with the given decoder. */
function readBars(slot: Slot, symbology: 'code128' | 'code39'): string {
  const bars = slot.rects.filter((r) => r.paint === 'f');
  const modules = barsToModules(bars.map((r) => ({ x: r.x, w: r.w })));
  return symbology === 'code128' ? decodeCode128(modules).text : decodeCode39(modules);
}

const isEmpty = (s: Slot): boolean => s.rects.length === 0 && s.texts.length === 0;

/** Every rectangle of every page lies inside the page minus its margins, and inside one label. */
function expectInsideMargins(bytes: Uint8Array, profile: LabelProfile): void {
  const pdf = checkPdf(bytes);
  const page = pageSizeMm(profile.page);
  const area: Box = {
    x0: profile.marginMm.l * PT,
    x1: (page.w - profile.marginMm.r) * PT,
    y0: profile.marginMm.b * PT,
    y1: (page.h - profile.marginMm.t) * PT,
  };
  const boxes = slots(profile);
  for (const p of pdf.pages) {
    expect(p.width).toBeCloseTo(page.w * PT, 2);
    expect(p.height).toBeCloseTo(page.h * PT, 2);
    for (const r of p.rects) {
      expect(r.w).toBeGreaterThan(0);
      expect(r.h).toBeGreaterThan(0);
      // A stroke reaches half the line width beyond its path.
      const ink = r.paint === 'f' ? 0 : r.lineWidth / 2;
      const ok = (b: Box): boolean =>
        r.x - ink >= b.x0 - EPS && r.x + r.w + ink <= b.x1 + EPS && r.y - ink >= b.y0 - EPS && r.y + r.h + ink <= b.y1 + EPS;
      expect(ok(area), `rect ${JSON.stringify(r)} outside the margins`).toBe(true);
      expect(boxes.some(ok), `rect ${JSON.stringify(r)} outside every label`).toBe(true);
    }
    for (const t of p.texts) {
      const width = textWidth(t.text, t.font as 'Helvetica', t.size);
      const ok = (b: Box): boolean =>
        t.x >= b.x0 - EPS && t.x + width <= b.x1 + EPS && t.y - 0.23 * t.size >= b.y0 - EPS && t.y + 0.94 * t.size <= b.y1 + EPS;
      expect(boxes.some(ok), `text ${JSON.stringify(t)} outside every label`).toBe(true);
    }
  }
}

describe('splitCallNumber', () => {
  it('splits on spaces into at most 5 lines, the rest joined onto the last', () => {
    expect(splitCallNumber('899.221 TOE b')).toEqual(['899.221', 'TOE', 'b']);
    expect(splitCallNumber('  R  899.221\tTOE \n b ')).toEqual(['R', '899.221', 'TOE', 'b']);
    expect(splitCallNumber('a b c d e')).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(splitCallNumber('a b c d e f g')).toEqual(['a', 'b', 'c', 'd', 'e f g']);
    expect(splitCallNumber('')).toEqual([]);
    expect(splitCallNumber('   ')).toEqual([]);
  });
});

describe('pageSizeMm', () => {
  it('knows A4, F4 and Letter, and takes a custom size', () => {
    expect(pageSizeMm('A4')).toEqual({ w: 210, h: 297 });
    expect(pageSizeMm('F4')).toEqual({ w: 215, h: 330 });
    expect(pageSizeMm('Letter')).toEqual({ w: 215.9, h: 279.4 });
    expect(pageSizeMm({ wMm: 100, hMm: 50 })).toEqual({ w: 100, h: 50 });
  });
});

describe('buildLabelPdf', () => {
  it('K13: each seeded profile × 30 labels passes the structural check', () => {
    expect(SEEDED.map((p) => p.kind)).toEqual(['spine', 'barcode', 'spine_barcode']);
    for (const [profile, pages] of [
      [SPINE, 1],
      [BARCODE, 2],
      [BOTH, 3],
    ] as const) {
      const pdf = checkPdf(build(profile));
      expect(pdf.pages).toHaveLength(pages);
      expect(pdf.title).toBe(profile.name);
      const filled = pdf.pages.flatMap((p) => bySlot(p, profile)).filter((s) => !isEmpty(s));
      // Every label leaves a mark (the spine profile draws a border even for a label without a call number).
      expect(filled).toHaveLength(30);
    }
  });

  it('K13: 1 000 labels are built in under 5 s on every seeded profile', () => {
    for (const profile of SEEDED) {
      const started = performance.now();
      const bytes = build(profile, { labels: makeLabels(1000) });
      const elapsed = performance.now() - started;
      expect(elapsed).toBeLessThan(5000);
      expect(checkPdf(bytes).pages).toHaveLength(Math.ceil(1000 / (profile.cols * profile.rows)));
    }
  });

  it('draws bars that read back to each barcode, in order (Code 128 and Code 39)', () => {
    for (const symbology of ['code128', 'code39'] as const) {
      for (const profile of [BARCODE, BOTH]) {
        const pdf = checkPdf(build(profile, { symbology }));
        const read = pdf.pages.flatMap((p) => bySlot(p, profile)).filter((s) => !isEmpty(s));
        expect(read.map((s) => readBars(s, symbology))).toEqual(makeLabels(30).map((l) => l.barcode));
        // The human-readable barcode under the bars.
        for (const [k, s] of read.entries()) {
          expect(s.texts.filter((t) => t.font === 'Courier').map((t) => t.text)).toEqual([makeLabels(30)[k]!.barcode]);
        }
      }
    }
  });

  it("uses the profile's own symbology, the given one (the setting) only when the profile names none", () => {
    const labels = makeLabels(2);
    const own = checkPdf(build({ ...BARCODE, symbology: 'code39' }, { labels, symbology: 'code128' }));
    expect(readBars(bySlot(own.pages[0]!, BARCODE)[0]!, 'code39')).toBe('B0000001');
    const setting = checkPdf(build({ ...BARCODE, symbology: null }, { labels, symbology: 'code39' }));
    expect(readBars(bySlot(setting.pages[0]!, BARCODE)[0]!, 'code39')).toBe('B0000001');
  });

  it('drops invisible format characters and bounds a huge title before cutting it', () => {
    const labels = [
      { callNumber: '899\u{AD}.221\u{200B} TOE', barcode: 'B0000001', title: '\u{FEFF}Laskar\u{200B} Pe\u{AD}langi' },
      { callNumber: null, barcode: 'B0000002', title: `${'Judul '.repeat(200_000)}akhir` },
      // BOTH reads 4 × 40 + 256 = 416 units of a title: they end inside the pair of the emoji after the x.
      { callNumber: null, barcode: 'B0000003', title: `${' '.repeat(414)}x\u{1F600}${' tail'.repeat(10)}` },
    ];
    const pdf = checkPdf(build(BOTH, { labels }));
    const [s0, s1, s2] = bySlot(pdf.pages[0]!, BOTH);
    // Only the head was read, so the title counts as cut even though what was read is short.
    expect(s2!.texts.map((t) => t.text).at(-1)).toBe('x\u{2026}');
    expect(s0!.texts.map((t) => t.text)).toEqual(['899.221', 'TOE', 'Perpustakaan Contoh', 'B0000001', 'Laskar Pelangi']);
    expect(s1!.texts.map((t) => t.text).at(-1)).toBe(`${'Judul '.repeat(6)}Jud\u{2026}`);
  });

  it('falls back to Code 128 for a barcode Code 39 cannot hold', () => {
    const labels = [{ callNumber: null, barcode: 'B#00_1', title: 'x' }];
    const pdf = checkPdf(build(BARCODE, { labels, symbology: 'code39' }));
    const [slot] = bySlot(pdf.pages[0]!, BARCODE);
    expect(readBars(slot!, 'code128')).toBe('B#00_1');
  });

  it('startPosition 5 leaves the first 4 slots of page 1 empty', () => {
    const pdf = checkPdf(build(SPINE, { startPosition: 5 }));
    expect(pdf.pages).toHaveLength(2);
    const first = bySlot(pdf.pages[0]!, SPINE);
    const second = bySlot(pdf.pages[1]!, SPINE);
    expect(first.map(isEmpty)).toEqual([...Array<boolean>(4).fill(true), ...Array<boolean>(26).fill(false)]);
    expect(second.map(isEmpty)).toEqual([...Array<boolean>(4).fill(false), ...Array<boolean>(26).fill(true)]);
  });

  it('startPosition counts on into the next sheet: 31 on a sheet of 30 is the first slot', () => {
    expect(build(SPINE, { startPosition: 31 })).toEqual(build(SPINE, { startPosition: 1 }));
    expect(build(SPINE, { startPosition: 35 })).toEqual(build(SPINE, { startPosition: 5 }));
  });

  it('copies: 3 prints each label three times in a row', () => {
    const labels = makeLabels(10);
    const pdf = checkPdf(build(BARCODE, { labels, copies: 3 }));
    const read = pdf.pages.flatMap((p) => bySlot(p, BARCODE)).filter((s) => !isEmpty(s));
    expect(read.map((s) => readBars(s, 'code128'))).toEqual(labels.flatMap((l) => [l.barcode, l.barcode, l.barcode]));
  });

  it('keeps every rectangle and text inside the page minus its margins, for each kind and page size', () => {
    /** A grid: margins t r b l, cols × rows labels of w × h with gaps gx, gy (millimetres). */
    const grid = (
      [t, r, b, l]: [number, number, number, number],
      [cols, rows]: [number, number],
      [labelWMm, labelHMm, gapXMm, gapYMm]: [number, number, number, number],
    ) => ({ marginMm: { t, r, b, l }, cols, rows, labelWMm, labelHMm, gapXMm, gapYMm });
    const tiny = { page: 'A4' as const, ...grid([5, 5, 5, 5], [10, 40], [18, 6, 2, 1]), fontPt: 24, titleMaxChars: 200 };
    const custom: LabelProfile[] = [
      ...SEEDED,
      { ...BOTH, id: 'f4', page: 'F4', ...grid([11, 3, 17, 9], [3, 9], [66, 33, 1.5, 0.5]) },
      { ...BARCODE, id: 'letter', page: 'Letter', ...grid([12.7, 4.8, 12.7, 4.8], [3, 10], [66.6, 25.4, 3.2, 0]), border: true },
      {
        ...SPINE,
        id: 'roll',
        page: { wMm: 50, hMm: 30 },
        ...grid([1, 1, 1, 1], [1, 1], [48, 28, 0, 0]),
        header: 'MILIK NEGARA',
        showLibraryName: true,
      },
      { ...BARCODE, id: 'tiny', ...tiny, header: 'MILIK PERPUSTAKAAN NASIONAL' },
      { ...BOTH, id: 'tiny-both', ...tiny, header: 'X' },
    ].map((p) => LabelProfileSchema.parse(p));
    const labels = [
      ...makeLabels(20),
      { callNumber: 'R 899.221 TOE b c.2 v.3 extra long words here', barcode: 'B'.repeat(64), title: 'W'.repeat(200) },
    ];
    for (const profile of custom) {
      for (const symbology of ['code128', 'code39'] as const) {
        expectInsideMargins(build(profile, { labels, symbology, startPosition: 3 }), profile);
      }
    }
  });

  it('spine: the call number split into lines, with the header and library name when the profile asks', () => {
    const pdf = checkPdf(build(SPINE, { labels: makeLabels(5) }));
    const [s0, s1, , , s4] = bySlot(pdf.pages[0]!, SPINE);
    expect(s0!.texts.map((t) => t.text)).toEqual(['899.221', 'TOE', 'b', 'c.2', 'v.3 extra']);
    expect(s1!.texts.map((t) => t.text)).toEqual(['899.221', 'TOE', 'b']);
    expect(s1!.texts.every((t) => t.font === 'Helvetica-Bold' && t.size === SPINE.fontPt)).toBe(true);
    // Lines run top to bottom, each one centred on the label.
    const ys = s1!.texts.map((t) => t.y);
    expect([...ys].sort((a, b) => b - a)).toEqual(ys);
    // No call number: only the border.
    expect(s4!.texts).toEqual([]);
    expect(s4!.rects.map((r) => r.paint)).toEqual(['S']);
    expect(s1!.rects.filter((r) => r.paint === 'f')).toEqual([]);

    const headed = checkPdf(build({ ...SPINE, header: 'MILIK NEGARA', showLibraryName: true }, { labels: makeLabels(2) }));
    const [h0] = bySlot(headed.pages[0]!, SPINE);
    expect(h0!.texts.map((t) => t.text)).toEqual(['MILIK NEGARA', 'Perpustakaan Contoh', '899.221', 'TOE', 'b', 'c.2', 'v.3 extra']);
  });

  it('barcode: library name, bars, the barcode and the title cut to titleMaxChars', () => {
    const pdf = checkPdf(build(BARCODE, { labels: makeLabels(2) }));
    const [s0, s1] = bySlot(pdf.pages[0]!, BARCODE);
    expect(s0!.texts.map((t) => t.text)).toEqual(['Perpustakaan Contoh', 'B0000001', 'Ensiklopedia Flora dan Fauna\u{2026}']);
    expect(s1!.texts.map((t) => t.text)).toEqual(['Perpustakaan Contoh', 'B0000002', 'Laskar Pelangi']);
    expect([...'Ensiklopedia Flora dan Fauna\u{2026}'].length).toBeLessThanOrEqual(BARCODE.titleMaxChars);
    // No border on this profile: every rectangle is a bar.
    expect(s0!.rects.every((r) => r.paint === 'f')).toBe(true);

    const untitled = checkPdf(build({ ...BARCODE, titleMaxChars: 0, showLibraryName: false }, { labels: makeLabels(1) }));
    expect(bySlot(untitled.pages[0]!, BARCODE)[0]!.texts.map((t) => t.text)).toEqual(['B0000001']);
  });

  it('spine and barcode: the call number on the left, the bars and texts on the right', () => {
    const pdf = checkPdf(build(BOTH, { labels: makeLabels(2) }));
    const [, s1] = bySlot(pdf.pages[0]!, BOTH);
    const box = slots(BOTH)[1]!;
    const middle = (box.x0 + box.x1) / 2;
    const callNumber = s1!.texts.filter((t) => t.font === 'Helvetica-Bold');
    expect(callNumber.map((t) => t.text)).toEqual(['899.221', 'TOE', 'b']);
    expect(callNumber.every((t) => t.x < middle)).toBe(true);
    const leftEnd = Math.max(...callNumber.map((t) => t.x + textWidth(t.text, 'Helvetica-Bold', t.size)));
    const bars = s1!.rects.filter((r) => r.paint === 'f');
    expect(bars.length).toBeGreaterThan(10);
    expect(bars.every((r) => r.x > leftEnd)).toBe(true);
    expect(s1!.texts.filter((t) => t.font !== 'Helvetica-Bold').map((t) => t.text)).toEqual([
      'Perpustakaan Contoh',
      'B0000002',
      'Laskar Pelangi',
    ]);
  });

  it('writes text outside WinAnsi transliterated or as ?', () => {
    const labels = [{ callNumber: '\u{112}K 1', barcode: 'B0000001', title: '\u{112}kspedisi \u{6771}\u{4EAC}' }];
    const pdf = checkPdf(build(BOTH, { labels, libraryName: 'Perpustakaan \u{C7}ahaya' }));
    const texts = pdf.pages[0]!.texts.map((t) => t.text);
    expect(texts).toEqual(['EK', '1', 'Perpustakaan \u{C7}ahaya', 'B0000001', 'Ekspedisi ??']);
  });

  it('writes one blank page for no labels', () => {
    const pdf = checkPdf(build(SPINE, { labels: [] }));
    expect(pdf.pages).toHaveLength(1);
    expect(pdf.pages[0]!.rects).toEqual([]);
    expect(pdf.pages[0]!.texts).toEqual([]);
  });

  it('refuses a startPosition or copies that is not a positive integer', () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => build(SPINE, { startPosition: bad })).toThrow(RangeError);
      expect(() => build(SPINE, { copies: bad })).toThrow(RangeError);
    }
  });
});
