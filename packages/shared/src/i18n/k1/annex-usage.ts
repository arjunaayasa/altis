/**
 * The shared texts of the usage annexes of accreditation: the monthly totals and any other fixed row label of those
 * annexes; keys `report.row.usage.*`. This file belongs to the task that writes those reports and is the one shared
 * message file it may edit. `ANNEX_USAGE_ID` is the source of the keys and `ANNEX_USAGE_EN` is typed against it, so a
 * key without its English text fails `tsc`; both are spread once into the shared catalogs (`i18n/id.ts`, `i18n/en.ts`)
 * and held to their rules: the same {placeholders} in both languages, no English left in the Indonesian text.
 *
 * No Node built-ins here: the browser bundles this module.
 */

export const ANNEX_USAGE_ID = {} as const;

export const ANNEX_USAGE_EN: Readonly<Record<keyof typeof ANNEX_USAGE_ID, string>> = {};
