import { ensureTable } from '../ddl.js';
import type { AltisMigration } from '../migrator.js';

// 0050: the loans per class of the OPAC home page, a volatile aggregate.
//
// - opac_class_activity: the classes whose members borrowed most in the last year, ranked, with their number of loans
//   and of different titles. The daily reports housekeeping rebuilds it from the loans' class snapshot; a class is kept
//   only when enough different members of it borrowed, and no member is ever stored in it (no id, no name, no count of
//   a single person). It is derived data: not backed up, emptied by a restore and rebuilt by the next run. PK `place`
//   (1 the most loans): the home page reads its first rows in that order.
//
// Table names and classes are literals: a shipped migration never reads the live registry.

const NAME = '0050_opac_class_activity';

export const opacClassActivity: AltisMigration = {
  async up(db, dialect) {
    await ensureTable(db, dialect, 'opac_class_activity', 'volatile', NAME, (t) => {
      t.int('place');
      t.varchar('class_name', 64);
      t.int('loans');
      t.int('titles');
      t.timestamp('refreshed_at');
      t.primaryKey(['place']);
    });
  },
};
