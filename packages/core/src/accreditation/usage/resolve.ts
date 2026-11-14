import type { DB } from '@altis/db';
import { ACCRED_GROUPS, addMonths, endOfMonth, monthOf, type AccredGroup, type UsageMetric } from '@altis/shared';
import { USAGE_IMPORT_ONLY_METRICS } from '@altis/shared/api/accreditation';
import type { Kysely } from 'kysely';
import type { AccredSettings } from '../../settings/accreditation.js';
import type { ResolvedCell, ResolvedUsage } from './index.js';

// How a cell of the monthly usage table is resolved (spec §10.7). A cell is a month (or a span of its own), a metric
// and a group; its value comes from the first source that has rows for it: a manual cell, then the live data of the
// modules that record usage (none in this edition: `USAGE_SOURCES` is empty, so that tier is skipped), then the SLiMS
// aggregate import, else there is no data. A month cell sums the rows of that source whose span lies inside the month:
// a cut-over month holds a SLiMS row that ends the day before the cut-over, and the cell carries that end.
//
// The rows name their group with a key, mapped when the table is read (a new mapping needs no new import):
// - `grp:<group>` is that population group (the manual cells);
// - `slims_type:<id>` (a member type of the source system) and `member_unknown` (members the source no longer has) go
//   through `usage_group_map`; a deleted-members key without a row there takes the default of the settings, a member
//   type without a row there, and a row naming no group, count in no group (`unmapped`);
// - `guest` is the guests, `''` the total only; a class key (`ddc:<class>`) is no group at all.
// The total of a month is its `''` row; without one in any source, the sum of every group's cell.
//
// The visits a source counts: a manual cell its `visits`; a SLiMS row its visits without repeats (`visits_deduped`)
// while the setting that removes repeats from imported visits is on, its raw `visits` otherwise. The visits without
// repeats are the import's own figure (USAGE_IMPORT_ONLY_METRICS): the manual cells refuse that metric, and a manual
// row of it (one written before that rule) is never read, so the grid shows and the results count the same figure.

/** A source of a stored cell, in the order a cell is resolved. */
export type UsageRowSource = 'manual' | 'slims';

const SOURCES: readonly UsageRowSource[] = Object.freeze(['manual', 'slims']);

/** A group a row counts in: a population group, the guests, or none (`unmapped`). */
export type UsageGroup = AccredGroup | 'guest' | 'unmapped';

/** Every group, in the order the grid and the annexes print them; a total without its own row sums them. */
export const USAGE_GROUPS: readonly UsageGroup[] = Object.freeze([...ACCRED_GROUPS, 'guest', 'unmapped']);

/** A stored row of `usage_stats` (one installation-wide branch key). */
interface UsageRow {
  source: UsageRowSource;
  metric: string;
  from: string;
  to: string;
  key: string;
  value: number;
}

/** The rows of a source that make a cell: their sum and the latest end of their spans. */
interface Part {
  value: number;
  source: UsageRowSource;
  to: string;
}

const NONE: ResolvedCell = Object.freeze({ value: null, source: 'none', spanTo: null });
const NO_ROWS: readonly UsageRow[] = Object.freeze([]);

const isGroup = (g: string | null): g is AccredGroup => g !== null && (ACCRED_GROUPS as readonly string[]).includes(g);

/** The months `YYYY-MM` from the month of `from` to the month of `to`, both included; none when `to` is before `from`. */
export function monthsOfSpan(from: string, to: string): string[] {
  const out: string[] = [];
  if (to < from) return out;
  const last = monthOf(to);
  for (let day = `${monthOf(from)}-01`; monthOf(day) <= last; day = addMonths(day, 1)) out.push(monthOf(day));
  return out;
}

const maxDate = (a: string | null, b: string): string => (a === null || b > a ? b : a);

/** The sum of `rows` (at least one, all of `source`) and the latest end of their spans. */
function partOf(hit: { source: UsageRowSource; rows: readonly UsageRow[] }): Part {
  let value = 0;
  let to: string | null = null;
  for (const r of hit.rows) {
    value += r.value;
    to = maxDate(to, r.to);
  }
  return { value, source: hit.source, to: to! };
}

/** The rows and the mapping a table reads, shared by its views. */
interface UsageData {
  /** Month rows by source, metric and month. */
  month: ReadonlyMap<string, readonly UsageRow[]>;
  /** Span rows (more than a month) by source, metric and span. */
  span: ReadonlyMap<string, readonly UsageRow[]>;
  /** The group of every key the rows name. */
  groupOf: (key: string) => UsageGroup | 'total' | null;
  unknownGroup: AccredGroup | null;
  hasUnmapped: boolean;
}

