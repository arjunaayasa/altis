/**
 * A small QR code encoder (ISO/IEC 18004) for member cards: byte mode, error correction level M, versions 1-10 (up to
 * 213 bytes), the smallest version that holds the data. Written for ALTIS, with no dependency; pure TypeScript, so the
 * server (card PDFs) and the browser (card previews) draw the same symbol.
 *
 * - The text is encoded as UTF-8 bytes in byte mode (a member number is ASCII anyway).
 * - The mask is chosen as the common reference encoders choose it: each of the eight masks is laid over the symbol with
 *   its format (and version) information still blank, the four penalty rules are summed (runs of same-coloured
 *   neighbours counted per module over its eight neighbours, 2×2 blocks, the 1:1:3:1:1 finder-like pattern in rows and
 *   columns, the dark share's distance from 50 %), and the lowest total wins (the first one on a tie). Matching that
 *   choice makes the symbol identical, module for module, to what those encoders draw for the same text; a test
 *   checks it against one.
 *
 * No Node built-ins here: the browser bundles this module.
 */

/** The largest version this encoder makes. */
export const QR_MAX_VERSION = 10;

/** A QR symbol: `size` × `size` modules, `dark[row][col]` true for a dark module; no quiet zone. */
export interface QrMatrix {
  version: number;
  size: number;
  dark: boolean[][];
}

// ---- tables (level M, versions 1-10) --------------------------------------------------------------------------------

/** Per version: the blocks as [count, total codewords, data codewords] groups. */
const BLOCKS_M: readonly (readonly (readonly [number, number, number])[])[] = [
  [],
  [[1, 26, 16]],
  [[1, 44, 28]],
  [[1, 70, 44]],
  [[2, 50, 32]],
  [[2, 67, 43]],
  [[4, 43, 27]],
  [[4, 49, 31]],
  [
    [2, 60, 38],
    [2, 61, 39],
  ],
  [
    [3, 58, 36],
    [2, 59, 37],
  ],
  [
    [4, 69, 43],
    [1, 70, 44],
  ],
];

/** Per version: the centre coordinates of the alignment patterns. */
const ALIGNMENT: readonly (readonly number[])[] = [
  [],
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

/** The two bits of level M in the format information. */
const LEVEL_M_BITS = 0;

// ---- GF(256) and Reed-Solomon ---------------------------------------------------------------------------------------

const EXP = new Array<number>(512);
const LOG = new Array<number>(256).fill(0);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255]!;
})();

function gfMul(a: number, b: number): number {
  return a === 0 || b === 0 ? 0 : EXP[LOG[a]! + LOG[b]!]!;
}

/** The generator polynomial of degree `n`, highest power first: the product of (x - α^i), i = 0 … n-1. */
function generator(n: number): number[] {
  let poly = [1];
  for (let i = 0; i < n; i += 1) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] = next[j]! ^ poly[j]!;
      next[j + 1] = next[j + 1]! ^ gfMul(poly[j]!, EXP[i]!);
    }
    poly = next;
  }
  return poly;
}

/** The `n` error correction codewords of `data`. */
function ecCodewords(data: readonly number[], n: number): number[] {
  const gen = generator(n);
  const rem = [...data, ...new Array<number>(n).fill(0)];
  for (let i = 0; i < data.length; i += 1) {
    const factor = rem[i]!;
    if (factor === 0) continue;
    for (let j = 0; j < gen.length; j += 1) rem[i + j] = rem[i + j]! ^ gfMul(gen[j]!, factor);
  }
  return rem.slice(data.length);
}

// ---- data codewords -------------------------------------------------------------------------------------------------

function dataCapacity(version: number): number {
  return BLOCKS_M[version]!.reduce((sum, [count, , data]) => sum + count * data, 0);
}

/** The bits of the byte-mode segment of `bytes` for `version`: mode, length, then the bytes. */
function segmentBits(bytes: Uint8Array, version: number): number {
  return 4 + (version < 10 ? 8 : 16) + 8 * bytes.length;
}

