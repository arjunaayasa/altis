import type { TableClass } from './ddl.js';
import type { DB, SettingsScope } from './schema.js';

export type { SettingsScope } from './schema.js';

// The table-class registry of spec §6.5: how backup and restore treat each table.
//
// - data: backed up, loaded on restore (§9.10);
// - config: backed up; definitions re-seeded from code, editable fields restored;
// - history: backed up as an archive; the target's rows are kept, archived rows are never loaded into live tables;
// - install: not backed up, kept on restore;
// - volatile: not backed up, emptied on restore;
// - migrator: not backed up, rebuilt by the migrations (schema_meta.install_id is kept).
//
// This is the classification of the current schema: every table of the `DB` type is classified (the compiler
// checks it). Shipped migrations name their classes as literals (ruling R44) and schema_tables records them; a
// test checks that schema_tables agrees with this map after all migrations. Restore drops tables by schema_tables,
// never by this list (spec §6.2).

/** A table of the database. */
export type TableName = keyof DB & string;

/**
 * The class of every table, exactly as the §6.5 registry table lists it (wildcards expanded, ruling R30:
 * `custom_*`, `notifications*`, `schema_migrations*`). `settings` is split by row: its table class is `data`, and
 * each row's class follows its `scope` ({@link SETTINGS_SCOPE_CLASS}).
 */
export const TABLE_CLASSES: Readonly<Record<TableName, TableClass>> = Object.freeze({
  branches: 'data',
  staff_users: 'data',
  staff_recovery_codes: 'data',
  roles: 'data',
  role_permissions: 'data',
  user_roles: 'data',
  settings: 'data',
  files: 'data',
  custom_field_defs: 'data',
  custom_values: 'data',
  notifications: 'data',
  notification_reads: 'data',
  schedules: 'config',
  audit_log: 'history',
  releases_log: 'history',
  backups: 'history',
  license_state: 'install',
  audit_head: 'install',
  sessions: 'volatile',
  remember_tokens: 'volatile',
  password_resets: 'volatile',
  rate_limits: 'volatile',
  idempotency_keys: 'volatile',
  events: 'volatile',
  event_consumers: 'volatile',
  jobs: 'volatile',
  locks: 'volatile',
  upload_sessions: 'volatile',
  schema_migrations: 'migrator',
  schema_migrations_lock: 'migrator',
  schema_meta: 'migrator',
  schema_tables: 'migrator',
  // ---- Phase 2 (catalog): Task 1 (spec §2.3: the search index is volatile, everything else data) ----
  languages: 'data',
  material_types: 'data',
  publishers: 'data',
  agents: 'data',
  subjects: 'data',
  subject_relations: 'data',
  records: 'data',
  record_identifiers: 'data',
  record_marc_extra: 'data',
  record_agents: 'data',
  record_subjects: 'data',
  record_relations: 'data',
  attachments: 'data',
  locations: 'data',
  collection_types: 'data',
  suppliers: 'data',
  items: 'data',
  item_events: 'data',
  pages: 'data',
  page_translations: 'data',
  search_doc: 'volatile',
  search_facet: 'volatile',
  search_term: 'volatile',
  search_state: 'volatile',
  catalog_runs: 'data',
  migration_map: 'data',
  migration_archive: 'data',
  // ---- Komunitas K1 (edition lane): the other migration lane's bookkeeping, made by the runner on every run ----
  schema_migrations_edition: 'migrator',
  schema_migrations_edition_lock: 'migrator',
  // Test builds only (decision D1d-26): the release fixtures' table, made by 9001_test_expand (fixture level 2 and
  // 3). It is not a table of `DB`; a production build folds the condition and drops the entry (R57). The registry
  // describes the union of the fixture levels: what a given database holds is columnsAt(table, <its schema>).
  ...(typeof __BUILD_PROFILE__ !== 'undefined' && __BUILD_PROFILE__ === 'test' ? { test_fixture: 'data' as const } : {}),
} satisfies Record<TableName, TableClass>);

/**
 * The class of a `settings` row by its `scope` (§6.5: `settings[scope=data]` is data, `settings[scope=instance]`
 * is install). Backup and restore (1c) must consult this for every settings row: instance rows are neither backed
 * up nor overwritten by a restore.
 */
export const SETTINGS_SCOPE_CLASS: Readonly<Record<SettingsScope, TableClass>> = Object.freeze({
  data: 'data',
  instance: 'install',
} satisfies Record<SettingsScope, TableClass>);

/**
 * One encrypted column (spec §7.6): its values are `v1:<kid>:<iv>:<ct>` (AES-256-GCM, AAD = `table.column.rowId`).
 * Typed per table: the compiler checks that `column` and `idColumn` are columns of `table` (they are read from
 * `DB`), so a rename in schema.ts breaks the registry until it follows.
 */
export type SecretColumn = {
  [T in TableName]: {
    readonly table: T;
    readonly column: keyof DB[T] & string;
    /** The column that identifies the row (its primary key): the `rowId` of the AAD. */
    readonly idColumn: keyof DB[T] & string;
    /** Only the rows where this flag column is 1 hold a secret; the column is plain data in the others. */
    readonly onlyWhere?: 'is_secret';
  };
}[TableName];

/**
 * The data dictionary of encrypted columns (spec §7.6): the secret box, key rotation and the backup passes
 * work from it instead of from a list of their own. `settings.value` is a secret only on the rows with
 * `is_secret = 1` (ruling R42: NULL once cleared or not carried over by a restore).
 */
export const SECRET_COLUMNS: readonly SecretColumn[] = Object.freeze(
  (
    [
      { table: 'staff_users', column: 'totp_secret_enc', idColumn: 'id' },
      { table: 'settings', column: 'value', idColumn: 'key', onlyWhere: 'is_secret' },
      { table: 'jobs', column: 'secret_param', idColumn: 'id' },
    ] satisfies SecretColumn[]
  ).map((entry) => Object.freeze(entry)),
);
