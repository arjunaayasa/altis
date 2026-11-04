import fsp from 'node:fs/promises';
import path from 'node:path';
import type { BundledPackage } from './checks.js';

// THIRD_PARTY_NOTICES.txt (spec §4.3, §7.10): the licence texts of every package bundled into app.js, server.mjs and
// the admin SPA (its JavaScript and its stylesheet), reproduced as they are, from each package's
// LICENSE*/LICENCE*/NOTICE* files. A package that ships none falls back
// to the licence section of its README (some small packages keep the text there), but only when that section holds
// real licence text: a bare "MIT" would leave the zip without the copyright and permission notice the licence
// requires (see `isLicenseText`). A package with no licence text at all fails the build (`LICENSE_TEXT_MISSING`),
// unless it is one of COMPOSED_LICENSES: a package reviewed by hand whose npm package carries no licence text anywhere
// (only a licence name in package.json and the README); its notice is the standard text of that licence with the
// package's author, kept under tools/release/licenses/, for that exact name, version and declared licence only.
// Sorted by name and version, LF line endings: reproducible.
//
// Third-party sources and data copied (or adapted) into this repository (not installed as packages, so the bundle
// metafile does not name them) carry their notice through VENDORED_NOTICES: each one's licence file, kept next to the
// copy, is appended after the packages. A missing or empty licence file fails the build the same way.

/** A third-party source or data file copied (or adapted) into this repository and bundled, and its licence file. */
export interface VendoredNotice {
  /** What was copied, as the notices name it. */
  name: string;
  /** Where it was copied or adapted from (a pinned commit, when there is one, is recorded next to the copy). */
  source: string;
  /** SPDX licence identifier. */
  license: string;
  /** The licence text, relative to the repository root. */
  file: string;
}

/** Every vendored source and data file of ALTIS (Global Constraints: "Licences"). */
export const VENDORED_NOTICES: readonly VendoredNotice[] = Object.freeze([
  Object.freeze({
    name: 'SecLists Passwords/Common-Credentials/10k-most-common.txt (packages/core/data/common-passwords.txt)',
    source: 'https://github.com/danielmiessler/SecLists',
    license: 'MIT',
    file: 'packages/core/data/LICENSE-SecLists.txt',
  }),
  // The admin UI primitives are adapted from shadcn/ui's new-york-v4 components by ALTIS (Ruling R1b-2): derived
  // work, no pinned upstream commit (apps/admin/src/components/ui/README.md).
  Object.freeze({
    name: 'shadcn/ui components (apps/admin/src/components/ui)',
    source: 'https://github.com/shadcn-ui/ui',
    license: 'MIT',
    file: 'apps/admin/src/components/ui/LICENSE-shadcn-ui.txt',
  }),
]);

/**
 * A bundled package that ships no licence text (no LICENSE/NOTICE file, a README that only names the licence), and
 * the notice ALTIS ships for it: the standard text of the licence its package.json declares, with its author as the
 * copyright holder. Pinned to the exact version that was reviewed: another version, or another declared licence,
 * fails LICENSE_TEXT_MISSING again.
 */
export interface ComposedLicense {
  name: string;
  version: string;
  /** The SPDX identifier of the package's package.json `license`, which the text below is the standard text of. */
  license: string;
  /** The notice, relative to the repository root. */
  file: string;
}

export const COMPOSED_LICENSES: readonly ComposedLicense[] = Object.freeze([
  // Radix's dialogs lock the page scroll through react-remove-scroll, which needs it (the admin SPA, Task 27).
  Object.freeze({
    name: 'react-remove-scroll-bar',
    version: '2.3.8',
    license: 'MIT',
    file: 'tools/release/licenses/react-remove-scroll-bar-2.3.8.txt',
  }),
  // The QR code of 2FA enrolment (the admin SPA, Task 28); the copyright line is its source header's.
  Object.freeze({
    name: 'qrcode-generator',
    version: '2.0.4',
    license: 'MIT',
    file: 'tools/release/licenses/qrcode-generator-2.0.4.txt',
  }),
]);

const COMPOSED_SOURCE = 'tidak ada berkas lisensi di paket / the package ships no licence file';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

