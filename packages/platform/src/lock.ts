import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, readlinkSync, utimesSync } from 'node:fs';
import fsp, { type FileHandle } from 'node:fs/promises';
import os from 'node:os';
import { DomainError } from '@altis/shared';

// Advisory file locks (spec §9.3, §4.5): up to six Passenger workers and a cron CLI share one DATA_DIR,
// so state files (`current.json`, `config.json`, ...) and the migration are guarded by lock *files*.
//
// A lock is a file created with O_EXCL whose content is `{pid, startMs, token, host}`:
//   - `pid`/`startMs` identify the holding process (`startMs` is its start time, so that a pid reused by a
//     later process, for example after a container restart, is recognised);
//   - `host` is this host's lock identity (rulings R25(b), R33): os.hostname() plus, on Linux, the kernel's boot
//     id (`/proc/sys/kernel/random/boot_id`) and the PID namespace (`/proc/self/ns/pid`), e.g.
//     `box/6f1c0d3e-…/pid:[4026531836]`. Pids only compare within one PID namespace of one running kernel, so the
//     pid rules below apply only to a record with exactly this identity. Containers on one host share the boot id
//     and differ in the PID namespace; separate kernels (VMs, microVMs, sandboxes) differ in the boot id, even
//     when both run in the initial PID namespace, whose id is the same constant on every Linux kernel. A record of
//     another identity (two containers sharing a DATA_DIR volume, where node is PID 1 in both, even with one
//     hostname through network_mode: host or a shared `hostname:`), in an older format (hostname/PID namespace,
//     written before the boot id was added; hostname only, before R33) or without a host (before R25(b)) is
//     judged by its mtime alone. Ruling R36: a record with our hostname and PID namespace but another boot id was
//     written by this host before it last booted, so its holder is gone and the lock is taken over at once (a
//     service, PM2 or standalone process after a power cut: the initial PID namespace keeps its id across boots).
//     Docker containers recreated after a host reboot get a new PID namespace, so their old records are judged by
//     mtime and still wait `staleMs` (30 s; 10 min for SQLite's migrate.lock, R31). Cost of R36: two kernels with
//     the same hostname AND the same PID namespace id sharing one DATA_DIR could both hold the lock (contrived);
//   - `token` is random per acquisition, so that only the owner removes or refreshes the file.
// A lock is stale when its holder (on this host) is gone (`process.kill(pid, 0)` says ESRCH) or when its mtime is
// older than `staleMs`. A live holder keeps the mtime fresh while `fn` runs, so a long critical section (a
// migration) is not mistaken for a crashed one. The refresh is one synchronous step of the heartbeat timer, so it
// happens whenever the timer gets to run, even when the holder lets the event loop turn only now and then
// (synchronous node:sqlite work between yields). Being synchronous, it also blocks the event loop while the file
// system does not answer: on a DATA_DIR on a stalled hard-mounted NFS share, every beat stalls the whole process
// (ruling R34). DATA_DIR belongs on a local disk. Not re-entrant: nesting the same lock deadlocks until
// `waitMs` runs out.
//
// Two ways to hold a lock: `withFileLock` around one call (waiting for it), and `acquireFileLock` (1d, spec §9.3's
// `releases/boot.lock`) for a hold that outlives a call, taken only when free right now and let go by its handle.
// `processGone` is the liveness rule above, for other records that name a process (boot markers).
//
// Time: elapsed-time budgets (`waitMs`, patience for I/O errors) use `performance.now()`, which a clock
// step does not disturb. Only the comparison with the lock file's mtime uses the wall clock, because the
// mtime is wall-clock time.

export interface FileLockOptions {
  /**
   * A lock whose holder is gone, or whose mtime is older than this, may be taken over. Default 30 000.
   *
   * Use the same value for every caller of one lock path: the holder refreshes the mtime every
   * `min(staleMs / 3, 10 s)` while the lock is held, and a waiter judges by its own `staleMs`. To keep a
   * mismatch from ever stealing a live lock, a waiter never takes a lock whose mtime is younger than 30 s,
   * so a `staleMs` below 30 000 is raised to 30 000.
   */
  staleMs?: number;
  /** How long to wait for a held lock before giving up. Default 10 000. */
  waitMs?: number;
}

