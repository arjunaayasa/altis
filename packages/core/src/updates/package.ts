import { createHash } from 'node:crypto';
import {
  COMPLETE_FILE,
  KEYSET_MAX_FILE_BYTES,
  MANIFEST_FILE,
  RELEASE_TYP,
  SIGNATURE_FILE,
  parseKeysetDocs,
  parseStrictJson,
  resolveKeysetSources,
  validateManifest,
  verifyDetached,
  verifyReleaseWithRoots,
  type Envelope,
  type KeysetDoc,
  type KeysetSource,
  type ReleaseFile,
  type ReleaseManifest,
  type TrustedKey,
} from '@altis/crypto';
import { entryMatchesManifest, type FeedEntry } from '@altis/crypto/feed';
import {
  dataPath,
  fsyncDir,
  releaseStagingPath,
  removeTree,
  stagedReleaseFile,
  writeBytesAtomic,
  writeStreamAtomic,
  type DataPath,
} from '@altis/platform';
import { DomainError, isDomainError, isSemver } from '@altis/shared';
import { openArchive, type ArchiveEntry, type ArchiveReader } from '../archive/zip-reader.js';
import { bootProtocolRefusal } from './precheck.js';

// Release packages (spec §9.1, §9.6 "Verifikasi + ekstraksi dalam satu lintasan", §8.3; plan Task 21; preflight S10,
// 1D-19; Review Focus 3).
//
// A package is the release zip (`pnpm release`): root files (app.js, package.json, …) and one release folder,
// `bundled-release/<v>/` (server.mjs, public/…, keyset.json, manifest.json, manifest.sig, .complete). Only the folder
// counts here: a one-click update never replaces app.js, so the root files are ignored (their names are still checked
// by the guarded reader, so a hostile name refuses the whole package).
//
// - readPackageManifest reads only `bundled-release/<v>/{manifest.json, manifest.sig, keyset.json}`, bounded, and
//   verifies the signature over manifest.json's raw bytes first, with the keys app.js would trust: the embedded roots,
//   the installation's root-signed keyset documents (`sources`: DATA_DIR/releases/keyset.json, the installed releases)
//   and the package's own keyset.json, which counts only through root signatures. So a release key revoked in any of
//   them (Review Focus 3) signs nothing. A signed manifest declaring a bootProtocol other than this app.js's is a
//   precheck refusal with the manual zip upgrade, not a broken package (S10).
// - extractVerifiedRelease does it all in one pass over the zip: the manifest first; then exactly the files it lists,
//   each streamed into `releases/.tmp-<v>-<opId>/release/` (stagedReleaseFile) through a hidden temporary sibling,
//   hashed while it is written and refused before it is renamed into place when its bytes differ; the guarded reader
//   bounds every entry by its declared size, which must be the manifest's, and refuses a deflate ratio above 10×.
//   Then the folders are fsynced, `.complete` is written, and verifyReleaseWithRoots (`check: 'all'`) checks the
//   folder the way app.js and doctor will. A previous attempt's folder (a killed process, P7) is removed first, so
//   the step runs again from the start; on any failure the staging folder goes.
//
// Refusals are UPDATE_PACKAGE_INVALID (422) with `meta.reason`:
//   entry      a name that leaves the folder, a file under the release folder the manifest does not list, a listed
//              file missing from the zip, a second release folder, a path a release folder cannot hold;
//   hash       a file whose size or SHA-256 differs from the manifest's (CRC-32 and truncation included);
//   bomb       a deflate entry declaring more than 10 times its compressed size, overlapping entries;
//   signature  manifest.sig missing or not a valid `altis-release/1` signature by a trusted release key;
//   manifest   no release folder or manifest, an unreadable zip, a signed manifest that is not valid;
//   keyset     the package's keyset.json missing or not in the keyset file format;
//   version    the release folder is not the manifest's version, or not the version expected;
//   mismatch   the manifest differs from the feed entry it was downloaded for (`meta.field`, entryMatchesManifest).

/** The folder of a package that holds its release: `bundled-release/<v>/`. */
export const PACKAGE_RELEASE_DIR = 'bundled-release';

/** The longest manifest.json read (the crypto reader's own bound). */
const MANIFEST_MAX_BYTES = 16 * 1024 * 1024;
/** The longest manifest.sig read (an envelope is about 200 bytes). */
const SIGNATURE_MAX_BYTES = 64 * 1024;
/** Every name is allowed by the reader's allowlist: the package's layout is checked here. */
const ANY_NAME = /^/;

type PackageReason = 'entry' | 'hash' | 'bomb' | 'signature' | 'manifest' | 'keyset' | 'version' | 'mismatch';

