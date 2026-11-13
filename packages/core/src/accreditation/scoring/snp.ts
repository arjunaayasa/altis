import { addDays, addMonths } from '@altis/shared';
import type { NoteRef, SnpResultView } from '@altis/shared/api/accreditation';
import type { AccredMetricValue, SnpCheck, SnpRule } from '../types.js';
import { pickTier } from './bands.js';
import { elementsOf } from './mandatory.js';

// The outcome of a school standard. A standard passes or fails by its rule, is only reported, or waits for a later
// module; one whose input is missing (no value, no class count, no starting size, or a value marked not to judge, such
// as additions with too many undated copies) is not evaluated, and its value's notes say why.
//
// - `min`: the value at least the minimum (a cut percentage against a whole minimum compares as the exact share).
// - `ratio_target`: the cut share exactly the target.
// - `min_by_size`: the minimum share of the tier the starting size reaches; a start below 1 000 titles uses the first
//   tier, and says so.
// - `min_by_classes`: the minimum of the class group; a class count outside every group uses the nearest one, and says
//   so.
// - `named_and_min`: every named kind among the kinds found (`facts.elements`) and at least the minimum of kinds.
// - `both_within`: the last stock-take and the last weeding (`facts.lastStocktake`, `facts.lastWeeding`) both in the
//   `years` years up to the snapshot date (checked against `o.D` when given; the metric's own window holds them).
// - `coverage`: at least a month of visits and a month of loans (`facts.visitMonths`, `facts.loanMonths`).
// - `staff_by_classes`: the staff at least `minAbove` above `above` classes, else `minElse`.

/** The starting size below which the first tier stands in for a smaller collection. */
const START_FLOOR = 1000;

type Outcome = SnpResultView['outcome'];

const hasValue = (v: AccredMetricValue | null): v is AccredMetricValue & { value: number } => v !== null && v.value !== null;

/** The class group of `classes`: the one holding it, else the nearest (the lower one on a tie), and whether it held it. */
function classGroup<T extends { minClasses: number; maxClasses: number }>(tiers: readonly T[], classes: number): { tier: T; inside: boolean } {
  const inside = tiers.find((t) => classes >= t.minClasses && classes <= t.maxClasses);
  if (inside !== undefined) return { tier: inside, inside: true };
  const distance = (t: T): number => (classes < t.minClasses ? t.minClasses - classes : classes - t.maxClasses);
  let nearest = tiers[0];
  if (nearest === undefined) throw new TypeError('a class-based standard needs at least one group');
  for (const t of tiers) if (distance(t) < distance(nearest)) nearest = t;
  return { tier: nearest, inside: false };
}

/** A date of the facts, or null. */
const dateFact = (v: AccredMetricValue, key: string): string | null => {
  const d = v.facts?.[key];
  return typeof d === 'string' && d !== '' ? d : null;
};

/** The outcome of `rule` for the value `v`, with the notes the rule adds. */
function judge(
  rule: SnpRule,
  v: AccredMetricValue | null,
  size: AccredMetricValue | null,
  classes: number | null,
  D: string | undefined,
): { outcome: Outcome; notes: NoteRef[] } {
  const no = { outcome: 'not_evaluated' as const, notes: [] };
  const verdict = (pass: boolean, notes: NoteRef[] = []) => ({ outcome: pass ? ('pass' as const) : ('fail' as const), notes });
  switch (rule.kind) {
    case 'not_available':
      return { outcome: 'not_available', notes: [{ key: 'accred.note.snp_not_available' }] };
    case 'reported':
      return { outcome: 'reported', notes: [] };
    case 'min':
      return hasValue(v) ? verdict(v.value >= rule.value) : no;
    case 'ratio_target':
      return hasValue(v) ? verdict(v.value === rule.target) : no;
    case 'min_by_size': {
      const start = size?.value ?? null;
      if (!hasValue(v) || v.suggest === false || start === null || start <= 0) return no;
      const notes: NoteRef[] = start < START_FLOOR ? [{ key: 'accred.note.snp_start_below_1000' }] : [];
      return verdict(v.value >= pickTier(rule.tiers, start).minPct, notes);
    }
    case 'min_by_classes': {
      if (!hasValue(v) || classes === null) return no;
      const { tier, inside } = classGroup(rule.tiers, classes);
      return verdict(v.value >= tier.min, inside ? [] : [{ key: 'accred.note.snp_tier_outside', params: { classes } }]);
    }
    case 'named_and_min': {
      if (!hasValue(v)) return no;
      const found = new Set(elementsOf(v));
      return verdict(rule.named.every((k) => found.has(k)) && v.value >= rule.min);
    }
    case 'both_within': {
      if (!hasValue(v)) return no;
      const from = D === undefined ? null : addDays(addMonths(D, -12 * rule.years), 1);
      const within = (d: string | null): boolean => d !== null && (from === null || D === undefined || (d >= from && d <= D));
      return verdict(within(dateFact(v, 'lastStocktake')) && within(dateFact(v, 'lastWeeding')));
    }
    case 'coverage': {
      const visits = v?.facts?.['visitMonths'];
      const loans = v?.facts?.['loanMonths'];
      if (typeof visits !== 'number' || typeof loans !== 'number') return no;
      return verdict(visits >= 1 && loans >= 1);
    }
    case 'staff_by_classes':
      if (!hasValue(v) || classes === null) return no;
      return verdict(v.value >= (classes > rule.above ? rule.minAbove : rule.minElse));
  }
}

/**
 * The outcome of one school standard: `v` its metric value, `size` the value of its size metric (`min_by_size`),
 * `classes` the period's class count (`min_by_classes`, `staff_by_classes`), `o.D` the snapshot date (`both_within`).
 * The notes are the value's own, then the rule's.
 */
export function evaluateSnp(
  check: SnpCheck,
  v: AccredMetricValue | null,
  size: AccredMetricValue | null,
  classes: number | null,
  o: { D?: string } = {},
): SnpResultView {
  const { outcome, notes } = judge(check.rule, v, size, classes, o.D);
  const all: NoteRef[] = [...(v?.notes ?? [])];
  for (const n of notes) if (!all.some((m) => m.key === n.key)) all.push(n);
  return { code: check.code, labelKey: check.labelKey, outcome, value: v?.value ?? null, rule: check.ruleKey, notes: all };
}
