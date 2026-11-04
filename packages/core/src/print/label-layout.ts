// Label sheets (Phase 2 spec §7, K13). A profile places `cols` × `rows` labels on a page inside its margins. Each
// label is one of three kinds:
// - `spine`: an optional header and library name, then the call number split into at most 5 lines;
// - `barcode`: the header and library name, the bars, the human-readable barcode and the title cut to titleMaxChars;
// - `spine_barcode`: the call number on the left, the barcode label on the right.
// Text is fitted to its label: lines shrink down to 4 pt when a label is too small, then the least important ones are
// left out, and a line too wide even at 4 pt is cut with an ellipsis. Nothing is ever drawn outside a label, so the
// page margins are respected. Pure; no I/O.

import { LABEL_PAGE_MM } from '@altis/shared/api/settings';
import type { LabelProfile } from '@altis/shared/api/settings';
import { textWidth } from './afm.js';
import type { PdfFont } from './afm.js';
import { code128Modules } from './code128.js';
import { code39Modules } from './code39.js';
import { PDF_LINE_WIDTH, PdfDocument } from './pdf.js';
import type { PdfPage } from './pdf.js';

/** What one label shows: the call number (the item's, else its record's; null for none), the barcode and the title. */
export type LabelData = { callNumber: string | null; barcode: string; title: string };

const PT_PER_MM = 72 / 25.4;
/** At most this many call number lines; the rest is joined onto the last one. */
const CALL_NUMBER_LINES = 5;
/** Text never shrinks below this size. */
const MIN_FONT_PT = 4;
/** A line takes 1.2 em. Its baseline sits 0.94 em below the line's top, which leaves room for accented capitals. */
const LINE_HEIGHT_EM = 1.2;
const ASCENT_EM = 0.94;
/** The space kept free inside each label edge, at most 8% of the label's width or height. */
const PAD_MM = 1.5;
const PAD_SHARE = 0.08;
/** The bars are at most 15 mm high and at least 5 mm, or 35% of their column's height when that is less. */
const BARS_MIN_MM = 5;
const BARS_MIN_SHARE = 0.35;
const BARS_MAX_MM = 15;
/** The widest module (X dimension), and the quiet zone of each symbology on each side. */
const MODULE_MAX_MM = 0.5;
const QUIET_MODULES = 10;
/** The share of a `spine_barcode` label's inner width that holds the call number. */
const SPINE_SHARE = 0.36;
const ELLIPSIS = '\u{2026}';
/**
 * How much of a title is read before it is cleaned and cut: 4 UTF-16 units per character kept (room for surrogate
 * pairs, combining marks and white space runs) plus 256.
 */
const TITLE_READ_FACTOR = 4;
const TITLE_READ_EXTRA = 256;

/**
 * The order in which lines are left out of a label that is too small: the title first, then the library name, the
 * header and the barcode text.
 */
const DROP_TITLE = 100;
const DROP_LIBRARY = 90;
const DROP_HEADER = 80;
const DROP_BARCODE_TEXT = 70;
/** Call number lines go last, the last line first. */
const DROP_CALL_NUMBER = 10;

/** Rounds a size down to the three decimals the PDF writes, so a fitted line never grows when written. */
const floor3 = (n: number): number => Math.floor(n * 1000) / 1000;

/**
 * Composed (NFC), without invisible format characters (zero-width space, soft hyphen, byte order mark: pasted text
 * often holds them, and the font would show `?` or a hyphen), white space and control characters as single spaces,
 * trimmed.
 */
function cleanText(s: string): string {
  return s
    .normalize('NFC')
    .replace(/\p{Cf}+/gu, '')
    .replace(/[\s\p{Cc}]+/gu, ' ')
    .trim();
}

/** The call number split on white space into at most 5 lines; what is left is joined onto the fifth line. */
export function splitCallNumber(cn: string): string[] {
  const parts = cn.split(/\s+/).filter((p) => p !== '');
  if (parts.length <= CALL_NUMBER_LINES) return parts;
  return [...parts.slice(0, CALL_NUMBER_LINES - 1), parts.slice(CALL_NUMBER_LINES - 1).join(' ')];
}

