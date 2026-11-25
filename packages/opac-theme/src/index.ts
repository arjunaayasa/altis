// @altis/opac-theme: joins per-module OPAC stylesheets in a fixed order so the server can serve the result under a content hash.

import { AKUN_CSS } from './akun.js';
import { BASE_CSS } from './base.js';
import { DETAIL_CSS } from './detail.js';
import { HOME_CSS } from './home.js';
import { PAGES_CSS } from './pages.js';
import { SEARCH_CSS } from './search.js';
import { SHELL_CSS } from './shell.js';
import { VISITS_CSS } from './visits.js';

export { ACCENTS, ACCENT_COLORS, PANEL_COLORS, DEFAULT_ACCENT, FRESH_INSTALL_ACCENT, SCHEME_COLORS, isAccent } from './base.js';
export type { AccentName } from './base.js';
export { BRAND_BACKDROPS, brandCss, brandTokens } from './brand.js';
export type { BrandScheme, BrandTokens } from './brand.js';
export { contrastRatio, hexRgb, oklchHex, oklchToRgb, rgbHex, rgbToOklch } from './color.js';
export type { Rgb } from './color.js';
export { OPAC_FONTS, OPAC_FONT_FACE_CSS, OPAC_FONT_FAMILY, OPAC_FONT_FILE_NAME, OPAC_FONT_PACKAGE, OPAC_FONT_STACK } from './fonts.js';
export type { OpacFont } from './fonts.js';
export { COVER_CLASSES, COVER_COLORS, SPINE_LABEL_COLORS } from './shell.js';
export type { CoverClass } from './shell.js';
export { AKUN_CSS, BASE_CSS, DETAIL_CSS, HOME_CSS, PAGES_CSS, SEARCH_CSS, SHELL_CSS, VISITS_CSS };

export const OPAC_CSS_MODULES: readonly string[] = Object.freeze([BASE_CSS, SHELL_CSS, PAGES_CSS, SEARCH_CSS, DETAIL_CSS, VISITS_CSS, AKUN_CSS, HOME_CSS]);

export function joinOpacCss(modules: readonly string[]): string {
  return modules.filter((m) => m !== '').join('\n');
}

export const OPAC_CSS: string = joinOpacCss(OPAC_CSS_MODULES);
