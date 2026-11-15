import type { DB } from '@altis/db';
import type { Transaction } from 'kysely';
import type { RunEnd } from '../../catalog/data/runs.js';
import { txCtx, type Actor } from '../../context.js';
import { createJobRegistry } from '../../jobs/registry.js';
import type { JobRegistry } from '../../jobs/types.js';
import { enqueueReindex, searchJobs } from '../../search/jobs.js';
import { SEARCH_TOKEN_VERSION } from '../../search/tokenize.js';
import { slimsTargetCounts } from './targets.js';

// A SLiMS migration run ended outside its job's slices (C17; E22, spec §11.2-§11.3): its job was cancelled while
// queued, died (its last attempt failed, or its lease ran out), or is gone, so pipeline.ts's `finish` never ran. Whoever
// ends such a run (the next start's endOrphanRuns, the housekeeping step's `runs` phase) does in the same transaction
// what `finish` does besides the run row and the report: it ends the run's hold of the search index when this run's job
// had marked it `building` (a real run past `analyze`; the OPAC's "results may be incomplete" notice), as `finish` does
// (releaseSlimsSearchIndex), and writes `catalog.migration.finish` by the system actor with `meta.status` (written for
// every end of a run). A real run's report rows of the ALTIS tables are counted again, as `finish` counts them: what it
// wrote before its job stopped shows as added, not the counts its first stage took.

const SYSTEM: Actor = { type: 'system', id: null, ip: null };

/** A registry that knows the payload of `catalog.reindex`, for enqueue (its handler never runs from it). */
const reindexRegistry: JobRegistry = createJobRegistry(
  searchJobs(() => {
    throw new TypeError('catalog.reindex of the SLiMS ending registry never runs');
  }),
);

/**
 * Ends the hold a run's job `jobId` has of the search index (pipeline.ts markIndexBuilding), in the transaction that
 * ends the run, at `now`. While `search_state` is still `building` under that job (L03: a full rebuild that started
 * during the run holds it, and marks it ready itself), the index is made ready with its document count, build time and
 * token format when every document it holds is of this release's format: `token_version`, which the run's take kept
 * only when the index it took was (or inserted over an empty catalogue). Otherwise (the index was built by another
 * tokenizer, or an update changed the tokenizer while the run was in flight, X2-2) the state stays `building` and a
 * full rebuild is queued, joined when one is (none can have started since the take: it would hold the state), and it
 * marks the index ready over documents of one format. A state another build holds is left to it.
 */
export async function releaseSlimsSearchIndex(trx: Transaction<DB>, o: { jobId: string; now: number }): Promise<void> {
  const state = await trx.selectFrom('search_state').select(['status', 'job_id', 'token_version']).where('id', '=', 1).executeTakeFirst();
  if (state?.status !== 'building' || state.job_id !== o.jobId) return;
  if (state.token_version === null || Number(state.token_version) !== SEARCH_TOKEN_VERSION) {
    await enqueueReindex(trx, reindexRegistry, { scope: 'all' }, { now: o.now, keyring: [], createdBy: null });
    return;
  }
  const docs = Number(
    (await trx.selectFrom('search_doc').select((eb) => eb.fn.countAll<number | string | bigint>().as('n')).executeTakeFirstOrThrow()).n,
  );
  await trx
    .updateTable('search_state')
    .set({ status: 'ready', docs, job_id: null, built_at: o.now, token_version: SEARCH_TOKEN_VERSION })
    .where('id', '=', 1)
    .where('status', '=', 'building')
    .where('job_id', '=', o.jobId)
    .execute();
}

/** The run's report rows of the ALTIS tables with their counts now (a summary without them is left as it is). */
async function recountTargets(trx: Transaction<DB>, runId: string): Promise<void> {
  const row = await trx.selectFrom('catalog_runs').select('summary').where('id', '=', runId).executeTakeFirst();
  let summary: Record<string, unknown>;
  try {
    summary = JSON.parse(row?.summary ?? 'null') as Record<string, unknown>;
  } catch {
    return;
  }
  const targets = summary?.['targets'];
  if (!Array.isArray(targets) || targets.length === 0) return;
  const counts: Record<string, number> = await slimsTargetCounts(trx);
  summary['targets'] = (targets as { table: string; before: number; after: number }[]).map((t) => ({ ...t, after: counts[t.table] ?? t.after }));
  await trx.updateTable('catalog_runs').set({ summary: JSON.stringify(summary) }).where('id', '=', runId).execute();
}

/** See the top of this file; call it in the transaction that ended run `runId` (`status`, at `now`). */
export async function closeAbandonedSlimsRun(
  trx: Transaction<DB>,
  o: { runId: string; jobId: string | null; status: RunEnd; dryRun: boolean; now: number },
): Promise<void> {
  if (o.jobId !== null) await releaseSlimsSearchIndex(trx, { jobId: o.jobId, now: o.now });
  if (!o.dryRun) await recountTargets(trx, o.runId);
  await txCtx(trx, o.now, SYSTEM).audit({
    action: 'catalog.migration.finish',
    entity: 'catalog_runs',
    entityId: o.runId,
    meta: { status: o.status, dryRun: o.dryRun, jobId: o.jobId, abandoned: true },
  });
}
