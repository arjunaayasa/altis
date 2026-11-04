import {
  TABLE_COLUMNS,
  checkpointSqliteFile,
  columnsAt,
  connectSqliteFile,
  readPkBatch,
  readSqliteOwner,
  removeSqliteOwner,
  sqliteProcessStatus,
  sqliteSwapUnavailable,
  withTx,
  type DbHandle,
  type PkValue,
  type SqliteProcessRecord,
  type TableName,
} from '@altis/db';
import { dataPath, ensureDir, fsyncDir, listNames, renameRetry, statOrNull, withFileLock, type DataPath, type HeldFileLock } from '@altis/platform';
import { DomainError } from '@altis/shared';
import type { Kysely } from 'kysely';
import { schemaVersionOf } from '../backup/create-job.js';
import { errorFields, type CoreLogger } from '../context.js';
import { readMaintenance, writeMaintenance } from '../ops/files.js';
import type { SqliteSwap, SqliteSwapWait } from './kind.js';

// A restore on SQLite (spec §9.10 "SQLite", decision C17; S19, S23, M45, P7, P14; plan Task 25). Task 22's steps
// `loading` … `finalizing` 1–3 (the kept rows included) run on the work file `db/<opId>/restore.sqlite`: the live file
// `db/altis.sqlite` stays untouched until finalizing step 4 swaps the work file into its place, so a failure before it
// only discards the work file. The swap, under the file lock `tmp/sqlite.lock` (connect() opens nothing while another
// process holds it, "CLI lain ditolak"):
//
//   1  the work file checkpointed (`wal_checkpoint(TRUNCATE)`) and closed; no connection may be left on it (no
//      `restore.sqlite-wal`/`-shm` after the close: another process still holds it → `waiting`)
//   2  `maintenance.json.sqliteRelease = opId`, then this process closes its own handles (`closeOwn`); then a wait
//      until `tmp/sqlite-owner.json` is gone, names this process or a dead one (whose record is removed). An owner
//      process sees the flag at its next ops fence look (≤ 2 s; a worker loop looks every pass, S19), closes its
//      handle and so removes its record. R1c-11 (P9): one step waits no longer than its deadline (`wait.until`), then
//      returns `waiting`: the op step is retried, never failed (S19), and the owners stay released while the flag
//      asks for it. The wait has a budget of `releaseWaitMs` (30 s) across steps, counted from its first step (the
//      kind keeps when, `wait.since`, in op params); once it is spent, an owner that still looks alive (a reused pid)
//      or that cannot be asked (a record of another host identity: a container recreated meanwhile) is left to
//      step 3, where the file itself shows whether a connection is still on it. The step that spent the budget says
//      so; from then on the live file is settled first (a connection left → `waiting` before the history copy), and
//      once step 3 found no connection on it, that owner's record goes (it names no process holding the file)
//   2b the history rows the live file gained since `preserving` (M45: an audit entry of a takeover, say): audit_log
//      rows above the work file's highest `seq`, with the live audit_head when it is ahead; releases_log and backups
//      rows the work file lacks. Repeatable: a later attempt copies only what is still missing
//   3  the work file settled again (step 1), then the live file opened alone, checkpointed and closed: no
//      `altis.sqlite-wal`/`-shm` may be left (a connection of any process still on it → `waiting`)
//   4  renameRetry(altis.sqlite → db/<opId>/pre-restore.sqlite), renameRetry(db/<opId>/restore.sqlite → altis.sqlite)
//      (EBUSY/EPERM retried for 10 s, Windows), fsyncDir(db). A second rename that fails puts the first one back
//   5  `sqliteRelease = null`; this process reopens its handles (`reopenOwn`), still under the lock (the holder may)
//
// A failure between 2 and 4 (R1c-11) leaves the live file the installation's: before the error goes on to the kind
// (which then fails the op, the live file intact), `sqliteRelease` is lowered and this process reopens its handles,
// both best-effort. So does a rename of 4 that leaves the live file in place (the first one refused, or the second
// one refused and the first put back), but its error is transient (DB_UNAVAILABLE `sqlite_swap`): the op stays at the
// swap and the next step tries again. Once `pre-restore.sqlite` exists, a failure is the kind's to judge from the files
// (`swapped`: rename_back), this process's handles left closed.
//
// The owners reopen at their next fence look after the data epoch moved (finalizing step 6), then restart (S23, P14).
// Which step a crash interrupted is read from the files (P7): `pre-restore.sqlite` with the work file still there is
// a swap between its renames (finished by the next attempt, once whatever a connect put at altis.sqlite meanwhile is
// let go of and settled as at 2–3); `pre-restore.sqlite` alone is a swap that happened.
//
// renameBack(opId) (failed_restoring_pre after the swap): the same release, wait (`waiting` → tried again) and
// exclusivity, then
// altis.sqlite → db/<opId>/altis.sqlite (the restored file, kept beside the op for 7 days, housekeeping) and
// db/<opId>/pre-restore.sqlite → altis.sqlite. The owners reopen when the replay raises the data epoch. A swap stopped
// between its renames has no restored live file: its work file is the one kept as db/<opId>/altis.sqlite, and the
// pre-restore file replaces whatever is at altis.sqlite.
//
// swapped(opId): whether `pre-restore.sqlite` exists, the kind's test for "a failure after the swap" (R1c-11): from the
// first rename on, the way back is renameBack, whatever the op's checkpoint says.
//
// openWork(opId): the work file while it exists; the live file once the swap happened (`pre-restore.sqlite`) or was
// undone (`db/<opId>/altis.sqlite`): finalizing steps 5–7 (and the replay's) run there; else a new work file.

