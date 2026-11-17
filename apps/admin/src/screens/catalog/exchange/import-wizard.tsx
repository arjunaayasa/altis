import { IMPORT_FORMATS, vocabKey, type ImportFormat } from '@altis/shared';
import type { MeResponse } from '@altis/shared/api/auth';
import type { BranchListResponse } from '@altis/shared/api/branches';
import { IMPORT_MATCH_ON, IMPORT_ON_DUPLICATE, IMPORT_ON_MATCH, type ImportBody } from '@altis/shared/api/catalog/exchange';
import type { CollectionTypeView, MasterListResponse, MaterialTypeView } from '@altis/shared/api/catalog/masters';
import type { RunStarted, RunView } from '@altis/shared/api/catalog/runs';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { JobProgress, type JobOutcome } from '@/components/job-progress';
import { CheckField, Field, Notice, NoticeAlert, ProblemAlert, SELECT_CLASS } from '@/components/form-field';
import { FactList, FormSection, LoadingState, Steps } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useLocale, useT, type TKey } from '@/i18n';
import { holds, holdsAt, meId } from '@/lib/access';
import { ApiError, api } from '@/lib/api';
import { isWritableBranch } from '@/lib/branches';
import { fieldErrorKey } from '@/lib/form-errors';
import { useApiQuery, useMe } from '@/lib/me';
import { uploadFile } from '@/lib/upload';
import { useBytes } from '@/screens/backups/upload';
import { ProgressBar } from '@/screens/jobs/list';
import { RUNS_KEY, RUN_LINK, SummaryView, runHref, runKey, useRetryKey } from './summary-view';

/**
 * Impor/Ekspor, the import wizard (Phase 2 spec §5.3, §13; plan Task 29):
 *
 * 1. **File:** the file goes up through the chunked upload of lib/upload.ts into the `catalog.import` context (staged;
 *    the server decides the type by its magic bytes and refuses anything but text, XML and ISO 2709).
 * 2. **Options:** the format (detected when left on "Deteksi otomatis": nothing is sent), how a record is matched and
 *    what a match or a likely duplicate does, items with their branch, and the defaults. The branch list holds only
 *    the live branches where the user may manage items (`holdsAt(catalog.items.manage)`, S11); creating items needs
 *    one. The server checks every grant again.
 * 3. **Dry run:** `POST catalog/imports {…, dryRun: true}` starts a run whose job reads the whole file without
 *    writing; `JobProgress` follows it (and drives it from the page where no worker runs), then the run's summary is
 *    read: counts, the reader's warnings (`encoding_cp1252`, Review Focus 1), the first 20 mapped drafts, the report.
 * 4. **Run:** `POST catalog/imports {fromRunId: <the dry run>, …the same options, dryRun: false}`. The dry run took
 *    the staged upload into its own work folder (S3), so the real run names the dry run, never the upload again. Its
 *    `Idempotency-Key` is derived from the dry run: a retry after a lost answer gets the stored answer back instead of
 *    a refusal for a dry run already taken. "Ubah opsi" goes back to the options with the dry run as the file, and the
 *    next dry run names it the same way. A file the server no longer has (`fromRunId`/`uploadId` `not_found`: taken,
 *    older than 7 days, someone else's) sends the user back to the upload.
 *
 * The wizard's state lives in this component only. The runs themselves are the server's: leaving the page leaves them
 * running (the job runner, or the next page that drives them), and Riwayat and the run's own page show them. A
 * finished dry run left behind (a reload, the run link, a session that ended) is continued from its own page
 * ({@link RealRunAction}, run.tsx): the same options, the same key (C21).
 */

/** The options of a run as the form holds them (`''`: not chosen, never sent). */
export interface ImportOptions {
  format: ImportFormat | '';
  matchOn: ImportBody['matchOn'];
  onMatch: ImportBody['onMatch'];
  onDuplicate: ImportBody['onDuplicate'];
  createItems: boolean;
  branchId: string;
  defaultMaterialTypeId: string;
  defaultCollectionTypeId: string;
}

