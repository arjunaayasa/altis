import { randomBytes } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import nodePath from 'node:path';

// A size-rotated, append-only text file for up to six Passenger workers (plus the cron CLI) that all log to the
// same `DATA_DIR/logs/altis.log` (ruling R46). The logger formats and redacts; every file system call of the log
// lives here, because apps/** may not call fs (rule `altis/no-nonliteral-fs`).
//
// Appending. Each `append` is one synchronous `write` of one complete text on a file opened with O_APPEND, so the
// kernel places it at the end of the file and the texts of different processes never interleave, however many
// processes write. Rotation is by the numbers, `altis.log` → `altis.log.1` → ... → `altis.log.<files-1>`, so at
// most `files` files exist; a gap in the chain is filled, never shifted past (see shiftChain).
//
// Another process rotates. Every `append` first looks at the path (one `stat`): when it no longer is the file this
// process has open (inode or device differ, or it is gone), the process closes its handle and opens the path
// again. Without this a worker would go on writing into `altis.log.1`, or, once that file is pushed off the end of
// the chain, into a file nobody can see any more.
//
// Rotation. A text that would take the file past `maxBytes` rotates it first (a file is never rotated while empty,
// so one text longer than `maxBytes` is written whole), and the text is written to the fresh file: a rotation never
// costs this process a line. Rotation shifts the whole chain, so two processes must not do it at once; they take
// a claim for it, the file `rotate.lock`, created with O_EXCL (synchronously: a log call cannot wait):
//   - a claim younger than 10 s belongs to a process that is rotating right now: skip the rotation, write the text
//     to the file as it is (it is rotated by that process, or by the next call here);
//   - an older claim was left by a process that died; it is removed once and the claim retried (it is removed
//     only if it is still the very file that was judged stale);
//   - holding the claim, the process looks at the path once more and rotates only if it is still the file whose
//     size it saw. Another process may have rotated between the size check and the claim, and rotating the fresh
//     file as well would push a whole file of history off the chain.
// The claim holds a random token and is removed only by its owner. The claim is not a lock in the sense of
// `withFileLock` (no heartbeat, no waiting): rotation takes a few renames, far below the 10 s.
//
// A rotation that fails (permissions, a held file on Windows) is reported through `onError`, the text is still
// written, and this process does not try again for 30 s, so that a persistent failure cannot repeat the shift of
// the chain on every line and wear the history away.
//
// Limits: the size is a soft limit (a few processes may each add one line between the check and the write), and
// the file system must give files stable inode numbers (every local one does).

export interface RotatingFileOptions {
  /** Rotate before a write that would take the file past this size, in bytes. A positive integer. */
  maxBytes: number;
  /** Files kept: `altis.log` and `altis.log.1` ... `altis.log.<files-1>`. 1 to 10 (the data path accepts `.1` to `.9`). */
  files: number;
  /** The claim file. Default: `rotate.lock` next to the log. */
  lockPath?: string;
  /** Called with a failure of the rotation itself; the text that triggered it is still written. Must not throw. */
  onError?: (error: unknown) => void;
}

export interface RotatingFile {
  /**
   * Appends `text` (a complete line, with its newline) as one write. Creates the file, and its directory, when
   * missing. Synchronous.
   *
   * @throws the underlying error when the file cannot be opened or written (`EACCES`, `ENOSPC`, ...)
   */
  append(text: string): void;
  /** Closes the file handle. Idempotent; a later `append` opens the file again. */
  close(): void;
}

const MAX_FILES = 10;
/** A claim younger than this (either way, to forgive a skewed clock) belongs to a process that is rotating. */
const CLAIM_FRESH_MS = 10_000;
/** After a failed rotation, this process leaves it alone for this long. */
const RETRY_AFTER_FAILURE_MS = 30_000;
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const BIGINT_STAT = { bigint: true, throwIfNoEntry: false } as const;

type Identity = { dev: bigint; ino: bigint };

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
}

