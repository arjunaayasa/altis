import { describe, expect, it } from 'vitest';
import { stripImageMetadata } from '../../src/files/strip-metadata.js';

// Metadata stripping of covers, floor plans and page images (Phase 2 spec §8, D2-18; plan Task 18): pure TypeScript,
// no image library. A JPEG loses its APP1 (EXIF, XMP) and APP13 (Photoshop/IPTC) segments, a PNG its `eXIf`, `tEXt`,
// `zTXt` and `iTXt` chunks, a WebP its `EXIF` and `XMP ` chunks (and the VP8X flags that announce them). What is left
// is the same image: every other segment or chunk byte for byte, and nothing after the image's end.

const bytes = (...parts: (number[] | Uint8Array | string)[]): Uint8Array => {
  const out: number[] = [];
  for (const p of parts) {
    if (typeof p === 'string') for (const ch of p) out.push(ch.charCodeAt(0));
    else out.push(...p);
  }
  return Uint8Array.from(out);
};

const latin1 = (b: Uint8Array): string => Buffer.from(b).toString('latin1');

// ---- JPEG --------------------------------------------------------------------------------------------------------

/** A marker segment `FF <marker>` with a two-byte length (which counts itself) and `payload`. */
function segment(marker: number, payload: Uint8Array | string): Uint8Array {
  const body = typeof payload === 'string' ? bytes(payload) : payload;
  const length = body.byteLength + 2;
  return bytes([0xff, marker, length >> 8, length & 0xff], body);
}

const SOI = [0xff, 0xd8];
const EOI = [0xff, 0xd9];
const APP0 = segment(0xe0, bytes('JFIF\0', [1, 1, 0, 0, 1, 0, 1, 0, 0]));
const EXIF = segment(0xe1, bytes('Exif\0\0', 'MM\0*\0\0\0\x08', 'GPS -6.2088,106.8456 Canon EOS'));
const XMP = segment(0xe1, bytes('http://ns.adobe.com/xap/1.0/\0', '<x:xmpmeta>Penulis Rahasia</x:xmpmeta>'));
const IPTC = segment(0xed, bytes('Photoshop 3.0\0', '8BIM\x04\x04\0\0\0\0\0\x10Penulis Rahasia'));
const ICC = segment(0xe2, bytes('ICC_PROFILE\0', [1, 1], 'profile-bytes'));
const DQT = segment(0xdb, bytes([0], new Uint8Array(64).fill(1)));
const SOF0 = segment(0xc0, bytes([8, 0, 16, 0, 16, 1, 1, 0x11, 0]));
const DHT = segment(0xc4, bytes([0], new Uint8Array(16).fill(0), [0]));
const SOS = segment(0xda, bytes([1, 1, 0, 0, 0x3f, 0]));
/** Entropy-coded data with a stuffed 0xFF (FF 00), a restart marker (FF D0) and fill bytes before the next marker. */
const SCAN = bytes([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0x78]);

/** The markers of a JPEG's segment chain up to the first SOS, checking every length; then whether it ends with EOI. */
function jpegChain(b: Uint8Array): { markers: number[]; endsWithEoi: boolean } {
  expect([b[0], b[1]]).toEqual(SOI);
  const markers: number[] = [];
  let at = 2;
  for (;;) {
    expect(b[at], `a marker at ${at}`).toBe(0xff);
    const marker = b[at + 1]!;
    markers.push(marker);
    const length = (b[at + 2]! << 8) | b[at + 3]!;
    expect(length).toBeGreaterThanOrEqual(2);
    expect(at + 2 + length).toBeLessThanOrEqual(b.byteLength);
    at += 2 + length;
    if (marker === 0xda) break;
  }
  return { markers, endsWithEoi: b[b.byteLength - 2] === 0xff && b[b.byteLength - 1] === 0xd9 };
}

