import { ACCRED_GROUPS, isUlid } from '@altis/shared';
import type { BranchListResponse } from '@altis/shared/api/branches';
import { PRICE_MODES, SlimsDbSource, SlimsPeopleOptions, type SlimsStartBody } from '@altis/shared/api/catalog/migration';
import type { RunListResponse, RunStarted, RunView } from '@altis/shared/api/catalog/runs';
import type { UploadContextName } from '@altis/shared/api/files';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { z } from 'zod';
import { useDateTime } from '@/components/data-table';
import { CheckField, Field, Notice, NoticeAlert, ProblemAlert } from '@/components/form-field';
import { DenseTable, FactList, LoadingState, PageHead, Section, Steps, Tag, type DenseColumn, type TagTone } from '@/components/layout';
import { JobProgress } from '@/components/job-progress';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useT, type TKey } from '@/i18n';
import { holds, meId } from '@/lib/access';
import { ApiError, api } from '@/lib/api';
import { problemText } from '@/lib/form-errors';
import { useApiQuery, useMe } from '@/lib/me';
import { uploadFile } from '@/lib/upload';
import { useBytes } from '@/screens/backups/upload';
import { ProgressBar } from '@/screens/jobs/list';
import {
  ACTIVE_BRANCHES_KEY,
  CatalogModeNote,
  EMPTY_OPTIONS,
  NonEmptyConfirm,
  OptionsStep,
  SkipCatalogField,
  canSkipCatalog,
  catalogModeLabel,
  checkOptions,
  confirmError,
  priceModeLabel,
  type OptionsDraft,
  type OptionsErrors,
} from './options-step';
import { CutoverChecklist, PeopleFields, peopleBody, peopleDraftOf } from './people';
import { ReportView, readReport, stageText } from './report-view';
import { EMPTY_SOURCE, SourceStep, checkDb, checkSource, hasSourceErrors, type SourceDraft, type SourceErrors } from './source-step';

/**
 * Migrasi SLiMS (Phase 2 spec §11, §13; plan Task 30; routes of Task 23): a super admin's wizard (`catalog.migration.run`,
 * M1; every start re-authenticated, the reauth dialog opening when the server asks).
 *
 * 1. **Sumber** (source-step.tsx): a SLiMS database with "Uji koneksi", or a dump; the files zip.
 * 2. **Opsi** (options-step.tsx): target branch, `priceMode`, source name (S13), "izinkan target tidak kosong" with
 *    the library's name typed out, and the catalogue mode (`catalogMode`: add new rows only, or re-sync with SLiMS).
 * 3. **Uji kering:** the dump and the zip go up (`slims.dump`, `slims.files`; an upload that went up already is not
 *    sent again when only the start failed), then `POST catalog/migrations/slims {…, dryRun: true}`. The password is
 *    emptied from the page once the start is sent.
 * 4. **Progress and report:** the screen moves to `?run=<runId>` and follows the run: `JobProgress` (realtime, polling,
 *    and the drive loop where no worker runs) and `GET catalog/runs/:id` every few seconds while it is live; once it
 *    ended, the report (report-view.tsx).
 * 5. **Jalankan migrasi** under a succeeded dry run (S3): `POST {fromRunId, …, dryRun: false}` with the dry run's
 *    branch, price mode and source name. A dump source sends no `source` and no `filesUploadId` (the dry run's staging
 *    and archive are adopted, nothing goes up again); a database source sends `source` again with the password asked
 *    again (it is never kept past a run). "Izinkan target tidak kosong" is confirmed again here, where the guard
 *    applies. The panel says what the dry run's catalogue mode does with the rows mapped before, and the real run keeps
 *    that mode. After a re-sync dry run that found no catalogue change, "Lewati tahap katalog" sends `skipCatalog`; the
 *    server checks it again (422 MIGRATION_PRECHECK_FAILED `catalog_changed` otherwise, answered with the advice to
 *    run a re-sync).
 *
 * The start answers 201 for a new run, or 200 `{joined: true}` when a migration is live already (one at a time): the
 * screen then shows that one. A migration still running when the screen opens (no `?run=`) is followed at once, so a
 * reload or another visit picks up the run (and drives it again where the open page is what runs it). The history
 * lists the recent runs, each with its report.
 */

