import fsp from 'node:fs/promises';
import path from 'node:path';
import { isSemver } from '@altis/shared';
import { appPath } from './app-paths.js';
import { readJsonWithBak } from './atomic.js';
import { dataPath } from './datapath.js';
import { isInside } from './pathutil.js';

// Release files (spec §9.2, §9.3, §4.8; decision D31): where a release lives, the content of
// DATA_DIR/releases/current.json, and the public files a release serves.
//
// app.js bundles this module (the bootloader re-exports releaseDir and the current.json parsing from here, S26), so
// it stays ES2017-compatible (P1), like the rest of the platform package.
//
// A release's public files (D31), all below `<release>/public/`:
//   admin-index   public/admin/index.html          the SPA document, with the `__CSP_NONCE__` placeholder
//   install-index public/admin/install.html        the install wizard's document (1c, Task 10), same placeholder
//   admin-asset   public/admin/assets/<name>       hashed assets; <name> must match ADMIN_ASSET_NAME
//   legal         public/THIRD_PARTY_NOTICES.txt   the notices of the bundled dependencies

export type ReleaseSource = 'bundled' | 'data';

export interface ReleaseRef {
  version: string;
  source: ReleaseSource;
}

/**
 * The content of `DATA_DIR/releases/current.json` (spec §9.3), frozen by bootloader contract v1: the first public
 * app.js parses it, so a later release may add fields (ignored here, and kept as they are by every write of
 * current-state.ts) but never change these.
 */
export interface CurrentState {
  schema: 1;
  /** The release that boots when nothing is pending. */
  active: ReleaseRef;
  /** The release before `active`: the boot fallback and the target of a manual rollback (§9.7). */
  previous: ReleaseRef | null;
  /**
   * The release an update installs (§9.6 step 5, the point of no return), booted instead of `active` until it is
   * promoted or reverted (§9.3: "Bootloader memuat `pending ?? active`"). Never the same version as `active`.
   */
  pending: ReleaseRef | null;
  /** When `pending` was set, in epoch ms; set exactly when `pending` is. */
  pendingSince: number | null;
  /** A version left by a manual rollback, which no automatic update installs again (§9.7). */
  pinned: string | null;
}

const CURRENT_FILE = 'current.json';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRef(value: unknown, field: string): ReleaseRef {
  if (!isRecord(value)) throw new TypeError(`current.json: ${field} is not an object`);
  const { version, source } = value;
  if (typeof version !== 'string' || !isSemver(version)) throw new TypeError(`current.json: ${field}.version is not SemVer`);
  if (source !== 'bundled' && source !== 'data') throw new TypeError(`current.json: ${field}.source is not bundled or data`);
  return { version, source };
}

/** An epoch-ms time stamp: a non-negative safe integer. */
function isEpochMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Validates the content of current.json and returns a fresh copy of its known fields (others are ignored, so a
 * later release may add some: contract v1 freezes this parser in the first public app.js).
 *
 * `pending` is null or a release ref with `pendingSince` its epoch-ms time stamp (an integer); the two are set
 * together, and a pending version is never the active one.
 *
 * @throws TypeError naming the first field that is not valid (`pending`, `pendingSince`, ...)
 */
export function parseCurrentState(raw: unknown): CurrentState {
  if (!isRecord(raw)) throw new TypeError('current.json: not an object');
  if (raw['schema'] !== 1) throw new TypeError('current.json: schema is not 1');
  const active = parseRef(raw['active'], 'active');
  const previous = raw['previous'] === null ? null : parseRef(raw['previous'], 'previous');
  const pending = raw['pending'] === null ? null : parseRef(raw['pending'], 'pending');
  const pendingSince = raw['pendingSince'];
  if (pending === null) {
    if (pendingSince !== null) throw new TypeError('current.json: pendingSince is not null while pending is null');
  } else {
    if (!isEpochMs(pendingSince)) throw new TypeError('current.json: pendingSince is not an integer time stamp while pending is set');
    if (pending.version === active.version) throw new TypeError('current.json: pending.version is the active version');
  }
  const pinned = raw['pinned'];
  if (pinned !== null && (typeof pinned !== 'string' || !isSemver(pinned))) throw new TypeError('current.json: pinned is not SemVer');
  return { schema: 1, active, previous, pending, pendingSince: pending === null ? null : (pendingSince as number), pinned };
}

/**
 * Where a release lives: `<appRoot>/bundled-release/<v>` or `DATA_DIR/releases/<v>`.
 *
 * @throws TypeError when the version is not SemVer; DomainError `INVALID_PATH_SEGMENT` when `DATA_DIR/releases` is a
 *   symbolic link or the path leaves it (see dataPath)
 */
