import { z } from 'zod';
import { metricsOfProvider, type AccredMetricId } from '../metric-ids.js';
import type { AccredMetricContext, AccredMetricProvider, AccredMetricValue, ProviderResume, ProviderStep } from '../types.js';
import { resolveUsage } from '../usage/index.js';
import { collectionMetricValue, collectionUsedValue, type CollectionScope } from './collection-metrics.js';
import {
  checkedCounters,
  collectionDays,
  CollectionCounters,
  holdsParts,
  isCollectionMetric,
  newCounters,
  partsFor,
  runCollectionPass,
  type CollectionMetricId,
} from './collection-scan.js';

// The `collection` metric provider (spec §10.5, §10.6, §10.8): the stock at the snapshot date `D` and what it holds
// (titles, copies, undated copies, fiction, printed titles by DDC class, the collection by medium and kind, processing,
// local works, enrichment and reference titles, recent serials), the additions of the three calendar years and of the
// period, and the share of the collection used in the period (its usage figure from the monthly usage table, its base
// the stock). Every asked metric is counted in one pass over the titles; when the slice's budget runs low the pass
// stops between batches and answers its counters as the resume state, and the next slice goes on from the last title
// read. The values are computed once the pass has read every title.

const resumeCursor = z.string().min(1).max(26);

/** The last title read and the counters of a resume state this provider answered. */
function readResume(resume: ProviderResume, parts: ReturnType<typeof partsFor>): { after: string; counters: CollectionCounters } {
  const cursor = resumeCursor.safeParse(resume.cursor);
  const state = CollectionCounters.safeParse(resume.state);
  if (!cursor.success || !state.success || !holdsParts(state.data, parts)) throw new TypeError('collection provider: a resume state it did not answer');
  return { after: cursor.data, counters: state.data };
}

async function compute(ctx: AccredMetricContext, ids: readonly AccredMetricId[], resume: ProviderResume | null): Promise<ProviderStep> {
  const asked: CollectionMetricId[] = [];
  for (const id of ids) {
    if (!isCollectionMetric(id)) throw new TypeError(`the collection provider does not compute ${id}`);
    asked.push(id);
  }
  if (asked.length === 0) return { done: true, values: new Map() };
  const parts = partsFor(asked);
  const span = { startsOn: ctx.period.starts_on, endsOn: ctx.period.ends_on };
  const days = collectionDays(span, ctx.D);
  const from = resume === null ? { after: null, counters: newCounters(parts) } : readResume(resume, parts);
  const pass = await runCollectionPass(ctx.db, {
    tz: ctx.settings.timezone,
    days,
    settings: ctx.settings,
    after: from.after,
    counters: from.counters,
    budgetLeftMs: () => ctx.budgetLeftMs(),
  });
  if (!pass.done) return { done: false, resume: { cursor: pass.after, state: checkedCounters(pass.counters) } };

  const scope: CollectionScope = { periodId: ctx.periodId, days, settings: ctx.settings, scanners: ctx.period.scanners, paramsOf: (m) => ctx.paramsOf(m) };
  const values = new Map<AccredMetricId, AccredMetricValue>();
  for (const id of asked) {
    if (id === 'usage.collection_used_pct') {
      // A range figure of the usage table: the row of exactly the period's span.
      const periodSpan = { from: span.startsOn, to: span.endsOn };
      const usage = await resolveUsage(ctx.db, periodSpan, ctx.settings);
      const used = usage.spanValue(ctx.settings.usedUnit === 'items' ? 'items_used' : 'titles_used', periodSpan);
      values.set(id, collectionUsedValue(pass.counters, used, ctx.settings));
    } else {
      values.set(id, collectionMetricValue(id, pass.counters, scope));
    }
  }
  return { done: true, values };
}

export const collectionProvider: AccredMetricProvider = Object.freeze<AccredMetricProvider>({
  id: 'collection',
  metrics: metricsOfProvider('collection'),
  compute,
});
