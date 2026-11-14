import { ensureIndex, ensureTable } from '../ddl.js';
import type { AltisMigration } from '../migrator.js';

// 0042: the circulation core (Komunitas): the library calendar, items read in place and numbered clearance letters. All
// class data and global, apart from the uses, which belong to the branch where the item was read.
//
// - calendars: the days the library is closed. `kind` says which fields count: `weekly` a weekday (`weekday`, ISO 1
//   Monday … 7 Sunday), `dates` a date range (`date_from` … `date_to`, both included), `yearly` a range of days of the
//   year (`month_day_from` … `month_day_to`, `MM-DD`, within one year). `branch_id` is null for every branch, and always
//   null in this edition. Due dates skip these days.
// - item_uses: one item read in the library (scanned at the desk in "read in place" mode), anonymous; it keeps the
//   statistics dimensions of that moment (`stat_*`). `item_id` and `record_id` may become null when a migration loses
//   the item; `member_id` stays null at the desk.
// - member_clearances: one numbered clearance letter (the member has no open loan, no unpaid balance, no hold waiting).
//   The number is the next `seq` of the library's year, unique per year, never reused: a voided letter keeps its
//   number (`voided_at`, `voided_by`, `void_reason`).
//
// Table names and classes are literals: a shipped migration never reads the live registry.

const NAME = '0042_circulation_core';

export const circulationCore: AltisMigration = {
  async up(db, dialect) {
    await ensureTable(db, dialect, 'calendars', 'data', NAME, (t) => {
      t.id();
      t.ulid('branch_id').nullable();
      t.varchar('kind', 16);
      t.smallint('weekday').nullable();
      t.date('date_from').nullable();
      t.date('date_to').nullable();
      t.char('month_day_from', 5).nullable();
      t.char('month_day_to', 5).nullable();
      t.varchar('name', 191);
      t.timestamp('archived_at').nullable();
      t.int('version').default(0);
      t.timestamp('created_at');
      t.ulid('created_by').nullable();
      t.timestamp('updated_at');
      t.ulid('updated_by').nullable();
    });
    await ensureIndex(db, dialect, 'calendars', 'ix_calendars_branch_id_kind', ['branch_id', 'kind']);

    await ensureTable(db, dialect, 'item_uses', 'data', NAME, (t) => {
      t.id();
      t.ulid('item_id').nullable();
      t.ulid('record_id').nullable();
      t.ulid('branch_id');
      t.date('used_on');
      t.timestamp('used_at');
      t.ulid('member_id').nullable();
      t.varchar('stat_ddc', 8).nullable();
      t.ulid('stat_material_type_id').nullable();
      t.ulid('stat_collection_type_id').nullable();
      t.varchar('source', 16);
      t.ulid('created_by').nullable();
    });
    await ensureIndex(db, dialect, 'item_uses', 'ix_item_uses_used_on', ['used_on']);
    await ensureIndex(db, dialect, 'item_uses', 'ix_item_uses_item_id_used_on', ['item_id', 'used_on']);
    await ensureIndex(db, dialect, 'item_uses', 'ix_item_uses_record_id_used_on', ['record_id', 'used_on']);

    await ensureTable(db, dialect, 'member_clearances', 'data', NAME, (t) => {
      t.id();
      t.ulid('member_id');
      t.smallint('year');
      t.int('seq');
      t.varchar('number_display', 64);
      t.date('issued_on');
      t.timestamp('issued_at');
      t.ulid('issued_by');
      t.varchar('purpose', 16);
      t.timestamp('voided_at').nullable();
      t.ulid('voided_by').nullable();
      t.varchar('void_reason', 191).nullable();
    });
    await ensureIndex(db, dialect, 'member_clearances', 'uq_member_clearances_year_seq', ['year', 'seq'], { unique: true });
    await ensureIndex(db, dialect, 'member_clearances', 'ix_member_clearances_member_id', ['member_id']);
  },
};
