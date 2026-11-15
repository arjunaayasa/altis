import { countGrouped } from '@altis/db';
import type { MessageKey } from '@altis/shared';
import { z } from 'zod';
import { instantRange, label, offsetPage } from '../collection/common.js';
import { sumOf } from '../circulation/common.js';
import { reportColumn, reportDateRangeField, reportIdField, reportParam } from '../params.js';
import type { ReportCtx, ReportRow, TableReport } from '../types.js';
import { PERIOD_FILTER, rangeOrPeriodSpan } from '../window.js';

// What each staff member did (personal data: the staff names), read from the structured audit log by the actor of each
// entry, never from the rows the work touched (a record edited later keeps who made it in the log): the catalogue
// records and copies they created (a batch of copies counted by its size), the members they registered (one by one,
// or the new members of an import they ran for real), and the loans, returns and renewals they made at the desk. Only
// a staff member's own entries count: a member renewing in the OPAC or a scheduled job is no staff member. A staff
// member without any of these entries in the span is not listed; the rows are ordered by the total, most first, then
// by name. Filtered by a date range (the last 30 days by default) or an accreditation period, in the library's days.

/** The counted columns, in order. */
const COUNTS = ['records', 'items', 'members', 'loans', 'returns', 'renewals'] as const;

type Count = (typeof COUNTS)[number];

/** The audit actions counted one per entry, and their column. */
const ONE_EACH: Readonly<Record<string, Count>> = Object.freeze({
  'catalog.record.create': 'records',
  'catalog.item.create': 'items',
  'members.member.create': 'members',
  'circulation.loan.create': 'loans',
  'circulation.loan.return': 'returns',
  'circulation.loan.renew': 'renewals',
});

/** The audit actions that carry their count in their details. */
const BATCH_ITEMS = 'catalog.item.batch_create';
const MEMBER_IMPORT = 'members.import.finish';

/** A whole non-negative count in an entry's details, else 0. */
function countIn(meta: Record<string, unknown>, key: string): number {
  const v = meta[key];
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : 0;
}

/** The details of an audit entry as an object (an unreadable one as none). */
function metaOf(text: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function activity(ctx: ReportCtx): Promise<{ rows: ReportRow[]; totals: ReportRow }> {
  const span = await rangeOrPeriodSpan(ctx, 'range', 30);
  const at = instantRange(ctx.tz, span);
  const inSpan = (actions: readonly string[]) =>
    ctx.db
      .selectFrom('audit_log as a')
      .where('a.at', '>=', at.from!)
      .where('a.at', '<', at.to!)
      .where('a.actor_type', '=', 'staff')
      .where('a.actor_id', 'is not', null)
      .where('a.action', 'in', [...actions]);

  const byActor = new Map<string, Record<Count, number>>();
  const add = (actor: string, column: Count, n: number): void => {
    if (n === 0) return;
    let counts = byActor.get(actor);
    if (counts === undefined) {
      counts = { records: 0, items: 0, members: 0, loans: 0, returns: 0, renewals: 0 };
      byActor.set(actor, counts);
    }
    counts[column] += n;
  };
  for (const g of await countGrouped(inSpan(Object.keys(ONE_EACH)), { u: 'a.actor_id', x: 'a.action' })) {
    const column = ONE_EACH[String(g.x)];
    if (g.u !== null && column !== undefined) add(String(g.u), column, g.count);
  }
  for (const e of await inSpan([BATCH_ITEMS, MEMBER_IMPORT]).select(['a.actor_id', 'a.action', 'a.meta']).execute()) {
    const meta = metaOf(e.meta);
    if (e.actor_id === null) continue;
    if (e.action === BATCH_ITEMS) add(e.actor_id, 'items', countIn(meta, 'count'));
    else if (meta['dryRun'] !== true) add(e.actor_id, 'members', countIn(meta, 'inserted'));
  }

  const ids = [...byActor.keys()];
  const names = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 500) {
    const found = await ctx.db
      .selectFrom('staff_users')
      .select(['id', 'name'])
      .where('id', 'in', ids.slice(i, i + 500))
      .execute();
    for (const s of found) names.set(s.id, s.name);
  }
  const unknown = label(ctx, 'report.row.staff_unknown' as MessageKey);
  const listed = ids
    .map((id) => ({ name: names.get(id) ?? unknown, counts: COUNTS.map((c) => byActor.get(id)![c]) }))
    .sort((a, b) => sumOf(b.counts) - sumOf(a.counts) || a.name.localeCompare(b.name));
  const rows: ReportRow[] = listed.map((r) => [r.name, ...r.counts, sumOf(r.counts)]);
  const sums = COUNTS.map((_, k) => sumOf(listed.map((r) => r.counts[k]!)));
  return { rows, totals: [label(ctx, 'report.row.total' as MessageKey), ...sums, sumOf(sums)] };
}

/** What each staff member did, from the audit log (see the top of this file). */
export const systemStaffActivityReport: TableReport = Object.freeze<TableReport>({
  id: 'system.staff_activity',
  module: 'system',
  kind: 'table',
  titleKey: 'report.system.staff_activity.title',
  permission: 'system.audit.read',
  exportPermission: 'system.audit.export',
  personal: true,
  formats: ['csv', 'xlsx', 'pdf'],
  orientation: 'landscape',
  params: [reportParam('range', 'dateRange'), PERIOD_FILTER],
  paramsSchema: z.strictObject({ range: reportDateRangeField.optional(), periodId: reportIdField.optional() }),
  columns: [
    reportColumn('staff', 'text', { source: { table: 'staff_users', column: 'name' }, widthChars: 28 }),
    ...COUNTS.map((key) => reportColumn(key, 'int')),
    reportColumn('total', 'int'),
  ],
  async rows(ctx, cursor, limit) {
    return offsetPage((await activity(ctx)).rows, cursor, limit);
  },
  async totals(ctx) {
    return (await activity(ctx)).totals;
  },
});
