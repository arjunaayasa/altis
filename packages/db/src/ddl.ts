import { faultArmed } from '@altis/platform';
import { DomainError, isDomainError } from '@altis/shared';
import {
  DataTypeNode,
  sql,
  type AlterTableColumnAlteringBuilder,
  type ColumnDataType,
  type ColumnDefinitionBuilder,
  type CreateTableBuilder,
  type Kysely,
  type OperationNodeSource,
  type RawBuilder,
} from 'kysely';
import { DIALECTS, type Dialect } from './connect.js';
import { FULLTEXT_VIRTUAL_TABLES } from './fulltext.js';

// Portable DDL (spec §6.2): one set of idempotent migrations for MySQL/MariaDB, PostgreSQL and SQLite.
//
// - Every table made here is listed in `schema_tables` (name, class, created_by). Restore and `install:reset` drop
//   tables by that list, never by a list in code (spec §6.2, §9.10 step 6).
// - Idempotent without `IF NOT EXISTS`: each create is preceded by a catalog check (information_schema on
//   MySQL/MariaDB, pg_catalog on PostgreSQL, sqlite_master on SQLite) for the current schema. `IF NOT EXISTS`
//   would silently skip when the name belongs to another kind of object or (for an index) another table; without
//   it such a clash fails loudly. A create that fails because another connection created the object in the
//   meantime is accepted once the catalog shows the object (outside a transaction; inside one, PostgreSQL has
//   already aborted it, so the error stands).
// - The registry row is written before the table is created: whatever crash happens in between, a table made by
//   these helpers is never left unregistered (a row without its table is harmless: the next run creates the
//   table, and dropRegisteredTables deletes such rows).
// - MySQL/MariaDB (one code path, whichever server the dialect points at): InnoDB, utf8mb4_unicode_ci; key and
//   token columns (id(), ulid(), char(), key191()) utf8mb4_bin (ruling R17). utf8mb4_bin is case-sensitive but
//   PAD SPACE on MySQL 8.x and MariaDB: trailing blanks are ignored in comparisons and unique keys there, unlike
//   PostgreSQL varchar and SQLite (ruling R24). The application stores keys trimmed, so they never differ only in
//   trailing blanks.
// - PostgreSQL: the same key and token columns are COLLATE "C" (byte order, the counterpart of R17), the other
//   character columns keep the database's default collation. Keys then sort in byte order on every dialect (SQLite
//   compares with BINARY), and their indexes serve keyset reads in byte order (readPkBatch): PostgreSQL only uses
//   an index whose collation is the comparison's. Columns made before migration 0009 are converted by
//   ensureByteOrder (ruling R1c-15).
// - Names are kept apart by convention: index and foreign key names are unique per database/schema (MySQL
//   scopes index names per table, PostgreSQL/SQLite do not record FK names as unique). Index names start with
//   ix_/uq_ (ruling R23); a primary key is declared as the constraint pk_<table> (PostgreSQL then makes no
//   <table>_pkey index of its own; MySQL/MariaDB's catalog still calls every primary key PRIMARY; SQLite records no
//   constraint names, and its serial() key is inline and unnamed, as AUTOINCREMENT requires); table names never
//   start with ix_/uq_/pk_/fk_ nor end in _seq (the suffix of PostgreSQL's identity sequences,
//   <table>_<column>_seq). This is no guarantee on PostgreSQL: a table named exactly `ix` or `uq` with a serial()
//   column gets the sequence ix_<column>_seq (or uq_...), a name an index may have too; PostgreSQL numbers a
//   sequence whose name is taken (<table>_<column>_seq1, ...); and a table these helpers did not create but adopted
//   (ruling R18) keeps the names its creator gave it, such as PostgreSQL's <table>_pkey. A clash fails loudly when
//   the object is created (no IF NOT EXISTS), never silently.
// - Name lengths: every identifier at most 63 characters (PostgreSQL truncates longer ones); a table name at most
//   60, so that pk_<table> fits; a foreign key's name fk_<table>_<column> must fit in 63 too (TypeError otherwise).
// - A foreign key target must exist with the same column type (SQLite would accept a missing or different one;
//   MySQL also needs the same collation). Such conflicts are DomainError SCHEMA_CONFLICT.

/** The table classes of spec §6.5 (backup and restore treat each class differently). */
export const TABLE_CLASS_NAMES = ['data', 'config', 'history', 'install', 'volatile', 'migrator'] as const;

export type TableClass = (typeof TABLE_CLASS_NAMES)[number];

/** Delete actions a foreign key may have: only ownership relations get foreign keys (spec §6.1). */
export type OnDeleteAction = 'cascade' | 'restrict';

/** Modifiers of a column declared through a {@link TableBuilder} helper. Order does not matter; the last call wins. */
export interface ColumnBuilder {
  /** NOT NULL. This is already the default of every helper; use it to undo an earlier `nullable()`. */
  notNull(): ColumnBuilder;
  /** Allows NULL. Not allowed on primary key columns. */
  nullable(): ColumnBuilder;
  /**
   * A constant default: an integer for the integer helpers (`bool()`: 0 or 1), a string for the character helpers
   * (exactly the column's length and not ending in a blank for `char()`, `date()` and `ulid()`; at most the length
   * for `varchar()`/`key191()`),
   * `null` for a nullable column. Not allowed on `text()`/`json()` (MySQL refuses defaults on TEXT) nor on
   * `id()`/`serial()`.
   */
  default(value: string | number | null): ColumnBuilder;
}

/**
 * Declares the columns and constraints of a table for {@link ensureTable}. Every column is NOT NULL unless
 * `.nullable()` is called. Column names match `/^[a-z][a-z0-9_]*$/`, at most 63 characters (the table name: at most
 * 60, see ensureTable; a foreign key's name `fk_<table>_<column>`: at most 63).
 */
export interface TableBuilder {
  /**
   * ULID primary key: `CHAR(26) PRIMARY KEY` (binary collation on MySQL/MariaDB, like `ulid()`, so a `ulid()`
   * column can reference it).
   */
  id(name?: string): ColumnBuilder;
  /**
   * Auto-increment primary key: `BIGINT AUTO_INCREMENT` (MySQL/MariaDB) or `BIGINT GENERATED BY DEFAULT AS
   * IDENTITY` (PostgreSQL, with the sequence `<table>_<column>_seq`), declared as the constraint `pk_<table>`
   * (MySQL/MariaDB's catalog names it PRIMARY); `INTEGER PRIMARY KEY AUTOINCREMENT` (SQLite, inline and unnamed:
   * AUTOINCREMENT allows nothing else). Starts at 1.
   */
  serial(name: string): ColumnBuilder;
  /**
   * A ULID that is not the primary key (references, mostly): `CHAR(26)`; values are exactly 26 characters and do
   * not end in a blank.
   */
  ulid(name: string): ColumnBuilder;
  /** `SMALLINT` holding 0 or 1. */
  bool(name: string): ColumnBuilder;
  /** `BIGINT` in the currency's smallest unit (the currency itself is a `char(name, 3)` column). */
  money(name: string): ColumnBuilder;
  /** `BIGINT` epoch milliseconds, UTC. */
  timestamp(name: string): ColumnBuilder;
  /** `CHAR(10)` calendar date `YYYY-MM-DD` (exactly 10 characters, never ending in a blank). */
  date(name: string): ColumnBuilder;
  /** `TEXT` holding JSON (validated with Zod by the code; no SQL JSON functions). */
  json(name: string): ColumnBuilder;
  /**
   * `VARCHAR(191)` for unique keys; binary (case-sensitive) collation `utf8mb4_bin` on MySQL/MariaDB, `COLLATE "C"`
   * on PostgreSQL (byte order, R1c-15). That
   * collation is PAD SPACE: trailing blanks are ignored in comparisons and unique keys on MySQL/MariaDB but not on
   * PostgreSQL/SQLite, so store trimmed values (R24).
   */
  key191(name: string): ColumnBuilder;
  /** `VARCHAR(length)`, 1 ≤ length ≤ 191. */
  varchar(name: string, length: number): ColumnBuilder;
  /**
   * `CHAR(length)`, 1 ≤ length ≤ 191, for fixed-length values (hashes, currency codes, tokens): **values must be
   * exactly `length` characters and must not end in a blank**. Otherwise they read back and compare differently
   * per dialect (PostgreSQL pads with blanks and ignores them, MySQL strips them, SQLite keeps them). Binary
   * collation on MySQL/MariaDB.
   */
  char(name: string, length: number): ColumnBuilder;
  /** `TEXT`. */
  text(name: string): ColumnBuilder;
  /** `SMALLINT`. */
  smallint(name: string): ColumnBuilder;
  /** `INTEGER`. */
  int(name: string): ColumnBuilder;
  /** `BIGINT`. */
  bigint(name: string): ColumnBuilder;
  /**
   * A primary key over `columns` (composite keys), instead of `id()`/`serial()`. Every primary key except SQLite's
   * serial() is declared as the constraint `pk_<table>`: PostgreSQL keeps that name; MySQL/MariaDB's catalog calls
   * every primary key PRIMARY; SQLite records no constraint names.
   */
  primaryKey(columns: string[]): void;
  /**
   * A foreign key `fk_<table>_<column>` from `column` of this table to `refTable(refColumn)`. The name must be at
   * most 63 characters (TypeError otherwise, before the database is touched). The target must exist
   * when the table is created (or be a column of this table) with the same column type (`ulid()` -> `id()`,
   * `bigint()` -> `serial()`, ...), and the constraint name must not be used by another table; otherwise
   * ensureTable fails with SCHEMA_CONFLICT on every dialect (TypeError for a self-reference). On MySQL/MariaDB the
   * collation must match as well: `varchar()`/`date()` cannot reference `key191()`/`char()` there.
   */
  foreignKey(column: string, refTable: string, refColumn: string, o: { onDelete: OnDeleteAction }): void;
}

