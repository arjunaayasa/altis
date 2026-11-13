import { ensureIndex, ensureTable } from '../ddl.js';
import type { AltisMigration } from '../migrator.js';

// 0031: accreditation periods, answers, results, snapshots, evidence and monthly usage (Komunitas K1). Every table is
// global (no branch scope in this edition: `accred_periods.branch_id` exists but stays null). All class data except
// accred_results, which is computed again from the data and so volatile.
//
// - accred_periods: one assessment period with its instrument, its profile (JSON, at most 16 000 bytes; it names the
//   school and library heads, so its fields are registered as personal data), population, facilities and services.
//   `status` is open or frozen; a frozen period keeps its snapshot.
// - accred_answers: the librarian's answer per indicator of a period; they belong to the period (CASCADE).
// - accred_results: the computed value of each indicator of a period (`_meta` holds the evaluation's state). No
//   foreign key: computed rows are rebuilt, never owned.
// - accred_snapshots: a frozen copy of the results and score of a period; they belong to the period (CASCADE).
// - accred_evidence: a file attached as evidence to an indicator of a period, or to a register row (`entity`,
//   `entity_id`). No foreign key: the file and the register row are linked by id only.
// - usage_stats: monthly usage cells (visits, loans, …) per source, metric, span, branch and group; `branch_key` and
//   `group_key` are '' for "all".
// - usage_group_map: how a member type of the source system counts in the population groups.
//
// Every text column of a primary or unique key is key191() (binary on MySQL/MariaDB, byte order on PostgreSQL); the
// code enforces the narrower width each one really has (indicator codes 16, group keys 48, branch keys 26). The one
// exception is usage_stats.source and usage_stats.metric: with four 191-character key columns and the two dates, that
// six-column primary key would be a few bytes under MySQL's 3 072-byte index limit, so these two lower-case codes,
// which only ALTIS writes, stay plain varchar.
// Table names and classes are literals: a shipped migration never reads the live registry.

const NAME = '0031_accreditation';

export const accreditation: AltisMigration = {
  async up(db, dialect) {
    await ensureTable(db, dialect, 'accred_periods', 'data', NAME, (t) => {
      t.id();
      t.ulid('branch_id').nullable();
      t.varchar('name', 191);
      t.varchar('kind', 16);
      t.date('starts_on');
      t.date('ends_on');
      t.varchar('instrument_id', 32);
      t.varchar('status', 16);
      t.timestamp('frozen_at').nullable();
      t.ulid('frozen_by').nullable();
      t.json('profile');
      t.int('students').nullable();
      t.int('teachers').nullable();
      t.int('edu_staff').nullable();
      t.int('classes').nullable();
      t.int('population_served').nullable();
      t.int('teachers_using').nullable();
      t.bool('all_registered_confirmed').default(0);
      t.smallint('user_pcs').nullable();
      t.smallint('staff_pcs').nullable();
      t.smallint('ict_devices').nullable();
      t.smallint('scanners').nullable();
      t.int('floor_m2').nullable();
      t.int('bandwidth_mbps').nullable();
      t.smallint('hours_per_week').nullable();
      t.json('services').nullable();
      t.varchar('external_website_url', 191).nullable();
      t.timestamp('archived_at').nullable();
      t.int('version').default(0);
      t.timestamp('created_at');
      t.ulid('created_by').nullable();
      t.timestamp('updated_at');
      t.ulid('updated_by').nullable();
    });
    await ensureIndex(db, dialect, 'accred_periods', 'ix_accred_periods_starts_on', ['starts_on']);

    await ensureTable(db, dialect, 'accred_answers', 'data', NAME, (t) => {
      t.ulid('period_id');
      t.key191('indicator_code');
      t.char('answer', 1);
      t.varchar('mode', 16);
      t.text('note').nullable();
      t.timestamp('updated_at');
      t.ulid('updated_by').nullable();
      t.primaryKey(['period_id', 'indicator_code']);
      t.foreignKey('period_id', 'accred_periods', 'id', { onDelete: 'cascade' });
    });

    await ensureTable(db, dialect, 'accred_results', 'volatile', NAME, (t) => {
      t.ulid('period_id');
      t.key191('indicator_code');
      t.json('payload');
      t.timestamp('computed_at');
      t.primaryKey(['period_id', 'indicator_code']);
    });

    await ensureTable(db, dialect, 'accred_snapshots', 'data', NAME, (t) => {
      t.id();
      t.ulid('period_id');
      t.varchar('instrument_id', 32);
      t.json('result_values');
      t.varchar('na', 8).nullable();
      t.varchar('na_low', 8);
      t.varchar('na_high', 8);
      t.char('grade', 1).nullable();
      t.bool('prerequisites_met');
      t.ulid('dossier_file_id').nullable();
      t.varchar('note', 191).nullable();
      t.timestamp('created_at');
      t.ulid('created_by').nullable();
      t.foreignKey('period_id', 'accred_periods', 'id', { onDelete: 'cascade' });
    });
    await ensureIndex(db, dialect, 'accred_snapshots', 'ix_accred_snapshots_period_id_created_at', ['period_id', 'created_at']);

    await ensureTable(db, dialect, 'accred_evidence', 'data', NAME, (t) => {
      t.id();
      t.ulid('period_id').nullable();
      t.varchar('indicator_code', 16).nullable();
      t.varchar('evidence_code', 32).nullable();
      t.varchar('entity', 32).nullable();
      t.ulid('entity_id').nullable();
      t.ulid('file_id');
      t.varchar('caption', 191);
      t.int('sort_order').default(0);
      t.timestamp('created_at');
      t.ulid('created_by').nullable();
    });
    await ensureIndex(db, dialect, 'accred_evidence', 'ix_accred_evidence_period_id_indicator_code', ['period_id', 'indicator_code']);
    await ensureIndex(db, dialect, 'accred_evidence', 'ix_accred_evidence_entity_entity_id', ['entity', 'entity_id']);

    await ensureTable(db, dialect, 'usage_stats', 'data', NAME, (t) => {
      t.varchar('source', 16);
      t.varchar('metric', 32);
      t.date('span_from');
      t.date('span_to');
      t.key191('branch_key');
      t.key191('group_key');
      t.bigint('value');
      t.ulid('run_id').nullable();
      t.timestamp('updated_at');
      t.ulid('updated_by').nullable();
      t.primaryKey(['source', 'metric', 'span_from', 'span_to', 'branch_key', 'group_key']);
    });

    await ensureTable(db, dialect, 'usage_group_map', 'data', NAME, (t) => {
      t.key191('group_key');
      t.varchar('label', 191);
      t.varchar('accred_group', 16).nullable();
      t.timestamp('updated_at');
      t.ulid('updated_by').nullable();
      t.primaryKey(['group_key']);
    });
  },
};
