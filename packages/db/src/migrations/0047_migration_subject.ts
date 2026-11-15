import { ensureColumn, ensureIndex } from '../ddl.js';
import type { AltisMigration } from '../migrator.js';

// 0047: the person a migrated SLiMS row is about (Komunitas, SLiMS members and circulation). Expand only: one nullable
// column without a default, appended to `migration_archive` with one ALTER TABLE ... ADD COLUMN, and its index.
//
// - migration_archive.subject_key: a keyed hash (64 hex characters) naming the member an archived SLiMS row is about
//   (a comment, a hold or a fine that did not become an ALTIS row), so that anonymising that member finds and removes
//   the rows without reading their JSON. Null for a row about no one.
// No table is created, so no class is named here.

export const migrationSubject: AltisMigration = {
  async up(db, dialect) {
    await ensureColumn(db, dialect, 'migration_archive', (t) => t.char('subject_key', 64).nullable());
    await ensureIndex(db, dialect, 'migration_archive', 'ix_migration_archive_subject_key', ['subject_key']);
  },
};
