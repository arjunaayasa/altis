// The library colour as the OPAC's tokens. A library sets one colour (`#rrggbb`, white text on it at 4.5:1 or more);
// the pages need more than that one value: the accent of links and buttons on the light page, a lighter accent on the
// dark page, a hover shade of each, and the panel behind a slide's text in both schemes. They are worked out here, in
// OKLCH (the hue and as much of the chroma as fits are kept; only the lightness moves), and each is held to its
// contrast by construction:
//
// - the light accent is the colour itself, darkened only as far as it takes to read at 4.5:1 on the second layer;
// - the dark accent is a light tint of the hue, at 4.5:1 or more on the dark second layer;
// - the panel is the colour itself (light) and a deeper shade of it (dark); white text is at 4.5:1 or more on both.
//
// Pure, no dependency: the server writes the result into the one style element that carries the response's nonce.

import { contrastRatio, hexRgb, oklchHex, rgbToOklch } from './color.js';

/** The contrast every text keeps (WCAG AA). */
const AA = 4.5;

/** What the brand's tokens are measured against: the second layer of each scheme (the page itself contrasts more). */
export const BRAND_BACKDROPS = Object.freeze({ light: '#f5f6f6', dark: '#1a1e1d' });

/** The tokens of one scheme. */
export interface BrandScheme {
  /** Links, buttons, the current menu entry. */
  accent: string;
  accentHover: string;
  /** The panel behind a slide's text (white text). */
  panel: string;
}

export interface BrandTokens {
  light: BrandScheme;
  dark: BrandScheme;
}

/** `hex` with its lightness moved by `step` until `ok`, at most 60 steps. */
function seek(l: number, c: number, h: number, step: number, ok: (hex: string) => boolean): string {
  let lightness = l;
  let hex = oklchHex(lightness, c, h);
  for (let i = 0; i < 60 && !ok(hex); i++) {
    lightness = Math.min(1, Math.max(0, lightness + step));
    hex = oklchHex(lightness, c, h);
  }
  return hex;
}

/**
 * The tokens of the library colour `hex` (`#rrggbb`).
 *
 * @throws TypeError when `hex` is not `#rrggbb`
 */
export function brandTokens(hex: string): BrandTokens {
  const base = hex.toLowerCase();
  const [l, c, h] = rgbToOklch(hexRgb(base));
  const onWhite = (x: string): boolean => contrastRatio(x, '#ffffff') >= AA;
  const lightAccent = contrastRatio(base, BRAND_BACKDROPS.light) >= AA ? base : seek(l, c, h, -0.01, (x) => contrastRatio(x, BRAND_BACKDROPS.light) >= AA);
  const lightPanel = onWhite(base) ? base : seek(l, c, h, -0.01, onWhite);
  const [la] = rgbToOklch(hexRgb(lightAccent));
  const tint = Math.min(c, 0.11);
  const darkAccent = seek(Math.max(0.76, Math.min(l + 0.3, 0.8)), tint, h, 0.01, (x) => contrastRatio(x, BRAND_BACKDROPS.dark) >= AA);
  const [ld] = rgbToOklch(hexRgb(darkAccent));
  return {
    light: { accent: lightAccent, accentHover: oklchHex(Math.max(0, la - 0.07), c, h), panel: lightPanel },
    dark: {
      accent: darkAccent,
      accentHover: oklchHex(Math.min(0.95, ld + 0.06), tint * 0.85, h),
      panel: seek(Math.min(l * 0.82, 0.37), c * 0.82, h, -0.01, onWhite),
    },
  };
}

const schemeCss = (s: BrandScheme): string => `--accent:${s.accent};--accent-hover:${s.accentHover};--panel:${s.panel}`;

/**
 * The style sheet that makes `hex` the library colour of a page: the tokens of both schemes on the root element. It
 * holds nothing but colours rebuilt from numbers, so a setting's text never reaches a page through it.
 */
export function brandCss(hex: string): string {
  const t = brandTokens(hex);
  return `:root{${schemeCss(t.light)}}@media (prefers-color-scheme:dark){:root{${schemeCss(t.dark)}}}`;
}