// ---------------------------------------------------------------------------------------------------------------
// Names and the table specification

const IDENTIFIER = /^[a-z][a-z0-9_]*$/;
/** PostgreSQL truncates longer identifiers (NAMEDATALEN - 1); MySQL allows 64. */
const MAX_IDENTIFIER = 63;
const MAX_CHAR_LENGTH = 191;
const MAX_CREATED_BY = 191;

const REGISTRY = 'schema_tables';
const META = 'schema_meta';
const BOOTSTRAP = 'bootstrap';

/** True when `name` is a portable identifier: `/^[a-z][a-z0-9_]*$/`, at most 63 characters, not `sqlite_*`. */
function isIdentifier(name: unknown): name is string {
  return typeof name === 'string' && IDENTIFIER.test(name) && name.length <= MAX_IDENTIFIER && !name.startsWith('sqlite_');
}

/**
 * `name` when it is a portable identifier; a TypeError otherwise. Package-internal: the concurrency primitives check
 * their table and column names with it too.
 */
export function identifier(kind: string, name: unknown): string {
  if (!isIdentifier(name)) {
    throw new TypeError(
      `${kind} name ${JSON.stringify(name)} must match /^[a-z][a-z0-9_]*$/, be at most ${MAX_IDENTIFIER} characters ` +
        'and not start with "sqlite_"',
    );
  }
  return name;
}

/** The column helpers of {@link TableBuilder}: what a column holds, which fixes its type on every dialect. */
export type ColumnKind =
  | 'id'
  | 'serial'
  | 'ulid'
  | 'bool'
  | 'money'
  | 'timestamp'
  | 'date'
  | 'json'
  | 'key191'
  | 'varchar'
  | 'char'
  | 'text'
  | 'smallint'
  | 'int'
  | 'bigint';

const INTEGER_KINDS: ReadonlySet<ColumnKind> = new Set(['bool', 'money', 'timestamp', 'smallint', 'int', 'bigint']);
/** Character kinds and their length. */
const CHAR_LENGTH: Readonly<Partial<Record<ColumnKind, number>>> = { id: 26, ulid: 26, date: 10, key191: MAX_CHAR_LENGTH };
/** CHAR(n) kinds: their values (and so their defaults) are exactly n characters. */
const FIXED_KINDS: ReadonlySet<ColumnKind> = new Set(['id', 'ulid', 'date', 'char']);
/**
 * Kinds with the binary collation on MySQL/MariaDB (ruling R17): case-sensitive there as on PostgreSQL/SQLite, but
 * PAD SPACE (trailing blanks ignored) on MySQL/MariaDB only (ruling R24). COLLATE "C" on PostgreSQL (R1c-15).
 */
const BINARY_KINDS: ReadonlySet<ColumnKind> = new Set(['id', 'ulid', 'char', 'key191']);

interface ColumnSpec {
  readonly name: string;
  readonly kind: ColumnKind;
  /** varchar/char only. */
  readonly length?: number;
  nullable: boolean;
  /** Absent: no DEFAULT clause. */
  default?: { value: string | number | null };
}

interface ForeignKeySpec {
  readonly column: string;
  readonly refTable: string;
  readonly refColumn: string;
  readonly onDelete: OnDeleteAction;
}

interface TableSpec {
  readonly name: string;
  readonly columns: readonly ColumnSpec[];
  /** The single-column key of id()/serial(), or the columns of primaryKey(). */
  readonly primaryKey: { readonly columns: readonly string[] };
  readonly foreignKeys: readonly ForeignKeySpec[];
}

function charLength(kind: 'varchar' | 'char', length: unknown): number {
  if (typeof length !== 'number' || !Number.isInteger(length) || length < 1 || length > MAX_CHAR_LENGTH) {
    throw new TypeError(`${kind} length must be an integer from 1 to ${MAX_CHAR_LENGTH}, got ${String(length)}`);
  }
  return length;
}

/** Declares one column of kind `kind`: called by the column helpers of a {@link TableBuilder}. */
type AddColumn = (kind: ColumnKind, name: unknown, length?: number) => ColumnBuilder;

/** The helpers of {@link TableBuilder} that declare a plain column (not a key). */
type PlainColumnHelpers = Omit<TableBuilder, 'id' | 'serial' | 'primaryKey' | 'foreignKey'>;

function plainColumnHelpers(add: AddColumn): PlainColumnHelpers {
  return {
    ulid: (columnName) => add('ulid', columnName),
    bool: (columnName) => add('bool', columnName),
    money: (columnName) => add('money', columnName),
    timestamp: (columnName) => add('timestamp', columnName),
    date: (columnName) => add('date', columnName),
    json: (columnName) => add('json', columnName),
    key191: (columnName) => add('key191', columnName),
    varchar: (columnName, length) => add('varchar', columnName, charLength('varchar', length)),
    char: (columnName, length) => add('char', columnName, charLength('char', length)),
    text: (columnName) => add('text', columnName),
    smallint: (columnName) => add('smallint', columnName),
    int: (columnName) => add('int', columnName),
    bigint: (columnName) => add('bigint', columnName),
  };
}

/** The modifiers of the column `spec` (they change `spec` in place). */
function modifiersOf(spec: ColumnSpec): ColumnBuilder {
  const modifiers: ColumnBuilder = {
    notNull: () => {
      spec.nullable = false;
      return modifiers;
    },
    nullable: () => {
      spec.nullable = true;
      return modifiers;
    },
    default: (value) => {
      spec.default = { value };
      return modifiers;
    },
  };
  return modifiers;
}

/** A new column spec: NOT NULL, no default, the name checked. */
function newColumn(kind: ColumnKind, columnName: unknown, length?: number): ColumnSpec {
  const base = { name: identifier('column', columnName), kind, nullable: false };
  return length === undefined ? base : { ...base, length };
}

