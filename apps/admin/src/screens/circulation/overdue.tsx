import type { BranchListResponse } from '@altis/shared/api/branches';
import { DUE_SOON_DAYS, type LoanClassesResponse, type LoanListItem, type LoanListResponse, type LoanSearchBody } from '@altis/shared/api/circulation';
import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';
import { Link, useSearch } from '@tanstack/react-router';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { SELECT_CLASS } from '@/components/form-field';
import { DenseTable, ErrorState, FilterField, FilterRow, PageHead, SkeletonTable, StatusText, type DenseColumn } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger, WRAPPING_TABS } from '@/components/ui/tabs';
import { useT } from '@/i18n';
import { holds } from '@/lib/access';
import { api } from '@/lib/api';
import { useApiQuery, useMe } from '@/lib/me';
import { DueBadge, useCalendarDate, useMemberTypes, useTypeName } from './common';
// ---- Komunitas (charges and payments) ----
import { useMoney } from './charges';
// ---- Komunitas (member, visit and circulation reports) ----
import { ReportLinks } from '@/screens/reports/report-links';
// ---- Komunitas (notices) ----
import { SendRemindersButton } from './notices';

/**
 * Terlambat & Jatuh Tempo (`/admin/layanan/terlambat`), two tabs over the open loans: **Terlambat** (past their due date)
 * and **Jatuh tempo** (due from today to three days ahead), each in its own branch's calendar. The labelled filters sit
 * in one row: Cari (the member's number or name), Kelas (for a class teacher), Tipe, Cabang (with more than one) and, on
 * the overdue tab, the fewest days late; the lists apply at once, the typed ones a moment after the last key or with
 * Enter. The list is read on the server a page at a time, through a POST read (a name never goes in a URL), grouped by
 * member: a head row with the name, number, type and class, the phone for a user who may also read member records, and
 * "Layani", which opens the member at the desk; the member with the oldest due date first, then one row per item:
 * barcode, title, loaned and due dates, and the days late (amber up to two weeks, red beyond) or the days left. The API
 * gives no total, so while more pages remain the summary says it counts the loans loaded so far. Overdue reminders are
 * sent from the overdue tab only.
 */

const LATE_RED_AFTER_DAYS = 14;

type Tab = LoanSearchBody['tab'];

interface Filters {
  q: string;
  className: string;
  memberTypeId: string;
  branchId: string;
  minDaysLate: string;
}

const NO_FILTERS: Filters = { q: '', className: '', memberTypeId: '', branchId: '', minDaysLate: '' };