const SCREEN = '/admin/catalog/migration';
/** Every query of the migration runs list. */
const RUNS_KEY = ['catalog', 'runs', { kind: 'migration' }] as const;
const runKey = (id: string): readonly unknown[] => ['catalog', 'runs', id];
/** A live run is read again this often (its job's progress comes through JobProgress). */
const RUN_POLL_MS = 5_000;
/** How long a dry run can be taken over (S2/S3: its work folder is kept 7 days). */
const DRY_RUN_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
/** How many runs the history shows. */
const HISTORY_LIMIT = 20;

/**
 * A run still moving: queued or running, and its job too (C17: a run whose job ended outside it, cancelled while
 * queued or dead, is left as it was until the next start or the daily housekeeping ends it; it is not followed).
 */
const isLive = (run: Pick<RunView, 'status' | 'jobStatus'>): boolean =>
  (run.status === 'queued' || run.status === 'running') && (run.jobStatus === undefined || run.jobStatus === 'queued' || run.jobStatus === 'running');

/**
 * The status a run shows: one still queued or running whose job ended without it (cancelled from the jobs page between
 * two slices, or dead) shows the end the next start or the daily housekeeping gives it, not "running".
 */
function shownStatus(run: Pick<RunView, 'status' | 'jobStatus'>): RunView['status'] {
  if ((run.status !== 'queued' && run.status !== 'running') || isLive(run) || run.jobStatus === undefined) return run.status;
  return run.jobStatus === 'cancelled' ? 'cancelled' : 'failed';
}

/** The run the address names (`?run=`), or null. */
function runOf(search: Record<string, unknown>): string | null {
  const run = search['run'];
  return typeof run === 'string' && isUlid(run) ? run : null;
}

/** What a start answers: a new run (201), or the live migration it joined (200 `joined: true`). */
type StartAnswer = RunStarted & { joined?: boolean };

/** Opens `runId` on the screen; `joined` when the start joined a live migration instead of starting one. */
type OpenRun = (runId: string, o?: { joined?: boolean }) => void;

/** The first field error of a VALIDATION_FAILED at a path that starts with `path`, or null. */
function fieldError(e: unknown, path: string): string | null {
  if (!(e instanceof ApiError) || e.code !== 'VALIDATION_FAILED') return null;
  const hit = (e.errors ?? []).find((x) => x.path === path || x.path.startsWith(`${path}.`));
  return hit === undefined ? null : hit.code;
}

// ---- the dry run wizard ------------------------------------------------------------------------------------------

type Upload = 'dump' | 'files';

type Phase =
  | { kind: 'idle' }
  | { kind: 'hashing' | 'sending'; which: Upload; done: number; total: number }
  | { kind: 'starting' };

