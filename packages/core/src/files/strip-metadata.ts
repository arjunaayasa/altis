// Metadata stripping of the images ALTIS publishes as they are uploaded (Phase 2 spec §8, decision D2-18; plan Task
// 18): covers, floor plans and page images. The admin shrinks a cover in the browser, but a phone photo still carries
// its EXIF block (the GPS position of the camera, its serial number, the owner's name) and an XMP or IPTC packet (an
// author, a caption). There is no image library on the server, so this walks the container in pure TypeScript and
// copies every part but the metadata, byte for byte:
//
// - JPEG: the marker segments; APP1 (EXIF and XMP) and APP13 (Photoshop/IPTC) are dropped. The entropy-coded data
//   after each SOS is copied as it is (a stuffed FF 00 and the restart markers FF D0-D7 belong to it) up to the next
//   marker, so the segments between the scans of a progressive JPEG are walked too. Fill bytes (FF FF) before a marker
//   go, and so does anything after EOI (an appended archive, say). One thing of the EXIF block is kept (review C15): its
//   Orientation tag (0x0112, values 2-8). A phone stores a portrait photo as landscape pixels plus that tag, which the
//   browser applies, and only covers are redrawn in the browser before upload; without the tag a page image, a floor
//   plan or a migrated SLiMS image would be stored sideways. It says nothing of who took the photo or where, so it is
//   written again in a block of its own (an IFD0 with that one entry) at the dropped block's place; every other tag,
//   the GPS IFD and the thumbnail go. An EXIF block whose structure does not hold is dropped whole, as before.
// - PNG: the chunks; `eXIf`, `tEXt`, `zTXt` and `iTXt` are dropped, every other chunk is copied whole (its CRC
//   included, so nothing is recomputed). Anything after IEND goes.
// - WebP: the RIFF chunks; `EXIF` and `XMP ` are dropped, the VP8X flags that announce them are cleared, and the RIFF
//   size is written again. Anything after the RIFF chunk goes.
//
// A file whose structure does not hold (a length past the end, a missing marker or terminator) is refused with a
// TypeError rather than passed on: the caller (upload completion) refuses it as not being the image it claims to be.

/** The kinds of image this strips. */
export type StrippableImage = 'jpeg' | 'png' | 'webp';

function malformed(kind: StrippableImage, why: string): TypeError {
  return new TypeError(`stripImageMetadata: the ${kind} is malformed (${why})`);
}

