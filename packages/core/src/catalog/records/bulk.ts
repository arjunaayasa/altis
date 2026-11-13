// Stub: replaced by a later change in this milestone.
// The bulk change of the records' accreditation fields. The signature is final; the body throws until it is written.
/* eslint-disable @typescript-eslint/no-unused-vars -- the parameters of the final signature are not read yet */
import type { RecordBulkBody, RecordBulkResponse } from '@altis/shared/api/catalog/records';
import type { TxCtx } from '../../context.js';

/** Sets the given accreditation fields of up to 500 records; unknown and archived records are refused one by one. */
export async function bulkUpdateRecords(tx: TxCtx, body: RecordBulkBody, now: number): Promise<RecordBulkResponse> {
  throw new Error('not implemented yet');
}
