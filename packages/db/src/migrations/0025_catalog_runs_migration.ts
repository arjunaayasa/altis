import { ensureIndex, ensureTable } from '../ddl.js';
import type { AltisMigration } from '../migrator.js';

// 0025: catalog operations and the migration bookkeeping (Phase 2 spec §2.2, §5.3, §11). Class data.
//
// - catalog_runs: one row per import, export, migration or dedupe scan; `options` (JSON, never a secret) and `summary`
//   (JSON counters) are capped by their writers at 60 000 bytes (MySQL TEXT). The report is a `files` row
//   (`context 'catalog.report'`, decision P2-23); an export's file lives in `DATA_DIR/exports/`.
// - migration_map: the ALTIS id of every row imported or migrated, keyed by its source (`slims`, `import:<runId>`),
//   source entity and legacy key, so a repeated slice never duplicates (§5.3, §11.3).
// - migration_archive: source rows kept verbatim (JSON) that have no ALTIS home.
// Every text column of a primary or unique key is key191() (R39b, P2-09): source, entity, legacy_key, table_name.

const NAME = '0025_catalog_runs_migration';

export const catalogRunsMigration: AltisMigration = {
  async up(db, dialect) {
    await ensureTable(db, dialect, 'catalog_runs', 'data', NAME, (t) => {
      t.id();
      t.varchar('kind', 16);
      t.varchar('status', 16);
      t.bool('dry_run').default(0);
      t.varchar('format', 32).nullable();
      t.json('options');
      t.json('summary');
      t.ulid('report_file_id').nullable();
      t.varchar('output_name', 191).nullable();
      t.bigint('output_size').nullable();
      t.timestamp('expires_at').nullable();
      t.ulid('job_id').nullable();
      t.timestamp('created_at');
      t.ulid('created_by').nullable();
      t.timestamp('finished_at').nullable();
    });
    await ensureIndex(db, dialect, 'catalog_runs', 'ix_catalog_runs_kind_created_at', ['kind', 'created_at']);

    await ensureTable(db, dialect, 'migration_map', 'data', NAME, (t) => {
      t.key191('source');
      t.key191('entity');
      t.key191('legacy_key');
      t.ulid('target_id');
      t.ulid('run_id');
      t.primaryKey(['source', 'entity', 'legacy_key']);
    });

    await ensureTable(db, dialect, 'migration_archive', 'data', NAME, (t) => {
      t.id();
      t.ulid('run_id');
      t.key191('source');
      t.key191('table_name');
      t.key191('legacy_key');
      t.text('row_json');
      t.timestamp('created_at');
    });
    await ensureIndex(
      db,
      dialect,
      'migration_archive',
      'uq_migration_archive_source_table_name_legacy_key',
      ['source', 'table_name', 'legacy_key'],
      { unique: true },
    );
  },
};