/** A profile's page in millimetres: A4 210 × 297, F4 215 × 330, Letter 215.9 × 279.4, or its own `{wMm, hMm}`. */
export function pageSizeMm(page: LabelProfile['page']): { w: number; h: number } {
  if (typeof page === 'string') {
    const named = LABEL_PAGE_MM[page];
    return { w: named.w, h: named.h };
  }
  return { w: page.wMm, h: page.hMm };
}

/**
 * The title cut to `max` characters (code points), the last one an ellipsis when it was cut; null for no title. Only
 * the head of the title is read, so a huge one costs no more than a short one.
 */
function cutTitle(title: string, max: number): string | null {
  if (max <= 0) return null;
  let read = Math.min(title.length, TITLE_READ_FACTOR * max + TITLE_READ_EXTRA);
  // Never end between the two halves of a surrogate pair.
  const last = title.charCodeAt(read - 1);
  if (read < title.length && last >= 0xd800 && last <= 0xdbff) read--;
  const chars = Array.from(cleanText(title.slice(0, read)));
  if (chars.length === 0) return null;
  if (chars.length <= max && read === title.length) return chars.join('');
  if (max === 1) return chars[0]!;
  return chars.slice(0, max - 1).join('').trimEnd() + ELLIPSIS;
}

interface Line {
  text: string;
  font: PdfFont;
  size: number;
  /** Lines with a higher value are left out first when the label is too small. */
  drop: number;
  /** A title is cut, never shrunk, when it is too wide. */
  title: boolean;
}

type Block = { line: Line } | { bars: boolean[] };

