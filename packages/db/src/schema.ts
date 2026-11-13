import type { ColumnType, Generated } from 'kysely';

// The Kysely database interface: one entry per table, written by hand to match the migrations
// (src/migrations/0001_* … 0009_*, Phase 2's 0020_* … 0029_*, Komunitas K1's 0030_* … 0033_*) and the runner's own tables (ddl.ts ensureBootstrap, migrator.ts). columns.ts
// (TABLE_COLUMNS, TABLE_KEYS) describes the same tables column by column; its drift test checks both against the
// catalog.
//
// Conventions (spec §6.1, ruling for Task 12):
// - ULIDs (`id()`, `ulid()`), hashes, tokens and codes are `string`.
// - Timestamps are BIGINT epoch milliseconds UTC: `number` (the pg int8 parser of connect.ts returns numbers).
// - Booleans are SMALLINT 0/1: `number`, holding 0 or 1. The database layer does no boolean coercion.
// - JSON and TEXT columns are `string` (JSON is validated with Zod by the code that reads it).
// - A column with a database default (or an auto-increment key) is `Generated<…>`: optional on insert.
// - A nullable column is `… | null`.
//
// Column additions follow expand-contract (spec §6.4): add the column to its table here in the same change as
// the migration that adds it.

/** SMALLINT holding 0 or 1. */
export type Flag = number;
/** BIGINT epoch milliseconds, UTC. */
export type EpochMs = number;
/** The values of `settings.scope`; each is classified by SETTINGS_SCOPE_CLASS (registry.ts). */
export type SettingsScope = 'data' | 'instance';

// ---------------------------------------------------------------------------------------------------------------
// 0001_meta_and_locks

/** Named locks (spec §6.3): claimed with a conditional `until < now`. Class volatile. */
export interface LocksTable {
  name: string;
  /** key191() (ruling R48): binary, compared exactly on every dialect. */
  owner: string;
  until: EpochMs;
}

// ---------------------------------------------------------------------------------------------------------------
// 0002_org_and_identity

/** Class data. */
export interface BranchesTable {
  id: string;
  code_key: string;
  code_display: string;
  name: string;
  address: string | null;
  /** IANA zone, e.g. `Asia/Jakarta`. */
  timezone: string;
  is_default: Generated<Flag>;
  archived_at: EpochMs | null;
  version: Generated<number>;
  created_at: EpochMs;
  created_by: string | null;
  updated_at: EpochMs;
  updated_by: string | null;
}

/** Class data. */
export interface StaffUsersTable {
  id: string;
  username_key: string;
  username_display: string;
  name: string;
  email_key: string | null;
  email_display: string | null;
  /** PHC string. */
  password_hash: string;
  /** `active` | `disabled` | `locked` (`locked` is set manually only). */
  status: string;
  /** null: the library's language. */
  locale: string | null;
  /** `v1:<kid>:<iv>:<ct>` (spec §7.6). */
  totp_secret_enc: string | null;
  totp_enabled: Generated<Flag>;
  totp_last_step: Generated<number>;
  totp_reenroll: Generated<Flag>;
  mfa_required: Generated<Flag>;
  must_change_password: Generated<Flag>;
  authz_version: Generated<number>;
  last_login_at: EpochMs | null;
  version: Generated<number>;
  created_at: EpochMs;
  created_by: string | null;
  updated_at: EpochMs;
  updated_by: string | null;
}

/** Class data. `user_id` references staff_users (ON DELETE CASCADE). */
export interface StaffRecoveryCodesTable {
  id: string;
  user_id: string;
  code_hash: string;
  used_at: EpochMs | null;
  created_at: EpochMs;
}

/** Class data. */
export interface RolesTable {
  id: string;
  key: string;
  name: string;
  description: string | null;
  is_system: Generated<Flag>;
  mfa_required: Generated<Flag>;
  version: Generated<number>;
  created_at: EpochMs;
  created_by: string | null;
  updated_at: EpochMs;
  updated_by: string | null;
}

/** Class data; custom roles only. `role_id` references roles (ON DELETE CASCADE). */
export interface RolePermissionsTable {
  role_id: string;
  permission: string;
}

/**
 * Class data. `user_id` references staff_users (ON DELETE CASCADE), `role_id` roles (ON DELETE RESTRICT).
 * `scope_key` is `''` for a global assignment, otherwise the `branch_id`; it has no default on purpose (binary
 * key191(), ruling R39).
 */
export interface UserRolesTable {
  id: string;
  user_id: string;
  role_id: string;
  branch_id: string | null;
  scope_key: string;
  created_at: EpochMs;
  created_by: string | null;
}

// ---------------------------------------------------------------------------------------------------------------
// 0003_sessions_and_limits

/** Class volatile. `id` is the SHA-256 hex of the session token. */
export interface SessionsTable {
  id: string;
  subject_type: string;
  subject_id: string;
  created_at: EpochMs;
  last_seen_at: EpochMs;
  expires_at: EpochMs;
  ip: string | null;
  user_agent: string | null;
  mfa_passed: Generated<Flag>;
  reauth_at: EpochMs | null;
  remember_selector: string | null;
  authz_version: Generated<number>;
}

