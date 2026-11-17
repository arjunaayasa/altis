import { type Permission, type StocktakeScanOutcome, type StocktakeState } from '@altis/shared';
import type { BranchListResponse, BranchView } from '@altis/shared/api/branches';
import type { LocationListResponse, LocationView } from '@altis/shared/api/catalog/locations';
import type { CollectionTypeView, MasterListResponse } from '@altis/shared/api/catalog/masters';
import type {
  StocktakeCounts,
  StocktakeCreateResponse,
  StocktakeItemsResponse,
  StocktakeJobResponse,
  StocktakeListResponse,
  StocktakeOfficersResponse,
  StocktakeScanResponse,
  StocktakeUndoResponse,
  StocktakeUnknownResponse,
  StocktakeView,
} from '@altis/shared/api/stocktake';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { CheckField, Field, Notice, ProblemAlert, SELECT_CLASS } from '@/components/form-field';
import { JobProgress } from '@/components/job-progress';
import {
  BackLink,
  Callout,
  DenseTable,
  ErrorState,
  FilterField,
  FilterRow,
  InlinePanel,
  LoadingState,
  MoreMenu,
  MoreMenuItem,
  PageHead,
  Section,
  SectionHead,
  SkeletonTable,
  StatStrip,
  TONE_SURFACE,
  TONE_TEXT,
  Tag,
  type DenseColumn,
  type StatusTone,
  type TagTone,
} from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger, WRAPPING_TABS } from '@/components/ui/tabs';
import { useLocale, useT, type TKey } from '@/i18n';
import { holds, holdsAt } from '@/lib/access';
import { ApiError, api } from '@/lib/api';
import { isWritableBranch } from '@/lib/branches';
import { useApiQuery, useMe } from '@/lib/me';
import { useScannerInput } from '@/lib/scanner';
import { uploadFile } from '@/lib/upload';
import { cn } from '@/lib/utils';
import { readStored, writeStored } from '@/screens/circulation/common';

/**
 * Inventarisasi (`/admin/layanan/inventarisasi`): the sessions of a branch (the history included) and a new session
 * with its scope (locations of the branch's tree, collection types, class prefixes). The session page
 * (`/admin/layanan/inventarisasi/<branchId>/<id>`): the counts (read again every 3 seconds), the preparation or finish
 * job while it runs, the scan box (a scanner anywhere on the page, or typing and Enter) with the shelf being checked,
 * clear feedback for every scan, my last scans with "Batalkan", a code list upload, the lists by state, the unknown
 * codes and the officers, the finish (a panel under the head: re-authentication, the session's name typed in full),
 * cancelling, and the minutes PDF. A session the SLiMS migration brought with the report file SLiMS wrote for it offers that file as a
 * download, in the history and on its page.
 */

const BRANCH_KEY = 'altis.stocktake-branch';
const LOCATION_KEY = 'altis.stocktake-location';
const POLL_MS = 3_000;
const RECENT_MAX = 12;

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

function useTime(): (ms: number) => string {
  const locale = useLocale();
  return useMemo(() => {
    const f = new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'id-ID', { dateStyle: 'medium', timeStyle: 'short' });
    return (ms) => f.format(ms);
  }, [locale]);
}

