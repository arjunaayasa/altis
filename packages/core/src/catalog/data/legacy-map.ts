import type { DB } from '@altis/db';
import type { Kysely, Transaction } from 'kysely';

// The legacy map (Phase 2 spec §2.2 `migration_map`, §5.3, §11.3): which ALTIS row each imported or migrated source row
// became, keyed by (source, entity, legacy key). `source` is `slims` (or the migration's `sourceName`, S13) or
// `import:<runId>`; `entity` the source table; `legacy_key` the source row's key (a SLiMS id, a line number). A
// repeated slice looks its rows up first and never maps (nor creates) one twice.
//
// The keys are key191() columns (binary, P2-09); the spec's narrower widths are enforced here: source ≤ 40, entity ≤ 32,
// legacy key ≤ 191 code points. Keys are stored as given, so they must not start or end with a blank (R24).

/** One mapping. */
export interface LegacyMapping {
  source: string;
  entity: string;
  legacyKey: string;
  targetId: string;
  runId: string;
}

/** Up to this many rows per INSERT and keys per `IN (…)` list. */
const BATCH = 500;

type Db = Kysely<DB> | Transaction<DB>;

/** `value` when it is a key of at most `max` code points without a leading or trailing blank; a TypeError otherwise. */
function key(what: string, value: unknown, max: number): string {
  if (typeof value !== 'string' || value === '' || value.trim() !== value || Array.from(value).length > max) {
    throw new TypeError(`legacy map: ${what} must be a non-empty string of at most ${max} characters without outer blanks`);
  }
  return value;
}

/**
 * Inserts the mappings of `rows` whose key is not mapped yet (a key given twice is inserted once; an existing key
 * keeps its target), in batches of at most 500 rows. Await it before the next statement on `trx`.
 *
 * @throws TypeError, before anything is written, for a source, entity or legacy key that does not fit (see the top of
 *   this file)
 */
export async function mapLegacy(trx: Transaction<DB>, rows: readonly LegacyMapping[]): Promise<void> {
  for (const r of rows) {
    key('source', r.source, 40);
    key('entity', r.entity, 32);
    key('legacy key', r.legacyKey, 191);
  }
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    // The keys already mapped, per (source, entity) of the batch.
    const groups = new Map<string, { source: string; entity: string; keys: Set<string> }>();
    for (const r of batch) {
      const g = `${r.source}\u0000${r.entity}`;
      const group = groups.get(g) ?? { source: r.source, entity: r.entity, keys: new Set<string>() };
      group.keys.add(r.legacyKey);
      groups.set(g, group);
    }
    const taken = new Set<string>();
    for (const [g, group] of groups) {
      const present = await trx
        .selectFrom('migration_map')
        .select('legacy_key')
        .where('source', '=', group.source)
        .where('entity', '=', group.entity)
        .where('legacy_key', 'in', [...group.keys])
        .execute();
      for (const p of present) taken.add(`${g}\u0000${p.legacy_key}`);
    }
    const values: { source: string; entity: string; legacy_key: string; target_id: string; run_id: string }[] = [];
    for (const r of batch) {
      const k = `${r.source}\u0000${r.entity}\u0000${r.legacyKey}`;
      if (taken.has(k)) continue;
      taken.add(k);
      values.push({ source: r.source, entity: r.entity, legacy_key: r.legacyKey, target_id: r.targetId, run_id: r.runId });
    }
    if (values.length > 0) await trx.insertInto('migration_map').values(values).execute();
  }
}

/** The targets of the mapped `keys` of (`source`, `entity`), keyed by legacy key; unmapped keys are absent. */
export async function lookupLegacy(db: Db, source: string, entity: string, keys: readonly string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const unique = [...new Set(keys)];
  for (let i = 0; i < unique.length; i += BATCH) {
    const rows = await db
      .selectFrom('migration_map')
      .select(['legacy_key', 'target_id'])
      .where('source', '=', source)
      .where('entity', '=', entity)
      .where('legacy_key', 'in', unique.slice(i, i + BATCH))
      .execute();
    for (const r of rows) found.set(r.legacy_key, r.target_id);
  }
  return found;
}

/** The target of one legacy key, or null when it is not mapped. */
export async function legacyTarget(db: Db, source: string, entity: string, legacyKey: string): Promise<string | null> {
  const row = await db
    .selectFrom('migration_map')
    .select('target_id')
    .where('source', '=', source)
    .where('entity', '=', entity)
    .where('legacy_key', '=', legacyKey)
    .executeTakeFirst();
  return row?.target_id ?? null;
}