/** Class volatile. */
export interface RememberTokensTable {
  selector: string;
  validator_hash: string;
  prev_validator_hash: string | null;
  rotated_at: EpochMs | null;
  subject_type: string;
  subject_id: string;
  expires_at: EpochMs;
  mfa_bound: Generated<Flag>;
  last_used_at: EpochMs | null;
}

/** Class volatile. */
export interface PasswordResetsTable {
  token_hash: string;
  subject_type: string;
  subject_id: string;
  expires_at: EpochMs;
  used_at: EpochMs | null;
}

/** Class volatile. `bucket` is the SHA-256 hex of `bucket_name` (TEXT, ruling R43). */
export interface RateLimitsTable {
  bucket: string;
  window_start: EpochMs;
  bucket_name: string;
  count: Generated<number>;
}

// ---------------------------------------------------------------------------------------------------------------
// 0004_settings_and_audit

/** Table class data; each row's class follows its `scope` (SETTINGS_SCOPE_CLASS in registry.ts). */
export interface SettingsTable {
  key: string;
  /** JSON; NULL for a secret that is cleared or could not be carried over by a restore (ruling R42). */
  value: string | null;
  is_secret: Generated<Flag>;
  /**
   * Writes are limited to the scopes SETTINGS_SCOPE_CLASS classifies; reads are a plain string (validate them).
   */
  scope: ColumnType<string, SettingsScope, SettingsScope>;
  updated_at: EpochMs;
  updated_by: string | null;
}

/** Class history. Rows are never updated (spec §6.3). */
export interface AuditLogTable {
  id: string;
  seq: number;
  at: EpochMs;
  actor_type: string;
  /** CHAR(26): a ULID or NULL only (auditAppend validates it; a padded value would break the chain on PostgreSQL). */
  actor_id: string | null;
  action: string;
  entity: string | null;
  /** key191() (ruling R40b): any identifier of the entity, a settings key or a schedule name included. */
  entity_id: string | null;
  /** CHAR(26): a ULID or NULL only (auditAppend validates it). */
  branch_id: string | null;
  ip: string | null;
  /** JSON. */
  meta: string;
  prev_hash: string;
  hash: string;
}

/** Class install. One row, `id = 1`, seeded by 0004 with `last_seq = 0` and `last_hash` = 64 zeros. */
export interface AuditHeadTable {
  id: number;
  last_seq: number;
  last_hash: string;
}

// ---------------------------------------------------------------------------------------------------------------
// 0005_jobs_events_notifications

/** Class volatile. */
export interface JobsTable {
  id: string;
  type: string;
  /** JSON. */
  payload: string;
  /** Encrypted with the keyring; never shown; deleted on a terminal status. */
  secret_param: string | null;
  /** `queued` | `running` | `succeeded` | `dead` | `cancelled`. */
  status: string;
  run_at: EpochMs;
  attempts: Generated<number>;
  max_attempts: number;
  /** Set to NULL on a terminal status. */
  unique_key: string | null;
  /** key191() (ruling R48): binary, compared exactly on every dialect. */
  lock_token: string | null;
  /** key191() (ruling R48). */
  locked_by: string | null;
  locked_until: EpochMs | null;
  cancel_requested: Generated<Flag>;
  progress: Generated<number>;
  progress_message: string | null;
  last_error: string | null;
  created_by: string | null;
  created_at: EpochMs;
  updated_at: EpochMs;
  finished_at: EpochMs | null;
  /**
   * 0009_ops_jobs: 1 once the handler called `markPointOfNoReturn()` (spec §10.1): the job can no longer be
   * cancelled. Default 0.
   */
  point_of_no_return: Generated<number>;
}

/** Class config. */
export interface SchedulesTable {
  name: string;
  expr: string;
  enabled: Generated<Flag>;
  next_run_at: EpochMs;
  last_run_at: EpochMs | null;
}

/** Class volatile. */
export interface EventsTable {
  seq: Generated<number>;
  channel: string;
  type: string;
  /** JSON, without personal data. */
  payload: string;
  created_at: EpochMs;
}

/** Class volatile. `cursor` is the last `events.seq` the consumer processed. */
export interface EventConsumersTable {
  name: string;
  cursor: Generated<number>;
  enabled: Generated<Flag>;
  updated_at: EpochMs;
  needs_full_reindex: Generated<Flag>;
}

/** Class data. Addressed to a user (`user_id`) or to holders of a permission (`audience_permission`). */
export interface NotificationsTable {
  id: string;
  audience_permission: string | null;
  user_id: string | null;
  type: string;
  title_key: string;
  /** JSON. */
  params: string;
  link: string | null;
  created_at: EpochMs;
  expires_at: EpochMs;
}

/** Class data. `notification_id` references notifications (ON DELETE CASCADE). */
export interface NotificationReadsTable {
  notification_id: string;
  user_id: string;
  read_at: EpochMs;
}

