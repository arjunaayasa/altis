import { upsert, withTx, type DbHandle } from '@altis/db';
import { addDays, endOfMonth, type AccredGroup } from '@altis/shared';
import type { DateSpan } from '../windows.js';
import { nextMonth, type UsageCells } from './count.js';
import { guessGroup } from './guess.js';

// The write step of a SLiMS usage import: everything it counted goes into `usage_stats` (source `slims`) and the
// member types it met into `usage_group_map`, in one transaction, so a reader sees the old import or the new one,
// never a mixture, and a run that fails before this step changes neither table.
//
// - The import's rows replace those of the same source over what it covers: every `slims` row whose span lies between
//   the first day of the first month and the last day of the last month it counted, and the `slims` rows of the three
//   period spans. Rows of other sources (`manual`) are never touched.
// - A month row spans its month, or, in the month of the cut-over, its first day to the day before the cut-over. Every
//   month from the first to the last carries its totals of visits (raw and without repeats) and loans, 0 included, so
//   a month without use reads as 0 and not as "no data". A span row (titles and copies used, distinct borrowers and
//   visitors, members active) spans one of the three period spans.
// - Member types: the mapping the import was started with overwrites a type's group; a type met for the first time
//   gets the group its name suggests (guessGroup), and an existing one keeps its group (its label follows SLiMS); the
//   members SLiMS no longer has get the group the start named, else (the first time) the setting's default.

/** One row of `usage_stats` this import writes. */
export interface UsageStatRow {
  metric: string;
  spanFrom: string;
  spanTo: string;
  groupKey: string;
  value: number;
}

/** What the write step stores. */
export interface UsageWriteInput {
  runId: string;
  now: number;
  /** The staff user who started the import (the group mapping they gave is theirs). */
  createdBy: string | null;
  cutoverOn: string | null;
  spans: readonly DateSpan[];
  /** Per month: metric → group → count. */
  monthly: Readonly<Record<string, UsageCells>>;
  /** Per span (as `spans`): metric → group → count. */
  spanCells: readonly UsageCells[];
  /** SLiMS member type id → name (`mst_member_type`). */
  types: Readonly<Record<string, string>>;
  /** The type ids the members carry (a type without a `mst_member_type` row among them). */
  memberTypeIds: readonly string[];
  memberTypeGroups?: Readonly<Record<string, AccredGroup | null>>;
  /** Given at the start: overwrites; absent: the default is used when the row does not exist yet. */
  unknownMemberGroup?: AccredGroup | null;
  unknownMemberGroupDefault: AccredGroup | null;
}

/** The totals every month carries, 0 included. */
const MONTH_TOTALS = ['visits', 'visits_deduped', 'loans'] as const;
/** Rows per INSERT. */
const INSERT_BATCH = 100;
/** The key of the members SLiMS no longer has. */
const UNKNOWN_KEY = 'member_unknown';

/** Every month from `first` to `last`, `YYYY-MM`. */
function monthRange(first: string, last: string): string[] {
  const out: string[] = [];
  for (let m = first; m <= last; m = nextMonth(m)) out.push(m);
  return out;
}

/** The rows the import writes (see the top of this file), one per key. */
export function usageRows(input: Pick<UsageWriteInput, 'cutoverOn' | 'spans' | 'monthly' | 'spanCells'>): {
  rows: UsageStatRow[];
  months: string[];
} {
  const rows = new Map<string, UsageStatRow>();
  const put = (r: UsageStatRow): void => {
    rows.set(`${r.metric}|${r.spanFrom}|${r.spanTo}|${r.groupKey}`, r);
  };
  const counted = Object.keys(input.monthly)
    .filter((m) => Object.keys(input.monthly[m]!).length > 0)
    .sort();
  const months = counted.length === 0 ? [] : monthRange(counted[0]!, counted[counted.length - 1]!);
  const cutMonth = input.cutoverOn?.slice(0, 7) ?? null;
  for (const month of months) {
    const spanFrom = `${month}-01`;
    const spanTo = month === cutMonth ? addDays(input.cutoverOn!, -1) : endOfMonth(month);
    const cells = input.monthly[month] ?? {};
    for (const metric of MONTH_TOTALS) put({ metric, spanFrom, spanTo, groupKey: '', value: cells[metric]?.[''] ?? 0 });
    for (const [metric, groups] of Object.entries(cells)) {
      for (const [groupKey, value] of Object.entries(groups)) if (value > 0) put({ metric, spanFrom, spanTo, groupKey, value });
    }
  }
  input.spans.forEach((span, i) => {
    for (const [metric, groups] of Object.entries(input.spanCells[i] ?? {})) {
      for (const [groupKey, value] of Object.entries(groups)) if (value > 0) put({ metric, spanFrom: span.from, spanTo: span.to, groupKey, value });
    }
  });
  return { rows: [...rows.values()], months };
}

