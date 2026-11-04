// The type of an upload from its first bytes (spec §7.5: "tipe dicek dari magic bytes; SVG ditolak sebagai gambar").
// What the client says (a file name, a Content-Type) is never asked. The kinds are the ones ALTIS acts on: ZIP (backup
// archives, update packages), PDF and the raster images that /files/:id may serve inline, and SVG, which is recognized
// only to be kept out of the images: it is XML that can carry scripts, so it is never given an `image/*` type.
//
// Phase 2 (its spec §8; plan Task 2, S1) adds the kinds of catalog attachments and imports: audio and video (mp3,
// mp4/m4a, ogg, wav, webm), gzip (SQL dumps), xml (MARCXML), iso2709 (MARC 21 transmission files) and text (CSV, SQL,
// MARC text). The order is fixed: the binary signatures first, then SVG and xml, then iso2709, then text, so a
// file is the first kind it matches. A recognized binary container that is none of these (an AVIF or HEIC image in an
// `ftyp` box, a Matroska file) is `unknown`, never text. `xml` and `text` are never inline types: an XML document can
// carry an XHTML script, so /files/:id serves both as downloads only.

/** How many leading bytes {@link detectType} looks at; callers read this many (or the whole file when it is shorter). */
export const MAGIC_HEAD_BYTES = 4096;

/** Every kind {@link detectType} can answer; an upload context names the ones it takes (files/contexts.ts). */
export type MagicKind =
  | 'zip'
  | 'pdf'
  | 'png'
  | 'jpeg'
  | 'gif'
  | 'webp'
  | 'svg'
  | 'unknown'
  // ---- Phase 2 (catalog): Task 2 ----
  | 'mp3'
  | 'mp4'
  | 'ogg'
  | 'wav'
  | 'webm'
  | 'gzip'
  | 'xml'
  | 'iso2709'
  | 'text';

/** The 1c name of {@link MagicKind}. */
export type DetectedKind = MagicKind;

export interface DetectedType {
  /** The media type the file is stored and served with. */
  mime: string;
  kind: MagicKind;
}

/** The type of anything not recognized, SVG included: served only as a download. */
const OPAQUE = 'application/octet-stream';

const UNKNOWN: DetectedType = Object.freeze({ kind: 'unknown', mime: OPAQUE });

function startsWith(head: Uint8Array, signature: readonly number[], at = 0): boolean {
  if (head.byteLength < at + signature.length) return false;
  return signature.every((byte, i) => head[at + i] === byte);
}

const ascii = (text: string): number[] => [...text].map((ch) => ch.charCodeAt(0));

/** The head as Latin-1 text: every byte one character, so no byte sequence can fail to decode. */
const latin1 = (head: Uint8Array): string => Buffer.from(head.buffer, head.byteOffset, head.byteLength).toString('latin1');

const ZIP_LOCAL = [0x50, 0x4b, 0x03, 0x04];
/** An empty archive is only its end-of-central-directory record. */
const ZIP_EMPTY = [0x50, 0x4b, 0x05, 0x06];
const PDF = ascii('%PDF-');
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];
const GIF87 = ascii('GIF87a');
const GIF89 = ascii('GIF89a');
const RIFF = ascii('RIFF');
const WEBP = ascii('WEBP');
// ---- Phase 2 (catalog): Task 2 ----
const WAVE = ascii('WAVE');
const FTYP = ascii('ftyp');
const OGG = ascii('OggS');
const EBML = [0x1a, 0x45, 0xdf, 0xa3];
/** gzip with the deflate method (RFC 1952: CM = 8, the only one defined). */
const GZIP = [0x1f, 0x8b, 0x08];
const ID3 = ascii('ID3');
const UTF8_BOM = [0xef, 0xbb, 0xbf];

/**
 * SVG: text whose first markup (after a UTF-8 byte order mark and white space) is `<svg`, or an XML prolog, a
 * doctype or a comment followed somewhere in the head by `<svg`. Case is ignored. Read as Latin-1, so no byte
 * sequence can fail to decode.
 */
