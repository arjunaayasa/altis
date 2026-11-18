import { crc32, deflateSync, inflateSync } from 'node:zlib';

// A small PNG codec on node:zlib, for the images the server stores again instead of keeping as uploaded (the site's
// logo and icon): decoding to plain pixels and encoding those pixels is what removes every text, EXIF and colour
// profile chunk, anything appended after the image, and whatever else a file can hide.
//
// - Decoding reads IHDR, PLTE, tRNS, IDAT and IEND only. Every chunk's CRC is checked; an unknown critical chunk, a
//   missing IEND and an interlaced (Adam7) image are refused; whatever follows IEND is never looked at. All five
//   colour types and their bit depths are read, into 8-bit RGBA.
// - The width and height of the header are checked against the caller's limit before any pixel is inflated, and the
//   inflated size is capped at exactly what that header needs, so a small file cannot expand into a huge buffer.
// - Encoding writes 8-bit RGBA, or 8-bit RGB when every pixel is opaque: IHDR, one IDAT, IEND, nothing else. The same
//   pixels give the same bytes.
// - `scaleDown` is an area average (each new pixel is the mean of the old pixels it covers, by covered area), on
//   colours multiplied by their alpha, so a transparent pixel's colour never bleeds into an edge.

/** Pixels in 8-bit RGBA, row by row from the top left, alpha not premultiplied. */
export interface RasterImage {
  width: number;
  height: number;
  data: Uint8Array;
}

/** Why a PNG was refused: its structure does not hold, its sides exceed the limit, or it is interlaced. */
export type PngRefusal = 'damaged' | 'dimensions' | 'interlaced';

/** A PNG that cannot be decoded; `reason` says why. */
export class PngError extends Error {
  readonly reason: PngRefusal;
  constructor(reason: PngRefusal, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PngError';
    this.reason = reason;
  }
}

/** What IHDR says of an image. */
export interface PngHeader {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlaced: boolean;
}

const SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
/** The bit depths each colour type allows (PNG specification, table 11.1). */
const DEPTHS: Readonly<Record<number, readonly number[]>> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
/** Samples per pixel of each colour type. */
const CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const damaged = (message: string): PngError => new PngError('damaged', message);

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function hasSignature(bytes: Uint8Array): boolean {
  return bytes.byteLength >= SIGNATURE.length && SIGNATURE.every((b, i) => bytes[i] === b);
}

/** One chunk at `at`: its type, its data (a view) and where the next chunk begins. The CRC is checked. */
function chunkAt(bytes: Uint8Array, dv: DataView, at: number): { type: string; data: Uint8Array; next: number } {
  if (at + 12 > bytes.byteLength) throw damaged('the file ends inside a chunk');
  const length = dv.getUint32(at);
  const end = at + 12 + length;
  if (length > 0x7fffffff || end > bytes.byteLength) throw damaged('a chunk is longer than the file');
  const typed = bytes.subarray(at + 4, at + 8 + length);
  if (crc32(typed) !== dv.getUint32(at + 8 + length)) throw damaged('a chunk fails its CRC');
  let type = '';
  for (let i = 0; i < 4; i += 1) {
    const c = typed[i]!;
    if (!((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a))) throw damaged('a chunk type is not four letters');
    type += String.fromCharCode(c);
  }
  return { type, data: typed.subarray(4), next: end };
}

function headerOf(data: Uint8Array): PngHeader {
  if (data.byteLength !== 13) throw damaged('IHDR is not 13 bytes');
  const dv = view(data);
  const width = dv.getUint32(0);
  const height = dv.getUint32(4);
  const bitDepth = data[8]!;
  const colorType = data[9]!;
  if (width === 0 || height === 0 || width > 0x7fffffff || height > 0x7fffffff) throw damaged('the width or height is not valid');
  if (DEPTHS[colorType]?.includes(bitDepth) !== true) throw damaged('the colour type and bit depth do not go together');
  if (data[10] !== 0 || data[11] !== 0 || data[12]! > 1) throw damaged('the compression, filter or interlace method is unknown');
  return { width, height, bitDepth, colorType, interlaced: data[12] === 1 };
}

