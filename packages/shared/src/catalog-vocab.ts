/**
 * The fixed vocabularies of the catalog (Phase 2 spec §2.5, §2.2, §3.8, §4.6, §5, §8, §9.5): lists that live in code,
 * not in tables. Each list is frozen `as const` with its own type; the server, the admin SPA and the OPAC read them
 * from here, so a status, a relator code or a facet is spelled one way everywhere.
 *
 * Labels: every list of {@link VOCAB_LISTS} has a shared message per value, `vocab.<list>.<value>` (Indonesian first,
 * English complete; `i18n/id.ts` checks at compile time that none is missing). The RDA lists carry their official
 * English terms instead: RDA terms and MARC tags are shown as they are in both languages (decision D2-06).
 *
 * No Node built-ins here: the browser bundles this package.
 */

import { ACCREDITATION_VOCAB_LISTS } from './accreditation-vocab.js';
import { CIRCULATION_VOCAB_LISTS } from './circulation-vocab.js';

const hasOwn = (o: object, key: string): boolean => Object.prototype.hasOwnProperty.call(o, key);

// ---- items (§2.5) --------------------------------------------------------------------------------------------------

/** The statuses of an item. Circulation states (on loan, on hold, in transit) are not item statuses (Phase 3). */
export const ITEM_STATUSES = Object.freeze([
  'on_order',
  'processing',
  'available',
  'not_for_loan',
  'repair',
  'missing',
  'lost',
  'withdrawn',
] as const);

export type ItemStatus = (typeof ITEM_STATUSES)[number];

/**
 * The legal status changes, verbatim from the §2.5 table: `ITEM_TRANSITIONS[from]` lists the statuses `from` may move
 * to. Anything else is 409 `ITEM_STATUS_TRANSITION`. `withdrawn → processing` also clears `archived_at` (the service's
 * part); archiving an item is `withdrawn` + `archived_at`.
 */
export const ITEM_TRANSITIONS: Readonly<Record<ItemStatus, readonly ItemStatus[]>> = Object.freeze({
  on_order: Object.freeze(['processing', 'available', 'withdrawn'] as const),
  processing: Object.freeze(['available', 'not_for_loan', 'withdrawn'] as const),
  available: Object.freeze(['not_for_loan', 'repair', 'missing', 'withdrawn'] as const),
  not_for_loan: Object.freeze(['available', 'repair', 'missing', 'withdrawn'] as const),
  repair: Object.freeze(['available', 'not_for_loan', 'withdrawn'] as const),
  missing: Object.freeze(['available', 'not_for_loan', 'lost'] as const),
  lost: Object.freeze(['available', 'withdrawn'] as const),
  withdrawn: Object.freeze(['processing'] as const),
});

/** True when an item of status `from` may move to `to`. Staying in the same status is not a transition (false). */
export function canTransition(from: ItemStatus, to: ItemStatus): boolean {
  // Own properties only: a status read from a request is never looked up on the prototype (`__proto__`, `toString`).
  if (!hasOwn(ITEM_TRANSITIONS, from)) return false;
  return (ITEM_TRANSITIONS[from] as readonly string[]).includes(to);
}

/** The kinds of `item_events` rows (§2.2): the item's history. */
export const ITEM_EVENT_TYPES = Object.freeze(['created', 'updated', 'status', 'moved', 'archived', 'imported', 'migrated'] as const);

export type ItemEventType = (typeof ITEM_EVENT_TYPES)[number];

// ---- records (§2.2, §3.8) ------------------------------------------------------------------------------------------

/**
 * The record fields a material type's template can hide or require (§3.8), in the spec's fixed order. `title` is
 * always required and is not among them; `rda` covers the three RDA codes, `publisher` the publisher and its place.
 */
export const RECORD_FIELD_NAMES = Object.freeze([
  'subtitle',
  'responsibility',
  'edition',
  'material_detail',
  'publisher',
  'publication_place',
  'publication_year',
  'physical_desc',
  'series',
  'classification',
  'call_number',
  'language',
  'rda',
  'summary',
  'notes',
  'identifiers',
  'agents',
  'subjects',
] as const);

export type RecordFieldName = (typeof RECORD_FIELD_NAMES)[number];

