import { ensureIndex, ensureTable } from '../ddl.js';
import type { AltisMigration } from '../migrator.js';

// 0032: the library's registers for accreditation (Komunitas K1): activities, staff and their trainings, partnerships,
// budgets and documents. All class data, all global (`branch_id` exists but stays null in this edition), each with
// archived_at + version and the trail columns.
//
// - library_activities: promotion, literacy, surveys, stock-takes, … (`kind` from a fixed list), by date.
// - library_staff: the people who run the library; `name` and `appointment_ref` (the appointment decree's number) are
//   personal data. `staff_user_id` links an ALTIS account when there is one (no foreign key: an account is not owned).
// - staff_trainings: a staff member's trainings; they belong to the staff member (CASCADE).
// - library_partnerships: agreements with partners, by start date.
// - library_budgets: one row per year and scope; money in the currency's minor unit with its `currency`. `scope_key` is
//   '' for the whole library; archiving a year renames it to `~<id>`, so the same year can be entered again. It is the
//   only text column of a unique key, so it is key191() (binary on MySQL/MariaDB, byte order on PostgreSQL).
// - library_documents: rules, procedures, programmes, reports, … (`kind` from a fixed list); `aspect_codes` is the JSON
//   list of the aspects a document covers.
// Table names and classes are literals: a shipped migration never reads the live registry.

const NAME = '0032_library_registers';

export const libraryRegisters: AltisMigration = {
  async up(db, dialect) {
    await ensureTable(db, dialect, 'library_activities', 'data', NAME, (t) => {
      t.id();
      t.ulid('branch_id').nullable();
      t.varchar('kind', 32);
      t.varchar('title', 191);
      t.date('held_on');
      t.date('ended_on').nullable();
      t.int('participants').nullable();
      t.varchar('partner', 191).nullable();
      t.bool('uses_library_facility').default(0);
      t.bool('external_speaker').default(0);
      t.text('description').nullable();
      t.timestamp('archived_at').nullable();
      t.int('version').default(0);
      t.timestamp('created_at');
      t.ulid('created_by').nullable();
      t.timestamp('updated_at');
      t.ulid('updated_by').nullable();
    });
    await ensureIndex(db, dialect, 'library_activities', 'ix_library_activities_kind_held_on', ['kind', 'held_on']);
    await ensureIndex(db, dialect, 'library_activities', 'ix_library_activities_held_on', ['held_on']);

    await ensureTable(db, dialect, 'library_staff', 'data', NAME, (t) => {
      t.id();
      t.ulid('branch_id').nullable();
      t.ulid('staff_user_id').nullable();
      t.varchar('name', 191);
      t.varchar('position', 191).nullable();
      t.varchar('role', 16);
      t.bool('is_librarian').default(0);
      t.varchar('employment', 16).nullable();
      t.varchar('education_level', 16).nullable();
      t.bool('education_library');
      t.bool('library_training');
      t.bool('competency_cert');
      t.bool('association_member');
      t.varchar('appointment_ref', 191).nullable();
      t.date('starts_on').nullable();
      t.date('ends_on').nullable();
      t.timestamp('archived_at').nullable();
      t.int('version').default(0);
      t.timestamp('created_at');
      t.ulid('created_by').nullable();
      t.timestamp('updated_at');
      t.ulid('updated_by').nullable();
    });
    await ensureIndex(db, dialect, 'library_staff', 'ix_library_staff_role', ['role']);

    await ensureTable(db, dialect, 'staff_trainings', 'data', NAME, (t) => {
      t.id();
      t.ulid('library_staff_id');
      t.varchar('title', 191);
      t.varchar('organizer', 191).nullable();
      t.date('held_on');
      t.smallint('hours').nullable();
      t.ulid('certificate_file_id').nullable();
      t.timestamp('archived_at').nullable();
      t.int('version').default(0);
      t.timestamp('created_at');
      t.ulid('created_by').nullable();
      t.timestamp('updated_at');
      t.ulid('updated_by').nullable();
      t.foreignKey('library_staff_id', 'library_staff', 'id', { onDelete: 'cascade' });
    });
    await ensureIndex(db, dialect, 'staff_trainings', 'ix_staff_trainings_library_staff_id_held_on', ['library_staff_id', 'held_on']);

    await ensureTable(db, dialect, 'library_partnerships', 'data', NAME, (t) => {
      t.id();
      t.ulid('branch_id').nullable();
      t.varchar('partner', 191);
      t.varchar('kind', 16);
      t.date('starts_on');
      t.date('ends_on').nullable();
      t.text('scope').nullable();
      t.ulid('document_file_id').nullable();
      t.timestamp('archived_at').nullable();
      t.int('version').default(0);
      t.timestamp('created_at');
      t.ulid('created_by').nullable();
      t.timestamp('updated_at');
      t.ulid('updated_by').nullable();
    });
    await ensureIndex(db, dialect, 'library_partnerships', 'ix_library_partnerships_starts_on', ['starts_on']);

    await ensureTable(db, dialect, 'library_budgets', 'data', NAME, (t) => {
      t.id();
      t.key191('scope_key');
      t.ulid('branch_id').nullable();
      t.smallint('year');
      t.bigint('library_minor');
      t.bigint('parent_minor').nullable();
      t.bigint('parent_nonpersonnel_minor').nullable();
      t.bigint('collection_minor').nullable();
      t.bigint('community_minor').nullable();
      t.char('currency', 3);
      t.text('note').nullable();
      t.timestamp('archived_at').nullable();
      t.int('version').default(0);
      t.timestamp('created_at');
      t.ulid('created_by').nullable();
      t.timestamp('updated_at');
      t.ulid('updated_by').nullable();
    });
    await ensureIndex(db, dialect, 'library_budgets', 'uq_library_budgets_scope_key_year', ['scope_key', 'year'], { unique: true });

    await ensureTable(db, dialect, 'library_documents', 'data', NAME, (t) => {
      t.id();
      t.ulid('branch_id').nullable();
      t.varchar('kind', 32);
      t.varchar('title', 191);
      t.varchar('reference', 191).nullable();
      t.date('issued_on').nullable();
      t.varchar('issued_by', 191).nullable();
      t.json('aspect_codes').nullable();
      t.date('valid_until').nullable();
      t.ulid('file_id').nullable();
      t.timestamp('archived_at').nullable();
      t.int('version').default(0);
      t.timestamp('created_at');
      t.ulid('created_by').nullable();
      t.timestamp('updated_at');
      t.ulid('updated_by').nullable();
    });
    await ensureIndex(db, dialect, 'library_documents', 'ix_library_documents_kind', ['kind']);
  },
};
