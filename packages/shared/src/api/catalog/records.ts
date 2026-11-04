/**
 * The records API vocabulary (Phase 2 spec §3.1-§3.3, §3.7, §3.8, §12.2; plan Tasks 4, 16, 24): the list, the create
 * and patch bodies, the detail, merge, cover and the live duplicate check.
 *
 * - A body names masters by id and authorities by reference: `{id}` of an existing one, or the fields of one to find or
 *   create by its key (decision P2-10: no audit entry of its own).
 * - The `store` routes answer `StoreResponse` (`./common.ts`), never the detail (S15); screens read it again with GET.
 *
 * No Node built-ins here: the browser bundles this module. Import it as `@altis/shared/api/catalog/records`.
 */
import { z } from 'zod';
import { AGENT_TYPES, RELATION_TYPES, RELATOR_ROLES, SUBJECT_TYPES } from '../../catalog-vocab.js';
import { ulidField, versionField } from '../common.js';
import { customValuesField, cursorQuery, epochMsQuery, longText, shortText, yearField } from './common.js';
import { IdentifierInput, LinkInput, MarcExtraField, RECORD_LIST_MAX, rdaCodeField, titleText, type RecordData } from './record-data.js';

// ---- the list ------------------------------------------------------------------------------------------------------

/** How the admin list is ordered: relevance needs `q`; `newest` reads the search index newest first (S14). */
export const RECORD_SORTS = Object.freeze(['relevance', 'newest', 'title', 'changed'] as const);

export type RecordSort = (typeof RECORD_SORTS)[number];

/**
 * `GET catalog/records`. `q` takes the search syntax of §4.4. `hidden`: only records hidden from the OPAC, or none of
 * them. `changedFrom`/`changedTo` bound `changed_at` (epoch ms). Relevance pages by `page` (≤ 50, §4.5); the time and
 * title orders page by `cursor`.
 */
export const RecordListQuery = z.strictObject({
  q: shortText(500).optional(),
  materialTypeId: ulidField.optional(),
  hidden: z.enum(['only', 'exclude']).optional(),
  archived: z.stringbool().optional(),
  hasItems: z.stringbool().optional(),
  changedFrom: epochMsQuery.optional(),
  changedTo: epochMsQuery.optional(),
  sort: z.enum(RECORD_SORTS).optional(),
  page: z.coerce.number().int().min(1).max(50).optional(),
  ...cursorQuery,
});

export type RecordListQuery = z.infer<typeof RecordListQuery>;

/** One row of the admin list. */
export interface RecordListItem {
  id: string;
  title: string;
  subtitle: string | null;
  /** The main agent's name, or null. */
  mainAgent: string | null;
  materialTypeId: string;
  year: string | null;
  callNumber: string | null;
  itemCount: number;
  coverFileId: string | null;
  opacVisible: boolean;
  archived: boolean;
  changedAt: number;
}

/** `GET catalog/records`: `total` and `page` for a relevance page (total counted to 10 000), `nextCursor` otherwise. */
export interface RecordListResponse {
  items: RecordListItem[];
  total: number | null;
  nextCursor: string | null;
  page: number | null;
}

// ---- authority references ------------------------------------------------------------------------------------------

/** An agent: `{id}` of an existing one, or the agent to find by `(type, name + dates)` or create. */
export const AgentRefInput = z.union([
  z.strictObject({ id: ulidField }),
  z.strictObject({
    type: z.enum(AGENT_TYPES),
    name: shortText(191).min(1),
    dates: shortText(64).nullable().optional(),
    authoritySource: shortText(64).nullable().optional(),
  }),
]);

export type AgentRefInput = z.infer<typeof AgentRefInput>;

/** A subject: `{id}` of an existing one, or the subject to find by `(type, term)` or create. */
export const SubjectRefInput = z.union([
  z.strictObject({ id: ulidField }),
  z.strictObject({
    type: z.enum(SUBJECT_TYPES),
    term: shortText(191).min(1),
    classification: shortText(64).nullable().optional(),
    authoritySource: shortText(64).nullable().optional(),
  }),
]);

export type SubjectRefInput = z.infer<typeof SubjectRefInput>;

/** A publisher: `{id}` of an existing one, or the publisher to find by name or create. */
export const PublisherRefInput = z.union([
  z.strictObject({ id: ulidField }),
  z.strictObject({ name: shortText(191).min(1), place: shortText(191).nullable().optional() }),
]);

export type PublisherRefInput = z.infer<typeof PublisherRefInput>;

// ---- create and patch ----------------------------------------------------------------------------------------------

/** Where a record came from, when a client says (`records.source`); imports and migrations set their own. */
export const RECORD_SOURCE = /^(manual|isbn:arsya|sru:[a-z0-9-]{1,32})$/;

/**
 * The fields a create and a patch share, all optional: the scalar columns of §2.2 under the {@link RecordDraft} names
 * (null clears one), the references and the lists. A list that is sent replaces the record's list.
 */
