import { ensureIndex, ensureTable } from '../ddl.js';
import type { AltisMigration } from '../migrator.js';

// 0020: the catalog's masters and authorities (Phase 2 spec §2.2, §2.4): languages, material types, publishers,
// agents, subjects and the thesaurus relations between subjects. All class data.
//
// - Codes and names are `*_display` (as typed) + `*_key` (normalizeKey, or agentNameKey for agents: name + dates)
//   UNIQUE. Every text column of a primary or unique key is key191() (binary, rulings R17/R39b/R48, decision P2-09),
//   `type` and `rel` included; the writers enforce the spec's narrower widths.
// - `merged_into` names the authority an archived one was merged into (no foreign key: no self-reference, §2.1).
// - subject_relations: one row per direction, both written by the thesaurus service (§3.5); `subject_id` is owned by
//   its subject (CASCADE), `related_id` has no foreign key (§2.1: a restore then needs no second pass).
// - material_types.template is the JSON template of §3.8; the RDA codes default to a printed book's.
// One DDL per step; every step checks the catalog first, so a run that stopped halfway is completed by running it
// again. Tables and classes are literals (R44).

const NAME = '0020_catalog_authorities';

export const catalogAuthorities: AltisMigration = {
  async up(db, dialect) {
    await ensureTable(db, dialect, 'languages', 'data', NAME, (t) => {
      t.id();
      t.varchar('code_display', 191);
      t.key191('code_key');
      t.varchar('name_id', 191);
      t.varchar('name_en', 191);
      t.timestamp('archived_at').nullable();
      t.int('version').default(0);
      t.timestamp('created_at');
      t.ulid('created_by').nullable();
      t.timestamp('updated_at');
      t.ulid('updated_by').nullable();
    });
    await ensureIndex(db, dialect, 'languages', 'uq_languages_code_key', ['code_key'], { unique: true });

    await ensureTable(db, dialect, 'material_types', 'data', NAME, (t) => {
      t.id();
      t.varchar('code_display', 191);
      t.key191('code_key');
      t.varchar('name_id', 191);
      t.varchar('name_en', 191);
      t.char('marc_type', 1);
      t.char('marc_level', 1).default('m');
      t.varchar('content_type', 8).default('txt');
      t.varchar('media_type', 8).default('n');
      t.varchar('carrier_type', 8).default('nc');
      t.varchar('schema_type', 32).default('Book');
      t.varchar('dcmi_type', 32).default('Text');
      t.json('template');
      t.int('sort_order').default(0);
      t.timestamp('archived_at').nullable();
      t.int('version').default(0);
      t.timestamp('created_at');
      t.ulid('created_by').nullable();
      t.timestamp('updated_at');
      t.ulid('updated_by').nullable();
    });
    await ensureIndex(db, dialect, 'material_types', 'uq_material_types_code_key', ['code_key'], { unique: true });

    await ensureTable(db, dialect, 'publishers', 'data', NAME, (t) => {
      t.id();
      t.varchar('name_display', 191);
      t.key191('name_key');
      t.varchar('place', 191).nullable();
      t.ulid('merged_into').nullable();
      t.timestamp('archived_at').nullable();
      t.int('version').default(0);
      t.timestamp('created_at');
      t.ulid('created_by').nullable();
      t.timestamp('updated_at');
      t.ulid('updated_by').nullable();
    });
    await ensureIndex(db, dialect, 'publishers', 'uq_publishers_name_key', ['name_key'], { unique: true });

    await ensureTable(db, dialect, 'agents', 'data', NAME, (t) => {
      t.id();
      t.key191('type');
      t.varchar('name_display', 191);
      t.key191('name_key');
      t.varchar('dates', 64).nullable();
      t.varchar('authority_source', 64).nullable();
      t.varchar('authority_ref', 191).nullable();
      t.text('note').nullable();
      t.ulid('merged_into').nullable();
      t.timestamp('archived_at').nullable();
      t.int('version').default(0);
      t.timestamp('created_at');
      t.ulid('created_by').nullable();
      t.timestamp('updated_at');
      t.ulid('updated_by').nullable();
    });
    await ensureIndex(db, dialect, 'agents', 'uq_agents_type_name_key', ['type', 'name_key'], { unique: true });

    await ensureTable(db, dialect, 'subjects', 'data', NAME, (t) => {
      t.id();
      t.key191('type');
      t.varchar('term_display', 191);
      t.key191('term_key');
      t.varchar('classification', 64).nullable();
      t.text('scope_note').nullable();
      t.varchar('authority_source', 64).nullable();
      t.ulid('merged_into').nullable();
      t.timestamp('archived_at').nullable();
      t.int('version').default(0);
      t.timestamp('created_at');
      t.ulid('created_by').nullable();
      t.timestamp('updated_at');
      t.ulid('updated_by').nullable();
    });
    await ensureIndex(db, dialect, 'subjects', 'uq_subjects_type_term_key', ['type', 'term_key'], { unique: true });

    await ensureTable(db, dialect, 'subject_relations', 'data', NAME, (t) => {
      t.ulid('subject_id');
      t.ulid('related_id');
      t.key191('rel');
      t.primaryKey(['subject_id', 'related_id', 'rel']);
      t.foreignKey('subject_id', 'subjects', 'id', { onDelete: 'cascade' });
    });
    await ensureIndex(db, dialect, 'subject_relations', 'ix_subject_relations_related_id', ['related_id']);
  },
};