/**
 * The header of a PNG: the signature and a first chunk IHDR with a good CRC and values the format allows. Nothing
 * else is read.
 *
 * @throws PngError `damaged`
 */
export function pngHeader(bytes: Uint8Array): PngHeader {
  if (!hasSignature(bytes)) throw damaged('the PNG signature is missing');
  const first = chunkAt(bytes, view(bytes), SIGNATURE.length);
  if (first.type !== 'IHDR') throw damaged('the first chunk is not IHDR');
  return headerOf(first.data);
}

/** The Paeth predictor of the PNG specification. */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Undoes the row filters of `raw` (each row: a filter byte, then `rowBytes`) in place. */
function unfilter(raw: Uint8Array, height: number, rowBytes: number, bpp: number): void {
  const stride = rowBytes + 1;
  for (let y = 0; y < height; y += 1) {
    const at = y * stride + 1;
    const up = at - stride;
    const filter = raw[at - 1]!;
    switch (filter) {
      case 0:
        break;
      case 1:
        for (let i = bpp; i < rowBytes; i += 1) raw[at + i] = (raw[at + i]! + raw[at + i - bpp]!) & 0xff;
        break;
      case 2:
        if (y > 0) for (let i = 0; i < rowBytes; i += 1) raw[at + i] = (raw[at + i]! + raw[up + i]!) & 0xff;
        break;
      case 3:
        for (let i = 0; i < rowBytes; i += 1) {
          const left = i >= bpp ? raw[at + i - bpp]! : 0;
          const above = y > 0 ? raw[up + i]! : 0;
          raw[at + i] = (raw[at + i]! + ((left + above) >> 1)) & 0xff;
        }
        break;
      case 4:
        for (let i = 0; i < rowBytes; i += 1) {
          const left = i >= bpp ? raw[at + i - bpp]! : 0;
          const above = y > 0 ? raw[up + i]! : 0;
          const corner = i >= bpp && y > 0 ? raw[up + i - bpp]! : 0;
          raw[at + i] = (raw[at + i]! + paeth(left, above, corner)) & 0xff;
        }
        break;
      default:
        throw damaged('a row names an unknown filter');
    }
  }
}

interface Extras {
  /** The palette as RGB triples (colour type 3). */
  palette: Uint8Array | null;
  /** tRNS as given: palette alphas, or the one transparent grey or RGB sample (16 bits each). */
  transparency: Uint8Array | null;
}

