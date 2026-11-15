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
import { Badge, Field, Notice, ProblemAlert, SELECT_CLASS } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useLocale, useT } from '@/i18n';
import { holds, holdsAt } from '@/lib/access';
import { api } from '@/lib/api';
import { isWritableBranch } from '@/lib/branches';
import { problemText } from '@/lib/form-errors';
import { useApiQuery, useMe } from '@/lib/me';
import { MasterTable, type MasterColumn } from '@/screens/catalog/masters/master-table';
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
    <Field id={id} label={t('visits.branch')} className="max-w-xs">
      <select id={id} className={SELECT_CLASS} value={branchId} onChange={(e) => choose(e.target.value)}>
        {branches.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
      </select>
    </Field>
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
    <dl className="grid grid-cols-3 gap-3" aria-label={t('visits.today')}>
      {(
        [
          ['visits.total', s?.total],
          ['visits.members', s?.members],
          ['visits.guests', s?.guests],
        ] as const
      ).map(([key, value]) => (
        <div key={key} className="rounded-lg border bg-card p-3">
          <dt className="text-xs text-muted-foreground">{t(key)}</dt>
          <dd className="text-2xl font-semibold">{value ?? '—'}</dd>
        </div>
      ))}
    </dl>
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
    <form noValidate onSubmit={(e) => void submit(e)} className="grid gap-3 rounded-lg border bg-card p-4">
      <h2 className="text-lg font-semibold">{t('visits.checkin.title')}</h2>
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
          {(c) => <Input {...c} autoComplete="off" className="font-mono" maxLength={200} value={memberNo} onChange={(e) => setMemberNo(e.target.value)} />}
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
      <Button type="submit" className="w-fit">
        {t('visits.checkin.submit')}
      </Button>
    </form>
  );
}