/** How a template shows a field (§3.8); a field the template does not name is `optional`. */
export const FIELD_STATES = Object.freeze(['hidden', 'optional', 'required'] as const);

export type FieldState = (typeof FIELD_STATES)[number];

/** The roles of an agent on a record: MARC relator codes (§2.2 `record_agents.role`). */
export const RELATOR_ROLES = Object.freeze(['aut', 'edt', 'trl', 'ill', 'cmp', 'drt', 'pro', 'cre', 'ctb'] as const);

export type RelatorRole = (typeof RELATOR_ROLES)[number];

/** The kinds of `record_identifiers` (§2.2, §3.2): `control` is the `<003>:<001>` of an imported record. */
export const IDENTIFIER_TYPES = Object.freeze(['isbn', 'issn', 'doi', 'control', 'other'] as const);

export type IdentifierType = (typeof IDENTIFIER_TYPES)[number];

/** The kinds of `record_relations` (§2.2), stored one way and shown both ways (§3.1). */
export const RELATION_TYPES = Object.freeze(['related', 'other_edition', 'part_of', 'translation_of'] as const);

export type RelationType = (typeof RELATION_TYPES)[number];

// ---- authorities (§2.2, §2.5, §3.5) -------------------------------------------------------------------------------

/** The kinds of `agents` (MARC 100/110/111 and 700/710/711). */
export const AGENT_TYPES = Object.freeze(['person', 'organization', 'meeting'] as const);

export type AgentType = (typeof AGENT_TYPES)[number];

/** The kinds of `subjects` (§2.2). */
export const SUBJECT_TYPES = Object.freeze(['topic', 'geographic', 'name', 'temporal', 'genre', 'occupation'] as const);

export type SubjectType = (typeof SUBJECT_TYPES)[number];

/** The MARC tag a subject of each type is exported under (§2.5; on import 610/611 also become `name`). */
export const SUBJECT_EXPORT_TAG: Readonly<Record<SubjectType, string>> = Object.freeze({
  name: '600',
  topic: '650',
  geographic: '651',
  temporal: '648',
  genre: '655',
  occupation: '656',
});

/** The thesaurus relations between subjects (§3.5): use / used for, broader / narrower, related, see also. */
export const THESAURUS_RELS = Object.freeze(['use', 'uf', 'bt', 'nt', 'rt', 'sa'] as const);

export type ThesaurusRel = (typeof THESAURUS_RELS)[number];

/** The relation written back in the same transaction when one is added or removed (§3.5): `use↔uf`, `bt↔nt`, ... */
export const THESAURUS_RECIPROCAL: Readonly<Record<ThesaurusRel, ThesaurusRel>> = Object.freeze({
  use: 'uf',
  uf: 'use',
  bt: 'nt',
  nt: 'bt',
  rt: 'rt',
  sa: 'sa',
});

// ---- items and masters (§2.2, §3.6, §3.7) -------------------------------------------------------------------------

/** The levels of a location, outermost first (§3.6: room › area › shelf, depth ≤ 3). */
export const LOCATION_KINDS = Object.freeze(['room', 'area', 'shelf'] as const);

export type LocationKind = (typeof LOCATION_KINDS)[number];

/** How an item was acquired (`items.acq_source`). */
export const ACQ_SOURCES = Object.freeze(['purchase', 'gift', 'exchange', 'deposit', 'other'] as const);

export type AcqSource = (typeof ACQ_SOURCES)[number];

/** The value types of a custom field (§2.2 `custom_field_defs.type`). */
export const CUSTOM_FIELD_TYPES = Object.freeze(['text', 'longtext', 'number', 'date', 'select', 'multiselect', 'boolean', 'url'] as const);

export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

/** The entities a custom field can extend in Phase 2 (§2.2 `custom_field_defs.entity`). */
export const CUSTOM_FIELD_ENTITIES = Object.freeze(['records', 'items'] as const);

export type CustomFieldEntity = (typeof CUSTOM_FIELD_ENTITIES)[number];

// ---- attachments (§2.2, §4.6, §8) ---------------------------------------------------------------------------------

/** An attachment is a stored file or an outside link. */
export const ATTACHMENT_KINDS = Object.freeze(['file', 'url'] as const);

