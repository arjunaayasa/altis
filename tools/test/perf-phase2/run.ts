#!/usr/bin/env tsx
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { connect, type DbConfig, type DbHandle } from '@altis/db';
import { recordUrlPath } from '../../../packages/core/src/index.js';
import { p95 } from '../../release/perf/measure.js';
import {
  HEALTH_TIMEOUT_MS,
  RSS_SAMPLE_DELAY_MS,
  SmokeError,
  SmokeSession,
  baseEnv,
  budgetsApply,
  descendantsOf,
  freePort,
  httpSend,
  messageOf,
  mustRun,
  newSmokeAdmin,
  problemCode,
  provisionDb,
  psTable,
  sleep,
  startProcess,
  stopTracked,
  toMb,
  waitHealthy,
  writePrivateFile,
  type Command,
  type TrackedProcess,
} from '../../release/smoke/run.js';
import { extractZip } from '../../release/src/zip.js';
import { TEST_ENGINES, type TestEngine } from '../test-db.js';
import { PERF_PHASE2_SEED, perfCounts, prng, seedPhase2, writePerfMarcXml, writePerfSlimsDump, type PerfCounts } from './seed.js';

// The measurement of acceptance K9 and K16 (Phase 2 spec §15; plan Task 39) on a release zip:
//
//   pnpm exec tsx tools/test/perf-phase2/run.ts --zip <altis-x.y.z.zip> --db sqlite|mariadb106|…
//       [--mode opac,import,migrate] [--scale <0..2>] [--requests <n>] [--keep] [--assert] [--node-options=<flags>]
//
// `--node-options=<flags>` (with `=`: its value starts with `--`) sets NODE_OPTIONS for the server and the commands after
// the install, e.g. `--node-options=--max-old-space-size=192`, to measure a V8 heap policy before the product adopts
// one; the report names it under `details.nodeOptions`.
//
// Each mode runs on a fresh standalone install of the zip (`node app.js install --config`, a random first super
// admin; SQLite in DATA_DIR, or a database `altis_smoke_p2…` on the tools/test/compose.yml engine):
//
// - opac (K9, and K16's cold start): the seed perf-phase2 (seed.ts seedPhase2: 100 000 records, 150 000 items, 50 000
//   agents, 20 000 subjects, 2 000 attachments, times --scale) written into the database, then the index rebuilt by
//   the release itself (`node app.js catalog:reindex --json`: its duration and RSS). The server is then started: the
//   cold start (spawn → first `/_health` 200) and the idle RSS RSS_SAMPLE_DELAY_MS later. The OPAC's OAI-PMH gets an
//   admin e-mail (it answers 503 without one). Then the mix of §15 (planMix: --requests per route, interleaved, one
//   after another): OPAC home, search of 1, 2 and 3 words, search + 2 facets, the record page, a sitemap page and a
//   `ListRecords` page (a harvest that follows its resumption tokens), and the admin catalogue API (records list,
//   search and record, items list and barcode lookup, agents and subjects lists, the four masters lists) as the
//   signed-in super admin. Every OPAC request is its own visitor (`X-Forwarded-For` from visitorIp, the server
//   trusting one proxy hop), as the rate limits `opac_search` (120/min) and `oai` (60/min) are per IP. The p95 per
//   route (nearest rank) and the RSS of the server process under that load (the highest of samples every 250 ms).
//   The machine should be otherwise idle: the requests run one after another, so any other load shows in the p95.
// - import (K16, K5): the same catalogue as one MARCXML file (seed.ts writePerfMarcXml, items in 952) uploaded through
//   `files/uploads` (context `catalog.import`) and imported by `POST catalog/imports` (createItems, match on ISBN,
//   duplicates reported): the duration and the highest RSS of the server process until the run ends.
// - migrate (K16): the same catalogue as a SLiMS dump (seed.ts writePerfSlimsDump) migrated by
//   `node app.js slims:import --dump <file> --json`: the duration and the highest RSS of that command's processes.
//
// Output: one JSON line (formatPhase2Report) on stdout; progress on stderr. Exit 0 when every budget holds where they
// are asserted (Linux x64, as `pnpm perf`, or anywhere with --assert), or when they are not asserted; 1 otherwise; 2 for
// a usage error. The zip's own size is always measured.

// ---------------------------------------------------------------------------------------------------------------------
// Budgets, routes and the mix (pure)

/** K9 and K16 (§15), strict upper bounds; the idle RSS is §12.7's. */
export const PHASE2_BUDGETS = Object.freeze({ opacP95Ms: 300, adminP95Ms: 200, zipBytes: 15_000_000, coldStartMs: 1500, rssMb: 300, rssIdleMb: 150 });

/** The OPAC routes of the §15 mix (K9: p95 < 300 ms). */
export const OPAC_ROUTES = ['opac.home', 'opac.search.1', 'opac.search.2', 'opac.search.3', 'opac.search.facets', 'opac.record', 'opac.sitemap.catalog', 'oai.list_records'] as const;
/**
 * The admin catalogue API routes (K9: p95 < 200 ms): the lists and lookups of Bibliografi, Eksemplar and Otoritas, and
 * the masters lists (each counts the live records or items that use every master of it).
 */
