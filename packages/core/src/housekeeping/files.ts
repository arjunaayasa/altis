import { claimLock, releaseLock, type DbHandle } from '@altis/db';
import { dataPath, listNames, readBytes, removeFile, removeStaleTemps, removeTree, statOrNull, type DataPath } from '@altis/platform';
import { isDomainError, isTerminal, isUlid, newId, ulidTime } from '@altis/shared';
import { z } from 'zod';
import { referencedBlobs } from '../backup/blob-refs.js';
import { blobPath } from '../backup/blobs.js';
import { BACKUP_CREATE_JOB, abandonBackup } from '../backup/create-job.js';
import { DOWNLOAD_DONE_KEEP_MS, DOWNLOAD_READY_KEEP_MS } from '../backup/prepare-download.js';
import { BACKUP_SNAPSHOT_LOCK, BACKUP_SNAPSHOT_LOCK_MS } from '../backup/mode.js';
import { orphanBackups } from '../backup/orphans.js';
import { protectedRunWorkIds } from '../catalog/data/runs.js';
import type { CoreLogger } from '../context.js';
import { archivedOpPath, parseOpFile, readOpFile, type OpFile } from '../ops/files.js';

// The files cleanup of DATA_DIR (`housekeeping.files`, schedule `files.cleanup`, hourly; spec §7.5, §9.9; decisions
// C15, C18; M24; preflight B5). It works in phases, item by item, and stops after any item once the slice's budget is
// spent, with a checkpoint `{phase, after}` the next slice continues from (B5):
//
// 1. `downloads`: a prepared download `backups/<id>/downloads/<preparer>/` goes 5 minutes after `completedAt` (the last
//    byte was served; a download manager may still fetch ranges) or 1 hour after `readyAt`, unless a download completed
//    within the last 5 minutes (C15). A folder without a usable `prepared.json` (its preparation died) goes once
//    nothing in it changed for 24 hours.
// 2. `tmp`: a folder `tmp/<ulid>/` older than 24 hours (by its name's time and its own mtime, whichever is later)
//    that belongs to no upload session and to no op still running. Nothing goes while `ops/op.json` is unreadable
//    (the op it names may be running). Phase 2 (S2): nor the work folder of a catalog run that is queued or running
//    or finished less than 7 days ago (protectedRunWorkIds): appending to its staging files does not touch the
//    folder's mtime, and a real run adopts its dry run's input (S3).
// 3. `work`: the `.work` folder of each backup whose status is `failed`.
// 4. `ops`: 7 days after an op finished, its kept rows `ops/<opId>/keep/` and its database files `db/<opId>/`
//    (`pre-restore.sqlite`, C18); an archived op (`ops/<opId>/op.json`, moved there by the next `begin`) goes as a
//    whole 90 days after it finished (M24). An op whose record cannot be read is left alone.
// 5. `temps`: the hidden temporary siblings a process killed in the middle of a write left, once older than 24 hours:
//    in `backups/`, `backups/blobs/`, each backup's folder with its `tables/<t>/` (a part a killed export was writing),
//    and the upload store's month folders `uploads/<yyyy>/<mm>/`.
// 6. `orphans`: each `running` backup nothing works on any more (its job ended without its handler running, or its
//    op ended; backup/orphans.ts) is ended as failed (abandonBackup: the row `failed`, its folder removed, the SQLite
//    copy `.work/snapshot.sqlite` with it), so that it neither leaks nor holds the blobs back forever.
// 7. `leftovers`: a backup folder `backups/<ulid>/` whose row is `deleted` or `failed`, or that no row lists, once 24
//    hours old (by its name's time and its own mtime, whichever is later): what is left when the retention or
//    abandonBackup was killed between the row and the folder (P7), or the folder's removal failed (a file held open on
//    Windows). Each is a whole backup, so on a quota it matters (P21). Never `backups/blobs/` (not a ULID).
// 8. `blobs`: the upload blobs (`backups/blobs/<sha256>`) no `ok` backup's manifest names, one blob per item.
//
// Phases 6 to 8 run under the named lock `backup:snapshot`, claimed once for this call (owner `o.owner`) and
// released at its end: while it is held no snapshot backup can start or make its row (every slice of one takes that
// lock first) and no freezing op can begin (`ops.begin` answers OPS_BLOCKED_BY_BACKUP; one begun just before the
// claim waits for the freeze, which waits for this job's lease). Under the lock they read again what the backups
// depend on, and do nothing when an op is active (or `ops/op.json` is unreadable) or another holds the lock; phase 8
// removes nothing either while a backup is `running` (its blobs may not be in a manifest yet) or an `ok` backup's
// manifest cannot be read (a blob it names must never go). Both yield to a snapshot backup that waits for a slice (a
// `backup.create` job queued or running): they take no lock then, so a long collection (one slice after another)
// never keeps a backup from its lock until its attempts run out; they run again an hour later.
//
// The caller skips the whole job while `clock_anomaly` is active: every age here is measured against `now`.

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** A `tmp/<ulid>/` folder, a dead preparation, a temporary sibling: left alone until this old. */
export const STALE_FILES_MS = DAY;
/** An op's kept rows and database files stay this long after it finished. */
export const OP_FILES_KEEP_MS = 7 * DAY;
/** An archived op record stays this long after it finished. */
export const OP_RECORD_KEEP_MS = 90 * DAY;

