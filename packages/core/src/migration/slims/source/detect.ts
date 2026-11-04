import type { SlimsTableInfo, SlimsVersionInfo } from './types.js';

// Which SLiMS a source looks like (spec §11.1: detected by the presence of core tables and columns, not by a version
// number), and the tables and columns this release knows: SLiMS 9 table/column names (interoperability facts, no
// SLiMS code; clean-room, spec §1.3 allows table and column names).
//
//   SLiMS 8 (Akasia; upgrade role 16) added the RDA columns of `biblio`, `biblio_relation` and `mst_voc_ctrl`.
//   SLiMS 9 (Bulian; role 20, 9.0.0) added `loan_history`; later 9.x releases `mst_custom_field` and `files_read`
//   (role 23), `files.file_key` and `content.is_draft` (role 31), `item_custom` (role 36).

/**
 * The columns this release knows, per table the migration reads (§11.4), in SLiMS 9.8's order. `biblio_custom` and
 * `item_custom` also hold one `cf_*` column per custom field, named by `mst_custom_field.dbfield`.
 */
export const SLIMS_COLUMNS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  // The catalogue.
  biblio: [
    'biblio_id', 'gmd_id', 'title', 'sor', 'edition', 'isbn_issn', 'publisher_id', 'publish_year', 'collation', 'series_title',
    'call_number', 'language_id', 'source', 'publish_place_id', 'classification', 'notes', 'image', 'file_att', 'opac_hide',
    'promoted', 'labels', 'frequency_id', 'spec_detail_info', 'content_type_id', 'media_type_id', 'carrier_type_id',
    'input_date', 'last_update', 'uid',
  ],
  biblio_author: ['biblio_id', 'author_id', 'level'],
  biblio_topic: ['biblio_id', 'topic_id', 'level'],
  biblio_relation: ['biblio_id', 'rel_biblio_id', 'rel_type'],
  biblio_attachment: ['biblio_id', 'file_id', 'placement', 'access_type', 'access_limit'],
  biblio_custom: ['biblio_id'],
  files: ['file_id', 'file_title', 'file_name', 'file_url', 'file_dir', 'mime_type', 'file_desc', 'file_key', 'uploader_id', 'input_date', 'last_update'],
  files_read: ['filelog_id', 'file_id', 'date_read', 'member_id', 'user_id', 'client_ip'],
  item: [
    'item_id', 'biblio_id', 'call_number', 'coll_type_id', 'item_code', 'inventory_code', 'received_date', 'supplier_id', 'order_no',
    'location_id', 'order_date', 'item_status_id', 'site', 'source', 'invoice', 'price', 'price_currency', 'invoice_date',
    'input_date', 'last_update', 'uid',
  ],
  item_custom: ['item_id'],
  // Masters, authorities and the thesaurus.
  mst_gmd: ['gmd_id', 'gmd_code', 'gmd_name', 'icon_image', 'input_date', 'last_update'],
  mst_content_type: ['id', 'content_type', 'code', 'code2', 'input_date', 'last_update'],
  mst_media_type: ['id', 'media_type', 'code', 'code2', 'input_date', 'last_update'],
  mst_carrier_type: ['id', 'carrier_type', 'code', 'code2', 'input_date', 'last_update'],
  mst_language: ['language_id', 'language_name', 'input_date', 'last_update'],
  mst_publisher: ['publisher_id', 'publisher_name', 'input_date', 'last_update'],
  mst_place: ['place_id', 'place_name', 'input_date', 'last_update'],
  mst_author: ['author_id', 'author_name', 'author_year', 'authority_type', 'auth_list', 'input_date', 'last_update'],
  mst_topic: ['topic_id', 'topic', 'topic_type', 'auth_list', 'classification', 'input_date', 'last_update'],
  mst_voc_ctrl: ['vocabolary_id', 'topic_id', 'rt_id', 'related_topic_id', 'scope'],
  mst_relation_term: ['ID', 'rt_id', 'rt_desc'],
  mst_location: ['location_id', 'location_name', 'input_date', 'last_update'],
  mst_coll_type: ['coll_type_id', 'coll_type_name', 'input_date', 'last_update'],
  mst_item_status: ['item_status_id', 'item_status_name', 'rules', 'no_loan', 'skip_stock_take', 'input_date', 'last_update'],
  mst_supplier: ['supplier_id', 'supplier_name', 'address', 'postal_code', 'phone', 'contact', 'fax', 'account', 'e_mail', 'input_date', 'last_update'],
  mst_custom_field: ['field_id', 'primary_table', 'dbfield', 'label', 'type', 'default', 'max', 'data', 'indexed', 'class', 'is_public', 'width', 'note'],
  mst_servers: ['server_id', 'name', 'uri', 'server_type', 'input_date', 'last_update'],
  setting: ['setting_id', 'setting_name', 'setting_value'],
  content: ['content_id', 'content_title', 'content_desc', 'content_path', 'is_news', 'is_draft', 'publish_date', 'input_date', 'last_update', 'content_ownpage'],
  // Archived whole into migration_archive (§11.4).
  serial: ['serial_id', 'date_start', 'date_end', 'period', 'notes', 'biblio_id', 'gmd_id', 'input_date', 'last_update'],
  kardex: ['kardex_id', 'date_expected', 'date_received', 'seq_number', 'notes', 'serial_id', 'input_date', 'last_update'],
  mst_frequency: ['frequency_id', 'frequency', 'language_prefix', 'time_increment', 'time_unit', 'input_date', 'last_update'],
  stock_take: [
    'stock_take_id', 'stock_take_name', 'start_date', 'end_date', 'init_user', 'total_item_stock_taked', 'total_item_lost',
    'total_item_exists', 'total_item_loan', 'stock_take_users', 'is_active', 'report_file',
  ],
  stock_take_item: ['stock_take_id', 'item_id', 'item_code', 'title', 'gmd_name', 'classification', 'coll_type_name', 'call_number', 'location', 'status', 'checked_by', 'last_update'],
  mst_label: ['label_id', 'label_name', 'label_desc', 'label_image', 'input_date', 'last_update'],
  biblio_log: ['biblio_log_id', 'biblio_id', 'user_id', 'realname', 'title', 'ip', 'action', 'affectedrow', 'rawdata', 'additional_information', 'date'],
} satisfies Record<string, readonly string[]>);

