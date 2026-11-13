import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations, withTx, type ReportRunsTable } from '@altis/db';
import { reportExportPath, reportWorkDir, reportWorkPath, type DataPath, type ReportFileExt } from '@altis/platform';
import { newId, type Locale, type ReportFormat } from '@altis/shared';
import { StoredRunParams } from '@altis/shared/api/reports';
import type { Selectable } from 'kysely';
import { openArchive } from '../../src/archive/zip-reader.js';
import type { CatalogJobDeps } from '../../src/catalog/jobs-deps.js';
import type { KeyringEntry } from '../../src/crypto/secret-box.js';
import { localStorageDriver } from '../../src/files/serve.js';
import { claimById } from '../../src/jobs/claim.js';
import { createJobRegistry } from '../../src/jobs/registry.js';
import { runSlice } from '../../src/jobs/slice.js';
import type { JobHandler, JobRegistry, SliceResult } from '../../src/jobs/types.js';
import { reportsExportJob } from '../../src/reports/export/job.js';
import { reportById } from '../../src/reports/registry.js';
import { startReportRun } from '../../src/reports/runs/index.js';
import type { ReportDefinition } from '../../src/reports/types.js';
import { createXmlReader, type XmlEvent } from '../../src/xml/index.js';
import { testDb, type TestDbHandle } from '../../../../tools/test/test-db.js';

// What the export job's tests share (reports-export-*.test.ts): a migrated database with a staff user who starts runs,
// a DATA_DIR of the file's own, the export job built over the registry and any test-local definitions, a run started
// the way the run routes start one and driven slice by slice through the queue's claim path, and readers for the
// three kinds of file it writes.

export const KEYRING: KeyringEntry[] = [{ kid: 'k1', key: randomBytes(32).toString('base64url'), active: true }];
const silent = { info() {}, warn() {}, error() {} };

/** The staff user who starts the runs; the PDF footers print this name. */
export const STAFF_NAME = 'Siti Pustakawan';

export interface ExportDb {
  h: TestDbHandle;
  root: string;
  dataDir: string;
  registry: JobRegistry;
  staffId: string;
  close(): Promise<void>;
}

/** A migrated database, a DATA_DIR and the export job over the registry plus `local` (test-local definitions). */
export async function openExportDb(prefix: string, local: readonly ReportDefinition[] = []): Promise<ExportDb> {
  const h = await testDb();
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), `altis-${prefix}-`)));
  const dataDir = path.join(root, 'data');
  await fsp.mkdir(path.join(dataDir, 'tmp'), { recursive: true });
  const now = Date.now();
  await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(root, 'migrations'), migrations: PHASE1_MIGRATIONS });
  const deps = (): CatalogJobDeps & { appVersion: string } => ({
    dataDir,
    baseUrl: 'https://perpus.example.sch.id',
    keyring: KEYRING,
    storage: localStorageDriver(dataDir),
    log: silent,
    appVersion: '0.1.0',
  });
  const lookup = (id: string): ReportDefinition | null => local.find((d) => d.id === id) ?? reportById(id);
  const registry = createJobRegistry([reportsExportJob(deps, { reportById: lookup }) as JobHandler<unknown>]);
  const staffId = newId(now);
  await h.db
    .insertInto('staff_users')
    .values({ id: staffId, username_key: 'siti', username_display: 'siti', name: STAFF_NAME, password_hash: 'x', status: 'active', created_at: now, updated_at: now })
    .execute();
  return {
    h,
    root,
    dataDir,
    registry,
    staffId,
    async close() {
      await h.close();
      await fsp.rm(root, { recursive: true, force: true });
    },
  };
}

/** Starts a run of `def` (a definition or a registry id) as the run routes do; its run and job ids. */
export async function startRun(
  db: ExportDb,
  def: ReportDefinition | string,
  o: { format: ReportFormat; params: Record<string, unknown>; locale?: Locale; pdf?: { paper: 'A4' | 'F4' } },
): Promise<{ id: string; jobId: string }> {
  const definition = typeof def === 'string' ? reportById(def) : def;
  if (definition === null) throw new Error(`no definition ${String(def)}`);
  const now = Date.now();
  return withTx(db.h, (trx) =>
    startReportRun(trx, definition, {
      format: o.format,
      params: o.params,
      locale: o.locale ?? 'id',
      createdBy: db.staffId,
      now,
      registry: db.registry,
      keyring: KEYRING,
      ...(o.pdf === undefined ? {} : { pdf: o.pdf }),
    }),
  );
}

/** Claims and runs job `jobId` slice by slice (`budgetMs` each) until it stops continuing; `afterSlice` runs between. */
export async function drive(
  db: ExportDb,
  jobId: string,
  o: { budgetMs?: number; maxSlices?: number; afterSlice?: (slice: number) => Promise<void> } = {},
): Promise<SliceResult['outcome'][]> {
  const outcomes: SliceResult['outcome'][] = [];
  for (let i = 1; i <= (o.maxSlices ?? 1000); i += 1) {
    const job = await claimById(db.h, db.registry, jobId, { worker: 'test', now: Date.now() });
    if (job === null) throw new Error(`job ${jobId} cannot be claimed`);
    const r = await runSlice(db.h, db.registry, job, {
      mode: 'worker',
      budgetMs: o.budgetMs ?? 20_000,
      keyring: KEYRING,
      log: silent,
      clock: () => Date.now(),
      env: {},
    });
    outcomes.push(r.outcome);
    if (r.outcome !== 'continued') return outcomes;
    await o.afterSlice?.(i);
  }
  return outcomes;
}