/** The unfiltered rows of `raw` as 8-bit RGBA. */
function toRgba(raw: Uint8Array, h: PngHeader, rowBytes: number, x: Extras): Uint8Array {
  const { width, height, bitDepth, colorType } = h;
  const out = new Uint8Array(width * height * 4);
  const stride = rowBytes + 1;
  const wide = bitDepth === 16;
  const step = wide ? 2 : 1;
  const t = x.transparency;
  /** Sample `i` of the row at `at` in full (16 bits when wide). */
  const full = (at: number, i: number): number => (wide ? (raw[at + i * 2]! << 8) | raw[at + i * 2 + 1]! : raw[at + i]!);
  if (colorType === 3 && x.palette === null) throw damaged('an indexed image has no palette');
  if (t !== null && ((colorType === 0 && t.byteLength !== 2) || (colorType === 2 && t.byteLength !== 6))) throw damaged('tRNS has the wrong length');
  const keyGrey = t !== null && colorType === 0 ? (t[0]! << 8) | t[1]! : -1;
  const keyRgb = t !== null && colorType === 2 ? [(t[0]! << 8) | t[1]!, (t[2]! << 8) | t[3]!, (t[4]! << 8) | t[5]!] : null;
  const greyScale = bitDepth === 1 ? 255 : bitDepth === 2 ? 85 : bitDepth === 4 ? 17 : 1;
  const mask = (1 << bitDepth) - 1;

  for (let y = 0; y < height; y += 1) {
    const at = y * stride + 1;
    let o = y * width * 4;
    for (let px = 0; px < width; px += 1, o += 4) {
      if (colorType === 6) {
        const i = at + px * 4 * step;
        out[o] = raw[i]!;
        out[o + 1] = raw[i + step]!;
        out[o + 2] = raw[i + 2 * step]!;
        out[o + 3] = raw[i + 3 * step]!;
      } else if (colorType === 2) {
        const i = at + px * 3 * step;
        out[o] = raw[i]!;
        out[o + 1] = raw[i + step]!;
        out[o + 2] = raw[i + 2 * step]!;
        const keyed = keyRgb !== null && full(at, px * 3) === keyRgb[0] && full(at, px * 3 + 1) === keyRgb[1] && full(at, px * 3 + 2) === keyRgb[2];
        out[o + 3] = keyed ? 0 : 255;
      } else if (colorType === 4) {
        const i = at + px * 2 * step;
        out[o] = out[o + 1] = out[o + 2] = raw[i]!;
        out[o + 3] = raw[i + step]!;
      } else {
        // One sample per pixel: grey (colour type 0) or a palette index (3), 1 to 16 bits.
        let sample: number;
        if (bitDepth >= 8) sample = full(at, px);
        else {
          const bit = px * bitDepth;
          sample = (raw[at + (bit >> 3)]! >> (8 - bitDepth - (bit & 7))) & mask;
        }
        if (colorType === 3) {
          const palette = x.palette!;
          if (sample * 3 + 2 >= palette.byteLength) throw damaged('a pixel names a colour the palette does not have');
          out[o] = palette[sample * 3]!;
          out[o + 1] = palette[sample * 3 + 1]!;
          out[o + 2] = palette[sample * 3 + 2]!;
          out[o + 3] = t !== null && sample < t.byteLength ? t[sample]! : 255;
        } else {
          out[o] = out[o + 1] = out[o + 2] = wide ? sample >> 8 : sample * greyScale;
          out[o + 3] = sample === keyGrey ? 0 : 255;
        }
      }
    }
  }
  return out;
}

/**
 * Decodes a PNG into 8-bit RGBA. `maxSide` bounds the width and the height the header may name; it is checked before
 * the pixel data is inflated, and the inflated size is capped at what the header needs.
 *
 * @throws PngError `dimensions` (a side above `maxSide`), `interlaced`, or `damaged` (anything else: a bad signature
 *   or CRC, a truncated file, an unknown critical chunk, pixel data of the wrong size, …)
 */
