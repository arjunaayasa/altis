import { VISIT_PURPOSES, VISIT_SOURCES, type Permission, type VisitPurpose, type VisitSource } from '@altis/shared';
import type { BranchListResponse, BranchView } from '@altis/shared/api/branches';
import type { LocationListResponse } from '@altis/shared/api/catalog/locations';
import type {
  StationCodeResponse,
  StationListResponse,
  StationView,
  VisitCheckinResponse,
  VisitCreateResponse,
  VisitListResponse,
  VisitSummary,
  VisitView,
} from '@altis/shared/api/visits';
import { keepPreviousData, useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useMemo, useState, type FormEvent } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Field, Notice, ProblemAlert, SELECT_CLASS } from '@/components/form-field';
import { Callout, DenseTable, ErrorState, FilterField, FilterRow, PageHead, Section, SectionHead, SkeletonTable, StatStrip, Tag, type DenseColumn, type TagTone } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useLocale, useT } from '@/i18n';
import { holds, holdsAt } from '@/lib/access';
import { api } from '@/lib/api';
import { isWritableBranch } from '@/lib/branches';
import { useApiQuery, useMe } from '@/lib/me';
import { readStored, todayLocal, writeStored } from '@/screens/circulation/common';
// ---- Komunitas (member, visit and circulation reports) ----
import { ReportLinks } from '@/screens/reports/report-links';

/**
 * Kunjungan (`/admin/layanan/kunjungan`): today's counts at a branch, a staff check-in (a member number or a guest),
 * a class or group visit with its head count (and how many of the class checked in on their own already), and the
 * visit list by date range and source, with "Batalkan" for a visit recorded by mistake. Perangkat Buku Tamu
 * (`/admin/layanan/buku-tamu`): the stations of a branch, a new one (in a room of the branch, or none) with its activation
 * code shown once, a new code, and revoking one. A station's room is what the visits it records are counted in, and
 * what the checklist of the move from SLiMS asks a station for (one per room SLiMS recorded visits in). The branch is chosen once and kept in this browser.
 */

const BRANCH_KEY = 'altis.visits-branch';

/** The branches where the user holds `permission`, and the chosen one (kept in this browser). */
function useBranchFor(permission: Permission): { branches: BranchView[] | undefined; branchId: string | null; choose(id: string): void } {
  const me = useMe();
  const query = useApiQuery<BranchListResponse>({ queryKey: ['branches', { includeArchived: false }], path: 'branches', staleTime: 60_000 });
  const [chosen, setChosen] = useState<string | null>(() => readStored(BRANCH_KEY));
  const branches = useMemo(() => query.data?.items.filter((b) => isWritableBranch(b) && holdsAt(me, permission, b.id)), [query.data, me, permission]);
  const branchId = useMemo(() => {
    if (branches === undefined || branches.length === 0) return null;
    if (chosen !== null && branches.some((b) => b.id === chosen)) return chosen;
    return (branches.find((b) => b.isDefault) ?? branches[0])!.id;
  }, [branches, chosen]);
  return {
    branches,
    branchId,
    choose: (id) => {
      setChosen(id);
      writeStored(BRANCH_KEY, id);
    },
  };
}

function BranchPicker({ branches, branchId, choose }: { branches: BranchView[]; branchId: string; choose(id: string): void }) {
  const t = useT();
  const id = useId();
  if (branches.length < 2) return null;
  return (
    <FilterRow label={t('visits.branch')}>
      <FilterField id={id} label={t('visits.branch')} className="max-w-xs">
        <select id={id} className={SELECT_CLASS} value={branchId} onChange={(e) => choose(e.target.value)}>
          {branches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </FilterField>
    </FilterRow>
  );
}

function useTime(): (ms: number) => string {
  const locale = useLocale();
  return useMemo(() => {
    const f = new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'id-ID', { dateStyle: 'medium', timeStyle: 'short' });
    return (ms) => f.format(ms);
  }, [locale]);
}

