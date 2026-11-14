import type { DB } from '@altis/db';
import type { ResultsView } from '@altis/shared/api/accreditation';
import type { Kysely, Transaction } from 'kysely';
import type { KeyringEntry } from '../../crypto/secret-box.js';
import { enqueue } from '../../jobs/enqueue.js';
import type { JobRegistry } from '../../jobs/types.js';
import type { AccredSettings } from '../../settings/accreditation.js';
import { instrumentById } from '../instruments/index.js';
import { periodNotFound } from '../periods/errors.js';
import { lastChangeOf } from '../periods/last-change.js';
import { composeResults, type ComposedResults } from './compose.js';
import { EVALUATE_JOB, evaluateKey } from './job.js';
import { readStoredResults } from './results.js';

// The evaluation of a period (spec §10.4, §10.10): its queueing, the results as the workspace reads them (the score
// composed when they are read, from the stored suggestions and the current answers), the freeze and its snapshots.
//
// Results are stale when nothing was computed yet or the period's last change is at or after the start of the
// evaluation that computed them (`computedAt`): a change in the same millisecond counts as later.

export { evaluateJob, evaluatePayload } from './job.js';
export type { EvaluatePayload } from './job.js';
export { copySnapshotDossier, freezePeriod, unfreezePeriod } from '../freeze.js';
export { getSnapshot, listSnapshots, openSnapshotDossier } from '../snapshots.js';

/**
 * Queues the evaluation of the live period `periodId`; a live evaluation of that period is joined (`existing`).
 *
 * @throws DomainError `NOT_FOUND` for an unknown or archived period
 */
export async function enqueueEvaluate(
  trx: Transaction<DB>,
  periodId: string,
  o: { now: number; createdBy: string; registry: JobRegistry; keyring: readonly KeyringEntry[] },
): Promise<{ jobId: string; existing: boolean }> {
  const period = await trx.selectFrom('accred_periods').select('id').where('id', '=', periodId).where('archived_at', 'is', null).executeTakeFirst();
  if (period === undefined) throw periodNotFound();
  const job = await enqueue(trx, o.registry, { type: EVALUATE_JOB, payload: { periodId }, uniqueKey: evaluateKey(periodId), createdBy: o.createdBy }, { now: o.now, keyring: o.keyring });
  return { jobId: job.id, existing: job.existing };
}

const EMPTY: ComposedResults = { prerequisites: null, indicators: [], snp: [], score: null, missingEvidence: [] };

/**
 * A period's results: the evaluation's state (a live job of the period is `queued` until its first slice marks it
 * `running`; a running state whose job has ended reads as `failed`), when they were computed, the last change, whether
 * they are stale, and the composition of the stored values with the current answers and evidence (compose.ts).
 *
 * @throws DomainError `NOT_FOUND` for an unknown or archived period
 */
export async function getResults(db: Kysely<DB>, periodId: string, settings: AccredSettings, now: number): Promise<ResultsView> {
  void settings;
  void now;
  const period = await db.selectFrom('accred_periods').select(['instrument_id']).where('id', '=', periodId).where('archived_at', 'is', null).executeTakeFirst();
  if (period === undefined) throw periodNotFound();
  const stored = await readStoredResults(db, periodId);
  const changedAt = await lastChangeOf(db, periodId);
  const live = await db.selectFrom('jobs').select('id').where('unique_key', '=', evaluateKey(periodId)).executeTakeFirst();
  const meta = stored.meta;

  let status: ResultsView['status'];
  let jobId: string | null;
  if (live !== undefined) {
    status = meta?.status === 'running' && meta.jobId === live.id ? 'running' : 'queued';
    jobId = live.id;
  } else if (meta === null) {
    status = 'missing';
    jobId = null;
  } else {
    status = meta.status === 'running' ? 'failed' : meta.status;
    jobId = meta.jobId;
  }
  const computedAt = meta?.computedAt ?? null;
  const instrument = instrumentById(period.instrument_id);
  const composed = instrument === null ? EMPTY : await composeResults(db, periodId, instrument, stored.rows);
  return {
    status,
    computedAt,
    changedAt,
    stale: computedAt === null || (changedAt !== null && changedAt >= computedAt),
    jobId,
    prerequisites: composed.prerequisites ?? meta?.prerequisites ?? null,
    indicators: composed.indicators,
    snp: composed.snp,
    score: composed.score,
    missingEvidence: composed.missingEvidence,
  };
}