/**
 * Stores the import (see the top of this file) in one transaction of its own.
 *
 * @returns the months it covers and the rows it wrote
 */
export async function writeUsageImport(h: DbHandle, input: UsageWriteInput): Promise<{ months: number; rows: number }> {
  const { rows, months } = usageRows(input);
  await withTx(h, async (trx) => {
    if (months.length > 0) {
      await trx
        .deleteFrom('usage_stats')
        .where('source', '=', 'slims')
        .where('span_from', '>=', `${months[0]!}-01`)
        .where('span_to', '<=', endOfMonth(months[months.length - 1]!))
        .execute();
    }
    for (const span of input.spans) {
      await trx.deleteFrom('usage_stats').where('source', '=', 'slims').where('span_from', '=', span.from).where('span_to', '=', span.to).execute();
    }
    for (let at = 0; at < rows.length; at += INSERT_BATCH) {
      await trx
        .insertInto('usage_stats')
        .values(
          rows.slice(at, at + INSERT_BATCH).map((r) => ({
            source: 'slims',
            metric: r.metric,
            span_from: r.spanFrom,
            span_to: r.spanTo,
            branch_key: '',
            group_key: r.groupKey,
            value: r.value,
            run_id: input.runId,
            updated_at: input.now,
            updated_by: null,
          })),
        )
        .execute();
    }

    // The member types.
    const mapped = input.memberTypeGroups ?? {};
    const ids = [...new Set([...Object.keys(input.types), ...input.memberTypeIds, ...Object.keys(mapped)])].sort();
    const keys = [...ids.map((id) => `slims_type:${id}`), UNKNOWN_KEY];
    const existing = new Map(
      (await trx.selectFrom('usage_group_map').select(['group_key', 'label', 'accred_group']).where('group_key', 'in', keys).execute()).map((r) => [r.group_key, r] as const),
    );
    for (const id of ids) {
      const groupKey = `slims_type:${id}`;
      const before = existing.get(groupKey);
      // The SLiMS name; a type SLiMS no longer names keeps the label it has, or is labelled by its id.
      const named = Object.hasOwn(input.types, id) ? input.types[id]! : (before?.label ?? id);
      if (Object.hasOwn(mapped, id)) {
        const accred = mapped[id] ?? null;
        await upsert(
          trx,
          'usage_group_map',
          { group_key: groupKey },
          { label: named, accred_group: accred, updated_at: input.now, updated_by: input.createdBy },
          { label: named, accred_group: accred, updated_at: input.now, updated_by: input.createdBy },
        );
      } else if (before === undefined) {
        await upsert(
          trx,
          'usage_group_map',
          { group_key: groupKey },
          { label: named, accred_group: guessGroup(named), updated_at: input.now, updated_by: null },
          { label: named, updated_at: input.now },
        );
      } else if (before.label !== named) {
        await trx.updateTable('usage_group_map').set({ label: named, updated_at: input.now }).where('group_key', '=', groupKey).execute();
      }
    }
    if (input.unknownMemberGroup !== undefined) {
      const accred = input.unknownMemberGroup;
      await upsert(
        trx,
        'usage_group_map',
        { group_key: UNKNOWN_KEY },
        { label: '', accred_group: accred, updated_at: input.now, updated_by: input.createdBy },
        { accred_group: accred, updated_at: input.now, updated_by: input.createdBy },
      );
    } else if (!existing.has(UNKNOWN_KEY)) {
      // A row another writer adds meanwhile keeps its group.
      await upsert(
        trx,
        'usage_group_map',
        { group_key: UNKNOWN_KEY },
        { label: '', accred_group: input.unknownMemberGroupDefault, updated_at: input.now, updated_by: null },
        { updated_at: input.now },
      );
    }
  });
  return { months: months.length, rows: rows.length };
}