/** The tables §11.4 archives raw into `migration_archive` (a subset of {@link SLIMS_COLUMNS}). */
export const SLIMS_ARCHIVED_TABLES: readonly string[] = Object.freeze(['serial', 'kardex', 'mst_frequency', 'stock_take', 'stock_take_item', 'mst_label', 'biblio_log', 'mst_item_status']);

/** Derived tables §11.4 skips (search indexes and caches). */
export const SLIMS_DERIVED_TABLES: readonly string[] = Object.freeze(['search_biblio', 'index_words', 'index_documents', 'cache']);

/** Tables §11.4 does not read in Phase 2 (D2-31: the report lists them as "Fase 3"); `member*`, `loan*` and `group*` too. */
const PHASE3_TABLES: ReadonlySet<string> = new Set([
  'fines', 'reserve', 'holiday', 'mst_loan_rules', 'mst_member_type', 'biblio_mark', 'comment', 'visitor_count', 'mst_visitor_room',
  'user', 'system_log',
]);
const PHASE3_PREFIXES = /^(member|loan|group)/;

/** How the migration treats a source table (§11.4). */
export type SlimsTableRole = 'read' | 'phase3' | 'derived' | 'other';

/** `read` (the migration reads it, archived tables included), `phase3` (not read in Phase 2), `derived` (skipped), or `other`. */
export function slimsTableRole(table: string): SlimsTableRole {
  if (Object.hasOwn(SLIMS_COLUMNS, table)) return 'read';
  if (SLIMS_DERIVED_TABLES.includes(table)) return 'derived';
  if (PHASE3_TABLES.has(table) || PHASE3_PREFIXES.test(table)) return 'phase3';
  return 'other';
}

/** Tables every SLiMS since Senayan 3 has: without one of them the source is not a SLiMS catalogue. */
const CORE_TABLES: readonly string[] = [
  'biblio', 'item', 'mst_gmd', 'mst_publisher', 'mst_place', 'mst_language', 'mst_author', 'mst_topic', 'biblio_author',
  'biblio_topic', 'mst_location', 'mst_coll_type', 'mst_item_status', 'mst_supplier', 'biblio_attachment', 'files',
];

/** Tables only SLiMS 9 has: one of them tells a SLiMS 9 from a SLiMS 8 (the split never lists them unseen, L12). */
export const SLIMS9_MARKER_TABLES: readonly string[] = Object.freeze(['loan_history', 'mst_custom_field', 'files_read']);

/** A custom field column of `biblio_custom` / `item_custom` (`cf_` and its generated suffix). */
const CUSTOM_COLUMN = /^cf_[A-Za-z0-9_]{1,59}$/;

/**
 * The version the source's tables look like (§11.1): `9` when it has every core table and a SLiMS 9 marker
 * (`loan_history`, `mst_custom_field` or `files_read`), `8` when it has the core tables and SLiMS 8's RDA columns
 * (`biblio.content_type_id`, `biblio_relation`, `mst_voc_ctrl`), otherwise `unknown`.
 *
 * `missing` lists the tables the migration reads that the source lacks (for `unknown`, at least the missing core
 * tables); `unknownColumns`, per table the migration reads, the columns this release does not know (a custom field's
 * `cf_*` column of `biblio_custom` / `item_custom` is known).
 */
export function detectSlimsVersion(tables: SlimsTableInfo[]): SlimsVersionInfo {
  const byName = new Map<string, SlimsTableInfo>();
  for (const t of tables) byName.set(t.name, t);

  const unknownColumns: Record<string, string[]> = {};
  for (const [table, known] of Object.entries(SLIMS_COLUMNS)) {
    const info = byName.get(table);
    if (info === undefined) continue;
    const custom = table === 'biblio_custom' || table === 'item_custom';
    const extra = info.columns.filter((c) => !known.includes(c) && !(custom && CUSTOM_COLUMN.test(c)));
    if (extra.length > 0) unknownColumns[table] = extra;
  }
  const missing = Object.keys(SLIMS_COLUMNS).filter((t) => !byName.has(t));

  if (CORE_TABLES.some((t) => !byName.has(t))) {
    const core = CORE_TABLES.filter((t) => !byName.has(t));
    return { version: 'unknown', missing: [...core, ...missing.filter((t) => !core.includes(t))], unknownColumns };
  }
  const nine = SLIMS9_MARKER_TABLES.some((t) => byName.has(t));
  const eight = (byName.get('biblio')?.columns.includes('content_type_id') ?? false) && byName.has('biblio_relation') && byName.has('mst_voc_ctrl');
  return { version: nine && eight ? '9' : eight ? '8' : 'unknown', missing, unknownColumns };
}
