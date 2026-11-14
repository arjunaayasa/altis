#!/usr/bin/env tsx
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { PHASE1_MIGRATIONS, connect, runMigrations, withTx, type DbConfig, type DbHandle } from '@altis/db';
import {
  claimById,
  closeJobSessions,
  createJobRegistry,
  enqueueEvaluate,
  evaluateJob,
  importSlimsUsageJob,
  loadAccredSettings,
  localStorageDriver,
  openArchive,
  previewReport,
  readSettings,
  reportById,
  reportsExportJob,
  retryDelayMs,
  runSlice,
  startDocumentRun,
  startReportRun,
  startSlimsUsageImport,
  type JobHandler,
  type JobRegistry,
  type KeyringEntry,
  type ReportJobDeps,
  type SliceResult,
} from '../../../packages/core/src/index.js';
import { dataPath, reportExportPath } from '../../../packages/platform/src/index.js';
import { REPORT_PDF_MAX_ROWS, REPORT_SCAN_PREVIEW_MAX_RECORDS, REPORT_XLSX_MAX_ROWS } from '../../../packages/shared/src/api/reports.js';
import { addDays, isDomainError, newId } from '../../../packages/shared/src/index.js';
import { p95 } from '../../release/perf/measure.js';
import { SmokeError, messageOf, provisionDb } from '../../release/smoke/run.js';
import { TEST_ENGINES, type TestEngine } from '../test-db.js';
import { PERF_PHASE2_SEED } from '../perf-phase2/seed.js';
import { PERF_KOMUNITAS_SEED, PERF_MEMBER_TYPES, jakartaDate, komunitasCounts, seedExtraItems, seedKomunitas, seedUnclassified } from './seed.js';
import { USAGE_DUMP_ROWS, writeUsageDump } from './usage-dump.js';

// The measurement of the community roadmap's performance budgets for the reports and the accreditation workspace:
//
//   pnpm perf:komunitas [--mode reports,accred,migrate] [--scale <0..1>] [--db sqlite|mariadb106|…] [--with-evidence]
//                       [--repeat <n>] [--keep] [--assert]
//
// Each mode runs on a fresh database of its own (SQLite in a temp DATA_DIR, or a database `altis_smoke_k1…` on the
// tools/test/compose.yml engine `--db` names), migrated by the code of this tree and seeded by seed.ts
// (seedKomunitas: the Phase 2 perf catalogue, 100 000 records and 150 000 items at scale 1, and a school library's
// accreditation period with its registers and 36 months of usage; the migrate mode leaves the catalogue out). The code
// measured is the domain code itself, in a child process of this runner (the same file, `--child`): the report
// preview as `POST reports/:id/preview` calls it, and every export, evaluation and import as the job runtime runs it,
// one claim and one slice of 20 seconds after another. The runner samples the child's RSS every second (`ps`), and
// SIGKILLs it where a mode says so.
//
// - reports: the first page of every collection report, 20 times each (`--repeat`), with its default parameters and
//   with its heaviest preview parameters (the acquisitions over all years; the summary and the DDC recap a year ago;
//   the title and copy lists of a past day): p95 < 1 500 ms, whether the answer is rows or the immediate 422
//   `export_only` of a scan-based report above REPORT_SCAN_PREVIEW_MAX_RECORDS live records; first on a catalogue
//   whose titles are all classified, then the summary, the DDC recap and the data-quality list again once one title in
//   20 has lost its classification (a call number of letters only, as migrated catalogues hold). When the catalogue is
//   above that limit, the scan-based cases are measured again on a catalogue of that many records (the threshold:
//   the slowest scan a preview still runs). Then the exports: XLSX of the title list (100 000 rows at scale 1) and PDF
//   of its class-1 titles (10 000 rows): every slice and the last one ≤ 20 s; then copies are added up to 1 000 000
//   (at scale 1) and the copy list is exported as CSV: ≤ 15 minutes, every slice ≤ 20 s.
// - accred: the evaluation of every indicator of the period (≤ 3 minutes, slices ≤ 20 s); the evidence file PDF
//   (≤ 60 s); the evidence ZIP (slices ≤ 20 s; 500 MiB over 2 000 files with `--with-evidence` at scale 1), run once
//   straight through and once SIGKILLed in the middle of a slice and resumed (the lease taken over as the job runtime
//   would once it expired): the resumed ZIP must read back whole (every entry against its CRC-32), with the entries
//   of the straight run and the same bytes for every uploaded file.
// - migrate: the read-only SLiMS usage import of a dump (usage-dump.ts: 1 000 000 `loan_history` and 1 000 000
//   `visitor_count` rows at scale 1): ≤ 30 minutes, slices ≤ 20 s.
// - every mode: the highest RSS of its children < 300 MB, beside the RSS of a child that only loads and connects (the
//   measuring process's own weight, the TypeScript loader included, which a release build does not carry).
//
// Output: the table of measurements on stderr, one JSON line (formatKomunitasReport) on stdout. Exit 0, or 1 when a
// mode failed to run or, with `--assert`, a budget is missed (the table names it); 2 for a usage error. Without
// `--assert` the budgets are only reported: a smoke run at a small scale (`--scale 0.02`) checks that every
// measurement runs. The budgets are set for the reference runner (Linux x64, 2 vCPU, 7 GB, Node 22.16) at scale 1, on
// SQLite and MariaDB 10.6; the LVE profile (1 core, 1 GB, 1 MB/s) is set up outside this runner.

// ---------------------------------------------------------------------------------------------------------------------
// Budgets, cases and judging (pure)

export const KOMUNITAS_MODES = ['reports', 'accred', 'migrate'] as const;
export type KomunitasMode = (typeof KOMUNITAS_MODES)[number];

/** The budgets (ms and MB). */
export const KOMUNITAS_BUDGETS = Object.freeze({
  previewP95Ms: 1_500,
  sliceMs: 20_000,
  csvMs: 15 * 60_000,
  evaluateMs: 3 * 60_000,
  dossierPdfMs: 60_000,
  usageImportMs: 30 * 60_000,
  rssMb: 300,
});

/** The rows of the CSV export at scale 1 (the copies are topped up to this many). */
export const CSV_ROWS = 1_000_000;

/** One line of the table. `budget` null: reported only; `check`: 1 passes, 0 fails. */
export interface Measurement {
  mode: KomunitasMode;
  name: string;
  value: number | null;
  unit: 'ms' | 'MB' | 'rows' | 'entries' | 'bytes' | 'check';
  budget: number | null;
  /** How the value meets the budget: strictly below, at most, or (checks) equal. */
  op: '<' | '<=' | '=';
  detail?: string;
}

