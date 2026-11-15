import type { AccredMetricUnit, AccredWindow } from './types.js';

// The metrics the K1 providers compute, each with its provider, unit and the one window it is measured over (an
// indicator that reads a metric uses that same window; the instrument tests hold every indicator to it). Where the
// definition of a metric names no single window: a value "for year Y" and the three budget years are `budget_years`
// (the provider takes Y = the year the period ends); a profile table of several spans is `period` (each row states its
// own span); a fact with no span (a founding decree on file) and every period and system value are `current`; "the 12
// months to D" is `twelve_months`, "D − 3 years + 1 day to D" is `three_years`, and "the period against the 12 months
// before it" is `period_and_previous`.

/** The providers of this edition's metrics. */
export const ACCRED_PROVIDER_IDS = Object.freeze([
  'collection',
  'registers',
  'period',
  'system',
  'usage',
  // ---- Komunitas K4 (stocktake) ----
  'stocktake',
] as const);

export type AccredProviderId = (typeof ACCRED_PROVIDER_IDS)[number];

/** A metric's provider, unit and window. */
export interface AccredMetricDef {
  provider: AccredProviderId;
  unit: AccredMetricUnit;
  window: AccredWindow;
}

const m = (provider: AccredProviderId, unit: AccredMetricUnit, window: AccredWindow): AccredMetricDef => Object.freeze({ provider, unit, window });

/**
 * Every metric of this edition, by id. `usage.collection_used_pct` is computed by the collection provider: its
 * denominator is the stock. `registers.stocktake_weeding_3y` is computed by the stocktake provider: a finished
 * stocktake session is a stock-take besides the register's.
 */
export const ACCRED_METRICS = Object.freeze({
  // ---- Komunitas K1 (collection) ----
  'collection.titles': m('collection', 'count', 'snapshot'),
  'collection.fiction_pct': m('collection', 'percent', 'snapshot'),
  'collection.titles_window_start': m('collection', 'count', 'three_calendar_years'),
  'collection.title_additions_3y_pct': m('collection', 'percent', 'three_calendar_years'),
  'collection.undated_items': m('collection', 'count', 'snapshot'),
  'collection.k7_organisation': m('collection', 'percent', 'current'),
  'collection.local_work_kinds': m('collection', 'count', 'snapshot'),
  'collection.ddc_printed_recap': m('collection', 'count', 'snapshot'),
  'collection.profile_matrix': m('collection', 'count', 'snapshot'),
  'collection.live_items': m('collection', 'count', 'snapshot'),
  'collection.enrichment_fiction_pct': m('collection', 'percent', 'snapshot'),
  'collection.enrichment_titles': m('collection', 'count', 'snapshot'),
  'collection.reference_kinds': m('collection', 'count', 'snapshot'),
  'collection.serial_titles_recent': m('collection', 'count', 'twelve_months'),
  'collection.titles_period_start': m('collection', 'count', 'period'),
  'collection.title_additions_period_pct': m('collection', 'percent', 'period'),
  'usage.collection_used_pct': m('collection', 'percent', 'period'),
  // ---- Komunitas K1 (registers) ----
  'registers.activities.needs_survey': m('registers', 'count', 'period'),
  'registers.activities.preservation_3p': m('registers', 'count', 'three_periods'),
  'registers.activities.learning': m('registers', 'count', 'period'),
  'registers.activities.reading_culture': m('registers', 'count', 'period'),
  'registers.activities.reading_guidance': m('registers', 'count', 'period'),
  'registers.activities.writing_guidance': m('registers', 'count', 'period'),
  'registers.activities.plagiarism_guidance': m('registers', 'count', 'period'),
  'registers.activities.innovation': m('registers', 'count', 'period'),
  'registers.activities.external_literacy': m('registers', 'count', 'period'),
  'registers.activities.satisfaction_survey': m('registers', 'count', 'period'),
  'registers.activities.promotion': m('registers', 'count', 'period'),
  'registers.collection_policy_aspects': m('registers', 'count', 'current'),
  'registers.service_procedures': m('registers', 'count', 'current'),
  'registers.head_performance_aspects': m('registers', 'count', 'period'),
  'registers.legality_elements': m('registers', 'count', 'current'),
  'registers.operating_procedures': m('registers', 'count', 'current'),
  'registers.library_program_aspects': m('registers', 'count', 'current'),
  'registers.partners_3p': m('registers', 'count', 'three_periods'),
  'registers.budget_share_3y': m('registers', 'percent', 'budget_years'),
  'registers.budget_share_year': m('registers', 'percent', 'budget_years'),
  'registers.report_routine_3p': m('registers', 'code', 'three_periods'),
  'registers.active_staff': m('registers', 'count', 'current'),
  'registers.staff_pcs_pct': m('registers', 'percent', 'current'),
  'registers.population_per_staff': m('registers', 'ratio', 'current'),
  'registers.training_avg_3p': m('registers', 'ratio', 'three_periods'),
  'registers.head_qualification': m('registers', 'code', 'current'),
  'registers.staff_roles': m('registers', 'code', 'current'),
  'registers.founding_decree_registered': m('registers', 'count', 'current'),
  'registers.stocktake_weeding_3y': m('stocktake', 'count', 'three_years'),
  'registers.profile_staff': m('registers', 'count', 'current'),
  'registers.profile_counts': m('registers', 'count', 'period'),
  'registers.profile_budget': m('registers', 'count', 'budget_years'),
  // ---- Komunitas K1 (period) ----
  'period.population': m('period', 'count', 'current'),
  'period.ict_devices_pct': m('period', 'percent', 'current'),
  'period.bandwidth_mbps': m('period', 'mbps', 'current'),
  'period.services_count': m('period', 'count', 'current'),
  'period.teachers_using_pct': m('period', 'percent', 'current'),
  'period.npp_present': m('period', 'count', 'current'),
  'period.hours_per_week': m('period', 'count', 'current'),
  'period.classes': m('period', 'count', 'current'),
  'period.floor_m2': m('period', 'count', 'current'),
  'period.user_pcs': m('period', 'count', 'current'),
  'period.scanners': m('period', 'count', 'current'),
  // ---- Komunitas K1 (system) ----
  'system.base_url_class': m('system', 'code', 'current'),
  'system.l11_automation': m('system', 'code', 'current'),
  'system.website_features': m('system', 'count', 'current'),
  // ---- Komunitas K1 (usage) ----
  'usage.school_months': m('usage', 'count', 'period'),
  'usage.school_visits_pct': m('usage', 'percent', 'period'),
  'usage.monthly_series': m('usage', 'count', 'period'),
  'usage.profile_averages': m('usage', 'count', 'period'),
  'usage.members_active': m('usage', 'count', 'period'),
  'usage.coverage': m('usage', 'count', 'period'),
  'usage.reading_interest': m('usage', 'percent', 'period_and_previous'),
} satisfies Record<string, AccredMetricDef>);

export type AccredMetricId = keyof typeof ACCRED_METRICS;

/** The ids of every metric of `provider`, in the catalogue's order. */
export function metricsOfProvider(provider: AccredProviderId): readonly AccredMetricId[] {
  return Object.freeze((Object.keys(ACCRED_METRICS) as AccredMetricId[]).filter((id) => ACCRED_METRICS[id].provider === provider));
}
