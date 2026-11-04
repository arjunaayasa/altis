import { SEARCH_TOKEN_VERSION, enqueueReindex, type JobRegistry, type KeyringEntry } from '@altis/core';
import { withTx, type DbHandle } from '@altis/db';

/**
 * The catalog's boot hook (Phase 2 Task 3, filled by Task 15): start() calls it once the migrations are done and the job
 * runtime exists, in every process (Passenger may boot six), and logs a failure without failing the boot. When the
 * search index was never built (`search_state` missing: the first boot of a new install, the boot after a restore,
 * which empties the volatile tables, spec §2.3), it queues `catalog.reindex {scope: 'all'}` by the system with the
 * unique key `catalog.reindex:all`, so the processes booting at once queue one job between them (the others join it).
 * The same when a ready index was built with another token format than this release's (`token_version`, migration
 * 0029; NULL before it was stored): an update that changed the tokenizer rebuilds the index once by itself. The worker
 * loop or the next cron pass picks it up (a page drives it where neither runs: C26). A build that stopped halfway is the
 * daily housekeeping's to restart (search/housekeeping.ts), so that an admin's cancel is not undone by every process
 * spawn. A build in flight across such an update needs nothing here (X2-2): a full rebuild whose checkpoint names
 * another token format starts again from the clear, and a SLiMS run that took an index of another format queues the full
 * rebuild at its end instead of marking it ready.
 */
export async function catalogBoot(h: DbHandle, rt: { registry: JobRegistry; keyring: readonly KeyringEntry[]; now: number }): Promise<void> {
  const state = await h.db.selectFrom('search_state').select(['status', 'token_version']).where('id', '=', 1).executeTakeFirst();
  if (state !== undefined && (state.status !== 'ready' || (state.token_version !== null && Number(state.token_version) === SEARCH_TOKEN_VERSION))) return;
  await withTx(h, (trx) => enqueueReindex(trx, rt.registry, { scope: 'all' }, { now: rt.now, keyring: rt.keyring, createdBy: null }));
}