function Summary({ branchId }: { branchId: string }) {
  const t = useT();
  const summary = useApiQuery<VisitSummary>({ queryKey: ['visits', 'summary', branchId], path: `visits/summary?branchId=${encodeURIComponent(branchId)}` });
  const s = summary.data;
  return (
    <Section title={t('visits.today')}>
      <StatStrip
        label={t('visits.today')}
        items={[
          { key: 'total', label: t('visits.total'), value: s?.total ?? '—' },
          { key: 'members', label: t('visits.members'), value: s?.members ?? '—' },
          { key: 'guests', label: t('visits.guests'), value: s?.guests ?? '—' },
        ]}
      />
    </Section>
  );
}

function CheckinForm({ branchId }: { branchId: string }) {
  const t = useT();
  const ids = useId();
  const queryClient = useQueryClient();
  const [guest, setGuest] = useState(false);
  const [memberNo, setMemberNo] = useState('');
  const [name, setName] = useState('');
  const [institution, setInstitution] = useState('');
  const [purpose, setPurpose] = useState<VisitPurpose | ''>('');
  const [answer, setAnswer] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [problem, setProblem] = useState<unknown>(null);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setProblem(null);
    setAnswer(null);
    const body = {
      ...(guest ? { guest: { name: name.trim(), institution: institution.trim() } } : { memberNo: memberNo.trim() }),
      ...(purpose === '' ? {} : { purpose }),
    };
    try {
      const r = await api<VisitCheckinResponse>('POST', `branches/${encodeURIComponent(branchId)}/visits/checkin`, body);
      const who = r.firstName ?? '';
      if (r.outcome === 'unknown') setAnswer({ kind: 'error', text: t('visits.checkin.unknown') });
      else {
        const base = t(r.outcome === 'repeat' ? 'visits.checkin.repeat' : 'visits.checkin.recorded', { name: who });
        setAnswer({ kind: 'success', text: r.expired ? `${base} ${t('visits.checkin.expired')}` : base });
      }
      setMemberNo('');
      setName('');
      setInstitution('');
      await queryClient.invalidateQueries({ queryKey: ['visits'] });
    } catch (e) {
      setProblem(e);
    }
  };

  return (
    <form noValidate onSubmit={(e) => void submit(e)} aria-labelledby={`${ids}-title`} className="grid content-start gap-4">
      <SectionHead id={`${ids}-title`} title={t('visits.checkin.title')} />
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" className="size-4 accent-primary" checked={guest} onChange={(e) => setGuest(e.target.checked)} />
        {t('visits.checkin.as_guest')}
      </label>
      {guest ? (
        <>
          <Field label={t('visits.checkin.guest_name')}>{(c) => <Input {...c} maxLength={191} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
          <Field label={t('visits.checkin.guest_institution')}>
            {(c) => <Input {...c} maxLength={191} value={institution} onChange={(e) => setInstitution(e.target.value)} />}
          </Field>
        </>
      ) : (
        <Field label={t('visits.checkin.member_no')}>
          {(c) => <Input {...c} autoComplete="off" className="tracking-wide" maxLength={200} value={memberNo} onChange={(e) => setMemberNo(e.target.value)} />}
        </Field>
      )}
      <Field id={`${ids}-purpose`} label={t('visits.checkin.purpose')}>
        <select id={`${ids}-purpose`} className={SELECT_CLASS} value={purpose} onChange={(e) => setPurpose(e.target.value as VisitPurpose | '')}>
          <option value="">{t('visits.checkin.purpose_none')}</option>
          {VISIT_PURPOSES.map((p) => (
            <option key={p} value={p}>
              {t(`vocab.visit_purpose.${p}`)}
            </option>
          ))}
        </select>
      </Field>
      {answer !== null && <Notice kind={answer.kind}>{answer.text}</Notice>}
      <ProblemAlert error={problem} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit">{t('visits.checkin.submit')}</Button>
      </div>
    </form>
  );
}