/** `parts` joined into one new array. */
function concat(parts: readonly Uint8Array[]): Uint8Array {
  let size = 0;
  for (const p of parts) size += p.byteLength;
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

const fourcc = (b: Uint8Array, at: number): string => String.fromCharCode(b[at]!, b[at + 1]!, b[at + 2]!, b[at + 3]!);

// ---- JPEG ----------------------------------------------------------------------------------------------------------

const APP1 = 0xe1;
const APP13 = 0xed;
const SOS = 0xda;
const EOI = 0xd9;

/** The start of an EXIF APP1 payload, `Exif\0` and a pad byte (`\0`, but a decoder does not look at it). */
const EXIF_SIGNATURE = [0x45, 0x78, 0x69, 0x66, 0x00];
const EXIF_ORIENTATION = 0x0112;
const TIFF_SHORT = 3;

/**
 * The orientation (1-8) that the IFD0 of an APP1 `payload` gives, as a browser reads it; null for a payload that is not
 * EXIF, has no Orientation tag, or whose structure does not hold.
 */
function exifOrientation(payload: Uint8Array): number | null {
  if (payload.byteLength < 6 + 8 || EXIF_SIGNATURE.some((byte, i) => payload[i] !== byte)) return null;
  const tiff = payload.subarray(6);
  const little = tiff[0] === 0x49 && tiff[1] === 0x49; // II
  if (!little && !(tiff[0] === 0x4d && tiff[1] === 0x4d)) return null; // MM
  const u16 = (at: number): number => (little ? tiff[at]! | (tiff[at + 1]! << 8) : (tiff[at]! << 8) | tiff[at + 1]!);
  const u32 = (at: number): number => (little ? (u16(at + 2) << 16) | u16(at) : (u16(at) << 16) | u16(at + 2)) >>> 0;
  if (u16(2) !== 42) return null;
  const ifd0 = u32(4);
  if (ifd0 < 8 || ifd0 + 2 > tiff.byteLength) return null;
  const count = u16(ifd0);
  if (ifd0 + 2 + count * 12 > tiff.byteLength) return null;
  for (let i = 0; i < count; i += 1) {
    const entry = ifd0 + 2 + i * 12;
    if (u16(entry) !== EXIF_ORIENTATION) continue;
    if (u16(entry + 2) !== TIFF_SHORT || u32(entry + 4) !== 1) return null;
    const value = u16(entry + 8);
    return value >= 1 && value <= 8 ? value : null;
  }
  return null;
}

/** An EXIF APP1 segment that holds `orientation` alone: a big-endian TIFF whose IFD0 has that one SHORT entry. */
function orientationSegment(orientation: number): Uint8Array {
  return Uint8Array.of(
    0xff, APP1, 0x00, 0x22, // the marker and a length of 34 (it counts itself)
    ...EXIF_SIGNATURE, 0x00,
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, // MM, 42, the IFD0 at 8
    0x00, 0x01, // one entry: Orientation, SHORT, a count of 1, the value (left-justified in its four bytes)
    0x01, 0x12, 0x00, TIFF_SHORT, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, // no IFD1 (the thumbnail)
  );
}

/** A restart marker (FF D0-D7): part of the entropy-coded data. */
const isRestart = (marker: number): boolean => marker >= 0xd0 && marker <= 0xd7;

/**
 * The end of the entropy-coded data that starts at `at`: the index of the first FF that begins a marker (not a stuffed
 * FF 00, a restart marker, or one more fill byte before the marker).
 */
function scanEnd(b: Uint8Array, at: number): number {
  for (let i = at; i < b.byteLength; i += 1) {
    if (b[i] !== 0xff) continue;
    const next = b[i + 1];
    if (next === undefined) throw malformed('jpeg', 'the scan ends inside a marker');
    if (next === 0x00 || isRestart(next)) {
      i += 1;
      continue;
    }
    return i;
  }
  throw malformed('jpeg', 'the scan has no end marker');
}

function stripJpeg(b: Uint8Array): Uint8Array {
  if (b.byteLength < 4 || b[0] !== 0xff || b[1] !== 0xd8) throw malformed('jpeg', 'no SOI');
  const parts: Uint8Array[] = [b.subarray(0, 2)];
  /** Whether an EXIF block gave the orientation: a browser applies the first one it can read, so later ones go. */
  let oriented = false;
  let at = 2;
  for (;;) {
    if (at >= b.byteLength) throw malformed('jpeg', 'no EOI');
    if (b[at] !== 0xff) throw malformed('jpeg', `no marker at byte ${at}`);
    while (b[at + 1] === 0xff) at += 1; // fill bytes before the marker
    const marker = b[at + 1];
    if (marker === undefined) throw malformed('jpeg', 'the file ends inside a marker');
    if (marker === EOI) {
      parts.push(b.subarray(at, at + 2));
      return concat(parts);
    }
    if (marker === 0x00 || marker === 0xd8) throw malformed('jpeg', `marker ${marker.toString(16)} outside a scan`);
    if (isRestart(marker) || marker === 0x01) {
      // A marker without a length (TEM, RSTn): kept as it is.
      parts.push(b.subarray(at, at + 2));
      at += 2;
      continue;
    }
    if (at + 4 > b.byteLength) throw malformed('jpeg', 'the file ends inside a segment length');
    const length = (b[at + 2]! << 8) | b[at + 3]!;
    if (length < 2) throw malformed('jpeg', `segment length ${length}`);
    const end = at + 2 + length;
    if (end > b.byteLength) throw malformed('jpeg', 'a segment runs past the end of the file');
    if (marker === APP1) {
      const orientation = oriented ? null : exifOrientation(b.subarray(at + 4, end));
      if (orientation !== null) {
        oriented = true;
        if (orientation !== 1) parts.push(orientationSegment(orientation)); // 1 is how the pixels are stored anyway
      }
    } else if (marker !== APP13) parts.push(b.subarray(at, end));
    at = end;
    if (marker === SOS) {
      const dataEnd = scanEnd(b, at);
      parts.push(b.subarray(at, dataEnd));
      at = dataEnd;
    }
  }
}

// ---- PNG -----------------------------------------------------------------------------------------------------------

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** The chunks of text and EXIF metadata (the XMP packet lives in an `iTXt` chunk). */
const PNG_METADATA: ReadonlySet<string> = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt']);
/** PNG chunk lengths are at most 2^31 - 1. */
const PNG_CHUNK_MAX = 0x7fffffff;

function stripPng(b: Uint8Array): Uint8Array {
  if (b.byteLength < 8 || PNG_SIGNATURE.some((byte, i) => b[i] !== byte)) throw malformed('png', 'no PNG signature');
  const parts: Uint8Array[] = [b.subarray(0, 8)];
  for (let at = 8; ; ) {
    if (at + 12 > b.byteLength) throw malformed('png', 'no IEND');
    const length = ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;
    if (length > PNG_CHUNK_MAX) throw malformed('png', `chunk length ${length}`);
    const end = at + 12 + length;
    if (end > b.byteLength) throw malformed('png', 'a chunk runs past the end of the file');
    const type = fourcc(b, at + 4);
    if (!PNG_METADATA.has(type)) parts.push(b.subarray(at, end));
    at = end;
    if (type === 'IEND') return concat(parts);
  }
}

// ---- WebP ----------------------------------------------------------------------------------------------------------

/** The chunks of EXIF and XMP metadata. */
const WEBP_METADATA: ReadonlySet<string> = new Set(['EXIF', 'XMP ']);
/** The chunks that hold or announce an image (a simple lossy or lossless image, or the extended header). */
const WEBP_IMAGE: ReadonlySet<string> = new Set(['VP8 ', 'VP8L', 'VP8X']);
/** The VP8X flags that announce an EXIF (0x08) and an XMP (0x04) chunk. */
const VP8X_METADATA_FLAGS = 0x08 | 0x04;

const u32le = (b: Uint8Array, at: number): number => (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0;

function le32(n: number): Uint8Array {
  return Uint8Array.of(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
}

function stripWebp(b: Uint8Array): Uint8Array {
  if (b.byteLength < 12 || fourcc(b, 0) !== 'RIFF' || fourcc(b, 8) !== 'WEBP') throw malformed('webp', 'no RIFF WEBP header');
  const riffEnd = 8 + u32le(b, 4);
  if (riffEnd < 12 || riffEnd > b.byteLength) throw malformed('webp', 'the RIFF size does not fit the file');
  const chunks: Uint8Array[] = [];
  let image = false;
  for (let at = 12; at < riffEnd; ) {
    if (at + 8 > riffEnd) throw malformed('webp', 'a chunk header runs past the RIFF end');
    const type = fourcc(b, at);
    const size = u32le(b, at + 4);
    const end = at + 8 + size + (size % 2);
    if (end > riffEnd) throw malformed('webp', `chunk ${type} runs past the RIFF end`);
    if (!WEBP_METADATA.has(type)) {
      const copy = b.slice(at, end);
      if (type === 'VP8X') {
        if (size < 1) throw malformed('webp', 'an empty VP8X chunk');
        copy[8] = copy[8]! & ~VP8X_METADATA_FLAGS;
      }
      chunks.push(copy);
    }
    if (WEBP_IMAGE.has(type)) image = true;
    at = end;
  }
  if (!image) throw malformed('webp', 'no image chunk');
  let size = 4;
  for (const c of chunks) size += c.byteLength;
  return concat([b.subarray(0, 4), le32(size), b.subarray(8, 12), ...chunks]);
}

/**
 * `bytes` without their metadata (see the top of this file), as a new array; an image without any comes back equal.
 *
 * @throws TypeError for a file whose structure does not hold, or an unknown `kind`
 */
export function stripImageMetadata(bytes: Uint8Array, kind: StrippableImage): Uint8Array {
  switch (kind) {
    case 'jpeg':
      return stripJpeg(bytes);
    case 'png':
      return stripPng(bytes);
    case 'webp':
      return stripWebp(bytes);
    default:
      throw new TypeError(`stripImageMetadata: unknown kind ${JSON.stringify(kind)}`);
  }
}