const DEFAULT_OPTIONS: ImportOptions = {
  format: '',
  matchOn: 'isbn',
  onMatch: 'skip',
  onDuplicate: 'report',
  createItems: false,
  branchId: '',
  defaultMaterialTypeId: '',
  defaultCollectionTypeId: '',
};

/** Where the file of the next run comes from: a fresh upload, or the work folder of the last dry run (S3). */
type Source = { kind: 'upload'; uploadId: string; name: string; size: number } | { kind: 'dry_run'; runId: string; name: string };

type Phase =
  | { kind: 'file' }
  | { kind: 'options'; source: Source }
  | { kind: 'dry'; name: string; options: ImportOptions; started: RunStarted }
  | { kind: 'real'; options: ImportOptions; started: RunStarted };

/** The body of `POST catalog/imports` for `source` and `o`: the file, the chosen options only, and `dryRun`. */
export function importBody(source: { uploadId: string } | { fromRunId: string }, o: ImportOptions, dryRun: boolean): ImportBody {
  const body: ImportBody = {
    ...source,
    matchOn: o.matchOn,
    onMatch: o.onMatch,
    onDuplicate: o.onDuplicate,
    createItems: o.createItems,
    dryRun,
  };
  if (o.format !== '') body.format = o.format;
  if (o.branchId !== '') body.branchId = o.branchId;
  if (o.defaultMaterialTypeId !== '') body.defaultMaterialTypeId = o.defaultMaterialTypeId;
  if (o.defaultCollectionTypeId !== '') body.defaultCollectionTypeId = o.defaultCollectionTypeId;
  return body;
}

/** The server no longer has the file this request named (a taken, expired or foreign dry run; a gone upload). */
export function fileGone(e: unknown): boolean {
  return (
    e instanceof ApiError &&
    e.code === 'VALIDATION_FAILED' &&
    (e.errors ?? []).some((f) => (f.path === 'fromRunId' || f.path === 'uploadId') && f.code === 'not_found')
  );
}

/** The option fields a VALIDATION_FAILED may name, with the message key of each one's first error. */
type OptionErrors = Partial<Record<keyof ImportOptions, string>>;

function optionErrors(e: unknown): OptionErrors {
  const out: OptionErrors = {};
  if (!(e instanceof ApiError) || e.code !== 'VALIDATION_FAILED') return out;
  for (const f of e.errors ?? []) {
    if (Object.prototype.hasOwnProperty.call(DEFAULT_OPTIONS, f.path) && out[f.path as keyof ImportOptions] === undefined) {
      out[f.path as keyof ImportOptions] = fieldErrorKey(f.code);
    }
  }
  return out;
}

/** The failure of a request that started a run: the reupload notice for a file the server no longer has. */
export function StartProblem({ error }: { error: unknown }) {
  const t = useT();
  if (error === null) return null;
  if (fileGone(error)) return <Notice kind="error">{t('catalog.exchange.import.reupload')}</Notice>;
  return <ProblemAlert error={error} />;
}

/** The steps of the wizard, in their order. */
const STEPS = ['file', 'options', 'dry_run', 'run'] as const;

/** The step list: where the wizard is. */
function WizardSteps({ current }: { current: 0 | 1 | 2 | 3 }) {
  const t = useT();
  return (
    <Steps
      steps={STEPS.map((s) => t(`catalog.exchange.import.step.${s}`))}
      current={current}
      label={t('catalog.exchange.import.steps')}
      doneLabel={t('catalog.exchange.import.step_done')}
    />
  );
}

// ---- 1. the file ---------------------------------------------------------------------------------------------------

type Upload = { kind: 'hashing' | 'sending'; done: number; total: number } | null;

