import { createHash, randomBytes, type Hash } from 'node:crypto';
import { constants as fsConstants, type Dirent } from 'node:fs';
import fsp, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { DomainError } from '@altis/shared';
import { areaOf, dataPath, dataRootOf, isDataDirOrArea, runWorkDir, type DataPath } from './datapath.js';
import { diskFullHit } from './fault.js';
import { ensureHeadroom } from './headroom.js';

// File helpers for DATA_DIR (spec §7.5, P21). Besides the 1a/1b helpers (atomicWriteJson, readJsonWithBak,
// withFileLock, ensureDir, ...), this is the only way packages/core and apps/server reach the file system: the
// `altis/no-nonliteral-fs` lint forbids fs and path calls with a computed path there, and every helper below takes a
// DataPath, which only dataPath, uploadPath and the typed builders produce.
//
// Rules shared by every helper:
// - P21: `ENOSPC`/`EDQUOT`, wherever the file system reports it (open, write, fsync, close, rename, mkdir), becomes
//   DomainError `DISK_QUOTA` (`meta: {code}`) after what the call created is removed: its temporary or new file and
//   the folders it had to create (except DATA_DIR's area folders, which other processes may be writing into at the
//   same moment). The previous content of a file being replaced stays as it was.
// - Missing folders below DATA_DIR are created (mode 0700); DATA_DIR itself never is: a DATA_DIR that vanished (an
//   unmounted volume) must not come back empty.
// - Replacing writes (writeBytesAtomic, writeStreamAtomic, withTempSibling, copyFileTo) write a hidden temporary
//   sibling `.<name>.tmp-<pid>-<12 hex>` that no dataPath segment can name, fsync it, rename it over the target and
//   fsync the folder: a reader sees the old file or the new one, never a part. writeExclusive writes such a sibling
//   too and `link`s it to the target, which fails when the target exists: a reader sees no file or the whole one.
// - Test fault `disk-full:<area>:<n>` (S13, test profile only): writeExclusive, writeBytesAtomic, writeStreamAtomic,
//   withTempSibling, copyFileTo, openAppend and openReadWrite each count as one write under the area of their target;
//   the n-th fails with a synthetic `EDQUOT` (after its temporary file was created, where the call has one), so the
//   cleanup path runs. Renames, truncation and removal are not writes.
//
// Not imported by app.js's own code (packages/bootloader), though bundled with @altis/platform.

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
/** readBytes refuses a larger file unless the caller allows more: the files read whole here are small state files. */
const READ_DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;

/** Rename retries (Windows antivirus and indexers briefly lock files): 50 ms doubling to 1 s, for at most 10 s. */
const RENAME_FIRST_DELAY_MS = 50;
const RENAME_MAX_DELAY_MS = 1000;
const RENAME_DEADLINE_MS = 10_000;

/** `fsync` on a directory is unsupported on some file systems; these codes mean "cannot", not "failed". */
const DIR_SYNC_UNSUPPORTED = new Set(['EINVAL', 'ENOTSUP', 'EPERM', 'EACCES', 'EISDIR', 'EBADF']);

/** dataDirUsage's default bounds. */
const USAGE_MAX_ENTRIES = 200_000;
const USAGE_MAX_MS = 5000;
const USAGE_STAT_BATCH = 64;

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isQuotaCode(code: string | undefined): code is 'ENOSPC' | 'EDQUOT' {
  return code === 'ENOSPC' || code === 'EDQUOT';
}

/**
 * `DISK_QUOTA` for a full disk or an exhausted quota (P21), any other error as it is. For this package's helpers.
 */
export function quotaMapped(file: string, error: unknown): unknown {
  const code = errorCode(error);
  if (!isQuotaCode(code)) return error;
  return new DomainError('DISK_QUOTA', {
    detail:
      `Ruang disk atau kuota hosting habis saat menulis ${file} (${code}); berkas parsial sudah dihapus / ` +
      `The disk is full or the hosting quota is used up while writing ${file} (${code}); the partial file was removed`,
    meta: { code },
    cause: error,
  });
}

function stateError(file: string, reason: 'not_a_file' | 'too_large', extra: Record<string, unknown> = {}): DomainError {
  const why =
    reason === 'not_a_file'
      ? 'bukan berkas biasa / is not a regular file'
      : `lebih besar dari batas ${String(extra['maxBytes'])} byte / is larger than the ${String(extra['maxBytes'])} byte limit`;
  return new DomainError('STATE_CORRUPT', {
    detail: `${file}: ${why}`,
    meta: { reason, ...extra },
  });
}

