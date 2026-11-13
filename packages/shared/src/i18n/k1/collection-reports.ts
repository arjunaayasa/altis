/**
 * The shared texts of the collection reports: the fixed item labels of the summary and any other fixed row label of
 * those reports; keys `report.row.collection.*`. This file belongs to the task that writes those reports and is the
 * one shared message file it may edit. `COLLECTION_REPORTS_ID` is the source of the keys and `COLLECTION_REPORTS_EN`
 * is typed against it, so a key without its English text fails `tsc`; both are spread once into the shared catalogs
 * (`i18n/id.ts`, `i18n/en.ts`) and held to their rules: the same {placeholders} in both languages, no English left in
 * the Indonesian text.
 *
 * No Node built-ins here: the browser bundles this module.
 */

export const COLLECTION_REPORTS_ID = {} as const;

export const COLLECTION_REPORTS_EN: Readonly<Record<keyof typeof COLLECTION_REPORTS_ID, string>> = {};
