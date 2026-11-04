import {
  readSchemaTableEntries,
  readTableColumns,
  readTableKeys,
  tableLoadOrder,
  type CatalogColumn,
  type CatalogForeignKey,
  type ColumnSpec,
  type DB,
  type Dialect,
} from '@altis/db';
import type { Kysely, Transaction } from 'kysely';
import type { BackupClass } from './canonical.js';

// The columns of the generic exporter (spec §9.8 row 3: a bundled newer release in `schemaHold` backs the database up
// "dengan eksportir generik (kolom dibaca dari skema DB, bukan registri kode)"; decision C11 leaves the generic
// exporter to 1d): the tables `schema_tables` records with a backup class, each with the columns and the primary key
// the database's catalog describes (@altis/db catalog.ts), never the code's registry. A column gets the ColumnKind
// whose canonical encoding (canonical.ts) it shares, so a table the registry also describes gives the same canonical
// rows, byte for byte, either way.

/**
 * The `since` of a column read from the catalog: no migration is known for it, and it exists now (it sorts before
 * every migration name, so a per-version filter keeps it).
 */
export const CATALOG_COLUMN_SINCE = '0000_catalog';

/** The table classes a backup holds (spec §6.5), as backupTables() takes them. */
const BACKUP_CLASSES: ReadonlySet<string> = new Set<BackupClass>(['data', 'config', 'history']);

/**
 * The ColumnKind of a catalog column, by the canonical encoding its values share (canonical.ts):
 *
 * - `integer` → `bigint` (a JSON number within ±(2^53 − 1)); ALTIS's `bool`, `timestamp`, `money`, `smallint` and
 *   `int` columns are all integers in the catalog and encode alike;
 * - `boolean` → `bool` (0/1; a driver's true/false is taken);
 * - `binary` → `char`, one of the R17 key kinds (a string compared in byte order without a collation clause);
 * - `text` → `varchar` with its length, or `text` without one (a string; a key column of this family is compared
 *   `COLLATE utf8mb4_bin` on MySQL/MariaDB, `COLLATE "C"` on PostgreSQL);
 * - `decimal` → `text` (the exact decimal string PostgreSQL and MySQL/MariaDB drivers return); never a key column
 *   ({@link catalogBackupTables} refuses one, ruling R1d-3);
 * - `json` → `json`, `date` → `date` (strings: a driver that returns a parsed object or a Date for a native type has
 *   the canonical row refuse the value, naming the column, rather than encode it some other way).
 */
export function columnSpecOf(c: CatalogColumn): ColumnSpec {
  const base = { name: c.name, nullable: c.nullable, since: CATALOG_COLUMN_SINCE };
  const sized = c.length === null ? {} : { length: c.length };
  switch (c.family) {
    case 'integer':
      return { ...base, kind: 'bigint' };
    case 'boolean':
      return { ...base, kind: 'bool' };
    case 'binary':
      return { ...base, kind: 'char', ...sized };
    case 'text':
      return c.length === null ? { ...base, kind: 'text' } : { ...base, kind: 'varchar', length: c.length };
    case 'decimal':
      return { ...base, kind: 'text' };
    case 'json':
      return { ...base, kind: 'json' };
    case 'date':
      return { ...base, kind: 'date', ...sized };
  }
}

/**
 * The columns of `table` as the database's catalog describes them, in ordinal order, as ColumnSpecs
 * ({@link columnSpecOf}); [] when the table does not exist.
 *
 * @throws TypeError for a table name that is not an identifier, an unknown dialect, or a column of a type a backup
 *   cannot hold (readTableColumns)
 */
export async function catalogColumnSpecs(db: Kysely<DB> | Transaction<DB>, dialect: Dialect, table: string): Promise<ColumnSpec[]> {
  return (await readTableColumns(db, dialect, table)).map(columnSpecOf);
}

/** One table of a catalog export: its class, its columns ({@link catalogColumnSpecs}) and its primary key. */
export interface CatalogBackupTable {
  table: string;
  cls: BackupClass;
  columns: readonly ColumnSpec[];
  /** The primary key's columns, in key order. */
  pk: readonly string[];
}

/**
 * The tables a catalog export holds: every table `schema_tables` records with class `data`, `config` or `history`
 * (a name whose table does not exist, which ddl.ts may leave behind a crash, is skipped), in load order by the
 * catalog's foreign keys (tableLoadOrder: parents first, ties by name), so that on a database the registry describes
 * the order is backupTables()'.
 *
 * A key column of the `decimal` family is refused (ruling R1d-3): its values are exact decimal strings, which the
 * keyset reads and a restore's resume compare in byte order (`'10.00' < '9.00'`), not in the database's numeric
 * order, so rows could be skipped or read twice.
 *
 * @throws TypeError for a table without a primary key (it cannot be read in key order), a `decimal` key column, a
 *   column of a type a backup cannot hold, or foreign keys that form a cycle (each naming the table, and the column)
 */
export async function catalogBackupTables(db: Kysely<DB> | Transaction<DB>, dialect: Dialect): Promise<CatalogBackupTable[]> {
  const found = new Map<string, CatalogBackupTable>();
  const foreignKeys = new Map<string, { fks: CatalogForeignKey[] }>();
  for (const entry of await readSchemaTableEntries(db)) {
    if (!BACKUP_CLASSES.has(entry.class)) continue;
    const catalog = await readTableColumns(db, dialect, entry.name);
    if (catalog.length === 0) continue;
    const keys = await readTableKeys(db, dialect, entry.name);
    if (keys.pk.length === 0) throw new TypeError(`catalogBackupTables(): ${entry.name} has no primary key to export it in key order`);
    for (const name of keys.pk) {
      if (catalog.find((c) => c.name === name)?.family === 'decimal') {
        throw new TypeError(`catalogBackupTables(): ${entry.name}.${name} is a DECIMAL key column, which a backup cannot read in key order`);
      }
    }
    const columns = catalog.map(columnSpecOf);
    found.set(entry.name, { table: entry.name, cls: entry.class as BackupClass, columns, pk: keys.pk });
    foreignKeys.set(entry.name, { fks: keys.fks });
  }
  const { order } = tableLoadOrder([...found.keys()], Object.fromEntries(foreignKeys));
  return order.map((name) => found.get(name) as CatalogBackupTable);
}
