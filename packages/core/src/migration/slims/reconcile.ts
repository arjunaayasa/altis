import type { MigrationReconcileRow, MigrationTableCounts } from '@altis/shared/api/catalog/migration';
import { slimsUnreadKind } from './report.js';

// The reconciliation of a SLiMS migration (Phase 2 spec §11.6): for every source table that was read, `source =
// migrated + merged + skipped + archived`, so no row is unaccounted for. A table that is not read in this phase (the
// "Fase 3" tables and the derived ones, counted with `unread`) is listed with its rows and never fails the check; its
// row says why it is not read (`unreadKind`: a later module's table, or a derived one).
//
// A catalogue re-sync archives mapped rows whose source row is gone: they are listed under `archived` with the rest, but
// they are no rows of the source, so the difference leaves them out (`vanished`, counters.ts).

/** The reconciliation of `summary`'s counters: one row per table (by name), `ok` iff every read table's diff is 0. */
export function reconcile(summary: {
  tables: Readonly<Record<string, MigrationTableCounts>>;
  unread: readonly string[];
  vanished?: Readonly<Record<string, number>>;
}): {
  ok: boolean;
  tables: MigrationReconcileRow[];
} {
  const unread = new Set(summary.unread);
  const vanished = summary.vanished ?? {};
  const rows: MigrationReconcileRow[] = Object.entries(summary.tables)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([table, c]) => {
      const skipped = Object.values(c.skipped).reduce((sum, n) => sum + n, 0);
      const isUnread = unread.has(table);
      const gone = Object.hasOwn(vanished, table) ? (vanished[table] ?? 0) : 0;
      const diff = isUnread ? 0 : c.source - (c.migrated + c.merged + skipped + c.archived - gone);
      const row: MigrationReconcileRow = { table, source: c.source, migrated: c.migrated, merged: c.merged, skipped, archived: c.archived, unread: isUnread, diff };
      const kind = isUnread ? slimsUnreadKind(table) : null;
      if (kind !== null) row.unreadKind = kind;
      return row;
    });
  return { ok: rows.every((r) => r.unread || r.diff === 0), tables: rows };
}