export const ADMIN_ROUTES = [
  'catalog.records.list',
  'catalog.records.search',
  'catalog.records.get',
  'catalog.items.list',
  'catalog.items.by_barcode',
  'catalog.agents.list',
  'catalog.subjects.list',
  'catalog.material_types.list',
  'catalog.languages.list',
  'catalog.collection_types.list',
  'catalog.suppliers.list',
] as const;

export type OpacRoute = (typeof OPAC_ROUTES)[number];
export type AdminRoute = (typeof ADMIN_ROUTES)[number];
export type Phase2Route = OpacRoute | AdminRoute;

const isAdminRoute = (route: Phase2Route): route is AdminRoute => (ADMIN_ROUTES as readonly string[]).includes(route);

/** The first page of the harvest (the runner follows each page's resumption token from there). */
export const OAI_FIRST_PAGE = '/oai?verb=ListRecords&metadataPrefix=oai_dc';

/** What the mix draws its requests from (read from the seeded database by sampleCatalog). */
export interface MixSample {
  /** Public live records: id, title, and the codes of their material type and language (`code_key`). */
  records: { id: string; title: string; materialTypeCode: string; languageCode: string }[];
  barcodes: string[];
  /** The first letters of agent names (what a librarian types into the agents list). */
  agentPrefixes: string[];
  /** Words of subject terms. */
  subjectTerms: string[];
  /** The number of `/sitemap/katalog/<n>` files (from `/sitemap.xml`). */
  sitemapFiles: number;
}

export interface PlannedRequest {
  route: Phase2Route;
  /** The path and query; for `oai.list_records` the first page (the runner follows the tokens). */
  path: string;
}

/** The distinct words of a title, lower case (what a visitor types from it). */
function titleWords(title: string): string[] {
  return [...new Set(title.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w !== ''))];
}

const query = (pairs: Record<string, string>): string => new URLSearchParams(pairs).toString();

/**
 * The requests of the mix: `perRoute` of each route of OPAC_ROUTES and ADMIN_ROUTES, shuffled together (the same plan
 * for the same seed). A search takes 1, 2 or 3 words of one sampled title (common words are searched more, as they
 * are more common in titles); the faceted search one word and the material type and language of its record.
 *
 * @throws RangeError when the sample has no record, barcode, agent prefix, subject term or sitemap file, or no title of
 *   three words
 */
export function planMix(s: MixSample, o: { perRoute: number; seed: number }): PlannedRequest[] {
  const r = prng(o.seed);
  const pick = <T>(list: readonly T[], what: string): T => {
    if (list.length === 0) throw new RangeError(`planMix: the sample has no ${what}`);
    return list[Math.floor(r() * list.length)]!;
  };
  const withWords = (n: number) => s.records.filter((rec) => titleWords(rec.title).length >= n);
  if (withWords(3).length === 0) throw new RangeError('planMix: the sample has no title of three words');
  if (s.sitemapFiles < 1) throw new RangeError('planMix: the sample has no sitemap file');
  const wordsOf = (n: number): { words: string[]; rec: MixSample['records'][number] } => {
    const rec = pick(withWords(n), 'record');
    const all = titleWords(rec.title);
    const words: string[] = [];
    while (words.length < n) {
      const w = all[Math.floor(r() * all.length)]!;
      if (!words.includes(w)) words.push(w);
    }
    return { words, rec };
  };
  const make: Record<Phase2Route, () => string> = {
    'opac.home': () => '/',
    'opac.search.1': () => `/cari?${query({ q: wordsOf(1).words.join(' ') })}`,
    'opac.search.2': () => `/cari?${query({ q: wordsOf(2).words.join(' ') })}`,
    'opac.search.3': () => `/cari?${query({ q: wordsOf(3).words.join(' ') })}`,
    'opac.search.facets': () => {
      const { words, rec } = wordsOf(1);
      return `/cari?${query({ q: words[0]!, jenis: rec.materialTypeCode, bahasa: rec.languageCode })}`;
    },
    'opac.record': () => {
      const rec = pick(s.records, 'record');
      return recordUrlPath(rec.id, rec.title);
    },
    'opac.sitemap.catalog': () => `/sitemap/katalog/${1 + Math.floor(r() * s.sitemapFiles)}`,
    'oai.list_records': () => OAI_FIRST_PAGE,
    'catalog.records.list': () => '/api/v1/catalog/records?limit=50',
    'catalog.records.search': () => `/api/v1/catalog/records?${query({ q: wordsOf(1).words[0]!, limit: '50' })}`,
    'catalog.records.get': () => `/api/v1/catalog/records/${encodeURIComponent(pick(s.records, 'record').id)}`,
    'catalog.items.list': () => '/api/v1/catalog/items?limit=50',
    'catalog.items.by_barcode': () => `/api/v1/catalog/items/by-barcode?${query({ barcode: pick(s.barcodes, 'barcode') })}`,
    'catalog.agents.list': () => `/api/v1/catalog/agents?${query({ q: pick(s.agentPrefixes, 'agent prefix'), limit: '50' })}`,
    'catalog.subjects.list': () => `/api/v1/catalog/subjects?${query({ q: pick(s.subjectTerms, 'subject term'), limit: '50' })}`,
    'catalog.material_types.list': () => '/api/v1/catalog/material-types',
    'catalog.languages.list': () => '/api/v1/catalog/languages',
    'catalog.collection_types.list': () => '/api/v1/catalog/collection-types',
    'catalog.suppliers.list': () => '/api/v1/catalog/suppliers',
  };
  const plan: PlannedRequest[] = [];
  for (const route of [...OPAC_ROUTES, ...ADMIN_ROUTES]) for (let i = 0; i < o.perRoute; i += 1) plan.push({ route, path: make[route]() });
  for (let i = plan.length - 1; i > 0; i -= 1) {
    const j = Math.floor(r() * (i + 1));
    [plan[i], plan[j]] = [plan[j]!, plan[i]!];
  }
  return plan;
}