function refused(reason: PackageReason, detail: string, extra: Record<string, unknown>, cause: unknown): DomainError {
  return new DomainError('UPDATE_PACKAGE_INVALID', {
    detail,
    meta: { reason, ...extra },
    ...(cause === undefined ? {} : { cause }),
  });
}

/** UPDATE_PACKAGE_INVALID `reason`, its detail `id` in Indonesian and `en` in English. */
function invalid(reason: PackageReason, id: string, en: string, extra: Record<string, unknown> = {}, cause?: unknown): DomainError {
  return refused(reason, `Paket pembaruan ditolak: ${id} / The update package is refused: ${en}`, extra, cause);
}

/** A name for messages: JSON-quoted and bounded. */
function shown(name: string): string {
  const text = JSON.stringify(name);
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The guarded reader's BACKUP_INVALID as UPDATE_PACKAGE_INVALID: a name (`path`, `entry`) → `entry`; `bomb` → `bomb`;
 * the data of an entry (`checksum`, or `format` while reading: truncated, unreadable) → `hash`; the archive itself
 * (`format` while opening: not a zip, encrypted, an unknown method) → `manifest`. Anything else as it is.
 */
function fromReader(error: unknown, phase: 'open' | 'read'): unknown {
  if (!isDomainError(error) || error.code !== 'BACKUP_INVALID') return error;
  const reason = error.meta?.['reason'];
  // The reader's own detail is bilingual already: it is kept whole, once.
  const detail = `Paket pembaruan ditolak / The update package is refused. ${error.detail ?? error.message}`;
  if (reason === 'path' || reason === 'entry') return refused('entry', detail, {}, error);
  if (reason === 'bomb') return refused('bomb', detail, {}, error);
  if (reason === 'checksum' || phase === 'read') return refused('hash', detail, {}, error);
  return refused('manifest', detail, {}, error);
}

async function openPackage(zip: DataPath): Promise<ArchiveReader> {
  try {
    return await openArchive(zip, { allow: ANY_NAME });
  } catch (error) {
    throw fromReader(error, 'open');
  }
}

/** The whole entry `e`, refused with `reason` when it declares more than `max` bytes. */
async function readWhole(reader: ArchiveReader, e: ArchiveEntry, max: number, reason: PackageReason): Promise<Buffer> {
  if (e.size > max) throw invalid(reason, `${shown(e.name)} lebih dari ${max} byte`, `${shown(e.name)} is over ${max} bytes`);
  const chunks: Uint8Array[] = [];
  try {
    for await (const chunk of reader.read(e)) chunks.push(chunk);
  } catch (error) {
    throw fromReader(error, 'read');
  }
  return Buffer.concat(chunks);
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });

/** What one read of a package's release folder found. */
interface PackageRelease {
  manifest: ReleaseManifest;
  /** The release folder's version, `<v>` of `bundled-release/<v>/`. */
  version: string;
  /** manifest.json and manifest.sig as the zip holds them. */
  manifestBytes: Buffer;
  sigBytes: Buffer;
  /** Every entry of the release folder by its path inside it. */
  files: Map<string, ArchiveEntry>;
}

interface PackageKeys {
  /** The root keys the build embeds. */
  roots: readonly TrustedKey[];
  /** Root-signed keyset documents kept elsewhere: DATA_DIR/releases/keyset.json, the installed releases (R65a). */
  sources: readonly KeysetSource[];
  /** Production builds: documents that trust a `dev-` kid count for nothing (R65b). */
  refuseDevKids: boolean;
}

