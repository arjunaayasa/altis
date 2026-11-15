import { MEMBER_STATUSES, type MemberStatus } from '@altis/shared';
import type { MemberListItem, MemberSearchBody, MemberSearchResponse } from '@altis/shared/api/members';
import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { PlusIcon, SearchIcon, UploadIcon } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { Field, Notice, SELECT_CLASS } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useT } from '@/i18n';
import { holds } from '@/lib/access';
import { api } from '@/lib/api';
import { problemText } from '@/lib/form-errors';
import { useMe } from '@/lib/me';
import { MasterTable, type MasterColumn } from '@/screens/catalog/masters/master-table';
import { MemberStatusBadge, useCalendarDate, useMemberTypes, useTypeName } from '@/screens/circulation/common';
// ---- Komunitas K2 (members extended) ----
import { BulkBar } from './bulk';

/**
 * Daftar Anggota (`/admin/anggota`): search by member number, name, identity number or e-mail, filter by type, class and
 * status (by default every status but archived), 50 at a time by name ("Muat lebih banyak"). The search text never
 * goes in a URL: it is the body of `POST members/search`. Each row opens the member's page; "Layani" opens the member
 * at the desk.
 */

interface Filters {
  q: string;
  typeId: string;
  status: MemberStatus | '';
  className: string;
}

const NO_FILTERS: Filters = { q: '', typeId: '', status: '', className: '' };

function searchBody(f: Filters, cursor: string | null): MemberSearchBody {
  const body: MemberSearchBody = { limit: 50 };
  if (f.q.trim() !== '') body.q = f.q.trim();
  if (f.typeId !== '') body.typeId = f.typeId;
  if (f.status !== '') body.status = f.status;
  if (f.className.trim() !== '') body.className = f.className.trim();
  if (cursor !== null) body.cursor = cursor;
  return body;
}

