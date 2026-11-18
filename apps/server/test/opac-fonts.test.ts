import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { OPAC_CSS, OPAC_FONTS, OPAC_FONT_FACE_CSS, OPAC_FONT_FAMILY, OPAC_FONT_FILE_NAME, OPAC_FONT_PACKAGE, OPAC_FONT_STACK } from '@altis/opac-theme';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { OPAC_FONT_CSS, OPAC_FONT_CSS_FILE, loadOpacFonts, opacFontsServed, readOpacFonts, setOpacFonts } from '../src/opac/fonts.js';
import { OPAC_CSS_HASH } from '../src/opac/routes.js';
import { recordingLogger } from './support.js';

// The OPAC's typeface: the release ships the font files in public/opac, the server serves them at /assets/<name> and
// names them in its pages only while it holds every one of them intact. Without them the pages name no font URL.

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const IMMUTABLE = 'public, max-age=31536000, immutable';
const BROWSER_ACCEPT = 'text/html,application/xhtml+xml';

/** The font package as the release tool has it installed (this package does not depend on it: a release ships the files). */
const FONT_PACKAGE_DIR = path.dirname(
  createRequire(path.join(REPO_ROOT, 'tools', 'release', 'package.json')).resolve(`${OPAC_FONT_PACKAGE.name}/package.json`),
);

let tmp: string;

beforeAll(async () => {
  tmp = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-opac-fonts-')));
});

