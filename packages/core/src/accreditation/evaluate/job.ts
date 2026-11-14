import { withTx } from '@altis/db';
import { isDomainError, localDate } from '@altis/shared';
import type { PrerequisitesView } from '@altis/shared/api/accreditation';
import { ulidField } from '@altis/shared/api/common';
import { z } from 'zod';
import { errorFields } from '../../context.js';
import { publish } from '../../events/publish.js';
import type { JobContext, JobHandler, JobOutcome } from '../../jobs/types.js';
import type { ReportJobDeps } from '../../reports/export/job.js';
import { loadAccredSettings } from '../../settings/accreditation.js';
import { instrumentById } from '../instruments/index.js';
import type { AccredMetricId } from '../metric-ids.js';
import { readProfile } from '../periods/profile.js';
import { ACCRED_METRIC_PROVIDERS } from '../providers/index.js';
import type { AccredMetricContext, AccredMetricProvider, AccredMetricValue, ProviderStep } from '../types.js';
import { snapshotDate } from '../windows.js';
import { evaluationMetrics, itemPayload, metricParamsOf, resultItems, valueReader, type ResultItem } from './compose.js';
import { META_CODE, noValue, readCarried, readMeta, readStoredResults, removeCarried, removeOtherRows, writeCarried, writeMeta, writeResultRow } from './results.js';

// `accreditation.evaluate` (spec §10.4): computes the metrics of a period's instrument provider by provider, across as
// many slices as they need, and stores each item's result (compose.ts) as soon as every metric it needs is computed.
//
// - The first slice notes its start (`startedAt`, the evaluation's `computedAt` once it is ready: results are stale when
//   anything changed at or after it) and writes `_meta {status: 'running', startedAt, jobId}`. Every value is computed
//   as of that start (its date in the library's time zone gives the snapshot date of the period).
// - The providers run in the registry's order (a test passes its own), each asked for the metrics it is the first to
//   own; one that answers "not done" ends the slice with its resume point, and so does a budget too short to start the
//   next provider. A metric its provider answered nothing for has no data; a metric no provider owns has none either.
// - When a provider is done, the items whose metrics are now all computed get their rows, in one transaction with the
//   values an item of a later provider still needs (kept for the slices after this one). The last transaction writes
//   the last items, removes the kept values and any row of an older evaluation that is not one of the instrument's,
//   writes `_meta {status: 'ready', startedAt, jobId, computedAt: startedAt, durationMs, prerequisites}` and, as its
//   last statement, publishes `accreditation.results.changed {periodId}` on the channel `accreditation`.
// - A failure writes `_meta {status: 'failed'}` and goes to the queue, which runs the slice again from its last
//   checkpoint while attempts remain; a slice that runs again marks the evaluation running. A cancelled evaluation
//   ends failed. A period archived meanwhile ends the job without writing anything.

/** The evaluation's payload: its period and, between slices, its start, the provider it is at and where it stopped. */
export const evaluatePayload = z.strictObject({
  periodId: ulidField,
  startedAt: z.number().int().min(0).optional(),
  providerIndex: z.int().min(0).max(63).optional(),
  resume: z.strictObject({ cursor: z.string().max(32_000), state: z.unknown() }).nullable().optional(),
});

export type EvaluatePayload = z.infer<typeof evaluatePayload>;

/** The job type. */
export const EVALUATE_JOB = 'accreditation.evaluate';

/** The unique key of the evaluation of `periodId`: one live evaluation per period. */
export function evaluateKey(periodId: string): string {
  return `${EVALUATE_JOB}:${periodId}`;
}

/** Another provider starts in the same slice only with this much of the budget left. */
const PROVIDER_START_MIN_MS = 5_000;

/** Who computes what, and when each item is written. */
interface Plan {
  items: ResultItem[];
  /** Per provider, the metrics it is asked for (those it is the first to own). */
  asked: AccredMetricId[][];
  /** Per item, the provider after which it is written (the providers' count: at the end). */
  stageOf: Map<ResultItem, number>;
  /** Per provider, the metrics it computes that an item of a later stage needs. */
  carried: AccredMetricId[][];
}