export function releaseDir(appRoot: string, dataDir: string, ref: ReleaseRef): string {
  if (!isSemver(ref.version)) throw new TypeError('releaseDir: version is not SemVer');
  return ref.source === 'bundled' ? path.join(appRoot, 'bundled-release', ref.version) : dataPath(dataDir, 'releases', ref.version);
}

/**
 * The `previous` release of DATA_DIR/releases/current.json (falling back to its `.bak`), or null when it names none
 * or neither file exists. Read-only: it takes no lock (a rename is atomic) and never initialises the file, which is
 * the bootloader's job.
 *
 * @throws DomainError `STATE_CORRUPT` when a file exists but neither it nor the `.bak` is usable; the I/O error for
 *   other failures than a missing file
 */
export async function readPreviousRelease(dataDir: string): Promise<ReleaseRef | null> {
  const state = await readJsonWithBak(dataPath(dataDir, 'releases', CURRENT_FILE), parseCurrentState);
  return state === null ? null : state.previous;
}

/**
 * 1d Task 25 (decision D1d-20, preflight 1D-21): whether `<appRoot>/tmp/restart.txt` was touched at or after `since`
 * (epoch ms; current.json's `pendingSince`). The release fence of an old process skips its own restart then: Passenger
 * restarts every process of the pool after that touch already, and touching it again once the boot-lock holder has
 * spawned would restart the holder too, a failed boot of the pending release.
 *
 * Compared in whole seconds, since some file systems keep an mtime in seconds only: a touch in the second of `since`
 * counts. Read-only (one `stat`); a file that is missing, or cannot be looked at, counts as not touched.
 */
export async function restartRequestedSince(appRoot: string, since: number): Promise<boolean> {
  let mtimeMs: number;
  try {
    mtimeMs = (await fsp.stat(appPath(appRoot, 'restart.txt'))).mtimeMs;
  } catch (error) {
    void error;
    return false;
  }
  return Math.floor(mtimeMs / 1000) >= Math.floor(since / 1000);
}

/**
 * The file name of a hashed admin asset: letters, digits, `_` and `-` in dot-separated parts, not starting with `.`
 * or `-`, ending in one of the served extensions. A leading `_` is allowed (Vite/rolldown name some chunks
 * `_virtual…`, M8); source maps (`.map`), dot files (`.vite/`) and any separator are not.
 */
export const ADMIN_ASSET_NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)*\.(js|css|woff2|svg|png|ico)$/;

export type ReleaseFileKind = 'admin-index' | 'install-index' | 'admin-asset' | 'legal';

/** Errors that mean "no such file here": the file or a folder on its way is missing, or it is a folder. */
const NOT_A_FILE = ['ENOENT', 'ENOTDIR', 'EISDIR'];

/** The segments below `public/` of a file of `kind`, or null when `name` is not a valid asset name. */
function publicSegments(kind: ReleaseFileKind, name: string | undefined): string[] | null {
  switch (kind) {
    case 'admin-index':
      return ['admin', 'index.html'];
    case 'install-index':
      return ['admin', 'install.html'];
    case 'admin-asset':
      return typeof name === 'string' && ADMIN_ASSET_NAME.test(name) ? ['admin', 'assets', name] : null;
    case 'legal':
      return ['THIRD_PARTY_NOTICES.txt'];
    default:
      return null;
  }
}

/**
 * The content of one public file of the release in `releaseDir` (see the table at the top of this file), or null
 * when there is none to serve:
 *
 * - an asset `name` that fails {@link ADMIN_ASSET_NAME} (refused before any file system call);
 * - a file whose real path (symbolic links resolved) is not inside the real path of `<releaseDir>/public`;
 * - a file that does not exist (ENOENT, ENOTDIR), or a folder (EISDIR).
 *
 * The bytes are a Buffer of its own (not a slice of a shared pool), which a Response body accepts as it is.
 *
 * @throws the I/O error for any other failure (EACCES, EIO, ...)
 */
export async function readReleaseFile(releaseDir: string, kind: ReleaseFileKind, name?: string): Promise<Buffer<ArrayBuffer> | null> {
  const segments = publicSegments(kind, name);
  if (segments === null) return null;
  const publicDir = path.join(releaseDir, 'public');
  const file = path.join(publicDir, ...segments);
  try {
    const realPublic = await fsp.realpath(publicDir);
    const realFile = await fsp.realpath(file);
    if (!isInside(realFile, realPublic)) return null;
    return await fsp.readFile(realFile);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (typeof code === 'string' && NOT_A_FILE.includes(code)) return null;
    throw error;
  }
}
