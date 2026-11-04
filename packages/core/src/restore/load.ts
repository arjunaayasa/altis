import {
  TABLE_KEYS,
  dropRegisteredTables,
  migrationsUpTo,
  readPkBatch,
  runMigrations,
  tableLoadOrder,
  withTx,
  type AltisMigration,
  type DB,
  type DbHandle,
  type PkValue,
  type TableName,
} from '@altis/db';
import { faultArmed, killSelf, type HeldFileLock } from '@altis/platform';
import { isDomainError } from '@altis/shared';
import type { Kysely, Transaction } from 'kysely';
import { z } from 'zod';
import { backupTables } from '../backup/canonical.js';
import type { BackupManifest } from '../backup/manifest.js';
import { pkValueSchema } from '../backup/manifest.js';
import type { CoreLogger } from '../context.js';
import { SCHEDULES } from '../scheduler/registry.js';
import { seedSchedules } from '../scheduler/tick.js';
import { readSettings } from '../settings/service.js';
import { restoreSecretColumns, type RestoreChecklist, type SecretRestore } from './secrets.js';
import type { RestoreSource } from './source.js';

// The load of a restore (spec §9.10 steps 6–8; decisions C16, C40; preflight S2, B4; P7, P9; plan Task 22), run on
// the restore's work handle (a dedicated pool-1 connection, P17/S4; on SQLite Task 25's work file), past the point of
// no return. The same steps load the backup being restored and, after a failure, the `pre_restore` backup (the
// replay). Each sub-step is checkpointed in the fixed-size {@link LoadCheckpoint} (ruling R1c-6):
//
//   dropped   dropRegisteredTables: every table schema_tables lists (resumable by itself);
//   migrated  runMigrations up to the backup's schemaVersion (migrationsUpTo), then schema_meta.install_id set back to
//             the target's (read in `prechecked`, before anything was dropped);
//   tables    the backup's `data` and `config` tables in tableLoadOrder (parents first). Before the first part of a
//             table, every row of it and of the tables loaded after it is deleted (children first): rows the restore
//             did not write (a booting process's seeds, B4) can neither shadow the backup nor block a delete through a
//             foreign key. A part is loaded in transactions of up to 5000 rows in primary-key order (halved when one
//             took more than 10 s: P9 outranks "one part = one transaction", C16), its secrets as the branch says. A
//             self-referencing column is NULL in a first pass and set in a second. A process killed after a commit
//             but before its checkpoint (P7) leaves rows beyond the checkpoint's `after`: the next step finds the last
//             of them (keyset reads in primary-key order) and skips every row of the backup up to it, so nothing is
//             loaded twice;
//   seeded    `schedules` (config): its rows loaded, the code's definitions seeded again (seedSchedules keeps the
//             backup's `enabled` and an editable `expr`).
//
// History tables (`audit_log`, `releases_log`, `backups`) are never loaded: the target keeps its own (finalize.ts).
//
// Test hooks (test build only, R57): `ALTIS_TEST_FAULT=restore-mid-load:<n>[:replay]` throws at part `<n>` of the
// main load (and of the replay with `:replay`), `disk-full:load:<n>` throws a synthetic EDQUOT at part `<n>` of the main
// load (S13); `ALTIS_TEST_RESTORE_KILL=after-drop|after-part:<n>` kills the process right after the drop, or right
// after part `<n>` of the main load committed, before the checkpoint (Review Focus 2); `ALTIS_TEST_RESTORE_TX_ROWS`
// makes the transactions smaller.

/** Rows per transaction (C16). */
export const LOAD_TX_ROWS = 5000;
/** A transaction that took longer than this halves the next ones (C16, P9). */
const SLOW_TX_MS = 10_000;
/** A step stops starting transactions this long before its deadline. */
const STEP_MARGIN_MS = 1000;
/** Bind parameters per INSERT statement (below every dialect's limit). */
const STATEMENT_PARAMS = 4000;
/** Text bytes per INSERT statement (below MySQL/MariaDB's smallest max_allowed_packet). */
const STATEMENT_BYTES = 2 * 1024 * 1024;
/** Rows per keyset read when looking for rows committed beyond the checkpoint. */
const RESUME_BATCH = 1000;