function planOf(items: ResultItem[], providers: readonly AccredMetricProvider[]): Plan {
  const wanted = evaluationMetrics(items);
  const owner = new Map<AccredMetricId, number>();
  for (const id of wanted) {
    const at = providers.findIndex((p) => p.metrics.includes(id));
    owner.set(id, at === -1 ? providers.length : at);
  }
  const asked = providers.map((_, i) => wanted.filter((id) => owner.get(id) === i));
  const stageOf = new Map<ResultItem, number>();
  for (const item of items) stageOf.set(item, Math.max(0, ...item.metrics.map((m) => owner.get(m)!)));
  const carried = providers.map((_, i) => asked[i]!.filter((id) => items.some((item) => stageOf.get(item)! > i && item.metrics.includes(id))));
  return { items, asked, stageOf, carried };
}

/**
 * `accreditation.evaluate`: interactive (the workspace drives it), one live job per period.
 *
 * @param o.providers the metric providers, in order (default the registry's; tests pass their own)
 */
export function evaluateJob(deps: () => ReportJobDeps, o: { providers?: readonly AccredMetricProvider[] } = {}): JobHandler<EvaluatePayload> {
  return {
    type: EVALUATE_JOB,
    permission: 'accreditation.workspace.read',
    retryable: 'api',
    interactive: true,
    payload: evaluatePayload,
    run: (ctx, p) => evaluate(ctx, p, deps, o.providers ?? ACCRED_METRIC_PROVIDERS),
  };
}