/** The address of visitor `i` (from 0): 10.0.0.1, 10.0.0.2, … (distinct for the first 2^24 − 1). */
export function visitorIp(i: number): string {
  const n = i + 1;
  return `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
}

const XML_ENTITIES: Readonly<Record<string, string>> = Object.freeze({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" });

/** The resumption token of an OAI-PMH `ListRecords` answer; null at the end of the list (an empty token) or on an error. */
export function oaiResumptionToken(body: string): string | null {
  if (/<error\b/.test(body)) return null;
  const m = /<resumptionToken\b[^>]*?(?:\/>|>([^<]*)<\/resumptionToken>)/.exec(body);
  const token = (m?.[1] ?? '').trim();
  return token === '' ? null : token.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => XML_ENTITIES[name]!);
}

// ---------------------------------------------------------------------------------------------------------------------
// Judging (pure)

export type Phase2Mode = 'opac' | 'import' | 'migrate';
export const PHASE2_MODES: readonly Phase2Mode[] = Object.freeze(['opac', 'import', 'migrate'] as const);

export interface Phase2Measurements {
  /** p95 (ms) per route of the mix; null when not measured. */
  p95Ms: Record<string, number | null>;
  /** Answers per route that were not 200 (or, for OAI-PMH, an OAI error). */
  errors: Record<string, number>;
  /** RSS (MB) of the server process under the mix; null where it cannot be sampled (Windows). */
  rssLoadMb: number | null;
  coldStartMs: number | null;
  rssIdleMb: number | null;
  zipBytes: number | null;
  /** `catalog:reindex` over the seed: its duration and the highest RSS of its processes. */
  reindexMs: number | null;
  rssReindexMb: number | null;
  /** The MARCXML import: from `POST catalog/imports` to the run's end, and the server's highest RSS meanwhile. */
  importMs: number | null;
  rssImportMb: number | null;
  /** `slims:import --dump`: its duration and the highest RSS of its processes. */
  migrateMs: number | null;
  rssMigrateMb: number | null;
}

export function emptyMeasurements(): Phase2Measurements {
  return {
    p95Ms: Object.fromEntries([...OPAC_ROUTES, ...ADMIN_ROUTES].map((r) => [r, null])),
    errors: Object.fromEntries([...OPAC_ROUTES, ...ADMIN_ROUTES].map((r) => [r, 0])),
    rssLoadMb: null,
    coldStartMs: null,
    rssIdleMb: null,
    zipBytes: null,
    reindexMs: null,
    rssReindexMb: null,
    importMs: null,
    rssImportMb: null,
    migrateMs: null,
    rssMigrateMb: null,
  };
}

/**
 * Each budget missed, in a fixed order: per route of the mix (its errors, then its p95), then the zip, the cold start
 * and the RSS figures. Only the modes that ran are judged. A route, the zip, the cold start, the import or the
 * migration never measured fails; an RSS that could not be sampled is not asserted.
 */
export function evaluatePhase2(m: Phase2Measurements, modes: readonly Phase2Mode[], b: typeof PHASE2_BUDGETS = PHASE2_BUDGETS): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  const over = (name: string, value: number | null, budget: number, unit: string, required: boolean): void => {
    if (value === null) {
      if (required) failures.push(`${name}: not measured`);
    } else if (!(value < budget)) failures.push(`${name} ${value} is over the budget (< ${budget} ${unit})`);
  };
  const opac = modes.includes('opac');
  if (opac) {
    for (const route of [...OPAC_ROUTES, ...ADMIN_ROUTES]) {
      const errors = m.errors[route] ?? 0;
      if (errors > 0) failures.push(`${route}: ${errors} answers were not 200`);
      const value = m.p95Ms[route] ?? null;
      const budget = isAdminRoute(route) ? b.adminP95Ms : b.opacP95Ms;
      if (value === null) failures.push(`p95 ${route}: not measured`);
      else if (!(value < budget)) failures.push(`p95 ${route} ${value} ms is over the budget (< ${budget} ms)`);
    }
  }
  over('zipBytes', m.zipBytes, b.zipBytes, 'bytes', true);
  if (opac) {
    over('coldStartMs', m.coldStartMs, b.coldStartMs, 'ms', true);
    over('rssIdleMb', m.rssIdleMb, b.rssIdleMb, 'MB', false);
    over('rssLoadMb', m.rssLoadMb, b.rssMb, 'MB', false);
    over('rssReindexMb', m.rssReindexMb, b.rssMb, 'MB', false);
  }
  if (modes.includes('import')) {
    if (m.importMs === null) failures.push('importMs: not measured');
    over('rssImportMb', m.rssImportMb, b.rssMb, 'MB', false);
  }
  if (modes.includes('migrate')) {
    if (m.migrateMs === null) failures.push('migrateMs: not measured');
    over('rssMigrateMb', m.rssMigrateMb, b.rssMb, 'MB', false);
  }
  return { ok: failures.length === 0, failures };
}

export interface Phase2Report {
  db: TestEngine;
  node: string;
  seed: string;
  counts: PerfCounts;
  modes: Phase2Mode[];
  measurements: Phase2Measurements;
  /** What else a run found: the seed's duration, p50s, the import's and the migration's summaries. */
  details?: Record<string, unknown>;
  budgetsAsserted: boolean;
  failures: string[];
}

/** One JSON line, keys in a fixed order, the budgets beside the numbers. */
export function formatPhase2Report(r: Phase2Report): string {
  return `${JSON.stringify({
    db: r.db,
    node: r.node,
    seed: r.seed,
    counts: r.counts,
    modes: r.modes,
    measurements: r.measurements,
    ...(r.details === undefined ? {} : { details: r.details }),
    budgets: PHASE2_BUDGETS,
    budgetsAsserted: r.budgetsAsserted,
    failures: r.failures,
  })}\n`;
}

// ---------------------------------------------------------------------------------------------------------------------
// The command line

export interface RunOptions {
  zip: string;
  db: TestEngine;
  modes: Phase2Mode[];
  scale: number;
  requests: number;
  keep: boolean;
  /** Assert the budgets on any platform (default: Linux x64 only, as `pnpm perf`). */
  assert: boolean;
  /** NODE_OPTIONS for the processes of the install after `install` (the server, `catalog:reindex`, `slims:import`). */
  nodeOptions: string | null;
}

/** The largest --scale (twice the seed of K9). */
export const SCALE_MAX = 2;
/** The most requests per route. */
export const REQUESTS_MAX = 10_000;
/** The longest --node-options value. */
export const NODE_OPTIONS_MAX = 200;

/** @throws Error `USAGE: …` */
export function parseRunArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): RunOptions {
  const args = argv[0] === '--' ? argv.slice(1) : [...argv];
  let v: { zip?: string; db?: string; mode?: string; scale?: string; requests?: string; keep?: boolean; assert?: boolean; 'node-options'?: string };
  try {
    v = parseArgs({
      args,
      strict: true,
      allowPositionals: false,
      options: {
        zip: { type: 'string' },
        db: { type: 'string' },
        mode: { type: 'string' },
        scale: { type: 'string' },
        requests: { type: 'string' },
        keep: { type: 'boolean' },
        assert: { type: 'boolean' },
        'node-options': { type: 'string' },
      },
    }).values;
  } catch (error) {
    throw new Error(`USAGE: ${messageOf(error)}`, { cause: error });
  }
  if (v.zip === undefined || v.zip === '') throw new Error('USAGE: --zip <altis-x.y.z.zip> is required');
  if (v.db === undefined || !(TEST_ENGINES as readonly string[]).includes(v.db)) throw new Error(`USAGE: --db must be one of ${TEST_ENGINES.join(', ')}`);
  const asked = (v.mode ?? PHASE2_MODES.join(',')).split(',').map((m) => m.trim());
  for (const m of asked) if (!(PHASE2_MODES as readonly string[]).includes(m)) throw new Error(`USAGE: --mode takes ${PHASE2_MODES.join(', ')} (comma-separated), not ${JSON.stringify(m)}`);
  const scale = v.scale === undefined ? 1 : Number(v.scale);
  if (!Number.isFinite(scale) || scale <= 0 || scale > SCALE_MAX) throw new Error(`USAGE: --scale must be a number above 0 and at most ${SCALE_MAX}`);
  const requests = v.requests === undefined ? 200 : Number(v.requests);
  if (!Number.isSafeInteger(requests) || requests < 1 || requests > REQUESTS_MAX) throw new Error(`USAGE: --requests must be an integer from 1 to ${REQUESTS_MAX}`);
  const nodeOptions = v['node-options'] ?? null;
  if (nodeOptions !== null && (nodeOptions.length > NODE_OPTIONS_MAX || !/^[\x20-\x7e]+$/.test(nodeOptions))) {
    throw new Error(`USAGE: --node-options must be 1 to ${NODE_OPTIONS_MAX} printable ASCII characters`);
  }
  const base = env['INIT_CWD'] !== undefined && env['INIT_CWD'] !== '' ? env['INIT_CWD'] : cwd;
  return {
    zip: path.resolve(base, v.zip),
    db: v.db as TestEngine,
    modes: PHASE2_MODES.filter((m) => asked.includes(m)),
    scale,
    requests,
    keep: v.keep === true,
    assert: v.assert === true,
    nodeOptions,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The run

const say = (line: string): void => void process.stderr.write(`perf-phase2: ${line}\n`);
const IS_WINDOWS = process.platform === 'win32';
/** How often an RSS is sampled while something runs. */
const RSS_SAMPLE_MS = 250;
/** The longest a CLI command (reindex, migration) or an import may take. */
const LONG_RUN_MS = 6 * 3_600_000;
/** How long one request of the mix may take. */
const REQUEST_TIMEOUT_MS = 60_000;
/** The records, barcodes, agents and subjects the mix draws from. */
const SAMPLE_SIZE = 500;

/** RSS (MB) of `pid`'s descendants (and `pid` itself with `withRoot`), or null on Windows. */
async function treeRss(pid: number, logDir: string, withRoot: boolean): Promise<number | null> {
  if (IS_WINDOWS) return null;
  const table = await psTable(logDir);
  const pids = [...(withRoot && table.has(pid) ? [pid] : []), ...descendantsOf(table, pid)];
  return toMb(pids.reduce((kib, p) => kib + (table.get(p)?.rssKb ?? 0), 0));
}

/** Samples treeRss every RSS_SAMPLE_MS until stopped; the highest sample (null on Windows or with none). */
function rssSampler(pid: () => number | undefined, logDir: string, withRoot: boolean): { stop(): Promise<number | null> } {
  let peak: number | null = null;
  let running = true;
  const loop = (async () => {
    while (running) {
      const p = pid();
      if (p !== undefined) {
        const rss = await treeRss(p, logDir, withRoot).catch(() => null);
        if (rss !== null && rss > 0) peak = Math.max(peak ?? 0, rss);
      }
      await sleep(RSS_SAMPLE_MS);
    }
  })();
  return {
    async stop() {
      running = false;
      await loop;
      return IS_WINDOWS ? null : peak;
    },
  };
}

/** `line` parsed as a JSON object, or null. */
function lastJson(line: string | undefined): Record<string, unknown> | null {
  if (line === undefined) return null;
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Runs `c` to its end while its RSS is sampled: exit code, duration, highest RSS, and the last JSON line it printed. */
async function runSampled(c: Command, logDir: string, timeoutMs = LONG_RUN_MS): Promise<{ code: number | null; ms: number; rssMb: number | null; json: Record<string, unknown> | null }> {
  const t0 = performance.now();
  const proc = startProcess(c, logDir);
  const sampler = rssSampler(() => proc.child.pid, logDir, true);
  const exited = new Promise<number | null>((resolve) => proc.child.once('exit', (code) => resolve(code)));
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => (timer = setTimeout(() => resolve('timeout'), timeoutMs)));
  const result = await Promise.race([exited, timeout]);
  clearTimeout(timer);
  const ms = Math.round(performance.now() - t0);
  const rssMb = await sampler.stop();
  if (result === 'timeout') {
    await stopTracked(proc);
    throw new SmokeError(`${c.label}: no end after ${timeoutMs} ms`);
  }
  const log = await fsp.readFile(path.join(logDir, `${c.label}.log`), 'utf8');
  const line = log.trim().split('\n').reverse().find((l) => l.startsWith('{'));
  return { code: result, ms, rssMb, json: lastJson(line) };
}

/** A fresh install of the zip (see the top of this file). */
interface Install {
  root: string;
  appRoot: string;
  dataDir: string;
  logDir: string;
  db: DbConfig;
  port: number;
  admin: { username: string; password: string };
  env: Record<string, string>;
}

async function install(o: RunOptions, zip: Buffer, label: string, cleanups: (() => Promise<void>)[]): Promise<Install> {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), `altis-perf-phase2-${label}-`)));
  if (o.keep) say(`keeping ${root} (--keep)`);
  else cleanups.push(() => fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const appRoot = path.join(root, 'app');
  const dataDir = path.join(root, 'altis-data');
  const logDir = path.join(root, 'logs');
  await fsp.mkdir(logDir);
  await extractZip(zip, appRoot);
  await fsp.mkdir(dataDir, { mode: 0o700 });
  const db = await provisionDb(o.db, `p2${label}_${randomBytes(4).toString('hex')}`, (drop) => void (o.keep ? undefined : cleanups.push(drop)));
  const port = await freePort();
  const admin = newSmokeAdmin();
  const installFile = path.join(root, 'install.json');
  writePrivateFile(installFile, `${JSON.stringify({ baseUrl: `http://127.0.0.1:${port}`, db, admin })}\n`);
  const env = { ...baseEnv(), ALTIS_DATA_DIR: dataDir };
  say(`${label}: install (${o.db})…`);
  await mustRun({ label: 'install', file: process.execPath, args: ['app.js', 'install', '--config', installFile], cwd: appRoot, env }, logDir);
  await fsp.rm(installFile, { force: true });
  // After the install: what the server and the commands run with (a V8 heap policy to try, --node-options).
  const runEnv = o.nodeOptions === null ? env : { ...env, NODE_OPTIONS: o.nodeOptions };
  return { root, appRoot, dataDir, logDir, db, port, admin: { username: admin.username, password: admin.password }, env: runEnv };
}

/** `node app.js` of the install, trusting one proxy hop (each OPAC request then is the visitor its X-Forwarded-For names). */
function startServer(i: Install, label: string): TrackedProcess {
  return startProcess({ label, file: process.execPath, args: ['app.js'], cwd: i.appRoot, env: { ...i.env, ALTIS_PORT: String(i.port), ALTIS_TRUST_PROXY_HOPS: '1' } }, i.logDir);
}

const openDb = (i: Install): Promise<DbHandle> => connect(i.db, { runtime: 'standalone', purpose: 'cli', dataDir: i.dataDir });

/** The installation's first live branch. */
async function firstBranch(h: DbHandle): Promise<{ id: string; code: string }> {
  const b = await h.db.selectFrom('branches').select(['id', 'code_display']).where('archived_at', 'is', null).orderBy('created_at').orderBy('id').limit(1).executeTakeFirstOrThrow();
  return { id: b.id, code: b.code_display };
}

/** SAMPLE_SIZE of everything the mix draws from, spread evenly over the catalogue. */
async function sampleCatalog(h: DbHandle, port: number): Promise<MixSample> {
  const spread = <T>(rows: readonly T[]): T[] => {
    const step = Math.max(1, Math.floor(rows.length / SAMPLE_SIZE));
    return rows.filter((_, k) => k % step === 0).slice(0, SAMPLE_SIZE);
  };
  const records = await h.db
    .selectFrom('records as r')
    .innerJoin('material_types as m', 'm.id', 'r.material_type_id')
    .leftJoin('languages as l', 'l.id', 'r.language_id')
    .select(['r.id', 'r.title', 'm.code_key as mt', 'l.code_key as lg'])
    .where('r.archived_at', 'is', null)
    .where('r.opac_visible', '=', 1)
    .where('r.language_id', 'is not', null)
    .orderBy('r.id')
    .execute();
  const barcodes = await h.db.selectFrom('items').select('barcode_key').where('archived_at', 'is', null).orderBy('barcode_key').execute();
  const agents = await h.db.selectFrom('agents').select('name_display').where('archived_at', 'is', null).orderBy('id').execute();
  const subjects = await h.db.selectFrom('subjects').select('term_display').where('archived_at', 'is', null).orderBy('id').execute();
  const index = await httpSend(port, 'GET', '/sitemap.xml', { accept: 'application/xml' }, undefined, REQUEST_TIMEOUT_MS);
  if (index.status !== 200) throw new SmokeError(`GET /sitemap.xml → ${index.status}`);
  const files = [...index.body.matchAll(/\/sitemap\/katalog\/(\d+)/g)].map((m) => Number(m[1]));
  return {
    records: spread(records).map((r) => ({ id: r.id, title: r.title, materialTypeCode: r.mt, languageCode: r.lg! })),
    barcodes: spread(barcodes).map((b) => b.barcode_key),
    agentPrefixes: spread(agents).map((a) => a.name_display.slice(0, 4)),
    subjectTerms: spread(subjects).map((s) => s.term_display.split(' -- ')[0]!),
    sitemapFiles: files.length === 0 ? 0 : Math.max(...files),
  };
}

/** Runs the plan one request after another: samples per route, the answers that were not 200, the RSS under it. */
async function runMix(plan: readonly PlannedRequest[], port: number, admin: SmokeSession, serverPid: () => number | undefined, logDir: string) {
  const samples = new Map<Phase2Route, number[]>();
  const errors = new Map<Phase2Route, number>();
  const firstError = new Map<Phase2Route, string>();
  let next: string | null = null;
  let visitor = 0;
  const sampler = rssSampler(serverPid, logDir, false);
  let rssLoadMb: number | null;
  try {
    for (const p of plan) {
      let target = p.path;
      if (p.route === 'oai.list_records') target = next === null ? OAI_FIRST_PAGE : `/oai?${query({ verb: 'ListRecords', resumptionToken: next })}`;
      const t = performance.now();
      const reply = isAdminRoute(p.route)
        ? await admin.request('GET', target, { timeoutMs: REQUEST_TIMEOUT_MS })
        : await httpSend(port, 'GET', target, { accept: p.route === 'oai.list_records' || p.route === 'opac.sitemap.catalog' ? 'application/xml' : 'text/html', 'x-forwarded-for': visitorIp(visitor++) }, undefined, REQUEST_TIMEOUT_MS);
      const ms = performance.now() - t;
      let ok = reply.status === 200;
      if (p.route === 'oai.list_records') {
        ok &&= !/<error\b/.test(reply.body);
        next = ok ? oaiResumptionToken(reply.body) : null;
      }
      (samples.get(p.route) ?? samples.set(p.route, []).get(p.route)!).push(ms);
      if (!ok) {
        errors.set(p.route, (errors.get(p.route) ?? 0) + 1);
        if (!firstError.has(p.route)) firstError.set(p.route, `${target} → ${reply.status} ${problemCode(reply.body) || reply.body.slice(0, 120)}`);
      }
    }
  } finally {
    rssLoadMb = await sampler.stop();
  }
  return { samples, errors, firstError, rssLoadMb };
}

/** `files/uploads` of `context`: declared, sent in the chunks the server fixed (multipart, read from disk), completed. */
async function uploadFile(s: SmokeSession, port: number, context: string, file: string): Promise<string> {
  const size = (await fsp.stat(file)).size;
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
  const created = await s.call<{ id: string; chunkSize: number; chunks: number }>('POST', 'files/uploads', { context, size, sha256: hash.digest('hex') });
  const handle = await fsp.open(file, 'r');
  try {
    for (let n = 0; n < created.chunks; n += 1) {
      const length = Math.min(created.chunkSize, size - n * created.chunkSize);
      const chunk = Buffer.alloc(length);
      await handle.read(chunk, 0, length, n * created.chunkSize);
      const boundary = `----altis-perf-${randomBytes(8).toString('hex')}`;
      const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="chunk"; filename="chunk"\r\nContent-Type: application/octet-stream\r\n\r\n`);
      const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
      const body = Buffer.concat([head, chunk, tail]);
      const headers = { ...s.headers(true), 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(body.length) };
      const reply = await httpSend(port, 'POST', `/api/v1/files/uploads/${created.id}/chunks/${n}`, headers, body, 120_000);
      s.take(reply.headers);
      if (reply.status !== 200) throw new SmokeError(`chunk ${n} of ${path.basename(file)} → ${reply.status} ${problemCode(reply.body)}`);
    }
  } finally {
    await handle.close();
  }
  await s.call('POST', `files/uploads/${created.id}/complete`, { originalName: path.basename(file) });
  return created.id;
}