/** The measurements that miss their budget, as sentences (a budgeted value never measured misses it). */
export function judgeKomunitas(rows: readonly Measurement[]): string[] {
  const failures: string[] = [];
  for (const m of rows) {
    if (m.budget === null) continue;
    const what = `${m.mode}: ${m.name}`;
    if (m.value === null) failures.push(`${what}: not measured${m.detail === undefined ? '' : ` (${m.detail})`}`);
    else if (m.op === '<' && !(m.value < m.budget)) failures.push(`${what} ${m.value} ${m.unit} is over the budget (< ${m.budget} ${m.unit})`);
    else if (m.op === '<=' && !(m.value <= m.budget)) failures.push(`${what} ${m.value} ${m.unit} is over the budget (≤ ${m.budget} ${m.unit})`);
    else if (m.op === '=' && m.value !== m.budget) failures.push(`${what} failed${m.detail === undefined ? '' : `: ${m.detail}`}`);
  }
  return failures;
}

/** The table of measurements, one line each, aligned. */
export function formatTable(rows: readonly Measurement[]): string {
  const cells = rows.map((m) => {
    const budget = m.budget === null ? '—' : m.unit === 'check' ? 'pass' : `${m.op === '<' ? '<' : '≤'} ${m.budget}`;
    const value = m.value === null ? 'n/a' : m.unit === 'check' ? (m.value === 1 ? 'pass' : 'FAIL') : String(m.value);
    const ok = m.budget === null ? '' : judgeKomunitas([m]).length === 0 ? 'ok' : 'MISS';
    return [m.mode, m.name, value, m.unit === 'check' ? '' : m.unit, budget, ok, m.detail ?? ''];
  });
  const head = ['mode', 'measurement', 'value', 'unit', 'budget', '', 'detail'];
  const widths = head.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i]!.length)));
  const line = (c: readonly string[]): string => c.map((x, i) => (i === c.length - 1 ? x : x.padEnd(widths[i]!))).join('  ').trimEnd();
  return [line(head), line(widths.map((w) => '-'.repeat(w))), ...cells.map(line)].join('\n');
}

/** A preview to measure: a collection report with parameters. */
export interface PreviewCase {
  reportId: string;
  /** `default`, or what makes the parameters the heaviest. */
  label: string;
  params: Record<string, unknown>;
  /** The parameters make the report scan the stock. */
  scan: boolean;
}

/**
 * Every collection report with its default parameters (what the screen sends first: none), and the scan-based ones
 * also with their heaviest preview parameters: the acquisitions over all years, the summary and the DDC recap a year
 * before `today`, the title and copy lists of that past day.
 */
export function previewCases(today: string): PreviewCase[] {
  const yearAgo = addDays(today, -365);
  const year = Number(today.slice(0, 4));
  const d = (reportId: string, scan = false): PreviewCase => ({ reportId, label: 'default', params: {}, scan });
  return [
    d('collection.summary'),
    { reportId: 'collection.summary', label: `asOf ${yearAgo}`, params: { asOf: yearAgo }, scan: true },
    d('collection.ddc_recap'),
    { reportId: 'collection.ddc_recap', label: `asOf ${yearAgo}`, params: { asOf: yearAgo }, scan: true },
    d('collection.acquisitions', true),
    { reportId: 'collection.acquisitions', label: `years 1900-${year}`, params: { yearFrom: 1900, yearTo: year }, scan: true },
    d('collection.title_list'),
    { reportId: 'collection.title_list', label: `asOf ${yearAgo}`, params: { asOf: yearAgo }, scan: true },
    d('collection.item_list'),
    { reportId: 'collection.item_list', label: `asOf ${yearAgo}`, params: { asOf: yearAgo }, scan: true },
    d('collection.accession_register'),
    d('collection.data_quality'),
    d('collection.attachment_downloads'),
  ];
}

/** The scale of a catalogue of `records` records (perfCounts(scale).records = records). */
export function scaleOfRecords(records: number): number {
  return records / PERF_PHASE2_SEED.records;
}

// ---------------------------------------------------------------------------------------------------------------------
// The command line

export interface RunOptions {
  modes: KomunitasMode[];
  scale: number;
  db: TestEngine;
  withEvidence: boolean;
  /** Preview requests per case. */
  repeat: number;
  keep: boolean;
  assert: boolean;
}

/** The largest --scale (the seed the budgets are set for). */
export const SCALE_MAX = 1;
/** The most preview requests per case. */
export const REPEAT_MAX = 1_000;

export const USAGE = 'usage: pnpm perf:komunitas [--mode reports,accred,migrate] [--scale <0..1>] [--db <engine>] [--with-evidence] [--repeat <n>] [--keep] [--assert]';

