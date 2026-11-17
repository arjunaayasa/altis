import { MEMBER_IMPORT_FORMATS, MEMBER_IMPORT_MODES, type MemberImportFormat, type MemberImportMode, type MemberImportRefusal, type MemberImportWarning } from '@altis/shared';
import type { MemberImportCounts, MemberImportStartResponse, MemberImportView } from '@altis/shared/api/members';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useId, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { Notice, ProblemAlert, SELECT_CLASS } from '@/components/form-field';
import { Callout, DenseTable, StatStrip, StatusText, Steps, TABLE, Tag, type DenseColumn } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { useT, type TKey, type Translate } from '@/i18n';
import { holds } from '@/lib/access';
import { ApiError, api } from '@/lib/api';
import { useMe } from '@/lib/me';
import { uploadFile } from '@/lib/upload';
import { cn } from '@/lib/utils';
import { newTransactionKey, useMemberTypes } from '@/screens/circulation/common';
import { MEMBER_CSV_COLUMNS, initialMapping, missingFields, readCsvHead, remap, slimsHead, type CsvHead, type MemberCsvColumn } from './import-head';

/**
 * Impor Anggota (`/admin/anggota/impor`), a wizard of four numbered steps:
 *
 * 1. **Unggah berkas:** the format, then the file: the ALTIS CSV (a header row naming the columns, `member_no`, `name`,
 *    `member_type` required, the others optional, in any order) or a SLiMS member export (its 18 columns in their
 *    fixed order, the type by its name), `,` or `;` as separator, UTF-8 or the Windows encoding Excel uses in
 *    Indonesia, chosen or dropped on the page. The template can be downloaded.
 * 2. **Pemetaan & pratinjau:** the browser reads the file's head (import-head.ts; nothing is sent yet): the separator,
 *    the encoding and the rows, then each column of the file with a sample value and the ALTIS field it feeds, which the
 *    admin can change ("Abaikan kolom ini" leaves it out; a field chosen for another column moves there); it starts
 *    from the header's names or the SLiMS order. A required field no column feeds stops here. The first 5 rows show
 *    under the fields they feed, the cells that will not pass marked in colour and in words (why, and a count of the
 *    ones that refuse their row and the ones only warned of), and the mode: create new members only (a number that
 *    exists is skipped) or also update the ones that exist (an empty cell keeps the stored value). The dry run and
 *    the import read the file with that mapping.
 * 3. **Uji kering:** the file goes up (the staged context `members.import`) and a dry run reads and checks every row
 *    without writing: the counts (will create, will update, unchanged, refused per reason), the warnings and the first
 *    20 rows as the import reads them. A member type the file names but the library does not have refuses the row; it
 *    is never created.
 * 4. **Hasil:** "Jalankan impor" sends the same file again (a fresh upload: a dry run may have used the first) for the
 *    real run; its counts and, when rows were refused, the report (line number, member number and reason; kept 90
 *    days) to download.
 *
 * Each run is polled until it ends; leaving the page leaves it running on the server.
 */

const TEMPLATE_HEADER = MEMBER_CSV_COLUMNS.join(';');

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

type Step = 'file' | 'mapping' | 'dry_run' | 'result';

const STEPS: readonly Step[] = ['file', 'mapping', 'dry_run', 'result'];

/** Polls an import run every 1.5 s until it ends. */
function useImportRun(id: string | null) {
  const me = useMe();
  return useQuery({
    queryKey: ['members', 'imports', id],
    queryFn: () => api<MemberImportView>('GET', `members/imports/${encodeURIComponent(id!)}`, undefined, { background: true }),
    enabled: me !== undefined && id !== null,
    refetchInterval: (q) => (q.state.data !== undefined && TERMINAL.has(q.state.data.status) ? false : 1500),
  });
}

