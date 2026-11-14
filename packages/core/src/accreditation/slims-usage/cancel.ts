import { withTx, type DbHandle } from '@altis/db';
import { dataPath, removeTree, runWorkDir } from '@altis/platform';
import { ulidField } from '@altis/shared/api/common';
import { z } from 'zod';
import { finishRun } from '../../catalog/data/runs.js';
import { errorFields, type CoreLogger } from '../../context.js';
import { SLIMS_USAGE_JOB, closeAbandonedUsageRun } from './start.js';

// A usage import cancelled while its job waited in the queue (spec §11.2: the raw dump lives only until it is split,
// and a cancelled import leaves nothing behind). The start moves the uploaded dump, member names and addresses
// included, into the run's folder `tmp/<runId>/dump.bin` at once; a queued job is cancelled without any slice of it
// running, and the handler is `origin-only`, so the job never runs again. Nothing else would remove the dump before the
// next start or the catalogue housekeeping, and an installation without a scheduler never runs the housekeeping.

/** The part of the job's payload that names a dump's upload. */
const dumpPayload = z.looseObject({
  state: z.looseObject({ source: z.looseObject({ kind: z.literal('dump'), uploadId: ulidField }) }),
});

function jsonObject(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * After the COMMIT of the cancel that ended usage import job `jobId` while it was queued: removes its run's work folder
 * (the raw dump with it) and what is left of the dump's upload, then ends the run `cancelled` with the finish entry its
 * own end would have written (by the system actor, no rows written). The files go first, so a crash in between leaves
 * the run of a cancelled job, which the next start and the catalogue housekeeping end, removing its folder at once; a
 * removal that fails is logged and leaves the run to them too. Nothing is done for a job that is not a cancelled usage
 * import, or whose run has already ended (whatever ended it removed its folder). Never rejects.
 */
export async function releaseCancelledUsageImport(h: DbHandle, o: { jobId: string; dataDir: string; now: number; log: CoreLogger }): Promise<void> {
  try {
    const job = await h.db.selectFrom('jobs').select(['type', 'status', 'payload']).where('id', '=', o.jobId).executeTakeFirst();
    if (job === undefined || job.type !== SLIMS_USAGE_JOB || job.status !== 'cancelled') return;
    const run = await h.db
      .selectFrom('catalog_runs')
      .select(['id', 'status', 'summary'])
      .where('job_id', '=', o.jobId)
      .where('kind', '=', 'slims_usage')
      .executeTakeFirst();
    if (run === undefined || (run.status !== 'queued' && run.status !== 'running')) return;
    const dump = dumpPayload.safeParse(jsonObject(job.payload));
    await removeTree(runWorkDir(o.dataDir, run.id));
    if (dump.success) await removeTree(dataPath(o.dataDir, 'tmp', dump.data.state.source.uploadId));
    await withTx(h, async (trx) => {
      if (!(await finishRun(trx, run.id, { status: 'cancelled', summary: jsonObject(run.summary) }, o.now))) return;
      await closeAbandonedUsageRun(trx, { runId: run.id, status: 'cancelled', now: o.now });
    });
  } catch (error) {
    o.log.warn('SLiMS usage import: what a cancelled import left could not be removed', { jobId: o.jobId, ...errorFields(error) });
  }
}