/** @throws Error `USAGE: …` */
export function parseRunArgs(argv: readonly string[]): RunOptions {
  const args = argv[0] === '--' ? argv.slice(1) : [...argv];
  let v: { mode?: string; scale?: string; db?: string; 'with-evidence'?: boolean; repeat?: string; keep?: boolean; assert?: boolean };
  try {
    v = parseArgs({
      args,
      strict: true,
      allowPositionals: false,
      options: {
        mode: { type: 'string' },
        scale: { type: 'string' },
        db: { type: 'string' },
        'with-evidence': { type: 'boolean' },
        repeat: { type: 'string' },
        keep: { type: 'boolean' },
        assert: { type: 'boolean' },
      },
    }).values;
  } catch (error) {
    throw new Error(`USAGE: ${messageOf(error)}`, { cause: error });
  }
  const asked = (v.mode ?? KOMUNITAS_MODES.join(',')).split(',').map((m) => m.trim());
  for (const m of asked) if (!(KOMUNITAS_MODES as readonly string[]).includes(m)) throw new Error(`USAGE: --mode takes ${KOMUNITAS_MODES.join(', ')} (comma-separated), not ${JSON.stringify(m)}`);
  const scale = v.scale === undefined ? 1 : Number(v.scale);
  if (!Number.isFinite(scale) || scale <= 0 || scale > SCALE_MAX) throw new Error(`USAGE: --scale must be a number above 0 and at most ${SCALE_MAX}`);
  const db = v.db ?? 'sqlite';
  if (!(TEST_ENGINES as readonly string[]).includes(db)) throw new Error(`USAGE: --db must be one of ${TEST_ENGINES.join(', ')}`);
  const repeat = v.repeat === undefined ? 20 : Number(v.repeat);
  if (!Number.isSafeInteger(repeat) || repeat < 1 || repeat > REPEAT_MAX) throw new Error(`USAGE: --repeat must be an integer from 1 to ${REPEAT_MAX}`);
  return {
    modes: KOMUNITAS_MODES.filter((m) => asked.includes(m)),
    scale,
    db: db as TestEngine,
    withEvidence: v['with-evidence'] === true,
    repeat,
    keep: v.keep === true,
    assert: v.assert === true,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// What the runner and its children share

const say = (line: string): void => void process.stderr.write(`perf-komunitas: ${line}\n`);
const RUN_FILE = fileURLToPath(import.meta.url);
const APP_VERSION = '0.1.0';
const BASE_URL = 'https://perpus.sma-perf.sch.id';
const IS_WINDOWS = process.platform === 'win32';
/** How often the runner samples a child's RSS. */
const RSS_SAMPLE_MS = 1_000;
/** The longest a child may run. */
const CHILD_TIMEOUT_MS = 3 * 3_600_000;

/** What a child is told: where the database and DATA_DIR are, and its task. */
interface ChildInput {
  db: DbConfig;
  dataDir: string;
  keyring: KeyringEntry[];
  task: ChildTask;
}

type ChildTask =
  /** Loads, connects and waits: the RSS of the measuring process itself (the TypeScript loader and the modules). */
  | { kind: 'idle'; ms: number }
  | { kind: 'previews'; cases: PreviewCase[]; repeat: number }
  /** Runs job `jobId` slice by slice to its end; `reclaim` takes over the lease of a dead worker first. */
  | { kind: 'drive'; jobId: string; budgetMs: number; reclaim: boolean };

/** What a child prints, one JSON object per line. */
type ChildEvent =
  | { event: 'preview'; reportId: string; label: string; ms: number[]; rows: number; exportOnly: number; errors: number; firstError: string | null; lastRows: number }
  | { event: 'slice-start'; n: number; at: number }
  /** `heapMb`, `buffersMb`: the child's JavaScript heap and its array buffers (Node's Buffers) right after the slice. */
  | { event: 'slice'; n: number; at: number; ms: number; outcome: SliceResult['outcome']; error?: string; heapMb: number; buffersMb: number }
  | { event: 'end'; status: string; slices: number };

const silentLog = {
  info() {},
  warn(message: string, fields?: Record<string, unknown>) {
    process.stderr.write(`perf-komunitas child: warn ${message} ${JSON.stringify(fields ?? {})}\n`);
  },
  error(message: string, fields?: Record<string, unknown>) {
    process.stderr.write(`perf-komunitas child: error ${message} ${JSON.stringify(fields ?? {})}\n`);
  },
};

/** The community job handlers over DATA_DIR `dataDir` (the server's komunitasJobHandlers, with the runner's facts). */
function jobRegistry(dataDir: string, keyring: readonly KeyringEntry[]): JobRegistry {
  const deps = (): ReportJobDeps => ({ dataDir, baseUrl: BASE_URL, keyring, storage: localStorageDriver(dataDir), log: silentLog, appVersion: APP_VERSION });
  return createJobRegistry([reportsExportJob(deps), evaluateJob(deps), importSlimsUsageJob(deps)] as JobHandler<unknown>[]);
}

const openDb = (db: DbConfig, dataDir: string): Promise<DbHandle> => connect(db, { runtime: 'standalone', purpose: 'cli', dataDir });

// ---------------------------------------------------------------------------------------------------------------------
// The child (`run.ts --child <file>`)

function emit(e: ChildEvent): void {
  process.stdout.write(`${JSON.stringify(e)}\n`);
}

const TERMINAL = new Set(['succeeded', 'failed', 'dead', 'cancelled']);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function childPreviews(h: DbHandle, task: Extract<ChildTask, { kind: 'previews' }>): Promise<void> {
  for (const c of task.cases) {
    const def = reportById(c.reportId);
    if (def === null || def.kind !== 'table') throw new Error(`no table report ${c.reportId}`);
    const out = { event: 'preview' as const, reportId: c.reportId, label: c.label, ms: [] as number[], rows: 0, exportOnly: 0, errors: 0, firstError: null as string | null, lastRows: 0 };
    for (let i = 0; i < task.repeat; i += 1) {
      const t = performance.now();
      try {
        // What the preview route does per request: the library's time zone and accreditation settings, then the page.
        const tz = (await readSettings(h.db, ['library.timezone'], []))['library.timezone'] as string;
        const page = await previewReport(h.db, def, { params: c.params, limit: 50 }, { locale: 'id', tz, now: Date.now(), settings: await loadAccredSettings(h.db) });
        out.rows += 1;
        out.lastRows = page.rows.length;
      } catch (error) {
        const errors = isDomainError(error) ? (error.meta as { errors?: { code?: string }[] } | undefined)?.errors : undefined;
        if (errors?.some((e) => e.code === 'export_only') === true) out.exportOnly += 1;
        else {
          out.errors += 1;
          out.firstError ??= messageOf(error);
        }
      }
      out.ms.push(Math.round((performance.now() - t) * 10) / 10);
    }
    emit(out);
  }
}

async function childDrive(h: DbHandle, reg: JobRegistry, keyring: readonly KeyringEntry[], task: Extract<ChildTask, { kind: 'drive' }>): Promise<void> {
  let n = 0;
  let reclaim = task.reclaim;
  let idle = 0;
  for (;;) {
    const row = await h.db.selectFrom('jobs').select(['status', 'run_at', 'attempts', 'locked_until']).where('id', '=', task.jobId).executeTakeFirst();
    if (row === undefined) return emit({ event: 'end', status: 'gone', slices: n });
    if (TERMINAL.has(row.status)) return emit({ event: 'end', status: row.status, slices: n });
    let now = Date.now();
    // The lease of a killed worker: taken over as the runtime would once it expired and its backoff passed.
    if (row.status === 'running' && reclaim) now = Math.max(now, Number(row.locked_until) + retryDelayMs(Number(row.attempts)) + 1_000);
    if (row.status === 'queued' && Number(row.run_at) > now) {
      const wait = Number(row.run_at) - now;
      if (wait > 5 * 60_000) return emit({ event: 'end', status: `queued until ${new Date(Number(row.run_at)).toISOString()}`, slices: n });
      await sleep(wait + 10);
      continue;
    }
    const job = await claimById(h, reg, task.jobId, { worker: `perf-komunitas:${process.pid}`, now });
    if (job === null) {
      // A running job of another worker (none here) or a claim race: look again shortly, but not for ever.
      if ((idle += 1) > 600) return emit({ event: 'end', status: `not claimable (${row.status})`, slices: n });
      await sleep(100);
      continue;
    }
    idle = 0;
    reclaim = false;
    n += 1;
    const at = performance.now();
    emit({ event: 'slice-start', n, at: Math.round(at) });
    const r = await runSlice(h, reg, job, { mode: 'worker', budgetMs: task.budgetMs, keyring, log: silentLog, clock: () => Date.now(), env: {} });
    const ms = Math.round(performance.now() - at);
    const mem = process.memoryUsage();
    const mb = (bytes: number): number => Math.round((bytes / 1_048_576) * 10) / 10;
    emit({ event: 'slice', n, at: Math.round(at), ms, outcome: r.outcome, ...(r.error === undefined ? {} : { error: r.error }), heapMb: mb(mem.heapUsed), buffersMb: mb(mem.arrayBuffers) });
  }
}

async function childMain(file: string): Promise<void> {
  const input = JSON.parse(await fsp.readFile(file, 'utf8')) as ChildInput;
  const h = await openDb(input.db, input.dataDir);
  try {
    if (input.task.kind === 'idle') {
      await sleep(input.task.ms);
      emit({ event: 'end', status: 'idle', slices: 0 });
    } else if (input.task.kind === 'previews') await childPreviews(h, input.task);
    else await childDrive(h, jobRegistry(input.dataDir, input.keyring), input.keyring, input.task);
  } finally {
    await closeJobSessions();
    await h.close();
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The runner

/** One mode's install: a database with the code's schema, a DATA_DIR, the keyring and the job handlers. */
interface Install {
  root: string;
  dataDir: string;
  db: DbConfig;
  h: DbHandle;
  keyring: KeyringEntry[];
  registry: JobRegistry;
}

let childCount = 0;

async function install(o: RunOptions, label: string, cleanups: (() => Promise<void>)[]): Promise<Install> {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), `altis-perf-komunitas-${label}-`)));
  if (o.keep) say(`keeping ${root} (--keep)`);
  else cleanups.push(() => fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const dataDir = path.join(root, 'data');
  await fsp.mkdir(path.join(dataDir, 'tmp'), { recursive: true, mode: 0o700 });
  const db = await provisionDb(o.db, `k1${label}_${randomBytes(4).toString('hex')}`, (drop) => void (o.keep ? undefined : cleanups.push(drop)));
  const h = await openDb(db, dataDir);
  cleanups.push(() => h.close());
  await runMigrations(h, { appVersion: APP_VERSION, dataDir, migrations: PHASE1_MIGRATIONS });
  const keyring: KeyringEntry[] = [{ kid: 'k1', key: randomBytes(32).toString('base64url'), active: true }];
  return { root, dataDir, db, h, keyring, registry: jobRegistry(dataDir, keyring) };
}

/** The RSS (MB) of process `pid`, or null (Windows, or gone). */
function rssOf(pid: number): Promise<number | null> {
  if (IS_WINDOWS) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'rss=', '-p', String(pid)], { timeout: 5_000 }, (error, stdout) => {
      const kib = Number(String(stdout).trim());
      resolve(error !== null || !Number.isFinite(kib) || kib <= 0 ? null : Math.round((kib / 1024) * 10) / 10);
    });
  });
}

