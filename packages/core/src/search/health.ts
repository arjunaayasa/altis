import { countRows, type DB } from '@altis/db';
import type { Kysely, Transaction } from 'kysely';
import { REINDEX_ALL_KEY } from './jobs.js';
import type { SearchHealth } from './types.js';

/**
 * The health of the index (spec §4.8): `search_state`'s status (`missing` before the first build and after a restore)
 * and last build; the documents of live records (`is_archived = 0`) against the live records (`archived_at IS NULL`),
 * which agree once a build finished and every write path indexed; the full rebuild (`catalog.reindex:all`) while one is
 * queued or running. Diagnostik, the dashboard alert and the housekeeping step read it. Three counts and two point
 * reads, no transaction.
 */
export async function searchHealth(db: Kysely<DB> | Transaction<DB>): Promise<SearchHealth> {
  const state = await db.selectFrom('search_state').select(['status', 'built_at']).where('id', '=', 1).executeTakeFirst();
  const docs = await countRows((db as Kysely<DB>).selectFrom('search_doc').where('is_archived', '=', 0).select('doc_no'));
  const records = await countRows((db as Kysely<DB>).selectFrom('records').where('archived_at', 'is', null).select('id'));
  const job = await db
    .selectFrom('jobs')
    .select('id')
    .where('unique_key', '=', REINDEX_ALL_KEY)
    .where('status', 'in', ['queued', 'running'])
    .executeTakeFirst();
  const status = state === undefined ? 'missing' : state.status === 'ready' ? 'ready' : 'building';
  return { status, docs, records, builtAt: state?.built_at ?? null, jobId: job?.id ?? null };
}
