import type { BranchListResponse } from '@altis/shared/api/branches';
import type { LoanListItem, LoanListResponse } from '@altis/shared/api/circulation';
import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useId, useState, type FormEvent } from 'react';
import { Badge, Field, Notice, SELECT_CLASS } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useT } from '@/i18n';
import { holds } from '@/lib/access';
import { api } from '@/lib/api';
import { problemText } from '@/lib/form-errors';
import { useApiQuery, useMe } from '@/lib/me';
import { MasterTable, type MasterColumn } from '@/screens/catalog/masters/master-table';
import { useCalendarDate, useMemberTypes, useTypeName } from './common';

/**
 * Terlambat & Jatuh Tempo (`/admin/layanan/terlambat`): the open loans past their due date, the longest-overdue first
 * (by due date), with the member, the item, the due date and the days late (amber up to two weeks, red beyond). Filters:
 * member type, branch and the fewest days late; they go in the request's query string, which never carries a personal
 * value (a member is named by id). "Layani" opens the member at the desk. The list comes a page at a time and the API
 * gives no total, so while more pages remain the summary says it counts the loans loaded so far.
 */

const LATE_RED_AFTER_DAYS = 14;

interface Filters {
  memberTypeId: string;
  branchId: string;
  minDaysLate: string;
}

const NO_FILTERS: Filters = { memberTypeId: '', branchId: '', minDaysLate: '' };

function listPath(f: Filters, cursor: string | null): string {
  const q = new URLSearchParams({ state: 'overdue', limit: '50' });
  if (f.memberTypeId !== '') q.set('memberTypeId', f.memberTypeId);
  if (f.branchId !== '') q.set('branchId', f.branchId);
  if (/^\d{1,5}$/.test(f.minDaysLate) && Number(f.minDaysLate) >= 1) q.set('minDaysLate', f.minDaysLate);
  if (cursor !== null) q.set('cursor', cursor);
  return `circulation/loans?${q.toString()}`;
}

