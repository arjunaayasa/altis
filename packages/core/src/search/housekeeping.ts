import type { CatalogHousekeepingStep } from '../catalog/housekeeping.js';
import { REINDEX_ALL_KEY, REINDEX_TERMS_KEY } from './jobs.js';

/**
 * The search step of `catalog.housekeeping` (spec §4.1, §12.6 "segarkan search_term, pastikan indeks ada"): queues a
 * full reindex when the index was never built (`search_state` missing: a restore, the first boot) or a build stopped
 * without finishing (`building` with no full rebuild queued or running, and the job `search_state.job_id` names, a
 * SLiMS migration or a rebuild, not queued or running either: L03, a migration marks the index building for its whole
 * run); otherwise, the index
 * being ready, queues the refresh of `search_term` (the spelling vocabulary, which saves do not maintain) as the
 * `catalog.reindex {scope: 'terms'}` job, so that it runs sliced and under `jobs:heavy` like the rebuild, never beside
 * it. Both are queued with their unique keys (a live one is joined), by the system. One step, no cursor.
 */
const step: CatalogHousekeepingStep = {
  name: 'search',
  async run(c) {
    const state = await c.h.db.selectFrom('search_state').select(['status', 'job_id']).where('id', '=', 1).executeTakeFirst();
    if (state?.status === 'ready') {
      await c.enqueue('catalog.reindex', { scope: 'terms' }, REINDEX_TERMS_KEY);
      return { done: true, cursor: null };
    }
    let live = c.h.db.selectFrom('jobs').select('id').where('status', 'in', ['queued', 'running']);
    const builder = state?.job_id ?? null;
    live = live.where((eb) => (builder === null ? eb('unique_key', '=', REINDEX_ALL_KEY) : eb.or([eb('unique_key', '=', REINDEX_ALL_KEY), eb('id', '=', builder)])));
    if ((await live.executeTakeFirst()) === undefined) await c.enqueue('catalog.reindex', { scope: 'all' }, REINDEX_ALL_KEY);
    return { done: true, cursor: null };
  },
};

export const searchHousekeepingStep: CatalogHousekeepingStep = Object.freeze(step);