interface ChildRun {
  code: number | null;
  signal: NodeJS.Signals | null;
  events: ChildEvent[];
  /** The highest RSS sampled, MB (null on Windows or without a sample). */
  rssPeakMb: number | null;
  stderrTail: string;
}

/**
 * Runs `task` in a child process (this file with `--child`, under the same loader), sampling its RSS every second;
 * `onEvent` sees each event as it comes and may kill the child.
 */
async function runChild(inst: Install, task: ChildTask, onEvent?: (e: ChildEvent, kill: () => void) => void): Promise<ChildRun> {
  childCount += 1;
  const file = path.join(inst.root, `child-${childCount}.json`);
  const input: ChildInput = { db: inst.db, dataDir: inst.dataDir, keyring: inst.keyring, task };
  await fsp.writeFile(file, JSON.stringify(input), { mode: 0o600 });
  const child = spawn(process.execPath, [...process.execArgv, RUN_FILE, '--child', file], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  const events: ChildEvent[] = [];
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-8_000);
    process.stderr.write(chunk);
  });
  const kill = (): void => void child.kill('SIGKILL');
  const lines = readline.createInterface({ input: child.stdout });
  const linesClosed = new Promise<void>((resolve) => lines.once('close', () => resolve()));
  lines.on('line', (line) => {
    if (!line.startsWith('{')) return;
    try {
      const e = JSON.parse(line) as ChildEvent;
      events.push(e);
      onEvent?.(e, kill);
    } catch {
      // not an event
    }
  });
  let peak: number | null = null;
  let running = true;
  const sample = async (): Promise<void> => {
    if (child.pid === undefined) return;
    const rss = await rssOf(child.pid);
    if (rss !== null && running) peak = Math.max(peak ?? 0, rss);
  };
  // Besides every second: at the end of each slice and at the child's end, while it still runs.
  lines.on('line', (line) => {
    if (line.startsWith('{"event":"slice"') || line.startsWith('{"event":"end"') || line.startsWith('{"event":"preview"')) void sample();
  });
  const sampling = (async () => {
    // The first sample a second in: a process just spawned has not loaded anything yet.
    await sleep(RSS_SAMPLE_MS);
    while (running) {
      await sample();
      await sleep(RSS_SAMPLE_MS);
    }
  })();
  const timer = setTimeout(kill, CHILD_TIMEOUT_MS);
  const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => child.once('exit', (c, s) => resolve([c, s])));
  clearTimeout(timer);
  running = false;
  await sampling;
  await linesClosed;
  await fsp.rm(file, { force: true });
  return { code, signal, events, rssPeakMb: peak, stderrTail: stderr.slice(-2_000) };
}

/** The slices of a driven job, its end status, and its time from the first slice's start to the last one's end. */
interface Driven {
  status: string;
  slices: { n: number; ms: number; outcome: string; error?: string }[];
  totalMs: number | null;
  maxSliceMs: number | null;
  lastSliceMs: number | null;
  rssPeakMb: number | null;
  /** The highest JavaScript heap and array-buffer sizes the child reported after a slice (MB). */
  heapPeakMb: number | null;
  buffersPeakMb: number | null;
}

