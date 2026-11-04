import { EXPORT_FORMATS, IMPORT_FORMATS, vocabKey, type RunStatus } from '@altis/shared';
import type { ImportSummary } from '@altis/shared/api/catalog/exchange';
import type { DedupeScanSummary, RunView } from '@altis/shared/api/catalog/runs';
import { DownloadIcon, FileTextIcon, TriangleAlertIcon } from 'lucide-react';
import { useRef, type ReactNode } from 'react';
import { useDateTime } from '@/components/data-table';
import { Badge } from '@/components/form-field';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { buttonVariants } from '@/components/ui/button';
import { useLocale, useT, type Translate } from '@/i18n';
import { holds } from '@/lib/access';
import { isMessageKey } from '@/lib/form-errors';
import { useMe } from '@/lib/me';

/**
 * What a catalog run shows once it has a summary (Phase 2 spec §5.3, §5.4, §3.3; plan Task 29), for the import wizard,
 * the export form and the run's own page:
 *
 * - an import (`ImportSummary`): the counts of §5.3 (on a dry run: what would happen, said so), the reasons for
 *   skipping, the reader's warnings (`encoding_cp1252`, Review Focus 1) and the first mapped drafts;
 * - a duplicate scan (`DedupeScanSummary`): its counts (the groups are Duplikat's);
 * - any other run (an export, a migration): its numeric counters, with a label where the key has one.
 *
 * Then the files: the CSV report (`GET catalog/runs/:id/report`, never `/files/:id`, S18) and an export's file
 * (`GET catalog/runs/:id/download`, `catalog.export.run`) while the run still names it (§5.4: 7 days, then 410 and
 * housekeeping removes it), with the expiry date. Both are plain same-origin links, so the browser downloads them with
 * the session cookie; the server audits each export download.
 *
 * A summary is read from the server and never trusted for its shape: each part is shown only when it has the shape
 * this screen knows, and every value is React text.
 */

/** The query key of one run (`GET catalog/runs/:id`). */
export const runKey = (id: string) => ['catalog', 'runs', 'detail', id] as const;

/** Every query of the runs (the lists and each run). */
export const RUNS_KEY = ['catalog', 'runs'] as const;

/** The admin page of a run. */
export const runHref = (id: string): string => `/admin/catalog/runs/${encodeURIComponent(id)}`;

/** The CSV report of a run. */
export const reportHref = (id: string): string => `/api/v1/catalog/runs/${encodeURIComponent(id)}/report`;

/** An export's file. */
export const downloadHref = (id: string): string => `/api/v1/catalog/runs/${encodeURIComponent(id)}/download`;

/** Whether the run still has work ahead. */
export const isRunActive = (status: RunStatus): boolean => status === 'queued' || status === 'running';

/**
 * The `Idempotency-Key` of a request that starts a run: the same key while the body stays the same (a retry after a
 * lost answer gets the stored answer back, instead of a second run or a refusal for a file the first one took), a
 * fresh one for another body. `clear()` once the run has started: the next start, even with the same body, is a new run.
 */