// ---------------------------------------------------------------------------------------------------------------
// 0006_files_custom_idempotency

/** Class data. The database stores no paths: they are derived from the id (spec §7.5). */
export interface FilesTable {
  id: string;
  original_name: string;
  mime: string;
  size: number;
  sha256: string;
  context: string;
  owner_type: string | null;
  /** key191() (ruling R41): the owner's identifier, not necessarily a ULID. */
  owner_id: string | null;
  access: string;
  /** `ok` | `missing`. */
  status: string;
  created_at: EpochMs;
  created_by: string | null;
}

/** Class volatile. `owner` is `<subject_type>:<subject_id>`. */
export interface UploadSessionsTable {
  id: string;
  /** key191() (ruling R48): binary, compared exactly on every dialect. */
  owner: string;
  context: string;
  size: number;
  sha256: string;
  chunk_size: number;
  received: Generated<number>;
  expires_at: EpochMs;
}

/** Class data. Extra fields of an entity (spec §6.1); `code_key` is unique per `entity`. */
export interface CustomFieldDefsTable {
  id: string;
  /** The table the field extends, e.g. `staff_users`; Phase 2: `records`, `items`. */
  entity: string;
  code_key: string;
  code_display: string;
  /** The Indonesian label (Phase 2: `labelId`). */
  label: string;
  /** Phase 2: `text` | `longtext` | `number` | `date` | `select` | `multiselect` | `boolean` | `url`. */
  type: string;
  /** JSON; Phase 2 select options: `[{value, label_id, label_en}]`. */
  options: string | null;
  is_required: Generated<Flag>;
  sort_order: Generated<number>;
  archived_at: EpochMs | null;
  version: Generated<number>;
  created_at: EpochMs;
  created_by: string | null;
  updated_at: EpochMs;
  updated_by: string | null;
  // ---- Phase 2 (catalog): Task 1, 0026_custom_fields_i18n ----
  /** The English label; null: the Indonesian one is shown in both languages. */
  label_en: string | null;
  /** Shown on the OPAC ("Informasi lain"). Default 0. */
  is_public: Generated<Flag>;
  /** A text value goes into the search text (only when also public in Phase 2, S20). Default 0. */
  is_searchable: Generated<Flag>;
}

/** Class data. `field_id` references custom_field_defs (ON DELETE CASCADE); `entity_id` is the row's id. */
export interface CustomValuesTable {
  field_id: string;
  entity_id: string;
  /** JSON. */
  value: string;
  updated_at: EpochMs;
  updated_by: string | null;
}

/** Class volatile (spec §7.9). */
export interface IdempotencyKeysTable {
  subject_type: string;
  subject_id: string;
  key: string;
  request_hash: string;
  /** `processing` | `done`. */
  status: string;
  locked_until: EpochMs;
  response_status: number | null;
  response_body: string | null;
  created_at: EpochMs;
}

// ---------------------------------------------------------------------------------------------------------------
// 0007_license_releases_backups

/** Class install. */
export interface LicenseStateTable {
  install_id: string;
  license_raw: string | null;
  status_cache: string | null;
  checked_at: EpochMs | null;
  grace_until: EpochMs | null;
  last_heartbeat_at: EpochMs | null;
  clock_high_water: Generated<EpochMs>;
}

/** Class history. */
export interface ReleasesLogTable {
  id: string;
  version: string;
  action: string;
  from_version: string | null;
  status: string;
  started_at: EpochMs;
  finished_at: EpochMs | null;
  backup_id: string | null;
  /** JSON. */
  detail: string | null;
}

/** Class history. */
export interface BackupsTable {
  id: string;
  /** `manual` | `scheduled` | `pre_update` | `pre_restore` | `external`. */
  kind: string;
  size: number | null;
  sha256: string | null;
  schema_version: string;
  app_version: string;
  dialect: string;
  /** `snapshot` | `frozen`. */
  consistency: string;
  status: string;
  created_at: EpochMs;
}

// ---------------------------------------------------------------------------------------------------------------
// ---- Phase 2 (catalog): Task 1 ----
// Migrations 0020–0027 (Phase 2 spec §2.2). Every `*_key` is normalizeKey() of its display form (title_key: the
// normalized title of §2.1); every text column of a primary or unique key is key191() (binary, P2-09).

/** The archive/version and trail columns most catalog tables share. */
interface ArchivedTrail {
  archived_at: EpochMs | null;
  version: Generated<number>;
  created_at: EpochMs;
  created_by: string | null;
  updated_at: EpochMs;
  updated_by: string | null;
}

// 0020_catalog_authorities

/** Class data. A language by its MARC code (≈ ISO 639-2/B). */
export interface LanguagesTable extends ArchivedTrail {
  id: string;
  code_display: string;
  code_key: string;
  name_id: string;
  name_en: string;
}

