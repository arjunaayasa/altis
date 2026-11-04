import type { FileHandle } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import {
  dataDirOf,
  ensureHeadroom as probeHeadroom,
  fsyncDir,
  listNames,
  openAppend,
  openRead,
  readBytes,
  removeFile,
  runWorkFileIn,
  statOrNull,
  truncateFile,
  type DataPath,
} from '@altis/platform';
import { DomainError, isDomainError } from '@altis/shared';
import { SLIMS9_MARKER_TABLES, SLIMS_COLUMNS } from './detect.js';
import { encodeStagedRow } from './dump-source.js';
import { DumpParseError, createSqlDumpParser, type DumpEvent } from './sql-dump.js';
import type { SlimsTableInfo, SplitCheckpoint } from './types.js';

// The first pass over a SQL dump (spec §11.1, S10): the dump (gunzipped when `gz`) is read as a stream and every row
// of a table the migration reads is appended to `<table>.ndjson` in the run's work folder (dump-source.ts reads them
// back); the rows of every other table are only counted (§11.6 needs `sumber` for them too, and personal data of
// Phase 3 tables never reaches the disk). A table list (`split_tables.ndjson`: each CREATE TABLE's columns and primary
// key, phpMyAdmin's ALTER TABLE ... ADD PRIMARY KEY) lets a later slice name the rows of an INSERT without a column
// list. A table the dump never creates (a data-only dump: `mysqldump --no-create-info`, phpMyAdmin's "Data" export)
// is listed with the columns its INSERTs name, in first-seen order (L12: the version detection and the `cf_*` columns
// read them); those name no positions, so its INSERTs without a column list stay refused (`columns_unknown`). Such a
// dump shows no table without rows (mysqldump writes only its locks, which are ignored), so when the whole dump held
// no CREATE TABLE but named `biblio`, the finished list also holds every table the migration reads that the dump never
// named, empty (no columns, 0 rows), except the SLiMS 9 markers: the version still rests on what the dump shows
// (biblio.content_type_id among its INSERTs' columns, a marker's rows), and a library's empty tables do not refuse it.
//
// Slices (C38): a slice stops at the first statement end after its budget, so the staging files hold exactly the
// statements before `checkpoint.offset`; it fsyncs them before answering. A resumed slice cuts every staging file back
// to its checkpoint size (a slice killed after its last checkpoint may have appended more), removes staging files the
// checkpoint does not know, and reads on from the offset: a plain dump from that byte, a gzipped one decompressed again
// from its start (gzip cannot seek). A staging file shorter than its checkpoint says (lost on a crash) starts the
// split over.
//
// A gzipped dump's decompression (C19): the caller may keep the reader between the slices of one process (`keep`, the
// pipeline's job session; worker and cron_cli run a long job's slices back to back), so the next slice reads on where
// the last one stopped, inflating every byte once. Only a slice without it (another process, after a crash or a retry)
// decompresses the dump again up to its offset; that skip calls `heartbeat` every 64 MiB (the job's lease and
// `jobs:heavy` outlive it), and the budget counts from its end, so every slice moves a budget's worth of statements
// however long the skip took (such a slice runs longer than its budget once, rather than one statement per slice).
//
// Disk (S10): `ensureHeadroom(3 × the dump's size)` before the first slice, and again for the next 64 MiB each time
// about 64 MiB more were written, since a `.sql.gz` decompresses to 10-50 times its size. Every check is a fresh probe
// (`{fresh: true}`): the platform's 10-minute cache would otherwise answer each re-check from the first one while the
// split writes gigabytes. Too little room is the probe's DomainError `DISK_QUOTA` (and a write that fails with
// ENOSPC/EDQUOT becomes one too); nothing more is written.

/** The staging bytes written between two headroom checks (S10). */
export const SPLIT_HEADROOM_STEP = 64 * 1024 * 1024;
/** The most tables a dump may hold (the checkpoint counts rows per table and must stay well below 64 KiB). */
export const SPLIT_MAX_TABLES = 512;
/** The table list's file: not a SLiMS table name, so never a staged table's file. */
const TABLE_LIST_FILE = 'split_tables.ndjson';
const TABLE_LIST_MAX = 16 * 1024 * 1024;
/**
 * A table name a checkpoint can carry (MySQL names are at most 64 characters); others are not tracked. The table list
 * splitDump returns (and the pipeline's `tables.json`) holds every name it tracked, so the pipeline reads it back with
 * this same rule.
 */
