import { ensureIndex, ensureTable } from '../ddl.js';
import type { AltisMigration } from '../migrator.js';

// 0048: stocktake (inventarisasi), class data, scoped to a branch.
//
// - stocktakes: one session of a branch with its scope (JSON: locations, collection types, material types, class
//   prefixes), its status (preparing → active → finishing → finished, or cancelled) and its running counts.
//   `active_key` is the branch id while the session is preparing, active or finishing and null afterwards: with a plain
//   UNIQUE index it allows one live session per branch on every engine (many NULLs are allowed). `options` holds what
//   the finish was asked to do (`{markMissing, restoreFound}`); `minutes_file_id` the stored minutes, `report_file_id`
//   a migrated session's old report. `source` is `altis` or `migrated`.
// - stocktake_items: one row per copy in the session: the copies the scope expected (`expected = 1`, prepared with a
//   snapshot of their location, status, class and collection type) and the unexpected ones scanned (`expected = 0`).
//   `state` is pending | on_loan | found | misplaced | unexpected; `result` what the finish did to the copy.
//   `scanned_by_name` (personal data) holds the officer's name of a migrated session only.
// - stocktake_unknown_codes: the scanned codes that name no copy, once per code with how often they were seen.
//
// Table names and classes are literals: a shipped migration never reads the live registry.

const NAME = '0048_stocktakes';

export const stocktakes: AltisMigration = {
  async up(db, dialect) {
    await ensureTable(db, dialect, 'stocktakes', 'data', NAME, (t) => {
      t.id();
      t.ulid('branch_id');
      t.varchar('name', 191);
      t.text('scope');
      t.varchar('status', 16);
      t.ulid('active_key').nullable();
      t.text('options').nullable();
      t.int('total').default(0);
      t.int('found').default(0);
      t.int('misplaced').default(0);
      t.int('on_loan').default(0);
      t.int('unexpected').default(0);
      t.int('unknown_codes').default(0);
      t.timestamp('started_at');
      t.ulid('started_by').nullable();
      t.timestamp('finished_at').nullable();
      t.ulid('finished_by').nullable();
      t.ulid('minutes_file_id').nullable();
      t.ulid('report_file_id').nullable();
      t.varchar('source', 16);
      t.int('version').default(0);
      t.timestamp('created_at');
      t.ulid('created_by').nullable();
      t.timestamp('updated_at');
      t.ulid('updated_by').nullable();
    });
    await ensureIndex(db, dialect, 'stocktakes', 'uq_stocktakes_active_key', ['active_key'], { unique: true });
    await ensureIndex(db, dialect, 'stocktakes', 'ix_stocktakes_branch_id_started_at', ['branch_id', 'started_at']);

    await ensureTable(db, dialect, 'stocktake_items', 'data', NAME, (t) => {
      t.ulid('stocktake_id');
      t.ulid('item_id');
      t.bool('expected');
      t.varchar('state', 16);
      t.ulid('expected_location_id').nullable();
      t.varchar('expected_status', 16).nullable();
      t.varchar('stat_ddc', 8).nullable();
      t.ulid('collection_type_id').nullable();
      t.timestamp('scanned_at').nullable();
      t.ulid('scanned_by').nullable();
      t.varchar('scanned_by_name', 191).nullable();
      t.ulid('scanned_location_id').nullable();
      t.varchar('result', 16).nullable();
      t.primaryKey(['stocktake_id', 'item_id']);
      t.foreignKey('stocktake_id', 'stocktakes', 'id', { onDelete: 'cascade' });
    });
    await ensureIndex(db, dialect, 'stocktake_items', 'ix_stocktake_items_stocktake_id_state', ['stocktake_id', 'state']);
    await ensureIndex(db, dialect, 'stocktake_items', 'ix_stocktake_items_stocktake_id_scanned_by', ['stocktake_id', 'scanned_by']);

    await ensureTable(db, dialect, 'stocktake_unknown_codes', 'data', NAME, (t) => {
      t.ulid('stocktake_id');
      t.key191('code_key');
      t.varchar('code_display', 64);
      t.timestamp('first_at');
      t.timestamp('last_at');
      t.int('seen').default(1);
      t.ulid('scanned_by').nullable();
      t.primaryKey(['stocktake_id', 'code_key']);
      t.foreignKey('stocktake_id', 'stocktakes', 'id', { onDelete: 'cascade' });
    });
  },
};
