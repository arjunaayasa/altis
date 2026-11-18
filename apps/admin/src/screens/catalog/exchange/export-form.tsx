import { EXPORT_FORMATS, isUlid, vocabKey, type ExportFormat } from '@altis/shared';
import type { BranchListResponse } from '@altis/shared/api/branches';
import { EXPORT_RECORD_IDS_MAX, type ExportBody } from '@altis/shared/api/catalog/exchange';
import type { CollectionTypeView, MasterListResponse, MaterialTypeView } from '@altis/shared/api/catalog/masters';
import type { RunStarted, RunView } from '@altis/shared/api/catalog/runs';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useId, useState, type FormEvent } from 'react';
import { JobProgress, type JobOutcome } from '@/components/job-progress';
import { CheckField, Field, NoticeAlert, ProblemAlert, SELECT_CLASS } from '@/components/form-field';
import { Callout, FORM_FULL, FormSection, LoadingState } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useLocale, useT } from '@/i18n';
import { api } from '@/lib/api';
import { useApiQuery } from '@/lib/me';
import { RUNS_KEY, RUN_LINK, SummaryView, runHref, runKey, useRetryKey } from './summary-view';

/**
 * Impor/Ekspor, the export form (Phase 2 spec §5.4, §13; plan Task 29): `POST catalog/exports` with a format and the
 * filters of `ExportBody` (a search in the syntax of Bibliografi, the material type, the collection type and the branch
 * of the items, records changed since a local day, archived records too), or with the records chosen in Bibliografi.
 *
 * - **"Ekspor terpilih" (M2):** Bibliografi stores the chosen ids (≤ {@link EXPORT_RECORD_IDS_MAX}) in
 *   `sessionStorage` under {@link EXPORT_SELECTION_KEY} and opens this page with `?export=selection`. The screen reads
 *   them once ({@link readExportSelection}), clears the storage ({@link clearExportSelection}) and drops the param, so a
 *   reload or a later visit never exports an old choice. The selection replaces the filters ("Ekspor dengan filter"
 *   drops it). A selection that is gone, malformed or too long is never sent, in part or in whole: the page says so.
 *   "Sertakan cantuman yang diarsipkan" stays offered with a selection (the server keeps an archived id only with
 *   `includeArchived`), ticked when Bibliografi says an archived record is among the ids; it is not forced, since it
 *   also lets archived items into the file. A run that wrote fewer records than were chosen (archived without the
 *   box, merged or deleted since) says how many were left out, so a short file is never silent (C20).
 * - The export runs as a job (`JobProgress`, which drives it from the page where no worker runs); its run then offers
 *   the file (`GET catalog/runs/:id/download`) until it expires, and the summary (skipped records, e.g.
 *   `marc_too_long`).
 *
 * Every value is checked by the server again; the form only sends what it offers.
 */

/** Where Bibliografi leaves the chosen record ids (the same key as its `EXPORT_SELECTION_KEY`; a test pins both). */
export const EXPORT_SELECTION_KEY = 'altis.exportSelection';

/** More stored text than this is not a selection Bibliografi wrote (1 000 ULIDs are about 28 KB of JSON). */
const SELECTION_TEXT_MAX = 64 * 1024;

/** The records chosen in Bibliografi, or `lost` when the page was asked for a selection it cannot read. */
export type ExportSelection = { kind: 'ids'; ids: string[]; archived: boolean } | { kind: 'lost' };

const LOST: ExportSelection = { kind: 'lost' };

/** The selection Bibliografi stored, read without changing anything (see the top of this file). */
export function readExportSelection(): ExportSelection {
  let text: string | null;
  try {
    text = sessionStorage.getItem(EXPORT_SELECTION_KEY);
  } catch {
    return LOST;
  }
  if (text === null || text.length > SELECTION_TEXT_MAX) return LOST;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return LOST;
  }
  // `{ids, archived}` as Bibliografi writes it; a bare list of ids (an older page of the same session) is no archived one.
  const stored = Array.isArray(value) ? { ids: value as unknown, archived: false } : storedSelection(value);
  if (stored === null) return LOST;
  const list = stored.ids;
  if (!Array.isArray(list) || !list.every((id): id is string => typeof id === 'string' && isUlid(id))) return LOST;
  const ids = [...new Set(list)];
  return ids.length === 0 || ids.length > EXPORT_RECORD_IDS_MAX ? LOST : { kind: 'ids', ids, archived: stored.archived };
}