const recordFields = {
  subtitle: titleText.nullable().optional(),
  responsibility: titleText.nullable().optional(),
  edition: shortText(191).nullable().optional(),
  materialDetail: shortText(191).nullable().optional(),
  publisher: PublisherRefInput.nullable().optional(),
  publicationPlace: shortText(191).nullable().optional(),
  publicationYear: yearField.nullable().optional(),
  publicationDateText: shortText(64).nullable().optional(),
  physicalDesc: shortText(191).nullable().optional(),
  series: shortText(191).nullable().optional(),
  classification: shortText(64).nullable().optional(),
  callNumber: shortText(64).nullable().optional(),
  languageId: ulidField.nullable().optional(),
  contentType: rdaCodeField.nullable().optional(),
  mediaType: rdaCodeField.nullable().optional(),
  carrierType: rdaCodeField.nullable().optional(),
  summary: longText.nullable().optional(),
  notes: longText.nullable().optional(),
  opacVisible: z.boolean().optional(),
  promoted: z.boolean().optional(),
  identifiers: z.array(IdentifierInput).max(RECORD_LIST_MAX.identifiers).optional(),
  agents: z
    .array(z.strictObject({ ref: AgentRefInput, role: z.enum(RELATOR_ROLES), isMain: z.boolean() }))
    .max(RECORD_LIST_MAX.agents)
    .optional(),
  subjects: z
    .array(z.strictObject({ ref: SubjectRefInput, isPrimary: z.boolean() }))
    .max(RECORD_LIST_MAX.subjects)
    .optional(),
  relations: z
    .array(z.strictObject({ relatedId: ulidField, type: z.enum(RELATION_TYPES) }))
    .max(RECORD_LIST_MAX.relations)
    .optional(),
  custom: customValuesField.optional(),
  source: z.string().regex(RECORD_SOURCE).optional(),
  marcExtra: z.array(MarcExtraField).max(RECORD_LIST_MAX.marcExtra).optional(),
};

/**
 * `POST catalog/records`. Required: `materialTypeId` and `title`; the template of the material type may require or
 * hide more (§3.8, checked by the server).
 *
 * `links` (S4), on create only: the 856/URL links of a draft (MARC, CSV, SRU, the editor's copy). The service stores
 * each http(s) one as a public URL attachment and skips any other with the warning `{path: 'links.<i>.url', code:
 * 'invalid_url'}`; later changes go through the attachments API.
 */
export const RecordCreateBody = z.strictObject({
  materialTypeId: ulidField,
  title: titleText.min(1),
  ...recordFields,
  links: z.array(LinkInput).max(RECORD_LIST_MAX.links).optional(),
});

export type RecordCreateBody = z.infer<typeof RecordCreateBody>;

/** `PATCH catalog/records/:id`: only the fields sent change; `version` is the row's. No `links` (use the attachments). */
export const RecordPatchBody = z.strictObject({
  version: versionField,
  materialTypeId: ulidField.optional(),
  title: titleText.min(1).optional(),
  ...recordFields,
});

export type RecordPatchBody = z.infer<typeof RecordPatchBody>;

/** The warnings a stored record carries (shown on the form, never a refusal). */
export type RecordWarningCode = 'isbn_invalid' | 'issn_invalid' | 'invalid_url';

/**
 * `GET catalog/records/:id`: the record as {@link RecordData} (staff load: every attachment and item, every custom
 * value in `custom`) with what the editor needs besides.
 */
export interface RecordDetail extends RecordData {
  version: number;
  materialTypeId: string;
  languageId: string | null;
  /** `manual`, `sru:<id>`, `isbn:arsya`, `import:<runId>`, `slims:<id>`, or null. */
  source: string | null;
  custom: Record<string, unknown>;
  warnings: { path: string; code: RecordWarningCode }[];
  itemCounts: { total: number; available: number };
}

// ---- merge, cover, duplicates --------------------------------------------------------------------------------------

/** `POST catalog/records/:id/merge`: merge `sourceId` into this record; `version` is this record's. */
export const MergeBody = z.strictObject({ sourceId: ulidField, version: versionField });

export type MergeBody = z.infer<typeof MergeBody>;

/** `PUT catalog/records/:id/cover`: a `catalog.cover` upload, or null to remove the cover. */
export const CoverBody = z.strictObject({ fileId: ulidField.nullable(), version: versionField });

export type CoverBody = z.infer<typeof CoverBody>;

/** `POST catalog/records/duplicates` (a read, §3.3): what the editor holds so far; `excludeId` is the record itself. */
export const DuplicateCheckBody = z.strictObject({
  title: titleText.min(1),
  subtitle: titleText.optional(),
  year: yearField.optional(),
  identifiers: z.array(IdentifierInput).max(RECORD_LIST_MAX.identifiers).optional(),
  mainAgentName: shortText(191).optional(),
  publisherName: shortText(191).optional(),
  excludeId: ulidField.optional(),
});

export type DuplicateCheckBody = z.infer<typeof DuplicateCheckBody>;

/** Why a candidate scored: the same ISBN/ISSN, a similar title, the same year, main agent or publisher. */
export type DuplicateReason = 'isbn' | 'title' | 'year' | 'agent' | 'publisher';

/** A likely duplicate (§3.3); `score` 0-100. */
export interface DuplicateCandidate {
  recordId: string;
  title: string;
  year: string | null;
  score: number;
  reasons: DuplicateReason[];
}

/** The answer of the duplicate check: at most 5 candidates at or above `threshold` (`catalog.dedupe.threshold`). */
export interface DuplicateCheckResponse {
  candidates: DuplicateCandidate[];
  threshold: number;
}
