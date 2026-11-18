import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { PngError, cropSquare, decodePng, encodePng, pngHeader, scaleDown, type RasterImage } from '../../src/files/png.js';
import { SiteImageError, defaultSiteIcon, siteIconVariant, storedSiteIcon, storedSiteLogo } from '../../src/files/site-images.js';
import { PNG_SIGNATURE, chunkTypes, gradientPng, handPng, ihdr, pngChunk, solidPng } from '../fixtures/png.js';

// The PNG codec the logo and icon uploads are stored again with: every colour type and bit depth decodes to RGBA,
// only the picture survives a round trip, and a file that is damaged, too large or not really a PNG is refused
// before it can cost memory.

const LIMIT = { maxSide: 4000 };

function pixels(image: RasterImage): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < image.data.byteLength; i += 4) out.push([...image.data.subarray(i, i + 4)]);
  return out;
}

function refusal(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof PngError || error instanceof SiteImageError) return error.reason;
    throw error;
  }
  return 'accepted';
}

describe('decodePng', () => {
  it('reads 8-bit RGBA and RGB, with every row filter', () => {
    // Row 0 unfiltered; row 1 Sub; row 2 Up; row 3 Average; row 4 Paeth: all decode to the same two pixels.
    const px = [10, 20, 30, 255, 50, 70, 90, 128];
    const sub = [10, 20, 30, 255, 40, 50, 60, (128 - 255) & 0xff];
    const up = [0, 0, 0, 0, 0, 0, 0, 0];
    const avg = [10 - 5, 20 - 10, 30 - 15, 255 - 127, 50 - ((10 + 50) >> 1), 70 - ((20 + 70) >> 1), 90 - ((30 + 90) >> 1), (128 - ((255 + 128) >> 1)) & 0xff];
    const paeth = [0, 0, 0, 0, 0, 0, 0, 0];
    const png = handPng({ width: 2, height: 5, bitDepth: 8, colorType: 6, rows: [px, sub, up, avg, paeth], filters: [0, 1, 2, 3, 4] });
    const image = decodePng(png, LIMIT);
    expect(pixels(image)).toEqual(Array.from({ length: 5 }, () => [[10, 20, 30, 255], [50, 70, 90, 128]]).flat());

    const rgb = decodePng(handPng({ width: 2, height: 1, bitDepth: 8, colorType: 2, rows: [[1, 2, 3, 4, 5, 6]] }), LIMIT);
    expect(pixels(rgb)).toEqual([[1, 2, 3, 255], [4, 5, 6, 255]]);
  });

  it('reads grey at 1, 2, 4, 8 and 16 bits, scaled to 8 bits', () => {
    expect(pixels(decodePng(handPng({ width: 3, height: 1, bitDepth: 1, colorType: 0, rows: [[0b10100000]] }), LIMIT)).map((p) => p[0])).toEqual([255, 0, 255]);
    expect(pixels(decodePng(handPng({ width: 4, height: 1, bitDepth: 2, colorType: 0, rows: [[0b00011011]] }), LIMIT)).map((p) => p[0])).toEqual([0, 85, 170, 255]);
    expect(pixels(decodePng(handPng({ width: 2, height: 1, bitDepth: 4, colorType: 0, rows: [[0x3f]] }), LIMIT)).map((p) => p[0])).toEqual([51, 255]);
    expect(pixels(decodePng(handPng({ width: 2, height: 1, bitDepth: 8, colorType: 0, rows: [[7, 200]] }), LIMIT))).toEqual([[7, 7, 7, 255], [200, 200, 200, 255]]);
    expect(pixels(decodePng(handPng({ width: 2, height: 1, bitDepth: 16, colorType: 0, rows: [[0x12, 0x34, 0xff, 0x00]] }), LIMIT)).map((p) => p[0])).toEqual([0x12, 0xff]);
  });

  it('reads grey with alpha and 16-bit colour, keeping the high byte of each sample', () => {
    expect(pixels(decodePng(handPng({ width: 1, height: 1, bitDepth: 8, colorType: 4, rows: [[90, 40]] }), LIMIT))).toEqual([[90, 90, 90, 40]]);
    expect(pixels(decodePng(handPng({ width: 1, height: 1, bitDepth: 16, colorType: 4, rows: [[90, 1, 40, 2]] }), LIMIT))).toEqual([[90, 90, 90, 40]]);
    expect(pixels(decodePng(handPng({ width: 1, height: 1, bitDepth: 16, colorType: 2, rows: [[1, 9, 2, 9, 3, 9]] }), LIMIT))).toEqual([[1, 2, 3, 255]]);
    expect(pixels(decodePng(handPng({ width: 1, height: 1, bitDepth: 16, colorType: 6, rows: [[1, 9, 2, 9, 3, 9, 4, 9]] }), LIMIT))).toEqual([[1, 2, 3, 4]]);
  });

  it('reads a palette at 1 to 8 bits, with the alpha tRNS gives its first entries', () => {
    const plte = pngChunk('PLTE', Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255]));
    const trns = pngChunk('tRNS', Buffer.from([0, 128]));
    const two = decodePng(handPng({ width: 3, height: 1, bitDepth: 2, colorType: 3, rows: [[0b00011000]], before: [plte, trns] }), LIMIT);
    expect(pixels(two)).toEqual([[255, 0, 0, 0], [0, 255, 0, 128], [0, 0, 255, 255]]);
    const eight = decodePng(handPng({ width: 2, height: 1, bitDepth: 8, colorType: 3, rows: [[2, 0]], before: [plte] }), LIMIT);
    expect(pixels(eight)).toEqual([[0, 0, 255, 255], [255, 0, 0, 255]]);
    // An index beyond the palette, and an indexed image without a palette.
    expect(refusal(() => decodePng(handPng({ width: 1, height: 1, bitDepth: 8, colorType: 3, rows: [[3]], before: [plte] }), LIMIT))).toBe('damaged');
    expect(refusal(() => decodePng(handPng({ width: 1, height: 1, bitDepth: 8, colorType: 3, rows: [[0]] }), LIMIT))).toBe('damaged');
  });

  it('a tRNS colour key makes exactly that grey or that colour transparent', () => {
    const grey = decodePng(handPng({ width: 2, height: 1, bitDepth: 8, colorType: 0, rows: [[9, 10]], before: [pngChunk('tRNS', Buffer.from([0, 9]))] }), LIMIT);
    expect(pixels(grey).map((p) => p[3])).toEqual([0, 255]);
    const key = pngChunk('tRNS', Buffer.from([0, 1, 0, 2, 0, 3]));
    const rgb = decodePng(handPng({ width: 2, height: 1, bitDepth: 8, colorType: 2, rows: [[1, 2, 3, 1, 2, 4]], before: [key] }), LIMIT);
    expect(pixels(rgb).map((p) => p[3])).toEqual([0, 255]);
  });

  it('refuses a side above the limit from the header alone, before any pixel data is read', () => {
    // No IDAT at all: a reader that looked further would call this damaged, not too large.
    const huge = Buffer.concat([PNG_SIGNATURE, ihdr(4001, 10, 8, 6), pngChunk('IEND')]);
    expect(refusal(() => decodePng(huge, LIMIT))).toBe('dimensions');
    expect(refusal(() => decodePng(Buffer.concat([PNG_SIGNATURE, ihdr(10, 70000, 8, 6), pngChunk('IEND')]), LIMIT))).toBe('dimensions');
    expect(pngHeader(huge)).toEqual({ width: 4001, height: 10, bitDepth: 8, colorType: 6, interlaced: false });
  });

  it('refuses pixel data that inflates to more or less than the header needs (a decompression bomb included)', () => {
    const bomb = Buffer.concat([PNG_SIGNATURE, ihdr(2, 2, 8, 6), pngChunk('IDAT', deflateSync(Buffer.alloc(8 * 1024 * 1024))), pngChunk('IEND')]);
    expect(bomb.byteLength).toBeLessThan(20_000);
    expect(refusal(() => decodePng(bomb, LIMIT))).toBe('damaged');
    const short = Buffer.concat([PNG_SIGNATURE, ihdr(2, 2, 8, 6), pngChunk('IDAT', deflateSync(Buffer.alloc(17))), pngChunk('IEND')]);
    expect(refusal(() => decodePng(short, LIMIT))).toBe('damaged');
  });

  it('refuses a bad CRC, a truncated file, a missing IEND, an unknown critical chunk, an unknown filter and an interlaced image', () => {
    const good = solidPng(4, 4);
    expect(refusal(() => decodePng(good, LIMIT))).toBe('accepted');
    const flipped = Buffer.from(good);
    flipped[flipped.byteLength - 20] = flipped[flipped.byteLength - 20]! ^ 0xff; // inside IDAT
    expect(refusal(() => decodePng(flipped, LIMIT))).toBe('damaged');
    for (const cut of [4, 8, 20, 33, good.byteLength - 12, good.byteLength - 1]) {
      expect(refusal(() => decodePng(good.subarray(0, cut), LIMIT)), String(cut)).toBe('damaged');
    }
    const critical = handPng({ width: 1, height: 1, bitDepth: 8, colorType: 0, rows: [[1]], before: [pngChunk('XYZa', Buffer.from('x'))] });
    expect(refusal(() => decodePng(critical, LIMIT))).toBe('damaged');
    expect(refusal(() => decodePng(handPng({ width: 1, height: 1, bitDepth: 8, colorType: 0, rows: [[1]], filters: [5] }), LIMIT))).toBe('damaged');
    const interlaced = Buffer.concat([PNG_SIGNATURE, ihdr(1, 1, 8, 0, 1), pngChunk('IDAT', deflateSync(Buffer.from([0, 1]))), pngChunk('IEND')]);
    expect(refusal(() => decodePng(interlaced, LIMIT))).toBe('interlaced');
    expect(refusal(() => decodePng(Buffer.concat([PNG_SIGNATURE, ihdr(1, 1, 3, 2), pngChunk('IEND')]), LIMIT))).toBe('damaged'); // RGB at 3 bits
    expect(refusal(() => decodePng(Buffer.concat([PNG_SIGNATURE, ihdr(0, 1, 8, 2), pngChunk('IEND')]), LIMIT))).toBe('damaged');
  });

  it('refuses a file that has the PNG signature and nothing a PNG holds after it', () => {
    const garbage = Buffer.concat([PNG_SIGNATURE, Buffer.from('<script>alert(1)</script>'.repeat(40))]);
    expect(refusal(() => decodePng(garbage, LIMIT))).toBe('damaged');
    expect(refusal(() => decodePng(Buffer.from('not a png at all'), LIMIT))).toBe('damaged');
    expect(refusal(() => decodePng(new Uint8Array(0), LIMIT))).toBe('damaged');
  });
});

