/**
 * The signed static update feed of release zips (spec §9.6, §12.6; Task 17).
 *
 *   pnpm --filter @altis/release feed:build --zip <altis-x.zip> [--zip <altis-y.zip> …] --channel stable|beta
 *       --base-url <url> --out <dir> --release-key <file> --timestamp-key <file> --keyset <file>
 *       --seq <n> --expires-in-days <1-14> [--issued-at <ISO date-time>] [--root-keys <file>]
 *
 * → <out>/<channel>/feed.json, feed.sig, freshness.json and <out>/packages/<zip>: the folder a static host (or
 *   `pnpm feed-dev`) serves at the feed base `<baseUrl>`.
 *
 * Each zip is read (in memory: a release zip stays under 15 MB) and must hold exactly one bundled release,
 * `bundled-release/<v>/manifest.json` + `manifest.sig`, whose manifest is valid and names `<v>`. Its feed entry copies
 * the manifest's `version`, `releasedAt`, `bootProtocol`, `minUpgradeFrom`, `minCodeVersionAfter`, `minNode` and
 * `minDb` (§9.6: clients refuse a package whose manifest differs, entryMatchesManifest), on the feed's channel, with
 * `size` and `sha256` of the zip's bytes, `url` = `<baseUrl>/packages/<zip name>` and `notesUrl` null. Entries are
 * sorted by version, oldest first. With `rootKeys` (the `[{kid, use: 'root', pub}]` file the release build embeds),
 * each package is also verified as a fresh client verifies it after extraction (verifyReleaseWithRoots, `check: 'all'`,
 * the roots plus the release's keyset.json and --keyset; dev kids refused under non-dev roots, R65b), and the signed
 * feed is checked with verifyFeed before it is published. Without it the manifest signature is not checked against a
 * trust anchor: tests may list a package that clients must refuse.
 *
 * Signing goes through sign-cli (Task 8): `feed sign` with the release key and the keyset documents of --keyset,
 * then `freshness sign` with the timestamp key (`issuedAt`, given only for dev keys, as `--issued-at`). Encrypted key
 * files ask for their passphrase on the terminal or take ALTIS_KEY_PASSPHRASE, as sign-cli does.
 *
 * Writes: everything is signed in a temporary folder first; nothing is written to `out` unless every check passed.
 * Then the packages (each written whole: temporary file, rename, from the very bytes that were hashed), then feed.json,
 * feed.sig and freshness.json, each replaced atomically. A client reading between two of those renames sees a
 * signature or hash mismatch and tries again later; a build killed part-way is repaired by running it again. A `seq`
 * lower than the one already published in `<out>/<channel>/freshness.json` is refused (FEED_SEQ_BACKWARDS): clients that
 * saw the higher one would refuse the feed. Two feed builds must not write to one `out` at the same time.
 */
import { createHash, randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  MANIFEST_FILE,
  RELEASE_TYP,
  SIGNATURE_FILE,
  isTrustedKey,
  parseKeysetDocs,
  parseStrictJson,
  validateManifest,
  verifyReleaseWithRoots,
  type KeysetDoc,
  type ReleaseManifest,
  type TrustedKey,
} from '@altis/crypto';
import { FRESHNESS_MAX_MS, verifyFeed, type FeedChannel, type FeedEntry } from '@altis/crypto/feed';
import { runCli as signCli } from '@altis/sign-cli';
import { compareSemver } from '@altis/shared';
import { extractZip, readZip, type ZipEntry } from '../src/zip.js';

