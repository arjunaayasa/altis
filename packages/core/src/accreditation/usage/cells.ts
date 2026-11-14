import { upsert } from '@altis/db';
import { endOfMonth } from '@altis/shared';
import { UsagePutBody } from '@altis/shared/api/accreditation';
import type { TxCtx } from '../../context.js';
import { periodFieldErrors, periodNotFound, parsePeriodBody, type PeriodFieldError } from '../periods/errors.js';
import { lockOpenPeriod } from '../periods/lock.js';
import { MONTHLY_METRICS, SPAN_METRICS } from './grid.js';
import { monthsOfSpan } from './resolve.js';

// The manual cells of a period's monthly usage (spec §10.7): a librarian's own figure for a month (or, for a metric of
// the whole period, for the period's span), which wins over the SLiMS import for that cell. A cell is part of the
// period's data, so its write takes the period lock first and a frozen period refuses it. The usage rows belong to the
// whole installation, not to one period; every write also touches the period's row, so the last change of this period
// (and of every period overlapping it) moves even when the only change removed a cell.

/**
 * Writes the manual cells of `body` for the open period `periodId`: a cell with a value is stored over its month
 * (first to last day) or, with `month: null`, over the period's span; a cell with `value: null` is removed. The
 * period's `updated_at` becomes `now` (its version stays). Audited `accreditation.usage.update` with `{cells: n}`.
 *
 * @throws DomainError `NOT_FOUND`, `ACCRED_PERIOD_FROZEN` (from the lock); `VALIDATION_FAILED` with one error per
 *   refused cell: `cells.<i>.metric` `import_only` (the visits without repeats, which only an import counts; the
 *   contract refuses it before the lock), `cells.<i>.month` `out_of_period` (a month outside the period), `required` (a
 *   monthly metric without a month), `invalid` (a metric of the whole period with a month); `cells.<i>` `duplicate`
 *   (the same cell again)
 */
export async function putUsageCells(tx: TxCtx, periodId: string, body: UsagePutBody, now: number): Promise<void> {
  const input = parsePeriodBody(UsagePutBody, body);
  const { trx } = tx;
  await lockOpenPeriod(trx, periodId);
  const period = await trx.selectFrom('accred_periods').select(['starts_on', 'ends_on']).where('id', '=', periodId).executeTakeFirst();
  if (period === undefined) throw periodNotFound();

  const months = new Set(monthsOfSpan(period.starts_on, period.ends_on));
  const errors: PeriodFieldError[] = [];
  const seen = new Set<string>();
  input.cells.forEach((c, i) => {
    if (c.month === null) {
      if (!SPAN_METRICS.includes(c.metric)) errors.push({ path: `cells.${i}.month`, code: 'required' });
    } else if (!MONTHLY_METRICS.includes(c.metric)) {
      errors.push({ path: `cells.${i}.month`, code: 'invalid' });
    } else if (!months.has(c.month)) {
      errors.push({ path: `cells.${i}.month`, code: 'out_of_period' });
    }
    const key = `${c.metric}\u0000${c.month ?? ''}\u0000${c.groupKey}`;
    if (seen.has(key)) errors.push({ path: `cells.${i}`, code: 'duplicate' });
    seen.add(key);
  });
  if (errors.length > 0) throw periodFieldErrors(errors);

  for (const c of input.cells) {
    const key = {
      source: 'manual',
      metric: c.metric,
      span_from: c.month === null ? period.starts_on : `${c.month}-01`,
      span_to: c.month === null ? period.ends_on : endOfMonth(c.month),
      branch_key: '',
      group_key: c.groupKey,
    };
    if (c.value === null) {
      await trx
        .deleteFrom('usage_stats')
        .where('source', '=', key.source)
        .where('metric', '=', key.metric)
        .where('span_from', '=', key.span_from)
        .where('span_to', '=', key.span_to)
        .where('branch_key', '=', key.branch_key)
        .where('group_key', '=', key.group_key)
        .execute();
    } else {
      const values = { value: c.value, run_id: null, updated_at: now, updated_by: tx.actor.id };
      await upsert(trx, 'usage_stats', key, { ...key, ...values }, values);
    }
  }
  await trx.updateTable('accred_periods').set({ updated_at: now }).where('id', '=', periodId).execute();
  await tx.audit({ action: 'accreditation.usage.update', entity: 'accred_periods', entityId: periodId, meta: { cells: input.cells.length } });
}