const monthKey = (source: string, metric: string, month: string): string => `${source}\u0000${metric}\u0000${month}`;
const spanKey = (source: string, metric: string, from: string, to: string): string => `${source}\u0000${metric}\u0000${from}\u0000${to}`;

/**
 * The usage of a span, resolved (see the top of this file). `cell` and `spanValue` answer {@link ResolvedUsage}'s
 * questions; the extra methods let the provider and the annexes ask about any months of the span.
 */
export class UsageTable implements ResolvedUsage {
  /** @param dedupe whether a SLiMS row counts its visits without repeats */
  constructor(
    private readonly data: UsageData,
    readonly months: readonly string[],
    readonly dedupe: boolean,
  ) {}

  /** The same rows, counting a SLiMS row's visits without repeats or not. */
  withDedupe(dedupe: boolean): UsageTable {
    return dedupe === this.dedupe ? this : new UsageTable(this.data, this.months, dedupe);
  }

  /** The group the members a source no longer has count in (null: in none). */
  get unknownGroup(): AccredGroup | null {
    return this.data.unknownGroup;
  }

  /** Whether a row of the span counts in no group. */
  get hasUnmapped(): boolean {
    return this.data.hasUnmapped;
  }

  /** The metric of the rows `source` counts for `metric`; null when `source` has none of it (an import-only metric). */
  private metricOf(source: UsageRowSource, metric: UsageMetric): string | null {
    if (source === 'manual' && USAGE_IMPORT_ONLY_METRICS.includes(metric)) return null;
    return source === 'slims' && metric === 'visits' && this.dedupe ? 'visits_deduped' : metric;
  }

  private monthRows(source: UsageRowSource, metric: UsageMetric, month: string): readonly UsageRow[] {
    const stored = this.metricOf(source, metric);
    return stored === null ? NO_ROWS : (this.data.month.get(monthKey(source, stored, month)) ?? NO_ROWS);
  }

  private spanRows(source: UsageRowSource, metric: UsageMetric, span: { from: string; to: string }): readonly UsageRow[] {
    const stored = this.metricOf(source, metric);
    return stored === null ? NO_ROWS : (this.data.span.get(spanKey(source, stored, span.from, span.to)) ?? NO_ROWS);
  }

  /** The rows of the first source that has rows matching `keep`. */
  private first(rowsOf: (s: UsageRowSource) => readonly UsageRow[], keep: (row: UsageRow) => boolean): { source: UsageRowSource; rows: UsageRow[] } | null {
    for (const source of SOURCES) {
      const rows = rowsOf(source).filter(keep);
      if (rows.length > 0) return { source, rows };
    }
    return null;
  }

  /** The part of `group` (never the total), or null without rows. */
  private groupPart(rowsOf: (s: UsageRowSource) => readonly UsageRow[], group: UsageGroup): Part | null {
    const hit = this.first(rowsOf, (r) => this.data.groupOf(r.key) === group);
    return hit === null ? null : partOf(hit);
  }

  /** The part of `bucket`: a group's, or the total (its own row, else the sum of the groups). */
  private part(rowsOf: (s: UsageRowSource) => readonly UsageRow[], bucket: UsageGroup | 'total'): Part | null {
    if (bucket !== 'total') return this.groupPart(rowsOf, bucket);
    const own = this.first(rowsOf, (r) => r.key === '');
    if (own !== null) return partOf(own);
    let sum: Part | null = null;
    for (const g of USAGE_GROUPS) {
      const p = this.groupPart(rowsOf, g);
      if (p === null) continue;
      sum = sum === null ? { ...p } : { value: sum.value + p.value, source: sum.source === 'manual' || p.source === 'manual' ? 'manual' : 'slims', to: maxDate(sum.to, p.to) };
    }
    return sum;
  }

  cell(metric: UsageMetric, month: string, group: UsageGroup | 'total'): ResolvedCell {
    const p = this.part((s) => this.monthRows(s, metric, month), group);
    if (p === null) return NONE;
    return { value: p.value, source: p.source, spanTo: p.to < endOfMonth(month) ? p.to : null };
  }

  spanValue(metric: UsageMetric, span: { from: string; to: string }, group: AccredGroup | 'total' = 'total'): ResolvedCell {
    return this.spanCell(metric, span, group);
  }