export function decodePng(bytes: Uint8Array, o: { maxSide: number }): RasterImage {
  const header = pngHeader(bytes);
  if (header.width > o.maxSide || header.height > o.maxSide) {
    throw new PngError('dimensions', `the image is ${header.width} x ${header.height}, above ${o.maxSide} a side`);
  }
  if (header.interlaced) throw new PngError('interlaced', 'interlaced PNG is not read');

  const dv = view(bytes);
  const extras: Extras = { palette: null, transparency: null };
  const idat: Uint8Array[] = [];
  let ended = false;
  for (let at = chunkAt(bytes, dv, SIGNATURE.length).next; !ended; ) {
    const chunk = chunkAt(bytes, dv, at);
    at = chunk.next;
    switch (chunk.type) {
      case 'IHDR':
        throw damaged('a second IHDR');
      case 'PLTE':
        if (chunk.data.byteLength === 0 || chunk.data.byteLength % 3 !== 0 || chunk.data.byteLength > 768 || extras.palette !== null || idat.length > 0) {
          throw damaged('the palette is not valid');
        }
        extras.palette = chunk.data;
        break;
      case 'tRNS':
        if (extras.transparency !== null || idat.length > 0 || header.colorType === 4 || header.colorType === 6 || chunk.data.byteLength > 256) {
          throw damaged('tRNS is not valid here');
        }
        extras.transparency = chunk.data;
        break;
      case 'IDAT':
        idat.push(chunk.data);
        break;
      case 'IEND':
        ended = true; // whatever follows is not part of the image
        break;
      default:
        // An ancillary chunk (lower-case first letter) is skipped; a critical one this reader does not know is refused.
        if (chunk.type.charCodeAt(0) < 0x61) throw damaged(`unknown critical chunk ${chunk.type}`);
    }
  }
  if (idat.length === 0) throw damaged('no pixel data');

  const bitsPerPixel = CHANNELS[header.colorType]! * header.bitDepth;
  const rowBytes = Math.ceil((header.width * bitsPerPixel) / 8);
  const expected = header.height * (rowBytes + 1);
  let raw: Uint8Array;
  try {
    // One byte more than needed is allowed, so that pixel data that is too long is seen as such (not cut off).
    raw = inflateSync(idat.length === 1 ? idat[0]! : Buffer.concat(idat), { maxOutputLength: expected + 1 });
  } catch (error) {
    throw new PngError('damaged', 'the pixel data cannot be inflated', { cause: error });
  }
  if (raw.byteLength !== expected) throw damaged('the pixel data has the wrong size');
  unfilter(raw, header.height, rowBytes, Math.max(1, bitsPerPixel >> 3));
  return { width: header.width, height: header.height, data: toRgba(raw, header, rowBytes, extras) };
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.byteLength);
  out.writeUInt32BE(data.byteLength, 0);
  out.write(type, 4, 'latin1');
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.byteLength)), 8 + data.byteLength);
  return out;
}

/**
 * Encodes `image` as a PNG: 8-bit RGB when every pixel is opaque, else 8-bit RGBA; IHDR, one IDAT and IEND only. Each
 * row takes the filter with the smallest sum of absolute differences (the first of equals), so the output depends on
 * the pixels alone.
 */
