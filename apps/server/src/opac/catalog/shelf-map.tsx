import { localStorageDriver } from '@altis/core';

// The shelf map of the OPAC record detail (Phase 2 Task 34; spec §3.6, §9.3): when `opac.showShelfMap` is on and an
// item's shelf has a box on its room's floor plan, an inline SVG inside a <details> (closed by default): the plan, the
// shelf's box highlighted, and the place ("Rak 800–899, Lantai 2") as `<title>` and `aria-label`.
//
// The plan is an `<img src="/files/<id>" loading="lazy">` with the SVG laid over it (`.shelf-map-plan`), not an SVG
// `<image href>` (review, Task 39e finding 1): a browser fetches an SVG `<image>` at page load whatever the <details>,
// so a record page downloaded up to 10 plans of up to 5 MB each with every map closed; SVG has no lazy loading, and a
// lazy image that is not rendered (in a closed <details>) is fetched only once the visitor opens the map. No script.
//
// A box is in per mille of the plan's width (x, w) and height (y, h). The SVG's view box is 1000 wide and as high as
// the plan's shape asks (its size read from the first bytes of the stored file: PNG, JPEG, GIF, WebP; a JPEG's as its
// EXIF Orientation turns it, review C15), and it is stretched over the image (`preserveAspectRatio="none"`), so the box
// sits on the right spot whatever size the image is drawn at. The image's `width`/`height` are the plan's as the
// browser draws it, so its space is kept before it loads and the view box is not stretched out of shape; when the
// size cannot be read they and the view box are square until the image gives its own shape. No style attribute: the
// layout and the colours come from the theme (`.shelf-map-plan`, `.shelf-here`).

/** A plan's size in pixels. */
export interface ImageSize {
  width: number;
  height: number;
}

/** A box on a plan, per mille (0-1000) of its width and height. */
export interface PlanBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The view box is this wide; a plan's height follows its shape, within these bounds. */
const VIEW_WIDTH = 1000;
const VIEW_HEIGHT_MIN = 100;
const VIEW_HEIGHT_MAX = 4000;
/** How much of the stored plan is read for its size (the header comes first; metadata was stripped on upload). */
const HEADER_BYTES = 64 * 1024;

const u16be = (b: Uint8Array, i: number): number => (b[i]! << 8) | b[i + 1]!;
const u16le = (b: Uint8Array, i: number): number => b[i]! | (b[i + 1]! << 8);
const u24le = (b: Uint8Array, i: number): number => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
const u32be = (b: Uint8Array, i: number): number => ((b[i]! << 24) >>> 0) + ((b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!);
const u32le = (b: Uint8Array, i: number): number => ((b[i + 3]! << 24) >>> 0) + ((b[i + 2]! << 16) | (b[i + 1]! << 8) | b[i]!);
const ascii = (b: Uint8Array, i: number, text: string): boolean => {
  if (i + text.length > b.length) return false;
  for (let k = 0; k < text.length; k += 1) if (b[i + k] !== text.charCodeAt(k)) return false;
  return true;
};

/** The JPEG markers of a frame header (SOF0-SOF15 without DHT C4, JPG C8 and DAC CC). */
const JPEG_SOF: ReadonlySet<number> = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
const JPEG_APP1 = 0xe1;

/**
 * The EXIF Orientation (1-8) of an APP1 `payload` (from its `Exif\0` signature on), as a browser reads it: the tag
 * 0x0112 of IFD0, a SHORT of count 1; null for a payload that is not EXIF, has no such tag, or whose structure does not
 * hold. The same reading as `exifOrientation` of the metadata stripper (packages/core/src/files/strip-metadata.ts),
 * which keeps that tag alone in a stored JPEG (review C15).
 */
function exifOrientation(payload: Uint8Array): number | null {
  if (payload.byteLength < 6 + 8 || !ascii(payload, 0, 'Exif\0')) return null;
  const tiff = payload.subarray(6);
  const little = ascii(tiff, 0, 'II');
  if (!little && !ascii(tiff, 0, 'MM')) return null;
  const u16 = (at: number): number => (little ? u16le(tiff, at) : u16be(tiff, at));
  const u32 = (at: number): number => (little ? u32le(tiff, at) : u32be(tiff, at));
  if (u16(2) !== 42) return null;
  const ifd0 = u32(4);
  if (ifd0 < 8 || ifd0 + 2 > tiff.byteLength) return null;
  const count = u16(ifd0);
  if (ifd0 + 2 + count * 12 > tiff.byteLength) return null;
  for (let k = 0; k < count; k += 1) {
    const entry = ifd0 + 2 + k * 12;
    if (u16(entry) !== 0x0112) continue;
    if (u16(entry + 2) !== 3 || u32(entry + 4) !== 1) return null;
    const value = u16(entry + 8);
    return value >= 1 && value <= 8 ? value : null;
  }
  return null;
}

/**
 * The size of a JPEG as a browser draws it: its frame header's, with width and height swapped when the first EXIF
 * block that gives an Orientation turns the picture a quarter (5-8). A phone stores a portrait photo as landscape
 * pixels plus that tag; the metadata stripper keeps it (review C15), and the browser applies it to the `<img>`.
 */
function jpegSize(b: Uint8Array): ImageSize | null {
  let orientation: number | null = null;
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i += 1; // a fill byte
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2; // a marker without a length
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // the image or its scan began without a frame header
    const length = u16be(b, i + 2);
    if (length < 2) return null;
    if (JPEG_SOF.has(marker)) {
      if (i + 9 > b.length) return null;
      const [width, height] = [u16be(b, i + 7), u16be(b, i + 5)];
      return orientation !== null && orientation >= 5 ? { width: height, height: width } : { width, height };
    }
    if (marker === JPEG_APP1 && orientation === null) orientation = exifOrientation(b.subarray(i + 4, Math.min(b.length, i + 2 + length)));
    i += 2 + length;
  }
  return null;
}