export const SPLIT_TABLE_NAME = /^[A-Za-z0-9_$-]{1,64}$/;
const TABLE_NAME = SPLIT_TABLE_NAME;
const READ_CHUNK = 256 * 1024;
/** The decompressed bytes a resumed slice skips between two heartbeats (C19). */
export const SPLIT_SKIP_HEARTBEAT_BYTES = 64 * 1024 * 1024;
const PUSH_PIECE = 16 * 1024;
const WRITE_FLUSH = 256 * 1024;

export interface SplitDumpOptions {
  dumpPath: DataPath;
  gz: boolean;
  /** The run's work folder (`runWorkDir(dataDir, runId)`). */
  stagingDir: DataPath;
  checkpoint: SplitCheckpoint | null;
  budgetMs: number;
  /** The disk headroom probe (default @altis/platform's ensureHeadroom, uncached: `{fresh: true}`); a test seam. */
  ensureHeadroom?: (dataDir: string, bytes: number) => Promise<void>;
  /** The staging bytes between two headroom checks (default {@link SPLIT_HEADROOM_STEP}); a test seam. */
  headroomStepBytes?: number;
  /** The clock the budget is measured with, in ms (default performance.now); a test seam. */
  now?: () => number;
  /**
   * C19: where the dump's reader is kept between the slices of one process (the pipeline's job session): taken when it
   * stands at the checkpoint's offset, left there when the slice ends before the dump does. Closed otherwise.
   */
  keep?: { reader: SplitDumpReader | null };
  /** The job's heartbeat, called while a resumed slice skips decompressed bytes (C19; throws JOB_LEASE_LOST). */
  heartbeat?: () => Promise<void>;
  /** The skipped bytes between two heartbeats (default {@link SPLIT_SKIP_HEARTBEAT_BYTES}); a test seam. */
  heartbeatStepBytes?: number;
}

interface TableState {
  /** The CREATE TABLE's columns, in order (empty without one). */
  columns: string[];
  primaryKey: string[];
  /** A table without a CREATE TABLE: the columns its INSERTs named, in first-seen order (L12). */
  seen?: string[];
}

/** The most columns of a table its INSERTs add to the table list (pipeline.ts reads at most 4096, of 1-64 characters). */
const LISTED_COLUMNS_MAX = 4096;

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
}

/** ENOSPC/EDQUOT of a staging write as DISK_QUOTA (P21: the caller of openAppend maps its writes' errors). */
function quota(error: unknown): unknown {
  const code = errorCode(error);
  if (code !== 'ENOSPC' && code !== 'EDQUOT') return error;
  return new DomainError('DISK_QUOTA', {
    detail: 'Ruang disk atau kuota hosting habis saat memecah dump SLiMS / The disk or hosting quota ran out while splitting the SLiMS dump',
    meta: { reason: 'write', code },
    cause: error,
  });
}

/** The staging files of one slice: appends buffered per file, sizes counted as written. */
class Staging {
  readonly sizes = new Map<string, number>();
  written = 0;
  private readonly handles = new Map<string, FileHandle>();
  private readonly pending = new Map<string, Buffer[]>();
  private readonly pendingBytes = new Map<string, number>();
  private created = false;

  constructor(private readonly dir: DataPath) {}

  async append(file: string, text: string): Promise<void> {
    const bytes = Buffer.from(text, 'utf8');
    const list = this.pending.get(file) ?? [];
    list.push(bytes);
    this.pending.set(file, list);
    const waiting = (this.pendingBytes.get(file) ?? 0) + bytes.length;
    this.pendingBytes.set(file, waiting);
    this.sizes.set(file, (this.sizes.get(file) ?? 0) + bytes.length);
    this.written += bytes.length;
    if (waiting >= WRITE_FLUSH) await this.flush(file);
  }