function Wizard({
  source,
  options,
  libraryName,
  onSource,
  onOptions,
  onOpen,
}: {
  source: SourceDraft;
  options: OptionsDraft;
  libraryName: string;
  onSource(next: SourceDraft): void;
  onOptions(next: OptionsDraft): void;
  onOpen: OpenRun;
}) {
  const t = useT();
  const bytes = useBytes();
  const queryClient = useQueryClient();
  // The options step reads the same query: the start waits for the branches (and so for the default branch).
  const branches = useApiQuery<BranchListResponse>({ queryKey: ACTIVE_BRANCHES_KEY, path: 'branches' });
  const [step, setStep] = useState<'source' | 'options'>('source');
  const [sourceErrors, setSourceErrors] = useState<SourceErrors>({});
  const [optionErrors, setOptionErrors] = useState<OptionsErrors>({});
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [failure, setFailure] = useState<{ text: string; info?: boolean } | null>(null);
  /** The uploads that went up already, per file: a start that failed after them does not send them again. */
  const uploaded = useRef<Partial<Record<Upload, { file: File; uploadId: string }>>>({});
  const run = useRef<AbortController | null>(null);
  useEffect(() => () => run.current?.abort(), []);
  const busy = phase.kind !== 'idle';
  /** A start is under way (set at once: a second click before the next render starts nothing). */
  const starting = useRef(false);

  const changeSource = useCallback(
    (next: SourceDraft) => {
      setSourceErrors({});
      onSource(next);
    },
    [onSource],
  );
  const changeOptions = useCallback(
    (next: OptionsDraft) => {
      setOptionErrors({});
      onOptions(next);
    },
    [onOptions],
  );

  const next = (): void => {
    const errors = checkSource(source);
    setSourceErrors(errors);
    if (!hasSourceErrors(errors)) setStep('options');
  };

  /** The upload id of `file` for `which`: the one that went up already, else a new upload. */
  const uploadOnce = async (which: Upload, file: File, context: UploadContextName, signal: AbortSignal): Promise<string> => {
    const done = uploaded.current[which];
    if (done !== undefined && done.file === file) return done.uploadId;
    setPhase({ kind: 'hashing', which, done: 0, total: file.size });
    const { uploadId } = await uploadFile(file, {
      context,
      signal,
      onHashProgress: (n, total) => setPhase(n >= total ? { kind: 'sending', which, done: 0, total } : { kind: 'hashing', which, done: n, total }),
      onProgress: (n, total) => setPhase({ kind: 'sending', which, done: n, total }),
    });
    uploaded.current[which] = { file, uploadId };
    return uploadId;
  };

  const start = async (): Promise<void> => {
    if (starting.current) return;
    const sErrors = checkSource(source);
    if (hasSourceErrors(sErrors)) {
      setSourceErrors(sErrors);
      setStep('source');
      return;
    }
    const oErrors = checkOptions(options, libraryName);
    setOptionErrors(oErrors);
    setFailure(null);
    if (Object.keys(oErrors).length > 0) return;
    starting.current = true;
    const controller = new AbortController();
    run.current = controller;
    const { signal } = controller;
    try {
      let from: SlimsStartBody['source'];
      if (source.kind === 'db') {
        from = checkDb(source.db).source;
      } else {
        from = { kind: 'dump', uploadId: await uploadOnce('dump', source.dump!, 'slims.dump', signal) };
      }
      const filesUploadId = source.files === null ? undefined : await uploadOnce('files', source.files, 'slims.files', signal);
      setPhase({ kind: 'starting' });
      const body: SlimsStartBody = {
        source: from,
        ...(filesUploadId === undefined ? {} : { filesUploadId }),
        branchId: options.branchId,
        priceMode: options.priceMode,
        sourceName: options.sourceName,
        allowNonEmpty: options.allowNonEmpty,
        ...(options.allowNonEmpty ? { confirmLibraryName: options.confirmLibraryName } : {}),
        dryRun: true,
        ...(options.catalogMode === 'sync' ? { catalogMode: 'sync' as const } : {}),
        ...peopleBody(options.people),
      };
      const started = await api<StartAnswer>('POST', 'catalog/migrations/slims', body, { signal });
      // A new run took the uploads; a joined one took nothing, and they stay usable for a later start.
      if (started.joined !== true) uploaded.current = {};
      // The password is asked again for the real run: it is not kept in this page.
      onSource({ ...source, db: { ...source.db, password: '' } });
      onOpen(started.runId, { joined: started.joined === true });
    } catch (e) {
      if (signal.aborted) {
        setFailure({ text: t('catalog.migration.upload_cancelled'), info: true });
        return;
      }
      if (fieldError(e, 'source.uploadId') === 'not_found' || fieldError(e, 'filesUploadId') === 'not_found') {
        uploaded.current = {};
        setFailure({ text: t('catalog.migration.upload_gone') });
      } else if (fieldError(e, 'branchId') !== null) {
        setOptionErrors({ branchId: 'catalog.migration.branch_gone' });
        void queryClient.invalidateQueries({ queryKey: ACTIVE_BRANCHES_KEY });
      } else if (fieldError(e, 'sourceName') !== null) {
        setOptionErrors({ sourceName: 'catalog.migration.options.source_name_invalid' });
      } else {
        setFailure({ text: problemText(t, e) });
      }
    } finally {
      starting.current = false;
      if (run.current === controller) run.current = null;
      setPhase({ kind: 'idle' });
    }
  };

  const steps = (
    <Steps
      steps={[t('catalog.migration.source.title'), t('catalog.migration.options.title')]}
      current={step === 'source' ? 0 : 1}
      label={t('catalog.migration.steps')}
      doneLabel={t('catalog.migration.step_done')}
    />
  );
  if (step === 'source') {
    return (
      <div className="grid gap-5">
        {steps}
        <SourceStep value={source} errors={sourceErrors} onChange={changeSource} onNext={next} />
      </div>
    );
  }

  const uploading = phase.kind === 'hashing' || phase.kind === 'sending' ? phase : null;
  const pct = uploading === null || uploading.total === 0 ? 0 : (uploading.done / uploading.total) * 100;
  const uploadLabel: TKey | null =
    uploading === null
      ? null
      : uploading.kind === 'hashing'
        ? 'catalog.migration.hashing'
        : uploading.which === 'dump'
          ? 'catalog.migration.uploading_dump'
          : 'catalog.migration.uploading_files';

  return (
    <div className="grid gap-5">
      {steps}
      <OptionsStep value={options} errors={optionErrors} libraryName={libraryName} onChange={changeOptions}>
        {uploading !== null && uploadLabel !== null && (
          <div className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <span className="font-semibold">{t(uploadLabel)}</span>
              <span className="tabular-nums">{Math.round(pct)} %</span>
            </div>
            <ProgressBar value={pct} label={t(uploadLabel)} />
            <p className="text-xs text-muted-foreground tabular-nums">
              {t('catalog.migration.upload_amount', { done: bytes(uploading.done), total: bytes(uploading.total) })}
            </p>
          </div>
        )}
        {phase.kind === 'starting' && (
          <p role="status" className="text-sm text-muted-foreground">
            {t('catalog.migration.starting')}
          </p>
        )}
        {failure !== null && (failure.info === true ? <NoticeAlert>{failure.text}</NoticeAlert> : <Notice kind="error">{failure.text}</Notice>)}
        <div className="flex flex-wrap gap-2 border-t pt-4">
          <Button type="button" variant="outline" disabled={busy} onClick={() => setStep('source')}>
            {t('catalog.migration.back')}
          </Button>
          <Button type="button" disabled={busy || branches.data === undefined} onClick={() => void start()}>
            {t('catalog.migration.start_dry')}
          </Button>
          {uploading !== null && (
            <Button type="button" variant="outline" onClick={() => run.current?.abort()}>
              {t('catalog.migration.cancel_upload')}
            </Button>
          )}
        </div>
      </OptionsStep>
    </div>
  );
}