export function useRetryKey(prefix: string): { key(body: unknown): string; clear(): void } {
  const last = useRef<{ body: string; key: string } | null>(null);
  return {
    key(body: unknown): string {
      const text = JSON.stringify(body);
      if (last.current?.body !== text) {
        const random = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
        last.current = { body: text, key: `${prefix}:${random}` };
      }
      return last.current.key;
    },
    clear(): void {
      last.current = null;
    },
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** `summary` as an {@link ImportSummary}, or null when it does not have that shape. */
export function importSummaryOf(summary: unknown): ImportSummary | null {
  if (!isRecord(summary)) return null;
  const { read, created, updated, skipped, duplicates, itemsCreated, errors, warnings, sample } = summary;
  if (![read, created, updated, duplicates, itemsCreated, errors].every(isCount)) return null;
  if (!isRecord(skipped) || !Object.values(skipped).every(isCount)) return null;
  if (!Array.isArray(warnings) || !warnings.every((w) => typeof w === 'string')) return null;
  if (sample !== undefined && !Array.isArray(sample)) return null;
  return summary as unknown as ImportSummary;
}

/** `summary` as a {@link DedupeScanSummary}, or null when it does not have that shape. */
export function dedupeSummaryOf(summary: unknown): DedupeScanSummary | null {
  if (!isRecord(summary) || !isRecord(summary['groups']) || !isCount(summary['records']) || !Array.isArray(summary['preview'])) return null;
  const { isbn, title_year: titleYear } = summary['groups'];
  if (!isCount(isbn) || !isCount(titleYear)) return null;
  const preview = summary['preview'] as unknown[];
  const groupsOk = preview.every(
    (g) => isRecord(g) && (g['reason'] === 'isbn' || g['reason'] === 'title_year') && Array.isArray(g['recordIds']) && g['recordIds'].every((id) => typeof id === 'string'),
  );
  return groupsOk ? (summary as unknown as DedupeScanSummary) : null;
}

/** The label of a run's format (an import or an export format), or the raw value for one this build does not know. */
export function formatLabel(t: Translate, run: Pick<RunView, 'kind' | 'format'>): string | null {
  const f = run.format;
  if (f === null) return null;
  if (run.kind === 'export' && (EXPORT_FORMATS as readonly string[]).includes(f)) return t(vocabKey('export_format', f as (typeof EXPORT_FORMATS)[number]));
  if ((IMPORT_FORMATS as readonly string[]).includes(f)) return t(vocabKey('import_format', f as (typeof IMPORT_FORMATS)[number]));
  return f;
}

/** The status badge of a run. */
export function RunStatusBadge({ status }: { status: RunStatus }) {
  const t = useT();
  const tone = status === 'failed' ? 'danger' : status === 'running' ? 'warning' : status === 'succeeded' ? 'info' : 'neutral';
  return <Badge tone={tone}>{t(vocabKey('run_status', status))}</Badge>;
}

/** A label for a counter key: its own text where this screen has one, else the key itself. */
function counterLabel(t: Translate, key: string): string {
  const own = `catalog.exchange.summary.${key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}`;
  return isMessageKey(own) ? t(own) : key;
}

/** A reason code (skipped, report rows): its text where this screen has one, else the code. */
function reasonLabel(t: Translate, code: string): string {
  const own = `catalog.exchange.reason.${code}`;
  return isMessageKey(own) ? t(own) : code;
}

/** A reader warning: its text where this screen has one, else a sentence naming the code. */
function warningText(t: Translate, code: string): string {
  const own = `catalog.exchange.warning.${code}`;
  return isMessageKey(own) ? t(own) : t('catalog.exchange.warning.other', { code });
}

function Counts({ entries }: { entries: [label: string, value: number][] }) {
  const locale = useLocale();
  const number = new Intl.NumberFormat(locale === 'en' ? 'en-GB' : 'id-ID');
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3 lg:grid-cols-4">
      {entries.map(([label, value], i) => (
        <div key={i} className="flex flex-col rounded-md border px-3 py-2">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="text-lg font-semibold tabular-nums">{number.format(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

/** One sample draft as the table shows it, read defensively (the summary is the server's JSON). */
interface SampleRow {
  title: string;
  subtitle: string | null;
  author: string;
  year: string;
  identifiers: string;
  type: string | null;
  items: number;
}

function sampleRowOf(d: unknown): SampleRow | null {
  if (!isRecord(d) || typeof d['title'] !== 'string') return null;
  const text = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  const agents = Array.isArray(d['agents']) ? d['agents'].filter(isRecord) : [];
  const main = agents.find((a) => a['isMain'] === true) ?? agents[0];
  const identifiers = Array.isArray(d['identifiers']) ? d['identifiers'].filter(isRecord) : [];
  return {
    title: d['title'],
    subtitle: text(d['subtitle']),
    author: text(main?.['name']) ?? '',
    year: text(d['publicationYear']) ?? '',
    identifiers: identifiers
      .filter((i) => i['type'] === 'isbn' || i['type'] === 'issn')
      .map((i) => text(i['value']))
      .filter((v): v is string => v !== null)
      .join(', '),
    type: text(d['materialTypeCode']),
    items: Array.isArray(d['items']) ? d['items'].length : 0,
  };
}

/** The first mapped drafts of a dry run (§5.3: up to 20). */
function SampleTable({ rows }: { rows: SampleRow[] }) {
  const t = useT();
  return (
    <div className="grid gap-2">
      <h4 className="text-sm font-semibold">{t('catalog.exchange.summary.sample')}</h4>
      <p className="text-xs text-muted-foreground">{t('catalog.exchange.summary.sample_hint', { count: rows.length })}</p>
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <caption className="sr-only">{t('catalog.exchange.summary.sample')}</caption>
          <thead className="bg-muted/50 text-left">
            <tr>
              {(['title', 'author', 'year', 'identifiers', 'type', 'items'] as const).map((c) => (
                <th key={c} scope="col" className="px-3 py-2 font-medium whitespace-nowrap text-muted-foreground">
                  {t(`catalog.exchange.summary.col.${c}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t align-top">
                <td className="px-3 py-2">
                  <span className="font-medium">{r.title}</span>
                  {r.subtitle !== null && <span className="text-muted-foreground"> : {r.subtitle}</span>}
                </td>
                <td className="px-3 py-2">{r.author}</td>
                <td className="px-3 py-2 tabular-nums">{r.year}</td>
                <td className="px-3 py-2 tabular-nums">{r.identifiers}</td>
                <td className="px-3 py-2">{r.type ?? <span className="text-muted-foreground">{t('catalog.exchange.summary.type_default')}</span>}</td>
                <td className="px-3 py-2 tabular-nums">{r.items}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Warnings({ codes }: { codes: string[] }) {
  const t = useT();
  if (codes.length === 0) return null;
  return (
    <Alert className="border-warning-foreground/30 bg-warning text-warning-foreground">
      <TriangleAlertIcon aria-hidden="true" />
      <AlertDescription className="text-current">
        <p className="font-medium">{t('catalog.exchange.summary.warnings')}</p>
        <ul className="list-disc pl-5">
          {codes.map((code, i) => (
            <li key={i}>{warningText(t, code)}</li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

function ImportView({ summary, dryRun }: { summary: ImportSummary; dryRun: boolean }) {
  const t = useT();
  const locale = useLocale();
  const number = new Intl.NumberFormat(locale === 'en' ? 'en-GB' : 'id-ID');
  const reasons = Object.entries(summary.skipped).filter(([, n]) => n > 0);
  const skipped = reasons.reduce((sum, [, n]) => sum + n, 0);
  const sample = (summary.sample ?? []).map(sampleRowOf).filter((r): r is SampleRow => r !== null);
  return (
    <div className="grid gap-3">
      {dryRun && <p className="text-sm font-medium">{t('catalog.exchange.summary.dry_note')}</p>}
      <Warnings codes={summary.warnings} />
      <Counts
        entries={[
          [t('catalog.exchange.summary.read'), summary.read],
          [t('catalog.exchange.summary.created'), summary.created],
          [t('catalog.exchange.summary.updated'), summary.updated],
          [t('catalog.exchange.summary.skipped'), skipped],
          [t('catalog.exchange.summary.duplicates'), summary.duplicates],
          [t('catalog.exchange.summary.items_created'), summary.itemsCreated],
          [t('catalog.exchange.summary.errors'), summary.errors],
        ]}
      />
      {reasons.length > 0 && (
        <div className="grid gap-1 text-sm">
          <p className="font-medium">{t('catalog.exchange.summary.skipped_by')}</p>
          <ul className="list-disc pl-5">
            {reasons.map(([code, n]) => (
              <li key={code}>
                <span>{reasonLabel(t, code)}</span>
                <span className="tabular-nums">: {number.format(n)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {summary.errors > 0 && <p className="text-sm text-muted-foreground">{t('catalog.exchange.summary.errors_hint')}</p>}
      {sample.length > 0 && <SampleTable rows={sample} />}
    </div>
  );
}

/** Any other summary: its numeric counters, one level of nested counters (`skipped`) by reason. */
function GenericView({ summary }: { summary: Record<string, unknown> }) {
  const t = useT();
  const entries: [string, number][] = [];
  for (const [key, value] of Object.entries(summary)) {
    if (isCount(value)) entries.push([counterLabel(t, key), value]);
    else if (isRecord(value)) {
      for (const [sub, n] of Object.entries(value)) if (isCount(n)) entries.push([`${counterLabel(t, key)}: ${reasonLabel(t, sub)}`, n]);
    }
  }
  if (entries.length === 0) return null;
  return <Counts entries={entries} />;
}

/** The report and an export's file, with the file's expiry. */
function RunFiles({ run }: { run: RunView }) {
  const t = useT();
  const me = useMe();
  const dateTime = useDateTime();
  const links: ReactNode[] = [];
  if (run.reportFileId !== null) {
    links.push(
      <a key="report" href={reportHref(run.id)} download className={buttonVariants({ variant: 'outline', size: 'sm' })}>
        <FileTextIcon aria-hidden="true" />
        {t('catalog.exchange.file.report')}
      </a>,
    );
  }
  // The server says whether the file is still there (housekeeping clears `outputName` once it is gone); this browser's
  // clock is not asked, so a page left open simply meets the server's 410 after `expiresAt`.
  const exported = run.kind === 'export' && run.status === 'succeeded';
  const available = exported && run.outputName !== null;
  if (available && holds(me, 'catalog.export.run')) {
    links.push(
      <a key="download" href={downloadHref(run.id)} download className={buttonVariants({ size: 'sm' })}>
        <DownloadIcon aria-hidden="true" />
        {t('catalog.exchange.file.download')}
      </a>,
    );
  }
  const expiry =
    !exported || run.expiresAt === null
      ? null
      : available
        ? t('catalog.exchange.file.expires', { date: dateTime(run.expiresAt) })
        : t('catalog.exchange.file.expired', { date: dateTime(run.expiresAt) });
  if (links.length === 0 && expiry === null) return null;
  return (
    <div className="grid gap-2">
      {links.length > 0 && <div className="flex flex-wrap gap-2">{links}</div>}
      {expiry !== null && <p className="text-sm text-muted-foreground">{expiry}</p>}
    </div>
  );
}

/** A run's summary and files (see the top of this file). */
export function SummaryView({ run }: { run: RunView }) {
  const t = useT();
  let body: ReactNode = null;
  if (run.summary !== null) {
    const imported = run.kind === 'import' ? importSummaryOf(run.summary) : null;
    const scan = run.kind === 'dedupe_scan' ? dedupeSummaryOf(run.summary) : null;
    if (imported !== null) body = <ImportView summary={imported} dryRun={run.dryRun} />;
    else if (scan !== null) {
      body = (
        <Counts
          entries={[
            [t('catalog.exchange.summary.groups_isbn'), scan.groups.isbn],
            [t('catalog.exchange.summary.groups_title_year'), scan.groups.title_year],
            [t('catalog.exchange.summary.records'), scan.records],
          ]}
        />
      );
    } else body = <GenericView summary={run.summary} />;
  } else if (!isRunActive(run.status)) {
    body = <p className="text-sm text-muted-foreground">{t('catalog.exchange.summary.none')}</p>;
  }
  return (
    <div className="grid gap-3">
      {body}
      <RunFiles run={run} />
    </div>
  );
}