/** Runs `build` and checks the result; throws TypeError for anything that would not be portable. */
function tableSpec(name: string, build: (t: TableBuilder) => void): TableSpec {
  const columns: ColumnSpec[] = [];
  const foreignKeys: ForeignKeySpec[] = [];
  const keys: string[][] = [];
  /** The columns of primaryKey(), when it was called. */
  const composite: { columns: string[] | null } = { columns: null };

  const add: AddColumn = (kind, columnName, length) => {
    const spec = newColumn(kind, columnName, length);
    if (columns.some((c) => c.name === spec.name)) throw new TypeError(`column ${spec.name} is declared twice in ${name}`);
    columns.push(spec);
    if (kind === 'id' || kind === 'serial') keys.push([spec.name]);
    return modifiersOf(spec);
  };

  const t: TableBuilder = {
    id: (columnName = 'id') => add('id', columnName),
    serial: (columnName) => add('serial', columnName),
    ...plainColumnHelpers(add),
    primaryKey: (cols) => {
      if (!Array.isArray(cols) || cols.length === 0) throw new TypeError(`primaryKey() of ${name} needs at least one column`);
      const keyColumns = cols.map((c) => identifier('primary key column', c));
      if (new Set(keyColumns).size !== keyColumns.length) throw new TypeError(`primaryKey() of ${name} repeats a column`);
      composite.columns = keyColumns;
      keys.push(keyColumns);
    },
    foreignKey: (column, refTable, refColumn, o) => {
      const onDelete = (o as { onDelete?: unknown } | undefined)?.onDelete;
      if (onDelete !== 'cascade' && onDelete !== 'restrict') {
        throw new TypeError(`foreignKey() onDelete must be 'cascade' or 'restrict', got ${JSON.stringify(onDelete)}`);
      }
      const fk: ForeignKeySpec = {
        column: identifier('foreign key column', column),
        refTable: identifier('referenced table', refTable),
        refColumn: identifier('referenced column', refColumn),
        onDelete,
      };
      if (foreignKeys.some((f) => f.column === fk.column)) {
        throw new TypeError(`column ${fk.column} of ${name} has two foreign keys`);
      }
      foreignKeys.push(fk);
    },
  };

  build(t);

  if (columns.length === 0) throw new TypeError(`table ${name} has no columns`);
  if (keys.length !== 1) {
    throw new TypeError(
      `table ${name} needs exactly one primary key (id(), serial() or primaryKey()), found ${keys.length}`,
    );
  }
  const byName = new Map(columns.map((c) => [c.name, c]));
  const keyColumns = keys[0] ?? [];
  for (const k of keyColumns) {
    const c = byName.get(k);
    if (c === undefined) throw new TypeError(`primary key column ${k} is not a column of ${name}`);
    // SQLite allows NULL in a primary key unless the column is declared NOT NULL.
    if (c.nullable) throw new TypeError(`primary key column ${k} of ${name} cannot be nullable()`);
  }
  for (const fk of foreignKeys) {
    if (!byName.has(fk.column)) throw new TypeError(`foreign key column ${fk.column} is not a column of ${name}`);
    if (fk.refTable === name) {
      const src = byName.get(fk.column);
      const ref = byName.get(fk.refColumn);
      if (ref === undefined) {
        throw new TypeError(`foreign key ${fk.column} of ${name} references ${fk.refColumn}, which is not a column of ${name}`);
      }
      if (src !== undefined && !sameColumnType(src, ref)) {
        throw new TypeError(
          `foreign key ${fk.column} (${src.kind}) of ${name} references ${fk.refColumn} (${ref.kind}): the column types ` +
            'or (on MySQL/MariaDB) collations differ',
        );
      }
    }
    constraintName('fk', name, fk.column);
  }
  for (const c of columns) checkDefault(name, c);
  constraintName('pk', name);
  return { name, columns, primaryKey: { columns: keyColumns }, foreignKeys };
}

function checkDefault(table: string, c: ColumnSpec): void {
  if (c.default === undefined) return;
  const { value } = c.default;
  const where = `default of ${table}.${c.name}`;
  if (c.kind === 'id' || c.kind === 'serial') throw new TypeError(`${where}: ${c.kind}() columns cannot have a default`);
  if (c.kind === 'text' || c.kind === 'json') {
    throw new TypeError(`${where}: ${c.kind}() columns cannot have a default (MySQL refuses defaults on TEXT)`);
  }
  if (value === null) {
    if (!c.nullable) throw new TypeError(`${where}: a null default needs nullable()`);
    return;
  }
  if (INTEGER_KINDS.has(c.kind)) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
      throw new TypeError(`${where}: ${c.kind}() needs a safe integer default, got ${JSON.stringify(value)}`);
    }
    if (c.kind === 'bool' && value !== 0 && value !== 1) throw new TypeError(`${where}: bool() defaults are 0 or 1`);
    return;
  }
  const length = c.length ?? CHAR_LENGTH[c.kind] ?? 0;
  if (typeof value !== 'string') throw new TypeError(`${where}: ${c.kind}() needs a string default`);
  const chars = [...value].length;
  if (FIXED_KINDS.has(c.kind) && chars !== length) {
    throw new TypeError(`${where}: ${c.kind}() values must be exactly ${length} characters, the default has ${chars}`);
  }
  if (FIXED_KINDS.has(c.kind) && value.endsWith(' ')) {
    throw new TypeError(`${where}: ${c.kind}() values must not end in a blank (dialects pad and strip CHAR blanks differently)`);
  }
  if (chars > length) throw new TypeError(`${where}: longer than the column (${length})`);
}

/** Prefixes of index and constraint names (ruling R23); a table name never starts with one. */
const RESERVED_TABLE_PREFIXES = ['ix_', 'uq_', 'pk_', 'fk_'] as const;
/** PostgreSQL names an identity sequence `<table>_<column>_seq`; a table name never ends like that. */
const RESERVED_TABLE_SUFFIX = '_seq';
/** A table's primary key is `pk_<table>`, which must fit in {@link MAX_IDENTIFIER}. */
const MAX_TABLE_NAME = MAX_IDENTIFIER - 'pk_'.length;

/** `name` when it is a valid table name for ensureTable; a TypeError otherwise. */
function tableName(name: unknown): string {
  const checked = identifier('table', name);
  if (checked.length > MAX_TABLE_NAME) {
    throw new TypeError(`table name ${checked} must be at most ${MAX_TABLE_NAME} characters (its primary key is pk_<table>)`);
  }
  const prefix = RESERVED_TABLE_PREFIXES.find((p) => checked.startsWith(p));
  if (prefix !== undefined) {
    throw new TypeError(`table name ${checked} must not start with ${prefix} (reserved for index and constraint names)`);
  }
  if (checked.endsWith(RESERVED_TABLE_SUFFIX)) {
    throw new TypeError(`table name ${checked} must not end in ${RESERVED_TABLE_SUFFIX} (PostgreSQL sequence names)`);
  }
  return checked;
}

/** `<prefix>_<parts joined by _>`, checked like any identifier. */
function constraintName(prefix: string, ...parts: string[]): string {
  return identifier(`${prefix} constraint`, [prefix, ...parts].join('_'));
}

// ---------------------------------------------------------------------------------------------------------------
// Dialect specifics

/** TypeError unless `dialect` is one of {@link DIALECTS} (a JS caller or a config value could pass anything). */
function checkDialect(dialect: unknown): asserts dialect is Dialect {
  if (!(DIALECTS as readonly unknown[]).includes(dialect)) throw new TypeError(`unknown dialect ${JSON.stringify(dialect)}`);
}

/** MySQL and MariaDB share one code path, whichever server the configured dialect points at. */
function mysqlFamily(dialect: Dialect): boolean {
  return dialect === 'mysql' || dialect === 'mariadb';
}

/** Table options of every MySQL/MariaDB table (global constraints). */
const MYSQL_TABLE_OPTIONS = sql`engine=InnoDB default charset=utf8mb4 collate=utf8mb4_unicode_ci`;
/**
 * {@link BINARY_KINDS} on MySQL/MariaDB: case-sensitive comparison, as on PostgreSQL/SQLite. utf8mb4_bin is PAD
 * SPACE on MySQL 8.x and MariaDB, so trailing blanks are still ignored there (R24); values are stored trimmed.
 */
const MYSQL_BINARY = sql`character set utf8mb4 collate utf8mb4_bin`;
/** {@link BINARY_KINDS} on PostgreSQL: byte order whatever the database's default collation (R1c-15). */
const PG_BYTE_ORDER = sql`collate "C"`;

/** The collation a column of kind `kind` has on MySQL/MariaDB; null for numbers. */
function mysqlCollation(kind: ColumnKind): string | null {
  if (BINARY_KINDS.has(kind)) return 'utf8mb4_bin';
  return kind === 'date' || kind === 'varchar' || kind === 'text' || kind === 'json' ? 'utf8mb4_unicode_ci' : null;
}

/** The column type in SQLite's spelling, except that `serial` is the column type MySQL/PostgreSQL give it. */
function canonicalType(c: ColumnSpec): ColumnDataType {
  switch (c.kind) {
    case 'id':
    case 'ulid':
      return 'char(26)';
    case 'serial':
      return 'bigint';
    case 'bool':
    case 'smallint':
      return 'smallint';
    case 'money':
    case 'timestamp':
    case 'bigint':
      return 'bigint';
    case 'int':
      return 'integer';
    case 'date':
      return 'char(10)';
    case 'json':
    case 'text':
      return 'text';
    case 'key191':
      return 'varchar(191)';
    case 'varchar':
      return `varchar(${c.length ?? MAX_CHAR_LENGTH})` as const;
    case 'char':
      return `char(${c.length ?? MAX_CHAR_LENGTH})` as const;
  }
}

/** The column type CREATE TABLE uses on `dialect`. */
function dataType(c: ColumnSpec, dialect: Dialect): ColumnDataType {
  // SQLite's rowid alias needs exactly INTEGER PRIMARY KEY.
  return c.kind === 'serial' && dialect === 'sqlite' ? 'integer' : canonicalType(c);
}