  private async flush(file: string): Promise<void> {
    const list = this.pending.get(file);
    if (list === undefined || list.length === 0) return;
    this.pending.set(file, []);
    this.pendingBytes.set(file, 0);
    let handle = this.handles.get(file);
    try {
      if (handle === undefined) {
        const path = runWorkFileIn(this.dir, file);
        if ((await statOrNull(path)) === null) this.created = true;
        handle = await openAppend(path);
        this.handles.set(file, handle);
      }
      const data = list.length === 1 ? list[0]! : Buffer.concat(list);
      for (let at = 0; at < data.length; ) {
        const { bytesWritten } = await handle.write(data, at, data.length - at);
        at += bytesWritten;
      }
    } catch (error) {
      throw quota(error);
    }
  }

  async flushAll(): Promise<void> {
    for (const file of this.pending.keys()) await this.flush(file);
  }

  /** Flushes and fsyncs every file this slice wrote (and the folder when a file was created). */
  async sync(): Promise<void> {
    await this.flushAll();
    try {
      for (const handle of this.handles.values()) await handle.sync();
      if (this.created) await fsyncDir(this.dir);
    } catch (error) {
      throw quota(error);
    }
  }

  async close(): Promise<void> {
    for (const handle of this.handles.values()) await handle.close().catch(() => undefined);
    this.handles.clear();
  }
}

/** Removes every staging file of the folder (a first slice, or one starting over). */
async function clearStaging(dir: DataPath): Promise<void> {
  for (const name of await listNames(dir)) {
    if (!name.endsWith('.ndjson')) continue;
    let path: DataPath;
    try {
      path = runWorkFileIn(dir, name);
    } catch {
      continue; // not a name a split writes
    }
    await removeFile(path);
  }
}

function validCheckpoint(c: SplitCheckpoint): boolean {
  const count = (v: unknown): boolean => Number.isSafeInteger(v) && (v as number) >= 0;
  const map = (v: unknown): boolean => typeof v === 'object' && v !== null && !Array.isArray(v) && Object.values(v).every(count);
  return count(c.offset) && map(c.files) && (c.rows === undefined || map(c.rows)) && (c.headroomAt === undefined || count(c.headroomAt));
}

/**
 * The state at `c`, after cutting the staging files back to it; null when the files do not match it (a file shorter
 * than recorded, or missing) and the split must start over.
 */
async function resume(dir: DataPath, c: SplitCheckpoint, staging: Staging, tables: Map<string, TableState>): Promise<boolean> {
  if (!validCheckpoint(c)) return false;
  for (const [name, size] of Object.entries(c.files)) {
    let path: DataPath;
    try {
      path = runWorkFileIn(dir, name);
    } catch {
      return false;
    }
    const stat = await statOrNull(path);
    if (stat === null ? size > 0 : stat.kind !== 'file' || stat.size < size) return false;
  }
  for (const name of await listNames(dir)) {
    if (!name.endsWith('.ndjson') || Object.hasOwn(c.files, name)) continue;
    try {
      await removeFile(runWorkFileIn(dir, name));
    } catch (error) {
      if (!isDomainError(error) || error.code !== 'INVALID_PATH_SEGMENT') throw error;
    }
  }
  for (const [name, size] of Object.entries(c.files)) {
    const path = runWorkFileIn(dir, name);
    const stat = await statOrNull(path);
    if (stat !== null && stat.size > size) await truncateFile(path, size);
    staging.sizes.set(name, size);
    staging.written += size;
  }
  const listSize = c.files[TABLE_LIST_FILE] ?? 0;
  if (listSize > 0) {
    const bytes = await readBytes(runWorkFileIn(dir, TABLE_LIST_FILE), TABLE_LIST_MAX + 1);
    if (bytes === null) return false;
    for (const line of bytes.subarray(0, listSize).toString('utf8').split('\n')) {
      if (line === '') continue;
      const entry = JSON.parse(line) as { table: string; columns?: string[]; primaryKey?: string[]; seen?: string[] };
      const known = tables.get(entry.table) ?? { columns: [], primaryKey: [] };
      if (entry.seen !== undefined) tables.set(entry.table, { ...known, seen: [...(known.seen ?? []), ...entry.seen] });
      else tables.set(entry.table, { ...known, columns: entry.columns ?? known.columns, primaryKey: entry.primaryKey ?? known.primaryKey });
    }
  }
  return true;
}