const round1 = (v: number | null): number | null => (v === null ? null : Math.round(v * 10) / 10);

/** Mode `opac` (see the top of this file). */
async function runOpac(o: RunOptions, zip: Buffer, counts: PerfCounts, m: Phase2Measurements, details: Record<string, unknown>, cleanups: (() => Promise<void>)[]): Promise<void> {
  const i = await install(o, zip, 'opac', cleanups);
  say(`opac: seed ${PERF_PHASE2_SEED.name} (${counts.records} records, ${counts.items} items)…`);
  const h = await openDb(i);
  try {
    const seeded = await seedPhase2(h, { counts, dataDir: i.dataDir, say });
    details['seedMs'] = seeded.ms;
  } finally {
    await h.close();
  }
  say(`opac: seeded in ${Math.round(Number(details['seedMs']) / 1000)} s; catalog:reindex…`);
  const reindex = await runSampled({ label: 'reindex', file: process.execPath, args: ['app.js', 'catalog:reindex', '--json'], cwd: i.appRoot, env: i.env }, i.logDir);
  if (reindex.code !== 0) throw new SmokeError(`catalog:reindex failed with exit code ${String(reindex.code)} (log: reindex.log)`);
  m.reindexMs = reindex.ms;
  m.rssReindexMb = reindex.rssMb;
  details['reindex'] = reindex.json;
  say(`opac: reindex ${Math.round(reindex.ms / 1000)} s, RSS ${String(reindex.rssMb)} MB`);

  const t0 = performance.now();
  const proc = startServer(i, 'server');
  cleanups.push(() => stopTracked(proc));
  const healthy = await waitHealthy(i.port, HEALTH_TIMEOUT_MS, proc.alive);
  m.coldStartMs = Math.round(healthy.at - t0);
  await sleep(RSS_SAMPLE_DELAY_MS);
  m.rssIdleMb = IS_WINDOWS ? null : await treeRss(proc.child.pid!, i.logDir, false);
  say(`opac: cold start ${m.coldStartMs} ms, idle RSS ${String(m.rssIdleMb)} MB`);

  const admin = new SmokeSession(i.port);
  await admin.signIn(i.admin.username, i.admin.password);
  await admin.call('PUT', 'settings/opac', { oai: { adminEmail: 'perf@perpustakaan.test' } });
  const h2 = await openDb(i);
  let sample: MixSample;
  try {
    sample = await sampleCatalog(h2, i.port);
  } finally {
    await h2.close();
  }
  const plan = planMix(sample, { perRoute: o.requests, seed: 20261102 });
  say(`opac: the mix, ${plan.length} requests…`);
  const run = await runMix(plan, i.port, admin, () => proc.child.pid, i.logDir);
  const p50: Record<string, number | null> = {};
  for (const route of [...OPAC_ROUTES, ...ADMIN_ROUTES]) {
    const s = run.samples.get(route) ?? [];
    m.p95Ms[route] = round1(p95(s));
    const sorted = [...s].sort((a, b) => a - b);
    p50[route] = sorted.length === 0 ? null : round1(sorted[Math.ceil(0.5 * sorted.length) - 1]!);
    m.errors[route] = run.errors.get(route) ?? 0;
    say(`opac: p95 ${route} ${String(m.p95Ms[route])} ms (p50 ${String(p50[route])})${m.errors[route] > 0 ? `, ${m.errors[route]} errors (${run.firstError.get(route)!})` : ''}`);
  }
  details['p50Ms'] = p50;
  if (run.firstError.size > 0) details['firstErrors'] = Object.fromEntries(run.firstError);
  m.rssLoadMb = run.rssLoadMb;
  say(`opac: RSS under the mix ${String(m.rssLoadMb)} MB`);
  await stopTracked(proc);
}

