// Stub: replaced by a later change in this milestone.
// The SLiMS usage import: the connection test and the start of an import. The signatures are final; every body
// throws until the import is written.
/* eslint-disable @typescript-eslint/no-unused-vars -- the parameters of the final signatures are not read yet */
import type { DB } from '@altis/db';
import type { SlimsDbConfigBody, SlimsUsageStartBody, SlimsUsageTestResponse } from '@altis/shared/api/accreditation';
import type { Transaction } from 'kysely';
import type { KeyringEntry } from '../../crypto/secret-box.js';
import type { JobRegistry } from '../../jobs/types.js';
import type { AccredSettings } from '../../settings/accreditation.js';

export { importSlimsUsageJob, importSlimsUsagePayload } from './job.js';
export type { ImportSlimsUsagePayload } from './job.js';
export { slimsUsageRunSettings } from './settings.js';
export type { SlimsUsageRunSettings } from './settings.js';

function notImplemented(): never {
  throw new Error('not implemented yet');
}

/** Opens a SLiMS database read only and answers what an import would read (a failure is `{ok: false}`). */
export async function testSlimsUsageConnection(cfg: SlimsDbConfigBody): Promise<SlimsUsageTestResponse> {
  return notImplemented();
}

/** Creates a `slims_usage` run started from the period `periodId` and queues its import job. */
export async function startSlimsUsageImport(
  trx: Transaction<DB>,
  periodId: string,
  body: SlimsUsageStartBody,
  o: { now: number; createdBy: string; registry: JobRegistry; keyring: readonly KeyringEntry[]; settings: AccredSettings },
): Promise<{ runId: string; jobId: string }> {
  return notImplemented();
}