// ---- the real run (S3) ---------------------------------------------------------------------------------------------

/** The SLiMS member types a dry run listed (its summary's `memberTypes`), for the group step of the real run. */
const MemberTypesOfRun = z.array(z.object({ id: z.string(), name: z.string(), members: z.number(), group: z.enum(ACCRED_GROUPS) }));

function readMemberTypes(summary: Record<string, unknown> | null): z.infer<typeof MemberTypesOfRun> | undefined {
  const parsed = MemberTypesOfRun.safeParse(summary?.['memberTypes']);
  return parsed.success ? parsed.data : undefined;
}

/** What the real run reads of a dry run's options (Task 23's `catalog_runs.options`; never a password). */
const DryRunOptions = z.object({
  sourceKind: z.enum(['db', 'dump']),
  db: z.object({ host: z.string(), port: z.number(), user: z.string(), database: z.string(), tls: z.boolean() }).nullable(),
  branchId: z.string(),
  priceMode: z.enum(PRICE_MODES),
  sourceName: z.string(),
  allowNonEmpty: z.boolean(),
  files: z.enum(['zip', 'dir']).nullable().catch(null),
  adoptedBy: z.string().optional(),
  // ---- Komunitas K1 (catalogue re-sync) ----
  // Absent in the runs of an earlier release: `append`, without a skip.
  catalogMode: z.enum(['append', 'sync']).optional().catch(undefined),
  skipCatalog: z.boolean().optional().catch(undefined),
  // ---- Komunitas (SLiMS members and circulation) ----
  people: SlimsPeopleOptions.optional().catch(undefined),
});

type DryRunOptions = z.infer<typeof DryRunOptions>;

interface RealErrors {
  password?: TKey;
  confirm?: TKey;
}