/** The run's row. */
export async function runRow(db: ExportDb, id: string): Promise<Selectable<ReportRunsTable>> {
  return db.h.db.selectFrom('report_runs').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
}

/** The run's stored parameters. */
export async function storedParams(db: ExportDb, id: string): Promise<StoredRunParams> {
  return StoredRunParams.parse(JSON.parse((await runRow(db, id)).params));
}

/** The job's row. */
export async function jobRow(db: ExportDb, jobId: string) {
  return db.h.db.selectFrom('jobs').select(['status', 'payload', 'progress_message']).where('id', '=', jobId).executeTakeFirstOrThrow();
}

export function exportPath(db: ExportDb, id: string, ext: ReportFileExt): DataPath {
  return reportExportPath(db.dataDir, id, ext);
}

export function workPath(db: ExportDb, id: string, name: string): DataPath {
  return reportWorkPath(db.dataDir, id, name);
}

/** True when the run's work folder exists. */
export async function workDirExists(db: ExportDb, id: string): Promise<boolean> {
  return fsp.stat(reportWorkDir(db.dataDir, id)).then(
    () => true,
    () => false,
  );
}

/** The names under `exports/reports/` (none when the folder does not exist). */
export async function exportNames(db: ExportDb): Promise<string[]> {
  return fsp.readdir(path.join(db.dataDir, 'exports', 'reports')).catch(() => []);
}

/** The cells of one CSV record line (every cell quoted, `""` inside). */
export function csvCells(line: string): string[] {
  return [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1]!.replace(/""/g, '"'));
}

/** The record lines of a CSV file without its BOM (CRLF line ends; no line break inside our cells). */
export function csvLines(bytes: Buffer): string[] {
  const text = bytes.toString('utf8').replace(/^\uFEFF/, '');
  const lines = text.split('\r\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

const XLSX_PART = /^(\[Content_Types\]\.xml|_rels\/\.rels|xl\/[a-z0-9_/]+\.xml(\.rels)?)$/;

/** The text of every part of an XLSX file, by name (our own reader; sheet XML compresses past the default ratio). */
export async function xlsxParts(p: DataPath): Promise<Map<string, string>> {
  const reader = await openArchive(p, { allow: XLSX_PART, maxRatio: 1000 });
  try {
    const out = new Map<string, string>();
    for (const e of reader.entries()) {
      const parts: Buffer[] = [];
      for await (const chunk of reader.read(e)) parts.push(Buffer.from(chunk));
      out.set(e.name, Buffer.concat(parts).toString('utf8'));
    }
    return out;
  } finally {
    await reader.close();
  }
}

export interface SheetCell {
  ref: string;
  /** `inlineStr` or `n` (a number: no `t` attribute). */
  type: 'inlineStr' | 'n';
  text: string;
}

/** The rows of `xl/worksheets/sheet1.xml`, each a list of its cells. */
export function sheetRows(xml: string): SheetCell[][] {
  const reader = createXmlReader();
  const events: XmlEvent[] = [...reader.write(xml), ...reader.end()];
  const rows: SheetCell[][] = [];
  let cell: SheetCell | null = null;
  let capture = false;
  for (const e of events) {
    if (e.type === 'open') {
      if (e.name === 'row') rows.push([]);
      if (e.name === 'c') cell = { ref: e.attrs['r'] ?? '', type: e.attrs['t'] === 'inlineStr' ? 'inlineStr' : 'n', text: '' };
      if (e.name === 't' || e.name === 'v') capture = true;
    } else if (e.type === 'close') {
      if (e.name === 't' || e.name === 'v') capture = false;
      if (e.name === 'c' && cell !== null) {
        rows.at(-1)!.push(cell);
        cell = null;
      }
    } else if (capture && cell !== null && e.type === 'text') {
      cell.text += e.text;
    }
  }
  return rows;
}

/** An accreditation period row (open), for the annexes' required `periodId`; its id. */
export async function insertPeriod(db: ExportDb, name: string): Promise<string> {
  const id = newId();
  const now = Date.now();
  await db.h.db
    .insertInto('accred_periods')
    .values({
      id,
      name,
      instrument_id: 'test-sch',
      kind: 'school_year',
      starts_on: '2025-07-01',
      ends_on: '2026-06-30',
      branch_id: null,
      profile: '{}',
      all_registered_confirmed: 0,
      status: 'open',
      frozen_at: null,
      frozen_by: null,
      archived_at: null,
      version: 1,
      created_at: now,
      created_by: null,
      updated_at: now,
      updated_by: null,
    })
    .execute();
  return id;
}