describe('encodePng and the round trip', () => {
  it('the pixels survive; text, EXIF and profile chunks and whatever follows IEND do not', () => {
    const secret = 'RAHASIA-di-dalam-berkas';
    const dirty = handPng({
      width: 2,
      height: 2,
      bitDepth: 8,
      colorType: 6,
      rows: [
        [1, 2, 3, 4, 5, 6, 7, 8],
        [9, 10, 11, 12, 13, 14, 15, 255],
      ],
      before: [pngChunk('tEXt', Buffer.from(`Comment\0${secret}`)), pngChunk('eXIf', Buffer.from(secret)), pngChunk('iCCP', Buffer.from(secret))],
      trailer: Buffer.from(`PK\x03\x04${secret}<?php echo 1; ?>`),
    });
    expect(dirty.includes(secret)).toBe(true);
    const image = decodePng(dirty, LIMIT);
    const clean = Buffer.from(encodePng(image));
    expect(chunkTypes(clean)).toEqual(['IHDR', 'IDAT', 'IEND']);
    expect(clean.includes(secret)).toBe(false);
    expect(clean.includes('PK')).toBe(false);
    expect(clean.subarray(-12)).toEqual(pngChunk('IEND'));
    expect(decodePng(clean, LIMIT)).toEqual(image);
    // The same pixels give the same bytes.
    expect(Buffer.from(encodePng(decodePng(clean, LIMIT))).equals(clean)).toBe(true);
  });

  it('writes RGB when every pixel is opaque and RGBA otherwise', () => {
    expect(pngHeader(solidPng(3, 2, [1, 2, 3, 255])).colorType).toBe(2);
    expect(pngHeader(solidPng(3, 2, [1, 2, 3, 254])).colorType).toBe(6);
    const image = decodePng(gradientPng(37, 11), LIMIT);
    expect(decodePng(encodePng(image), LIMIT)).toEqual(image);
    expect(() => encodePng({ width: 2, height: 2, data: new Uint8Array(15) })).toThrow(TypeError);
  });
});

