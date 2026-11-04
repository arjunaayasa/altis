import { ensureIndex } from '../ddl.js';
import type { AltisMigration } from '../migrator.js';

// 0008: the index the audit viewer of Phase 1b reads (spec §7.8). No table is created, so no table class is named
// here.
//
// - audit_log (action, seq): the log is filtered by one action and read in `seq` order (the hash chain's order,
//   newest first on screen), so (action, seq) answers "the latest entries of one action" without a sort. Named per
//   ruling R23 (ix_<table>_<columns>).
//
// Expand-only and idempotent like the others: ensureIndex checks the catalog first, so a run that stopped before
// the index existed is completed by running it again.

export const accessIndexes: AltisMigration = {
  async up(db, dialect) {
    await ensureIndex(db, dialect, 'audit_log', 'ix_audit_log_action_seq', ['action', 'seq']);
  },
};
