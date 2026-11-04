import { withTx } from '@altis/db';
import { isUlid } from '@altis/shared';
import { errorFields } from '../../context.js';
import type { CatalogHousekeepingStep, HousekeepingStepContext } from '../housekeeping.js';

/**
 * The orphan-upload step of `catalog.housekeeping` (spec §8, §12.6; plan Task 18): a cover, attachment, floor plan or
 * page image whose upload completed but that no record, attachment, location or page claimed within 24 hours is
 * removed (its stored content, then its `files` row), since 1c's `files.cleanup` only cleans DATA_DIR folders. A cover
 * a record let go of (Task 16) turns into such an upload too.
 *
 * In batches of 200 rows (`context` one of the four, `owner_id IS NULL`, `created_at < now − 24 h`), by id:
 * 1. one short transaction marks the batch's rows that are still unclaimed (`owner_type 'orphan'`, access `staff`) and
 *    reads which rows carry the mark. Every claim (a cover, an attachment, a floor plan, a page image) takes only a
 *    row whose owner columns are both null, so a claim that comes after the mark fails cleanly instead of winning a
 *    row whose blob is about to go, and a claim that came before it keeps its file;
 * 2. the blobs of the marked rows are deleted (outside any transaction, R37); one that fails is logged and its row
 *    stays marked for the next run;
 * 3. one short transaction deletes the marked rows whose blob went.
 * A run killed anywhere leaves at worst marked rows (some without their blob), which the next run finishes, so no blob
 * is ever left without its row. Two runs at once do the same idempotent deletes. The step ends after a short batch,
 * or returns its cursor (the last id of the batch) when the slice's budget runs low; a batch always runs first.
 */

/** The upload contexts whose unclaimed files are removed. */
const ORPHAN_CONTEXTS = ['catalog.cover', 'catalog.attachment', 'catalog.floor_plan', 'opac.page_image'] as const;
/** An upload has this long to be claimed (spec §8: 24 hours). */
const ORPHAN_AGE_MS = 24 * 3_600_000;
/** Rows per batch. */
const BATCH = 200;
/** Below this much budget left, no further batch starts in this slice. */
const BATCH_MARGIN_MS = 1000;
/** The `owner_type` of a row this step is removing (see step 1 above). */
const ORPHAN_MARK = 'orphan';

export const orphanUploadsStep: CatalogHousekeepingStep = Object.freeze({
  name: 'orphan_uploads',
  async run(c: HousekeepingStepContext) {
    const cutoff = c.now - ORPHAN_AGE_MS;
    let cursor = c.cursor !== null && isUlid(c.cursor) ? c.cursor : null;
    for (;;) {
      let q = c.h.db
        .selectFrom('files')
        .select('id')
        .where('context', 'in', ORPHAN_CONTEXTS)
        .where('owner_id', 'is', null)
        .where('created_at', '<', cutoff);
      if (cursor !== null) q = q.where('id', '>', cursor);
      const batch = (await q.orderBy('id').limit(BATCH).execute()).map((r) => r.id);
      if (batch.length === 0) return { done: true, cursor: null };

      const marked = await withTx(c.h, async (trx) => {
        await trx
          .updateTable('files')
          .set({ owner_type: ORPHAN_MARK, access: 'staff' })
          .where('id', 'in', batch)
          .where('context', 'in', ORPHAN_CONTEXTS)
          .where('owner_id', 'is', null)
          .where('created_at', '<', cutoff)
          .execute();
        const rows = await trx.selectFrom('files').select('id').where('id', 'in', batch).where('owner_type', '=', ORPHAN_MARK).where('owner_id', 'is', null).execute();
        return rows.map((r) => r.id);
      });

      const gone: string[] = [];
      for (const id of marked) {
        try {
          await c.deps.storage.delete(id);
          gone.push(id);
        } catch (error) {
          c.deps.log.warn('catalog.housekeeping: an orphan upload could not be removed; the next run tries again', { fileId: id, ...errorFields(error) });
        }
      }
      if (gone.length > 0) {
        await withTx(c.h, (trx) => trx.deleteFrom('files').where('id', 'in', gone).where('owner_type', '=', ORPHAN_MARK).where('owner_id', 'is', null).execute());
      }

      cursor = batch[batch.length - 1]!;
      if (batch.length < BATCH) return { done: true, cursor: null };
      if (c.budgetLeftMs() < BATCH_MARGIN_MS) return { done: false, cursor };
    }
  },
});