/** The `{ids, archived}` object Bibliografi stores, or null for any other value. */
function storedSelection(value: unknown): { ids: unknown; archived: boolean } | null {
  if (typeof value !== 'object' || value === null) return null;
  const { ids, archived } = value as { ids?: unknown; archived?: unknown };
  return archived === undefined || typeof archived === 'boolean' ? { ids, archived: archived === true } : null;
}

/** Clears the stored selection; a storage that refuses is left as it is (the param is dropped all the same). */
export function clearExportSelection(): void {
  try {
    sessionStorage.removeItem(EXPORT_SELECTION_KEY);
  } catch {
    // Blocked storage: the selection was read once, and the page no longer asks for it.
  }
}

/** The filters as the form holds them (`''`: not chosen, never sent). */
interface Filters {
  q: string;
  materialTypeId: string;
  collectionTypeId: string;
  branchId: string;
  /** A local `YYYY-MM-DD` day. */
  changedSince: string;
  includeArchived: boolean;
}

const NO_FILTERS: Filters = { q: '', materialTypeId: '', collectionTypeId: '', branchId: '', changedSince: '', includeArchived: false };

/** `ExportBody.filter.q` is at most 500 characters. */
const Q_MAX = 500;

/** Epoch ms of a local day's first millisecond, or undefined for no day or a bad one. */
function localMidnight(day: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined;
  const ms = new Date(`${day}T00:00:00`).getTime();
  return Number.isNaN(ms) || ms < 0 ? undefined : ms;
}

/**
 * The body of `POST catalog/exports`: the selection, or the chosen filters only; booleans only when on. Archived
 * records (and items) are asked for with a selection too: the server keeps an archived id only with them.
 */
export function exportBody(format: ExportFormat, selection: string[] | null, f: Filters, includeItems: boolean): ExportBody {
  const filter: ExportBody['filter'] = {};
  if (selection !== null) {
    filter.recordIds = selection;
  } else {
    const q = f.q.trim().slice(0, Q_MAX);
    if (q !== '') filter.q = q;
    if (f.materialTypeId !== '') filter.materialTypeId = f.materialTypeId;
    if (f.collectionTypeId !== '') filter.collectionTypeId = f.collectionTypeId;
    if (f.branchId !== '') filter.branchId = f.branchId;
    const since = localMidnight(f.changedSince);
    if (since !== undefined) filter.changedSince = since;
  }
  if (f.includeArchived) filter.includeArchived = true;
  if (includeItems) filter.includeItems = true;
  return { format, filter };
}

/** A non-negative whole counter of a run's summary, or 0. */
function counter(v: unknown): number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0;
}

/**
 * How many of `chosen` selected records a succeeded export left out without a reason in its report (archived without
 * `includeArchived`, merged or deleted since they were chosen): `chosen` less the written and the reported ones.
 */
export function leftOutOf(run: RunView, chosen: number): number {
  if (run.status !== 'succeeded' || run.summary === null) return 0;
  const skipped = run.summary['skipped'];
  const reported = typeof skipped === 'object' && skipped !== null ? counter((skipped as Record<string, unknown>)['marc_too_long']) : 0;
  return Math.max(0, chosen - counter(run.summary['records']) - reported);
}

/**
 * A started export: its progress, then its run (the file, the expiry, the summary). `chosen` is the number of
 * selected records it was started with (null: by the filters).
 */
