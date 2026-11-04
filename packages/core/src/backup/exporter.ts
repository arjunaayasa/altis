import { createHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import {
  DIALECTS,
  TABLE_KEYS,
  columnsAt,
  countRows,
  readKeyedBatch,
  readPkBatch,
  releaseMigrations,
  type ColumnSpec,
  type DB,
  type Dialect,
  type PkValue,
  type TableName,
} from '@altis/db';
import {
  backupPartPath,
  dataPath,
  faultArmed,
  fsyncDir,
  killSelf,
  openRead,
  openReadWrite,
  removeFile,
  statOrNull,
  writeStreamAtomic,
  type DataPath,
} from '@altis/platform';
import { DomainError, isDomainError, isUlid } from '@altis/shared';
import type { Kysely, Transaction } from 'kysely';
import { z } from 'zod';
import { IncrementalSha256, decodeSha256Midstate, encodeSha256Midstate } from '../files/sha256-incremental.js';
import { blobPresent, blobWanted, linkBlob, type BlobSource } from './blobs.js';
import {
  BACKUP_PATH_TABLES,
  backupRowIncluded,
  backupTablesAt,
  canonicalLine,
  canonicalRow,
  checksumLine,
  hasSecretColumns,
  type BackupClass,
} from './canonical.js';
import { catalogBackupTables } from './generic-columns.js';
import {
  BACKUP_FORMAT,
  backupManifestSchema,
  backupPartSchema,
  backupTableNameSchema,
  manifestHmac,
  pkValueSchema,
  readManifest,
  verifyManifestHmac,
  writeManifest,
  type BackupKind,
  type BackupManifest,
  type BackupManifestTable,
  type BackupPart,
} from './manifest.js';

// The resumable backup exporter (spec §9.9, P7, P9; decisions C12, C38; preflight S13, S14). It reads `o.read`,
// which the caller makes consistent: a snapshot transaction (MySQL/MariaDB/PostgreSQL, readSnapshot), a read-only
// handle on a SQLite copy (sqliteSnapshotTo), or the live database while the installation is frozen. It writes
// `backups/<id>/` in four phases, each resumable from the JSON checkpoint `step` returns:
//
// 1. tables: per table in load order, parts of at most 50 000 rows in primary-key order (keyset batches of 1000 rows,
//    readPkBatch; never `.stream()`, L31), one canonical JSON line per row, gzip-streamed through
//    writeStreamAtomic into `tables/<table>/<n, 5 digits>.jsonl.gz` (a hidden temporary sibling, fsynced and renamed:
//    a part file is whole or absent, S14). A part closes early once `deadline − 2 s` is reached, but never empty
//    unless the table is (an empty table has one empty part). After its rename, each part's record (its rows, first
//    and last key, the SHA-256 of the file and its uncompressed size) goes into the part log, and the part into the
//    checkpoint. A process killed in the middle of a part (P7) leaves the checkpoint at the part before: the part is
//    written again (only its hidden temporary file is left behind, removed with the backup's folder);
// 2. checksums: per table, the written parts are read back (gunzip, their SHA-256, size and rows checked against
//    their records) and the checksum lines hashed (decision C12). Node's hash state cannot cross a process, so the
//    table's hash runs on the pure-JS SHA-256 of ruling R1c-4, whose midstate goes into the checkpoint between parts:
//    a large table's checksum is resumable per part, like its export, so no slice outgrows P9;
// 3. blobs (`includeFiles`): each `files` row with status `ok` is linked (or copied) to `backups/blobs/<sha256>`
//    unless present;
// 4. manifest: `manifest.json` with the installation's HMAC, written atomically and last: a backup folder without
//    it is unfinished. The part log is removed after it, on a best-effort basis: one that cannot be removed (a file
//    held open on Windows) stays until the backup's folder is removed, and does not fail the finished backup.
//
// The part log `backups/<id>/parts.jsonl` holds one JSON line per part written, in the order written. The checkpoint
// keeps only the number of parts of each table and the log's length it vouches for (`log`), so its size depends on
// the number of tables, not on the number of parts: it is a job's payload (Task 20), and `jobs.payload` holds at most
// 65 535 bytes on MySQL/MariaDB. A record goes in at byte `log` of the file, which is cut there first: whatever a run
// that died before its checkpoint was stored had added after it is dropped, as its parts are written again. The
// records are fsynced once per step, before the step returns the checkpoint that vouches for them.
//
// Disk errors come out as DomainError `DISK_QUOTA` (P21) after the data-files helpers removed the partial file; the
// caller removes the backup's folder. Test fault `export-mid-part:<n>` (S13): the process is killed once part `<n>`
// (of whichever table reaches part n first in this process) has been written to its temporary file, before the
// rename.
//
// Where the tables and their columns come from (`columns`): the code's column registry by default (decision C11:
// backupTablesAt(schemaVersion), columnsAt the schema version, TABLE_KEYS, readPkBatch), or, for the generic exporter of a
// `schemaHold` `pre_update` backup (1d; spec §9.8 row 3), the database's catalog (`'catalog'`: the tables
// `schema_tables` records, each with its catalog columns and primary key, generic-columns.ts, read with
// readKeyedBatch). The catalog is read at the start of every step; the checkpoint records its fingerprint, so a step
// that finds another catalog than the step before (the schema changed under the export) fails instead of mixing two.
// The manifest then records `columnsFrom: 'catalog'`; otherwise its format is the same.

/** The most rows of one part file (spec §9.9). */
export const PART_MAX_ROWS = 50_000;
/** Rows per keyset batch. */
export const EXPORT_BATCH = 1000;
/** A part closes, and a step ends, this long before the step's deadline (fsync, rename and the checkpoint follow). */
export const PART_CLOSE_MARGIN_MS = 2000;

/** The highest part number a path can carry (`99999.jsonl.gz`). */
const PART_NUMBER_MAX = 99_999;
/** Bytes per read of a part file in the checksum phase. */
const READ_CHUNK_BYTES = 256 * 1024;
const LINE_FEED = 0x0a;
/** The most bytes of the part log: as many as a manifest may have (it lists the same parts). */
const PART_LOG_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Where an export stands (JSON: it crosses slices, processes and job payloads unchanged). Its size is bounded by the
 * number of backup tables, whatever the number of parts.
 *
 * - `table`: the index in the step's tables (backupTablesAt(schemaVersion), or the catalog's) of the table the
 *   `tables`/`checksums` phase is at;
 * - `part`: the next part number to write (`tables`) or to hash (`checksums`), from 1;
 * - `after`: the key of the last row read (`tables`: of the table at `table`; `blobs`: of the last `files` row done);
 * - `written`: per table, the number of parts written so far (renamed into place; parts 1 to that number), whose
 *   records are in the part log;
 * - `log`: the length in bytes of the part log (`backups/<id>/parts.jsonl`) that holds the records of those parts;
 * - `checksums`: per table, its checksum once every part was hashed;
 * - `blob`: the number of `files` rows the `blobs` phase has gone through;
 * - `startedAt` (additive): when the export began, the manifest's `createdAt`;
 * - `hash` (additive): the midstate of the checksum of the table at `table`, over its parts before `part` (null at
 *   part 1);
 * - `catalog` (additive, 1d): a catalog export's fingerprint of the tables, columns and keys it exports (SHA-256 hex);
 *   absent from a registry export's;
 * - `tableRows` (additive, 1d T11-EXPORT-PROGRESS-GRANULARITY): the rows the table at `table` held when its export
 *   began (counted at its first part), so that the progress moves inside a table; absent between tables and in a
 *   checkpoint an earlier exporter wrote (the progress then counts that table from 0).
 */
