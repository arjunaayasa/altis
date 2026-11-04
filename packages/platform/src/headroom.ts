import { randomBytes } from 'node:crypto';
import fsp, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { DomainError } from '@altis/shared';
import { dataPath } from './datapath.js';
import { realpathNearest } from './pathutil.js';

// Disk headroom probe (spec P21). `statfs` cannot be trusted on shared hosting, where the limit is a cPanel
// quota rather than the size of the disk, so room is found out the only reliable way: by writing it.

const MIB = 1024 * 1024;
/** Zeros are written in chunks of this size. */
const CHUNK_BYTES = MIB;
/**
 * The probe never writes more than this, however much is asked for. A bigger request is not proven up front:
 * it relies on the real write hitting ENOSPC/EDQUOT and aborting (P21).
 */
const MAX_PROBE_BYTES = 64 * MIB;
/** A positive result is trusted this long. */
const CACHE_MS = 10 * 60 * 1000;
/** A probe file older than this was left behind by a process that was killed, and is removed. */
const STALE_PROBE_MS = 60 * 60 * 1000;
const PROBE_FILE = /^headroom-[0-9a-f]{16}$/;

/** What has been proven for one real directory: `proven` bytes were writable until `expires` (`performance.now()`). */
interface Proof {
  proven: number;
  expires: number;
}

/** A probe in progress, and how many bytes it is writing. */
interface Flight {
  size: number;
  promise: Promise<void>;
}

const verified = new Map<string, Proof>();
/** Probes in progress per real directory, so that concurrent callers (three upload sessions, say) share them. */
const inFlight = new Map<string, Flight[]>();

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
}

/** Removes probe files that a killed process left behind (each can be 512 MiB). Best effort. */
async function sweepStale(tmpDir: string): Promise<void> {
  try {
    const cutoff = Date.now() - STALE_PROBE_MS;
    for (const name of await fsp.readdir(tmpDir)) {
      if (!PROBE_FILE.test(name)) continue;
      const file = path.join(tmpDir, name);
      try {
        if ((await fsp.lstat(file)).mtimeMs < cutoff) await fsp.rm(file, { force: true });
      } catch {
        // gone already, or not ours to remove: leave it
      }
    }
  } catch {
    // an unreadable tmp directory shows up in the probe itself
  }
}

/** Writes `bytes` of zeros to a new file in DATA_DIR/tmp, fsyncs it and removes it again. Throws the raw I/O error. */
async function probe(dir: string, bytes: number): Promise<void> {
  const tmpDir = dataPath(dir, 'tmp');
  const file = path.join(tmpDir, `headroom-${randomBytes(8).toString('hex')}`);
  let handle: FileHandle | undefined;
  try {
    try {
      await fsp.mkdir(tmpDir, { mode: 0o700 }); // DATA_DIR itself must exist already
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
    }
    await sweepStale(tmpDir);

    handle = await fsp.open(file, 'wx', 0o600);
    const zeros = Buffer.alloc(CHUNK_BYTES);
    for (let left = bytes; left > 0; ) {
      const { bytesWritten } = await handle.write(zeros, 0, Math.min(CHUNK_BYTES, left));
      if (!(bytesWritten > 0)) throw new Error(`headroom probe: a write to ${file} made no progress`);
      left -= bytesWritten;
    }
    await handle.sync();
    const done = handle;
    handle = undefined;
    await done.close(); // NFS reports a quota overrun here at the latest
  } finally {
    await handle?.close().catch(() => undefined);
    await fsp.rm(file, { force: true }).catch(() => undefined);
  }
}