/** Class data. `template` is the JSON template of §3.8. */
export interface MaterialTypesTable extends ArchivedTrail {
  id: string;
  code_display: string;
  code_key: string;
  name_id: string;
  name_en: string;
  /** Leader/06, one character. */
  marc_type: string;
  /** Leader/07, one character; default `m`. */
  marc_level: Generated<string>;
  /** RDA 336; default `txt`. */
  content_type: Generated<string>;
  /** RDA 337; default `n`. */
  media_type: Generated<string>;
  /** RDA 338; default `nc`. */
  carrier_type: Generated<string>;
  /** schema.org type; default `Book`. */
  schema_type: Generated<string>;
  /** DCMI type; default `Text`. */
  dcmi_type: Generated<string>;
  /** JSON `{fields, defaults, customFields}`. */
  template: string;
  sort_order: Generated<number>;
}

/** Class data. */
export interface PublishersTable extends ArchivedTrail {
  id: string;
  name_display: string;
  name_key: string;
  place: string | null;
  /** The publisher this archived one was merged into. */
  merged_into: string | null;
}

/** Class data. `name_key` = agentNameKey(name, dates), UNIQUE per `type`. */
export interface AgentsTable extends ArchivedTrail {
  id: string;
  /** `person` | `organization` | `meeting`. */
  type: string;
  name_display: string;
  name_key: string;
  dates: string | null;
  authority_source: string | null;
  authority_ref: string | null;
  note: string | null;
  merged_into: string | null;
}

/** Class data. `term_key` UNIQUE per `type`. */
export interface SubjectsTable extends ArchivedTrail {
  id: string;
  /** `topic` | `geographic` | `name` | `temporal` | `genre` | `occupation`. */
  type: string;
  term_display: string;
  term_key: string;
  classification: string | null;
  scope_note: string | null;
  authority_source: string | null;
  merged_into: string | null;
}

/** Class data. `subject_id` references subjects (ON DELETE CASCADE); `related_id` has no foreign key. */
export interface SubjectRelationsTable {
  subject_id: string;
  related_id: string;
  /** `use` | `uf` | `bt` | `nt` | `rt` | `sa`. */
  rel: string;
}

// 0021_catalog_records

/** Class data. */
export interface RecordsTable extends ArchivedTrail {
  id: string;
  material_type_id: string;
  title: string;
  subtitle: string | null;
  responsibility: string | null;
  title_key: string;
  edition: string | null;
  material_detail: string | null;
  publisher_id: string | null;
  publication_place: string | null;
  /** CHAR(4): four digits when set. */
  publication_year: string | null;
  publication_date_text: string | null;
  physical_desc: string | null;
  series: string | null;
  classification: string | null;
  call_number: string | null;
  language_id: string | null;
  content_type: string | null;
  media_type: string | null;
  carrier_type: string | null;
  summary: string | null;
  notes: string | null;
  cover_file_id: string | null;
  /** Default 1. */
  opac_visible: Generated<Flag>;
  /** Default 0. */
  promoted: Generated<Flag>;
  /** `manual`, `sru:<serverId>`, `isbn:arsya`, `import:<runId>`, `slims:<id>`. */
  source: string | null;
  merged_into: string | null;
  /** The last change of the record's public representation (OAI datestamp, sitemap, RSS). */
  changed_at: EpochMs;
  // ---- Komunitas K1 (tables): 0033, the accreditation fields (none changes the public representation) ----
  /** `general` | `children` | `special_needs`; null: not stated. */
  audience: string | null;
  /** Who made a local work: `student` | `teacher` | `staff` | `school` | `local`; null: not a local work. */
  local_work: string | null;
  /** The kind of local work (`LOCAL_WORK_KINDS`). */
  local_work_kind: string | null;
  /** `encyclopedia` | `dictionary` | `handbook` | `atlas` | `globe` | `biography` | `almanac` | `directory` | `other`. */
  reference_kind: string | null;
}

/** Class data. `record_id` references records (ON DELETE CASCADE). */
export interface RecordIdentifiersTable {
  id: string;
  record_id: string;
  /** `isbn` | `issn` | `doi` | `control` | `other`. */
  type: string;
  value_display: string;
  /** ISBN-13 digits, ISSN 8 characters, DOI lower case, `control` = `<003>:<001>`. */
  value_key: string;
  qualifier: string | null;
  /** Default 1. */
  is_valid: Generated<Flag>;
  sort_order: Generated<number>;
}

/** Class data. `record_id` references records (ON DELETE CASCADE). */
export interface RecordMarcExtraTable {
  id: string;
  record_id: string;
  /** Three characters: a MARC tag, or `LDR`. */
  tag: string;
  /** One character, a blank included (VARCHAR(1), so a blank reads back as a blank on every dialect). */
  ind1: string;
  ind2: string;
  /** JSON `[[code, value], …]`, or a control field's content. */
  data: string;
  sort_order: Generated<number>;
}

/** Class data. `record_id` references records (ON DELETE CASCADE). */
export interface RecordAgentsTable {
  record_id: string;
  agent_id: string;
  /** A MARC relator code. */
  role: string;
  is_main: Generated<Flag>;
  sort_order: Generated<number>;
}