function webpSize(b: Uint8Array): ImageSize | null {
  const p = 20; // the first chunk's payload
  if (ascii(b, 12, 'VP8X')) return p + 10 <= b.length ? { width: u24le(b, p + 4) + 1, height: u24le(b, p + 7) + 1 } : null;
  if (ascii(b, 12, 'VP8 ')) {
    if (p + 10 > b.length || b[p + 3] !== 0x9d || b[p + 4] !== 0x01 || b[p + 5] !== 0x2a) return null;
    return { width: u16le(b, p + 6) & 0x3fff, height: u16le(b, p + 8) & 0x3fff };
  }
  if (ascii(b, 12, 'VP8L')) {
    if (p + 5 > b.length || b[p] !== 0x2f) return null;
    const bits = u32le(b, p + 1);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  return null;
}

/**
 * The pixel size of a PNG, JPEG, GIF or WebP image from its first bytes (its header), as a browser draws it (a JPEG
 * turned a quarter by its EXIF Orientation is as wide as its frame is high), or null for anything else, a header cut
 * short, or a width or height of 0.
 */
export function imageSize(b: Uint8Array): ImageSize | null {
  let size: ImageSize | null = null;
  if (b.length >= 24 && b[0] === 0x89 && ascii(b, 1, 'PNG\r\n\x1a\n') && ascii(b, 12, 'IHDR')) size = { width: u32be(b, 16), height: u32be(b, 20) };
  else if (b.length >= 10 && (ascii(b, 0, 'GIF87a') || ascii(b, 0, 'GIF89a'))) size = { width: u16le(b, 6), height: u16le(b, 8) };
  else if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) size = jpegSize(b);
  else if (ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP')) size = webpSize(b);
  return size !== null && size.width > 0 && size.height > 0 ? size : null;
}

/**
 * The size of the stored plan `fileId` (its first 64 KiB read from DATA_DIR), or null when it cannot be read: no
 * DATA_DIR, no blob, or a header {@link imageSize} does not know. Never throws: the map then falls back to a square.
 */
export async function planSize(dataDir: () => string, fileId: string): Promise<ImageSize | null> {
  try {
    const content = await localStorageDriver(dataDir()).get(fileId, { start: 0, end: HEADER_BYTES - 1 });
    if (content === null) return null;
    const parts: Uint8Array[] = [];
    let total = 0;
    for await (const part of content) {
      parts.push(part);
      total += part.byteLength;
      if (total >= HEADER_BYTES) break;
    }
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
      bytes.set(part, at);
      at += part.byteLength;
    }
    return imageSize(bytes);
  } catch {
    return null;
  }
}

/** `v` as a whole number within 0-1000 (a box from the database), or null when it is not a number. */
function perMille(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1000, Math.max(0, Math.round(n))) : null;
}

/** The box as drawn in a view box `height` high, or null when it is not a usable box. */
function drawnBox(box: PlanBox, height: number): PlanBox | null {
  const [x, y, w, h] = [perMille(box.x), perMille(box.y), perMille(box.w), perMille(box.h)];
  if (x === null || y === null || w === null || h === null || w === 0 || h === 0) return null;
  const scale = height / 1000;
  return { x, y: Math.round(y * scale), w: Math.min(w, 1000 - x), h: Math.max(1, Math.round(Math.min(h, 1000 - y) * scale)) };
}

export interface ShelfMapProps {
  planFileId: string;
  box: PlanBox;
  /** The plan's size, or null when unknown (a square view box). */
  size: ImageSize | null;
  /** The place, e.g. "Rak 800–899, Lantai 2": the SVG's `<title>` and `aria-label`. */
  label: string;
  /** The text of the <summary>. */
  summary: string;
}

/** The view box height of a plan of `size`: 1000 × its shape, within bounds; 1000 when unknown. */
function viewHeight(size: ImageSize | null): number {
  if (size === null) return VIEW_WIDTH;
  return Math.min(VIEW_HEIGHT_MAX, Math.max(VIEW_HEIGHT_MIN, Math.round((VIEW_WIDTH * size.height) / size.width)));
}

/** The shelf map (see the top of this file); nothing for a box that cannot be drawn. */
export function ShelfMap(props: ShelfMapProps) {
  const height = viewHeight(props.size);
  const box = drawnBox(props.box, height);
  if (box === null) return null;
  const shown = props.size ?? { width: VIEW_WIDTH, height: VIEW_WIDTH };
  return (
    <details class="shelf-map">
      <summary>{props.summary}</summary>
      <div class="shelf-map-plan">
        <img src={`/files/${encodeURIComponent(props.planFileId)}`} alt="" width={String(shown.width)} height={String(shown.height)} loading="lazy" decoding="async" />
        <svg xmlns="http://www.w3.org/2000/svg" viewBox={`0 0 ${VIEW_WIDTH} ${height}`} preserveAspectRatio="none" role="img" aria-label={props.label}>
          <title>{props.label}</title>
          <rect class="shelf shelf-here" x={String(box.x)} y={String(box.y)} width={String(box.w)} height={String(box.h)} rx="4" />
        </svg>
      </div>
    </details>
  );
}