/** The release folder of the package `reader` reads, and its verified manifest (see the module comment). */
async function readRelease(reader: ArchiveReader, o: PackageKeys): Promise<PackageRelease> {
  const prefix = `${PACKAGE_RELEASE_DIR}/`;
  let version: string | null = null;
  const files = new Map<string, ArchiveEntry>();
  for (const e of reader.entries()) {
    if (!e.name.startsWith(prefix)) continue; // a root file (or another folder): never extracted
    const rest = e.name.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash <= 0) throw invalid('entry', `${shown(e.name)} tidak berada di folder rilis`, `${shown(e.name)} is not inside a release folder`);
    const folder = rest.slice(0, slash);
    if (version === null) version = folder;
    else if (folder !== version) {
      throw invalid('entry', `paket memuat lebih dari satu rilis (${shown(version)}, ${shown(folder)})`, `the package holds more than one release`);
    }
    files.set(rest.slice(slash + 1), e);
  }
  if (version === null) throw invalid('manifest', `tidak ada folder ${prefix}<versi>`, `there is no ${prefix}<version> folder`);
  if (!isSemver(version)) throw invalid('entry', `folder rilis ${shown(version)} bukan versi SemVer`, `the release folder ${shown(version)} is not a SemVer version`);

  const manifestEntry = files.get(MANIFEST_FILE);
  if (manifestEntry === undefined) throw invalid('manifest', `${MANIFEST_FILE} tidak ada`, `${MANIFEST_FILE} is missing`);
  const sigEntry = files.get(SIGNATURE_FILE);
  if (sigEntry === undefined) throw invalid('signature', `${SIGNATURE_FILE} tidak ada`, `${SIGNATURE_FILE} is missing`);
  const keysetEntry = files.get('keyset.json');
  if (keysetEntry === undefined) throw invalid('keyset', 'keyset.json tidak ada', 'keyset.json is missing');

  const manifestBytes = await readWhole(reader, manifestEntry, MANIFEST_MAX_BYTES, 'manifest');
  const sigBytes = await readWhole(reader, sigEntry, SIGNATURE_MAX_BYTES, 'signature');
  const keysetBytes = await readWhole(reader, keysetEntry, KEYSET_MAX_FILE_BYTES, 'keyset');

  let shipped: KeysetDoc[];
  try {
    shipped = parseKeysetDocs(parseStrictJson(UTF8.decode(keysetBytes)));
  } catch (error) {
    throw invalid('keyset', `keyset.json tidak terbaca (${messageOf(error)})`, `keyset.json cannot be read (${messageOf(error)})`, {}, error);
  }
  let env: Envelope;
  try {
    env = parseStrictJson(UTF8.decode(sigBytes)) as Envelope;
  } catch (error) {
    throw invalid('signature', `${SIGNATURE_FILE} bukan JSON`, `${SIGNATURE_FILE} is not JSON`, {}, error);
  }
  let manifestText: string;
  try {
    manifestText = UTF8.decode(manifestBytes);
  } catch (error) {
    throw invalid('manifest', `${MANIFEST_FILE} bukan UTF-8`, `${MANIFEST_FILE} is not UTF-8`, {}, error);
  }

  // The keys app.js would trust: the roots, the documents kept elsewhere, the package's own (root-signed only).
  const report = resolveKeysetSources(o.roots.slice(), [...o.sources, { name: `package:${PACKAGE_RELEASE_DIR}/${version}/keyset.json`, docs: shipped }], {
    refuseDevKids: o.refuseDevKids,
  });
  let payload: unknown;
  try {
    payload = verifyDetached(manifestText, env, report.keys, RELEASE_TYP);
  } catch (error) {
    const why = messageOf(error);
    if (why === 'SIG_INVALID:payload') throw invalid('manifest', `${MANIFEST_FILE} bukan JSON yang ketat`, `${MANIFEST_FILE} is not strict JSON`, {}, error);
    throw invalid('signature', `tanda tangan manifest tidak sah (${why})`, `the manifest signature is not valid (${why})`, {}, error);
  }

  // Signed: a release for another app.js contract is a precheck refusal with the manual upgrade (S10, 1D-19).
  if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
    const declared = (payload as Record<string, unknown>)['bootProtocol'];
    if (typeof declared === 'number' && Number.isSafeInteger(declared) && declared !== 1) {
      const named = (payload as Record<string, unknown>)['version'];
      throw bootProtocolRefusal(typeof named === 'string' && isSemver(named) ? named : version, declared);
    }
  }
  let manifest: ReleaseManifest;
  try {
    manifest = validateManifest(payload);
  } catch (error) {
    const field = messageOf(error).replace(/^MANIFEST_INVALID:/, '');
    throw invalid('manifest', `manifest tidak sah (${field})`, `the manifest is not valid (${field})`, { field }, error);
  }
  if (manifest.version !== version) {
    throw invalid('version', `folder ${shown(version)} memuat rilis ${manifest.version}`, `the folder ${shown(version)} holds release ${manifest.version}`);
  }
  return { manifest, version, manifestBytes, sigBytes, files };
}

/**
 * The verified manifest of the release package `zip` (see the module comment): only
 * `bundled-release/<v>/{manifest.json, manifest.sig, keyset.json}` are read, the signature is verified over the raw
 * bytes first, and nothing is written.
 *
 * @throws DomainError `UPDATE_PACKAGE_INVALID` reason `manifest`, `signature`, `keyset`, `entry`, `bomb`, `hash` or
 *   `version`; `UPDATE_PRECHECK_FAILED` reason `boot_protocol` (with the manual zip upgrade) for a signed manifest
 *   declaring another bootProtocol; the open error of the file (ENOENT, …) as it is
 */