afterAll(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

afterEach(() => setOpacFonts(null));

/** A release folder with the font files as the release build writes them. */
async function releaseWithFonts(name: string): Promise<string> {
  const dir = path.join(tmp, name);
  await fsp.mkdir(path.join(dir, 'public', 'opac'), { recursive: true });
  for (const font of OPAC_FONTS) await fsp.copyFile(path.join(FONT_PACKAGE_DIR, font.source), path.join(dir, 'public', 'opac', font.file));
  return dir;
}

/** The app as start() makes it: the release's font files are read first, then the app is made. */
async function setup(releaseDir?: string) {
  const log = recordingLogger();
  await loadOpacFonts(releaseDir, log);
  const app = createApp({
    state: { phase: 'ready' },
    version: '0.1.0',
    buildId: 'b1d0001',
    log,
    ...(releaseDir === undefined ? {} : { release: { dir: releaseDir, previousDir: async () => null } }),
  });
  return { app, log };
}

async function page(app: Awaited<ReturnType<typeof setup>>['app']): Promise<{ html: string; res: Response }> {
  const res = await app.request('/tidak-ada', { headers: { Accept: BROWSER_ACCEPT } });
  expect(res.status).toBe(404);
  return { html: await res.text(), res };
}

const latin = OPAC_FONTS.find((f) => f.subset === 'latin')!;
const latinExt = OPAC_FONTS.find((f) => f.subset === 'latin-ext')!;

describe('the theme', () => {
  it('all OPAC text is set in Plus Jakarta Sans, then the system sans-serif', () => {
    expect(OPAC_FONT_STACK).toBe('"Plus Jakarta Sans Variable",ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans",sans-serif');
    expect(OPAC_CSS).toContain(`--font:${OPAC_FONT_STACK};`);
    expect(OPAC_CSS).toMatch(/body\{[^}]*font:1rem\/1\.55 var\(--font\)/);
  });

  it('two font files, upright latin and latin-ext, each named by its digest; only latin is preloaded', () => {
    expect(OPAC_FONTS.map((f) => f.subset).sort()).toEqual(['latin', 'latin-ext']);
    for (const font of OPAC_FONTS) {
      expect(font.file).toBe(`plus-jakarta-sans-${font.subset}-${font.sha256.slice(0, 10)}.woff2`);
      expect(font.file).toMatch(OPAC_FONT_FILE_NAME);
      expect(font.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(font.source).toBe(`files/plus-jakarta-sans-${font.subset}-wght-normal.woff2`);
    }
    expect(OPAC_FONTS.filter((f) => f.preload)).toEqual([latin]);
  });

  it('the @font-face rules: the family, weights 200-800, swap, a relative URL per file with its unicode-range; kept out of OPAC_CSS', () => {
    const rules = OPAC_FONT_FACE_CSS.split('\n');
    expect(rules).toHaveLength(OPAC_FONTS.length);
    for (const [i, font] of OPAC_FONTS.entries()) {
      expect(rules[i]).toBe(
        `@font-face{font-family:"${OPAC_FONT_FAMILY}";font-style:normal;font-display:swap;font-weight:200 800;` +
          `src:url(${font.file}) format("woff2-variations");unicode-range:${font.unicodeRange}}`,
      );
    }
    expect(OPAC_FONT_FACE_CSS).not.toMatch(/https?:|@import/i);
    expect(OPAC_CSS).not.toContain('@font-face');
    expect(OPAC_FONT_CSS).toBe(`${OPAC_FONT_FACE_CSS}\n${OPAC_CSS}`);
    expect(OPAC_FONT_CSS_FILE).toBe(`opac-${createHash('sha256').update(OPAC_FONT_CSS, 'utf8').digest('hex').slice(0, 10)}.css`);
    expect(OPAC_FONT_CSS_FILE).not.toBe(`opac-${OPAC_CSS_HASH}.css`);
  });
});

describe('an app without a release directory', () => {
  it('serves no font: the pages link the plain stylesheet and name no font file; the font URLs are 404', async () => {
    const { app, log } = await setup();
    expect(opacFontsServed()).toBe(false);
    const { html } = await page(app);
    expect(html).toContain(`<link rel="stylesheet" href="/assets/opac-${OPAC_CSS_HASH}.css"`);
    expect(html).not.toMatch(/rel="preload"/);
    expect(html).not.toMatch(/woff2/);
    expect(html).not.toContain(OPAC_FONT_CSS_FILE);
    for (const file of [...OPAC_FONTS.map((f) => f.file), OPAC_FONT_CSS_FILE]) {
      expect((await app.request(`/assets/${file}`)).status, file).toBe(404);
    }
    const css = await (await app.request(`/assets/opac-${OPAC_CSS_HASH}.css`)).text();
    expect(css).toBe(OPAC_CSS);
    expect(css).not.toMatch(/url\(/);
    expect(log.lines.filter((e) => e.level === 'warn')).toEqual([]);
  });
});

describe('an app run from a release with the font files', () => {
  it('GET /assets/<font>: 200, font/woff2, immutable, the very bytes; no database needed', async () => {
    const { app, log } = await setup(await releaseWithFonts('ok'));
    expect(opacFontsServed()).toBe(true);
    for (const font of OPAC_FONTS) {
      const res = await app.request(`/assets/${font.file}`);
      expect(res.status, font.file).toBe(200);
      expect(res.headers.get('content-type')).toBe('font/woff2');
      expect(res.headers.get('cache-control')).toBe(IMMUTABLE);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      const body = Buffer.from(await res.arrayBuffer());
      expect(createHash('sha256').update(body).digest('hex')).toBe(font.sha256);
      expect(body.subarray(0, 4).toString('latin1')).toBe('wOF2');
    }
    expect(log.lines.filter((e) => e.level === 'warn')).toEqual([]);
  });

  it('the pages link the stylesheet with the @font-face rules and preload the latin subset only, with crossorigin', async () => {
    const { app } = await setup(await releaseWithFonts('ok-page'));
    const { html, res } = await page(app);
    expect(html).toContain(`<link rel="stylesheet" href="/assets/${OPAC_FONT_CSS_FILE}"`);
    expect(html).not.toContain(`opac-${OPAC_CSS_HASH}.css`);
    const preloads = [...html.matchAll(/<link rel="preload"[^>]*>/g)].map((m) => m[0]);
    expect(preloads).toEqual([`<link rel="preload" as="font" type="font/woff2" href="/assets/${latin.file}" crossorigin="anonymous"/>`]);
    expect(html).not.toContain(latinExt.file);
    // The preload comes before the stylesheet; nothing inline was added for the font.
    expect(html.indexOf('rel="preload"')).toBeLessThan(html.indexOf('rel="stylesheet"'));
    expect(html).not.toMatch(/<style/i);
    // The policy is as strict as before: no font-src of its own, so fonts fall under default-src 'self'.
    const policy = res.headers.get('content-security-policy')!;
    expect(policy).toMatch(/^default-src 'self'; /);
    expect(policy).not.toMatch(/font-src/);

    const css = await app.request(`/assets/${OPAC_FONT_CSS_FILE}`);
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8');
    expect(css.headers.get('cache-control')).toBe(IMMUTABLE);
    const text = await css.text();
    expect(text).toBe(OPAC_FONT_CSS);
    // Every URL of the stylesheet is a font file this app answers.
    const urls = [...text.matchAll(/url\(([^)]+)\)/g)].map((m) => m[1]!);
    expect(urls.sort()).toEqual(OPAC_FONTS.map((f) => f.file).sort());
    for (const url of urls) expect((await app.request(new URL(url, `http://x/assets/${OPAC_FONT_CSS_FILE}`).pathname)).status).toBe(200);
    // The plain stylesheet stays an answer (a tab loaded before the update).
    expect((await app.request(`/assets/opac-${OPAC_CSS_HASH}.css`)).status).toBe(200);
  });

  it.each(['plus-jakarta-sans-latin-0123456789.woff2', `${latin.file}.map`, latin.file.toUpperCase(), `..%2F${latin.file}`, 'plus-jakarta-sans-latin.woff2'])(
    '/assets/%s: 404',
    async (file) => {
      const { app } = await setup(await releaseWithFonts('ok-404'));
      expect((await app.request(`/assets/${file}`)).status).toBe(404);
    },
  );
});

describe('a release whose font files are not the recorded ones', () => {
  it('an altered file, a missing file or a link out of public/opac: no font is served, a warning is logged, the pages use the system font', async () => {
    const altered = await releaseWithFonts('altered');
    await fsp.appendFile(path.join(altered, 'public', 'opac', latinExt.file), 'x');
    const missing = await releaseWithFonts('missing');
    await fsp.rm(path.join(missing, 'public', 'opac', latin.file));
    const linked = await releaseWithFonts('linked');
    await fsp.rename(path.join(linked, 'public', 'opac', latin.file), path.join(linked, latin.file));
    await fsp.symlink(path.join(linked, latin.file), path.join(linked, 'public', 'opac', latin.file));
    const empty = path.join(tmp, 'empty');
    await fsp.mkdir(empty);

    for (const dir of [altered, missing, linked, empty]) {
      expect(await readOpacFonts(dir), dir).toBeNull();
      setOpacFonts(await readOpacFonts(await releaseWithFonts('before'))); // whatever was served before
      const { app, log } = await setup(dir);
      expect(opacFontsServed()).toBe(false);
      expect(log.lines.filter((e) => e.level === 'warn').map((e) => e.msg)).toEqual([
        'opac: the font files of the release are missing or altered; the OPAC uses the system font',
      ]);
      const { html } = await page(app);
      expect(html).toContain(`<link rel="stylesheet" href="/assets/opac-${OPAC_CSS_HASH}.css"`);
      expect(html).not.toMatch(/woff2|rel="preload"/);
      for (const file of [...OPAC_FONTS.map((f) => f.file), OPAC_FONT_CSS_FILE]) expect((await app.request(`/assets/${file}`)).status).toBe(404);
    }
  });

  it('no directory, no such directory, no list: none', async () => {
    expect(await readOpacFonts(undefined)).toBeNull();
    expect(await readOpacFonts(path.join(tmp, 'nowhere'))).toBeNull();
    expect(await readOpacFonts(tmp, [])).toBeNull();
    expect(await loadOpacFonts(path.join(tmp, 'nowhere'))).toBe(false);
  });

  it('createApp alone reads no font file: only a started server serves them', async () => {
    const dir = await releaseWithFonts('not-loaded');
    const app = createApp({ state: { phase: 'ready' }, version: '0.1.0', buildId: 'b1d0001', log: recordingLogger(), release: { dir, previousDir: async () => null } });
    expect(opacFontsServed()).toBe(false);
    expect((await app.request(`/assets/${latin.file}`)).status).toBe(404);
  });
});
