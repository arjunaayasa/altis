import { DomainError } from '@altis/shared';
import { TABLE_KEYS } from './columns.js';
import type { AltisMigration } from './migrator.js';
import type { TableName } from './registry.js';

// Orders for backup and restore: tables in foreign-key order (parents are loaded before the rows that reference
// them), and the prefix of the migration list a backup's schema stops at (restore migrates an empty database to the
// archive's version first, then loads, then migrates to the latest; spec §9.10).

/** What {@link tableLoadOrder} needs of a table's keys: its foreign keys. */
interface ForeignKeysOf {
  readonly fks: readonly { readonly column: string; readonly table: string }[];
}

/**
 * `tables` with every table after the tables it references (its foreign keys' targets among `tables`): the order in
 * which their rows can be loaded with foreign keys enforced. Among the tables ready at any point the one first by
 * name comes first, so the order is the same on every run. A foreign key to a table outside `tables` does not
 * constrain the order. A table that references itself is not ordered by that key (its rows need their own order,
 * or a load with the parent column filled in afterwards): its self-referencing columns are reported in `selfRefs`.
 *
 * `keys` is the key registry, TABLE_KEYS by default (another one for tests).
 *
 * @throws TypeError for a table `keys` does not know, a table given twice, or foreign keys that form a cycle
 *   through two or more of `tables` (none do in TABLE_KEYS)
 */
export function tableLoadOrder<T extends string = TableName>(
  tables: readonly T[],
  keys: Readonly<Record<string, ForeignKeysOf>> = TABLE_KEYS,
): { order: T[]; selfRefs: Partial<Record<T, string[]>> } {
  const wanted = new Set<T>();
  for (const table of tables) {
    if (!Object.hasOwn(keys, table)) throw new TypeError(`tableLoadOrder(): ${JSON.stringify(table)} is not a known table`);
    if (wanted.has(table)) throw new TypeError(`tableLoadOrder(): ${table} is given twice`);
    wanted.add(table);
  }
  const parents = new Map<T, Set<T>>();
  const selfRefs: Partial<Record<T, string[]>> = {};
  for (const table of wanted) {
    const own = new Set<T>();
    for (const fk of keys[table]?.fks ?? []) {
      if (fk.table === table) (selfRefs[table] ??= []).push(fk.column);
      else if (wanted.has(fk.table as T)) own.add(fk.table as T);
    }
    parents.set(table, own);
  }
  const order: T[] = [];
  const placed = new Set<T>();
  while (order.length < wanted.size) {
    const ready = [...wanted]
      .filter((table) => !placed.has(table) && [...(parents.get(table) ?? [])].every((p) => placed.has(p)))
      .sort();
    const next = ready[0];
    if (next === undefined) {
      const rest = [...wanted].filter((table) => !placed.has(table)).sort();
      throw new TypeError(`tableLoadOrder(): the foreign keys of ${rest.join(', ')} form a cycle`);
    }
    order.push(next);
    placed.add(next);
  }
  return { order, selfRefs };
}

/**
 * The migrations of `all` up to and including `last`, in name order (names carry distinct four-digit numbers, so
 * name order is number order, as the migrator applies them): restore's `migrateTo` for the schema version a backup
 * was made at.
 *
 * @throws DomainError `BACKUP_SCHEMA_TOO_NEW` (`meta.migration`: `last`) when `all` has no migration `last` (a
 *   backup from a newer ALTIS)
 */
export function migrationsUpTo(all: Readonly<Record<string, AltisMigration>>, last: string): Record<string, AltisMigration> {
  const names = Object.keys(all).sort();
  const end = names.indexOf(last);
  if (end < 0) {
    throw new DomainError('BACKUP_SCHEMA_TOO_NEW', {
      detail:
        `Migrasi ${String(last).slice(0, 64)} tidak dikenal versi ALTIS ini / ` +
        `Migration ${String(last).slice(0, 64)} is not known to this version of ALTIS`,
      meta: { migration: last },
    });
  }
  const prefix: Record<string, AltisMigration> = {};
  for (const name of names.slice(0, end + 1)) prefix[name] = all[name] as AltisMigration;
  return prefix;
}