/**
 * The dump's bytes (decompressed when `gz`) from a position on, read once: `seek` moves forward (skipping by reading),
 * `next` gives the following bytes, and `unread` gives back the end of the last bytes `next` gave, from a statement end
 * a slice stopped at, so that a reader kept for the next slice (C19) goes on from there.
 */
export class SplitDumpReader {
  /** The decompressed offset of the next byte `next` gives. */
  private at: number;
  /** Bytes from `at` on that were read but not given yet. */
  private held: Buffer | null = null;
  /** The bytes `next` gave last, and their offset. */
  private last: Buffer | null = null;
  private lastAt = 0;
  private closed = false;

  private constructor(
    readonly dumpPath: DataPath,
    readonly gz: boolean,
    private readonly handle: FileHandle,
    private readonly raw: Readable,
    private readonly source: Readable,
    private readonly chunks: AsyncIterator<Buffer>,
    at: number,
  ) {
    this.at = at;
  }

  /** Opens the dump at `offset` (a gzipped one at its start: gzip cannot seek; `seek` then reads up to it). */
  static async open(dumpPath: DataPath, gz: boolean, offset: number): Promise<SplitDumpReader> {
    const handle = await openRead(dumpPath);
    const raw = handle.createReadStream({ start: gz ? 0 : offset, highWaterMark: READ_CHUNK, autoClose: false });
    let source: Readable = raw;
    if (gz) {
      const gunzip = createGunzip({ chunkSize: 64 * 1024 });
      raw.on('error', (error) => gunzip.destroy(error));
      source = raw.pipe(gunzip);
    }
    const chunks = (source as AsyncIterable<Buffer>)[Symbol.asyncIterator]();
    return new SplitDumpReader(dumpPath, gz, handle, raw, source, chunks, gz ? 0 : offset);
  }

  /** The decompressed offset of the next byte `next` gives. */
  get position(): number {
    return this.at;
  }

  private async read(): Promise<Buffer | null> {
    if (this.held !== null) {
      const held = this.held;
      this.held = null;
      return held;
    }
    try {
      const r = await this.chunks.next();
      return r.done === true ? null : r.value;
    } catch (error) {
      if (this.gz && /^Z_/.test(errorCode(error) ?? '')) throw new DumpParseError('gzip_invalid', { table: null });
      throw error;
    }
  }

  /**
   * Reads up to `offset` and drops what it read, calling `onSkip(bytes)` after each piece; false when `offset` is
   * behind the position (the reader cannot go back). A dump that ends before `offset` leaves it at its end.
   */
  async seek(offset: number, onSkip?: (bytes: number) => Promise<void>): Promise<boolean> {
    if (offset < this.at) return false;
    this.last = null;
    while (this.at < offset) {
      const chunk = await this.read();
      if (chunk === null) return true;
      const need = offset - this.at;
      if (chunk.length <= need) {
        this.at += chunk.length;
        await onSkip?.(chunk.length);
      } else {
        this.held = chunk.subarray(need);
        this.at = offset;
        await onSkip?.(need);
      }
    }
    return true;
  }

  /** The next bytes, or null at the dump's end. */
  async next(): Promise<Buffer | null> {
    const chunk = await this.read();
    if (chunk === null) {
      this.last = null;
      return null;
    }
    this.last = chunk;
    this.lastAt = this.at;
    this.at += chunk.length;
    return chunk;
  }

  /** Gives back the bytes from `offset` on of what `next` gave last; false when `offset` is not inside them. */
  unread(offset: number): boolean {
    const last = this.last;
    if (last === null || offset < this.lastAt || offset > this.lastAt + last.length) return false;
    this.held = offset === this.lastAt + last.length ? null : last.subarray(offset - this.lastAt);
    this.at = offset;
    this.last = null;
    return true;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.source.destroy();
    this.raw.destroy();
    await this.handle.close().catch(() => undefined);
  }
}

