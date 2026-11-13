import { ensureColumn, ensureIndex } from '../ddl.js';
import type { AltisMigration } from '../migrator.js';

// 0033: the catalogue fields accreditation reads (Komunitas K1). Expand only: five nullable columns without a default,
// each appended to the end of its table with one ALTER TABLE ... ADD COLUMN, and one index.
//
// - records.audience: who a title is for (general, children, special needs).
// - records.local_work: who made a local work (student, teacher, staff, school, local author).
// - records.local_work_kind: what kind of local work it is (written work, clipping, short stories, …).
// - records.reference_kind: the kind of reference work (encyclopedia, dictionary, atlas, …).
// - items.input_on: the date a copy was entered in the source system (YYYY-MM-DD in the library's time zone), filled
//   by a migration only; one step of the acquisition-date chain.
// - ix_items_received_date_inventory_no: the accession register lists copies by receiving date, then inventory number,
//   page by page; the index serves that order.
// None of these changes a record's public representation. No table is created, so no class is named here.

export const catalogAccredFields: AltisMigration = {
  async up(db, dialect) {
    await ensureColumn(db, dialect, 'records', (t) => t.varchar('audience', 16).nullable());
    await ensureColumn(db, dialect, 'records', (t) => t.varchar('local_work', 16).nullable());
    await ensureColumn(db, dialect, 'records', (t) => t.varchar('local_work_kind', 16).nullable());
    await ensureColumn(db, dialect, 'records', (t) => t.varchar('reference_kind', 16).nullable());
    await ensureColumn(db, dialect, 'items', (t) => t.date('input_on').nullable());
    await ensureIndex(db, dialect, 'items', 'ix_items_received_date_inventory_no', ['received_date', 'inventory_no']);
  },
};