/** The phases, in the order they run. */
export const FILES_PHASES = Object.freeze(['downloads', 'tmp', 'work', 'ops', 'temps', 'orphans', 'leftovers', 'blobs'] as const);
export type FilesPhase = (typeof FILES_PHASES)[number];

/** Where the next slice continues: the phase, and the last item done in it (null: from its first). */
export const filesCheckpointSchema = z.strictObject({
  phase: z.enum(FILES_PHASES),
  after: z.string().min(1).max(64).nullable(),
});
export type FilesCheckpoint = z.infer<typeof filesCheckpointSchema>;

/** The fixed folders the `temps` phase sweeps besides each backup's own (see phase 5). */
const TEMP_FOLDERS = Object.freeze(['backups', 'blobs', 'uploads'] as const);

/** A blob's name: its SHA-256 (anything else in `backups/blobs`, a copy's temporary sibling, is not a blob). */
const SHA256_HEX = /^[0-9a-f]{64}$/;
/** `prepared.json` and op records are small JSON files. */
const SMALL_JSON_MAX = 64 * 1024;

const epochMs = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
/** What the cleanup reads of `prepared.json` (Task 21 writes `{jobId, readyAt, size, encrypted, completedAt}`). */
const preparedSchema = z.looseObject({ readyAt: epochMs.nullable().optional(), completedAt: epochMs.nullable().optional() });

