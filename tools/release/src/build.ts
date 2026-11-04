import { execFile, execFileSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { buildBootloader } from '@altis/bootloader';
import {
  COMPLETE_FILE,
  KEYSET_FILE,
  KEYSET_MAX_FILE_BYTES,
  MANIFEST_FILE,
  buildManifest,
  isTrustedKey,
  parseKeysetDocs,
  parseStrictJson,
  resolveTrustedKeys,
  verifyReleaseWithRoots,
  type KeysetDoc,
  type ReleaseManifest,
  type KeysetReport,
  type TrustedKey,
} from '@altis/crypto';
import { MIN_SERVER_VERSIONS, migrationsForLevel, type TestFixtureLevel } from '@altis/db';
import { loadKeyFile, runCli as signCli, type LoadedKeyFile } from '@altis/sign-cli';
import { ADMIN_ASSET_NAME } from '@altis/platform';
import { compareSemver, isSemver } from '@altis/shared';
import { build, type Metafile, type Plugin } from 'esbuild';
import { checkLicenses, checkNativeInputs, checkNoLeaks, checkRuntimeImports, packagesOfInputs, scanRuntimeImports } from './checks.js';
import { collectNotices } from './notices.js';
import { writeZip } from './zip.js';

// The release build (spec §4.3, §9.1; Task 17):
//
//   pnpm release --profile test|production --version <semver> [--out <dir>]
//                [--signing-key <file>] [--root-keys <file>] [--keyset <file>]
//                [--build-id <id>] [--released-at YYYY-MM-DD] [--allow-dirty]
//                [--min-upgrade-from <semver>] [--feed-url <url>]
//
// --profile has no default, and it is bound to the version (VERSION_PROFILE_MISMATCH): a test build's prerelease
// contains `test` (0.1.0-test), a production version's never does, so a dev-signed zip never carries a production
// version.
//
// → <out>/altis-<version>.zip, <out>/build-report.json ({zipBytes, adminBytes, files, notices: {packages}}) and the
//   source maps in <out>/private/sourcemaps/ (not shipped in the zip). Default --out: <repository>/dist. Relative
//   paths are taken from where `pnpm release` was run (INIT_CWD).
//
// The zip:
//   app.js, package.json, ecosystem.config.cjs, THIRD_PARTY_NOTICES.txt, LICENSE, NOTICE (both copied byte for byte
//   from the repository root: AGPL-3.0-only),
//   bundled-release/<version>/{server.mjs, manifest.json, manifest.sig, keyset.json, .complete,
//                              public/THIRD_PARTY_NOTICES.txt, public/admin/index.html, public/admin/install.html,
//                              public/admin/assets/*}
//
// Keys (spec §8.3, Task 17 rulings, ruling R65):
// - test: the dev keys of tools/keys/dev: dev-rel-1 signs, the dev root (roots.json) is embedded, the dev keyset
//   (signed by dev-root-1) is shipped. A test build only signs with a `dev-` key and only embeds `dev-` roots
//   (NON_DEV_KEY_IN_TEST_BUILD otherwise): a build that keeps the ALTIS_TEST_* hooks must never carry a production
//   signature nor trust production keys.
// - production: the three key files come from --signing-key/--root-keys/--keyset or from ALTIS_RELEASE_SIGNING_KEY,
//   ALTIS_RELEASE_ROOT_KEYS, ALTIS_RELEASE_KEYSET; one missing → MISSING_RELEASE_KEY:<variable> (the repository holds
//   no production key: without keys of its own, docs/ops/release-signing.md, a production build fails here). Anything from tools/keys/dev, or any dev kid or
//   public key (the roots included), → DEV_KEY_IN_PRODUCTION; the shipped files are scanned for dev key material and
//   ALTIS_TEST_ and test.branch.manage at the end (PRODUCTION_BUILD_LEAK).
// - The signing key file is `{kid, use: 'release', pkcs8}` (altis-sign keygen). The root keys file is
//   `[{kid, use: 'root', pub}]`, root keys only with distinct kids and public keys, at least two in production (ruling
//   R65e): the public halves of the offline roots (active + spare), which app.js
//   and server.mjs embed as __TRUSTED_KEYS__ (rulings R62, R65). The keyset is a list of `altis-keyset/1` documents
//   signed offline by a root, shipped as keyset.json; every document must count under the roots (KEYSET_INVALID
//   otherwise). The build never needs a root private key. The signer must be a release key that the keyset trusts
//   (SIGNING_KEY_NOT_TRUSTED otherwise), and the bundled release is verified (`check: 'all'`) the way app.js verifies
//   it on a fresh install: verifyReleaseWithRoots with the roots and the shipped keyset.json.
//
// Phase 1d (Task 9):
// - Release fixtures (decision D1d-26, spec §12.5): a test build of 0.1.0-test, 0.2.0-test or 0.3.0-test is fixture
//   level 1, 2 or 3 (fixtureLevelOf; any other test version 1, production 0). server.mjs gets the level as
//   `__TEST_FIXTURE__` (releaseMigrations() then adds 9001_test_expand at 2, 9002_test_contract at 3) and the manifest
//   states the schema of that level (schemaFacts). A production bundle must hold none of the fixture names
//   (PRODUCTION_LEAK_NEEDLES).
// - The feed URL (spec §9.6 "URL feed tertanam saat build", decision D1d-2): `--feed-url`, else (production only)
//   ALTIS_RELEASE_FEED_URL, embedded in server.mjs as `__FEED_URL__` ('' without one). Optional for every profile:
//   without one the installs make no online update check (config.json update.feedUrl and ALTIS_UPDATE_FEED_URL can
//   still name a feed), while an uploaded zip and the bundled re-upload still update them. A URL given must be an
//   http(s) URL without user:password (FEED_URL_INVALID), the rule of config.json's `update.feedUrl`.
// - `--min-upgrade-from` (default 0.0.0): the manifest's minUpgradeFrom, older than the release
//   (MIN_UPGRADE_FROM_INVALID). The update precheck refuses an installation older than it (§9.6).
//
// Bundles:
// - server.mjs: esbuild with the Global Constraints options, metafile, `__BUILD_PROFILE__`, `__TRUSTED_KEYS__`,
//   `__TEST_FIXTURE__` and `__FEED_URL__`.
//   ONE self-contained file (ruling): at run time it may load node built-ins only. Optional requires of bundled
//   packages that ALTIS never ships (ABSENT_MODULES) are replaced by a stub that throws MODULE_NOT_FOUND, exactly what
//   those packages expect when the module is not installed; otherwise Node would look for them in node_modules
//   folders above the release (app folder, DATA_DIR's parents, $HOME) and run whatever it found.
// - app.js: @altis/bootloader's buildBootloader for the release's own profile and keys, into the staging folder: the
//   zip never takes a file left in packages/bootloader/dist (a production zip never holds the test build).
// - The admin SPA (Task 27, decision D31): `pnpm --filter @altis/admin build` with ALTIS_BUILD=<version>,
//   ALTIS_BUILD_PROFILE=<profile> and NODE_ENV=production (a test runner's NODE_ENV would give React's development
//   build), then apps/admin/dist copied to bundled-release/<v>/public/admin/. Only the two pages, index.html (the SPA)
//   and install.html (the install wizard, 1c Task 30), and assets/<name> files the server will serve (ADMIN_ASSET_NAME)
//   may be there, and both pages are required, each with the `__CSP_NONCE__` placeholder the server fills, no inline
//   style and no inline script without that nonce (ADMIN_BUILD_INVALID otherwise, checkAdminPage).
//   apps/admin/.build/inputs.json, written by the build, names what the
//   bundle is made of: it joins the licence and native-module checks and the notices. The notices are also shipped as
//   public/THIRD_PARTY_NOTICES.txt (the same text), which the server serves at /legal/third-party-notices.txt. Two
//   release builds of one checkout must not run at the same time (they share apps/admin/dist).
//
// Reproducible: the manifest's buildId is the git commit and releasedAt its commit date (UTC), so two builds of one
// commit and profile give a byte-identical zip (Ed25519 signatures are deterministic; see zip.ts for the archive).
// A production build refuses a working tree whose tracked files differ from that commit, or whose state git cannot
// tell (DIRTY_TREE): its buildId would name sources it was not built from. `--allow-dirty` (local experiments only)
// builds anyway and stamps the buildId `<commit>-dirty`. Test builds are not checked.

export type ReleaseProfile = 'test' | 'production';

export interface ReleaseKeyFiles {
  /** `<kid>.key.json` of the release key that signs manifest.json. */
  signingKey?: string;
  /** `[{kid, use: 'root', pub}]`: the root public keys embedded in app.js and server.mjs. */
  rootKeys?: string;
  /** The root-signed keyset documents (`[{raw, env}]`) shipped as bundled-release/<v>/keyset.json. */
  keyset?: string;
}

export interface BuildReleaseOptions {
  profile: ReleaseProfile;
  version: string;
  /** Output folder (created when missing). */
  out: string;
  /** Key files; a test build defaults each one to tools/keys/dev. */
  keys?: ReleaseKeyFiles;
  /** Default: the git commit (`git rev-parse HEAD`). */
  buildId?: string;
  /** YYYY-MM-DD. Default: the commit date of HEAD in UTC. */
  releasedAt?: string;
  /** Production: build from a dirty (or unknown) working tree anyway, the buildId stamped `-dirty`. */
  allowDirty?: boolean;
  /** Test seam: the state of the sources. Default: {@link gitSourceState} of this repository. */
  source?: SourceState;
  /** Test seam: more files treated as inputs of the bundles by the licence and native-module checks. */
  extraBundleInputs?: string[];
  /** Test seam: the folder that holds {@link LEGAL_FILES}. Default: the repository root. */
  legalRoot?: string;
  /** The manifest's minUpgradeFrom (`--min-upgrade-from`): older than `version`. Default {@link MIN_UPGRADE_FROM}. */
  minUpgradeFrom?: string;
  /**
   * The update feed base embedded in server.mjs (`--feed-url` / ALTIS_RELEASE_FEED_URL): an http(s) URL without
   * user:password. Optional: a build without one embeds '' (no online update check).
   */
  feedUrl?: string;
}

/** What git says about the sources; `undefined` where it cannot tell (no git, not a checkout). */
export interface SourceState {
  /** HEAD's commit. */
  commit: string | undefined;
  /** HEAD's commit time, in seconds since the epoch. */
  committedAt: number | undefined;
  /** Tracked files differ from HEAD (staged or not); untracked files do not count. */
  dirty: boolean | undefined;
}

export interface BuildReport {
  zipBytes: number;
  /** The bytes of the admin SPA's files (public/admin), uncompressed. */
  adminBytes: number;
  files: { path: string; size: number }[];
  notices: { packages: { name: string; version: string; license: string | null }[] };
}

export interface BuildReleaseResult {
  zipFile: string;
  reportFile: string;
  report: BuildReport;
  manifest: ReleaseManifest;
  /** Module specifiers each bundle loads at run time (node built-ins only). */
  runtimeImports: { server: string[]; app: string[] };
  /** The source maps written under <out>/private/sourcemaps (not shipped in the zip). */
  sourcemaps: string[];
}

const TOOL_DIR = path.resolve(import.meta.dirname, '..');
const REPO_ROOT = path.resolve(TOOL_DIR, '..', '..');
const SERVER_ENTRY = path.join(REPO_ROOT, 'apps', 'server', 'src', 'index.ts');
const DEV_KEYS_DIR = path.join(REPO_ROOT, 'tools', 'keys', 'dev');
const ECOSYSTEM_TEMPLATE = path.join(TOOL_DIR, 'templates', 'ecosystem.config.cjs');
const ADMIN_DIR = path.join(REPO_ROOT, 'apps', 'admin');
const ADMIN_INPUTS = path.join(ADMIN_DIR, '.build', 'inputs.json');

export const DEFAULT_OUT = path.join(REPO_ROOT, 'dist');
/** Budget (global constraints): the zip stays under 15 MB. */
export const ZIP_BUDGET_BYTES = 15_000_000;
/**
 * The licence files of the zip's root, copied byte for byte from the repository root: the AGPL-3.0 text and the
 * copyright notice (AGPL-3.0-only).
 */
export const LEGAL_FILES: readonly string[] = Object.freeze(['LICENSE', 'NOTICE']);
/** The SPDX licence of ALTIS, as the zip's package.json states it. */
export const RELEASE_LICENSE = 'AGPL-3.0-only';
/** The oldest Node.js a release runs on (global constraints). */
export const MIN_NODE = '22.16.0';
/** No release before this one is a starting point for an upgrade (Phase 1 has no upgrade path yet). */
export const MIN_UPGRADE_FROM = '0.0.0';

/** Global Constraints: the banner of server.mjs (CommonJS dependencies get a `require` that resolves built-ins). */
const SERVER_BANNER = "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);";

/**
 * Optional requires of bundled packages that ALTIS never ships, stubbed out (see the top of this file):
 * - `cardinal`: mysql2's optional SQL highlighter for debug output (try/catch around the require);
 * - `pg-native`: pg's native libpq binding (a native module: forbidden), behind `pg.native` / NODE_PG_FORCE_NATIVE.
 */
export const ABSENT_MODULES: readonly string[] = Object.freeze(['cardinal', 'pg-native']);

/**
 * Texts no production file may hold (PRODUCTION_BUILD_LEAK): the `ALTIS_TEST_` hooks, the test-only permission
 * `test.branch.manage`, which `permissionCatalog` leaves out of a production bundle as dead code (S28), and the release
 * fixtures' migrations and table (decision D1d-26), which releaseMigrations() and the registries keep under the test
 * profile only.
 */
export const PRODUCTION_LEAK_NEEDLES: readonly string[] = Object.freeze([
  'ALTIS_TEST_',
  'test.branch.manage',
  '9001_test_expand',
  '9002_test_contract',
  'test_fixture',
]);

/** The environment variable that carries a production build's feed URL (`--feed-url` wins). */
export const RELEASE_FEED_URL_ENV = 'ALTIS_RELEASE_FEED_URL';

/** The placeholder of the admin index.html that the server replaces with each request's CSP nonce (D31). */
export const CSP_NONCE_PLACEHOLDER = '__CSP_NONCE__';

/** The environment variables that carry the production key files (paths). */
export const RELEASE_KEY_ENV = {
  signingKey: 'ALTIS_RELEASE_SIGNING_KEY',
  rootKeys: 'ALTIS_RELEASE_ROOT_KEYS',
  keyset: 'ALTIS_RELEASE_KEYSET',
} as const satisfies Record<keyof ReleaseKeyFiles, string>;

const RELEASE_KEY_FLAG = {
  signingKey: '--signing-key',
  rootKeys: '--root-keys',
  keyset: '--keyset',
} as const satisfies Record<keyof ReleaseKeyFiles, string>;

const KEY_NAMES = ['signingKey', 'rootKeys', 'keyset'] as const;
const DEV_KID_PREFIX = 'dev-';

/** package.json of the zip, exactly (spec §9.1). */
export function packageJsonText(version: string): string {
  const manifest = {
    name: 'altis',
    private: true,
    version,
    license: RELEASE_LICENSE,
    type: 'commonjs',
    main: 'app.js',
    scripts: { start: 'node app.js' },
    engines: { node: '>=22.16' },
  };
  return `${JSON.stringify(manifest)}\n`;
}

function checkProfile(profile: string): asserts profile is ReleaseProfile {
  if (profile !== 'test' && profile !== 'production') throw new Error(`BUILD_PROFILE_INVALID:${JSON.stringify(profile)} (test or production)`);
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------------------------------------------------------
// Keys

interface ReleaseKeys {
  signingKeyFile: string;
  signerKid: string;
  /** The root keys embedded in app.js and server.mjs (__TRUSTED_KEYS__). */
  roots: TrustedKey[];
  keysetBytes: Buffer;
}

/** A key file read once: its bytes and its strict-JSON value. */
async function readJsonFile(file: string, what: string): Promise<{ bytes: Buffer; value: unknown }> {
  let bytes: Buffer;
  try {
    bytes = await fsp.readFile(file);
  } catch (error) {
    throw new Error(`RELEASE_KEYS_INVALID:${what} (cannot read ${file}: ${messageOf(error)})`, { cause: error });
  }
  try {
    return { bytes, value: parseStrictJson(bytes.toString('utf8')) };
  } catch (error) {
    throw new Error(`RELEASE_KEYS_INVALID:${what} (${file} is not strict JSON: ${messageOf(error)})`, { cause: error });
  }
}

/**
 * The signing key file, read with altis-sign's loadKeyFile (Task 8, preflight S11): `{kid, use: 'release', pkcs8}`
 * or its passphrase-encrypted form `{kid, use: 'release', enc}` (`altis-sign keygen --encrypt`), the form the
 * production `rel` key only exists in. The passphrase comes from ALTIS_KEY_PASSPHRASE or a prompt on the terminal; a
 * passphrase typed there is remembered for that file, so signing the manifest (`release sign`) does not ask again.
 *
 * @throws Error `RELEASE_KEYS_INVALID:signing key (…)`, `KEY_PASSPHRASE_REQUIRED (…)`, `KEY_PASSPHRASE_INVALID (…)`
 */
async function readSigningKey(file: string): Promise<{ kid: string; pub: string }> {
  let key: LoadedKeyFile;
  try {
    key = await loadKeyFile(file);
  } catch (error) {
    const message = messageOf(error);
    if (message.startsWith('KEY_PASSPHRASE_')) throw new Error(message, { cause: error });
    throw new Error(`RELEASE_KEYS_INVALID:signing key (${message})`, { cause: error });
  }
  if (key.use !== 'release') throw new Error(`RELEASE_KEYS_INVALID:signing key (${file} has use "${key.use}", not "release")`);
  return { kid: key.kid, pub: key.pub };
}

/** The root keys file `[{kid, use: 'root', pub}]`: non-empty, root keys only, distinct kids. */
async function readRootKeys(file: string): Promise<TrustedKey[]> {
  const { value } = await readJsonFile(file, 'root keys');
  const roots = Array.isArray(value) && value.every((key) => isTrustedKey(key) && key.use === 'root') ? (value as TrustedKey[]) : [];
  const kids = new Set(roots.map((key) => key.kid));
  const pubs = new Set(roots.map((key) => key.pub));
  if (roots.length === 0 || kids.size !== roots.length || pubs.size !== roots.length) {
    throw new Error(`RELEASE_KEYS_INVALID:root keys (${file} must be a non-empty list of distinct {kid, use: "root", pub})`);
  }
  return roots.map((key) => ({ kid: key.kid, use: key.use, pub: key.pub }));
}

/**
 * The keyset documents `[{raw, env}]` shipped as keyset.json, and what they make app.js trust under `roots`. The file
 * is in the frozen format app.js reads (ruling R65c: an array of at most 4096 documents of at most 64 KiB, 8 MiB in
 * all; RELEASE_KEYS_INVALID otherwise). Every document must count (app.js would ignore it otherwise) and no kid may
 * be bound to two keys: KEYSET_INVALID.
 */
async function readKeyset(file: string, roots: TrustedKey[]): Promise<{ bytes: Buffer; docs: KeysetDoc[]; resolved: TrustedKey[] }> {
  const { bytes, value } = await readJsonFile(file, 'keyset');
  let docs: KeysetDoc[];
  try {
    if (bytes.length > KEYSET_MAX_FILE_BYTES) throw new Error(`larger than ${KEYSET_MAX_FILE_BYTES} bytes`);
    docs = parseKeysetDocs(value);
  } catch (error) {
    throw new Error(`RELEASE_KEYS_INVALID:keyset (${file}: ${messageOf(error)})`, { cause: error });
  }
  const malformed = docs.findIndex((doc: unknown) => {
    const d = doc !== null && typeof doc === 'object' ? (doc as Record<string, unknown>) : {};
    return typeof d['raw'] !== 'string' || d['env'] === null || typeof d['env'] !== 'object';
  });
  if (malformed !== -1) throw new Error(`RELEASE_KEYS_INVALID:keyset (${file}: document ${malformed} is not {raw, env})`);
  const resolved = resolveTrustedKeys(roots, docs);
  const problems = [
    ...resolved.rejected.map(({ index, reason }) => `document ${index}: ${reason}`),
    ...resolved.conflicts.map((kid) => `kid ${kid} is bound to two keys`),
  ];
  if (problems.length > 0) throw new Error(`KEYSET_INVALID:${problems.join('; ')} (${file}, against the root keys)`);
  return { bytes, docs, resolved: resolved.keys };
}

/** Every dev key (tools/keys/dev/trusted.json, the dev root included): kids and public keys. */
async function devKeyMaterial(): Promise<{ kids: string[]; pubs: string[] }> {
  const keys = JSON.parse(await fsp.readFile(path.join(DEV_KEYS_DIR, 'trusted.json'), 'utf8')) as TrustedKey[];
  return { kids: keys.map((k) => k.kid), pubs: keys.map((k) => k.pub) };
}

async function insideDevKeys(file: string): Promise<boolean> {
  const real = async (p: string): Promise<string> => fsp.realpath(p).catch(() => path.resolve(p));
  const relative = path.relative(await real(DEV_KEYS_DIR), await real(file));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** The keys of a keyset document's payload and the kid that signed it (unverified: for the dev-key check only). */
function keysetDocKeys(doc: KeysetDoc): { signer: string; kids: string[]; pubs: string[] } {
  let keys: unknown;
  try {
    const payload = parseStrictJson(doc.raw) as { keys?: unknown } | null;
    keys = payload?.keys;
  } catch {
    keys = undefined; // not JSON: no keys to look at (resolveTrustedKeys has refused it already)
  }
  const list = Array.isArray(keys) ? keys.filter(isTrustedKey) : [];
  return { signer: String(doc.env?.kid), kids: list.map((k) => k.kid), pubs: list.map((k) => k.pub) };
}

/**
 * The keys of this build (see the top of this file).
 *
 * @throws Error `MISSING_RELEASE_KEY:<variable>`, `DEV_KEY_IN_PRODUCTION:<what>`, `NON_DEV_KEY_IN_TEST_BUILD:<what>`,
 *   `RELEASE_KEYS_INVALID:<what>`, `KEYSET_INVALID:<detail>`, `SIGNING_KEY_NOT_TRUSTED:<kid>`
 */
async function loadReleaseKeys(profile: ReleaseProfile, given: ReleaseKeyFiles): Promise<ReleaseKeys> {
  const files: ReleaseKeyFiles =
    profile === 'test'
      ? {
          signingKey: given.signingKey ?? path.join(DEV_KEYS_DIR, 'dev-rel-1.key.json'),
          rootKeys: given.rootKeys ?? path.join(DEV_KEYS_DIR, 'roots.json'),
          keyset: given.keyset ?? path.join(DEV_KEYS_DIR, 'keyset.json'),
        }
      : given;
  for (const name of KEY_NAMES) {
    if (files[name] === undefined) {
      throw new Error(
        `MISSING_RELEASE_KEY:${RELEASE_KEY_ENV[name]} (or ${RELEASE_KEY_FLAG[name]} <file>): a production build is signed with ` +
          'an offline release key, embeds the offline root keys (public) and ships a root-signed keyset, never the dev keys',
      );
    }
  }
  const signingKeyFile = files.signingKey!;
  const dev = await devKeyMaterial();
  const isDev = (kid: string, pub?: string): boolean => kid.startsWith(DEV_KID_PREFIX) || dev.kids.includes(kid) || (pub !== undefined && dev.pubs.includes(pub));

  if (profile === 'production') {
    for (const name of KEY_NAMES) {
      if (await insideDevKeys(files[name]!)) throw new Error(`DEV_KEY_IN_PRODUCTION:${files[name]!} (tools/keys/dev is for tests only)`);
    }
  }
  const signer = await readSigningKey(signingKeyFile);
  const roots = await readRootKeys(files.rootKeys!);
  if (profile === 'production') {
    if (isDev(signer.kid, signer.pub)) throw new Error(`DEV_KEY_IN_PRODUCTION:signing key ${signer.kid}`);
    const devRoot = roots.find((key) => isDev(key.kid, key.pub));
    if (devRoot !== undefined) throw new Error(`DEV_KEY_IN_PRODUCTION:root key ${devRoot.kid}`);
    // Ruling R65e: the roots are frozen into app.js, so production embeds an active root and an offline spare.
    if (roots.length < 2) {
      throw new Error(`RELEASE_KEYS_INVALID:root keys (${files.rootKeys!} must hold at least two root keys: the active one and the offline spare)`);
    }
  } else {
    if (!signer.kid.startsWith(DEV_KID_PREFIX)) {
      throw new Error(`NON_DEV_KEY_IN_TEST_BUILD:${signer.kid} (a test build keeps the test hooks; it is only ever signed with a dev- key)`);
    }
    const nonDevRoot = roots.find((key) => !key.kid.startsWith(DEV_KID_PREFIX));
    if (nonDevRoot !== undefined) {
      throw new Error(`NON_DEV_KEY_IN_TEST_BUILD:root key ${nonDevRoot.kid} (a test build keeps the test hooks; it only ever embeds dev- roots)`);
    }
  }
  const keyset = await readKeyset(files.keyset!, roots);
  if (profile === 'production') {
    keyset.docs.forEach((doc, index) => {
      const found = keysetDocKeys(doc);
      if (isDev(found.signer) || found.kids.some((kid) => isDev(kid)) || found.pubs.some((pub) => dev.pubs.includes(pub))) {
        throw new Error(`DEV_KEY_IN_PRODUCTION:keyset document ${index}`);
      }
    });
  }
  if (!keyset.resolved.some((key) => key.kid === signer.kid && key.use === 'release' && key.pub === signer.pub)) {
    throw new Error(
      `SIGNING_KEY_NOT_TRUSTED:${signer.kid} (no root-signed document of ${files.keyset!} trusts it as a release key, or one ` +
        'revokes it: app.js would refuse the release)',
    );
  }
  return { signingKeyFile, signerKid: signer.kid, roots, keysetBytes: keyset.bytes };
}

// ---------------------------------------------------------------------------------------------------------------
// Manifest facts

/** git's output in `repo` (possibly empty), or undefined when git fails. Takes no optional lock (other git users). */
function git(repo: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', args, {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    }).trim();
  } catch {
    return undefined;
  }
}

/** The commit, commit time and cleanliness of the git checkout at `repo` (default: this repository). */
export function gitSourceState(repo: string = REPO_ROOT): SourceState {
  const commit = git(repo, ['rev-parse', '--verify', 'HEAD']);
  if (commit === undefined || !/^[0-9a-f]{40,64}$/.test(commit)) return { commit: undefined, committedAt: undefined, dirty: undefined };
  const seconds = Number(git(repo, ['log', '-1', '--format=%ct', 'HEAD']));
  const status = git(repo, ['status', '--porcelain', '--untracked-files=no']);
  return {
    commit,
    committedAt: Number.isSafeInteger(seconds) && seconds > 0 ? seconds : undefined,
    dirty: status === undefined ? undefined : status !== '',
  };
}

/** The prerelease part of a SemVer version (between `-` and `+`), or '' without one. */
function prereleaseOf(version: string): string {
  const core = version.split('+')[0]!;
  const dash = core.indexOf('-');
  return dash === -1 ? '' : core.slice(dash + 1);
}

/** @throws Error `VERSION_PROFILE_MISMATCH` unless a test version's prerelease has `test` and a production one's not */
function checkVersionProfile(profile: ReleaseProfile, version: string): void {
  const isTestVersion = /test/i.test(prereleaseOf(version));
  if (profile === 'test' && !isTestVersion) {
    throw new Error(`VERSION_PROFILE_MISMATCH:${version} (a test build needs a prerelease with "test", e.g. 0.1.0-test)`);
  }
  if (profile === 'production' && isTestVersion) {
    throw new Error(`VERSION_PROFILE_MISMATCH:${version} (a production version never carries a "test" prerelease)`);
  }
}

/**
 * The release fixture level of a build (decision D1d-26): 0 in production; in a test build 1 for `0.1.0-test`, 2 for
 * `0.2.0-test`, 3 for `0.3.0-test`, and 1 for any other test version.
 */
export function fixtureLevelOf(profile: ReleaseProfile, version: string): TestFixtureLevel {
  if (profile !== 'test') return 0;
  if (version === '0.2.0-test') return 2;
  if (version === '0.3.0-test') return 3;
  return 1;
}

/**
 * schemaLatest (NNNN of the last migration) and minCodeVersionAfter (highest contract floor, else 0.0.0) of the
 * migrations of fixture `level` (default 0: PHASE1_MIGRATIONS): level 2 ends at 9001, level 3 at 9002 with the floor
 * 0.3.0-test. Read with migrationsForLevel, since this script runs without a build profile.
 */
export function schemaFacts(level: TestFixtureLevel = 0): { schemaLatest: string; minCodeVersionAfter: string } {
  const migrations = migrationsForLevel(level);
  const names = Object.keys(migrations).sort(byText);
  const last = names[names.length - 1];
  let minCodeVersionAfter = '0.0.0';
  for (const migration of Object.values(migrations)) {
    const floor = migration.contract?.minCodeVersion;
    if (floor !== undefined && compareSemver(floor, minCodeVersionAfter) > 0) minCodeVersionAfter = floor;
  }
  return { schemaLatest: last === undefined ? '0000' : last.slice(0, 4), minCodeVersionAfter };
}

/** An http(s) URL without user:password and without whitespace or control characters (config.json's `update.feedUrl`). */
function isFeedUrl(value: string): boolean {
  if (/\s/.test(value) || [...value].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)) return false;
  try {
    const { protocol, username, password } = new URL(value);
    return (protocol === 'http:' || protocol === 'https:') && username === '' && password === '';
  } catch {
    return false;
  }
}

/**
 * The feed base server.mjs embeds: `feedUrl`, or '' without one (any profile: no online update check then).
 *
 * @throws Error `FEED_URL_INVALID` (not an http(s) URL without user:password)
 */
function checkFeedUrl(feedUrl: string | undefined): string {
  if (feedUrl === undefined || feedUrl === '') return '';
  if (!isFeedUrl(feedUrl)) throw new Error(`FEED_URL_INVALID:${JSON.stringify(feedUrl.slice(0, 200))} (an http(s) URL without user:password)`);
  return feedUrl;
}

/** @throws Error `MIN_UPGRADE_FROM_INVALID` unless `minUpgradeFrom` (when given) is a SemVer version older than `version` */
function checkMinUpgradeFrom(version: string, minUpgradeFrom: string | undefined): void {
  if (minUpgradeFrom === undefined) return;
  if (!isSemver(minUpgradeFrom) || compareSemver(minUpgradeFrom, version) >= 0) {
    throw new Error(`MIN_UPGRADE_FROM_INVALID:${JSON.stringify(minUpgradeFrom)} (a SemVer version older than ${version})`);
  }
}

/**
 * @throws Error `DIRTY_TREE` (production, tracked files changed or state unknown, without allowDirty),
 *   `BUILD_ID_UNKNOWN`, `RELEASED_AT_UNKNOWN`
 */
function manifestMeta(o: BuildReleaseOptions, source: SourceState): Omit<ReleaseManifest, 'files'> {
  const dirty = source.dirty !== false;
  if (o.profile === 'production' && dirty && o.allowDirty !== true) {
    throw new Error(
      `DIRTY_TREE:${source.dirty === undefined ? 'git cannot tell the state of the sources' : 'tracked files differ from the commit'} ` +
        '(a production build is made from a clean checkout; --allow-dirty for a local experiment, stamped -dirty)',
    );
  }
  let buildId = o.buildId ?? source.commit;
  if (buildId === undefined || buildId === '') throw new Error('BUILD_ID_UNKNOWN: not a git checkout; pass --build-id and --released-at');
  if (o.profile === 'production' && dirty) buildId = `${buildId}-dirty`;
  let releasedAt = o.releasedAt;
  if (releasedAt === undefined) {
    const seconds = source.committedAt;
    if (seconds === undefined) throw new Error('RELEASED_AT_UNKNOWN: no commit date; pass --released-at YYYY-MM-DD');
    releasedAt = new Date(seconds * 1000).toISOString().slice(0, 10);
  }
  const triple = (v: readonly number[]): string => v.join('.');
  return {
    version: o.version,
    buildId,
    bootProtocol: 1,
    releasedAt,
    ...schemaFacts(fixtureLevelOf(o.profile, o.version)),
    minUpgradeFrom: o.minUpgradeFrom ?? MIN_UPGRADE_FROM,
    minNode: MIN_NODE,
    minDb: {
      mysql: triple(MIN_SERVER_VERSIONS.mysql),
      mariadb: triple(MIN_SERVER_VERSIONS.mariadb),
      postgres: triple(MIN_SERVER_VERSIONS.postgres),
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Bundles

/** esbuild plugin: each of `names` resolves to a module that throws MODULE_NOT_FOUND when it is required. */
function absentModules(names: readonly string[]): Plugin {
  const filter = new RegExp(`^(${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`);
  return {
    name: 'altis-absent-modules',
    setup(b) {
      b.onResolve({ filter }, (args) => ({ path: args.path, namespace: 'altis-absent' }));
      b.onLoad({ filter: /.*/, namespace: 'altis-absent' }, (args) => ({
        contents:
          `var e = new Error(${JSON.stringify(`Cannot find module '${args.path}' (not shipped with ALTIS)`)});\n` +
          "e.code = 'MODULE_NOT_FOUND';\nthrow e;\n",
        loader: 'js',
      }));
    },
  };
}

/** Every module specifier an output of `metafile` loads at run time (sorted, unique). */
function runtimeImportsOf(metafile: Metafile): string[] {
  const specifiers = new Set<string>();
  for (const output of Object.values(metafile.outputs)) for (const imported of output.imports) specifiers.add(imported.path);
  return [...specifiers].sort(byText);
}

export interface ServerBundle {
  code: Uint8Array;
  map: Uint8Array;
  metafile: Metafile;
}

/**
 * server.mjs of a release (see the top of this file): `profile`, the embedded `roots`, the fixture `level`
 * (`__TEST_FIXTURE__`) and the feed base (`__FEED_URL__`, '' for none). Exported for the leak test of Task 9.
 */
export async function bundleServer(
  profile: ReleaseProfile,
  roots: TrustedKey[],
  o: { level: TestFixtureLevel; feedUrl: string },
): Promise<ServerBundle> {
  // Nothing is written (write: false); the outfile only anchors the source map's relative paths, the same on every
  // build.
  const outfile = path.join(REPO_ROOT, 'dist', 'release', 'server.mjs');
  const result = await build({
    absWorkingDir: REPO_ROOT,
    entryPoints: [SERVER_ENTRY],
    outfile,
    write: false,
    // Global Constraints, exactly:
    platform: 'node',
    format: 'esm',
    target: 'node22.16',
    bundle: true,
    minify: true,
    legalComments: 'none',
    banner: { js: SERVER_BANNER },
    external: ['node:sqlite'],
    // Task 17:
    metafile: true,
    sourcemap: 'external',
    define: {
      __BUILD_PROFILE__: JSON.stringify(profile),
      __TRUSTED_KEYS__: JSON.stringify(roots),
      __TEST_FIXTURE__: String(o.level),
      __FEED_URL__: JSON.stringify(o.feedUrl),
    },
    plugins: [absentModules(ABSENT_MODULES)],
    logLevel: 'silent',
  });
  const code = result.outputFiles.find((file) => file.path === outfile);
  const map = result.outputFiles.find((file) => file.path === `${outfile}.map`);
  if (code === undefined || map === undefined || result.outputFiles.length !== 2) throw new Error('SERVER_BUNDLE_UNEXPECTED: esbuild outputs');
  return { code: code.contents, map: map.contents, metafile: result.metafile };
}

/** A file of the admin build: its path under public/admin (POSIX) and its bytes. */
interface AdminFile {
  path: string;
  data: Buffer;
}

interface AdminBuild {
  files: AdminFile[];
  /** What the bundle is made of (apps/admin/.build/inputs.json), relative to the repository root. */
  inputs: string[];
}

/** The environment of the admin build: this one, minus a test runner's settings, plus the release's. */
function adminBuildEnv(profile: ReleaseProfile, version: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) if (!name.startsWith('VITEST') && name !== 'NODE_ENV') env[name] = value;
  return { ...env, NODE_ENV: 'production', ALTIS_BUILD: version, ALTIS_BUILD_PROFILE: profile };
}

/**
 * The pages of the admin build: the SPA (index.html, served at /admin) and the install wizard (install.html, served at
 * /install; 1c Task 30, release kind `install-index`). Every other file is a hashed asset under assets/.
 */
export const ADMIN_PAGES: readonly string[] = Object.freeze(['index.html', 'install.html']);

/**
 * Refuses an admin page the server could not serve under its CSP (D31): it must hold the {@link CSP_NONCE_PLACEHOLDER}
 * the server replaces with each request's nonce, no inline `<style>`, every `<script>` either loaded from /admin/assets
 * or, when inline, carrying `nonce="__CSP_NONCE__"`.
 *
 * @throws Error `ADMIN_BUILD_INVALID:<name> (<why>)`
 */
export function checkAdminPage(name: string, html: string): void {
  const invalid = (why: string): Error => new Error(`ADMIN_BUILD_INVALID:${name} (${why})`);
  if (!html.includes(CSP_NONCE_PLACEHOLDER)) throw invalid(`no ${CSP_NONCE_PLACEHOLDER} placeholder for the CSP nonce`);
  if (/<style\b/i.test(html)) throw invalid('an inline <style>');
  for (const [, attributes, body] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const src = /\ssrc\s*=\s*["']([^"']*)["']/i.exec(attributes!)?.[1];
    if (src !== undefined) {
      if (!src.startsWith('/admin/assets/')) throw invalid(`a script not served from /admin/assets: ${src}`);
    } else if (body!.trim() !== '' && !attributes!.includes(`nonce="${CSP_NONCE_PLACEHOLDER}"`)) {
      throw invalid(`an inline <script> without the ${CSP_NONCE_PLACEHOLDER} nonce`);
    }
  }
}

/** Runs `pnpm <args>` in the repository. @throws Error `ADMIN_BUILD_FAILED:<last lines of its output>` */
function runPnpm(args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      'pnpm',
      args,
      { cwd: REPO_ROOT, env, maxBuffer: 64 * 1024 * 1024, shell: process.platform === 'win32', windowsHide: true },
      (error, stdout, stderr) => {
        if (error === null) return resolve();
        const tail = `${stdout}\n${stderr}`.trim().split('\n').slice(-20).join('\n');
        reject(new Error(`ADMIN_BUILD_FAILED:pnpm ${args.join(' ')} (${error.message.split('\n')[0]})\n${tail}`, { cause: error }));
      },
    );
  });
}

