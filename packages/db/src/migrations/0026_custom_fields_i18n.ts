import { ensureColumn } from '../ddl.js';
import type { AltisMigration } from '../migrator.js';

// 0026: custom fields for the catalog (Phase 2 spec §2.2 "Perubahan tabel Fase 1", §3.7). Three columns are added to
// the end of custom_field_defs, each with one ALTER TABLE ... ADD COLUMN (the defaults fill the rows already there):
//
// - label_en: the English label (191, NULL: the Indonesian `label` is shown in both languages);
// - is_public: the value is shown on the OPAC ("Informasi lain"), default 0;
// - is_searchable: the value of a text field goes into the search text (`t_rest`), default 0. In Phase 2 only fields
//   that are also public are indexed (S20, decision P2-36).
// Phase 2's `entity` values are `records` and `items`. No table is created, so no class is named here (R44).

export const customFieldsI18n: AltisMigration = {
  async up(db, dialect) {
    await ensureColumn(db, dialect, 'custom_field_defs', (t) => t.varchar('label_en', 191).nullable());
    await ensureColumn(db, dialect, 'custom_field_defs', (t) => t.bool('is_public').default(0));
    await ensureColumn(db, dialect, 'custom_field_defs', (t) => t.bool('is_searchable').default(0));
  },
};