function FileStep({ onUploaded }: { onUploaded(source: Source): void }) {
  const t = useT();
  const bytes = useBytes();
  const inputId = useId();
  const hintId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [upload, setUpload] = useState<Upload>(null);
  const [outcome, setOutcome] = useState<{ kind: 'error' | 'info'; error?: unknown; text?: string } | null>(null);
  const running = useRef<AbortController | null>(null);
  useEffect(() => () => running.current?.abort(), []);

  const start = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (upload !== null) return;
    if (file === null) {
      setOutcome({ kind: 'error', text: t('catalog.exchange.import.choose') });
      return;
    }
    const controller = new AbortController();
    running.current = controller;
    setOutcome(null);
    setUpload({ kind: 'hashing', done: 0, total: file.size });
    void (async () => {
      try {
        const { uploadId } = await uploadFile(file, {
          context: 'catalog.import',
          signal: controller.signal,
          onHashProgress: (done, total) => setUpload(done >= total ? { kind: 'sending', done: 0, total } : { kind: 'hashing', done, total }),
          onProgress: (done, total) => setUpload({ kind: 'sending', done, total }),
        });
        if (controller.signal.aborted) return;
        setUpload(null);
        onUploaded({ kind: 'upload', uploadId, name: file.name, size: file.size });
      } catch (e) {
        setUpload(null);
        setOutcome(controller.signal.aborted ? { kind: 'info', text: t('catalog.exchange.import.cancelled') } : { kind: 'error', error: e });
      } finally {
        if (running.current === controller) running.current = null;
      }
    })();
  };

  const pct = upload === null || upload.total === 0 ? 0 : (upload.done / upload.total) * 100;
  const progressLabel = upload === null ? '' : t(upload.kind === 'hashing' ? 'catalog.exchange.import.hashing' : 'catalog.exchange.import.sending');
  return (
    <form noValidate className="grid max-w-xl gap-3" onSubmit={start}>
      <div className="grid gap-1.5">
        <Label htmlFor={inputId}>{t('catalog.exchange.import.file')}</Label>
        <Input
          id={inputId}
          type="file"
          accept=".mrc,.marc,.iso,.dat,.xml,.csv,.txt,application/marc,application/marcxml+xml,application/xml,text/xml,text/csv,text/plain"
          aria-describedby={hintId}
          disabled={upload !== null}
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setOutcome(null);
          }}
        />
        <p id={hintId} className="text-xs text-muted-foreground">
          {t('catalog.exchange.import.file_hint')}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={upload !== null}>
          {t('catalog.exchange.import.upload')}
        </Button>
        {upload !== null && (
          <Button type="button" variant="outline" onClick={() => running.current?.abort()}>
            {t('catalog.exchange.import.cancel_upload')}
          </Button>
        )}
      </div>
      {upload !== null && (
        <div className="grid gap-1">
          <div className="flex items-baseline justify-between gap-2 text-sm">
            <span className="font-semibold">{progressLabel}</span>
            <span className="tabular-nums">{Math.round(pct)} %</span>
          </div>
          <ProgressBar value={pct} label={progressLabel} />
          <p className="text-xs text-muted-foreground tabular-nums">
            {t('catalog.exchange.import.amount', { done: bytes(upload.done), total: bytes(upload.total) })}
          </p>
        </div>
      )}
      {outcome?.kind === 'info' && <NoticeAlert>{outcome.text}</NoticeAlert>}
      {outcome?.kind === 'error' && (outcome.text !== undefined ? <Notice kind="error">{outcome.text}</Notice> : <ProblemAlert error={outcome.error} />)}
    </form>
  );
}

// ---- 2. the options ------------------------------------------------------------------------------------------------

/** A native select inside a {@link Field}. */
function SelectField({
  label,
  hint,
  error,
  value,
  disabled,
  onChange,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  value: string;
  disabled?: boolean;
  onChange(value: string): void;
  children: ReactNode;
}) {
  return (
    <Field label={label} hint={hint} error={error}>
      {(control) => (
        <select {...control} className={SELECT_CLASS} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
          {children}
        </select>
      )}
    </Field>
  );
}

