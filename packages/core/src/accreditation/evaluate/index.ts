// Stub: replaced by a later change in this milestone.
// The evaluation of a period: its queueing, the results as the workspace reads them (the score composed at read time),
// the freeze and its snapshots. The signatures are final; every body throws until the evaluation is written.
/* eslint-disable @typescript-eslint/no-unused-vars -- the parameters of the final signatures are not read yet */
import type { DB } from '@altis/db';
import type { DataPath } from '@altis/platform';
import type { FreezeBody, ResultsView, SnapshotListResponse, SnapshotView } from '@altis/shared/api/accreditation';
import type { StoreResponse } from '@altis/shared/api/catalog/common';
import type { Kysely, Transaction } from 'kysely';
import type { TxCtx } from '../../context.js';
import type { KeyringEntry } from '../../crypto/secret-box.js';
import type { StorageDriver } from '../../files/serve.js';
import type { JobRegistry } from '../../jobs/types.js';
import type { AccredSettings } from '../../settings/accreditation.js';

export { evaluateJob, evaluatePayload } from './job.js';
export type { EvaluatePayload } from './job.js';

function notImplemented(): never {
  throw new Error('not implemented yet');
}

/** Queues the evaluation of `periodId` (a live evaluation of that period is joined). */
export async function enqueueEvaluate(
  trx: Transaction<DB>,
  periodId: string,
  o: { now: number; createdBy: string; registry: JobRegistry; keyring: readonly KeyringEntry[] },
): Promise<{ jobId: string; existing: boolean }> {
  return notImplemented();
}

/** A period's results: the stored values and suggestions, the current answers, the score, the evidence. */
export async function getResults(db: Kysely<DB>, periodId: string, settings: AccredSettings, now: number): Promise<ResultsView> {
  return notImplemented();
}

/** Freezes an open period whose results are fresh and keeps its snapshot. */
export async function freezePeriod(tx: TxCtx, periodId: string, body: FreezeBody, now: number): Promise<StoreResponse> {
  return notImplemented();
}

/** Opens a frozen period again; its snapshots stay. */
export async function unfreezePeriod(tx: TxCtx, periodId: string, now: number): Promise<StoreResponse> {
  return notImplemented();
}

/** The snapshots of a period, newest first. */
export async function listSnapshots(db: Kysely<DB>, periodId: string): Promise<SnapshotListResponse> {
  return notImplemented();
}

/** One snapshot with its frozen values. */
export async function getSnapshot(db: Kysely<DB>, id: string): Promise<SnapshotView> {
  return notImplemented();
}

/** The frozen dossier copy of a snapshot, to download. */
export async function openSnapshotDossier(
  db: Kysely<DB>,
  id: string,
  storage: StorageDriver,
): Promise<{ path: DataPath; size: number; fileName: string; mime: string; snapshotId: string }> {
  return notImplemented();
}
