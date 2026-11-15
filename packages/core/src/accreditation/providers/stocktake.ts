import { addDays, localDate } from '@altis/shared';
import { ACCRED_METRICS, metricsOfProvider, type AccredMetricId } from '../metric-ids.js';
import type { AccredMetricContext, AccredMetricProvider, AccredMetricValue } from '../types.js';
import { resolveWindow } from '../windows.js';
import { computeRegisterMetrics, metricValue, periodDates } from './registers-metrics.js';

// The `stocktake` metric provider: the recount and weeding standard (`registers.stocktake_weeding_3y`). The register's
// stock-take and weeding activities count as they always did (registers-metrics.ts); a stocktake session that finished
// (in ALTIS, or migrated from SLiMS) counts as a stock-take too, on the day it finished in the library's time zone. The
// value adds the sessions finished in the window to the register's activities, and the last stock-take is the later
// of the register's and the sessions' (a session finished after the snapshot date does not count). A session is no
// register row: its value is `live` once a session counts, the register's detail list stays the evidence list.

const RECOUNT: AccredMetricId = 'registers.stocktake_weeding_3y';
/** Sessions read at most (a library finishes a few a year). */
const SESSIONS_MAX = 1000;

/** The stocktake metrics among `ids`. */
export async function computeStocktakeMetrics(ctx: AccredMetricContext, ids: readonly AccredMetricId[]): Promise<Map<AccredMetricId, AccredMetricValue>> {
  const out = new Map<AccredMetricId, AccredMetricValue>();
  if (!ids.includes(RECOUNT)) return out;
  const base = (await computeRegisterMetrics(ctx, [RECOUNT])).get(RECOUNT)!;
  const w = resolveWindow(ACCRED_METRICS[RECOUNT].window, periodDates(ctx.period), ctx.D);
  // Finished by the end of D wherever the library is (UTC−12 … UTC+14 lies within a day either side).
  const before = Date.parse(`${addDays(ctx.D, 2)}T00:00:00Z`);
  const rows = await ctx.db
    .selectFrom('stocktakes')
    .select('finished_at')
    .where('status', '=', 'finished')
    .where('finished_at', 'is not', null)
    .where('finished_at', '<', before)
    .orderBy('finished_at', 'desc')
    .limit(SESSIONS_MAX)
    .execute();
  const days = rows.map((r) => localDate(ctx.settings.timezone, Number(r.finished_at))).filter((d) => d <= ctx.D);
  const inWindow = days.filter((d) => d >= w.from && d <= w.to).length;
  const lastSession = days.length === 0 ? null : days.reduce((a, b) => (b > a ? b : a));
  const lastRegister = typeof base.facts?.['lastStocktake'] === 'string' ? base.facts['lastStocktake'] : null;
  const lastStocktake = lastSession !== null && (lastRegister === null || lastSession > lastRegister) ? lastSession : lastRegister;
  out.set(
    RECOUNT,
    metricValue(RECOUNT, (base.value ?? 0) + inWindow, inWindow > 0 ? 'live' : base.basis, {
      notes: base.notes,
      ...(base.detail === undefined ? {} : { detail: base.detail }),
      facts: { ...base.facts, lastStocktake },
    }),
  );
  return out;
}

export const stocktakeProvider: AccredMetricProvider = Object.freeze<AccredMetricProvider>({
  id: 'stocktake',
  metrics: metricsOfProvider('stocktake'),
  compute: async (ctx, ids) => ({ done: true, values: await computeStocktakeMetrics(ctx, ids) }),
});