const DEFAULT_STALE_MS = 30_000;
const DEFAULT_WAIT_MS = 10_000;
/** Heartbeat: the holder touches the lock every `min(staleMs / 3, 10 s)`, so a refresh is never more than 10 s old. */
const HEARTBEAT_MAX_MS = 10_000;
/** A waiter never judges a lock stale sooner than this after its last refresh (3 missed heartbeats at the slowest cadence). */
const MIN_STALE_MS = 30_000;
/** Waiters poll with exponential backoff, 25 ms doubling up to 250 ms, with jitter so that waiters do not move in step. */
const POLL_FIRST_MS = 25;
const POLL_MAX_MS = 250;
/** Outside Windows, EACCES/EPERM that lasts this long is a real permission problem, not contention. */
const PERMISSION_PATIENCE_MS = 2000;
/** Two start times of one process, computed at different moments, differ by a few ms; a recycled pid differs by far more. */
const START_TIME_TOLERANCE_MS = 2000;
const MAX_PID = 2 ** 31 - 1;

/**
 * Test hook, compiled out of production builds (dead branch once `__BUILD_PROFILE__` is 'production'): with
 * ALTIS_TEST_LOCK_STALE_MS=<ms> every lock goes stale after that many ms (it replaces the caller's `staleMs`, the
 * default and the 30 s floor; the heartbeat follows as `staleMs / 3`), so tests can exercise staleness and
 * heartbeats without waiting for 30 s or 10 min. Absent or invalid: the production timings.
 */
function testStaleMs(): number | undefined {
  if (typeof __BUILD_PROFILE__ !== 'undefined' && __BUILD_PROFILE__ !== 'production') {
    const value = Number(process.env['ALTIS_TEST_LOCK_STALE_MS']);
    if (Number.isInteger(value) && value > 0) return value;
  }
  return undefined;
}

const START_KEY = Symbol.for('altis.processStartMs');

/**
 * When this process started, as recorded in the locks it takes.
 *
 * Stored on `globalThis` so that every copy of this module in the process agrees: `app.js` and `server.mjs`
 * each bundle their own copy, and computing the value per copy would give each a slightly different one.
 */
export function processStartMs(): number {
  const shared = globalThis as unknown as Record<symbol, unknown>;
  const known = shared[START_KEY];
  if (typeof known === 'number') return known;
  const startMs = Math.round(Date.now() - process.uptime() * 1000);
  shared[START_KEY] = startMs;
  return startMs;
}

const PROCESS_START_MS = processStartMs();

/** The parts of a host identity; null for a part this OS does not have. */
interface HostParts {
  hostname: string;
  bootId: string | null;
  pidNamespace: string | null;
}

function hostParts(hostname: string, readBootId: () => string, readPidNamespace: () => string): HostParts {
  const part = (read: () => string): string | null => {
    try {
      const value = read().trim();
      return value === '' ? null : value;
    } catch {
      return null; // not Linux, or no /proc
    }
  };
  return { hostname, bootId: part(readBootId), pidNamespace: part(readPidNamespace) };
}

function joined(parts: HostParts): string {
  return [parts.hostname, parts.bootId, parts.pidNamespace].filter((p): p is string => p !== null).join('/');
}

/**
 * A host identity for lock records (R33): `hostname`, then `/` and the boot id that `readBootId` returns (Linux:
 * `/proc/sys/kernel/random/boot_id`, one per kernel boot), then `/` and the PID namespace that `readPidNamespace`
 * returns (Linux: the link `/proc/self/ns/pid`, e.g. `pid:[4026531836]`). Each part is trimmed; a part that cannot
 * be read (not Linux, no /proc) or is empty is left out, down to the hostname alone.
 */
export function hostIdentity(hostname: string, readBootId: () => string, readPidNamespace: () => string): string {
  return joined(hostParts(hostname, readBootId, readPidNamespace));
}

const readBootId = (): string => readFileSync('/proc/sys/kernel/random/boot_id', 'utf8');
const readPidNamespace = (): string => readlinkSync('/proc/self/ns/pid');

