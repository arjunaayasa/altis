import { withTx, type DB, type DbHandle } from '@altis/db';
import { atomicWriteJson, dataPath, ensureDir, readJsonWithBak, withFileLock } from '@altis/platform';
import { isDomainError } from '@altis/shared';
import type { Kysely, Transaction } from 'kysely';
import { z } from 'zod';
import { readMaintenance } from '../ops/files.js';
import { readSettings, writeSettings, type SettingsCache } from '../settings/service.js';
import type { SettingKey } from '../settings/registry.js';
import type { RunMode } from './types.js';

// Run records and the scheduler's traces (spec §10.2, §10.3; decisions C39, C42; preflight S2, S18, M20).
//
// - A run record is the epoch ms of the last successful run of a mode, the instance setting `system.run.<mode>`: one
//   key per mode, so a writer never overwrites another mode's time (M20). Diagnostik shows the newest; piggyback runs
//   only while no worker or cron run is recorded within the last 10 minutes (runnerFresh); the dashboard warns of a
//   missing runner (Task 26). Each process writes a mode at most once a minute, and never while a restore holds the
//   maintenance flag: the restore may have dropped the settings table (S2).
// - The `/_cron` single-flight (C39) is a file lease, `tmp/cron-flight.json` `{until}` written under `tmp/cron.lock`,
//   not a `locks` row: it works before the install and while a restore has dropped the tables. A call that finds the
//   lock held, or an `until` still ahead, is refused (202); an `until` more than 60 s ahead was written by a clock that
//   has since moved back, and counts as expired (S18).
// - `tmp/cron-seen.json` `{mode, at}` records a scheduler call before the install completes (`jobs:run` and
//   `POST /_cron` answer "not installed" then), so the wizard's scheduler test (Task 27) can see either path.

/** A mode's run record is written at most this often per process. */
export const RUN_RECORD_MIN_GAP_MS = 60_000;

/** A worker or cron run older than this no longer counts as a runner (spec §10.2 piggyback: 10 minutes). */
export const RUNNER_STALE_MS = 600_000;

/** The `/_cron` lease (spec §10.3: "lease 30 detik"). */
export const CRON_FLIGHT_MS = 30_000;

/** An `until` further ahead than this was written by a clock that has since moved back (S18). */
const CRON_FLIGHT_FAR_MS = 60_000;

/** Every run mode, in the order of the settings registry. */
export const RUN_MODES: readonly RunMode[] = Object.freeze(['worker', 'cron_cli', 'cron_http', 'drive', 'piggyback'] as const);

/** The modes that count as a runner for piggyback and the dashboard: the worker and both cron paths. */
const RUNNER_MODES: readonly RunMode[] = ['worker', 'cron_cli', 'cron_http'];

const runKey = (mode: RunMode): SettingKey => `system.run.${mode}`;

/** What this process last wrote, per DATA_DIR and mode (a per-process cache, P6: safe to lose). */
const lastWritten = new Map<string, number>();