/** True when a foreign key column of kind `src` can reference `ref` on every dialect: same type and collation. */
function sameColumnType(src: ColumnSpec, ref: ColumnSpec): boolean {
  return canonicalType(src) === canonicalType(ref) && mysqlCollation(src.kind) === mysqlCollation(ref.kind);
}

/** True when the primary key is written inline: SQLite's serial(), since AUTOINCREMENT needs INTEGER PRIMARY KEY. */
function inlineKey(spec: TableSpec, dialect: Dialect): boolean {
  return dialect === 'sqlite' && spec.columns.some((c) => c.kind === 'serial');
}

function columnModifiers(cb: ColumnDefinitionBuilder, c: ColumnSpec, dialect: Dialect): ColumnDefinitionBuilder {
  if (c.kind === 'serial') {
    if (dialect === 'sqlite') return cb.primaryKey().autoIncrement();
    return dialect === 'postgres' ? cb.generatedByDefaultAsIdentity() : cb.autoIncrement();
  }
  let b = cb;
  if (BINARY_KINDS.has(c.kind)) {
    if (mysqlFamily(dialect)) b = cb.modifyFront(MYSQL_BINARY);
    else if (dialect === 'postgres') b = cb.modifyFront(PG_BYTE_ORDER);
  }
  if (c.default !== undefined) b = b.defaultTo(c.default.value);
  if (!c.nullable) b = b.notNull();
  return b;
}

/** The CREATE TABLE statement of `spec` (no IF NOT EXISTS; see the top of this file). */
function createTable<T>(db: Kysely<T>, spec: TableSpec, dialect: Dialect): CreateTableBuilder<string, string> {
  let q: CreateTableBuilder<string, string> = db.schema.createTable(spec.name);
  for (const c of spec.columns) {
    q = q.addColumn(c.name, dataType(c, dialect), (cb) => columnModifiers(cb, c, dialect));
  }
  // A named key everywhere else: PostgreSQL would otherwise name its index <table>_pkey (see the top of the file).
  if (!inlineKey(spec, dialect)) q = q.addPrimaryKeyConstraint(constraintName('pk', spec.name), [...spec.primaryKey.columns]);
  for (const fk of spec.foreignKeys) {
    q = q.addForeignKeyConstraint(constraintName('fk', spec.name, fk.column), [fk.column], fk.refTable, [fk.refColumn], (b) =>
      b.onDelete(fk.onDelete),
    );
  }
  if (mysqlFamily(dialect)) q = q.modifyEnd(MYSQL_TABLE_OPTIONS);
  return q;
}

/** True when `query` returns at least one row. */
async function anyRow<T>(db: Kysely<T>, query: RawBuilder<unknown>): Promise<boolean> {
  return (await query.execute(db)).rows.length > 0;
}

/** True when a base table `name` exists in the current database/schema. */
function tableExists<T>(db: Kysely<T>, dialect: Dialect, name: string): Promise<boolean> {
  if (mysqlFamily(dialect)) {
    return anyRow(db, sql`SELECT 1 AS present FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${name} AND TABLE_TYPE = 'BASE TABLE'`);
  }
  if (dialect === 'postgres') {
    // Qualified with current_schema(), where an unqualified CREATE TABLE puts the table, so that a table of the
    // same name further down the search_path is not taken for it.
    return anyRow(db, sql`SELECT 1 AS present FROM pg_catalog.pg_class
      WHERE oid = to_regclass(format('%I.%I', current_schema(), ${name}::text)) AND relkind IN ('r', 'p')`);
  }
  return anyRow(db, sql`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ${name}`);
}

/** Every base table of the current database/schema. */
async function listTables<T>(db: Kysely<T>, dialect: Dialect): Promise<Set<string>> {
  let query: RawBuilder<{ name: string }>;
  if (mysqlFamily(dialect)) {
    query = sql`SELECT TABLE_NAME AS name FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'`;
  } else if (dialect === 'postgres') {
    query = sql`SELECT c.relname AS name FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p')`;
  } else {
    query = sql`SELECT name FROM sqlite_master WHERE type = 'table'`;
  }
  return new Set((await query.execute(db)).rows.map((r) => String(r.name)));
}

/** The tables `query` lists in its `owner` column, sorted. */
async function owners<T>(db: Kysely<T>, query: RawBuilder<{ owner: string }>): Promise<string[]> {
  return [...new Set((await query.execute(db)).rows.map((r) => String(r.owner)))].sort();
}

/** The tables of the current database/schema that have an index `name` (MySQL allows one per table). */
function indexOwners<T>(db: Kysely<T>, dialect: Dialect, name: string): Promise<string[]> {
  if (mysqlFamily(dialect)) {
    return owners(db, sql`SELECT TABLE_NAME AS owner FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND INDEX_NAME = ${name}`);
  }
  if (dialect === 'postgres') {
    return owners(db, sql`SELECT tablename AS owner FROM pg_catalog.pg_indexes
      WHERE schemaname = current_schema() AND indexname = ${name}`);
  }
  return owners(db, sql`SELECT tbl_name AS owner FROM sqlite_master WHERE type = 'index' AND name = ${name}`);
}

/**
 * The tables of the current database/schema with a constraint `name`. SQLite keeps constraint names only in the
 * table's CREATE statement: this looks for `constraint "<name>" ` exactly as Kysely writes it.
 */
function constraintOwners<T>(db: Kysely<T>, dialect: Dialect, name: string): Promise<string[]> {
  if (mysqlFamily(dialect)) {
    return owners(db, sql`SELECT TABLE_NAME AS owner FROM information_schema.TABLE_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = ${name}`);
  }
  if (dialect === 'postgres') {
    return owners(db, sql`SELECT t.relname AS owner FROM pg_catalog.pg_constraint c
      JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname = current_schema() AND c.conname = ${name}`);
  }
  return owners(db, sql`SELECT name AS owner FROM sqlite_master
    WHERE type = 'table' AND instr(sql, ${`constraint "${name}" `}) > 0`);
}

/** A column as the catalog describes it: the type in {@link canonicalType} spelling, and the MySQL collation. */
interface ColumnFacts {
  type: string;
  collation: string | null;
}

/**
 * Column `column` of table `table` in the current database/schema, or null when there is none. The type is spelled
 * like {@link canonicalType}: `char(n)`, `varchar(n)`, `smallint`, `integer`, `bigint`, `text` (a SQLite INTEGER
 * PRIMARY KEY AUTOINCREMENT, i.e. serial(), reads as `bigint`). The collation is read on MySQL/MariaDB only.
 */
async function columnFacts<T>(db: Kysely<T>, dialect: Dialect, table: string, column: string): Promise<ColumnFacts | null> {
  if (mysqlFamily(dialect)) {
    const { rows } = await sql<{ dt: string; len: unknown; coll: string | null }>`
      SELECT DATA_TYPE AS dt, CHARACTER_MAXIMUM_LENGTH AS len, COLLATION_NAME AS coll FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${table} AND COLUMN_NAME = ${column}`.execute(db);
    const row = rows[0];
    if (row === undefined) return null;
    const dt = String(row.dt).toLowerCase();
    const type = dt === 'char' || dt === 'varchar' ? `${dt}(${Number(row.len)})` : dt === 'int' ? 'integer' : dt;
    return { type, collation: row.coll === null ? null : String(row.coll) };
  }
  if (dialect === 'postgres') {
    const { rows } = await sql<{ type: string }>`SELECT format_type(atttypid, atttypmod) AS type FROM pg_catalog.pg_attribute
      WHERE attrelid = to_regclass(format('%I.%I', current_schema(), ${table}::text))
        AND attname = ${column} AND attnum > 0 AND NOT attisdropped`.execute(db);
    const row = rows[0];
    if (row === undefined) return null;
    const type = String(row.type).replace(/^character varying\b/, 'varchar').replace(/^character\b/, 'char');
    return { type, collation: null };
  }
  const { rows } = await sql<{ type: string; pk: unknown; ddl: string | null }>`
    SELECT c.type AS type, c.pk AS pk, m.sql AS ddl FROM sqlite_master m JOIN pragma_table_info(m.name) c
    WHERE m.type = 'table' AND m.name = ${table} AND c.name = ${column}`.execute(db);
  const row = rows[0];
  if (row === undefined) return null;
  const type = String(row.type).toLowerCase();
  // AUTOINCREMENT belongs to the column's own definition (`"seq" integer primary key autoincrement`), not just
  // anywhere in the table's DDL, where a default or a name could also spell it. `column` is a checked identifier.
  const own = new RegExp(`(?:^|[\\s(,])["\`[]?${column}["\`\\]]?\\s+integer\\s+primary\\s+key\\s+autoincrement\\b`, 'i');
  const serial = type === 'integer' && Number(row.pk) > 0 && own.test(row.ddl ?? '');
  return { type: serial ? 'bigint' : type, collation: null };
}

