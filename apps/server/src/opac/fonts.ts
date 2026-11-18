import { createHash } from 'node:crypto';
import { sha256hex } from '@altis/core';
import { OPAC_CSS, OPAC_FONTS, OPAC_FONT_FACE_CSS, OPAC_FONT_FILE_NAME, type OpacFont } from '@altis/opac-theme';
import { readReleaseFile } from '@altis/platform';
import type { Logger } from '../logger.js';
import { loggableError } from '../safe-error.js';

// The OPAC's font files and the stylesheet that goes with them.
//
// The release ships the font files of @altis/opac-theme (OPAC_FONTS) in `<release>/public/opac/`. They are read once,
// when the server starts (start() calls loadOpacFonts before it makes the app), and kept in memory like the
// stylesheet: two files, about 50 kB together. A file counts only when it is a regular file inside the release's
// `public/` whose SHA-256 is the recorded one, and the fonts count only when every one of them does. Then, and only
// then:
//
// - `/assets/<file>` answers each font file (opac.assets), and
// - the pages link the stylesheet that begins with the `@font-face` rules (OPAC_FONT_CSS_FILE) and preload the `latin`
//   subset (layout.tsx).
//
// Without them (an app made by createApp alone, as in most tests, or a release folder that lost a file) the
// pages link the plain stylesheet, name no font URL anywhere, and the text is set in the system's sans-serif.
//
// This is state of the module, not of the app's services: the page frame is rendered by plain functions from many
// places (the 404 and 500 pages among them) that are handed no services. One process serves one release.

/** The OPAC stylesheet with the `@font-face` rules in front of it. */
export const OPAC_FONT_CSS: string = `${OPAC_FONT_FACE_CSS}\n${OPAC_CSS}`;

/** The file name it is served under: `opac-<first 10 hex digits of its SHA-256>.css`. */
export const OPAC_FONT_CSS_FILE = `opac-${sha256hex(OPAC_FONT_CSS).slice(0, 10)}.css`;

/** The `Content-Type` of a font file. */
export const FONT_TYPE = 'font/woff2';

export type OpacFontFiles = ReadonlyMap<string, Buffer<ArrayBuffer>>;

/**
 * The font files of the release in `releaseDir` by served name, or null unless every one of `fonts` is there and
 * intact: a regular file inside the release's `public/` (readReleaseFile) whose SHA-256 is the recorded one. An
 * undefined `releaseDir`: null.
 *
 * @throws the I/O error for a failure other than a missing file (EACCES, EIO, ...)
 */
export async function readOpacFonts(releaseDir: string | undefined, fonts: readonly OpacFont[] = OPAC_FONTS): Promise<OpacFontFiles | null> {
  if (releaseDir === undefined || fonts.length === 0) return null;
  const files = new Map<string, Buffer<ArrayBuffer>>();
  for (const font of fonts) {
    if (!OPAC_FONT_FILE_NAME.test(font.file)) return null;
    const bytes = await readReleaseFile(releaseDir, 'opac-font', font.file);
    if (bytes === null || createHash('sha256').update(bytes).digest('hex') !== font.sha256) return null;
    files.set(font.file, bytes);
  }
  return files;
}

let served: OpacFontFiles | null = null;

/**
 * Reads the font files of the release the server runs from and makes them the ones this process serves; without a
 * release directory, with a file missing or altered, or when they cannot be read, none are served. Never rejects: a
 * server without its fonts still serves every page.
 *
 * @returns whether the fonts are served
 */
export async function loadOpacFonts(releaseDir: string | undefined, log?: Logger): Promise<boolean> {
  try {
    served = await readOpacFonts(releaseDir);
    if (served === null && releaseDir !== undefined) {
      log?.warn('opac: the font files of the release are missing or altered; the OPAC uses the system font', { dir: releaseDir });
    }
  } catch (error) {
    served = null;
    log?.warn('opac: the font files of the release cannot be read; the OPAC uses the system font', { dir: releaseDir, err: loggableError(error) });
  }
  return served !== null;
}

/** Test seam: serve `files` (null: none). */
export function setOpacFonts(files: OpacFontFiles | null): void {
  served = files;
}

/** Whether the font files are served: the pages name them only then. */
export function opacFontsServed(): boolean {
  return served !== null;
}

/** The bytes of the served font file `name`, or null. */
export function opacFontFile(name: string): Buffer<ArrayBuffer> | null {
  return served?.get(name) ?? null;
}

/** The stylesheet the pages link now: its file name under `/assets/`. */
export function opacStylesheetFile(plain: string): string {
  return served === null ? plain : OPAC_FONT_CSS_FILE;
}

/** The fonts the pages preload now: their file names under `/assets/` (none while no font is served). */
export function opacFontPreloads(): string[] {
  return served === null ? [] : OPAC_FONTS.filter((f) => f.preload).map((f) => f.file);
}
