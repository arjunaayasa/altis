import {
  bootMarkerPath,
  dataPath,
  listNames,
  lockHostIdentity,
  processGone,
  processStartMs,
  readBytes,
  removeTree,
  writeBytesAtomic,
  writeBytesInFolder,
} from '@altis/platform';
import { isDomainError } from '@altis/shared';

// Boot markers of a pending release (spec §9.3, decision D1d-19, preflight M8, S15): `releases/boot/<v>/<pid>-<startMs>`,
// one per process that tried to boot release `<v>` while it was pending. The holder of `releases/boot.lock` writes its
// own when it begins, rewrites it when its phase changes or it makes progress, and refreshes it every 10 s; the next
// holder reads them all to count the attempts that ended (classifyAttempts), and decides whether to revert.
//
// app.js bundles this module (ES2017, P1), and so do the tests.

/** `releases/boot.lock` is stale when its holder is gone or it was not refreshed for this long (§9.3). */
export const BOOT_LOCK_STALE_MS = 60_000;
/** The holder refreshes the lock, its marker and op.json's `heartbeatAt` this often (§9.3 "setiap 10 detik"). */
export const BOOT_REFRESH_MS = 10_000;
/** A process that waits for boot.lock tries again at most this often, when a request arrives (§9.3 "setiap 5 detik"). */
export const BOOT_RETRY_MS = 5_000;
/** A holder that died in `migrating` with progress less than this before its last refresh was `interrupted` (§9.3). */
export const INTERRUPTED_WINDOW_MS = 60_000;
/** This many failed boots revert the pending release (§9.3 "≥ 3 boot gagal"). */
export const REVERT_FAILED_BOOTS = 3;
/** A migration without progress for this long is a failure (§9.3 "migrasi tanpa progres selama 15 menit"). */
export const REVERT_STALL_MS = 900_000;

/** Where a boot is (spec §9.2's `bootMarker.phase`). */
export type BootPhase = 'importing' | 'listening' | 'migrating';

/** What a holder waits for that is no fault of the release (§9.3 "Bukan alasan revert"): never counted as a failure. */
export type BootWaitReason = 'db_unavailable' | 'migration_lock';

/** How an attempt failed explicitly: the detail a revert reports (op.json `error.detail`). */
export type BootErrorDetail = 'verify' | 'import' | 'start' | 'stalled';

/** The content of a boot marker. Times are epoch ms of the writer's clock. */
export interface BootMarker {
  phase: BootPhase;
  /** When the boot last made progress: a phase change, `bootMarker.progress()`. */
  lastProgressAt: number;
  /** When the holder last wrote the marker (every 10 s while it holds boot.lock). */
  refreshedAt: number;
  /** The writer's lock host identity (lockHostIdentity, rulings R25(b), R33): its pid means something only there. */
  host: string;
  /** Set while the holder waits for its environment (§9.3): such an attempt is not counted. */
  waiting: BootWaitReason | null;
  /**
   * An explicit failure the holder recorded: `detail` is what a revert reports, `reason` the bootloader's rescue
   * reason (`RELEASE_INVALID`, `START_FAILED`), kept for the log (preflight M8).
   */
  error: { detail: BootErrorDetail; reason: string } | null;
}

/** A marker as read back: the process that wrote it, and its content. */
export interface MarkerRecord {
  pid: number;
  startMs: number;
  marker: BootMarker;
}

/** What classifyAttempts makes of the markers of ended attempts. */
export interface AttemptCount {
  /** Attempts that failed: they died before they were healthy, without an explicit error. */
  failed: number;
  /** Attempts that died in `migrating` shortly after progress (Passenger's idle kill, a restart): not failures. */
  interrupted: number;
  /** The detail of an explicit error one of them recorded (the most recent one), or null. */
  explicit: string | null;
}

/** A marker is a small JSON object; anything larger is not one of ours. */
const MARKER_MAX_BYTES = 4096;
/** The name of a marker: `<pid>-<startMs>`. */
const MARKER_NAME = /^(\d{1,10})-(\d{1,16})$/;

