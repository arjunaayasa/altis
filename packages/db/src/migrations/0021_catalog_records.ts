import { ensureIndex, ensureTable } from '../ddl.js';
import type { AltisMigration } from '../migrator.js';

// 0021: bibliographic records and what they own (Phase 2 spec §2.2, §2.4). All class data.
//
// - records: `title_key` (key191, binary) is the normalized title the title sort and the duplicate pre-screen read;
//   `changed_at` moves whenever the public representation changes (OAI datestamp, sitemap lastmod, RSS), `updated_at`
//   only on a direct edit. `merged_into` names the record an archived one was merged into (no foreign key, §2.1).
//   `publication_year` is CHAR(4) (exactly four characters when set).
// - record_identifiers, record_marc_extra, record_agents, record_subjects, record_relations and attachments belong
//   to their record (CASCADE). The authority and related-record columns have no foreign key (§2.1).
// - record_marc_extra keeps the MARC fields ALTIS does not model, verbatim. Its indicators are VARCHAR(1), not
//   CHAR(1): the most common indicator is a blank, and a CHAR value ending in a blank reads back differently per
//   dialect (MySQL strips it, PostgreSQL pads it; ddl.ts).
// - attachments.read_count is a counter (increment()); `legacy_access_limit` keeps SLiMS's member-type list for
//   Phase 3.
// Every text column of a primary or unique key is key191() (R39b, P2-09): record_identifiers.type and value_key,
// record_agents.role, record_relations.type.

const NAME = '0021_catalog_records';

export const catalogRecords: AltisMigration = {
  async up(db, dialect) {
    await ensureTable(db, dialect, 'records', 'data', NAME, (t) => {
      t.id();
      t.ulid('material_type_id');
      t.text('title');
      t.text('subtitle').nullable();
      t.text('responsibility').nullable();
      t.key191('title_key');
      t.varchar('edition', 191).nullable();
      t.varchar('material_detail', 191).nullable();
      t.ulid('publisher_id').nullable();
      t.varchar('publication_place', 191).nullable();
      t.char('publication_year', 4).nullable();
      t.varchar('publication_date_text', 64).nullable();
      t.varchar('physical_desc', 191).nullable();
      t.varchar('series', 191).nullable();
      t.varchar('classification', 64).nullable();
      t.varchar('call_number', 64).nullable();
      t.ulid('language_id').nullable();
      t.varchar('content_type', 8).nullable();
      t.varchar('media_type', 8).nullable();
      t.varchar('carrier_type', 8).nullable();
      t.text('summary').nullable();
      t.text('notes').nullable();
      t.ulid('cover_file_id').nullable();
      t.bool('opac_visible').default(1);
      t.bool('promoted').default(0);
      t.varchar('source', 191).nullable();
      t.ulid('merged_into').nullable();
      t.timestamp('changed_at');
      t.timestamp('archived_at').nullable();
      t.int('version').default(0);
      t.timestamp('created_at');
      t.ulid('created_by').nullable();
      t.timestamp('updated_at');
      t.ulid('updated_by').nullable();
    });
    await ensureIndex(db, dialect, 'records', 'ix_records_title_key', ['title_key']);
    await ensureIndex(db, dialect, 'records', 'ix_records_changed_at_id', ['changed_at', 'id']);
    await ensureIndex(db, dialect, 'records', 'ix_records_publisher_id', ['publisher_id']);
    await ensureIndex(db, dialect, 'records', 'ix_records_material_type_id', ['material_type_id']);

    await ensureTable(db, dialect, 'record_identifiers', 'data', NAME, (t) => {
      t.id();
      t.ulid('record_id');
      t.key191('type');
      t.varchar('value_display', 64);
      t.key191('value_key');
      t.varchar('qualifier', 64).nullable();
      t.bool('is_valid').default(1);
      t.int('sort_order').default(0);
      t.foreignKey('record_id', 'records', 'id', { onDelete: 'cascade' });
    });
    await ensureIndex(
      db,
      dialect,
      'record_identifiers',
      'uq_record_identifiers_record_id_type_value_key',
      ['record_id', 'type', 'value_key'],
      { unique: true },
    );
    await ensureIndex(db, dialect, 'record_identifiers', 'ix_record_identifiers_type_value_key', ['type', 'value_key']);

    await ensureTable(db, dialect, 'record_marc_extra', 'data', NAME, (t) => {
      t.id();
      t.ulid('record_id');
      t.char('tag', 3);
      t.varchar('ind1', 1);
      t.varchar('ind2', 1);
      t.text('data');
      t.int('sort_order').default(0);
      t.foreignKey('record_id', 'records', 'id', { onDelete: 'cascade' });
    });
    await ensureIndex(db, dialect, 'record_marc_extra', 'ix_record_marc_extra_record_id_sort_order', ['record_id', 'sort_order']);

    await ensureTable(db, dialect, 'record_agents', 'data', NAME, (t) => {
      t.ulid('record_id');
      t.ulid('agent_id');
      t.key191('role');
      t.bool('is_main').default(0);
      t.int('sort_order').default(0);
      t.primaryKey(['record_id', 'agent_id', 'role']);
      t.foreignKey('record_id', 'records', 'id', { onDelete: 'cascade' });
    });
    await ensureIndex(db, dialect, 'record_agents', 'ix_record_agents_agent_id', ['agent_id']);

    await ensureTable(db, dialect, 'record_subjects', 'data', NAME, (t) => {
      t.ulid('record_id');
      t.ulid('subject_id');
      t.bool('is_primary').default(0);
      t.int('sort_order').default(0);
      t.primaryKey(['record_id', 'subject_id']);
      t.foreignKey('record_id', 'records', 'id', { onDelete: 'cascade' });
    });
    await ensureIndex(db, dialect, 'record_subjects', 'ix_record_subjects_subject_id', ['subject_id']);

    await ensureTable(db, dialect, 'record_relations', 'data', NAME, (t) => {
      t.ulid('record_id');
      t.ulid('related_id');
      t.key191('type');
      t.primaryKey(['record_id', 'related_id', 'type']);
      t.foreignKey('record_id', 'records', 'id', { onDelete: 'cascade' });
    });
    await ensureIndex(db, dialect, 'record_relations', 'ix_record_relations_related_id', ['related_id']);

    await ensureTable(db, dialect, 'attachments', 'data', NAME, (t) => {
      t.id();
      t.ulid('record_id');
      t.varchar('kind', 8);
      t.ulid('file_id').nullable();
      t.text('url').nullable();
      t.varchar('title', 191);
      t.text('description').nullable();
      t.varchar('access', 16);
      t.text('legacy_access_limit').nullable();
      t.bigint('read_count').default(0);
      t.int('sort_order').default(0);
      t.timestamp('archived_at').nullable();
      t.int('version').default(0);
      t.timestamp('created_at');
      t.ulid('created_by').nullable();
      t.timestamp('updated_at');
      t.ulid('updated_by').nullable();
      t.foreignKey('record_id', 'records', 'id', { onDelete: 'cascade' });
    });
    await ensureIndex(db, dialect, 'attachments', 'ix_attachments_record_id', ['record_id']);
  },
};
