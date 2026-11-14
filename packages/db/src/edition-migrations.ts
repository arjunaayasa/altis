import type { Kysely } from 'kysely';
import { countRows } from './aggregate.js';
import { readSchemaTableOrigins } from './catalog.js';
import type { AltisMigration } from './migrator.js';
import type { DB } from './schema.js';

// Migrasi jalur lain: a second, separate lane of migrations that another edition built on this code may ship beside
// the core lane (`PHASE1_MIGRATIONS`), without ever changing the core lane's rules.
//
// - Names are `eNNNN_slug` (EDITION_MIGRATION_NAME), each number used once; the core lane keeps `NNNN_slug`.
// - Bookkeeping is separate: the lane is recorded in `schema_migrations_edition` and locked through
//   `schema_migrations_edition_lock` (EDITION_MIGRATOR_TABLES), which the runner makes on every run (class
//   `migrator`), so `schema_migrations` never holds a name of this lane and the core lane's decision never sees one.
// - A migration of this lane only makes tables of its own: `schema_tables.created_by` holds its name, and it never
//   changes a core table nor references one with a foreign key.
// - `schema_meta` follows the core lane only: this lane never moves `schema_version` and never raises
//   `min_code_version` (a `contract` of one of its migrations is ignored).
//
// This edition ships none: EDITION_MIGRATIONS is empty, so the runner never reads `schema_migrations_edition` for its
// decision and never runs the lane. A database that holds rows of the lane or tables it made is reported by
// editionLaneState (Diagnostik), left out of the catalog export of a `pre_update` backup, and refused by a restore or an
// update revert (BACKUP_EDITION_TABLES), since this code cannot tell what those tables need.

/** The migrations of the other lane this code ships, by name: none in this edition. */
export const EDITION_MIGRATIONS: Readonly<Record<string, AltisMigration>> = Object.freeze({});

/** Names of the other lane: `e`, four digits, an underscore, then lower-case letters, digits and underscores. */
export const EDITION_MIGRATION_NAME = /^e\d{4}_[a-z0-9_]+$/;

/** The bookkeeping tables of the other lane: its applied names and its lock (class `migrator`). */
export const EDITION_MIGRATOR_TABLES = ['schema_migrations_edition', 'schema_migrations_edition_lock'] as const;

/** Whether a `schema_tables.created_by` value names a migration of the other lane. */
export function isEditionCreatedBy(createdBy: string): boolean {
  return EDITION_MIGRATION_NAME.test(createdBy);
}

/**
 * What the database holds of the other lane: the rows of `schema_migrations_edition` (0 when that table is not
 * registered yet, as before this code first migrated the database) and the tables `schema_tables` records as made
 * by one of its migrations, sorted by name. Reads only; `db` may be any instance or transaction on an ALTIS database.
 */
export async function editionLaneState(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: Kysely<any>,
): Promise<{ rows: number; tables: string[] }> {
  const origins = await readSchemaTableOrigins(db);
  const tables = origins.filter((o) => isEditionCreatedBy(o.createdBy)).map((o) => o.name);
  if (!origins.some((o) => o.name === EDITION_MIGRATOR_TABLES[0])) return { rows: 0, tables };
  const rows = await countRows((db as Kysely<DB>).selectFrom('schema_migrations_edition').select('name'));
  return { rows, tables };
}