/** Mode `import` (see the top of this file). */
async function runImport(o: RunOptions, zip: Buffer, counts: PerfCounts, m: Phase2Measurements, details: Record<string, unknown>, cleanups: (() => Promise<void>)[]): Promise<void> {
  const i = await install(o, zip, 'import', cleanups);
  const h = await openDb(i);
  let branch: { id: string; code: string };
  try {
    branch = await firstBranch(h);
  } finally {
    await h.close();
  }
  const file = path.join(i.root, 'perf-phase2.xml');
  const bytes = await writePerfMarcXml(file, counts, [branch.code, branch.code]);
  details['importFileBytes'] = bytes;
  say(`import: ${counts.records} records in MARCXML (${Math.round(bytes / 1_048_576)} MiB)`);
  const proc = startServer(i, 'server');
  cleanups.push(() => stopTracked(proc));
  await waitHealthy(i.port, HEALTH_TIMEOUT_MS, proc.alive);
  const admin = new SmokeSession(i.port);
  await admin.signIn(i.admin.username, i.admin.password);
  const uploadId = await uploadFile(admin, i.port, 'catalog.import', file);
  await fsp.rm(file, { force: true });
  const sampler = rssSampler(() => proc.child.pid, i.logDir, false);
  const t0 = performance.now();
  let run: { status: string; summary: Record<string, unknown> | null };
  try {
    const started = await admin.call<{ runId: string; jobId: string }>('POST', 'catalog/imports', {
      uploadId,
      format: 'marcxml',
      matchOn: 'isbn',
      onMatch: 'skip',
      onDuplicate: 'report',
      createItems: true,
      branchId: branch.id,
      dryRun: false,
    });
    let last = -1;
    for (;;) {
      run = await admin.call<{ status: string; summary: Record<string, unknown> | null }>('GET', `catalog/runs/${started.runId}`);
      if (run.status !== 'queued' && run.status !== 'running') break;
      if (performance.now() - t0 > LONG_RUN_MS) throw new SmokeError(`the import did not end within ${LONG_RUN_MS} ms`);
      const read = Number(run.summary?.['read'] ?? 0);
      if (read - last >= 10_000) {
        say(`import: ${read} records read`);
        last = read;
      }
      await sleep(2000);
    }
  } finally {
    m.rssImportMb = await sampler.stop();
  }
  m.importMs = run.status === 'succeeded' ? Math.round(performance.now() - t0) : null;
  details['import'] = { status: run.status, summary: run.summary };
  if (run.status !== 'succeeded') throw new SmokeError(`the import ended ${run.status}`);
  say(`import: ${Math.round(m.importMs! / 1000)} s, server RSS up to ${String(m.rssImportMb)} MB`);
  await stopTracked(proc);
}