function toBytes(data: string | Uint8Array): Uint8Array {
  return typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
}

/** A hidden temporary sibling of `file` that no dataPath segment can name. */
function tempSibling(file: string): string {
  return path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
}

/**
 * Test fault `disk-full:<area>:<n>` (S13): counts one write under the area of `file` and throws a synthetic `EDQUOT`
 * when it is the n-th. The condition stays inline so that a production build drops the whole block.
 */
function faultBeforeWrite(file: string): void {
  if (typeof __BUILD_PROFILE__ !== 'undefined' && __BUILD_PROFILE__ === 'test') {
    const area = areaOf(file);
    if (area !== null && diskFullHit(process.env, area)) {
      throw Object.assign(new Error(`EDQUOT: disk quota exceeded (synthetic disk-full fault), write '${file}'`), {
        code: 'EDQUOT',
        syscall: 'write',
      });
    }
  }
}

/**
 * Creates the missing folders above `file` (mode 0700) and returns them, deepest first, so that a failed call can
 * remove them again. DATA_DIR itself is never created: when it is missing, the error of the attempt (ENOENT) is thrown.
 */
async function ensureParents(file: string): Promise<string[]> {
  const parent = path.dirname(file);
  const root = dataRootOf(file);
  if (root !== null) {
    if (root === parent || root === file) return []; // a file directly in DATA_DIR: DATA_DIR must exist already
    await fsp.stat(root); // throws ENOENT for a DATA_DIR that is gone
  }
  let first: string | undefined;
  try {
    first = await fsp.mkdir(parent, { recursive: true, mode: DIR_MODE });
  } catch (error) {
    throw quotaMapped(file, error);
  }
  if (first === undefined) return [];
  const created: string[] = [];
  for (let dir = parent; ; dir = path.dirname(dir)) {
    created.push(dir);
    if (dir === first || path.dirname(dir) === dir) break;
  }
  return created;
}

/**
 * Best effort: removes `files`, then the folders in `dirs` (deepest first) that are empty. DATA_DIR's area folders
 * stay: another process may have just found one and be about to create its own file in it.
 */
async function cleanup(files: readonly string[], dirs: readonly string[]): Promise<void> {
  for (const file of files) await fsp.rm(file, { force: true }).catch(() => undefined);
  for (const dir of dirs) {
    if (!isDataDirOrArea(dir)) await fsp.rmdir(dir).catch(() => undefined);
  }
}

async function writeAll(handle: FileHandle, data: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < data.byteLength) {
    const { bytesWritten } = await handle.write(data, offset, data.byteLength - offset);
    if (!(bytesWritten > 0)) throw new Error('write made no progress');
    offset += bytesWritten;
  }
}

