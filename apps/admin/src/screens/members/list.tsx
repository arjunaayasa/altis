import { MEMBER_STATUSES, type MemberStatus } from '@altis/shared';
import type { StoreResponse } from '@altis/shared/api/catalog/common';
import type { MemberClassesResponse, MemberListItem, MemberSearchBody, MemberSearchResponse, MemberView } from '@altis/shared/api/members';
import { keepPreviousData, useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Field, Notice, SELECT_CLASS } from '@/components/form-field';
import { Callout, DenseTable, FILTER_ROW, MoreMenu, MoreMenuItem, MoreMenuRule, PageHead, SkeletonTable, StatusText, type DenseColumn } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useT } from '@/i18n';
import { holds } from '@/lib/access';
import { ApiError, api } from '@/lib/api';
import { problemText } from '@/lib/form-errors';
import { useApiQuery, useMe } from '@/lib/me';
import { MemberStatusBadge, todayLocal, useCalendarDate, useMemberTypes, useTypeName } from '@/screens/circulation/common';
// ---- Komunitas K2 (members extended) ----
import { BulkBar } from './bulk';
import { refreshMembers } from './common';

/**
 * Daftar Anggota (`/admin/anggota`): search by member number, name, identity number or e-mail, filter by type, class (a
 * list of the live members' classes) and status (by default every status but archived), 50 at a time by name ("Muat
 * lebih banyak"). The filters sit in one row with their labels and apply as they change (the search a moment after the
 * last key, or at once with Enter). The search text never goes in a URL: it is the body of `POST members/search`, whose
 * rows carry each member's open loans and how many are overdue (column Pinjaman: "n dari batas", "n terlambat"). Each name opens the member's page; its ⋯
 * menu also serves the member at the desk and, for a manager, extends, suspends or reactivates that one member (its page
 * opens with that panel open) or archives it (asked first in a dialog; a member with open loans is refused, said above
 * the table). Selected members get the bulk bar and its panels (bulk.tsx).
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
  const navigate = useNavigate();
  const ids = useId();
  const types = useMemberTypes();
  const [draft, setDraft] = useState<Filters>(NO_FILTERS);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const canManage = holds(me, 'members.records.manage');
  const canImport = holds(me, 'members.import.run');
  const canTypes = holds(me, 'members.types.manage');
  const canServe =
    holds(me, 'circulation.desk.use') || Object.values(me?.authenticated === true ? me.branchPermissions : {}).some((p) => p.includes('circulation.desk.use'));
  const queryClient = useQueryClient();
  const [archiving, setArchiving] = useState<MemberListItem | null>(null);
  const [refused, setRefused] = useState<MemberView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const openPanel = (memberPanel: 'extend' | 'suspend' | 'reactivate', member: MemberListItem): void =>
    void navigate({ href: `/admin/anggota/${encodeURIComponent(member.id)}`, state: { memberPanel } });

  // Archiving one member reads it first (its version and open loans); open loans are refused and said above the table.
  const archive = async (row: MemberListItem): Promise<void> => {
    setNotice(null);
    setRefused(null);
    const view = await api<MemberView>('GET', `members/${encodeURIComponent(row.id)}`);
    try {
      await api<StoreResponse>('DELETE', `members/${encodeURIComponent(row.id)}`, { version: view.version });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'MEMBER_IN_USE') {
        setRefused(view);
        return;
      }
      throw e;
    }
    await refreshMembers(queryClient);
    setNotice(t('members.archive.done', { name: row.name }));
  };

  // The typed filter applies a moment after the last key; the lists apply at once (see `pick`).
  useEffect(() => {
    if (draft.q === filters.q) return;
    const id = setTimeout(() => setFilters((f) => ({ ...f, q: draft.q })), 350);
    return () => clearTimeout(id);
  }, [draft.q, filters.q]);
  // ---- Komunitas (staff screens' data): the classes of the class filter ----
  const classes = useApiQuery<MemberClassesResponse>({ queryKey: ['members', 'classes'], path: 'members/classes', staleTime: 60_000 });

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
  const pick = (next: Filters): void => {
    setDraft(next);
    setFilters(next);
  };
  const clear = (): void => pick(NO_FILTERS);
  const today = todayLocal();

  const columns: DenseColumn<MemberListItem>[] = [
    {
      id: 'select',
      header: (
        <input type="checkbox" className="size-4 accent-primary align-middle" aria-label={t('members.tools.select_all')} checked={allSelected} onChange={toggleAll} />
      ),
      headClassName: 'w-px',
      cell: (r) => (
        <input
          type="checkbox"
          className="size-4 accent-primary align-middle"
          aria-label={t('members.tools.select_one', { name: r.name })}
          checked={selection.has(r.id)}
          onChange={() => toggle(r)}
        />
      ),
    },
    {
      id: 'name',
      header: t('members.col.name'),
      cell: (r) => (
        <span className="grid">
          <Link to={`/admin/anggota/${encodeURIComponent(r.id)}`} className="w-fit font-semibold text-accent-text underline-offset-4 hover:underline">
            {r.name}
          </Link>
          <span className="text-xs font-semibold tracking-wide text-muted-foreground tabular-nums">{r.memberNo}</span>
        </span>
      ),
    },
    { id: 'type', header: t('members.col.type'), cell: (r) => typeName(r.type) },
    { id: 'class', header: t('members.col.class'), className: 'whitespace-nowrap', cell: (r) => r.className ?? '—' },
    {
      id: 'expires',
      header: t('members.col.valid_until'),
      className: 'whitespace-nowrap',
      cell: (r) => {
        if (r.expiresOn === null) return t('members.never_expires');
        const left = daysFrom(today, r.expiresOn);
        return (
          <span className="grid">
            {day(r.expiresOn)}
            {left !== null && left >= 0 && left <= 30 && <StatusText tone="warn" className="text-xs">{t('circulation.due.left', { count: left })}</StatusText>}
          </span>
        );
      },
    },
    { id: 'status', header: t('members.col.status'), cell: (r) => <MemberStatusBadge status={r.status} /> },
    {
      id: 'loans',
      header: t('members.col.loans'),
      headClassName: 'text-right',
      className: 'text-right whitespace-nowrap',
      cell: (r) => (
        <span className="grid justify-items-end">
          {r.type.loanLimit === null || r.type.loanLimit === 0 ? String(r.openLoans ?? 0) : t('circulation.member.loans_of', { count: r.openLoans ?? 0, limit: r.type.loanLimit })}
          {(r.overdueLoans ?? 0) > 0 && (
            <StatusText tone="bad" className="text-xs">
              {t('members.list.overdue_count', { count: r.overdueLoans ?? 0 })}
            </StatusText>
          )}
        </span>
      ),
    },
    {
      id: 'actions',
      header: <span className="sr-only">{t('table.actions')}</span>,
      className: 'w-px py-1.5 text-right',
      cell: (r) => (
        <MoreMenu small label={t('members.action.more_named', { name: r.name })}>
          <MoreMenuItem onSelect={() => void navigate({ href: `/admin/anggota/${encodeURIComponent(r.id)}` })}>
            {t(canManage ? 'members.action.view_edit' : 'members.action.view')}
          </MoreMenuItem>
          {canServe && (
            <MoreMenuItem aria-label={t('members.action.serve_named', { name: r.name })} onSelect={() => void navigate({ href: `/admin/layanan?member=${encodeURIComponent(r.id)}` })}>
              {t('members.action.serve_desk')}
            </MoreMenuItem>
          )}
          {canManage && r.status !== 'archived' && r.status !== 'anonymized' && (
            <>
              <MoreMenuItem onSelect={() => openPanel('extend', r)}>{t('members.action.extend')}</MoreMenuItem>
              {r.status === 'suspended' ? (
                <MoreMenuItem onSelect={() => openPanel('reactivate', r)}>{t('members.action.reactivate_ellipsis')}</MoreMenuItem>
              ) : (
                <MoreMenuItem onSelect={() => openPanel('suspend', r)}>{t('members.action.suspend_ellipsis')}</MoreMenuItem>
              )}
              <MoreMenuRule />
              <MoreMenuItem danger onSelect={() => setArchiving(r)}>
                {t('members.action.archive')}
              </MoreMenuItem>
            </>
          )}
        </MoreMenu>
      ),
    },
  ];

  const nothingAtAll = !filtered && list.data !== undefined && rows.length === 0;

  return (
    <div className="grid gap-6">
      <PageHead
        title={t('members.title')}
        intro={t('members.list.intro')}
        actions={
          <>
            {/* ---- Komunitas K2 (members extended): the member list report, which exports it (personal data) ---- */}
            {holds(me, 'members.export.run') && (
              <Button asChild variant="outline">
                <Link to={`/admin/reports/${encodeURIComponent('members.list')}`}>{t('members.tools.export')}</Link>
              </Button>
            )}
            {canImport && (
              <Button asChild variant="outline">
                <Link to="/admin/anggota/impor">{t('members.import_csv')}</Link>
              </Button>
            )}
            {canManage && (
              <Button asChild>
                <Link to="/admin/anggota/baru">{t('members.add')}</Link>
              </Button>
            )}
          </>
        }
      />
      <form noValidate onSubmit={apply} aria-label={t('members.filters')} data-slot="filter-row" className={FILTER_ROW}>
        <Field label={t('members.filter.search')} className="sm:col-span-2 lg:col-span-1">
          {(c) => (
            <Input
              {...c}
              type="search"
              autoComplete="off"
              maxLength={191}
              placeholder={t('members.filter.search_placeholder')}
              value={draft.q}
              onChange={(e) => setDraft({ ...draft, q: e.target.value })}
            />
          )}
        </Field>
        <Field id={`${ids}-type`} label={t('members.filter.type')}>
          <select id={`${ids}-type`} className={SELECT_CLASS} value={draft.typeId} onChange={(e) => pick({ ...draft, typeId: e.target.value })}>
            <option value="">{t('members.filter.all_types')}</option>
            {(types.data?.items ?? []).map((type) => (
              <option key={type.id} value={type.id}>
                {typeName(type)}
              </option>
            ))}
          </select>
        </Field>
        <Field id={`${ids}-class`} label={t('members.filter.class')}>
          <select id={`${ids}-class`} className={SELECT_CLASS} value={draft.className} onChange={(e) => pick({ ...draft, className: e.target.value })}>
            <option value="">{t('members.filter.all_classes')}</option>
            {/* A class typed before the list came, or no longer held by a live member, stays selectable. */}
            {[...new Set([...(classes.data?.items ?? []), ...(draft.className === '' ? [] : [draft.className])])].map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </Field>
        <Field id={`${ids}-status`} label={t('members.filter.status')}>
          <select id={`${ids}-status`} className={SELECT_CLASS} value={draft.status} onChange={(e) => pick({ ...draft, status: e.target.value as MemberStatus | '' })}>
            <option value="">{t('members.filter.all_but_archived')}</option>
            {MEMBER_STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`vocab.member_status.${s}`)}
              </option>
            ))}
          </select>
        </Field>
        {/* Enter in a typed filter applies it at once. */}
        <button type="submit" className="sr-only" tabIndex={-1}>
          {t('members.filter.apply')}
        </button>
      </form>
      {list.isError && list.data === undefined ? (
        <Callout
          tone="bad"
          role="alert"
          title={t('members.list.failed')}
          action={
            <Button variant="outline" size="sm" className="bg-background" onClick={() => void list.refetch()}>
              {t('table.retry')}
            </Button>
          }>
          <p>{problemText(t, list.error)}</p>
        </Callout>
      ) : list.data === undefined ? (
        <SkeletonTable label={t('shell.loading')} />
      ) : nothingAtAll ? (
        <section aria-labelledby={`${ids}-empty`} className="grid max-w-[62ch] gap-3 py-6">
          <h2 id={`${ids}-empty`} className="text-heading font-semibold">
            {t('members.empty_all')}
          </h2>
          <p className="text-sm text-muted-foreground">{t('members.empty_all_hint')}</p>
          <div className="flex flex-wrap gap-2">
            {canManage && (
              <Button asChild>
                <Link to="/admin/anggota/baru">{t('members.add')}</Link>
              </Button>
            )}
            {canImport && (
              <Button asChild variant="outline">
                <Link to="/admin/anggota/impor">{t('members.import_csv')}</Link>
              </Button>
            )}
            {canTypes && (
              <Button asChild variant="ghost">
                <Link to="/admin/anggota/tipe">{t('members.list.set_types')}</Link>
              </Button>
            )}
          </div>
        </section>
      ) : (
        <div className="grid gap-3">
          {(canManage || selection.size > 0) && <BulkBar selected={[...selection.values()]} canManage={canManage} onClear={() => setSelection(new Map())} />}
          {notice !== null && <Notice kind="success">{notice}</Notice>}
          {refused !== null && (
            <Callout
              tone="bad"
              role="alert"
              title={refused.openLoans > 0 ? t('members.archive.refused_title', { name: refused.name, count: refused.openLoans }) : t('error.MEMBER_IN_USE')}
              action={
                canServe ? (
                  <Button asChild size="sm" variant="outline" className="bg-background">
                    <Link to={`/admin/layanan?member=${encodeURIComponent(refused.id)}`}>{t('members.action.serve_desk')}</Link>
                  </Button>
                ) : undefined
              }>
              <p>{t('members.archive.refused_body')}</p>
            </Callout>
          )}
          <DenseTable
            caption={t('members.caption')}
            columns={columns}
            rows={rows}
            rowKey={(r) => r.id}
            rowClassName={(r) => (selection.has(r.id) ? 'bg-accent-soft' : undefined)}
            empty={
              <span className="flex flex-wrap items-center gap-2">
                {t('members.empty_filtered')}
                <Button type="button" variant="link" className="h-auto p-0" onClick={clear}>
                  {t('members.filter.clear')}
                </Button>
              </span>
            }
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-muted-foreground">
              {t(list.hasNextPage ? 'members.list.shown_more' : 'members.list.shown_all', { count: rows.length })}
              {filtered && rows.length > 0 && (
                <>
                  {' '}
                  <Button type="button" variant="link" className="h-auto p-0 text-sm" onClick={clear}>
                    {t('members.filter.clear')}
                  </Button>
                </>
              )}
            </p>
            {list.hasNextPage && (
              <Button variant="outline" size="sm" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                {t('circulation.load_more')}
              </Button>
            )}
          </div>
        </div>
      )}
      {archiving !== null && (
        <ConfirmDialog
          open
          destructive
          title={t('members.archive.title', { name: archiving.name })}
          description={t('members.archive.body')}
          confirmLabel={t('members.action.archive_confirm')}
          onConfirm={() => archive(archiving)}
          onClose={() => setArchiving(null)}
        />
      )}
    </div>
  );
}

/** The days from `from` to `to` (calendar dates), or null when either is not one. */
function daysFrom(from: string, to: string): number | null {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Number.isNaN(a) || Number.isNaN(b) ? null : Math.round((b - a) / 86_400_000);
}
