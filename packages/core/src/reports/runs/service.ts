import type { DB } from '@altis/db';
import { DomainError, localDate, newId, type Locale, type ReportFormat } from '@altis/shared';
import { issueCode } from '@altis/shared/api/common';
import {
  REPORT_PDF_MAX_ROWS,
  REPORT_XLSX_MAX_ROWS,
  ReportPdfOptions,
  StoredRunParams,
  type ReportRunStarted,
} from '@altis/shared/api/reports';
import type { Kysely, Transaction } from 'kysely';
import type { z } from 'zod';
import type { KeyringEntry } from '../../crypto/secret-box.js';
import { enqueue } from '../../jobs/enqueue.js';
import type { JobRegistry } from '../../jobs/types.js';
import { loadAccredSettings, type AccredSettings } from '../../settings/accreditation.js';
import { readSettings } from '../../settings/service.js';
import type { ReportCtx, ReportDefinition } from '../types.js';

// The start of a report run (spec §4.15): the body's parameters are checked by the definition's own schema, the run
// row is written `queued` and its export job `reports.export` is queued in the caller's transaction. The generic run
// routes start table reports only; the accreditation documents start through their own routes with the same function.
//
// What a run stores (`report_runs.params`) is `{def, pdf?}`: the definition's values after its schema, and the paper of
// a PDF. Only `def` ever reaches the report code; the whole JSON is at most 8 000 bytes.
//
// The language of a run's file is the requester's UI language, except for an accreditation definition (the annexes and
// the documents), whose files are always Indonesian: such a run is stored with `locale 'id'` whatever the requester
// reads, so the stored language stays the language of the file.

/** The job that writes a run's file. */
export const REPORTS_EXPORT_JOB = 'reports.export';

/** The most rows an export of each format may have (CSV has no limit). */
const ROW_LIMITS: Readonly<Partial<Record<ReportFormat, number>>> = Object.freeze({ xlsx: REPORT_XLSX_MAX_ROWS, pdf: REPORT_PDF_MAX_ROWS });

/** How long a definition's count may take when a run starts. */
const COUNT_BUDGET_MS = 10_000;

/** One VALIDATION_FAILED for field errors `{path, code}`. */
export function reportFieldErrors(errors: readonly { path: string; code: string }[]): DomainError {
  return new DomainError('VALIDATION_FAILED', {
    detail: 'Data yang dikirim tidak valid / The submitted data is not valid',
    meta: { errors: errors.map((e) => ({ path: e.path, code: e.code })) },
  });
}

/** The issues of a Zod parse as field errors under `prefix` (`params.rows`; the prefix alone for a top-level issue). */
function issuesUnder(prefix: string, issues: readonly z.core.$ZodIssue[]): { path: string; code: string }[] {
  return issues.map((issue) => ({ path: [prefix, ...issue.path.map(String)].join('.'), code: issueCode(issue) }));
}

/**
 * `params` checked by `def`'s own schema: its output, the definition's stored values.
 *
 * @throws DomainError `VALIDATION_FAILED` with every issue at `params.<name>`
 */
export function parseDefParams(def: ReportDefinition, params: Record<string, unknown>): Record<string, unknown> {
  const parsed = def.paramsSchema.safeParse(params);
  if (!parsed.success) throw reportFieldErrors(issuesUnder('params', parsed.error.issues));
  return parsed.data;
}

/** The context a definition's functions run in, with a budget of `budgetMs` from now (a monotonic clock). */
export function reportCtx(
  db: Kysely<DB>,
  o: { locale: Locale; tz: string; now: number; settings: AccredSettings; params: Record<string, unknown>; budgetMs: number },
): ReportCtx {
  const deadline = performance.now() + o.budgetMs;
  return {
    db,
    locale: o.locale,
    tz: o.tz,
    now: o.now,
    today: localDate(o.tz, o.now),
    settings: o.settings,
    params: o.params,
    budgetLeftMs: () => Math.max(0, deadline - performance.now()),
  };
}

/** The library's time zone (`library.timezone`). */
export async function libraryTimeZone(db: Kysely<DB>): Promise<string> {
  return (await readSettings(db, ['library.timezone'], []))['library.timezone'] as string;
}

/**
 * Creates a run of `def` in `trx` (the caller audits it): checks the format against the definition's, the parameters
 * against its schema, the paper against its own schema and the size of what is stored; for a table definition that can
 * count its rows, refuses an export over its format's row limit before anything is written. Then writes the run
 * (`queued`, the definition's `personal`, the language of its file) and queues its export job (no unique key: two
 * exports of the same report are two runs).
 *
 * @throws DomainError `VALIDATION_FAILED` (`format`, `params.<name>`, `pdf.<name>`, or `params` `too_big` when the stored
 *   JSON would pass 8 000 bytes); `REPORT_TOO_LARGE` with `meta {rows, max, format}`
 */
export async function startReportRun(
  trx: Transaction<DB>,
  def: ReportDefinition,
  o: {
    format: ReportFormat;
    params: Record<string, unknown>;
    locale: Locale;
    createdBy: string;
    now: number;
    registry: JobRegistry;
    keyring: readonly KeyringEntry[];
    pdf?: { paper: 'A4' | 'F4' };
  },
): Promise<ReportRunStarted> {
  if (!(def.formats as readonly string[]).includes(o.format)) throw reportFieldErrors([{ path: 'format', code: 'invalid_value' }]);
  const params = parseDefParams(def, o.params);
  let pdf: ReportPdfOptions | undefined;
  if (o.pdf !== undefined) {
    const parsed = ReportPdfOptions.safeParse(o.pdf);
    if (!parsed.success) throw reportFieldErrors(issuesUnder('pdf', parsed.error.issues));
    pdf = parsed.data;
  }
  const stored = StoredRunParams.safeParse({ def: params, ...(pdf === undefined ? {} : { pdf }) });
  if (!stored.success) throw reportFieldErrors([{ path: 'params', code: 'too_big' }]);

  const max = ROW_LIMITS[o.format];
  if (def.kind === 'table' && def.count !== undefined && max !== undefined) {
    const ctx = reportCtx(trx, {
      locale: o.locale,
      tz: await libraryTimeZone(trx),
      now: o.now,
      settings: await loadAccredSettings(trx),
      params,
      budgetMs: COUNT_BUDGET_MS,
    });
    const rows = await def.count(ctx);
    if (rows !== null && rows > max) {
      throw new DomainError('REPORT_TOO_LARGE', {
        detail: `Laporan ini ${rows} baris; ${o.format.toUpperCase()} paling banyak ${max} baris / This report has ${rows} rows; a ${o.format.toUpperCase()} holds at most ${max}`,
        meta: { rows, max, format: o.format },
      });
    }
  }

  const id = newId(o.now);
  await trx
    .insertInto('report_runs')
    .values({
      id,
      report_id: def.id,
      format: o.format,
      locale: def.module === 'accreditation' ? 'id' : o.locale,
      params: JSON.stringify(stored.data),
      personal: def.personal ? 1 : 0,
      status: 'queued',
      row_count: null,
      non_latin_rows: null,
      output_name: null,
      output_size: null,
      error_code: null,
      job_id: null,
      expires_at: null,
      created_at: o.now,
      created_by: o.createdBy,
      finished_at: null,
    })
    .execute();
  const job = await enqueue(trx, o.registry, { type: REPORTS_EXPORT_JOB, payload: { runId: id }, createdBy: o.createdBy }, { now: o.now, keyring: o.keyring });
  await trx.updateTable('report_runs').set({ job_id: job.id }).where('id', '=', id).execute();
  return { id, jobId: job.id };
}
