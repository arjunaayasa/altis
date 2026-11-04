import { createHash } from 'node:crypto';
import { canonicalize } from '@altis/crypto';
import {
  SECRET_COLUMNS,
  SETTINGS_SCOPE_CLASS,
  TABLE_CLASSES,
  TABLE_COLUMNS,
  TABLE_KEYS,
  columnsAt,
  readPkBatch,
  tableLoadOrder,
  type ColumnSpec,
  type DB,
  type Dialect,
  type PkValue,
  type TableName,
} from '@altis/db';
import type { Kysely, Transaction } from 'kysely';
import type { BackupManifest } from './manifest.js';

// The canonical backup row (spec §9.9) and what a backup holds:
//
// - the tables of class `data`, `config` and `history` (§6.5), in foreign-key load order (parents first), so a restore
//   can load the parts in the order the manifest lists them; `settings` holds only its rows of scope class `data`
//   (an `instance` row is install state: neither backed up nor overwritten by a restore, §6.5);
// - one JSON line per row: the registry's columns (TABLE_COLUMNS, decision C11) and nothing else, keys sorted
//   (RFC 8785 canonical JSON), integers as JSON numbers within ±(2^53 − 1), booleans 0/1, NULL as an explicit null.
//   The drivers of the four dialects return the same values for the same row (text as strings, integers as numbers,
//   flags as 0/1), so a row gives the same bytes whatever database it was read from;
// - the per-table checksum: SHA-256 of the canonical lines in primary-key order with the registered secret columns
//   left out (SECRET_COLUMNS: `staff_users.totp_secret_enc`, and `settings.value` where `is_secret = 1`). A restore
//   re-seals secrets (a passphrase archive, another installation's keyring), so a sealed value is never compared;
//   cross-dialect restores compare these checksums (A6).

/** The table classes a backup holds. */
export type BackupClass = 'data' | 'config' | 'history';

/** One table of a backup and its class. */
export interface BackupTable {
  table: TableName;
  cls: BackupClass;
}

const BACKUP_CLASSES: ReadonlySet<string> = new Set<BackupClass>(['data', 'config', 'history']);

/** Integer column kinds: written as JSON numbers. */
const INTEGER_KINDS: ReadonlySet<ColumnSpec['kind']> = new Set(['serial', 'bool', 'money', 'timestamp', 'smallint', 'int', 'bigint']);

/** The table names of the code's registry: what the typed backup path builders accept (decision C10). */
export const BACKUP_PATH_TABLES: ReadonlySet<string> = new Set(Object.keys(TABLE_COLUMNS));

/**
 * The table names the part paths of backup `m` accept: the registry's ({@link BACKUP_PATH_TABLES}), or, for a catalog
 * export (the generic exporter of a `schemaHold` pre_update, spec §9.8 row 3), the tables its manifest lists, as the
 * exporter named them (preflight M1): a table the registry does not know has parts too (phase-end review C13). Those
 * names passed the manifest's table name check, and backupPartPath checks them again.
 */
export function backupPathTablesOf(m: Pick<BackupManifest, 'columnsFrom' | 'tables'>): ReadonlySet<string> {
  return m.columnsFrom === 'catalog' ? new Set(Object.keys(m.tables)) : BACKUP_PATH_TABLES;
}

/**
 * The tables a backup holds (class `data`, `config` or `history`), in load order: every table after the tables its
 * foreign keys reference (tableLoadOrder), ties by name. Volatile, install and migrator tables are never backed up.
 *
 * With `schemaVersion` (a migration name or a schema version), only the tables that existed at it (columnsAt not
 * empty): the registry can name a table a database at that schema does not have yet, such as the test builds'
 * `test_fixture` (decision D1d-26) on a database below 9001.
 */
export function backupTables(schemaVersion?: string): BackupTable[] {
  const tables = (Object.keys(TABLE_CLASSES) as TableName[]).filter(
    (t) => BACKUP_CLASSES.has(TABLE_CLASSES[t]) && (schemaVersion === undefined || columnsAt(t, schemaVersion).length > 0),
  );
  return tableLoadOrder(tables).order.map((table) => ({ table, cls: TABLE_CLASSES[table] as BackupClass }));
}

/**
 * The tables a backup of a database at `schemaVersion` holds: those of {@link backupTables} that existed once that
 * migration had run (columnsAt). A database not yet migrated to the code's latest schema (a Phase 1 schema read by
 * Phase 2 code) has no table of a later migration, so its backup lists none.
 *
 * @throws TypeError for a `schemaVersion` that is neither a migration name nor a schema version
 */
export function backupTablesAt(schemaVersion: string): BackupTable[] {
  return backupTables().filter((t) => columnsAt(t.table, schemaVersion).length > 0);
}

/** A short, printable description of a value for an error message (never the value of a long text). */
function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return `a string of ${value.length} characters`;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') return `${typeof value} ${String(value)}`;
  return typeof value;
}

/** `value` as a safe integer, or a TypeError naming the column. */
function integerOf(table: string, c: ColumnSpec, value: unknown): number {
  if (c.kind === 'bool' && typeof value === 'boolean') return value ? 1 : 0;
  let n: number | null = null;
  if (typeof value === 'number' && Number.isSafeInteger(value)) n = value;
  else if (typeof value === 'bigint' && value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
    n = Number(value);
  }
  if (n === null) {
    throw new TypeError(
      `canonicalRow(): ${table}.${c.name} must be an integer within ±(2^53 − 1), got ${describeValue(value)}`,
    );
  }
  if (c.kind === 'bool' && n !== 0 && n !== 1) {
    throw new TypeError(`canonicalRow(): ${table}.${c.name} is a flag and must be 0 or 1, got ${n}`);
  }
  return n === 0 ? 0 : n; // -0 is 0
}