let ownParts: HostParts | undefined;

/**
 * This host's identity parts, computed once. Test hooks, compiled out of production builds:
 * ALTIS_TEST_LOCK_BOOTID=<id> stands for the boot id and ALTIS_TEST_LOCK_PIDNS=<id> for the PID namespace, so the
 * rules can be tested on any OS.
 */
function lockHostParts(): HostParts {
  if (typeof __BUILD_PROFILE__ !== 'undefined' && __BUILD_PROFILE__ !== 'production') {
    const bootId = process.env['ALTIS_TEST_LOCK_BOOTID'];
    const namespace = process.env['ALTIS_TEST_LOCK_PIDNS'];
    if ((bootId !== undefined && bootId !== '') || (namespace !== undefined && namespace !== '')) {
      return hostParts(
        os.hostname(),
        bootId !== undefined && bootId !== '' ? () => bootId : readBootId,
        namespace !== undefined && namespace !== '' ? () => namespace : readPidNamespace,
      );
    }
  }
  ownParts ??= hostParts(os.hostname(), readBootId, readPidNamespace);
  return ownParts;
}

/** This host's identity as recorded in the locks it takes (R25(b), R33); see {@link hostIdentity}. */
export function lockHostIdentity(): string {
  return joined(lockHostParts());
}

/**
 * R36: true for a record written by this very host before it last booted: its hostname and PID namespace are ours,
 * its boot id is another one. Its holder cannot be alive. Both identities need all three parts; any other mismatch
 * (another hostname or PID namespace, a missing part) says nothing about the holder.
 */
function fromPreviousBoot(host: string | null): boolean {
  const ours = lockHostParts();
  if (host === null || ours.bootId === null || ours.pidNamespace === null) return false;
  const [hostname, bootId, pidNamespace, ...rest] = host.split('/');
  return (
    rest.length === 0 &&
    hostname === ours.hostname &&
    pidNamespace === ours.pidNamespace &&
    bootId !== undefined &&
    bootId !== '' &&
    bootId !== ours.bootId
  );
}

interface LockInfo {
  pid: number;
  startMs: number;
  token: string;
  /** The holder's host identity; null for a record without one (written before R25(b)): an unknown host. */
  host: string | null;
}

/** The lock file as seen at one moment; `info` is null when its content is not a valid lock record. */
interface Snapshot {
  raw: string;
  mtimeMs: number;
  info: LockInfo | null;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseInfo(raw: string): LockInfo | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null; // empty or partial: the holder died between creating the file and writing it
  }
  if (typeof value !== 'object' || value === null) return null;
  const { pid, startMs, token } = value as Record<string, unknown>;
  // pid 0 and negative pids would make process.kill(pid, 0) address a whole process group.
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid < 1 || pid > MAX_PID) return null;
  if (typeof startMs !== 'number' || !Number.isFinite(startMs)) return null;
  if (typeof token !== 'string' || token === '') return null;
  const { host } = value as Record<string, unknown>;
  return { pid, startMs, token, host: typeof host === 'string' && host !== '' ? host : null };
}