async function evaluate(
  ctx: JobContext,
  p: EvaluatePayload,
  deps: () => ReportJobDeps,
  providers: readonly AccredMetricProvider[],
): Promise<JobOutcome<EvaluatePayload>> {
  const d = deps();
  const periodId = p.periodId;
  const period = await ctx.db.selectFrom('accred_periods').selectAll().where('id', '=', periodId).where('archived_at', 'is', null).executeTakeFirst();
  if (period === undefined) {
    d.log.warn('accreditation evaluation: the period is gone', { jobId: ctx.jobId, periodId });
    return { done: true };
  }
  const startedAt = p.startedAt ?? ctx.now();
  const failed = async (): Promise<void> => {
    await withTx(ctx.handle, (trx) => writeMeta(trx, periodId, { status: 'failed', startedAt, jobId: ctx.jobId }, ctx.now()));
  };
  try {
    const instrument = instrumentById(period.instrument_id);
    if (instrument === null) {
      d.log.warn('accreditation evaluation: the period names an instrument this build does not have', { jobId: ctx.jobId, periodId });
      await failed();
      return { done: true };
    }
    const meta = await readMeta(ctx.db, periodId);
    const mine = meta !== null && meta.jobId === ctx.jobId && meta.startedAt === startedAt;
    // The last transaction committed but the queue never heard of it (the process was stopped): nothing is left to do.
    if (mine && meta.status === 'ready') return { done: true };
    if (!mine || meta.status !== 'running') {
      await withTx(ctx.handle, async (trx) => {
        // A new evaluation starts without the values an earlier one kept.
        if (p.startedAt === undefined) await removeCarried(trx, periodId);
        await writeMeta(trx, periodId, { status: 'running', startedAt, jobId: ctx.jobId }, startedAt);
      });
    }

    const settings = await loadAccredSettings(ctx.db);
    const today = localDate(settings.timezone, startedAt);
    const D = snapshotDate(period.ends_on, today);
    const plan = planOf(resultItems(instrument), providers);
    const metricCtx: AccredMetricContext = {
      db: ctx.db,
      periodId,
      period,
      profile: readProfile(period.profile),
      instrument,
      D,
      today,
      settings,
      baseUrl: d.baseUrl === '' ? null : d.baseUrl,
      now: startedAt,
      budgetLeftMs: () => ctx.budgetLeftMs(),
      paramsOf: metricParamsOf(instrument),
    };

    let index = p.providerIndex ?? 0;
    let resume = p.resume ?? null;
    // The values of the providers before `index`, kept by the slices that computed them.
    const values: Map<AccredMetricId, AccredMetricValue> = index > 0 ? await readCarried(ctx.db, periodId) : new Map();
    const valueOf = valueReader(values);
    const progress = (i: number): number => (providers.length === 0 ? 100 : Math.floor((i * 100) / providers.length));
    const next = (providerIndex: number, r: EvaluatePayload['resume']): JobOutcome<EvaluatePayload> => ({
      continueWith: { periodId, startedAt, providerIndex, resume: r },
      progress: progress(providerIndex),
    });

    let ranOne = false;
    for (; index < providers.length; index += 1, resume = null) {
      if (ctx.cancelled()) {
        await failed();
        return { done: true };
      }
      if (ranOne && ctx.budgetLeftMs() < PROVIDER_START_MIN_MS) return next(index, null);
      await ctx.heartbeat({ progress: progress(index) });
      const ids = plan.asked[index]!;
      const step: ProviderStep = ids.length === 0 ? { done: true, values: new Map() } : await providers[index]!.compute(metricCtx, ids, resume);
      ranOne = true;
      if (!step.done) return next(index, step.resume);
      for (const id of ids) values.set(id, step.values.get(id) ?? noValue(id));
      if (index === providers.length - 1) break;
      const stage = index;
      const rows = plan.items.filter((item) => plan.stageOf.get(item) === stage).map((item) => ({ code: item.code, json: itemPayload(item, valueOf, D).json }));
      await withTx(ctx.handle, async (trx) => {
        for (const r of rows) await writeResultRow(trx, periodId, r.code, r.json, startedAt);
        for (const id of plan.carried[stage]!) await writeCarried(trx, periodId, id, valueOf(id), startedAt);
      });
    }

    // Every provider is done: the items of the last one and those no provider computes, the evaluation's end and its
    // event, in one transaction.
    const rows: { code: string; json: string }[] = [];
    let prerequisites: PrerequisitesView | null = null;
    for (const item of plan.items) {
      if (plan.stageOf.get(item)! < providers.length - 1) continue;
      const built = itemPayload(item, valueOf, D);
      if (built.prerequisites !== null) prerequisites = built.prerequisites;
      rows.push({ code: item.code, json: built.json });
    }
    const finishedAt = ctx.now();
    await withTx(ctx.handle, async (trx) => {
      for (const r of rows) await writeResultRow(trx, periodId, r.code, r.json, startedAt);
      await removeOtherRows(trx, periodId, [...plan.items.map((item) => item.code), META_CODE]);
      let found = prerequisites;
      if (found === null) {
        // Written by an earlier provider's transaction.
        const row = (await readStoredResults(trx, periodId)).rows.get(plan.items.find((item) => item.kind === 'prerequisites')!.code);
        found = row?.kind === 'prerequisites' ? row.prerequisites : null;
      }
      await writeMeta(
        trx,
        periodId,
        {
          status: 'ready',
          startedAt,
          jobId: ctx.jobId,
          computedAt: startedAt,
          durationMs: Math.max(0, finishedAt - startedAt),
          ...(found === null ? {} : { prerequisites: found }),
        },
        startedAt,
      );
      await publish(trx, { channel: 'accreditation', type: 'accreditation.results.changed', payload: { periodId } });
    });
    return { done: true };
  } catch (error) {
    // Another process holds the job now: the state is its to write.
    if (isDomainError(error) && error.code === 'JOB_LEASE_LOST') throw error;
    d.log.warn('accreditation evaluation failed', { jobId: ctx.jobId, periodId, ...errorFields(error) });
    await failed().catch((e: unknown) => d.log.error('accreditation evaluation: its failure could not be recorded', { jobId: ctx.jobId, periodId, ...errorFields(e) }));
    throw error;
  }
}
