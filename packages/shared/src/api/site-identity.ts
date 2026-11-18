/**
 * The site's identity (the setting `site.identity`): the library's own logo, a logo for dark backgrounds, the site
 * icon, the site's name and tagline. One source for the OPAC, the admin's sidebar and sign-in page, the browser tab
 * and printed things that carry the logo. No Node built-ins here: the browser bundles this module. Import it as
 * `@altis/shared/api/site-identity`.
 *
 * - `GET/PUT /api/v1/site/identity` (permission `opac.pages.manage`) read and save it; a save names the revision it
 *   loaded (409 CONFLICT_STALE otherwise) and is audited as `site.identity.update`.
 * - `GET /api/v1/site/identity/public` needs no session: what every visitor sees anyway (name, tagline, logo, icon).
 * - The images are uploads of the contexts `site.logo` and `site.icon`: PNG only, at most 1 MiB and 4000 px a side.
 *   The server decodes each one and stores it again (no metadata, nothing hidden), the logo scaled down to fit
 *   960 × 240, the icon cropped to its centre square. A browser turns a JPEG or WebP into PNG before it uploads; an
 *   SVG must be exported as PNG first.
 * - Until the identity is saved for the first time, the logo is the one the home page held and the name is the
 *   library's (`saved: false`).
 */
import { z } from 'zod';
import { ulidField } from './common.js';

/** The longest site name, tagline (per language) and logo alternative text, in code points. */
export const SITE_IDENTITY_LIMITS = Object.freeze({ name: 120, tagline: 160, alt: 160 });

/** The upload contexts of the identity's images. */
export const SITE_LOGO_CONTEXT = 'site.logo';
export const SITE_ICON_CONTEXT = 'site.icon';

/** The largest logo or icon file. */
export const SITE_IMAGE_MAX_BYTES = 1024 * 1024;
/** The largest width and height of an uploaded logo or icon, in pixels. */
export const SITE_IMAGE_MAX_SIDE = 4000;
/** The stored logo fits in this box (it is never enlarged); an upload below `minSide` a side is refused. */
export const SITE_LOGO_BOX = Object.freeze({ maxWidth: 960, maxHeight: 240, minSide: 16 });
/** An uploaded icon is at least this many pixels a side; its centre square is stored, at most `storedSide` a side. */
export const SITE_ICON_SIDES = Object.freeze({ min: 256, storedSide: 512 });
/** The sizes the server makes of the icon: the browser tab, the Apple touch icon, the home screen. */
export const SITE_ICON_SIZES = Object.freeze([32, 180, 192] as const);

export type SiteIconSize = (typeof SITE_ICON_SIZES)[number];

/** The path the icon of `size` is served at, with or without a site icon (then a built-in one). */
export function siteIconPath(size: SiteIconSize): string {
  return `/site-icon-${size}.png`;
}

/** A trimmed text of at most `max` code points. */
const text = (max: number) => z.string().trim().max(max);

/** The stored identity. */
export const SiteIdentity = z.strictObject({
  /** The main logo (for light backgrounds): a `site.logo` upload; a blank `alt` reads as the site's name. */
  logo: z.strictObject({ fileId: ulidField, alt: text(SITE_IDENTITY_LIMITS.alt) }).nullable(),
  /** The logo for dark backgrounds: a `site.logo` upload. */
  logoDark: z.strictObject({ fileId: ulidField }).nullable(),
  /** The site icon: a `site.icon` upload. */
  icon: z.strictObject({ fileId: ulidField }).nullable(),
  /** The site's name; null or blank: the library's name from Settings. */
  name: text(SITE_IDENTITY_LIMITS.name).nullable(),
  /** The tagline in each language; null or blank: none there. */
  tagline: z.strictObject({ id: text(SITE_IDENTITY_LIMITS.tagline).nullable(), en: text(SITE_IDENTITY_LIMITS.tagline).nullable() }),
  /** Whether the name is printed beside the logo (for a logo that is only a mark). */
  showNameBesideLogo: z.boolean(),
});

export type SiteIdentity = z.infer<typeof SiteIdentity>;

/** The identity of a site that has none yet: no images, the library's name, no tagline. */
export const SITE_IDENTITY_DEFAULT: SiteIdentity = Object.freeze({
  logo: null,
  logoDark: null,
  icon: null,
  name: null,
  tagline: Object.freeze({ id: null, en: null }),
  showNameBesideLogo: true,
});

/** The URL of the icon in each size. */
export type SiteIconUrls = Record<`${SiteIconSize}`, string>;

/** `GET site/identity`. */
export interface SiteIdentityView {
  /** The identity in force: the saved one, else the home page's old logo with the defaults. */
  identity: SiteIdentity;
  /** False until the identity was saved for the first time. */
  saved: boolean;
  /** Names what was loaded; a save sends it back. */
  revision: string;
  /** The library's name from Settings: the site's name while `identity.name` is blank. */
  libraryName: string;
  /** Where the images are served; `icon` always answers (the built-in icon while none is set). */
  urls: { logo: string | null; logoDark: string | null; icon: SiteIconUrls };
}

/** `PUT site/identity`. */
export const SiteIdentityPutBody = z.strictObject({
  revision: z.string().regex(/^[0-9a-f]{16}$/),
  identity: SiteIdentity,
});

export type SiteIdentityPutBody = z.infer<typeof SiteIdentityPutBody>;

/** The answer of `PUT site/identity`: the new revision and the fields that changed. */
export interface SiteIdentityPutResponse {
  revision: string;
  changed: string[];
}

/** `GET site/identity/public`: what a visitor without a session may know. */
export interface SiteIdentityPublic {
  /** The site's name (the library's when none was given). */
  name: string;
  tagline: { id: string | null; en: string | null };
  showNameBesideLogo: boolean;
  logo: { url: string; alt: string } | null;
  logoDark: { url: string } | null;
  /** True when the library set an icon of its own; the URLs answer either way. */
  hasIcon: boolean;
  icon: SiteIconUrls;
}