/** The locations of a branch in tree order, each with its depth. */
function useLocations(branchId: string | null): { id: string; label: string; parentId: string | null }[] {
  const me = useMe();
  const q = useApiQuery<LocationListResponse>({
    queryKey: ['catalog', 'locations', branchId],
    path: `catalog/locations?branchId=${encodeURIComponent(branchId ?? '')}`,
    enabled: branchId !== null && holds(me, 'catalog.records.read'),
    staleTime: 60_000,
  });
  return useMemo(() => {
    const items: LocationView[] = (q.data?.items ?? []).filter((l) => l.branchId === branchId);
    const children = new Map<string | null, LocationView[]>();
    for (const l of items) children.set(l.parentId, [...(children.get(l.parentId) ?? []), l]);
    const out: { id: string; label: string; parentId: string | null }[] = [];
    const walk = (parent: string | null, depth: number): void => {
      for (const l of (children.get(parent) ?? []).sort((a, b) => a.name.localeCompare(b.name))) {
        out.push({ id: l.id, label: `${'  '.repeat(depth)}${l.name} (${l.code})`, parentId: l.parentId });
        if (depth < 8) walk(l.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }, [q.data, branchId]);
}

/** The API path of a migrated session's SLiMS report (a download: another system's HTML page, never shown here). */
function slimsReportPath(s: StocktakeView): string {
  return `branches/${encodeURIComponent(s.branch.id)}/stocktakes/${encodeURIComponent(s.id)}/slims-report`;
}

function statusTone(status: StocktakeView['status']): TagTone {
  return status === 'active' ? 'ok' : status === 'preparing' || status === 'finishing' ? 'warn' : 'neutral';
}

// ---- the list ------------------------------------------------------------------------------------------------------

export function StocktakeListScreen() {
  const t = useT();
  const me = useMe();
  const time = useTime();
  const { branches, branchId, choose } = useBranchFor('stocktake.scan.use');
  const list = useApiQuery<StocktakeListResponse>({
    queryKey: ['stocktake', 'list', branchId],
    path: `branches/${encodeURIComponent(branchId ?? '')}/stocktakes`,
    enabled: branchId !== null,
    refetchInterval: POLL_MS * 2,
  });
  const manage = branchId !== null && holdsAt(me, 'stocktake.sessions.manage', branchId);
  const live = list.data?.items.find((s) => s.status === 'preparing' || s.status === 'active' || s.status === 'finishing');

  if (branches !== undefined && branchId === null) {
    return (
      <div className="grid max-w-6xl gap-6">
        <PageHead title={t('stocktake.ui.title')} intro={t('stocktake.ui.intro')} />
        <Notice kind="error">{t('stocktake.ui.no_branch')}</Notice>
      </div>
    );
  }
  const columns: DenseColumn<StocktakeView>[] = [
    {
      id: 'name',
      header: t('stocktake.ui.col.name'),
      cell: (s) => (
        <Link to="/admin/layanan/inventarisasi/$branchId/$id" params={{ branchId: s.branch.id, id: s.id }} className="font-semibold text-accent-text underline-offset-4 hover:underline">
          {s.name}
        </Link>
      ),
    },
    { id: 'status', header: t('stocktake.ui.col.status'), cell: (s) => <Tag tone={statusTone(s.status)}>{t(`vocab.stocktake_status.${s.status}`)}</Tag> },
    { id: 'started', header: t('stocktake.ui.col.started'), className: 'whitespace-nowrap', cell: (s) => time(s.startedAt) },
    { id: 'finished', header: t('stocktake.ui.col.finished'), className: 'whitespace-nowrap', cell: (s) => (s.finishedAt === null ? '—' : time(s.finishedAt)) },
    { id: 'found', header: t('stocktake.ui.count.found'), headClassName: 'text-right', className: 'text-right whitespace-nowrap', cell: (s) => `${s.counts.found} / ${s.counts.total}` },
    { id: 'pending', header: t('stocktake.ui.count.pending'), headClassName: 'text-right', className: 'text-right', cell: (s) => s.counts.pending },
    { id: 'source', header: t('stocktake.ui.col.source'), cell: (s) => t(`vocab.stocktake_source.${s.source}`) },
    // ---- the SLiMS report of a migrated session ----
    {
      id: 'slims_report',
      header: t('stocktake.ui.col.slims_report'),
      cell: (s) =>
        s.migratedReport === null ? (
          '—'
        ) : (
          <a
            href={`/api/v1/${slimsReportPath(s)}`}
            download
            aria-label={t('stocktake.ui.slims_report.download_named', { name: s.name })}
            className="text-accent-text underline-offset-4 hover:underline">
            {t('stocktake.ui.slims_report.download')}
          </a>
        ),
    },
  ];
  return (
    <div className="grid max-w-6xl gap-6">
      <PageHead title={t('stocktake.ui.title')} intro={t('stocktake.ui.intro')} />
      {branches !== undefined && branchId !== null && branches.length > 1 && <BranchPicker branches={branches} branchId={branchId} choose={choose} />}
      {live !== undefined && (
        <Callout
          title={t('stocktake.ui.live', { name: live.name })}
          action={
            <Button asChild size="sm" variant="outline" className="bg-background">
              <Link to="/admin/layanan/inventarisasi/$branchId/$id" params={{ branchId: live.branch.id, id: live.id }}>
                {t('stocktake.ui.open')}
              </Link>
            </Button>
          }
        />
      )}
      {manage && branchId !== null && live === undefined && <NewSession branchId={branchId} />}
      <Section title={t('stocktake.ui.history')}>
        {list.isError && list.data === undefined ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />
        ) : list.data === undefined ? (
          <SkeletonTable label={t('shell.loading')} columns={8} rows={3} />
        ) : (
          <DenseTable caption={t('stocktake.ui.history')} columns={columns} rows={list.data.items} rowKey={(s) => s.id} empty={t('stocktake.ui.empty')} />
        )}
      </Section>
    </div>
  );
}

function BranchPicker({ branches, branchId, choose }: { branches: BranchView[]; branchId: string; choose(id: string): void }) {
  const t = useT();
  const id = useId();
  return (
    <FilterRow label={t('stocktake.ui.branch')}>
      <FilterField id={id} label={t('stocktake.ui.branch')} className="max-w-xs">
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

function selected(select: HTMLSelectElement): string[] {
  return [...select.selectedOptions].map((o) => o.value);
}

function NewSession({ branchId }: { branchId: string }) {
  const t = useT();
  const locale = useLocale();
  const me = useMe();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const locations = useLocations(branchId);
  const types = useApiQuery<MasterListResponse<CollectionTypeView>>({
    queryKey: ['catalog', 'collection-types'],
    path: 'catalog/collection-types',
    enabled: holds(me, 'catalog.records.read'),
    staleTime: 60_000,
  });
  const [name, setName] = useState('');
  const [locationIds, setLocationIds] = useState<string[]>([]);
  const [typeIds, setTypeIds] = useState<string[]>([]);
  const [classes, setClasses] = useState('');
  const [problem, setProblem] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [nameError, setNameError] = useState<string | undefined>();
  const locId = useId();
  const typeId = useId();

  const submit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    setProblem(null);
    if (name.trim() === '') {
      setNameError('form.error.required');
      return;
    }
    setNameError(undefined);
    const classPrefixes = classes
      .split(/[\s,;]+/)
      .map((c) => c.trim())
      .filter((c) => c !== '');
    const scope = {
      ...(locationIds.length > 0 ? { locationIds } : {}),
      ...(typeIds.length > 0 ? { collectionTypeIds: typeIds } : {}),
      ...(classPrefixes.length > 0 ? { classPrefixes } : {}),
    };
    setBusy(true);
    try {
      const r = await api<StocktakeCreateResponse>('POST', `branches/${encodeURIComponent(branchId)}/stocktakes`, { name: name.trim(), scope });
      await queryClient.invalidateQueries({ queryKey: ['stocktake'] });
      await navigate({ to: '/admin/layanan/inventarisasi/$branchId/$id', params: { branchId, id: r.id } });
    } catch (err) {
      setProblem(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title={t('stocktake.ui.new.title')}>
      <p className="-mt-1 max-w-[75ch] text-sm text-muted-foreground">{t('stocktake.ui.new.intro')}</p>
      <form noValidate aria-label={t('stocktake.ui.new.title')} onSubmit={(e) => void submit(e)} className="grid max-w-4xl gap-x-5 gap-y-4 md:grid-cols-2">
        <Field label={t('stocktake.ui.new.name')} error={nameError} className="md:col-span-2">
          {(c) => <Input {...c} maxLength={191} value={name} onChange={(e) => setName(e.target.value)} placeholder={t('stocktake.ui.new.name_hint')} />}
        </Field>
        <Field id={locId} label={t('stocktake.ui.new.locations')} hint={t('stocktake.ui.new.locations_hint')}>
          <select id={locId} multiple size={6} className={SELECT_CLASS + ' h-auto'} value={locationIds} onChange={(e) => setLocationIds(selected(e.target))}>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
        </Field>
        <Field id={typeId} label={t('stocktake.ui.new.collection_types')} hint={t('stocktake.ui.new.multi_hint')}>
          <select id={typeId} multiple size={6} className={SELECT_CLASS + ' h-auto'} value={typeIds} onChange={(e) => setTypeIds(selected(e.target))}>
            {(types.data?.items ?? [])
              .filter((c) => !c.archived)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {locale === 'en' && c.nameEn !== '' ? c.nameEn : c.nameId} ({c.code})
                </option>
              ))}
          </select>
        </Field>
        <Field label={t('stocktake.ui.new.classes')} hint={t('stocktake.ui.new.classes_hint')}>
          {(c) => <Input {...c} maxLength={400} value={classes} onChange={(e) => setClasses(e.target.value)} />}
        </Field>
        <div className="flex items-end">
          <Button type="submit" disabled={busy}>
            {t('stocktake.ui.new.submit')}
          </Button>
        </div>
      </form>
      <ProblemAlert error={problem} />
    </Section>
  );
}

// ---- the session ---------------------------------------------------------------------------------------------------

interface RecentScan {
  key: string;
  outcome: StocktakeScanOutcome;
  code: string;
  itemId: string | null;
  title: string | null;
  location: string | null;
  undone?: boolean;
}

/** The state colour of a scan's outcome (its words say it; an outcome already counted is neutral). */
const OUTCOME_TONE: Record<StocktakeScanOutcome, StatusTone | null> = {
  found: 'ok',
  misplaced: 'warn',
  already_found: null,
  on_loan: 'warn',
  unexpected: 'warn',
  unknown: 'bad',
};

type Tab = StocktakeState | 'unknown' | 'officers';

const TABS: readonly Tab[] = ['pending', 'misplaced', 'unexpected', 'unknown', 'on_loan', 'found', 'officers'];

export function StocktakeSessionScreen() {
  const t = useT();
  const me = useMe();
  const time = useTime();
  const queryClient = useQueryClient();
  const { branchId, id } = useParams({ strict: false }) as { branchId: string; id: string };
  const base = `branches/${encodeURIComponent(branchId)}/stocktakes/${encodeURIComponent(id)}`;
  const session = useApiQuery<StocktakeView>({ queryKey: ['stocktake', 'session', id], path: base, refetchInterval: POLL_MS });
  const locations = useLocations(branchId);
  const [locationId, setLocationId] = useState<string>(() => readStored(LOCATION_KEY) ?? '');
  const [code, setCode] = useState('');
  const [last, setLast] = useState<RecentScan | null>(null);
  const [recent, setRecent] = useState<RecentScan[]>([]);
  const [problem, setProblem] = useState<unknown>(null);
  // The counts of my last scan or undo, until the session's next poll lands (`seen`: the poll they were answered after);
  // `seq` keeps an older answer from replacing a newer one.
  const [counts, setCounts] = useState<{ counts: StocktakeCounts; seen: number; seq: number } | null>(null);
  const seqRef = useRef(0);
  const [tab, setTab] = useState<Tab>('pending');
  const [finishing, setFinishing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [uploadJob, setUploadJob] = useState<string | null>(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const locId = useId();
  const fileId = useId();
  const s = session.data;
  const manage = holdsAt(me, 'stocktake.sessions.manage', branchId);
  const active = s?.status === 'active';
  const shown = counts !== null && s !== undefined && s.status === 'active' && counts.seen === session.dataUpdatedAt ? counts.counts : s?.counts;
  const keepCounts = (seq: number, c: StocktakeCounts): void => {
    const seen = queryClient.getQueryState(['stocktake', 'session', id])?.dataUpdatedAt ?? 0;
    setCounts((old) => (old !== null && old.seq > seq ? old : { counts: c, seen, seq }));
  };

  const doScan = async (raw: string): Promise<void> => {
    const barcode = raw.trim();
    if (barcode === '' || !active) return;
    setProblem(null);
    setCode('');
    const seq = (seqRef.current += 1);
    try {
      const body = { barcode, ...(locationId === '' ? {} : { locationId }) };
      const r = await api<StocktakeScanResponse>('POST', `${base}/scans`, body, { idempotencyKey: crypto.randomUUID() });
      const entry: RecentScan = {
        key: crypto.randomUUID(),
        outcome: r.outcome,
        code: r.code,
        itemId: r.item?.id ?? null,
        title: r.item?.title ?? null,
        location: r.item?.location?.name ?? null,
      };
      setLast(entry);
      setRecent((list) => [entry, ...list].slice(0, RECENT_MAX));
      keepCounts(seq, r.counts);
      void queryClient.invalidateQueries({ queryKey: ['stocktake', 'items', id] });
    } catch (err) {
      setProblem(err);
    } finally {
      inputRef.current?.focus();
    }
  };
  useScannerInput({ onScan: (c) => void doScan(c) });

  const undo = async (entry: RecentScan): Promise<void> => {
    if (entry.itemId === null) return;
    setProblem(null);
    const seq = (seqRef.current += 1);
    try {
      const r = await api<StocktakeUndoResponse>('DELETE', `${base}/scans/${encodeURIComponent(entry.itemId)}`);
      keepCounts(seq, r.counts);
      setRecent((list) => list.map((x) => (x.key === entry.key ? { ...x, undone: true } : x)));
      void queryClient.invalidateQueries({ queryKey: ['stocktake', 'items', id] });
    } catch (err) {
      setProblem(err);
    }
  };

  const upload = async (file: File): Promise<void> => {
    setProblem(null);
    setUploadBusy(true);
    try {
      const { uploadId } = await uploadFile(file, { context: 'stocktake.codes', branchId });
      const r = await api<StocktakeJobResponse>('POST', `${base}/uploads`, { uploadId, ...(locationId === '' ? {} : { locationId }) }, { idempotencyKey: crypto.randomUUID() });
      setUploadJob(r.jobId);
    } catch (err) {
      setProblem(err);
    } finally {
      setUploadBusy(false);
    }
  };

  const refresh = async (): Promise<void> => {
    setCounts(null);
    await queryClient.invalidateQueries({ queryKey: ['stocktake'] });
  };

  if (session.isError && s === undefined) {
    return (
      <div className="grid max-w-6xl gap-6">
        <BackLink to="/admin/layanan/inventarisasi">{t('stocktake.ui.back_list')}</BackLink>
        <PageHead title={t('stocktake.ui.title')} />
        <ErrorState error={session.error} onRetry={() => void session.refetch()} retrying={session.isFetching} />
      </div>
    );
  }
  if (s === undefined || shown === undefined) {
    return (
      <div className="grid max-w-6xl gap-6">
        <BackLink to="/admin/layanan/inventarisasi">{t('stocktake.ui.back_list')}</BackLink>
        <LoadingState label={t('stocktake.ui.loading')} />
      </div>
    );
  }

  const tiles: [TKey, number][] = [
    ['stocktake.ui.count.total', shown.total],
    ['stocktake.ui.count.found', shown.found],
    ['stocktake.ui.count.pending', shown.pending],
    ['stocktake.ui.count.misplaced', shown.misplaced],
    ['stocktake.ui.count.on_loan', shown.onLoan],
    ['stocktake.ui.count.unexpected', shown.unexpected],
    ['stocktake.ui.count.unknown', shown.unknownCodes],
  ];
  const pct = shown.total === 0 ? 0 : Math.round((shown.found / shown.total) * 1000) / 10;

  const lastTone = last === null ? null : OUTCOME_TONE[last.outcome];
  return (
    <div className="grid max-w-6xl gap-6">
      <BackLink to="/admin/layanan/inventarisasi">{t('stocktake.ui.back_list')}</BackLink>
      <PageHead
        title={s.name}
        intro={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Tag tone={statusTone(s.status)}>{t(`vocab.stocktake_status.${s.status}`)}</Tag>
            <span>
              {s.branch.name} · {time(s.startedAt)}
              {s.startedBy !== null ? ` · ${s.startedBy.name}` : ''}
              {s.finishedAt !== null ? ` — ${t('stocktake.ui.finished_at', { time: time(s.finishedAt) })}${s.finishedBy !== null ? ` · ${s.finishedBy.name}` : ''}` : ''}
            </span>
          </span>
        }
        actions={
          <>
            <Button asChild variant="outline">
              <a href={`/api/v1/${base}/minutes`} target="_blank" rel="noreferrer">
                {t('stocktake.ui.minutes')}
              </a>
            </Button>
            {s.migratedReport !== null && (
              <Button asChild variant="outline">
                <a href={`/api/v1/${base}/slims-report`} download>
                  {t('stocktake.ui.slims_report.session')}
                </a>
              </Button>
            )}
            {manage && active && (
              <Button variant="outline" aria-expanded={finishing} onClick={() => setFinishing((open) => !open)}>
                {t('stocktake.ui.finish.open')}
              </Button>
            )}
            {manage && (s.status === 'preparing' || s.status === 'active') && (
              <MoreMenu label={t('stocktake.ui.more')}>
                <MoreMenuItem danger onSelect={() => setCancelling(true)}>
                  {t('stocktake.ui.cancel.open')}
                </MoreMenuItem>
              </MoreMenu>
            )}
          </>
        }
      />
      {finishing && manage && active && <FinishPanel session={s} base={base} onClose={() => setFinishing(false)} onDone={() => void refresh()} />}
      <div className="grid gap-2" aria-live="polite">
        <StatStrip items={tiles.map(([key, n]) => ({ key, label: t(key), value: n }))} />
        <p className="text-meta text-muted-foreground">{t('stocktake.ui.progress', { pct })}</p>
      </div>

      {(s.status === 'preparing' || s.status === 'finishing') && s.jobId !== null && (
        <section aria-labelledby={`${locId}-job`} className="grid gap-2">
          <SectionHead id={`${locId}-job`} title={t(s.status === 'preparing' ? 'stocktake.ui.preparing' : 'stocktake.ui.finishing')} />
          <JobProgress jobId={s.jobId} onDone={() => void refresh()} />
        </section>
      )}

      {active && (
        <div className="grid gap-4">
          <form
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void doScan(code);
            }}
            className="grid gap-4"
          >
            <Field id={locId} label={t('stocktake.ui.scan.location')} className="max-w-md">
              <select
                id={locId}
                className={SELECT_CLASS}
                value={locationId}
                onChange={(e) => {
                  setLocationId(e.target.value);
                  writeStored(LOCATION_KEY, e.target.value);
                  inputRef.current?.focus();
                }}
              >
                <option value="">{t('stocktake.ui.scan.location_none')}</option>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('stocktake.ui.scan.label')} hint={t('stocktake.ui.scan.hint')}>
              {(c) => (
                <div className="flex gap-2">
                  <Input
                    {...c}
                    ref={inputRef}
                    autoFocus
                    autoComplete="off"
                    maxLength={200}
                    className="h-13 min-w-0 flex-1 text-base tracking-wide md:text-base"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                  />
                  <Button type="submit" className="h-13 px-5">
                    {t('stocktake.ui.scan.submit')}
                  </Button>
                </div>
              )}
            </Field>
          </form>
          {last !== null && (
            <div
              role="status"
              aria-live="assertive"
              data-outcome={last.outcome}
              className={cn('grid gap-1 rounded-lg border px-4 py-3', lastTone === null ? 'bg-layer' : TONE_SURFACE[lastTone])}>
              <p className={cn('text-base font-bold', lastTone !== null && TONE_TEXT[lastTone])}>
                {t(`vocab.stocktake_scan.${last.outcome}`)} · <span className="tracking-wide">{last.code}</span>
              </p>
              {last.title !== null && <p className="text-sm font-semibold">{last.title}</p>}
              <p className="text-sm">{t(`stocktake.ui.scan.explain.${last.outcome}`, { location: last.location ?? '—' })}</p>
            </div>
          )}
          <ProblemAlert error={problem} />
          {recent.length > 0 && (
            <div className="grid gap-2">
              <h3 className="text-sm font-bold">{t('stocktake.ui.recent')}</h3>
              <ul className="grid rounded-lg border text-sm">
                {recent.map((r) => (
                  <li key={r.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-1.5 last:border-b-0">
                    <Tag tone={OUTCOME_TONE[r.outcome] ?? 'neutral'}>{t(`vocab.stocktake_scan.${r.outcome}`)}</Tag>
                    <span className="tracking-wide">{r.code}</span>
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">{r.title ?? ''}</span>
                    {r.undone === true ? (
                      <span className="text-meta text-muted-foreground">{t('stocktake.ui.undone')}</span>
                    ) : (
                      (r.outcome === 'found' || r.outcome === 'misplaced' || r.outcome === 'unexpected') && (
                        <Button size="sm" variant="ghost" onClick={() => void undo(r)}>
                          {t('stocktake.ui.undo')}
                        </Button>
                      )
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="flex flex-wrap items-end gap-3 border-t pt-4">
            <Field id={fileId} label={t('stocktake.ui.upload.label')} hint={t('stocktake.ui.upload.hint')}>
              <div className="flex items-center gap-2">
                <input
                  id={fileId}
                  ref={fileRef}
                  type="file"
                  accept=".txt,.csv,text/plain,text/csv"
                  disabled={uploadBusy || uploadJob !== null}
                  className="sr-only"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = '';
                    if (f !== undefined) void upload(f);
                  }}
                />
                <Button type="button" variant="outline" disabled={uploadBusy || uploadJob !== null} onClick={() => fileRef.current?.click()}>
                  {uploadBusy ? t('stocktake.ui.upload.busy') : t('stocktake.ui.upload.choose')}
                </Button>
              </div>
            </Field>
            {uploadJob !== null && (
              <div className="min-w-64 flex-1">
                <JobProgress
                  jobId={uploadJob}
                  onDone={() => {
                    setUploadJob(null);
                    void refresh();
                  }}
                />
              </div>
            )}
          </div>
        </div>
      )}

      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="min-w-0">
        <TabsList className={WRAPPING_TABS.list} aria-label={t('stocktake.ui.lists')}>
          {TABS.map((x) => (
            <TabsTrigger key={x} value={x} className={WRAPPING_TABS.trigger}>
              {x === 'unknown' ? t('stocktake.ui.tab.unknown') : x === 'officers' ? t('stocktake.ui.tab.officers') : t(`vocab.stocktake_state.${x}`)}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value={tab} className="pt-3">
          {tab === 'unknown' ? <UnknownList base={base} /> : tab === 'officers' ? <OfficerList base={base} /> : <ItemList base={base} id={id} state={tab} />}
        </TabsContent>
      </Tabs>

      <ConfirmDialog
        open={cancelling}
        title={t('stocktake.ui.cancel.title')}
        description={t('stocktake.ui.cancel.description', { name: s.name })}
        confirmLabel={t('stocktake.ui.cancel.confirm')}
        destructive
        onConfirm={async () => {
          await api('POST', `${base}/cancel`, undefined, { idempotencyKey: crypto.randomUUID() });
          await refresh();
        }}
        onClose={() => setCancelling(false)}
      />
    </div>
  );
}

function ItemList({ base, id, state }: { base: string; id: string; state: StocktakeState }) {
  const t = useT();
  const time = useTime();
  const [cursor, setCursor] = useState<string | null>(null);
  const q = useApiQuery<StocktakeItemsResponse>({
    queryKey: ['stocktake', 'items', id, state, cursor],
    path: `${base}/items?state=${state}&limit=100${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`,
    refetchInterval: POLL_MS * 2,
  });
  const rows = (q.data?.items ?? []).map((r) => ({ ...r, id: r.itemId }));
  const columns: DenseColumn<(typeof rows)[number]>[] = [
    { id: 'barcode', header: t('stocktake.ui.col.barcode'), className: 'whitespace-nowrap', cell: (r) => <span className="tracking-wide">{r.barcode}</span> },
    { id: 'title', header: t('stocktake.ui.col.title'), cell: (r) => r.title },
    { id: 'call', header: t('stocktake.ui.col.call_number'), cell: (r) => r.callNumber ?? '—' },
    { id: 'location', header: t('stocktake.ui.col.location'), cell: (r) => r.expectedLocation?.name ?? '—' },
    ...(state === 'misplaced' ? [{ id: 'scanned_location', header: t('stocktake.ui.col.scanned_location'), cell: (r: (typeof rows)[number]) => r.scannedLocation?.name ?? '—' }] : []),
    { id: 'status', header: t('stocktake.ui.col.item_status'), cell: (r) => t(`vocab.item_status.${r.currentStatus}` as TKey) },
    { id: 'scanned', header: t('stocktake.ui.col.scanned'), cell: (r) => (r.scannedAt === null ? '—' : `${time(r.scannedAt)}${r.scannedBy === null ? '' : ` · ${r.scannedBy.name}`}`) },
    { id: 'result', header: t('stocktake.ui.col.result'), cell: (r) => (r.result === null ? '—' : t(`vocab.stocktake_result.${r.result}`)) },
  ];
  return (
    <div className="grid gap-3">
      {q.data === undefined && !q.isError ? (
        <SkeletonTable label={t('shell.loading')} columns={7} rows={3} />
      ) : (
        <DenseTable caption={t(`vocab.stocktake_state.${state}`)} columns={columns} rows={rows} rowKey={(r) => r.id} empty={t('stocktake.ui.list_empty')} />
      )}
      <div className="flex flex-wrap gap-2">
        {cursor !== null && (
          <Button size="sm" variant="outline" onClick={() => setCursor(null)}>
            {t('stocktake.ui.first_page')}
          </Button>
        )}
        {q.data?.nextCursor != null && (
          <Button size="sm" variant="outline" onClick={() => setCursor(q.data?.nextCursor ?? null)}>
            {t('stocktake.ui.next_page')}
          </Button>
        )}
      </div>
    </div>
  );
}

function UnknownList({ base }: { base: string }) {
  const t = useT();
  const time = useTime();
  const q = useApiQuery<StocktakeUnknownResponse>({ queryKey: ['stocktake', 'unknown', base], path: `${base}/unknown-codes?limit=200`, refetchInterval: POLL_MS * 2 });
  const rows = (q.data?.items ?? []).map((r) => ({ ...r, id: r.code }));
  const columns: DenseColumn<(typeof rows)[number]>[] = [
    { id: 'code', header: t('stocktake.ui.col.code'), cell: (r) => <span className="tracking-wide">{r.code}</span> },
    { id: 'seen', header: t('stocktake.ui.col.seen'), headClassName: 'text-right', className: 'text-right', cell: (r) => r.seen },
    { id: 'last', header: t('stocktake.ui.col.last_seen'), cell: (r) => time(r.lastAt) },
    { id: 'by', header: t('stocktake.ui.col.officer'), cell: (r) => r.scannedBy?.name ?? '—' },
  ];
  return <DenseTable caption={t('stocktake.ui.tab.unknown')} columns={columns} rows={rows} rowKey={(r) => r.id} empty={t('stocktake.ui.list_empty')} />;
}

function OfficerList({ base }: { base: string }) {
  const t = useT();
  const q = useApiQuery<StocktakeOfficersResponse>({ queryKey: ['stocktake', 'officers', base], path: `${base}/officers`, refetchInterval: POLL_MS * 2 });
  const rows = (q.data?.items ?? []).map((r, i) => ({ ...r, id: r.id ?? `n${i}` }));
  const columns: DenseColumn<(typeof rows)[number]>[] = [
    { id: 'name', header: t('stocktake.ui.col.officer'), cell: (r) => r.name },
    { id: 'found', header: t('stocktake.ui.count.found'), headClassName: 'text-right', className: 'text-right', cell: (r) => r.found },
    { id: 'misplaced', header: t('stocktake.ui.count.misplaced'), headClassName: 'text-right', className: 'text-right', cell: (r) => r.misplaced },
    { id: 'unexpected', header: t('stocktake.ui.count.unexpected'), headClassName: 'text-right', className: 'text-right', cell: (r) => r.unexpected },
  ];
  return <DenseTable caption={t('stocktake.ui.tab.officers')} columns={columns} rows={rows} rowKey={(r) => r.id} empty={t('stocktake.ui.list_empty')} />;
}

/** "Selesaikan sesi", a panel under the page head: what happens to the copies, and the session's name typed in full. */
function FinishPanel({ session, base, onClose, onDone }: { session: StocktakeView; base: string; onClose(): void; onDone(): void }) {
  const t = useT();
  const [confirmName, setConfirmName] = useState('');
  const [markMissing, setMarkMissing] = useState(true);
  const [restoreFound, setRestoreFound] = useState(true);
  const [problem, setProblem] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [mismatch, setMismatch] = useState(false);
  const submit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    setProblem(null);
    if (confirmName.trim() !== session.name.trim()) {
      setMismatch(true);
      return;
    }
    setMismatch(false);
    setBusy(true);
    try {
      await api<StocktakeJobResponse>('POST', `${base}/finish`, { confirmName: confirmName.trim(), markMissing, restoreFound }, { idempotencyKey: crypto.randomUUID() });
      setBusy(false);
      onClose();
      onDone();
    } catch (err) {
      setBusy(false);
      if (err instanceof ApiError && err.errors?.some((f) => f.path === 'confirmName') === true) setMismatch(true);
      else setProblem(err);
    }
  };
  return (
    <InlinePanel title={t('stocktake.ui.finish.title')} onSubmit={(e) => void submit(e)} onCancel={busy ? undefined : onClose}>
      <p className="-mt-1.5 max-w-[75ch] text-sm text-muted-foreground">{t('stocktake.ui.finish.intro', { pending: session.counts.pending, onLoan: session.counts.onLoan })}</p>
      <div className="grid max-w-2xl gap-4">
        <CheckField label={t('stocktake.ui.finish.mark_missing')} hint={t('stocktake.ui.finish.mark_missing_hint')} checked={markMissing} onChange={(e) => setMarkMissing(e.target.checked)} />
        <CheckField label={t('stocktake.ui.finish.restore_found')} hint={t('stocktake.ui.finish.restore_found_hint')} checked={restoreFound} onChange={(e) => setRestoreFound(e.target.checked)} />
        <Field label={t('stocktake.ui.finish.type_name', { name: session.name })} error={mismatch ? 'stocktake.ui.finish.mismatch' : undefined}>
          {(c) => <Input {...c} autoComplete="off" maxLength={191} value={confirmName} onChange={(e) => setConfirmName(e.target.value)} />}
        </Field>
      </div>
      <ProblemAlert error={problem} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" variant="destructive" disabled={busy}>
          {t('stocktake.ui.finish.submit')}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onClose} disabled={busy}>
          {t('form.cancel')}
        </Button>
      </div>
    </InlinePanel>
  );
}