function ClassVisitForm({ branchId }: { branchId: string }) {
  const t = useT();
  const ids = useId();
  const queryClient = useQueryClient();
  const [className, setClassName] = useState('');
  const [headcount, setHeadcount] = useState('');
  const [note, setNote] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const [problem, setProblem] = useState<unknown>(null);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setProblem(null);
    setDone(null);
    const count = Number(headcount.trim());
    try {
      const r = await api<VisitCreateResponse>('POST', `branches/${encodeURIComponent(branchId)}/visits`, {
        ...(className.trim() === '' ? {} : { className: className.trim() }),
        headcount: Number.isInteger(count) && count > 0 ? count : 1,
        ...(note.trim() === '' ? {} : { note: note.trim() }),
      });
      setDone(r.classCheckedIn > 0 ? `${t('visits.class.recorded')} ${t('visits.class.already', { count: r.classCheckedIn })}` : t('visits.class.recorded'));
      setClassName('');
      setHeadcount('');
      setNote('');
      await queryClient.invalidateQueries({ queryKey: ['visits'] });
    } catch (e) {
      setProblem(e);
    }
  };

  return (
    <form noValidate onSubmit={(e) => void submit(e)} aria-labelledby={`${ids}-title`} className="grid content-start gap-4">
      <SectionHead id={`${ids}-title`} title={t('visits.class.title')} />
      <Field label={t('visits.class.name')}>{(c) => <Input {...c} maxLength={64} value={className} onChange={(e) => setClassName(e.target.value)} />}</Field>
      <Field label={t('visits.class.headcount')}>{(c) => <Input {...c} inputMode="numeric" value={headcount} onChange={(e) => setHeadcount(e.target.value)} />}</Field>
      <Field label={t('visits.class.note')}>{(c) => <Input {...c} maxLength={191} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
      {done !== null && <Notice kind="success">{done}</Notice>}
      <ProblemAlert error={problem} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="outline">
          {t('visits.class.submit')}
        </Button>
      </div>
    </form>
  );
}

