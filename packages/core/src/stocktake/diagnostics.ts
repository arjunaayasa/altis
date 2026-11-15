import type { DiagnosticsStocktake } from '@altis/shared/api/diagnostics';
import { codesKeyPrefix, countsOf, type Db } from './common.js';

// The Diagnostik card of stocktake: each session under way (preparing, active or finishing) with its preparation or
// finish job and the code lists still being applied, and why one does not move. A preparing or finishing session
// needs a live job: without one (none queued, or the last one ended dead or cancelled) it is stuck, as it is when its
// live job has not reported for a while (a job waiting to run counts from its last write too: no runner takes it).

/** A live job that has not written for this long is stalled. */
export const STOCKTAKE_JOB_STALL_MS = 10 * 60_000;
/** Sessions the card lists at most (one per branch can be under way). */
const SESSIONS_MAX = 20;

/** The sessions under way, oldest first (see the top of this file). */
export async function stocktakeDiagnostics(db: Db, now: number): Promise<DiagnosticsStocktake[]> {
  const rows = await db
    .selectFrom('stocktakes as s')
    .innerJoin('branches as b', 'b.id', 's.branch_id')
    .select(['s.id', 's.name', 's.status', 's.started_at', 's.total', 's.found', 's.misplaced', 's.on_loan', 's.unexpected', 's.unknown_codes', 'b.id as branch_id', 'b.code_display', 'b.name as branch_name'])
    .where('s.status', 'in', ['preparing', 'active', 'finishing'])
    .orderBy('s.started_at')
    .orderBy('s.id')
    .limit(SESSIONS_MAX)
    .execute();
  const out: DiagnosticsStocktake[] = [];
  for (const r of rows) {
    const status = r.status as DiagnosticsStocktake['status'];
    const type = status === 'finishing' ? 'stocktake.finish' : 'stocktake.prepare';
    // The session's id is a ULID: as a quoted value it names the session's jobs in their JSON payloads only.
    const job = await db
      .selectFrom('jobs')
      .select(['id', 'type', 'status', 'progress', 'updated_at'])
      .where('type', '=', type)
      .where('payload', 'like', `%"stocktakeId":"${r.id}"%`)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst();
    const uploads = await db.selectFrom('jobs').select('id').where('unique_key', 'like', `${codesKeyPrefix(r.id)}%`).execute();
    let stuck: DiagnosticsStocktake['stuck'] = null;
    if (status !== 'active') {
      if (job === undefined) stuck = 'no_job';
      else if (job.status !== 'queued' && job.status !== 'running') stuck = 'job_ended';
      else if (now - Number(job.updated_at) > STOCKTAKE_JOB_STALL_MS) stuck = 'stalled';
    }
    const c = countsOf(r);
    out.push({
      id: r.id,
      branch: { id: r.branch_id, code: r.code_display, name: r.branch_name },
      name: r.name,
      status,
      startedAt: Number(r.started_at),
      counts: { total: c.total, found: c.found, pending: c.pending },
      job: job === undefined ? null : { id: job.id, type, status: job.status, progress: Number(job.progress), updatedAt: Number(job.updated_at) },
      pendingUploads: uploads.length,
      stuck,
    });
  }
  return out;
}