/** "Jalankan migrasi" under a succeeded dry run of the user, not taken over yet and less than 7 days old. */
function RealRunPanel({
  dryRun,
  options,
  draft,
  libraryName,
  onOpen,
}: {
  dryRun: RunView;
  options: DryRunOptions;
  draft: OptionsDraft;
  libraryName: string;
  onOpen: OpenRun;
}) {
  const t = useT();
  const titleId = useId();
  const queryClient = useQueryClient();
  const branches = useApiQuery<BranchListResponse>({ queryKey: ACTIVE_BRANCHES_KEY, path: 'branches' });
  const branch = branches.data?.items.find((b) => b.id === options.branchId);
  const db = options.sourceKind === 'db' ? options.db : null;
  const [password, setPassword] = useState('');
  const [noPassword, setNoPassword] = useState(false);
  const [allowNonEmpty, setAllowNonEmpty] = useState(options.allowNonEmpty);
  const [typed, setTyped] = useState(draft.allowNonEmpty ? draft.confirmLibraryName : '');
  const [errors, setErrors] = useState<RealErrors>({});
  const [busy, setBusy] = useState(false);
  /** The start is under way (set at once: a second click before the next render sends nothing). */
  const sending = useRef(false);
  const [failure, setFailure] = useState<string | null>(null);
  const report = readReport(dryRun.summary);
  const reconciled = report?.reconciliation;
  const catalogMode = options.catalogMode ?? 'append';
  const skipAllowed = canSkipCatalog(options, report?.catalogChanges);
  const [skipCatalog, setSkipCatalog] = useState(false);
  // ---- Komunitas (SLiMS members and circulation): the dry run's options, its member types' groups editable ----
  const [people, setPeople] = useState(() => peopleDraftOf(options.people));
  const memberTypes = readMemberTypes(dryRun.summary);

  const submit = async (): Promise<void> => {
    if (sending.current) return;
    const found: RealErrors = {};
    let source: SlimsDbSource | undefined;
    if (db !== null) {
      if (password === '' && !noPassword) found.password = 'catalog.migration.real.password_required';
      const checked = SlimsDbSource.safeParse({ kind: 'db', ...db, password: noPassword ? '' : password });
      if (checked.success) source = checked.data;
      else found.password ??= 'form.error.too_big';
    }
    const confirm = confirmError(allowNonEmpty, typed, libraryName);
    if (confirm !== undefined) found.confirm = confirm;
    setErrors(found);
    setFailure(null);
    if (Object.keys(found).length > 0) return;
    const body: SlimsStartBody = {
      fromRunId: dryRun.id,
      ...(source === undefined ? {} : { source }),
      branchId: options.branchId,
      priceMode: options.priceMode,
      sourceName: options.sourceName,
      allowNonEmpty,
      ...(allowNonEmpty ? { confirmLibraryName: typed } : {}),
      dryRun: false,
      ...(catalogMode === 'sync' ? { catalogMode: 'sync' as const } : {}),
      ...(skipAllowed && skipCatalog ? { skipCatalog: true } : {}),
      ...peopleBody(people),
    };
    sending.current = true;
    setBusy(true);
    try {
      const started = await api<StartAnswer>('POST', 'catalog/migrations/slims', body);
      setPassword('');
      onOpen(started.runId, { joined: started.joined === true });
    } catch (e) {
      if (fieldError(e, 'fromRunId') !== null) {
        setFailure(t('catalog.migration.real.unusable'));
        void queryClient.invalidateQueries({ queryKey: runKey(dryRun.id) });
      } else if (fieldError(e, 'source') !== null) {
        setFailure(t('catalog.migration.real.source_mismatch'));
      } else if (fieldError(e, 'branchId') !== null) {
        setFailure(t('catalog.migration.branch_gone'));
      } else if (e instanceof ApiError && e.code === 'MIGRATION_TARGET_NOT_EMPTY') {
        setFailure(t('catalog.migration.real.not_empty'));
      } else if (e instanceof ApiError && e.code === 'MIGRATION_PRECHECK_FAILED' && e.reason === 'catalog_changed') {
        setFailure(t('catalog.migration.real.catalog_changed'));
      } else if (fieldError(e, 'skipCatalog') !== null) {
        setFailure(t('catalog.migration.real.skip_needs_sync'));
      } else if (e instanceof ApiError && e.code === 'MIGRATION_PRECHECK_FAILED' && e.reason === 'member_no_collision') {
        setFailure(t('catalog.migration.people.collision_refused'));
      } else if (e instanceof ApiError && e.code === 'MIGRATION_CIRCULATION_LIVE') {
        setFailure(t('catalog.migration.people.circulation_live'));
      } else {
        setFailure(problemText(t, e));
      }
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby={titleId} className="grid max-w-4xl gap-4 border-t pt-6">
      <h2 id={titleId} className="text-base font-bold">
        {t('catalog.migration.real.title')}
      </h2>
      <p className="max-w-[75ch] text-sm text-muted-foreground">{t('catalog.migration.real.description')}</p>
      <CatalogModeNote mode={catalogMode} />
      {reconciled !== undefined && reconciled !== null && !reconciled.ok && <Notice kind="error">{t('catalog.migration.real.reconcile_warning')}</Notice>}
      <FactList
        className="max-w-2xl"
        items={[
          {
            key: 'source',
            label: t('catalog.migration.real.source'),
            value: `${
              db === null ? t('catalog.migration.real.source_dump') : t('catalog.migration.real.source_db', { database: db.database, host: db.host, port: String(db.port) })
            } · ${t(options.files === 'zip' ? 'catalog.migration.real.files_yes' : 'catalog.migration.real.files_no')}`,
          },
          { key: 'branch', label: t('catalog.migration.real.branch'), value: branch === undefined ? options.branchId : `${branch.name} (${branch.code})` },
          { key: 'price', label: t('catalog.migration.real.price'), value: t(priceModeLabel(options.priceMode)) },
          { key: 'name', label: t('catalog.migration.real.source_name'), value: options.sourceName },
          { key: 'mode', label: t('catalog.migration.options.catalog_mode'), value: t(catalogModeLabel(catalogMode)) },
        ]}
      />
      <SkipCatalogField allowed={skipAllowed} checked={skipCatalog} disabled={busy} onChange={setSkipCatalog} />
      <PeopleFields value={people} onChange={setPeople} memberTypes={memberTypes} />
      {db !== null && (
        <div className="grid gap-3 md:max-w-md">
          <Field label={t('catalog.migration.db.password')} hint={t('catalog.migration.db.password_hint')} error={errors.password}>
            {(c) => (
              <Input
                {...c}
                type="password"
                value={password}
                maxLength={200}
                autoComplete="new-password"
                disabled={noPassword}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setErrors((old) => ({ ...old, password: undefined }));
                }}
              />
            )}
          </Field>
          <CheckField
            label={t('catalog.migration.real.no_password')}
            checked={noPassword}
            onChange={(e) => {
              setNoPassword(e.target.checked);
              setErrors((old) => ({ ...old, password: undefined }));
            }}
          />
        </div>
      )}
      <NonEmptyConfirm
        allowNonEmpty={allowNonEmpty}
        typed={typed}
        libraryName={libraryName}
        error={errors.confirm}
        onChange={(next) => {
          setAllowNonEmpty(next.allowNonEmpty);
          setTyped(next.confirmLibraryName);
          setErrors((old) => ({ ...old, confirm: undefined }));
        }}
      />
      {failure !== null && <Notice kind="error">{failure}</Notice>}
      <div className="flex flex-wrap gap-2 border-t pt-4">
        <Button type="button" disabled={busy} onClick={() => void submit()}>
          {busy ? t('catalog.migration.real.working') : t('catalog.migration.real.submit')}
        </Button>
      </div>
    </section>
  );
}

