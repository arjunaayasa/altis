export { DIALECTS, MYSQL_SQL_MODE, connect } from './connect.js';
export type { ConnectOptions, DbConfig, DbHandle, Dialect } from './connect.js';
export { isConnectionLost, isDriverError, normalizeDbError } from './db-errors.js';
export type { DbUnavailableReason } from './db-errors.js';
export { MIN_SERVER_VERSIONS, checkServer, listCatalogTables, meetsMinimum, parseServerVersion } from './server-check.js';
export type { ServerCheck, ServerFlavor, ServerProblem, VersionTriple } from './server-check.js';
export { assertOutsideTx, withTx } from './tx.js';
export type { WithTxOptions } from './tx.js';
export { countRows } from './aggregate.js';
export { claimLock, increment, releaseLock, upsert } from './concurrency.js';
export type { UpsertOutcome } from './concurrency.js';
export { AUDIT_GENESIS_HASH, auditAppend, verifyAuditChain } from './audit.js';
export type { AuditAppendResult, AuditChainPartial, AuditChainResult, AuditEntry, VerifyAuditChainOptions } from './audit.js';
export { TABLE_CLASS_NAMES, dropRegisteredTables, ensureBootstrap, ensureIndex, ensureTable } from './ddl.js';
export type { ColumnBuilder, OnDeleteAction, TableBuilder, TableClass } from './ddl.js';
export {
  MIGRATION_NAME,
  MIGRATOR_TABLES,
  MigrationError,
  migrateUpOne,
  readSchemaMetaMirror,
  runMigrations,
} from './migrator.js';
export type {
  AltisMigration,
  MigrationFailureMeta,
  MigrationHandle,
  MigrationMode,
  MigrationOptions,
  MigrationOutcome,
  SchemaMetaMirror,
} from './migrator.js';
export { PHASE1_MIGRATIONS } from './migrations/index.js';
export { SECRET_COLUMNS, SETTINGS_SCOPE_CLASS, TABLE_CLASSES } from './registry.js';
export type { SecretColumn, SettingsScope, TableName } from './registry.js';
export type * from './schema.js';
// Phase 1c, Task 3: operations primitives (column additions, column registry, load order, keyset batches,
// snapshot reads, SQLite copies).
export { ensureColumn } from './ddl.js';
export { RUNNER_TABLES_SINCE, TABLE_COLUMNS, TABLE_KEYS, columnsAt } from './columns.js';
export type { ColumnKind, ColumnSpec, ForeignKeyRef, TableKeySpec } from './columns.js';
export { migrationsUpTo, tableLoadOrder } from './order.js';
export { readPkBatch, readSnapshot } from './batches.js';
export type { PkValue } from './batches.js';
export { checkpointSqliteFile, connectSqliteFile, sqliteSnapshotTo } from './sqlite-file.js';
export type { ClaimLockOptions } from './concurrency.js';
// Phase 1c, Task 25: the SQLite owner record and the swap lock's refusal (a restore's work file swap).
export { readSqliteOwner, removeSqliteOwner, sqliteProcessStatus, sqliteSwapUnavailable } from './connect.js';
export type { SqliteProcessRecord } from './connect.js';
// Phase 1d, Task 6: the database's catalog for the generic exporter (spec §9.8 row 3, schemaHold) and keyset batches of
// a table it describes.
export { readSchemaTableEntries, readSchemaTables, readTableColumns, readTableKeys } from './catalog.js';
export type { CatalogColumn, CatalogFamily, CatalogForeignKey, CatalogKeys, SchemaTableEntry } from './catalog.js';
export { readKeyedBatch } from './batches.js';
// Phase 1d, Task 9: release fixtures (D1d-26), migration progress (1D-03), the migrate-ddl fault's reset.
export { buildFixtureLevel, migrationsForLevel, releaseMigrations } from './migrations/index.js';
export type { TestFixtureLevel } from './migrations/index.js';
export type { MigrationProgress } from './migrator.js';
export { resetDdlFaults } from './ddl.js';
// ---- Phase 2 (catalog): Task 1 (the registered full-text helpers; the foreign MySQL client stub, B5) ----
export { FULLTEXT_DIALECT_OBJECTS, FULLTEXT_VIRTUAL_TABLES, PG_SEARCH_VECTOR_SQL, ensureFullText, fullTextFamily } from './fulltext.js';
export type { FullTextFamily, FullTextSpec } from './fulltext.js';
export { openForeignMysql } from './foreign-mysql.js';
export type { ForeignMysql, ForeignMysqlConfig } from './foreign-mysql.js';
// ---- Phase 2 (catalog): Task 15 (the query side of the registered full-text helpers) ----
export { fullTextClear, fullTextDeleteRows, fullTextExcluded, fullTextInsertRows, fullTextRanked, fullTextWhere } from './fulltext-query.js';
export type { FtExpr, FullTextField, FullTextRow } from './fulltext-query.js';
// ---- Komunitas K1 (tables): grouped counts and the personal-data dictionary ----
export { AggregateOverflowError, countDistinctGrouped, countGrouped, datePrefix, sumGrouped } from './aggregate.js';
export type { GroupKeys } from './aggregate.js';
export { PERSONAL_COLUMNS, isPersonalColumn, personalLogKeys } from './registry.js';
export type { PersonalCategory, PersonalColumn } from './registry.js';