/** Every regular file under `dir`, as sorted POSIX paths relative to it. */
async function filesUnder(dir: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(at: string, rel: string): Promise<void> {
    for (const entry of await fsp.readdir(at, { withFileTypes: true })) {
      const child = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) await walk(path.join(at, entry.name), child);
      else if (entry.isFile()) found.push(child);
      else throw new Error(`ADMIN_BUILD_INVALID:${child} (not a regular file)`);
    }
  }
  await walk(dir, '');
  return found.sort(byText);
}

/**
 * Builds the admin SPA for this release (see the top of this file) and reads what it made.
 *
 * @throws Error `ADMIN_BUILD_FAILED:<output>`, `ADMIN_BUILD_INVALID:<file> (<why>)`
 */
async function buildAdmin(profile: ReleaseProfile, version: string): Promise<AdminBuild> {
  await fsp.rm(ADMIN_INPUTS, { force: true });
  await runPnpm(['--filter', '@altis/admin', 'build'], adminBuildEnv(profile, version));
  const dist = path.join(ADMIN_DIR, 'dist');
  const files: AdminFile[] = [];
  for (const rel of await filesUnder(dist)) {
    const asset = /^assets\/([^/]+)$/.exec(rel);
    if (!ADMIN_PAGES.includes(rel) && (asset === null || !ADMIN_ASSET_NAME.test(asset[1]!))) {
      throw new Error(`ADMIN_BUILD_INVALID:${rel} (only ${ADMIN_PAGES.join(', ')} and assets/<name> files the server serves; see ADMIN_ASSET_NAME)`);
    }
    files.push({ path: rel, data: await fsp.readFile(path.join(dist, ...rel.split('/'))) });
  }
  for (const name of ADMIN_PAGES) {
    const page = files.find((f) => f.path === name);
    if (page === undefined) throw new Error(`ADMIN_BUILD_INVALID:${name} (missing)`);
    checkAdminPage(name, page.data.toString('utf8'));
  }
  let inputs: unknown;
  try {
    inputs = JSON.parse(await fsp.readFile(ADMIN_INPUTS, 'utf8'));
  } catch (error) {
    throw new Error(`ADMIN_BUILD_INVALID:.build/inputs.json (${messageOf(error)})`, { cause: error });
  }
  if (!Array.isArray(inputs) || inputs.length === 0 || !inputs.every((i): i is string => typeof i === 'string' && i !== '')) {
    throw new Error('ADMIN_BUILD_INVALID:.build/inputs.json (not a list of module paths)');
  }
  return { files, inputs };
}