/** The final codeword sequence (data and EC blocks interleaved) of `bytes` in `version`. */
function codewords(bytes: Uint8Array, version: number): number[] {
  const capacityBits = dataCapacity(version) * 8;
  const bits: number[] = [];
  const put = (value: number, length: number): void => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  if (bits.length + 4 <= capacityBits) put(0, 4);
  while (bits.length % 8 !== 0) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let k = 0; k < 8; k += 1) v = (v << 1) | bits[i + k]!;
    data.push(v);
  }
  for (let pad = 0; data.length < capacityBits / 8; pad += 1) data.push(pad % 2 === 0 ? 0xec : 0x11);

  const dataBlocks: number[][] = [];
  const ecBlocks: number[][] = [];
  let at = 0;
  for (const [count, total, size] of BLOCKS_M[version]!) {
    for (let k = 0; k < count; k += 1) {
      const block = data.slice(at, at + size);
      at += size;
      dataBlocks.push(block);
      ecBlocks.push(ecCodewords(block, total - size));
    }
  }
  const out: number[] = [];
  const interleave = (blocks: number[][]): void => {
    const longest = Math.max(...blocks.map((b) => b.length));
    for (let i = 0; i < longest; i += 1) for (const b of blocks) if (i < b.length) out.push(b[i]!);
  };
  interleave(dataBlocks);
  interleave(ecBlocks);
  return out;
}

// ---- the symbol -----------------------------------------------------------------------------------------------------

type Grid = (boolean | null)[][];

/** The BCH code of `data` with generator `g` (degree `degree`), as the format and version information use it. */
function bch(data: number, g: number, degree: number): number {
  let d = data << degree;
  const top = (v: number): number => (v === 0 ? 0 : 32 - Math.clz32(v));
  while (top(d) - top(g) >= 0) d ^= g << (top(d) - top(g));
  return (data << degree) | d;
}

function formatBits(mask: number): number {
  return bch((LEVEL_M_BITS << 3) | mask, 0b10100110111, 10) ^ 0b101010000010010;
}

function versionBits(version: number): number {
  return bch(version, 0b1111100100101, 12);
}

function maskBit(mask: number, row: number, col: number): boolean {
  switch (mask) {
    case 0:
      return (row + col) % 2 === 0;
    case 1:
      return row % 2 === 0;
    case 2:
      return col % 3 === 0;
    case 3:
      return (row + col) % 3 === 0;
    case 4:
      return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5:
      return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6:
      return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    default:
      return (((row * col) % 3) + ((row + col) % 2)) % 2 === 0;
  }
}

/**
 * The symbol of `data` with mask `mask`; `blank` leaves the format and version information (and the dark module
 * beside it) light, as the mask choice evaluates it.
 */
function build(version: number, data: readonly number[], mask: number, blank: boolean): boolean[][] {
  const size = version * 4 + 17;
  const g: Grid = Array.from({ length: size }, () => new Array<boolean | null>(size).fill(null));

  const finder = (row: number, col: number): void => {
    for (let r = -1; r <= 7; r += 1) {
      if (row + r < 0 || row + r >= size) continue;
      for (let c = -1; c <= 7; c += 1) {
        if (col + c < 0 || col + c >= size) continue;
        const ring = (r >= 0 && r <= 6 && (c === 0 || c === 6)) || (c >= 0 && c <= 6 && (r === 0 || r === 6));
        const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        g[row + r]![col + c] = ring || core;
      }
    }
  };
  finder(0, 0);
  finder(size - 7, 0);
  finder(0, size - 7);

  const centres = ALIGNMENT[version]!;
  for (const row of centres) {
    for (const col of centres) {
      if (g[row]![col] !== null) continue;
      for (let r = -2; r <= 2; r += 1) {
        for (let c = -2; c <= 2; c += 1) g[row + r]![col + c] = r === -2 || r === 2 || c === -2 || c === 2 || (r === 0 && c === 0);
      }
    }
  }

  for (let i = 8; i < size - 8; i += 1) {
    if (g[i]![6] === null) g[i]![6] = i % 2 === 0;
    if (g[6]![i] === null) g[6]![i] = i % 2 === 0;
  }

  const format = formatBits(mask);
  for (let i = 0; i < 15; i += 1) {
    const on = !blank && ((format >> i) & 1) === 1;
    if (i < 6) g[i]![8] = on;
    else if (i < 8) g[i + 1]![8] = on;
    else g[size - 15 + i]![8] = on;
  }
  for (let i = 0; i < 15; i += 1) {
    const on = !blank && ((format >> i) & 1) === 1;
    if (i < 8) g[8]![size - i - 1] = on;
    else if (i < 9) g[8]![15 - i] = on;
    else g[8]![14 - i] = on;
  }
  g[size - 8]![8] = !blank;

  if (version >= 7) {
    const bits = versionBits(version);
    for (let i = 0; i < 18; i += 1) {
      const on = !blank && ((bits >> i) & 1) === 1;
      g[Math.floor(i / 3)]![(i % 3) + size - 11] = on;
      g[(i % 3) + size - 11]![Math.floor(i / 3)] = on;
    }
  }

  let row = size - 1;
  let step = -1;
  let byte = 0;
  let bit = 7;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1;
    for (;;) {
      for (let c = 0; c < 2; c += 1) {
        if (g[row]![col - c] !== null) continue;
        let dark = byte < data.length && ((data[byte]! >>> bit) & 1) === 1;
        if (maskBit(mask, row, col - c)) dark = !dark;
        g[row]![col - c] = dark;
        bit -= 1;
        if (bit === -1) {
          byte += 1;
          bit = 7;
        }
      }
      row += step;
      if (row < 0 || row >= size) {
        row -= step;
        step = -step;
        break;
      }
    }
  }
  return g as boolean[][];
}