function driven(run: ChildRun): Driven {
  const reported = run.events.flatMap((e) => (e.event === 'slice' ? [e] : []));
  const peakOf = (values: number[]): number | null => (values.length === 0 ? null : Math.max(...values));
  const slices = run.events.flatMap((e) => (e.event === 'slice' ? [{ n: e.n, at: e.at, ms: e.ms, outcome: e.outcome, ...(e.error === undefined ? {} : { error: e.error }) }] : []));
  const end = run.events.find((e) => e.event === 'end');
  const status = end?.event === 'end' ? end.status : run.signal !== null ? `killed (${run.signal})` : `exit ${String(run.code)}`;
  const first = slices[0];
  const last = slices[slices.length - 1];
  return {
    status,
    slices: slices.map((s) => ({ n: s.n, ms: s.ms, outcome: s.outcome, ...(s.error === undefined ? {} : { error: s.error }) })),
    totalMs: first === undefined || last === undefined ? null : last.at + last.ms - first.at,
    maxSliceMs: slices.length === 0 ? null : Math.max(...slices.map((s) => s.ms)),
    lastSliceMs: last?.ms ?? null,
    rssPeakMb: run.rssPeakMb,
    heapPeakMb: peakOf(reported.map((e) => e.heapMb)),
    buffersPeakMb: peakOf(reported.map((e) => e.buffersMb)),
  };
}

/** Runs job `jobId` to its end in a child (slices of 20 s). */
async function drive(inst: Install, jobId: string, onEvent?: (e: ChildEvent, kill: () => void) => void, o: { reclaim?: boolean } = {}): Promise<{ run: ChildRun; d: Driven }> {
  const run = await runChild(inst, { kind: 'drive', jobId, budgetMs: 20_000, reclaim: o.reclaim === true }, onEvent);
  return { run, d: driven(run) };
}

const round1 = (v: number | null): number | null => (v === null ? null : Math.round(v * 10) / 10);

/** The run row's end. */
async function runRow(inst: Install, id: string) {
  return inst.h.db.selectFrom('report_runs').select(['status', 'row_count', 'output_size', 'error_code', 'params']).where('id', '=', id).executeTakeFirstOrThrow();
}

class ModeContext {
  readonly rows: Measurement[] = [];
  rssPeak: number | null = null;
  constructor(readonly mode: KomunitasMode) {}

  add(m: Omit<Measurement, 'mode'>): void {
    this.rows.push({ mode: this.mode, ...m });
  }

  rss(mb: number | null): void {
    if (mb !== null) this.rssPeak = Math.max(this.rssPeak ?? 0, mb);
  }

  /** The measurements of a driven export or job: its time, its slices, its end. */
  addDriven(name: string, d: Driven, o: { totalBudget: number | null; lastSlice?: boolean }): void {
    const failed = d.status !== 'succeeded';
    const error = d.slices.find((s) => s.error !== undefined)?.error;
    const memory = `RSS ${d.rssPeakMb === null ? 'n/a' : `${d.rssPeakMb} MB`} (heap ${String(d.heapPeakMb)} MB, buffers ${String(d.buffersPeakMb)} MB)`;
    const detail = `${d.slices.length} slices, ${d.status}${error === undefined ? '' : `, ${error}`}, ${memory}`;
    this.add({ name: `${name} total`, value: failed ? null : d.totalMs, unit: 'ms', budget: o.totalBudget, op: '<=', detail });
    this.add({ name: `${name} longest slice`, value: d.maxSliceMs, unit: 'ms', budget: KOMUNITAS_BUDGETS.sliceMs, op: '<=' });
    if (o.lastSlice === true) this.add({ name: `${name} final slice`, value: d.lastSliceMs, unit: 'ms', budget: KOMUNITAS_BUDGETS.sliceMs, op: '<=' });
    this.add({ name: `${name} succeeded`, value: failed ? 0 : 1, unit: 'check', budget: 1, op: '=', ...(failed ? { detail: d.status } : {}) });
    this.rss(d.rssPeakMb);
  }

  finishRss(): void {
    this.add({ name: 'RSS of the children (peak)', value: this.rssPeak, unit: 'MB', budget: KOMUNITAS_BUDGETS.rssMb, op: '<', ...(this.rssPeak === null ? { detail: 'not sampled' } : {}) });
  }
}

/**
 * The RSS of a child that only loads and connects: what the measuring process weighs before any work (the TypeScript
 * loader included, which a release build does not carry), reported beside the peaks.
 */
async function measureBaseline(ctx: ModeContext, inst: Install): Promise<void> {
  const run = await runChild(inst, { kind: 'idle', ms: 2_500 });
  ctx.add({ name: 'RSS of an idle child (baseline)', value: run.rssPeakMb, unit: 'MB', budget: null, op: '<' });
}

/** The preview measurements of `cases` on `inst`, as `prefix` (`preview` or `preview@<n>`). */
async function measurePreviews(ctx: ModeContext, inst: Install, cases: PreviewCase[], repeat: number, prefix: string): Promise<void> {
  const run = await runChild(inst, { kind: 'previews', cases, repeat });
  ctx.rss(run.rssPeakMb);
  if (run.code !== 0) throw new SmokeError(`the preview child ended ${run.signal ?? `with exit code ${String(run.code)}`}: ${run.stderrTail}`);
  ctx.add({ name: `${prefix} child RSS (peak)`, value: run.rssPeakMb, unit: 'MB', budget: null, op: '<' });
  for (const e of run.events) {
    if (e.event !== 'preview') continue;
    const answer = e.errors > 0 ? `${e.errors} errors (${e.firstError ?? ''})` : e.exportOnly === e.ms.length ? '422 export_only' : e.exportOnly > 0 ? `rows, ${e.exportOnly} × export_only` : `rows (${e.lastRows} on the page)`;
    ctx.add({ name: `${prefix} ${e.reportId} ${e.label} p95`, value: e.errors > 0 ? null : round1(p95(e.ms)), unit: 'ms', budget: KOMUNITAS_BUDGETS.previewP95Ms, op: '<', detail: answer });
  }
}

/** Starts a report run of `reportId` as the run route does (as the seeded staff member, in Indonesian). */
async function startExport(inst: Install, staffId: string, reportId: string, format: 'csv' | 'xlsx' | 'pdf', params: Record<string, unknown>): Promise<{ id: string; jobId: string }> {
  const def = reportById(reportId);
  if (def === null) throw new Error(`no report ${reportId}`);
  return withTx(inst.h, (trx) => startReportRun(trx, def, { format, params, locale: 'id', createdBy: staffId, now: Date.now(), registry: inst.registry, keyring: inst.keyring }));
}