/** The error to report to one caller when the file system said "full" or "over quota"; null for any other error. */
function quotaError(error: unknown, dir: string, requested: number, probed: number): DomainError | null {
  const code = errorCode(error);
  if (code !== 'ENOSPC' && code !== 'EDQUOT') return null;
  const wanted = Math.ceil(requested / MIB);
  const tried = Math.ceil(probed / MIB);
  return new DomainError('DISK_QUOTA', {
    detail:
      `Ruang disk atau kuota hosting habis di ${dir}: diperlukan ${wanted} MB, penulisan uji ${tried} MB gagal / ` +
      `The disk is full or the hosting quota is used up in ${dir}: ${wanted} MB needed, the ${tried} MB test write failed`,
    meta: { reason: 'headroom', code, requested, probed },
    cause: error,
  });
}

/** Records that `size` bytes were writable, never lowering what an earlier, still valid probe proved. */
function remember(key: string, size: number): void {
  const now = performance.now();
  const earlier = verified.get(key);
  if (earlier !== undefined && now < earlier.expires && earlier.proven >= size) return; // the stronger proof stands
  verified.set(key, { proven: size, expires: now + CACHE_MS });
}

function startProbe(key: string, dir: string, size: number): Flight {
  const promise = probe(dir, size)
    .then(() => {
      remember(key, size);
    })
    .finally(() => {
      const rest = (inFlight.get(key) ?? []).filter((other) => other !== flight);
      if (rest.length > 0) inFlight.set(key, rest);
      else inFlight.delete(key);
    });
  const flight: Flight = { size, promise };
  inFlight.set(key, [...(inFlight.get(key) ?? []), flight]);
  return flight;
}

/**
 * Makes sure that `bytes` can still be written under `dir` (DATA_DIR) by writing that many zeros to
 * `tmp/headroom-<random>`, fsyncing and deleting the file. The probe writes exactly `bytes` (rounded up to a
 * whole byte) and never more than 64 MiB: a bigger request is only proven up to 64 MiB and then relies on the
 * real write failing with ENOSPC/EDQUOT and aborting (P21). The `tmp` folder is created when it is missing;
 * `dir` itself must exist.
 *
 * Cache: one entry per real path of `dir`, holding the largest size proven and when it expires (10 minutes
 * after the probe that proved it). A request is answered from it when it is no bigger than what is proven and
 * the entry has not expired; a probe that succeeds raises the proven size to the largest of the two, and a
 * failure is never remembered. A caller that arrives while a probe of at least its own size is running waits
 * for that probe instead of starting one. Probe files that a killed process left in `tmp` for over an hour are
 * removed first.
 *
 * `o.fresh` (S10: a writer that re-checks its room while it writes, such as splitDump every 64 MiB) skips the cache
 * lookup, so the room is proven by a probe that ends after the call began; it still waits for a big enough probe in
 * flight rather than starting one, and a success is remembered as any other is.
 *
 * @throws DomainError `DISK_QUOTA` when the disk is full or the quota is used up (`ENOSPC`, `EDQUOT`), whether
 *   the file system says so on create, write, fsync or close; `meta` holds `requested` and `probed` (the size
 *   that was actually written, at most 64 MiB)
 * @throws RangeError when `bytes` is negative or not finite
 * @throws the underlying error for any other I/O failure
 */
export async function ensureHeadroom(dir: string, bytes: number, o: { fresh?: boolean } = {}): Promise<void> {
  if (!Number.isFinite(bytes) || bytes < 0) {
    throw new RangeError(`ensureHeadroom: bytes must be a finite number of at least 0, got ${bytes}`);
  }
  if (bytes === 0) return;

  const size = Math.ceil(Math.min(bytes, MAX_PROBE_BYTES));
  const key = realpathNearest(dir);

  const proof = verified.get(key);
  if (proof !== undefined && o.fresh !== true) {
    if (performance.now() >= proof.expires) verified.delete(key);
    else if (size <= proof.proven) return;
  }

  const flight = (inFlight.get(key) ?? []).find((running) => running.size >= size) ?? startProbe(key, dir, size);
  try {
    await flight.promise;
  } catch (error) {
    throw quotaError(error, dir, bytes, flight.size) ?? error;
  }
}