export function OverdueScreen() {
  const t = useT();
  const me = useMe();
  const day = useCalendarDate();
  const typeName = useTypeName();
  const ids = useId();
  const types = useMemberTypes(true);
  const branches = useApiQuery<BranchListResponse>({ queryKey: ['branches', { includeArchived: false }], path: 'branches', staleTime: 60_000 });
  const [draft, setDraft] = useState<Filters>(NO_FILTERS);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const canServe = holds(me, 'circulation.desk.use') || Object.values(me?.authenticated === true ? me.branchPermissions : {}).some((p) => p.includes('circulation.desk.use'));
  const canOpenMember = holds(me, 'members.records.read');

  const list = useInfiniteQuery({
    queryKey: ['circulation', 'loans', 'overdue', filters],
    queryFn: ({ pageParam }) => api<LoanListResponse>('GET', listPath(filters, pageParam)),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    placeholderData: keepPreviousData,
    enabled: me !== undefined,
  });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  const members = new Set(rows.map((r) => r.member?.id ?? r.id)).size;
  const longest = rows.reduce((max, r) => Math.max(max, r.daysLate), 0);
  const filtered = filters.memberTypeId !== '' || filters.branchId !== '' || filters.minDaysLate !== '';

  const apply = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setFilters(draft);
  };

  const typeOf = (id: string): string => {
    const type = types.data?.items.find((x) => x.id === id);
    return type === undefined ? '' : typeName(type);
  };
  const branchCode = (id: string): string => branches.data?.items.find((b) => b.id === id)?.code ?? '';

  const columns: MasterColumn<LoanListItem>[] = [
    {
      id: 'member',
      header: t('circulation.col.borrower'),
      cell: (row) =>
        row.member === null ? (
          <span className="text-muted-foreground">{t('circulation.overdue.anonymous')}</span>
        ) : (
          <div>
            {canOpenMember ? (
              <Link to={`/admin/anggota/${encodeURIComponent(row.member.id)}`} className="font-medium text-primary underline-offset-4 hover:underline">
                {row.member.name}
              </Link>
            ) : (
              <span className="font-medium">{row.member.name}</span>
            )}
            <p className="text-xs text-muted-foreground">
              <span className="font-mono">{row.member.memberNo}</span>
              {row.member.className !== null && ` · ${row.member.className}`}
              {typeOf(row.member.typeId) !== '' && ` · ${typeOf(row.member.typeId)}`}
            </p>
          </div>
        ),
    },
    {
      id: 'item',
      header: t('circulation.col.item'),
      cell: (row) => (
        <div>
          <p className="font-medium">{row.record?.title ?? '—'}</p>
          <p className="font-mono text-xs text-muted-foreground">
            {row.item?.barcode ?? '—'}
            {branchCode(row.branchId) !== '' && ` · ${branchCode(row.branchId)}`}
          </p>
        </div>
      ),
    },
    { id: 'due', header: t('circulation.col.due'), className: 'whitespace-nowrap', cell: (row) => day(row.dueOn) },
    {
      id: 'late',
      header: t('circulation.col.late'),
      cell: (row) => <Badge tone={row.daysLate > LATE_RED_AFTER_DAYS ? 'danger' : 'warning'}>{t('circulation.due.late', { count: row.daysLate })}</Badge>,
    },
    ...(canServe
      ? [
          {
            id: 'actions',
            header: t('table.actions'),
            cell: (row: LoanListItem) =>
              row.member === null ? null : (
                <Button asChild size="sm" variant="outline">
                  <Link to={`/admin/layanan?member=${encodeURIComponent(row.member.id)}`}>{t('circulation.overdue.serve')}</Link>
                </Button>
              ),
          },
        ]
      : []),
  ];

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">{t('nav.circulation.overdue')}</h1>
      <form noValidate onSubmit={apply} className="grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-4" aria-label={t('circulation.overdue.filters')}>
        <Field id={`${ids}-type`} label={t('circulation.overdue.type')}>
          <select id={`${ids}-type`} className={SELECT_CLASS} value={draft.memberTypeId} onChange={(e) => setDraft({ ...draft, memberTypeId: e.target.value })}>
            <option value="">{t('circulation.overdue.all_types')}</option>
            {(types.data?.items ?? []).map((type) => (
              <option key={type.id} value={type.id}>
                {typeName(type)}
              </option>
            ))}
          </select>
        </Field>
        <Field id={`${ids}-branch`} label={t('circulation.overdue.branch')}>
          <select id={`${ids}-branch`} className={SELECT_CLASS} value={draft.branchId} onChange={(e) => setDraft({ ...draft, branchId: e.target.value })}>
            <option value="">{t('circulation.overdue.all_branches')}</option>
            {(branches.data?.items ?? []).map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('circulation.overdue.min_days')}>
          {(c) => <Input {...c} inputMode="numeric" autoComplete="off" value={draft.minDaysLate} onChange={(e) => setDraft({ ...draft, minDaysLate: e.target.value })} />}
        </Field>
        <div className="flex items-end gap-2">
          <Button type="submit">{t('circulation.overdue.apply')}</Button>
          {filtered && (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setDraft(NO_FILTERS);
                setFilters(NO_FILTERS);
              }}>
              {t('circulation.overdue.clear')}
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
      ) : (
        <>
          {rows.length > 0 && (
            <p className="text-sm text-muted-foreground">
              {t(list.hasNextPage ? 'circulation.overdue.summary_loaded' : 'circulation.overdue.summary', { loans: rows.length, members, days: longest })}
            </p>
          )}
          <MasterTable
            caption={t('circulation.overdue.caption')}
            columns={columns}
            rows={rows}
            empty={t(filtered ? 'circulation.overdue.empty_filtered' : 'circulation.overdue.empty')}
          />
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
