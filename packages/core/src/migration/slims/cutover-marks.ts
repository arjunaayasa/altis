import type { DB } from '@altis/db';
import type { Kysely, Transaction } from 'kysely';

// The marks of the cut-over checklist (cutover.ts): each step an admin marked done is a `catalog.migration.cutover`
// audit entry (entity `slims_cutover`, the step as its id). The audit trail is where these marks live: they are the
// record of an admin's decision, kept as long as the trail. Kept apart so the circulation stage reads the "serve" mark
// without importing the checklist.

type Db = Kysely<DB> | Transaction<DB>;

/** When the cut-over step `step` was last marked done, or null. */
export async function cutoverMarkAt(db: Db, step: 'reprint_opened' | 'serve'): Promise<number | null> {
  const row = await db
    .selectFrom('audit_log')
    .select('at')
    .where('action', '=', 'catalog.migration.cutover')
    .where('entity', '=', 'slims_cutover')
    .where('entity_id', '=', step)
    .orderBy('seq', 'desc')
    .limit(1)
    .executeTakeFirst();
  return row === undefined ? null : Number(row.at);
}
