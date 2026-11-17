import type { BranchListResponse } from '@altis/shared/api/branches';
import type { LoanListItem, LoanListResponse } from '@altis/shared/api/circulation';
import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { Field, SELECT_CLASS } from '@/components/form-field';
import { Callout, DenseTable, FILTER_ROW, PageHead, SkeletonTable, StatusText, type DenseColumn } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useT } from '@/i18n';
import { holds } from '@/lib/access';
import { api } from '@/lib/api';
import { problemText } from '@/lib/form-errors';
import { useApiQuery, useMe } from '@/lib/me';
import { useCalendarDate, useMemberTypes, useTypeName } from './common';
// ---- Komunitas (charges and payments) ----
import { useMoney } from './charges';
// ---- Komunitas (member, visit and circulation reports) ----
import { ReportLinks } from '@/screens/reports/report-links';
// ---- Komunitas (notices) ----
import { SendRemindersButton } from './notices';

/**
 * Terlambat & Jatuh Tempo (`/admin/layanan/terlambat`): the open loans past their due date, grouped by member (a head
 * row with the name, number, type and class, and "Layani", which opens the member at the desk), the member with the
 * longest-overdue loan first, then one row per item: barcode, title, loaned and due dates and the days late as a number
 * in words, amber up to two weeks and red beyond. The labelled filters (member type, branch, the fewest days late) sit
 * in one row and apply as they change; they go in the request's query string, which never carries a personal value. The
 * list comes a page at a time and the API gives no total, so while more pages remain the summary says it counts the
 * loans loaded so far.
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
  const money = useMoney();
  const typeName = useTypeName();
  const ids = useId();
  const types = useMemberTypes(true);
  const branches = useApiQuery<BranchListResponse>({ queryKey: ['branches', { includeArchived: false }], path: 'branches', staleTime: 60_000 });
  const [draft, setDraft] = useState<Filters>(NO_FILTERS);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const canServe = holds(me, 'circulation.desk.use') || Object.values(me?.authenticated === true ? me.branchPermissions : {}).some((p) => p.includes('circulation.desk.use'));
  const canOpenMember = holds(me, 'members.records.read');

  // The typed number applies a moment after the last key; the lists at once.
  useEffect(() => {
    if (draft.minDaysLate === filters.minDaysLate) return;
    const id = setTimeout(() => setFilters((f) => ({ ...f, minDaysLate: draft.minDaysLate })), 400);
    return () => clearTimeout(id);
  }, [draft.minDaysLate, filters.minDaysLate]);

  const list = useInfiniteQuery({
    queryKey: ['circulation', 'loans', 'overdue', filters],
    queryFn: ({ pageParam }) => api<LoanListResponse>('GET', listPath(filters, pageParam)),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    placeholderData: keepPreviousData,
    enabled: me !== undefined,
  });
  const loaded = list.data?.pages.flatMap((p) => p.items) ?? [];
  const rows = groupByMember(loaded);
  const members = new Set(loaded.map((r) => r.member?.id ?? r.id)).size;
  const longest = loaded.reduce((max, r) => Math.max(max, r.daysLate), 0);
  const filtered = filters.memberTypeId !== '' || filters.branchId !== '' || filters.minDaysLate !== '';

  const apply = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setFilters(draft);
  };
  const pick = (next: Filters): void => {
    setDraft(next);
    setFilters(next);
  };

  const typeOf = (id: string): string => {
    const type = types.data?.items.find((x) => x.id === id);
    return type === undefined ? '' : typeName(type);
  };
  const branchCode = (id: string): string => branches.data?.items.find((b) => b.id === id)?.code ?? '';

  const groupHead = (row: LoanListItem) => {
    const m = row.member;
    if (m === null) return <span className="text-muted-foreground">{t('circulation.overdue.anonymous')}</span>;
    const memberLoans = loaded.filter((r) => r.member?.id === m.id);
    return (
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <span className="min-w-0">
          {canOpenMember ? (
            <Link to={`/admin/anggota/${encodeURIComponent(m.id)}`} className="font-semibold text-accent-text underline-offset-4 hover:underline">
              {m.name}
            </Link>
          ) : (
            <span className="font-semibold">{m.name}</span>
          )}{' '}
          <span className="text-sm text-muted-foreground">
            <span className="font-semibold tracking-wide tabular-nums">{m.memberNo}</span>
            {typeOf(m.typeId) !== '' && ` · ${typeOf(m.typeId)}`}
            {m.className !== null && `, ${m.className}`}
          </span>
        </span>
        <span className="flex flex-wrap items-center gap-2">
          {/* ---- Komunitas (notices) ---- */}
          <SendRemindersButton loans={memberLoans.map((r) => ({ branchId: r.branchId, memberId: m.id }))} label="notices.send.overdue" />
          {canServe && (
            <Button asChild size="sm" variant="outline" className="bg-background">
              <Link to={`/admin/layanan?member=${encodeURIComponent(m.id)}`} aria-label={t('members.action.serve_named', { name: m.name })}>
                {t('circulation.overdue.serve')}
              </Link>
            </Button>
          )}
        </span>
      </div>
    );
  };

  const columns: DenseColumn<LoanListItem>[] = [
    {
      id: 'barcode',
      header: t('circulation.col.barcode'),
      className: 'whitespace-nowrap',
      cell: (row) => (
        <span className="grid">
          <span className="font-semibold tracking-wide">{row.item?.barcode ?? '—'}</span>
          {branchCode(row.branchId) !== '' && <span className="text-xs text-muted-foreground">{branchCode(row.branchId)}</span>}
        </span>
      ),
    },
    { id: 'title', header: t('circulation.col.title'), cell: (row) => row.record?.title ?? '—' },
    { id: 'loaned', header: t('circulation.col.loaned'), className: 'whitespace-nowrap', cell: (row) => day(row.loanedOn) },
    { id: 'due', header: t('circulation.col.due'), className: 'whitespace-nowrap', cell: (row) => day(row.dueOn) },
    {
      id: 'late',
      header: t('circulation.member.overdue'),
      headClassName: 'text-right',
      className: 'text-right whitespace-nowrap',
      cell: (row) => (
        <span className="grid justify-items-end">
          <StatusText tone={row.daysLate > LATE_RED_AFTER_DAYS ? 'bad' : 'warn'}>{t('circulation.fact.days', { count: row.daysLate })}</StatusText>
          {row.finePreview !== null && (
            <span className="text-xs text-bad">{t('charges.fine_preview', { amount: money(row.finePreview.amount, row.finePreview.currency), days: row.finePreview.days })}</span>
          )}
        </span>
      ),
    },
  ];

  return (
    <div className="grid gap-6">
      <PageHead
        title={t('nav.circulation.overdue')}
        intro={t('circulation.overdue.intro')}
        actions={
          /* ---- Komunitas (notices): an overdue reminder for every member shown ---- */
          loaded.length > 0 ? <SendRemindersButton loans={loaded.map((r) => ({ branchId: r.branchId, memberId: r.member?.id ?? null }))} label="notices.send.overdue_all" /> : undefined
        }
      />
      <ReportLinks reports={[{ id: 'circulation.overdue', permission: 'circulation.records.read' }, { id: 'circulation.due_soon', permission: 'circulation.records.read' }]} />
      <form noValidate onSubmit={apply} className={FILTER_ROW} aria-label={t('circulation.overdue.filters')}>
        <Field id={`${ids}-type`} label={t('circulation.overdue.type')}>
          <select id={`${ids}-type`} className={SELECT_CLASS} value={draft.memberTypeId} onChange={(e) => pick({ ...draft, memberTypeId: e.target.value })}>
            <option value="">{t('circulation.overdue.all_types')}</option>
            {(types.data?.items ?? []).map((type) => (
              <option key={type.id} value={type.id}>
                {typeName(type)}
              </option>
            ))}
          </select>
        </Field>
        <Field id={`${ids}-branch`} label={t('circulation.overdue.branch')}>
          <select id={`${ids}-branch`} className={SELECT_CLASS} value={draft.branchId} onChange={(e) => pick({ ...draft, branchId: e.target.value })}>
            <option value="">{t('circulation.overdue.all_branches')}</option>
            {(branches.data?.items ?? []).map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('circulation.overdue.min_days')}>
          {(c) => <Input {...c} inputMode="numeric" autoComplete="off" placeholder="0" value={draft.minDaysLate} onChange={(e) => setDraft({ ...draft, minDaysLate: e.target.value })} />}
        </Field>
        <div className="flex items-end gap-2 pb-1.5">
          {/* Enter in the number applies it at once. */}
          <button type="submit" className="sr-only" tabIndex={-1}>
            {t('circulation.overdue.apply')}
          </button>
          {filtered && (
            <Button type="button" variant="link" className="h-auto p-0" onClick={() => pick(NO_FILTERS)}>
              {t('circulation.overdue.clear')}
            </Button>
          )}
        </div>
      </form>
      {list.isError && list.data === undefined ? (
        <Callout
          tone="bad"
          role="alert"
          title={t('circulation.overdue.failed')}
          action={
            <Button variant="outline" size="sm" className="bg-background" onClick={() => void list.refetch()}>
              {t('table.retry')}
            </Button>
          }>
          <p>{problemText(t, list.error)}</p>
        </Callout>
      ) : list.data === undefined ? (
        <SkeletonTable label={t('shell.loading')} columns={5} rows={5} />
      ) : rows.length === 0 ? (
        <div className="grid gap-1 py-4">
          <p className="font-bold">{t(filtered ? 'circulation.overdue.empty_filtered' : 'circulation.overdue.empty')}</p>
          <p className="text-sm text-muted-foreground">{t(filtered ? 'circulation.overdue.empty_filtered_hint' : 'circulation.overdue.empty_hint')}</p>
        </div>
      ) : (
        <div className="grid gap-3">
          <p className="text-sm text-muted-foreground">
            {t(list.hasNextPage ? 'circulation.overdue.summary_loaded' : 'circulation.overdue.summary', { loans: loaded.length, members, days: longest })}
          </p>
          <DenseTable
            caption={t('circulation.overdue.caption')}
            columns={columns}
            rows={rows}
            rowKey={(r) => r.id}
            empty={t('circulation.overdue.empty')}
            groupOf={(r) => r.member?.id ?? 'anonymous'}
            groupHead={groupHead}
          />
          {list.hasNextPage && (
            <Button variant="outline" size="sm" className="w-fit" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
              {t('circulation.load_more')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The loans grouped by member, in the order each member first appears (the list comes oldest due date first, so the
 * member with the longest-overdue loan leads); within a member, the order of the list. Anonymised loans form one group.
 */
export function groupByMember(rows: readonly LoanListItem[]): LoanListItem[] {
  const groups = new Map<string, LoanListItem[]>();
  for (const r of rows) {
    const key = r.member?.id ?? 'anonymous';
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [r]);
    else list.push(r);
  }
  return [...groups.values()].flat();
}
