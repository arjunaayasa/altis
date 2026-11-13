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

export const COLLECTION_REPORTS_ID = {
  // The summary's rows of titles.
  'report.row.collection.titles_all': 'Semua judul',
  'report.row.collection.titles_with_items': 'Judul dengan eksemplar',
  'report.row.collection.titles_without_items': 'Judul tanpa eksemplar (elektronik atau berkas publik)',
  'report.row.collection.titles_electronic': 'Judul elektronik',
  // Rows and groups of a value that is not set.
  'report.row.collection.no_location': 'Tanpa lokasi',
  'report.row.collection.no_language': 'Tanpa bahasa',
  'report.row.collection.no_items': 'Tanpa eksemplar',
  // The DDC recap's rows of the other classes.
  'report.row.collection.no_class_token': 'Tanpa nomor kelas',
  'report.row.collection.other_tokens': 'Nomor kelas lain',
  // The details of the data quality report.
  'report.row.collection.copies': '{count} eksemplar',
  'report.row.collection.fill_received_date': 'Lengkapi tanggal terima lewat ubah massal eksemplar',
} as const;

export const COLLECTION_REPORTS_EN: Readonly<Record<keyof typeof COLLECTION_REPORTS_ID, string>> = {
  'report.row.collection.titles_all': 'All titles',
  'report.row.collection.titles_with_items': 'Titles with copies',
  'report.row.collection.titles_without_items': 'Titles without copies (electronic or with a public file)',
  'report.row.collection.titles_electronic': 'Electronic titles',
  'report.row.collection.no_location': 'No location',
  'report.row.collection.no_language': 'No language',
  'report.row.collection.no_items': 'No copies',
  'report.row.collection.no_class_token': 'No class number',
  'report.row.collection.other_tokens': 'Other class numbers',
  'report.row.collection.copies': '{count} copies',
  'report.row.collection.fill_received_date': 'Fill in the receiving date through the bulk edit of copies',
};
