import { SITE_ICON_SIDES, SITE_IMAGE_MAX_BYTES, SITE_LOGO_BOX } from '@altis/shared/api/site-identity';

/**
 * The logo or icon of the site's identity, made ready for its upload in the browser. The server takes PNG only (the
 * upload contexts `site.logo` and `site.icon`), so the chosen PNG, JPEG or WebP file is decoded, drawn on a canvas
 * (transparency kept, no backdrop) and encoded as PNG:
 *
 * - a logo is scaled down to fit the box the server stores (960 × 240), never enlarged;
 * - an icon is cut to its centre square, at most 512 px a side;
 * - a PNG above the upload limit (1 MiB) is drawn again smaller, a few times, before it is given up.
 *
 * Refused before anything is decoded or sent: an SVG (by its type, its name or its first bytes; it must be exported as
 * PNG), a file that is no PNG, JPEG or WebP by its first bytes, and a file above {@link SITE_IMAGE_SOURCE_MAX_BYTES}.
 * Refused after decoding: an image the browser cannot read, and one smaller than the server accepts.
 */

/** The largest file the browser is asked to decode. */
export const SITE_IMAGE_SOURCE_MAX_BYTES = 8 * 1024 * 1024;
/** What the file input offers. */
export const SITE_IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp';

export type SiteImageKind = 'logo' | 'icon';
/** What a file is by its first bytes. */
export type SniffedImage = 'png' | 'jpeg' | 'webp' | 'svg' | 'other';
/** Why a chosen file cannot become the logo or icon. */
export type SiteImageRefusal = 'svg' | 'not_image' | 'source_too_large' | 'unreadable' | 'too_small' | 'too_large';

/** A chosen file that was refused in the browser; `minSide` comes with `too_small`. */
export class SiteImageError extends Error {
  override name = 'SiteImageError';
  refusal: SiteImageRefusal;
  minSide?: number;

  constructor(refusal: SiteImageRefusal, minSide?: number) {
    super(`site image refused: ${refusal}`);
    this.refusal = refusal;
    if (minSide !== undefined) this.minSide = minSide;
  }
}

/** The PNG to upload, and its size in pixels. */
export interface SitePng {
  blob: Blob;
  width: number;
  height: number;
}

/** The first bytes of `file` (a browser without `Blob.arrayBuffer` reads them with a FileReader). */
async function head(file: Blob, bytes: number): Promise<Uint8Array> {
  const part = file.slice(0, bytes);
  if (typeof part.arrayBuffer === 'function') return new Uint8Array(await part.arrayBuffer());
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(new TypeError('the file cannot be read'));
    reader.readAsArrayBuffer(part);
  });
}

const startsWith = (bytes: Uint8Array, magic: readonly number[], at = 0): boolean => magic.every((b, i) => bytes[at + i] === b);

/** What `file` is by its content: the magic bytes of PNG, JPEG and WebP, or markup that opens an SVG. */
export async function sniffImage(file: Blob): Promise<SniffedImage> {
  const bytes = await head(file, 1024);
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return 'webp';
  // A gzipped SVG (.svgz) is told by its name; plain markup by its opening tag.
  const text = Array.from(bytes, (b) => String.fromCharCode(b)).join('').toLowerCase();
  // The bytes read as Latin-1: a UTF-8 byte order mark is the three characters EF BB BF.
  if (/<svg[\s>]/.test(text) || /^(\xef\xbb\xbf)?\s*<\?xml/.test(text)) return 'svg';
  return 'other';
}

/** Whether `file` says it is an SVG by its type or its name. */
function namedSvg(file: Blob): boolean {
  const name = typeof File !== 'undefined' && file instanceof File ? file.name.toLowerCase() : '';
  return file.type.toLowerCase().startsWith('image/svg') || /\.svgz?$/.test(name);
}

/**
 * Checks `file` before the browser decodes it.
 *
 * @throws SiteImageError `svg`, `not_image` or `source_too_large`
 */