function isSvg(head: Uint8Array): boolean {
  let text = latin1(head).toLowerCase();
  if (text.startsWith('\u00ef\u00bb\u00bf')) text = text.slice(3); // the UTF-8 BOM, read as Latin-1
  text = text.trimStart();
  if (text.startsWith('<svg')) return true;
  return (text.startsWith('<?xml') || text.startsWith('<!doctype') || text.startsWith('<!--')) && text.includes('<svg');
}

// ---- Phase 2 (catalog): Task 2 ----

/** The major brands of an `ftyp` box that are still images (HEIF, AVIF), not audio or video. */
const IMAGE_BRANDS: ReadonlySet<string> = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1', 'avif', 'avis']);
/** The major brands of an `ftyp` box that are audio only (iTunes AAC, audiobooks, protected audio). */
const AUDIO_BRANDS: ReadonlySet<string> = new Set(['M4A ', 'M4B ', 'M4P ']);

/**
 * An MPEG audio Layer III frame header (an MP3 without an ID3 tag): the 11-bit frame sync, a version that is not the
 * reserved one, layer III, a bitrate index that is neither free (0) nor bad (15), and a sampling rate that is not
 * reserved. Layer III only: a UTF-16 byte order mark (`FF FE`) and AAC's ADTS header (layer 0) never pass.
 */
function isMpegLayer3Frame(head: Uint8Array): boolean {
  if (head.byteLength < 4 || head[0] !== 0xff) return false;
  const b1 = head[1]!;
  const b2 = head[2]!;
  if ((b1 & 0xe0) !== 0xe0) return false;
  const version = (b1 >> 3) & 0x03;
  const layer = (b1 >> 1) & 0x03;
  const bitrate = b2 >> 4;
  const sampling = (b2 >> 2) & 0x03;
  return version !== 0x01 && layer === 0x01 && bitrate !== 0x00 && bitrate !== 0x0f && sampling !== 0x03;
}

/** An ID3v2 tag: `ID3`, a major version 2-4, and a first size byte without its high bit (sizes are syncsafe). */
function isId3(head: Uint8Array): boolean {
  return startsWith(head, ID3) && head.byteLength >= 7 && head[3]! >= 2 && head[3]! <= 4 && head[6]! < 0x80;
}

const isDigit = (byte: number | undefined): boolean => byte !== undefined && byte >= 0x30 && byte <= 0x39;
const isPrintable = (byte: number | undefined): boolean => byte !== undefined && byte >= 0x20 && byte <= 0x7e;

/** The decimal value of `head[from..from+length)`, all digits (the caller checked). */
function digitsAt(head: Uint8Array, from: number, length: number): number {
  let n = 0;
  for (let i = from; i < from + length; i += 1) n = n * 10 + (head[i]! - 0x30);
  return n;
}

/**
 * ISO 2709 (a MARC 21 record, §5.1): a 24-byte leader of five digits of record length, five printable characters,
 * the indicator and subfield code counts and five digits of base address, three printable characters and the
 * four-digit entry map; then the directory, which ends with a field terminator (0x1E) right before the base address.
 * When the base address lies beyond the head, the first directory entry must look like one (a tag of three
 * characters, then nine digits). The record length is not compared with anything: a dirty leader is the reader's to
 * report, per record. A CSV row that starts with five digits fails on the digits at 10-16 or on the terminator.
 */
function isIso2709(head: Uint8Array): boolean {
  if (head.byteLength < 25) return false;
  for (const i of [0, 1, 2, 3, 4, 10, 11, 12, 13, 14, 15, 16, 20, 21, 22, 23]) if (!isDigit(head[i])) return false;
  for (const i of [5, 6, 7, 8, 9, 17, 18, 19]) if (!isPrintable(head[i])) return false;
  const base = digitsAt(head, 12, 5);
  if (base < 25) return false; // the leader and at least the directory's terminator
  if (base - 1 < head.byteLength) return head[base - 1] === 0x1e;
  for (let i = 24; i < 27; i += 1) if (!isPrintable(head[i]) || head[i] === 0x20) return false;
  for (let i = 27; i < 36; i += 1) if (!isDigit(head[i])) return false;
  return true;
}