describe('scaleDown and cropSquare', () => {
  it('averages by area: a 4 x 2 image halves to the mean of each 2 x 2 block', () => {
    const data = new Uint8Array([
      ...[0, 0, 0, 255], ...[100, 0, 0, 255], ...[0, 0, 200, 255], ...[0, 0, 200, 255],
      ...[100, 0, 0, 255], ...[200, 0, 0, 255], ...[0, 0, 200, 255], ...[0, 0, 200, 255],
    ]);
    expect(pixels(scaleDown({ width: 4, height: 2, data }, 2, 1))).toEqual([[100, 0, 0, 255], [0, 0, 200, 255]]);
  });

  it('a transparent pixel lends no colour: the colours are weighted by alpha', () => {
    // An opaque red pixel beside a fully transparent green one: half-transparent red, never brown.
    const data = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 0]);
    expect(pixels(scaleDown({ width: 2, height: 1, data }, 1, 1))).toEqual([[255, 0, 0, 128]]);
    expect(pixels(scaleDown({ width: 2, height: 1, data: new Uint8Array(8) }, 1, 1))).toEqual([[0, 0, 0, 0]]);
  });

  it('handles a ratio that is not whole, keeps a flat colour flat, and never scales up', () => {
    const flat = decodePng(solidPng(100, 37, [12, 200, 77, 255]), LIMIT);
    const small = scaleDown(flat, 33, 7);
    expect(small.width).toBe(33);
    expect(small.height).toBe(7);
    expect(new Set(pixels(small).map((p) => p.join(',')))).toEqual(new Set(['12,200,77,255']));
    expect(scaleDown(flat, 100, 37)).toBe(flat);
    expect(() => scaleDown(flat, 101, 37)).toThrow(TypeError);
    expect(() => scaleDown(flat, 0, 1)).toThrow(TypeError);
  });

  it('cropSquare keeps the centre', () => {
    const data = new Uint8Array(4 * 2 * 4);
    for (let x = 0; x < 4; x += 1) for (let y = 0; y < 2; y += 1) data.set([x * 10, y, 0, 255], (y * 4 + x) * 4);
    const square = cropSquare({ width: 4, height: 2, data });
    expect(pixels(square).map((p) => p[0])).toEqual([10, 20, 10, 20]);
    const tall = cropSquare({ width: 1, height: 3, data: new Uint8Array([1, 0, 0, 255, 2, 0, 0, 255, 3, 0, 0, 255]) });
    expect(pixels(tall)).toEqual([[2, 0, 0, 255]]);
  });
});

