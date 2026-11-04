/**
 * keyset.json files (spec §8.3, rulings R65a and R65c): reading one in the frozen format, and gathering every
 * root-signed document an installation holds, the same way for app.js and doctor.
 *
 * Gathering more documents is always safe: only root-signed documents count, and revocation only grows. So app.js
 * and doctor resolve with the union of every keyset.json they can see, and a revocation survives as long as any one
 * copy of it does: DATA_DIR/releases/keyset.json and its `.bak` (both, not one or the other), the keyset.json of every
 * bundled release next to app.js (outside DATA_DIR: read-only in Docker), and that of every release current.json names.
 *
 * Bundled into the ES2017 bootloader: keep the syntax plain; node built-ins and sibling modules only.
 */
import fsp from 'node:fs/promises';
import nodePath from 'node:path';
import { errorCode, readBoundedText } from './files.js';
import { parseKeysetDocs, type KeysetDoc, type KeysetSource } from './keyset.js';
import { isSemverText } from './semver.js';
import { parseStrictJson } from './strict-json.js';

/** The root-signed keyset documents a release ships (spec §9.1), and the name of DATA_DIR's copy. */
export const KEYSET_FILE = 'keyset.json';
/** Largest keyset.json read (ruling R65c; room for the 1d append-only writer). */
export const KEYSET_MAX_FILE_BYTES = 8 * 1024 * 1024;
/** The folder next to app.js that holds the bundled releases (spec §9.1). */
const BUNDLED_DIR = 'bundled-release';

const INVALID = 'KEYSET_FILE_INVALID';

/** A keyset.json that could not be used, and why. */
export type KeysetSkip = { name: string; error: unknown };

/** What {@link readKeysetWithBak} and {@link collectInstalledKeysets} found. */
export type CollectedKeysets = { sources: KeysetSource[]; skipped: KeysetSkip[] };

function invalidFile(file: string, cause: unknown): Error {
  return new Error(INVALID + ': ' + nodePath.basename(file), { cause });
}

/** True for the error {@link readKeysetFile} throws for a file that exists but cannot be used. */
export function isInvalidKeysetFile(error: unknown): boolean {
  return error instanceof Error && error.message.indexOf(INVALID + ':') === 0;
}

/**
 * The documents of the keyset.json `file` (see {@link parseKeysetDocs} for the format), or null when there is no such
 * file. Read through one descriptor, never through a symbolic link and never blocking (a FIFO fails at once).
 *
 * @throws Error `KEYSET_FILE_INVALID: <name>` (`cause` holds the detail) when the file exists but is not a regular
 *   file, is larger than {@link KEYSET_MAX_FILE_BYTES}, is not UTF-8 strict JSON or breaks the format; any other I/O
 *   error (EACCES, EIO, ...) as it is
 */
export async function readKeysetFile(file: string): Promise<KeysetDoc[] | null> {
  let text: string;
  try {
    text = await readBoundedText(file, KEYSET_MAX_FILE_BYTES);
  } catch (err) {
    const code = errorCode(err);
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    const unusable = code === undefined || code === 'ELOOP' || code === 'EMLINK' || code === 'EISDIR' || code.indexOf('ERR_') === 0;
    if (!unusable) throw err;
    throw invalidFile(file, err);
  }
  try {
    return parseKeysetDocs(parseStrictJson(text));
  } catch (err) {
    throw invalidFile(file, err);
  }
}

/**
 * The documents of a state keyset file and of its `.bak` copy, both of them (ruling R65a): each file that can be used
 * is a source (`name`, `name + '.bak'`); one that cannot is skipped. None when neither exists. A `.bak` that cannot
 * even be read (EACCES, EIO, ...) next to a usable main file is skipped too, so it never blocks the boot.
 *
 * @throws Error `KEYSET_CORRUPT` when a file exists but neither it nor the `.bak` can be used (losing them could bring
 *   a revoked key back: callers fail closed); an I/O error of the main file, or of the `.bak` when the main file is
 *   not usable, as it is
 */
export async function readKeysetWithBak(file: string, name: string): Promise<CollectedKeysets> {
  const found: CollectedKeysets = { sources: [], skipped: [] };
  let present = false;
  const candidates: [string, string][] = [
    [file, name],
    [file + '.bak', name + '.bak'],
  ];
  for (let i = 0; i < candidates.length; i++) {
    const [path, label] = candidates[i] as [string, string];
    let docs: KeysetDoc[] | null;
    try {
      docs = await readKeysetFile(path);
    } catch (err) {
      const backupNextToUsableMain = i === 1 && found.sources.length === 1;
      if (!isInvalidKeysetFile(err) && !backupNextToUsableMain) throw err;
      present = true;
      found.skipped.push({ name: label, error: err });
      continue;
    }
    if (docs === null) continue;
    present = true;
    found.sources.push({ name: label, docs });
  }
  if (present && found.sources.length === 0) {
    throw new Error('KEYSET_CORRUPT: ' + name + ' and its .bak are both unusable', { cause: (found.skipped[0] as KeysetSkip).error });
  }
  return found;
}

export type InstalledKeysetsOptions = {
  /** The folder of app.js: the keyset.json of every SemVer-named folder of `<appRoot>/bundled-release` is read. */
  appRoot: string;
  /** DATA_DIR/releases/keyset.json; its `.bak` is read too. */
  dataKeyset: string;
  /** More release folders whose keyset.json is read, with a name for reports: those current.json names. */
  releases: { name: string; dir: string }[];
};

/**
 * Every root-signed keyset document the installation holds, besides the release about to be verified (ruling R65a),
 * in this order: DATA_DIR/releases/keyset.json and its `.bak` ({@link readKeysetWithBak}), then each bundled release
 * (`bundled-release/<version>/keyset.json`, by version), then `o.releases` (a folder already read is skipped).
 * A release keyset.json that is missing adds nothing; one that cannot be used is reported in `skipped` (the release
 * itself then fails its own verification when it is run).
 *
 * @throws Error `KEYSET_CORRUPT` (see {@link readKeysetWithBak}); any I/O error of DATA_DIR's keyset other than a
 *   missing file
 */
export async function collectInstalledKeysets(o: InstalledKeysetsOptions): Promise<CollectedKeysets> {
  const found = await readKeysetWithBak(o.dataKeyset, 'DATA_DIR/releases/' + KEYSET_FILE);

  const releases: { name: string; dir: string }[] = [];
  const bundledRoot = nodePath.join(o.appRoot, BUNDLED_DIR);
  try {
    const entries = await fsp.readdir(bundledRoot, { withFileTypes: true });
    const versions = entries.filter((e) => e.isDirectory() && isSemverText(e.name)).map((e) => e.name);
    versions.sort();
    for (const version of versions) {
      releases.push({ name: BUNDLED_DIR + '/' + version + '/' + KEYSET_FILE, dir: nodePath.join(bundledRoot, version) });
    }
  } catch (err) {
    const code = errorCode(err);
    if (code !== 'ENOENT' && code !== 'ENOTDIR') found.skipped.push({ name: BUNDLED_DIR, error: err });
  }
  for (const release of o.releases) releases.push(release);

  const read = new Set<string>();
  for (const release of releases) {
    const dir = nodePath.resolve(release.dir);
    if (read.has(dir)) continue;
    read.add(dir);
    let docs: KeysetDoc[] | null;
    try {
      docs = await readKeysetFile(nodePath.join(dir, KEYSET_FILE));
    } catch (err) {
      found.skipped.push({ name: release.name, error: err });
      continue;
    }
    if (docs !== null) found.sources.push({ name: release.name, docs });
  }
  return found;
}