/** Why a succeeded dry run cannot be taken over by `userId` at `now`, or null when it can. */
function notUsable(run: RunView, options: DryRunOptions | null, userId: string | null, now: number): 'adopted' | 'expired' | 'unusable' | null {
  if (options === null || run.createdBy === null || run.createdBy !== userId) return 'unusable';
  if (options.adoptedBy !== undefined) return 'adopted';
  if (run.finishedAt === null || run.finishedAt <= now - DRY_RUN_KEEP_MS) return 'expired';
  return null;
}

// ---- a run ---------------------------------------------------------------------------------------------------------

function RunSection({
  runId,
  joined,
  draft,
  libraryName,
  onOpen,
  onNew,
}: {
  runId: string;
  joined: boolean;
  draft: OptionsDraft;
  libraryName: string;
  onOpen: OpenRun;
  onNew(): void;
}) {
  const t = useT();
  const me = useMe();
  const dateTime = useDateTime();
  const queryClient = useQueryClient();
  const titleId = useId();
  const query = useApiQuery<RunView>({
    queryKey: runKey(runId),
    path: `catalog/runs/${encodeURIComponent(runId)}`,
    // Reads nobody asked for (the page may stay open for hours): they never keep the session alive (§7.1).
    request: { background: true },
    retry: (count, e) => !(e instanceof ApiError) && count < 2,
    refetchInterval: (q) => (q.state.data !== undefined && isLive(q.state.data) ? RUN_POLL_MS : false),
  });
  const ended = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: runKey(runId) });
    void queryClient.invalidateQueries({ queryKey: RUNS_KEY });
  }, [queryClient, runId]);
  const run = query.data;
  // Read once per run shown: a dry run turns too old while the page stays open only after a reload.
  const [now] = useState(() => Date.now());

  const newButton = (
    <Button type="button" variant="outline" onClick={onNew}>
      {t('catalog.migration.run.new')}
    </Button>
  );

  if (run === undefined || run.kind !== 'migration') {
    if (run === undefined && !query.isError) return <LoadingState label={t('catalog.migration.loading')} />;
    const notFound = run !== undefined || (query.error instanceof ApiError && query.error.code === 'NOT_FOUND');
    return (
      <div className="grid justify-items-start gap-3">
        {notFound ? <Notice kind="error">{t('catalog.migration.run.not_found')}</Notice> : <ProblemAlert error={query.error} />}
        {newButton}
      </div>
    );
  }

  const live = isLive(run);
  const status = shownStatus(run);
  const stage = readReport(run.summary)?.stage ?? null;
  const parsed = DryRunOptions.safeParse(run.options);
  const options = parsed.success ? parsed.data : null;
  const offer = !live && run.dryRun && run.status === 'succeeded';
  const why = offer ? notUsable(run, options, meId(me), now) : null;

  return (
    <div className="grid gap-6">
      {joined && <NoticeAlert>{t('catalog.migration.joined')}</NoticeAlert>}
      <section aria-labelledby={titleId} className="grid gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id={titleId} className="text-base font-bold">
            {t(run.dryRun ? 'catalog.migration.kind.dry' : 'catalog.migration.kind.real')}
          </h2>
          <Tag tone={statusTone(status)}>{t(`vocab.run_status.${status}`)}</Tag>
          <span className="text-sm text-muted-foreground">{t('catalog.migration.run.started_at', { at: dateTime(run.createdAt) })}</span>
        </div>
        {live ? (
          <>
            <p role="status" className="text-sm font-semibold">
              {t(run.dryRun ? 'catalog.migration.run.live_dry' : 'catalog.migration.run.live_real')}
            </p>
            {stage !== null && <p className="text-sm">{t('catalog.migration.run.stage', { stage: stageText(t, stage) })}</p>}
            <p className="text-xs text-muted-foreground">{t('catalog.migration.run.keep_open')}</p>
            {run.jobId !== null && <JobProgress jobId={run.jobId} onDone={ended} />}
            {run.jobId !== null && holds(me, 'system.jobs.read') && (
              <Link to="/admin/jobs/$jobId" params={{ jobId: run.jobId }} className="w-fit text-sm font-semibold text-accent-text underline-offset-4 hover:underline">
                {t('catalog.migration.run.job')}
              </Link>
            )}
          </>
        ) : (
          <div>{newButton}</div>
        )}
      </section>
      {!live && <ReportView run={{ ...run, status }} unclosed={status !== run.status} />}
      {offer &&
        (why === null && options !== null ? (
          <RealRunPanel dryRun={run} options={options} draft={draft} libraryName={libraryName} onOpen={onOpen} />
        ) : why === 'adopted' && options?.adoptedBy !== undefined && isUlid(options.adoptedBy) ? (
          <NoticeAlert>
            {t('catalog.migration.real.adopted')}{' '}
            <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={() => onOpen(options.adoptedBy!)}>
              {t('catalog.migration.real.adopted_open')}
            </Button>
          </NoticeAlert>
        ) : (
          <NoticeAlert>{t(why === 'expired' ? 'catalog.migration.real.expired' : 'catalog.migration.real.unusable')}</NoticeAlert>
        ))}
    </div>
  );
}

