import { ATTACHMENTS_EN, ATTACHMENTS_ID } from './attachments';
import { AUTHORITIES_EN, AUTHORITIES_ID } from './authorities';
import { DUPLICATES_EN, DUPLICATES_ID } from './duplicates';
import { EXCHANGE_EN, EXCHANGE_ID } from './exchange';
import { ITEMS_EN, ITEMS_ID } from './items';
import { LABELS_EN, LABELS_ID } from './labels';
import { LOCATIONS_EN, LOCATIONS_ID } from './locations';
import { MASTERS_EN, MASTERS_ID } from './masters';
import { MIGRATION_EN, MIGRATION_ID } from './migration';
import { PAGES_EN, PAGES_ID } from './pages';
import { RECORDS_EN, RECORDS_ID } from './records';
import { SETTINGS_EN, SETTINGS_ID } from './settings';
import { SRU_EN, SRU_ID } from './sru';

// The admin copy of the catalogue (Phase 2 Task 3, plan decision P2-02): one file per area, each owned by the task
// that builds its screens, joined here and spread once into ADMIN_ID/ADMIN_EN (i18n/id.ts, i18n/en.ts), so that no
// later task edits those shared files. Keys start with `catalog.<area>.` (Halaman & Berita: `pages.`), never with a
// shared family prefix such as `opac.`.

/**
 * Task 3's own copy: the text each placeholder screen shows until its task replaces it (S22: not the `nav.catalog.*`
 * labels, which Task 2 adds in parallel). One key per placeholder screen (components/catalog/screen-placeholder.tsx).
 */
const PLACEHOLDER_ID = {
  'catalog.placeholder.records_list': 'Daftar bibliografi belum tersedia.',
  'catalog.placeholder.record_create': 'Formulir cantuman baru belum tersedia.',
  'catalog.placeholder.record_edit': 'Editor cantuman belum tersedia.',
  'catalog.placeholder.items_list': 'Daftar eksemplar belum tersedia.',
  'catalog.placeholder.item_edit': 'Halaman eksemplar belum tersedia.',
  'catalog.placeholder.authorities': 'Daftar otoritas belum tersedia.',
  'catalog.placeholder.authority_edit': 'Editor otoritas belum tersedia.',
  'catalog.placeholder.locations': 'Pengelolaan lokasi dan rak belum tersedia.',
  'catalog.placeholder.masters': 'Pengelolaan data induk belum tersedia.',
  'catalog.placeholder.material_type_edit': 'Editor jenis bahan belum tersedia.',
  'catalog.placeholder.exchange': 'Impor dan ekspor katalog belum tersedia.',
  'catalog.placeholder.run_detail': 'Rincian proses katalog belum tersedia.',
  'catalog.placeholder.labels': 'Cetak label belum tersedia.',
  'catalog.placeholder.duplicates': 'Pemeriksaan duplikat belum tersedia.',
  'catalog.placeholder.migration': 'Migrasi katalog SLiMS belum tersedia.',
  'catalog.placeholder.pages_list': 'Daftar halaman dan berita belum tersedia.',
  'catalog.placeholder.page_create': 'Formulir halaman baru belum tersedia.',
  'catalog.placeholder.page_edit': 'Editor halaman belum tersedia.',
  'catalog.placeholder.catalog_settings': 'Pengaturan katalog belum tersedia.',
} as const;

