/**
 * Shrinks an image in the browser before it is uploaded (Phase 2 spec §8: "admin memperkecil gambar di browser
 * (`<canvas>`, sisi panjang ≤ 600 px, JPEG/WebP) sebelum unggah"; plan Task 24). A record's cover goes up small, so a
 * shared host stores and serves a few dozen kilobytes instead of a phone photo of several megabytes, and the canvas
 * re-encoding leaves no EXIF behind (the server strips metadata anyway, Task 18).
 *
 * - The file is decoded with `createImageBitmap` (EXIF orientation applied), else through an `<img>`.
 * - It is drawn at {@link scaledSize}: the longest side at most `maxSide`, the ratio kept, never enlarged, on white
 *   (a cover is shown on a white page, and JPEG has no transparency).
 * - It is encoded as `type`. A browser that cannot encode WebP answers PNG from `toBlob`, so the image is encoded
 *   again as JPEG, which every browser writes.
 * - A file the browser cannot decode rejects with a TypeError; nothing is uploaded then.
 */

export type ResizedImageType = 'image/webp' | 'image/jpeg';

export interface ResizeOptions {
  /** The longest side of the result, in pixels. */
  maxSide: number;
  type: ResizedImageType;
}

/** The encoder quality of the lossy formats. */
const QUALITY = 0.85;

/** The size of a `width` × `height` image whose longest side is at most `maxSide` (whole pixels, at least 1). */
export function scaledSize(width: number, height: number, maxSide: number): { width: number; height: number } {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** A decoded image and how to let it go. */
interface Decoded {
  source: CanvasImageSource;
  width: number;
  height: number;
  release(): void;
}

/** Decodes `file` through an `<img>` (a browser without `createImageBitmap`). */
function decodeWithImage(file: Blob): Promise<Decoded> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ source: img, width: img.naturalWidth, height: img.naturalHeight, release: () => URL.revokeObjectURL(url) });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new TypeError('resizeImage(): the image cannot be decoded'));
    };
    img.src = url;
  });
}

async function decode(file: Blob): Promise<Decoded> {
  if (typeof createImageBitmap !== 'function') return decodeWithImage(file);
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new TypeError('resizeImage(): the image cannot be decoded');
  }
  return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
}

/** The canvas as a Blob of `type` (null when the browser gives nothing). */
function toBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, QUALITY));
}

/** `file` decoded, shrunk to `o.maxSide` and encoded as `o.type` (JPEG where the browser cannot write WebP). */
export async function resizeImage(file: Blob, o: ResizeOptions): Promise<Blob> {
  const image = await decode(file);
  try {
    if (image.width < 1 || image.height < 1) throw new TypeError('resizeImage(): the image is empty');
    const size = scaledSize(image.width, image.height, o.maxSide);
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext('2d');
    if (context === null) throw new TypeError('resizeImage(): this browser cannot draw on a canvas');
    context.imageSmoothingQuality = 'high';
    // A white backdrop under a transparent image: JPEG (the fallback) has no transparency and would turn it black.
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, size.width, size.height);
    context.drawImage(image.source, 0, 0, size.width, size.height);
    const wanted = await toBlob(canvas, o.type);
    if (wanted !== null && wanted.type === o.type) return wanted;
    const jpeg = await toBlob(canvas, 'image/jpeg');
    if (jpeg === null) throw new TypeError('resizeImage(): this browser cannot encode the image');
    return jpeg;
  } finally {
    image.release();
  }
}