/** How long a swap waits for the owner processes to let go of the live file, across its steps (S19, R1c-11). */
export const SQLITE_RELEASE_WAIT_MS = 30_000;
/** How long the swap waits for `tmp/sqlite.lock` (one stepper at a time already holds `ops/step.lock`). */
const LOCK_WAIT_MS = 2000;
/** How often the wait for the owners looks at `tmp/sqlite-owner.json`. */
const OWNER_POLL_MS = 100;
/** Rows per batch when the history rows are copied (2b). */
const COPY_BATCH = 500;

/** The history tables whose rows the live file may gain during a restore (M45). */
const HISTORY: readonly TableName[] = Object.freeze(['audit_log', 'releases_log', 'backups']);

export interface SqliteSwapOptions {
  /** DATA_DIR (the ops machine's). */
  dataDir: string;
  log: CoreLogger;
  /**
   * The budget of the wait for the owners, across the steps of one swap (or rename back), before an owner that still
   * looks alive is left to the file check (default 30 000 ms; R1c-11). Each step waits until its own deadline at most.
   */
  releaseWaitMs?: number;
}

/**
 * What one step's wait for the owners found (see 2 at the top of this file): no owner left but this process; still
 * one when the step's bound came; or, the budget spent, the record of one that still looks alive (left to the file).
 */
type OwnersWait = 'released' | 'waiting' | { unconfirmed: SqliteProcessRecord };

/** A Kysely over tables named at run time (the history tables, the columns of the registry). */
type AnyDb = Kysely<Record<string, Record<string, unknown>>>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function exists(p: DataPath): Promise<boolean> {
  return (await statOrNull(p)) !== null;
}

/**
 * The SQLite side of a restore for DATA_DIR `o.dataDir` (see the top of this file), implementing Task 22's
 * {@link SqliteSwap}. One per process; every state it acts on is read from the files.
 *
 * @throws TypeError for a `releaseWaitMs` that is not a finite number of at least 0
 */