describe('the stored logo and icon', () => {
  it('a logo is scaled down to fit 960 x 240, keeps its alpha, and is never enlarged', () => {
    expect(pngHeader(storedSiteLogo(gradientPng(1200, 600)))).toMatchObject({ width: 480, height: 240, colorType: 6 });
    expect(pngHeader(storedSiteLogo(solidPng(3000, 300)))).toMatchObject({ width: 960, height: 96 });
    expect(pngHeader(storedSiteLogo(solidPng(200, 50)))).toMatchObject({ width: 200, height: 50 });
    expect(refusal(() => storedSiteLogo(solidPng(15, 200)))).toBe('too_small');
    expect(refusal(() => storedSiteLogo(Buffer.concat([PNG_SIGNATURE, ihdr(4001, 100, 8, 6), pngChunk('IEND')])))).toBe('dimensions');
    expect(refusal(() => storedSiteLogo(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')))).toBe('damaged');
  });

  it('an icon is at least 256 px a side, stored as its centre square of at most 512 px, and served at 32, 180 and 192 px', () => {
    expect(refusal(() => storedSiteIcon(solidPng(255, 400)))).toBe('too_small');
    const stored = storedSiteIcon(gradientPng(700, 600));
    expect(pngHeader(stored)).toMatchObject({ width: 512, height: 512 });
    expect(pngHeader(storedSiteIcon(solidPng(300, 256)))).toMatchObject({ width: 256, height: 256 });
    for (const size of [32, 180, 192] as const) {
      const variant = siteIconVariant(stored, size);
      expect(pngHeader(variant)).toMatchObject({ width: size, height: size });
      expect(chunkTypes(variant)).toEqual(['IHDR', 'IDAT', 'IEND']);
    }
    expect(refusal(() => siteIconVariant(Buffer.from('gone'), 32))).toBe('damaged');
  });

  it('the built-in icon exists in each size: a square PNG with transparent corners and an opaque centre', () => {
    for (const size of [32, 180, 192] as const) {
      const icon = decodePng(defaultSiteIcon(size), LIMIT);
      expect([icon.width, icon.height]).toEqual([size, size]);
      expect(icon.data[3]).toBe(0);
      expect(icon.data[((size >> 1) * size + (size >> 1)) * 4 + 3]).toBe(255);
      expect(defaultSiteIcon(size)).toBe(defaultSiteIcon(size));
    }
  });
});