function OptionsStep({
  source,
  options,
  setOptions,
  onStarted,
  onRestart,
}: {
  source: Source;
  options: ImportOptions;
  setOptions(next: ImportOptions): void;
  onStarted(started: RunStarted, options: ImportOptions): void;
  onRestart(): void;
}) {
  const t = useT();
  const me = useMe();
  const locale = useLocale();
  const bytes = useBytes();
  const branches = useApiQuery<BranchListResponse>({ queryKey: ['branches', { includeArchived: false }], path: 'branches' });
  const types = useApiQuery<MasterListResponse<MaterialTypeView>>({
    queryKey: ['catalog', 'material-types', { includeArchived: true }],
    path: 'catalog/material-types?includeArchived=true',
  });
  const collections = useApiQuery<MasterListResponse<CollectionTypeView>>({
    queryKey: ['catalog', 'collection-types', { includeArchived: true }],
    path: 'catalog/collection-types?includeArchived=true',
  });
  /** The writable branches (live and active, L13) where the user may create items (S11). */
  const itemBranches = useMemo(
    () => (branches.data?.items ?? []).filter((b) => isWritableBranch(b) && holdsAt(me, 'catalog.items.manage', b.id)),
    [branches.data, me],
  );
  const [errors, setErrors] = useState<OptionErrors>({});
  const [problem, setProblem] = useState<unknown>(null);
  const [posting, setPosting] = useState(false);
  const retryKey = useRetryKey('catalog-import-dry');
  const name = (n: { nameId: string; nameEn: string }): string => (locale === 'en' ? n.nameEn : n.nameId);
  const set = <K extends keyof ImportOptions>(key: K, value: ImportOptions[K]): void => {
    setOptions({ ...options, [key]: value });
    setErrors((e) => ({ ...e, [key]: undefined }));
  };
  // Without the branch list nothing proves a grant: items cannot be created (the server would check again anyway).
  const noItemBranch = itemBranches.length === 0;
  // A branch that is no longer offered (another user's grants, a stale list) is never sent.
  const branchId = itemBranches.some((b) => b.id === options.branchId) ? options.branchId : '';
  // The form shows once its lists have answered, so every choice it offers is there when it appears.
  const settled = [branches, types, collections].every((q) => q.data !== undefined || q.isError);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (posting) return;
    const chosen: ImportOptions = { ...options, branchId, createItems: options.createItems && !noItemBranch };
    if (chosen.createItems && chosen.branchId === '') {
      setErrors({ branchId: 'catalog.exchange.import.branch_required' });
      return;
    }
    setErrors({});
    setProblem(null);
    setPosting(true);
    try {
      const file = source.kind === 'upload' ? { uploadId: source.uploadId } : { fromRunId: source.runId };
      const body = importBody(file, chosen, true);
      const started = await api<RunStarted>('POST', 'catalog/imports', body, { idempotencyKey: retryKey.key(body) });
      retryKey.clear();
      onStarted(started, chosen);
    } catch (e) {
      setErrors(optionErrors(e));
      setProblem(e);
    } finally {
      setPosting(false);
    }
  };

  if (!settled) return <LoadingState />;
  const listProblem = [branches, types, collections].find((q) => q.isError)?.error ?? null;
  return (
    <form noValidate className="grid gap-4" onSubmit={(e) => void submit(e)}>
      <ProblemAlert error={listProblem} />
      <p className="max-w-[75ch] text-sm">
        {source.kind === 'upload'
          ? t('catalog.exchange.import.source_upload', { name: source.name, size: bytes(source.size) })
          : t('catalog.exchange.import.source_dry_run', { name: source.name })}
      </p>
      <div className="max-w-sm">
        <SelectField label={t('catalog.exchange.import.format')} error={errors.format} value={options.format} onChange={(v) => set('format', v as ImportFormat | '')}>
          <option value="">{t('catalog.exchange.import.format_auto')}</option>
          {IMPORT_FORMATS.map((f) => (
            <option key={f} value={f}>
              {t(vocabKey('import_format', f))}
            </option>
          ))}
        </SelectField>
      </div>
      <div>
        <FormSection title={t('catalog.exchange.import.matching')}>
          <SelectField label={t('catalog.exchange.import.match_on')} error={errors.matchOn} value={options.matchOn} onChange={(v) => set('matchOn', v as ImportOptions['matchOn'])}>
            {IMPORT_MATCH_ON.map((m) => (
              <option key={m} value={m}>
                {t(`catalog.exchange.import.match_on.${m}`)}
              </option>
            ))}
          </SelectField>
          <SelectField
            label={t('catalog.exchange.import.on_match')}
            error={errors.onMatch}
            value={options.onMatch}
            disabled={options.matchOn === 'none'}
            onChange={(v) => set('onMatch', v as ImportOptions['onMatch'])}>
            {IMPORT_ON_MATCH.map((m) => (
              <option key={m} value={m}>
                {t(`catalog.exchange.import.on_match.${m}`)}
              </option>
            ))}
          </SelectField>
          <SelectField
            label={t('catalog.exchange.import.on_duplicate')}
            hint={t('catalog.exchange.import.on_duplicate_hint')}
            error={errors.onDuplicate}
            value={options.onDuplicate}
            onChange={(v) => set('onDuplicate', v as ImportOptions['onDuplicate'])}>
            {IMPORT_ON_DUPLICATE.map((m) => (
              <option key={m} value={m}>
                {t(`catalog.exchange.import.on_duplicate.${m}`)}
              </option>
            ))}
          </SelectField>
        </FormSection>
        <FormSection title={t('catalog.exchange.import.items')}>
          <CheckField
            className="sm:col-span-full"
            label={t('catalog.exchange.import.create_items')}
            hint={t('catalog.exchange.import.create_items_hint')}
            checked={options.createItems && !noItemBranch}
            disabled={noItemBranch}
            onChange={(e) => set('createItems', e.target.checked)}
          />
          {noItemBranch ? (
            // A branch list that could not be read is the alert above, not a lack of rights.
            !branches.isError && <p className="text-sm text-muted-foreground sm:col-span-full">{t('catalog.exchange.import.no_branch')}</p>
          ) : (
            <SelectField
              label={t('catalog.exchange.import.branch')}
              hint={t('catalog.exchange.import.branch_hint')}
              error={errors.branchId}
              value={branchId}
              onChange={(v) => set('branchId', v)}>
              <option value="">{t('catalog.exchange.import.branch_none')}</option>
              {itemBranches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name} ({b.code})
                </option>
              ))}
            </SelectField>
          )}
        </FormSection>
        <FormSection title={t('catalog.exchange.import.defaults')}>
          <SelectField
            label={t('catalog.exchange.import.default_type')}
            hint={t('catalog.exchange.import.default_type_hint')}
            error={errors.defaultMaterialTypeId}
            value={options.defaultMaterialTypeId}
            onChange={(v) => set('defaultMaterialTypeId', v)}>
            <option value="">{t('catalog.exchange.import.default_setting')}</option>
            {(types.data?.items ?? [])
              .filter((m) => !m.archived)
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {name(m)} ({m.code})
                </option>
              ))}
          </SelectField>
          <SelectField
            label={t('catalog.exchange.import.default_collection')}
            hint={t('catalog.exchange.import.default_collection_hint')}
            error={errors.defaultCollectionTypeId}
            value={options.defaultCollectionTypeId}
            onChange={(v) => set('defaultCollectionTypeId', v)}>
            <option value="">{t('catalog.exchange.import.default_setting')}</option>
            {(collections.data?.items ?? [])
              .filter((c) => !c.archived)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {name(c)} ({c.code})
                </option>
              ))}
          </SelectField>
        </FormSection>
        <div className="grid gap-3 border-t pt-4">
          <StartProblem error={problem} />
          <p className="max-w-[75ch] text-sm text-muted-foreground">{t('catalog.exchange.import.dry_run_hint')}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={posting}>
              {t('catalog.exchange.import.dry_run')}
            </Button>
            <Button type="button" variant="outline" disabled={posting} onClick={onRestart}>
              {t('catalog.exchange.import.restart')}
            </Button>
          </div>
        </div>
      </div>
    </form>
  );
}

