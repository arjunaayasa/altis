/**
 * The authorities API vocabulary (Phase 2 spec §2.2, §3.5, §12.2; plan Tasks 13, 26): names (agents), subjects with
 * their thesaurus, publishers, merge and orphans. Each kind has its own literal paths (`catalog/agents`, ...; M3).
 *
 * Keys: an agent is unique on `(type, name + dates)`, a subject on `(type, term)`, a publisher on its name, each after
 * `normalizeKey`; a taken one is `{path: 'name' | 'term', code: 'taken'}`. The `store` routes answer `StoreResponse`
 * (S15); the orphan archive answers {@link OrphansArchiveResponse}.
 *
 * No Node built-ins here: the browser bundles this module. Import it as `@altis/shared/api/catalog/authorities`.
 */
import { z } from 'zod';
import { AGENT_TYPES, SUBJECT_TYPES, THESAURUS_RELS, type AgentType, type SubjectType, type ThesaurusRel } from '../../catalog-vocab.js';
import { ulidField, versionField } from '../common.js';
import { cursorQuery, longText, shortText, type Paged } from './common.js';

/** The three kinds of authority, as path segments, `merged_into` targets and orphan kinds. */
export const AUTHORITY_KINDS = Object.freeze(['agents', 'subjects', 'publishers'] as const);

export type AuthorityKind = (typeof AUTHORITY_KINDS)[number];

// ---- agents --------------------------------------------------------------------------------------------------------

const agentFields = {
  /** Inverted when there is a family name (`Toer, Pramoedya Ananta`); a single name as it is (§2.1). */
  name: shortText(191).min(1),
  dates: shortText(64).nullable().optional(),
  authoritySource: shortText(64).nullable().optional(),
  authorityRef: shortText(191).nullable().optional(),
  note: longText.nullable().optional(),
};

/** `POST catalog/agents`. */
export const AgentBody = z.strictObject({ type: z.enum(AGENT_TYPES), ...agentFields });

export type AgentBody = z.infer<typeof AgentBody>;

/** `PATCH catalog/agents/:id`; a change of name, dates or type re-indexes the records that name the agent. */
export const AgentPatchBody = z.strictObject({
  version: versionField,
  type: z.enum(AGENT_TYPES).optional(),
  name: agentFields.name.optional(),
  dates: agentFields.dates,
  authoritySource: agentFields.authoritySource,
  authorityRef: agentFields.authorityRef,
  note: agentFields.note,
});

export type AgentPatchBody = z.infer<typeof AgentPatchBody>;

// ---- subjects ------------------------------------------------------------------------------------------------------

const subjectFields = {
  term: shortText(191).min(1),
  classification: shortText(64).nullable().optional(),
  scopeNote: longText.nullable().optional(),
  authoritySource: shortText(64).nullable().optional(),
};

/** `POST catalog/subjects`. */
export const SubjectBody = z.strictObject({ type: z.enum(SUBJECT_TYPES), ...subjectFields });

export type SubjectBody = z.infer<typeof SubjectBody>;

/** `PATCH catalog/subjects/:id`. */
export const SubjectPatchBody = z.strictObject({
  version: versionField,
  type: z.enum(SUBJECT_TYPES).optional(),
  term: subjectFields.term.optional(),
  classification: subjectFields.classification,
  scopeNote: subjectFields.scopeNote,
  authoritySource: subjectFields.authoritySource,
});

export type SubjectPatchBody = z.infer<typeof SubjectPatchBody>;

/**
 * `PUT catalog/subjects/:id/relations`: the subject's outgoing relations, replaced as a whole. The reciprocal of each
 * one added or removed is written in the same transaction (§3.5); a relation to itself is `{path:
 * 'relations.<i>.subjectId', code: 'self'}`.
 */
export const SubjectRelationsBody = z.strictObject({
  relations: z.array(z.strictObject({ rel: z.enum(THESAURUS_RELS), subjectId: ulidField })).max(200),
  version: versionField,
});

export type SubjectRelationsBody = z.infer<typeof SubjectRelationsBody>;

// ---- publishers ----------------------------------------------------------------------------------------------------

/** `POST catalog/publishers`. */
export const PublisherBody = z.strictObject({ name: shortText(191).min(1), place: shortText(191).nullable().optional() });

export type PublisherBody = z.infer<typeof PublisherBody>;

/** `PATCH catalog/publishers/:id`. */
export const PublisherPatchBody = z.strictObject({
  version: versionField,
  name: shortText(191).min(1).optional(),
  place: shortText(191).nullable().optional(),
});

export type PublisherPatchBody = z.infer<typeof PublisherPatchBody>;

// ---- merge, lists, orphans -----------------------------------------------------------------------------------------

/** `POST catalog/{agents|subjects|publishers}/:id/merge`: merge this one into `intoId`; `version` is this one's. */
export const MergeIntoBody = z.strictObject({ intoId: ulidField, version: versionField });

export type MergeIntoBody = z.infer<typeof MergeIntoBody>;

/** `GET catalog/{agents|subjects|publishers}`: `q` searches the name or term; `type` filters agents or subjects. */
export const AuthorityListQuery = z.strictObject({
  q: shortText(191).optional(),
  type: z.enum([...AGENT_TYPES, ...SUBJECT_TYPES]).optional(),
  includeArchived: z.stringbool().optional(),
  ...cursorQuery,
});

export type AuthorityListQuery = z.infer<typeof AuthorityListQuery>;

/** `GET catalog/orphans?kind=`: authorities no record links to. */
export const OrphansQuery = z.strictObject({ kind: z.enum(AUTHORITY_KINDS), ...cursorQuery });

export type OrphansQuery = z.infer<typeof OrphansQuery>;

/** `POST catalog/orphans/archive`: at most 500 ids, one audit entry; linked ones are skipped. */
export const OrphansArchiveBody = z.strictObject({ kind: z.enum(AUTHORITY_KINDS), ids: z.array(ulidField).min(1).max(500) });

export type OrphansArchiveBody = z.infer<typeof OrphansArchiveBody>;

/** The answer of the orphan archive. */
export interface OrphansArchiveResponse {
  archived: number;
  skipped: number;
}

/** What every authority view carries: how many records link to it, and its merge and archive state. */
interface AuthorityState {
  /** The records that link to it (live ones). */
  usage: number;
  mergedInto: string | null;
  archived: boolean;
  version: number;
  createdAt: number;
  updatedAt: number | null;
}

/** One agent. */
export interface AgentView extends AuthorityState {
  id: string;
  type: AgentType;
  name: string;
  dates: string | null;
  authoritySource: string | null;
  authorityRef: string | null;
  note: string | null;
}

/** One subject, with its outgoing relations and the BT/NT cycles it is part of (allowed, but shown, §3.5). */
export interface SubjectView extends AuthorityState {
  id: string;
  type: SubjectType;
  term: string;
  classification: string | null;
  scopeNote: string | null;
  authoritySource: string | null;
  relations: { rel: ThesaurusRel; subjectId: string; term: string; type: SubjectType }[];
  /** Each cycle as the subject ids along it, starting and ending at this subject. */
  cycles: string[][];
}

/** One publisher. */
export interface PublisherView extends AuthorityState {
  id: string;
  name: string;
  place: string | null;
}

/** A page of authorities. */
export type AgentListResponse = Paged<AgentView>;
export type SubjectListResponse = Paged<SubjectView>;
export type PublisherListResponse = Paged<PublisherView>;

/** A page of orphans: the bare names, for the bulk archive. */
export type OrphansResponse = Paged<{ id: string; label: string; type: AgentType | SubjectType | null }>;
