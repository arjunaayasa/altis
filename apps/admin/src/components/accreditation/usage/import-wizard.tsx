import { ACCRED_GROUPS, isCalendarDate, type AccredGroup } from '@altis/shared';
import type { SlimsUsageStartBody } from '@altis/shared/api/accreditation';
import type { RunView } from '@altis/shared/api/catalog/runs';
import { useQueryClient } from '@tanstack/react-query';
import { DownloadIcon, XIcon } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { Field, Notice, NoticeAlert, SELECT_CLASS } from '@/components/form-field';
import { JobProgress, type JobOutcome } from '@/components/job-progress';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useLocale, useT, type TKey } from '@/i18n';
import { ApiError, api } from '@/lib/api';
import { problemText } from '@/lib/form-errors';
import { useApiQuery } from '@/lib/me';
import { uploadFile } from '@/lib/upload';
import { useBytes } from '@/screens/backups/upload';
import { ProgressBar } from '@/screens/jobs/list';
import { confirmReauth } from '@/screens/reports/run-history';
import { AccredGroupSelect, GroupMap } from './group-map';
import { accredKeys } from './queries';
import {
  EMPTY_USAGE_SOURCE,
  SourceForm,
  checkUsageDb,
  checkUsageSource,
  hasUsageSourceErrors,
  type UsageSourceDraft,
  type UsageSourceErrors,
  type UsageTestState,
} from './source-form';

/**
 * "Impor dari SLiMS" (spec §10.7, §11.2): the read-only import of SLiMS usage figures into the monthly usage table.
 *
 * 1. **Source** (source-form.tsx): a SLiMS database, tested through the accreditation route (which lists the member
 *    types with a guessed group), or a SQL dump.
 * 2. **Mapping and cut-over date:** for a database the member types of the test with their guesses, each changeable; a
 *    dump's types are only read during the import, so it is mapped after the run. The cut-over date starts from what the
 *    server knows (the last import's, else the accreditation settings' live date): SLiMS rows from that day on are not
 *    counted. The group of the members SLiMS deleted starts from the setting.
 * 3. **Start, progress, summary:** the start waits for the password confirmation (a cancelled one starts nothing, and a
 *    dump is only uploaded after it, in the context `accreditation.slims_dump`), then `POST
 *    accreditation/periods/:id/slims-usage`; a live import is joined. The job's progress follows, then the run's summary
 *    with the note that SLiMS keeps one visitor log for the desk and the guest book, and its CSV report. After a dump the
 *    mapping of the member types the import found is asked for here.
 *
 * The database password is dropped from this page once the import has started.
 */

/** The first field error of a VALIDATION_FAILED at `path` or below it, or null. */
function fieldError(e: unknown, path: string): string | null {
  if (!(e instanceof ApiError) || e.code !== 'VALIDATION_FAILED') return null;
  const hit = (e.errors ?? []).find((x) => x.path === path || x.path.startsWith(`${path}.`));
  return hit === undefined ? null : hit.code;
}

/** The answer of the start: a new run (201), or the live one joined (200 `joined: true`). */
interface StartAnswer {
  runId: string;
  jobId: string;
  joined?: true;
}

type Phase = { kind: 'idle' } | { kind: 'hashing' | 'sending'; done: number; total: number } | { kind: 'starting' };

interface Started extends StartAnswer {
  sourceKind: 'db' | 'dump';
}

export interface ImportWizardProps {
  periodId: string;
  /** Where the cut-over date starts: the last import's, else the accreditation settings' live date, else empty. */
  defaultCutover: string | null;
  /** The group of the deleted members to start from (`accreditation.unknownMemberGroup.default`). */
  unknownDefault: AccredGroup | null;
  onClose(): void;
}

