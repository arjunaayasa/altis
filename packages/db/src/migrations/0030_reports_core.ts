import { ensureIndex, ensureTable } from '../ddl.js';
import type { AltisMigration } from '../migrator.js';

// 0030: report runs (Komunitas K1). Class volatile: a run and its file are kept for a few days and swept by the
// reports housekeeping; a restore empties the table.
//
// - report_runs: one export of a report definition (`report_id`, the id of a definition in the code) in one format.
//   `locale` is the language the export is written in; `params` the stored parameters as JSON (at most 8 000 bytes,
//   checked by the code); `personal` 1 when the export holds personal data. `output_name` is the file under the
//   reports export folder once the run succeeded; `non_latin_rows` counts the PDF rows whose characters the PDF fonts
//   could not print. The creator's runs are listed newest first (created_by, created_at); expired runs are found by
//   expires_at.
// Table name and class are literals: a shipped migration never reads the live registry.

const NAME = '0030_reports_core';

export const reportsCore: AltisMigration = {
  async up(db, dialect) {
    await ensureTable(db, dialect, 'report_runs', 'volatile', NAME, (t) => {
      t.id();
      t.varchar('report_id', 64);
      t.varchar('format', 8);
      t.char('locale', 2);
      t.json('params');
      t.bool('personal');
      t.varchar('status', 16);
      t.int('row_count').nullable();
      t.int('non_latin_rows').nullable();
      t.varchar('output_name', 191).nullable();
      t.bigint('output_size').nullable();
      t.varchar('error_code', 64).nullable();
      t.ulid('job_id').nullable();
      t.timestamp('expires_at').nullable();
      t.timestamp('created_at');
      t.ulid('created_by').nullable();
      t.timestamp('finished_at').nullable();
    });
    await ensureIndex(db, dialect, 'report_runs', 'ix_report_runs_created_by_created_at', ['created_by', 'created_at']);
    await ensureIndex(db, dialect, 'report_runs', 'ix_report_runs_expires_at', ['expires_at']);
  },
};