function ExportRun({ started, chosen, onAgain }: { started: RunStarted; chosen: number | null; onAgain(): void }) {
  const t = useT();
  const locale = useLocale();
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
  const leftOut = chosen === null || run.data === undefined ? 0 : leftOutOf(run.data, chosen);
  const number = new Intl.NumberFormat(locale === 'en' ? 'en-GB' : 'id-ID');
  return (
    <section aria-labelledby={headingId} className="grid gap-3">
      <h3 id={headingId} className="text-heading font-semibold">
        {t(read ? 'catalog.exchange.export.result' : 'catalog.exchange.export.running')}
      </h3>
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
      {leftOut > 0 && (
        <NoticeAlert>{t('catalog.exchange.export.selection_short', { count: number.format(leftOut), chosen: number.format(chosen ?? 0) })}</NoticeAlert>
      )}
      <div className="flex flex-wrap items-center gap-3">
        {outcome !== null && (
          <Button type="button" variant="outline" onClick={onAgain}>
            {t('catalog.exchange.export.again')}
          </Button>
        )}
        <Link to={runHref(started.runId)} className={RUN_LINK}>
          {t('catalog.exchange.open_run')}
        </Link>
      </div>
    </section>
  );
}

/** The export form (see the top of this file); `selection` is what the screen read for `?export=selection`. */
export function ExportForm({ selection, onDropSelection }: { selection: ExportSelection | null; onDropSelection(): void }) {
  const t = useT();
  const locale = useLocale();
  const headingId = useId();
  const [format, setFormat] = useState<ExportFormat>('marc21');
  // A selection that holds an archived record asks for archived records from the start (the screen reads it once).
  const [filters, setFilters] = useState<Filters>(() => ({ ...NO_FILTERS, includeArchived: selection?.kind === 'ids' && selection.archived }));
  const [includeItems, setIncludeItems] = useState(false);
  const [posting, setPosting] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);
  const [started, setStarted] = useState<{ run: RunStarted; chosen: number | null } | null>(null);
  const retryKey = useRetryKey('catalog-export');
  const branches = useApiQuery<BranchListResponse>({ queryKey: ['branches', { includeArchived: true }], path: 'branches?includeArchived=true' });
  const types = useApiQuery<MasterListResponse<MaterialTypeView>>({
    queryKey: ['catalog', 'material-types', { includeArchived: true }],
    path: 'catalog/material-types?includeArchived=true',
  });
  const collections = useApiQuery<MasterListResponse<CollectionTypeView>>({
    queryKey: ['catalog', 'collection-types', { includeArchived: true }],
    path: 'catalog/collection-types?includeArchived=true',
  });
  const ids = selection?.kind === 'ids' ? selection.ids : null;
  const number = new Intl.NumberFormat(locale === 'en' ? 'en-GB' : 'id-ID');
  const name = (n: { nameId: string; nameEn: string }): string => (locale === 'en' ? n.nameEn : n.nameId);
  const archivedName = (label: string, archived: boolean): string => (archived ? t('catalog.exchange.export.archived_option', { name: label }) : label);
  const set = <K extends keyof Filters>(key: K, value: Filters[K]): void => setFilters((f) => ({ ...f, [key]: value }));
  // The form shows once its lists have answered, so every choice it offers is there when it appears.
  const settled = [branches, types, collections].every((q) => q.data !== undefined || q.isError);
  const listProblem = [branches, types, collections].find((q) => q.isError)?.error ?? null;

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (posting) return;
    setProblem(null);
    setPosting(true);
    try {
      const body = exportBody(format, ids, filters, includeItems);
      const next = await api<RunStarted>('POST', 'catalog/exports', body, { idempotencyKey: retryKey.key(body) });
      retryKey.clear();
      setStarted({ run: next, chosen: ids?.length ?? null });
    } catch (e) {
      setProblem(e);
    } finally {
      setPosting(false);
    }
  };

  return (
    <section aria-labelledby={headingId} className="grid gap-5">
      <h2 id={headingId} className="text-heading font-semibold">
        {t('catalog.exchange.export.title')}
      </h2>
      {started !== null ? (
        <ExportRun key={started.run.runId} started={started.run} chosen={started.chosen} onAgain={() => setStarted(null)} />
      ) : !settled ? (
        <LoadingState />
      ) : (
        <form noValidate className="grid gap-4" onSubmit={(e) => void submit(e)}>
          <ProblemAlert error={listProblem} />
          {ids !== null ? (
            <Callout
              title={t('catalog.exchange.export.selection', { count: number.format(ids.length) })}
              action={
                <Button type="button" size="sm" variant="outline" className="bg-background" onClick={onDropSelection}>
                  {t('catalog.exchange.export.selection_clear')}
                </Button>
              }>
              <CheckField
                label={t('catalog.exchange.export.include_archived')}
                hint={t('catalog.exchange.export.selection_archived_hint')}
                checked={filters.includeArchived}
                onChange={(e) => set('includeArchived', e.target.checked)}
              />
            </Callout>
          ) : (
            <>
              {selection?.kind === 'lost' && <NoticeAlert>{t('catalog.exchange.export.selection_lost')}</NoticeAlert>}
              <FormSection title={t('catalog.exchange.export.filters')}>
                <Field label={t('catalog.exchange.export.q')} hint={t('catalog.exchange.export.q_hint')} className={FORM_FULL}>
                  {(c) => (
                    <Input
                      {...c}
                      type="search"
                      maxLength={Q_MAX}
                      autoComplete="off"
                      spellCheck={false}
                      value={filters.q}
                      onChange={(e) => set('q', e.target.value)}
                    />
                  )}
                </Field>
                <Field label={t('catalog.exchange.export.type')}>
                  {(c) => (
                    <select {...c} className={SELECT_CLASS} value={filters.materialTypeId} onChange={(e) => set('materialTypeId', e.target.value)}>
                      <option value="">{t('catalog.exchange.export.type_all')}</option>
                      {(types.data?.items ?? []).map((m) => (
                        <option key={m.id} value={m.id}>
                          {archivedName(`${name(m)} (${m.code})`, m.archived)}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
                <Field label={t('catalog.exchange.export.collection')}>
                  {(c) => (
                    <select {...c} className={SELECT_CLASS} value={filters.collectionTypeId} onChange={(e) => set('collectionTypeId', e.target.value)}>
                      <option value="">{t('catalog.exchange.export.collection_all')}</option>
                      {(collections.data?.items ?? []).map((m) => (
                        <option key={m.id} value={m.id}>
                          {archivedName(`${name(m)} (${m.code})`, m.archived)}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
                <Field label={t('catalog.exchange.export.branch')}>
                  {(c) => (
                    <select {...c} className={SELECT_CLASS} value={filters.branchId} onChange={(e) => set('branchId', e.target.value)}>
                      <option value="">{t('catalog.exchange.export.branch_all')}</option>
                      {(branches.data?.items ?? []).map((b) => (
                        <option key={b.id} value={b.id}>
                          {archivedName(`${b.name} (${b.code})`, b.archivedAt !== null)}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
                <Field label={t('catalog.exchange.export.changed_since')}>
                  {(c) => <Input {...c} type="date" value={filters.changedSince} onChange={(e) => set('changedSince', e.target.value)} />}
                </Field>
                <CheckField
                  className="self-end pb-2"
                  label={t('catalog.exchange.export.include_archived')}
                  checked={filters.includeArchived}
                  onChange={(e) => set('includeArchived', e.target.checked)}
                />
              </FormSection>
            </>
          )}
          <FormSection title={t('catalog.exchange.export.file_section')}>
            <Field label={t('catalog.exchange.export.format')}>
              {(c) => (
                <select {...c} className={SELECT_CLASS} value={format} onChange={(e) => setFormat(e.target.value as ExportFormat)}>
                  {EXPORT_FORMATS.map((f) => (
                    <option key={f} value={f}>
                      {t(vocabKey('export_format', f))}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <CheckField
              className="self-end pb-2"
              label={t('catalog.exchange.export.include_items')}
              checked={includeItems}
              onChange={(e) => setIncludeItems(e.target.checked)}
            />
          </FormSection>
          <div className="grid gap-3 border-t pt-4">
            <ProblemAlert error={problem} />
            <p className="max-w-[75ch] text-sm text-muted-foreground">{t('catalog.exchange.export.hint')}</p>
            <div>
              <Button type="submit" disabled={posting}>
                {t('catalog.exchange.export.submit')}
              </Button>
            </div>
          </div>
        </form>
      )}
    </section>
  );
}
