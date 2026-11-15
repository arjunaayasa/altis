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
import { Badge, CheckField, Field, Notice, ProblemAlert, SELECT_CLASS } from '@/components/form-field';
import { JobProgress } from '@/components/job-progress';
import { useReturnFocus } from '@/components/return-focus';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useLocale, useT, type TKey } from '@/i18n';
import { holds, holdsAt } from '@/lib/access';
import { ApiError, api } from '@/lib/api';
import { isWritableBranch } from '@/lib/branches';
import { useApiQuery, useMe } from '@/lib/me';
import { useScannerInput } from '@/lib/scanner';
import { uploadFile } from '@/lib/upload';
import { MasterTable, type MasterColumn } from '@/screens/catalog/masters/master-table';
import { readStored, writeStored } from '@/screens/circulation/common';

/**
 * Inventarisasi (`/admin/layanan/inventarisasi`): the sessions of a branch (the history included) and a new session
 * with its scope (locations of the branch's tree, collection types, class prefixes). The session page
 * (`/admin/layanan/inventarisasi/<branchId>/<id>`): the counts (read again every 3 seconds), the preparation or finish
 * job while it runs, the scan box (a scanner anywhere on the page, or typing and Enter) with the shelf being checked,
 * clear feedback for every scan, my last scans with "Batalkan", a code list upload, the lists by state, the unknown
 * codes and the officers, the finish (re-authentication, the session's name typed in full), cancelling, and the
 * minutes PDF. A session the SLiMS migration brought with the report file SLiMS wrote for it offers that file as a
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

function statusTone(status: StocktakeView['status']): 'info' | 'warning' | 'neutral' {
  return status === 'active' ? 'info' : status === 'preparing' || status === 'finishing' ? 'warning' : 'neutral';
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
      <div className="flex max-w-4xl flex-col gap-4">
        <h1 className="text-2xl font-semibold">{t('stocktake.ui.title')}</h1>
        <Notice kind="error">{t('stocktake.ui.no_branch')}</Notice>
      </div>
    );
  }
  const columns: MasterColumn<StocktakeView>[] = [
    {
      id: 'name',
      header: t('stocktake.ui.col.name'),
      cell: (s) => (
        <Link to="/admin/layanan/inventarisasi/$branchId/$id" params={{ branchId: s.branch.id, id: s.id }} className="font-medium text-primary underline-offset-4 hover:underline">
          {s.name}
        </Link>
      ),
    },
    { id: 'status', header: t('stocktake.ui.col.status'), cell: (s) => <Badge tone={statusTone(s.status)}>{t(`vocab.stocktake_status.${s.status}`)}</Badge> },
    { id: 'started', header: t('stocktake.ui.col.started'), cell: (s) => time(s.startedAt) },
    { id: 'finished', header: t('stocktake.ui.col.finished'), cell: (s) => (s.finishedAt === null ? '—' : time(s.finishedAt)) },
    { id: 'found', header: t('stocktake.ui.count.found'), cell: (s) => `${s.counts.found} / ${s.counts.total}` },
    { id: 'pending', header: t('stocktake.ui.count.pending'), cell: (s) => s.counts.pending },
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
            className="text-primary underline-offset-4 hover:underline">
            {t('stocktake.ui.slims_report.download')}
          </a>
        ),
    },
  ];
  return (
    <div className="flex max-w-6xl flex-col gap-4">
      <h1 className="text-2xl font-semibold">{t('stocktake.ui.title')}</h1>
      <p className="text-sm text-muted-foreground">{t('stocktake.ui.intro')}</p>
      {branches !== undefined && branchId !== null && branches.length > 1 && <BranchPicker branches={branches} branchId={branchId} choose={choose} />}
      {live !== undefined && (
        <Notice kind="success" action={<Link to="/admin/layanan/inventarisasi/$branchId/$id" params={{ branchId: live.branch.id, id: live.id }} className="font-medium underline">{t('stocktake.ui.open')}</Link>}>
          {t('stocktake.ui.live', { name: live.name })}
        </Notice>
      )}
      {manage && branchId !== null && live === undefined && <NewSession branchId={branchId} />}
      <h2 className="text-lg font-semibold">{t('stocktake.ui.history')}</h2>
      <MasterTable caption={t('stocktake.ui.history')} columns={columns} rows={list.data?.items ?? []} empty={t('stocktake.ui.empty')} />
    </div>
  );
}

function BranchPicker({ branches, branchId, choose }: { branches: BranchView[]; branchId: string; choose(id: string): void }) {
  const t = useT();
  const id = useId();
  return (
    <Field id={id} label={t('stocktake.ui.branch')} className="max-w-xs">
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
    <section className="grid gap-3 rounded-lg border bg-card p-4">
      <h2 className="text-lg font-semibold">{t('stocktake.ui.new.title')}</h2>
      <p className="text-sm text-muted-foreground">{t('stocktake.ui.new.intro')}</p>
      <form noValidate onSubmit={(e) => void submit(e)} className="grid gap-3 md:grid-cols-2">
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
    </section>
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

const OUTCOME_STYLE: Record<StocktakeScanOutcome, string> = {
  found: 'border-green-600 bg-green-50 text-green-900 dark:bg-green-950 dark:text-green-100',
  misplaced: 'border-amber-500 bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-100',
  already_found: 'border-slate-400 bg-slate-50 text-slate-900 dark:bg-slate-900 dark:text-slate-100',
  on_loan: 'border-amber-500 bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-100',
  unexpected: 'border-amber-500 bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-100',
  unknown: 'border-red-600 bg-red-50 text-red-900 dark:bg-red-950 dark:text-red-100',
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

  if (session.isError) {
    return (
      <div className="flex max-w-4xl flex-col gap-4">
        <h1 className="text-2xl font-semibold">{t('stocktake.ui.title')}</h1>
        <ProblemAlert error={session.error} />
      </div>
    );
  }
  if (s === undefined || shown === undefined) return <p className="text-sm text-muted-foreground">{t('stocktake.ui.loading')}</p>;

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

  return (
    <div className="flex max-w-6xl flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link to="/admin/layanan/inventarisasi" className="text-sm text-primary underline-offset-4 hover:underline">
          {t('stocktake.ui.back')}
        </Link>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">{s.name}</h1>
        <Badge tone={statusTone(s.status)}>{t(`vocab.stocktake_status.${s.status}`)}</Badge>
        <span className="text-sm text-muted-foreground">
          {s.branch.name} · {time(s.startedAt)}
          {s.startedBy !== null ? ` · ${s.startedBy.name}` : ''}
          {s.finishedAt !== null ? ` — ${t('stocktake.ui.finished_at', { time: time(s.finishedAt) })}${s.finishedBy !== null ? ` · ${s.finishedBy.name}` : ''}` : ''}
        </span>
      </div>
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7" aria-live="polite">
        {tiles.map(([key, n]) => (
          <div key={key} className="rounded-md border bg-card p-3">
            <dt className="text-xs text-muted-foreground">{t(key)}</dt>
            <dd className="text-2xl font-semibold tabular-nums">{n}</dd>
          </div>
        ))}
      </dl>
      <p className="text-sm text-muted-foreground">{t('stocktake.ui.progress', { pct })}</p>

      {(s.status === 'preparing' || s.status === 'finishing') && s.jobId !== null && (
        <section className="grid gap-2 rounded-lg border bg-card p-4">
          <h2 className="text-base font-semibold">{t(s.status === 'preparing' ? 'stocktake.ui.preparing' : 'stocktake.ui.finishing')}</h2>
          <JobProgress jobId={s.jobId} onDone={() => void refresh()} />
        </section>
      )}

      {active && (
        <section className="grid gap-3 rounded-lg border-2 border-primary/40 bg-card p-4">
          <form
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void doScan(code);
            }}
            className="flex flex-wrap items-end gap-3"
          >
            <Field label={t('stocktake.ui.scan.label')} hint={t('stocktake.ui.scan.hint')} className="min-w-72 flex-1">
              {(c) => (
                <Input
                  {...c}
                  ref={inputRef}
                  autoFocus
                  autoComplete="off"
                  maxLength={200}
                  className="h-12 text-lg"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
              )}
            </Field>
            <Field id={locId} label={t('stocktake.ui.scan.location')} className="min-w-64">
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
            <Button type="submit" className="h-12">
              {t('stocktake.ui.scan.submit')}
            </Button>
          </form>
          {last !== null && (
            <div role="status" aria-live="assertive" className={`rounded-md border-l-8 p-3 ${OUTCOME_STYLE[last.outcome]}`} data-outcome={last.outcome}>
              <p className="text-lg font-semibold">
                {t(`vocab.stocktake_scan.${last.outcome}`)} · <span className="font-mono">{last.code}</span>
              </p>
              {last.title !== null && <p className="text-sm">{last.title}</p>}
              <p className="text-sm">{t(`stocktake.ui.scan.explain.${last.outcome}`, { location: last.location ?? '—' })}</p>
            </div>
          )}
          <ProblemAlert error={problem} />
          {recent.length > 0 && (
            <div className="grid gap-1">
              <h3 className="text-sm font-semibold">{t('stocktake.ui.recent')}</h3>
              <ul className="grid gap-1 text-sm">
                {recent.map((r) => (
                  <li key={r.key} className="flex flex-wrap items-center gap-2 rounded border px-2 py-1">
                    <Badge tone={r.outcome === 'found' ? 'info' : r.outcome === 'unknown' ? 'warning' : 'neutral'}>{t(`vocab.stocktake_scan.${r.outcome}`)}</Badge>
                    <span className="font-mono">{r.code}</span>
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">{r.title ?? ''}</span>
                    {r.undone === true ? (
                      <span className="text-xs text-muted-foreground">{t('stocktake.ui.undone')}</span>
                    ) : (
                      (r.outcome === 'found' || r.outcome === 'misplaced' || r.outcome === 'unexpected') && (
                        <Button size="sm" variant="outline" onClick={() => void undo(r)}>
                          {t('stocktake.ui.undo')}
                        </Button>
                      )
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="flex flex-wrap items-end gap-3 border-t pt-3">
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
        </section>
      )}

      <div className="flex flex-wrap gap-2">
        <a href={`/api/v1/${base}/minutes`} target="_blank" rel="noreferrer" className="inline-flex h-9 items-center rounded-md border px-3 text-sm font-medium hover:bg-muted">
          {t('stocktake.ui.minutes')}
        </a>
        {s.migratedReport !== null && (
          <a href={`/api/v1/${base}/slims-report`} download className="inline-flex h-9 items-center rounded-md border px-3 text-sm font-medium hover:bg-muted">
            {t('stocktake.ui.slims_report.session')}
          </a>
        )}
        {manage && active && (
          <Button variant="destructive" onClick={() => setFinishing(true)}>
            {t('stocktake.ui.finish.open')}
          </Button>
        )}
        {manage && (s.status === 'preparing' || s.status === 'active') && (
          <Button variant="outline" onClick={() => setCancelling(true)}>
            {t('stocktake.ui.cancel.open')}
          </Button>
        )}
      </div>

      <div role="tablist" aria-label={t('stocktake.ui.lists')} className="flex flex-wrap gap-1 border-b">
        {TABS.map((x) => (
          <button
            key={x}
            type="button"
            role="tab"
            aria-selected={tab === x}
            className={`rounded-t-md px-3 py-2 text-sm ${tab === x ? 'border border-b-0 bg-card font-semibold' : 'text-muted-foreground hover:text-foreground'}`}
            onClick={() => setTab(x)}
          >
            {x === 'unknown' ? t('stocktake.ui.tab.unknown') : x === 'officers' ? t('stocktake.ui.tab.officers') : t(`vocab.stocktake_state.${x}`)}
          </button>
        ))}
      </div>
      <div role="tabpanel">
        {tab === 'unknown' ? <UnknownList base={base} /> : tab === 'officers' ? <OfficerList base={base} /> : <ItemList base={base} id={id} state={tab} />}
      </div>

      <FinishDialog open={finishing} session={s} base={base} onClose={() => setFinishing(false)} onDone={() => void refresh()} />
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
  const columns: MasterColumn<(typeof rows)[number]>[] = [
    { id: 'barcode', header: t('stocktake.ui.col.barcode'), cell: (r) => <span className="font-mono">{r.barcode}</span> },
    { id: 'title', header: t('stocktake.ui.col.title'), cell: (r) => r.title },
    { id: 'call', header: t('stocktake.ui.col.call_number'), cell: (r) => r.callNumber ?? '—' },
    { id: 'location', header: t('stocktake.ui.col.location'), cell: (r) => r.expectedLocation?.name ?? '—' },
    ...(state === 'misplaced' ? [{ id: 'scanned_location', header: t('stocktake.ui.col.scanned_location'), cell: (r: (typeof rows)[number]) => r.scannedLocation?.name ?? '—' }] : []),
    { id: 'status', header: t('stocktake.ui.col.item_status'), cell: (r) => t(`vocab.item_status.${r.currentStatus}` as TKey) },
    { id: 'scanned', header: t('stocktake.ui.col.scanned'), cell: (r) => (r.scannedAt === null ? '—' : `${time(r.scannedAt)}${r.scannedBy === null ? '' : ` · ${r.scannedBy.name}`}`) },
    { id: 'result', header: t('stocktake.ui.col.result'), cell: (r) => (r.result === null ? '—' : t(`vocab.stocktake_result.${r.result}`)) },
  ];
  return (
    <div className="grid gap-2">
      <MasterTable caption={t(`vocab.stocktake_state.${state}`)} columns={columns} rows={rows} empty={t('stocktake.ui.list_empty')} />
      <div className="flex gap-2">
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
  const columns: MasterColumn<(typeof rows)[number]>[] = [
    { id: 'code', header: t('stocktake.ui.col.code'), cell: (r) => <span className="font-mono">{r.code}</span> },
    { id: 'seen', header: t('stocktake.ui.col.seen'), cell: (r) => r.seen },
    { id: 'last', header: t('stocktake.ui.col.last_seen'), cell: (r) => time(r.lastAt) },
    { id: 'by', header: t('stocktake.ui.col.officer'), cell: (r) => r.scannedBy?.name ?? '—' },
  ];
  return <MasterTable caption={t('stocktake.ui.tab.unknown')} columns={columns} rows={rows} empty={t('stocktake.ui.list_empty')} />;
}

function OfficerList({ base }: { base: string }) {
  const t = useT();
  const q = useApiQuery<StocktakeOfficersResponse>({ queryKey: ['stocktake', 'officers', base], path: `${base}/officers`, refetchInterval: POLL_MS * 2 });
  const rows = (q.data?.items ?? []).map((r, i) => ({ ...r, id: r.id ?? `n${i}` }));
  const columns: MasterColumn<(typeof rows)[number]>[] = [
    { id: 'name', header: t('stocktake.ui.col.officer'), cell: (r) => r.name },
    { id: 'found', header: t('stocktake.ui.count.found'), cell: (r) => r.found },
    { id: 'misplaced', header: t('stocktake.ui.count.misplaced'), cell: (r) => r.misplaced },
    { id: 'unexpected', header: t('stocktake.ui.count.unexpected'), cell: (r) => r.unexpected },
  ];
  return <MasterTable caption={t('stocktake.ui.tab.officers')} columns={columns} rows={rows} empty={t('stocktake.ui.list_empty')} />;
}

function FinishDialog({ open, session, base, onClose, onDone }: { open: boolean; session: StocktakeView; base: string; onClose(): void; onDone(): void }) {
  const t = useT();
  const focus = useReturnFocus();
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
    <Dialog open={open} onOpenChange={(next) => (next || busy ? undefined : onClose())}>
      {open && (
        <DialogContent closeLabel={t('form.cancel')} onOpenAutoFocus={focus.onOpenAutoFocus} onCloseAutoFocus={focus.onCloseAutoFocus}>
          <DialogHeader>
            <DialogTitle>{t('stocktake.ui.finish.title')}</DialogTitle>
            <DialogDescription>{t('stocktake.ui.finish.intro', { pending: session.counts.pending, onLoan: session.counts.onLoan })}</DialogDescription>
          </DialogHeader>
          <form noValidate onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
            <CheckField label={t('stocktake.ui.finish.mark_missing')} hint={t('stocktake.ui.finish.mark_missing_hint')} checked={markMissing} onChange={(e) => setMarkMissing(e.target.checked)} />
            <CheckField label={t('stocktake.ui.finish.restore_found')} hint={t('stocktake.ui.finish.restore_found_hint')} checked={restoreFound} onChange={(e) => setRestoreFound(e.target.checked)} />
            <Field label={t('stocktake.ui.finish.type_name', { name: session.name })} error={mismatch ? 'stocktake.ui.finish.mismatch' : undefined}>
              {(c) => <Input {...c} autoComplete="off" maxLength={191} value={confirmName} onChange={(e) => setConfirmName(e.target.value)} />}
            </Field>
            <ProblemAlert error={problem} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
                {t('form.cancel')}
              </Button>
              <Button type="submit" variant="destructive" disabled={busy}>
                {t('stocktake.ui.finish.submit')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      )}
    </Dialog>
  );
}