/** Where a load stands (op.params.load, or op.params.replay.load). */
export type LoadCheckpoint = {
  dropped: boolean;
  migrated: boolean;
  /** Index into {@link loadTables} of the table being loaded. */
  table: number;
  /** The rows of that table (and of the tables after it) were deleted. */
  started: boolean;
  /** The next part to load, from 1. */
  part: number;
  /** 1: rows (self-references NULL); 2: self-references set. */
  pass: 1 | 2;
  /** The primary key of the last row of the table committed as of this checkpoint. */
  after: PkValue[] | null;
  txRows: number;
  seeded: boolean;
};

export const loadCheckpointSchema = z.strictObject({
  dropped: z.boolean(),
  migrated: z.boolean(),
  table: z.number().int().min(0).max(1000),
  started: z.boolean(),
  part: z.number().int().min(1).max(100_000),
  pass: z.union([z.literal(1), z.literal(2)]),
  after: z.array(pkValueSchema).min(1).max(8).nullable(),
  txRows: z.number().int().min(1).max(LOAD_TX_ROWS),
  seeded: z.boolean(),
}) satisfies z.ZodType<LoadCheckpoint>;

/** The first checkpoint of a load. */
export function newLoad(): LoadCheckpoint {
  return { dropped: false, migrated: false, table: 0, started: false, part: 1, pass: 1, after: null, txRows: txRowsStart(), seeded: false };
}

/** {@link LOAD_TX_ROWS}, or in a test build `ALTIS_TEST_RESTORE_TX_ROWS` (fewer). */
function txRowsStart(): number {
  if (typeof __BUILD_PROFILE__ !== 'undefined' && __BUILD_PROFILE__ === 'test') {
    const value = Number(process.env['ALTIS_TEST_RESTORE_TX_ROWS']);
    if (Number.isInteger(value) && value > 0 && value < LOAD_TX_ROWS) return value;
  }
  return LOAD_TX_ROWS;
}

/** The tables a restore loads: the backup's `data` and `config` tables, in load order. */
export function loadTables(m: BackupManifest): TableName[] {
  return backupTables()
    .filter((t) => (t.cls === 'data' || t.cls === 'config') && Object.hasOwn(m.tables, t.table))
    .map((t) => t.table);
}

/** The global number of part `n` of the table at `index` of `tables` (parts of the tables before it counted first). */
function globalPart(m: BackupManifest, tables: readonly TableName[], index: number, n: number): number {
  let before = 0;
  for (let i = 0; i < index; i += 1) before += m.tables[tables[i]!]!.parts.length;
  return before + n;
}

/** Test faults at part `part` (S13); the condition stays inline so that a production build drops the block. */
function partFault(part: number, replay: boolean): void {
  if (typeof __BUILD_PROFILE__ !== 'undefined' && __BUILD_PROFILE__ === 'test') {
    const mid = faultArmed(process.env, 'restore-mid-load');
    if (mid !== null) {
      const [n, flag] = mid.split(':');
      if (Number(n) === part && (!replay || flag === 'replay')) throw new Error(`restore-mid-load at part ${part} (test fault)`);
    }
    const disk = faultArmed(process.env, 'disk-full');
    const m = disk === null || replay ? null : /^load:(\d+)$/.exec(disk);
    if (m !== null && Number(m[1]) === part) {
      throw Object.assign(new Error('EDQUOT: disk quota exceeded (test fault)'), { code: 'EDQUOT' });
    }
  }
}

/** Test hook `ALTIS_TEST_RESTORE_KILL` (Review Focus 2): kills the process at `point` of the main load. */
function killPoint(point: string, replay: boolean): void {
  if (typeof __BUILD_PROFILE__ !== 'undefined' && __BUILD_PROFILE__ === 'test') {
    if (!replay && process.env['ALTIS_TEST_RESTORE_KILL'] === point) killSelf();
  }
}

