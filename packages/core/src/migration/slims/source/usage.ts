import { createHmac } from 'node:crypto';
import type { openForeignMysql } from '@altis/db';
import type { DataPath } from '@altis/platform';
import { textCell } from './clean-text.js';
import { openDbSource, type OpenDbSourceOptions } from './db-source.js';
import { splitDump, type SplitDumpOptions } from './dump-split.js';
import { openStagedDumpSource, projectRow } from './dump-source.js';
import type { SlimsDbConfig, SlimsRow, SlimsSource, SlimsTableInfo, SplitCheckpoint } from './types.js';

// The readers of the read-only SLiMS usage import (spec §11.2): SLiMS 9 table/column names (interoperability facts, no
// SLiMS code). The import counts loans, visits and in-library use per month from a SLiMS database or dump without
// keeping anyone's identity, so both of its readers apply the same two rules to every row, as the row is read from the
// connection or split from the dump, before it is staged or returned:
//
// - only the columns of SLIMS_USAGE_COLUMNS are kept (a name, an address, an institution, an e-mail never leaves the
//   source: the direct connection does not even select them);
// - every member id (SLIMS_USAGE_HASHED) is replaced by its keyed hash: HMAC-SHA256 under a key drawn at random for the
//   run (kept in the job's sealed secret and dropped with it), cut to 128 bits, as 32 lower-case hex characters. One
//   member gives the same hash in every table of one run, so the import can tell members apart and group them by type,
//   and nobody can tell which member it was once the key is gone. An empty id (a guest in the visitor log) stays empty
//   and NULL stays NULL. Each reader hashes with its own copy of the key, taken when it is opened and wiped when it is
//   done (the split's call ends, the connection is closed), so the caller may wipe its key at once.
//
// The catalogue migration's list (SLIMS_COLUMNS) is a different list and does not change: the member, loan and visitor
// tables never enter it, so the catalogue migration never stages their rows. `member`, keyed by the hashed id, is read
// from the database by position (`ORDER BY member_id LIMIT ? OFFSET ?`, a numeric cursor), so no raw id is ever kept in
// a checkpoint; `item`, whose key `item_id` is not read, likewise. `read_counter` (a plugin's table) is optional: a
// source without it simply does not list it.

/** The SLiMS tables the usage import reads. */
export type SlimsUsageTable = 'loan' | 'loan_history' | 'visitor_count' | 'member' | 'mst_member_type' | 'item' | 'biblio' | 'read_counter';

/**
 * The columns the usage import reads, per table (spec §11.2); `visitor_count.visitor_id` and `read_counter.id` only
 * page the reads.
 */
export const SLIMS_USAGE_COLUMNS: Readonly<Record<SlimsUsageTable, readonly string[]>> = Object.freeze({
  loan: Object.freeze(['loan_id', 'item_code', 'member_id', 'loan_date', 'is_lent', 'is_return']),
  loan_history: Object.freeze(['loan_id', 'item_code', 'biblio_id', 'classification', 'member_id', 'member_type_name', 'loan_date']),
  visitor_count: Object.freeze(['visitor_id', 'member_id', 'checkin_date']),
  member: Object.freeze(['member_id', 'member_type_id', 'expire_date']),
  mst_member_type: Object.freeze(['member_type_id', 'member_type_name']),
  item: Object.freeze(['item_code', 'biblio_id']),
  biblio: Object.freeze(['biblio_id', 'classification']),
  read_counter: Object.freeze(['id', 'item_code', 'created_at']),
});

/** The columns replaced by their keyed hash as the row is read or split: the member id. */
export const SLIMS_USAGE_HASHED: Readonly<Partial<Record<SlimsUsageTable, readonly string[]>>> = Object.freeze({
  loan: Object.freeze(['member_id']),
  loan_history: Object.freeze(['member_id']),
  visitor_count: Object.freeze(['member_id']),
  member: Object.freeze(['member_id']),
});

/** The shortest hash key accepted (the run's key is 32 random bytes). */
const KEY_MIN_BYTES = 16;
/** The bytes of the hash kept: 128 bits. */
const HASH_BYTES = 16;
const OPTIONAL_TABLES: ReadonlySet<string> = new Set(['read_counter']);

function checkKey(key: Uint8Array): void {
  if (!(key instanceof Uint8Array) || key.byteLength < KEY_MIN_BYTES) throw new TypeError(`the usage hash key must hold at least ${KEY_MIN_BYTES} bytes`);
}

const digest = (key: Uint8Array, bytes: Uint8Array): string => createHmac('sha256', key).update(bytes).digest().subarray(0, HASH_BYTES).toString('hex');

/**
 * The keyed hash of a SLiMS member id: `''` for an empty id (a guest) and for one of spaces only; otherwise the hex of
 * the first 16 bytes of HMAC-SHA256(`key`, the id trimmed, as UTF-8). `key` holds at least 16 bytes.
 *
 * @throws TypeError for a shorter key
 */
export function memberHash(key: Uint8Array, memberId: string): string {
  checkKey(key);
  const id = memberId.trim();
  return id === '' ? '' : digest(key, Buffer.from(id, 'utf8'));
}

const ASCII_SPACE: ReadonlySet<number> = new Set([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20]);