// ---------------------------------------------------------------------------------------------------------------
// Staging → zip

/** Files under `root` as sorted POSIX paths, each `.complete` moved to the end (an interrupted unzip leaves none). */
async function stagedFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(dir: string, rel: string): Promise<void> {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const child = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), child);
      else if (entry.isFile()) files.push(child);
      else throw new Error(`STAGING_UNEXPECTED:${child} (not a regular file)`);
    }
  }
  await walk(root, '');
  const isComplete = (p: string): boolean => path.posix.basename(p) === COMPLETE_FILE;
  files.sort(byText);
  return [...files.filter((p) => !isComplete(p)), ...files.filter(isComplete)];
}

async function signManifest(releaseDir: string, keyFile: string): Promise<void> {
  const errors: string[] = [];
  const code = await signCli(['release', 'sign', '--dir', releaseDir, '--key', keyFile], {
    out: () => {},
    err: (line) => void errors.push(line),
  });
  if (code !== 0) throw new Error(`MANIFEST_SIGN_FAILED:${errors.join(' ').trim()}`);
}

async function writeAtomically(file: string, data: Uint8Array | string): Promise<void> {
  const temporary = `${file}.tmp-${process.pid}`;
  await fsp.writeFile(temporary, data);
  await fsp.rename(temporary, file);
}

