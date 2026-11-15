import { ensureIndex, ensureTable } from '../ddl.js';
import type { AltisMigration } from '../migrator.js';

// 0049: the popular titles of the OPAC, a volatile aggregate.
//
// - opac_popular_titles: per branch, the titles the OPAC shows that were lent most in the last year, with their number
//   of loans. The daily reports housekeeping rebuilds it from the loans; a title is kept only when enough different
//   borrowers lent it, and no borrower is ever stored in it. It is derived data: not backed up, emptied by a restore and
//   rebuilt by the next run. PK (`record_id`, `branch_id`) serves the catalogue's "most borrowed" order (one record's
//   rows), the index the home page's list (a branch's rows by loans).
//
// Table names and classes are literals: a shipped migration never reads the live registry.

const NAME = '0049_opac_popular';

export const opacPopular: AltisMigration = {
  async up(db, dialect) {
    await ensureTable(db, dialect, 'opac_popular_titles', 'volatile', NAME, (t) => {
      t.ulid('record_id');
      t.ulid('branch_id');
      t.int('loans');
      t.timestamp('refreshed_at');
      t.primaryKey(['record_id', 'branch_id']);
    });
    await ensureIndex(db, dialect, 'opac_popular_titles', 'ix_opac_popular_titles_branch_id_loans', ['branch_id', 'loans']);
  },
};