// ---- 3 and 4. a run: its progress, then its summary ----------------------------------------------------------------

const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === 'string' && (list as readonly string[]).includes(v);
const idOrEmpty = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * A stored import run's `options` (`{body, stagingId, adoptedFrom}`, `body` its `ImportBody`) as the form holds them,
 * or null when they do not have that shape.
 */
export function importOptionsOf(stored: Record<string, unknown>): ImportOptions | null {
  const body = stored['body'];
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const options = body as Record<string, unknown>;
  const { format, matchOn, onMatch, onDuplicate, createItems } = options;
  if (!oneOf(IMPORT_MATCH_ON, matchOn) || !oneOf(IMPORT_ON_MATCH, onMatch) || !oneOf(IMPORT_ON_DUPLICATE, onDuplicate)) return null;
  return {
    format: oneOf(IMPORT_FORMATS, format) ? format : '',
    matchOn,
    onMatch,
    onDuplicate,
    createItems: createItems === true,
    branchId: idOrEmpty(options['branchId']),
    defaultMaterialTypeId: idOrEmpty(options['defaultMaterialTypeId']),
    defaultCollectionTypeId: idOrEmpty(options['defaultCollectionTypeId']),
  };
}

/** The options a run was started with, as a short list (the real run uses exactly these). */
export function OptionsList({ options }: { options: ImportOptions }) {
  const t = useT();
  const rows: [TKey, string][] = [
    ['catalog.exchange.import.format', options.format === '' ? t('catalog.exchange.import.format_auto') : t(vocabKey('import_format', options.format))],
    ['catalog.exchange.import.match_on', t(`catalog.exchange.import.match_on.${options.matchOn}`)],
    ['catalog.exchange.import.on_duplicate', t(`catalog.exchange.import.on_duplicate.${options.onDuplicate}`)],
    ['catalog.exchange.import.create_items', t(options.createItems ? 'form.yes' : 'form.no')],
  ];
  if (options.matchOn !== 'none') rows.splice(2, 0, ['catalog.exchange.import.on_match', t(`catalog.exchange.import.on_match.${options.onMatch}`)]);
  return <FactList className="max-w-xl" items={rows.map(([label, value]) => ({ key: label, label: t(label), value }))} />;
}

