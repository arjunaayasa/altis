import type { DB } from '@altis/db';
import type { Transaction } from 'kysely';
import type { KeyringEntry } from '../../crypto/secret-box.js';
import type { JobRegistry } from '../../jobs/types.js';
import { REINDEX_RECORD_IDS_MAX, enqueueReindex } from '../../search/jobs.js';

// The reindex a change of placement needs (Phase 2 spec §4.6; plan Task 14): the facets `lc` (the room) and `av` (an
// item available at a public location) of a record come from where its items are shelved, so moving a location (its
// parent or kind) or changing whether it is public changes them for every record with a live item at the location or
// below it. A location may hold thousands of items, so the records are queued to `catalog.reindex` (Task 15's job)
// rather than indexed in the request: lists of at most REINDEX_RECORD_IDS_MAX ids, or the whole catalogue once the
// records are more than LOCATION_REINDEX_LIST_MAX.

/** The most records a change of placement queues by id; above it the whole catalogue is reindexed (one `all` job). */
const LOCATION_REINDEX_LIST_MAX = 10 * REINDEX_RECORD_IDS_MAX;
const ID_BATCH = 500;
/** §3.6: room › area › shelf. */
const MAX_DEPTH = 3;

/** The ids of `id` and of every location below it in `branchId` (at most three levels). */
async function subtree(trx: Transaction<DB>, branchId: string, id: string): Promise<string[]> {
  const all = new Set<string>([id]);
  let frontier = [id];
  for (let level = 1; level < MAX_DEPTH && frontier.length > 0; level += 1) {
    const next: string[] = [];
    for (let i = 0; i < frontier.length; i += ID_BATCH) {
      const rows = await trx
        .selectFrom('locations')
        .select('id')
        .where('branch_id', '=', branchId)
        .where('parent_id', 'in', frontier.slice(i, i + ID_BATCH))
        .execute();
      for (const r of rows) {
        if (!all.has(r.id)) {
          all.add(r.id);
          next.push(r.id);
        }
      }
    }
    frontier = next;
  }
  return [...all];
}

/**
 * Queues the reindex of the records with a live item at location `id` of `branchId` or below it, in the caller's
 * transaction `trx` (enqueue's rules): `{recordIds}` jobs of at most REINDEX_RECORD_IDS_MAX ids, or one `{scope: 'all'}`
 * (joined with one not started yet, superseding one that has: C24) when they are more than
 * {@link LOCATION_REINDEX_LIST_MAX}. Answers how many jobs it queued
 * (0 when nothing is shelved there); the caller wakes the worker after the commit.
 *
 * @param registry a registry with the `catalog.reindex` handler (the runtime's, or one of `searchJobs`)
 */
export async function enqueueLocationReindex(
  trx: Transaction<DB>,
  registry: JobRegistry,
  branchId: string,
  id: string,
  o: { now: number; keyring: readonly KeyringEntry[]; createdBy: string | null },
): Promise<number> {
  const locations = await subtree(trx, branchId, id);
  const records = new Set<string>();
  for (let i = 0; i < locations.length && records.size <= LOCATION_REINDEX_LIST_MAX; i += ID_BATCH) {
    const rows = await trx
      .selectFrom('items')
      .select('record_id')
      .distinct()
      .where('branch_id', '=', branchId)
      .where('location_id', 'in', locations.slice(i, i + ID_BATCH))
      .where('archived_at', 'is', null)
      .orderBy('record_id')
      .limit(LOCATION_REINDEX_LIST_MAX + 1 - records.size)
      .execute();
    for (const r of rows) records.add(r.record_id);
  }
  if (records.size === 0) return 0;
  if (records.size > LOCATION_REINDEX_LIST_MAX) {
    // A change every record of the rebuild may hold: a rebuild that has started is superseded, not joined (C24).
    await enqueueReindex(trx, registry, { scope: 'all' }, { ...o, changed: true });
    return 1;
  }
  const ids = [...records].sort();
  let jobs = 0;
  for (let i = 0; i < ids.length; i += REINDEX_RECORD_IDS_MAX) {
    await enqueueReindex(trx, registry, { recordIds: ids.slice(i, i + REINDEX_RECORD_IDS_MAX) }, o);
    jobs += 1;
  }
  return jobs;
}