function VisitList({ branchId, canManage }: { branchId: string; canManage: boolean }) {
  const t = useT();
  const ids = useId();
  const time = useTime();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState({ from: todayLocal(), to: todayLocal(), source: '' as VisitSource | '' });
  const [filters, setFilters] = useState(draft);
  const [voiding, setVoiding] = useState<VisitView | null>(null);
  const list = useInfiniteQuery({
    queryKey: ['visits', 'list', branchId, filters],
    queryFn: ({ pageParam }) => {
      const q = new URLSearchParams({ branchId, from: filters.from, to: filters.to, limit: '50' });
      if (filters.source !== '') q.set('source', filters.source);
      if (pageParam !== null) q.set('cursor', pageParam);
      return api<VisitListResponse>('GET', `visits?${q.toString()}`);
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    placeholderData: keepPreviousData,
  });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];

  const who = (v: VisitView): string => {
    if (v.memberNo !== null) return `${v.memberNo} — ${v.memberName ?? ''}`;
    if (v.guestName !== null) return t('visits.guest_label', { name: v.guestName, institution: v.guestInstitution ?? '' });
    if (v.headcount > 1 || v.className !== null) return t('visits.group_label');
    return t('visits.anonymous');
  };

  const columns: DenseColumn<VisitView>[] = [
    { id: 'time', header: t('visits.col.time'), className: 'whitespace-nowrap', cell: (v) => time(v.visitedAt) },
    { id: 'who', header: t('visits.col.who'), cell: who },
    { id: 'class', header: t('visits.col.class'), cell: (v) => v.className ?? '—' },
    { id: 'source', header: t('visits.col.source'), cell: (v) => <Tag>{t(`vocab.visit_source.${v.source}`)}</Tag> },
    { id: 'purpose', header: t('visits.col.purpose'), cell: (v) => (v.purpose === null ? '—' : t(`vocab.visit_purpose.${v.purpose}`)) },
    { id: 'count', header: t('visits.col.count'), headClassName: 'text-right', className: 'text-right', cell: (v) => v.headcount },
    ...(canManage
      ? [
          {
            id: 'actions',
            header: <span className="sr-only">{t('table.actions')}</span>,
            className: 'w-px py-1.5 text-right whitespace-nowrap',
            cell: (v: VisitView) => (
              <Button size="sm" variant="ghost" aria-label={t('visits.void_named', { time: time(v.visitedAt) })} onClick={() => setVoiding(v)}>
                {t('visits.void')}
              </Button>
            ),
          },
        ]
      : []),
  ];

  return (
    <Section title={t('visits.list.title')}>
      <FilterRow
        label={t('visits.list.title')}
        onSubmit={(e) => {
          e.preventDefault();
          setFilters(draft);
        }}
        actions={
          <Button type="submit" variant="outline">
            {t('visits.list.apply')}
          </Button>
        }>
        <FilterField label={t('visits.list.from')}>{(c) => <Input {...c} type="date" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />}</FilterField>
        <FilterField label={t('visits.list.to')}>{(c) => <Input {...c} type="date" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />}</FilterField>
        <FilterField id={`${ids}-source`} label={t('visits.list.source')}>
          <select id={`${ids}-source`} className={SELECT_CLASS} value={draft.source} onChange={(e) => setDraft({ ...draft, source: e.target.value as VisitSource | '' })}>
            <option value="">{t('visits.list.all_sources')}</option>
            {VISIT_SOURCES.map((s) => (
              <option key={s} value={s}>
                {t(`vocab.visit_source.${s}`)}
              </option>
            ))}
          </select>
        </FilterField>
      </FilterRow>
      {list.isError && list.data === undefined ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />
      ) : list.data === undefined ? (
        <SkeletonTable label={t('shell.loading')} columns={canManage ? 7 : 6} rows={4} />
      ) : (
        <DenseTable caption={t('visits.list.title')} columns={columns} rows={rows} rowKey={(v) => v.id} empty={t('visits.list.empty')} />
      )}
      {list.hasNextPage && (
        <Button variant="outline" className="w-fit" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
          {t('visits.load_more')}
        </Button>
      )}
      {voiding !== null && (
        <ConfirmDialog
          open
          destructive
          title={t('visits.void_named', { time: time(voiding.visitedAt) })}
          description={who(voiding)}
          confirmLabel={t('visits.void')}
          onConfirm={async () => {
            await api('POST', `branches/${encodeURIComponent(branchId)}/visits/${encodeURIComponent(voiding.id)}/void`);
            await queryClient.invalidateQueries({ queryKey: ['visits'] });
          }}
          onClose={() => setVoiding(null)}
        />
      )}
    </Section>
  );
}

export function VisitsScreen() {
  const t = useT();
  const me = useMe();
  const { branches, branchId, choose } = useBranchFor('visits.records.manage');
  const allBranches = useApiQuery<BranchListResponse>({ queryKey: ['branches', { includeArchived: false }], path: 'branches', staleTime: 60_000 });
  const readable = holds(me, 'visits.records.read');
  // A reader without a branch of their own still reads the default branch's list.
  const readBranch = branchId ?? allBranches.data?.items.find((b) => b.isDefault)?.id ?? allBranches.data?.items[0]?.id ?? null;
  return (
    <div className="grid max-w-6xl gap-6">
      <PageHead title={t('visits.title')} />
      <ReportLinks reports={[{ id: 'visits.monthly', permission: 'reports.statistics.read' }, { id: 'visits.daily', permission: 'reports.statistics.read' }, { id: 'visits.list', permission: 'visits.records.read' }]} />
      {branches !== undefined && branchId !== null && <BranchPicker branches={branches} branchId={branchId} choose={choose} />}
      {readBranch !== null && readable && <Summary branchId={readBranch} />}
      {branchId !== null ? (
        <div className="grid gap-x-8 gap-y-6 lg:grid-cols-2">
          <CheckinForm branchId={branchId} />
          <ClassVisitForm branchId={branchId} />
        </div>
      ) : (
        branches !== undefined && !readable && <Notice kind="error">{t('visits.no_branch')}</Notice>
      )}
      {readBranch !== null && readable && <VisitList branchId={readBranch} canManage={branchId === readBranch} />}
    </div>
  );
}

