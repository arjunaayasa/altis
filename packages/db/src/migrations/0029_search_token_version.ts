import { ensureColumn } from '../ddl.js';
import type { AltisMigration } from '../migrator.js';

// 0029: the token format a search index was built with (Phase 2 big review, Task 39b's note). One column is added to
// the end of search_state with one ALTER TABLE ... ADD COLUMN:
//
// - token_version: the token format (search/tokenize.ts SEARCH_TOKEN_VERSION) of the build that made the index ready;
//   NULL for a build from before it was stored. The boot hook queues a full rebuild when a ready index holds another
//   one, so an update that changes the tokenizer rebuilds the index once by itself.
// No table is created, so no class is named here (R44).

export const searchTokenVersion: AltisMigration = {
  async up(db, dialect) {
    await ensureColumn(db, dialect, 'search_state', (t) => t.smallint('token_version').nullable());
  },
};