/** The hash of one cell: NULL stays NULL; text, a number and bytes are hashed as the id they hold. */
function hashCell(key: Uint8Array, cell: SlimsRow[string]): SlimsRow[string] {
  if (cell === null) return null;
  if (typeof cell === 'string') return memberHash(key, cell);
  if (typeof cell === 'number') return memberHash(key, String(cell));
  const text = textCell(cell);
  if (typeof text === 'string') return memberHash(key, text);
  // Bytes that are not UTF-8 (a latin1 table): hashed as they are, trimmed of ASCII white space.
  let from = 0;
  let to = text.byteLength;
  while (from < to && ASCII_SPACE.has(text[from]!)) from += 1;
  while (to > from && ASCII_SPACE.has(text[to - 1]!)) to -= 1;
  return from === to ? '' : digest(key, text.subarray(from, to));
}

const isUsageTable = (table: string): table is SlimsUsageTable => Object.hasOwn(SLIMS_USAGE_COLUMNS, table);

/** The row transform over `key` itself (not a copy): the caller owns `key` and wipes it when the transform is done. */
function transformWith(key: Uint8Array): (table: string, row: SlimsRow) => SlimsRow {
  return (table, row) => {
    if (!isUsageTable(table)) throw new TypeError('usageRowTransform: not a table the usage import reads');
    const out = projectRow(row, SLIMS_USAGE_COLUMNS[table]);
    for (const column of SLIMS_USAGE_HASHED[table] ?? []) {
      if (Object.hasOwn(out, column)) out[column] = hashCell(key, out[column]!);
    }
    return out;
  };
}

/**
 * The transform both readers apply to every row of a usage table: only the columns of SLIMS_USAGE_COLUMNS (those the
 * row has, in that order), the member id replaced by memberHash. Returns a new row; the input is left as it was. The
 * transform hashes with a copy of `key` taken now: wiping `key` afterwards does not change it.
 *
 * @throws TypeError for a key shorter than 16 bytes, and (from the returned function) for a table that is not a usage
 *   table
 */
export function usageRowTransform(key: Uint8Array): (table: string, row: SlimsRow) => SlimsRow {
  checkKey(key);
  return transformWith(Uint8Array.from(key));
}

/** What openUsageDbSource is opened with: the run's hash key, and the connection's options. */
export interface OpenUsageDbSourceOptions {
  hashKey: Uint8Array;
  connectTimeoutMs?: number;
  /** The foreign client (default @altis/db's openForeignMysql); a test seam. */
  connect?: typeof openForeignMysql;
}

/**
 * The SLiMS database as the usage import reads it (see the module comment): only the usage tables, with only their
 * usage columns and exact row counts, rows hashed as they are read. The source hashes with its own copy of
 * `o.hashKey`, wiped when it is closed: the caller may wipe its key as soon as this answers.
 *
 * @throws TypeError for a hash key shorter than 16 bytes (before connecting)
 * @throws DomainError `MIGRATION_SOURCE_UNREACHABLE` as openDbSource
 */
export async function openUsageDbSource(cfg: SlimsDbConfig, o: OpenUsageDbSourceOptions): Promise<SlimsSource> {
  checkKey(o.hashKey);
  const key = Uint8Array.from(o.hashKey);
  const options: OpenDbSourceOptions = { tables: SLIMS_USAGE_COLUMNS, transform: transformWith(key), secretColumns: SLIMS_USAGE_HASHED };
  if (o.connectTimeoutMs !== undefined) options.connectTimeoutMs = o.connectTimeoutMs;
  if (o.connect !== undefined) options.connect = o.connect;
  let source: SlimsSource;
  try {
    source = await openDbSource(cfg, options);
  } catch (error) {
    key.fill(0);
    throw error;
  }
  return {
    kind: source.kind,
    tables: () => source.tables(),
    rows: (table, after, limit) => source.rows(table, after, limit),
    async close() {
      try {
        await source.close();
      } finally {
        key.fill(0);
      }
    },
  };
}

/** What splitUsageDump is called with: splitDump's options (its seams included) and the run's hash key. */
export type SplitUsageDumpOptions = Omit<SplitDumpOptions, 'tables' | 'transform'> & { hashKey: Uint8Array };

/**
 * splitDump for the usage import: only the usage tables are staged, each row with only its usage columns and its
 * member id hashed before it is written; the answered list holds only the usage tables (a dump that never names
 * `read_counter` leaves it out). Slicing, resuming and the disk checks are splitDump's.
 *
 * @throws TypeError for a hash key shorter than 16 bytes (before anything is read or written)
 * @throws DumpParseError, DomainError `DISK_QUOTA` as splitDump
 */
export async function splitUsageDump(o: SplitUsageDumpOptions): Promise<{ done: boolean; checkpoint: SplitCheckpoint; tables: SlimsTableInfo[] }> {
  const { hashKey, ...split } = o;
  checkKey(hashKey);
  const key = Uint8Array.from(hashKey);
  try {
    const result = await splitDump({ ...split, tables: SLIMS_USAGE_COLUMNS, transform: transformWith(key) });
    return { ...result, tables: result.tables.filter((t) => !(OPTIONAL_TABLES.has(t.name) && t.columns.length === 0 && t.rows === 0)) };
  } finally {
    key.fill(0);
  }
}

/** The rows splitUsageDump staged in `stagingDir` (its last `tables`): only the usage tables and columns are served. */
export function openStagedUsageSource(stagingDir: DataPath, tables: SlimsTableInfo[]): SlimsSource {
  return openStagedDumpSource(stagingDir, tables, { allowed: SLIMS_USAGE_COLUMNS });
}
