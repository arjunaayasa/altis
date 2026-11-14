import type { AltisMigration } from '../migrator.js';
import { ensureIndex, ensureTable } from '../ddl.js';

// 0044: the member area of the OPAC (Komunitas). Both tables are class data and global.
//
// - member_bookmarks: the titles a member marked ("Tandai") on the OPAC, at most 200 per member (the code keeps the
//   limit). One row per member and record (the primary key); they belong to the member (CASCADE), and a record that is
//   archived later is hidden from the list, not deleted.
// - attachment_member_types: the member types that may open an attachment whose access is `members`. They belong to
//   the attachment (CASCADE); no row for an attachment means every signed-in member may open it.
//
// Table names and classes are literals: a shipped migration never reads the live registry.

const NAME = '0044_member_area';

export const memberArea: AltisMigration = {
  async up(db, dialect) {
    await ensureTable(db, dialect, 'member_bookmarks', 'data', NAME, (t) => {
      t.ulid('member_id');
      t.ulid('record_id');
      t.timestamp('created_at');
      t.primaryKey(['member_id', 'record_id']);
      t.foreignKey('member_id', 'members', 'id', { onDelete: 'cascade' });
    });
    await ensureIndex(db, dialect, 'member_bookmarks', 'ix_member_bookmarks_record_id', ['record_id']);

    await ensureTable(db, dialect, 'attachment_member_types', 'data', NAME, (t) => {
      t.ulid('attachment_id');
      t.ulid('member_type_id');
      t.primaryKey(['attachment_id', 'member_type_id']);
      t.foreignKey('attachment_id', 'attachments', 'id', { onDelete: 'cascade' });
    });
    await ensureIndex(db, dialect, 'attachment_member_types', 'ix_attachment_member_types_member_type_id', ['member_type_id']);
  },
};