/** A DomainError SCHEMA_CONFLICT with `meta.reason`; `detail` is bilingual (id / en). */
function conflict(reason: string, detail: string, meta: Record<string, unknown>): DomainError {
  return new DomainError('SCHEMA_CONFLICT', { detail, meta: { reason, ...meta } });
}

/** A foreign key of the catalog: `child` references `parent`; `local` when `child` is in the current schema. */
interface ForeignKeyEdge {
  child: string;
  parent: string;
  local: boolean;
}

/** Every foreign key that references a table of the current database/schema, read from the catalog. */
async function foreignKeyEdges<T>(db: Kysely<T>, dialect: Dialect): Promise<ForeignKeyEdge[]> {
  let query: RawBuilder<{ child: string; parent: string; local: unknown }>;
  if (mysqlFamily(dialect)) {
    query = sql`SELECT TABLE_NAME AS child, REFERENCED_TABLE_NAME AS parent, CONSTRAINT_SCHEMA = DATABASE() AS local
      FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE UNIQUE_CONSTRAINT_SCHEMA = DATABASE()`;
  } else if (dialect === 'postgres') {
    query = sql`SELECT ch.relname AS child, pa.relname AS parent, cn.nspname = current_schema() AS local
      FROM pg_catalog.pg_constraint c
      JOIN pg_catalog.pg_class ch ON ch.oid = c.conrelid
      JOIN pg_catalog.pg_namespace cn ON cn.oid = ch.relnamespace
      JOIN pg_catalog.pg_class pa ON pa.oid = c.confrelid
      JOIN pg_catalog.pg_namespace pn ON pn.oid = pa.relnamespace
      WHERE c.contype = 'f' AND pn.nspname = current_schema()`;
  } else {
    query = sql`SELECT m.name AS child, f."table" AS parent, 1 AS local
      FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) f WHERE m.type = 'table'`;
  }
  return (await query.execute(db)).rows.map((r) => ({
    child: String(r.child),
    parent: String(r.parent),
    local: r.local === true || Number(r.local) === 1,
  }));
}

/**
 * Creates something unless `exists()` says it is there. A create that fails is accepted when, outside a
 * transaction, `exists()` now reports the object (another connection created it at the same time).
 */
async function createUnlessPresent<T>(db: Kysely<T>, exists: () => Promise<boolean>, create: () => Promise<unknown>): Promise<void> {
  if (await exists()) return;
  try {
    await create();
  } catch (error) {
    if (!db.isTransaction) {
      let present = false;
      try {
        present = await exists();
      } catch {
        // the create's error is the one to report
      }
      if (present) return;
    }
    throw error;
  }
  afterDdl();
}

/** The armed `migrate-ddl` fault this process counts for, and the DDL statements it has executed since it was armed. */
let ddlFault: { spec: string; count: number } | null = null;

/**
 * Called right after each DDL statement this process executed (CREATE TABLE, CREATE INDEX, ALTER TABLE): the test
 * fault `migrate-ddl:<k>` (decision D1d-25) throws after the `k`-th one, counted from the moment the fault was armed,
 * so the statement took effect and the migration around it fails (Task 34 migrates once per statement). The count
 * restarts whenever the armed fault changes, and after {@link resetDdlFaults}. Inert outside the test profile.
 */
function afterDdl(): void {
  // Inline, so that a production build folds the condition to false and drops the block (R57).
  if (typeof __BUILD_PROFILE__ !== 'undefined' && __BUILD_PROFILE__ === 'test') {
    const arg = faultArmed(process.env, 'migrate-ddl');
    if (arg === null || !/^[1-9]\d{0,8}$/.test(arg)) {
      ddlFault = null;
      return;
    }
    if (ddlFault === null || ddlFault.spec !== arg) ddlFault = { spec: arg, count: 0 };
    ddlFault.count += 1;
    if (ddlFault.count === Number(arg)) {
      throw new Error(`test fault migrate-ddl:${arg}: DDL statement ${arg} of this process was executed, then failed`);
    }
  }
}

/** Forgets the DDL count of the `migrate-ddl` fault, so a test can arm the same fault again from zero. */
export function resetDdlFaults(): void {
  ddlFault = null;
}

// ---------------------------------------------------------------------------------------------------------------
// The registry

/** The registry's row type, for the query builder (`registry()` casts the caller's Kysely instance to it). */
type RegistryTables = { schema_tables: { name: string; class: string; created_by: string } };

function registry<T>(db: Kysely<T>): Kysely<RegistryTables> {
  return db as unknown as Kysely<RegistryTables>;
}

/**
 * Adds the row (`name`, `cls`, `createdBy`) to schema_tables unless a row for `name` is there already. An existing
 * row keeps its first `created_by`; a different `class` is a SCHEMA_CONFLICT (ruling R19).
 */
async function register<T>(db: Kysely<T>, name: string, cls: TableClass, createdBy: string): Promise<void> {
  const r = registry(db);
  const read = () => r.selectFrom(REGISTRY).select('class').where('name', '=', name).executeTakeFirst();
  let row = await read();
  if (row === undefined) {
    try {
      await r.insertInto(REGISTRY).values({ name, class: cls, created_by: createdBy }).execute();
      return;
    } catch (error) {
      // Another connection registered it at the same time (no ON CONFLICT / ON DUPLICATE KEY in shared SQL).
      if (db.isTransaction || !isDomainError(error) || error.code !== 'UNIQUE_VIOLATION') throw error;
      row = await read();
      if (row === undefined) throw error;
    }
  }
  if (row.class !== cls) {
    throw conflict(
      'class_mismatch',
      `Tabel ${name} terdaftar di schema_tables sebagai kelas ${row.class}, kode menyatakan ${cls} / ` +
        `Table ${name} is registered in schema_tables as class ${row.class}, the code declares ${cls}`,
      { table: name, registered: row.class, declared: cls },
    );
  }
}

/**
 * Checks, before anything is written, what CREATE TABLE would otherwise handle differently per dialect: every
 * foreign key name is free in the database/schema, and every foreign key target column exists with the same type
 * (and, on MySQL/MariaDB, collation) as its source column. Self-references were checked by tableSpec.
 *
 * When a foreign key name turns out to belong to the table itself, another connection created the table after
 * the caller found it missing: there is nothing left to check, and the create step accepts the table (the race
 * recovery described at the top of this file).
 */
async function checkCreatable<T>(db: Kysely<T>, dialect: Dialect, spec: TableSpec): Promise<void> {
  const byName = new Map(spec.columns.map((c) => [c.name, c]));
  for (const fk of spec.foreignKeys) {
    const name = constraintName('fk', spec.name, fk.column);
    const owners = await constraintOwners(db, dialect, name);
    if (owners.includes(spec.name) && (await tableExists(db, dialect, spec.name))) return;
    const taken = owners.filter((t) => t !== spec.name);
    if (taken.length > 0) {
      throw conflict(
        'constraint_name_taken',
        `Nama constraint ${name} sudah dipakai tabel ${taken.join(', ')} / ` +
          `Constraint name ${name} is already used by table ${taken.join(', ')}`,
        { name, table: taken[0] },
      );
    }
    if (fk.refTable === spec.name) continue;
    const target = await columnFacts(db, dialect, fk.refTable, fk.refColumn);
    if (target === null) {
      throw conflict(
        'foreign_key_target_missing',
        `Foreign key ${name} merujuk ${fk.refTable}(${fk.refColumn}), yang tidak ada / ` +
          `Foreign key ${name} references ${fk.refTable}(${fk.refColumn}), which does not exist`,
        { name, refTable: fk.refTable, refColumn: fk.refColumn },
      );
    }
    const src = byName.get(fk.column);
    if (src === undefined) continue; // tableSpec guarantees it exists
    const srcCollation = mysqlFamily(dialect) ? mysqlCollation(src.kind) : null;
    if (target.type !== canonicalType(src) || target.collation !== srcCollation) {
      const source = `${canonicalType(src)}${srcCollation === null ? '' : ` ${srcCollation}`}`;
      const referenced = `${target.type}${target.collation === null ? '' : ` ${target.collation}`}`;
      throw conflict(
        'fk_type_mismatch',
        `Foreign key ${name}: kolom ${spec.name}.${fk.column} (${source}) tidak cocok dengan ` +
          `${fk.refTable}.${fk.refColumn} (${referenced}) / Foreign key ${name}: column ${spec.name}.${fk.column} ` +
          `(${source}) does not match ${fk.refTable}.${fk.refColumn} (${referenced})`,
        { name, table: spec.name, column: fk.column, refTable: fk.refTable, refColumn: fk.refColumn },
      );
    }
  }
}