  /** {@link spanValue} for any group, the guests and the uncounted rows included. */
  spanCell(metric: UsageMetric, span: { from: string; to: string }, group: UsageGroup | 'total'): ResolvedCell {
    const p = this.part((s) => this.spanRows(s, metric, span), group);
    return p === null ? NONE : { value: p.value, source: p.source, spanTo: span.to };
  }

  monthsWithData(metric: UsageMetric): number {
    return this.monthsWithDataIn(metric, this.months);
  }

  /** How many of `months` have at least one row of `metric` (any source, any group, a zero included). */
  monthsWithDataIn(metric: UsageMetric, months: readonly string[]): number {
    let n = 0;
    for (const m of months) if (SOURCES.some((s) => this.monthRows(s, metric, m).length > 0)) n += 1;
    return n;
  }

  memberUnknown(metric: UsageMetric): number {
    return this.memberUnknownIn(metric, this.months);
  }

  /**
   * The value of the deleted-members rows that count in a group over `months`: in each month, those of the source
   * the group's cell is taken from. Zero when they count in no group.
   */
  memberUnknownIn(metric: UsageMetric, months: readonly string[]): number {
    const group = this.data.unknownGroup;
    if (group === null) return 0;
    let n = 0;
    for (const m of months) {
      const p = this.groupPart((s) => this.monthRows(s, metric, m), group);
      if (p === null) continue;
      for (const r of this.monthRows(p.source, metric, m)) if (r.key === 'member_unknown') n += r.value;
    }
    return n;
  }
}

/**
 * The usage of `span` (its months, and the span rows that lie inside them), with the member-type mapping as it is now.
 * A month cell is stored over its whole month, so a span that starts or ends inside a month (a free-date period) still
 * reads the rows of that first and last month: the rows are read from the first day of its first month to the last day
 * of its last month. `o.dedupe` (default: the setting that removes repeats from imported visits) decides which visits a
 * SLiMS row counts.
 */
export async function loadUsageTable(db: Kysely<DB>, span: { from: string; to: string }, settings: AccredSettings, o: { dedupe?: boolean } = {}): Promise<UsageTable> {
  const rows = await db
    .selectFrom('usage_stats')
    .select(['source', 'metric', 'span_from', 'span_to', 'group_key', 'value'])
    .where('source', 'in', SOURCES)
    .where('branch_key', '=', '')
    .where('span_from', '>=', `${monthOf(span.from)}-01`)
    .where('span_to', '<=', endOfMonth(monthOf(span.to)))
    .execute();
  const mapRows = await db.selectFrom('usage_group_map').select(['group_key', 'accred_group']).execute();
  const mapped = new Map<string, AccredGroup | null>(mapRows.map((r) => [r.group_key, isGroup(r.accred_group) ? r.accred_group : null]));
  const unknownGroup = mapped.has('member_unknown') ? mapped.get('member_unknown')! : settings.unknownMemberGroupDefault;

  const groupOf = (key: string): UsageGroup | 'total' | null => {
    if (key === '') return 'total';
    if (key === 'guest') return 'guest';
    if (key.startsWith('grp:')) {
      const g = key.slice(4);
      return isGroup(g) ? g : null;
    }
    if (key.startsWith('slims_type:')) return mapped.get(key) ?? 'unmapped';
    if (key === 'member_unknown') return unknownGroup ?? 'unmapped';
    return null;
  };

  const month = new Map<string, UsageRow[]>();
  const spans = new Map<string, UsageRow[]>();
  let hasUnmapped = false;
  for (const r of rows) {
    const row: UsageRow = { source: r.source as UsageRowSource, metric: r.metric, from: r.span_from, to: r.span_to, key: r.group_key, value: Number(r.value) };
    if (groupOf(row.key) === 'unmapped') hasUnmapped = true;
    const inMonth = monthOf(row.from) === monthOf(row.to);
    const key = inMonth ? monthKey(row.source, row.metric, monthOf(row.from)) : spanKey(row.source, row.metric, row.from, row.to);
    const list = (inMonth ? month : spans).get(key);
    if (list === undefined) (inMonth ? month : spans).set(key, [row]);
    else list.push(row);
  }
  const data: UsageData = { month, span: spans, groupOf, unknownGroup, hasUnmapped };
  return new UsageTable(data, monthsOfSpan(span.from, span.to), o.dedupe ?? settings.dedupeLegacy);
}