/** A rectangle in points, `y` its bottom edge. */
interface Area {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** `text` cut so that it and an ellipsis fit `maxW` at `size`; '' when not even the ellipsis fits. */
function cutToWidth(text: string, font: PdfFont, size: number, maxW: number): string {
  const chars = Array.from(text);
  const room = maxW - textWidth(ELLIPSIS, font, size);
  let k = 0;
  let width = 0;
  while (k < chars.length) {
    const next = width + textWidth(chars[k]!, font, size);
    if (next > room) break;
    width = next;
    k++;
  }
  for (; k >= 0; k--) {
    const cut = chars.slice(0, k).join('').trimEnd() + ELLIPSIS;
    if (textWidth(cut, font, size) <= maxW) return cut;
  }
  return '';
}

/** The line fitted to `maxW`: shrunk (down to 4 pt, never a title), then cut with an ellipsis. */
function fitWidth(line: Line, size: number, maxW: number): { text: string; size: number } {
  const width = textWidth(line.text, line.font, size);
  if (width <= maxW) return { text: line.text, size };
  if (!line.title) {
    const shrunk = floor3(Math.max(MIN_FONT_PT, (size * maxW) / width));
    if (textWidth(line.text, line.font, shrunk) <= maxW) return { text: line.text, size: shrunk };
    size = Math.min(size, shrunk);
  }
  return { text: cutToWidth(line.text, line.font, size, maxW), size };
}

/** Draws the bars of `modules` filling `area`'s height, centred, with room for the quiet zones on both sides. */
function drawBars(page: PdfPage, area: Area, modules: readonly boolean[]): void {
  const x = Math.min(area.w / (modules.length + 2 * QUIET_MODULES), MODULE_MAX_MM * PT_PER_MM);
  const left = area.x + (area.w - modules.length * x) / 2;
  let start = -1;
  for (let m = 0; m <= modules.length; m++) {
    if (modules[m] === true) {
      if (start < 0) start = m;
    } else if (start >= 0) {
      page.rect(left + start * x, area.y, (m - start) * x, area.h);
      start = -1;
    }
  }
}

/**
 * Stacks `blocks` top to bottom in `area`, centred. Lines are scaled down together until they fit next to the bars'
 * minimum height (never below 4 pt), and while they still do not fit the line with the highest `drop` is left out.
 * The bars take the height that is left, from their minimum up to 15 mm. With bars, the free height is shared out
 * between the blocks; without bars, the lines stay together in the middle.
 */
function layColumn(page: PdfPage, area: Area, blocks: readonly Block[]): void {
  if (area.w <= 0 || area.h <= 0) return;
  const hasBars = blocks.some((b) => 'bars' in b);
  const barsMin = hasBars ? Math.min(BARS_MIN_MM * PT_PER_MM, BARS_MIN_SHARE * area.h) : 0;
  const room = area.h - barsMin;
  let kept = [...blocks];
  let sizes = new Map<Line, number>();
  for (;;) {
    const lines = kept.flatMap((b) => ('line' in b ? [b.line] : []));
    const nominal = lines.reduce((sum, l) => sum + LINE_HEIGHT_EM * l.size, 0);
    const scale = nominal > room ? room / nominal : 1;
    sizes = new Map(lines.map((l) => [l, floor3(Math.max(MIN_FONT_PT, l.size * scale))]));
    const needed = lines.reduce((sum, l) => sum + LINE_HEIGHT_EM * sizes.get(l)!, 0);
    if (needed <= room || lines.length === 0) break;
    const leaving = lines.reduce((a, b) => (b.drop > a.drop ? b : a));
    kept = kept.filter((b) => !('line' in b) || b.line !== leaving);
  }

  const linesHeight = [...sizes.values()].reduce((sum, s) => sum + LINE_HEIGHT_EM * s, 0);
  const barsHeight = hasBars ? Math.min(Math.max(area.h - linesHeight, barsMin), BARS_MAX_MM * PT_PER_MM) : 0;
  const free = Math.max(0, area.h - linesHeight - barsHeight);
  const gap = hasBars ? free / (kept.length + 1) : 0;
  let top = area.y + area.h - (hasBars ? gap : free / 2);
  for (const block of kept) {
    if ('bars' in block) {
      drawBars(page, { x: area.x, y: top - barsHeight, w: area.w, h: barsHeight }, block.bars);
      top -= barsHeight + gap;
      continue;
    }
    const lineSize = sizes.get(block.line)!;
    const fitted = fitWidth(block.line, lineSize, area.w);
    if (fitted.text !== '') {
      const width = textWidth(fitted.text, block.line.font, fitted.size);
      const x = area.x + (area.w - width) / 2;
      page.text(x, top - ASCENT_EM * lineSize, fitted.text, { font: block.line.font, size: fitted.size });
    }
    top -= LINE_HEIGHT_EM * lineSize + gap;
  }
}

/** The bars of a barcode: the profile's symbology, Code 128 for what Code 39 cannot hold, none for an empty value. */
function barcodeModules(barcode: string, symbology: 'code128' | 'code39'): boolean[] | null {
  if (symbology === 'code39') {
    try {
      return code39Modules(barcode);
    } catch {
      // Code 39 holds only A-Z 0-9 - . space $ / + %: fall through to Code 128, which scanners read as well.
    }
  }
  try {
    return code128Modules(barcode);
  } catch {
    // Outside printable ASCII (never for a stored barcode, spec §3.4): the label shows the text without bars.
    return null;
  }
}

interface LabelText {
  header: string;
  library: string;
}

/** Draws one label in `box`: its border when the profile asks, then the blocks of its kind. */
function drawLabel(
  page: PdfPage,
  box: Area,
  profile: LabelProfile,
  label: LabelData,
  modules: boolean[] | null,
  fixed: LabelText,
): void {
  if (profile.border) {
    const half = PDF_LINE_WIDTH / 2;
    page.rect(box.x + half, box.y + half, box.w - PDF_LINE_WIDTH, box.h - PDF_LINE_WIDTH, { stroke: true });
  }
  const pad = Math.min(PAD_MM * PT_PER_MM, PAD_SHARE * box.w, PAD_SHARE * box.h);
  const inner: Area = { x: box.x + pad, y: box.y + pad, w: box.w - 2 * pad, h: box.h - 2 * pad };
  const size = profile.fontPt;
  const line = (text: string, font: PdfFont, drop: number, title = false): Block => ({
    line: { text, font, size, drop, title },
  });
  const top: Block[] = [];
  if (fixed.header !== '') top.push(line(fixed.header, 'Helvetica', DROP_HEADER));
  if (fixed.library !== '') top.push(line(fixed.library, 'Helvetica', DROP_LIBRARY));
  const callNumber = splitCallNumber(cleanText(label.callNumber ?? '')).map((t, k) =>
    line(t, 'Helvetica-Bold', DROP_CALL_NUMBER + k),
  );
  const barcode: Block[] = [
    ...top,
    ...(modules === null ? [] : [{ bars: modules }]),
    line(label.barcode, 'Courier', DROP_BARCODE_TEXT),
  ];
  const title = cutTitle(label.title, profile.titleMaxChars);
  if (title !== null) barcode.push(line(title, 'Helvetica', DROP_TITLE, true));

  switch (profile.kind) {
    case 'spine':
      layColumn(page, inner, [...top, ...callNumber]);
      break;
    case 'barcode':
      layColumn(page, inner, barcode);
      break;
    case 'spine_barcode': {
      const left = inner.w * SPINE_SHARE;
      layColumn(page, { ...inner, w: left }, callNumber);
      layColumn(page, { ...inner, x: inner.x + left + pad, w: inner.w - left - pad }, barcode);
      break;
    }
  }
}

/**
 * The label sheet PDF (spec §7): `labels` × `copies` (each label's copies side by side), placed row by row from slot
 * `startPosition` of the first sheet. A start past the end of a sheet counts on into the next sheet, which is the same
 * slot of a fresh sheet (31 on a sheet of 30 is slot 1). The library name shows when the profile's showLibraryName is
 * set. The bars use the profile's own symbology; `symbology` (the setting `catalog.barcode.symbology`) applies when
 * the profile names none. No labels gives one blank page. `startPosition` and `copies` must be positive integers
 * (RangeError).
 */
export function buildLabelPdf(i: {
  profile: LabelProfile;
  labels: LabelData[];
  startPosition: number;
  copies: number;
  libraryName: string;
  symbology: 'code128' | 'code39';
}): Uint8Array {
  const { profile, labels, startPosition, copies } = i;
  if (!Number.isInteger(startPosition) || startPosition < 1) {
    throw new RangeError(`labels: startPosition ${startPosition}`);
  }
  if (!Number.isInteger(copies) || copies < 1) throw new RangeError(`labels: copies ${copies}`);
  const perPage = profile.cols * profile.rows;
  const first = (startPosition - 1) % perPage;
  const count = labels.length * copies;
  const page = pageSizeMm(profile.page);
  const doc = new PdfDocument({ title: profile.name });
  const pages = Array.from({ length: Math.max(1, Math.ceil((first + count) / perPage)) }, () =>
    doc.addPage(page.w * PT_PER_MM, page.h * PT_PER_MM),
  );
  const fixed: LabelText = {
    header: cleanText(profile.header),
    library: profile.showLibraryName ? cleanText(i.libraryName) : '',
  };
  const symbology = profile.symbology ?? i.symbology;
  const w = profile.labelWMm * PT_PER_MM;
  const h = profile.labelHMm * PT_PER_MM;
  let modules: boolean[] | null = null;
  for (let n = 0; n < count; n++) {
    const label = labels[Math.floor(n / copies)]!;
    if (n % copies === 0) modules = profile.kind === 'spine' ? null : barcodeModules(label.barcode, symbology);
    const slot = first + n;
    const cell = slot % perPage;
    const col = cell % profile.cols;
    const row = Math.floor(cell / profile.cols);
    const left = profile.marginMm.l + col * (profile.labelWMm + profile.gapXMm);
    const top = profile.marginMm.t + row * (profile.labelHMm + profile.gapYMm);
    const box: Area = { x: left * PT_PER_MM, y: (page.h - top) * PT_PER_MM - h, w, h };
    drawLabel(pages[Math.floor(slot / perPage)]!, box, profile, label, modules, fixed);
  }
  return doc.toBytes();
}