export interface BuildFeedOptions {
  /** Release zips (`pnpm release` output), one entry each. */
  zips: string[];
  channel: FeedChannel;
  /** The feed base clients use (`update.feedUrl`): an http(s) URL without user:password, query or fragment. */
  baseUrl: string;
  /** The feed folder; created when missing. */
  out: string;
  /** Key file of the `release` key that signs feed.json (`<kid>.key.json`, plain or encrypted). */
  releaseKey: string;
  /** Key file of the `timestamp` key that signs freshness.json. */
  timestampKey: string;
  /** The root-signed keyset documents (`[{raw, env}]`) the feed carries. */
  keyset: string;
  /** The freshness document's seq: at least the one already published (clients refuse a lower one). */
  seq: number;
  /** freshness.json expires this many days after issuedAt: 1 to 14 (§9.6). */
  expiresInDays: number;
  /** Epoch ms of freshness.json's issuedAt; dev timestamp keys only (sign-cli refuses it otherwise). Default: now. */
  issuedAt?: number;
  /** The root public keys (`[{kid, use: 'root', pub}]`): verify every package and the feed as clients will. */
  rootKeys?: string;
}

export interface BuildFeedResult {
  /** `out`, resolved: what feed-dev or a static host serves. */
  dir: string;
  /** The entries of the signed feed, oldest first. */
  entries: FeedEntry[];
}

export const FEED_FILES = ['feed.json', 'feed.sig', 'freshness.json'] as const;
export const PACKAGES_DIR = 'packages';

const CHANNELS: readonly string[] = ['stable', 'beta'];
const DAY_MS = 86_400_000;
/** A package name that is one plain URL path segment. */
const PACKAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*\.zip$/;
const BUNDLED_MANIFEST = /^bundled-release\/([^/]+)\/manifest\.json$/;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** The feed base without trailing slashes. @throws Error `FEED_BASE_URL_INVALID` */
function checkBaseUrl(value: string): string {
  const invalid = (): never => {
    throw new Error(`FEED_BASE_URL_INVALID:${JSON.stringify(value.slice(0, 200))} (an http(s) URL without user:password, query or fragment)`);
  };
  if (typeof value !== 'string' || /\s/.test(value) || [...value].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)) return invalid();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid();
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    return invalid();
  }
  if (value.includes('?') || value.includes('#')) return invalid();
  return value.replace(/\/+$/, '');
}

function checkOptions(o: BuildFeedOptions): void {
  if (typeof o.channel !== 'string' || !CHANNELS.includes(o.channel)) throw new Error(`FEED_CHANNEL_INVALID:${JSON.stringify(o.channel)} (stable or beta)`);
  if (!Number.isSafeInteger(o.seq) || o.seq < 0) throw new Error(`FEED_SEQ_INVALID:${String(o.seq)} (a whole number >= 0)`);
  const maxDays = FRESHNESS_MAX_MS / DAY_MS;
  if (!Number.isSafeInteger(o.expiresInDays) || o.expiresInDays < 1 || o.expiresInDays > maxDays) {
    throw new Error(`FEED_EXPIRES_INVALID:${String(o.expiresInDays)} (1 to ${maxDays} days, spec §9.6)`);
  }
  if (o.issuedAt !== undefined && (!Number.isSafeInteger(o.issuedAt) || o.issuedAt < 0 || Number.isNaN(new Date(o.issuedAt).getTime()))) {
    throw new Error(`FEED_ISSUED_AT_INVALID:${String(o.issuedAt)} (epoch milliseconds)`);
  }
}

/** The root keys of a `[{kid, use: 'root', pub}]` file. @throws Error `FEED_ROOT_KEYS_INVALID` */
async function readRoots(file: string): Promise<TrustedKey[]> {
  let value: unknown;
  try {
    value = parseStrictJson(await fsp.readFile(file, 'utf8'));
  } catch (error) {
    throw new Error(`FEED_ROOT_KEYS_INVALID:${file} (${messageOf(error)})`, { cause: error });
  }
  if (!Array.isArray(value) || value.length === 0 || !value.every((k) => isTrustedKey(k) && k.use === 'root')) {
    throw new Error(`FEED_ROOT_KEYS_INVALID:${file} (a non-empty array of {kid, use: "root", pub})`);
  }
  return value as TrustedKey[];
}

