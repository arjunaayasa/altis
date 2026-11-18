// The OPAC's typeface: Plus Jakarta Sans (variable, weights 200-800, SIL Open Font License 1.1), self-hosted.
//
// Only the upright `latin` and `latin-ext` subsets are served. The font files are not part of this package (it stays a
// set of strings): the release build copies them out of the pinned npm package into the release's `public/opac/`
// folder under the names below, and the server serves them from there at `/assets/<file>`. A file's name carries the
// first 10 hex digits of its SHA-256, so it can be cached for good; the full digest is checked by the release build
// (a different file fails the build) and again by the server before it serves a byte.
//
// The `@font-face` rules are a stylesheet of their own (OPAC_FONT_FACE_CSS), which the server puts in front of the
// OPAC stylesheet only when it holds the font files. Without them the pages name no font URL at all and the text falls
// through OPAC_FONT_STACK to the system's sans-serif.

/** The npm package the font files come from, at the one version whose digests are recorded below. */
export const OPAC_FONT_PACKAGE = Object.freeze({ name: '@fontsource-variable/plus-jakarta-sans', version: '5.3.0' });

/** The family name of the `@font-face` rules (the package's own). */
export const OPAC_FONT_FAMILY = 'Plus Jakarta Sans Variable';

/** The font stack of all OPAC text. */
export const OPAC_FONT_STACK = `"${OPAC_FONT_FAMILY}",ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans",sans-serif`;

export interface OpacFont {
  subset: 'latin' | 'latin-ext';
  /** The file inside the npm package. */
  source: string;
  /** The SHA-256 of that file, in hex. */
  sha256: string;
  /** The name it is shipped (`public/opac/<file>`) and served (`/assets/<file>`) under. */
  file: string;
  /** The `unicode-range` of the subset, as the package's own stylesheet gives it. */
  unicodeRange: string;
  /** Whether the pages preload it: only the subset nearly every page needs. */
  preload: boolean;
}

function font(subset: OpacFont['subset'], sha256: string, unicodeRange: string, preload: boolean): OpacFont {
  return Object.freeze({
    subset,
    source: `files/plus-jakarta-sans-${subset}-wght-normal.woff2`,
    sha256,
    file: `plus-jakarta-sans-${subset}-${sha256.slice(0, 10)}.woff2`,
    unicodeRange,
    preload,
  });
}

/** The font files of the OPAC, in the order of their `@font-face` rules. */
export const OPAC_FONTS: readonly OpacFont[] = Object.freeze([
  font(
    'latin-ext',
    '38e3b8fd8045048eb311d90170a4429ed2c8f405852dc3d91b5af8452758703f',
    'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF',
    false,
  ),
  font(
    'latin',
    '153fc85b70298beeb1d61a5f723331649e7f23bb77302a66e61cb3e2fbdb5e79',
    'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
    true,
  ),
]);

/** What a served font file is called: `plus-jakarta-sans-<subset>-<10 hex digits>.woff2`. */
export const OPAC_FONT_FILE_NAME = /^plus-jakarta-sans-[a-z]+(-[a-z]+)*-[0-9a-f]{10}\.woff2$/;

/**
 * The `@font-face` rules of {@link OPAC_FONTS}. The URLs are relative: the rules are served from `/assets/`, next to
 * the font files.
 */
export const OPAC_FONT_FACE_CSS: string = OPAC_FONTS.map(
  (f) =>
    `@font-face{font-family:"${OPAC_FONT_FAMILY}";font-style:normal;font-display:swap;font-weight:200 800;` +
    `src:url(${f.file}) format("woff2-variations");unicode-range:${f.unicodeRange}}`,
).join('\n');