const PLACEHOLDER_EN: Record<keyof typeof PLACEHOLDER_ID, string> = {
  'catalog.placeholder.records_list': 'The bibliography list is not available yet.',
  'catalog.placeholder.record_create': 'The new record form is not available yet.',
  'catalog.placeholder.record_edit': 'The record editor is not available yet.',
  'catalog.placeholder.items_list': 'The item list is not available yet.',
  'catalog.placeholder.item_edit': 'The item page is not available yet.',
  'catalog.placeholder.authorities': 'The authority list is not available yet.',
  'catalog.placeholder.authority_edit': 'The authority editor is not available yet.',
  'catalog.placeholder.locations': 'Managing locations and shelves is not available yet.',
  'catalog.placeholder.masters': 'Managing master data is not available yet.',
  'catalog.placeholder.material_type_edit': 'The material type editor is not available yet.',
  'catalog.placeholder.exchange': 'Catalogue import and export are not available yet.',
  'catalog.placeholder.run_detail': 'The catalogue run details are not available yet.',
  'catalog.placeholder.labels': 'Label printing is not available yet.',
  'catalog.placeholder.duplicates': 'The duplicate check is not available yet.',
  'catalog.placeholder.migration': 'The SLiMS catalogue migration is not available yet.',
  'catalog.placeholder.pages_list': 'The list of pages and news is not available yet.',
  'catalog.placeholder.page_create': 'The new page form is not available yet.',
  'catalog.placeholder.page_edit': 'The page editor is not available yet.',
  'catalog.placeholder.catalog_settings': 'The catalogue settings are not available yet.',
};

/** The screens a placeholder stands for: `catalog.placeholder.<screen>`. */
export type CatalogPlaceholderScreen = keyof typeof PLACEHOLDER_ID extends `catalog.placeholder.${infer S}` ? S : never;

/** Every area's Indonesian copy (the source of the keys), in a fixed order. */
export const CATALOG_AREAS_ID = Object.freeze({
  records: RECORDS_ID,
  items: ITEMS_ID,
  authorities: AUTHORITIES_ID,
  masters: MASTERS_ID,
  locations: LOCATIONS_ID,
  settings: SETTINGS_ID,
  exchange: EXCHANGE_ID,
  duplicates: DUPLICATES_ID,
  labels: LABELS_ID,
  migration: MIGRATION_ID,
  attachments: ATTACHMENTS_ID,
  pages: PAGES_ID,
  sru: SRU_ID,
  placeholder: PLACEHOLDER_ID,
});

/** Every area's English copy, in the same order. */
export const CATALOG_AREAS_EN: { readonly [A in keyof typeof CATALOG_AREAS_ID]: Readonly<Record<string, string>> } = Object.freeze({
  records: RECORDS_EN,
  items: ITEMS_EN,
  authorities: AUTHORITIES_EN,
  masters: MASTERS_EN,
  locations: LOCATIONS_EN,
  settings: SETTINGS_EN,
  exchange: EXCHANGE_EN,
  duplicates: DUPLICATES_EN,
  labels: LABELS_EN,
  migration: MIGRATION_EN,
  attachments: ATTACHMENTS_EN,
  pages: PAGES_EN,
  sru: SRU_EN,
  placeholder: PLACEHOLDER_EN,
});

/** The catalogue's Indonesian copy, spread into ADMIN_ID. */
export const CATALOG_ID = {
  ...RECORDS_ID,
  ...ITEMS_ID,
  ...AUTHORITIES_ID,
  ...MASTERS_ID,
  ...LOCATIONS_ID,
  ...SETTINGS_ID,
  ...EXCHANGE_ID,
  ...DUPLICATES_ID,
  ...LABELS_ID,
  ...MIGRATION_ID,
  ...ATTACHMENTS_ID,
  ...PAGES_ID,
  ...SRU_ID,
  ...PLACEHOLDER_ID,
} as const;

/** The catalogue's English copy, spread into ADMIN_EN (typed against {@link CATALOG_ID}). */
export const CATALOG_EN: Record<keyof typeof CATALOG_ID, string> = {
  ...RECORDS_EN,
  ...ITEMS_EN,
  ...AUTHORITIES_EN,
  ...MASTERS_EN,
  ...LOCATIONS_EN,
  ...SETTINGS_EN,
  ...EXCHANGE_EN,
  ...DUPLICATES_EN,
  ...LABELS_EN,
  ...MIGRATION_EN,
  ...ATTACHMENTS_EN,
  ...PAGES_EN,
  ...SRU_EN,
  ...PLACEHOLDER_EN,
};
