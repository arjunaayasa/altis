import { constants as fsConstants } from 'node:fs';
import fsp, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { DomainError } from '@altis/shared';
import { dataRootOf, runWorkPath, type DataPath } from './datapath.js';
import { isInside } from './pathutil.js';

// Phase 2 Task 10. Two kinds of path the SLiMS migration needs that dataPath does not build:
//
// - openUnderRoot: a file below a folder the operator named on the command line (`slims:import --files-dir <the SLiMS
//   folder>`, spec §11.1: "path dibatasi realpath di bawah folder itu"). The relative path comes from SLiMS data
//   (`repository/<file_dir>/<file_name>`), so it is untrusted: it must be a plain `/`-separated relative path, and the
//   real path of the file (every symbolic link resolved) must lie inside the real path of the folder.
// - runWorkFileIn and dataDirOf: the SLiMS dump splitter gets the run's work folder as a DataPath (`tmp/<runId>`) and
//   writes one staging file per table into it; these rebuild the DATA_DIR and the run id from that DataPath and pass
//   them through runWorkPath, so the staging names get the same checks as every other run work file.

function invalid(reason: 'invalid_rel' | 'escapes_root' | 'not_a_file', rel: string): DomainError {
  const shown = JSON.stringify(rel.length > 120 ? `${rel.slice(0, 120)}…` : rel);
  return new DomainError('INVALID_PATH_SEGMENT', {
    detail: `Path ${shown} tidak diizinkan di bawah folder sumber / The path ${shown} is not allowed below the source folder`,
    meta: { reason },
  });
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
}

/** The segments of a plain relative path (`a/b/c`), or null for anything else. */
function relSegments(rel: string): string[] | null {
  if (typeof rel !== 'string' || rel === '' || rel.length > 4096) return null;
  if (rel.includes('\\') || rel.includes(String.fromCharCode(0)) || rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) return null;
  const segments = rel.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return null;
  return segments;
}

/** The real path of `p`, or null when it (or a folder on the way) does not exist. */
async function realOrNull(p: string): Promise<string | null> {
  try {
    return await fsp.realpath(p);
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
}

/**
 * Opens `root/rel` for reading, when that file exists and its real path lies inside the real path of `root`.
 *
 * `rel` must be a `/`-separated relative path without empty, `.` or `..` segments, backslashes, NUL, a leading `/`
 * or a drive letter. The file's real path is checked before it is opened, and again after (the opened file must be
 * the one the real path names), so a link swapped in between cannot lead out of the root. The caller closes the
 * handle.
 *
 * @returns the open handle, or null when there is no such file
 * @throws DomainError `INVALID_PATH_SEGMENT` with `meta.reason` `invalid_rel` (the path's form), `escapes_root` (a
 *   symbolic link leads out of the root) or `not_a_file` (a folder, FIFO, device or socket)
 * @throws the error of a root that does not exist or cannot be read (ENOENT, EACCES, ...), and any other I/O error
 */
export async function openUnderRoot(root: string, rel: string): Promise<FileHandle | null> {
  const segments = relSegments(rel);
  if (segments === null) throw invalid('invalid_rel', String(rel));
  const realRoot = await fsp.realpath(root);
  const target = path.join(realRoot, ...segments);
  const real = await realOrNull(target);
  if (real === null) return null;
  if (!isInside(real, realRoot)) throw invalid('escapes_root', rel);

  let handle: FileHandle;
  try {
    handle = await fsp.open(real, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0) | (fsConstants.O_NONBLOCK || 0));
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    if (code === 'EISDIR') throw invalid('not_a_file', rel);
    if (code === 'ELOOP') throw invalid('escapes_root', rel); // the last segment became a link after the check
    throw error;
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw invalid('not_a_file', rel);
    const again = await realOrNull(target);
    if (again === null || !isInside(again, realRoot)) throw invalid('escapes_root', rel);
    const named = await fsp.stat(again);
    if (named.dev !== opened.dev || named.ino !== opened.ino) throw invalid('escapes_root', rel);
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
  return handle;
}

/**
 * The DATA_DIR that `p` lies in (as {@link dataPath} and the typed builders remembered it in this process).
 *
 * @throws TypeError when `p` lies in no DATA_DIR this process has built a path in
 */
export function dataDirOf(p: DataPath): string {
  const root = typeof p === 'string' ? dataRootOf(p) : null;
  if (root === null) throw new TypeError('dataDirOf: the path lies in no known DATA_DIR');
  return root;
}

/**
 * `runWorkPath(dataDir, runId, name)` for the run whose work folder `dir` is (`tmp/<runId>`, as runWorkDir built it).
 *
 * @throws TypeError when `dir` is not a run work folder of a known DATA_DIR
 * @throws DomainError `INVALID_PATH_SEGMENT` for a name runWorkPath refuses
 */
export function runWorkFileIn(dir: DataPath, name: string): DataPath {
  const root = dataDirOf(dir);
  const parts = path.relative(root, dir).split(path.sep);
  if (parts.length !== 2 || parts[0] !== 'tmp' || parts[1] === undefined || parts[1] === '') {
    throw new TypeError('runWorkFileIn: not the work folder of a run (tmp/<runId>)');
  }
  return runWorkPath(root, parts[1], name);
}