/**
 * Registers the table of `spec`, then creates it unless it exists (registry first: see the top of this file). A
 * table that has to be created is checked first ({@link checkCreatable}), so a refusal writes nothing.
 */
async function ensureSpec<T>(db: Kysely<T>, dialect: Dialect, spec: TableSpec, cls: TableClass, createdBy: string): Promise<void> {
  if (!(await tableExists(db, dialect, spec.name))) await checkCreatable(db, dialect, spec);
  await register(db, spec.name, cls, createdBy);
  await createUnlessPresent(
    db,
    () => tableExists(db, dialect, spec.name),
    () => createTable(db, spec, dialect).execute(),
  );
}

function checkClass(cls: unknown): TableClass {
  if (!(TABLE_CLASS_NAMES as readonly unknown[]).includes(cls)) {
    throw new TypeError(`table class must be one of ${TABLE_CLASS_NAMES.join(', ')}, got ${JSON.stringify(cls)}`);
  }
  return cls as TableClass;
}

function checkCreatedBy(createdBy: unknown): string {
  if (typeof createdBy !== 'string' || createdBy === '' || [...createdBy].length > MAX_CREATED_BY) {
    throw new TypeError(`createdBy must be a non-empty string of at most ${MAX_CREATED_BY} characters`);
  }
  return createdBy;
}

// ---------------------------------------------------------------------------------------------------------------
// Public API
//
// The exported helpers take `Kysely<any>`, like AltisMigration.up (ruling R45): they work on any instance or
// transaction whatever its table types, and TypeScript cannot infer T of a `Kysely<T>` parameter from a
// `Transaction<DB>` (it gives up on Kysely's conditional method types).

/**
 * Creates the registry `schema_tables(name VARCHAR(191) PK, class VARCHAR(16), created_by VARCHAR(191))` and
 * `schema_meta(id SMALLINT PK, schema_version VARCHAR(32), min_code_version VARCHAR(32), install_id CHAR(26) NULL)`
 * when missing, and registers both with class `migrator`, created_by `bootstrap` (ruling R4). Idempotent; safe to
 * run from several connections at once. `schema_tables.name` is a key191() column (binary collation on MySQL).
 */
export async function ensureBootstrap(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: Kysely<any>,
  dialect: Dialect,
): Promise<void> {
  checkDialect(dialect);
  const registrySpec = tableSpec(REGISTRY, (t) => {
    t.key191('name');
    t.varchar('class', 16);
    t.varchar('created_by', MAX_CREATED_BY);
    t.primaryKey(['name']);
  });
  const metaSpec = tableSpec(META, (t) => {
    t.smallint('id');
    t.varchar('schema_version', 32);
    t.varchar('min_code_version', 32);
    t.char('install_id', 26).nullable();
    t.primaryKey(['id']);
  });
  // The registry cannot list itself before it exists: create it first, then register both tables.
  await createUnlessPresent(
    db,
    () => tableExists(db, dialect, REGISTRY),
    () => createTable(db, registrySpec, dialect).execute(),
  );
  await register(db, REGISTRY, 'migrator', BOOTSTRAP);
  await ensureSpec(db, dialect, metaSpec, 'migrator', BOOTSTRAP);
}

/**
 * Makes sure table `name` exists and is listed in `schema_tables` as (`name`, `cls`, `createdBy`).
 *
 * `build` declares the columns through {@link TableBuilder}; the definition is checked before the database is
 * touched (TypeError for a name, type, key or default that would not work the same on every dialect). Table names
 * are identifiers of at most 60 characters (the key is `pk_<table>`) that neither start with `ix_`, `uq_`, `pk_`
 * or `fk_` nor end in `_seq` (TypeError, R23). When the
 * table already exists it is left as it is (no columns are compared or altered) and registered if it has no row
 * (ruling R18). An existing registry row keeps its `created_by`. Needs {@link ensureBootstrap} to have run.
 *
 * @throws TypeError for a definition that would not be portable (see above; also a foreign key name
 *   `fk_<table>_<column>` longer than 63 characters), before the database is touched
 * @throws DomainError `SCHEMA_CONFLICT` (nothing written) with `meta.reason`:
 *   - `class_mismatch` (`meta.table`, `registered`, `declared`): the registry lists the table under another class
 *     (R19);
 *   - `constraint_name_taken` (`meta.name`, `table`): another table uses a foreign key name;
 *   - `foreign_key_target_missing` (`meta.name`, `refTable`, `refColumn`): a referenced table or column does not
 *     exist;
 *   - `fk_type_mismatch` (`meta.name`, `table`, `column`, `refTable`, `refColumn`): a foreign key column's type
 *     (or, on MySQL/MariaDB, collation) differs from the referenced column's.
 */
export async function ensureTable(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: Kysely<any>,
  dialect: Dialect,
  name: string,
  cls: TableClass,
  createdBy: string,
  build: (t: TableBuilder) => void,
): Promise<void> {
  checkDialect(dialect);
  const spec = tableSpec(tableName(name), build);
  await ensureSpec(db, dialect, spec, checkClass(cls), checkCreatedBy(createdBy));
}

/**
 * Makes sure `table` has an index `name` over `columns` (UNIQUE with `{unique: true}`). An index of that name on
 * that table is accepted as it is, without comparing its columns. Index names are unique per database/schema on
 * every dialect, MySQL/MariaDB included (where the server would accept the same name on another table).
 *
 * Ruling R23: the name starts with `uq_` when `unique` is true and with `ix_` otherwise, so an index never shares
 * a name with a table, a `pk_`/`fk_` constraint or MySQL's `PRIMARY`.
 *
 * @throws TypeError for a name without the right prefix, an invalid table/index/column name or an empty or
 *   repeated column list, before the database is touched
 * @throws DomainError `SCHEMA_CONFLICT` `meta.reason: 'index_name_taken'` (`meta.table`: the table that has it)
 */
export async function ensureIndex(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: Kysely<any>,
  dialect: Dialect,
  table: string,
  name: string,
  columns: string[],
  o: { unique?: boolean } = {},
): Promise<void> {
  checkDialect(dialect);
  identifier('table', table);
  identifier('index', name);
  const prefix = o.unique === true ? 'uq_' : 'ix_';
  if (!name.startsWith(prefix)) {
    throw new TypeError(`${o.unique === true ? 'a unique' : 'an'} index name must start with ${prefix}, got ${name} (ruling R23)`);
  }
  if (!Array.isArray(columns) || columns.length === 0) throw new TypeError(`index ${name} needs at least one column`);
  for (const c of columns) identifier('index column', c);
  if (new Set(columns).size !== columns.length) throw new TypeError(`index ${name} repeats a column`);
  const exists = async () => {
    const taken = await indexOwners(db, dialect, name);
    if (taken.includes(table)) return true;
    if (taken.length > 0) {
      throw conflict(
        'index_name_taken',
        `Nama indeks ${name} sudah dipakai tabel ${taken.join(', ')} / Index name ${name} is already used by table ${taken.join(', ')}`,
        { name, table: taken[0] },
      );
    }
    return false;
  };
  await createUnlessPresent(
    db,
    exists,
    () => {
      const q = db.schema.createIndex(name).on(table).columns([...columns]);
      return (o.unique === true ? q.unique() : q).execute();
    },
  );
}

/**
 * The one column `build` declares for {@link ensureColumn}, checked like a column of ensureTable; a TypeError for a
 * key helper, for no column or more than one, and for a column ALTER TABLE ... ADD COLUMN cannot add the same way on
 * every dialect: a NOT NULL column needs a constant default (SQLite refuses one without, and `text()`/`json()` take
 * none on MySQL, so they can only be added nullable).
 */
function addedColumnSpec(table: string, build: (t: TableBuilder) => ColumnBuilder): ColumnSpec {
  const declared: ColumnSpec[] = [];
  const add: AddColumn = (kind, columnName, length) => {
    const spec = newColumn(kind, columnName, length);
    declared.push(spec);
    return modifiersOf(spec);
  };
  const refuse = (helper: string) => (): never => {
    throw new TypeError(
      `ensureColumn() adds one plain column to ${table}; ${helper}() declares a key, which only ensureTable() can create`,
    );
  };
  const t: TableBuilder = {
    id: refuse('id'),
    serial: refuse('serial'),
    primaryKey: refuse('primaryKey'),
    foreignKey: refuse('foreignKey'),
    ...plainColumnHelpers(add),
  };
  build(t);
  const [spec, ...more] = declared;
  if (spec === undefined || more.length > 0) {
    throw new TypeError(`ensureColumn() adds exactly one column to ${table}, the builder declared ${declared.length}`);
  }
  checkDefault(table, spec);
  if (!spec.nullable && (spec.default === undefined || spec.default.value === null)) {
    throw new TypeError(
      `column ${table}.${spec.name}: a NOT NULL column can only be added with a constant default (SQLite needs one for ` +
        'the rows already there); text() and json() columns, which take no default, can only be added nullable()',
    );
  }
  return spec;
}

