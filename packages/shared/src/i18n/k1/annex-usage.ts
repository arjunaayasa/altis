/**
 * The shared texts of the usage annexes of accreditation: the monthly totals and any other fixed row label of those
 * annexes; keys `report.row.usage.*`. This file belongs to the task that writes those reports and is the one shared
 * message file it may edit. `ANNEX_USAGE_ID` is the source of the keys and `ANNEX_USAGE_EN` is typed against it, so a
 * key without its English text fails `tsc`; both are spread once into the shared catalogs (`i18n/id.ts`, `i18n/en.ts`)
 * and held to their rules: the same {placeholders} in both languages, no English left in the Indonesian text.
 *
 * No Node built-ins here: the browser bundles this module.
 */

export const ANNEX_USAGE_ID = {
  // The totals row of both annexes, with the divisor of the monthly averages.
  'report.row.usage.total_school_months': 'Jumlah; pembagi {divisor} bulan sekolah',
  'report.row.usage.total_school_months_prorated': 'Jumlah; pembagi {divisor} bulan sekolah (10 × {months} ÷ 12, dibulatkan ke atas)',
  'report.row.usage.total_months': 'Jumlah; pembagi {divisor} bulan berdata',
  'report.row.usage.total_no_data': 'Jumlah; belum ada data penggunaan',
  // The source of a month cut over: the figures reach only to that day.
  'report.row.usage.source_until': '{source} s.d. {date}',
} as const;

export const ANNEX_USAGE_EN: Readonly<Record<keyof typeof ANNEX_USAGE_ID, string>> = {
  'report.row.usage.total_school_months': 'Total; divisor {divisor} school months',
  'report.row.usage.total_school_months_prorated': 'Total; divisor {divisor} school months (10 × {months} ÷ 12, rounded up)',
  'report.row.usage.total_months': 'Total; divisor {divisor} months with data',
  'report.row.usage.total_no_data': 'Total; no usage data yet',
  'report.row.usage.source_until': '{source} until {date}',
};
