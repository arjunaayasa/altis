import { ensureTable } from '../ddl.js';
import type { AltisMigration } from '../migrator.js';

// 0001: named locks (spec §6.3). The meta tables (schema_tables, schema_meta) and Kysely's schema_migrations /
// schema_migrations_lock are made by the runner itself before any migration (rulings R4, R27), so this migration
// does not create them.

const NAME = '0001_meta_and_locks';

export const metaAndLocks: AltisMigration = {
  async up(db, dialect) {
    // Claimed with a conditional UPDATE ... WHERE until < now (spec §6.3).
    await ensureTable(db, dialect, 'locks', 'volatile', NAME, (t) => {
      t.key191('name');
      // Binary (ruling R48): compared for identity in WHERE clauses, exactly on every dialect.
      t.key191('owner');
      t.timestamp('until');
      t.primaryKey(['name']);
    });
  },
};
