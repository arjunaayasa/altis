import { ensureIndex, ensureTable } from '../ddl.js';
import { ensureFullText, type FullTextSpec } from '../fulltext.js';
import type { AltisMigration } from '../migrator.js';

// 0024: the built-in search index (Phase 2 spec §2.2, §4). Class volatile: never backed up, emptied by a restore and
// rebuilt by `catalog.reindex` (§2.3).
//
// - search_doc: one row per record (`record_id` UNIQUE), its normalized token text in four columns, keyed by the
//   serial `doc_no` that SQLite's FTS5 table uses as its rowid. Besides the spec's indexes, the newest-first reads
//   (S14, spec erratum E2) have their own: `ix_search_doc_public_created (is_public, created_at)` for the OPAC's
//   `terbaru` sort, the home page's new titles and `/rss`, and `ix_search_doc_created (created_at)` for the admin's
//   `newest` sort. Those reads go through search_doc, never by sorting `records`.
// - search_facet: the facet values of each record (§4.6); search_term: the vocabulary the typo correction reads
//   (§4.7); search_state: one row, `id = 1` (§4.8).
// - The full-text index per dialect goes through the registered helper ensureFullText with the literal spec below
//   (§4.3): InnoDB FULLTEXT indexes on MySQL/MariaDB, one GIN expression index on PostgreSQL, an FTS5
//   external-content table on SQLite.
// Every text column of a primary or unique key is key191() (R39b, P2-09): search_facet.facet and value_key,
// search_term.term.

const NAME = '0024_search_index';

/** The full-text index of search_doc, as this migration made it (frozen with it, R44). */
export const SEARCH_FULLTEXT: FullTextSpec = Object.freeze({
  table: 'search_doc',
  rowid: 'doc_no',
  columns: Object.freeze(['t_title', 't_agents', 't_subjects', 't_rest']),
  innodb: Object.freeze([
    Object.freeze({ name: 'ix_search_doc_ft_all', columns: Object.freeze(['t_title', 't_agents', 't_subjects', 't_rest']) }),
    Object.freeze({ name: 'ix_search_doc_ft_title', columns: Object.freeze(['t_title']) }),
    Object.freeze({ name: 'ix_search_doc_ft_agents', columns: Object.freeze(['t_agents']) }),
    Object.freeze({ name: 'ix_search_doc_ft_subjects', columns: Object.freeze(['t_subjects']) }),
  ]),
  pg: Object.freeze({ name: 'ix_search_doc_ft' }),
  fts5: Object.freeze({ name: 'search_fts' }),
});

export const searchIndex: AltisMigration = {
  async up(db, dialect) {
    await ensureTable(db, dialect, 'search_doc', 'volatile', NAME, (t) => {
      t.serial('doc_no');
      t.ulid('record_id');
      t.bool('is_public');
      t.bool('is_archived');
      t.text('t_title');
      t.text('t_agents');
      t.text('t_subjects');
      t.text('t_rest');
      t.key191('title_key');
      t.smallint('year').nullable();
      t.timestamp('created_at');
      t.timestamp('changed_at');
    });
    await ensureIndex(db, dialect, 'search_doc', 'uq_search_doc_record_id', ['record_id'], { unique: true });
    await ensureIndex(db, dialect, 'search_doc', 'ix_search_doc_is_public_changed_at', ['is_public', 'changed_at']);
    await ensureIndex(db, dialect, 'search_doc', 'ix_search_doc_is_public_title_key', ['is_public', 'title_key']);
    await ensureIndex(db, dialect, 'search_doc', 'ix_search_doc_is_public_year', ['is_public', 'year']);
    await ensureIndex(db, dialect, 'search_doc', 'ix_search_doc_public_created', ['is_public', 'created_at']);
    await ensureIndex(db, dialect, 'search_doc', 'ix_search_doc_created', ['created_at']);

    await ensureTable(db, dialect, 'search_facet', 'volatile', NAME, (t) => {
      t.ulid('record_id');
      t.key191('facet');
      t.key191('value_key');
      t.primaryKey(['record_id', 'facet', 'value_key']);
    });
    await ensureIndex(db, dialect, 'search_facet', 'ix_search_facet_facet_value_key_record_id', ['facet', 'value_key', 'record_id']);

    await ensureTable(db, dialect, 'search_term', 'volatile', NAME, (t) => {
      t.key191('term');
      t.varchar('first_char', 4);
      t.smallint('len');
      t.int('df');
      t.primaryKey(['term']);
    });
    await ensureIndex(db, dialect, 'search_term', 'ix_search_term_first_char_len_df', ['first_char', 'len', 'df']);

    await ensureTable(db, dialect, 'search_state', 'volatile', NAME, (t) => {
      t.smallint('id');
      t.varchar('status', 16);
      t.int('docs');
      t.ulid('job_id').nullable();
      t.timestamp('built_at').nullable();
      t.primaryKey(['id']);
    });

    await ensureFullText(db, dialect, SEARCH_FULLTEXT);
  },
};