/**
 * One run of the wizard: `JobProgress` until the job ends, then the run as the server tells it (`GET catalog/runs/:id`,
 * read once the job has ended). `children` gets the run once it is read, for the step's own actions.
 */
function RunPanel({
  started,
  title,
  options,
  children,
}: {
  started: RunStarted;
  title: { running: TKey; done: TKey };
  options: ImportOptions;
  children(o: { run: RunView | undefined; outcome: JobOutcome | null }): ReactNode;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const headingId = useId();
  const [outcome, setOutcome] = useState<JobOutcome | null>(null);
  const run = useApiQuery<RunView>({
    queryKey: runKey(started.runId),
    path: `catalog/runs/${encodeURIComponent(started.runId)}`,
    enabled: outcome !== null,
  });
  // "Result" once the run has been read (or could not be): the summary comes with the heading that announces it.
  const read = outcome !== null && (run.data !== undefined || run.isError);
  return (
    <section aria-labelledby={headingId} className="grid gap-3 border-t pt-5">
      <h3 id={headingId} className="text-base font-bold">
        {t(read ? title.done : title.running)}
      </h3>
      <OptionsList options={options} />
      <JobProgress
        jobId={started.jobId}
        onDone={(status) => {
          setOutcome(status);
          void queryClient.invalidateQueries({ queryKey: RUNS_KEY });
        }}
      />
      {outcome === null && <p className="text-sm text-muted-foreground">{t('catalog.exchange.leave_hint')}</p>}
      {run.isError && <ProblemAlert error={run.error} />}
      {run.data !== undefined && <SummaryView run={run.data} />}
      {children({ run: run.data, outcome })}
      <Link to={runHref(started.runId)} className={RUN_LINK}>
        {t('catalog.exchange.open_run')}
      </Link>
    </section>
  );
}

/** How long the server keeps a finished dry run's file for a real run (S2: `RUN_WORK_KEEP_MS`, 7 days). */
const DRY_RUN_KEEP_MS = 7 * 86_400_000;

/**
 * Whether `run` is a dry import run that `me` may still continue from its page: theirs, succeeded less than 7 days
 * ago, not yet taken by a real run (`options.adoptedBy`), with options the form can read (the server checks it all
 * again; a refusal shows the reupload notice).
 */
export function continuable(run: RunView, me: MeResponse | undefined, now: number): ImportOptions | null {
  if (run.kind !== 'import' || !run.dryRun || run.status !== 'succeeded' || run.finishedAt === null) return null;
  if (run.createdBy === null || run.createdBy !== meId(me) || !holds(me, 'catalog.import.run')) return null;
  if (run.finishedAt <= now - DRY_RUN_KEEP_MS || run.options['adoptedBy'] !== undefined) return null;
  return importOptionsOf(run.options);
}

/**
 * "Jalankan impor" on a finished dry run's own page (C21): `POST catalog/imports {fromRunId, …its options, dryRun:
 * false}` under the wizard's key, then the real run's page.
 */
export function RealRunAction({ dryRunId, options }: { dryRunId: string; options: ImportOptions }) {
  const t = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<unknown>(null);
  const [posting, setPosting] = useState(false);
  const gone = fileGone(problem);

  const runIt = async (): Promise<void> => {
    if (posting) return;
    setProblem(null);
    setPosting(true);
    try {
      const real = await api<RunStarted>('POST', 'catalog/imports', importBody({ fromRunId: dryRunId }, options, false), {
        idempotencyKey: `catalog-import:${dryRunId}`,
      });
      void queryClient.invalidateQueries({ queryKey: RUNS_KEY });
      void navigate({ to: runHref(real.runId) });
    } catch (e) {
      setProblem(e);
    } finally {
      setPosting(false);
    }
  };

  return (
    <section aria-label={t('catalog.exchange.import.run')} className="grid gap-2">
      {!gone && <p className="max-w-[75ch] text-sm text-muted-foreground">{t('catalog.exchange.import.run_hint')}</p>}
      <StartProblem error={problem} />
      {!gone && (
        <div>
          <Button type="button" disabled={posting} onClick={() => void runIt()}>
            {t('catalog.exchange.import.run')}
          </Button>
        </div>
      )}
    </section>
  );
}

function DryRunStep({
  name,
  options,
  started,
  onRun,
  onChangeOptions,
  onRestart,
}: {
  name: string;
  options: ImportOptions;
  started: RunStarted;
  onRun(started: RunStarted): void;
  onChangeOptions(source: Source): void;
  onRestart(): void;
}) {
  const t = useT();
  const [problem, setProblem] = useState<unknown>(null);
  const [posting, setPosting] = useState(false);
  const dryRunId = started.runId;

  const runIt = async (): Promise<void> => {
    if (posting) return;
    setProblem(null);
    setPosting(true);
    try {
      // The dry run's file and the same options; a retry under the same key gets the stored answer (see the top).
      const real = await api<RunStarted>('POST', 'catalog/imports', importBody({ fromRunId: dryRunId }, options, false), {
        idempotencyKey: `catalog-import:${dryRunId}`,
      });
      onRun(real);
    } catch (e) {
      setProblem(e);
    } finally {
      setPosting(false);
    }
  };

  return (
    <RunPanel started={started} title={{ running: 'catalog.exchange.import.dry_running', done: 'catalog.exchange.import.dry_result' }} options={options}>
      {({ run, outcome }) => {
        if (outcome === null) return null;
        const ok = outcome === 'succeeded' && run?.status === 'succeeded';
        const gone = fileGone(problem);
        return (
          <>
            {outcome !== 'succeeded' && <p className="text-sm">{t('catalog.exchange.import.failed')}</p>}
            {ok && !gone && <p className="max-w-[75ch] text-sm text-muted-foreground">{t('catalog.exchange.import.run_hint')}</p>}
            <StartProblem error={problem} />
            <div className="flex flex-wrap gap-2">
              {ok && !gone && (
                <Button type="button" disabled={posting} onClick={() => void runIt()}>
                  {t('catalog.exchange.import.run')}
                </Button>
              )}
              {ok && !gone && (
                <Button type="button" variant="outline" disabled={posting} onClick={() => onChangeOptions({ kind: 'dry_run', runId: dryRunId, name })}>
                  {t('catalog.exchange.import.change_options')}
                </Button>
              )}
              <Button type="button" variant="outline" disabled={posting} onClick={onRestart}>
                {t('catalog.exchange.import.restart')}
              </Button>
            </div>
          </>
        );
      }}
    </RunPanel>
  );
}

function RealRunStep({ options, started, onRestart }: { options: ImportOptions; started: RunStarted; onRestart(): void }) {
  const t = useT();
  return (
    <RunPanel started={started} title={{ running: 'catalog.exchange.import.running', done: 'catalog.exchange.import.result' }} options={options}>
      {({ outcome }) =>
        outcome === null ? null : (
          <>
            {outcome !== 'succeeded' && <p className="text-sm">{t('catalog.exchange.import.failed')}</p>}
            <div>
              <Button type="button" variant="outline" onClick={onRestart}>
                {t('catalog.exchange.import.again')}
              </Button>
            </div>
          </>
        )
      }
    </RunPanel>
  );
}

// ---- the wizard ----------------------------------------------------------------------------------------------------

/** The import wizard (see the top of this file). */
export function ImportWizard() {
  const t = useT();
  const headingId = useId();
  const [phase, setPhase] = useState<Phase>({ kind: 'file' });
  // The options outlive a step back ("Ubah opsi") and a new file ("Mulai dari awal").
  const [options, setOptions] = useState<ImportOptions>(DEFAULT_OPTIONS);
  const restart = (): void => setPhase({ kind: 'file' });
  const step = phase.kind === 'file' ? 0 : phase.kind === 'options' ? 1 : phase.kind === 'dry' ? 2 : 3;

  return (
    <section aria-labelledby={headingId} className="grid gap-5">
      <h2 id={headingId} className="text-base font-bold">
        {t('catalog.exchange.import.title')}
      </h2>
      <WizardSteps current={step} />
      {phase.kind === 'file' && <FileStep onUploaded={(source) => setPhase({ kind: 'options', source })} />}
      {phase.kind === 'options' && (
        <OptionsStep
          source={phase.source}
          options={options}
          setOptions={setOptions}
          onRestart={restart}
          onStarted={(started, chosen) => setPhase({ kind: 'dry', name: phase.source.name, options: chosen, started })}
        />
      )}
      {phase.kind === 'dry' && (
        <DryRunStep
          key={phase.started.runId}
          name={phase.name}
          options={phase.options}
          started={phase.started}
          onRestart={restart}
          onChangeOptions={(source) => setPhase({ kind: 'options', source })}
          onRun={(started) => setPhase({ kind: 'real', options: phase.options, started })}
        />
      )}
      {phase.kind === 'real' && <RealRunStep key={phase.started.runId} options={phase.options} started={phase.started} onRestart={restart} />}
    </section>
  );
}