/** The keyset documents of --keyset, for the package checks (`feed sign` checks the file itself). */
async function readKeysetDocs(file: string): Promise<KeysetDoc[]> {
  try {
    return parseKeysetDocs(parseStrictJson(await fsp.readFile(file, 'utf8')));
  } catch (error) {
    throw new Error(`FEED_KEYSET_INVALID:${file} (${messageOf(error)})`, { cause: error });
  }
}

interface Package {
  name: string;
  bytes: Buffer;
  manifest: ReleaseManifest;
}

/** The one bundled release's signed manifest of a zip. @throws Error `FEED_PACKAGE_INVALID:<name> (<why>)` */
function manifestOfZip(name: string, entries: ZipEntry[]): ReleaseManifest {
  const invalid = (why: string, cause?: unknown): never => {
    throw new Error(`FEED_PACKAGE_INVALID:${name} (${why})`, cause === undefined ? undefined : { cause });
  };
  const manifests = entries.filter((e) => BUNDLED_MANIFEST.test(e.path));
  if (manifests.length !== 1) return invalid(manifests.length === 0 ? 'no bundled-release/<version>/manifest.json' : 'more than one bundled release');
  const entry = manifests[0] as ZipEntry;
  const folder = (BUNDLED_MANIFEST.exec(entry.path) as RegExpExecArray)[1] as string;
  const signature = entries.find((e) => e.path === `bundled-release/${folder}/${SIGNATURE_FILE}`);
  if (signature === undefined) return invalid(`no bundled-release/${folder}/${SIGNATURE_FILE}`);
  let manifest: ReleaseManifest;
  try {
    manifest = validateManifest(parseStrictJson(entry.data.toString('utf8')));
  } catch (error) {
    return invalid(`${MANIFEST_FILE}: ${messageOf(error)}`, error);
  }
  if (manifest.version !== folder) return invalid(`the manifest of bundled-release/${folder} is version ${manifest.version}`);
  let env: unknown;
  try {
    env = parseStrictJson(signature.data.toString('utf8'));
  } catch (error) {
    return invalid(`${SIGNATURE_FILE}: ${messageOf(error)}`, error);
  }
  if (env === null || typeof env !== 'object' || (env as Record<string, unknown>)['typ'] !== RELEASE_TYP) {
    return invalid(`${SIGNATURE_FILE} is not an ${RELEASE_TYP} envelope`);
  }
  return manifest;
}

