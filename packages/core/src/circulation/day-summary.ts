import { countRows } from '@altis/db';
import type { CirculationDaySummary } from '@altis/shared/api/circulation-summary';
import { sql, type SqlBool } from 'kysely';
import type { Db } from '../members/common.js';
import { branchToday } from './dates.js';

// The numbers of the day at one branch for the dashboard (see @altis/shared/api/circulation-summary): four counts over
// the loan and hold indexes (lending day, return day, open loans by due date, holds by status), each of them cheap.

/** Today's loans, returns, overdue open loans and holds ready for pickup at `branchId`, at `now`. */
export async function circulationDaySummary(db: Db, branchId: string, now: number): Promise<CirculationDaySummary> {
  const on = await branchToday(db, branchId, now);
  const [loaned, returned, overdue, holdsReady] = await Promise.all([
    countRows(
      db
        .selectFrom('loans')
        .where('loaned_on', '=', on)
        .where('branch_id', '=', branchId)
        .where(sql<SqlBool>`(outcome is null or outcome <> 'voided')`),
    ),
    countRows(db.selectFrom('loans').where('returned_on', '=', on).where('return_branch_id', '=', branchId).where('outcome', '=', 'returned')),
    countRows(db.selectFrom('loans').where('open_item_id', 'is not', null).where('due_on', '<', on).where('branch_id', '=', branchId)),
    countRows(db.selectFrom('holds').where('status', '=', 'ready').where('pickup_branch_id', '=', branchId)),
  ]);
  return { branchId, on, loaned, returned, overdue, holdsReady };
}