/** Class data. `record_id` references records (ON DELETE CASCADE). */
export interface RecordSubjectsTable {
  record_id: string;
  subject_id: string;
  is_primary: Generated<Flag>;
  sort_order: Generated<number>;
}

/** Class data. `record_id` references records (ON DELETE CASCADE); stored in one direction. */
export interface RecordRelationsTable {
  record_id: string;
  related_id: string;
  /** `related` | `other_edition` | `part_of` | `translation_of`. */
  type: string;
}

/** Class data. `record_id` references records (ON DELETE CASCADE). */
export interface AttachmentsTable extends ArchivedTrail {
  id: string;
  record_id: string;
  /** `file` | `url`. */
  kind: string;
  file_id: string | null;
  url: string | null;
  title: string;
  description: string | null;
  /** `public` | `staff`. */
  access: string;
  /** JSON: SLiMS member type ids (Phase 3). */
  legacy_access_limit: string | null;
  read_count: Generated<number>;
  sort_order: Generated<number>;
}

// 0022_catalog_items

/** Class data. `branch_id` references branches (ON DELETE RESTRICT); `parent_id` has no foreign key. */
export interface LocationsTable extends ArchivedTrail {
  id: string;
  branch_id: string;
  parent_id: string | null;
  /** `room` | `area` | `shelf`. */
  kind: string;
  code_display: string;
  code_key: string;
  name: string;
  shelf_hint: string | null;
  class_from: string | null;
  class_to: string | null;
  /** A room's floor plan. */
  map_file_id: string | null;
  /** The box on the parent's plan, per mille (0–1000). */
  map_x: number | null;
  map_y: number | null;
  map_w: number | null;
  map_h: number | null;
  /** Default 1. */
  is_public: Generated<Flag>;
  sort_order: Generated<number>;
}

/** Class data. */
export interface CollectionTypesTable extends ArchivedTrail {
  id: string;
  code_display: string;
  code_key: string;
  name_id: string;
  name_en: string;
  /** Default 1. */
  loanable: Generated<Flag>;
  /** Default 1. */
  self_service: Generated<Flag>;
  sort_order: Generated<number>;
}

/** Class data. The contact columns are personal data (main spec §6.9). */
export interface SuppliersTable extends ArchivedTrail {
  id: string;
  code_display: string;
  code_key: string;
  name: string;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  note: string | null;
}

/** Class data. `record_id` references records (ON DELETE RESTRICT). */
export interface ItemsTable extends ArchivedTrail {
  id: string;
  record_id: string;
  branch_id: string;
  barcode_display: string;
  /** The normalised barcode (spec §3.4, normalizeBarcode); UNIQUE across branches. */
  barcode_key: string;
  inventory_no: string | null;
  /** null: the record's. */
  call_number: string | null;
  location_id: string | null;
  collection_type_id: string;
  /** §2.5. */
  status: string;
  status_note: string | null;
  /** 1–99, default 1. */
  parts_total: Generated<number>;
  /** `purchase` | `gift` | `exchange` | `deposit` | `other`. */
  acq_source: string | null;
  order_no: string | null;
  /** `YYYY-MM-DD`. */
  order_date: string | null;
  received_date: string | null;
  invoice_date: string | null;
  supplier_id: string | null;
  invoice_no: string | null;
  /** In the currency's minor unit. */
  price: number | null;
  currency: string | null;
  note: string | null;
  // ---- Komunitas K1 (tables): 0033 ----
  /** `YYYY-MM-DD`: the date the copy was entered in the source system (library time zone); written by a migration only. */
  input_on: string | null;
}

/** Class data. `item_id` references items (ON DELETE CASCADE). */
export interface ItemEventsTable {
  id: string;
  item_id: string;
  at: EpochMs;
  /** `created` | `updated` | `status` | `moved` | `archived` | `imported` | `migrated`. */
  type: string;
  from_status: string | null;
  to_status: string | null;
  from_location_id: string | null;
  to_location_id: string | null;
  actor_type: string;
  actor_id: string | null;
  /** JSON: field names only. */
  meta: string;
}

// 0023_opac_pages

/** Class data. `slug_key` UNIQUE per `kind`. */
export interface PagesTable extends ArchivedTrail {
  id: string;
  /** `page` | `news`. */
  kind: string;
  slug_key: string;
  /** `draft` | `published`. */
  status: string;
  published_at: EpochMs | null;
  show_in_nav: Generated<Flag>;
  cover_file_id: string | null;
  sort_order: Generated<number>;
}

/** Class data. `page_id` references pages (ON DELETE CASCADE). */
export interface PageTranslationsTable {
  page_id: string;
  /** `id` | `en`. */
  locale: string;
  title: string;
  summary: string | null;
  /** `markdown` | `html`. */
  body_format: string;
  body: string;
  updated_at: EpochMs;
}

// 0024_search_index (class volatile)