export async function readPackageManifest(zip: DataPath, o: PackageKeys): Promise<ReleaseManifest> {
  const reader = await openPackage(zip);
  try {
    return (await readRelease(reader, o)).manifest;
  } finally {
    await reader.close();
  }
}

export interface ExtractReleaseOptions extends PackageKeys {
  /** The package (the update op keeps it as `releases/.tmp-<v>-<opId>/package.zip`). */
  zip: DataPath;
  /** The version expected: the feed entry's, or the uploaded manifest's. */
  version: string;
  /** The update op: its staging folder is `releases/.tmp-<version>-<opId>/`. */
  opId: string;
  dataDir: string;
  /** The feed entry the package was downloaded for, whose values must equal the manifest's (§9.6); null offline. */
  expect: FeedEntry | null;
}

/** `releases/.tmp-<v>-<opId>/release/<relPath>`; a path a release folder cannot hold is refused as `entry`. */
function stagedPath(o: ExtractReleaseOptions, relPath: string): DataPath {
  try {
    return stagedReleaseFile(o.dataDir, o.version, o.opId, relPath);
  } catch (error) {
    if (isDomainError(error) && error.code === 'INVALID_PATH_SEGMENT') {
      throw invalid('entry', `${shown(relPath)} tidak dapat disimpan di folder rilis`, `${shown(relPath)} cannot be kept in a release folder`, {}, error);
    }
    throw error;
  }
}

/** A copy of `chunk` (file bytes from `start`) with the bytes inside `ranges` set to zero: the watermark rule (§8.3). */
function zeroed(chunk: Uint8Array, start: number, ranges: readonly { offset: number; length: number }[]): Uint8Array {
  const end = start + chunk.byteLength;
  let copy: Buffer | null = null;
  for (const r of ranges) {
    const from = Math.max(r.offset, start) - start;
    const to = Math.min(r.offset + r.length, end) - start;
    if (from >= to) continue;
    copy ??= Buffer.from(chunk);
    copy.fill(0, from, to);
  }
  return copy ?? chunk;
}

/**
 * The bytes of `e` for writeStreamAtomic, hashed on their way: more bytes than the manifest's size, or a different
 * SHA-256 at the end, throw `hash` before the consumer renames the file into place.
 */
async function* hashed(reader: ArchiveReader, e: ArchiveEntry, file: ReleaseFile): AsyncGenerator<Uint8Array, void, undefined> {
  const hash = createHash('sha256');
  const ranges = file.wm ?? [];
  let at = 0;
  try {
    for await (const chunk of reader.read(e)) {
      if (at + chunk.byteLength > file.size) throw invalid('hash', `${shown(file.path)} lebih besar dari manifest`, `${shown(file.path)} is larger than the manifest says`);
      hash.update(ranges.length === 0 ? chunk : zeroed(chunk, at, ranges));
      at += chunk.byteLength;
      yield chunk;
    }
  } catch (error) {
    throw fromReader(error, 'read');
  }
  if (at !== file.size || hash.digest('hex') !== file.sha256) {
    throw invalid('hash', `isi ${shown(file.path)} tidak cocok dengan manifest`, `the content of ${shown(file.path)} does not match the manifest`, { path: file.path });
  }
}

/** The folders of `paths` (`public/admin/assets`, `public/admin`, `public`), deepest first. */
function foldersOf(paths: readonly string[]): string[] {
  const folders = new Set<string>();
  for (const p of paths) {
    const parts = p.split('/');
    for (let n = parts.length - 1; n > 0; n -= 1) folders.add(parts.slice(0, n).join('/'));
  }
  return [...folders].sort((a, b) => b.split('/').length - a.split('/').length || (a < b ? -1 : a > b ? 1 : 0));
}

/** verifyReleaseWithRoots' `RELEASE_INVALID:<reason>[:<path>]` as UPDATE_PACKAGE_INVALID. */
function fromRelease(error: unknown): unknown {
  const message = messageOf(error);
  if (!(error instanceof Error) || !message.startsWith('RELEASE_INVALID:')) return error;
  const what = message.slice('RELEASE_INVALID:'.length);
  const kind = what.split(':')[0];
  const reason: PackageReason =
    kind === 'signature' ? 'signature' : kind === 'keyset' ? 'keyset' : kind === 'missing' || kind === 'extra' ? 'entry' : kind === 'wm' ? 'manifest' : 'hash';
  return invalid(reason, `rilis yang diekstrak tidak lolos verifikasi (${what})`, `the extracted release fails verification (${what})`, {}, error);
}