function checkEpoch(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a safe non-negative integer (epoch ms)`);
}

function checkMode(mode: RunMode): void {
  if (!RUN_MODES.includes(mode)) throw new TypeError(`unknown run mode ${JSON.stringify(mode)}`);
}

/**
 * Records a successful run of `mode` at `now`: the instance setting `system.run.<mode>`, in a transaction of its own
 * on `h` (call it outside any withTx callback). Skipped when this process wrote the same mode for the same DATA_DIR
 * less than {@link RUN_RECORD_MIN_GAP_MS} ago (a clock that moved back counts as expired), and while the maintenance
 * flag's reason is `restore` (S2).
 *
 * @throws TypeError for an unknown mode or a malformed `now`; what reading the maintenance flag and writing the
 *   setting throw (nothing is recorded as written then)
 */
export async function recordRun(h: DbHandle, mode: RunMode, now: number, o: { dataDir: string }): Promise<void> {
  checkMode(mode);
  checkEpoch('recordRun: now', now);
  const slot = `${o.dataDir}\u0000${mode}`;
  const last = lastWritten.get(slot);
  if (last !== undefined && now >= last && now - last < RUN_RECORD_MIN_GAP_MS) return;
  const flag = await readMaintenance(o.dataDir);
  if (flag?.reason === 'restore') return;
  await withTx(h, (trx) => writeSettings(trx, { [runKey(mode)]: now }, { keyring: [], now, actorId: null }));
  lastWritten.set(slot, now);
}

/**
 * The run records, by mode (a mode never recorded is absent): read through `o.cache` when given (each key served
 * from memory for up to its time to live, P6), else from `db`.
 */
export async function lastRuns(
  db: Kysely<DB> | Transaction<DB>,
  o: { cache?: SettingsCache } = {},
): Promise<Partial<Record<RunMode, number>>> {
  const out: Partial<Record<RunMode, number>> = {};
  let values: Partial<Record<SettingKey, unknown>>;
  if (o.cache === undefined) {
    values = await readSettings(db, RUN_MODES.map(runKey), []);
  } else {
    values = {};
    for (const mode of RUN_MODES) values[runKey(mode)] = await o.cache.get<number | null>(db, runKey(mode));
  }
  for (const mode of RUN_MODES) {
    const at = values[runKey(mode)];
    if (typeof at === 'number' && Number.isSafeInteger(at)) out[mode] = at;
  }
  return out;
}

/**
 * Whether a runner is alive: a worker, `jobs:run` or `POST /_cron` run recorded within {@link RUNNER_STALE_MS} of
 * `now`, either way (a record ahead of a clock that moved back counts only that close). Drive and piggyback runs
 * never count: they happen only because of traffic.
 */
export function runnerFresh(runs: Partial<Record<RunMode, number>>, now: number): boolean {
  return RUNNER_MODES.some((mode) => {
    const at = runs[mode];
    return at !== undefined && Math.abs(now - at) <= RUNNER_STALE_MS;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// The /_cron single-flight and cron-seen.json

const flightSchema = z.object({ until: z.number().int() });
const seenSchema = z.object({ mode: z.enum(['cron_cli', 'cron_http']), at: z.number().int().min(0) });

async function tmpDir(dataDir: string): Promise<void> {
  await ensureDir(dataPath(dataDir, 'tmp'));
}

/** The flight's `until`, or null when there is none or it cannot be read (both count as expired). */
async function readFlight(dataDir: string): Promise<number | null> {
  try {
    return (await readJsonWithBak(dataPath(dataDir, 'tmp', 'cron-flight.json'), (raw) => flightSchema.parse(raw)))?.until ?? null;
  } catch (error) {
    if (isDomainError(error) && error.code === 'STATE_CORRUPT') return null;
    throw error;
  }
}

/**
 * The `/_cron` single-flight (spec §10.3, decision C39): under `tmp/cron.lock` (no wait), reads
 * `tmp/cron-flight.json`; an `until` after `now` (and at most 60 s after it, S18) means a call less than 30 s ago or
 * one still running → false (the route answers 202 without work); otherwise `until = now + 30 s` is written → true.
 * A lock held by another call is false too.
 *
 * @throws what the file system throws besides a busy lock (DATA_DIR not writable, ...)
 */
export async function cronFlight(dataDir: string, now: number): Promise<boolean> {
  checkEpoch('cronFlight: now', now);
  await tmpDir(dataDir);
  try {
    return await withFileLock(
      dataPath(dataDir, 'tmp', 'cron.lock'),
      async (lock) => {
        const until = await readFlight(dataDir);
        if (until !== null && until > now && until <= now + CRON_FLIGHT_FAR_MS) return false;
        lock.assertHeld();
        await atomicWriteJson(dataPath(dataDir, 'tmp', 'cron-flight.json'), { until: now + CRON_FLIGHT_MS });
        return true;
      },
      { waitMs: 0 },
    );
  } catch (error) {
    if (isDomainError(error) && error.code === 'STATE_CORRUPT' && error.meta?.['reason'] === 'lock_timeout') return false;
    throw error;
  }
}

/** Records a scheduler call made before the install completed: `tmp/cron-seen.json` `{mode, at}`. */
export async function writeCronSeen(dataDir: string, mode: 'cron_cli' | 'cron_http', now: number): Promise<void> {
  if (mode !== 'cron_cli' && mode !== 'cron_http') throw new TypeError('writeCronSeen: mode must be cron_cli or cron_http');
  checkEpoch('writeCronSeen: now', now);
  await tmpDir(dataDir);
  await atomicWriteJson(dataPath(dataDir, 'tmp', 'cron-seen.json'), { mode, at: now });
}

/** The last scheduler call recorded by {@link writeCronSeen}, or null (none, or unreadable). */
export async function readCronSeen(dataDir: string): Promise<{ mode: 'cron_cli' | 'cron_http'; at: number } | null> {
  try {
    return await readJsonWithBak(dataPath(dataDir, 'tmp', 'cron-seen.json'), (raw) => seenSchema.parse(raw));
  } catch (error) {
    if (isDomainError(error) && error.code === 'STATE_CORRUPT') return null;
    throw error;
  }
}
