import { SITE_ICON_SIDES, SITE_IMAGE_MAX_SIDE, SITE_LOGO_BOX, type SiteIconSize } from '@altis/shared/api/site-identity';
import { PngError, cropSquare, decodePng, encodePng, scaleDown, type RasterImage } from './png.js';

// What the server does with an uploaded logo or site icon (contexts `site.logo` and `site.icon`): the PNG is decoded
// to pixels and encoded again, so nothing of the uploaded file but its picture is stored (png.ts).
//
// - The logo keeps its alpha and is scaled down to fit SITE_LOGO_BOX (never enlarged).
// - The icon is cropped to its centre square and stored at most SITE_ICON_SIDES.storedSide a side; the sizes a browser
//   asks for (32, 180, 192) are made from that stored file by `siteIconVariant`, so one file row holds the icon and
//   claiming, releasing, sweeping and backing it up are those of any single file.
// - Without a site icon the same sizes come from a built-in one, drawn here.

/** Why a logo or icon was refused; `too_small` names the smallest side allowed. */
export type SiteImageRefusal = 'damaged' | 'dimensions' | 'interlaced' | 'too_small';

/** A logo or icon the server cannot store. */
export class SiteImageError extends Error {
  readonly reason: SiteImageRefusal;
  /** The smallest and largest side in pixels the context takes. */
  readonly sides: { min: number; max: number };
  constructor(reason: SiteImageRefusal, sides: { min: number; max: number }, options?: ErrorOptions) {
    super(`site image refused: ${reason}`, options);
    this.name = 'SiteImageError';
    this.reason = reason;
    this.sides = sides;
  }
}

function decoded(bytes: Uint8Array, minSide: number): RasterImage {
  const sides = { min: minSide, max: SITE_IMAGE_MAX_SIDE };
  let image: RasterImage;
  try {
    image = decodePng(bytes, { maxSide: SITE_IMAGE_MAX_SIDE });
  } catch (error) {
    if (error instanceof PngError) throw new SiteImageError(error.reason, sides, { cause: error });
    throw error;
  }
  if (Math.min(image.width, image.height) < minSide) throw new SiteImageError('too_small', sides);
  return image;
}

/**
 * The logo to store for the uploaded PNG `bytes`: the same picture, scaled down to fit the logo box, as a fresh PNG.
 *
 * @throws SiteImageError
 */
export function storedSiteLogo(bytes: Uint8Array): Uint8Array {
  const image = decoded(bytes, SITE_LOGO_BOX.minSide);
  const factor = Math.min(1, SITE_LOGO_BOX.maxWidth / image.width, SITE_LOGO_BOX.maxHeight / image.height);
  const width = Math.max(1, Math.min(image.width, Math.round(image.width * factor)));
  const height = Math.max(1, Math.min(image.height, Math.round(image.height * factor)));
  return encodePng(scaleDown(image, width, height));
}

/**
 * The icon to store for the uploaded PNG `bytes`: its centre square, at most SITE_ICON_SIDES.storedSide a side.
 *
 * @throws SiteImageError
 */
export function storedSiteIcon(bytes: Uint8Array): Uint8Array {
  const square = cropSquare(decoded(bytes, SITE_ICON_SIDES.min));
  const side = Math.min(square.width, SITE_ICON_SIDES.storedSide);
  return encodePng(scaleDown(square, side, side));
}

/**
 * The stored icon `stored` (what {@link storedSiteIcon} made) as a `size` × `size` PNG.
 *
 * @throws SiteImageError when the bytes are not a stored icon (a damaged blob)
 */
export function siteIconVariant(stored: Uint8Array, size: SiteIconSize): Uint8Array {
  const square = cropSquare(decoded(stored, size));
  return encodePng(scaleDown(square, size, size));
}

/** The built-in icon's colours: a dark slate tile and a white open-book mark. */
const TILE: readonly [number, number, number] = [0x1f, 0x29, 0x37];
const MARK: readonly [number, number, number] = [0xff, 0xff, 0xff];

/** The built-in icon drawn at `side` pixels: a rounded square with two pages and a spine between them. */
function drawDefaultIcon(side: number): RasterImage {
  const data = new Uint8Array(side * side * 4);
  const radius = side * 0.22;
  const inTile = (x: number, y: number): boolean => {
    const dx = Math.max(radius - x, x - (side - radius), 0);
    const dy = Math.max(radius - y, y - (side - radius), 0);
    return dx * dx + dy * dy <= radius * radius;
  };
  // The pages: two rectangles from 30 % to 70 % of the height, left and right of a gap in the middle.
  const top = side * 0.3;
  const bottom = side * 0.7;
  const inMark = (x: number, y: number): boolean =>
    y >= top && y < bottom && ((x >= side * 0.2 && x < side * 0.47) || (x >= side * 0.53 && x < side * 0.8));
  for (let y = 0; y < side; y += 1) {
    for (let x = 0; x < side; x += 1) {
      const cx = x + 0.5;
      const cy = y + 0.5;
      if (!inTile(cx, cy)) continue;
      const colour = inMark(cx, cy) ? MARK : TILE;
      const o = (y * side + x) * 4;
      data[o] = colour[0];
      data[o + 1] = colour[1];
      data[o + 2] = colour[2];
      data[o + 3] = 255;
    }
  }
  return { width: side, height: side, data };
}

const defaults = new Map<SiteIconSize, Uint8Array>();

/** The built-in icon as a `size` × `size` PNG (drawn four times larger and averaged down, so its edges are smooth). */
export function defaultSiteIcon(size: SiteIconSize): Uint8Array {
  let png = defaults.get(size);
  if (png === undefined) {
    png = encodePng(scaleDown(drawDefaultIcon(size * 4), size, size));
    defaults.set(size, png);
  }
  return png;
}