/** Saves the CSV template (the header row only) as a file. */
function downloadTemplate(): void {
  const blob = new Blob([`${TEMPLATE_HEADER}\r\n`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'template-anggota.csv';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function refusalText(t: Translate, reason: MemberImportRefusal): string {
  return t(`vocab.member_import_refusal.${reason}`);
}

function warningText(t: Translate, warning: MemberImportWarning): string {
  return t(`vocab.member_import_warning.${warning}`);
}

/** The counts of a run as one strip, then the refusals and the warnings by reason. */
function Counts({ counts, dryRun }: { counts: MemberImportCounts; dryRun: boolean }) {
  const t = useT();
  const refusals = Object.entries(counts.refusedBy).filter(([, n]) => (n ?? 0) > 0) as [MemberImportRefusal, number][];
  const warnings = Object.entries(counts.warnings).filter(([, n]) => (n ?? 0) > 0) as [MemberImportWarning, number][];
  return (
    <div className="grid gap-3">
      <p className="text-sm text-muted-foreground">{t('members.import.rows', { count: counts.rows })}</p>
      <StatStrip
        label={t('members.import.counts')}
        items={[
          { key: 'inserted', label: t(dryRun ? 'members.import.count.will_create' : 'members.import.count.created'), value: String(counts.inserted) },
          { key: 'updated', label: t(dryRun ? 'members.import.count.will_update' : 'members.import.count.updated'), value: String(counts.updated) },
          { key: 'unchanged', label: t('members.import.count.unchanged'), value: String(counts.unchanged) },
          { key: 'refused', label: t('members.import.count.refused'), value: String(counts.refused), ...(counts.refused > 0 ? { tone: 'bad' as const } : {}) },
        ]}
      />
      {refusals.length > 0 && (
        <Callout tone="bad" title={t('members.import.refused_rows', { count: counts.refused })}>
          <ul className="grid gap-0.5">
            {refusals.map(([reason, n]) => (
              <li key={reason}>{t('members.import.reason_count', { reason: refusalText(t, reason), count: n })}</li>
            ))}
          </ul>
          {refusals.some(([reason]) => reason === 'unknown_member_type') && <p>{t('members.import.unknown_type_hint')}</p>}
        </Callout>
      )}
      {warnings.length > 0 && (
        <Callout tone="warn" title={t('members.import.warnings')}>
          <ul className="grid gap-0.5">
            {warnings.map(([w, n]) => (
              <li key={w}>{t('members.import.reason_count', { reason: warningText(t, w), count: n })}</li>
            ))}
          </ul>
        </Callout>
      )}
    </div>
  );
}

/** A run in progress, failed, or done (its counts, and the sample rows of a dry run). */
function RunView({ run }: { run: MemberImportView | undefined }) {
  const t = useT();
  if (run === undefined || !TERMINAL.has(run.status)) {
    return (
      <div role="status" aria-busy="true" className="grid gap-1.5">
        <p className="text-sm">{t(run?.status === 'running' ? 'members.import.running' : 'members.import.queued')}</p>
        <div className="h-1.5 overflow-hidden rounded-full bg-layer-2">
          <div className="h-full w-1/3 animate-pulse rounded-full bg-primary motion-reduce:animate-none" />
        </div>
      </div>
    );
  }
  if (run.status !== 'succeeded' || run.counts === null) {
    const code = run.errorCode;
    return <Notice kind="error">{code === null ? t('members.import.failed') : t(`error.${code}` as TKey)}</Notice>;
  }
  const columns: DenseColumn<MemberImportView['sample'][number]>[] = [
    { id: 'line', header: t('members.import.col.line'), className: 'text-muted-foreground', cell: (r) => String(r.line) },
    { id: 'no', header: t('members.col.member_no'), className: 'whitespace-nowrap', cell: (r) => <span className="font-semibold tracking-wide">{r.memberNo}</span> },
    { id: 'name', header: t('members.col.name'), cell: (r) => r.name },
    {
      id: 'type',
      header: t('members.col.type'),
      cell: (r) => (r.refusal === 'unknown_member_type' ? <StatusText tone="bad">{r.memberType}</StatusText> : r.memberType),
    },
    { id: 'class', header: t('members.col.class'), cell: (r) => r.className ?? '—' },
    {
      id: 'state',
      header: t('members.import.col.state'),
      cell: (r) =>
        r.refusal !== null ? (
          <StatusText tone="bad">{refusalText(t, r.refusal)}</StatusText>
        ) : r.warnings.length > 0 ? (
          <StatusText tone="warn">{r.warnings.map((w) => warningText(t, w)).join(', ')}</StatusText>
        ) : (
          <span className="text-muted-foreground">{t('members.import.row_ok')}</span>
        ),
    },
  ];
  return (
    <div className="grid gap-4">
      <Counts counts={run.counts} dryRun={run.dryRun} />
      {run.dryRun && run.sample.length > 0 && (
        <section className="grid gap-2">
          <h3 className="text-sm font-bold">{t('members.import.sample')}</h3>
          <DenseTable caption={t('members.import.sample')} columns={columns} rows={run.sample} rowKey={(r) => String(r.line)} empty={t('members.import.sample_empty')} />
        </section>
      )}
      {run.reportAvailable && (
        <div className="grid gap-1">
          <Button asChild variant="outline" className="w-fit">
            <a href={`/api/v1/members/imports/${encodeURIComponent(run.id)}/report`} download>
              {t('members.import.report')}
            </a>
          </Button>
          <p className="text-xs text-muted-foreground">{t('members.import.report_note')}</p>
        </div>
      )}
    </div>
  );
}

export function MemberImportScreen() {
  const t = useT();
  const me = useMe();
  const ids = useId();
  const queryClient = useQueryClient();
  const types = useMemberTypes();
  const canRun = holds(me, 'members.import.run');
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [head, setHead] = useState<CsvHead | null>(null);
  // ---- Komunitas (staff screens' data): the format and the field each column feeds ----
  const [format, setFormat] = useState<MemberImportFormat>('csv-members');
  const [mapping, setMapping] = useState<(MemberCsvColumn | null)[]>([]);
  const [mode, setMode] = useState<MemberImportMode>('create_only');
  const [step, setStep] = useState<Step>('file');
  const [dryRunId, setDryRunId] = useState<string | null>(null);
  const [realRunId, setRealRunId] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [problem, setProblem] = useState<unknown>(null);
  const [fileError, setFileError] = useState<ReactNode>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const dryRun = useImportRun(dryRunId);
  const realRun = useImportRun(realRunId);

  /** Reads the head of the chosen file in the browser, then shows the mapping (or says why the file cannot go on). */
  const choose = async (next: File | null): Promise<void> => {
    setProblem(null);
    setFileError(null);
    setFile(next);
    setHead(null);
    if (next === null) return;
    try {
      const raw = readCsvHead(new Uint8Array(await next.arrayBuffer()));
      const read = format === 'slims-members' ? slimsHead(raw) : raw;
      setHead(read);
      setMapping(initialMapping(format, read.header));
      setStep('mapping');
    } catch {
      setFileError(t('members.import.unreadable'));
    }
  };

  /** Uploads the file and starts a run; returns its id, or null after a problem (said on the page). */
  const start = async (dry: boolean): Promise<string | null> => {
    if (file === null) return null;
    setProblem(null);
    setFileError(null);
    setBusy(true);
    setProgress(0);
    try {
      const { uploadId } = await uploadFile(file, { context: 'members.import', onProgress: (sent, total) => setProgress(total === 0 ? 100 : Math.round((sent / total) * 100)) });
      const started = await api<MemberImportStartResponse>(
        'POST',
        'members/imports',
        { uploadId, format, mode, dryRun: dry, columns: mapping },
        { idempotencyKey: newTransactionKey('member-import') },
      );
      return started.id;
    } catch (e) {
      if (e instanceof ApiError && e.code === 'MEMBER_IMPORT_FORMAT') {
        setFileError(t('error.MEMBER_IMPORT_FORMAT'));
        setStep('file');
      } else setProblem(e);
      return null;
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const runDry = async (): Promise<void> => {
    if (file === null) {
      setFileError(t('members.import.no_file'));
      setStep('file');
      return;
    }
    const id = await start(true);
    if (id !== null) {
      setDryRunId(id);
      setRealRunId(null);
      setStep('dry_run');
    }
  };

  const runReal = async (): Promise<void> => {
    const id = await start(false);
    if (id !== null) {
      setRealRunId(id);
      setStep('result');
    }
  };

  const restart = (): void => {
    setStep('file');
    setFile(null);
    setHead(null);
    setMapping([]);
    setDryRunId(null);
    setRealRunId(null);
    setProblem(null);
    setFileError(null);
    if (fileInput.current !== null) fileInput.current.value = '';
    void queryClient.invalidateQueries({ queryKey: ['members'] });
  };

  const onDrop = (e: DragEvent<HTMLLabelElement>): void => {
    e.preventDefault();
    setOver(false);
    if (!canRun || busy) return;
    void choose(e.dataTransfer.files[0] ?? null);
  };

  const dryDone = dryRun.data !== undefined && dryRun.data.status === 'succeeded';
  const realDone = realRun.data !== undefined && TERMINAL.has(realRun.data.status);
  const missing = missingFields(mapping);
  // A SLiMS export names the type: its name (Indonesian or English) is known as well as its code.
  const typeCodes = new Set(
    (types.data?.items ?? []).flatMap((x) => [x.code.toLowerCase(), ...(format === 'slims-members' ? [x.nameId.toLowerCase(), ...(x.nameEn === null ? [] : [x.nameEn.toLowerCase()])] : [])]),
  );
  // The preview's rows, each cell with how it will fare (null: a column the preview does not show, or a fine value).
  const previewFlags =
    head === null
      ? []
      : head.rows.slice(0, 5).map((row) =>
          head.header.map((_, i) => {
            const c = mapping[i] ?? null;
            return c === null ? null : cellFlag(c, row[i] ?? '', typeCodes, format);
          }),
        );
  const flagged = previewFlags.flat().filter((f): f is CellFlag => f !== null);
  const refusedCells = flagged.filter((f) => f.tone === 'bad').length;

  return (
    <div className="grid gap-6">
      <div className="grid max-w-[75ch] gap-1">
        <h1 className="text-xl leading-tight font-bold">{t('nav.members.import')}</h1>
        <p className="text-sm text-muted-foreground">{t('members.import.page_intro')}</p>
      </div>
      <Steps
        label={t('members.import.steps')}
        current={STEPS.indexOf(step)}
        doneLabel={t('members.import.step_done')}
        steps={[t('members.import.step.file'), t('members.import.step.mapping'), t('members.import.step.dry_run'), t('members.import.step.result')]}
      />
      {!canRun && <ProblemAlert error={new ApiError(403, 'AUTHZ_DENIED')} />}
      <ProblemAlert error={problem} />

      {step === 'file' && (
        <section aria-labelledby={`${ids}-h`} className="grid max-w-3xl gap-4">
          <h2 id={`${ids}-h`} className="text-base font-bold">
            {t('members.import.step.file')}
          </h2>
          {fileError !== null && (
            <Callout tone="bad" role="alert" title={t('members.import.not_members_csv')}>
              <p>{fileError}</p>
            </Callout>
          )}
          <p className="text-sm text-muted-foreground">{t('members.import.intro')}</p>
          <fieldset className="grid gap-2" disabled={!canRun || busy}>
            <legend className="mb-1 text-meta font-semibold">{t('members.import.format')}</legend>
            {MEMBER_IMPORT_FORMATS.map((f) => (
              <label key={f} className="flex items-start gap-2 text-sm">
                <input type="radio" name={`${ids}-format`} value={f} checked={format === f} onChange={() => setFormat(f)} className="mt-0.5 size-4 accent-primary" />
                <span>
                  <span className="font-semibold">{t(`members.import.format.${f}`)}</span>
                  <span className="block text-xs text-muted-foreground">{t(`members.import.format_hint.${f}`)}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <label
            htmlFor={`${ids}-file`}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={onDrop}
            className={cn(
              'grid cursor-pointer justify-items-center gap-1.5 rounded-lg border border-dashed px-4 py-8 text-center has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-ring',
              over ? 'border-primary bg-accent-soft' : 'border-input bg-layer hover:border-primary hover:bg-accent-soft',
              (!canRun || busy) && 'cursor-not-allowed opacity-60',
            )}>
            <strong>{t('members.import.drop')}</strong>
            <span className="text-sm text-muted-foreground">{t('members.import.file_hint')}</span>
            {file !== null && <span className="text-sm">{file.name}</span>}
            <input
              ref={fileInput}
              id={`${ids}-file`}
              type="file"
              accept=".csv,text/csv,text/plain"
              disabled={!canRun || busy}
              className="sr-only"
              onChange={(e) => void choose(e.target.files?.[0] ?? null)}
            />
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" variant="link" className="h-auto w-fit p-0" onClick={downloadTemplate}>
              {t('members.import.template')}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t('members.import.required_note')}</p>
        </section>
      )}

      {step === 'mapping' && head !== null && (
        <section aria-labelledby={`${ids}-h`} className="grid gap-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id={`${ids}-h`} className="text-base font-bold">
              {t('members.import.step.mapping')}
            </h2>
            <span className="text-sm text-muted-foreground">
              {t('members.import.detected', {
                name: file?.name ?? '',
                sep: t(head.separator === ';' ? 'members.import.sep.semicolon' : 'members.import.sep.comma'),
                encoding: head.encoding === 'utf-8' ? 'UTF-8' : 'Windows-1252',
                rows: head.total,
                columns: head.header.length,
              })}
            </span>
          </div>
          <DenseTable
            caption={t('members.import.mapping_caption')}
            columns={[
              { id: 'col', header: t('members.import.col.file_column'), className: 'whitespace-nowrap', cell: (i: number) => <span className="font-semibold tracking-wide">{head.header[i] === '' ? '—' : head.header[i]}</span> },
              { id: 'sample', header: t('members.import.col.sample'), className: 'text-muted-foreground', cell: (i: number) => head.rows[0]?.[i] ?? '' },
              {
                id: 'field',
                header: t('members.import.col.field'),
                className: 'min-w-[220px]',
                cell: (i: number) => {
                  const c = mapping[i] ?? null;
                  const label = head.header[i] === '' ? t('members.import.column_n', { n: i + 1 }) : head.header[i]!;
                  return (
                    <select
                        aria-label={t('members.import.field_for', { column: label })}
                        className={cn(SELECT_CLASS, 'h-8 w-auto min-w-[180px] text-meta')}
                        disabled={!canRun || busy}
                        value={c ?? ''}
                        onChange={(e) => setMapping((m) => remap(m, i, e.target.value === '' ? null : (e.target.value as MemberCsvColumn)))}>
                        {MEMBER_CSV_COLUMNS.map((f) => (
                          <option key={f} value={f}>
                            {REQUIRED.has(f) ? t('members.import.field_required', { field: t(FIELD_LABEL[f]) }) : t(FIELD_LABEL[f])}
                          </option>
                        ))}
                        <option value="">{t('members.import.ignore')}</option>
                    </select>
                  );
                },
              },
            ]}
            rows={head.header.map((_, i) => i)}
            rowKey={(i) => String(i)}
            empty="—"
          />
          <p className="text-meta text-muted-foreground">{t('members.import.mapping_note')}</p>
          {missing.length > 0 && (
            <Callout tone="bad" role="alert" title={t('members.import.unmapped', { fields: missing.map((f) => t(FIELD_LABEL[f])).join(', ') })}>
              <p>{t('members.import.fix_mapping')}</p>
            </Callout>
          )}
          <fieldset className="grid gap-2" disabled={!canRun || busy}>
            <legend className="mb-1 text-sm font-semibold">{t('members.import.mode')}</legend>
            {MEMBER_IMPORT_MODES.map((m) => (
              <label key={m} className="flex items-start gap-2 text-sm">
                <input type="radio" name={`${ids}-mode`} value={m} checked={mode === m} onChange={() => setMode(m)} className="mt-0.5 size-4 accent-primary" />
                <span>
                  <span className="font-semibold">{t(`members.import.mode.${m}`)}</span>
                  <span className="block text-xs text-muted-foreground">{t(`members.import.mode_hint.${m}`)}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <h3 className="text-sm font-bold">{t('members.import.preview', { count: Math.min(5, head.rows.length) })}</h3>
          <div className={TABLE.wrap}>
            <table className={TABLE.table}>
              <caption className="sr-only">{t('members.import.preview', { count: Math.min(5, head.rows.length) })}</caption>
              <thead>
                <tr>
                  <th scope="col" className={TABLE.th}>
                    {t('members.import.col.line')}
                  </th>
                  {head.header.map((_, i) => {
                    const c = mapping[i] ?? null;
                    return c !== null ? (
                      <th key={i} scope="col" className={TABLE.th}>
                        {t(FIELD_LABEL[c])}
                      </th>
                    ) : null;
                  })}
                </tr>
              </thead>
              <tbody>
                {head.rows.slice(0, 5).map((row, r) => (
                  <tr key={r}>
                    <td className={cn(TABLE.td, 'text-muted-foreground')}>{head.lines[r]}</td>
                    {head.header.map((_, i) => {
                      const c = mapping[i] ?? null;
                      if (c === null) return null;
                      const v = row[i] ?? '';
                      const flag = previewFlags[r]?.[i] ?? null;
                      return (
                        <td key={i} className={cn(TABLE.td, 'whitespace-nowrap')}>
                          {v === '' ? (
                            <span className="text-muted-foreground">—</span>
                          ) : flag === null ? (
                            v
                          ) : (
                            <span className="inline-flex items-center gap-1.5">
                              <StatusText tone={flag.tone}>{v}</StatusText>
                              <Tag tone={flag.tone}>{t(`members.import.cell.${flag.problem}`)}</Tag>
                            </span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {flagged.length > 0 && <p className="text-sm text-muted-foreground">{t('members.import.flagged', { refused: refusedCells, warned: flagged.length - refusedCells })}</p>}
          {progress !== null && (
            <p role="status" className="text-sm text-muted-foreground">
              {t('members.import.uploading', { percent: progress })}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" disabled={busy} onClick={restart}>
              {t('members.import.back')}
            </Button>
            <Button type="button" disabled={busy || !canRun || missing.length > 0} onClick={() => void runDry()}>
              {t('members.import.dry_run')}
            </Button>
            <span className="text-sm text-muted-foreground">{t('members.import.dry_run_saves_nothing')}</span>
          </div>
        </section>
      )}

      {step === 'dry_run' && (
        <section className="grid gap-4" aria-labelledby={`${ids}-h`}>
          <div className="grid gap-1">
            <h2 id={`${ids}-h`} className="text-base font-bold">
              {t('members.import.step.dry_run')}
            </h2>
            <p className="text-sm text-muted-foreground">{t('members.import.dry_run_note', { name: file?.name ?? '' })}</p>
          </div>
          <RunView run={dryRun.data} />
          {dryRun.isError && <Notice kind="error">{t('members.import.poll_failed')}</Notice>}
          {progress !== null && (
            <p role="status" className="text-sm text-muted-foreground">
              {t('members.import.uploading', { percent: progress })}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" disabled={busy} onClick={() => setStep(head === null ? 'file' : 'mapping')}>
              {t('members.import.back_mapping')}
            </Button>
            <Button type="button" disabled={!dryDone || busy || !canRun} onClick={() => void runReal()}>
              {t('members.import.run')}
            </Button>
          </div>
        </section>
      )}

      {step === 'result' && (
        <section className="grid max-w-3xl gap-4" aria-labelledby={`${ids}-h`}>
          <h2 id={`${ids}-h`} className="text-base font-bold">
            {t(realDone ? 'members.import.done_title' : 'members.import.running_title')}
          </h2>
          {!realDone && <p className="text-xs text-muted-foreground">{t('members.import.leave_ok')}</p>}
          <RunView run={realRun.data} />
          {realRun.isError && <Notice kind="error">{t('members.import.poll_failed')}</Notice>}
          {realDone && (
            <div className="flex flex-wrap gap-2">
              <Button asChild>
                <Link to="/admin/anggota">{t('members.import.view_members')}</Link>
              </Button>
              <Button type="button" variant="ghost" onClick={restart}>
                {t('members.import.another')}
              </Button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

const REQUIRED: ReadonlySet<MemberCsvColumn> = new Set(['member_no', 'name', 'member_type']);

/** The form label of each column of the CSV. */
const FIELD_LABEL: Readonly<Record<MemberCsvColumn, TKey>> = {
  member_no: 'members.field.member_no',
  name: 'members.field.name',
  member_type: 'members.field.type',
  class_name: 'members.field.class',
  identity_no: 'members.field.identity_no',
  gender: 'members.field.gender',
  birth_date: 'members.field.birth_date',
  email: 'members.field.email',
  phone: 'members.field.phone',
  address: 'members.field.address',
  postal_code: 'members.field.postal_code',
  mailing_address: 'members.field.mailing_address',
  institution: 'members.field.institution',
  joined_on: 'members.field.joined_on',
  expires_on: 'members.field.expires_on',
  home_branch: 'members.field.home_branch',
  notes: 'members.field.notes',
  locale: 'members.field.locale',
};

/** How a preview cell will fare: `bad` when the row will be refused for it, `warn` when it is only warned of; and why. */
interface CellFlag {
  tone: 'bad' | 'warn';
  problem: 'unknown_type' | 'unreadable_date' | 'gender_unknown';
}

/** See {@link CellFlag}; null for a value the import takes as it is. */
function cellFlag(column: MemberCsvColumn, value: string, typeCodes: ReadonlySet<string>, format: MemberImportFormat): CellFlag | null {
  const v = value.trim();
  if (v === '') return null;
  const slims = format === 'slims-members';
  if (column === 'member_type') return typeCodes.size > 0 && !typeCodes.has(v.toLowerCase()) ? { tone: 'bad', problem: 'unknown_type' } : null;
  if (column === 'birth_date' || column === 'joined_on' || column === 'expires_on') {
    if (slims && v === '0000-00-00') return null;
    return /^\d{4}-\d{2}-\d{2}$|^\d{1,2}[/.-]\d{1,2}[/.-]\d{4}$/.test(v) ? null : { tone: 'bad', problem: 'unreadable_date' };
  }
  if (column === 'gender') return /^(l|p|m|f|male|female|laki-laki|perempuan)$/i.test(v) || (slims && (v === '0' || v === '1')) ? null : { tone: 'warn', problem: 'gender_unknown' };
  return null;
}