/** fsyncs a file that is already closed (a temporary file somebody else wrote). */
async function syncFile(file: string): Promise<void> {
  const handle = await fsp.open(file, 'r+'); // Windows flushes only a handle opened for writing
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** fsyncs the folder `dir`; a file system that cannot is skipped, `ENOSPC`/`EDQUOT` (NFS) is `DISK_QUOTA`. */
async function syncDirectory(dir: string): Promise<void> {
  if (process.platform === 'win32') return; // directories cannot be opened (or fsynced) on Windows
  let handle: FileHandle | undefined;
  try {
    handle = await fsp.open(dir, 'r');
    await handle.sync();
  } catch (error) {
    const code = errorCode(error);
    if (code === undefined || !DIR_SYNC_UNSUPPORTED.has(code)) throw quotaMapped(dir, error);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Whether a failed rename or removal may succeed when tried again: `EPERM`/`EBUSY` anywhere, and on Windows also
 * `EACCES` (an antivirus scanner or the indexer briefly holding the file; graceful-fs, atomic.ts and lock.ts retry
 * the same).
 */
function renameRetryable(code: string | undefined): boolean {
  return code === 'EPERM' || code === 'EBUSY' || (code === 'EACCES' && process.platform === 'win32');
}

/** `op`, retried with backoff (50 ms doubling to 1 s) while {@link renameRetryable}, for at most 10 s. */
async function whileBusy(op: () => Promise<void>): Promise<void> {
  const deadline = performance.now() + RENAME_DEADLINE_MS;
  let delay = RENAME_FIRST_DELAY_MS;
  for (;;) {
    try {
      await op();
      return;
    } catch (error) {
      if (!renameRetryable(errorCode(error))) throw error;
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw error;
      await sleep(Math.min(delay, remaining));
      delay = Math.min(delay * 2, RENAME_MAX_DELAY_MS);
    }
  }
}

/** `rename`, retried while {@link renameRetryable} (see {@link whileBusy}). */
function renameWithRetry(from: string, to: string): Promise<void> {
  return whileBusy(() => fsp.rename(from, to));
}

/**
 * Reads the regular file `file` whole, at most `maxBytes` bytes (whatever its size said when it was opened: it may
 * grow). Null when it does not exist. For this package (readBytes, readAppFile).
 */
export async function readBounded(file: string, maxBytes: number): Promise<Buffer | null> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError(`maxBytes must be a positive integer, got ${String(maxBytes)}`);
  }
  let handle: FileHandle;
  try {
    // O_NONBLOCK: a FIFO planted in place of the file opens at once instead of waiting for a writer, and is refused
    // below. It changes nothing for a regular file. Windows has no such flag.
    handle = await fsp.open(file, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK || 0));
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    if (code === 'EISDIR') throw stateError(file, 'not_a_file');
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw stateError(file, 'not_a_file');
    if (info.size > maxBytes) throw stateError(file, 'too_large', { maxBytes });
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const want = Math.min(READ_CHUNK_BYTES, maxBytes + 1 - total); // one byte more tells a file that grew
      const chunk = Buffer.allocUnsafe(want);
      const { bytesRead } = await handle.read(chunk, 0, want, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) throw stateError(file, 'too_large', { maxBytes });
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Replaces `file` with `data` through a hidden temporary sibling (write, fsync, rename with retries, fsync the
 * folder), creating missing folders unless `parents` is false (then a missing folder fails the temporary file's open
 * with ENOENT). `fault`: whether the call counts as a write for the `disk-full` test fault. For this package
 * (writeBytesAtomic, writeBytesInFolder, writeAppFileAtomic).
 */
export async function replaceFile(file: string, data: string | Uint8Array, mode: number, fault: boolean, parents = true): Promise<void> {
  const bytes = toBytes(data);
  const created = parents ? await ensureParents(file) : [];
  const temp = tempSibling(file);
  let handle: FileHandle | undefined;
  try {
    handle = await fsp.open(temp, 'wx', mode);
    if (fault) faultBeforeWrite(file);
    await writeAll(handle, bytes);
    await handle.sync();
    const done = handle;
    handle = undefined;
    await done.close(); // NFS reports a quota overrun here at the latest
    await renameWithRetry(temp, file);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await cleanup([temp], created);
    throw quotaMapped(file, error);
  }
  await syncDirectory(path.dirname(file));
}

/**
 * The content of `p`, or null when it does not exist (nor its folder). Only a regular file is read, and at most
 * `maxBytes` bytes (default 16 MiB): this is for small files read whole; larger ones go through {@link openRead}.
 *
 * @throws DomainError `STATE_CORRUPT` with `meta.reason` `not_a_file` (a folder, FIFO, device or socket) or
 *   `too_large` (`meta.maxBytes`)
 * @throws RangeError when `maxBytes` is not a positive integer
 */
export function readBytes(p: DataPath, maxBytes: number = READ_DEFAULT_MAX_BYTES): Promise<Buffer | null> {
  return readBounded(p, maxBytes);
}

/**
 * `link` errors that mean the file system has no hard links (FAT/exFAT, some network shares): Linux says EPERM,
 * macOS ENOTSUP, and Windows reports FAT's ERROR_INVALID_FUNCTION as EISDIR.
 */
const LINK_UNSUPPORTED = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EISDIR']);

/** Whether `a` and `b` are names of one file (same device and inode); false when either cannot be looked at. */
async function sameFile(a: string, b: string): Promise<boolean> {
  try {
    const [x, y] = await Promise.all([fsp.lstat(a, { bigint: true }), fsp.lstat(b, { bigint: true })]);
    return x.dev === y.dev && x.ino === y.ino;
  } catch {
    return false;
  }
}

/** Writes `bytes` to the new file `file` (O_EXCL) in place; the fallback of writeExclusive without hard links. */
async function createInPlace(file: string, bytes: Uint8Array, mode: number): Promise<boolean> {
  let handle: FileHandle;
  try {
    handle = await fsp.open(file, 'wx', mode); // O_CREAT | O_EXCL | O_WRONLY
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return false;
    throw error;
  }
  try {
    await writeAll(handle, bytes);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fsp.rm(file, { force: true }).catch(() => undefined);
    throw error;
  }
  try {
    await handle.close();
  } catch (error) {
    await fsp.rm(file, { force: true }).catch(() => undefined);
    throw error;
  }
  return true;
}

/**
 * Creates `p` exclusively (the `wx` of spec §9.4's `op.json`) with `data`, published whole: the content is written to
 * a hidden temporary sibling and fsynced first, then `link`ed to `p`, which fails with EEXIST when `p` exists (the
 * exclusive create that also holds on NFS). So `p` never exists empty or partial: a caller that gets false reads the
 * winner's full content, and a process killed meanwhile (P7) leaves no `p` (only, at worst, a hidden temp file).
 * Then the temporary name is removed and the folder fsynced.
 *
 * On a file system without hard links (FAT/exFAT) it falls back to creating `p` with O_EXCL and writing it in place,
 * which is just as exclusive but lets a reader see `p` before its content is in it.
 *
 * @returns true when this call created the file with its full content; false, with nothing written, when it existed
 *   already
 * @throws DomainError `DISK_QUOTA` (P21) after removing what it created, `p` included; only the folder's fsync after
 *   `p` was published whole (NFS) can fail with `p` left in place, since readers may already have seen it
 */
export async function writeExclusive(p: DataPath, data: string | Uint8Array, mode: number = FILE_MODE): Promise<boolean> {
  const bytes = toBytes(data);
  const created = await ensureParents(p);
  const temp = tempSibling(p);
  let handle: FileHandle | undefined;
  let ours: boolean;
  try {
    handle = await fsp.open(temp, 'wx', mode);
    faultBeforeWrite(p);
    await writeAll(handle, bytes);
    await handle.sync();
    const done = handle;
    handle = undefined;
    await done.close(); // NFS reports a quota overrun here at the latest
    ours = await linkExclusive(temp, p, bytes, mode);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await cleanup([temp], created);
    throw quotaMapped(p, error);
  }
  // `p` is complete now, ours or somebody else's: the temporary name goes either way (best effort).
  await fsp.rm(temp, { force: true }).catch(() => undefined);
  if (!ours) return false;
  await syncDirectory(path.dirname(p));
  return true;
}

/**
 * Publishes the written, fsynced `temp` as `file` unless `file` exists: true when this call created `file`. Without
 * hard links, `temp` is removed and `file` is created in place from `bytes` instead.
 */
async function linkExclusive(temp: string, file: string, bytes: Uint8Array, mode: number): Promise<boolean> {
  try {
    await fsp.link(temp, file);
    return true;
  } catch (error) {
    const code = errorCode(error);
    // A retransmitted NFS request can report EEXIST for a link that its first transmission made.
    if (code === 'EEXIST') return sameFile(temp, file);
    if (code === undefined || !LINK_UNSUPPORTED.has(code)) throw error;
  }
  // Best effort: a scanner may hold the fresh temp file for a moment, and the caller removes it again afterwards.
  await fsp.rm(temp, { force: true }).catch(() => undefined);
  return createInPlace(file, bytes, mode);
}

/**
 * Replaces `p` with `data` atomically: a reader sees the old content or the new one, never a part (see the module
 * comment). Default mode 0600.
 *
 * @throws DomainError `DISK_QUOTA` (P21) after removing the temporary file; `p` keeps its old content
 */
export function writeBytesAtomic(p: DataPath, data: string | Uint8Array, mode: number = FILE_MODE): Promise<void> {
  return replaceFile(p, data, mode, true);
}

/**
 * Replaces `p` with `data` as {@link writeBytesAtomic} does, but only inside a folder that exists: a missing folder is
 * never created (a record must not bring back a folder another process removed, with nothing else in it).
 *
 * @returns true when `p` was written; false, with nothing written, when its folder is gone
 * @throws DomainError `DISK_QUOTA` (P21) after removing the temporary file; `p` keeps its old content
 */
export async function writeBytesInFolder(p: DataPath, data: string | Uint8Array, mode: number = FILE_MODE): Promise<boolean> {
  try {
    await replaceFile(p, data, mode, true, false);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Opens the regular file `p` for reading (a FIFO, device or folder is refused). The caller closes the handle.
 *
 * @throws DomainError `STATE_CORRUPT` `not_a_file`; the open error (ENOENT, ...) as it is
 */
export async function openRead(p: DataPath): Promise<FileHandle> {
  let handle: FileHandle;
  try {
    handle = await fsp.open(p, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK || 0));
  } catch (error) {
    if (errorCode(error) === 'EISDIR') throw stateError(p, 'not_a_file');
    throw error;
  }
  try {
    if (!(await handle.stat()).isFile()) throw stateError(p, 'not_a_file');
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
  return handle;
}

/** Opens `p` with `flags`, creating missing folders; a counted write for the `disk-full` fault. */
async function openForWriting(p: DataPath, flags: string | number): Promise<FileHandle> {
  const created = await ensureParents(p);
  try {
    faultBeforeWrite(p);
    return await fsp.open(p, flags, FILE_MODE);
  } catch (error) {
    await cleanup([], created);
    throw quotaMapped(p, error);
  }
}

/**
 * Opens `p` for appending (created with mode 0600 when missing, and its missing folders too). The caller writes and
 * closes; a quota error from those writes is the caller's to map.
 *
 * @throws DomainError `DISK_QUOTA` (P21) when the open itself hits it
 */
export function openAppend(p: DataPath): Promise<FileHandle> {
  return openForWriting(p, 'a');
}

/** A line break (CR, LF, U+2028, U+2029; built from escapes, so this file holds none of them). */
const LINE_BREAK = new RegExp('[\\r\\n\\u2028\\u2029]');

/**
 * 1c Task 18: appends `text` and a line feed to `p` as one write (created with mode 0600 when missing, and its missing
 * folders too), then fsyncs it: an append-only log of one line per record (`logs/audit-anchor.log`). A write that
 * fails is cut back off, so the file never ends in part of a line this call wrote.
 *
 * @throws TypeError, before anything is written, when `text` is not a string or holds a line break (CR, LF, U+2028,
 *   U+2029) or a NUL
 * @throws DomainError `DISK_QUOTA` (P21) when the open, the write or the fsync hits it
 */
export async function appendLine(p: DataPath, text: string): Promise<void> {
  if (typeof text !== 'string' || LINE_BREAK.test(text) || text.includes('\0')) {
    throw new TypeError('appendLine: text must be a string without a line break or a NUL');
  }
  const bytes = Buffer.from(`${text}\n`, 'utf8');
  const handle = await openAppend(p);
  let before: number | undefined;
  try {
    before = (await handle.stat()).size;
    await writeAll(handle, bytes);
    await handle.sync();
  } catch (error) {
    if (before !== undefined) await handle.truncate(before).catch(() => undefined);
    throw quotaMapped(p, error);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Opens `p` for positioned reads and writes, creating it (mode 0600, with its missing folders) when missing and never
 * truncating it. Unlike `a+`, a write lands at the position given (a chunk at its offset, Task 9).
 *
 * @throws DomainError `DISK_QUOTA` (P21) when the open itself hits it
 */
export function openReadWrite(p: DataPath): Promise<FileHandle> {
  return openForWriting(p, fsConstants.O_RDWR | fsConstants.O_CREAT);
}

/** Cuts `p` (or extends it with zeros) to `length` bytes. */
export async function truncateFile(p: DataPath, length: number): Promise<void> {
  try {
    await fsp.truncate(p, length);
  } catch (error) {
    throw quotaMapped(p, error);
  }
}

/**
 * Renames `from` to `to` (replacing `to`), creating `to`'s missing folders, retrying `EPERM`/`EBUSY` (and `EACCES` on
 * Windows) with backoff for at most 10 s, then fsyncs `to`'s folder (and `from`'s when it is another one).
 *
 * @throws the rename's error once retrying ends, or at once for any other error; `ENOSPC`/`EDQUOT` as `DISK_QUOTA`
 */
export async function renameRetry(from: DataPath, to: DataPath): Promise<void> {
  const created = await ensureParents(to);
  try {
    await renameWithRetry(from, to);
  } catch (error) {
    await cleanup([], created);
    throw quotaMapped(to, error);
  }
  await syncDirectory(path.dirname(to));
  if (path.dirname(from) !== path.dirname(to)) await syncDirectory(path.dirname(from));
}

/**
 * Removes the folder (or file) `p` with everything below it; nothing happens when it is gone already.
 *
 * @throws TypeError for DATA_DIR itself, an area folder (`<DATA_DIR>/backups`, ...), or a path in no DATA_DIR this
 *   process built a path in: those are never removed whole
 */
export async function removeTree(p: DataPath): Promise<void> {
  if (dataRootOf(p) === null || isDataDirOrArea(p)) {
    throw new TypeError(`removeTree: ${p} is DATA_DIR, an area folder of it, or outside it, and is never removed whole`);
  }
  await fsp.rm(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/**
 * Removes the file `p`; nothing happens when it is gone already. A folder is refused (ERR_FS_EISDIR). EPERM/EBUSY
 * (and EACCES on Windows: a scanner or the indexer holding the file) are retried with backoff for up to 10 s, since
 * fs.rm ignores its own maxRetries without `recursive`.
 */
export function removeFile(p: DataPath): Promise<void> {
  return whileBusy(() => fsp.rm(p, { force: true }));
}

/** The names of the regular files and folders in `dir` (no links, FIFOs, ...), sorted; [] when `dir` is missing. */
export async function listNames(dir: DataPath): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() || entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * The hidden temporary siblings the replacing writes create ({@link tempSibling}: `.<name>.tmp-<pid>-<12 hex>`), and
 * the SQLite side files of one that withTempSibling handed to SQLite.
 */
const TEMP_SIBLING = /^\..+\.tmp-\d+-[0-9a-f]{12}(?:-journal|-wal|-shm)?$/;

/** The deepest {@link removeStaleTemps} goes below the folder it is given. */
const STALE_TEMPS_MAX_DEPTH = 8;

/**
 * 1c Task 18: removes the hidden temporary siblings (see the module comment) in `dir` whose mtime is older than
 * `o.now − o.olderThanMs`: what a process killed in the middle of a replacing write left behind (P7). With `o.depth`
 * (default 0: `dir` alone) the subfolders down to that many levels below `dir` are swept too, never through a
 * symbolic link. Only regular files with such a name are looked at (never a folder, a link or any other name); a
 * younger one may still be written by a live process and stays. A file or folder removed meanwhile by somebody else is
 * skipped and not counted.
 *
 * @returns how many it removed; 0 when `dir` is missing
 * @throws RangeError when `o.now` or `o.olderThanMs` is not a non-negative safe integer, or `o.depth` not an integer
 *   from 0 to 8
 */
export async function removeStaleTemps(dir: DataPath, o: { now: number; olderThanMs: number; depth?: number }): Promise<number> {
  for (const [name, value] of [
    ['now', o.now],
    ['olderThanMs', o.olderThanMs],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`removeStaleTemps: ${name} must be a non-negative integer`);
  }
  const depth = o.depth ?? 0;
  if (!Number.isInteger(depth) || depth < 0 || depth > STALE_TEMPS_MAX_DEPTH) {
    throw new RangeError(`removeStaleTemps: depth must be an integer from 0 to ${STALE_TEMPS_MAX_DEPTH}`);
  }
  const cutoff = o.now - o.olderThanMs;

  const sweep = async (folder: string, levelsLeft: number): Promise<number> => {
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(folder, { withFileTypes: true });
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ENOENT' || code === 'ENOTDIR') return 0;
      throw error;
    }
    let removed = 0;
    for (const entry of entries) {
      // readdir's types come from lstat: a link to a folder is neither a file nor a directory here.
      if (entry.isDirectory()) {
        if (levelsLeft > 0) removed += await sweep(path.join(folder, entry.name), levelsLeft - 1);
        continue;
      }
      if (!entry.isFile() || !TEMP_SIBLING.test(entry.name)) continue;
      const file = path.join(folder, entry.name);
      let info;
      try {
        info = await fsp.lstat(file);
      } catch (error) {
        if (errorCode(error) === 'ENOENT') continue;
        throw error;
      }
      if (!info.isFile() || !(info.mtimeMs < cutoff)) continue;
      try {
        await fsp.unlink(file);
        removed += 1;
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error;
      }
    }
    return removed;
  };
  return sweep(dir, depth);
}

/** What {@link statOrNull} reports. A symbolic link is `other`: it is not followed. */
export interface FileStat {
  size: number;
  mtimeMs: number;
  kind: 'file' | 'dir' | 'other';
}

/** Size, mtime and kind of `p` itself (a symbolic link is not followed); null when it does not exist. */
export async function statOrNull(p: DataPath): Promise<FileStat | null> {
  try {
    const info = await fsp.lstat(p);
    return { size: info.size, mtimeMs: info.mtimeMs, kind: info.isFile() ? 'file' : info.isDirectory() ? 'dir' : 'other' };
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
}

/**
 * Puts a copy of the file `from` at `to` (replacing `to`), atomically, creating `to`'s missing folders: a hard link
 * when the file system allows one (no space used), a copy otherwise (another volume, no links). With a hard link both
 * names share one file, so this is only for files that are never changed in place (uploads, blobs, archives).
 *
 * @throws DomainError `DISK_QUOTA` (P21) after removing the temporary copy
 */
export async function copyFileTo(from: DataPath, to: DataPath): Promise<void> {
  const created = await ensureParents(to);
  const temp = tempSibling(to);
  try {
    try {
      await fsp.link(from, temp);
    } catch {
      await fsp.copyFile(from, temp, fsConstants.COPYFILE_EXCL);
      await syncFile(temp);
    }
    faultBeforeWrite(to);
    await renameWithRetry(temp, to);
    // rename() between two links of one file does nothing (POSIX), which leaves the temporary link: remove it.
    await fsp.rm(temp, { force: true });
  } catch (error) {
    await cleanup([temp], created);
    throw quotaMapped(to, error);
  }
  await syncDirectory(path.dirname(to));
}

/** fsyncs the folder `p` (skipped on Windows and on file systems that cannot). */
export function fsyncDir(p: DataPath): Promise<void> {
  return syncDirectory(p);
}

/**
 * Writes `source` to `p` atomically through a hidden temporary sibling (S14: backup parts, extracted archive entries).
 *
 * @returns the number of bytes written
 * @throws the source's own error, or DomainError `DISK_QUOTA` (P21); either way neither `p` (when it did not exist)
 *   nor the temporary file is left, and an existing `p` keeps its old content
 */
export async function writeStreamAtomic(p: DataPath, source: AsyncIterable<Uint8Array>): Promise<{ bytes: number }> {
  const created = await ensureParents(p);
  const temp = tempSibling(p);
  let handle: FileHandle | undefined;
  let bytes = 0;
  try {
    handle = await fsp.open(temp, 'wx', FILE_MODE);
    faultBeforeWrite(p);
    for await (const chunk of source) {
      await writeAll(handle, chunk);
      bytes += chunk.byteLength;
    }
    await handle.sync();
    const done = handle;
    handle = undefined;
    await done.close();
    await renameWithRetry(temp, p);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await cleanup([temp], created);
    throw quotaMapped(p, error);
  }
  await syncDirectory(path.dirname(p));
  return { bytes };
}

/**
 * Lets `fn` write a hidden temporary sibling of `p` (the DataPath it is given), then fsyncs it and renames it over `p`
 * (S14: SQLite copies, which SQLite itself writes, and anything else that needs a file name rather than a stream).
 *
 * @throws `fn`'s own error, or DomainError `DISK_QUOTA` (P21); either way the temporary file is removed and `p` stays
 *   as it was
 */
export async function withTempSibling(p: DataPath, fn: (tmp: DataPath) => Promise<void>): Promise<void> {
  const created = await ensureParents(p);
  const temp = tempSibling(p);
  try {
    await fn(temp as DataPath);
    faultBeforeWrite(p);
    await syncFile(temp);
    await renameWithRetry(temp, p);
  } catch (error) {
    // The temporary name is this call's alone, so SQLite's side files of it (a failed copy's journal) are too.
    await cleanup([temp, `${temp}-journal`, `${temp}-wal`, `${temp}-shm`], created);
    throw quotaMapped(p, error);
  }
  await syncDirectory(path.dirname(p));
}

/** copyOperatorFile reads the operator's file in pieces of this size. */
const COPY_CHUNK_BYTES = 1024 * 1024;

/** The bytes of `handle` from its start, each piece also fed to `hash`. */
async function* piecesOf(handle: FileHandle, hash: Hash): AsyncGenerator<Uint8Array, void, undefined> {
  for (let position = 0; ; ) {
    const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
    if (bytesRead === 0) return;
    position += bytesRead;
    const piece = buffer.subarray(0, bytesRead);
    hash.update(piece);
    yield piece;
  }
}

/**
 * 1c Task 29 (`backup:restore <file>`; preflight S8): copies the operator's file `src` (a path typed on the command
 * line, absolute or relative to the working directory, a symbolic link followed) to `dest`, atomically through a hidden
 * temporary sibling (as writeStreamAtomic), after `ensureHeadroom(<dest's DATA_DIR>, 2 × size)`. A regular file only,
 * of any size (read in pieces, never whole): a folder, a FIFO or a device is refused before anything is written.
 *
 * @returns the bytes copied and their SHA-256 (hex)
 * @throws DomainError `STATE_CORRUPT` `not_a_file`; `DISK_QUOTA` (P21: from the probe, or from the copy, whose
 *   temporary file is removed); the open error of `src` (ENOENT, EACCES, ...) as it is
 * @throws TypeError for an empty `src` or one holding a NUL, or a `dest` outside every DATA_DIR
 */
export async function copyOperatorFile(src: string, dest: DataPath): Promise<{ size: number; sha256: string }> {
  if (typeof src !== 'string' || src === '' || src.includes('\0')) throw new TypeError('copyOperatorFile: src must be a non-empty path');
  const root = dataRootOf(dest);
  if (root === null) throw new TypeError('copyOperatorFile: dest must lie in a DATA_DIR');
  let handle: FileHandle;
  try {
    handle = await fsp.open(path.resolve(src), fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK || 0));
  } catch (error) {
    if (errorCode(error) === 'EISDIR') throw stateError(src, 'not_a_file');
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw stateError(src, 'not_a_file');
    await ensureHeadroom(root, 2 * info.size);
    const hash = createHash('sha256');
    const { bytes } = await writeStreamAtomic(dest, piecesOf(handle, hash));
    return { size: bytes, sha256: hash.digest('hex') };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export interface DataDirUsageOptions {
  /** Stop after this many folder entries (files, folders and anything else). Default 200 000. */
  maxEntries?: number;
  /** Stop after this many milliseconds. Default 5000. */
  maxMs?: number;
}

export interface DataDirUsage {
  /** The sizes of the regular files counted, in bytes. */
  bytes: number;
  /** The number of regular files counted. */
  files: number;
  /** True when a bound stopped the walk: the numbers are a lower bound. */
  truncated: boolean;
}

/**
 * How much DATA_DIR holds: the walk adds up the sizes of the regular files below it, never following a symbolic link,
 * and stops at `maxEntries` entries or after `maxMs` (then `truncated` is true and the numbers are a lower bound).
 * A DATA_DIR that does not exist holds nothing; a folder that cannot be read is skipped.
 */
export async function dataDirUsage(dataDir: string, o: DataDirUsageOptions = {}): Promise<DataDirUsage> {
  const maxEntries = o.maxEntries ?? USAGE_MAX_ENTRIES;
  const maxMs = o.maxMs ?? USAGE_MAX_MS;
  const started = performance.now();
  const outOfTime = (): boolean => performance.now() - started >= maxMs;
  let bytes = 0;
  let files = 0;
  let entries = 0;
  const stack: string[] = [dataPath(dataDir, 'root')];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let list: Dirent[];
    try {
      list = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // gone meanwhile, or not readable
    }
    const names: string[] = [];
    for (const entry of list) {
      if (entries >= maxEntries || outOfTime()) return { bytes, files, truncated: true };
      entries += 1;
      if (entry.isDirectory()) stack.push(path.join(dir, entry.name));
      else if (entry.isFile()) names.push(entry.name);
    }
    for (let i = 0; i < names.length; i += USAGE_STAT_BATCH) {
      const infos = await Promise.all(
        names.slice(i, i + USAGE_STAT_BATCH).map((name) => fsp.lstat(path.join(dir, name)).catch(() => null)),
      );
      for (const info of infos) {
        if (info !== null && info.isFile()) {
          bytes += info.size;
          files += 1;
        }
      }
      if (outOfTime()) return { bytes, files, truncated: true };
    }
  }
  return { bytes, files, truncated: false };
}

// ---- Phase 2 (catalog): Task 3 ----

/**
 * S3: a real catalog run takes over the work folder of its dry run (`tmp/<fromRunId>` becomes `tmp/<toRunId>`, with
 * every file in it: an import's input, a SLiMS dump's per-table staging, the files archive), so the upload is not sent
 * twice. One rename of the folder (retried while the file system is busy), then the parent is flushed.
 *
 * Call it before anything is written into the new run's folder: an existing `tmp/<toRunId>` (or a run adopting its own
 * folder) is refused, and both folders are left as they were. Two adoptions of one dry run race on the rename: the
 * second finds no source and is refused like a dry run whose work is gone.
 *
 * @throws DomainError `NOT_FOUND` when `tmp/<fromRunId>` is not a folder (never made, expired, adopted already);
 *   `INVALID_PATH_SEGMENT` for an id that is not a ULID (see {@link runWorkDir}) and, with `meta.reason:
 *   'target_exists'`, when `tmp/<toRunId>` exists; `DISK_QUOTA` as for every helper here
 */
export async function adoptRunWork(dataDir: string, fromRunId: string, toRunId: string): Promise<void> {
  const from = runWorkDir(dataDir, fromRunId);
  const to = runWorkDir(dataDir, toRunId);
  const gone = (): DomainError =>
    new DomainError('NOT_FOUND', {
      detail:
        'Folder kerja uji kering tidak ditemukan (sudah dipakai atau kedaluwarsa) / ' +
        "The dry run's work folder was not found (already used or expired)",
    });
  if ((await statOrNull(from))?.kind !== 'dir') throw gone();
  if ((await statOrNull(to)) !== null) {
    throw new DomainError('INVALID_PATH_SEGMENT', {
      detail: 'Folder kerja run tujuan sudah ada / The target run already has a work folder',
      meta: { area: 'tmp', reason: 'target_exists' },
    });
  }
  try {
    await renameWithRetry(from, to);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') throw gone();
    throw quotaMapped(to, error);
  }
  await syncDirectory(path.dirname(to));
}