/**
 * Makes sure `table` has the column `build` declares: when the catalog lacks it, one `ALTER TABLE <table> ADD COLUMN`
 * adds it (one DDL statement, so MySQL/MariaDB cannot stop halfway through it), at the end of the table, with the
 * type, collation (R17), nullability and default it would have in ensureTable. Rows already there get the default
 * (NULL for a nullable column without one). A column of that name is accepted as it is, without comparing its type
 * (as ensureTable does for a table, ruling R18, and ensureIndex for an index). Expand-only migrations use it to add
 * a column to a shipped table (spec §6.4); the column must also be added to `schema.ts` and `TABLE_COLUMNS`.
 *
 * `build` calls exactly one plain column helper and returns its {@link ColumnBuilder}, e.g.
 * `(t) => t.bool('point_of_no_return').default(0)`.
 *
 * @throws TypeError, before the database is touched, for an invalid table name or dialect, a key helper (`id`,
 *   `serial`, `primaryKey`, `foreignKey`), no column or more than one, a definition ensureTable would refuse (name,
 *   length, default), and a NOT NULL column without a constant default (see {@link addedColumnSpec})
 * @throws DomainError `SCHEMA_CONFLICT` `meta.reason: 'table_missing'` (`meta.table`) when the table does not exist
 */
export async function ensureColumn(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: Kysely<any>,
  dialect: Dialect,
  table: string,
  build: (t: TableBuilder) => ColumnBuilder,
): Promise<void> {
  checkDialect(dialect);
  identifier('table', table);
  const spec = addedColumnSpec(table, build);
  if (!(await tableExists(db, dialect, table))) {
    throw conflict(
      'table_missing',
      `Tabel ${table} tidak ada, kolom ${spec.name} tidak dapat ditambahkan / ` +
        `Table ${table} does not exist, so column ${spec.name} cannot be added`,
      { table, column: spec.name },
    );
  }
  await createUnlessPresent(
    db,
    async () => (await columnFacts(db, dialect, table, spec.name)) !== null,
    () =>
      db.schema
        .alterTable(table)
        .addColumn(spec.name, dataType(spec, dialect), (cb) => columnModifiers(cb, spec, dialect))
        .execute(),
  );
}

/** Every {@link ColumnKind}, for the checks of values a JS caller passes. */
const COLUMN_KINDS: Readonly<Record<ColumnKind, true>> = {
  id: true,
  serial: true,
  ulid: true,
  bool: true,
  money: true,
  timestamp: true,
  date: true,
  json: true,
  key191: true,
  varchar: true,
  char: true,
  text: true,
  smallint: true,
  int: true,
  bigint: true,
};

/** A column as {@link ensureByteOrder} takes it: the column registry's `ColumnSpec` (columns.ts) fits. */
export interface ByteOrderColumn {
  readonly name: string;
  readonly kind: ColumnKind;
  /** The declared length of a `char` or `varchar` column; ignored for the other kinds. */
  readonly length?: number;
}

/** `columns` checked like the columns of ensureTable (TypeError), as specs. */
function byteOrderSpecs(table: string, columns: unknown): ColumnSpec[] {
  if (!Array.isArray(columns)) throw new TypeError(`ensureByteOrder(): the columns of ${table} must be an array`);
  const specs = columns.map((c: unknown): ColumnSpec => {
    const { name, kind, length } = (typeof c === 'object' && c !== null ? c : {}) as Partial<ByteOrderColumn>;
    if (typeof kind !== 'string' || !Object.hasOwn(COLUMN_KINDS, kind)) {
      throw new TypeError(`ensureByteOrder(): column ${table}.${String(name)} has an unknown kind ${JSON.stringify(kind)}`);
    }
    return kind === 'char' || kind === 'varchar' ? newColumn(kind, name, charLength(kind, length)) : newColumn(kind, name);
  });
  if (new Set(specs.map((c) => c.name)).size !== specs.length) {
    throw new TypeError(`ensureByteOrder(): columns of ${table} repeat a column`);
  }
  return specs;
}

/** A column type of {@link canonicalType} as an operand of a `sql` template (Kysely writes it as it does in DDL). */
function typeOperand(type: ColumnDataType): OperationNodeSource {
  return { toOperationNode: () => DataTypeNode.create(type) };
}

/**
 * Makes sure the key and token columns among `columns` of `table` (kinds `id`, `ulid`, `char`, `key191`) compare in
 * byte order: on PostgreSQL, one `ALTER TABLE <table> ALTER COLUMN <c> TYPE <type> COLLATE "C", ...` for the ones
 * the catalog shows in another collation (PostgreSQL rebuilds their indexes and the foreign keys that use them;
 * rows are kept). Nothing is sent when every such column is "C" already. The other kinds are left as they are.
 *
 * Migration 0009 runs it over the columns of migrations 0001–0009 (ruling R1c-15): columns made by an earlier
 * build were in the database's default collation, which no keyset read in byte order can use an index of. Columns
 * made since are "C" from their creation (ensureTable, ensureColumn). MySQL/MariaDB key columns are utf8mb4_bin
 * from their creation (R17) and SQLite compares with BINARY: there it sends nothing at all.
 *
 * Every column is checked before anything is altered.
 *
 * @throws TypeError, before the database is touched, for an unknown dialect, an invalid table or column name, an
 *   unknown kind, a `char`/`varchar` column without a length from 1 to 191, or a repeated column
 * @throws DomainError `SCHEMA_CONFLICT` (PostgreSQL; nothing altered) with `meta.reason`: `table_missing`
 *   (`meta.table`), `column_missing` or `column_type_mismatch` (`meta.table`, `column`): a key or token column
 *   missing, or of another type than its kind's
 */
export async function ensureByteOrder(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: Kysely<any>,
  dialect: Dialect,
  table: string,
  columns: readonly ByteOrderColumn[],
): Promise<void> {
  checkDialect(dialect);
  identifier('table', table);
  const binary = byteOrderSpecs(table, columns).filter((c) => BINARY_KINDS.has(c.kind));
  if (dialect !== 'postgres' || binary.length === 0) return;
  if (!(await tableExists(db, dialect, table))) {
    throw conflict(
      'table_missing',
      `Tabel ${table} tidak ada, urutan byte kolomnya tidak dapat ditetapkan / ` +
        `Table ${table} does not exist, so the byte order of its columns cannot be set`,
      { table },
    );
  }
  const { rows } = await sql<{ name: string; type: string; coll: string | null; ns: string | null }>`
    SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, co.collname AS coll, n.nspname AS ns
    FROM pg_catalog.pg_attribute a
    LEFT JOIN pg_catalog.pg_collation co ON co.oid = a.attcollation
    LEFT JOIN pg_catalog.pg_namespace n ON n.oid = co.collnamespace
    WHERE a.attrelid = to_regclass(format('%I.%I', current_schema(), ${table}::text)) AND a.attnum > 0
      AND NOT a.attisdropped`.execute(db);
  const catalog = new Map(rows.map((r) => [String(r.name), r]));
  const toAlter: ColumnSpec[] = [];
  for (const c of binary) {
    const row = catalog.get(c.name);
    if (row === undefined) {
      throw conflict(
        'column_missing',
        `Kolom ${table}.${c.name} tidak ada / Column ${table}.${c.name} does not exist`,
        { table, column: c.name },
      );
    }
    const type = String(row.type).replace(/^character varying\b/, 'varchar').replace(/^character\b/, 'char');
    if (type !== canonicalType(c)) {
      throw conflict(
        'column_type_mismatch',
        `Kolom ${table}.${c.name} bertipe ${type}, kode menyatakan ${canonicalType(c)} / ` +
          `Column ${table}.${c.name} is ${type}, the code declares ${canonicalType(c)}`,
        { table, column: c.name },
      );
    }
    if (!(row.coll === 'C' && row.ns === 'pg_catalog')) toAlter.push(c);
  }
  const [first, ...rest] = toAlter;
  if (first === undefined) return;
  const byteOrder = (c: ColumnSpec) => sql`${typeOperand(canonicalType(c))} ${PG_BYTE_ORDER}`;
  let q: AlterTableColumnAlteringBuilder = db.schema
    .alterTable(table)
    .alterColumn(first.name, (ac) => ac.setDataType(byteOrder(first)));
  for (const c of rest) q = q.alterColumn(c.name, (ac) => ac.setDataType(byteOrder(c)));
  await q.execute();
  afterDdl();
}

