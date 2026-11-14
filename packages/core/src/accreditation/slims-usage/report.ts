import type { UsageCounts } from './count.js';

// What a SLiMS usage import reports when it ends: its run summary (`catalog_runs.summary`: counts only) and its report
// file (a CSV, through writeRunReport): the rows read per table, the rows not counted and why, the totals of each month
// (visits raw and without repeats, loans), the share of visits and loans of members SLiMS no longer has, and a note on
// what SLiMS's visitor log cannot tell apart. Months, codes and numbers only: no member, not even a hash.

/** The report file's columns. */
export const USAGE_REPORT_HEADER: readonly string[] = Object.freeze(['section', 'key', 'value', 'visits', 'visits_deduped', 'loans', 'note']);

/** The note the report always carries: SLiMS keeps one visitor log for both. */
export const USAGE_SOURCE_NOTE = 'SLiMS tidak membedakan kunjungan dari meja dan dari buku tamu';

/** What the summary and the report are made of. */
export interface UsageEnding {
  status: string;
  sourceKind: 'db' | 'dump';
  cutoverOn: string | null;
  dedupeMinutes: number;
  /** The phase the import reached. */
  phase: string;
  /** Why it failed (a failed run), as a code. */
  failure: string | null;
  counts: UsageCounts;
  /** What the write step stored (null when it did not run). */
  written: { months: number; rows: number } | null;
}

const total = (counts: UsageCounts, metric: string): number =>
  Object.values(counts.monthly).reduce((sum, cells) => sum + (cells[metric]?.[''] ?? 0), 0);

/** `part` of `whole` as a whole percentage (rounded down), or '' without a whole. */
function share(part: number, whole: number): string {
  return whole > 0 ? `${Math.floor((part * 100) / whole)}%` : '';
}

/** The run summary: counts only. */
export function usageSummary(e: UsageEnding): Record<string, unknown> {
  const months = Object.keys(e.counts.monthly).sort();
  return {
    status: e.status,
    phase: e.phase,
    failure: e.failure,
    sourceKind: e.sourceKind,
    cutoverOn: e.cutoverOn,
    dedupeMinutes: e.dedupeMinutes,
    rows: { ...e.counts.rows },
    dropped: { dateInvalid: { ...e.counts.dateInvalid }, afterCutover: { ...e.counts.afterCutover }, loanSeenBefore: e.counts.loanSeenBefore },
    firstMonth: months[0] ?? null,
    lastMonth: months[months.length - 1] ?? null,
    totals: {
      visits: total(e.counts, 'visits'),
      visitsDeduped: total(e.counts, 'visits_deduped'),
      loans: total(e.counts, 'loans'),
      inLibraryUses: total(e.counts, 'in_library_uses'),
    },
    memberUnknown: { ...e.counts.memberUnknown },
    written: e.written,
  };
}

/** The report file's rows (USAGE_REPORT_HEADER). */
export function usageReportRows(e: UsageEnding): string[][] {
  const row = (section: string, key: string, value: string | number, o: { visits?: number; deduped?: number; loans?: number; note?: string } = {}): string[] => [
    section,
    key,
    String(value),
    o.visits === undefined ? '' : String(o.visits),
    o.deduped === undefined ? '' : String(o.deduped),
    o.loans === undefined ? '' : String(o.loans),
    o.note ?? '',
  ];
  const rows: string[][] = [
    row('run', 'status', e.status),
    row('run', 'source', e.sourceKind),
    row('run', 'cutover_on', e.cutoverOn ?? ''),
    row('run', 'dedupe_minutes', e.dedupeMinutes),
    row('run', 'phase', e.phase),
  ];
  if (e.failure !== null) rows.push(row('run', 'failure', e.failure));
  for (const table of Object.keys(e.counts.rows).sort()) rows.push(row('table', table, e.counts.rows[table]!));
  for (const table of Object.keys(e.counts.dateInvalid).sort()) rows.push(row('dropped', `date_invalid.${table}`, e.counts.dateInvalid[table]!));
  for (const table of Object.keys(e.counts.afterCutover).sort()) rows.push(row('dropped', `after_cutover.${table}`, e.counts.afterCutover[table]!));
  if (e.counts.loanSeenBefore > 0) rows.push(row('dropped', 'loan_seen_before', e.counts.loanSeenBefore));
  for (const month of Object.keys(e.counts.monthly).sort()) {
    const cells = e.counts.monthly[month]!;
    rows.push(
      row('month', month, '', {
        visits: cells['visits']?.[''] ?? 0,
        deduped: cells['visits_deduped']?.[''] ?? 0,
        loans: cells['loans']?.[''] ?? 0,
      }),
    );
  }
  const visits = total(e.counts, 'visits');
  const loans = total(e.counts, 'loans');
  rows.push(row('total', 'all', '', { visits, deduped: total(e.counts, 'visits_deduped'), loans }));
  rows.push(row('member_unknown', 'visits', e.counts.memberUnknown.visits, { note: share(e.counts.memberUnknown.visits, visits) }));
  rows.push(row('member_unknown', 'loans', e.counts.memberUnknown.loans, { note: share(e.counts.memberUnknown.loans, loans) }));
  if (e.written !== null) rows.push(row('written', 'months', e.written.months), row('written', 'rows', e.written.rows));
  rows.push(row('note', 'visit_source', '', { note: USAGE_SOURCE_NOTE }));
  return rows;
}
