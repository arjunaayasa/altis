import { crc32, deflateSync } from 'node:zlib';
import { encodePng } from '../../src/files/png.js';

// PNG files built by hand for tests: any colour type and bit depth, any extra chunk, and whatever a test wants to
// break (the codec under test only ever writes 8-bit RGB or RGBA).

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** One chunk with a correct CRC. */
export function pngChunk(type: string, data: Uint8Array = new Uint8Array(0)): Buffer {
  const out = Buffer.alloc(12 + data.byteLength);
  out.writeUInt32BE(data.byteLength, 0);
  out.write(type, 4, 'latin1');
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.byteLength)), 8 + data.byteLength);
  return out;
}

export function ihdr(width: number, height: number, bitDepth: number, colorType: number, interlace = 0): Buffer {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = bitDepth;
  data[9] = colorType;
  data[12] = interlace;
  return pngChunk('IHDR', data);
}

export interface HandPng {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  /** One entry per row: the sample bytes, written with filter 0 unless `filters` names another per row. */
  rows: readonly (readonly number[])[];
  filters?: readonly number[];
  /** Chunks between IHDR and IDAT (PLTE, tRNS, tEXt, …), already built. */
  before?: readonly Uint8Array[];
  /** Bytes after IEND. */
  trailer?: Uint8Array;
}

/** A PNG with exactly these rows (already filtered when `filters` is given: the bytes are stored as they are). */
export function handPng(p: HandPng): Buffer {
  const raw = Buffer.concat(p.rows.map((row, y) => Buffer.from([p.filters?.[y] ?? 0, ...row])));
  return Buffer.concat([
    PNG_SIGNATURE,
    ihdr(p.width, p.height, p.bitDepth, p.colorType),
    ...(p.before ?? []),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND'),
    p.trailer ?? Buffer.alloc(0),
  ]);
}

/** A `width` × `height` PNG of one colour (RGBA), made by the codec. */
export function solidPng(width: number, height: number, rgba: readonly [number, number, number, number] = [200, 30, 30, 255]): Buffer {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.byteLength; i += 4) data.set(rgba, i);
  return Buffer.from(encodePng({ width, height, data }));
}

/** A `width` × `height` PNG whose pixels differ (a gradient with alpha), made by the codec. */
export function gradientPng(width: number, height: number): Buffer {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      data.set([(x * 255) / Math.max(1, width - 1), (y * 255) / Math.max(1, height - 1), (x + y) & 0xff, x < width / 2 ? 255 : 128], (y * width + x) * 4);
    }
  }
  return Buffer.from(encodePng({ width, height, data }));
}

/** The types of the chunks of `png`, in order (up to and including IEND). */
export function chunkTypes(png: Uint8Array): string[] {
  const b = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  const types: string[] = [];
  for (let at = 8; at + 12 <= b.byteLength; ) {
    const length = b.readUInt32BE(at);
    const type = b.toString('latin1', at + 4, at + 8);
    types.push(type);
    at += 12 + length;
    if (type === 'IEND') break;
  }
  return types;
}
