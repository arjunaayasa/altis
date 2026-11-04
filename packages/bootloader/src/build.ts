import { readFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isTrustedKey, type TrustedKey } from '@altis/crypto';
import { isSemver } from '@altis/shared';
import { build, type Metafile } from 'esbuild';

// Builds app.js (spec §9.2, P1): one CommonJS file, ES2017 syntax, everything bundled (no dependency at run time).
//
//   tsx src/build.ts [--profile test|production] [--version <bundled version>] [--root-keys <file>] [--out <file>]
//
// Without --out, a test build goes to dist/app.test.js and a production build to dist/app.js: a build that embeds the
// dev keys and keeps the test hooks can never be taken for the production app.js (a test build is refused there).
//
// Defines:
// - __BUILD_PROFILE__: 'test' keeps the ALTIS_TEST_* hooks; 'production' compiles them out (ruling R57).
// - __TRUSTED_KEYS__: the trust anchors of app.js (spec §8.3, ruling R65): `root` public keys only. Every other key
//   reaches app.js through root-signed keyset documents (DATA_DIR/releases/keyset.json and the release's own
//   keyset.json). Test builds embed the dev root key (tools/keys/dev/roots.json, test only). Production builds embed
//   the root key set given with --root-keys / `rootKeys` (the public halves of the offline `root-*` keys: active +
//   offline spare, at least two, ruling R65e); a `dev-` kid is refused, and so is any key of another use. A test build
//   embeds `dev-` roots only (NON_DEV_KEY_IN_TEST_BUILD).
// - __BUNDLED_VERSION__: the version of the release shipped in `bundled-release/<version>` next to app.js.

export type BuildProfile = 'test' | 'production';

export interface BuildBootloaderOptions {
  profile: BuildProfile;
  outfile: string;
  /** The version of the release in `bundled-release/<version>`; SemVer. */
  bundledVersion: string;
  /** The root public keys to embed. Required for `production`. Default for `test`: tools/keys/dev/roots.json. */
  rootKeys?: TrustedKey[];
  /**
   * Where to write app.js's source map (the release build keeps it private, never next to app.js). Default: none.
   * app.js never carries a sourceMappingURL comment.
   */
  sourcemapFile?: string;
}

export interface BuildBootloaderResult {
  outfile: string;
  bytes: number;
  /** The keys embedded as __TRUSTED_KEYS__: the root keys. */
  trustedKeys: TrustedKey[];
  /** esbuild's metafile; input paths are relative to the repository root (licence and native-module checks). */
  metafile: Metafile;
}

const PACKAGE_DIR = path.resolve(import.meta.dirname, '..');
const REPO_ROOT = path.resolve(PACKAGE_DIR, '..', '..');
const ENTRY = path.join(PACKAGE_DIR, 'src', 'main.ts');
const DEV_KEYS_DIR = path.resolve(PACKAGE_DIR, '..', '..', 'tools', 'keys', 'dev');
/** Every public dev key (the leak check of a production build looks for each one). */
const DEV_TRUSTED = path.join(DEV_KEYS_DIR, 'trusted.json');
/** The dev trust anchors: what a test build embeds. */
const DEV_ROOTS = path.join(DEV_KEYS_DIR, 'roots.json');
/** Where `pnpm --filter @altis/bootloader build` writes app.js without --out: dist/app.test.js or dist/app.js. */
export function defaultOutfile(profile: BuildProfile): string {
  return path.join(PACKAGE_DIR, 'dist', profile === 'production' ? 'app.js' : 'app.test.js');
}
/** The bundled release of a test build unless told otherwise (spec §12.5). */
export const DEFAULT_TEST_VERSION = '0.1.0-test';
const DEV_KID_PREFIX = 'dev-';

function readKeyList(file: string): TrustedKey[] {
  const keys = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  if (!Array.isArray(keys) || !keys.every(isTrustedKey)) throw new Error(`${file} is not a list of trusted keys`);
  return keys;
}

/** The dev root keys (tools/keys/dev/roots.json, test only): the trust anchors of a test build. */
export function devRootKeys(): TrustedKey[] {
  return readKeyList(DEV_ROOTS);
}

/** Every public dev key (tools/keys/dev/trusted.json, test only). */
function devPublicKeys(): TrustedKey[] {
  return readKeyList(DEV_TRUSTED);
}

function checkedKeys(o: BuildBootloaderOptions): TrustedKey[] {
  const keys = o.rootKeys ?? (o.profile === 'test' ? devRootKeys() : undefined);
  if (keys === undefined || keys.length === 0) {
    throw new Error('ROOT_KEYS_REQUIRED: a production build needs the root key set (--root-keys)');
  }
  const kids = new Set<string>();
  const pubs = new Set<string>();
  for (const key of keys) {
    if (!isTrustedKey(key) || key.use !== 'root' || kids.has(key.kid) || pubs.has(key.pub)) {
      throw new Error(`ROOT_KEYS_INVALID: every key must be a distinct {kid, use: 'root', pub} (${JSON.stringify(key)})`);
    }
    kids.add(key.kid);
    pubs.add(key.pub);
    if (o.profile === 'production' && key.kid.startsWith(DEV_KID_PREFIX)) {
      throw new Error(`DEV_KEY_IN_PRODUCTION: ${key.kid}`);
    }
    if (o.profile === 'test' && !key.kid.startsWith(DEV_KID_PREFIX)) {
      throw new Error(`NON_DEV_KEY_IN_TEST_BUILD: ${key.kid} (a test build keeps the test hooks; it only ever embeds dev- roots)`);
    }
  }
  // Ruling R65e: the roots are frozen into app.js, so a production build embeds an active root and an offline spare.
  if (o.profile === 'production' && keys.length < 2) {
    throw new Error('ROOT_KEYS_INVALID: a production build embeds at least two root keys (active + offline spare)');
  }
  return keys.map((key) => ({ kid: key.kid, use: key.use, pub: key.pub }));
}