/**
 * The bytes of {@link LEGAL_FILES} in `dir`, read before anything is built.
 * @throws Error `LEGAL_FILE_MISSING:<file>` for one that cannot be read or is empty
 */
async function readLegalFiles(dir: string): Promise<[string, Buffer][]> {
  const files: [string, Buffer][] = [];
  for (const name of LEGAL_FILES) {
    let data: Buffer;
    try {
      data = await fsp.readFile(path.join(dir, name));
    } catch (error) {
      throw new Error(`LEGAL_FILE_MISSING:${name} (${path.join(dir, name)}: ${messageOf(error)})`, { cause: error });
    }
    if (data.length === 0) throw new Error(`LEGAL_FILE_MISSING:${name} (${path.join(dir, name)} is empty)`);
    files.push([name, data]);
  }
  return files;
}

/**
 * Builds the release zip (see the top of this file). Nothing is written to `o.out` unless every check passed.
 *
 * @throws Error `BUILD_PROFILE_INVALID`, `VERSION_INVALID`, `FEED_URL_INVALID`,
 *   `MIN_UPGRADE_FROM_INVALID`, the key errors of the top of this file, `LEGAL_FILE_MISSING:<file>`, `BUILD_ID_UNKNOWN`,
 *   `RELEASED_AT_UNKNOWN`, `NATIVE_MODULE:<path>`, `LICENSE_NOT_ALLOWED:<pkg>`, `BUNDLE_NOT_SELF_CONTAINED:<spec>`,
 *   `LICENSE_TEXT_MISSING:<pkg>`, `RELEASE_INVALID:<reason>`, `PRODUCTION_BUILD_LEAK:<file>`, `ZIP_TOO_LARGE`, and the
 *   errors of buildBootloader (`DEV_KEY_IN_PRODUCTION`, `PRODUCTION_BUILD_LEAK`, …)
 */