// ---- the history ---------------------------------------------------------------------------------------------------

/** The tone of a run's status tag: green once it succeeded, red when it failed, neutral otherwise. */
function statusTone(status: RunView['status']): TagTone {
  return status === 'failed' ? 'bad' : status === 'succeeded' ? 'ok' : 'neutral';
}

function History({ runs, onOpen }: { runs: RunView[]; onOpen: OpenRun }) {
  const t = useT();
  const dateTime = useDateTime();
  const columns: DenseColumn<RunView>[] = [
    { id: 'created', header: t('catalog.migration.history.col_created'), className: 'whitespace-nowrap', cell: (r) => dateTime(r.createdAt) },
    { id: 'kind', header: t('catalog.migration.history.col_kind'), cell: (r) => t(r.dryRun ? 'catalog.migration.kind.dry' : 'catalog.migration.kind.real') },
    {
      id: 'status',
      header: t('catalog.migration.history.col_status'),
      cell: (r) => {
        const status = shownStatus(r);
        return <Tag tone={statusTone(status)}>{t(`vocab.run_status.${status}`)}</Tag>;
      },
    },
    {
      id: 'actions',
      header: <span className="sr-only">{t('catalog.migration.col_actions')}</span>,
      className: 'w-px py-1.5 text-right whitespace-nowrap',
      cell: (r) => (
        <Button type="button" variant="ghost" size="sm" onClick={() => onOpen(r.id)}>
          {t('catalog.migration.history.open')}
        </Button>
      ),
    },
  ];
  return (
    <Section title={t('catalog.migration.history.title')}>
      <DenseTable caption={t('catalog.migration.history.title')} columns={columns} rows={runs} rowKey={(r) => r.id} empty={t('catalog.migration.history.empty')} />
    </Section>
  );
}