export function MembersListScreen() {
  const t = useT();
  const me = useMe();
  const day = useCalendarDate();
  const typeName = useTypeName();
  const ids = useId();
  const types = useMemberTypes();
  const [draft, setDraft] = useState<Filters>(NO_FILTERS);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const canManage = holds(me, 'members.records.manage');
  const canImport = holds(me, 'members.import.run');
  const canTypes = holds(me, 'members.types.manage');
  const canServe =
    holds(me, 'circulation.desk.use') || Object.values(me?.authenticated === true ? me.branchPermissions : {}).some((p) => p.includes('circulation.desk.use'));

  const list = useInfiniteQuery({
    queryKey: ['members', 'search', filters],
    queryFn: ({ pageParam }) => api<MemberSearchResponse>('POST', 'members/search', searchBody(filters, pageParam)),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    placeholderData: keepPreviousData,
    enabled: me !== undefined,
  });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  // ---- Komunitas K2 (members extended): the selection of the bulk bar ----
  const [selection, setSelection] = useState<Map<string, MemberListItem>>(new Map());
  const toggle = (r: MemberListItem): void =>
    setSelection((prev) => {
      const next = new Map(prev);
      if (next.has(r.id)) next.delete(r.id);
      else next.set(r.id, r);
      return next;
    });
  const allSelected = rows.length > 0 && rows.every((r) => selection.has(r.id));
  const toggleAll = (): void => setSelection(allSelected ? new Map() : new Map(rows.map((r) => [r.id, r])));
  const filtered = filters.q.trim() !== '' || filters.typeId !== '' || filters.status !== '' || filters.className.trim() !== '';

  const apply = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setFilters(draft);
  };
  const clear = (): void => {
    setDraft(NO_FILTERS);
    setFilters(NO_FILTERS);
  };

  const columns: MasterColumn<MemberListItem>[] = [
    {
      id: 'select',
      header: (
        <input type="checkbox" className="size-4 accent-primary" aria-label={t('members.tools.select_all')} checked={allSelected} onChange={toggleAll} />
      ),
      cell: (r) => (
        <input
          type="checkbox"
          className="size-4 accent-primary"
          aria-label={t('members.tools.select_one', { name: r.name })}
          checked={selection.has(r.id)}
          onChange={() => toggle(r)}
        />
      ),
    },
    {
      id: 'no',
      header: t('members.col.member_no'),
      className: 'whitespace-nowrap',
      cell: (r) => (
        <Link to={`/admin/anggota/${encodeURIComponent(r.id)}`} className="font-mono font-medium text-primary underline-offset-4 hover:underline">
          {r.memberNo}
        </Link>
      ),
    },
    { id: 'name', header: t('members.col.name'), cell: (r) => r.name },
    { id: 'type', header: t('members.col.type'), cell: (r) => typeName(r.type) },
    { id: 'class', header: t('members.col.class'), cell: (r) => r.className ?? '—' },
    { id: 'expires', header: t('members.col.valid_until'), className: 'whitespace-nowrap', cell: (r) => (r.expiresOn === null ? t('members.never_expires') : day(r.expiresOn)) },
    { id: 'status', header: t('members.col.status'), cell: (r) => <MemberStatusBadge status={r.status} /> },
    ...(canServe
      ? [
          {
            id: 'actions',
            header: t('table.actions'),
            cell: (r: MemberListItem) => (
              <Button asChild size="sm" variant="outline">
                <Link to={`/admin/layanan?member=${encodeURIComponent(r.id)}`} aria-label={t('members.action.serve_named', { name: r.name })}>
                  {t('members.action.serve')}
                </Link>
              </Button>
            ),
          },
        ]
      : []),
  ];

  const nothingAtAll = !filtered && list.data !== undefined && rows.length === 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">{t('members.title')}</h1>
        <div className="flex flex-wrap gap-2">
          {/* ---- Komunitas K2 (members extended): the member list report, which exports it (personal data) ---- */}
          {holds(me, 'members.export.run') && (
            <Button asChild variant="outline">
              <Link to={`/admin/reports/${encodeURIComponent('members.list')}`}>{t('members.tools.export')}</Link>
            </Button>
          )}
          {canImport && (
            <Button asChild variant="outline">
              <Link to="/admin/anggota/impor">
                <UploadIcon aria-hidden="true" />
                {t('members.import_csv')}
              </Link>
            </Button>
          )}
          {canManage && (
            <Button asChild>
              <Link to="/admin/anggota/baru">
                <PlusIcon aria-hidden="true" />
                {t('members.add')}
              </Link>
            </Button>
          )}
        </div>
      </div>
      <form noValidate onSubmit={apply} aria-label={t('members.filters')} className="grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-2 lg:grid-cols-5">
        <Field label={t('members.filter.search')} hint={t('members.filter.search_hint')} className="lg:col-span-2">
          {(c) => <Input {...c} type="search" autoComplete="off" maxLength={191} value={draft.q} onChange={(e) => setDraft({ ...draft, q: e.target.value })} />}
        </Field>
        <Field id={`${ids}-type`} label={t('members.filter.type')}>
          <select id={`${ids}-type`} className={SELECT_CLASS} value={draft.typeId} onChange={(e) => setDraft({ ...draft, typeId: e.target.value })}>
            <option value="">{t('members.filter.all_types')}</option>
            {(types.data?.items ?? []).map((type) => (
              <option key={type.id} value={type.id}>
                {typeName(type)}
              </option>
            ))}
          </select>
        </Field>
        <Field id={`${ids}-status`} label={t('members.filter.status')}>
          <select id={`${ids}-status`} className={SELECT_CLASS} value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value as MemberStatus | '' })}>
            <option value="">{t('members.filter.all_but_archived')}</option>
            {MEMBER_STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`vocab.member_status.${s}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('members.filter.class')}>
          {(c) => <Input {...c} autoComplete="off" maxLength={64} value={draft.className} onChange={(e) => setDraft({ ...draft, className: e.target.value })} />}
        </Field>
        <div className="flex flex-wrap gap-2 sm:col-span-2 lg:col-span-5">
          <Button type="submit">
            <SearchIcon aria-hidden="true" />
            {t('members.filter.apply')}
          </Button>
          {filtered && (
            <Button type="button" variant="outline" onClick={clear}>
              {t('members.filter.clear')}
            </Button>
          )}
        </div>
      </form>
      {list.isError && list.data === undefined ? (
        <Notice
          kind="error"
          action={
            <Button variant="outline" size="sm" onClick={() => void list.refetch()}>
              {t('table.retry')}
            </Button>
          }>
          {problemText(t, list.error)}
        </Notice>
      ) : list.data === undefined ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t('shell.loading')}
        </p>
      ) : nothingAtAll ? (
        <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed p-6">
          <p className="font-medium">{t('members.empty_all')}</p>
          <p className="text-sm text-muted-foreground">{t('members.empty_all_hint')}</p>
          <div className="flex flex-wrap gap-2">
            {canManage && (
              <Button asChild size="sm">
                <Link to="/admin/anggota/baru">{t('members.add')}</Link>
              </Button>
            )}
            {canImport && (
              <Button asChild size="sm" variant="outline">
                <Link to="/admin/anggota/impor">{t('members.import_csv')}</Link>
              </Button>
            )}
            {canTypes && (
              <Button asChild size="sm" variant="link">
                <Link to="/admin/anggota/tipe">{t('nav.members.types')}</Link>
              </Button>
            )}
          </div>
        </div>
      ) : (
        <>
          {(canManage || selection.size > 0) && <BulkBar selected={[...selection.values()]} canManage={canManage} onClear={() => setSelection(new Map())} />}
          <MasterTable caption={t('members.caption')} columns={columns} rows={rows} empty={t('members.empty_filtered')} />
          {list.hasNextPage && (
            <Button variant="outline" className="w-fit" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
              {t('circulation.load_more')}
            </Button>
          )}
        </>
      )}
    </div>
  );
}
