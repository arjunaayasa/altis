import { AGENT_TYPES, vocabKey, type AgentType, type SubjectType, type ThesaurusRel } from '@altis/shared';
import type { AgentView, AuthorityKind, PublisherView, SubjectView } from '@altis/shared/api/catalog/authorities';
import type { Paged } from '@altis/shared/api/catalog/common';
import { keepPreviousData } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '@/components/form-field';
import { useT, type Translate } from '@/i18n';
import { useApiQuery } from '@/lib/me';
import { SEARCH_MAX, type AuthorityTypeFilter } from './search';

/**
 * What the Otoritas screens share (Phase 2 Task 26): the React Query keys, the labels of an authority and of its type,
 * the archived/merged badges, the search of live authorities that the merge dialog and the thesaurus editor pick
 * from, and the version chain of an authority's page.
 *
 * Every key starts with `['catalog', <kind>]`, so a write invalidates the lists, the pages and the searches of its
 * kind at once (`invalidateQueries({queryKey: ['catalog', kind]})`).
 */

/** Any authority view. */
export type AuthorityView = AgentView | SubjectView | PublisherView;

/** The view of each kind. */
export interface AuthorityViewOf {
  agents: AgentView;
  subjects: SubjectView;
  publishers: PublisherView;
}

/** The applied filters of a list (the query key part; the URL holds them). */
export interface AuthorityListFilters {
  q: string;
  type: AuthorityTypeFilter | '';
  includeArchived: boolean;
}

/** The look of a link to an authority (a name in a list, a related subject). */
export const AUTHORITY_LINK = 'font-semibold text-accent-text underline-offset-4 hover:underline';

/** Everything of one kind: its lists, pages and searches. */
export const authorityKindKey = (kind: AuthorityKind): readonly ['catalog', AuthorityKind] => ['catalog', kind];

/** The list of a kind with its applied filters. */
export const authorityListKey = (kind: AuthorityKind, filters: AuthorityListFilters) => ['catalog', kind, 'list', filters] as const;

/** One authority's page. */
export const authorityKey = (kind: AuthorityKind, id: string) => ['catalog', kind, id] as const;

/** The orphans of a kind. */
export const orphansKey = (kind: AuthorityKind) => ['catalog', 'orphans', kind] as const;

/** The API path of a kind (`catalog/agents`, ...), and of one authority. */
export function authorityPath(kind: AuthorityKind, id?: string): string {
  return id === undefined ? `catalog/${kind}` : `catalog/${kind}/${encodeURIComponent(id)}`;
}

/** The admin page of an authority. */
export function authorityHref(kind: AuthorityKind, id: string): string {
  return `/admin/catalog/authorities/${kind}/${encodeURIComponent(id)}`;
}

function isAgentType(type: AuthorityTypeFilter): type is AgentType {
  return (AGENT_TYPES as readonly string[]).includes(type);
}

/** The shared label of an agent's or a subject's type (the two lists share no value); null for none (a publisher). */
export function typeLabel(t: Translate, type: AuthorityTypeFilter | null | undefined): string | null {
  if (type === undefined || type === null) return null;
  return isAgentType(type) ? t(vocabKey('agent_type', type)) : t(vocabKey('subject_type', type));
}

/** The heading of an authority: an agent's or a publisher's name, a subject's term. */
export function authorityName(view: AuthorityView): string {
  return 'term' in view ? view.term : view.name;
}

/**
 * The label that tells an authority apart from its namesakes (a picker option, a merge confirmation): an agent's name
 * with its dates, a subject's term with its type, a publisher's name with its place.
 */
export function authorityLabel(t: Translate, kind: AuthorityKind, view: AuthorityView): string {
  if (kind === 'agents') {
    const a = view as AgentView;
    return a.dates === null || a.dates === '' ? a.name : `${a.name} (${a.dates})`;
  }
  if (kind === 'subjects') {
    const s = view as SubjectView;
    return subjectLabel(t, s.term, s.type);
  }
  const p = view as PublisherView;
  return p.place === null || p.place === '' ? p.name : `${p.name} (${p.place})`;
}

/** A subject's term with its type (`Sejarah (Topik)`): the label of a subject in a picker. */
export function subjectLabel(t: Translate, term: string, type: SubjectType): string {
  return `${term} (${t(vocabKey('subject_type', type))})`;
}

