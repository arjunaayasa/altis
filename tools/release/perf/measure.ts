#!/usr/bin/env tsx
import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { TEST_ENGINES, type TestEngine } from '@altis/test-tools';
import {
  BUDGETS,
  HEALTH_TIMEOUT_MS,
  RSS_SAMPLE_DELAY_MS,
  SmokeError,
  SmokeSession,
  baseEnv,
  budgetsApply,
  descendantsOf,
  freePort,
  messageOf,
  mustRun,
  newSmokeAdmin,
  provisionDb,
  psTable,
  sleep,
  startProcess,
  stopTracked,
  toMb,
  waitHealthy,
  writePrivateFile,
} from '../smoke/run.js';
import { ZIP_BUDGET_BYTES } from '../src/build.js';
import { extractZip } from '../src/zip.js';
import { PERF_SEED, seedPerf } from './seed.js';

// The §12.7 performance budgets (acceptance A11; plan Task 35):
//
//   pnpm perf --zip <altis-x.y.z.zip> --db sqlite|mariadb106|… [--update-report <smoke report of --scenario update>] [--keep]
//
// What a run does, on a standalone install (`node app.js`, the server process app.js supervises):
//   1. the zip unpacked into a temp folder, a fresh database (SQLite in DATA_DIR, or `altis_perf_<id>` on the
//      tools/test/compose.yml engine), `node app.js install --config` with a random first super admin;
//   2. the seed `perf-phase1` (perf/seed.ts: 50 staff through the API, 200 000 audit entries and 10 000 jobs);
//   3. the server stopped and started again: the cold start (spawn → first `/_health` 200) and the idle RSS of the
//      server process RSS_SAMPLE_DELAY_MS later;
//   4. PERF_REQUESTS requests each, one after another, as the signed-in super admin, to `GET users`, `GET audit`,
//      `GET jobs` and `GET dashboard`: their p95 (nearest rank), and the RSS of the server process under that load
//      (the highest of samples taken every 250 ms);
//   5. the zip's size, and the update's duration (apply → done) from the smoke report of `--scenario update` when one
//      is given (passenger-sim + MariaDB 10.6 in CI).
//
// Output: one JSON line (formatPerfReport) on stdout; progress on stderr. Exit 0 when every budget holds on Linux x64
// (CI), or always on another platform (budgets reported, not asserted: `budgetsAsserted: false`, as the smoke run); 1
// otherwise; 2 for a usage error.

/** §12.7. Strict upper bounds. */
export const PERF_BUDGETS = Object.freeze({
  apiP95Ms: 200,
  rssLoadMb: 300,
  coldStartMs: BUDGETS.coldStartMs,
  rssIdleMb: BUDGETS.rssIdleMb,
  zipBytes: ZIP_BUDGET_BYTES,
  updateMs: 120_000,
});

export const PERF_ENDPOINTS = ['users', 'audit', 'jobs', 'dashboard'] as const;
export type PerfEndpoint = (typeof PERF_ENDPOINTS)[number];

/** Requests per endpoint. */
export const PERF_REQUESTS = 200;

/** How often the RSS is sampled while the load runs. */
const RSS_LOAD_SAMPLE_MS = 250;

export interface PerfMeasurements {
  /** p95 (ms) per endpoint; null when not measured. */
  p95Ms: Record<PerfEndpoint, number | null>;
  /** RSS (MB) of the server process under the load; null where it cannot be sampled (Windows). */
  rssLoadMb: number | null;
  coldStartMs: number | null;
  rssIdleMb: number | null;
  zipBytes: number | null;
  /** apply → done of the update scenario (ms); null when no smoke report was given. */
  updateMs: number | null;
}

/** The p95 of `samples` by nearest rank (the ⌈0.95·n⌉-th smallest); null for none. */
export function p95(samples: readonly number[]): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.ceil(0.95 * sorted.length) - 1]!;
}

/** The budgets as the smoke run judges its own (Linux x64 only). */
export const perfBudgetsApply = budgetsApply;

/**
 * Each budget missed, in a fixed order. Never measured: an endpoint, the cold start, the zip → a failure; an RSS that
 * could not be sampled and an update that was not run are not asserted.
 */
export function evaluatePerf(m: PerfMeasurements, budgets: typeof PERF_BUDGETS = PERF_BUDGETS): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  for (const endpoint of PERF_ENDPOINTS) {
    const value = m.p95Ms[endpoint];
    if (value === null) failures.push(`p95 GET ${endpoint}: not measured`);
    else if (!(value < budgets.apiP95Ms)) failures.push(`p95 GET ${endpoint} ${value} ms is over the budget (< ${budgets.apiP95Ms} ms)`);
  }
  const over = (name: string, value: number | null, budget: number, unit: string, required: boolean): void => {
    if (value === null) {
      if (required) failures.push(`${name}: not measured`);
    } else if (!(value < budget)) failures.push(`${name} ${value} is over the budget (< ${budget} ${unit})`);
  };
  over('rssLoadMb', m.rssLoadMb, budgets.rssLoadMb, 'MB', false);
  over('coldStartMs', m.coldStartMs, budgets.coldStartMs, 'ms', true);
  over('rssIdleMb', m.rssIdleMb, budgets.rssIdleMb, 'MB', false);
  over('zipBytes', m.zipBytes, budgets.zipBytes, 'bytes', true);
  over('updateMs', m.updateMs, budgets.updateMs, 'ms', false);
  return { ok: failures.length === 0, failures };
}