/** Mode `migrate` (see the top of this file). */
async function runMigrate(o: RunOptions, zip: Buffer, counts: PerfCounts, m: Phase2Measurements, details: Record<string, unknown>, cleanups: (() => Promise<void>)[]): Promise<void> {
  const i = await install(o, zip, 'migrate', cleanups);
  const file = path.join(i.root, 'slims-perf.sql');
  const bytes = await writePerfSlimsDump(file, counts);
  details['migrateDumpBytes'] = bytes;
  say(`migrate: ${counts.records} biblio in a SLiMS dump (${Math.round(bytes / 1_048_576)} MiB); slims:import…`);
  const r = await runSampled({ label: 'slims-import', file: process.execPath, args: ['app.js', 'slims:import', '--dump', file, '--json'], cwd: i.appRoot, env: i.env }, i.logDir);
  details['migrate'] = r.json;
  if (r.code !== 0) throw new SmokeError(`slims:import failed with exit code ${String(r.code)} (log: slims-import.log)`);
  m.migrateMs = r.ms;
  m.rssMigrateMb = r.rssMb;
  say(`migrate: ${Math.round(r.ms / 1000)} s, RSS up to ${String(r.rssMb)} MB`);
}

/** One run (see the top of this file). Never throws for a failure of the run: it is in `failures`. */
export async function runPhase2(o: RunOptions): Promise<Phase2Report> {
  const counts = perfCounts(o.scale);
  const m = emptyMeasurements();
  const details: Record<string, unknown> = {};
  const failures: string[] = [];
  const asserted = o.assert || budgetsApply();
  const zip = await fsp.readFile(o.zip);
  m.zipBytes = zip.length;
  if (o.nodeOptions !== null) details['nodeOptions'] = o.nodeOptions;
  const modes: Record<Phase2Mode, typeof runOpac> = { opac: runOpac, import: runImport, migrate: runMigrate };
  for (const mode of o.modes) {
    const cleanups: (() => Promise<void>)[] = [];
    try {
      await modes[mode](o, zip, counts, m, details, cleanups);
    } catch (error) {
      failures.push(`${mode}: ${messageOf(error)}`);
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
  }
  const judged = evaluatePhase2(m, o.modes);
  if (asserted) failures.push(...judged.failures);
  else if (!judged.ok) say(`budgets not asserted on ${process.platform}-${process.arch} (Linux x64 only, or --assert); would fail: ${judged.failures.join('; ')}`);
  return { db: o.db, node: process.version, seed: PERF_PHASE2_SEED.name, counts, modes: o.modes, measurements: m, details, budgetsAsserted: asserted, failures };
}

async function main(argv: string[]): Promise<number> {
  let options: RunOptions;
  try {
    options = parseRunArgs(argv);
  } catch (error) {
    process.stderr.write(`perf-phase2: ${messageOf(error)}\nusage: pnpm exec tsx tools/test/perf-phase2/run.ts --zip <altis-x.y.z.zip> --db <engine> [--mode opac,import,migrate] [--scale <0..2>] [--requests <n>] [--keep] [--assert] [--node-options=<flags>]\n`);
    return 2;
  }
  const report = await runPhase2(options);
  for (const failure of report.failures) say(`FAILED: ${failure}`);
  await new Promise<void>((resolve) => process.stdout.write(formatPhase2Report(report), () => resolve()));
  return report.failures.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => process.stderr.write('', () => process.exit(code)),
    (error: unknown) => {
      process.stderr.write(`perf-phase2: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      process.stderr.write('', () => process.exit(1));
    },
  );
}