/** The JSON of the small file `p`, or undefined when it is missing, not a regular file, too large or not JSON. */
async function readJson(p: DataPath): Promise<unknown> {
  let bytes: Buffer | null;
  try {
    bytes = await readBytes(p, SMALL_JSON_MAX);
  } catch (error) {
    if (isDomainError(error) && error.code === 'STATE_CORRUPT') return undefined;
    throw error;
  }
  if (bytes === null) return undefined;
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

/** The mtime of `p`, or 0 when it is missing. */
async function mtimeOf(p: DataPath): Promise<number> {
  return (await statOrNull(p))?.mtimeMs ?? 0;
}

/** Whether the prepared download in `dir` is past its keep time at `now` (see phase 1). */
async function downloadExpired(dir: (...segments: string[]) => DataPath, now: number): Promise<boolean> {
  const parsed = preparedSchema.safeParse(await readJson(dir('prepared.json')));
  if (parsed.success) {
    const completedAt = parsed.data.completedAt ?? null;
    const readyAt = parsed.data.readyAt ?? null;
    const doneLongAgo = completedAt !== null && now - completedAt > DOWNLOAD_DONE_KEEP_MS;
    if (doneLongAgo) return true;
    if (readyAt !== null) return now - readyAt > DOWNLOAD_READY_KEEP_MS && completedAt === null;
  }
  // No usable record: a preparation that died once nothing in the folder changed for 24 h.
  const newest = Math.max(await mtimeOf(dir()), await mtimeOf(dir('archive.altisbak')), await mtimeOf(dir('archive.central')), await mtimeOf(dir('prepared.json')));
  return now - newest > STALE_FILES_MS;
}

/** The ULID-named folders of `dir`, sorted. */
async function ulidDirs(dir: DataPath): Promise<string[]> {
  return (await listNames(dir)).filter(isUlid);
}

/** The archived record `ops/<opId>/op.json`, or null when it is missing or unreadable. */
async function archivedOp(dataDir: string, opId: string): Promise<OpFile | null> {
  const raw = await readJson(archivedOpPath(dataDir, opId));
  if (raw === undefined) return null;
  try {
    return parseOpFile(raw);
  } catch {
    return null;
  }
}

/** What one cleanFiles call works with. */
export interface CleanFilesOptions {
  dataDir: string;
  /** Epoch ms the ages are measured against. */
  now: number;
  /** The checkpoint of the previous slice, or null to start at the first phase. */
  from: FilesCheckpoint | null;
  /** True while the slice may take another item (checked after each one; the first always runs). */
  budgetLeft(): boolean;
  /**
   * Who holds `backup:snapshot` while the blobs are collected (the job: `job:<id>`); unique per run, so that two runs
   * never share the lock. A fresh one when absent.
   */
  owner?: string;
  /** Where the failures that are only logged go (an orphan's folder that cannot be removed). */
  log?: CoreLogger;
}

const SILENT: CoreLogger = { info() {}, warn() {}, error() {} };

/** One phase: its items (sorted keys) and what to do with one; the number of things it removed. */
interface Phase {
  items(): Promise<string[]>;
  run(item: string): Promise<number>;
}

/**
 * Runs the files cleanup of `o.dataDir` (see the top of this file) from `o.from` until it ends or the budget is spent.
 * File errors other than a missing file are thrown (the job's error path retries the run from its checkpoint).
 *
 * @returns how many things it removed, and the checkpoint to continue from (null: the cleanup is complete)
 */
export async function cleanFiles(h: DbHandle, o: CleanFilesOptions): Promise<{ removed: number; next: FilesCheckpoint | null }> {
  const { dataDir, now } = o;
  const owner = o.owner ?? `files:${newId()}`;
  const op = await readOpFile(dataDir);
  /** The op holding the ops lock: running (needs attention included), or unreadable. */
  const active: OpFile | 'corrupt' | null = op === null || op === 'corrupt' ? op : isTerminal(op.kind, op.state) ? null : op;

  /** Whether this call holds `backup:snapshot` (released at its end). */
  let holding = false;
  let guarded: Promise<boolean> | undefined;
  /**
   * The lock `backup:snapshot` for this call (claimed once, by the first phase that needs it), and whether the
   * backups are at rest under it: no backup job waiting, no op active (`ops/op.json` read again after the claim; see
   * phases 6 and 7).
   */
  const atRest = (): Promise<boolean> =>
    (guarded ??= (async () => {
      const waiting = await h.db
        .selectFrom('jobs')
        .select('id')
        .where('type', '=', BACKUP_CREATE_JOB)
        .where('status', 'in', ['queued', 'running'])
        .executeTakeFirst();
      if (waiting !== undefined) return false;
      if (!(await claimLock(h, BACKUP_SNAPSHOT_LOCK, owner, BACKUP_SNAPSHOT_LOCK_MS))) return false;
      holding = true;
      const current = await readOpFile(dataDir);
      return current !== 'corrupt' && (current === null || isTerminal(current.kind, current.state));
    })());

  /**
   * The blobs no `ok` backup names, sorted; [] while that cannot be known safely (see phase 8): the one rule of
   * blob-refs.ts (1d, T20-BLOB-RULE-THREE-COPIES).
   */
  const unusedBlobs = async (): Promise<string[]> => {
    if (!(await atRest())) return [];
    if ((await h.db.selectFrom('backups').select('id').where('status', '=', 'running').executeTakeFirst()) !== undefined) return [];
    const kept = await h.db.selectFrom('backups').select('id').where('status', '=', 'ok').orderBy('id').execute();
    const { blobs: referenced, unreadable } = await referencedBlobs(dataDir, kept);
    if (unreadable.length > 0) {
      (o.log ?? SILENT).warn('housekeeping: a kept backup has no readable manifest; its upload blobs cannot be told apart, none is removed', {
        backupIds: unreadable,
      });
      return [];
    }
    return (await listNames(dataPath(dataDir, 'backups', 'blobs'))).filter((name) => SHA256_HEX.test(name) && !referenced.has(name));
  };

  const phases: Record<FilesPhase, Phase> = {
    downloads: {
      items: () => ulidDirs(dataPath(dataDir, 'backups')),
      async run(backupId) {
        let removed = 0;
        for (const preparer of await ulidDirs(dataPath(dataDir, 'backups', backupId, 'downloads'))) {
          const dir = (...segments: string[]) => dataPath(dataDir, 'backups', backupId, 'downloads', preparer, ...segments);
          if (!(await downloadExpired(dir, now))) continue;
          await removeTree(dir());
          removed += 1;
        }
        return removed;
      },
    },
    tmp: {
      items: async () => (active === 'corrupt' ? [] : ulidDirs(dataPath(dataDir, 'tmp'))),
      async run(name) {
        if (active !== null && (active === 'corrupt' || active.opId === name)) return 0;
        const p = dataPath(dataDir, 'tmp', name);
        const info = await statOrNull(p);
        if (info === null || info.kind !== 'dir') return 0;
        if (!(now - Math.max(ulidTime(name), info.mtimeMs) > STALE_FILES_MS)) return 0;
        const session = await h.db.selectFrom('upload_sessions').select('id').where('id', '=', name).executeTakeFirst();
        if (session !== undefined) return 0;
        // ---- Phase 2 (catalog): Task 1 (S2) ----
        // A catalog run's work folder: kept while its run is queued or running and for 7 days after it finished.
        if ((await protectedRunWorkIds(h.db, [name], now)).has(name)) return 0;
        await removeTree(p);
        return 1;
      },
    },
    work: {
      items: async () =>
        (await h.db.selectFrom('backups').select('id').where('status', '=', 'failed').orderBy('id').execute()).map((r) => r.id).filter(isUlid),
      async run(backupId) {
        const p = dataPath(dataDir, 'backups', backupId, '.work');
        if ((await statOrNull(p)) === null) return 0;
        await removeTree(p);
        return 1;
      },
    },
    ops: {
      items: async () => [...new Set([...(await ulidDirs(dataPath(dataDir, 'ops'))), ...(await ulidDirs(dataPath(dataDir, 'db')))])].sort(),
      async run(opId) {
        let record: OpFile | null;
        let archived = false;
        if (op !== null && op !== 'corrupt' && op.opId === opId) {
          record = op;
        } else {
          record = await archivedOp(dataDir, opId);
          archived = record !== null;
        }
        if (record === null || !isTerminal(record.kind, record.state)) return 0;
        const finishedAt = record.finishedAt ?? record.heartbeatAt;
        let removed = 0;
        const remove = async (p: DataPath): Promise<void> => {
          if ((await statOrNull(p)) === null) return;
          await removeTree(p);
          removed += 1;
        };
        if (archived && now - finishedAt > OP_RECORD_KEEP_MS) {
          await remove(dataPath(dataDir, 'db', opId));
          await remove(dataPath(dataDir, 'ops', opId));
        } else if (now - finishedAt > OP_FILES_KEEP_MS) {
          await remove(dataPath(dataDir, 'ops', opId, 'keep'));
          await remove(dataPath(dataDir, 'db', opId));
        }
        return removed;
      },
    },
    temps: {
      // Sorted as the checkpoint compares them: the backup ids (digits and capitals) before the three fixed keys.
      items: async () => [...(await ulidDirs(dataPath(dataDir, 'backups'))), ...TEMP_FOLDERS].sort(),
      run(which) {
        const swept = { now, olderThanMs: STALE_FILES_MS };
        if (which === 'backups') return removeStaleTemps(dataPath(dataDir, 'backups'), swept);
        if (which === 'blobs') return removeStaleTemps(dataPath(dataDir, 'backups', 'blobs'), swept);
        if (which === 'uploads') return removeStaleTemps(dataPath(dataDir, 'uploads'), { ...swept, depth: 2 });
        // A backup's folder: itself, `tables/` and each `tables/<t>/`, `downloads/<preparer>/`, `.work/`.
        return removeStaleTemps(dataPath(dataDir, 'backups', which), { ...swept, depth: 2 });
      },
    },
    orphans: {
      items: async () => ((await atRest()) ? orphanBackups(h, dataDir) : []),
      async run(backupId) {
        const ended = await abandonBackup(h, dataDir, { backupId, error: null, now, log: o.log ?? SILENT, notify: false });
        return ended ? 1 : 0;
      },
    },
    leftovers: {
      // Listed under the lock, at rest: no backup can make its row meanwhile (see phase 7).
      items: async () => ((await atRest()) ? ulidDirs(dataPath(dataDir, 'backups')) : []),
      async run(backupId) {
        const p = dataPath(dataDir, 'backups', backupId);
        const info = await statOrNull(p);
        if (info === null || info.kind !== 'dir') return 0;
        if (!(now - Math.max(ulidTime(backupId), info.mtimeMs) > STALE_FILES_MS)) return 0;
        const row = await h.db.selectFrom('backups').select('status').where('id', '=', backupId).executeTakeFirst();
        if (row !== undefined && row.status !== 'deleted' && row.status !== 'failed') return 0;
        await removeTree(p);
        return 1;
      },
    },
    blobs: {
      // Listed under the lock, which stays held until this call ends: nothing can start using a blob meanwhile.
      items: unusedBlobs,
      async run(name) {
        await removeFile(blobPath(dataDir, name));
        return 1;
      },
    },
  };

  let removed = 0;
  let took = false;
  const start = o.from === null ? 0 : FILES_PHASES.indexOf(o.from.phase);
  try {
    for (let i = start; i < FILES_PHASES.length; i += 1) {
      const phase = FILES_PHASES[i]!;
      /** The last item of this phase done (by this call or, for the phase it starts in, the previous slice). */
      let done = i === start ? (o.from?.after ?? null) : null;
      for (const item of await phases[phase].items()) {
        if (done !== null && item <= done) continue;
        if (took && !o.budgetLeft()) return { removed, next: { phase, after: done } };
        took = true;
        removed += await phases[phase].run(item);
        done = item;
      }
    }
    return { removed, next: null };
  } finally {
    // Its lease ends by itself (a lease's time) when the release fails.
    if (holding) await releaseLock(h, BACKUP_SNAPSHOT_LOCK, owner).catch(() => undefined);
  }
}
