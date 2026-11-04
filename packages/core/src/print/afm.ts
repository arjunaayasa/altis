// Glyph widths of the three standard Type 1 fonts the label sheets use, from Adobe's published Core 14 AFM metrics
// (units of 1/1000 em), indexed by WinAnsi byte (Phase 2 spec §7). The fonts are not embedded, so these widths are
// what every PDF reader lays the text out with. Pure; no I/O.

import { toWinAnsi } from './winansi.js';

/** The standard fonts a page can name. */
export type PdfFont = 'Helvetica' | 'Helvetica-Bold' | 'Courier';

export const PDF_FONTS: readonly PdfFont[] = Object.freeze(['Helvetica', 'Helvetica-Bold', 'Courier'] as const);

/** A 256-entry width table from the widths of 0x20-0x7E and 0x80-0xFF; bytes WinAnsi leaves undefined measure 0. */
function table(ascii: readonly number[], high: readonly number[]): Uint16Array {
  if (ascii.length !== 95 || high.length !== 128) throw new Error('afm: a width table has the wrong length');
  const widths = new Uint16Array(256);
  widths.set(ascii, 0x20);
  widths.set(high, 0x80);
  return widths;
}

// 0x80-0x9F: Euro, (undefined), quotesinglbase, florin, quotedblbase, ellipsis, dagger, daggerdbl, circumflex,
// perthousand, Scaron, guilsinglleft, OE, (undefined), Zcaron, (undefined), (undefined), quoteleft, quoteright,
// quotedblleft, quotedblright, bullet, endash, emdash, tilde, trademark, scaron, guilsinglright, oe, (undefined),
// zcaron, Ydieresis. 0xA0-0xFF: ISO Latin-1 (0xA0 is space, 0xAD hyphen).

const HELVETICA = table(
  [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, // space-slash
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, // 0-9, colon-question
    1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, // at, A-O
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, // P-Z, bracketleft-underscore
    333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, // grave, a-o
    556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584, // p-z, braceleft-asciitilde
  ],
  [
    556, 0, 222, 556, 333, 1000, 556, 556, 333, 1000, 667, 333, 1000, 0, 611, 0, // 0x80
    0, 222, 222, 333, 333, 350, 556, 1000, 333, 1000, 500, 333, 944, 0, 500, 667, // 0x90
    278, 333, 556, 556, 556, 556, 260, 556, 333, 737, 370, 556, 584, 333, 737, 333, // 0xA0
    400, 584, 333, 333, 333, 556, 537, 278, 333, 333, 365, 556, 834, 834, 834, 611, // 0xB0
    667, 667, 667, 667, 667, 667, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278, // 0xC0
    722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611, // 0xD0
    556, 556, 556, 556, 556, 556, 889, 500, 556, 556, 556, 556, 278, 278, 278, 278, // 0xE0
    556, 556, 556, 556, 556, 556, 556, 584, 611, 556, 556, 556, 556, 500, 556, 500, // 0xF0
  ],
);

const HELVETICA_BOLD = table(
  [
    278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, // space-slash
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, // 0-9, colon-question
    975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, // at, A-O
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, // P-Z, bracketleft-underscore
    333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, // grave, a-o
    611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584, // p-z, braceleft-asciitilde
  ],
  [
    556, 0, 278, 556, 500, 1000, 556, 556, 333, 1000, 667, 333, 1000, 0, 611, 0, // 0x80
    0, 278, 278, 500, 500, 350, 556, 1000, 333, 1000, 556, 333, 944, 0, 500, 667, // 0x90
    278, 333, 556, 556, 556, 556, 280, 556, 333, 737, 370, 556, 584, 333, 737, 333, // 0xA0
    400, 584, 333, 333, 333, 611, 556, 278, 333, 333, 365, 556, 834, 834, 834, 611, // 0xB0
    722, 722, 722, 722, 722, 722, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278, // 0xC0
    722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611, // 0xD0
    556, 556, 556, 556, 556, 556, 889, 556, 556, 556, 556, 556, 278, 278, 278, 278, // 0xE0
    611, 611, 611, 611, 611, 611, 611, 584, 611, 611, 611, 611, 611, 556, 611, 556, // 0xF0
  ],
);

/** Courier is monospaced: every defined glyph is 600 wide. */
const COURIER = table(
  Array<number>(95).fill(600),
  Array.from({ length: 128 }, (_, i) => ([0x81, 0x8d, 0x8f, 0x90, 0x9d].includes(0x80 + i) ? 0 : 600)),
);

/** The width table of each font, by WinAnsi byte, in 1/1000 em. */
const AFM_WIDTHS: Readonly<Record<PdfFont, Uint16Array>> = Object.freeze({
  Helvetica: HELVETICA,
  'Helvetica-Bold': HELVETICA_BOLD,
  Courier: COURIER,
});

/** The width in points of `s` in `font` at `size` points: its WinAnsi bytes, as the page writes them, without kerning. */
export function textWidth(s: string, font: PdfFont, size: number): number {
  const widths = AFM_WIDTHS[font];
  let units = 0;
  for (const b of toWinAnsi(s).bytes) units += widths[b]!;
  return (units * size) / 1000;
}