export interface PerfReport {
  db: TestEngine;
  node: string;
  seed: string;
  measurements: PerfMeasurements;
  budgetsAsserted: boolean;
  failures: string[];
}

/** One JSON line, keys in a fixed order, the budgets beside the numbers. */
export function formatPerfReport(r: PerfReport): string {
  return `${JSON.stringify({ db: r.db, node: r.node, seed: r.seed, measurements: r.measurements, budgets: PERF_BUDGETS, budgetsAsserted: r.budgetsAsserted, failures: r.failures })}\n`;
}

/**
 * The update duration (apply → done, ms) from the smoke report of `--scenario update` (its last JSON line); null when
 * the scenario failed.
 *
 * @throws Error `USAGE: …` when the report is not one of `--scenario update`
 */
export function updateMsOfSmokeReport(text: string): number | null {
  const line = text.trim().split('\n').filter(Boolean).at(-1) ?? '';
  let report: { scenario?: unknown; scenarioOk?: unknown; scenarioDetail?: { applyToDoneMs?: unknown } };
  try {
    report = JSON.parse(line) as typeof report;
  } catch {
    throw new Error('USAGE: --update-report is not a smoke report (one JSON line)');
  }
  if (report.scenario !== 'update') throw new Error(`USAGE: --update-report is the report of --scenario ${String(report.scenario)}, not update`);
  const ms = report.scenarioDetail?.applyToDoneMs;
  return report.scenarioOk === true && typeof ms === 'number' ? ms : null;
}

export interface PerfOptions {
  zip: string;
  db: TestEngine;
  updateReport: string | null;
  keep: boolean;
}

const isEngine = (value: string): value is TestEngine => (TEST_ENGINES as readonly string[]).includes(value);

/** @throws Error `USAGE: …` */
export function parsePerfArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): PerfOptions {
  const args = argv[0] === '--' ? argv.slice(1) : [...argv];
  let values: { zip?: string; db?: string; 'update-report'?: string; keep?: boolean };
  try {
    values = parseArgs({
      args,
      strict: true,
      allowPositionals: false,
      options: { zip: { type: 'string' }, db: { type: 'string' }, 'update-report': { type: 'string' }, keep: { type: 'boolean' } },
    }).values;
  } catch (error) {
    throw new Error(`USAGE: ${messageOf(error)}`, { cause: error });
  }
  if (values.zip === undefined || values.zip === '') throw new Error('USAGE: --zip <altis-x.y.z.zip> is required');
  if (values.db === undefined || !isEngine(values.db)) throw new Error(`USAGE: --db must be one of ${TEST_ENGINES.join(', ')}`);
  const base = env['INIT_CWD'] !== undefined && env['INIT_CWD'] !== '' ? env['INIT_CWD'] : cwd;
  const report = values['update-report'];
  return { zip: path.resolve(base, values.zip), db: values.db, updateReport: report === undefined || report === '' ? null : path.resolve(base, report), keep: values.keep === true };
}

// ---------------------------------------------------------------------------------------------------------------
// The run

const say = (line: string): void => void process.stderr.write(`perf: ${line}\n`);
const IS_WINDOWS = process.platform === 'win32';

/** RSS (MB) of the processes app.js supervises (its descendants), or null on Windows. */
async function serverRss(appJsPid: number, logDir: string): Promise<number | null> {
  if (IS_WINDOWS) return null;
  const table = await psTable(logDir);
  const served = descendantsOf(table, appJsPid);
  if (served.length === 0) throw new SmokeError('app.js has no server process');
  return toMb(served.reduce((kib, pid) => kib + (table.get(pid)?.rssKb ?? 0), 0));
}