/**
 * The canonical form of one row of `table`: exactly `columns` (in their order; JSON keys are sorted later by
 * {@link canonicalLine}), integers as numbers within ±(2^53 − 1) (a driver's `bigint` within that range is
 * converted), flags as 0/1 (`true`/`false` accepted), text as strings, NULL as null. Keys of `row` that are not in
 * `columns` are left out.
 *
 * @throws TypeError when a column is missing from `row` (undefined), an integer is not a safe integer (`2 ** 53`, a
 *   fraction, a numeric string), a flag is not 0/1, or a text column holds anything but a string
 */
export function canonicalRow(table: TableName, row: Record<string, unknown>, columns: readonly ColumnSpec[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of columns) {
    const value = Object.hasOwn(row, c.name) ? row[c.name] : undefined;
    if (value === undefined) throw new TypeError(`canonicalRow(): the row of ${table} has no column ${c.name}`);
    if (value === null) {
      out[c.name] = null;
    } else if (INTEGER_KINDS.has(c.kind)) {
      out[c.name] = integerOf(table, c, value);
    } else if (typeof value === 'string') {
      out[c.name] = value;
    } else {
      throw new TypeError(`canonicalRow(): ${table}.${c.name} must be a string, got ${describeValue(value)}`);
    }
  }
  return out;
}

/**
 * One JSONL line: the RFC 8785 canonical JSON of `row` (keys sorted) and a line feed.
 *
 * @throws TypeError (`JCS_INVALID:…`) for a value outside the JSON data model, such as a lone surrogate
 */
export function canonicalLine(row: Record<string, unknown>): string {
  return `${canonicalize(row)}\n`;
}

/**
 * Whether a backup holds this row of `table`: every row, except that `settings` holds only the rows whose scope's
 * class is `data` (SETTINGS_SCOPE_CLASS; an `instance` row, or a scope this code does not know, is left out).
 */
export function backupRowIncluded(table: TableName, row: Record<string, unknown>): boolean {
  if (table !== 'settings') return true;
  const scope = row['scope'];
  return typeof scope === 'string' && Object.hasOwn(SETTINGS_SCOPE_CLASS, scope) && SETTINGS_SCOPE_CLASS[scope as keyof typeof SETTINGS_SCOPE_CLASS] === 'data';
}

/** The secret columns of each table (SECRET_COLUMNS), and whether they are secret only where `is_secret = 1`. */
const SECRETS_BY_TABLE: ReadonlyMap<string, readonly { column: string; onlyWhere: 'is_secret' | undefined }[]> = (() => {
  const map = new Map<string, { column: string; onlyWhere: 'is_secret' | undefined }[]>();
  for (const s of SECRET_COLUMNS) {
    const list = map.get(s.table) ?? [];
    list.push({ column: s.column, onlyWhere: s.onlyWhere });
    map.set(s.table, list);
  }
  return map;
})();

/** Whether `table` has registered secret columns: its checksum lines differ from its canonical lines. */
export function hasSecretColumns(table: TableName): boolean {
  return SECRETS_BY_TABLE.has(table);
}

/**
 * The line a table checksum hashes for the canonical row `row`: its canonical line without the registered secret
 * columns (`staff_users.totp_secret_enc`; `settings.value` only where `is_secret = 1`). For a table without secret
 * columns it is the canonical line itself.
 */
export function checksumLine(table: TableName, row: Record<string, unknown>): string {
  const secrets = SECRETS_BY_TABLE.get(table);
  if (secrets === undefined) return canonicalLine(row);
  const copy = { ...row };
  for (const s of secrets) {
    if (s.onlyWhere === undefined || copy[s.onlyWhere] === 1) delete copy[s.column];
  }
  return canonicalLine(copy);
}

/** The primary key values of the canonical row `row` of `table`, in key order. */
export function pkOf(table: TableName, row: Record<string, unknown>): PkValue[] {
  return TABLE_KEYS[table].pk.map((name) => {
    const value = row[name];
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new TypeError(`pkOf(): the key column ${table}.${name} holds ${describeValue(value)}`);
    }
    return value;
  });
}

/** Rows per keyset batch of {@link tableChecksumFromDb}. */
const CHECKSUM_BATCH = 1000;

/**
 * The checksum of `table` as a backup's manifest records it, computed from the database `read` (the comparison of
 * acceptance A6: after a restore, every table's checksum equals the archive's): SHA-256 (hex) of the
 * {@link checksumLine}s of the rows a backup holds ({@link backupRowIncluded}), in primary-key order (byte order on
 * every dialect, readPkBatch). `o.schemaVersion` (a migration name or a schema version) takes the columns that
 * existed then (columnsAt), as a backup made at that version holds them; default every column of the registry.
 */
export async function tableChecksumFromDb(
  read: Kysely<DB> | Transaction<DB>,
  dialect: Dialect,
  table: TableName,
  o: { schemaVersion?: string } = {},
): Promise<string> {
  const columns = o.schemaVersion === undefined ? TABLE_COLUMNS[table] : columnsAt(table, o.schemaVersion);
  const names = columns.map((c) => c.name);
  const hash = createHash('sha256');
  let after: PkValue[] | null = null;
  for (;;) {
    const batch = await readPkBatch(read, dialect, table, { after, limit: CHECKSUM_BATCH, columns: names });
    let text = '';
    for (const raw of batch) {
      const row = canonicalRow(table, raw, columns);
      if (backupRowIncluded(table, row)) text += checksumLine(table, row);
      after = pkOf(table, row);
    }
    hash.update(text, 'utf8');
    if (batch.length < CHECKSUM_BATCH) break;
  }
  return hash.digest('hex');
}
