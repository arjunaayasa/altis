import { randomBytes } from 'node:crypto';
import fsp, { type FileHandle } from 'node:fs/promises';
import nodePath from 'node:path';
import { DomainError } from '@altis/shared';

// Atomic state files (spec §9.3, P-rules on `current.json`, `config.json`, ...).
//
// Every state file is replaced as a whole: write a temporary file, fsync it, rename it over the real
// one, fsync the directory. A power cut therefore leaves either the old or the new content, never a mix,
// except on file systems that reorder metadata, which is what the `.bak` copy is for.
//
// Writers must still serialise with `withFileLock`: two unlocked writers could interleave their `.bak`
// updates. Readers need no lock, because a rename is atomic.

export interface AtomicWriteOptions {
  /** Permission bits of the new file and of its `.bak` (subject to the umask). Default `0o600`. */
  mode?: number;
}

const DEFAULT_MODE = 0o600;

/** Rename retries (Windows antivirus and indexers briefly lock files): 50 ms doubling to 1 s, for at most 10 s per write. */
const RENAME_FIRST_DELAY_MS = 50;
const RENAME_MAX_DELAY_MS = 1000;
const RENAME_DEADLINE_MS = 10_000;

/** `fsync` on a directory is unsupported on some file systems; these codes mean "cannot", not "failed". */
const DIR_SYNC_UNSUPPORTED = new Set(['EINVAL', 'ENOTSUP', 'EPERM', 'EACCES', 'EISDIR', 'EBADF']);

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tempName(target: string): string {
  return `${target}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
}

/** Creates `file` exclusively, writes `data`, fsyncs and closes it. */
async function writeSynced(file: string, data: string | Uint8Array, mode: number): Promise<void> {
  const handle = await fsp.open(file, 'wx', mode);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Whether a failed rename may succeed when tried again: `EPERM`/`EBUSY` anywhere, and on Windows also `EACCES`,
 * which an antivirus scanner or the indexer briefly holding the file causes there (graceful-fs retries the same
 * three on win32; lock.ts does too). Elsewhere `EACCES` is a real permission problem.
 */
function renameRetryable(code: string | undefined): boolean {
  return code === 'EPERM' || code === 'EBUSY' || (code === 'EACCES' && process.platform === 'win32');
}

/**
 * A `rename` that retries with backoff while Windows reports `EPERM`/`EBUSY` (or `EACCES` on Windows,
 * {@link renameRetryable}), for at most 10 s in total across every rename it is used for (spec: "ulang <= 10
 * detik"). The budget starts at the first attempt and is measured with `performance.now()`, which a clock step
 * cannot disturb. Other errors are not retried.
 */
function createRenamer(): (from: string, to: string) => Promise<void> {
  let deadline: number | undefined;
  return async (from, to) => {
    if (deadline === undefined) deadline = performance.now() + RENAME_DEADLINE_MS;
    let delay = RENAME_FIRST_DELAY_MS;
    for (;;) {
      try {
        await fsp.rename(from, to);
        return;
      } catch (error) {
        if (!renameRetryable(errorCode(error))) throw error;
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw error;
        await sleep(Math.min(delay, remaining));
        delay = Math.min(delay * 2, RENAME_MAX_DELAY_MS);
      }
    }
  };
}

async function syncDirectory(dir: string): Promise<void> {
  if (process.platform === 'win32') return; // directories cannot be opened (or fsynced) on Windows
  let handle: FileHandle | undefined;
  try {
    handle = await fsp.open(dir, 'r');
    await handle.sync();
  } catch (error) {
    const code = errorCode(error);
    if (code === undefined || !DIR_SYNC_UNSUPPORTED.has(code)) throw error;
  } finally {
    await handle?.close();
  }
}

/** Strips a UTF-8 byte-order mark (Notepad adds one when an operator edits `config.json` by hand). */
function parseJsonText(text: string): unknown {
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

function parsesAsJson(bytes: Buffer): boolean {
  try {
    parseJsonText(bytes.toString('utf8'));
    return true;
  } catch {
    return false;
  }
}

/** Copies the current main file to `${path}.bak`, but only when it is intact (never overwrite a good copy with garbage). */
async function refreshBackup(
  path: string,
  mode: number,
  scratch: string[],
  rename: (from: string, to: string) => Promise<void>,
): Promise<void> {
  let current: Buffer;
  try {
    current = await fsp.readFile(path);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return; // first write: nothing to keep
    throw error;
  }
  if (!parsesAsJson(current)) return;
  const bakTemp = tempName(`${path}.bak`);
  scratch.push(bakTemp);
  await writeSynced(bakTemp, current, mode);
  await rename(bakTemp, `${path}.bak`);
}

/**
 * Replaces the JSON file at `path` atomically, keeping the previous good content in `${path}.bak`.
 *
 * Procedure: write `${path}.tmp-<pid>-<rand>`, fsync, close; copy the current main file to `.bak` if it
 * parses as JSON (same temp + rename procedure); rename the temp file over the main file, retrying with
 * backoff (50 ms up to 1 s) while the OS reports `EPERM`/`EBUSY` (and `EACCES` on Windows), for at most 10 s in
 * total for both renames; fsync the directory (skipped on Windows). On failure the temporary files are removed and the main file is left untouched.
 *
 * The directory must exist. Callers that can race should hold `withFileLock` around the write.
 */
export async function atomicWriteJson(path: string, value: unknown, opts: AtomicWriteOptions = {}): Promise<void> {
  const mode = opts.mode ?? DEFAULT_MODE;
  const text = JSON.stringify(value, null, 2);
  if (text === undefined) throw new TypeError('atomicWriteJson: value cannot be represented as JSON');

  const temp = tempName(path);
  const scratch = [temp]; // files to remove if anything goes wrong
  try {
    await writeSynced(temp, `${text}\n`, mode);
    const rename = createRenamer(); // one 10 s budget for the .bak rename and the main rename together
    await refreshBackup(path, mode, scratch, rename);
    await rename(temp, path);
  } catch (error) {
    await Promise.all(scratch.map((file) => fsp.rm(file, { force: true }).catch(() => undefined)));
    throw error;
  }
  await syncDirectory(nodePath.dirname(path));
}

type ReadResult<T> = { status: 'missing' } | { status: 'corrupt' } | { status: 'ok'; value: T };

async function readOne<T>(file: string, parse: (raw: unknown) => T): Promise<ReadResult<T>> {
  let text: string;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { status: 'missing' };
    throw error; // EISDIR, EACCES, EIO...: not "missing" and not "corrupt", so do not guess
  }
  try {
    return { status: 'ok', value: parse(parseJsonText(text)) };
  } catch {
    return { status: 'corrupt' };
  }
}

/**
 * Reads a state file written by {@link atomicWriteJson}. A file that does not parse as JSON, or that
 * `parse` rejects (by throwing), is treated as corrupt and the `.bak` copy is used instead.
 *
 * @returns the parsed value, or `null` when neither the file nor its `.bak` exists
 * @throws DomainError `STATE_CORRUPT` when a file exists but neither it nor the `.bak` is usable
 * @throws the underlying error for I/O failures other than a missing file (for example `EACCES`)
 */
export async function readJsonWithBak<T>(path: string, parse: (raw: unknown) => T): Promise<T | null> {
  const main = await readOne(path, parse);
  if (main.status === 'ok') return main.value;
  const bak = await readOne(`${path}.bak`, parse);
  if (bak.status === 'ok') return bak.value;
  if (main.status === 'missing' && bak.status === 'missing') return null;

  throw new DomainError('STATE_CORRUPT', {
    detail:
      `Berkas status ${path} rusak dan salinan .bak tidak dapat dipakai; pulihkan dari cadangan / ` +
      `State file ${path} is corrupt and its .bak copy is not usable; restore it from a backup`,
    meta: { reason: 'state_unreadable', path },
  });
}