/** Class volatile. One row per record; `doc_no` is the FTS5 rowid on SQLite. */
export interface SearchDocTable {
  doc_no: Generated<number>;
  record_id: string;
  is_public: Flag;
  is_archived: Flag;
  t_title: string;
  t_agents: string;
  t_subjects: string;
  t_rest: string;
  title_key: string;
  year: number | null;
  created_at: EpochMs;
  changed_at: EpochMs;
}

/** Class volatile. */
export interface SearchFacetTable {
  record_id: string;
  /** `mt`, `lg`, `ct`, `br`, `lc`, `av`, `at`, `sb`, `cl`. */
  facet: string;
  value_key: string;
}

/** Class volatile. */
export interface SearchTermTable {
  term: string;
  first_char: string;
  len: number;
  df: number;
}

/** Class volatile. One row, `id = 1`. */
export interface SearchStateTable {
  id: number;
  /** `building` | `ready`. */
  status: string;
  docs: number;
  job_id: string | null;
  built_at: EpochMs | null;
  /** The token format of the build that made it ready (search/tokenize.ts SEARCH_TOKEN_VERSION); 0029, NULL before. */
  token_version: number | null;
}

// 0025_catalog_runs_migration

/** Class data. */
export interface CatalogRunsTable {
  id: string;
  /** `import` | `export` | `migration` | `dedupe_scan`. */
  kind: string;
  /** `queued` | `running` | `succeeded` | `failed` | `cancelled`. */
  status: string;
  dry_run: Generated<Flag>;
  format: string | null;
  /** JSON, never a secret. */
  options: string;
  /** JSON counters. */
  summary: string;
  report_file_id: string | null;
  output_name: string | null;
  output_size: number | null;
  expires_at: EpochMs | null;
  job_id: string | null;
  created_at: EpochMs;
  created_by: string | null;
  finished_at: EpochMs | null;
}

/** Class data. */
export interface MigrationMapTable {
  /** `slims`, `import:<runId>`, ... (≤ 40). */
  source: string;
  /** The source table (≤ 32). */
  entity: string;
  legacy_key: string;
  target_id: string;
  run_id: string;
}

/** Class data. */
export interface MigrationArchiveTable {
  id: string;
  run_id: string;
  source: string;
  table_name: string;
  legacy_key: string;
  /** JSON. */
  row_json: string;
  created_at: EpochMs;
}

// ---------------------------------------------------------------------------------------------------------------
// ---- Komunitas K1 (tables) ----
// Migrations 0030–0032: report runs, accreditation and the library's registers. Every text column of a primary or
// unique key is key191() (binary), except usage_stats.source and usage_stats.metric (see 0031). Codes ALTIS writes from
// fixed lists are `string`; dates are `YYYY-MM-DD`; money is in the currency's minor unit.

// 0030_reports_core

/** Class volatile. One export of a report definition. */
export interface ReportRunsTable {
  id: string;
  /** The id of a report definition in the code (≤ 64). */
  report_id: string;
  /** `csv` | `xlsx` | `pdf` | `zip`. */
  format: string;
  /** The language the export is written in (`id` | `en`). */
  locale: string;
  /** JSON (≤ 8 000 bytes): the stored parameters. */
  params: string;
  /** 1 when the export holds personal data. */
  personal: Flag;
  /** `queued` | `running` | `succeeded` | `failed` | `cancelled`. */
  status: string;
  row_count: number | null;
  /** PDF rows marked as holding characters the PDF fonts cannot print. */
  non_latin_rows: number | null;
  /** The file under the reports export folder, once the run succeeded. */
  output_name: string | null;
  output_size: number | null;
  error_code: string | null;
  job_id: string | null;
  expires_at: EpochMs | null;
  created_at: EpochMs;
  created_by: string | null;
  finished_at: EpochMs | null;
}

// 0031_accreditation

/** Class data. One assessment period; global (`branch_id` stays null in this edition). */
export interface AccredPeriodsTable extends ArchivedTrail {
  id: string;
  branch_id: string | null;
  name: string;
  /** `school_year` | `calendar_year` | `rolling_12` | `custom`. */
  kind: string;
  starts_on: string;
  ends_on: string;
  instrument_id: string;
  /** `open` | `frozen`. */
  status: string;
  frozen_at: EpochMs | null;
  frozen_by: string | null;
  /** JSON (≤ 16 000 bytes): the institution's profile; some of its fields are personal data (PERSONAL_COLUMNS). */
  profile: string;
  students: number | null;
  teachers: number | null;
  edu_staff: number | null;
  classes: number | null;
  population_served: number | null;
  teachers_using: number | null;
  /** Default 0: the statement that every member of the school is registered as a library member. */
  all_registered_confirmed: Generated<Flag>;
  user_pcs: number | null;
  staff_pcs: number | null;
  ict_devices: number | null;
  scanners: number | null;
  floor_m2: number | null;
  bandwidth_mbps: number | null;
  hours_per_week: number | null;
  /** JSON list of service codes. */
  services: string | null;
  external_website_url: string | null;
}