describe('stripImageMetadata: JPEG', () => {
  const photo = bytes(SOI, APP0, EXIF, XMP, ICC, IPTC, DQT, SOF0, DHT, SOS, SCAN, EOI);

  it('drops APP1 (EXIF and XMP) and APP13, and keeps SOI followed by a valid segment chain', () => {
    const out = stripImageMetadata(photo, 'jpeg');
    expect(latin1(out)).not.toContain('Exif\0\0');
    expect(latin1(out)).not.toContain('Penulis Rahasia');
    expect(latin1(out)).not.toContain('Photoshop 3.0');
    const chain = jpegChain(out);
    expect(chain.markers).toEqual([0xe0, 0xe2, 0xdb, 0xc0, 0xc4, 0xda]);
    expect(chain.endsWithEoi).toBe(true);
    // Everything else is kept byte for byte, the scan data included.
    expect(out).toEqual(bytes(SOI, APP0, ICC, DQT, SOF0, DHT, SOS, SCAN, EOI));
  });

  it('strips the segments between the scans of a progressive JPEG, and drops what follows EOI', () => {
    const SOF2 = segment(0xc2, bytes([8, 0, 16, 0, 16, 1, 1, 0x11, 0]));
    const progressive = bytes(SOI, APP0, DQT, SOF2, DHT, SOS, SCAN, DHT, EXIF, SOS, SCAN, EOI, 'PK\x03\x04appended zip');
    const out = stripImageMetadata(progressive, 'jpeg');
    expect(out).toEqual(bytes(SOI, APP0, DQT, SOF2, DHT, SOS, SCAN, DHT, SOS, SCAN, EOI));
  });

  it('keeps fill bytes out and accepts a JPEG without metadata unchanged', () => {
    const plain = bytes(SOI, APP0, DQT, SOF0, DHT, SOS, SCAN, EOI);
    expect(stripImageMetadata(plain, 'jpeg')).toEqual(plain);
    // Fill bytes (FF FF …) before a marker are allowed and dropped.
    const filled = bytes(SOI, [0xff, 0xff], APP0, DQT, SOF0, DHT, SOS, SCAN, EOI);
    expect(stripImageMetadata(filled, 'jpeg')).toEqual(plain);
  });

  // C15: a phone keeps a portrait photo's pixels landscape and says so in the EXIF Orientation tag (0x0112), which the
  // browser applies; dropping the whole EXIF block would store the photo sideways. That one tag is kept, in an EXIF
  // block of its own; every other tag (camera, serial, GPS) and the rest of the block still go.
  describe('the EXIF orientation (C15)', () => {
    /** A TIFF IFD0 with Make, Orientation (unless null), a GPS IFD pointer and a GPS IFD, in `order`. */
    function exif(order: 'II' | 'MM', orientation: number | null, header = 'Exif\0\0'): Uint8Array {
      const le = order === 'II';
      const u16 = (n: number): number[] => (le ? [n & 0xff, n >> 8] : [n >> 8, n & 0xff]);
      const u32 = (n: number): number[] => (le ? [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24] : [n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
      const entries = orientation === null ? 2 : 3;
      const valueArea = 8 + 2 + entries * 12 + 4;
      const make = bytes('Canon EOS\0'); // 10 bytes at valueArea
      const gpsIfd = valueArea + make.byteLength;
      const gpsText = bytes('GPS -6.2088,106.8456\0'); // after the GPS IFD (2 + 12 + 4 bytes)
      const ifd0 = [
        ...u16(entries),
        ...u16(0x010f), ...u16(2), ...u32(make.byteLength), ...u32(valueArea), // Make (ASCII), at an offset
        ...(orientation === null ? [] : [...u16(0x0112), ...u16(3), ...u32(1), ...u16(orientation), 0, 0]), // Orientation (SHORT)
        ...u16(0x8825), ...u16(4), ...u32(1), ...u32(gpsIfd), // the GPS IFD pointer (LONG)
        ...u32(0), // no IFD1
      ];
      const gps = [...u16(1), ...u16(0x0001), ...u16(2), ...u32(gpsText.byteLength), ...u32(gpsIfd + 18), ...u32(0)];
      const tiff = bytes(order, u16(42), u32(8), ifd0, make, gps, gpsText);
      return segment(0xe1, bytes(header, tiff));
    }
    /** The EXIF block the stripper writes in place of one with orientation `n`: Orientation alone, nothing else. */
    const ORIENTATION = (n: number): Uint8Array =>
      segment(0xe1, bytes('Exif\0\0', 'MM\0*\0\0\0\x08', [0, 1], [0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, n, 0, 0], [0, 0, 0, 0]));

    it.each(['II', 'MM'] as const)('keeps the orientation (6, %s byte order) alone, where the EXIF block was', (order) => {
      const photo = bytes(SOI, APP0, exif(order, 6), XMP, ICC, IPTC, DQT, SOF0, DHT, SOS, SCAN, EOI);
      expect(latin1(photo)).toContain('Canon EOS');
      const out = stripImageMetadata(photo, 'jpeg');
      expect(out).toEqual(bytes(SOI, APP0, ORIENTATION(6), ICC, DQT, SOF0, DHT, SOS, SCAN, EOI));
      for (const secret of ['Canon EOS', 'GPS -6.2088', 'Penulis Rahasia', 'Photoshop 3.0']) expect(latin1(out)).not.toContain(secret);
      expect(jpegChain(out).markers).toEqual([0xe0, 0xe1, 0xe2, 0xdb, 0xc0, 0xc4, 0xda]);
    });

    it.each([2, 3, 4, 5, 7, 8])('keeps orientation %i, as a browser applies it', (n) => {
      const out = stripImageMetadata(bytes(SOI, exif('II', n), APP0, DQT, SOF0, DHT, SOS, SCAN, EOI), 'jpeg');
      expect(out).toEqual(bytes(SOI, ORIENTATION(n), APP0, DQT, SOF0, DHT, SOS, SCAN, EOI));
    });

    it('drops the block whole when it has no orientation to keep: none, the normal 1, or a value past 8', () => {
      const plain = bytes(SOI, APP0, DQT, SOF0, DHT, SOS, SCAN, EOI);
      for (const orientation of [null, 1, 0, 9]) {
        expect(stripImageMetadata(bytes(SOI, APP0, exif('MM', orientation), DQT, SOF0, DHT, SOS, SCAN, EOI), 'jpeg'), String(orientation)).toEqual(plain);
      }
    });

    it('drops an EXIF block whose structure does not hold, as before (an IFD0 past the end, no TIFF byte order)', () => {
      const plain = bytes(SOI, APP0, DQT, SOF0, DHT, SOS, SCAN, EOI);
      const pastTheEnd = segment(0xe1, bytes('Exif\0\0', 'MM\0*\0\0\x7f\xff', [0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0]));
      const noOrder = segment(0xe1, bytes('Exif\0\0', 'XX\0*\0\0\0\x08', [0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0]));
      const cut = segment(0xe1, bytes('Exif\0\0', 'MM\0*\0\0\0\x08', [0, 2, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0]));
      for (const block of [pastTheEnd, noOrder, cut]) expect(stripImageMetadata(bytes(SOI, APP0, block, DQT, SOF0, DHT, SOS, SCAN, EOI), 'jpeg')).toEqual(plain);
    });

    it('writes one orientation block: the first EXIF block that has one decides, as a browser reads it', () => {
      const out = stripImageMetadata(bytes(SOI, APP0, exif('MM', null), exif('II', 8), exif('MM', 6), DQT, SOF0, DHT, SOS, SCAN, EOI), 'jpeg');
      expect(out).toEqual(bytes(SOI, APP0, ORIENTATION(8), DQT, SOF0, DHT, SOS, SCAN, EOI));
    });
  });

  it.each([
    ['no SOI', bytes(APP0, EOI)],
    ['a segment longer than the file', bytes(SOI, [0xff, 0xe1, 0x7f, 0xff], 'Exif\0\0')],
    ['a length below 2', bytes(SOI, [0xff, 0xe0, 0x00, 0x01], DQT, SOS, SCAN, EOI)],
    ['no marker where one belongs', bytes(SOI, [0x12, 0x34], SOS, SCAN, EOI)],
    ['no SOS before the end', bytes(SOI, APP0, DQT)],
    ['a scan without EOI', bytes(SOI, APP0, DQT, SOF0, DHT, SOS, SCAN)],
  ])('refuses a malformed JPEG (%s)', (_name, input) => {
    expect(() => stripImageMetadata(input, 'jpeg')).toThrow(TypeError);
  });
});

// ---- PNG ---------------------------------------------------------------------------------------------------------

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A PNG chunk; the CRC is a fixed fake (stripping never recomputes or checks it, it copies kept chunks whole). */
function chunk(type: string, data: Uint8Array | string): Uint8Array {
  const body = typeof data === 'string' ? bytes(data) : data;
  const n = body.byteLength;
  return bytes([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff], type, body, [0xde, 0xad, 0xbe, 0xef]);
}

/** The chunk types of a PNG, in order, checking every length. */
function pngChunks(b: Uint8Array): string[] {
  expect([...b.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
  const types: string[] = [];
  for (let at = 8; at < b.byteLength; ) {
    const n = ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;
    types.push(latin1(b.subarray(at + 4, at + 8)));
    at += 12 + n;
    expect(at).toBeLessThanOrEqual(b.byteLength);
  }
  return types;
}

describe('stripImageMetadata: PNG', () => {
  const IHDR = chunk('IHDR', bytes([0, 0, 0, 16, 0, 0, 0, 16, 8, 6, 0, 0, 0]));
  const IDAT = chunk('IDAT', bytes('compressed-pixels'));
  const IEND = chunk('IEND', '');

  it('drops tEXt, zTXt, iTXt and eXIf and keeps every other chunk whole', () => {
    const png = bytes(
      PNG_SIGNATURE,
      IHDR,
      chunk('tEXt', 'Author\0Penulis Rahasia'),
      chunk('iCCP', 'icc\0\0zz'),
      chunk('zTXt', 'Comment\0\0zz'),
      chunk('iTXt', 'XML:com.adobe.xmp\0\0\0\0\0<x:xmpmeta/>'),
      chunk('eXIf', 'MM\0*GPS'),
      IDAT,
      IEND,
    );
    const out = stripImageMetadata(png, 'png');
    expect(pngChunks(out)).toEqual(['IHDR', 'iCCP', 'IDAT', 'IEND']);
    expect(latin1(out)).not.toContain('tEXt');
    expect(latin1(out)).not.toContain('Penulis Rahasia');
    expect(out).toEqual(bytes(PNG_SIGNATURE, IHDR, chunk('iCCP', 'icc\0\0zz'), IDAT, IEND));
  });

  it('drops what follows IEND', () => {
    const out = stripImageMetadata(bytes(PNG_SIGNATURE, IHDR, IDAT, IEND, 'trailing secret'), 'png');
    expect(out).toEqual(bytes(PNG_SIGNATURE, IHDR, IDAT, IEND));
  });

  it.each([
    ['a bad signature', bytes([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0], IHDR, IEND)],
    ['a chunk longer than the file', bytes(PNG_SIGNATURE, IHDR, [0, 0, 0x7f, 0xff], 'IDAT', 'x')],
    ['no IEND', bytes(PNG_SIGNATURE, IHDR, IDAT)],
  ])('refuses a malformed PNG (%s)', (_name, input) => {
    expect(() => stripImageMetadata(input, 'png')).toThrow(TypeError);
  });
});

// ---- WebP --------------------------------------------------------------------------------------------------------

/** A RIFF chunk: FourCC, little-endian size, the data, a pad byte when the size is odd. */
function riffChunk(fourcc: string, data: Uint8Array | string): Uint8Array {
  const body = typeof data === 'string' ? bytes(data) : data;
  const n = body.byteLength;
  return bytes(fourcc, [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff], body, n % 2 === 1 ? [0] : []);
}

function webp(...chunks: Uint8Array[]): Uint8Array {
  const body = bytes('WEBP', ...chunks);
  const n = body.byteLength;
  return bytes('RIFF', [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff], body);
}

/** The FourCCs of a WebP's chunks, checking the RIFF size and every chunk size. */
function webpChunks(b: Uint8Array): string[] {
  expect(latin1(b.subarray(0, 4))).toBe('RIFF');
  expect(latin1(b.subarray(8, 12))).toBe('WEBP');
  const riffSize = b[4]! | (b[5]! << 8) | (b[6]! << 16) | (b[7]! << 24);
  expect(riffSize + 8).toBe(b.byteLength);
  const out: string[] = [];
  for (let at = 12; at < b.byteLength; ) {
    const n = b[at + 4]! | (b[at + 5]! << 8) | (b[at + 6]! << 16) | (b[at + 7]! << 24);
    out.push(latin1(b.subarray(at, at + 4)));
    at += 8 + n + (n % 2);
    expect(at).toBeLessThanOrEqual(b.byteLength);
  }
  return out;
}

describe('stripImageMetadata: WebP', () => {
  /** VP8X: flags (ICC 0x20, alpha 0x10, EXIF 0x08, XMP 0x04), 3 reserved bytes, canvas width - 1 and height - 1. */
  const vp8x = (flags: number) => riffChunk('VP8X', bytes([flags, 0, 0, 0, 15, 0, 0, 15, 0, 0]));
  const VP8 = riffChunk('VP8 ', bytes('vp8-frame-data'));

  it('drops EXIF and XMP chunks, clears their VP8X flags and fixes the RIFF size', () => {
    const input = webp(vp8x(0x20 | 0x10 | 0x08 | 0x04), riffChunk('ICCP', 'icc'), VP8, riffChunk('EXIF', 'MM\0*GPS'), riffChunk('XMP ', '<x:xmpmeta>Penulis Rahasia</x:xmpmeta>'));
    const out = stripImageMetadata(input, 'webp');
    expect(webpChunks(out)).toEqual(['VP8X', 'ICCP', 'VP8 ']);
    expect(latin1(out)).not.toContain('Penulis Rahasia');
    expect(out).toEqual(webp(vp8x(0x20 | 0x10), riffChunk('ICCP', 'icc'), VP8));
  });

  it('leaves a simple WebP as it is, and drops bytes after the RIFF chunk', () => {
    const simple = webp(VP8);
    expect(stripImageMetadata(simple, 'webp')).toEqual(simple);
    expect(stripImageMetadata(bytes(simple, 'appended'), 'webp')).toEqual(simple);
  });

  it.each([
    ['no RIFF header', bytes('RIFX', [4, 0, 0, 0], 'WEBP')],
    ['a RIFF size past the end', bytes('RIFF', [0xff, 0, 0, 0], 'WEBP', VP8)],
    ['a chunk past the RIFF end', webp(bytes('VP8 ', [0x40, 0, 0, 0], 'short'))],
    ['no image chunk at all', webp(riffChunk('EXIF', 'x'))],
  ])('refuses a malformed WebP (%s)', (_name, input) => {
    expect(() => stripImageMetadata(input, 'webp')).toThrow(TypeError);
  });
});
