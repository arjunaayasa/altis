import { createHash } from 'node:crypto';
import { DomainError } from '@altis/shared';
import type { StorageDriver } from '../files/serve.js';
import { sessionNotFound, type Db } from './common.js';

// The report file SLiMS wrote for a stocktake session (an HTML page of another system), brought over by the SLiMS
// migration's stocktake stage: a `files` row of the session (`stocktakes.report_file_id`), staff only, of a context of
// its own that `/files/:id` never serves (its owner is a session, catalog/attachments/access.ts). The branch-checked
// route of the session is its only way out, as an attachment of an opaque type: the page must never render in the admin
// origin.
//
// Its id is derived from the session's: a migration run that stored the bytes and died before its commit stores them
// again under the same key when it, or the next run, comes back to the session, so no blob is left behind.

/** The context and owner type of a stored SLiMS stocktake report (the owner type is the minutes' one). */
export const STOCKTAKE_SLIMS_REPORT_CONTEXT = 'stocktake.slims_report';
export const STOCKTAKE_SLIMS_REPORT_OWNER = 'stocktakes';

/** The type a stored SLiMS report is kept and served as: opaque bytes, never a page. */
export const STOCKTAKE_SLIMS_REPORT_MIME = 'application/octet-stream';

/** The largest SLiMS report file the migration brings over. */
export const STOCKTAKE_SLIMS_REPORT_MAX_BYTES = 20 * 1024 * 1024;

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * The file id of the SLiMS report of session `sessionId`: the session id's time part, then 80 bits of a SHA-256 of the
 * session id (a valid ULID, the same for the same session every time).
 */
export function stocktakeReportFileId(sessionId: string): string {
  const digest = createHash('sha256').update(`${STOCKTAKE_SLIMS_REPORT_CONTEXT}:${sessionId}`).digest();
  let bits = 0n;
  for (const b of digest.subarray(0, 10)) bits = (bits << 8n) | BigInt(b);
  let tail = '';
  for (let i = 15; i >= 0; i -= 1) tail += CROCKFORD[Number((bits >> BigInt(i * 5)) & 31n)];
  return `${sessionId.slice(0, 10)}${tail}`;
}

/** The stored SLiMS report of the session `id` of `branchId`, as it is served. */
export interface StocktakeSlimsReport {
  name: string;
  size: number;
  content: AsyncIterable<Uint8Array>;
}

/**
 * The stored SLiMS report of the session `id` of `branchId`.
 *
 * @throws DomainError NOT_FOUND (a session not of the branch; a session without a report, or whose blob is gone)
 */
export async function stocktakeSlimsReport(db: Db, storage: StorageDriver, branchId: string, id: string): Promise<StocktakeSlimsReport> {
  const row = await db
    .selectFrom('stocktakes as s')
    .leftJoin('files as f', (j) =>
      j
        .onRef('f.id', '=', 's.report_file_id')
        .on('f.owner_type', '=', STOCKTAKE_SLIMS_REPORT_OWNER)
        .onRef('f.owner_id', '=', 's.id')
        .on('f.context', '=', STOCKTAKE_SLIMS_REPORT_CONTEXT)
        .on('f.status', '=', 'ok'),
    )
    .select(['s.id', 'f.id as file_id', 'f.original_name', 'f.size'])
    .where('s.id', '=', id)
    .where('s.branch_id', '=', branchId)
    .executeTakeFirst();
  if (row === undefined) throw sessionNotFound();
  const missing = (): DomainError => new DomainError('NOT_FOUND', { detail: 'Sesi ini tidak punya laporan SLiMS / This session has no SLiMS report' });
  if (row.file_id === null) throw missing();
  const size = Number(row.size);
  const stored = await storage.stat(row.file_id);
  if (stored === null || stored.size !== size) throw missing();
  const content = await storage.get(row.file_id);
  if (content === null) throw missing();
  return { name: row.original_name ?? 'laporan-slims.html', size, content };
}