/** Class data. `period_id` references accred_periods (ON DELETE CASCADE). */
export interface AccredAnswersTable {
  period_id: string;
  /** key191() (≤ 16 enforced by the code). */
  indicator_code: string;
  /** `a` | `b` | `c` | `d`. */
  answer: string;
  /** `manual` | `override`. */
  mode: string;
  /** Personal data (free text). */
  note: string | null;
  updated_at: EpochMs;
  updated_by: string | null;
}

/** Class volatile. A computed indicator value; `indicator_code` `_meta` holds the evaluation's state. No foreign key. */
export interface AccredResultsTable {
  period_id: string;
  /** key191() (≤ 16 enforced by the code). */
  indicator_code: string;
  /** JSON (≤ 16 000 bytes). */
  payload: string;
  computed_at: EpochMs;
}

/** Class data. A frozen copy of a period's results. `period_id` references accred_periods (ON DELETE CASCADE). */
export interface AccredSnapshotsTable {
  id: string;
  period_id: string;
  instrument_id: string;
  /** JSON (≤ 60 000 bytes): the compact frozen values. */
  result_values: string;
  /** The score as a decimal string; null while not every indicator is answered. */
  na: string | null;
  na_low: string;
  na_high: string;
  /** `A` | `B` | `C` | `D`. */
  grade: string | null;
  prerequisites_met: Flag;
  dossier_file_id: string | null;
  note: string | null;
  created_at: EpochMs;
  created_by: string | null;
}

/** Class data. An evidence file of a period's indicator or of a register row. No foreign key. */
export interface AccredEvidenceTable {
  id: string;
  period_id: string | null;
  indicator_code: string | null;
  evidence_code: string | null;
  /** The register table of `entity_id`: `library_activities` | `library_staff` | `staff_trainings` | … */
  entity: string | null;
  entity_id: string | null;
  file_id: string;
  caption: string;
  /** Default 0. */
  sort_order: Generated<number>;
  created_at: EpochMs;
  created_by: string | null;
}

/** Class data. One monthly usage cell. */
export interface UsageStatsTable {
  /** `manual` | `slims` (plain varchar, see 0031). */
  source: string;
  /** A usage metric code (plain varchar, see 0031). */
  metric: string;
  span_from: string;
  span_to: string;
  /** key191() (≤ 26): '' = every branch. */
  branch_key: string;
  /** key191() (≤ 48): '' = total, `grp:<group>`, `guest`, `slims_type:<id>`, `member_unknown`, `ddc:<class>`. */
  group_key: string;
  value: number;
  run_id: string | null;
  updated_at: EpochMs;
  updated_by: string | null;
}

/** Class data. How a source system's member type counts in the population groups. */
export interface UsageGroupMapTable {
  /** key191() (≤ 48): `slims_type:<id>` or `member_unknown`. */
  group_key: string;
  label: string;
  /** null: not counted. */
  accred_group: string | null;
  updated_at: EpochMs;
  updated_by: string | null;
}

// 0032_library_registers

/** Class data. */
export interface LibraryActivitiesTable extends ArchivedTrail {
  id: string;
  branch_id: string | null;
  /** `ACTIVITY_KINDS`. */
  kind: string;
  title: string;
  held_on: string;
  ended_on: string | null;
  participants: number | null;
  partner: string | null;
  /** Default 0. */
  uses_library_facility: Generated<Flag>;
  /** Default 0. */
  external_speaker: Generated<Flag>;
  description: string | null;
}

/** Class data. `name` and `appointment_ref` are personal data. */
export interface LibraryStaffTable extends ArchivedTrail {
  id: string;
  branch_id: string | null;
  staff_user_id: string | null;
  name: string;
  position: string | null;
  /** `head` | `librarian` | `ict` | `technical` | `other`. */
  role: string;
  /** Default 0. */
  is_librarian: Generated<Flag>;
  /** `civil_servant` | `contract` | `honorary` | `foundation` | `other`. */
  employment: string | null;
  /** `sma` | `d1` | `d2` | `d3` | `d4` | `s1` | `s2` | `s3` | `other`. */
  education_level: string | null;
  education_library: Flag;
  library_training: Flag;
  competency_cert: Flag;
  association_member: Flag;
  appointment_ref: string | null;
  starts_on: string | null;
  ends_on: string | null;
}

/** Class data. `library_staff_id` references library_staff (ON DELETE CASCADE). */
export interface StaffTrainingsTable extends ArchivedTrail {
  id: string;
  library_staff_id: string;
  title: string;
  organizer: string | null;
  held_on: string;
  hours: number | null;
  certificate_file_id: string | null;
}

/** Class data. */
export interface LibraryPartnershipsTable extends ArchivedTrail {
  id: string;
  branch_id: string | null;
  partner: string;
  /** `mou` | `pks` | `other`. */
  kind: string;
  starts_on: string;
  ends_on: string | null;
  scope: string | null;
  document_file_id: string | null;
}

