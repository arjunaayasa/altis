// The JPEG header reader behind the PDF pictures (ISO/IEC 10918-1, the marker syntax only; nothing is decoded). A PDF
// shows a JPEG file unchanged through the DCTDecode filter, so the writer only needs the frame size and the number of
// colour components, and must refuse what a PDF reader would not show: another format, CMYK (the admin converts
// uploads to RGB JPEG), lossless, hierarchical or arithmetic-coded frames, samples other than 8 bits, and a file cut
// off before its end marker. The whole file is walked marker by marker, so a cut-off scan is found too. Pure; no I/O.

export type JpegErrorReason = 'not_jpeg' | 'cmyk' | 'truncated';

/** A file the PDF writer cannot use as a picture; `reason` says why. The message never quotes the bytes. */
export class JpegError extends Error {
  readonly reason: JpegErrorReason;

  constructor(reason: JpegErrorReason, message?: string) {
    super(message ? `JPEG refused (${reason}): ${message}` : `JPEG refused (${reason})`);
    this.name = 'JpegError';
    this.reason = reason;
  }
}

/** What a picture needs from its JPEG header. */
export interface JpegInfo {
  width: number;
  height: number;
  /** 1 = grey (DeviceGray), 3 = colour (DeviceRGB). */
  components: 1 | 3;
}

const SOI = 0xd8;
const EOI = 0xd9;
const SOS = 0xda;
/** Frames with Huffman coding a PDF reader decodes: baseline, extended sequential and progressive. */
const SUPPORTED_FRAMES = new Set([0xc0, 0xc1, 0xc2]);
/** Every other start-of-frame marker: lossless, hierarchical (differential) and arithmetic-coded frames. */
const OTHER_FRAMES = new Set([0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

/** Markers without a length field: TEM and the restart markers (SOI and EOI are handled on their own). */
const standalone = (marker: number): boolean => marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7);

/**
 * The frame size and colour components of a JPEG file. Throws `JpegError`: `not_jpeg` when the bytes are not a JPEG
 * file a PDF reader can show (no start marker, a broken marker structure, a frame type other than baseline, extended
 * sequential or progressive Huffman, samples other than 8 bits, a zero size, components other than 1, 3 or 4, no
 * frame or scan before the end marker); `cmyk` for four components; `truncated` when the bytes end before the end
 * marker. Bytes after the end marker are ignored.
 */
export function jpegInfo(bytes: Uint8Array): JpegInfo {
  if (bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== SOI) throw new JpegError('not_jpeg', 'no start-of-image marker');
  let frame: JpegInfo | null = null;
  let scans = 0;
  let pos = 2;
  for (;;) {
    // A marker: 0xFF, any number of 0xFF fill bytes, then the marker code.
    if (pos >= bytes.length) throw new JpegError('truncated');
    if (bytes[pos] !== 0xff) throw new JpegError('not_jpeg', `no marker at byte ${pos}`);
    while (pos < bytes.length && bytes[pos] === 0xff) pos++;
    if (pos >= bytes.length) throw new JpegError('truncated');
    const marker = bytes[pos++]!;
    if (marker === EOI) {
      if (frame === null || scans === 0) throw new JpegError('not_jpeg', 'no frame or no scan before the end marker');
      return frame;
    }
    if (marker === SOI || marker === 0x00) throw new JpegError('not_jpeg', `unexpected marker at byte ${pos - 1}`);
    if (standalone(marker)) continue;
    if (pos + 2 > bytes.length) throw new JpegError('truncated');
    const length = (bytes[pos]! << 8) | bytes[pos + 1]!;
    if (length < 2) throw new JpegError('not_jpeg', `segment length ${length}`);
    const end = pos + length;
    if (end > bytes.length) throw new JpegError('truncated');
    if (SUPPORTED_FRAMES.has(marker)) {
      if (frame !== null) throw new JpegError('not_jpeg', 'a second frame header');
      frame = readFrame(bytes, pos + 2, length - 2);
    } else if (OTHER_FRAMES.has(marker)) {
      throw new JpegError('not_jpeg', 'a lossless, hierarchical or arithmetic-coded frame');
    }
    pos = end;
    if (marker === SOS) {
      if (frame === null) throw new JpegError('not_jpeg', 'a scan before the frame header');
      scans++;
      pos = skipEntropyData(bytes, pos);
    }
  }
}

/** The frame header's fields (after its length): precision, height, width, components, 3 bytes per component. */
function readFrame(bytes: Uint8Array, at: number, length: number): JpegInfo {
  if (length < 6) throw new JpegError('not_jpeg', 'a short frame header');
  const precision = bytes[at]!;
  const height = (bytes[at + 1]! << 8) | bytes[at + 2]!;
  const width = (bytes[at + 3]! << 8) | bytes[at + 4]!;
  const components = bytes[at + 5]!;
  if (length !== 6 + 3 * components) throw new JpegError('not_jpeg', 'the frame header length does not match its components');
  if (precision !== 8) throw new JpegError('not_jpeg', `${precision}-bit samples`);
  // A height of 0 defers it to a later DNL marker, which PDF readers do not all support.
  if (width === 0 || height === 0) throw new JpegError('not_jpeg', 'a zero width or height');
  if (components === 4) throw new JpegError('cmyk');
  if (components !== 1 && components !== 3) throw new JpegError('not_jpeg', `${components} colour components`);
  return { width, height, components };
}

/**
 * The position of the marker that ends the entropy-coded data starting at `pos`. Inside it, 0xFF is followed by 0x00
 * (a stuffed data byte) or a restart marker; any other marker ends the data.
 */
function skipEntropyData(bytes: Uint8Array, pos: number): number {
  for (let i = pos; i + 1 < bytes.length; i++) {
    if (bytes[i] !== 0xff) continue;
    const next = bytes[i + 1]!;
    if (next === 0x00 || next === 0xff || (next >= 0xd0 && next <= 0xd7)) {
      // A stuffed byte or a restart marker is data; a run of 0xFF fill bytes is looked at again from its last byte.
      if (next !== 0xff) i++;
      continue;
    }
    return i;
  }
  throw new JpegError('truncated');
}
