import { ensureIndex, ensureTable } from '../ddl.js';
import type { AltisMigration } from '../migrator.js';

// 0023: Halaman & Berita, the OPAC's pages and news (Phase 2 spec §2.2, §9.5). Class data.
//
// - pages: `slug_key` (lower case `[a-z0-9-]`, enforced by the writer) is UNIQUE per `kind`; a `published_at` in the
//   future schedules the publication.
// - page_translations: one row per page and locale (`id`, `en`), owned by its page (CASCADE). `body` is stored
//   sanitized (§9.5) and sanitized again when rendered.
// Every text column of a primary or unique key is key191() (R39b, P2-09): pages.kind, page_translations.locale.

const NAME = '0023_opac_pages';

export const opacPages: AltisMigration = {
  async up(db, dialect) {
    await ensureTable(db, dialect, 'pages', 'data', NAME, (t) => {
      t.id();
      t.key191('kind');
      t.key191('slug_key');
      t.varchar('status', 16);
      t.timestamp('published_at').nullable();
      t.bool('show_in_nav').default(0);
      t.ulid('cover_file_id').nullable();
      t.int('sort_order').default(0);
      t.timestamp('archived_at').nullable();
      t.int('version').default(0);
      t.timestamp('created_at');
      t.ulid('created_by').nullable();
      t.timestamp('updated_at');
      t.ulid('updated_by').nullable();
    });
    await ensureIndex(db, dialect, 'pages', 'uq_pages_kind_slug_key', ['kind', 'slug_key'], { unique: true });
    await ensureIndex(db, dialect, 'pages', 'ix_pages_kind_status_published_at', ['kind', 'status', 'published_at']);

    await ensureTable(db, dialect, 'page_translations', 'data', NAME, (t) => {
      t.ulid('page_id');
      t.key191('locale');
      t.varchar('title', 191);
      t.text('summary').nullable();
      t.varchar('body_format', 16);
      t.text('body');
      t.timestamp('updated_at');
      t.primaryKey(['page_id', 'locale']);
      t.foreignKey('page_id', 'pages', 'id', { onDelete: 'cascade' });
    });
  },
};