// ---- the screen ----------------------------------------------------------------------------------------------------

function Migration({ libraryName }: { libraryName: string }) {
  const t = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const search = useSearch({ strict: false });
  const chosen = runOf(search);
  const history = useApiQuery<RunListResponse>({ queryKey: RUNS_KEY, path: `catalog/runs?kind=migration&limit=${HISTORY_LIMIT}` });
  const live = history.data?.items.find(isLive) ?? null;
  const [source, setSource] = useState<SourceDraft>(EMPTY_SOURCE);
  // `?catalogMode=sync` (a link from the accreditation workspace) opens the wizard with the re-sync chosen.
  const [options, setOptions] = useState<OptionsDraft>(() => (search['catalogMode'] === 'sync' ? { ...EMPTY_OPTIONS, catalogMode: 'sync' } : EMPTY_OPTIONS));
  /** The run a start joined instead of starting one: its page says so. */
  const [joined, setJoined] = useState<string | null>(null);

  const open = useCallback<OpenRun>(
    (runId, o = {}) => {
      setJoined(o.joined === true ? runId : null);
      void queryClient.invalidateQueries({ queryKey: RUNS_KEY });
      void navigate({ to: SCREEN, search: { run: runId } });
    },
    [navigate, queryClient],
  );
  const startNew = useCallback(() => {
    setJoined(null);
    void queryClient.invalidateQueries({ queryKey: RUNS_KEY });
    void navigate({ to: SCREEN, search: {} });
  }, [navigate, queryClient]);

  // A migration still running when the screen opens is followed (fresh data only: the run just left may be ending).
  const follow = chosen === null && live !== null && !history.isFetching ? live.id : null;
  useEffect(() => {
    if (follow !== null) void navigate({ to: SCREEN, search: { run: follow }, replace: true });
  }, [follow, navigate]);

  if (chosen !== null) {
    return <RunSection key={chosen} runId={chosen} joined={joined === chosen} draft={options} libraryName={libraryName} onOpen={open} onNew={startNew} />;
  }
  if (history.data === undefined || live !== null) {
    return history.isError ? <ProblemAlert error={history.error} /> : <LoadingState label={t('catalog.migration.loading')} />;
  }
  return (
    <>
      <Wizard source={source} options={options} libraryName={libraryName} onSource={setSource} onOptions={setOptions} onOpen={open} />
      <CutoverChecklist />
      <History runs={history.data.items} onOpen={open} />
    </>
  );
}

export function SlimsMigrationScreen() {
  const t = useT();
  const me = useMe();
  const allowed = holds(me, 'catalog.migration.run');
  return (
    <div className="grid gap-6">
      <PageHead title={t('nav.catalog.migration')} intro={t('catalog.migration.description')} />
      {/* Every route of the screen needs the permission (a super admin's, M1): say so before anything is asked. */}
      {!allowed ? <ProblemAlert error={new ApiError(403, 'AUTHZ_DENIED')} /> : <Migration libraryName={me?.library.name ?? ''} />}
    </div>
  );
}

