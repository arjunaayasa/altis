import { ensureIndex } from '../ddl.js';
import type { AltisMigration } from '../migrator.js';

// 0028: four indexes on the catalogue that the perf seed of K9 (plan Task 39; 100 000 records, 150 000 items) showed
// reading whole tables on every request. No table is created, so no table class is named here.
//
// - records (language_id, archived_at), items (collection_type_id, archived_at), items (supplier_id, archived_at): the
//   masters screens count the live records or items each language, collection type and supplier is used by (Task 12,
//   masters/in-use.ts: `WHERE <column> IN (…) AND archived_at IS NULL GROUP BY <column>`), on every list, archive and
//   update. Both columns are in the index, so the count reads the index alone.
// - records (promoted, changed_at, id): the OPAC home page's promoted titles (Task 21, `promoted = 1` newest changed
//   first). Without it the query walked ix_records_changed_at_id backwards through every record when fewer than its
//   limit are promoted (none, in most libraries).
//
// Named per ruling R23 (ix_<table>_<columns>). Expand-only and idempotent like the others: ensureIndex checks the
// catalog first, so a run that stopped before an index existed is completed by running it again.

export const catalogPerfIndexes: AltisMigration = {
  async up(db, dialect) {
    await ensureIndex(db, dialect, 'records', 'ix_records_language_id_archived_at', ['language_id', 'archived_at']);
    await ensureIndex(db, dialect, 'records', 'ix_records_promoted_changed_at_id', ['promoted', 'changed_at', 'id']);
    await ensureIndex(db, dialect, 'items', 'ix_items_collection_type_id_archived_at', ['collection_type_id', 'archived_at']);
    await ensureIndex(db, dialect, 'items', 'ix_items_supplier_id_archived_at', ['supplier_id', 'archived_at']);
  },
};
