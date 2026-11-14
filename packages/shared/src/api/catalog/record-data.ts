/**
 * The two shapes of a bibliographic record that travel between the catalog's parts (Phase 2, plan Task 4):
 *
 * - {@link RecordDraft}: what every importer produces before anything is stored (MARC and MARCXML, the CSV codecs, an
 *   SRU or ISBN lookup, the SLiMS migration). Masters and authorities are named by code or by name, never by id.
 * - {@link RecordData}: the denormalised view of a stored record that the records service loads (`loadRecordData`) for
 *   the renderers, the exporters, the OPAC detail and OAI-PMH.
 *
 * No Node built-ins here: the browser bundles this module. Import it as `@altis/shared/api/catalog/record-data`.
 */
import { z } from 'zod';
import {
  AGENT_TYPES,
  IDENTIFIER_TYPES,
  RELATOR_ROLES,
  SUBJECT_TYPES,
  type AttachmentAccess,
  type AttachmentKind,
  type ItemStatus,
  type RelationType,
} from '../../catalog-vocab.js';
import { AUDIENCES, LOCAL_WORKS, LOCAL_WORK_KINDS, REFERENCE_KINDS } from '../../accreditation-vocab.js';
import { codeField, customValuesField, lineText, longText, multilineSafe, shortText, URL_MAX, yearField } from './common.js';

/** At most this many entries of each list in a draft or a record body (the create body's bounds). */
export const RECORD_LIST_MAX = Object.freeze({
  identifiers: 50,
  agents: 100,
  subjects: 200,
  relations: 100,
  links: 50,
  marcExtra: 500,
});

/** The most items one draft can carry (952/852 fields of one MARC record, rows of one CSV record). */
export const DRAFT_ITEMS_MAX = 10_000;

/** A MARC field ALTIS does not map, kept to be exported again (`record_marc_extra`); `LDR` is the original leader. */
export const MarcExtraField = z.strictObject({
  tag: z.string().regex(/^(LDR|\d{3})$/),
  /** One character; a space for a control field or the leader. */
  ind1: z.string().regex(/^[\x20-\x7E]$/),
  ind2: z.string().regex(/^[\x20-\x7E]$/),
  /** A control field's content, or the JSON `[[code, value], …]` of a data field's subfields. */
  data: z.string().max(9999).check(multilineSafe()),
});

export type MarcExtraField = z.infer<typeof MarcExtraField>;

/** A record's title, subtitle or statement of responsibility (TEXT columns, one line each). */
export const titleText = lineText;

/** An RDA content, media or carrier code as a record stores it (VARCHAR 8; the official lists are in the vocabulary). */
export const rdaCodeField = z.string().regex(/^[a-z]{1,8}$/);

/** An identifier as written (`value_display`, VARCHAR 64) with its qualifier ("jil. 2"). */
export const IdentifierInput = z.strictObject({
  type: z.enum(IDENTIFIER_TYPES),
  value: shortText(64).min(1),
  qualifier: shortText(64).nullable().optional(),
});

export type IdentifierInput = z.infer<typeof IdentifierInput>;

/** A link of a draft (MARC 856 `$u $y`, a CSV or SRU URL): stored as a public URL attachment when it is http(s) (S4). */
export const LinkInput = z.strictObject({
  url: z.string().trim().min(1).max(URL_MAX),
  title: shortText(191).optional(),
});

export type LinkInput = z.infer<typeof LinkInput>;

const draftAgent = z.strictObject({
  type: z.enum(AGENT_TYPES),
  name: shortText(191).min(1),
  dates: shortText(64).optional(),
  role: z.enum(RELATOR_ROLES),
  isMain: z.boolean(),
  authoritySource: shortText(64).optional(),
});

const draftSubject = z.strictObject({
  type: z.enum(SUBJECT_TYPES),
  term: shortText(191).min(1),
  classification: shortText(64).optional(),
  authoritySource: shortText(64).optional(),
  isPrimary: z.boolean(),
});

const draftItem = z.strictObject({
  /** As read; the importer normalises it (spec §3.4) and checks it before creating the item. */
  barcode: z.string().min(1).max(200),
  locationCode: codeField.optional(),
  callNumber: shortText(64).optional(),
  collectionTypeCode: codeField.optional(),
  branchCode: codeField.optional(),
});

/**
 * The accreditation fields of a record (`records.audience`, `local_work`, `local_work_kind`, `reference_kind`): each a
 * value of its vocabulary, null to clear, absent to leave as it is. Shared by the draft, the create and patch bodies
 * and the bulk change.
 */
export const recordAccredFields = {
  audience: z.enum(AUDIENCES).nullable().optional(),
  localWork: z.enum(LOCAL_WORKS).nullable().optional(),
  localWorkKind: z.enum(LOCAL_WORK_KINDS).nullable().optional(),
  referenceKind: z.enum(REFERENCE_KINDS).nullable().optional(),
};

/**
 * A record as an importer reads it (MARC, MARCXML, CSV, SRU, the SLiMS migration), before it is stored. The fields
 * are the record's columns (§2.2) under their API names; masters by code, authorities by name. Strict at every depth.
 */