function ClassVisitForm({ branchId }: { branchId: string }) {
  const t = useT();
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
    <form noValidate onSubmit={(e) => void submit(e)} className="grid gap-3 rounded-lg border bg-card p-4">
      <h2 className="text-lg font-semibold">{t('visits.class.title')}</h2>
      <Field label={t('visits.class.name')}>{(c) => <Input {...c} maxLength={64} value={className} onChange={(e) => setClassName(e.target.value)} />}</Field>
      <Field label={t('visits.class.headcount')}>{(c) => <Input {...c} inputMode="numeric" value={headcount} onChange={(e) => setHeadcount(e.target.value)} />}</Field>
      <Field label={t('visits.class.note')}>{(c) => <Input {...c} maxLength={191} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
      {done !== null && <Notice kind="success">{done}</Notice>}
      <ProblemAlert error={problem} />
      <Button type="submit" className="w-fit">
        {t('visits.class.submit')}
      </Button>
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

  const columns: MasterColumn<VisitView>[] = [
    { id: 'time', header: t('visits.col.time'), className: 'whitespace-nowrap', cell: (v) => time(v.visitedAt) },
    { id: 'who', header: t('visits.col.who'), cell: who },
    { id: 'class', header: t('visits.col.class'), cell: (v) => v.className ?? '—' },
    { id: 'source', header: t('visits.col.source'), cell: (v) => <Badge>{t(`vocab.visit_source.${v.source}`)}</Badge> },
    { id: 'purpose', header: t('visits.col.purpose'), cell: (v) => (v.purpose === null ? '—' : t(`vocab.visit_purpose.${v.purpose}`)) },
    { id: 'count', header: t('visits.col.count'), cell: (v) => v.headcount },
    ...(canManage
      ? [
          {
            id: 'actions',
            header: t('table.actions'),
            cell: (v: VisitView) => (
              <Button size="sm" variant="outline" aria-label={t('visits.void_named', { time: time(v.visitedAt) })} onClick={() => setVoiding(v)}>
                {t('visits.void')}
              </Button>
            ),
          },
        ]
      : []),
  ];

  return (
    <section className="grid gap-3">
      <h2 className="text-lg font-semibold">{t('visits.list.title')}</h2>
      <form
        noValidate
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setFilters(draft);
        }}
      >
        <Field label={t('visits.list.from')}>{(c) => <Input {...c} type="date" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />}</Field>
        <Field label={t('visits.list.to')}>{(c) => <Input {...c} type="date" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />}</Field>
        <Field id={`${ids}-source`} label={t('visits.list.source')}>
          <select id={`${ids}-source`} className={SELECT_CLASS} value={draft.source} onChange={(e) => setDraft({ ...draft, source: e.target.value as VisitSource | '' })}>
            <option value="">{t('visits.list.all_sources')}</option>
            {VISIT_SOURCES.map((s) => (
              <option key={s} value={s}>
                {t(`vocab.visit_source.${s}`)}
              </option>
            ))}
          </select>
        </Field>
        <Button type="submit">{t('visits.list.apply')}</Button>
      </form>
      {list.isError && <Notice kind="error">{problemText(t, list.error)}</Notice>}
      <MasterTable caption={t('visits.list.title')} columns={columns} rows={rows} empty={t('visits.list.empty')} />
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
    </section>
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
    <div className="flex max-w-6xl flex-col gap-4">
      <h1 className="text-2xl font-semibold">{t('visits.title')}</h1>
      <ReportLinks reports={[{ id: 'visits.monthly', permission: 'reports.statistics.read' }, { id: 'visits.daily', permission: 'reports.statistics.read' }, { id: 'visits.list', permission: 'visits.records.read' }]} />
      {branches !== undefined && branchId !== null && <BranchPicker branches={branches} branchId={branchId} choose={choose} />}
      {readBranch !== null && readable && <Summary branchId={readBranch} />}
      {branchId !== null ? (
        <div className="grid gap-4 lg:grid-cols-2">
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
      <div className="flex max-w-4xl flex-col gap-4">
        <h1 className="text-2xl font-semibold">{t('visits.stations.title')}</h1>
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

  const columns: MasterColumn<StationView>[] = [
    { id: 'name', header: t('visits.stations.col.name'), cell: (s) => s.name },
    { id: 'room', header: t('visits.stations.col.room'), cell: (s) => roomName(s.locationId) },
    {
      id: 'state',
      header: t('visits.stations.col.state'),
      cell: (s) => {
        const state = stationState(s);
        return <Badge tone={state === 'paired' ? 'info' : state === 'revoked' ? 'neutral' : 'warning'}>{t(`visits.stations.state.${state}`)}</Badge>;
      },
    },
    { id: 'seen', header: t('visits.stations.col.last_seen'), cell: (s) => (s.lastSeenAt === null ? t('visits.stations.never') : time(s.lastSeenAt)) },
    {
      id: 'actions',
      header: t('table.actions'),
      cell: (s) => (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => void newCode(s)}>
            {t('visits.stations.new_code')}
          </Button>
          {s.revokedAt === null && (
            <Button size="sm" variant="outline" onClick={() => setRevoking(s)}>
              {t('visits.stations.revoke')}
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="flex max-w-5xl flex-col gap-4">
      <h1 className="text-2xl font-semibold">{t('visits.stations.title')}</h1>
      <p className="text-sm text-muted-foreground">{t('visits.stations.intro')}</p>
      {branches !== undefined && branchId !== null && <BranchPicker branches={branches} branchId={branchId} choose={choose} />}
      <form noValidate onSubmit={(e) => void create(e)} className="flex flex-wrap items-end gap-2">
        <Field label={t('visits.stations.name')} className="min-w-64 flex-1">
          {(c) => <Input {...c} maxLength={191} value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>
        {rooms.length > 0 && (
          <Field label={t('visits.stations.room')} className="min-w-48">
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
      <ProblemAlert error={problem} />
      {notice !== null && <Notice kind="success">{notice}</Notice>}
      {code !== null && (
        <section role="status" className="grid gap-2 rounded-lg border-2 border-primary bg-card p-4">
          <h2 className="text-base font-semibold">{t('visits.stations.code_title', { name: code.name })}</h2>
          <p className="font-mono text-4xl tracking-[0.3em]">
            {code.code.slice(0, 4)}-{code.code.slice(4)}
          </p>
          <p className="text-sm text-muted-foreground">{t('visits.stations.code_hint', { time: time(code.expiresAt) })}</p>
        </section>
      )}
      <MasterTable caption={t('visits.stations.title')} columns={columns} rows={stations.data?.items ?? []} empty={t('visits.stations.empty')} />
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