export async function checkSiteImageFile(file: Blob): Promise<void> {
  if (namedSvg(file)) throw new SiteImageError('svg');
  const sniffed = await sniffImage(file);
  if (sniffed === 'svg') throw new SiteImageError('svg');
  if (sniffed === 'other') throw new SiteImageError('not_image');
  if (file.size > SITE_IMAGE_SOURCE_MAX_BYTES) throw new SiteImageError('source_too_large');
}

/** The part of a `width` × `height` image that is drawn, and the size it is drawn at. */
export interface SiteImageFrame {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  width: number;
  height: number;
}

/**
 * How an image of `width` × `height` is drawn as `kind`, at `scale` (1, or less for another try at a smaller file):
 * a logo whole, fitted in the stored box and never enlarged; an icon as its centre square of at most 512 px.
 *
 * @throws SiteImageError `too_small` below the sides the server accepts
 */
export function siteImageFrame(kind: SiteImageKind, width: number, height: number, scale = 1): SiteImageFrame {
  const whole = (n: number): number => Math.max(1, Math.round(n));
  if (kind === 'icon') {
    const side = Math.min(width, height);
    if (side < SITE_ICON_SIDES.min) throw new SiteImageError('too_small', SITE_ICON_SIDES.min);
    const out = Math.max(SITE_ICON_SIDES.min, whole(Math.min(side, SITE_ICON_SIDES.storedSide) * scale));
    return { sx: Math.floor((width - side) / 2), sy: Math.floor((height - side) / 2), sw: side, sh: side, width: out, height: out };
  }
  if (Math.min(width, height) < SITE_LOGO_BOX.minSide) throw new SiteImageError('too_small', SITE_LOGO_BOX.minSide);
  const fit = Math.min(1, SITE_LOGO_BOX.maxWidth / width, SITE_LOGO_BOX.maxHeight / height) * scale;
  return { sx: 0, sy: 0, sw: width, sh: height, width: Math.max(SITE_LOGO_BOX.minSide, whole(width * fit)), height: Math.max(SITE_LOGO_BOX.minSide, whole(height * fit)) };
}

/** The steps a PNG above the limit is drawn again at. */
const SCALES = [1, 0.75, 0.5] as const;

/**
 * `file` as the PNG to upload for `kind` (see the top of this file).
 *
 * @throws SiteImageError why the file cannot be used; nothing was uploaded
 */
export async function sitePngOf(file: Blob, kind: SiteImageKind): Promise<SitePng> {
  await checkSiteImageFile(file);
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new SiteImageError('unreadable');
  }
  try {
    if (bitmap.width < 1 || bitmap.height < 1) throw new SiteImageError('unreadable');
    for (const scale of SCALES) {
      const frame = siteImageFrame(kind, bitmap.width, bitmap.height, scale);
      const canvas = document.createElement('canvas');
      canvas.width = frame.width;
      canvas.height = frame.height;
      const context = canvas.getContext('2d');
      if (context === null) throw new SiteImageError('unreadable');
      context.imageSmoothingQuality = 'high';
      // No backdrop: the transparent parts of a logo stay transparent.
      context.drawImage(bitmap, frame.sx, frame.sy, frame.sw, frame.sh, 0, 0, frame.width, frame.height);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (blob === null || blob.type !== 'image/png') throw new SiteImageError('unreadable');
      if (blob.size <= SITE_IMAGE_MAX_BYTES) return { blob, width: frame.width, height: frame.height };
    }
    throw new SiteImageError('too_large');
  } finally {
    bitmap.close();
  }
}

/** `blob` as a `data:` address, for showing a fresh image before it is saved. */
export function dataUrlOf(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => (typeof reader.result === 'string' ? resolve(reader.result) : reject(new TypeError('the image cannot be read')));
    reader.onerror = () => reject(new TypeError('the image cannot be read'));
    reader.readAsDataURL(blob);
  });
}
