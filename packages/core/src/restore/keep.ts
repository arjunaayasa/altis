import type { FileHandle } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { TABLE_COLUMNS, columnsAt, readPkBatch, withTx, type DbHandle, type PkValue, type TableName } from '@altis/db';
import { opKeepPath, openRead, openReadWrite, statOrNull, type DataPath, type HeldFileLock } from '@altis/platform';
import { DomainError } from '@altis/shared';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { BACKUP_PATH_TABLES, canonicalLine, canonicalRow, pkOf } from '../backup/canonical.js';
import { pkValueSchema } from '../backup/manifest.js';
import { committedAfter, insertLines } from './load.js';

// What a restore keeps of the target (spec §6.5, §9.10 "hal yang dipertahankan", A6; decision C16; preflight S2; plan
// Task 22). Before the point of no return (`preserving`), the target's rows that no backup may replace are written to
// `ops/<opId>/keep/<table>.jsonl.gz` (canonical lines in primary-key order, the columns of the target's schema
// version):
//
//   install   license_state, audit_head, and the `settings` rows of scope `instance` (machine state: ip_trust, the
//             run records, clock_anomaly, ...);
//   history   audit_log, releases_log, backups: the target's own history, which the backup's history never replaces.
//
// A table can be large (`audit_log` keeps two years), so a step writes keyset batches of it until its deadline (at
// least one batch, P9) and appends them to the file as one gzip member (the file is a series of members, read back as
// one stream). As ruling R1c-6 does for a sidecar, the checkpoint (`op.params.keep`) records the key of the last row
// written and the file's length then; the next step first cuts the file back to that length (what a step killed after
// its write appended), then goes on after that key.
//
// At `finalizing` step 1 (restoreKeptStep) they go back after the load: the install and history tables are emptied
// first (the migrations seeded audit_head, nothing else writes there during a restore) and the kept rows inserted again
// with the columns the final schema still has (the intersection: the code's latest, or the backup's schema for a
// restore with `targetSchema: 'backup'`, 1d); the `instance` settings rows are deleted and inserted
// again, which is an upsert that no row written meanwhile can collide with (S2). Resumable per table and, within a
// table, from the last row committed (load.ts's insertLines).

/** The tables a restore keeps, in the order they are kept and put back. */
export const KEPT_TABLES: readonly TableName[] = Object.freeze(['license_state', 'audit_head', 'settings', 'audit_log', 'releases_log', 'backups']);

/** Rows per keyset batch when keeping a table (at least one batch per step). */
const KEEP_BATCH = 1000;
const READ_CHUNK_BYTES = 256 * 1024;

/** Where `preserving` stands (op.params.keep): the table being kept, its last row written and the file's length then. */
export type PreserveCheckpoint = { table: number; after: PkValue[] | null; bytes: number };

export const preserveCheckpointSchema = z.strictObject({
  table: z.number().int().min(0).max(100),
  after: z.array(pkValueSchema).min(1).max(8).nullable(),
  bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}) satisfies z.ZodType<PreserveCheckpoint>;

/** The first checkpoint of `preserving`. */
export function newPreserve(): PreserveCheckpoint {
  return { table: 0, after: null, bytes: 0 };
}

/** Where `restoreKeptStep` stands (op.params.final.keep). */
export type KeptCheckpoint = { table: number; started: boolean; after: PkValue[] | null };

export const keptCheckpointSchema = z.strictObject({
  table: z.number().int().min(0).max(100),
  started: z.boolean(),
  after: z.array(pkValueSchema).min(1).max(8).nullable(),
}) satisfies z.ZodType<KeptCheckpoint>;

function keepPath(dataDir: string, opId: string, table: TableName): DataPath {
  return opKeepPath(dataDir, opId, table, BACKUP_PATH_TABLES);
}

function keepMissing(table: TableName): DomainError {
  return new DomainError('STATE_CORRUPT', {
    detail: `Salinan tabel ${table} yang disimpan hilang / The kept copy of table ${table} is gone`,
    meta: { reason: 'keep_missing' },
  });
}