// ---- stations ------------------------------------------------------------------------------------------------------

const STATION_TONE: Readonly<Record<'paired' | 'code' | 'unpaired' | 'revoked', TagTone>> = { paired: 'ok', code: 'warn', unpaired: 'warn', revoked: 'neutral' };

function stationState(s: StationView): 'paired' | 'code' | 'unpaired' | 'revoked' {
  if (s.revokedAt !== null) return 'revoked';
  if (s.paired) return 'paired';
  if (s.codeExpiresAt !== null) return 'code';
  return 'unpaired';
}

export function StationsScreen() {
  const t = useT();
  const time = useTime();
  const queryClient = useQueryClient();
  const me = useMe();
  const { branches, branchId, choose } = useBranchFor('visits.stations.manage');
  const [name, setName] = useState('');
  const [roomId, setRoomId] = useState('');
  const [code, setCode] = useState<(StationCodeResponse & { name: string }) | null>(null);
  const [problem, setProblem] = useState<unknown>(null);
  const [revoking, setRevoking] = useState<StationView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const stations = useApiQuery<StationListResponse>({
    queryKey: ['visits', 'stations', branchId],
    path: `visits/stations?branchId=${encodeURIComponent(branchId ?? '')}`,
    enabled: branchId !== null,
  });
  // The rooms of the branch (a holder of the catalogue's read permission sees them; without it, a station has no room).
  const locations = useApiQuery<LocationListResponse>({
    queryKey: ['catalog', 'locations', branchId],
    path: `catalog/locations?branchId=${encodeURIComponent(branchId ?? '')}`,
    enabled: branchId !== null && holds(me, 'catalog.records.read'),
    staleTime: 60_000,
  });
  const rooms = useMemo(
    () => (locations.data?.items ?? []).filter((l) => l.kind === 'room' && !l.archived && l.branchId === branchId).sort((a, b) => a.name.localeCompare(b.name)),
    [locations.data, branchId],
  );
  const roomName = (id: string | null): string => (id === null ? '—' : (rooms.find((l) => l.id === id)?.name ?? '—'));

  if (branches !== undefined && branchId === null) {
    return (
      <div className="grid max-w-5xl gap-6">
        <PageHead title={t('visits.stations.title')} intro={t('visits.stations.intro')} />
        <Notice kind="error">{t('visits.no_branch')}</Notice>
      </div>
    );
  }

  const create = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (branchId === null || name.trim() === '') return;
    setProblem(null);
    setNotice(null);
    try {
      const r = await api<StationCodeResponse>('POST', `branches/${encodeURIComponent(branchId)}/visits/stations`, {
        name: name.trim(),
        ...(roomId === '' ? {} : { locationId: roomId }),
      });
      setCode({ ...r, name: name.trim() });
      setName('');
      setRoomId('');
      await queryClient.invalidateQueries({ queryKey: ['visits', 'stations'] });
    } catch (e) {
      setProblem(e);
    }
  };

  const newCode = async (s: StationView): Promise<void> => {
    setProblem(null);
    setNotice(null);
    try {
      const r = await api<StationCodeResponse>('POST', `branches/${encodeURIComponent(s.branchId)}/visits/stations/${encodeURIComponent(s.id)}/activation-code`);
      setCode({ ...r, name: s.name });
      await queryClient.invalidateQueries({ queryKey: ['visits', 'stations'] });
    } catch (e) {
      setProblem(e);
    }
  };

  const columns: DenseColumn<StationView>[] = [
    { id: 'name', header: t('visits.stations.col.name'), cell: (s) => <span className="font-semibold">{s.name}</span> },
    { id: 'room', header: t('visits.stations.col.room'), cell: (s) => roomName(s.locationId) },
    {
      id: 'state',
      header: t('visits.stations.col.state'),
      cell: (s) => {
        const state = stationState(s);
        return <Tag tone={STATION_TONE[state]}>{t(`visits.stations.state.${state}`)}</Tag>;
      },
    },
    { id: 'seen', header: t('visits.stations.col.last_seen'), cell: (s) => (s.lastSeenAt === null ? t('visits.stations.never') : time(s.lastSeenAt)) },
    {
      id: 'actions',
      header: <span className="sr-only">{t('table.actions')}</span>,
      className: 'w-px py-1.5 text-right whitespace-nowrap',
      cell: (s) => (
        <>
          <Button size="sm" variant="ghost" onClick={() => void newCode(s)}>
            {t('visits.stations.new_code')}
          </Button>
          {s.revokedAt === null && (
            <Button size="sm" variant="ghost" onClick={() => setRevoking(s)}>
              {t('visits.stations.revoke')}
            </Button>
          )}
        </>
      ),
    },
  ];

  return (
    <div className="grid max-w-5xl gap-6">
      <PageHead title={t('visits.stations.title')} intro={t('visits.stations.intro')} />
      {branches !== undefined && branchId !== null && <BranchPicker branches={branches} branchId={branchId} choose={choose} />}
      <ProblemAlert error={problem} />
      {notice !== null && <Notice kind="success">{notice}</Notice>}
      {code !== null && (
        <Callout role="status" title={t('visits.stations.code_title', { name: code.name })}>
          <p translate="no" className="text-2xl font-bold tracking-[0.3em] tabular-nums">
            {code.code.slice(0, 4)}-{code.code.slice(4)}
          </p>
          <p className="text-muted-foreground">{t('visits.stations.code_hint', { time: time(code.expiresAt) })}</p>
        </Callout>
      )}
      <form noValidate aria-label={t('visits.stations.create')} onSubmit={(e) => void create(e)} className="flex flex-wrap items-end gap-3 rounded-lg border bg-background p-4">
        <Field label={t('visits.stations.name')} className="min-w-0 flex-[2_1_220px]">
          {(c) => <Input {...c} maxLength={191} value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>
        {rooms.length > 0 && (
          <Field label={t('visits.stations.room')} className="min-w-0 flex-[1_1_160px]">
            {(c) => (
              <select {...c} className={SELECT_CLASS} value={roomId} onChange={(e) => setRoomId(e.target.value)}>
                <option value="">{t('visits.stations.room_none')}</option>
                {rooms.map((l) => (
                  <option key={l.id} value={l.id}>
                    {`${l.name} (${l.code})`}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}
        <Button type="submit">{t('visits.stations.create')}</Button>
      </form>
      {stations.isError && stations.data === undefined ? (
        <ErrorState error={stations.error} onRetry={() => void stations.refetch()} retrying={stations.isFetching} />
      ) : stations.data === undefined ? (
        <SkeletonTable label={t('shell.loading')} columns={5} rows={2} />
      ) : (
        <DenseTable caption={t('visits.stations.title')} columns={columns} rows={stations.data.items} rowKey={(s) => s.id} empty={t('visits.stations.empty')} />
      )}
      {revoking !== null && (
        <ConfirmDialog
          open
          destructive
          title={t('visits.stations.revoke')}
          description={t('visits.stations.revoke_confirm', { name: revoking.name })}
          confirmLabel={t('visits.stations.revoke')}
          onConfirm={async () => {
            await api('DELETE', `branches/${encodeURIComponent(revoking.branchId)}/visits/stations/${encodeURIComponent(revoking.id)}`);
            await queryClient.invalidateQueries({ queryKey: ['visits', 'stations'] });
            setNotice(t('visits.stations.revoked'));
          }}
          onClose={() => setRevoking(null)}
        />
      )}
    </div>
  );
}