export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

/** Who may open an attachment: everyone (the OPAC) or staff only. */
export const ATTACHMENT_ACCESS = Object.freeze(['public', 'staff'] as const);

export type AttachmentAccess = (typeof ATTACHMENT_ACCESS)[number];

/** The media families of public attachments: the values of the `at` facet and of `/cari?lampiran=` (§4.6). */
export const ATTACHMENT_MEDIA = Object.freeze(['pdf', 'audio', 'video', 'image', 'url', 'other'] as const);

export type AttachmentMedia = (typeof ATTACHMENT_MEDIA)[number];

// ---- search (§4.6) -------------------------------------------------------------------------------------------------

/**
 * The facets of `search_facet.facet`: material type, language, collection type, branch, location (room), available
 * (`1`), public attachment media, subject, and `cl`, the first digit of the classification (M4).
 */
export const FACETS = Object.freeze(['mt', 'lg', 'ct', 'br', 'lc', 'av', 'at', 'sb', 'cl'] as const);

export type FacetName = (typeof FACETS)[number];

// ---- RDA 336/337/338 (§2.2, §2.5) ---------------------------------------------------------------------------------

/** One entry of an RDA term-and-code list: the MARC `$b` code and the official English term (`$a`). */
export interface RdaTerm {
  readonly code: string;
  readonly term: string;
}

const rda = <const T extends readonly RdaTerm[]>(list: T): T => Object.freeze(list.map((e) => Object.freeze(e))) as unknown as T;

/** RDA content types (MARC 336), the official term and code list. */
export const RDA_CONTENT_TYPES = rda([
  { code: 'crd', term: 'cartographic dataset' },
  { code: 'cri', term: 'cartographic image' },
  { code: 'crm', term: 'cartographic moving image' },
  { code: 'crt', term: 'cartographic tactile image' },
  { code: 'crn', term: 'cartographic tactile three-dimensional form' },
  { code: 'crf', term: 'cartographic three-dimensional form' },
  { code: 'cod', term: 'computer dataset' },
  { code: 'cop', term: 'computer program' },
  { code: 'ntv', term: 'notated movement' },
  { code: 'ntm', term: 'notated music' },
  { code: 'prm', term: 'performed music' },
  { code: 'snd', term: 'sounds' },
  { code: 'spw', term: 'spoken word' },
  { code: 'sti', term: 'still image' },
  { code: 'tci', term: 'tactile image' },
  { code: 'tcn', term: 'tactile notated movement' },
  { code: 'tcm', term: 'tactile notated music' },
  { code: 'tct', term: 'tactile text' },
  { code: 'tcf', term: 'tactile three-dimensional form' },
  { code: 'txt', term: 'text' },
  { code: 'tdf', term: 'three-dimensional form' },
  { code: 'tdm', term: 'three-dimensional moving image' },
  { code: 'tdi', term: 'two-dimensional moving image' },
  { code: 'xxx', term: 'other' },
  { code: 'zzz', term: 'unspecified' },
] as const);

/** RDA media types (MARC 337), the official term and code list. */
export const RDA_MEDIA_TYPES = rda([
  { code: 's', term: 'audio' },
  { code: 'c', term: 'computer' },
  { code: 'h', term: 'microform' },
  { code: 'p', term: 'microscopic' },
  { code: 'g', term: 'projected' },
  { code: 'e', term: 'stereographic' },
  { code: 'n', term: 'unmediated' },
  { code: 'v', term: 'video' },
  { code: 'x', term: 'other' },
  { code: 'z', term: 'unspecified' },
] as const);