export type ExportCheckpoint = {
  phase: 'tables' | 'checksums' | 'blobs' | 'manifest' | 'done';
  table: number;
  part: number;
  after: PkValue[] | null;
  written: Record<string, number>;
  log: number;
  checksums: Record<string, string>;
  blob: number;
  startedAt?: number;
  hash?: string | null;
  catalog?: string;
  tableRows?: number;
};

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** The shape of an {@link ExportCheckpoint} (for a job payload's schema; `step` checks it too). */
export const exportCheckpointSchema = z.strictObject({
  phase: z.enum(['tables', 'checksums', 'blobs', 'manifest', 'done']),
  table: z.number().int().min(0).max(1000),
  part: z.number().int().min(1).max(PART_NUMBER_MAX + 1),
  after: z.array(pkValueSchema).min(1).max(8).nullable(),
  written: z.record(backupTableNameSchema, z.number().int().min(1).max(PART_NUMBER_MAX)),
  log: z.number().int().min(0).max(PART_LOG_MAX_BYTES),
  checksums: z.record(backupTableNameSchema, z.string().regex(/^[0-9a-f]{64}$/)),
  blob: count,
  startedAt: count.optional(),
  hash: z.string().max(1024).nullable().optional(),
  catalog: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  tableRows: count.optional(),
}) satisfies z.ZodType<ExportCheckpoint>;

/** One line of the part log: a part of a table, as the manifest lists it. */
const partLogRecordSchema = z.strictObject({ table: backupTableNameSchema, ...backupPartSchema.shape });

export interface ExporterOptions {
  /** The database to read: a snapshot transaction, a SQLite copy's handle, or the frozen live database. */
  read: Kysely<DB> | Transaction<DB>;
  dialect: Dialect;
  dataDir: string;
  /** ULID: `backups/<backupId>/`. */
  backupId: string;
  kind: BackupKind;
  includeFiles: boolean;
  consistency: 'snapshot' | 'frozen';
  appVersion: string;
  /** The last migration's name: the columns of each table are the ones that existed then (columnsAt). */
  schemaVersion: string;
  installId: string;
  /** The installation's session key (32 bytes): the manifest HMAC's key material (decision C13). */
  sessionKey: Uint8Array;
  /** The keyring's key ids. */
  kids: string[];
  /**
   * The audit chain head the manifest records; `audit_log` is exported up to it (entries after it, which a frozen
   * backup's normal maintenance lets sign-ins append, are left out), so the archive's chain ends at the head.
   */
  auditHead: { seq: number; hash: string };
  clock: () => number;
  /**
   * Where the tables and their columns come from: `'registry'` (default) the code's column registry at
   * `schemaVersion` (decision C11); `'catalog'` the database's own catalog (the generic exporter of a `schemaHold`
   * `pre_update` backup, spec §9.8 row 3): every table `schema_tables` records with a backup class, each with the
   * columns and primary key the catalog describes, so a table or column the registry does not know is backed up too.
   */
  columns?: 'registry' | 'catalog';
}

export interface ExportStepResult {
  checkpoint: ExportCheckpoint;
  done: boolean;
  /** 0 to 100. */
  progress: number;
}

export interface Exporter {
  /**
   * Goes on from `cp` (null: from the start) until the export is done or `deadline − 2 s` is reached, and always
   * does at least one unit of work (a part, a part's checksum, a blob, the manifest), so steps with tight deadlines
   * still get it done. Idempotent per checkpoint: a step run again from the same checkpoint (its process died, P7)
   * writes the same files again.
   *
   * @throws TypeError for a malformed checkpoint; DomainError `DISK_QUOTA` (P21), `BACKUP_INVALID` (`reason:
   *   'checksum'`) for a part that no longer matches what was written or a part log (`parts.jsonl`) that no longer
   *   holds what the checkpoint vouches for; the database's errors as they are
   */
  step(cp: ExportCheckpoint | null, o: { deadline: number }): Promise<ExportStepResult>;
}

/** `source` gzip-compressed. Errors of either side come out of the iteration; ending it early stops both. */
async function* gzipped(source: AsyncIterable<Uint8Array>): AsyncGenerator<Buffer> {
  const gz = createGzip();
  // The feeding side's outcome is awaited after the output ended; a failure meanwhile also destroys `gz`, which ends
  // the loop below with that error. Caught here so that an early end of the consumer leaves no unhandled rejection.
  const feeding = pipeline(Readable.from(source), gz).then(
    () => null,
    (error: unknown) => error,
  );
  for await (const chunk of gz as AsyncIterable<Buffer>) yield chunk;
  const failure = await feeding;
  if (failure !== null) throw failure;
}

/** `source` gunzipped (as {@link gzipped}). */
async function* gunzipped(source: AsyncIterable<Uint8Array>): AsyncGenerator<Buffer> {
  const gunzip = createGunzip();
  const feeding = pipeline(Readable.from(source), gunzip).then(
    () => null,
    (error: unknown) => error,
  );
  for await (const chunk of gunzip as AsyncIterable<Buffer>) yield chunk;
  const failure = await feeding;
  if (failure !== null) throw failure;
}

/** The bytes of an open file from its start, `hash` updated with each chunk. */
async function* fileBytes(handle: FileHandle, hash: { update(data: Uint8Array): unknown }): AsyncGenerator<Buffer> {
  for (;;) {
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
    if (bytesRead === 0) return;
    const chunk = buffer.subarray(0, bytesRead);
    hash.update(chunk);
    yield chunk;
  }
}

/**
 * The most rows of one part: {@link PART_MAX_ROWS}, or in a test build `ALTIS_TEST_EXPORT_PART_ROWS=<rows>` (fewer;
 * a dead branch in production builds, R57), so that a test makes thousands of parts out of a small table.
 */
function partMaxRows(): number {
  if (typeof __BUILD_PROFILE__ !== 'undefined' && __BUILD_PROFILE__ === 'test') {
    const value = Number(process.env['ALTIS_TEST_EXPORT_PART_ROWS']);
    if (Number.isInteger(value) && value > 0 && value < PART_MAX_ROWS) return value;
  }
  return PART_MAX_ROWS;
}

/** Test fault `export-mid-part:<n>` (S13). The condition stays inline so that a production build drops the block. */
function faultAfterPartWritten(part: number): void {
  if (typeof __BUILD_PROFILE__ !== 'undefined' && __BUILD_PROFILE__ === 'test') {
    if (faultArmed(process.env, 'export-mid-part') === String(part)) killSelf();
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { code } = error as { code?: unknown };
  return typeof code === 'string' ? code : undefined;
}

function partMismatch(table: string, n: number, what: string): DomainError {
  return new DomainError('BACKUP_INVALID', {
    detail:
      `Bagian ${n} tabel ${table} tidak cocok dengan yang ditulis (${what}) / ` +
      `Part ${n} of table ${table} does not match what was written (${what})`,
    meta: { reason: 'checksum', table, part: n },
  });
}

/** The part log is gone, shorter than the checkpoint says, or does not list the parts the checkpoint counts. */
function partLogMismatch(what: string): DomainError {
  return new DomainError('BACKUP_INVALID', {
    detail:
      `Catatan bagian cadangan (parts.jsonl) tidak cocok dengan titik lanjut (${what}) / ` +
      `The backup's part log (parts.jsonl) does not match the checkpoint (${what})`,
    meta: { reason: 'checksum' },
  });
}

/** `DISK_QUOTA` (P21) for a full disk or an exhausted quota, null for any other error. */
function diskQuota(error: unknown): DomainError | null {
  if (isDomainError(error)) return error.code === 'DISK_QUOTA' ? error : null;
  const code = errorCode(error);
  if (code !== 'ENOSPC' && code !== 'EDQUOT') return null;
  return new DomainError('DISK_QUOTA', {
    detail:
      `Ruang disk atau kuota hosting habis saat menulis catatan bagian cadangan (${code}) / ` +
      `The disk is full or the hosting quota is used up while writing the backup's part log (${code})`,
    meta: { code },
    cause: error,
  });
}

/** Writes all of `data` at `position` of `handle`. */
async function writeAt(handle: FileHandle, data: Uint8Array, position: number): Promise<void> {
  for (let done = 0; done < data.byteLength; ) {
    const { bytesWritten } = await handle.write(data, done, data.byteLength - done, position + done);
    if (!(bytesWritten > 0)) throw new Error('part log write made no progress');
    done += bytesWritten;
  }
}

/** One table of an export: its name, class, columns (in canonical-row order) and primary key's columns. */
interface ExportTable {
  /** A registry table's name, or (catalog export) any table `schema_tables` records. */
  table: string;
  cls: BackupClass;
  columns: readonly ColumnSpec[];
  pk: readonly string[];
}

/** The tables an export holds, in load order, and how it reads them. */
interface ExportLayout {
  tables: readonly ExportTable[];
  /** The table names the part paths accept (backupPartPath's `tables`): the registry's, or the catalog's (M1). */
  pathTables: ReadonlySet<string>;
  /** The next keyset batch of `t` after `after`, with `t.columns`. */
  read(t: ExportTable, after: PkValue[] | null, limit: number): Promise<Record<string, unknown>[]>;
  /** How many rows `t` holds now (T11: the progress inside a table). */
  count(t: ExportTable): Promise<number>;
  /** A catalog layout's fingerprint (SHA-256 hex of its tables, columns and keys); null for the registry's. */
  fingerprint: string | null;
}

/**
 * A table name as the canonical helpers type it. They use it for messages and for their per-name rules (the
 * `settings` scope, the secret columns), which a table the registry does not know never matches.
 */
function asTableName(table: string): TableName {
  return table as TableName;
}

/** The primary key values of the canonical row `row` of `t`, in key order. */
function keyOf(t: ExportTable, row: Record<string, unknown>): PkValue[] {
  return t.pk.map((name) => {
    const value = row[name];
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new TypeError(`createExporter(): the key column ${t.table}.${name} holds ${value === null ? 'null' : typeof value}`);
    }
    return value;
  });
}

/**
 * The exporter of one backup (see the module comment). Nothing is read or written until the first `step`.
 *
 * @throws TypeError for a `backupId` that is not a ULID, an unknown dialect, a `schemaVersion` that is not a
 *   migration name (a registry export: one of this code's), a session key shorter than 16 bytes, a `clock` that is not a function, or a `columns` that is
 *   neither `'registry'` nor `'catalog'`
 */
export function createExporter(o: ExporterOptions): Exporter {
  if (typeof o.backupId !== 'string' || !isUlid(o.backupId)) throw new TypeError('createExporter(): backupId must be a ULID');
  if (!(DIALECTS as readonly unknown[]).includes(o.dialect)) throw new TypeError(`createExporter(): unknown dialect ${String(o.dialect)}`);
  if (!(o.sessionKey instanceof Uint8Array) || o.sessionKey.byteLength < 16) {
    throw new TypeError('createExporter(): the session key must be at least 16 bytes');
  }
  if (typeof o.clock !== 'function') throw new TypeError('createExporter(): clock must be a function');
  const columnsFrom = o.columns ?? 'registry';
  if (columnsFrom !== 'registry' && columnsFrom !== 'catalog') {
    throw new TypeError(`createExporter(): columns must be 'registry' or 'catalog', got ${JSON.stringify(o.columns)}`);
  }
  let registry: ExportLayout | null = null;
  if (columnsFrom === 'registry') {
    // The tables and columns are this code's: the manifest names one of its migrations, which restore resolves
    // (migrationsUpTo), never a bare number or a later release's migration (phase-end review C12; schemaVersionOf).
    if (!Object.keys(releaseMigrations(3)).includes(o.schemaVersion)) {
      throw new TypeError(`createExporter(): schemaVersion must name a migration of this code, got ${JSON.stringify(o.schemaVersion)}`);
    }
    // The tables of the backup's schema version (a registry table its database does not have yet is left out).
    const tables = backupTablesAt(o.schemaVersion).map(({ table, cls }) => ({ table, cls, columns: columnsAt(table, o.schemaVersion), pk: TABLE_KEYS[table].pk }));
    registry = {
      tables,
      pathTables: BACKUP_PATH_TABLES,
      read: (t, after, limit) => readPkBatch(o.read, o.dialect, asTableName(t.table), { after, limit, columns: t.columns.map((c) => c.name) }),
      count: (t) => countTable(t.table),
      fingerprint: null,
    };
  } else if (!backupManifestSchema.shape.schemaVersion.safeParse(o.schemaVersion).success) {
    throw new TypeError(`createExporter(): schemaVersion must be a migration name or a schema version, got ${JSON.stringify(o.schemaVersion)}`);
  }

  /**
   * The rows of `table` now (T11). A catalog table the registry does not know is named through the same typed builder:
   * Kysely quotes the identifier, and the catalog reader only lists names that are plain identifiers.
   */
  function countTable(table: string): Promise<number> {
    return countRows(o.read.selectFrom(asTableName(table)));
  }

  /** The database's catalog as the export reads it (read again at every step: a step may run in another process). */
  async function catalogLayout(): Promise<ExportLayout> {
    const tables = await catalogBackupTables(o.read, o.dialect);
    const described = tables.map((t) => [t.table, t.cls, t.pk, t.columns.map((c) => [c.name, c.kind, c.length ?? null, c.nullable])]);
    return {
      tables,
      pathTables: new Set(tables.map((t) => t.table)),
      read: (t, after, limit) => readKeyedBatch(o.read, o.dialect, t.table, { columns: t.columns, pk: t.pk }, { after, limit }),
      count: (t) => countTable(t.table),
      fingerprint: createHash('sha256').update(JSON.stringify(described)).digest('hex'),
    };
  }

  /** The layout of the step running now: set at its start (the steps of one exporter run one after another). */
  let layout: ExportLayout | null = registry;
  const current = (): ExportLayout => {
    if (layout === null) throw new TypeError('createExporter(): no step is running');
    return layout;
  };
  const partPath = (table: string, n: number): DataPath => backupPartPath(o.dataDir, o.backupId, table, n, current().pathTables);
  const partRows = partMaxRows();
  const partLogPath = (): DataPath => dataPath(o.dataDir, 'backups', o.backupId, 'parts.jsonl');

  /**
   * The part log, opened by the step's first record and closed by {@link closePartLog} when the step ends. Only the
   * checkpoint a step returns is ever stored, so the records need to be on disk by then, not one by one: one fsync per
   * step, not per part.
   */
  let logHandle: FileHandle | null = null;

  /**
   * Puts the record of `part` of `table` at byte `at` of the part log, cut there first (nothing a dead run left after
   * `at` stays). Returns the log's new length.
   *
   * @throws DomainError `DISK_QUOTA` (P21); `BACKUP_INVALID` when the log is shorter than `at` (records were lost)
   */
  async function logPart(at: number, table: string, part: BackupPart): Promise<number> {
    const line = Buffer.from(`${JSON.stringify({ table, ...part })}\n`, 'utf8');
    if (at + line.byteLength > PART_LOG_MAX_BYTES) {
      throw new TypeError(`createExporter().step(): the part log would pass ${PART_LOG_MAX_BYTES} bytes`);
    }
    try {
      if (logHandle === null) {
        logHandle = await openReadWrite(partLogPath());
        if ((await logHandle.stat()).size < at) throw partLogMismatch('short');
      }
      await logHandle.truncate(at);
      await writeAt(logHandle, line, at);
    } catch (error) {
      throw diskQuota(error) ?? error;
    }
    return at + line.byteLength;
  }

  /**
   * Ends the step's writes to the part log: fsyncs it and the backup's folder (the log may be new) and closes it, or,
   * after a failed step (`ok` false), only closes it. Nothing happens when the step wrote no record.
   *
   * @throws DomainError `DISK_QUOTA` (P21)
   */
  async function closePartLog(ok: boolean): Promise<void> {
    const handle = logHandle;
    logHandle = null;
    if (handle === null) return;
    if (!ok) {
      await handle.close().catch(() => undefined);
      return;
    }
    try {
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw diskQuota(error) ?? error;
    }
    try {
      await handle.close(); // NFS reports a quota overrun here at the latest
    } catch (error) {
      throw diskQuota(error) ?? error;
    }
    await fsyncDir(dataPath(o.dataDir, 'backups', o.backupId));
  }

  /**
   * The parts recorded in the first `length` bytes of the part log, per table in the order written; null when the
   * log does not exist.
   *
   * @throws DomainError `BACKUP_INVALID` for a log shorter than `length` or a line that is not a part's record
   */
  async function readPartLog(length: number): Promise<Map<string, BackupPart[]> | null> {
    let handle: FileHandle;
    try {
      handle = await openRead(partLogPath());
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return null;
      throw error;
    }
    const bytes = Buffer.allocUnsafe(length);
    try {
      for (let done = 0; done < length; ) {
        const { bytesRead } = await handle.read(bytes, done, length - done, done);
        if (bytesRead === 0) throw partLogMismatch('short');
        done += bytesRead;
      }
    } finally {
      await handle.close();
    }
    const parts = new Map<string, BackupPart[]>();
    for (let start = 0; start < length; ) {
      const end = bytes.indexOf(LINE_FEED, start);
      if (end === -1) throw partLogMismatch('last line');
      let record: z.infer<typeof partLogRecordSchema>;
      try {
        record = partLogRecordSchema.parse(JSON.parse(bytes.toString('utf8', start, end)));
      } catch {
        throw partLogMismatch('record');
      }
      const { table, ...part } = record;
      const list = parts.get(table);
      if (list === undefined) parts.set(table, [part]);
      else list.push(part);
      start = end + 1;
    }
    return parts;
  }

  /** The part log as this step read it, once: it is only read after the `tables` phase, which alone writes it. */
  let partLog: Promise<Map<string, BackupPart[]> | null> | null = null;

  /**
   * The parts of `table`, 1 to `c.written[table]`, from the part log.
   *
   * @throws TypeError when the checkpoint counts no parts of `table`; DomainError `BACKUP_INVALID` when the log is
   *   gone or does not list exactly those parts
   */
  async function partsOf(c: ExportCheckpoint, table: string): Promise<BackupPart[]> {
    const written = c.written[table];
    if (written === undefined) throw new TypeError(`createExporter().step(): the checkpoint counts no parts of ${table}`);
    partLog ??= readPartLog(c.log);
    const log = await partLog;
    if (log === null) throw partLogMismatch('missing');
    const parts = log.get(table) ?? [];
    if (parts.length !== written || parts.some((p, i) => p.n !== i + 1)) throw partLogMismatch(table);
    return parts;
  }

  /** An audit entry appended after the manifest's head (a sign-in while a frozen backup runs): not in the backup. */
  function pastAuditHead(table: string, row: Record<string, unknown>): boolean {
    return table === 'audit_log' && Number(row['seq']) > o.auditHead.seq;
  }

  /** The rows of `t` after `after`: canonical, the ones the backup holds, and the key of the last row read. */
  async function readRows(
    t: ExportTable,
    after: PkValue[] | null,
    limit: number,
  ): Promise<{ rows: Record<string, unknown>[]; after: PkValue[] | null; ended: boolean }> {
    const batch = await current().read(t, after, limit);
    const rows: Record<string, unknown>[] = [];
    let last = after;
    for (const raw of batch) {
      const row = canonicalRow(asTableName(t.table), raw, t.columns);
      last = keyOf(t, row);
      if (backupRowIncluded(asTableName(t.table), row) && !pastAuditHead(t.table, row)) rows.push(row);
    }
    return { rows, after: last, ended: batch.length < limit };
  }

  /** The table at `c.table` is complete with `last` parts: drops stale later parts of an earlier run, moves on. */
  async function finishTable(c: ExportCheckpoint, table: string, last: number): Promise<void> {
    // A run that died after renaming parts it never recorded may have left more parts than this one wrote.
    for (let n = last + 1; n <= PART_NUMBER_MAX; n += 1) {
      const p = partPath(table, n);
      if ((await statOrNull(p)) === null) break;
      await removeFile(p);
    }
    c.table += 1;
    c.part = 1;
    c.after = null;
    delete c.tableRows;
  }

  /** Writes the next part of the table at `c.table` (or finds the table complete). */
  async function tableUnit(c: ExportCheckpoint, closeAt: number): Promise<void> {
    const found = current().tables[c.table];
    if (found === undefined) {
      Object.assign(c, { phase: 'checksums', table: 0, part: 1, after: null, hash: null });
      delete c.tableRows;
      return;
    }
    const entry: ExportTable = found;
    const { table } = entry;
    const n = c.part;
    // T11: the rows the table holds as its export begins (its first part, run again from the start after a kill).
    if (n === 1 && c.after === null) c.tableRows = await current().count(entry);
    if (n > PART_NUMBER_MAX) throw new TypeError(`createExporter().step(): ${table} needs more than ${PART_NUMBER_MAX} parts`);
    // The part's first rows, read before its file is opened: a part is never empty unless the table is.
    const firstBatch = Math.min(EXPORT_BATCH, partRows);
    let next = await readRows(entry, c.after, firstBatch);
    while (next.rows.length === 0 && !next.ended) next = await readRows(entry, next.after, firstBatch);
    if (next.rows.length === 0 && n > 1) {
      await finishTable(c, table, n - 1);
      return;
    }

    const state = { rows: 0, bytes: 0, firstPk: null as PkValue[] | null, lastPk: null as PkValue[] | null, after: next.after, ended: next.ended };
    async function* lines(): AsyncGenerator<Buffer> {
      let rows = next.rows;
      for (;;) {
        if (rows.length > 0) {
          let text = '';
          for (const row of rows) text += canonicalLine(row);
          state.firstPk ??= keyOf(entry, rows[0] as Record<string, unknown>);
          state.lastPk = keyOf(entry, rows[rows.length - 1] as Record<string, unknown>);
          state.rows += rows.length;
          const bytes = Buffer.from(text, 'utf8');
          state.bytes += bytes.byteLength;
          yield bytes;
        }
        if (state.ended || state.rows >= partRows || o.clock() >= closeAt) return;
        const batch = await readRows(entry, state.after, Math.min(EXPORT_BATCH, partRows - state.rows));
        rows = batch.rows;
        state.after = batch.after;
        state.ended = batch.ended;
      }
    }
    const fileHash = createHash('sha256');
    async function* file(): AsyncGenerator<Uint8Array> {
      for await (const chunk of gzipped(lines())) {
        fileHash.update(chunk);
        yield chunk;
      }
      // Every chunk is in the temporary file now (each is written before the next is asked for); the rename follows.
      faultAfterPartWritten(n);
    }
    await writeStreamAtomic(partPath(table, n), file());

    const part: BackupPart = {
      n,
      rows: state.rows,
      firstPk: state.firstPk,
      lastPk: state.lastPk,
      sha256: fileHash.digest('hex'),
      bytes: state.bytes,
    };
    c.log = await logPart(c.log, table, part);
    c.written[table] = n;
    if (state.ended) {
      await finishTable(c, table, n);
    } else {
      c.part = n + 1;
      c.after = state.after;
    }
  }

  /** Feeds part `part` of `table` to `hash` (its checksum lines), checking the file against the checkpoint. */
  async function hashPart(table: string, part: BackupPart, hash: IncrementalSha256): Promise<void> {
    let handle: FileHandle;
    try {
      handle = await openRead(partPath(table, part.n));
    } catch (error) {
      if (errorCode(error) === 'ENOENT') throw partMismatch(table, part.n, 'missing');
      throw error;
    }
    const fileHash = createHash('sha256');
    const parse = hasSecretColumns(asTableName(table));
    let bytes = 0;
    let rows = 0;
    let rest: Buffer = Buffer.alloc(0);
    try {
      for await (const chunk of gunzipped(fileBytes(handle, fileHash))) {
        bytes += chunk.byteLength;
        if (!parse) {
          // The part's lines are canonical lines, which are the checksum lines of a table without secret columns.
          hash.update(chunk);
          for (let i = chunk.indexOf(LINE_FEED); i !== -1; i = chunk.indexOf(LINE_FEED, i + 1)) rows += 1;
          continue;
        }
        const data = rest.byteLength === 0 ? chunk : Buffer.concat([rest, chunk]);
        let start = 0;
        for (let end = data.indexOf(LINE_FEED); end !== -1; end = data.indexOf(LINE_FEED, start)) {
          const row = JSON.parse(data.toString('utf8', start, end)) as Record<string, unknown>;
          hash.update(Buffer.from(checksumLine(asTableName(table), row), 'utf8'));
          rows += 1;
          start = end + 1;
        }
        rest = data.subarray(start);
      }
    } catch (error) {
      if (error instanceof SyntaxError || errorCode(error)?.startsWith('Z_') === true) {
        throw partMismatch(table, part.n, 'gzip/JSON');
      }
      throw error;
    } finally {
      await handle.close();
    }
    if (rest.byteLength !== 0) throw partMismatch(table, part.n, 'last line');
    if (fileHash.digest('hex') !== part.sha256) throw partMismatch(table, part.n, 'sha256');
    if (bytes !== part.bytes) throw partMismatch(table, part.n, 'bytes');
    if (rows !== part.rows) throw partMismatch(table, part.n, 'rows');
  }

  /** Hashes the parts of the table at `c.table` from part `c.part` on, until its checksum is done or `closeAt`. */
  async function checksumUnit(c: ExportCheckpoint, closeAt: number): Promise<void> {
    const entry = current().tables[c.table];
    if (entry === undefined) {
      Object.assign(c, { phase: o.includeFiles ? 'blobs' : 'manifest', table: 0, part: 1, after: null, hash: null, blob: 0 });
      return;
    }
    const { table } = entry;
    const parts = await partsOf(c, table);
    if (c.part > parts.length) throw new TypeError(`createExporter().step(): ${table} has no part ${c.part} to hash`);
    let hash: IncrementalSha256;
    if (c.part === 1) {
      hash = new IncrementalSha256();
    } else {
      const midstate = typeof c.hash === 'string' ? decodeSha256Midstate(c.hash) : null;
      if (midstate === null) throw new TypeError(`createExporter().step(): the checkpoint's hash of ${table} is missing or malformed`);
      hash = IncrementalSha256.fromMidstate(midstate);
    }
    let n = c.part;
    do {
      await hashPart(table, parts[n - 1] as BackupPart, hash);
      n += 1;
    } while (n <= parts.length && o.clock() < closeAt);
    if (n > parts.length) {
      c.checksums[table] = hash.digestHex();
      Object.assign(c, { table: c.table + 1, part: 1, hash: null });
    } else {
      Object.assign(c, { part: n, hash: encodeSha256Midstate(hash.midstate()) });
    }
  }

  /** The `files` rows after `after`, as blob sources. */
  async function fileRows(after: PkValue[] | null): Promise<{ rows: BlobSource[]; ended: boolean }> {
    const batch = await readPkBatch(o.read, o.dialect, 'files', { after, limit: EXPORT_BATCH, columns: ['id', 'size', 'sha256', 'status'] });
    const rows = batch.map((r) => ({ id: String(r['id']), size: Number(r['size']), sha256: String(r['sha256']), status: String(r['status']) }));
    return { rows, ended: batch.length < EXPORT_BATCH };
  }

  /** Links the blobs of one batch of `files` rows, pausing between files once `closeAt` is reached. */
  async function blobUnit(c: ExportCheckpoint, closeAt: number): Promise<void> {
    const { rows, ended } = await fileRows(c.after);
    let first = true;
    for (const row of rows) {
      if (!first && o.clock() >= closeAt) return;
      first = false;
      await linkBlob(o.dataDir, row);
      c.after = [row.id];
      c.blob += 1;
    }
    if (ended) Object.assign(c, { phase: 'manifest', after: null });
  }

  /** The blobs in place for the `files` rows, by SHA-256 (sorted). */
  async function collectBlobs(): Promise<{ sha256: string; size: number }[]> {
    const found = new Map<string, number>();
    let after: PkValue[] | null = null;
    for (;;) {
      const { rows, ended } = await fileRows(after);
      for (const row of rows) {
        if (blobWanted(row) && !found.has(row.sha256) && (await blobPresent(o.dataDir, row))) found.set(row.sha256, row.size);
        after = [row.id];
      }
      if (ended) break;
    }
    return [...found.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([sha256, size]) => ({ sha256, size }));
  }

  async function manifestUnit(c: ExportCheckpoint): Promise<void> {
    partLog ??= readPartLog(c.log);
    if ((await partLog) === null) {
      // The part log goes once the manifest is in place: a step that died after removing it finds the manifest.
      const m = await readManifest(o.dataDir, o.backupId);
      if (m === null || !verifyManifestHmac(o.sessionKey, m)) throw partLogMismatch('missing');
      Object.assign(c, { phase: 'done', table: 0, part: 1, after: null, hash: null });
      return;
    }
    const section: Record<string, BackupManifestTable> = {};
    for (const { table, cls, columns } of current().tables) {
      const checksum = c.checksums[table];
      if (checksum === undefined) throw new TypeError(`createExporter().step(): the checkpoint has no checksum of ${table}`);
      const parts = await partsOf(c, table);
      section[table] = {
        class: cls,
        columns: columns.map((col) => col.name),
        rows: parts.reduce((sum, p) => sum + p.rows, 0),
        checksum,
        parts,
      };
    }
    const base: Omit<BackupManifest, 'hmac'> = {
      format: BACKUP_FORMAT,
      backupId: o.backupId,
      kind: o.kind,
      appVersion: o.appVersion,
      schemaVersion: o.schemaVersion,
      dialect: o.dialect,
      createdAt: c.startedAt ?? o.clock(),
      consistency: o.consistency,
      kids: [...o.kids],
      installId: o.installId,
      auditHead: { seq: o.auditHead.seq, hash: o.auditHead.hash },
      includesFiles: o.includeFiles,
      secrets: 'keyring',
      // A registry export leaves the field out (its default), so its manifest is the one 1c wrote.
      ...(columnsFrom === 'catalog' ? { columnsFrom } : {}),
      tables: section,
      blobs: o.includeFiles ? await collectBlobs() : [],
    };
    await writeManifest(o.dataDir, { ...base, hmac: manifestHmac(o.sessionKey, base) });
    // Best effort: the backup is complete once its manifest is in place. A log that cannot be removed now (on Windows,
    // a scanner holding it open longer than removeFile's retries) must not fail it; it goes with the backup's folder.
    await removeFile(partLogPath()).catch(() => undefined);
    Object.assign(c, { phase: 'done', table: 0, part: 1, after: null, hash: null });
  }

  /**
   * T11: how far the table at `c.table` is, 0 to 1: the rows of its parts written so far (every part but the last one
   * of a table holds `partRows` rows unless a deadline closed it early, so this is an estimate) out of `tableRows`.
   */
  function withinTable(c: ExportCheckpoint): number {
    if (c.tableRows === undefined) return 0;
    return Math.min(1, ((c.part - 1) * partRows) / Math.max(1, c.tableRows));
  }

  function progressOf(c: ExportCheckpoint): number {
    const share = (done: number): number => Math.min(1, done / Math.max(1, current().tables.length));
    switch (c.phase) {
      case 'tables':
        // (tables done + rows done / tableRows) / tables, of the phase's 80 %.
        return Math.floor(80 * share(c.table + withinTable(c)));
      case 'checksums':
        return 80 + Math.floor(15 * share(c.table));
      case 'blobs':
        return 95;
      case 'manifest':
        return 99;
      case 'done':
        return 100;
    }
  }

  return {
    async step(cp, s) {
      if (typeof s?.deadline !== 'number' || !Number.isFinite(s.deadline)) {
        throw new TypeError('createExporter().step(): deadline must be a finite epoch-ms number');
      }
      partLog = null;
      let c: ExportCheckpoint;
      if (cp === null) {
        c = { phase: 'tables', table: 0, part: 1, after: null, written: {}, log: 0, checksums: {}, blob: 0, startedAt: o.clock(), hash: null };
      } else {
        const parsed = exportCheckpointSchema.safeParse(cp);
        if (!parsed.success) throw new TypeError('createExporter().step(): the checkpoint is malformed');
        c = structuredClone(parsed.data);
      }
      if (registry === null) {
        layout = null;
        const catalog = await catalogLayout();
        if (cp === null) {
          c.catalog = catalog.fingerprint as string;
        } else if (c.catalog !== catalog.fingerprint) {
          throw new DomainError('BACKUP_INVALID', {
            detail:
              'Skema basis data berubah selama ekspor cadangan; mulai ulang cadangan / ' +
              'The database schema changed during the backup export; start the backup again',
            meta: { reason: 'schema' },
          });
        }
        layout = catalog;
      } else if (c.catalog !== undefined) {
        throw new TypeError('createExporter().step(): the checkpoint is a catalog export’s, this exporter reads the registry');
      }
      const closeAt = s.deadline - PART_CLOSE_MARGIN_MS;
      let first = true;
      try {
        while (c.phase !== 'done' && (first || o.clock() < closeAt)) {
          first = false;
          switch (c.phase) {
            case 'tables':
              await tableUnit(c, closeAt);
              // The log is complete once the phase is over: on disk and closed before anything reads it.
              if (c.phase !== 'tables') await closePartLog(true);
              break;
            case 'checksums':
              await checksumUnit(c, closeAt);
              break;
            case 'blobs':
              await blobUnit(c, closeAt);
              break;
            case 'manifest':
              await manifestUnit(c);
              break;
          }
        }
      } catch (error) {
        await closePartLog(false);
        throw error;
      }
      await closePartLog(true);
      return { checkpoint: c, done: c.phase === 'done', progress: progressOf(c) };
    },
  };
}
