// A JPEG of any declared size for the upload tests: SOI, a JFIF header, a quantisation table, a baseline frame header of
// `width` × `height` with three components, an empty Huffman table, one scan with a few bytes of entropy-coded data, and
// EOI. Its marker structure holds (the server reads the frame size from it and strips its metadata), though a viewer
// would not draw a picture from it.

const segment = (marker: number, payload: number[]): number[] => [0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff, ...payload];

/** The bytes of a structurally valid baseline JPEG of `width` × `height`. */
export function sizedJpeg(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    0xff,
    0xd8,
    ...segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ...segment(0xdb, [0, ...new Array<number>(64).fill(1)]),
    ...segment(0xc0, [8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0]),
    ...segment(0xc4, [0, ...new Array<number>(16).fill(0)]),
    ...segment(0xda, [3, 1, 0, 2, 0, 3, 0, 0, 0x3f, 0]),
    0x12,
    0x34,
    0x56,
    0xff,
    0xd9,
  ]);
}