function sameFile(a: Identity, b: Identity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/** Whether `lockPath` is held by a live rotation: its age is below the limit, in either direction. */
function isFresh(mtimeMs: bigint): boolean {
  return Math.abs(Date.now() - Number(mtimeMs)) < CLAIM_FRESH_MS;
}

/**
 * Opens (creating it, and its directory, when missing) `path` for appending, and returns the descriptor with the
 * identity of the file it really is.
 */
function openAppend(path: string): { fd: number; identity: Identity } {
  let fd: number;
  try {
    fd = openSync(path, 'a', FILE_MODE);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
    mkdirSync(nodePath.dirname(path), { recursive: true, mode: DIR_MODE });
    fd = openSync(path, 'a', FILE_MODE);
  }
  try {
    const { dev, ino } = fstatSync(fd, { bigint: true });
    return { fd, identity: { dev, ino } };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

/** Renames `from` to `to`, replacing `to`; a missing `from` is not an error (the chain has gaps while it fills). */
function shiftFile(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
}

export function createRotatingFile(path: string, opts: RotatingFileOptions): RotatingFile {
  const { maxBytes, files } = opts;
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError('createRotatingFile: maxBytes must be a positive integer');
  }
  if (!Number.isInteger(files) || files < 1 || files > MAX_FILES) {
    throw new RangeError(`createRotatingFile: files must be an integer from 1 to ${MAX_FILES}`);
  }
  const lockPath = opts.lockPath ?? nodePath.join(nodePath.dirname(path), 'rotate.lock');
  const report = opts.onError ?? (() => undefined);

  let fd: number | undefined;
  let identity: Identity | undefined;
  let rotateAgainAfter = 0; // performance.now() value

  function closeHandle(): void {
    const old = fd;
    fd = undefined;
    identity = undefined;
    if (old === undefined) return;
    try {
      closeSync(old);
    } catch {
      // nothing useful to do about a failed close
    }
  }

  /** The file the path names now, opened if this process does not have it open yet, with its size. */
  function currentFile(): Identity & { fd: number; size: number } {
    const onDisk = statSync(path, BIGINT_STAT);
    if (onDisk !== undefined && fd !== undefined && identity !== undefined && sameFile(identity, onDisk)) {
      return { dev: onDisk.dev, ino: onDisk.ino, fd, size: Number(onDisk.size) };
    }
    closeHandle();
    const opened = openAppend(path);
    fd = opened.fd;
    identity = opened.identity;
    return { ...opened.identity, fd: opened.fd, size: Number(fstatSync(opened.fd, { bigint: true }).size) };
  }

  /** The claim token, or null when another process is rotating (or the claim cannot be taken). */
  function claim(): string | null {
    const token = randomBytes(8).toString('hex');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const claimFd = openSync(lockPath, 'wx', FILE_MODE);
        try {
          writeSync(claimFd, token);
        } finally {
          closeSync(claimFd);
        }
        return token;
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error;
      }
      const held = statSync(lockPath, BIGINT_STAT);
      if (held === undefined) continue; // released in the meantime: try again
      if (isFresh(held.mtimeMs)) return null;
      // Stale: its holder died. Remove it, but only if it still is the file we judged stale.
      const again = statSync(lockPath, BIGINT_STAT);
      if (again !== undefined && sameFile(again, held) && again.mtimeNs === held.mtimeNs) {
        try {
          unlinkSync(lockPath);
        } catch (error) {
          if (errorCode(error) !== 'ENOENT') throw error;
        }
      }
    }
    return null;
  }

  function release(token: string): void {
    try {
      if (readFileSync(lockPath, 'utf8') === token) unlinkSync(lockPath);
    } catch {
      // already gone, or no longer ours
    }
  }

  /**
   * Shifts the chain by one place and starts a new `path`. Only the files before the first gap move: with `.k`
   * missing, `.k-1` ... `.1` move up into it and nothing after it is touched (a full chain drops its oldest file,
   * `.files-1`). A rename of `path` that fails (on Windows, a program holding the log open without
   * FILE_SHARE_DELETE, such as PowerShell's `Get-Content -Wait`) leaves a gap at `.1`, and every later attempt then
   * only retries that rename instead of pushing another file of history off the end.
   */
  function shiftChain(): void {
    if (files === 1) {
      unlinkSync(path);
      return;
    }
    let gap = 1;
    while (gap < files - 1 && statSync(`${path}.${gap}`, BIGINT_STAT) !== undefined) gap += 1;
    for (let i = gap - 1; i >= 1; i -= 1) shiftFile(`${path}.${i}`, `${path}.${i + 1}`);
    renameSync(path, `${path}.1`);
  }

  /** Rotates `seen` (the file whose size was checked) unless somebody else did it first. */
  function rotate(seen: Identity): void {
    if (performance.now() < rotateAgainAfter) return;
    let token: string | null = null;
    try {
      token = claim();
      if (token === null) return;
      const now = statSync(path, BIGINT_STAT);
      if (now === undefined || !sameFile(now, seen)) return; // rotated by another process meanwhile
      closeHandle();
      shiftChain();
    } catch (error) {
      rotateAgainAfter = performance.now() + RETRY_AFTER_FAILURE_MS;
      report(error);
    } finally {
      if (token !== null) release(token);
    }
  }

  function writeAll(target: number, data: Buffer): void {
    try {
      for (let done = 0; done < data.length; ) {
        done += writeSync(target, data, done, data.length - done);
      }
    } catch (error) {
      closeHandle(); // do not keep a handle that failed
      throw error;
    }
  }

  return {
    append(text: string): void {
      const data = Buffer.from(text, 'utf8');
      if (data.length === 0) return;
      let file = currentFile();
      if (file.size > 0 && file.size + data.length > maxBytes) {
        rotate(file);
        file = currentFile(); // after a rotation, the path is a new file
      }
      writeAll(file.fd, data);
    },
    close: closeHandle,
  };
}
