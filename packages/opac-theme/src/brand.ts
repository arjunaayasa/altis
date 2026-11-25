// Derives light and dark OPAC accent tokens from one library hex colour (`#rrggbb`), holding every pairing to WCAG AA (4.5:1).
// Pure and dependency-free: the server writes the result into the single CSP-nonced style element.

import { contrastRatio, hexRgb, oklchHex, rgbToOklch } from './color.js';

const AA = 4.5;

/** Warm stone second-layer backdrops against which brand link and button contrast is guaranteed. */
export const BRAND_BACKDROPS = Object.freeze({ light: '#f2efe8', dark: '#1c1f1d' });

export interface BrandScheme {
  accent: string;
  accentHover: string;
  /** Solid fallback surface for a hero without photos (white text >= 4.5:1). */
  panel: string;
}

export interface BrandTokens {
  light: BrandScheme;
  dark: BrandScheme;
}

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
 * Computes light and dark scheme tokens for library colour `hex` (`#rrggbb`).
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

/** Rebuilds CSS custom properties strictly from parsed RGB channels so raw setting text never enters `<style>`. */
export function brandCss(hex: string): string {
  const t = brandTokens(hex);
  return (
    `:root{${schemeCss(t.light)}}` +
    `@media (prefers-color-scheme:dark){:root:not([data-theme=light]){${schemeCss(t.dark)}}}` +
    `:root[data-theme=dark]{${schemeCss(t.dark)}}`
  );
}