/** Class data. UNIQUE (scope_key, year); an archived year's `scope_key` is `~<id>`. */
export interface LibraryBudgetsTable extends ArchivedTrail {
  id: string;
  /** key191() (≤ 32): '' = the whole library. */
  scope_key: string;
  branch_id: string | null;
  year: number;
  library_minor: number;
  parent_minor: number | null;
  /** The parent institution's budget without staff, maintenance and building upkeep. */
  parent_nonpersonnel_minor: number | null;
  collection_minor: number | null;
  community_minor: number | null;
  currency: string;
  note: string | null;
}

/** Class data. */
export interface LibraryDocumentsTable extends ArchivedTrail {
  id: string;
  branch_id: string | null;
  /** `DOCUMENT_KINDS`. */
  kind: string;
  title: string;
  reference: string | null;
  issued_on: string | null;
  issued_by: string | null;
  /** JSON list of aspect codes. */
  aspect_codes: string | null;
  valid_until: string | null;
  file_id: string | null;
}

// ---------------------------------------------------------------------------------------------------------------
// The runner's tables (class migrator): made by ensureBootstrap (ddl.ts) and migrator.ts, never by a migration.

export interface SchemaTablesTable {
  name: string;
  class: string;
  created_by: string;
}

/** One row, `id = 1`. */
export interface SchemaMetaTable {
  id: number;
  schema_version: string;
  min_code_version: string;
  install_id: string | null;
}

/** Kysely's Migrator: `timestamp` is an ISO 8601 string. */
export interface SchemaMigrationsTable {
  name: string;
  timestamp: string;
}

export interface SchemaMigrationsLockTable {
  id: string;
  is_locked: Generated<number>;
}

// ---------------------------------------------------------------------------------------------------------------

/** Every table of the database. TABLE_CLASSES (registry.ts) classifies exactly these. */
export interface DB {
  locks: LocksTable;
  branches: BranchesTable;
  staff_users: StaffUsersTable;
  staff_recovery_codes: StaffRecoveryCodesTable;
  roles: RolesTable;
  role_permissions: RolePermissionsTable;
  user_roles: UserRolesTable;
  sessions: SessionsTable;
  remember_tokens: RememberTokensTable;
  password_resets: PasswordResetsTable;
  rate_limits: RateLimitsTable;
  settings: SettingsTable;
  audit_log: AuditLogTable;
  audit_head: AuditHeadTable;
  jobs: JobsTable;
  schedules: SchedulesTable;
  events: EventsTable;
  event_consumers: EventConsumersTable;
  notifications: NotificationsTable;
  notification_reads: NotificationReadsTable;
  files: FilesTable;
  upload_sessions: UploadSessionsTable;
  custom_field_defs: CustomFieldDefsTable;
  custom_values: CustomValuesTable;
  idempotency_keys: IdempotencyKeysTable;
  license_state: LicenseStateTable;
  releases_log: ReleasesLogTable;
  backups: BackupsTable;
  schema_tables: SchemaTablesTable;
  schema_meta: SchemaMetaTable;
  schema_migrations: SchemaMigrationsTable;
  schema_migrations_lock: SchemaMigrationsLockTable;
  // ---- Phase 2 (catalog): Task 1 ----
  languages: LanguagesTable;
  material_types: MaterialTypesTable;
  publishers: PublishersTable;
  agents: AgentsTable;
  subjects: SubjectsTable;
  subject_relations: SubjectRelationsTable;
  records: RecordsTable;
  record_identifiers: RecordIdentifiersTable;
  record_marc_extra: RecordMarcExtraTable;
  record_agents: RecordAgentsTable;
  record_subjects: RecordSubjectsTable;
  record_relations: RecordRelationsTable;
  attachments: AttachmentsTable;
  locations: LocationsTable;
  collection_types: CollectionTypesTable;
  suppliers: SuppliersTable;
  items: ItemsTable;
  item_events: ItemEventsTable;
  pages: PagesTable;
  page_translations: PageTranslationsTable;
  search_doc: SearchDocTable;
  search_facet: SearchFacetTable;
  search_term: SearchTermTable;
  search_state: SearchStateTable;
  catalog_runs: CatalogRunsTable;
  migration_map: MigrationMapTable;
  migration_archive: MigrationArchiveTable;
  // ---- Komunitas K1 (tables) ----
  report_runs: ReportRunsTable;
  accred_periods: AccredPeriodsTable;
  accred_answers: AccredAnswersTable;
  accred_results: AccredResultsTable;
  accred_snapshots: AccredSnapshotsTable;
  accred_evidence: AccredEvidenceTable;
  usage_stats: UsageStatsTable;
  usage_group_map: UsageGroupMapTable;
  library_activities: LibraryActivitiesTable;
  library_staff: LibraryStaffTable;
  staff_trainings: StaffTrainingsTable;
  library_partnerships: LibraryPartnershipsTable;
  library_budgets: LibraryBudgetsTable;
  library_documents: LibraryDocumentsTable;
}