/** Reads the lock file and its mtime from one open handle; null when there is no lock file. */
async function readSnapshot(lockPath: string): Promise<Snapshot | null> {
  let handle: FileHandle;
  try {
    handle = await fsp.open(lockPath, 'r');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
  try {
    const { mtimeMs } = await handle.stat();
    const raw = await handle.readFile('utf8');
    return { raw, mtimeMs, info: parseInfo(raw) };
  } finally {
    await handle.close();
  }
}

/**
 * True when the process a record names (a lock's holder, a boot marker's writer: `{pid, startMs, host}`) is known to
 * be gone (rulings R33, R36): a process of exactly this host identity whose pid no longer exists, or whose pid is
 * ours with another start time (a pid reused after a container restart); or a record this host wrote before it last
 * booted. A process of another host identity, or of none, cannot be judged by its pid: false, and only a time stamp
 * (a lock's mtime, a marker's refresh) can tell. So is a pid that is not a valid one (never signalled: 0 and negative
 * pids address process groups).
 */
export function processGone(info: { pid: number; startMs: number; host: string | null }): boolean {
  if (info.host !== lockHostIdentity()) return fromPreviousBoot(info.host);
  if (typeof info.pid !== 'number' || !Number.isInteger(info.pid) || info.pid < 1 || info.pid > MAX_PID) return false;
  // Our own pid with a different start time: the pid was reused (container restart), so the holder is gone.
  if (info.pid === process.pid) return Math.abs(info.startMs - PROCESS_START_MS) > START_TIME_TOLERANCE_MS;
  try {
    process.kill(info.pid, 0);
    return false;
  } catch (error) {
    return errorCode(error) === 'ESRCH'; // EPERM means it exists but belongs to someone else
  }
}

/** True when the process that wrote the lock no longer exists; a holder we cannot identify counts as present. */
function holderGone(info: LockInfo | null): boolean {
  return info !== null && processGone(info);
}

/** How long a lock may go without a refresh before it is stale: `staleMs`, at least 30 s (or the test hook's value). */
function staleWindowMs(staleMs: number): number {
  return Math.max(staleMs, testStaleMs() ?? MIN_STALE_MS);
}

function isStale(snapshot: Snapshot, staleMs: number): boolean {
  return holderGone(snapshot.info) || Date.now() - snapshot.mtimeMs > staleWindowMs(staleMs);
}

/** Creates the lock file exclusively. False when it already exists; any other failure is thrown. */
async function tryCreate(lockPath: string, token: string): Promise<boolean> {
  let handle: FileHandle;
  try {
    handle = await fsp.open(lockPath, 'wx', 0o600); // O_CREAT | O_EXCL | O_WRONLY
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return false;
    throw error;
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, startMs: PROCESS_START_MS, token, host: lockHostIdentity() }));
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fsp.rm(lockPath, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();
  return true;
}

/**
 * Removes the stale lock that `seen` describes so that the caller can try to create its own.
 *
 * Several waiters usually notice a stale lock at the same moment (a crashed worker, then every Passenger
 * process retries). If each simply re-checked and unlinked it, a slow one could delete the *new* lock that
 * a faster one had created in the gap. So the right to break is itself claimed with O_EXCL, under a name
 * derived from the stale lock's exact content and mtime: one waiter wins per stale lock, and the rest
 * leave it alone. The winner re-reads the lock before unlinking it, and only removes it if it is unchanged.
 *
 * @returns true when the stale lock is gone (or was replaced) and creating a new one is worth trying at
 * once; false when another waiter is breaking it. A refusal by the file system (EACCES, EPERM, ...) is thrown
 * and handled by `acquire`.
 */
async function breakStale(lockPath: string, seen: Snapshot, staleMs: number): Promise<boolean> {
  const identity = createHash('sha256').update(`${seen.raw}\0${seen.mtimeMs}`).digest('hex').slice(0, 16);
  const claim = `${lockPath}.break-${identity}`;
  if (!(await tryCreate(claim, randomBytes(16).toString('hex')))) {
    // Somebody else is breaking this very lock. If that waiter died halfway, its claim goes stale too.
    const other = await readSnapshot(claim);
    if (other !== null && isStale(other, staleMs)) await fsp.rm(claim, { force: true }).catch(() => undefined);
    return false;
  }
  try {
    const now = await readSnapshot(lockPath);
    if (now !== null && now.raw === seen.raw && now.mtimeMs === seen.mtimeMs) {
      await fsp.rm(lockPath, { force: true });
    }
    return true;
  } finally {
    await fsp.rm(claim, { force: true }).catch(() => undefined);
  }
}

function timeoutError(lockPath: string, holder: LockInfo | null, waitMs: number): DomainError {
  // A pid of another host identity means nothing here: name the host it belongs to.
  const where = holder === null || holder.host === lockHostIdentity() ? '' : ` on ${holder.host ?? 'an unknown host'}`;
  const by = holder === null ? '' : ` (PID ${holder.pid}${where})`;
  return new DomainError('STATE_CORRUPT', {
    detail:
      `Berkas kunci ${lockPath} masih dipegang proses lain${by} setelah ${waitMs} ms / ` +
      `Lock file ${lockPath} is still held by another process${by} after ${waitMs} ms`,
    meta: { reason: 'lock_timeout' },
  });
}