/** One run (see the top of this file). Never throws for a failure of the run: it is in `failures`. */
export async function runPerf(o: PerfOptions): Promise<PerfReport> {
  const m: PerfMeasurements = { p95Ms: { users: null, audit: null, jobs: null, dashboard: null }, rssLoadMb: null, coldStartMs: null, rssIdleMb: null, zipBytes: null, updateMs: null };
  const failures: string[] = [];
  const cleanups: (() => Promise<void>)[] = [];
  const asserted = perfBudgetsApply();
  try {
    if (o.updateReport !== null) m.updateMs = updateMsOfSmokeReport(await fsp.readFile(o.updateReport, 'utf8'));
    const zip = await fsp.readFile(o.zip);
    m.zipBytes = zip.length;
    const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-perf-')));
    if (o.keep) say(`keeping ${root} (--keep)`);
    else cleanups.push(() => fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
    const appRoot = path.join(root, 'app');
    const dataDir = path.join(root, 'altis-data');
    const logDir = path.join(root, 'logs');
    await fsp.mkdir(logDir);
    await extractZip(zip, appRoot);
    await fsp.mkdir(dataDir, { mode: 0o700 });
    const id = randomBytes(4).toString('hex');
    const db = await provisionDb(o.db, `perf_${id}`, (drop) => void (o.keep ? undefined : cleanups.push(drop)));
    const port = await freePort();
    const admin = newSmokeAdmin();
    const installFile = path.join(root, 'install.json');
    writePrivateFile(installFile, `${JSON.stringify({ baseUrl: `http://127.0.0.1:${port}`, db, admin })}\n`);
    const env = { ...baseEnv(), ALTIS_DATA_DIR: dataDir };
    say(`install (${o.db})…`);
    await mustRun({ label: 'install', file: process.execPath, args: ['app.js', 'install', '--config', installFile], cwd: appRoot, env }, logDir);
    await fsp.rm(installFile, { force: true });
    const start = (label: string) => startProcess({ label, file: process.execPath, args: ['app.js'], cwd: appRoot, env: { ...env, ALTIS_PORT: String(port) } }, logDir);

    // 2. The seed, the server running for the API part.
    let proc = start('seed-server');
    cleanups.push(() => stopTracked(proc));
    await waitHealthy(port, HEALTH_TIMEOUT_MS, proc.alive);
    const session = new SmokeSession(port);
    await session.signIn(admin.username, admin.password);
    await session.call('POST', 'auth/reauth', { password: admin.password });
    say(`seed ${PERF_SEED.name}…`);
    const seeded = await seedPerf({ db, dataDir, admin: session, say });
    say(`seeded in ${Math.round(seeded.ms / 1000)} s`);
    await stopTracked(proc);

    // 3. Cold start and idle RSS.
    const t0 = performance.now();
    proc = start('server');
    const healthy = await waitHealthy(port, HEALTH_TIMEOUT_MS, proc.alive);
    m.coldStartMs = Math.round(healthy.at - t0);
    await sleep(RSS_SAMPLE_DELAY_MS);
    m.rssIdleMb = await serverRss(proc.child.pid!, logDir);
    say(`cold start ${m.coldStartMs} ms, idle RSS ${String(m.rssIdleMb)} MB`);

    // 4. The load, its p95 and the RSS under it.
    const s = new SmokeSession(port);
    await s.signIn(admin.username, admin.password);
    let peak = 0;
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        const rss = await serverRss(proc.child.pid!, logDir).catch(() => null);
        if (rss !== null) peak = Math.max(peak, rss);
        await sleep(RSS_LOAD_SAMPLE_MS);
      }
    })();
    try {
      for (const endpoint of PERF_ENDPOINTS) {
        const samples: number[] = [];
        for (let i = 0; i < PERF_REQUESTS; i += 1) {
          const t = performance.now();
          const reply = await s.request('GET', `/api/v1/${endpoint}`);
          samples.push(performance.now() - t);
          if (reply.status !== 200) throw new SmokeError(`GET ${endpoint} → ${reply.status}`);
        }
        const value = p95(samples);
        m.p95Ms[endpoint] = value === null ? null : Math.round(value * 10) / 10;
        say(`p95 GET ${endpoint}: ${String(m.p95Ms[endpoint])} ms`);
      }
    } finally {
      sampling = false;
      await sampler;
    }
    m.rssLoadMb = IS_WINDOWS ? null : peak;
    say(`RSS under load ${String(m.rssLoadMb)} MB`);
  } catch (error) {
    failures.push(messageOf(error));
    if (!(error instanceof SmokeError)) process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  } finally {
    for (const fn of cleanups.splice(0).reverse()) {
      try {
        await fn();
      } catch (error) {
        say(`cleanup: ${messageOf(error)}`);
      }
    }
  }
  const judged = evaluatePerf(m);
  if (asserted) failures.push(...judged.failures);
  else if (!judged.ok) say(`budgets not asserted on ${process.platform}-${process.arch} (Linux x64 only); would fail: ${judged.failures.join('; ')}`);
  return { db: o.db, node: process.version, seed: PERF_SEED.name, measurements: m, budgetsAsserted: asserted, failures };
}

async function main(argv: string[]): Promise<number> {
  let options: PerfOptions;
  try {
    options = parsePerfArgs(argv);
  } catch (error) {
    process.stderr.write(`perf: ${messageOf(error)}\nusage: pnpm perf --zip <altis-x.y.z.zip> --db <engine> [--update-report <file>] [--keep]\n`);
    return 2;
  }
  const report = await runPerf(options);
  for (const failure of report.failures) say(`FAILED: ${failure}`);
  await new Promise<void>((resolve) => process.stdout.write(formatPerfReport(report), () => resolve()));
  return report.failures.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => process.stderr.write('', () => process.exit(code)),
    (error: unknown) => {
      process.stderr.write(`perf: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      process.stderr.write('', () => process.exit(1));
    },
  );
}