async function measureExport(ctx: ModeContext, inst: Install, staffId: string, name: string, reportId: string, format: 'csv' | 'xlsx' | 'pdf', params: Record<string, unknown>, totalBudget: number | null): Promise<void> {
  say(`${ctx.mode}: ${name}…`);
  const started = await startExport(inst, staffId, reportId, format, params);
  const { d } = await drive(inst, started.jobId);
  const row = await runRow(inst, started.id);
  ctx.addDriven(name, { ...d, status: d.status === 'succeeded' && row.status !== 'succeeded' ? `run ${row.status} ${row.error_code ?? ''}` : d.status }, { totalBudget, lastSlice: true });
  ctx.add({ name: `${name} rows`, value: row.row_count === null ? null : Number(row.row_count), unit: 'rows', budget: null, op: '<=' });
  say(`${ctx.mode}: ${name}: ${String(d.totalMs)} ms over ${d.slices.length} slices (${row.status}, ${String(row.row_count)} rows)`);
}

/** Live records of the catalogue. */
async function liveRecords(h: DbHandle): Promise<number> {
  return Number((await h.db.selectFrom('records').select((eb) => eb.fn.countAll().as('n')).where('archived_at', 'is', null).executeTakeFirstOrThrow()).n);
}

/** Mode `reports` (see the top of this file). */
async function runReports(o: RunOptions, ctx: ModeContext, details: Record<string, unknown>, cleanups: (() => Promise<void>)[]): Promise<void> {
  const inst = await install(o, 'reports', cleanups);
  await measureBaseline(ctx, inst);
  say(`reports: seed (scale ${o.scale})…`);
  // First a catalogue whose titles are all classified: the data-quality list then has nothing to show early, its
  // heaviest preview; then one title in 20 loses its classification (the DDC recap's heaviest shape) and the reports it
  // weighs on are measured again.
  const seeded = await seedKomunitas(inst.h, { scale: o.scale, dataDir: inst.dataDir, accreditation: false, unclassified: false, say });
  details['reportsSeed'] = { ms: seeded.ms, counts: seeded.counts.catalog };
  const today = jakartaDate(Date.now());
  const cases = previewCases(today);
  const live = await liveRecords(inst.h);
  say(`reports: previews of ${cases.length} cases × ${o.repeat} (${live} live records)…`);
  await measurePreviews(ctx, inst, cases, o.repeat, 'preview');
  await seedUnclassified(inst.h);
  const again = cases.filter((c) => c.reportId === 'collection.ddc_recap' || c.reportId === 'collection.data_quality' || (c.reportId === 'collection.summary' && !c.scan));
  say(`reports: previews of ${again.length} cases with one title in 20 unclassified…`);
  await measurePreviews(ctx, inst, again, o.repeat, 'preview (5 % unclassified)');

  // The threshold: a catalogue the scan-based previews still scan.
  if (live > REPORT_SCAN_PREVIEW_MAX_RECORDS) {
    const atLimit = await install(o, 'reports-threshold', cleanups);
    say(`reports: threshold catalogue of ${REPORT_SCAN_PREVIEW_MAX_RECORDS} records…`);
    await seedKomunitas(atLimit.h, { scale: scaleOfRecords(REPORT_SCAN_PREVIEW_MAX_RECORDS), dataDir: atLimit.dataDir, accreditation: false });
    await measurePreviews(ctx, atLimit, cases.filter((c) => c.scan), o.repeat, `preview@${await liveRecords(atLimit.h)}`);
  }

  await measureExport(ctx, inst, seeded.staffId, 'xlsx collection.title_list', 'collection.title_list', 'xlsx', {}, null);
  await measureExport(ctx, inst, seeded.staffId, 'pdf collection.title_list class 1', 'collection.title_list', 'pdf', { classPrefix: '1' }, null);
  const total = Math.round(CSV_ROWS * o.scale);
  say(`reports: copies up to ${total}…`);
  const added = await seedExtraItems(inst.h, { total, say });
  details['extraItems'] = added;
  await measureExport(ctx, inst, seeded.staffId, 'csv collection.item_list', 'collection.item_list', 'csv', {}, KOMUNITAS_BUDGETS.csvMs);
  details['exportLimits'] = { xlsxRows: REPORT_XLSX_MAX_ROWS, pdfRows: REPORT_PDF_MAX_ROWS };
}

/** The names and CRC-32s of a finished ZIP, every entry read whole (each against its CRC-32). */
async function readZip(inst: Install, runId: string): Promise<{ names: string[]; crcs: Map<string, number>; bytes: number }> {
  const reader = await openArchive(reportExportPath(inst.dataDir, runId, 'zip'), { allow: /^[^\0]+$/, maxEntries: 10_000, maxRatio: 1_000 });
  try {
    const crcs = new Map<string, number>();
    let bytes = 0;
    for (const e of reader.entries()) {
      for await (const chunk of reader.read(e)) bytes += chunk.byteLength;
      crcs.set(e.name, e.crc32);
    }
    return { names: [...crcs.keys()], crcs, bytes };
  } finally {
    await reader.close();
  }
}