/** Verifies an extracted package as a fresh client does (see the top of this file). @throws Error `FEED_PACKAGE_INVALID` */
async function verifyPackage(pkg: Package, roots: TrustedKey[], keysetDocs: KeysetDoc[], scratch: string): Promise<void> {
  const dir = path.join(scratch, `package-${randomBytes(6).toString('hex')}`);
  try {
    await extractZip(pkg.bytes, dir);
    await verifyReleaseWithRoots(path.join(dir, 'bundled-release', pkg.manifest.version), roots, {
      check: 'all',
      sources: [{ name: 'feed', docs: keysetDocs }],
      refuseDevKids: roots.some((root) => !root.kid.startsWith('dev-')),
    });
  } catch (error) {
    throw new Error(`FEED_PACKAGE_INVALID:${pkg.name} (${messageOf(error)})`, { cause: error });
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

/** Reads the zips: names, bytes, manifests; one per name and per version. */
async function readPackages(zips: readonly string[]): Promise<Package[]> {
  const packages: Package[] = [];
  for (const zip of zips) {
    const name = path.basename(zip);
    if (!PACKAGE_NAME.test(name)) throw new Error(`FEED_PACKAGE_NAME:${JSON.stringify(name)} (letters, digits, . _ + -, ending in .zip: one URL path segment)`);
    if (packages.some((p) => p.name === name)) throw new Error(`FEED_PACKAGE_DUPLICATE:${name} (two zips of one name in ${PACKAGES_DIR}/)`);
    let bytes: Buffer;
    try {
      bytes = await fsp.readFile(zip);
    } catch (error) {
      throw new Error(`FEED_PACKAGE_UNREADABLE:${zip} (${messageOf(error)})`, { cause: error });
    }
    let entries: ZipEntry[];
    try {
      entries = readZip(bytes);
    } catch (error) {
      throw new Error(`FEED_PACKAGE_INVALID:${name} (${messageOf(error)})`, { cause: error });
    }
    const manifest = manifestOfZip(name, entries);
    const twin = packages.find((p) => p.manifest.version === manifest.version);
    if (twin !== undefined) throw new Error(`FEED_DUPLICATE_VERSION:${manifest.version} (${twin.name} and ${name}: one entry per version)`);
    packages.push({ name, bytes, manifest });
  }
  return packages;
}

function entryOf(pkg: Package, channel: FeedChannel, baseUrl: string): FeedEntry {
  const m = pkg.manifest;
  return {
    version: m.version,
    channel,
    releasedAt: m.releasedAt,
    bootProtocol: m.bootProtocol,
    minUpgradeFrom: m.minUpgradeFrom,
    minCodeVersionAfter: m.minCodeVersionAfter,
    minNode: m.minNode,
    minDb: { mysql: m.minDb.mysql, mariadb: m.minDb.mariadb, postgres: m.minDb.postgres },
    size: pkg.bytes.length,
    sha256: sha256Hex(pkg.bytes),
    url: `${baseUrl}/${PACKAGES_DIR}/${encodeURIComponent(pkg.name)}`,
    notesUrl: null,
  };
}

/** The seq of the freshness document already published in `channelDir`, or undefined (none, or not readable as one). */
async function publishedSeq(channelDir: string): Promise<number | undefined> {
  let text: string;
  try {
    text = await fsp.readFile(path.join(channelDir, 'freshness.json'), 'utf8');
  } catch {
    return undefined;
  }
  try {
    const doc = parseStrictJson(text) as { raw?: unknown };
    const payload = typeof doc.raw === 'string' ? (parseStrictJson(doc.raw) as { seq?: unknown }) : undefined;
    return typeof payload?.seq === 'number' && Number.isSafeInteger(payload.seq) ? payload.seq : undefined;
  } catch {
    return undefined;
  }
}

/** Runs one sign-cli command; its first error line becomes `<code>:<line>`. */
async function sign(code: string, argv: string[]): Promise<void> {
  const errors: string[] = [];
  const exit = await signCli(argv, { out: () => {}, err: (line) => void errors.push(line) });
  if (exit !== 0) {
    const first = (errors.join('\n').split('\n')[0] ?? '').replace(/^error: /, '').trim();
    throw new Error(`${code}:${first === '' ? `altis-sign ${argv[0]} ${argv[1]} exited ${exit}` : first}`);
  }
}

/** Writes `data` to `file` whole: a temporary file next to it, then a rename. */
async function writeWhole(file: string, data: Uint8Array | string): Promise<void> {
  const temporary = `${file}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  try {
    await fsp.writeFile(temporary, data);
    await fsp.rename(temporary, file);
  } catch (error) {
    await fsp.rm(temporary, { force: true });
    throw error;
  }
}

/**
 * Builds and publishes a signed feed (see the top of this file).
 *
 * @throws Error `FEED_CHANNEL_INVALID`, `FEED_BASE_URL_INVALID`, `FEED_SEQ_INVALID`, `FEED_EXPIRES_INVALID`,
 *   `FEED_ISSUED_AT_INVALID`, `FEED_PACKAGE_NAME`, `FEED_PACKAGE_DUPLICATE`, `FEED_PACKAGE_UNREADABLE`,
 *   `FEED_PACKAGE_INVALID:<zip name>`, `FEED_DUPLICATE_VERSION`, `FEED_ROOT_KEYS_INVALID`, `FEED_KEYSET_INVALID`,
 *   `FEED_SEQ_BACKWARDS`, `FEED_SIGN_FAILED:<sign-cli error>`, `FRESHNESS_SIGN_FAILED:<sign-cli error>`,
 *   `FEED_SELF_CHECK:<verifyFeed error>`
 */
export async function buildFeed(o: BuildFeedOptions): Promise<BuildFeedResult> {
  checkOptions(o);
  const baseUrl = checkBaseUrl(o.baseUrl);
  const out = path.resolve(o.out);
  const channelDir = path.join(out, o.channel);
  const published = await publishedSeq(channelDir);
  if (published !== undefined && o.seq < published) {
    throw new Error(`FEED_SEQ_BACKWARDS:${o.seq} < ${published} (${path.join(channelDir, 'freshness.json')}; clients that saw ${published} refuse a lower seq)`);
  }

  const packages = await readPackages(o.zips);
  packages.sort((a, b) => compareSemver(a.manifest.version, b.manifest.version));
  const entries = packages.map((pkg) => entryOf(pkg, o.channel, baseUrl));

  const stage = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-feed-')));
  try {
    const roots = o.rootKeys === undefined ? undefined : await readRoots(o.rootKeys);
    if (roots !== undefined) {
      const keysetDocs = await readKeysetDocs(o.keyset);
      for (const pkg of packages) await verifyPackage(pkg, roots, keysetDocs, stage);
    }

    const source = path.join(stage, 'feed-src.json');
    await fsp.writeFile(source, `${JSON.stringify({ v: 1, channel: o.channel, releases: entries }, null, 2)}\n`);
    const signed = path.join(stage, 'signed');
    await sign('FEED_SIGN_FAILED', ['feed', 'sign', '--in', source, '--keyset', o.keyset, '--key', o.releaseKey, '--out-dir', signed]);
    await sign('FRESHNESS_SIGN_FAILED', [
      'freshness',
      'sign',
      '--feed',
      path.join(signed, 'feed.json'),
      '--seq',
      String(o.seq),
      '--expires-in-days',
      String(o.expiresInDays),
      '--key',
      o.timestampKey,
      '--out',
      path.join(signed, 'freshness.json'),
      ...(o.issuedAt === undefined ? [] : ['--issued-at', new Date(o.issuedAt).toISOString()]),
    ]);
    const [feedText, sigText, freshnessText] = await Promise.all(FEED_FILES.map((name) => fsp.readFile(path.join(signed, name), 'utf8')));

    if (roots !== undefined) {
      try {
        const verified = verifyFeed({
          feedText: feedText as string,
          sigText: sigText as string,
          freshnessText: freshnessText as string,
          channel: o.channel,
          roots,
          sources: [],
          refuseDevKids: roots.some((root) => !root.kid.startsWith('dev-')),
          now: o.issuedAt ?? Date.now(),
          minSeq: o.seq,
        });
        if (verified.entries.length !== entries.length) throw new Error(`${verified.entries.length} entries signed, ${entries.length} built`);
      } catch (error) {
        throw new Error(`FEED_SELF_CHECK:${messageOf(error)}`, { cause: error });
      }
    }

    // Publish: the packages first, so that a feed never names a package that is not there yet.
    const packagesDir = path.join(out, PACKAGES_DIR);
    await fsp.mkdir(packagesDir, { recursive: true });
    for (const pkg of packages) await writeWhole(path.join(packagesDir, pkg.name), pkg.bytes);
    await fsp.mkdir(channelDir, { recursive: true });
    await writeWhole(path.join(channelDir, 'feed.json'), feedText as string);
    await writeWhole(path.join(channelDir, 'feed.sig'), sigText as string);
    await writeWhole(path.join(channelDir, 'freshness.json'), freshnessText as string);
    return { dir: out, entries };
  } finally {
    await fsp.rm(stage, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Command line

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * The options of `feed:build …` (see the top of this file); relative paths are taken from INIT_CWD (where pnpm was run)
 * or `cwd`. @throws Error `USAGE: …`
 */
export function parseFeedBuildArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): BuildFeedOptions {
  const args = argv[0] === '--' ? argv.slice(1) : [...argv];
  const text = { type: 'string' } as const;
  let values: Record<string, string | string[] | undefined>;
  try {
    values = parseArgs({
      args,
      strict: true,
      allowPositionals: false,
      options: {
        zip: { type: 'string', multiple: true },
        channel: text,
        'base-url': text,
        out: text,
        'release-key': text,
        'timestamp-key': text,
        keyset: text,
        seq: text,
        'expires-in-days': text,
        'issued-at': text,
        'root-keys': text,
      },
    }).values;
  } catch (error) {
    throw new Error(`USAGE: ${messageOf(error)}`, { cause: error });
  }
  const base = env['INIT_CWD'] !== undefined && env['INIT_CWD'] !== '' ? env['INIT_CWD'] : cwd;
  const required = (name: string): string => {
    const value = values[name];
    if (typeof value !== 'string' || value === '') throw new Error(`USAGE: missing --${name}`);
    return value;
  };
  const whole = (name: string): number => {
    const value = required(name);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`USAGE: --${name} must be a whole number, not ${JSON.stringify(value)}`);
    return Number(value);
  };
  const file = (name: string): string => path.resolve(base, required(name));
  const zips = (values['zip'] as string[] | undefined) ?? [];
  if (zips.length === 0) throw new Error('USAGE: missing --zip (one or more release zips)');
  const options: BuildFeedOptions = {
    zips: zips.map((zip) => path.resolve(base, zip)),
    channel: required('channel') as FeedChannel,
    baseUrl: required('base-url'),
    out: file('out'),
    releaseKey: file('release-key'),
    timestampKey: file('timestamp-key'),
    keyset: file('keyset'),
    seq: whole('seq'),
    expiresInDays: whole('expires-in-days'),
  };
  const issuedAt = values['issued-at'];
  if (typeof issuedAt === 'string') {
    const ms = ISO_DATE_TIME.test(issuedAt) ? Date.parse(issuedAt) : Number.NaN;
    if (Number.isNaN(ms)) throw new Error(`USAGE: --issued-at must be an ISO 8601 date-time with a zone (2026-10-29T10:00:00Z), not ${JSON.stringify(issuedAt)}`);
    options.issuedAt = ms;
  }
  if (typeof values['root-keys'] === 'string') options.rootKeys = file('root-keys');
  return options;
}

const USAGE = [
  'Usage: pnpm --filter @altis/release feed:build --zip <altis-x.zip> [--zip …] --channel stable|beta --base-url <url>',
  '         --out <dir> --release-key <file> --timestamp-key <file> --keyset <file> --seq <n> --expires-in-days <1-14>',
  '         [--issued-at <ISO date-time, dev keys only>] [--root-keys <roots.json>]',
  '',
].join('\n');

async function main(argv: string[]): Promise<void> {
  let options: BuildFeedOptions;
  try {
    options = parseFeedBuildArgs(argv);
  } catch (error) {
    process.stderr.write(`${messageOf(error)}\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  const result = await buildFeed(options);
  process.stdout.write(
    [
      `feed ${options.channel} seq ${options.seq} → ${path.join(result.dir, options.channel)} (${FEED_FILES.join(', ')})`,
      ...result.entries.map((e) => `  ${e.version} (${e.releasedAt}) ${e.size} bytes sha256 ${e.sha256} → ${e.url}`),
      options.rootKeys === undefined ? '  packages not verified against root keys (no --root-keys)' : '  packages and feed verified with the root keys',
      '',
    ].join('\n'),
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`feed build failed: ${messageOf(error)}\n`);
    process.exitCode = 1;
  });
}