/**
 * Verifies the release package `o.zip` and extracts its release into `releases/.tmp-<version>-<opId>/release/`, in one
 * pass (see the module comment): the manifest first (as readPackageManifest), the folder's version is `o.version`, the
 * manifest equals `o.expect` when given; then only the listed files, hashed while written, bounded by their manifest
 * sizes and a deflate ratio of 10×; the zip's root files and its own `.complete` are ignored; then fsync, `.complete`
 * and verifyReleaseWithRoots (`check: 'all'`). Runs again from the start after a killed attempt: what that attempt
 * left in the folder is removed first. On any failure the staging folder `releases/.tmp-<version>-<opId>/` is removed,
 * the package in it included.
 *
 * @returns the verified manifest
 * @throws DomainError `UPDATE_PACKAGE_INVALID` reason `entry`, `hash`, `bomb`, `signature`, `manifest`, `keyset`,
 *   `version` or `mismatch` (`meta.field`); `UPDATE_PRECHECK_FAILED` reason `boot_protocol`; `DISK_QUOTA` (P21); the
 *   I/O error of the file system as it is
 */
export async function extractVerifiedRelease(o: ExtractReleaseOptions): Promise<ReleaseManifest> {
  const staging = releaseStagingPath(o.dataDir, o.version, o.opId);
  const target = releaseStagingPath(o.dataDir, o.version, o.opId, 'release');
  try {
    await removeTree(target); // a killed attempt's files (P7)
    const reader = await openPackage(o.zip);
    let manifest: ReleaseManifest;
    try {
      const found = await readRelease(reader, o);
      manifest = found.manifest;
      if (manifest.version !== o.version) {
        throw invalid('version', `paket berisi rilis ${manifest.version}, bukan ${o.version}`, `the package holds release ${manifest.version}, not ${o.version}`, {
          found: manifest.version,
        });
      }
      if (o.expect !== null) {
        const field = entryMatchesManifest(o.expect, manifest);
        if (field !== null) {
          throw invalid('mismatch', `${field} berbeda dari feed`, `${field} differs from the feed`, { field });
        }
      }

      // The plan: every file of the release folder is listed (or is manifest.json, manifest.sig, .complete), and every
      // listed file is in the zip with the manifest's size, at a path a release folder can hold.
      const listed = new Map(manifest.files.map((f) => [f.path, f]));
      for (const rel of found.files.keys()) {
        if (rel === MANIFEST_FILE || rel === SIGNATURE_FILE || rel === COMPLETE_FILE) continue;
        if (!listed.has(rel)) throw invalid('entry', `${shown(rel)} tidak ada di manifest`, `${shown(rel)} is not in the manifest`, { path: rel });
      }
      const plan: { file: ReleaseFile; entry: ArchiveEntry; dest: DataPath }[] = [];
      for (const file of manifest.files) {
        const entry = found.files.get(file.path);
        if (entry === undefined) throw invalid('entry', `${shown(file.path)} tidak ada di paket`, `${shown(file.path)} is missing from the package`, { path: file.path });
        if (entry.size !== file.size) {
          throw invalid('hash', `ukuran ${shown(file.path)} tidak cocok dengan manifest`, `the size of ${shown(file.path)} does not match the manifest`, { path: file.path });
        }
        plan.push({ file, entry, dest: stagedPath(o, file.path) });
      }
      const manifestDest = stagedPath(o, MANIFEST_FILE);
      const sigDest = stagedPath(o, SIGNATURE_FILE);

      for (const step of plan) await writeStreamAtomic(step.dest, hashed(reader, step.entry, step.file));
      await writeBytesAtomic(manifestDest, found.manifestBytes);
      await writeBytesAtomic(sigDest, found.sigBytes);
    } finally {
      await reader.close();
    }

    // Every file was fsynced with its own folder; the folders themselves are made durable before `.complete`.
    for (const folder of foldersOf(manifest.files.map((f) => f.path))) await fsyncDir(stagedPath(o, folder));
    await fsyncDir(target);
    await writeBytesAtomic(stagedPath(o, COMPLETE_FILE), '');
    await fsyncDir(staging);
    await fsyncDir(dataPath(o.dataDir, 'releases'));

    try {
      return await verifyReleaseWithRoots(target, o.roots.slice(), { check: 'all', sources: o.sources.slice(), refuseDevKids: o.refuseDevKids });
    } catch (error) {
      throw fromRelease(error);
    }
  } catch (error) {
    await removeTree(staging).catch(() => undefined);
    throw error;
  }
}