/** RDA carrier types (MARC 338), the official term and code list, grouped by media type. */
export const RDA_CARRIER_TYPES = rda([
  // audio
  { code: 'sg', term: 'audio cartridge' },
  { code: 'sb', term: 'audio belt' },
  { code: 'se', term: 'audio cylinder' },
  { code: 'sd', term: 'audio disc' },
  { code: 'si', term: 'sound track reel' },
  { code: 'sq', term: 'audio roll' },
  { code: 'sw', term: 'audio wire reel' },
  { code: 'ss', term: 'audiocassette' },
  { code: 'st', term: 'audiotape reel' },
  { code: 'sz', term: 'other audio carrier' },
  // computer
  { code: 'ck', term: 'computer card' },
  { code: 'cb', term: 'computer chip cartridge' },
  { code: 'cd', term: 'computer disc' },
  { code: 'ce', term: 'computer disc cartridge' },
  { code: 'ca', term: 'computer tape cartridge' },
  { code: 'cf', term: 'computer tape cassette' },
  { code: 'ch', term: 'computer tape reel' },
  { code: 'cr', term: 'online resource' },
  { code: 'cz', term: 'other computer carrier' },
  // microform
  { code: 'ha', term: 'aperture card' },
  { code: 'he', term: 'microfiche' },
  { code: 'hf', term: 'microfiche cassette' },
  { code: 'hb', term: 'microfilm cartridge' },
  { code: 'hc', term: 'microfilm cassette' },
  { code: 'hd', term: 'microfilm reel' },
  { code: 'hj', term: 'microfilm roll' },
  { code: 'hh', term: 'microfilm slip' },
  { code: 'hg', term: 'microopaque' },
  { code: 'hz', term: 'other microform carrier' },
  // microscopic
  { code: 'pp', term: 'microscope slide' },
  { code: 'pz', term: 'other microscopic carrier' },
  // projected image
  { code: 'mc', term: 'film cartridge' },
  { code: 'mf', term: 'film cassette' },
  { code: 'mr', term: 'film reel' },
  { code: 'mo', term: 'film roll' },
  { code: 'gd', term: 'filmslip' },
  { code: 'gf', term: 'filmstrip' },
  { code: 'gc', term: 'filmstrip cartridge' },
  { code: 'gt', term: 'overhead transparency' },
  { code: 'gs', term: 'slide' },
  { code: 'mz', term: 'other projected image carrier' },
  // stereographic
  { code: 'eh', term: 'stereograph card' },
  { code: 'es', term: 'stereograph disc' },
  { code: 'ez', term: 'other stereographic carrier' },
  // unmediated
  { code: 'no', term: 'card' },
  { code: 'nn', term: 'flipchart' },
  { code: 'na', term: 'roll' },
  { code: 'nb', term: 'sheet' },
  { code: 'nc', term: 'volume' },
  { code: 'nr', term: 'object' },
  { code: 'nz', term: 'other unmediated carrier' },
  // video
  { code: 'vc', term: 'video cartridge' },
  { code: 'vf', term: 'videocassette' },
  { code: 'vd', term: 'videodisc' },
  { code: 'vr', term: 'videotape reel' },
  { code: 'vz', term: 'other video carrier' },
  // unspecified
  { code: 'zu', term: 'unspecified' },
] as const);

export type RdaContentCode = (typeof RDA_CONTENT_TYPES)[number]['code'];
export type RdaMediaCode = (typeof RDA_MEDIA_TYPES)[number]['code'];
export type RdaCarrierCode = (typeof RDA_CARRIER_TYPES)[number]['code'];

/** The codes of each RDA list, in list order (for `z.enum` and selects). */
export const RDA_CONTENT_CODES = Object.freeze(RDA_CONTENT_TYPES.map((e) => e.code)) as readonly RdaContentCode[];
export const RDA_MEDIA_CODES = Object.freeze(RDA_MEDIA_TYPES.map((e) => e.code)) as readonly RdaMediaCode[];
export const RDA_CARRIER_CODES = Object.freeze(RDA_CARRIER_TYPES.map((e) => e.code)) as readonly RdaCarrierCode[];

// ---- exchange and runs (§2.2 catalog_runs, §5) --------------------------------------------------------------------

/** The import formats (§5.3); an import without a format detects it. */
export const IMPORT_FORMATS = Object.freeze(['marc21', 'marcxml', 'csv-records', 'csv-items', 'csv-slims', 'csv-slims-items'] as const);

export type ImportFormat = (typeof IMPORT_FORMATS)[number];

/** The export formats (§5.1, §5.2, §5.4); `marcjson` is MARC-in-JSON as JSON Lines. */
export const EXPORT_FORMATS = Object.freeze(['marc21', 'marcxml', 'marcjson', 'csv-records', 'csv-items'] as const);