/**
 * Splits a mysqldump (`gz`: gzip-compressed) into one `<table>.ndjson` staging file per table the migration reads, in
 * `stagingDir`, from `checkpoint` on (null: from the start), for about `budgetMs`; `done` once the whole dump is read.
 * `tables` lists every table seen so far, by name, with its columns, primary key and row count. See the module
 * comment for slicing, resuming and the disk headroom (S10).
 *
 * @throws DumpParseError for a dump that cannot be read as it is (S9 `literal_too_long`, `truncated`, `syntax`,
 *   `column_count`, `columns_unknown` for a read table's rows without columns, `too_many_tables`, `gzip_invalid`)
 * @throws DomainError `DISK_QUOTA` from the headroom probe or a staging write (nothing more is written then)
 */
export async function splitDump(o: SplitDumpOptions): Promise<{ done: boolean; checkpoint: SplitCheckpoint; tables: SlimsTableInfo[] }> {
  const now = o.now ?? (() => performance.now());
  // C19: the reader a slice of this process left, taken (it goes back only when this slice ends before the dump does).
  let kept = o.keep?.reader ?? null;
  if (o.keep !== undefined) o.keep.reader = null;
  const dataDir = dataDirOf(o.stagingDir);
  const headroom = o.ensureHeadroom ?? ((dir: string, bytes: number) => probeHeadroom(dir, bytes, { fresh: true }));
  const step = o.headroomStepBytes ?? SPLIT_HEADROOM_STEP;

  let staging = new Staging(o.stagingDir);
  let tables = new Map<string, TableState>();
  let rows = new Map<string, number>();
  let offset = 0;
  let headroomAt = 0;
  const resumed = o.checkpoint !== null && (await resume(o.stagingDir, o.checkpoint, staging, tables));
  if (resumed) {
    const c = o.checkpoint!;
    offset = c.offset;
    headroomAt = c.headroomAt ?? 0;
    rows = new Map(Object.entries(c.rows ?? {}));
  } else {
    staging = new Staging(o.stagingDir);
    tables = new Map();
    await clearStaging(o.stagingDir);
    const dump = await statOrNull(o.dumpPath);
    await headroom(dataDir, 3 * (dump?.size ?? 0));
  }

  const track = (table: string): boolean => {
    if (!TABLE_NAME.test(table)) return false;
    if (!rows.has(table)) {
      if (rows.size >= SPLIT_MAX_TABLES) throw new DumpParseError('too_many_tables', { table });
      rows.set(table, 0);
    }
    return true;
  };
  const listLine = async (entry: object): Promise<void> => {
    await staging.append(TABLE_LIST_FILE, `${JSON.stringify(entry)}\n`);
    if ((staging.sizes.get(TABLE_LIST_FILE) ?? 0) > TABLE_LIST_MAX) throw new DumpParseError('too_many_tables', { table: null });
  };
  /** L12: the columns of an INSERT's own list, for a table without a CREATE TABLE; new ones go to the table list. */
  const see = async (table: string, named: readonly string[]): Promise<void> => {
    const t = tables.get(table) ?? { columns: [], primaryKey: [] };
    if (t.columns.length > 0) return;
    const seen = new Set(t.seen ?? []);
    const added: string[] = [];
    for (const column of named) {
      if (seen.size >= LISTED_COLUMNS_MAX) break;
      if (seen.has(column) || column.length < 1 || column.length > 64) continue;
      seen.add(column);
      added.push(column);
    }
    if (added.length === 0) return;
    tables.set(table, { ...t, seen: [...(t.seen ?? []), ...added] });
    await listLine({ table, seen: added });
  };
  const apply = async (e: DumpEvent): Promise<void> => {
    if (!track(e.table)) return;
    if (e.type === 'create') {
      tables.set(e.table, { columns: e.columns, primaryKey: e.primaryKey });
      await listLine({ table: e.table, columns: e.columns, primaryKey: e.primaryKey });
      return;
    }
    if (e.type === 'primaryKey') {
      tables.set(e.table, { ...(tables.get(e.table) ?? { columns: [] }), primaryKey: e.primaryKey });
      await listLine({ table: e.table, primaryKey: e.primaryKey });
      return;
    }
    rows.set(e.table, rows.get(e.table)! + e.rows.length);
    if (e.columns !== null) await see(e.table, e.columns);
    if (!Object.hasOwn(SLIMS_COLUMNS, e.table)) return; // counted only (§11.4: not read, derived, or unknown)
    if (e.columns === null && (tables.get(e.table)?.columns.length ?? 0) === 0) throw new DumpParseError('columns_unknown', { table: e.table });
    if (staging.written - headroomAt >= step) {
      await staging.flushAll();
      await headroom(dataDir, step);
      headroomAt = staging.written;
    }
    const file = `${e.table}.ndjson`;
    let text = '';
    for (const row of e.rows) text += `${encodeStagedRow(row)}\n`;
    await staging.append(file, text);
  };

  const columns = new Map<string, readonly string[]>();
  for (const [table, t] of tables) if (t.columns.length > 0) columns.set(table, t.columns);
  const parser = createSqlDumpParser({ marks: true, columns });
  if (kept !== null && (kept.dumpPath !== o.dumpPath || kept.gz !== o.gz || kept.position > offset)) {
    await kept.close();
    kept = null;
  }
  const dump = kept ?? (await SplitDumpReader.open(o.dumpPath, o.gz, offset));
  const start = offset;
  let read = 0;
  let done = true;
  let keepReader = false;
  try {
    const beat = o.heartbeatStepBytes ?? SPLIT_SKIP_HEARTBEAT_BYTES;
    let skipped = 0;
    await dump.seek(offset, async (bytes) => {
      skipped += bytes;
      if (skipped < beat) return;
      skipped = 0;
      await o.heartbeat?.();
    });
    const started = now(); // C19: the budget is the statements', however long the skip took
    reading: for (let chunk = await dump.next(); chunk !== null; chunk = await dump.next()) {
      // Pushed in small pieces: a slice whose budget is over stops at the next statement end without parsing (and
      // throwing away) the rest of a large read.
      for (let at = 0; at < chunk.length; at += PUSH_PIECE) {
        const piece = chunk.toString('latin1', at, Math.min(chunk.length, at + PUSH_PIECE));
        read += piece.length;
        for (const e of parser.push(piece)) {
          if (e.type !== 'end') {
            await apply(e);
            continue;
          }
          offset = start + e.offset;
          if (now() - started >= o.budgetMs) {
            done = false;
            keepReader = dump.unread(offset);
            break reading;
          }
        }
      }
    }
    if (done) {
      for (const e of parser.end()) if (e.type !== 'end') await apply(e);
      offset = start + read;
    }
    await staging.sync();
  } catch (error) {
    keepReader = false;
    throw error;
  } finally {
    if (keepReader && o.keep !== undefined) o.keep.reader = dump;
    else await dump.close();
    await staging.close();
  }

  const checkpoint: SplitCheckpoint = {
    offset,
    files: Object.fromEntries([...staging.sizes].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    rows: Object.fromEntries(rows),
    headroomAt,
  };
  const names = new Set([...rows.keys(), ...tables.keys()]);
  // L12: a data-only dump's empty tables (see the top of this file).
  if (done && rows.has('biblio') && ![...tables.values()].some((t) => t.columns.length > 0)) {
    for (const name of Object.keys(SLIMS_COLUMNS)) if (!SLIMS9_MARKER_TABLES.includes(name)) names.add(name);
  }
  const list: SlimsTableInfo[] = [...names]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((name) => {
      const t = tables.get(name);
      const columns = t === undefined ? [] : t.columns.length > 0 ? t.columns : (t.seen ?? []);
      return { name, columns: [...columns], primaryKey: [...(t?.primaryKey ?? [])], rows: rows.get(name) ?? 0 };
    });
  return { done, checkpoint, tables: list };
}