function sqliteInTransaction(): DomainError {
  return conflict(
    'sqlite_transaction',
    'Di SQLite, tabel ALTIS tidak dapat dihapus di dalam transaksi / ' +
      'On SQLite, the ALTIS tables cannot be dropped inside a transaction',
    {},
  );
}

/**
 * Runs `fn` on one pinned SQLite connection with foreign key enforcement off, and turns it back on afterwards.
 * With enforcement on, DROP TABLE runs an implicit DELETE whose RESTRICT checks fail for a table that references
 * itself and holds rows (a RESTRICT action fires per row, deferred or not). The pragma has no effect inside a
 * transaction: a Kysely transaction is refused by the caller, and one begun outside Kysely (a raw BEGIN on a
 * pinned connection) is caught here by reading the pragma back, before anything is dropped.
 */
async function withoutSqliteForeignKeys<T>(db: Kysely<T>, fn: (c: Kysely<T>) => Promise<void>): Promise<void> {
  await db.connection().execute(async (c) => {
    await sql`PRAGMA foreign_keys = OFF`.execute(c);
    try {
      const { rows } = await sql<{ foreign_keys: unknown }>`PRAGMA foreign_keys`.execute(c);
      if (Number(rows[0]?.foreign_keys) !== 0) throw sqliteInTransaction(); // a transaction begun outside Kysely
      await fn(c);
    } finally {
      await sql`PRAGMA foreign_keys = ON`.execute(c);
    }
  });
}

/** What {@link dropRegisteredTables} leaves in place. */
export interface DropRegisteredOptions {
  /** True for a registered table to keep (never asked about `schema_tables` itself). */
  keep?(t: { name: string; createdBy: string }): boolean;
}

/**
 * Drops the dialect's full-text virtual tables (FULLTEXT_VIRTUAL_TABLES: SQLite's `search_fts` and with it its
 * shadow tables), then every table listed in `schema_tables` and deletes its row, children before parents: the order comes from
 * the foreign keys in the database catalog (information_schema, pg_constraint, SQLite's foreign_key_list), not
 * from code. `schema_tables` itself goes last when it is registered (it is, since ensureBootstrap), so the result
 * is a database without any ALTIS table; tables missing from `schema_tables` are never dropped. Rows of registered
 * tables that do not exist are deleted. Resumable: a run that stopped halfway continues where it stopped. Does
 * nothing when `schema_tables` does not exist. On SQLite it must be called outside a transaction: it refuses
 * first (`sqlite_transaction`), even when there is nothing to drop.
 *
 * On SQLite the drops run on one connection with foreign key enforcement off (see
 * {@link withoutSqliteForeignKeys}), which is why it cannot run inside a transaction there; MySQL/MariaDB and
 * PostgreSQL drop a self-referencing table without checking its rows. A Kysely transaction is refused at the
 * start. A transaction begun outside Kysely (a raw BEGIN on a pinned connection) is invisible to that check: it
 * is caught by the PRAGMA read-back, which runs after the existence, name, dependency and cycle checks and still
 * before the first drop.
 *
 * Used by restore (spec §9.10 step 6) and `install:reset`. The caller holds the ops lock, and saves
 * `schema_meta.install_id` first when it must survive (spec §6.5): schema_meta is registered, so it is dropped.
 *
 * `o.keep` (a restore by code that ships no migration of the other lane): a registered table it accepts, judged by
 * its name and `created_by`, is left as it is with its `schema_tables` row, and `schema_tables` then stays too, holding
 * only the rows of the tables kept. A kept table that references a dropped one is refused like an unregistered
 * dependent.
 *
 * @throws DomainError `SCHEMA_CONFLICT`, before dropping anything, with `meta.reason` (and `meta.tables`):
 *   `invalid_registered_name` (a registered name is not a plain identifier: it would be read as `schema.table`),
 *   `unregistered_dependent` (a table outside the registry, or a kept one, references a dropped one),
 *   `foreign_key_cycle` (registered tables reference each other in a cycle), `sqlite_transaction` (SQLite, inside a
 *   transaction)
 */
export async function dropRegisteredTables(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: Kysely<any>,
  dialect: Dialect,
  o: DropRegisteredOptions = {},
): Promise<void> {
  checkDialect(dialect);
  if (dialect === 'sqlite' && db.isTransaction) throw sqliteInTransaction();
  if (!(await tableExists(db, dialect, REGISTRY))) return;
  const rows = await registry(db).selectFrom(REGISTRY).select(['name', 'created_by']).execute();
  // ---- Komunitas K1 (edition lane): the tables `keep` accepts stay, with their rows and schema_tables ----
  const keep = o.keep;
  const kept = new Set(
    keep === undefined ? [] : rows.filter((row) => row.name !== REGISTRY && keep({ name: row.name, createdBy: row.created_by })).map((row) => row.name),
  );
  const registered = new Set(rows.map((row) => row.name).filter((name) => !kept.has(name)));
  const invalid = [...registered].filter((name) => !isIdentifier(name)).sort();
  if (invalid.length > 0) {
    throw conflict(
      'invalid_registered_name',
      `schema_tables memuat nama yang bukan pengenal biasa: ${invalid.join(', ')} / ` +
        `schema_tables holds names that are not plain identifiers: ${invalid.join(', ')}`,
      { tables: invalid },
    );
  }
  const present = await listTables(db, dialect);
  const doomed = new Set([...registered].filter((t) => present.has(t)));
  // Self-references do not constrain the order (and on SQLite enforcement is off during the drops).
  const edges = (await foreignKeyEdges(db, dialect)).filter((e) => e.child !== e.parent && doomed.has(e.parent));

  const outsiders = [...new Set(edges.filter((e) => !e.local || !doomed.has(e.child)).map((e) => e.child))].sort();
  if (outsiders.length > 0) {
    throw conflict(
      'unregistered_dependent',
      `Tabel di luar schema_tables mereferensikan tabel ALTIS: ${outsiders.join(', ')}; hapus foreign key-nya dulu / ` +
        `Tables outside schema_tables reference ALTIS tables: ${outsiders.join(', ')}; drop their foreign keys first`,
      { tables: outsiders },
    );
  }

  // Kahn's algorithm on "child before parent", alphabetical within a round so the order is deterministic.
  const order: string[] = [];
  const remaining = new Set([...doomed].filter((t) => t !== REGISTRY));
  while (remaining.size > 0) {
    const ready = [...remaining].filter((t) => !edges.some((e) => e.parent === t && remaining.has(e.child))).sort();
    if (ready.length === 0) {
      const tables = [...remaining].sort();
      throw conflict(
        'foreign_key_cycle',
        `Foreign key tabel ALTIS membentuk siklus: ${tables.join(', ')} / ` +
          `Foreign keys of ALTIS tables form a cycle: ${tables.join(', ')}`,
        { tables },
      );
    }
    for (const t of ready) {
      order.push(t);
      remaining.delete(t);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const drop = async (k: Kysely<any>): Promise<void> => {
    // ---- Phase 2 (catalog): Task 1 (B6) ----
    // The dialect's full-text virtual tables first (SQLite's FTS5 `search_fts`, which takes its four shadow tables
    // with it; SQLite refuses to drop a shadow table on its own): they are no registered table, and left behind they
    // would keep the database from being empty (install:reset --wipe-db, then a reinstall's DB_NOT_EMPTY).
    for (const v of FULLTEXT_VIRTUAL_TABLES[dialect]) await k.schema.dropTable(v).ifExists().execute();
    const r = registry(k);
    // Rows without a table: a drop that finished before its row was deleted, or a create that failed.
    for (const t of [...registered].filter((name) => !present.has(name))) {
      await r.deleteFrom(REGISTRY).where('name', '=', t).execute();
    }
    for (const t of order) {
      await k.schema.dropTable(t).ifExists().execute();
      await r.deleteFrom(REGISTRY).where('name', '=', t).execute();
    }
    if (registered.has(REGISTRY) && kept.size === 0) await k.schema.dropTable(REGISTRY).ifExists().execute();
  };
  if (dialect === 'sqlite') await withoutSqliteForeignKeys(db, drop);
  else await drop(db);
}