/** The file system kept refusing access to the lock file: a permission problem, not contention. */
function ioError(lockPath: string, code: string, cause: unknown): DomainError {
  return new DomainError('STATE_CORRUPT', {
    detail:
      `Berkas kunci ${lockPath} tidak dapat diakses (${code}); periksa izin berkas dan direktorinya / ` +
      `Cannot access lock file ${lockPath} (${code}); check the permissions of the file and its directory`,
    meta: { reason: 'lock_io', code },
    cause,
  });
}

/**
 * @returns the token of the lock this process now holds
 *
 * Errors from the file system while looking at or taking the lock:
 * - EPERM/EACCES: on Windows a file that was just unlinked lingers while a scanner has it open, and answers
 *   like this; elsewhere it is a real permission problem. Both are retried with the normal backoff. A run
 *   of them that lasts the whole wait (Windows) or `PERMISSION_PATIENCE_MS` (elsewhere) is reported as
 *   `lock_io`, with the errno code, rather than as a timeout.
 * - EBUSY on Windows: busy, retried like a held lock.
 * - anything else is thrown as it is.
 */
async function acquire(lockPath: string, staleMs: number, waitMs: number): Promise<string> {
  const token = randomBytes(16).toString('hex');
  const deadline = performance.now() + waitMs;
  let delay = POLL_FIRST_MS;
  let holder: LockInfo | null = null;
  let refused: { since: number; error: NodeJS.ErrnoException } | null = null; // the current run of EACCES/EPERM
  for (;;) {
    let next: 'now' | 'soon' | 'backoff' = 'backoff';
    try {
      if (await tryCreate(lockPath, token)) return token;
      const seen = await readSnapshot(lockPath);
      if (seen === null) {
        next = 'soon'; // released between our attempt and our look: try again straight away (but never spin)
      } else {
        holder = seen.info;
        if (isStale(seen, staleMs) && (await breakStale(lockPath, seen, staleMs))) next = 'now';
      }
      refused = null;
    } catch (error) {
      const code = errorCode(error);
      if (code === 'EACCES' || code === 'EPERM') {
        if (refused === null) refused = { since: performance.now(), error: error as NodeJS.ErrnoException };
        else refused.error = error as NodeJS.ErrnoException;
        if (process.platform !== 'win32' && performance.now() - refused.since > PERMISSION_PATIENCE_MS) {
          throw ioError(lockPath, code, error);
        }
      } else if (code === 'EBUSY' && process.platform === 'win32') {
        refused = null;
      } else {
        throw error;
      }
    }
    if (next === 'now') continue;

    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      if (refused !== null) throw ioError(lockPath, refused.error.code ?? 'EACCES', refused.error);
      throw timeoutError(lockPath, holder, waitMs);
    }
    if (next === 'soon') {
      await sleep(1);
    } else {
      await sleep(Math.max(1, Math.min(delay * (0.75 + Math.random() * 0.5), remaining)));
      delay = Math.min(delay * 2, POLL_MAX_MS);
    }
  }
}

/**
 * Whether the lock file still carries `token`, read synchronously: `'ours'`, `'lost'` (gone, or another holder's
 * record, a partial one included: our own record is written once, whole, before the heartbeat starts) or
 * `'unknown'` (the file system refused the read for a moment, e.g. EBUSY/EACCES from a Windows scanner).
 */
function ownership(lockPath: string, token: string): 'ours' | 'lost' | 'unknown' {
  let raw: string;
  try {
    raw = readFileSync(lockPath, 'utf8');
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? 'lost' : 'unknown';
  }
  const info = parseInfo(raw);
  return info !== null && info.token === token ? 'ours' : 'lost';
}

