import type { AgentView, AuthorityKind, PublisherView, SubjectView } from '@altis/shared/api/catalog/authorities';
import type { Paged } from '@altis/shared/api/catalog/common';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useId, useMemo, useState, type FormEvent } from 'react';
import { CheckField, SELECT_CLASS } from '@/components/form-field';
import { DenseTable, ErrorState, FilterField, FilterRow, PageError, SkeletonTable, type DenseColumn } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useT, type Translate } from '@/i18n';
import { api } from '@/lib/api';
import { useMe } from '@/lib/me';
import { AUTHORITY_LINK, AuthorityBadges, authorityHref, authorityListKey, authorityPath, typeLabel, type AuthorityListFilters, type AuthorityView } from './common';
import { SEARCH_MAX, cleanSearch, typesOf, type AuthoritiesSearch, type AuthorityTypeFilter } from './search';

/**
 * The list of one tab of Otoritas (Phase 2 Task 26; spec §13; `GET catalog/{agents|subjects|publishers}`): the live
 * authorities of the kind (archived ones on request), in the order of their keys as the server pages them (keyset, "Muat lagi"),
 * with the usage count (the live records that link to each). The filters (a search in the name or term, the type of an
 * agent or subject, archived ones too) are applied with "Terapkan" and live in the URL; the list reads under
 * `['catalog', kind, 'list', filters]`, so each tab and each filter has its own cache entry.
 */

/** One row, whatever the kind. */
interface Row {
  id: string;
  name: string;
  type: string | null;
  /** An agent's dates, a subject's classification, a publisher's place. */
  extra: string | null;
  usage: number;
  archived: boolean;
  mergedInto: string | null;
}

function rowOf(t: Translate, kind: AuthorityKind, view: AuthorityView): Row {
  const base = { id: view.id, usage: view.usage, archived: view.archived, mergedInto: view.mergedInto };
  if (kind === 'agents') {
    const a = view as AgentView;
    return { ...base, name: a.name, type: typeLabel(t, a.type), extra: a.dates };
  }
  if (kind === 'subjects') {
    const s = view as SubjectView;
    return { ...base, name: s.term, type: typeLabel(t, s.type), extra: s.classification };
  }
  const p = view as PublisherView;
  return { ...base, name: p.name, type: null, extra: p.place };
}

/** How many authorities a page of the list holds. */
const PAGE = 50;

/** `GET catalog/<kind>` for one page: the applied filters, then the cursor of the previous page. */
function listPath(kind: AuthorityKind, filters: AuthorityListFilters, cursor: string | null): string {
  const q = new URLSearchParams();
  if (filters.q !== '') q.set('q', filters.q);
  if (filters.type !== '') q.set('type', filters.type);
  if (filters.includeArchived) q.set('includeArchived', 'true');
  q.set('limit', String(PAGE));
  if (cursor !== null) q.set('cursor', cursor);
  return `${authorityPath(kind)}?${q.toString()}`;
}

const EXTRA_HEADER = {
  agents: 'catalog.authorities.col.dates',
  subjects: 'catalog.authorities.col.classification',
  publishers: 'catalog.authorities.col.place',
} as const;

const NO_ROWS: Row[] = [];