export interface NoticePackage {
  name: string;
  version: string;
  license: string | undefined;
  /** The files the text was taken from (`README.md` when it came from the README's licence section). */
  files: string[];
}

export interface Notices {
  text: string;
  packages: NoticePackage[];
}

const LICENSE_FILE = /^(licen[cs]e|notice)/i;
const README_FILE = /^readme(\.(md|markdown|txt))?$/i;
const RULE = '='.repeat(80);
const THIN_RULE = '-'.repeat(80);

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const normalize = (text: string): string => `${text.replace(/\r\n?/g, '\n').replace(/\s+$/, '')}\n`;

/** The licence section of a Markdown README: from a `# License` heading (any level) to the next heading at its level. */
function readmeLicenseSection(readme: string): string | undefined {
  const lines = readme.replace(/\r\n?/g, '\n').split('\n');
  const start = lines.findIndex((line) => /^#{1,6}\s*licen[cs]e\b/i.test(line));
  if (start === -1) return undefined;
  const level = /^#+/.exec(lines[start]!)![0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const heading = /^(#{1,6})\s/.exec(lines[i]!);
    if (heading !== null && heading[1]!.length <= level) {
      end = i;
      break;
    }
  }
  const body = lines.slice(start + 1, end).join('\n').trim();
  return body === '' ? undefined : body;
}

/** A README licence section shorter than this, without the words below, is a name or a link, not a licence text. */
const MIN_LICENSE_SECTION_CHARS = 200;

/**
 * Whether a README licence section is a real licence text: at least 200 characters, or the permission grant ("Permission
 * is hereby granted", the MIT/ISC/BSD wording) or a "Copyright" line. A section that only says "MIT" or "see LICENSE"
 * is not: reproducing it would silently drop the notice the licence requires.
 */
export function isLicenseText(section: string): boolean {
  return section.trim().length >= MIN_LICENSE_SECTION_CHARS || /permission is hereby granted|copyright/i.test(section);
}

async function regularFiles(dir: string): Promise<string[]> {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  return entries.filter((e) => e.isFile()).map((e) => e.name).sort(byText);
}

/**
 * The licence texts of one package, and the files they came from (a composed text: its path from the repository root).
 *
 * @throws Error `LICENSE_TEXT_MISSING:<pkg>`
 */
async function licenseTexts(
  pkg: BundledPackage,
  composed: readonly ComposedLicense[],
  root: string,
): Promise<{ files: string[]; texts: string[]; composed?: true }> {
  const names = await regularFiles(pkg.dir);
  const files = names.filter((name) => LICENSE_FILE.test(name));
  if (files.length > 0) {
    const texts = await Promise.all(files.map(async (file) => normalize(await fsp.readFile(path.join(pkg.dir, file), 'utf8'))));
    if (texts.some((text) => text.trim() !== '')) return { files, texts };
  }
  let thin = false;
  for (const readme of names.filter((name) => README_FILE.test(name))) {
    const section = readmeLicenseSection(await fsp.readFile(path.join(pkg.dir, readme), 'utf8'));
    if (section === undefined) continue;
    if (isLicenseText(section)) return { files: [readme], texts: [normalize(section)] };
    thin = true;
  }
  const reviewed = composed.find((c) => c.name === pkg.name && c.version === pkg.version && c.license === pkg.license);
  if (reviewed !== undefined) {
    let text: string;
    try {
      text = await fsp.readFile(path.join(root, reviewed.file), 'utf8');
    } catch (error) {
      throw new Error(`LICENSE_TEXT_MISSING:${pkg.name} (${pkg.version}: composed text ${reviewed.file} cannot be read)`, { cause: error });
    }
    if (text.trim() !== '') return { files: [reviewed.file], texts: [normalize(text)], composed: true };
  }
  const why = thin ? 'the licence section of its README holds no licence text (no copyright or permission notice)' : 'no LICENSE/NOTICE file and no licence section in a README';
  throw new Error(`LICENSE_TEXT_MISSING:${pkg.name} (${pkg.version}: ${why})`);
}