export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** The kinds of `catalog_runs`. */
export const RUN_KINDS = Object.freeze([
  'import',
  'export',
  'migration',
  'dedupe_scan',
  // ---- Komunitas K1 (runs) ----
  // The read-only import of SLiMS usage statistics into an accreditation period.
  'slims_usage',
  // ---- Komunitas (members and circulation) ----
  // The CSV import of members.
  'member_import',
] as const);

export type RunKind = (typeof RUN_KINDS)[number];

/** The statuses of `catalog_runs`. */
export const RUN_STATUSES = Object.freeze(['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const);

export type RunStatus = (typeof RUN_STATUSES)[number];

// ---- pages (§2.2 pages, §9.5) -------------------------------------------------------------------------------------

/** Halaman (static page) and Berita (news post). */
export const PAGE_KINDS = Object.freeze(['page', 'news'] as const);

export type PageKind = (typeof PAGE_KINDS)[number];

/** A page is a draft or published; a published page with a future `published_at` is scheduled. */
export const PAGE_STATUSES = Object.freeze(['draft', 'published'] as const);

export type PageStatus = (typeof PAGE_STATUSES)[number];

/** The languages of a page's translations: `id` is required, `en` optional (§9.5). */
export const PAGE_LOCALES = Object.freeze(['id', 'en'] as const);

export type PageLocale = (typeof PAGE_LOCALES)[number];

/** How a page body is written: the Markdown subset, or HTML (migrated pages); both are rendered sanitized. */
export const BODY_FORMATS = Object.freeze(['markdown', 'html'] as const);

export type BodyFormat = (typeof BODY_FORMATS)[number];

// ---- labels --------------------------------------------------------------------------------------------------------

/**
 * Every list with shared labels, by the `<list>` of its message keys `vocab.<list>.<value>` (the record field names are
 * `vocab.field.<name>`). The RDA lists are not here: their terms are shown as they are.
 */
export const VOCAB_LISTS = Object.freeze({
  item_status: ITEM_STATUSES,
  item_event: ITEM_EVENT_TYPES,
  field: RECORD_FIELD_NAMES,
  field_state: FIELD_STATES,
  relator: RELATOR_ROLES,
  identifier_type: IDENTIFIER_TYPES,
  relation_type: RELATION_TYPES,
  agent_type: AGENT_TYPES,
  subject_type: SUBJECT_TYPES,
  thesaurus_rel: THESAURUS_RELS,
  location_kind: LOCATION_KINDS,
  acq_source: ACQ_SOURCES,
  custom_field_type: CUSTOM_FIELD_TYPES,
  custom_field_entity: CUSTOM_FIELD_ENTITIES,
  attachment_kind: ATTACHMENT_KINDS,
  attachment_access: ATTACHMENT_ACCESS,
  attachment_media: ATTACHMENT_MEDIA,
  facet: FACETS,
  import_format: IMPORT_FORMATS,
  export_format: EXPORT_FORMATS,
  run_kind: RUN_KINDS,
  run_status: RUN_STATUSES,
  page_kind: PAGE_KINDS,
  page_status: PAGE_STATUSES,
  page_locale: PAGE_LOCALES,
  body_format: BODY_FORMATS,
  // ---- Komunitas K1 (vocabularies) ----
  ...ACCREDITATION_VOCAB_LISTS,
  // ---- Komunitas (members and circulation) ----
  ...CIRCULATION_VOCAB_LISTS,
});

export type VocabList = keyof typeof VOCAB_LISTS;

/** A value of the list `L`. */
export type VocabValue<L extends VocabList> = (typeof VOCAB_LISTS)[L][number];

/** Every `vocab.<list>.<value>` message key (`i18n/id.ts` fails to compile when one has no message). */
export type VocabMessageKey = { [L in VocabList]: `vocab.${L}.${VocabValue<L>}` }[VocabList];

/** The message key of `value` in `list`: `vocabKey('item_status', 'on_order')` → `'vocab.item_status.on_order'`. */
export function vocabKey<L extends VocabList>(list: L, value: VocabValue<L>): `vocab.${L}.${VocabValue<L>}` {
  return `vocab.${list}.${value}` as `vocab.${L}.${VocabValue<L>}`;
}