export function encodePng(image: RasterImage): Uint8Array {
  const { width, height, data } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || data.byteLength !== width * height * 4) {
    throw new TypeError('encodePng: the image is not width x height RGBA');
  }
  let opaque = true;
  for (let i = 3; i < data.byteLength; i += 4) {
    if (data[i] !== 255) {
      opaque = false;
      break;
    }
  }
  const bpp = opaque ? 3 : 4;
  const rowBytes = width * bpp;
  const raw = Buffer.alloc(height * (rowBytes + 1));
  let prev = new Uint8Array(rowBytes);
  let row = new Uint8Array(rowBytes);
  const tries = [0, 1, 2, 3, 4].map(() => new Uint8Array(rowBytes));
  for (let y = 0; y < height; y += 1) {
    if (opaque) for (let px = 0, s = y * width * 4, d = 0; px < width; px += 1, s += 4, d += 3) row.set(data.subarray(s, s + 3), d);
    else row.set(data.subarray(y * rowBytes, (y + 1) * rowBytes));
    let best = 0;
    let bestSum = Infinity;
    for (let f = 0; f < 5; f += 1) {
      const out = tries[f]!;
      let sum = 0;
      for (let i = 0; i < rowBytes; i += 1) {
        const left = i >= bpp ? row[i - bpp]! : 0;
        const above = prev[i]!;
        const corner = i >= bpp ? prev[i - bpp]! : 0;
        const predicted = f === 0 ? 0 : f === 1 ? left : f === 2 ? above : f === 3 ? (left + above) >> 1 : paeth(left, above, corner);
        const v = (row[i]! - predicted) & 0xff;
        out[i] = v;
        sum += v < 128 ? v : 256 - v;
      }
      if (sum < bestSum) {
        bestSum = sum;
        best = f;
      }
    }
    raw[y * (rowBytes + 1)] = best;
    raw.set(tries[best]!, y * (rowBytes + 1) + 1);
    [prev, row] = [row, prev];
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = opaque ? 2 : 6;
  const out = Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', new Uint8Array(0))]);
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

/** For each of `to` new cells along an axis of `from` old ones: the first old cell it covers and the share of each. */
function coverage(from: number, to: number): { first: number; weights: Float64Array }[] {
  const scale = from / to;
  const cells: { first: number; weights: Float64Array }[] = [];
  for (let i = 0; i < to; i += 1) {
    const lo = i * scale;
    const hi = Math.min(from, (i + 1) * scale);
    const first = Math.min(from - 1, Math.floor(lo));
    const last = Math.max(first, Math.min(from - 1, Math.ceil(hi) - 1));
    const weights = new Float64Array(last - first + 1);
    let total = 0;
    for (let j = first; j <= last; j += 1) {
      const w = Math.max(0, Math.min(j + 1, hi) - Math.max(j, lo));
      weights[j - first] = w;
      total += w;
    }
    if (total <= 0) weights.fill(1 / weights.length);
    else for (let j = 0; j < weights.length; j += 1) weights[j] = weights[j]! / total;
    cells.push({ first, weights });
  }
  return cells;
}

/**
 * `image` scaled down to `width` × `height` by area average, on alpha-premultiplied colours. The image itself when it
 * already has that size.
 *
 * @throws TypeError when a new side is not a whole number from 1 to the old side (this never scales up)
 */
export function scaleDown(image: RasterImage, width: number, height: number): RasterImage {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > image.width || height > image.height) {
    throw new TypeError('scaleDown: the new size must be whole and no larger than the image');
  }
  if (width === image.width && height === image.height) return image;
  const cols = coverage(image.width, width);
  const rows = coverage(image.height, height);
  const src = image.data;
  const out = new Uint8Array(width * height * 4);
  // One source row reduced along x (premultiplied R, G, B and alpha); a row on a boundary is reduced once and reused.
  const reduced = new Float64Array(width * 4);
  let reducedRow = -1;
  const reduce = (y: number): void => {
    if (reducedRow === y) return;
    reducedRow = y;
    const base = y * image.width * 4;
    for (let x = 0; x < width; x += 1) {
      const { first, weights } = cols[x]!;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let j = 0; j < weights.length; j += 1) {
        const i = base + (first + j) * 4;
        const wa = weights[j]! * src[i + 3]!;
        r += wa * src[i]!;
        g += wa * src[i + 1]!;
        b += wa * src[i + 2]!;
        a += wa;
      }
      reduced[x * 4] = r;
      reduced[x * 4 + 1] = g;
      reduced[x * 4 + 2] = b;
      reduced[x * 4 + 3] = a;
    }
  };
  const acc = new Float64Array(width * 4);
  for (let y = 0; y < height; y += 1) {
    const { first, weights } = rows[y]!;
    acc.fill(0);
    for (let j = 0; j < weights.length; j += 1) {
      reduce(first + j);
      const w = weights[j]!;
      for (let i = 0; i < acc.length; i += 1) acc[i] = acc[i]! + w * reduced[i]!;
    }
    for (let x = 0, o = y * width * 4; x < width; x += 1, o += 4) {
      const a = acc[x * 4 + 3]!;
      if (a <= 0) continue; // fully transparent: zeros
      out[o] = Math.min(255, Math.round(acc[x * 4]! / a));
      out[o + 1] = Math.min(255, Math.round(acc[x * 4 + 1]! / a));
      out[o + 2] = Math.min(255, Math.round(acc[x * 4 + 2]! / a));
      out[o + 3] = Math.min(255, Math.round(a));
    }
  }
  return { width, height, data: out };
}

/** The centre square of `image` (its shorter side); the image itself when it is square. */
export function cropSquare(image: RasterImage): RasterImage {
  const side = Math.min(image.width, image.height);
  if (image.width === side && image.height === side) return image;
  const left = (image.width - side) >> 1;
  const top = (image.height - side) >> 1;
  const data = new Uint8Array(side * side * 4);
  for (let y = 0; y < side; y += 1) {
    const from = ((top + y) * image.width + left) * 4;
    data.set(image.data.subarray(from, from + side * 4), y * side * 4);
  }
  return { width: side, height: side, data };
}