/**
 * Touches the lock file every `min(staleMs / 3, 10 s)` while it is ours, and calls `onLost` (then stops) once it is
 * not: removed, or replaced by a waiter that judged it stale (L11). Returns the function that stops it.
 *
 * Each refresh is one synchronous step inside the timer callback (read the small file, check the token, set the
 * mtime): it completes in the same event-loop turn the timer fires in. An asynchronous refresh needs a turn per
 * file operation, which a holder that yields only between long synchronous stretches (node:sqlite) cannot give
 * fast enough. A failed or skipped beat is harmless: the next one repairs it.
 *
 * Ruling R34: being synchronous, a beat blocks the event loop for as long as the file system takes to answer. On
 * a local disk that is microseconds; on a DATA_DIR on a hard-mounted NFS share that stalls, it blocks the whole
 * process (requests included) until the share answers again. DATA_DIR on a local disk is recommended.
 */
function startHeartbeat(lockPath: string, token: string, staleMs: number, onLost: () => void): () => void {
  const refresh = (): void => {
    const state = ownership(lockPath, token);
    if (state === 'lost') {
      stop(); // not ours any more: leave it alone from now on
      onLost();
      return;
    }
    if (state === 'unknown') return; // the file system refused for a moment: the next beat tries again
    try {
      const now = new Date();
      utimesSync(lockPath, now, now);
    } catch {
      // gone meanwhile, or refused for a moment: the next beat sees which
    }
  };
  const timer = setInterval(refresh, Math.max(Math.min(Math.floor(staleMs / 3), HEARTBEAT_MAX_MS), 10));
  timer.unref(); // never keep the process alive for a lock
  function stop(): void {
    clearInterval(timer);
  }
  return stop;
}

/**
 * What {@link withFileLock} hands its critical section (L11): a way to find out that the lock was taken over while
 * `fn` ran, which happens when this process stalled for longer than `staleMs` (a frozen event loop, a suspended VM, a
 * stalled disk) and a waiter judged the lock stale. Write state files only after {@link HeldFileLock.assertHeld}.
 */
export interface HeldFileLock {
  /** True once the heartbeat found the lock file gone or carrying another holder's token. Never false again. */
  lost(): boolean;
  /**
   * Throws DomainError `STATE_CORRUPT` `{reason: 'lock_lost'}` when the lock is lost. Besides the heartbeat's finding
   * it reads the lock file itself, so a takeover since the last beat is noticed too.
   */
  assertHeld(): void;
}

function lostError(lockPath: string): DomainError {
  return new DomainError('STATE_CORRUPT', {
    detail:
      `Berkas kunci ${lockPath} diambil alih proses lain selagi masih dipegang; pekerjaan di dalamnya dibatalkan / ` +
      `Lock file ${lockPath} was taken over by another process while it was held; the work inside it is abandoned`,
    meta: { reason: 'lock_lost' },
  });
}

/**
 * Deletes the lock file, but only when it still carries `token`: a lock taken over from us is not ours to delete.
 * `not-ours` when the file is gone or carries something else (another holder's record, or one being written), so the
 * caller learns from this read too that the lock was lost; EPERM/EBUSY/EACCES are retried for up to a second.
 */