export const RecordDraft = z.strictObject({
  /** The material type's code, or null for the default one (`catalog.defaultMaterialTypeId`). */
  materialTypeCode: codeField.nullable(),
  title: titleText.min(1),
  subtitle: titleText.optional(),
  responsibility: titleText.optional(),
  edition: shortText(191).optional(),
  materialDetail: shortText(191).optional(),
  publisher: z.strictObject({ name: shortText(191).min(1), place: shortText(191).optional() }).nullable(),
  publicationPlace: shortText(191).optional(),
  publicationYear: yearField.optional(),
  /** The date as written ("c1998", "[2005?]"); `publicationYear` is its first plausible year. */
  publicationDateText: shortText(64).optional(),
  physicalDesc: shortText(191).optional(),
  series: shortText(191).optional(),
  classification: shortText(64).optional(),
  callNumber: shortText(64).optional(),
  /** A MARC language code (`languages.code`). */
  languageCode: codeField.optional(),
  contentType: rdaCodeField.optional(),
  mediaType: rdaCodeField.optional(),
  carrierType: rdaCodeField.optional(),
  summary: longText.optional(),
  notes: longText.optional(),
  identifiers: z.array(IdentifierInput).max(RECORD_LIST_MAX.identifiers),
  agents: z.array(draftAgent).max(RECORD_LIST_MAX.agents),
  subjects: z.array(draftSubject).max(RECORD_LIST_MAX.subjects),
  links: z.array(LinkInput).max(RECORD_LIST_MAX.links),
  items: z.array(draftItem).max(DRAFT_ITEMS_MAX),
  marcExtra: z.array(MarcExtraField).max(RECORD_LIST_MAX.marcExtra),
  /** Custom values by code, as read (CSV strings stay strings until `coerceCustomValues`, S19). */
  custom: customValuesField.optional(),
  // ---- Komunitas K1 (catalogue accreditation fields) ----
  // Who the record is meant for, who made a local work and its kind, the kind of a reference work; all optional, so a
  // draft from an older importer stays valid.
  ...recordAccredFields,
});

export type RecordDraft = z.infer<typeof RecordDraft>;

/** A draft agent, subject or item. */
export type DraftAgent = RecordDraft['agents'][number];
export type DraftSubject = RecordDraft['subjects'][number];
export type DraftItem = RecordDraft['items'][number];

/**
 * A stored record, denormalised (`loadRecordData`): the {@link RecordDraft} fields plus its identity, state, masters,
 * authorities with their ids, attachments, relations, items and public custom values.
 *
 * - `links` are the record's URL attachments the load may show (public ones only with `publicOnly`), as `{url, title}`;
 *   `attachments` lists them too, with the files.
 * - `custom` holds every custom value by code on a staff load and is absent with `publicOnly`; `customPublic` lists the
 *   values of the `is_public` fields with their labels.
 * - Acquisition data (prices, suppliers, order and invoice numbers) is never part of it.
 */
export interface RecordData extends Omit<RecordDraft, 'publisher' | 'agents' | 'subjects' | 'items'> {
  id: string;
  createdAt: number;
  updatedAt: number;
  /** The last change of the record's public representation (OAI datestamp, sitemap `lastmod`, RSS). */
  changedAt: number;
  opacVisible: boolean;
  promoted: boolean;
  archived: boolean;
  /** The live record this one was merged into (one hop, P2-20), or null. */
  mergedInto: string | null;
  materialType: {
    id: string;
    code: string;
    nameId: string;
    nameEn: string;
    /** Leader/06 and /07. */
    marcType: string;
    marcLevel: string;
    /** The schema.org type (`Book`) and the DCMI type (`Text`). */
    schemaType: string;
    dcmiType: string;
  };
  language: { code: string; nameId: string; nameEn: string } | null;
  publisher: { id: string; name: string; place?: string } | null;
  agents: (RecordDraft['agents'][number] & { id: string })[];
  subjects: (RecordDraft['subjects'][number] & { id: string })[];
  coverFileId: string | null;
  attachments: { id: string; kind: AttachmentKind; fileId: string | null; url: string | null; title: string; access: AttachmentAccess; mime: string | null }[];
  /** Both directions (§3.1): `out` = stored on this record, `in` = stored on the other one. */
  relations: { type: RelationType; direction: 'out' | 'in'; recordId: string; title: string }[];
  items: {
    id: string;
    barcode: string;
    branchId: string;
    branchCode: string;
    locationId: string | null;
    /** The location's code (B3), so `recordToMarc` can write 852 `$c`. */
    locationCode: string | null;
    /** The item's own call number, or null when it follows the record's. */
    callNumber: string | null;
    status: ItemStatus;
    collectionTypeCode: string;
    /** §2.5: `available` and the collection type is loanable; self-service when also `self_service`. */
    loanable: boolean;
    selfService: boolean;
  }[];
  customPublic: { code: string; labelId: string; labelEn: string | null; value: unknown }[];
}
