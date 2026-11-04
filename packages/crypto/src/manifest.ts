/**
 * Release manifest (spec §8.3, §9.1): the signed list of every file in a release directory, and the check
 * that a directory on disk is that release.
 *
 * `manifest.json` is the manifest; `manifest.sig` is the JSON envelope `{typ: 'altis-release/1', kid, alg,
 * sig}` over it, made by a `release` key (see {@link signDetached}). `keyset.json` holds the root-signed keyset
 * documents the release ships (listed in the manifest like any file). `.complete` marks a directory whose
 * extraction finished. {@link verifyRelease} takes already resolved keys; {@link verifyReleaseWithRoots} resolves
 * them the way app.js does (ruling R65): from the embedded root keys and root-signed documents only, so the keys a
 * release ships count only through a root signature.
 *
 * Verification is not atomic with the later `import()`: whoever can write to the release directory can
 * swap a file after it was checked. The release directory therefore has to be writable only by the
 * account that runs ALTIS.
 *
 * Bundled into the ES2017 bootloader: keep the syntax plain; the only imports are node built-ins and
 * sibling modules of this package.
 */
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import fsp, { type FileHandle } from 'node:fs/promises';
import nodePath from 'node:path';
import { verifyDetached, type Envelope } from './envelope.js';
import { OPEN_READ_FLAGS, errorCode, readBoundedText } from './files.js';
import type { TrustedKey } from './keys.js';
import { resolveKeysetSources, resolveTrustedKeys, type KeysetDoc, type KeysetReport, type KeysetSource } from './keyset.js';
import { KEYSET_FILE, readKeysetFile } from './keyset-file.js';
import { isSemverText } from './semver.js';
import { parseStrictJson } from './strict-json.js';

/** `typ` of the manifest envelope; signed by a `release` key. */
export const RELEASE_TYP = 'altis-release/1';
export const MANIFEST_FILE = 'manifest.json';
export const SIGNATURE_FILE = 'manifest.sig';
export const COMPLETE_FILE = '.complete';

/** Files in the release root that are not listed in the manifest. */
const UNLISTED_ROOT_FILES = [MANIFEST_FILE, SIGNATURE_FILE, COMPLETE_FILE];

/** The file {@link verifyRelease} checks by default under `check: 'executed'`. */
const DEFAULT_EXECUTED = ['server.mjs'];

/** One of the reserved watermark ranges (the frozen `wm` field): bytes zero-filled before hashing. */
export type WatermarkRange = { offset: number; length: number };

export type ReleaseFile = { path: string; sha256: string; size: number; wm?: WatermarkRange[] };

export type ReleaseManifest = {
  version: string;
  buildId: string;
  bootProtocol: 1;
  releasedAt: string; // YYYY-MM-DD
  schemaLatest: string;
  minCodeVersionAfter: string;
  minUpgradeFrom: string;
  minNode: string;
  minDb: { mysql: string; mariadb: string; postgres: string };
  /** Sorted by path (UTF-16 code units); never lists the files of {@link UNLISTED_ROOT_FILES}. */
  files: ReleaseFile[];
};

export type BuildManifestOptions = {
  /** Watermark ranges by POSIX path; sorted, non-overlapping and inside the file. */
  wm?: Record<string, WatermarkRange[]>;
};

export type VerifyReleaseOptions = {
  /** `executed`: signature plus the hash of the `executed` files. `all`: every listed file, and no extra file. */
  check: 'executed' | 'all';
  /** Files the bootloader will execute; default `['server.mjs']`. */
  executed?: string[];
};

export type VerifyReleaseWithRootsOptions = VerifyReleaseOptions & {
  /**
   * Root-signed keyset documents kept outside the release: for app.js and doctor, every keyset.json of the
   * installation (`collectInstalledKeysets`, ruling R65a). Default: none (a fresh install, as the release build checks
   * it).
   */
  sources?: KeysetSource[];
  /** Production builds: reject every document that adds a `dev-` kid (ruling R65b; see resolveTrustedKeys). */
  refuseDevKids?: boolean;
  /**
   * Called once the keys are resolved, before the manifest is checked (so also when that check then fails), with the
   * resolution: the release's own documents are the last source, named `release`.
   */
  onResolved?: (report: KeysetReport) => void;
};

