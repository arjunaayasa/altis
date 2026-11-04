import { AGENT_TYPES, SUBJECT_TYPES, type AgentType, type SubjectType } from '@altis/shared';
import { AUTHORITY_KINDS, type AuthorityKind } from '@altis/shared/api/catalog/authorities';

/**
 * The search params of Otoritas (`/admin/catalog/authorities`, Phase 2 Task 26): which tab, which view of it (the list
 * or the orphans) and the list's applied filters. They live in the URL, so a link, the back button and the way back
 * from an authority's page keep them. The route's `validateSearch` (routes/catalog/authorities.tsx) and the screens
 * read them through {@link validateAuthoritiesSearch}; this module stays free of React so the route file can import it
 * without pulling the screens out of their lazy chunk.
 *
 * Each value is checked as the API would (`AuthorityListQuery`): a value the server would refuse (an unknown kind, a
 * type of another kind, a search of more than 191 characters or with a control character) is dropped, never sent.
 */

/** A type of agent or of subject: the list's type filter (publishers have none). */
export type AuthorityTypeFilter = AgentType | SubjectType;

export interface AuthoritiesSearch {
  /** The tab; Nama (`agents`) when absent. */
  kind?: Exclude<AuthorityKind, 'agents'>;
  /** The orphans view of the tab; the list when absent. */
  view?: 'orphans';
  /** The applied search (trimmed, 1-191 characters). */
  q?: string;
  /** The applied type filter, one of the tab's types. */
  type?: AuthorityTypeFilter;
  /** Archived authorities are listed too. */
  archived?: true;
}

/** The longest search the API takes (`shortText(191)`). */
export const SEARCH_MAX = 191;

/** True for one of the three kinds (a path segment of `/admin/catalog/authorities/$kind/$id`). */
export function isAuthorityKind(value: unknown): value is AuthorityKind {
  return typeof value === 'string' && (AUTHORITY_KINDS as readonly string[]).includes(value);
}

/** The types the list of `kind` filters on: agents' or subjects'; none for publishers. */
export function typesOf(kind: AuthorityKind): readonly AuthorityTypeFilter[] {
  if (kind === 'agents') return AGENT_TYPES;
  if (kind === 'subjects') return SUBJECT_TYPES;
  return [];
}

/**
 * A search text the API takes as it is: trimmed, 1-191 UTF-16 code units (Zod's `max` counts those, not code points),
 * without control characters or a lone surrogate (the API refuses malformed UTF-16); else undefined.
 */
export function cleanSearch(value: unknown): string | undefined {
  // The router reads `?q=1925` as the number 1925, and `?q="\ud800"` as a lone surrogate (its search values are JSON).
  const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
  if (typeof text !== 'string') return undefined;
  const trimmed = text.trim();
  if (trimmed === '' || trimmed.length > SEARCH_MAX || /[\p{Cc}\p{Cs}]/u.test(trimmed)) return undefined;
  return trimmed;
}

/** The tab of `search`. */
export function kindOf(search: AuthoritiesSearch): AuthorityKind {
  return search.kind ?? 'agents';
}

/** The `validateSearch` of `/admin/catalog/authorities`: the known values of `search`, each valid, nothing else. */
export function validateAuthoritiesSearch(search: Record<string, unknown>): AuthoritiesSearch {
  const out: AuthoritiesSearch = {};
  const kind: AuthorityKind = isAuthorityKind(search.kind) ? search.kind : 'agents';
  if (kind !== 'agents') out.kind = kind;
  if (search.view === 'orphans') out.view = 'orphans';
  const q = cleanSearch(search.q);
  if (q !== undefined) out.q = q;
  const type = search.type;
  if (typeof type === 'string' && (typesOf(kind) as readonly string[]).includes(type)) out.type = type as AuthorityTypeFilter;
  if (search.archived === true || search.archived === 'true') out.archived = true;
  return out;
}
