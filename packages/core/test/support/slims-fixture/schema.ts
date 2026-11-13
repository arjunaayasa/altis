// The tables of the synthetic SLiMS fixture (spec §11.7): SLiMS 9 table/column names (interoperability facts, no SLiMS
// code; clean-room: table and column names and plausible types only, no SLiMS DDL). Every
// table §11.4 reads is here, in SLiMS 9.8's column order, plus a few tables the migration does not read (Phase 3,
// derived and a plugin's), so the reader's counting of those is exercised too.
//
// A few columns are typed as an older or hand-altered install would have them, because the traps need it:
// `mst_topic.topic_type` is a varchar (a type `o` or `c` from an import), `mst_publisher` is a latin1 table (raw
// Windows-1252 bytes in the dump), and two custom field columns are varchars although their fields say numeric and
// date (SLiMS changes a field's type without altering its column).

export interface FixtureTable {
  name: string;
  /** `name SQL-type` pairs, in order. */
  columns: readonly (readonly [string, string])[];
  primaryKey: readonly string[];
  /** Other key lines of the CREATE TABLE (written as they are). */
  keys?: readonly string[];
  /** Default utf8mb4. */
  charset?: 'utf8mb4' | 'latin1';
  /**
   * `mysqldump` (default): PRIMARY KEY inside CREATE TABLE, extended INSERT without a column list. `phpmyadmin`:
   * INSERT with a column list, the primary key added by ALTER TABLE at the end of the dump.
   */
  style?: 'mysqldump' | 'phpmyadmin';
}

const STAMPS = [
  ['input_date', 'datetime DEFAULT NULL'],
  ['last_update', 'datetime DEFAULT NULL'],
] as const;

/** The custom field columns (`mst_custom_field.dbfield`) of `biblio_custom` and `item_custom`. */
export const BIBLIO_CUSTOM_COLUMNS = [
  ['cf_1a2b3', 'varchar(255) DEFAULT NULL'], // text: funding source
  ['cf_4c5d6', 'varchar(255) DEFAULT NULL'], // numeric field over a varchar column (S19: '12' must become 12)
  ['cf_7e8f9', 'varchar(255) DEFAULT NULL'], // checklist: a serialized list
  ['cf_0a1b2', 'varchar(255) DEFAULT NULL'], // date field over a varchar column ('' and zero dates)
  ['cf_bad01', 'varchar(255) DEFAULT NULL'], // dropdown whose option list is a broken payload
] as const;
export const ITEM_CUSTOM_COLUMNS = [
  ['cf_9c8d7', 'varchar(255) DEFAULT NULL'], // dropdown: condition
  ['cf_5e6f7', 'text'], // longtext: physical note
] as const;