function searchBody(tab: Tab, f: Filters, cursor: string | null): LoanSearchBody {
  const body: LoanSearchBody = { tab, limit: 50 };
  if (f.q.trim() !== '') body.q = f.q.trim();
  if (f.className !== '') body.className = f.className;
  if (f.memberTypeId !== '') body.memberTypeId = f.memberTypeId;
  if (f.branchId !== '') body.branchId = f.branchId;
  if (tab === 'overdue' && /^\d{1,5}$/.test(f.minDaysLate) && Number(f.minDaysLate) >= 1) body.minDaysLate = Number(f.minDaysLate);
  if (cursor !== null) body.cursor = cursor;
  return body;
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
  const classes = useApiQuery<LoanClassesResponse>({ queryKey: ['circulation', 'loans', 'classes'], path: 'circulation/loans/classes', staleTime: 60_000 });
  // Beranda's "due within two days" line opens the second tab (`?tab=due_soon`).
  const search = useSearch({ strict: false }) as { tab?: string };
  const [tab, setTab] = useState<Tab>(search.tab === 'due_soon' ? 'due_soon' : 'overdue');
  const [draft, setDraft] = useState<Filters>(NO_FILTERS);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const canServe = holds(me, 'circulation.desk.use') || Object.values(me?.authenticated === true ? me.branchPermissions : {}).some((p) => p.includes('circulation.desk.use'));
  const canOpenMember = holds(me, 'members.records.read');
  const overdue = tab === 'overdue';

  // The typed filters apply a moment after the last key; the lists at once (see `pick`).
  useEffect(() => {
    if (draft.q === filters.q && draft.minDaysLate === filters.minDaysLate) return;
    const id = setTimeout(() => setFilters((f) => ({ ...f, q: draft.q, minDaysLate: draft.minDaysLate })), 400);
    return () => clearTimeout(id);
  }, [draft.q, draft.minDaysLate, filters.q, filters.minDaysLate]);

  const list = useInfiniteQuery({
    queryKey: ['circulation', 'loans', 'search', tab, filters],
    queryFn: ({ pageParam }) => api<LoanListResponse>('POST', 'circulation/loans/search', searchBody(tab, filters, pageParam)),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    placeholderData: keepPreviousData,
    enabled: me !== undefined,
  });
  const loaded = list.data?.pages.flatMap((p) => p.items) ?? [];
  const rows = groupByMember(loaded);
  const members = new Set(loaded.map((r) => r.member?.id ?? r.id)).size;
  const longest = loaded.reduce((max, r) => Math.max(max, r.daysLate), 0);
  const filtered = filters.q.trim() !== '' || filters.className !== '' || filters.memberTypeId !== '' || filters.branchId !== '' || (overdue && filters.minDaysLate !== '');

  const apply = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setFilters(draft);
  };
  const pick = (next: Filters): void => {
    setDraft(next);
    setFilters(next);
  };
  const clear = (): void => pick(NO_FILTERS);

  const typeOf = (id: string): string => {
    const type = types.data?.items.find((x) => x.id === id);
    return type === undefined ? '' : typeName(type);
  };
  const branchCode = (id: string): string => branches.data?.items.find((b) => b.id === id)?.code ?? '';

  const groupHead = (row: LoanListItem) => {
    const m = row.member;
    if (m === null) return <span className="text-muted-foreground">{t('circulation.overdue.anonymous')}</span>;
    const memberLoans = loaded.filter((r) => r.member?.id === m.id);
    const facts = [typeOf(m.typeId), m.className ?? '', m.phone ?? ''].filter((x) => x !== '');
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
          <span className="text-meta text-muted-foreground">
            <span className="font-semibold tracking-wide tabular-nums">{m.memberNo}</span>
            {facts.length > 0 && ` · ${facts.join(' · ')}`}
          </span>
        </span>
        <span className="flex flex-wrap items-center gap-2">
          {/* ---- Komunitas (notices): overdue reminders only ---- */}
          {overdue && <SendRemindersButton loans={memberLoans.map((r) => ({ branchId: r.branchId, memberId: m.id }))} label="notices.send.overdue" />}
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
    overdue
      ? {
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
        }
      : {
          id: 'left',
          header: t('circulation.overdue.col.left'),
          headClassName: 'text-right',
          className: 'text-right whitespace-nowrap',
          cell: (row) => <DueBadge dueOn={row.dueOn} daysLate={row.daysLate} />,
        },
  ];

  return (
    <div className="grid gap-6">
      <PageHead
        title={t('nav.circulation.overdue')}
        intro={t('circulation.overdue.intro_tabs')}
        actions={
          /* ---- Komunitas (notices): an overdue reminder for every member shown ---- */
          overdue && loaded.length > 0 ? (
            <SendRemindersButton loans={loaded.map((r) => ({ branchId: r.branchId, memberId: r.member?.id ?? null }))} label="notices.send.overdue_all" />
          ) : undefined
        }
      />
      <ReportLinks reports={[{ id: 'circulation.overdue', permission: 'circulation.records.read' }, { id: 'circulation.due_soon', permission: 'circulation.records.read' }]} />
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList className={WRAPPING_TABS.list} aria-label={t('circulation.overdue.tabs')}>
          <TabsTrigger value="overdue" className={WRAPPING_TABS.trigger}>
            {t('circulation.overdue.tab.overdue')}
          </TabsTrigger>
          <TabsTrigger value="due_soon" className={WRAPPING_TABS.trigger}>
            {t('circulation.overdue.tab.due_soon', { days: DUE_SOON_DAYS })}
          </TabsTrigger>
        </TabsList>
      </Tabs>
      <FilterRow
        label={t('circulation.overdue.filters')}
        onSubmit={apply}
        actions={
          filtered ? (
            <Button type="button" variant="link" className="h-auto p-0" onClick={clear}>
              {t('circulation.overdue.clear')}
            </Button>
          ) : undefined
        }>
        <FilterField wide label={t('circulation.overdue.search')}>
          {(c) => (
            <Input
              {...c}
              type="search"
              autoComplete="off"
              maxLength={191}
              placeholder={t('circulation.overdue.search_placeholder')}
              value={draft.q}
              onChange={(e) => setDraft({ ...draft, q: e.target.value })}
            />
          )}
        </FilterField>
        <FilterField id={`${ids}-class`} label={t('members.filter.class')}>
          <select id={`${ids}-class`} className={SELECT_CLASS} value={draft.className} onChange={(e) => pick({ ...draft, className: e.target.value })}>
            <option value="">{t('members.filter.all_classes')}</option>
            {(classes.data?.items ?? []).map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </FilterField>
        <FilterField id={`${ids}-type`} label={t('circulation.overdue.type')}>
          <select id={`${ids}-type`} className={SELECT_CLASS} value={draft.memberTypeId} onChange={(e) => pick({ ...draft, memberTypeId: e.target.value })}>
            <option value="">{t('circulation.overdue.all_types')}</option>
            {(types.data?.items ?? []).map((type) => (
              <option key={type.id} value={type.id}>
                {typeName(type)}
              </option>
            ))}
          </select>
        </FilterField>
        {(branches.data?.items.length ?? 0) > 1 && (
          <FilterField id={`${ids}-branch`} label={t('circulation.overdue.branch')}>
            <select id={`${ids}-branch`} className={SELECT_CLASS} value={draft.branchId} onChange={(e) => pick({ ...draft, branchId: e.target.value })}>
              <option value="">{t('circulation.overdue.all_branches')}</option>
              {(branches.data?.items ?? []).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </FilterField>
        )}
        {overdue && (
          <FilterField label={t('circulation.overdue.min_days')}>
            {(c) => <Input {...c} inputMode="numeric" autoComplete="off" placeholder="0" value={draft.minDaysLate} onChange={(e) => setDraft({ ...draft, minDaysLate: e.target.value })} />}
          </FilterField>
        )}
      </FilterRow>
      {list.isError && list.data === undefined ? (
        <ErrorState title={t('circulation.overdue.failed')} error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />
      ) : list.data === undefined ? (
        <SkeletonTable label={t('shell.loading')} columns={5} rows={5} />
      ) : rows.length === 0 ? (
        <div className="grid gap-1 py-4">
          <p className="font-bold">
            {overdue
              ? t(filtered ? 'circulation.overdue.empty_filtered' : 'circulation.overdue.empty')
              : t(filtered ? 'circulation.overdue.soon_empty_filtered' : 'circulation.overdue.soon_empty', { days: DUE_SOON_DAYS })}
          </p>
          {filtered ? (
            <Button type="button" variant="link" className="h-auto w-fit p-0 text-sm" onClick={clear}>
              {t('circulation.overdue.clear')}
            </Button>
          ) : (
            <p className="text-sm text-muted-foreground">{t('circulation.overdue.empty_hint')}</p>
          )}
        </div>
      ) : (
        <div className="grid gap-3">
          <p className="text-sm text-muted-foreground">
            {overdue
              ? t(list.hasNextPage ? 'circulation.overdue.summary_loaded' : 'circulation.overdue.summary', { loans: loaded.length, members, days: longest })
              : t(list.hasNextPage ? 'circulation.overdue.soon_summary_loaded' : 'circulation.overdue.soon_summary', { loans: loaded.length, members })}
          </p>
          <DenseTable
            caption={t(overdue ? 'circulation.overdue.caption' : 'circulation.overdue.soon_caption')}
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