/** Compares two primary keys in the order of readPkBatch (numbers by value, text by UTF-8 bytes). */
export function comparePk(a: readonly PkValue[], b: readonly PkValue[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const x = a[i]!;
    const y = b[i]!;
    if (typeof x === 'number' && typeof y === 'number') {
      if (x !== y) return x < y ? -1 : 1;
      continue;
    }
    const d = Buffer.compare(Buffer.from(String(x), 'utf8'), Buffer.from(String(y), 'utf8'));
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

/** The primary key of a canonical row of `table`. */
export function rowPk(table: TableName, row: Record<string, unknown>): PkValue[] {
  return TABLE_KEYS[table].pk.map((name) => {
    const value = row[name];
    if (typeof value !== 'string' && typeof value !== 'number') throw new TypeError(`restore: ${table}.${name} is not a key value`);
    return value;
  });
}

/**
 * The key of the last row of `table` beyond `after` in primary-key order (rows a killed step committed after its
 * checkpoint), or `after` itself when there is none.
 */
export async function committedAfter(work: DbHandle, table: TableName, after: PkValue[] | null): Promise<PkValue[] | null> {
  const pk = TABLE_KEYS[table].pk;
  let last = after;
  for (;;) {
    const batch = await readPkBatch(work.db, work.dialect, table, { after: last, limit: RESUME_BATCH, columns: pk });
    if (batch.length === 0) return last;
    last = rowPk(table, batch[batch.length - 1]!);
    if (batch.length < RESUME_BATCH) return last;
  }
}

/** A Kysely of tables named at run time: the restore writes whatever table the backup holds. */
type Loose = Kysely<Record<string, Record<string, unknown>>>;

function loose(trx: Transaction<DB> | Kysely<DB>): Loose {
  return trx as unknown as Loose;
}

/** Inserts `rows` (already in `columns` form) into `table` in `trx`, a few statements of bounded size. */
async function insertRows(trx: Transaction<DB>, table: string, rows: Record<string, unknown>[]): Promise<void> {
  const width = Math.max(1, Object.keys(rows[0] ?? {}).length);
  const perStatement = Math.max(1, Math.floor(STATEMENT_PARAMS / width));
  let batch: Record<string, unknown>[] = [];
  let bytes = 0;
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    await loose(trx).insertInto(table).values(batch).execute();
    batch = [];
    bytes = 0;
  };
  for (const row of rows) {
    let size = 0;
    for (const value of Object.values(row)) if (typeof value === 'string') size += value.length * 3;
    if (batch.length > 0 && (batch.length >= perStatement || bytes + size > STATEMENT_BYTES)) await flush();
    batch.push(row);
    bytes += size;
  }
  await flush();
}

/** Deletes every row of `tables`, in the order given, in one transaction. */
export async function emptyTables(work: DbHandle, tables: readonly string[]): Promise<void> {
  await withTx(work, async (trx) => {
    for (const t of tables) await loose(trx).deleteFrom(t).execute();
  });
}

export interface InsertLinesOptions {
  /** The columns written (each row is cut down to them); default every key of the row. */
  columns?: readonly string[];
  /** Rows whose primary key is at most this one are skipped (loaded before). */
  after: PkValue[] | null;
  txRows: number;
  /** Stop starting transactions once `clock() ≥ stopAt`. */
  stopAt: number;
  clock: () => number;
  /** Changes a row before it is written (the secrets, a self-reference left NULL). */
  transform?: (row: Record<string, unknown>) => Record<string, unknown>;
  /** Called after each COMMIT with the key of the last row committed. */
  committed?: (after: PkValue[]) => void;
}

/**
 * Writes the canonical rows of `lines` into `table` of `work` in transactions of `o.txRows` rows (halved after one
 * that took more than 10 s), skipping rows up to `o.after`. Returns where it stopped: `ended` once every line was
 * written, else the key of the last row committed (a later call goes on from there).
 */
export async function insertLines(
  work: DbHandle,
  table: TableName,
  lines: AsyncIterable<string>,
  o: InsertLinesOptions,
): Promise<{ ended: boolean; after: PkValue[] | null; txRows: number }> {
  let after = o.after;
  let txRows = o.txRows;
  let pending: Record<string, unknown>[] = [];
  let lastPending: PkValue[] | null = null;
  const commit = async (): Promise<void> => {
    if (pending.length === 0) return;
    const rows = pending;
    const started = performance.now();
    await withTx(work, (trx) => insertRows(trx, table, rows));
    if (performance.now() - started > SLOW_TX_MS) txRows = Math.max(1, Math.floor(txRows / 2));
    after = lastPending;
    pending = [];
    if (after !== null) o.committed?.(after);
  };
  for await (const line of lines) {
    if (line === '') continue;
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const pk = rowPk(table, parsed);
    if (after !== null && comparePk(pk, after) <= 0) continue;
    let row = o.transform === undefined ? parsed : o.transform(parsed);
    if (o.columns !== undefined) {
      const cut: Record<string, unknown> = {};
      for (const c of o.columns) cut[c] = Object.hasOwn(row, c) ? row[c] : null;
      row = cut;
    }
    pending.push(row);
    lastPending = pk;
    if (pending.length >= txRows) {
      await commit();
      if (o.clock() >= o.stopAt) return { ended: false, after, txRows };
    }
  }
  await commit();
  return { ended: true, after, txRows };
}

/** Sets the self-referencing columns `columns` of the rows of `lines` (the second pass), skipping rows up to `after`. */
async function updateSelfRefs(
  work: DbHandle,
  table: TableName,
  lines: AsyncIterable<string>,
  columns: readonly string[],
  o: { after: PkValue[] | null; txRows: number; stopAt: number; clock: () => number },
): Promise<{ ended: boolean; after: PkValue[] | null }> {
  const pkCols = TABLE_KEYS[table].pk;
  let after = o.after;
  let pending: Record<string, unknown>[] = [];
  const commit = async (): Promise<void> => {
    if (pending.length === 0) return;
    const rows = pending;
    await withTx(work, async (trx) => {
      for (const row of rows) {
        const set: Record<string, unknown> = {};
        for (const c of columns) set[c] = row[c];
        let q = loose(trx).updateTable(table).set(set);
        for (const k of pkCols) q = q.where(k, '=', row[k] as string | number);
        await q.execute();
      }
    });
    after = rowPk(table, rows[rows.length - 1]!);
    pending = [];
  };
  for await (const line of lines) {
    if (line === '') continue;
    const row = JSON.parse(line) as Record<string, unknown>;
    if (after !== null && comparePk(rowPk(table, row), after) <= 0) continue;
    if (columns.every((c) => row[c] === null)) continue;
    pending.push(row);
    if (pending.length >= o.txRows) {
      await commit();
      if (o.clock() >= o.stopAt) return { ended: false, after };
    }
  }
  await commit();
  return { ended: true, after };
}

/** Another process holds a migration lock: a later step tries again. */
function lockBusy(error: unknown): boolean {
  if (!isDomainError(error)) return false;
  const reason = error.meta?.['reason'];
  return (error.code === 'STATE_CORRUPT' && reason === 'lock_timeout') || (error.code === 'DB_UNAVAILABLE' && reason === 'busy');
}

/** What a load step needs. */
export interface LoadContext {
  work: DbHandle;
  source: RestoreSource;
  dataDir: string;
  appVersion: string;
  /** Every migration of the code. */
  migrations: Record<string, AltisMigration>;
  /** `schema_meta.install_id` of the target, read before anything was dropped. */
  targetInstallId: string | null;
  secrets: SecretRestore;
  deadline: number;
  clock: () => number;
  log: CoreLogger;
  /** `ops/step.lock`: asserted before the drop and each table's delete. */
  lock: HeldFileLock;
  /** The `pre_restore` replay (the fault hooks tell it apart). */
  replay: boolean;
}

/** A load step's result: `busy` when a migration lock is held elsewhere (nothing changed). */
export interface LoadStepResult {
  done: boolean;
  busy: boolean;
  checkpoint: LoadCheckpoint;
  /** 0 to 100, of the load. */
  progress: number;
}

/**
 * One step of a load from `cp` (see the top of this file): one sub-step (the drop, the archive-level migrations, the
 * schedules' seeding), or parts until `ctx.deadline` (at least one transaction).
 *
 * @throws the database's errors (a lost connection is DB_UNAVAILABLE), BACKUP_INVALID while reading a part, the test
 *   faults
 */
export async function loadStep(ctx: LoadContext, cp: LoadCheckpoint): Promise<LoadStepResult> {
  const c = structuredClone(cp);
  const { work, source } = ctx;
  const m = source.manifest;
  const tables = loadTables(m);
  const progressOf = (): number => Math.floor((100 * Math.min(c.table, tables.length)) / Math.max(1, tables.length + 1));
  const result = (done: boolean, busy = false): LoadStepResult => ({ done, busy, checkpoint: c, progress: done ? 100 : progressOf() });

  if (!c.dropped) {
    ctx.lock.assertHeld();
    await dropRegisteredTables(work.db, work.dialect);
    killPoint('after-drop', ctx.replay);
    c.dropped = true;
    return result(false);
  }
  if (!c.migrated) {
    try {
      await runMigrations(work, {
        appVersion: ctx.appVersion,
        dataDir: ctx.dataDir,
        migrations: migrationsUpTo(ctx.migrations, m.schemaVersion),
        lockWaitMs: Math.max(1000, ctx.deadline - ctx.clock()),
      });
    } catch (error) {
      if (lockBusy(error)) return result(false, true);
      throw error;
    }
    await work.db.updateTable('schema_meta').set({ install_id: ctx.targetInstallId }).where('id', '=', 1).execute();
    c.migrated = true;
    return result(false);
  }

  const { selfRefs } = tableLoadOrder(tables);
  const stopAt = ctx.deadline - STEP_MARGIN_MS;
  let first = true;
  while (first || ctx.clock() < stopAt) {
    first = false;
    const table = tables[c.table];
    if (table === undefined) {
      if (!c.seeded) {
        const tz = (await readSettings(work.db, ['library.timezone'], []))['library.timezone'] as string;
        await withTx(work, (trx) => seedSchedules(trx, ctx.clock(), tz, SCHEDULES));
        c.seeded = true;
      }
      return result(true);
    }
    if (!c.started) {
      ctx.lock.assertHeld();
      await emptyTables(work, tables.slice(c.table).reverse());
      Object.assign(c, { started: true, part: 1, pass: 1, after: null });
    }
    const parts = m.tables[table]!.parts;
    const self = selfRefs[table] ?? [];
    const part = parts.find((p) => p.n === c.part);
    if (part === undefined) {
      if (c.pass === 1 && self.length > 0) Object.assign(c, { pass: 2, part: 1, after: null });
      else Object.assign(c, { table: c.table + 1, started: false, part: 1, pass: 1, after: null });
      continue;
    }
    if (c.pass === 2) {
      const r = await updateSelfRefs(work, table, source.partLines(table, part.n), self, { after: c.after, txRows: c.txRows, stopAt, clock: ctx.clock });
      c.after = r.after;
      if (!r.ended) return result(false);
      c.part += 1;
      continue;
    }
    // Rows a killed step committed after its checkpoint.
    c.after = await committedAfter(work, table, c.after);
    if (c.after !== null && part.lastPk !== null && comparePk(c.after, part.lastPk) >= 0) {
      c.part += 1;
      continue;
    }
    partFault(globalPart(m, tables, c.table, part.n), ctx.replay);
    // The names restoreSecretColumns notes are not kept: a step killed after its COMMIT would lose them, so the report
    // reads what was not carried over from the restored rows at the end (finalize.ts restoredLists).
    const scratch: RestoreChecklist = { secrets: [], reenroll: [] };
    const r = await insertLines(work, table, source.partLines(table, part.n), {
      after: c.after,
      txRows: c.txRows,
      stopAt,
      clock: ctx.clock,
      transform: (row) => {
        const out = restoreSecretColumns(table, row, ctx.secrets, scratch);
        for (const col of self) out[col] = null;
        return out;
      },
      // Right after the COMMIT of the part's last row, before any checkpoint (Review Focus 2).
      committed: (after) => {
        if (part.lastPk !== null && comparePk(after, part.lastPk) === 0) killPoint(`after-part:${globalPart(m, tables, c.table, part.n)}`, ctx.replay);
      },
    });
    c.after = r.after;
    c.txRows = r.txRows;
    if (!r.ended) return result(false);
    c.part += 1;
  }
  return result(false);
}