/** `source` gzip-compressed. */
async function* gzipped(source: AsyncIterable<Uint8Array>): AsyncGenerator<Buffer, void, undefined> {
  const gz = createGzip();
  const feeding = pipeline(Readable.from(source), gz).then(
    () => null,
    (error: unknown) => error,
  );
  for await (const chunk of gz as AsyncIterable<Buffer>) yield chunk;
  const failure = await feeding;
  if (failure !== null) throw failure;
}

/**
 * Appends to `p` the canonical lines of `table` (for `settings`, its `instance` rows) after the key `o.after`, read
 * from `live` in key batches until the table ends or `o.clock() ≥ o.stopAt` (at least one batch), as one gzip member
 * written at `o.bytes` once the file is cut back to that length. Returns whether the table ended, the key of the last
 * row read, and the file's length after the member (synced).
 */
async function appendKept(
  live: DbHandle,
  table: TableName,
  p: DataPath,
  o: { schemaVersion: string; after: PkValue[] | null; bytes: number; stopAt: number; clock: () => number },
): Promise<{ ended: boolean; after: PkValue[] | null; bytes: number }> {
  const info = await statOrNull(p);
  if (o.bytes > 0 && (info === null || info.kind !== 'file' || info.size < o.bytes)) throw keepMissing(table);
  const columns = columnsAt(table, o.schemaVersion);
  const names = columns.map((c) => c.name);
  let after = o.after;
  let ended = false;
  async function* lines(): AsyncGenerator<Buffer, void, undefined> {
    for (let first = true; ; first = false) {
      if (!first && o.clock() >= o.stopAt) return;
      const batch = await readPkBatch(live.db, live.dialect, table, { after, limit: KEEP_BATCH, columns: names });
      let text = '';
      for (const raw of batch) {
        const row = canonicalRow(table, raw, columns);
        after = pkOf(table, row);
        if (table === 'settings' && row['scope'] !== 'instance') continue;
        text += canonicalLine(row);
      }
      if (text !== '') yield Buffer.from(text, 'utf8');
      if (batch.length < KEEP_BATCH) {
        ended = true;
        return;
      }
    }
  }
  const handle: FileHandle = await openReadWrite(p);
  let position = o.bytes;
  try {
    await handle.truncate(o.bytes);
    for await (const chunk of gzipped(lines())) {
      for (let at = 0; at < chunk.byteLength; ) {
        const { bytesWritten } = await handle.write(chunk, at, chunk.byteLength - at, position);
        at += bytesWritten;
        position += bytesWritten;
      }
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { ended, after, bytes: position };
}

/**
 * One step of `preserving` from `cp` (see the top of this file): the kept tables written one after another until
 * `o.stopAt` (at least one batch). Returns the next checkpoint, `done` once every table of {@link KEPT_TABLES} is kept.
 *
 * @throws DomainError DISK_QUOTA (P21; a full disk's ENOSPC/EDQUOT from a write as it is), STATE_CORRUPT
 *   (`keep_missing`) when the file is shorter than the checkpoint says; the database's errors
 */
export async function preserveStep(
  live: DbHandle,
  o: { dataDir: string; opId: string; schemaVersion: string; stopAt: number; clock: () => number; lock: HeldFileLock },
  cp: PreserveCheckpoint,
): Promise<{ done: boolean; checkpoint: PreserveCheckpoint }> {
  const c = structuredClone(cp);
  for (let first = true; first || o.clock() < o.stopAt; first = false) {
    const table = KEPT_TABLES[c.table];
    if (table === undefined) break;
    o.lock.assertHeld();
    const r = await appendKept(live, table, keepPath(o.dataDir, o.opId, table), { ...o, after: c.after, bytes: c.bytes });
    if (r.ended) Object.assign(c, { table: c.table + 1, after: null, bytes: 0 });
    else Object.assign(c, { after: r.after, bytes: r.bytes });
  }
  return { done: c.table >= KEPT_TABLES.length, checkpoint: c };
}

/** The lines of a kept file (gunzipped; our own file, so no bound beyond its line split). */
async function* fileLines(p: DataPath): AsyncGenerator<string, void, undefined> {
  const handle: FileHandle = await openRead(p);
  const gunzip = createGunzip();
  async function* bytes(): AsyncGenerator<Buffer> {
    for (let position = 0; ; ) {
      const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
      if (bytesRead === 0) return;
      position += bytesRead;
      yield buffer.subarray(0, bytesRead);
    }
  }
  const feeding = pipeline(Readable.from(bytes()), gunzip).then(
    () => null,
    (error: unknown) => error,
  );
  try {
    let rest = '';
    for await (const chunk of gunzip as AsyncIterable<Buffer>) {
      const text = rest + chunk.toString('utf8');
      const lines = text.split('\n');
      rest = lines.pop() ?? '';
      for (const line of lines) if (line !== '') yield line;
    }
    if (rest !== '') yield rest;
    const failure = await feeding;
    if (failure !== null) throw failure;
  } finally {
    gunzip.destroy();
    await handle.close();
  }
}

/**
 * One step of `finalizing` step 1 from `cp` (see the top of this file): the kept tables put back one after another
 * until `stopAt` (at least one transaction). Returns the next checkpoint, `done` once every kept table is back.
 *
 * `o.schemaVersion` is the schema the kept files were written at (the target's); `o.finalSchemaVersion` the one the
 * restored database ends at (absent: the code's latest, TABLE_COLUMNS).
 *
 * @throws DomainError STATE_CORRUPT (`keep_missing`) when a kept file is gone; the database's errors
 */
export async function restoreKeptStep(
  work: DbHandle,
  o: {
    dataDir: string;
    opId: string;
    schemaVersion: string;
    finalSchemaVersion?: string;
    txRows: number;
    stopAt: number;
    clock: () => number;
    lock: HeldFileLock;
  },
  cp: KeptCheckpoint,
): Promise<{ done: boolean; checkpoint: KeptCheckpoint }> {
  const c = structuredClone(cp);
  let first = true;
  while (first || o.clock() < o.stopAt) {
    first = false;
    const table = KEPT_TABLES[c.table];
    if (table === undefined) return { done: true, checkpoint: c };
    const p = keepPath(o.dataDir, o.opId, table);
    if ((await statOrNull(p)) === null) throw keepMissing(table);
    const kept = new Set(columnsAt(table, o.schemaVersion).map((col) => col.name));
    const final = o.finalSchemaVersion === undefined ? TABLE_COLUMNS[table] : columnsAt(table, o.finalSchemaVersion);
    const columns = final.map((col) => col.name).filter((name) => kept.has(name));
    o.lock.assertHeld();
    if (table === 'settings') {
      // A few rows, among the loaded `data` rows: deleted and inserted again in one transaction (an upsert, S2).
      const rows: Record<string, unknown>[] = [];
      for await (const line of fileLines(p)) {
        const row = JSON.parse(line) as Record<string, unknown>;
        const cut: Record<string, unknown> = {};
        for (const name of columns) cut[name] = Object.hasOwn(row, name) ? row[name] : null;
        rows.push(cut);
      }
      await withTx(work, async (trx) => {
        const k = trx as unknown as Kysely<Record<string, Record<string, unknown>>>;
        await k.deleteFrom('settings').where('scope', '=', 'instance').execute();
        const keys = rows.map((r) => r['key'] as string);
        if (keys.length > 0) await k.deleteFrom('settings').where('key', 'in', keys).execute();
        for (let i = 0; i < rows.length; i += 200) await k.insertInto('settings').values(rows.slice(i, i + 200)).execute();
      });
      Object.assign(c, { table: c.table + 1, started: false, after: null });
      continue;
    }
    if (!c.started) {
      await (work.db as unknown as Kysely<Record<string, Record<string, unknown>>>).deleteFrom(table).execute();
      Object.assign(c, { started: true, after: null });
    }
    // Rows a killed step committed after its checkpoint (the table holds only kept rows: it was emptied first).
    c.after = await committedAfter(work, table, c.after);
    const r = await insertLines(work, table, fileLines(p), { columns, after: c.after, txRows: o.txRows, stopAt: o.stopAt, clock: o.clock });
    c.after = r.after;
    if (!r.ended) return { done: false, checkpoint: c };
    Object.assign(c, { table: c.table + 1, started: false, after: null });
  }
  return { done: c.table >= KEPT_TABLES.length, checkpoint: c };
}