/** A thesaurus relation as its abbreviation, shown as it is in both languages: `BT`, `NT`, `USE`, ... */
export function relAbbr(rel: ThesaurusRel): string {
  return rel.toUpperCase();
}

/** The archived and merged badges of an authority (nothing for a live one). */
export function AuthorityBadges({ view }: { view: Pick<AuthorityView, 'archived' | 'mergedInto'> }) {
  const t = useT();
  if (view.mergedInto !== null) return <Badge tone="neutral">{t('catalog.authorities.badge.merged')}</Badge>;
  if (view.archived) return <Badge tone="neutral">{t('catalog.authorities.badge.archived')}</Badge>;
  return null;
}

/** `value`, once it has not changed for `ms` milliseconds. */
export function useDebounced<T>(value: T, ms = 300): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/** How many candidates a picker shows. */
const PICK_LIMIT = 20;

/**
 * What a picker searches for: `typed` without control characters or lone surrogates, trimmed, and cut to at most
 * {@link SEARCH_MAX} UTF-16 code units (what `shortText(191)` counts) at a code point boundary.
 */
export function pickerSearch(typed: string): string {
  let out = '';
  for (const ch of typed.replace(/[\p{Cc}\p{Cs}]/gu, ' ').trim()) {
    if (out.length + ch.length > SEARCH_MAX) break;
    out += ch;
  }
  return out.trim();
}

/** What {@link useAuthorityCandidates} answers. */
export interface AuthorityCandidates<V> {
  /** The live authorities that match; none while nothing is typed. */
  items: V[];
  /** Something is typed and no answer came yet. */
  loading: boolean;
  /** Nothing is typed yet: the picker asks for a few letters. */
  idle: boolean;
  /** The last search failed: why. */
  error: unknown;
}

/**
 * The live authorities of `kind` whose name or term holds what is typed (`GET catalog/<kind>?q=&limit=20`, debounced),
 * for the merge dialog and the thesaurus editor; `type` narrows agents to one type (agents of different types cannot
 * be merged). Archived ones are not listed: they cannot be a merge target, and a relation to one would bring it back.
 *
 * Nothing is read before something is typed, nor while the picker is not `enabled`; while a newer search is on its
 * way, the previous answer stays shown.
 */
export function useAuthorityCandidates<K extends AuthorityKind>(
  kind: K,
  search: string,
  o: { type?: AuthorityTypeFilter; enabled: boolean },
): AuthorityCandidates<AuthorityViewOf[K]> {
  const typed = pickerSearch(search);
  const q = useDebounced(typed, 300);
  const params = new URLSearchParams({ q });
  if (o.type !== undefined) params.set('type', o.type);
  params.set('limit', String(PICK_LIMIT));
  const query = useApiQuery<Paged<AuthorityViewOf[K]>>({
    queryKey: ['catalog', kind, 'candidates', { q, type: o.type ?? '' }],
    path: `${authorityPath(kind)}?${params.toString()}`,
    enabled: o.enabled && q !== '',
    placeholderData: keepPreviousData,
  });
  const idle = typed === '';
  return {
    items: idle ? [] : (query.data?.items ?? []),
    loading: o.enabled && !idle && query.data === undefined && !query.isError,
    idle,
    error: idle ? null : query.error,
  };
}

/**
 * The page's own writes to one authority (the form, the thesaurus, the archive and the merge share its row version):
 * each version a write was sent with, and the version the server answered. A write based on a version read earlier
 * sends the version past every own write that started from it, so saving the form and then the thesaurus needs no
 * reload; a change by someone else still makes the server refuse (CONFLICT_STALE).
 */
export interface VersionChain {
  /** The version to send for a write based on `version`: past every own write that started from it. */
  advance(version: number): number;
  /** An own write sent `from` and the row is now at `to`. */
  record(from: number, to: number): void;
}

/** A {@link VersionChain} for the lifetime of a page. */
export function useVersionChain(): VersionChain {
  const steps = useRef(new Map<number, number>());
  return useMemo(
    () => ({
      advance(version: number): number {
        let v = version;
        // A chain only grows (each step answers a higher version): the bound only guards against a broken answer.
        for (let i = 0; i < 1000 && steps.current.has(v); i++) v = steps.current.get(v)!;
        return v;
      },
      record(from: number, to: number): void {
        if (to > from) steps.current.set(from, to);
      },
    }),
    [],
  );
}
