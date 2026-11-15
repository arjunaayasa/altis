import { withTx } from '@altis/db';
import type { ReportsHousekeepingStep } from '../reports/housekeeping/index.js';

// The step `notices` of `reports.housekeeping`: a member notice is kept 400 days after it was queued, then its row is
// deleted (the rows hold ids and states only; the log and the member's data export read them until then). Age-based
// (skipped while the clock looks wrong). In batches of 500 by creation time; nothing to resume from, so no cursor.

const DAY = 86_400_000;

/** How long a notice row is kept. */
export const NOTICE_RETENTION_DAYS = 400;

const BATCH = 500;
/** Below this much budget left, no further batch starts in this slice (the first always does). */
const BATCH_MARGIN_MS = 2000;

/** Notices older than {@link NOTICE_RETENTION_DAYS} days are deleted. */
export const noticesRetentionStep: ReportsHousekeepingStep = Object.freeze<ReportsHousekeepingStep>({
  name: 'notices',
  ageBased: true,
  async run(c) {
    const before = c.now - NOTICE_RETENTION_DAYS * DAY;
    let worked = false;
    for (;;) {
      if (worked && c.budgetLeftMs() < BATCH_MARGIN_MS) return { done: false, cursor: null };
      const ids = (await c.h.db.selectFrom('notices').select('id').where('created_at', '<', before).orderBy('created_at').orderBy('id').limit(BATCH).execute()).map(
        (r) => r.id,
      );
      if (ids.length === 0) return { done: true, cursor: null };
      await withTx(c.h, (trx) => trx.deleteFrom('notices').where('id', 'in', ids).where('created_at', '<', before).execute());
      worked = true;
      if (ids.length < BATCH) return { done: true, cursor: null };
    }
  },
});
