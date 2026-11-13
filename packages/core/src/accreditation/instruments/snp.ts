import type { AccredMetricId } from '../metric-ids.js';
import type { AccredWindow, SnpCheck, SnpRule } from '../types.js';
import { deepFreeze } from './shared.js';

// The school standards the compliance tab checks (the national library standard for schools and madrasahs), per
// level: a selection that ALTIS data can measure, each with its metric, its window and the rule that decides it. Where
// the standard leaves the rule open, the reading is: the fiction share of enrichment books passes only at the target
// share; the lower secondary named reference kinds are the primary ones; the additions are measured over the period;
// stock-taking and weeding both within three years; visit and loan reports need at least one month of each; the
// budget share is the one of the calendar year the period ends. The classes of the class-based rules are the period's
// `period.classes`.

type Level = 'sd' | 'smp' | 'sma';
type PerLevel<T> = Readonly<Record<Level, T>>;

/** One standard, with a rule per level (or one for all). */
interface SnpSpec {
  readonly n: string;
  readonly metric: AccredMetricId | null;
  readonly window: AccredWindow;
  readonly rule: SnpRule | PerLevel<SnpRule>;
}

const isPerLevel = (rule: SnpSpec['rule']): rule is PerLevel<SnpRule> => !('kind' in rule);

const PRIMARY_REFERENCES = ['encyclopedia', 'dictionary', 'handbook', 'globe'] as const;

const SPECS: readonly SnpSpec[] = [
  { n: '01', metric: 'collection.titles', window: 'snapshot', rule: { kind: 'min', value: 1000 } },
  {
    n: '02',
    metric: 'collection.enrichment_fiction_pct',
    window: 'snapshot',
    rule: { sd: { kind: 'ratio_target', target: 40 }, smp: { kind: 'ratio_target', target: 30 }, sma: { kind: 'ratio_target', target: 25 } },
  },
  {
    n: '03',
    metric: 'collection.enrichment_titles',
    window: 'snapshot',
    rule: {
      sd: {
        kind: 'min_by_classes',
        tiers: [
          { minClasses: 1, maxClasses: 6, min: 1000 },
          { minClasses: 7, maxClasses: 12, min: 1500 },
          { minClasses: 13, maxClasses: 24, min: 2000 },
        ],
      },
      smp: {
        kind: 'min_by_classes',
        tiers: [
          { minClasses: 3, maxClasses: 6, min: 1000 },
          { minClasses: 7, maxClasses: 12, min: 1500 },
          { minClasses: 13, maxClasses: 18, min: 2000 },
          { minClasses: 19, maxClasses: 24, min: 2500 },
        ],
      },
      sma: {
        kind: 'min_by_classes',
        tiers: [
          { minClasses: 3, maxClasses: 6, min: 1000 },
          { minClasses: 7, maxClasses: 12, min: 1500 },
          { minClasses: 13, maxClasses: 18, min: 2000 },
          { minClasses: 19, maxClasses: 27, min: 2500 },
        ],
      },
    },
  },
  {
    n: '04',
    metric: 'collection.reference_kinds',
    window: 'snapshot',
    rule: {
      sd: { kind: 'named_and_min', named: PRIMARY_REFERENCES, min: 4 },
      smp: { kind: 'named_and_min', named: PRIMARY_REFERENCES, min: 5 },
      sma: { kind: 'named_and_min', named: [...PRIMARY_REFERENCES, 'biography'], min: 5 },
    },
  },
  {
    n: '05',
    metric: 'collection.serial_titles_recent',
    window: 'twelve_months',
    rule: { sd: { kind: 'min', value: 2 }, smp: { kind: 'min', value: 2 }, sma: { kind: 'min', value: 3 } },
  },
  {
    n: '06',
    metric: 'collection.title_additions_period_pct',
    window: 'period',
    rule: {
      kind: 'min_by_size',
      sizeMetric: 'collection.titles_period_start',
      tiers: [
        { minSize: 0, minPct: 10 },
        { minSize: 1501, minPct: 8 },
        { minSize: 2001, minPct: 6 },
      ],
    },
  },
  { n: '07', metric: 'registers.stocktake_weeding_3y', window: 'three_years', rule: { kind: 'both_within', years: 3 } },
  {
    n: '08',
    metric: 'period.hours_per_week',
    window: 'current',
    rule: { sd: { kind: 'min', value: 30 }, smp: { kind: 'min', value: 35 }, sma: { kind: 'min', value: 35 } },
  },
  { n: '09', metric: 'usage.coverage', window: 'period', rule: { kind: 'coverage' } },
  {
    n: '10',
    metric: 'registers.activities.promotion',
    window: 'period',
    rule: { sd: { kind: 'min', value: 4 }, smp: { kind: 'min', value: 7 }, sma: { kind: 'min', value: 8 } },
  },
  {
    n: '11',
    metric: 'registers.active_staff',
    window: 'current',
    rule: {
      sd: { kind: 'staff_by_classes', above: 6, minAbove: 3, minElse: 1 },
      smp: { kind: 'staff_by_classes', above: 3, minAbove: 3, minElse: 1 },
      sma: { kind: 'staff_by_classes', above: 3, minAbove: 3, minElse: 1 },
    },
  },
  { n: '12', metric: 'registers.budget_share_year', window: 'budget_years', rule: { kind: 'min', value: 5 } },
  { n: '13', metric: 'usage.reading_interest', window: 'period_and_previous', rule: { kind: 'reported' } },
  { n: '14', metric: null, window: 'period', rule: { kind: 'not_available' } },
];

/**
 * The standards of `level`: code `SNP-S-<nn>`, label `accred.snp.S-<nn>`, and the printed rule `accred.snp.S-<nn>.rule`
 * (`.rule.<level>` where the level changes it).
 */
function standards(level: Level): readonly SnpCheck[] {
  return deepFreeze(
    SPECS.map(({ n, metric, window, rule }): SnpCheck => {
      const key = `accred.snp.S-${n}`;
      return {
        code: `SNP-S-${n}`,
        labelKey: key,
        metric,
        window,
        rule: isPerLevel(rule) ? rule[level] : rule,
        ruleKey: isPerLevel(rule) ? `${key}.rule.${level}` : `${key}.rule`,
      };
    }),
  );
}

export const SNP_SD: readonly SnpCheck[] = standards('sd');
export const SNP_SMP: readonly SnpCheck[] = standards('smp');
export const SNP_SMA: readonly SnpCheck[] = standards('sma');
