/**
 * The shared texts of the collection annexes of accreditation: the starting collection, per-year and total rows of the
 * additions table and any other fixed row label; keys `report.row.accred_collection.*`. This file belongs to the task
 * that writes those reports and is the one shared message file it may edit. `ANNEX_COLLECTION_ID` is the source of the
 * keys and `ANNEX_COLLECTION_EN` is typed against it, so a key without its English text fails `tsc`; both are spread
 * once into the shared catalogs (`i18n/id.ts`, `i18n/en.ts`) and held to their rules: the same {placeholders} in both
 * languages, no English left in the Indonesian text.
 *
 * No Node built-ins here: the browser bundles this module.
 */

export const ANNEX_COLLECTION_ID = {
  // The additions table: the titles in stock on the last day before the three years, the titles added in each year,
  // and their total (its share of the starting collection beside it).
  'report.row.accred_collection.start': 'Stok awal per {date}',
  'report.row.accred_collection.year': 'Penambahan tahun {year}',
  'report.row.accred_collection.total': 'Jumlah penambahan tiga tahun',
} as const;

export const ANNEX_COLLECTION_EN: Readonly<Record<keyof typeof ANNEX_COLLECTION_ID, string>> = {
  'report.row.accred_collection.start': 'Starting collection on {date}',
  'report.row.accred_collection.year': 'Added in {year}',
  'report.row.accred_collection.total': 'Total added in the three years',
};