/** The licence text of a vendored copy. @throws Error `LICENSE_TEXT_MISSING:<name>` when its file is missing or empty */
async function vendoredText(v: VendoredNotice, root: string): Promise<string> {
  let text: string;
  try {
    text = await fsp.readFile(path.join(root, v.file), 'utf8');
  } catch (error) {
    throw new Error(`LICENSE_TEXT_MISSING:${v.name} (vendored: ${v.file} cannot be read)`, { cause: error });
  }
  if (text.trim() === '') throw new Error(`LICENSE_TEXT_MISSING:${v.name} (vendored: ${v.file} is empty)`);
  return normalize(text);
}

export interface CollectNoticesOptions {
  /** The ALTIS version the notices ship with. */
  version: string;
  /** The vendored copies to append (default {@link VENDORED_NOTICES}). */
  vendored?: readonly VendoredNotice[];
  /** The reviewed texts of packages that ship none (default {@link COMPOSED_LICENSES}). */
  composed?: readonly ComposedLicense[];
  /** The directory their `file`s are relative to (default: the repository root). */
  root?: string;
}

/**
 * THIRD_PARTY_NOTICES.txt for `packages` (one entry per name and version), followed by the vendored copies
 * ({@link VENDORED_NOTICES}), shipped with ALTIS `o.version`.
 *
 * @throws Error `LICENSE_TEXT_MISSING:<pkg>` for a package without any licence text, or a vendored copy whose licence
 *   file is missing or empty
 */
export async function collectNotices(packages: readonly BundledPackage[], o: CollectNoticesOptions): Promise<Notices> {
  const vendored = o.vendored ?? VENDORED_NOTICES;
  const composed = o.composed ?? COMPOSED_LICENSES;
  const root = o.root ?? REPO_ROOT;
  const unique = new Map<string, BundledPackage>();
  for (const pkg of [...packages].sort((a, b) => byText(a.name, b.name) || byText(a.version, b.version) || byText(a.dir, b.dir))) {
    const key = `${pkg.name}@${pkg.version}`;
    if (!unique.has(key)) unique.set(key, pkg);
  }

  const sections: string[] = [];
  const listed: NoticePackage[] = [];
  for (const pkg of unique.values()) {
    const { files, texts, composed: fromComposed } = await licenseTexts(pkg, composed, root);
    const fromReadme = fromComposed !== true && files.length === 1 && README_FILE.test(files[0]!);
    listed.push({ name: pkg.name, version: pkg.version, license: pkg.license, files });
    sections.push(
      [
        RULE,
        `${pkg.name} ${pkg.version}`,
        `Lisensi / License: ${pkg.license ?? '-'}`,
        `Sumber / Source: ${
          fromReadme ? `${files[0]!} (bagian lisensi / licence section)` : fromComposed ? `${files[0]!} (${COMPOSED_SOURCE})` : files.join(', ')
        }`,
        THIN_RULE,
        texts.join(`\n${THIN_RULE}\n`).replace(/\n$/, ''),
        '',
      ].join('\n'),
    );
  }

  const copies = [...vendored].sort((a, b) => byText(a.name, b.name) || byText(a.file, b.file));
  for (const v of copies) {
    const text = await vendoredText(v, root);
    sections.push(
      [
        RULE,
        v.name,
        `Lisensi / License: ${v.license}`,
        `Sumber / Source: ${v.source} (${v.file})`,
        THIN_RULE,
        text.replace(/\n$/, ''),
        '',
      ].join('\n'),
    );
  }

  const header = [
    `ALTIS ${o.version}: pemberitahuan pihak ketiga / third-party notices`,
    '',
    'Paket sumber terbuka berikut dibundel ke dalam app.js, server.mjs, dan antarmuka admin (public/admin); teks',
    'lisensinya disalin apa adanya di bawah.',
    'The following open-source packages are bundled into app.js, server.mjs and the admin interface (public/admin);',
    'their licence texts are reproduced below as they are.',
    '',
    ...listed.map((p) => `  ${p.name} ${p.version} (${p.license ?? '-'})`),
    '',
    ...(copies.length === 0
      ? []
      : [
          'Kode dan data pihak ketiga berikut disalin ke dalam sumber ALTIS lalu ikut dibundel:',
          'The following third-party code and data are copied into the ALTIS sources and bundled with them:',
          '',
          ...copies.map((v) => `  ${v.name} (${v.license})`),
          '',
        ]),
  ].join('\n');
  return { text: `${[header, ...sections].join('\n')}`, packages: listed };
}