function checkProfile(profile: string): asserts profile is BuildProfile {
  if (profile !== 'test' && profile !== 'production') throw new Error(`BUILD_PROFILE_INVALID: ${String(profile)}`);
}

/**
 * Builds app.js.
 *
 * @throws Error `BUILD_PROFILE_INVALID`, `TEST_BUILD_AT_PRODUCTION_PATH`, `ROOT_KEYS_REQUIRED`, `ROOT_KEYS_INVALID`,
 *   `DEV_KEY_IN_PRODUCTION`, `NON_DEV_KEY_IN_TEST_BUILD`, `BUNDLED_VERSION_INVALID`, `PRODUCTION_BUILD_LEAK`
 */
export async function buildBootloader(o: BuildBootloaderOptions): Promise<BuildBootloaderResult> {
  checkProfile(o.profile);
  if (o.profile === 'test' && path.resolve(o.outfile) === defaultOutfile('production')) {
    throw new Error(`TEST_BUILD_AT_PRODUCTION_PATH: a test build is never written to ${defaultOutfile('production')}`);
  }
  if (!isSemver(o.bundledVersion)) throw new Error(`BUNDLED_VERSION_INVALID: ${JSON.stringify(o.bundledVersion)}`);
  const trustedKeys = checkedKeys(o);

  await fsp.mkdir(path.dirname(o.outfile), { recursive: true });
  const result = await build({
    absWorkingDir: REPO_ROOT,
    entryPoints: [ENTRY],
    outfile: o.outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'es2017',
    minify: true,
    legalComments: 'none',
    logLevel: 'silent',
    metafile: true,
    // 'external': the map is written next to app.js without a sourceMappingURL comment, then moved to sourcemapFile.
    sourcemap: o.sourcemapFile === undefined ? false : 'external',
    define: {
      __BUILD_PROFILE__: JSON.stringify(o.profile),
      __TRUSTED_KEYS__: JSON.stringify(trustedKeys),
      __BUNDLED_VERSION__: JSON.stringify(o.bundledVersion),
    },
    banner: { js: `/* ALTIS app.js (bootloader v1, ${o.profile}) */` },
  });

  const text = await fsp.readFile(o.outfile, 'utf8');
  const writtenMap = `${o.outfile}.map`;
  if (o.profile === 'production') {
    // Belt and braces (ruling R57): nothing of the test profile may survive in a production build.
    const leaks = ['ALTIS_TEST_', ...devPublicKeys().flatMap((key) => [key.kid, key.pub])].filter((needle) => text.includes(needle));
    if (leaks.length > 0) {
      await fsp.rm(o.outfile, { force: true });
      await fsp.rm(writtenMap, { force: true });
      throw new Error(`PRODUCTION_BUILD_LEAK: ${leaks.join(', ')}`);
    }
  }
  if (o.sourcemapFile !== undefined && path.resolve(o.sourcemapFile) !== path.resolve(writtenMap)) {
    await fsp.mkdir(path.dirname(o.sourcemapFile), { recursive: true });
    await fsp.copyFile(writtenMap, o.sourcemapFile);
    await fsp.rm(writtenMap, { force: true });
  }
  return { outfile: o.outfile, bytes: Buffer.byteLength(text), trustedKeys, metafile: result.metafile };
}

function option(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  if (at === -1) return undefined;
  const value = args[at + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`);
  return value;
}

/** The options of the build command (see the top of this file). @throws Error `BUILD_PROFILE_INVALID` */
export async function parseBuildArgs(args: string[]): Promise<BuildBootloaderOptions> {
  const profile = option(args, '--profile') ?? 'test';
  checkProfile(profile);
  const keysFile = option(args, '--root-keys');
  const rootKeys = keysFile === undefined ? undefined : (JSON.parse(await fsp.readFile(keysFile, 'utf8')) as TrustedKey[]);
  return {
    profile,
    outfile: path.resolve(option(args, '--out') ?? defaultOutfile(profile)),
    bundledVersion: option(args, '--version') ?? (profile === 'test' ? DEFAULT_TEST_VERSION : ''),
    ...(rootKeys === undefined ? {} : { rootKeys }),
  };
}

async function cli(args: string[]): Promise<void> {
  const options = await parseBuildArgs(args);
  const result = await buildBootloader(options);
  process.stdout.write(
    `app.js (${options.profile}) → ${result.outfile}: ${result.bytes} bytes, root keys ${result.trustedKeys.map((k) => k.kid).join(', ')}\n`,
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  cli(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