/** The filter form: what is typed is applied (to the URL, then the list) only with "Terapkan". */
function Filters({ kind, applied, onApply }: { kind: AuthorityKind; applied: AuthoritiesSearch; onApply(next: AuthoritiesSearch): void }) {
  const t = useT();
  const ids = useId();
  const types = typesOf(kind);
  const [q, setQ] = useState(applied.q ?? '');
  const [type, setType] = useState<AuthorityTypeFilter | ''>(applied.type ?? '');
  const [archived, setArchived] = useState(applied.archived === true);

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    const next: AuthoritiesSearch = {};
    const text = cleanSearch(q);
    if (text !== undefined) next.q = text;
    if (type !== '') next.type = type;
    if (archived) next.archived = true;
    onApply(next);
  };
  const clear = (): void => {
    setQ('');
    setType('');
    setArchived(false);
    onApply({});
  };

  return (
    <FilterRow
      label={t('catalog.authorities.filter.label')}
      onSubmit={submit}
      actions={
        <>
          <Button type="submit" variant="outline">
            {t('catalog.authorities.filter.apply')}
          </Button>
          <Button type="button" variant="ghost" onClick={clear}>
            {t('catalog.authorities.filter.clear')}
          </Button>
        </>
      }>
      <FilterField wide label={t('catalog.authorities.filter.q')}>
        {(c) => (
          <Input
            {...c}
            type="search"
            autoComplete="off"
            maxLength={SEARCH_MAX}
            placeholder={t('catalog.authorities.filter.q_placeholder')}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        )}
      </FilterField>
      {types.length > 0 && (
        <FilterField id={`${ids}-type`} label={t('catalog.authorities.filter.type')}>
          <select id={`${ids}-type`} className={SELECT_CLASS} value={type} onChange={(e) => setType(e.target.value as AuthorityTypeFilter | '')}>
            <option value="">{t('catalog.authorities.filter.type_all')}</option>
            {types.map((value) => (
              <option key={value} value={value}>
                {typeLabel(t, value)}
              </option>
            ))}
          </select>
        </FilterField>
      )}
      <div className="flex h-8.5 items-center">
        <CheckField label={t('catalog.authorities.filter.archived')} checked={archived} onChange={(e) => setArchived(e.target.checked)} />
      </div>
    </FilterRow>
  );
}

/** The list of `kind` with its filters (`search`, from the URL); `onApply` puts new filters into the URL. */
export function AuthorityList({ kind, search, onApply }: { kind: AuthorityKind; search: AuthoritiesSearch; onApply(next: AuthoritiesSearch): void }) {
  const t = useT();
  const me = useMe();
  const filters: AuthorityListFilters = useMemo(
    () => ({ q: search.q ?? '', type: search.type ?? '', includeArchived: search.archived === true }),
    [search.q, search.type, search.archived],
  );

  const list = useInfiniteQuery({
    queryKey: authorityListKey(kind, filters),
    queryFn: ({ pageParam }) => api<Paged<AuthorityView>>('GET', listPath(kind, filters, pageParam)),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    enabled: me !== undefined,
    // Every loaded page would be read again: a list being read does not change under the reader's eyes.
    refetchOnWindowFocus: false,
  });

  const rows = useMemo(() => list.data?.pages.flatMap((page) => page.items.map((view) => rowOf(t, kind, view))) ?? NO_ROWS, [list.data, t, kind]);

  const name: DenseColumn<Row> = {
    id: 'name',
    header: t(kind === 'subjects' ? 'catalog.authorities.col.term' : 'catalog.authorities.col.name'),
    cell: (r) => (
      <span className="flex flex-wrap items-center gap-2">
        <Link to={authorityHref(kind, r.id)} className={AUTHORITY_LINK}>
          {r.name}
        </Link>
        <AuthorityBadges view={r} />
      </span>
    ),
  };
  const type: DenseColumn<Row> = { id: 'type', header: t('catalog.authorities.col.type'), cell: (r) => r.type ?? '—' };
  const extra: DenseColumn<Row> = { id: 'extra', header: t(EXTRA_HEADER[kind]), cell: (r) => <span className="text-muted-foreground">{r.extra ?? '—'}</span> };
  const usage: DenseColumn<Row> = { id: 'usage', header: t('catalog.authorities.col.usage'), className: 'text-right', headClassName: 'text-right', cell: (r) => r.usage };
  const columns = kind === 'publishers' ? [name, extra, usage] : [name, type, extra, usage];

  return (
    <div className="grid gap-5">
      {/* A new key when the URL's filters change (the back button): the form shows what is applied. */}
      <Filters key={`${filters.q}|${filters.type}|${String(filters.includeArchived)}`} kind={kind} applied={search} onApply={onApply} />
      {list.isError && list.data === undefined ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />
      ) : list.data === undefined ? (
        <SkeletonTable label={t('shell.loading')} columns={columns.length} />
      ) : (
        <div className="grid gap-3">
          <DenseTable caption={t(`catalog.authorities.caption.${kind}`)} columns={columns} rows={rows} rowKey={(r) => r.id} empty={t('catalog.authorities.empty')} />
          {list.isFetchNextPageError && <PageError error={list.error} />}
          {list.hasNextPage && (
            <Button variant="outline" className="w-fit" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
              {t(list.isFetchingNextPage ? 'shell.loading' : 'catalog.authorities.load_more')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