async function release(lockPath: string, token: string): Promise<'released' | 'not-ours'> {
  const deadline = performance.now() + 1000; // Windows scanners can hold the file for a moment
  let delay = POLL_FIRST_MS;
  for (;;) {
    try {
      const seen = await readSnapshot(lockPath);
      if (seen === null || seen.info === null || seen.info.token !== token) return 'not-ours';
      await fsp.rm(lockPath, { force: true });
      return 'released';
    } catch (error) {
      const code = errorCode(error);
      if ((code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') || performance.now() >= deadline) throw error;
      await sleep(delay);
      delay *= 2;
    }
  }
}

/**
 * Runs `fn` while holding the lock file at `lockPath` (O_EXCL), so that only one process at a time, across
 * Passenger workers and the CLI, is inside the critical section. The directory must exist.
 *
 * A held lock is polled with backoff (25 ms up to 250 ms) until `waitMs`. A stale lock (holder dead, or
 * not refreshed for `staleMs`, see {@link FileLockOptions.staleMs}) is taken over. The lock is released
 * when `fn` settles; if `fn` fails its error wins over any failure to release.
 *
 * Lock loss (L11): `fn` receives a {@link HeldFileLock}. When the heartbeat finds that the lock was taken over while
 * `fn` ran, `lost()` turns true and `assertHeld()` throws; and when `fn` resolves anyway, the call rejects with
 * `lock_lost` instead of returning its value (the new holder's lock is left alone). When `fn` resolves, the release
 * reads the lock file once more (retrying a refused read), so a takeover after the last heartbeat (a stall that ends
 * just as `fn` resolves) rejects too.
 * Callers that ignore the argument keep working.
 *
 * @throws DomainError `STATE_CORRUPT` with `meta.reason === 'lock_timeout'` when the lock stays held for `waitMs`
 * @throws DomainError `STATE_CORRUPT` with `meta {reason: 'lock_io', code}` when the file system keeps refusing
 *   access to the lock file (EACCES/EPERM), which means a permission problem rather than a busy lock
 * @throws DomainError `STATE_CORRUPT` with `meta.reason === 'lock_lost'` when `fn` resolved after the lock was lost
 * @throws RangeError when `staleMs` is not positive or `waitMs` is negative or NaN
 */
export async function withFileLock<T>(
  lockPath: string,
  fn: (lock: HeldFileLock) => Promise<T>,
  opts: FileLockOptions = {},
): Promise<T> {
  const staleMs = testStaleMs() ?? opts.staleMs ?? DEFAULT_STALE_MS;
  const waitMs = opts.waitMs ?? DEFAULT_WAIT_MS;
  if (!(staleMs > 0) || !(waitMs >= 0)) {
    throw new RangeError('withFileLock: staleMs must be greater than 0 and waitMs must not be negative');
  }

  const token = await acquire(lockPath, staleMs, waitMs);
  let isLost = false;
  const stopHeartbeat = startHeartbeat(lockPath, token, staleMs, () => {
    isLost = true;
  });
  const held: HeldFileLock = {
    lost: () => isLost,
    assertHeld: () => {
      if (!isLost && ownership(lockPath, token) === 'lost') {
        isLost = true;
        stopHeartbeat();
      }
      if (isLost) throw lostError(lockPath);
    },
  };
  let result: T;
  try {
    result = await fn(held);
  } catch (error) {
    stopHeartbeat();
    await release(lockPath, token).catch(() => undefined);
    throw error;
  }
  stopHeartbeat();
  // The release reads the lock file once more and only removes it while it carries our token. A takeover during a
  // stall that ended just as fn resolved happened after the last beat (whose overdue run was just cancelled), and a
  // read the file system refused for a moment (EBUSY, EACCES) is retried there: either way its answer is the truth.
  if ((await release(lockPath, token)) === 'not-ours') isLost = true;
  if (isLost) throw lostError(lockPath);
  return result;
}

/**
 * A lock taken by {@link acquireFileLock}: held, and kept fresh by its heartbeat, until {@link release} is called or
 * the process ends.
 */
export interface HeldFileLockHandle extends HeldFileLock {
  /** The random token in the lock file: only this handle removes or refreshes a file that carries it. */
  token: string;
  /**
   * Stops the heartbeat and removes the lock file, but only while it still carries {@link token}. True when it did;
   * false when the file was gone or carried something else (taken over, or already released by this handle).
   *
   * @throws the I/O error when the file system keeps refusing the removal (EPERM/EBUSY/EACCES for more than 1 s)
   */
  release(): Promise<boolean>;
}

/** One attempt at the lock (see {@link acquireNow}); file system errors are thrown as they are. */
async function tryNow(lockPath: string, staleMs: number): Promise<string | null> {
  const token = randomBytes(16).toString('hex');
  // A few rounds at most: the file can vanish between our attempt and our look, and a broken stale lock is retried.
  for (let round = 0; round < 3; round += 1) {
    if (await tryCreate(lockPath, token)) return token;
    const seen = await readSnapshot(lockPath);
    if (seen === null) continue; // released between our attempt and our look
    if (!isStale(seen, staleMs)) return null;
    if (!(await breakStale(lockPath, seen, staleMs))) return null;
  }
  return null;
}

/**
 * Per lock path, when the current run of Windows refusals (EACCES/EPERM/EBUSY from {@link acquireFileLock}) began, by
 * `performance.now()`. Any other answer for that path ends the run. One entry per lock path that is being refused.
 */
const windowsRefusals = new Map<string, number>();

/**
 * One attempt at the lock, without waiting: the token when this process now holds it, null while another holder has
 * it (or another process is breaking the same stale lock). A stale lock is taken over as {@link withFileLock} does.
 * Elsewhere than Windows, EACCES/EPERM is a permission problem (`lock_io`). Windows answers EPERM/EACCES/EBUSY while a
 * scanner has the file open: null, the caller tries later; but once a run of such refusals (no other answer between
 * them, however far apart the attempts were: nothing tells what the lock did in between) has lasted longer than the
 * stale window, it is a lasting problem (an ACL change, a quarantined folder), reported as `lock_io` on every attempt
 * until the file system answers otherwise.
 */
async function acquireNow(lockPath: string, staleMs: number): Promise<string | null> {
  let answer: string | null;
  try {
    answer = await tryNow(lockPath, staleMs);
  } catch (error) {
    const code = errorCode(error);
    if (process.platform === 'win32' && (code === 'EACCES' || code === 'EPERM' || code === 'EBUSY')) {
      const now = performance.now();
      const since = windowsRefusals.get(lockPath);
      if (since === undefined) windowsRefusals.set(lockPath, now);
      else if (now - since > staleWindowMs(staleMs)) throw ioError(lockPath, code, error);
      return null;
    }
    windowsRefusals.delete(lockPath);
    if (code === 'EACCES' || code === 'EPERM') throw ioError(lockPath, code, error);
    throw error;
  }
  windowsRefusals.delete(lockPath);
  return answer;
}

/**
 * Takes the lock file at `lockPath` if it can be taken right now, for a critical section that is not one call: the
 * holder keeps it across requests (spec §9.3: `releases/boot.lock` for a whole boot and migration) and lets it go with
 * {@link HeldFileLockHandle.release}. The directory must exist.
 *
 * Returns null at once while a live holder has the lock; a stale one (holder gone, or not refreshed for `staleMs`,
 * with the same 30 s floor and test hook as {@link withFileLock}) is taken over. The record and the takeover are those
 * of withFileLock, so both kinds of caller may share a lock path.
 *
 * While held, a heartbeat refreshes the lock every `min(staleMs / 3, 10 s)`: a timer, which Passenger allows while a
 * lock is held. It is unref'd, so it never keeps the process alive. `lost()` turns true when the heartbeat finds the
 * lock taken over (L11), and `assertHeld()` reads the file itself.
 *
 * On Windows, EACCES/EPERM/EBUSY (a scanner holding the file for a moment) answer null like a held lock, until a run
 * of them with no other answer between has lasted longer than the stale window (`staleMs`, at least 30 s): from then
 * on it is `lock_io`, so a refusal that never goes away is reported instead of looking held forever.
 *
 * @throws DomainError `STATE_CORRUPT` `{reason: 'lock_io', code}` for EACCES/EPERM outside Windows, and for
 *   EACCES/EPERM/EBUSY on Windows that have lasted longer than the stale window; other I/O errors as they are
 * @throws RangeError when `staleMs` is not positive
 */
export async function acquireFileLock(lockPath: string, opts: { staleMs?: number } = {}): Promise<HeldFileLockHandle | null> {
  const testStale = testStaleMs();
  const staleMs = testStale !== undefined ? testStale : opts.staleMs !== undefined ? opts.staleMs : DEFAULT_STALE_MS;
  if (!(staleMs > 0)) throw new RangeError('acquireFileLock: staleMs must be greater than 0');

  const token = await acquireNow(lockPath, staleMs);
  if (token === null) return null;
  let isLost = false;
  const stopHeartbeat = startHeartbeat(lockPath, token, staleMs, () => {
    isLost = true;
  });
  return {
    token,
    lost: () => isLost,
    assertHeld: () => {
      if (!isLost && ownership(lockPath, token) === 'lost') {
        isLost = true;
        stopHeartbeat();
      }
      if (isLost) throw lostError(lockPath);
    },
    release: async () => {
      stopHeartbeat();
      return (await release(lockPath, token)) === 'released';
    },
  };
}
