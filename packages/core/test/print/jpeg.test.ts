import { describe, expect, it } from 'vitest';
import { JpegError, jpegInfo } from '../../src/print/jpeg.js';
import {
  TINY_JPEG_BASELINE,
  TINY_JPEG_CMYK,
  TINY_JPEG_GRAY,
  TINY_JPEG_PROGRESSIVE,
  TINY_PNG_HEAD,
} from '../fixtures/tiny.jpg.js';

// The JPEG header reader behind PDF images: it walks the markers of a whole file, answers the frame size and the
// number of colour components, and refuses what a PDF reader could not show through DCTDecode as an 8-bit grey or RGB
// picture (not a JPEG, CMYK, a cut-off file).

/** The reason of the JpegError `f` throws; fails when it throws something else or nothing. */
function reasonOf(f: () => unknown): string {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(JpegError);
    expect(e).toBeInstanceOf(Error);
    expect((e as JpegError).name).toBe('JpegError');
    return (e as JpegError).reason;
  }
  throw new Error('no error was thrown');
}

/** The offset of the first `FF <marker>` pair. */
function markerAt(bytes: Uint8Array, marker: number): number {
  for (let i = 0; i + 1 < bytes.length; i++) if (bytes[i] === 0xff && bytes[i + 1] === marker) return i;
  throw new Error(`no marker ${marker.toString(16)}`);
}

const patched = (bytes: Uint8Array, at: number, ...values: number[]): Uint8Array => {
  const copy = bytes.slice();
  copy.set(values, at);
  return copy;
};

describe('jpegInfo', () => {
  it('reads the size and the components of a 2 × 1 baseline file', () => {
    expect(jpegInfo(TINY_JPEG_BASELINE)).toEqual({ width: 2, height: 1, components: 3 });
  });

  it('accepts a progressive file and a grey file', () => {
    expect(jpegInfo(TINY_JPEG_PROGRESSIVE)).toEqual({ width: 2, height: 1, components: 3 });
    expect(jpegInfo(TINY_JPEG_GRAY)).toEqual({ width: 2, height: 1, components: 1 });
  });

  it('refuses PNG bytes, an empty file and a lone start marker as not a JPEG', () => {
    expect(reasonOf(() => jpegInfo(TINY_PNG_HEAD))).toBe('not_jpeg');
    expect(reasonOf(() => jpegInfo(new Uint8Array(0)))).toBe('not_jpeg');
    expect(reasonOf(() => jpegInfo(Uint8Array.from([0xff])))).toBe('not_jpeg');
    expect(reasonOf(() => jpegInfo(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])))).toBe('not_jpeg');
  });

  it('refuses a CMYK file', () => {
    expect(reasonOf(() => jpegInfo(TINY_JPEG_CMYK))).toBe('cmyk');
  });

  it('refuses a file cut off in its headers, in its scan data or just before the end marker', () => {
    const sof = markerAt(TINY_JPEG_BASELINE, 0xc0);
    for (const cut of [2, 3, 5, 20, sof + 4, sof + 12, TINY_JPEG_BASELINE.length - 10, TINY_JPEG_BASELINE.length - 2]) {
      expect(reasonOf(() => jpegInfo(TINY_JPEG_BASELINE.subarray(0, cut))), `cut at ${cut}`).toBe('truncated');
    }
    expect(reasonOf(() => jpegInfo(TINY_JPEG_PROGRESSIVE.subarray(0, TINY_JPEG_PROGRESSIVE.length - 30)))).toBe('truncated');
  });

  it('ignores bytes after the end marker', () => {
    const padded = new Uint8Array(TINY_JPEG_BASELINE.length + 5);
    padded.set(TINY_JPEG_BASELINE);
    expect(jpegInfo(padded)).toEqual({ width: 2, height: 1, components: 3 });
  });

  it('refuses frames a PDF reader cannot show: lossless or arithmetic coding, 12-bit samples, a zero size', () => {
    const sof = markerAt(TINY_JPEG_BASELINE, 0xc0);
    expect(reasonOf(() => jpegInfo(patched(TINY_JPEG_BASELINE, sof + 1, 0xc3)))).toBe('not_jpeg');
    expect(reasonOf(() => jpegInfo(patched(TINY_JPEG_BASELINE, sof + 1, 0xc9)))).toBe('not_jpeg');
    expect(reasonOf(() => jpegInfo(patched(TINY_JPEG_BASELINE, sof + 4, 12)))).toBe('not_jpeg');
    expect(reasonOf(() => jpegInfo(patched(TINY_JPEG_BASELINE, sof + 5, 0, 0)))).toBe('not_jpeg');
    expect(reasonOf(() => jpegInfo(patched(TINY_JPEG_BASELINE, sof + 7, 0, 0)))).toBe('not_jpeg');
  });

  it('refuses a scan before any frame, a second frame and a byte where a marker belongs', () => {
    const sof = markerAt(TINY_JPEG_BASELINE, 0xc0);
    const sos = markerAt(TINY_JPEG_BASELINE, 0xda);
    // The frame header renamed to an application segment: the scan then comes first.
    expect(reasonOf(() => jpegInfo(patched(TINY_JPEG_BASELINE, sof + 1, 0xe5)))).toBe('not_jpeg');
    // A DHT segment renamed to a second SOF0 (its length no longer fits a frame header either).
    const dht = markerAt(TINY_JPEG_BASELINE, 0xc4);
    expect(reasonOf(() => jpegInfo(patched(TINY_JPEG_BASELINE, dht + 1, 0xc0)))).toBe('not_jpeg');
    expect(reasonOf(() => jpegInfo(patched(TINY_JPEG_BASELINE, sos, 0x00)))).toBe('not_jpeg');
  });
});