export async function buildRelease(o: BuildReleaseOptions): Promise<BuildReleaseResult> {
  checkProfile(o.profile);
  if (!isSemver(o.version)) throw new Error(`VERSION_INVALID:${JSON.stringify(o.version)} (SemVer, e.g. 0.1.0-test)`);
  checkVersionProfile(o.profile, o.version);
  const feedUrl = checkFeedUrl(o.feedUrl);
  checkMinUpgradeFrom(o.version, o.minUpgradeFrom);
  const keys = await loadReleaseKeys(o.profile, o.keys ?? {});
  const meta = manifestMeta(o, o.source ?? gitSourceState());
  const legal = await readLegalFiles(o.legalRoot ?? REPO_ROOT);

  const staging = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-release-')));
  try {
    const root = path.join(staging, 'zip');
    const releaseDir = path.join(root, 'bundled-release', o.version);
    await fsp.mkdir(path.join(releaseDir, 'public'), { recursive: true });

    // Bundles.
    const server = await bundleServer(o.profile, keys.roots, { level: fixtureLevelOf(o.profile, o.version), feedUrl });
    const appMap = path.join(staging, 'app.js.map');
    const app = await buildBootloader({
      profile: o.profile,
      outfile: path.join(root, 'app.js'),
      bundledVersion: o.version,
      rootKeys: keys.roots,
      sourcemapFile: appMap,
    });
    const admin = await buildAdmin(o.profile, o.version);

    // Guards over what the bundles contain (the admin's runs in the browser: its imports are not checked here).
    const inputs = [
      ...Object.keys(server.metafile.inputs),
      ...Object.keys(app.metafile.inputs),
      ...admin.inputs,
      ...(o.extraBundleInputs ?? []),
    ];
    checkNativeInputs(inputs);
    const packages = await packagesOfInputs(inputs, REPO_ROOT);
    checkLicenses(packages);
    const runtimeImports = { server: runtimeImportsOf(server.metafile), app: runtimeImportsOf(app.metafile) };
    // What esbuild reports as external, and what the finished bundles themselves load (import(), import, require()):
    // a foreign specifier in either fails with BUNDLE_NOT_SELF_CONTAINED:<specifier>.
    const scanned = [
      ...scanRuntimeImports(new TextDecoder().decode(server.code)),
      ...scanRuntimeImports(await fsp.readFile(path.join(root, 'app.js'), 'utf8')),
    ];
    checkRuntimeImports([...runtimeImports.server, ...runtimeImports.app, ...scanned]);
    const notices = await collectNotices(packages, { version: o.version });

    // The files of the zip.
    await fsp.writeFile(path.join(releaseDir, 'server.mjs'), server.code);
    for (const file of admin.files) {
      const target = path.join(releaseDir, 'public', 'admin', ...file.path.split('/'));
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, file.data);
    }
    await fsp.writeFile(path.join(releaseDir, 'public', 'THIRD_PARTY_NOTICES.txt'), notices.text);
    await fsp.writeFile(path.join(releaseDir, KEYSET_FILE), keys.keysetBytes);
    await fsp.writeFile(path.join(root, 'package.json'), packageJsonText(o.version));
    await fsp.writeFile(path.join(root, 'ecosystem.config.cjs'), (await fsp.readFile(ECOSYSTEM_TEMPLATE, 'utf8')).replace(/\r\n/g, '\n'));
    await fsp.writeFile(path.join(root, 'THIRD_PARTY_NOTICES.txt'), notices.text);
    for (const [name, data] of legal) await fsp.writeFile(path.join(root, name), data);
    const manifest = await buildManifest(releaseDir, meta);
    await fsp.writeFile(path.join(releaseDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
    await signManifest(releaseDir, keys.signingKeyFile);
    await fsp.writeFile(path.join(releaseDir, COMPLETE_FILE), '');

    // The bundled release as app.js sees it on a fresh install: the embedded roots + the shipped keyset.json (no
    // DATA_DIR keyset yet), every file, nothing extra. The same function app.js and doctor verify with.
    let resolved: KeysetReport | undefined;
    try {
      await verifyReleaseWithRoots(releaseDir, keys.roots, {
        check: 'all',
        refuseDevKids: o.profile === 'production',
        onResolved: (r) => void (resolved = r),
      });
    } catch (error) {
      const untrusted = resolved !== undefined && !resolved.keys.some((key) => key.kid === keys.signerKid);
      throw new Error(
        `${messageOf(error)} (checked as app.js checks it: the root keys + the shipped keyset.json${
          untrusted ? `; signer ${keys.signerKid} is not trusted by them` : ''
        })`,
        { cause: error },
      );
    }

    const paths = await stagedFiles(root);
    const entries = await Promise.all(paths.map(async (p) => ({ path: p, data: await fsp.readFile(path.join(root, ...p.split('/'))) })));
    if (o.profile === 'production') {
      const dev = await devKeyMaterial();
      checkNoLeaks(
        entries.map((e) => ({ path: e.path, text: e.data.toString('utf8') })),
        [...PRODUCTION_LEAK_NEEDLES, ...dev.kids, ...dev.pubs],
      );
    }
    const zip = writeZip(entries);
    if (zip.length >= ZIP_BUDGET_BYTES) throw new Error(`ZIP_TOO_LARGE:${zip.length} bytes (budget ${ZIP_BUDGET_BYTES})`);

    const report: BuildReport = {
      zipBytes: zip.length,
      adminBytes: admin.files.reduce((sum, file) => sum + file.data.length, 0),
      files: entries.map((e) => ({ path: e.path, size: e.data.length })),
      notices: { packages: notices.packages.map((p) => ({ name: p.name, version: p.version, license: p.license ?? null })) },
    };

    // Everything passed: write the outputs.
    const out = path.resolve(o.out);
    const mapsDir = path.join(out, 'private', 'sourcemaps');
    await fsp.mkdir(mapsDir, { recursive: true });
    const sourcemaps = [path.join(mapsDir, 'server.mjs.map'), path.join(mapsDir, 'app.js.map')];
    await writeAtomically(sourcemaps[0]!, server.map);
    await writeAtomically(sourcemaps[1]!, await fsp.readFile(appMap));
    const zipFile = path.join(out, `altis-${o.version}.zip`);
    const reportFile = path.join(out, 'build-report.json');
    await writeAtomically(zipFile, zip);
    await writeAtomically(reportFile, `${JSON.stringify(report, null, 2)}\n`);
    return { zipFile, reportFile, report, manifest, runtimeImports, sourcemaps };
  } finally {
    await fsp.rm(staging, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Command line

/**
 * The options of `pnpm release …` (see the top of this file). `--profile` and `--version` are required. Key files come from the flags, else (production only)
 * from ALTIS_RELEASE_SIGNING_KEY / ALTIS_RELEASE_ROOT_KEYS / ALTIS_RELEASE_KEYSET, and the feed URL (optional) from
 * `--feed-url`, else (production only) ALTIS_RELEASE_FEED_URL; relative paths are taken from
 * INIT_CWD (where pnpm was run) or `cwd`. SOURCE_DATE_EPOCH, when set, gives releasedAt.
 *
 * @throws Error `USAGE: …`, `BUILD_PROFILE_INVALID`
 */
export function parseReleaseArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): BuildReleaseOptions {
  const args = argv[0] === '--' ? argv.slice(1) : [...argv];
  let values: Record<string, string | undefined>;
  let allowDirty: boolean;
  try {
    const parsed = parseArgs({
      args,
      strict: true,
      allowPositionals: false,
      options: {
        profile: { type: 'string' },
        version: { type: 'string' },
        out: { type: 'string' },
        'signing-key': { type: 'string' },
        'root-keys': { type: 'string' },
        keyset: { type: 'string' },
        'build-id': { type: 'string' },
        'released-at': { type: 'string' },
        'allow-dirty': { type: 'boolean' },
        'min-upgrade-from': { type: 'string' },
        'feed-url': { type: 'string' },
      },
    }).values as Record<string, string | boolean | undefined>;
    allowDirty = parsed['allow-dirty'] === true;
    values = parsed as Record<string, string | undefined>;
  } catch (error) {
    throw new Error(`USAGE: ${messageOf(error)}`, { cause: error });
  }
  const profile = values['profile'];
  if (profile === undefined) throw new Error('USAGE: --profile test|production is required (no default: a test build is signed with the dev keys)');
  checkProfile(profile);
  const version = values['version'];
  if (version === undefined) throw new Error('USAGE: --version <semver> is required');

  const base = env['INIT_CWD'] !== undefined && env['INIT_CWD'] !== '' ? env['INIT_CWD'] : cwd;
  const resolve = (p: string): string => path.resolve(base, p);
  const keys: ReleaseKeyFiles = {};
  for (const name of KEY_NAMES) {
    const fromFlag = values[RELEASE_KEY_FLAG[name].slice(2)];
    // The environment carries production keys only: a test build never picks them up by accident.
    const fromEnv = profile === 'production' ? env[RELEASE_KEY_ENV[name]] : undefined;
    const file = fromFlag ?? (fromEnv === '' ? undefined : fromEnv);
    if (file !== undefined) keys[name] = resolve(file);
  }

  // The environment's feed URL is for production builds only, as its keys are: a test build takes --feed-url.
  const envFeed = profile === 'production' ? env[RELEASE_FEED_URL_ENV] : undefined;
  const feedUrl = values['feed-url'] ?? (envFeed === '' ? undefined : envFeed);

  let releasedAt = values['released-at'];
  const epoch = env['SOURCE_DATE_EPOCH'];
  if (releasedAt === undefined && epoch !== undefined && /^\d+$/.test(epoch)) releasedAt = new Date(Number(epoch) * 1000).toISOString().slice(0, 10);

  return {
    profile,
    version,
    out: values['out'] === undefined ? DEFAULT_OUT : resolve(values['out']),
    keys,
    ...(values['build-id'] === undefined ? {} : { buildId: values['build-id'] }),
    ...(releasedAt === undefined ? {} : { releasedAt }),
    ...(allowDirty ? { allowDirty } : {}),
    ...(values['min-upgrade-from'] === undefined ? {} : { minUpgradeFrom: values['min-upgrade-from'] }),
    ...(feedUrl === undefined ? {} : { feedUrl }),
  };
}

async function main(argv: string[]): Promise<void> {
  const options = parseReleaseArgs(argv);
  const result = await buildRelease(options);
  const { report } = result;
  process.stdout.write(
    [
      `altis-${options.version}.zip (${options.profile}): ${report.zipBytes} bytes → ${result.zipFile}`,
      `  ${report.files.length} files (admin ${report.adminBytes} bytes); ${report.notices.packages.length} bundled packages, licences allowed`,
      `  manifest ${result.manifest.buildId} (${result.manifest.releasedAt}), signed and verified (check: all)`,
      `  build report → ${result.reportFile}`,
      `  source maps (not in the zip) → ${path.dirname(result.sourcemaps[0]!)}`,
      '',
    ].join('\n'),
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`release build failed: ${messageOf(error)}\n`);
    process.exitCode = 1;
  });
}
