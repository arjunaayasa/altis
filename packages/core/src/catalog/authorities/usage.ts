import { ID_BATCH, type AuthorityTable, type Db } from './common.js';

// The usage of authorities (Phase 2 spec §3.5; plan Task 13): how many live records (not archived) link to each one,
// through `record_agents`, `record_subjects` or `records.publisher_id`. It is the `usage` of every view, the count of
// CATALOG_IN_USE, and what makes an orphan (orphans.ts). A record with the same agent in two roles counts once.
//
// A merged record has no links any more (its merge moved them to its target), so only archived records are left out.

/** The usage of each of `ids` (0 for an id no live record links to). */
export async function authorityUsage(db: Db, kind: AuthorityTable, ids: readonly string[]): Promise<Map<string, number>> {
  const unique = [...new Set(ids)];
  const usage = new Map<string, number>(unique.map((id) => [id, 0]));
  for (let i = 0; i < unique.length; i += ID_BATCH) {
    const batch = unique.slice(i, i + ID_BATCH);
    let rows: { id: string; n: number | string | bigint }[];
    if (kind === 'agents') {
      rows = await db
        .selectFrom('record_agents as l')
        .innerJoin('records as r', 'r.id', 'l.record_id')
        .select(['l.agent_id as id', (eb) => eb.fn.count('l.record_id').distinct().as('n')])
        .where('l.agent_id', 'in', batch)
        .where('r.archived_at', 'is', null)
        .groupBy('l.agent_id')
        .execute();
    } else if (kind === 'subjects') {
      rows = await db
        .selectFrom('record_subjects as l')
        .innerJoin('records as r', 'r.id', 'l.record_id')
        .select(['l.subject_id as id', (eb) => eb.fn.countAll().as('n')])
        .where('l.subject_id', 'in', batch)
        .where('r.archived_at', 'is', null)
        .groupBy('l.subject_id')
        .execute();
    } else {
      const found = await db
        .selectFrom('records')
        .select(['publisher_id', (eb) => eb.fn.countAll().as('n')])
        .where('publisher_id', 'in', batch)
        .where('archived_at', 'is', null)
        .groupBy('publisher_id')
        .execute();
      rows = found.flatMap((r) => (r.publisher_id === null ? [] : [{ id: r.publisher_id, n: r.n }]));
    }
    for (const r of rows) usage.set(r.id, Number(r.n));
  }
  return usage;
}

/** The usage of one authority. */
export async function usageOf(db: Db, kind: AuthorityTable, id: string): Promise<number> {
  return (await authorityUsage(db, kind, [id])).get(id) ?? 0;
}