/** Mode `accred` (see the top of this file). */
async function runAccred(o: RunOptions, ctx: ModeContext, details: Record<string, unknown>, cleanups: (() => Promise<void>)[]): Promise<void> {
  const inst = await install(o, 'accred', cleanups);
  await measureBaseline(ctx, inst);
  say(`accred: seed (scale ${o.scale}${o.withEvidence ? ', with evidence' : ''})…`);
  const seeded = await seedKomunitas(inst.h, { scale: o.scale, dataDir: inst.dataDir, withEvidence: o.withEvidence, say });
  details['accredSeed'] = { ms: seeded.ms, counts: seeded.counts, span: seeded.span };
  const periodId = seeded.periodId!;
  const staffId = seeded.staffId;
  const opts = (): { createdBy: string; now: number; registry: JobRegistry; keyring: KeyringEntry[] } => ({ createdBy: staffId, now: Date.now(), registry: inst.registry, keyring: inst.keyring });

  say('accred: evaluation…');
  const ev = await withTx(inst.h, (trx) => enqueueEvaluate(trx, periodId, opts()));
  const evaluated = await drive(inst, ev.jobId);
  const meta = await inst.h.db.selectFrom('accred_results').select('payload').where('period_id', '=', periodId).where('indicator_code', '=', '_meta').executeTakeFirst();
  const metaStatus = meta === undefined ? 'missing' : String((JSON.parse(meta.payload) as { status?: unknown }).status);
  ctx.addDriven('evaluation', { ...evaluated.d, status: evaluated.d.status === 'succeeded' && metaStatus !== 'ready' ? `results ${metaStatus}` : evaluated.d.status }, { totalBudget: KOMUNITAS_BUDGETS.evaluateMs });
  say(`accred: evaluation ${String(evaluated.d.totalMs)} ms over ${evaluated.d.slices.length} slices (${evaluated.d.status}, results ${metaStatus})`);

  say('accred: evidence file PDF…');
  const pdf = await withTx(inst.h, (trx) => startDocumentRun(trx, 'accreditation.dossier', periodId, { format: 'pdf' }, opts()));
  const pdfRun = await drive(inst, pdf.jobId);
  const pdfRow = await runRow(inst, pdf.id);
  ctx.addDriven('evidence file PDF', { ...pdfRun.d, status: pdfRun.d.status === 'succeeded' && pdfRow.status !== 'succeeded' ? `run ${pdfRow.status} ${pdfRow.error_code ?? ''}` : pdfRun.d.status }, { totalBudget: KOMUNITAS_BUDGETS.dossierPdfMs });
  ctx.add({ name: 'evidence file PDF pages', value: pdfRow.row_count === null ? null : Number(pdfRow.row_count), unit: 'rows', budget: null, op: '<=' });

  say('accred: evidence ZIP, straight through…');
  const zip = await withTx(inst.h, (trx) => startDocumentRun(trx, 'accreditation.dossier', periodId, { format: 'zip' }, opts()));
  const zipRun = await drive(inst, zip.jobId);
  const zipRow = await runRow(inst, zip.id);
  ctx.addDriven('evidence ZIP', { ...zipRun.d, status: zipRun.d.status === 'succeeded' && zipRow.status !== 'succeeded' ? `run ${zipRow.status} ${zipRow.error_code ?? ''}` : zipRun.d.status }, { totalBudget: null });
  ctx.add({ name: 'evidence ZIP entries', value: zipRow.row_count === null ? null : Number(zipRow.row_count), unit: 'entries', budget: null, op: '<=' });
  ctx.add({ name: 'evidence ZIP size', value: zipRow.output_size === null ? null : Number(zipRow.output_size), unit: 'bytes', budget: null, op: '<=' });
  details['zipWarnings'] = (JSON.parse(zipRow.params) as { warnings?: unknown }).warnings ?? [];
  say(`accred: evidence ZIP ${String(zipRun.d.totalMs)} ms over ${zipRun.d.slices.length} slices (${zipRow.status}, ${String(zipRow.row_count)} entries, ${String(zipRow.output_size)} bytes)`);

  // The same ZIP again, its worker SIGKILLed in the middle of its third slice, then resumed.
  say('accred: evidence ZIP, killed in a slice and resumed…');
  const again = await withTx(inst.h, (trx) => startDocumentRun(trx, 'accreditation.dossier', periodId, { format: 'zip' }, opts()));
  // The kill is armed at the start of a slice (from the third), half the slices' mean duration in; a slice that ends
  // first disarms it, and the next one is tried with half that delay, up to the tenth.
  let armed: { n: number; timer: NodeJS.Timeout } | null = null;
  let killedIn: number | null = null;
  let done = 0;
  let sum = 0;
  let delay = 0;
  const first = await drive(inst, again.jobId, (e, kill) => {
    if (e.event === 'slice') {
      done += 1;
      sum += e.ms;
      if (armed?.n === e.n) {
        clearTimeout(armed.timer);
        armed = null;
      }
    }
    if (e.event === 'slice-start' && e.n >= 3 && e.n <= 10 && killedIn === null && armed === null) {
      delay = delay === 0 ? Math.min(10_000, Math.max(10, Math.round(sum / Math.max(1, done) / 2))) : Math.max(1, Math.round(delay / 2));
      const n = e.n;
      armed = {
        n,
        timer: setTimeout(() => {
          killedIn = n;
          kill();
        }, delay),
      };
    }
  });
  if (armed !== null) clearTimeout((armed as { timer: NodeJS.Timeout }).timer);
  ctx.rss(first.d.rssPeakMb);
  // Killed inside the slice: its start was reported, its end never was.
  const midSlice = killedIn !== null && first.run.events.some((e) => e.event === 'slice' && e.n === killedIn) === false;
  let resumed: Driven | null = null;
  let check = 0;
  let checkDetail: string;
  if (killedIn === null || first.run.signal !== 'SIGKILL' || !midSlice) {
    checkDetail = `not exercised: the job ended ${first.d.status} after ${first.d.slices.length} slices without a kill inside one of slices 3 to 10`;
  } else {
    resumed = (await drive(inst, again.jobId, undefined, { reclaim: true })).d;
    ctx.rss(resumed.rssPeakMb);
    const row = await runRow(inst, again.id);
    if (resumed.status !== 'succeeded' || row.status !== 'succeeded') {
      checkDetail = `the resumed run ended ${resumed.status} / ${row.status} ${row.error_code ?? ''}`;
    } else if (zipRow.status !== 'succeeded') {
      checkDetail = 'the straight run did not succeed: nothing to compare with';
    } else {
      try {
        const a = await readZip(inst, zip.id);
        const b = await readZip(inst, again.id);
        const sameNames = a.names.length === b.names.length && a.names.every((n, i) => b.names[i] === n);
        const uploads = a.names.filter((n) => n.endsWith('.jpg'));
        const sameFiles = uploads.every((n) => a.crcs.get(n) === b.crcs.get(n));
        check = sameNames && sameFiles ? 1 : 0;
        checkDetail = `killed in slice ${String(killedIn)}, resumed in ${resumed.slices.length} slices; ${b.names.length} entries read back (${b.bytes} bytes), ${sameNames ? 'the straight run\'s names' : 'NAMES DIFFER'}, ${uploads.length} uploaded files ${sameFiles ? 'identical' : 'DIFFER'}`;
      } catch (error) {
        checkDetail = `the resumed ZIP does not read back: ${messageOf(error)}`;
      }
    }
  }
  ctx.add({ name: 'evidence ZIP SIGKILL mid-slice, resumed, read back', value: check, unit: 'check', budget: 1, op: '=', detail: checkDetail });
  details['zipKill'] = { killedInSlice: killedIn, before: first.d.slices.length, after: resumed?.slices.length ?? null, resumedLongestSliceMs: resumed?.maxSliceMs ?? null };
  say(`accred: kill and resume: ${checkDetail}`);
}

