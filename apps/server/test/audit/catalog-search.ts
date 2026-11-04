import type { ReindexResponse } from '@altis/shared/api/catalog/search';
import { expect } from 'vitest';
import type { AreaAuditScript } from './catalog.js';

// The A10 audit script of the catalog area `search` (Phase 2 plan, Task 2 scaffold; Task 15 wrote `run`): Diagnostik's
// "Bangun ulang indeks" through the API appends `catalog.search.reindex`, and the queued rebuild is driven to its end
// (the installation's runtime is external, so `drive` runs its slices), leaving the index ready.
export const AUDIT: AreaAuditScript = {
  actions: ['catalog.search.reindex'],
  async run(s) {
    const res = await s.admin.send('post', '/api/v1/catalog/search/reindex', undefined, { 'idempotency-key': 'audit-search-reindex-1' });
    expect(res.status, res.text).toBe(202);
    const { jobId } = res.json as ReindexResponse;
    for (let n = 0; n < 50; n += 1) {
      const slice = await s.jobs.drive(jobId, { budgetMs: 20_000 });
      if (slice === null || slice.outcome !== 'continued') break;
    }
    const job = await s.db.db.selectFrom('jobs').select('status').where('id', '=', jobId).executeTakeFirstOrThrow();
    expect(job.status).toBe('succeeded');
    expect(await s.db.db.selectFrom('search_state').select('status').executeTakeFirst()).toEqual({ status: 'ready' });
  },
};