export const FIXTURE_TABLES: readonly FixtureTable[] = [
  // ---- masters, authorities, thesaurus
  {
    name: 'mst_gmd',
    columns: [['gmd_id', 'int(11) NOT NULL AUTO_INCREMENT'], ['gmd_code', 'varchar(3) DEFAULT NULL'], ['gmd_name', 'varchar(30) NOT NULL'], ['icon_image', 'varchar(100) DEFAULT NULL'], ...STAMPS],
    primaryKey: ['gmd_id'],
    keys: ['UNIQUE KEY `gmd_name` (`gmd_name`)'],
  },
  {
    name: 'mst_content_type',
    columns: [['id', 'int(11) NOT NULL AUTO_INCREMENT'], ['content_type', 'varchar(50) NOT NULL'], ['code', 'varchar(5) NOT NULL'], ['code2', 'char(1) NOT NULL'], ...STAMPS],
    primaryKey: ['id'],
  },
  {
    name: 'mst_media_type',
    columns: [['id', 'int(11) NOT NULL AUTO_INCREMENT'], ['media_type', 'varchar(50) NOT NULL'], ['code', 'varchar(5) NOT NULL'], ['code2', 'char(1) NOT NULL'], ...STAMPS],
    primaryKey: ['id'],
  },
  {
    name: 'mst_carrier_type',
    columns: [['id', 'int(11) NOT NULL AUTO_INCREMENT'], ['carrier_type', 'varchar(100) NOT NULL'], ['code', 'varchar(5) NOT NULL'], ['code2', 'char(1) NOT NULL'], ...STAMPS],
    primaryKey: ['id'],
  },
  {
    name: 'mst_language',
    columns: [['language_id', "char(5) NOT NULL DEFAULT ''"], ['language_name', 'varchar(20) NOT NULL'], ...STAMPS],
    primaryKey: ['language_id'],
  },
  {
    name: 'mst_publisher',
    columns: [['publisher_id', 'int(11) NOT NULL AUTO_INCREMENT'], ['publisher_name', 'varchar(100) NOT NULL'], ...STAMPS],
    primaryKey: ['publisher_id'],
    keys: ['UNIQUE KEY `publisher_name` (`publisher_name`)'],
    charset: 'latin1',
  },
  {
    name: 'mst_place',
    columns: [['place_id', 'int(11) NOT NULL AUTO_INCREMENT'], ['place_name', 'varchar(30) NOT NULL'], ...STAMPS],
    primaryKey: ['place_id'],
  },
  {
    name: 'mst_author',
    columns: [
      ['author_id', 'int(11) NOT NULL AUTO_INCREMENT'],
      ['author_name', 'varchar(100) NOT NULL'],
      ['author_year', 'varchar(20) DEFAULT NULL'],
      ['authority_type', "enum('p','o','c') DEFAULT 'p'"],
      ['auth_list', 'varchar(20) DEFAULT NULL'],
      ...STAMPS,
    ],
    primaryKey: ['author_id'],
    keys: ['UNIQUE KEY `author_name` (`author_name`,`authority_type`)'],
  },
  {
    name: 'mst_topic',
    columns: [
      ['topic_id', 'int(11) NOT NULL AUTO_INCREMENT'],
      ['topic', 'varchar(50) NOT NULL'],
      ['topic_type', "varchar(5) NOT NULL DEFAULT 't'"],
      ['auth_list', 'varchar(20) DEFAULT NULL'],
      ['classification', 'varchar(50) DEFAULT NULL'],
      ...STAMPS,
    ],
    primaryKey: ['topic_id'],
    keys: ['UNIQUE KEY `topic` (`topic`,`topic_type`)'],
  },
  {
    name: 'mst_voc_ctrl',
    columns: [['vocabolary_id', 'int(11) NOT NULL AUTO_INCREMENT'], ['topic_id', 'int(11) NOT NULL'], ['rt_id', 'varchar(11) DEFAULT NULL'], ['related_topic_id', 'varchar(250) DEFAULT NULL'], ['scope', 'text']],
    primaryKey: ['vocabolary_id'],
  },
  {
    name: 'mst_relation_term',
    columns: [['ID', 'int(11) NOT NULL AUTO_INCREMENT'], ['rt_id', 'varchar(11) NOT NULL'], ['rt_desc', 'varchar(50) NOT NULL']],
    primaryKey: ['ID'],
  },
  {
    name: 'mst_location',
    columns: [['location_id', "varchar(3) NOT NULL DEFAULT ''"], ['location_name', 'varchar(100) DEFAULT NULL'], ...STAMPS],
    primaryKey: ['location_id'],
  },
  {
    name: 'mst_coll_type',
    columns: [['coll_type_id', 'int(3) NOT NULL AUTO_INCREMENT'], ['coll_type_name', 'varchar(30) NOT NULL'], ...STAMPS],
    primaryKey: ['coll_type_id'],
  },
  {
    name: 'mst_item_status',
    columns: [
      ['item_status_id', 'char(3) NOT NULL'],
      ['item_status_name', 'varchar(30) NOT NULL'],
      ['rules', 'varchar(255) DEFAULT NULL'],
      ['no_loan', "smallint(1) NOT NULL DEFAULT '0'"],
      ['skip_stock_take', "smallint(1) NOT NULL DEFAULT '0'"],
      ...STAMPS,
    ],
    primaryKey: ['item_status_id'],
  },
  {
    name: 'mst_supplier',
    columns: [
      ['supplier_id', 'int(6) NOT NULL AUTO_INCREMENT'],
      ['supplier_name', 'varchar(100) NOT NULL'],
      ['address', 'varchar(100) DEFAULT NULL'],
      ['postal_code', 'char(10) DEFAULT NULL'],
      ['phone', 'char(14) DEFAULT NULL'],
      ['contact', 'char(30) DEFAULT NULL'],
      ['fax', 'char(14) DEFAULT NULL'],
      ['account', 'char(12) DEFAULT NULL'],
      ['e_mail', 'char(80) DEFAULT NULL'],
      ...STAMPS,
    ],
    primaryKey: ['supplier_id'],
  },
  {
    name: 'mst_custom_field',
    columns: [
      ['field_id', 'int(11) NOT NULL AUTO_INCREMENT'],
      ['primary_table', 'varchar(100) DEFAULT NULL'],
      ['dbfield', 'varchar(100) NOT NULL'],
      ['label', 'varchar(255) NOT NULL'],
      ['type', "enum('text','checklist','numeric','dropdown','longtext','choice','date') NOT NULL"],
      ['default', 'varchar(255) DEFAULT NULL'],
      ['max', 'int(11) DEFAULT NULL'],
      ['data', 'text'],
      ['indexed', 'tinyint(1) DEFAULT NULL'],
      ['class', 'varchar(100) DEFAULT NULL'],
      ['is_public', 'tinyint(1) DEFAULT NULL'],
      ['width', 'int(5) DEFAULT NULL'],
      ['note', 'text'],
    ],
    primaryKey: ['dbfield'],
    keys: ['UNIQUE KEY `field_id` (`field_id`)'],
  },
  {
    name: 'mst_servers',
    columns: [['server_id', 'int(11) NOT NULL AUTO_INCREMENT'], ['name', 'varchar(255) NOT NULL'], ['uri', 'text NOT NULL'], ['server_type', "tinyint(1) NOT NULL DEFAULT '1'"], ...STAMPS],
    primaryKey: ['server_id'],
  },
  {
    name: 'setting',
    columns: [['setting_id', 'int(3) NOT NULL AUTO_INCREMENT'], ['setting_name', 'varchar(30) NOT NULL'], ['setting_value', 'text']],
    primaryKey: ['setting_id'],
    keys: ['UNIQUE KEY `setting_name` (`setting_name`)'],
  },
  {
    name: 'content',
    columns: [
      ['content_id', 'int(11) NOT NULL AUTO_INCREMENT'],
      ['content_title', 'varchar(255) NOT NULL'],
      ['content_desc', 'text NOT NULL'],
      ['content_path', 'varchar(20) NOT NULL'],
      ['is_news', 'smallint(1) DEFAULT NULL'],
      ['is_draft', "smallint(1) DEFAULT '0'"],
      ['publish_date', 'date DEFAULT NULL'],
      ...STAMPS,
      ['content_ownpage', "enum('1','2') NOT NULL DEFAULT '1'"],
    ],
    primaryKey: ['content_id'],
    keys: ['UNIQUE KEY `content_path` (`content_path`)'],
    style: 'phpmyadmin',
  },
  // ---- the catalogue
  {
    name: 'biblio',
    columns: [
      ['biblio_id', 'int(11) NOT NULL AUTO_INCREMENT'],
      ['gmd_id', 'int(3) DEFAULT NULL'],
      ['title', 'text NOT NULL'],
      ['sor', 'varchar(200) DEFAULT NULL'],
      ['edition', 'varchar(50) DEFAULT NULL'],
      ['isbn_issn', 'varchar(32) DEFAULT NULL'],
      ['publisher_id', 'int(11) DEFAULT NULL'],
      ['publish_year', 'varchar(20) DEFAULT NULL'],
      ['collation', 'varchar(100) DEFAULT NULL'],
      ['series_title', 'varchar(200) DEFAULT NULL'],
      ['call_number', 'varchar(50) DEFAULT NULL'],
      ['language_id', "char(5) DEFAULT 'en'"],
      ['source', 'varchar(3) DEFAULT NULL'],
      ['publish_place_id', 'int(11) DEFAULT NULL'],
      ['classification', 'varchar(40) DEFAULT NULL'],
      ['notes', 'text'],
      ['image', 'varchar(100) DEFAULT NULL'],
      ['file_att', 'varchar(255) DEFAULT NULL'],
      ['opac_hide', "smallint(1) DEFAULT '0'"],
      ['promoted', "smallint(1) DEFAULT '0'"],
      ['labels', 'text'],
      ['frequency_id', "int(11) NOT NULL DEFAULT '0'"],
      ['spec_detail_info', 'text'],
      ['content_type_id', 'int(11) DEFAULT NULL'],
      ['media_type_id', 'int(11) DEFAULT NULL'],
      ['carrier_type_id', 'int(11) DEFAULT NULL'],
      ...STAMPS,
      ['uid', 'int(11) DEFAULT NULL'],
    ],
    primaryKey: ['biblio_id'],
    keys: ['KEY `references_idx` (`gmd_id`,`publisher_id`,`language_id`,`publish_place_id`)', 'FULLTEXT KEY `title_ft_idx` (`title`,`series_title`)'],
  },
  {
    name: 'biblio_author',
    columns: [['biblio_id', "int(11) NOT NULL DEFAULT '0'"], ['author_id', "int(11) NOT NULL DEFAULT '0'"], ['level', "int(1) NOT NULL DEFAULT '1'"]],
    primaryKey: ['biblio_id', 'author_id'],
  },
  {
    name: 'biblio_topic',
    columns: [['biblio_id', "int(11) NOT NULL DEFAULT '0'"], ['topic_id', "int(11) NOT NULL DEFAULT '0'"], ['level', "int(1) NOT NULL DEFAULT '1'"]],
    primaryKey: ['biblio_id', 'topic_id'],
  },
  {
    name: 'biblio_relation',
    columns: [['biblio_id', "int(11) NOT NULL DEFAULT '0'"], ['rel_biblio_id', "int(11) NOT NULL DEFAULT '0'"], ['rel_type', "int(1) DEFAULT '1'"]],
    primaryKey: ['biblio_id', 'rel_biblio_id'],
  },
  {
    name: 'files',
    columns: [
      ['file_id', 'int(11) NOT NULL AUTO_INCREMENT'],
      ['file_title', 'text NOT NULL'],
      ['file_name', 'text NOT NULL'],
      ['file_url', 'text'],
      ['file_dir', 'text'],
      ['mime_type', 'varchar(100) DEFAULT NULL'],
      ['file_desc', 'text'],
      ['file_key', 'text'],
      ['uploader_id', "int(11) NOT NULL DEFAULT '0'"],
      ...STAMPS,
    ],
    primaryKey: ['file_id'],
  },
  {
    // No primary key in this install: the DB source pages it by offset and flags it `no_pk`.
    name: 'biblio_attachment',
    columns: [
      ['biblio_id', 'int(11) NOT NULL'],
      ['file_id', 'int(11) NOT NULL'],
      ['placement', "enum('link','popup','embed') DEFAULT NULL"],
      ['access_type', "enum('public','private') NOT NULL"],
      ['access_limit', 'text'],
    ],
    primaryKey: [],
    keys: ['KEY `biblio_id` (`biblio_id`)', 'KEY `file_id` (`file_id`)'],
  },
  {
    name: 'files_read',
    columns: [
      ['filelog_id', 'int(11) NOT NULL AUTO_INCREMENT'],
      ['file_id', 'int(11) NOT NULL'],
      ['date_read', 'timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP'],
      ['member_id', 'varchar(20) DEFAULT NULL'],
      ['user_id', 'int(11) DEFAULT NULL'],
      ['client_ip', 'varchar(20) DEFAULT NULL'],
    ],
    primaryKey: ['filelog_id'],
  },
  {
    name: 'biblio_custom',
    columns: [['biblio_id', 'int(11) NOT NULL'], ...BIBLIO_CUSTOM_COLUMNS],
    primaryKey: ['biblio_id'],
  },
  {
    name: 'item',
    columns: [
      ['item_id', 'int(11) NOT NULL AUTO_INCREMENT'],
      ['biblio_id', 'int(11) DEFAULT NULL'],
      ['call_number', 'varchar(50) DEFAULT NULL'],
      ['coll_type_id', 'int(3) DEFAULT NULL'],
      ['item_code', 'varchar(20) DEFAULT NULL'],
      ['inventory_code', 'varchar(200) DEFAULT NULL'],
      ['received_date', 'date DEFAULT NULL'],
      ['supplier_id', 'varchar(6) DEFAULT NULL'],
      ['order_no', 'varchar(20) DEFAULT NULL'],
      ['location_id', 'varchar(3) DEFAULT NULL'],
      ['order_date', 'date DEFAULT NULL'],
      ['item_status_id', 'char(3) DEFAULT NULL'],
      ['site', 'varchar(50) DEFAULT NULL'],
      ['source', "int(1) NOT NULL DEFAULT '0'"],
      ['invoice', 'varchar(20) DEFAULT NULL'],
      ['price', 'int(11) DEFAULT NULL'],
      ['price_currency', 'varchar(10) DEFAULT NULL'],
      ['invoice_date', 'date DEFAULT NULL'],
      ...STAMPS,
      ['uid', 'int(11) DEFAULT NULL'],
    ],
    primaryKey: ['item_id'],
    keys: ['UNIQUE KEY `item_code` (`item_code`)', 'KEY `biblio_id_idx` (`biblio_id`)'],
  },
  {
    name: 'item_custom',
    columns: [['item_id', 'int(11) NOT NULL'], ...ITEM_CUSTOM_COLUMNS],
    primaryKey: ['item_id'],
  },
  // ---- archived whole (§11.4)
  {
    name: 'mst_frequency',
    columns: [
      ['frequency_id', 'int(11) NOT NULL AUTO_INCREMENT'],
      ['frequency', 'varchar(25) NOT NULL'],
      ['language_prefix', 'varchar(5) DEFAULT NULL'],
      ['time_increment', 'smallint(6) DEFAULT NULL'],
      ['time_unit', "enum('day','week','month','year') DEFAULT 'day'"],
      ...STAMPS,
    ],
    primaryKey: ['frequency_id'],
  },
  {
    name: 'serial',
    columns: [
      ['serial_id', 'int(11) NOT NULL AUTO_INCREMENT'],
      ['date_start', 'date NOT NULL'],
      ['date_end', 'date DEFAULT NULL'],
      ['period', 'varchar(100) DEFAULT NULL'],
      ['notes', 'text'],
      ['biblio_id', 'int(11) DEFAULT NULL'],
      ['gmd_id', 'int(11) DEFAULT NULL'],
      ...STAMPS,
    ],
    primaryKey: ['serial_id'],
  },
  {
    name: 'kardex',
    columns: [
      ['kardex_id', 'int(11) NOT NULL AUTO_INCREMENT'],
      ['date_expected', 'date NOT NULL'],
      ['date_received', 'date DEFAULT NULL'],
      ['seq_number', 'varchar(25) DEFAULT NULL'],
      ['notes', 'text'],
      ['serial_id', 'int(11) DEFAULT NULL'],
      ...STAMPS,
    ],
    primaryKey: ['kardex_id'],
  },
  {
    name: 'stock_take',
    columns: [
      ['stock_take_id', 'int(11) NOT NULL AUTO_INCREMENT'],
      ['stock_take_name', 'varchar(200) NOT NULL'],
      ['start_date', 'datetime NOT NULL'],
      ['end_date', 'datetime DEFAULT NULL'],
      ['init_user', 'varchar(50) NOT NULL'],
      ['total_item_stock_taked', 'int(11) DEFAULT NULL'],
      ['total_item_lost', 'int(11) DEFAULT NULL'],
      ['total_item_exists', "int(11) DEFAULT '0'"],
      ['total_item_loan', 'int(11) DEFAULT NULL'],
      ['stock_take_users', 'mediumtext'],
      ['is_active', "int(1) NOT NULL DEFAULT '0'"],
      ['report_file', 'varchar(255) DEFAULT NULL'],
    ],
    primaryKey: ['stock_take_id'],
  },
  {
    name: 'stock_take_item',
    columns: [
      ['stock_take_id', 'int(11) NOT NULL'],
      ['item_id', 'int(11) NOT NULL'],
      ['item_code', 'varchar(20) NOT NULL'],
      ['title', 'varchar(255) NOT NULL'],
      ['gmd_name', 'varchar(30) DEFAULT NULL'],
      ['classification', 'varchar(30) DEFAULT NULL'],
      ['coll_type_name', 'varchar(30) DEFAULT NULL'],
      ['call_number', 'varchar(50) DEFAULT NULL'],
      ['location', 'varchar(100) DEFAULT NULL'],
      ['status', "enum('e','m','u','l') NOT NULL DEFAULT 'm'"],
      ['checked_by', 'varchar(50) NOT NULL'],
      ['last_update', 'datetime DEFAULT NULL'],
    ],
    primaryKey: ['stock_take_id', 'item_id'],
    keys: ['UNIQUE KEY `item_code` (`item_code`)'],
  },
  {
    name: 'mst_label',
    columns: [['label_id', 'int(11) NOT NULL AUTO_INCREMENT'], ['label_name', 'varchar(20) NOT NULL'], ['label_desc', 'varchar(50) DEFAULT NULL'], ['label_image', 'varchar(200) NOT NULL'], ...STAMPS],
    primaryKey: ['label_id'],
  },
  {
    name: 'biblio_log',
    columns: [
      ['biblio_log_id', 'int(11) NOT NULL AUTO_INCREMENT'],
      ['biblio_id', 'int(11) NOT NULL'],
      ['user_id', 'int(11) NOT NULL'],
      ['realname', 'varchar(100) NOT NULL'],
      ['title', 'text NOT NULL'],
      ['ip', 'varchar(200) NOT NULL'],
      ['action', 'varchar(50) NOT NULL'],
      ['affectedrow', 'varchar(50) NOT NULL'],
      ['rawdata', 'text NOT NULL'],
      ['additional_information', 'text NOT NULL'],
      ['date', 'datetime NOT NULL'],
    ],
    primaryKey: ['biblio_log_id'],
  },
  // ---- not read in Phase 2 ("Fase 3"), derived, and a plugin's table
  {
    name: 'member',
    columns: [
      ['member_id', 'varchar(20) NOT NULL'],
      ['member_name', 'varchar(100) NOT NULL'],
      ['member_email', 'varchar(100) DEFAULT NULL'],
      ['member_since_date', 'date DEFAULT NULL'],
      // ---- Komunitas K1 (usage tables) ----
      // SLiMS 9 table/column names (interoperability facts, no SLiMS code): the member type, the address (personal data
      // the usage import must never stage) and the expiry the active-member counts read.
      ['member_type_id', 'int(6) DEFAULT NULL'],
      ['member_address', 'varchar(255) DEFAULT NULL'],
      ['expire_date', 'date DEFAULT NULL'],
    ],
    primaryKey: ['member_id'],
  },
  {
    name: 'loan',
    columns: [
      ['loan_id', 'int(11) NOT NULL AUTO_INCREMENT'],
      ['item_code', 'varchar(20) DEFAULT NULL'],
      ['member_id', 'varchar(20) DEFAULT NULL'],
      ['loan_date', 'date NOT NULL'],
      ['due_date', 'date NOT NULL'],
      // ---- Komunitas K1 (usage tables) ----
      // SLiMS 9 table/column names (interoperability facts, no SLiMS code): whether the copy went out and came back.
      ['is_lent', 'int(1) NOT NULL DEFAULT 0'],
      ['is_return', 'int(1) NOT NULL DEFAULT 0'],
      ['return_date', 'date DEFAULT NULL'],
    ],
    primaryKey: ['loan_id'],
  },
  {
    name: 'loan_history',
    columns: [
      ['loan_id', 'int(11) NOT NULL'],
      ['item_code', 'varchar(20) NOT NULL'],
      ['biblio_id', 'int(11) NOT NULL'],
      ['title', 'text'],
      ['member_id', 'varchar(20) NOT NULL'],
      // ---- Komunitas K1 (usage tables) ----
      // SLiMS 9 table/column names (interoperability facts, no SLiMS code): the class and member type kept with a loan.
      ['classification', 'varchar(40) DEFAULT NULL'],
      ['member_type_name', 'varchar(50) DEFAULT NULL'],
      ['loan_date', 'date DEFAULT NULL'],
    ],
    primaryKey: ['loan_id'],
  },
  // ---- Komunitas K1 (usage tables) ----
  // SLiMS 9 table/column names (interoperability facts, no SLiMS code): the visitor log (a member's id, or a guest's
  // name and institution) and the member types. The catalogue migration reads neither; both are empty unless the
  // fixture is built with its usage option.
  {
    name: 'visitor_count',
    columns: [
      ['visitor_id', 'int(11) NOT NULL AUTO_INCREMENT'],
      ['member_id', 'varchar(20) DEFAULT NULL'],
      ['member_name', 'varchar(255) NOT NULL'],
      ['institution', 'varchar(100) DEFAULT NULL'],
      ['checkin_date', 'datetime NOT NULL'],
    ],
    primaryKey: ['visitor_id'],
  },
  {
    name: 'mst_member_type',
    columns: [
      ['member_type_id', 'int(11) NOT NULL AUTO_INCREMENT'],
      ['member_type_name', 'varchar(50) NOT NULL'],
    ],
    primaryKey: ['member_type_id'],
  },
  {
    name: 'search_biblio',
    columns: [['biblio_id', 'int(11) NOT NULL'], ['title', 'text'], ['author', 'text'], ['topic', 'text']],
    primaryKey: ['biblio_id'],
  },
  {
    name: 'read_counter',
    columns: [['id', 'int(11) NOT NULL AUTO_INCREMENT'], ['item_code', 'varchar(20) NOT NULL'], ['title', 'text'], ['created_at', 'datetime DEFAULT NULL']],
    primaryKey: ['id'],
  },
];