/** Mode `migrate` (see the top of this file). */
async function runMigrate(o: RunOptions, ctx: ModeContext, details: Record<string, unknown>, cleanups: (() => Promise<void>)[]): Promise<void> {
  const inst = await install(o, 'migrate', cleanups);
  await measureBaseline(ctx, inst);
  // The import needs no catalogue: the library, its staff member and the period it is started from.
  const seeded = await seedKomunitas(inst.h, { scale: o.scale, dataDir: inst.dataDir, catalog: false, say });
  const periodId = seeded.periodId!;
  const uploadId = newId();
  const settings = await loadAccredSettings(inst.h.db);
  const started = await withTx(inst.h, (trx) =>
    startSlimsUsageImport(
      trx,
      periodId,
      { source: { kind: 'dump', uploadId }, memberTypeGroups: Object.fromEntries(PERF_MEMBER_TYPES.map((t) => [String(t.id), t.group])), unknownMemberGroup: 'student' },
      { now: Date.now(), createdBy: seeded.staffId, registry: inst.registry, keyring: inst.keyring, settings },
    ),
  );
  // The dump where a completed upload of it lies (the job takes it from there as the start route's hook would).
  const staged = dataPath(inst.dataDir, 'tmp', uploadId);
  await fsp.mkdir(staged, { recursive: true, mode: 0o700 });
  say(`migrate: the SLiMS dump (scale ${o.scale})…`);
  const dump = await writeUsageDump(path.join(staged, 'upload.bin'), { scale: o.scale, endsOn: seeded.span.endsOn });
  details['usageDump'] = { bytes: dump.bytes, rows: { loanHistory: dump.counts.loanHistory, visits: dump.counts.visits, members: dump.counts.members, loans: dump.counts.loans, reads: dump.counts.reads } };
  say(`migrate: ${dump.counts.loanHistory} loan_history and ${dump.counts.visits} visitor_count rows (${Math.round(dump.bytes / 1_048_576)} MiB); the import…`);
  const run = await drive(inst, started.jobId);
  const end = await inst.h.db.selectFrom('catalog_runs').select(['status', 'summary']).where('id', '=', started.runId).executeTakeFirstOrThrow();
  const rows = Number((await inst.h.db.selectFrom('usage_stats').select((eb) => eb.fn.countAll().as('n')).where('source', '=', 'slims').executeTakeFirstOrThrow()).n);
  ctx.addDriven('SLiMS usage import', { ...run.d, status: run.d.status === 'succeeded' && end.status !== 'succeeded' ? `run ${end.status}` : run.d.status }, { totalBudget: KOMUNITAS_BUDGETS.usageImportMs });
  ctx.add({ name: 'SLiMS usage import usage rows', value: rows, unit: 'rows', budget: null, op: '<=' });
  details['usageImport'] = { status: end.status, summary: (() => { try { return JSON.parse(end.summary) as unknown; } catch { return null; } })() };
  say(`migrate: ${String(run.d.totalMs)} ms over ${run.d.slices.length} slices (${end.status}, ${rows} usage rows)`);
}

export interface KomunitasReport {
  db: TestEngine;
  node: string;
  seed: string;
  scale: number;
  modes: KomunitasMode[];
  measurements: Measurement[];
  details: Record<string, unknown>;
  budgetsAsserted: boolean;
  failures: string[];
}

/** One JSON line, the budgets beside the measurements. */
export function formatKomunitasReport(r: KomunitasReport): string {
  return `${JSON.stringify({ ...r, budgets: KOMUNITAS_BUDGETS, seedCounts: { ...PERF_PHASE2_SEED, ...PERF_KOMUNITAS_SEED, usageDump: USAGE_DUMP_ROWS } })}\n`;
}

/** One run (see the top of this file). Never throws for a failure of the run: it is in `failures`. */
export async function runKomunitas(o: RunOptions): Promise<KomunitasReport> {
  const measurements: Measurement[] = [];
  const details: Record<string, unknown> = { counts: komunitasCounts(o.scale, { withEvidence: o.withEvidence }) };
  const failures: string[] = [];
  const modes: Record<KomunitasMode, typeof runReports> = { reports: runReports, accred: runAccred, migrate: runMigrate };
  for (const mode of o.modes) {
    const cleanups: (() => Promise<void>)[] = [];
    const ctx = new ModeContext(mode);
    const t0 = performance.now();
    try {
      await modes[mode](o, ctx, details, cleanups);
    } catch (error) {
      failures.push(`${mode}: ${messageOf(error)}`);
      if (!(error instanceof SmokeError)) process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    } finally {
      ctx.finishRss();
      measurements.push(...ctx.rows);
      details[`${mode}Ms`] = Math.round(performance.now() - t0);
      for (const fn of cleanups.splice(0).reverse()) {
        try {
          await fn();
        } catch (error) {
          say(`cleanup: ${messageOf(error)}`);
        }
      }
    }
  }
  const missed = judgeKomunitas(measurements);
  if (o.assert) failures.push(...missed);
  else if (missed.length > 0) say(`budgets not asserted (--assert asserts them); would miss: ${missed.join('; ')}`);
  return { db: o.db, node: process.version, seed: PERF_KOMUNITAS_SEED.name, scale: o.scale, modes: o.modes, measurements, details, budgetsAsserted: o.assert, failures };
}

async function main(argv: string[]): Promise<number> {
  if (argv[0] === '--child' && argv[1] !== undefined) {
    await childMain(argv[1]);
    return 0;
  }
  let options: RunOptions;
  try {
    options = parseRunArgs(argv);
  } catch (error) {
    process.stderr.write(`perf-komunitas: ${messageOf(error)}\n${USAGE}\n`);
    return 2;
  }
  const report = await runKomunitas(options);
  process.stderr.write(`\n${formatTable(report.measurements)}\n\n`);
  for (const failure of report.failures) say(`FAILED: ${failure}`);
  await new Promise<void>((resolve) => process.stdout.write(formatKomunitasReport(report), () => resolve()));
  return report.failures.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => process.stderr.write('', () => process.exit(code)),
    (error: unknown) => {
      process.stderr.write(`perf-komunitas: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      process.stderr.write('', () => process.exit(1));
    },
  );
}