// ---------------------------------------------------------------------------------------------------------
// Validation

function bad(field: string): never {
  throw new TypeError('MANIFEST_INVALID:' + field);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isCalendarDate(value: unknown): boolean {
  const m = typeof value === 'string' ? DATE.exec(value) : null;
  if (m === null) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day); // Date.UTC would map years 0-99 to 1900-1999
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

const MAX_PATH_LENGTH = 1024;

/** Characters that no release path may contain: controls, and those that are special on POSIX or Windows. */
function hasUnsafeCharacter(path: string): boolean {
  for (let i = 0; i < path.length; i++) {
    const c = path.charCodeAt(i);
    if (c < 0x20 || c === 0x7f || '\\:*?"<>|'.indexOf(path.charAt(i)) !== -1) return true;
  }
  return false;
}

/** A relative POSIX path of plain segments: no `.`/`..`, no empty segment, no backslash, drive or wildcard. */
function isReleasePath(path: unknown): path is string {
  if (typeof path !== 'string' || path === '' || path.length > MAX_PATH_LENGTH || hasUnsafeCharacter(path)) {
    return false;
  }
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/**
 * Checks `wm` against a file of `size` bytes: sorted, non-overlapping, non-empty ranges inside the file.
 * Returns copies holding `offset` and `length` only; other properties of a range are ignored (R12b).
 */
function validateRanges(wm: unknown, size: number, at: string): WatermarkRange[] {
  if (!Array.isArray(wm)) return bad(at);
  const ranges: WatermarkRange[] = [];
  let end = 0;
  for (let i = 0; i < wm.length; i++) {
    const here = at + '[' + i + ']';
    const range: unknown = wm[i];
    if (!isRecord(range)) return bad(here);
    const offset = range['offset'];
    const length = range['length'];
    if (!isNonNegativeInteger(offset) || !isNonNegativeInteger(length) || length < 1) return bad(here);
    if (offset < end || offset + length > size) return bad(here);
    end = offset + length;
    ranges.push({ offset, length });
  }
  return ranges;
}

const DB_FIELDS = ['mysql', 'mariadb', 'postgres'];

function validateMeta(value: Record<string, unknown>): Omit<ReleaseManifest, 'files'> {
  const version = value['version'];
  if (!isSemverText(version)) return bad('version');
  if (!isNonEmptyString(value['buildId'])) return bad('buildId');
  if (value['bootProtocol'] !== 1) return bad('bootProtocol');
  const releasedAt = value['releasedAt'];
  if (!isCalendarDate(releasedAt) || typeof releasedAt !== 'string') return bad('releasedAt');
  for (const field of ['schemaLatest', 'minCodeVersionAfter', 'minUpgradeFrom', 'minNode']) {
    if (!isNonEmptyString(value[field])) return bad(field);
  }
  const minDb = value['minDb'];
  if (!isRecord(minDb)) return bad('minDb');
  for (const field of DB_FIELDS) if (!isNonEmptyString(minDb[field])) return bad('minDb.' + field);
  return {
    version,
    buildId: value['buildId'] as string,
    bootProtocol: 1,
    releasedAt,
    schemaLatest: value['schemaLatest'] as string,
    minCodeVersionAfter: value['minCodeVersionAfter'] as string,
    minUpgradeFrom: value['minUpgradeFrom'] as string,
    minNode: value['minNode'] as string,
    minDb: { mysql: minDb['mysql'] as string, mariadb: minDb['mariadb'] as string, postgres: minDb['postgres'] as string },
  };
}

/**
 * Checks that `value` has every field of a {@link ReleaseManifest}, valid, and returns a fresh copy that
 * holds those fields only. Throws `TypeError('MANIFEST_INVALID:<field>')`, where `<field>` is `version`,
 * `minDb.postgres`, `files[3].sha256`, `files[3].wm[1]` and so on.
 *
 * Forward compatible (R12, R12b): properties that this version does not know are ignored, in the manifest,
 * in `minDb`, in file entries and in `wm` ranges, and are left out of the copy. The signature still covers
 * them, so they cannot be changed after signing. `app.js` is frozen after the first public release, so a
 * future manifest may gain fields without breaking updates. Only `bootProtocol` is strict: it must be 1.
 *
 * What is checked:
 * - `version` is SemVer, `releasedAt` a real calendar date, `bootProtocol` is 1, the other metadata fields
 *   and the three `minDb` values are non-empty strings;
 * - `sha256` is 64 lower-case hex digits; `size` a non-negative integer;
 * - paths are plain relative POSIX paths, never `manifest.json`/`manifest.sig`/`.complete` in the root,
 *   and unique even when compared case-insensitively;
 * - `wm`, when present, is a list of ranges that are sorted, non-overlapping and inside the file.
 */
export function validateManifest(value: unknown): ReleaseManifest {
  if (!isRecord(value)) return bad('manifest');
  const meta = validateMeta(value);
  const list = value['files'];
  if (!Array.isArray(list)) return bad('files');

  const seen = new Set<string>();
  const files: ReleaseFile[] = [];
  for (let i = 0; i < list.length; i++) {
    const at = 'files[' + i + ']';
    const entry: unknown = list[i];
    if (!isRecord(entry)) return bad(at);
    const path = entry['path'];
    if (!isReleasePath(path)) return bad(at + '.path');
    const folded = path.toLowerCase();
    if (UNLISTED_ROOT_FILES.indexOf(folded) !== -1 || seen.has(folded)) return bad(at + '.path');
    seen.add(folded);
    const sha256 = entry['sha256'];
    if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) return bad(at + '.sha256');
    const size = entry['size'];
    if (!isNonNegativeInteger(size)) return bad(at + '.size');
    const file: ReleaseFile = { path, sha256, size };
    if (Object.prototype.hasOwnProperty.call(entry, 'wm')) file.wm = validateRanges(entry['wm'], size, at + '.wm');
    files.push(file);
  }
  return {
    version: meta.version,
    buildId: meta.buildId,
    bootProtocol: meta.bootProtocol,
    releasedAt: meta.releasedAt,
    schemaLatest: meta.schemaLatest,
    minCodeVersionAfter: meta.minCodeVersionAfter,
    minUpgradeFrom: meta.minUpgradeFrom,
    minNode: meta.minNode,
    minDb: meta.minDb,
    files,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Files

const READ_CHUNK_BYTES = 64 * 1024;

/** Longest manifest.json or manifest.sig that is read (a manifest of 100 000 files is about 20 MB; ours has ~10). */
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;

/** The name of the release's own keyset source in a {@link KeysetReport}. */
const OWN_KEYSET = 'release';

const byPath = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function absolutePath(dir: string, path: string): string {
  return nodePath.join(dir, ...path.split('/'));
}

/** Sets the bytes of `chunk` (which holds file bytes from `start`) that lie in a range to zero. */
function zeroRanges(chunk: Buffer, start: number, ranges: WatermarkRange[]): void {
  const end = start + chunk.length;
  for (const range of ranges) {
    const from = Math.max(range.offset, start) - start;
    const to = Math.min(range.offset + range.length, end) - start;
    if (from < to) chunk.fill(0, from, to);
  }
}

type FileState =
  | { state: 'missing' }
  | { state: 'not-regular' }
  | { state: 'ok'; sha256: string; size: number };

/**
 * SHA-256 and size of a regular file, with `ranges` read as zeros. A symbolic link or any other kind of
 * entry is reported as `not-regular`, never followed. `expectedSize` (when known) saves reading a file of
 * the wrong size: the result then has a size that differs from it and an empty hash.
 */
async function inspectFile(file: string, ranges: WatermarkRange[], expectedSize?: number): Promise<FileState> {
  let info: Stats;
  try {
    info = await fsp.lstat(file);
  } catch (err) {
    if (errorCode(err) === 'ENOENT' || errorCode(err) === 'ENOTDIR') return { state: 'missing' };
    throw err;
  }
  if (!info.isFile()) return { state: 'not-regular' };
  if (expectedSize !== undefined && info.size !== expectedSize) return { state: 'ok', sha256: '', size: info.size };

  let handle: FileHandle;
  try {
    handle = await fsp.open(file, OPEN_READ_FLAGS);
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return { state: 'missing' };
    if (errorCode(err) === 'ELOOP' || errorCode(err) === 'EMLINK') return { state: 'not-regular' };
    throw err;
  }
  try {
    if (!(await handle.stat()).isFile()) return { state: 'not-regular' };
    const hash = createHash('sha256');
    const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, READ_CHUNK_BYTES, position);
      if (bytesRead === 0) break;
      const data = chunk.subarray(0, bytesRead);
      zeroRanges(data, position, ranges);
      hash.update(data);
      position += bytesRead;
    }
    return { state: 'ok', sha256: hash.digest('hex'), size: position };
  } finally {
    await handle.close();
  }
}

type Listing = { files: string[]; others: string[] };

/** Every file under `dir` as a sorted POSIX path (minus the unlisted root files), and the non-regular entries. */
async function listDirectory(dir: string): Promise<Listing> {
  const listing: Listing = { files: [], others: [] };
  async function walk(abs: string, rel: string): Promise<void> {
    for (const entry of await fsp.readdir(abs, { withFileTypes: true })) {
      const childRel = rel === '' ? entry.name : rel + '/' + entry.name;
      if (rel === '' && UNLISTED_ROOT_FILES.indexOf(entry.name) !== -1) continue;
      if (entry.isDirectory()) await walk(nodePath.join(abs, entry.name), childRel);
      else if (entry.isFile()) listing.files.push(childRel);
      else listing.others.push(childRel);
    }
  }
  await walk(dir, '');
  listing.files.sort(byPath);
  listing.others.sort(byPath);
  return listing;
}

// ---------------------------------------------------------------------------------------------------------
// Build

/**
 * Builds the manifest of the files under `dir` (recursively; the root's `manifest.json`, `manifest.sig` and
 * `.complete` are left out), with `meta` as its other fields. Each file's hash is computed with its
 * `o.wm` ranges read as zeros. Throws `TypeError('MANIFEST_INVALID:<field>')` for invalid `meta` or ranges
 * (see {@link validateManifest}), `MANIFEST_INVALID:unsupported:<path>` for a symbolic link or other
 * non-regular entry, `MANIFEST_INVALID:path:<path>` for a file name that cannot be a release path, and
 * `MANIFEST_INVALID:wm:<path>` for ranges given for a file that is not there.
 */
export async function buildManifest(
  dir: string,
  meta: Omit<ReleaseManifest, 'files'>,
  o: BuildManifestOptions = {},
): Promise<ReleaseManifest> {
  if (!isRecord(meta)) return bad('meta');
  validateMeta(meta);
  const listing = await listDirectory(dir);
  if (listing.others.length > 0) return bad('unsupported:' + listing.others[0]);
  for (const path of listing.files) if (!isReleasePath(path)) return bad('path:' + path);
  const wm = o.wm === undefined ? {} : o.wm;
  for (const path of Object.keys(wm)) if (listing.files.indexOf(path) === -1) return bad('wm:' + path);

  const files: ReleaseFile[] = [];
  for (let i = 0; i < listing.files.length; i++) {
    const path = listing.files[i] as string;
    const file = absolutePath(dir, path);
    const ranges = Object.prototype.hasOwnProperty.call(wm, path) ? (wm[path] as WatermarkRange[]) : [];
    const size = (await fsp.stat(file)).size;
    const valid = validateRanges(ranges, size, 'files[' + i + '].wm');
    const result = await inspectFile(file, valid);
    if (result.state !== 'ok') return bad('unsupported:' + path);
    const entry: ReleaseFile = { path, sha256: result.sha256, size: result.size };
    if (valid.length > 0) entry.wm = valid;
    files.push(entry);
  }
  return validateManifest({
    version: meta.version,
    buildId: meta.buildId,
    bootProtocol: meta.bootProtocol,
    releasedAt: meta.releasedAt,
    schemaLatest: meta.schemaLatest,
    minCodeVersionAfter: meta.minCodeVersionAfter,
    minUpgradeFrom: meta.minUpgradeFrom,
    minNode: meta.minNode,
    minDb: meta.minDb,
    files,
  });
}

// ---------------------------------------------------------------------------------------------------------
// Verify

function fail(reason: string, cause?: unknown): never {
  throw cause === undefined
    ? new Error('RELEASE_INVALID:' + reason)
    : new Error('RELEASE_INVALID:' + reason, { cause });
}

/**
 * Reads manifest.json and manifest.sig (bounded, never through a symbolic link, never blocking on a FIFO), verifies
 * the signature with `trusted`, and validates the manifest.
 */
async function readSignedManifest(dir: string, trusted: TrustedKey[]): Promise<ReleaseManifest> {
  try {
    const raw = await readBoundedText(nodePath.join(dir, MANIFEST_FILE), MAX_MANIFEST_BYTES);
    const env = parseStrictJson(await readBoundedText(nodePath.join(dir, SIGNATURE_FILE), MAX_MANIFEST_BYTES)) as Envelope;
    return validateManifest(verifyDetached(raw, env, trusted, RELEASE_TYP));
  } catch (err) {
    return fail('signature', err);
  }
}

/** The `executed` files of `o`, after checking `dir` and `o`. @throws TypeError naming `caller` */
function checkedArguments(caller: string, dir: unknown, o: VerifyReleaseOptions): string[] {
  if (typeof dir !== 'string' || dir === '') throw new TypeError(caller + ': dir must be a non-empty string');
  if (o === null || typeof o !== 'object' || (o.check !== 'executed' && o.check !== 'all')) {
    throw new TypeError(caller + ": check must be 'executed' or 'all'");
  }
  const executed = o.executed === undefined ? DEFAULT_EXECUTED : o.executed;
  if (!Array.isArray(executed) || !executed.every(isReleasePath)) {
    throw new TypeError(caller + ': executed must be a list of release paths');
  }
  return executed;
}

async function requireComplete(dir: string): Promise<void> {
  let complete = false;
  try {
    complete = (await fsp.lstat(nodePath.join(dir, COMPLETE_FILE))).isFile();
  } catch (err) {
    if (errorCode(err) !== 'ENOENT' && errorCode(err) !== 'ENOTDIR') throw err;
  }
  if (!complete) fail('incomplete');
}

/** `missing` / `hash` failure of one listed file, or void when it matches. */
async function checkListedFile(dir: string, entry: ReleaseFile): Promise<void> {
  const ranges = entry.wm === undefined ? [] : entry.wm;
  const result = await inspectFile(absolutePath(dir, entry.path), ranges, entry.size);
  if (result.state === 'missing') fail('missing:' + entry.path);
  if (result.state === 'not-regular' || result.size !== entry.size || result.sha256 !== entry.sha256) {
    fail('hash:' + entry.path);
  }
}

/**
 * Verifies the release in `dir` against `trusted` (already resolved with `resolveTrustedKeys`) and returns
 * its manifest. Throws `Error('RELEASE_INVALID:<reason>')`; the first check that fails decides the reason:
 * 1. `incomplete`: `.complete` is not a regular file in `dir` (so also when `dir` does not exist);
 * 2. `signature`: manifest.json or manifest.sig is missing, unreadable, not strict JSON or too large; the
 *    envelope is not a valid `altis-release/1` signature by a trusted `release` key over manifest.json;
 *    or the signed manifest is not a valid {@link ReleaseManifest}. `cause` holds the detail;
 * 3. for each `executed` file, in the given order: `missing:<path>` if the manifest does not list it, and
 *    `wm:<path>` if its entry has watermark ranges (refused until watermarking is designed; the spec has
 *    `wm` empty in Phases 1-2, and an empty `wm` list is fine);
 * 4. only under `check: 'all'`, looking at the directory as a whole: `missing:<path>` for the first listed
 *    file (in path order) that is not there, then `extra:<path>` for the first file or symbolic link
 *    (in path order) that the manifest does not list; manifest.json, manifest.sig and .complete in the
 *    root are not counted;
 * 5. `hash:<path>` for a file whose size or SHA-256 (with the manifest's `wm` ranges read as zeros) differs,
 *    or that is not a regular file (a symbolic link is never followed); `missing:<path>` if it vanished
 *    meanwhile. The `executed` files come first, in the given order, then (under `all`) every other listed
 *    file; each file is read once.
 *
 * `check: 'executed'` therefore stops after the signature and the `executed` files (default
 * `['server.mjs']`); other files, missing, extra or modified, go unnoticed. A programming error (`o` or
 * an `executed` path is not valid) is a TypeError; an I/O error other than not-found is rethrown as it is.
 */
export async function verifyRelease(
  dir: string,
  trusted: TrustedKey[],
  o: VerifyReleaseOptions,
): Promise<ReleaseManifest> {
  const executed = checkedArguments('verifyRelease', dir, o);
  await requireComplete(dir);
  const manifest = await readSignedManifest(dir, trusted);
  const listed = new Map<string, ReleaseFile>();
  for (const entry of manifest.files) listed.set(entry.path, entry);

  const executedEntries: ReleaseFile[] = [];
  for (const path of executed) {
    const entry = listed.get(path);
    if (entry === undefined) fail('missing:' + path);
    if (entry.wm !== undefined && entry.wm.length > 0) fail('wm:' + path);
    executedEntries.push(entry);
  }

  if (o.check === 'all') {
    const onDisk = await listDirectory(dir);
    const everything = onDisk.files.concat(onDisk.others).sort(byPath);
    const present = new Set(everything);
    for (const entry of manifest.files) if (!present.has(entry.path)) fail('missing:' + entry.path);
    const extra = everything.find((path) => !listed.has(path));
    if (extra !== undefined) fail('extra:' + extra);
  }

  const checked = new Set<string>();
  const check = async (entry: ReleaseFile): Promise<void> => {
    if (checked.has(entry.path)) return;
    checked.add(entry.path);
    await checkListedFile(dir, entry);
  };
  for (const entry of executedEntries) await check(entry);
  if (o.check === 'all') for (const entry of manifest.files) await check(entry);
  return manifest;
}

/**
 * The keyset documents the release in `dir` ships: `<dir>/keyset.json` ({@link readKeysetFile}: a JSON array in the
 * frozen format, never read through a symbolic link, never blocking). What they say counts only through root
 * signatures ({@link resolveTrustedKeys}).
 *
 * @throws Error `RELEASE_INVALID:keyset` when the file is missing, unreadable or not in the format (`cause` holds the
 *   detail)
 */
export async function readReleaseKeyset(dir: string): Promise<KeysetDoc[]> {
  let docs: KeysetDoc[] | null;
  try {
    docs = await readKeysetFile(nodePath.join(dir, KEYSET_FILE));
  } catch (err) {
    return fail('keyset', err);
  }
  if (docs === null) return fail('keyset', new Error('missing: ' + KEYSET_FILE));
  return docs;
}

/**
 * Verifies the release in `dir` with the keys app.js trusts for it (spec §8.3, §9.2, ruling R65) and returns its
 * manifest: the `roots` a build embeds, plus every key that root-signed keyset documents add, those of `o.sources`
 * and those the release ships in keyset.json, minus every kid they revoke ({@link resolveKeysetSources}); then
 * {@link verifyRelease} with those keys. A release cannot vouch for itself: what it ships counts only through a root
 * signature. app.js (`check: 'executed'`), doctor and the release build (`check: 'all'`) all verify through here.
 *
 * Throws `Error('RELEASE_INVALID:<reason>')`: `incomplete` first (as {@link verifyRelease}), then `keyset` (see
 * {@link readReleaseKeyset}), then the reasons of {@link verifyRelease}. A TypeError for invalid arguments or roots.
 */
export async function verifyReleaseWithRoots(
  dir: string,
  roots: TrustedKey[],
  o: VerifyReleaseWithRootsOptions,
): Promise<ReleaseManifest> {
  checkedArguments('verifyReleaseWithRoots', dir, o);
  const sources = o.sources === undefined ? [] : o.sources;
  if (!Array.isArray(sources)) throw new TypeError('verifyReleaseWithRoots: sources must be an array');
  resolveTrustedKeys(roots, []); // invalid roots are a programming error: refuse them (TypeError) before any I/O

  await requireComplete(dir);
  const shipped: KeysetSource = { name: OWN_KEYSET, docs: await readReleaseKeyset(dir) };
  const report = resolveKeysetSources(roots, sources.concat([shipped]), { refuseDevKids: o.refuseDevKids === true });
  if (o.onResolved !== undefined) o.onResolved(report);
  const options: VerifyReleaseOptions = { check: o.check };
  if (o.executed !== undefined) options.executed = o.executed;
  return verifyRelease(dir, report.keys, options);
}