export function ImportWizard({ periodId, defaultCutover, unknownDefault, onClose }: ImportWizardProps) {
  const t = useT();
  const titleId = useId();
  const [started, setStarted] = useState<Started | null>(null);

  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-4 rounded-lg border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="grid gap-1">
          <h2 id={titleId} className="text-base font-semibold">
            {t('accreditation.usage.wizard.title')}
          </h2>
          <p className="text-sm text-muted-foreground">{t('accreditation.usage.wizard.intro')}</p>
        </div>
        <Button type="button" variant="ghost" size="icon" aria-label={t('accreditation.usage.wizard.close')} onClick={onClose}>
          <XIcon aria-hidden="true" />
        </Button>
      </div>
      {started === null ? (
        <Setup periodId={periodId} defaultCutover={defaultCutover} unknownDefault={unknownDefault} onStarted={setStarted} />
      ) : (
        <>
          <p className="text-xs text-muted-foreground">{t('accreditation.usage.wizard.step', { n: 3 })}</p>
          <ImportRun periodId={periodId} started={started} unknownDefault={unknownDefault} onClose={onClose} />
        </>
      )}
    </section>
  );
}

// ---- steps 1 and 2 -------------------------------------------------------------------------------------------------

function Setup({
  periodId,
  defaultCutover,
  unknownDefault,
  onStarted,
}: {
  periodId: string;
  defaultCutover: string | null;
  unknownDefault: AccredGroup | null;
  onStarted(started: Started): void;
}) {
  const t = useT();
  const bytes = useBytes();
  const queryClient = useQueryClient();
  const ids = { cutover: useId(), unknown: useId() };
  const [step, setStep] = useState<'source' | 'options'>('source');
  const [source, setSource] = useState<UsageSourceDraft>(EMPTY_USAGE_SOURCE);
  const [test, setTest] = useState<UsageTestState>({ kind: 'idle' });
  const [errors, setErrors] = useState<UsageSourceErrors>({});
  /** The groups chosen for the tested member types (by type id); a type not chosen keeps its guess. */
  const [typeGroups, setTypeGroups] = useState<Readonly<Record<string, AccredGroup | null>>>({});
  const [cutover, setCutover] = useState(defaultCutover ?? '');
  const [cutoverError, setCutoverError] = useState<TKey | undefined>(undefined);
  const [unknownGroup, setUnknownGroup] = useState<AccredGroup | null>(unknownDefault);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [failure, setFailure] = useState<string | null>(null);
  const starting = useRef(false);
  /** The dump that went up already: a start that failed after it does not send it again. */
  const uploaded = useRef<{ file: File; uploadId: string } | null>(null);
  const controller = useRef<AbortController | null>(null);

  // Leaving the page stops an upload in flight (lib/upload.ts then deletes its session).
  useEffect(() => () => controller.current?.abort(), []);

  const types = test.kind === 'done' && test.answer.ok ? test.answer.memberTypes : [];
  const groupOf = (id: string, guess: AccredGroup): AccredGroup | null =>
    Object.prototype.hasOwnProperty.call(typeGroups, id) ? (typeGroups[id] ?? null) : guess;

  const changeTest = (next: UsageTestState): void => {
    setTest(next);
    if (next.kind !== 'testing') setTypeGroups({});
  };

  const next = (): void => {
    const found = checkUsageSource(source, test);
    setErrors(found);
    if (!hasUsageSourceErrors(found)) setStep('options');
  };

  const start = async (): Promise<void> => {
    if (starting.current) return;
    const found = checkUsageSource(source, test);
    if (hasUsageSourceErrors(found)) {
      setErrors(found);
      setStep('source');
      return;
    }
    const cut = cutover.trim();
    if (cut !== '' && !isCalendarDate(cut)) {
      setCutoverError('form.error.invalid_format');
      return;
    }
    setCutoverError(undefined);
    setFailure(null);
    starting.current = true;
    const run = new AbortController();
    controller.current = run;
    try {
      // The password first: a cancelled confirmation uploads and starts nothing.
      if (!(await confirmReauth(queryClient))) {
        setFailure(t('accreditation.usage.reauth_cancelled'));
        return;
      }
      let from: SlimsUsageStartBody['source'];
      if (source.kind === 'db') {
        const db = checkUsageDb(source.db);
        if (db.config === undefined) return;
        from = { kind: 'db', db: db.config };
      } else {
        const file = source.dump!;
        let uploadId = uploaded.current?.file === file ? uploaded.current.uploadId : null;
        if (uploadId === null) {
          setPhase({ kind: 'hashing', done: 0, total: file.size });
          ({ uploadId } = await uploadFile(file, {
            context: 'accreditation.slims_dump',
            signal: run.signal,
            onHashProgress: (n, total) => setPhase(n >= total ? { kind: 'sending', done: 0, total } : { kind: 'hashing', done: n, total }),
            onProgress: (n, total) => setPhase({ kind: 'sending', done: n, total }),
          }));
          uploaded.current = { file, uploadId };
        }
        from = { kind: 'dump', uploadId };
      }
      setPhase({ kind: 'starting' });
      const body: SlimsUsageStartBody = {
        source: from,
        cutoverOn: cut === '' ? null : cut,
        ...(from.kind === 'db' ? { memberTypeGroups: Object.fromEntries(types.map((x) => [x.id, groupOf(x.id, x.guess)])) } : {}),
        unknownMemberGroup: unknownGroup,
      };
      const answer = await api<StartAnswer>('POST', `accreditation/periods/${encodeURIComponent(periodId)}/slims-usage`, body, { signal: run.signal });
      // A new run took the upload; a joined one took nothing.
      if (answer.joined !== true) uploaded.current = null;
      // The password is not kept in this page once the import has started.
      setSource((s) => ({ ...s, db: { ...s.db, password: '' } }));
      onStarted({ ...answer, sourceKind: from.kind });
    } catch (e) {
      if (run.signal.aborted) return;
      if (fieldError(e, 'source.uploadId') === 'not_found') {
        uploaded.current = null;
        setFailure(t('accreditation.usage.upload_gone'));
      } else if (fieldError(e, 'cutoverOn') !== null) {
        setCutoverError('form.error.invalid_format');
      } else {
        setFailure(problemText(t, e));
      }
    } finally {
      starting.current = false;
      if (controller.current === run) controller.current = null;
      setPhase({ kind: 'idle' });
    }
  };

  if (step === 'source') {
    return (
      <div className="flex flex-col gap-4">
        <div className="grid gap-1">
          <p className="text-xs text-muted-foreground">{t('accreditation.usage.wizard.step', { n: 1 })}</p>
          <h3 className="text-sm font-semibold">{t('accreditation.usage.source.title')}</h3>
        </div>
        <SourceForm
          value={source}
          errors={errors}
          test={test}
          onChange={(value) => {
            setSource(value);
            setErrors({});
          }}
          onTest={changeTest}
        />
        <div className="flex gap-2">
          <Button type="button" onClick={next}>
            {t('accreditation.usage.next')}
          </Button>
        </div>
      </div>
    );
  }

  const busy = phase.kind !== 'idle';
  const uploading = phase.kind === 'hashing' || phase.kind === 'sending' ? phase : null;
  const uploadLabel = uploading === null ? null : t(uploading.kind === 'hashing' ? 'accreditation.usage.hashing' : 'accreditation.usage.uploading', { done: bytes(uploading.done), total: bytes(uploading.total) });

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-1">
        <p className="text-xs text-muted-foreground">{t('accreditation.usage.wizard.step', { n: 2 })}</p>
        <h3 className="text-sm font-semibold">{t('accreditation.usage.options.title')}</h3>
      </div>

      <div className="grid gap-2">
        <h4 className="text-sm font-medium">{t('accreditation.usage.types.title')}</h4>
        {source.kind === 'dump' ? (
          <p className="text-sm text-muted-foreground">{t('accreditation.usage.types.dump_later')}</p>
        ) : types.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('accreditation.usage.types.none')}</p>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">{t('accreditation.usage.types.intro')}</p>
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left">
                  <tr>
                    <th scope="col" className="px-3 py-2 font-medium text-muted-foreground">
                      {t('accreditation.usage.groups.col_type')}
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium text-muted-foreground">
                      {t('accreditation.usage.groups.col_group')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {types.map((type) => {
                    const name = type.name.trim() === '' ? t('accreditation.usage.groups.type_id', { id: type.id }) : type.name;
                    return (
                      <tr key={type.id} className="border-t">
                        <th scope="row" className="px-3 py-2 text-left align-top font-normal">
                          {name}
                        </th>
                        <td className="px-3 py-2">
                          <div className="max-w-xs">
                            <AccredGroupSelect
                              label={t('accreditation.usage.groups.select', { type: name })}
                              value={groupOf(type.id, type.guess)}
                              disabled={busy}
                              onChange={(g) => setTypeGroups((current) => ({ ...current, [type.id]: g }))}
                            />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Field id={ids.cutover} label={t('accreditation.usage.cutover')} hint={t('accreditation.usage.cutover_hint')} error={cutoverError}>
          {(c) => (
            <Input
              {...c}
              type="date"
              value={cutover}
              disabled={busy}
              onChange={(e) => {
                setCutover(e.target.value);
                setCutoverError(undefined);
              }}
            />
          )}
        </Field>
        <Field id={ids.unknown} label={t('accreditation.usage.unknown_group')} hint={t('accreditation.usage.unknown_group_hint')}>
          {(c) => (
            <select
              {...c}
              className={SELECT_CLASS}
              value={unknownGroup ?? ''}
              disabled={busy}
              onChange={(e) => setUnknownGroup(e.target.value === '' ? null : (e.target.value as AccredGroup))}
            >
              <option value="">{t('accreditation.usage.groups.none')}</option>
              {ACCRED_GROUPS.map((g) => (
                <option key={g} value={g}>
                  {t(`vocab.accred_group.${g}`)}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>

      {uploading !== null && uploadLabel !== null && (
        <div className="grid gap-1">
          <ProgressBar value={uploading.total === 0 ? 0 : (uploading.done / uploading.total) * 100} label={uploadLabel} />
          <p role="status" className="text-sm text-muted-foreground">
            {uploadLabel}
          </p>
        </div>
      )}
      {phase.kind === 'starting' && (
        <p role="status" className="text-sm text-muted-foreground">
          {t('accreditation.usage.starting')}
        </p>
      )}
      {failure !== null && <Notice kind="error">{failure}</Notice>}

      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" disabled={busy} onClick={() => setStep('source')}>
          {t('accreditation.usage.back')}
        </Button>
        <Button type="button" disabled={busy} onClick={() => void start()}>
          {t('accreditation.usage.start')}
        </Button>
      </div>
    </div>
  );
}

// ---- step 3 --------------------------------------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function ImportRun({
  periodId,
  started,
  unknownDefault,
  onClose,
}: {
  periodId: string;
  started: Started;
  unknownDefault: AccredGroup | null;
  onClose(): void;
}) {
  const t = useT();
  const locale = useLocale();
  const queryClient = useQueryClient();
  const number = new Intl.NumberFormat(locale === 'en' ? 'en-GB' : 'id-ID');
  const [ended, setEnded] = useState<JobOutcome | null>(null);
  const run = useApiQuery<RunView>({
    queryKey: ['catalog', 'runs', started.runId],
    path: `catalog/runs/${encodeURIComponent(started.runId)}`,
    enabled: ended !== null,
  });

  const done = (status: JobOutcome): void => {
    setEnded(status);
    if (status === 'succeeded') {
      void queryClient.invalidateQueries({ queryKey: accredKeys.usage(periodId) });
      void queryClient.invalidateQueries({ queryKey: accredKeys.usageGroups() });
      void queryClient.invalidateQueries({ queryKey: accredKeys.period(periodId) });
      void queryClient.invalidateQueries({ queryKey: accredKeys.results(periodId) });
    }
  };

  const view = run.data;
  const s = isRecord(view?.summary) ? view.summary : null;
  const status = view?.status ?? (ended === 'dead' ? 'failed' : ended);
  const totals = isRecord(s?.['totals']) ? s['totals'] : {};
  const unknown = isRecord(s?.['memberUnknown']) ? s['memberUnknown'] : {};
  const written = isRecord(s?.['written']) ? s['written'] : null;
  const first = typeof s?.['firstMonth'] === 'string' ? s['firstMonth'] : null;
  const last = typeof s?.['lastMonth'] === 'string' ? s['lastMonth'] : null;
  const cutoverOn = typeof s?.['cutoverOn'] === 'string' ? s['cutoverOn'] : null;
  const failureCode = typeof s?.['failure'] === 'string' ? s['failure'] : 'error';

  return (
    <div className="flex flex-col gap-4">
      {started.joined === true && <NoticeAlert>{t('accreditation.usage.joined')}</NoticeAlert>}
      <div className="grid gap-2">
        <h3 className="text-sm font-semibold">{ended === null ? t('accreditation.usage.progress.title') : t('accreditation.usage.summary.title')}</h3>
        <JobProgress jobId={started.jobId} onDone={done} />
      </div>
      {ended !== null && view === undefined && !run.isError && (
        <p role="status" className="text-sm text-muted-foreground">
          {t('shell.loading')}
        </p>
      )}
      {ended !== null && (view !== undefined || run.isError) && (
        <div className="grid gap-3">
          {status === 'succeeded' && <Notice kind="success">{t('accreditation.usage.summary.succeeded')}</Notice>}
          {status === 'failed' && <Notice kind="error">{t('accreditation.usage.summary.failed', { code: failureCode })}</Notice>}
          {status === 'cancelled' && <Notice kind="error">{t('accreditation.usage.summary.cancelled')}</Notice>}
          {run.isError && <p className="text-sm text-muted-foreground">{t('accreditation.usage.summary.unreadable')}</p>}
          {s !== null && status === 'succeeded' && (
            <ul className="grid list-disc gap-1 pl-5 text-sm">
              {first !== null && last !== null && <li>{t('accreditation.usage.summary.months', { first, last })}</li>}
              <li>
                {t('accreditation.usage.summary.visits', { raw: number.format(count(totals['visits'])), deduped: number.format(count(totals['visitsDeduped'])) })}
              </li>
              <li>{t('accreditation.usage.summary.loans', { count: number.format(count(totals['loans'])) })}</li>
              <li>{t('accreditation.usage.summary.in_library', { count: number.format(count(totals['inLibraryUses'])) })}</li>
              {(count(unknown['visits']) > 0 || count(unknown['loans']) > 0) && (
                <li>
                  {t('accreditation.usage.summary.member_unknown', { visits: number.format(count(unknown['visits'])), loans: number.format(count(unknown['loans'])) })}
                </li>
              )}
              {written !== null && (
                <li>{t('accreditation.usage.summary.written', { rows: number.format(count(written['rows'])), months: number.format(count(written['months'])) })}</li>
              )}
              {cutoverOn !== null && <li>{t('accreditation.usage.summary.cutover', { date: cutoverOn })}</li>}
            </ul>
          )}
          <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm">{t('accreditation.usage.summary.note')}</p>
          {view?.reportFileId !== null && view?.reportFileId !== undefined && (
            <div>
              <a href={`/api/v1/catalog/runs/${encodeURIComponent(view.id)}/report`} download className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                <DownloadIcon aria-hidden="true" />
                {t('accreditation.usage.summary.report')}
              </a>
            </div>
          )}
          {status === 'succeeded' && started.sourceKind === 'dump' && (
            <div className="rounded-md border p-3">
              <GroupMap
                editable
                unknownDefault={unknownDefault}
                periodId={periodId}
                title={t('accreditation.usage.summary.map_title')}
                intro={t('accreditation.usage.summary.map_intro')}
              />
            </div>
          )}
          <div>
            <Button type="button" onClick={onClose}>
              {t('accreditation.usage.summary.done')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