/**
 * XML: `<?xml`, or a `<` as the first character after a UTF-8 byte order mark and white space, in a head that holds no
 * NUL (XML text never does; a binary file whose first byte happens to be `<` stays `unknown`).
 */
function isXml(head: Uint8Array): boolean {
  let at = startsWith(head, UTF8_BOM) ? 3 : 0;
  while (at < head.byteLength && (head[at] === 0x20 || head[at] === 0x09 || head[at] === 0x0a || head[at] === 0x0d)) at += 1;
  return head[at] === 0x3c && !head.includes(0x00); // `<`, which `<?xml` begins with too
}

/** Text: a head that is not empty and holds no NUL (UTF-8 and cp1252 alike; a CSV from Excel may be either). */
function isText(head: Uint8Array): boolean {
  return head.byteLength > 0 && !head.includes(0x00);
}

/**
 * The type of a file from its first bytes (at most {@link MAGIC_HEAD_BYTES} are looked at), the first that matches:
 * ZIP, PDF, PNG, JPEG, GIF, WebP and, from Phase 2, WAV, MP4 (`ftyp`; M4A brands as audio), Ogg, WebM (EBML with the
 * `webm` doctype), gzip and MP3 (an ID3 tag or a Layer III frame) by their signatures; then SVG as text (see above),
 * with an opaque type, never `image/svg+xml`; then XML, ISO 2709 and text; anything else `unknown`
 * (`application/octet-stream`).
 */
export function detectType(head: Uint8Array): DetectedType {
  const bytes = head.byteLength > MAGIC_HEAD_BYTES ? head.subarray(0, MAGIC_HEAD_BYTES) : head;
  if (startsWith(bytes, ZIP_LOCAL) || startsWith(bytes, ZIP_EMPTY)) return { kind: 'zip', mime: 'application/zip' };
  if (startsWith(bytes, PDF)) return { kind: 'pdf', mime: 'application/pdf' };
  if (startsWith(bytes, PNG)) return { kind: 'png', mime: 'image/png' };
  if (startsWith(bytes, JPEG)) return { kind: 'jpeg', mime: 'image/jpeg' };
  if (startsWith(bytes, GIF87) || startsWith(bytes, GIF89)) return { kind: 'gif', mime: 'image/gif' };
  if (startsWith(bytes, RIFF) && startsWith(bytes, WEBP, 8)) return { kind: 'webp', mime: 'image/webp' };
  // ---- Phase 2 (catalog): Task 2 ----
  if (startsWith(bytes, RIFF) && startsWith(bytes, WAVE, 8)) return { kind: 'wav', mime: 'audio/wav' };
  if (startsWith(bytes, FTYP, 4) && bytes.byteLength >= 12) {
    const brand = latin1(bytes.subarray(8, 12));
    if (IMAGE_BRANDS.has(brand)) return { ...UNKNOWN };
    return { kind: 'mp4', mime: AUDIO_BRANDS.has(brand) ? 'audio/mp4' : 'video/mp4' };
  }
  if (startsWith(bytes, OGG)) return { kind: 'ogg', mime: 'audio/ogg' };
  if (startsWith(bytes, EBML)) {
    // The EBML header names its doctype within its first bytes: `webm`, or `matroska` for any other Matroska file.
    return latin1(bytes.subarray(0, 64)).includes('webm') ? { kind: 'webm', mime: 'video/webm' } : { ...UNKNOWN };
  }
  if (startsWith(bytes, GZIP)) return { kind: 'gzip', mime: 'application/gzip' };
  if (isId3(bytes) || isMpegLayer3Frame(bytes)) return { kind: 'mp3', mime: 'audio/mpeg' };
  if (isSvg(bytes)) return { kind: 'svg', mime: OPAQUE };
  if (isXml(bytes)) return { kind: 'xml', mime: 'application/xml' };
  if (isIso2709(bytes)) return { kind: 'iso2709', mime: 'application/marc' };
  if (isText(bytes)) return { kind: 'text', mime: 'text/plain' };
  return { ...UNKNOWN };
}