/** The penalty of a symbol (see the top of this file). */
function penalty(m: boolean[][]): number {
  const n = m.length;
  let points = 0;
  for (let row = 0; row < n; row += 1) {
    for (let col = 0; col < n; col += 1) {
      const dark = m[row]![col];
      let same = 0;
      for (let r = -1; r <= 1; r += 1) {
        if (row + r < 0 || row + r >= n) continue;
        for (let c = -1; c <= 1; c += 1) {
          if (col + c < 0 || col + c >= n || (r === 0 && c === 0)) continue;
          if (m[row + r]![col + c] === dark) same += 1;
        }
      }
      if (same > 5) points += 3 + same - 5;
    }
  }
  for (let row = 0; row < n - 1; row += 1) {
    for (let col = 0; col < n - 1; col += 1) {
      const count = Number(m[row]![col]) + Number(m[row + 1]![col]) + Number(m[row]![col + 1]) + Number(m[row + 1]![col + 1]);
      if (count === 0 || count === 4) points += 3;
    }
  }
  const finderLike = (at: (k: number) => boolean): boolean => at(0) && !at(1) && at(2) && at(3) && at(4) && !at(5) && at(6);
  for (let row = 0; row < n; row += 1) {
    for (let col = 0; col < n - 6; col += 1) if (finderLike((k) => m[row]![col + k]!)) points += 40;
  }
  for (let col = 0; col < n; col += 1) {
    for (let row = 0; row < n - 6; row += 1) if (finderLike((k) => m[row + k]![col]!)) points += 40;
  }
  let darkCount = 0;
  for (const line of m) for (const v of line) if (v) darkCount += 1;
  points += (Math.abs((100 * darkCount) / n / n - 50) / 5) * 10;
  return points;
}

/**
 * The QR symbol of `text` (UTF-8, byte mode, level M, the smallest version 1-10 that holds it).
 *
 * @throws RangeError when the text needs more than version 10 (213 bytes)
 */
export function qrMatrix(text: string): QrMatrix {
  const bytes = new TextEncoder().encode(text);
  let version = 1;
  while (version <= QR_MAX_VERSION && segmentBits(bytes, version) > dataCapacity(version) * 8) version += 1;
  if (version > QR_MAX_VERSION) throw new RangeError(`qrMatrix: ${bytes.length} bytes do not fit a version ${QR_MAX_VERSION} symbol`);
  const data = codewords(bytes, version);
  let best = 0;
  let lowest = Infinity;
  for (let mask = 0; mask < 8; mask += 1) {
    const p = penalty(build(version, data, mask, true));
    if (p < lowest) {
      lowest = p;
      best = mask;
    }
  }
  const dark = build(version, data, best, false);
  return { version, size: dark.length, dark };
}
