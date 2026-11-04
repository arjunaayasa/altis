import { createJobRegistry, enqueueReindex, type JobRegistry } from '@altis/core';
import { DomainError } from '@altis/shared';
import type { ReindexResponse } from '@altis/shared/api/catalog/search';
import { route, type RouteContext, type RouteDecl } from '../../http/route.js';
import { jobHandlers } from '../../jobs/runtime.js';

// The catalog API route of the index rebuild (Phase 2 spec §4.8, §12.2; plan Task 15): `POST catalog/search/reindex`,
// Diagnostik's "Bangun ulang indeks". It queues `catalog.reindex {scope: 'all'}` with the unique key
// `catalog.reindex:all` (a rebuild already queued or running, from the boot hook, the housekeeping or the CLI, is
// joined and answered), audits `catalog.search.reindex` once, and answers 202 `{jobId}`; the job's progress is the
// job's own (GET jobs/:id, `jobs.<id>`). `mode: system` (§12.3: an edition never locks the index), `idempotency:
// store` (a resend answers the same job), `maintenance: deny`.

let fallbackRegistry: JobRegistry | null = null;

/** The handlers of this release: the job runtime's, else (no runtime in this process yet) the handler array's. */
function registryOf(rc: RouteContext<unknown, unknown, unknown>): JobRegistry {
  const runtime = rc.services.jobs;
  if (runtime !== null) return runtime.registry;
  fallbackRegistry ??= createJobRegistry(jobHandlers());
  return fallbackRegistry;
}

/** POST catalog/search/reindex. */
const reindex = route({
  id: 'catalog.search.reindex',
  method: 'POST',
  path: '/api/v1/catalog/search/reindex',
  permission: 'system.diagnostics.manage',
  mode: 'system',
  idempotency: 'store',
  audit: 'catalog.search.reindex',
  async handler(rc) {
    // Unreachable: a permission route runs with a session.
    if (rc.auth === null) throw new DomainError('AUTH_REQUIRED');
    const { jobId, existing } = await enqueueReindex(rc.tx().trx, registryOf(rc), { scope: 'all' }, {
      now: rc.now,
      keyring: rc.config.keyring,
      createdBy: rc.auth.subjectId,
    });
    await rc.audit({ entity: 'jobs', entityId: jobId, meta: { scope: 'all', joined: existing } });
    rc.afterCommit(() => rc.services.jobs?.kick());
    const body: ReindexResponse = { jobId };
    return { status: 202, body };
  },
});

export const SEARCH_ROUTES: RouteDecl[] = [reindex];