export function createSqliteSwap(o: SqliteSwapOptions): SqliteSwap {
  const { dataDir, log } = o;
  const releaseWaitMs = o.releaseWaitMs ?? SQLITE_RELEASE_WAIT_MS;
  if (!Number.isFinite(releaseWaitMs) || releaseWaitMs < 0) throw new TypeError('createSqliteSwap: releaseWaitMs must be a finite number of at least 0');

  const dbDir = (): DataPath => dataPath(dataDir, 'db');
  const livePath = (): DataPath => dataPath(dataDir, 'db', 'altis.sqlite');
  const opDir = (opId: string): DataPath => dataPath(dataDir, 'db', opId);
  const workPath = (opId: string): DataPath => dataPath(dataDir, 'db', opId, 'restore.sqlite');
  const prePath = (opId: string): DataPath => dataPath(dataDir, 'db', opId, 'pre-restore.sqlite');
  /** Where renameBack puts the restored file. */
  const backPath = (opId: string): DataPath => dataPath(dataDir, 'db', opId, 'altis.sqlite');
  const lockPath = (): DataPath => dataPath(dataDir, 'tmp', 'sqlite.lock');

  /**
   * `file` checkpointed and closed by a connection of its own; true when no connection is left on it afterwards
   * (SQLite removes `-wal` and `-shm` when the last connection to a file closes, and only then).
   */
  async function settle(file: DataPath, dir: DataPath, name: string): Promise<boolean> {
    const h = await connectSqliteFile(file);
    try {
      await checkpointSqliteFile(h);
    } finally {
      await h.close();
    }
    const names = await listNames(dir);
    return !names.includes(`${name}-wal`) && !names.includes(`${name}-shm`);
  }

  /** Sets `maintenance.json.sqliteRelease` (the op's flag; a missing flag gets one, null on none is left alone). */
  async function askRelease(lock: HeldFileLock, opId: string, value: string | null): Promise<void> {
    const flag = await readMaintenance(dataDir);
    if ((flag?.sqliteRelease ?? null) === value) return;
    lock.assertHeld();
    if (flag === null) {
      if (value === null) return;
      await writeMaintenance(dataDir, { reason: 'restore', since: Date.now(), opId, exemptJobIds: [], sqliteRelease: value });
      return;
    }
    await writeMaintenance(dataDir, { ...flag, sqliteRelease: value });
  }

  /**
   * Waits until no live process other than this one is recorded as the owner (see 2 at the top of this file):
   * `released` then; `waiting` when this step's bound (`wait.until`) came first; once the budget is spent, the record
   * of the owner that still looks alive (`unconfirmed`), left to the file check (said once, by the step that spent
   * the budget). Without `wait` one call has the whole budget.
   */
  async function ownersReleased(lock: HeldFileLock, opId: string, wait: SqliteSwapWait | undefined): Promise<OwnersWait> {
    const now = wait === undefined ? () => Date.now() : () => wait.now();
    const entered = now();
    let since = wait?.since ?? null;
    for (;;) {
      const owner = await readSqliteOwner(dataDir);
      if (owner === null) return 'released';
      const status = sqliteProcessStatus(owner);
      if (status === 'self') return 'released';
      if (status === 'gone') {
        // A crashed owner: its record goes (nothing can connect and record itself while the lock is held).
        lock.assertHeld();
        await removeSqliteOwner(dataDir);
        log.warn('sqlite swap: the owner recorded in tmp/sqlite-owner.json is gone; its record was removed', { opId, pid: owner.pid });
        return 'released';
      }
      const t = now();
      if (since === null || t < since) {
        // The first wait of the op (or a clock that went back): the budget runs from here, across steps.
        since = t;
        wait?.began(t);
      }
      if (t - since >= releaseWaitMs) {
        // R1c-11: the budget is spent. An owner that still looks alive (its pid reused by another process, or a
        // record of another host identity whose pid cannot be asked) no longer counts: the file itself decides
        // (step 3: a connection of any process on this kernel keeps its -wal/-shm).
        if (since + releaseWaitMs >= entered) {
          log.warn('sqlite swap: the owner recorded in tmp/sqlite-owner.json did not let go in time; the database file is checked instead', {
            opId,
            pid: owner.pid,
            host: owner.host,
            status,
            waitedMs: t - since,
          });
        }
        return { unconfirmed: owner };
      }
      const until = Math.min(since + releaseWaitMs, wait?.until ?? Number.POSITIVE_INFINITY);
      if (t >= until) {
        log.warn('sqlite swap: a process still holds the database; the swap is tried again on a later step', {
          opId,
          pid: owner.pid,
          host: owner.host,
          waitedMs: t - since,
        });
        return 'waiting';
      }
      await sleep(Math.min(OWNER_POLL_MS, until - t));
    }
  }

  /**
   * The live file showed no connection (3) although an owner record the budget let through (`unconfirmed`) is still
   * there: that record names no process holding the file, so it goes, and a later swap or rename back does not spend
   * the budget on it again. Only that record (one written meanwhile stays); best-effort, the record being a hint.
   */
  async function dropUnconfirmed(lock: HeldFileLock, opId: string, owner: SqliteProcessRecord): Promise<void> {
    let current: SqliteProcessRecord | null;
    try {
      current = await readSqliteOwner(dataDir);
    } catch {
      return;
    }
    if (current === null || current.pid !== owner.pid || current.startMs !== owner.startMs || current.host !== owner.host) return;
    lock.assertHeld();
    try {
      await removeSqliteOwner(dataDir);
    } catch (error) {
      log.warn('sqlite swap: the record in tmp/sqlite-owner.json could not be removed', { opId, ...errorFields(error) });
      return;
    }
    log.warn('sqlite swap: the owner recorded in tmp/sqlite-owner.json holds no connection on the database file; its record was removed', {
      opId,
      pid: owner.pid,
      host: owner.host,
    });
  }

  /** A step that cannot swap (or rename back) because a connection is still on the database file: `waiting`. */
  function connectionLeft(opId: string, what: 'swap' | 'rename back'): 'waiting' {
    log.warn(`sqlite swap: a connection is still on the database file; the ${what} is tried again on a later step`, { opId });
    return 'waiting';
  }

  /** The columns of `table` both files have (the live file at its own schema version, the work file at the latest). */
  function sharedColumns(table: TableName, liveVersion: string): string[] {
    const atLive = new Set(columnsAt(table, liveVersion).map((c) => c.name));
    return TABLE_COLUMNS[table].map((c) => c.name).filter((name) => atLive.has(name));
  }

  /** audit_log rows above the work file's highest seq, then the live audit_head when it is ahead (2b). */
  async function copyAudit(live: DbHandle, work: DbHandle, columns: string[]): Promise<number> {
    const from = live.db as unknown as AnyDb;
    const into = work.db as unknown as AnyDb;
    const top = await into.selectFrom('audit_log').select('seq').orderBy('seq', 'desc').limit(1).executeTakeFirst();
    let after = Number(top?.['seq'] ?? 0);
    let copied = 0;
    for (;;) {
      const rows = await from.selectFrom('audit_log').select(columns).where('seq', '>', after).orderBy('seq').limit(COPY_BATCH).execute();
      if (rows.length === 0) break;
      await withTx(work, (trx) => (trx as unknown as AnyDb).insertInto('audit_log').values(rows).execute());
      after = Number(rows[rows.length - 1]!['seq']);
      copied += rows.length;
    }
    const liveHead = await from.selectFrom('audit_head').select(['last_seq', 'last_hash']).where('id', '=', 1).executeTakeFirst();
    const workHead = await into.selectFrom('audit_head').select(['last_seq', 'last_hash']).where('id', '=', 1).executeTakeFirst();
    if (liveHead !== undefined && workHead !== undefined && Number(liveHead['last_seq']) > Number(workHead['last_seq'])) {
      await into.updateTable('audit_head').set({ last_seq: liveHead['last_seq'], last_hash: liveHead['last_hash'] }).where('id', '=', 1).execute();
    }
    return copied;
  }

  /** The rows of `table` (keyed by `id`) the work file lacks (2b). */
  async function copyMissing(live: DbHandle, work: DbHandle, table: TableName, columns: string[]): Promise<number> {
    const into = work.db as unknown as AnyDb;
    let after: PkValue[] | null = null;
    let copied = 0;
    for (;;) {
      const batch = await readPkBatch(live.db, live.dialect, table, { after, limit: COPY_BATCH, columns });
      if (batch.length === 0) break;
      const ids = batch.map((row) => row['id'] as string);
      const have = new Set((await into.selectFrom(table).select('id').where('id', 'in', ids).execute()).map((row) => row['id']));
      const missing = batch.filter((row) => !have.has(row['id']));
      if (missing.length > 0) await withTx(work, (trx) => (trx as unknown as AnyDb).insertInto(table).values(missing).execute());
      copied += missing.length;
      after = [ids[ids.length - 1]!];
      if (batch.length < COPY_BATCH) break;
    }
    return copied;
  }

  /** 2b: the history rows the live file gained since `preserving`, copied into the work file. */
  async function copyHistory(opId: string): Promise<number> {
    const live = await connectSqliteFile(livePath());
    try {
      const work = await connectSqliteFile(workPath(opId));
      try {
        const version = await schemaVersionOf(live.db);
        let copied = 0;
        for (const table of HISTORY) {
          const columns = sharedColumns(table, version);
          copied += table === 'audit_log' ? await copyAudit(live, work, columns) : await copyMissing(live, work, table, columns);
        }
        return copied;
      } finally {
        await work.close();
      }
    } finally {
      await live.close();
    }
  }

  /**
   * 4: the two renames; a failed second one puts the first back (the installation never lacks its live file). When the
   * live file is still (or again) in place, nothing was swapped (R1c-11): the flag goes down, this process reopens its
   * handles (`unrelease`) and the error is transient (`sqliteSwapUnavailable`: the op stays at the swap, the next step
   * tries again; an EBUSY lasting past renameRetry's 10 s, Windows, is the usual one). Once `pre-restore.sqlite`
   * exists (a rename that went through, then its directory sync failed) the error goes on as it is: the kind goes back
   * through rename_back (`swapped`), and this process's handles stay closed (a reopen could make an empty altis.sqlite).
   */
  async function renameIn(lock: HeldFileLock, opId: string, reopenOwn: () => Promise<void>): Promise<void> {
    lock.assertHeld();
    try {
      await renameRetry(livePath(), prePath(opId));
    } catch (error) {
      if (await exists(prePath(opId))) throw error;
      log.error('sqlite swap: the database file could not be moved aside; the swap is tried again on a later step', { opId, ...errorFields(error) });
      await unrelease(lock, opId, reopenOwn);
      throw sqliteSwapUnavailable();
    }
    try {
      await renameRetry(workPath(opId), livePath());
    } catch (error) {
      // Renamed in, then its directory sync failed: swapped (putting the first rename back would drop the restored file).
      if (!(await exists(workPath(opId)))) throw error;
      log.error('sqlite swap: the work file could not be renamed into place; the live file goes back', { opId, ...errorFields(error) });
      try {
        await renameRetry(prePath(opId), livePath());
      } catch (back) {
        // Both files are kept where they are: the next attempt finishes the swap (pre-restore.sqlite and the work file).
        log.error('sqlite swap: the live file could not be put back; the next step finishes the swap', { opId, ...errorFields(back) });
      }
      if (!(await exists(prePath(opId)))) await unrelease(lock, opId, reopenOwn);
      throw sqliteSwapUnavailable();
    }
    await fsyncDir(dbDir());
  }

  /** 5: the flag lowered, this process's handles reopened. */
  async function finish(lock: HeldFileLock, opId: string, reopenOwn: () => Promise<void>): Promise<'swapped'> {
    await askRelease(lock, opId, null);
    await reopenOwn();
    return 'swapped';
  }

  /**
   * A swap that failed after 2 and before 4 (R1c-11), best-effort: `sqliteRelease` lowered and this process's handles
   * reopened. Each failure is logged, never thrown (the swap's own error is the one that counts); the other owners
   * reopen when the op ends (their fence sees the flag gone).
   */
  async function unrelease(lock: HeldFileLock, opId: string, reopenOwn: () => Promise<void>): Promise<void> {
    try {
      await askRelease(lock, opId, null);
    } catch (error) {
      log.error('sqlite swap: the release flag could not be lowered after the swap failed', { opId, ...errorFields(error) });
    }
    try {
      await reopenOwn();
    } catch (error) {
      log.error('sqlite swap: this process could not open its database handle again after the swap failed', { opId, ...errorFields(error) });
    }
  }

  function locked<T>(fn: (lock: HeldFileLock) => Promise<T>): Promise<T> {
    return (async () => {
      await ensureDir(dataPath(dataDir, 'tmp'));
      return withFileLock(lockPath(), fn, { waitMs: LOCK_WAIT_MS });
    })();
  }

  return {
    workPath,

    async openWork(opId) {
      if (await exists(workPath(opId))) return connectSqliteFile(workPath(opId));
      // Swapped in (or renamed back): the steps after the swap run on the live file.
      if ((await exists(prePath(opId))) || (await exists(backPath(opId)))) return connectSqliteFile(livePath());
      await ensureDir(opDir(opId));
      return connectSqliteFile(workPath(opId), { create: true });
    },

    swap({ opId, closeOwn, reopenOwn, wait }) {
      return locked(async (lock) => {
        const work = await exists(workPath(opId));
        if (await exists(prePath(opId))) {
          // The first rename happened already: a swap between its renames (crash), or one the op did not record yet.
          if (work) {
            // Whatever is at altis.sqlite now is no installation's file (one a connect made meanwhile, the kind's
            // dialect probe among them): like the live file at 2–3 it is let go of and settled, and the work file
            // settled again, before the work file takes its place; a connection left on either → `waiting`.
            await askRelease(lock, opId, opId);
            await closeOwn();
            if (await exists(livePath())) {
              const owners = await ownersReleased(lock, opId, wait);
              if (owners === 'waiting') return 'waiting';
              if (!(await settle(livePath(), dbDir(), 'altis.sqlite'))) return connectionLeft(opId, 'swap');
              if (owners !== 'released') await dropUnconfirmed(lock, opId, owners.unconfirmed);
            }
            if (!(await settle(workPath(opId), opDir(opId), 'restore.sqlite'))) return connectionLeft(opId, 'swap');
            lock.assertHeld();
            await renameRetry(workPath(opId), livePath());
            await fsyncDir(dbDir());
            log.warn('sqlite swap: a swap interrupted between its renames was finished', { opId });
          } else if (!(await exists(livePath()))) {
            // Neither the work file nor the live file (removed by hand?): the old data goes back, the op fails.
            lock.assertHeld();
            await renameRetry(prePath(opId), livePath());
            await fsyncDir(dbDir());
            throw new DomainError('STATE_CORRUPT', {
              detail:
                `Berkas kerja restore dan db/altis.sqlite hilang; data sebelum restore dikembalikan / ` +
                `The restore work file and db/altis.sqlite are gone; the data from before the restore was put back`,
              meta: { reason: 'sqlite_work_missing' },
            });
          }
          return finish(lock, opId, reopenOwn);
        }
        if (!work) {
          throw new DomainError('STATE_CORRUPT', {
            detail: `Berkas kerja restore db/${opId}/restore.sqlite tidak ada / The restore work file db/${opId}/restore.sqlite is missing`,
            meta: { reason: 'sqlite_work_missing' },
          });
        }
        // 1
        if (!(await settle(workPath(opId), opDir(opId), 'restore.sqlite'))) {
          log.warn('sqlite swap: another connection is still on the work file; the swap is tried again on a later step', { opId });
          return 'waiting';
        }
        let copied: number;
        try {
          // 2
          await askRelease(lock, opId, opId);
          await closeOwn();
          const owners = await ownersReleased(lock, opId, wait);
          if (owners === 'waiting') return 'waiting';
          // An owner the budget let through: the live file is looked at first, so that a step that cannot swap costs
          // one open, checkpoint and close, not a history copy.
          if (owners !== 'released' && !(await settle(livePath(), dbDir(), 'altis.sqlite'))) return connectionLeft(opId, 'swap');
          // 2b
          copied = await copyHistory(opId);
          // 3
          if (!(await settle(workPath(opId), opDir(opId), 'restore.sqlite')) || !(await settle(livePath(), dbDir(), 'altis.sqlite'))) {
            return connectionLeft(opId, 'swap');
          }
          if (owners !== 'released') await dropUnconfirmed(lock, opId, owners.unconfirmed);
        } catch (error) {
          // R1c-11: nothing was renamed, so the live file is still the installation's: the flag goes down and this
          // process opens its own handle again (a single-process install would otherwise serve no database at all).
          await unrelease(lock, opId, reopenOwn);
          throw error;
        }
        // 4
        await renameIn(lock, opId, reopenOwn);
        log.info('sqlite swap: the restored database is in place', { opId, historyRowsCopied: copied });
        // 5
        return finish(lock, opId, reopenOwn);
      });
    },

    renameBack(opId, o = {}) {
      return locked(async (lock): Promise<void | 'waiting'> => {
        if (!(await exists(prePath(opId)))) {
          if (!(await exists(backPath(opId)))) log.warn('sqlite swap: nothing to rename back (the live file was never swapped)', { opId });
          return;
        }
        // A swap stopped between its renames (R1c-11): the work file never went live, so it is the restored file kept
        // beside the op (openWork then opens the live file for the replay's steps), and whatever is at altis.sqlite is
        // not (an empty file a connect made meanwhile): the pre-restore file replaces it.
        const stopped = await exists(workPath(opId));
        if (await exists(livePath())) {
          await askRelease(lock, opId, opId);
          const owners = await ownersReleased(lock, opId, o.wait);
          if (owners === 'waiting') return 'waiting'; // the next step tries again
          if (!(await settle(livePath(), dbDir(), 'altis.sqlite'))) return connectionLeft(opId, 'rename back');
          if (owners !== 'released') await dropUnconfirmed(lock, opId, owners.unconfirmed);
          lock.assertHeld();
          if (!stopped) await renameRetry(livePath(), backPath(opId));
        }
        if (stopped) {
          lock.assertHeld();
          await renameRetry(workPath(opId), backPath(opId));
        }
        lock.assertHeld();
        await renameRetry(prePath(opId), livePath());
        await fsyncDir(dbDir());
        await askRelease(lock, opId, null);
        log.warn('sqlite swap: the pre-restore database is back in place', { opId });
      });
    },

    swapped(opId) {
      return exists(prePath(opId));
    },
  };
}