const PHASES: readonly string[] = ['importing', 'listening', 'migrating'];
const WAIT_REASONS: readonly string[] = ['db_unavailable', 'migration_lock'];
const ERROR_DETAILS: readonly string[] = ['verify', 'import', 'start', 'stalled'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** The marker in `raw`; throws for anything that is not one. Unknown fields are ignored. */
export function parseMarker(raw: unknown): BootMarker {
  if (!isRecord(raw)) throw new TypeError('boot marker: not an object');
  const { phase, lastProgressAt, refreshedAt, host, waiting, error } = raw;
  if (typeof phase !== 'string' || PHASES.indexOf(phase) === -1) throw new TypeError('boot marker: phase');
  if (!isTime(lastProgressAt) || !isTime(refreshedAt)) throw new TypeError('boot marker: times');
  if (typeof host !== 'string') throw new TypeError('boot marker: host');
  if (waiting !== null && (typeof waiting !== 'string' || WAIT_REASONS.indexOf(waiting) === -1)) throw new TypeError('boot marker: waiting');
  let failure: BootMarker['error'] = null;
  if (error !== null) {
    if (!isRecord(error) || typeof error['detail'] !== 'string' || ERROR_DETAILS.indexOf(error['detail']) === -1) {
      throw new TypeError('boot marker: error');
    }
    const reason = error['reason'];
    failure = { detail: error['detail'] as BootErrorDetail, reason: typeof reason === 'string' ? reason.slice(0, 64) : '' };
  }
  return {
    phase: phase as BootPhase,
    lastProgressAt,
    refreshedAt,
    host,
    waiting: waiting as BootWaitReason | null,
    error: failure,
  };
}

/**
 * The marker that stands for one that cannot be read (not JSON, not a marker): an attempt did happen, and nothing says
 * it was interrupted or waited, so it counts as failed once it is old enough to be judged (its time stamps are 0, and
 * its host is unknown, so only the age rule applies, which it meets at once).
 */
function unreadableMarker(): BootMarker {
  return { phase: 'importing', lastProgressAt: 0, refreshedAt: 0, host: '', waiting: null, error: null };
}

/** `releases/boot/<v>`: the markers of release `<v>`. */
function markerFolder(dataDir: string, version: string) {
  return dataPath(dataDir, 'releases', 'boot', version);
}

/**
 * Writes the marker of process `pid` (started at `startMs`) booting `version`: atomically (temporary sibling, fsync,
 * rename, fsync of the folder), so a reader sees the old marker or the new one, never a part. The first write creates
 * the folders; with `o.inFolder` (a refresh) nothing is written when the folder is gone, so a marker that a revert or a
 * promotion removed is never brought back.
 *
 * @throws DomainError `INVALID_PATH_SEGMENT` (see bootMarkerPath), `DISK_QUOTA`; other I/O errors as they are
 */
export async function writeMarker(
  dataDir: string,
  version: string,
  pid: number,
  startMs: number,
  m: BootMarker,
  o?: { inFolder?: boolean },
): Promise<void> {
  const file = bootMarkerPath(dataDir, version, pid, startMs);
  const text = JSON.stringify(m) + '\n';
  if (o !== undefined && o.inFolder === true) await writeBytesInFolder(file, text);
  else await writeBytesAtomic(file, text);
}

/**
 * Every marker of `version`, by name (`<pid>-<startMs>`); other names (the writers' temporary files) are skipped, and so
 * is anything that is not a regular file. A marker that cannot be read as one counts as a failed attempt (see
 * {@link unreadableMarker}). No folder: none.
 *
 * @throws the I/O error of the folder or of a file other than a missing one (EACCES, ...)
 */
export async function readMarkers(dataDir: string, version: string): Promise<MarkerRecord[]> {
  const names = await listNames(markerFolder(dataDir, version));
  const records: MarkerRecord[] = [];
  for (const name of names) {
    const match = MARKER_NAME.exec(name);
    if (match === null) continue;
    const pid = Number(match[1]);
    const startMs = Number(match[2]);
    if (!Number.isSafeInteger(pid) || pid < 1 || !Number.isSafeInteger(startMs)) continue;
    let bytes: Buffer | null;
    try {
      bytes = await readBytes(bootMarkerPath(dataDir, version, pid, startMs), MARKER_MAX_BYTES);
    } catch (error) {
      // A folder or a FIFO of that name is not a marker; a file too large to be one is an unreadable marker.
      if (isDomainError(error) && error.code === 'STATE_CORRUPT' && error.meta !== undefined && error.meta['reason'] === 'too_large') {
        records.push({ pid, startMs, marker: unreadableMarker() });
        continue;
      }
      if (isDomainError(error)) continue;
      throw error;
    }
    if (bytes === null) continue; // removed meanwhile
    let marker: BootMarker;
    try {
      marker = parseMarker(JSON.parse(bytes.toString('utf8')));
    } catch {
      marker = unreadableMarker();
    }
    records.push({ pid, startMs, marker });
  }
  return records;
}

/** Removes every marker of `version` (`releases/boot/<v>/`), at promotion and at revert; none: nothing happens. */
export async function removeMarkers(dataDir: string, version: string): Promise<void> {
  await removeTree(markerFolder(dataDir, version));
}

/**
 * The holder that wrote `m` is gone (preflight S15): its process is known to be gone (processGone: this host, pid gone or
 * reused; or a record from before this host's last boot), or it has not refreshed its marker for
 * {@link BOOT_LOCK_STALE_MS}, which is how a holder of another host or PID namespace (a recreated Docker container) is
 * judged at all.
 */
export function holderGone(m: MarkerRecord, now: number): boolean {
  return processGone({ pid: m.pid, startMs: m.startMs, host: m.marker.host }) || now - m.marker.refreshedAt > BOOT_LOCK_STALE_MS;
}

/**
 * The attempt `m` describes has ended, as the holder of boot.lock judges it before it boots: its holder is gone
 * ({@link holderGone}); or it recorded an explicit error, which a holder writes only once its attempt is over (it then
 * reverts, or exits, or gives boot.lock back to retry the revert, S3); or it is this very process's own, which holds
 * boot.lock now and so is not booting.
 */
export function attemptEnded(m: MarkerRecord, now: number): boolean {
  if (m.marker.error !== null) return true;
  if (m.pid === process.pid && m.startMs === processStartMs() && m.marker.host === lockHostIdentity()) return true;
  return holderGone(m, now);
}

/**
 * Counts the attempts of the markers whose attempt ended (`gone`; the boot uses {@link attemptEnded}), per spec §9.3:
 * - an explicit error → `explicit` (its detail; the most recently refreshed one when there are several);
 * - waiting for the environment (`waiting` set) → not counted;
 * - in `migrating` with progress less than {@link INTERRUPTED_WINDOW_MS} before its last refresh → `interrupted`;
 * - otherwise → `failed`.
 * The markers of attempts that have not ended are not counted at all.
 */
export function classifyAttempts(
  markers: readonly MarkerRecord[],
  now: number,
  gone: (m: MarkerRecord, now: number) => boolean,
): AttemptCount {
  let failed = 0;
  let interrupted = 0;
  let explicit: string | null = null;
  let explicitAt = -1;
  for (const record of markers) {
    if (!gone(record, now)) continue;
    const m = record.marker;
    if (m.error !== null) {
      if (explicit === null || m.refreshedAt > explicitAt) {
        explicit = m.error.detail;
        explicitAt = m.refreshedAt;
      }
      continue;
    }
    if (m.waiting !== null) continue;
    if (m.phase === 'migrating' && m.refreshedAt - m.lastProgressAt < INTERRUPTED_WINDOW_MS) {
      interrupted += 1;
      continue;
    }
    failed += 1;
  }
  return { failed, interrupted, explicit };
}
