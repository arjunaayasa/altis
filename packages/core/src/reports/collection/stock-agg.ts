import { z } from 'zod';
import { STOCK_SCAN_MAX_LIMIT, scanRecordStock, type RecordStockFacts } from '../stock/index.js';
import type { ReportCtx, ReportRow } from '../types.js';
import { SCAN_MARGIN_MS, decodeCursor, encodeCursor } from './common.js';

// The stock scan of the collection reports, resumable through the report's cursor (spec §4.15: a report whose answer
// needs the stock at a day other than today, or the acquisition date of every copy, reads every title through the
// stock reader). A call reads batches of titles while its budget lasts (at least one batch, so the cursor always
// moves) and then answers either its rows or, when the scan is not done, no rows and a cursor that holds where the
// scan stands:
// - an aggregate (summary, DDC recap, acquisitions) keeps its running counts in the cursor and answers all its rows in
//   the call that ends the scan (an aggregate has at most a few thousand rows);
// - a list (titles, copies, the copies of a year, undated copies) answers its rows as it finds them, up to the page's
//   limit, and keeps the scan's position (the last title it finished, and the last copy of a title it stopped in).

/** The titles read in one batch. */
export const STOCK_BATCH = STOCK_SCAN_MAX_LIMIT;

/** The scan's position: the last title read, or null to start. */
const scanKey = z.string().min(1).max(26).nullable();

/**
 * One call of an aggregate's scan from `cursor` (null: from the start, with `init()`). Each batch of titles is added
 * into the counts by `visit`. Answers the counts once the scan is done, or the cursor to continue from.
 */
export async function scanAggregate<A>(
  ctx: ReportCtx,
  cursor: string | null,
  o: { branchId: string | null; schema: z.ZodType<A>; init: () => A; visit: (acc: A, batch: readonly RecordStockFacts[]) => void | Promise<void> },
): Promise<{ done: true; acc: A } | { done: false; cursor: string }> {
  const state = cursor === null ? { k: null, a: o.init() } : decodeCursor(cursor, z.strictObject({ k: scanKey, a: o.schema }));
  let after: string | null = state.k;
  const acc = state.a;
  for (;;) {
    const batch = await scanRecordStock(ctx.db, { tz: ctx.tz, after, limit: STOCK_BATCH, branchId: o.branchId });
    await o.visit(acc, batch.rows);
    if (batch.next === null) return { done: true, acc };
    after = batch.next;
    if (ctx.budgetLeftMs() < SCAN_MARGIN_MS) return { done: false, cursor: encodeCursor({ k: after, a: acc }) };
  }
}

/** One row a list found: the title and copy it is about (a title's row has no copy) and its cells. */
export interface ListEntry {
  recordId: string;
  itemId: string | null;
  row: ReportRow;
}

/**
 * One page of a list read through the scan, from `cursor`: `entries` turns a batch of titles into rows, in the scan's
 * order (by title, a title's copies by copy). Answers up to `limit` rows and the cursor of the rest (null at the end); a
 * page may hold no rows when the budget ran out first.
 */
export async function scanList(
  ctx: ReportCtx,
  cursor: string | null,
  limit: number,
  o: { branchId: string | null; entries: (batch: readonly RecordStockFacts[]) => Promise<ListEntry[]> },
): Promise<{ rows: ReportRow[]; nextCursor: string | null }> {
  // `k`: the last title done; `s`: the last copy answered of the title after it (null: none yet).
  const state = cursor === null ? { k: null, s: null } : decodeCursor(cursor, z.strictObject({ k: scanKey, s: z.string().min(1).max(26).nullable() }));
  let after: string | null = state.k;
  let skip: string | null = state.s;
  const rows: ReportRow[] = [];
  for (;;) {
    const batch = await scanRecordStock(ctx.db, { tz: ctx.tz, after, limit: STOCK_BATCH, branchId: o.branchId });
    const first = batch.rows[0]?.recordId ?? null;
    let found = await o.entries(batch.rows);
    if (skip !== null) {
      const from = skip;
      found = found.filter((e) => e.recordId !== first || e.itemId === null || e.itemId > from);
      skip = null;
    }
    // At least one row fits: the loop only goes on while the page has room.
    const room = limit - rows.length;
    if (found.length > room) {
      const taken = found.slice(0, room);
      rows.push(...taken.map((e) => e.row));
      const last = taken[taken.length - 1]!;
      // The page ends with a whole title: go on after it; inside a title: before it, past its last copy answered.
      if (found[room]!.recordId !== last.recordId) return { rows, nextCursor: encodeCursor({ k: last.recordId, s: null }) };
      return { rows, nextCursor: encodeCursor({ k: previousTitle(batch.rows, last.recordId, after), s: last.itemId }) };
    }
    rows.push(...found.map((e) => e.row));
    if (batch.next === null) return { rows, nextCursor: null };
    after = batch.next;
    if (rows.length >= limit || ctx.budgetLeftMs() < SCAN_MARGIN_MS) return { rows, nextCursor: encodeCursor({ k: after, s: null }) };
  }
}

/** The title read just before `recordId` in `batch` (or `after`, the scan's position before the batch). */
function previousTitle(batch: readonly RecordStockFacts[], recordId: string, after: string | null): string | null {
  let previous = after;
  for (const r of batch) {
    if (r.recordId === recordId) return previous;
    previous = r.recordId;
  }
  return previous;
}
