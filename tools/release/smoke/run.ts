#!/usr/bin/env tsx
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { DbConfig } from '@altis/db';
import type { LoginResponse, MeResponse } from '@altis/shared/api/auth';
import type { BackupCreateResponse, BackupListResponse } from '@altis/shared/api/backups';
import {
  PROBE_SSE_INTERVAL_MS,
  PROBE_SSE_TICKS,
  XFF_PROBE_FORGED,
  type ProbePollResponse,
  type ProbeResultBody,
  type ProbeResultResponse,
  type RealtimeResponse,
} from '@altis/shared/api/diagnostics';
import type { EventItem, EventsResponse } from '@altis/shared/api/events';
import type { JobView } from '@altis/shared/api/jobs';
import {
  ENGINE_SPECS,
  TEST_DB_PASSWORD,
  TEST_DB_ROOT_PASSWORD,
  TEST_DB_USER,
  TEST_ENGINES,
  testDbHost,
  type TestEngine,
} from '@altis/test-tools';
import mysql from 'mysql2';
import pg from 'pg';
import { extractZip } from '../src/zip.js';

// The artifact smoke test (spec §12.1 "Artefak", §13.2 exit check of 1a; Task 19):
//
//   pnpm smoke --zip <altis-x.y.z.zip> --target passenger-sim|pm2|docker|standalone --db <engine> [--max-pool <n>]
//              [--scenario cron-backup|piggyback|cron-cli|polling-progress|sse-progress|xff]
//   pnpm smoke --zip <N−1 zip> --to-zip <N zip> [--to-zip <N+1 zip>] [--feed <dir>] --target <t> --db <engine>
//              --scenario update|update-faults|update-kill|rollback-restore|rollback-manual|update-offline|rejections|
//                         docker-pull|zip-reupload
//              (1d Task 35: the update scenarios of update-scenarios.ts, UPDATE_SCENARIOS and UPDATE_SCENARIO_TARGETS)
//
// <engine> is one of the test engines of tools/test/compose.yml (sqlite, mysql80, mysql84, mariadb106, mariadb114,
// pg15, pg17); passenger-sim never runs on SQLite (P20: SQLITE_NOT_ALLOWED). --max-pool is passenger-sim's (default 3,
// nightly 6). The zip path is taken from where pnpm was run (INIT_CWD).
//
// What a run does:
//   1. unzips the release into a fresh temp folder `<tmp>/app` (the appRoot; never inside a public_html) and creates
//      DATA_DIR as its sibling `<tmp>/altis-data`;
//   2. database: SQLite in DATA_DIR; a server engine gets a new database `altis_smoke_<id>` on the tools/test/compose.yml
//      service (created as root/superuser like tools/test/global-setup.ts, dropped at the end); Docker brings its own
//      database service (docker/compose.yml, or a generated override for the engines other than MariaDB 10.6);
//   3. writes the install input (baseUrl http://127.0.0.1:<port>, the database, the first super admin with a random
//      password, never printed; host targets: mode 0600) and runs the headless install
//      `node app.js install --config <file>`, under the runtime of the target (ALTIS_RUNTIME passenger/pm2; Docker's
//      image says docker);
//   4. starts the target and measures:
//      - standalone: `node app.js` (app.js supervises the server process it forks);
//      - pm2: `pm2 start ecosystem.config.cjs` (pm2 through `npx --yes pm2@<PM2_VERSION>`, never installed globally;
//        its own PM2_HOME in the temp folder, so the user's pm2 daemon is never touched);
//      - passenger-sim: tools/release/passenger-sim pointed at the appRoot (workers spawned per request, idle-ms
//        PASSENGER_IDLE_MS);
//      - docker: `docker compose -f docker/compose.yml` with the unzipped zip as the `release` build context, a
//        generated .env (random passwords and the engine's database for the app's ALTIS_DB_*, mode 0600, in the temp
//        folder; never printed), install through
//        `docker compose run --rm app node /app/app.js install --config /data/install.json`, then `up`;
//      coldStartMs = from the spawn of the server process to the first 200 of /_health ({"status":"ok"}): standalone
//      from `node app.js`; pm2 from pm2's start of the process (pm_uptime); docker from the container's StartedAt;
//      passenger-sim: a first request boots a worker, the smoke waits until idle-ms has stopped it, and measures the
//      first request after that (a worker spawned by a request: what a visitor meets after an idle period);
//      rssIdleMb = RSS of the process that serves (standalone: the supervised server process, not the supervisor;
//      pm2: the app process; passenger-sim: the worker; docker: the node process of the container), sampled
//      RSS_SAMPLE_DELAY_MS after healthy with `ps -o rss=` (docker: `docker top`); null on Windows (not asserted);
//   5. stops everything, drops the database, removes the temp folder (and, for Docker, the volumes and the image).
//
// Output: one JSON line on stdout {target, db, node, zipBytes, coldStartMs, rssIdleMb, healthOk, budgetsAsserted};
// progress and diagnostics on stderr. Exit 0 when healthy (and, on Linux x64, within budget: cold start < 1.5 s, idle
// RSS < 150 MB); 1 otherwise; 2 for a usage error (USAGE, SQLITE_NOT_ALLOWED). On any other platform the budgets are
// reported, not asserted (`budgetsAsserted: false`).
//
// Scenarios (1c Task 34; acceptance A5, A6, A9 on a cPanel-like host): `--scenario <name>`, passenger-sim only (its
// workers run in the `external` runner mode: no timer, the work done by /_cron, `jobs:run`, drive and piggyback; and
// it appends the peer to X-Forwarded-For like a real proxy), never on SQLite (P20). After the measurements above,
// passenger-sim is started again on the same port with Passenger's default pool idle time (300 s,
// PASSENGER_SCENARIO_IDLE_MS: a worker outlives the 31 s between two cron calls), and the scenario runs against the
// same install, signed in as its first super admin over node:http (a cookie jar, the CSRF
// token of `GET auth/me`, the install's Origin on writes), and the report line gains `scenario`, `scenarioOk` and
// `scenarioDetail` (what it saw):
//
//   cron-backup       A6: `POST backups` (no runner recorded: a frozen backup, maintenance on), then only the panel's
//                     cron line, `curl -fsS -X POST -H "Authorization: Bearer <cronToken>" <baseUrl>/_cron`, every 31 s
//                     (the single-flight lease is 30 s): no Origin, no cookie, no page → the op ends `done`,
//                     DATA_DIR/ops/maintenance.json is gone, and the backup is listed `ok`, `frozen`.
//   piggyback         A5: `test.jobs.enqueue` of a 3-slice `test.slices` job, then plain page views only (`GET /`,
//                     `GET /admin/login`, and the job's own page `GET jobs/:id`), never /_cron or `jobs:run` → the job
//                     succeeds (one piggyback slice per process at most every 30 s, §10.2).
//   cron-cli          A5: a 3-slice job, then `node app.js jobs:run` once → the job succeeded.
//   polling-progress  A9: `jobs:run --budget 1` once (a recorded cron_cli run: the manual backup is a snapshot), then
//                     `GET events?channels=system.backup` every second while `jobs:run --budget 1` runs the backup →
//                     the `backup.progress` hints of the snapshot job (S24) and its `backup.done`. The first slice of
//                     a 1 s pass gets no time beyond one unit of export work, so the job continues as a large
//                     database's would, and its continued slices publish the hints.
//   sse-progress      A9: the browser test of SSE through passenger-sim (`GET diagnostics/probe/sse`: three ticks spread
//                     over ≥ 1 s), its result posted (`POST diagnostics/probe-result`, sse: true), `PUT
//                     diagnostics/realtime {sse: true}` (off by default on Passenger), then `GET events/stream` (one
//                     stream after the other, each ending within 25 s, resumed with Last-Event-ID) receives the hints of
//                     a backup run as in polling-progress.
//   xff               A9, P15: `node app.js config:set trustProxy.hops <n>`, then a poll (`GET diagnostics/probe/poll`)
//                     with a forged `X-Forwarded-For: 203.0.113.77`, to which passenger-sim appends the real peer: with
//                     hops 1 the client IP is the peer and `POST diagnostics/probe-result` finds nothing spoofable;
//                     with hops 2 the forged entry is the client IP and the result is `spoofable`; with hops 0 every
//                     visitor is the local proxy (`collapsed`). The hops go back to 1 at the end.

export const TARGETS = ['passenger-sim', 'pm2', 'docker', 'standalone'] as const;
export type Target = (typeof TARGETS)[number];

/** Global Constraints (CI Linux x64): cold start to a healthy answer < 1.5 s, idle RSS < 150 MB. Strict bounds. */
export const BUDGETS = Object.freeze({ coldStartMs: 1500, rssIdleMb: 150 });
/** RSS is sampled this long after the first healthy answer. */
export const RSS_SAMPLE_DELAY_MS = 10_000;
/** How long a target may take to answer /_health with 200 (Passenger's own start timeout is 90 s). */
export const HEALTH_TIMEOUT_MS = 90_000;
/** passenger-sim's idle-ms for the smoke: longer than the RSS sample delay, so the sampled worker is still there. */
export const PASSENGER_IDLE_MS = 12_000;
/** passenger-sim's max-pool when --max-pool is not given (spec §12.2: PR 3, nightly 6). */
export const PASSENGER_MAX_POOL = 3;
/**
 * passenger-sim's idle-ms while a scenario runs: Passenger's own default pool idle time (PassengerPoolIdleTime, 300 s).
 * A worker started by one cron call is still there for the next one, 31 s later, as on a host with that default; with
 * the measurement's 12 s every call would meet a worker still loading its release, which app.js answers with 503
 * "starting" (the curl line has no retry).
 */
export const PASSENGER_SCENARIO_IDLE_MS = 300_000;
/** The pm2 release the smoke runs (through npx: an exact version, never a global install). */
export const PM2_VERSION = '7.0.4';
/** The database images of the Docker smoke, per engine (the same images as tools/test/compose.yml). */
export const DOCKER_DB_IMAGES: Readonly<Record<Exclude<TestEngine, 'sqlite'>, string>> = Object.freeze({
  mysql80: 'mysql:8.0',
  mysql84: 'mysql:8.4',
  mariadb106: 'mariadb:10.6',
  mariadb114: 'mariadb:11.4',
  pg15: 'postgres:15',
  pg17: 'postgres:17',
});

export const TOOL_DIR = path.resolve(import.meta.dirname, '..');
export const REPO_ROOT = path.resolve(TOOL_DIR, '..', '..');
export const SIM_TS = path.join(TOOL_DIR, 'passenger-sim', 'sim.ts');
export const DOCKER_DIR = path.join(REPO_ROOT, 'docker');
export const COMPOSE_FILE = path.join(DOCKER_DIR, 'compose.yml');

const IS_WINDOWS = process.platform === 'win32';
const POLL_MS = 20;
const STOP_GRACE_MS = 15_000;
const CONNECT_TIMEOUT_MS = 5000;
const SIM_LISTEN_TIMEOUT_MS = 30_000;
const COMMAND_TIMEOUT_MS = 10 * 60_000;
/** The Docker database: user and schema `altis` (docker/compose.yml); the password is ALTIS_DB_PASSWORD. */
const DOCKER_DB_NAME = 'altis';

export const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A failure of the run (not a usage error): reported, exit 1. */
export class SmokeError extends Error {
  override name = 'SmokeError';
}

// ---------------------------------------------------------------------------------------------------------------
// Command line

/** The scenarios of `--scenario` (see the top of this file; 1c Task 34). */
export const SCENARIOS = ['cron-backup', 'piggyback', 'cron-cli', 'polling-progress', 'sse-progress', 'xff'] as const;
export type Scenario = (typeof SCENARIOS)[number];

/** The scenarios of the PR tier (§13.2 CI: "the two passenger-sim scenarios"); the nightly tier runs them all. */
export const PR_SCENARIOS: readonly Scenario[] = Object.freeze(['cron-backup', 'piggyback'] as const);

/**
 * 1d Task 35 (A7, A9, §12.7): the update scenarios of tools/release/smoke/update-scenarios.ts, which update the install
 * of `--zip` (release N−1) to `--to-zip` (release N) through a signed feed (tools/release/feed: buildFeed, feed-dev).
 * See update-scenarios.ts for what each one does and asserts.
 */
export const UPDATE_SCENARIOS = [
  'update',
  'update-faults',
  'update-kill',
  'rollback-restore',
  'rollback-manual',
  'update-offline',
  'rejections',
  'docker-pull',
  'zip-reupload',
] as const;
export type UpdateScenario = (typeof UPDATE_SCENARIOS)[number];

/** Every scenario `--scenario` takes: the six of 1c, then the update scenarios. */
export const ALL_SCENARIOS = Object.freeze([...SCENARIOS, ...UPDATE_SCENARIOS] as const);
export type AnyScenario = Scenario | UpdateScenario;

/**
 * Where each update scenario runs. The four A1 environments for most (passenger-sim never on SQLite, P20);
 * `update-kill` is Passenger's own (6 concurrent spawns, workers killed when idle); `docker-pull` updates by a new
 * image (on standalone by the zip unpacked over the app folder: the same boot path, proven without Docker);
 * `zip-reupload` replaces the app folder of a standalone install.
 */
export const UPDATE_SCENARIO_TARGETS: Readonly<Record<UpdateScenario, readonly Target[]>> = Object.freeze({
  update: TARGETS,
  'update-faults': TARGETS,
  'update-kill': ['passenger-sim'],
  'rollback-restore': TARGETS,
  'rollback-manual': TARGETS,
  'update-offline': TARGETS,
  rejections: TARGETS,
  'docker-pull': ['docker', 'standalone'],
  'zip-reupload': ['standalone'],
});

/** How many `--to-zip` a scenario takes: docker-pull two (image 0.2, then image 0.3), the others one. */
export const updateScenarioZips = (scenario: UpdateScenario): number => (scenario === 'docker-pull' ? 2 : 1);

/**
 * passenger-sim's idle time while an update scenario runs (A7 "passenger-sim tanpa cron", Review Focus 4): Passenger
 * stops a worker that served nothing for 5 s, so the update must survive its workers coming and going.
 */
export const UPDATE_SIM_IDLE_MS = 5000;

/** §12.7: an update 0.1 → 0.2 on passenger-sim without cron, from apply to `done`, in < 2 minutes. */
export const UPDATE_DONE_BUDGET_MS = 120_000;

export interface SmokeOptions {
  /** Absolute path of the release zip. */
  zip: string;
  target: Target;
  db: TestEngine;
  /** passenger-sim's max-pool. */
  maxPool: number;
  /** What runs after the measurements; null: nothing. */
  scenario: AnyScenario | null;
  /** The releases an update scenario updates to (absolute paths, in order); empty otherwise. */
  toZips: string[];
  /**
   * An update scenario's feed folder (`feed:build` output, absolute) that feed-dev serves instead of the feed the run
   * builds from `toZips`; null: the run builds its own.
   */
  feed: string | null;
}

const isTarget = (value: string): value is Target => (TARGETS as readonly string[]).includes(value);
const isEngine = (value: string): value is TestEngine => (TEST_ENGINES as readonly string[]).includes(value);
/** 1d Task 35: whether `value` names a tools/test/compose.yml engine (tools/e2e takes one in ALTIS_E2E_DB). */
export const isTestEngine = isEngine;
const isScenario = (value: string): value is Scenario => (SCENARIOS as readonly string[]).includes(value);
export const isUpdateScenario = (value: string | null): value is UpdateScenario => value !== null && (UPDATE_SCENARIOS as readonly string[]).includes(value);

/**
 * The options of `pnpm smoke …` (see the top of this file).
 *
 * @throws Error `USAGE: …`; `SQLITE_NOT_ALLOWED: …` for passenger-sim + sqlite (P20)
 */
export function parseSmokeArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): SmokeOptions {
  const args = argv[0] === '--' ? argv.slice(1) : [...argv];
  let values: Record<string, string | string[] | undefined>;
  try {
    values = parseArgs({
      args,
      strict: true,
      allowPositionals: false,
      options: {
        zip: { type: 'string' },
        target: { type: 'string' },
        db: { type: 'string' },
        'max-pool': { type: 'string' },
        scenario: { type: 'string' },
        'to-zip': { type: 'string', multiple: true },
        feed: { type: 'string' },
      },
    }).values as Record<string, string | string[] | undefined>;
  } catch (error) {
    throw new Error(`USAGE: ${messageOf(error)}`, { cause: error });
  }
  const one = (name: string): string | undefined => {
    const value = values[name];
    return Array.isArray(value) ? value[0] : value;
  };
  const zip = one('zip');
  if (zip === undefined || zip === '') throw new Error('USAGE: --zip <altis-x.y.z.zip> is required');
  const target = one('target');
  if (target === undefined || !isTarget(target)) throw new Error(`USAGE: --target must be one of ${TARGETS.join(', ')}`);
  const db = one('db');
  if (db === undefined || !isEngine(db)) throw new Error(`USAGE: --db must be one of ${TEST_ENGINES.join(', ')}`);
  const toZips = (values['to-zip'] as string[] | undefined) ?? [];
  const feed = one('feed');
  let scenario: AnyScenario | null = null;
  const rawScenario = one('scenario');
  if (rawScenario !== undefined) {
    if (isUpdateScenario(rawScenario)) {
      // 1d Task 35: SQLite only where the target allows it (P20); the target, then the releases to update to.
      if (target === 'passenger-sim' && db === 'sqlite') {
        throw new Error(`SQLITE_NOT_ALLOWED: --scenario ${rawScenario} on passenger-sim needs MySQL, MariaDB or PostgreSQL: Passenger runs several worker processes (P20)`);
      }
      const targets = UPDATE_SCENARIO_TARGETS[rawScenario];
      if (rawScenario === 'update-kill' && db === 'sqlite') {
        throw new Error('SQLITE_NOT_ALLOWED: --scenario update-kill runs on passenger-sim, whose several worker processes never share a SQLite file (P20)');
      }
      if (!targets.includes(target)) throw new Error(`USAGE: --scenario ${rawScenario} runs on ${targets.join(', ')} only`);
      const wanted = updateScenarioZips(rawScenario);
      if (toZips.length === 0) {
        throw new Error(`USAGE: --scenario ${rawScenario} needs --to-zip <altis-N.zip>${wanted === 2 ? ' twice' : ''} (the release to update to)`);
      }
      if (toZips.length !== wanted) {
        throw new Error(wanted === 2 ? `USAGE: --scenario ${rawScenario} needs --to-zip twice (image N, then image N+1)` : `USAGE: --scenario ${rawScenario} takes one --to-zip`);
      }
      if (toZips.some((z) => z === '')) throw new Error('USAGE: --to-zip needs a file');
      scenario = rawScenario;
    } else {
      if (!isScenario(rawScenario)) throw new Error(`USAGE: --scenario must be one of ${ALL_SCENARIOS.join(', ')}`);
      // Before the target: whatever the target given, a scenario is a Passenger host's, which never runs SQLite.
      if (db === 'sqlite') {
        throw new Error('SQLITE_NOT_ALLOWED: the scenarios run on passenger-sim, whose several worker processes never share a SQLite file (P20)');
      }
      if (target !== 'passenger-sim') throw new Error('USAGE: --scenario applies to --target passenger-sim only');
      scenario = rawScenario;
    }
  }
  if (!isUpdateScenario(scenario)) {
    if (toZips.length > 0) throw new Error('USAGE: --to-zip belongs to an update scenario (--scenario update, …)');
    if (feed !== undefined) throw new Error('USAGE: --feed belongs to an update scenario (--scenario update, …)');
  }
  if (feed === '') throw new Error('USAGE: --feed needs a folder');
  if (target === 'passenger-sim' && db === 'sqlite') {
    throw new Error('SQLITE_NOT_ALLOWED: Passenger runs several worker processes; its targets use MySQL, MariaDB or PostgreSQL (P20)');
  }
  let maxPool = PASSENGER_MAX_POOL;
  const rawPool = one('max-pool');
  if (rawPool !== undefined) {
    if (target !== 'passenger-sim') throw new Error('USAGE: --max-pool applies to --target passenger-sim only');
    if (!/^\d{1,4}$/.test(rawPool) || Number(rawPool) < 1 || Number(rawPool) > 1000) throw new Error('USAGE: --max-pool must be an integer from 1 to 1000');
    maxPool = Number(rawPool);
  }
  const base = env['INIT_CWD'] !== undefined && env['INIT_CWD'] !== '' ? env['INIT_CWD'] : cwd;
  return {
    zip: path.resolve(base, zip),
    target,
    db,
    maxPool,
    scenario,
    toZips: toZips.map((z) => path.resolve(base, z)),
    feed: feed === undefined ? null : path.resolve(base, feed),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Budgets and the report

export interface Measurements {
  coldStartMs: number | null;
  rssIdleMb: number | null;
}

/** The budget check: a cold start never measured fails; an RSS that could not be sampled (null) is not asserted. */
export function evaluateBudget(m: Measurements, budgets: Readonly<Record<keyof Measurements, number>> = BUDGETS): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  if (m.coldStartMs === null) failures.push('coldStartMs: not measured');
  else if (!(m.coldStartMs < budgets.coldStartMs)) failures.push(`coldStartMs ${m.coldStartMs} is over the budget (< ${budgets.coldStartMs} ms)`);
  if (m.rssIdleMb !== null && !(m.rssIdleMb < budgets.rssIdleMb)) failures.push(`rssIdleMb ${m.rssIdleMb} is over the budget (< ${budgets.rssIdleMb} MB)`);
  return { ok: failures.length === 0, failures };
}

/** The budgets are measured on CI's Linux x64 runners; anywhere else they are reported only. */
export function budgetsApply(platform: string = process.platform, arch: string = process.arch): boolean {
  return platform === 'linux' && arch === 'x64';
}

export interface SmokeReport extends Measurements {
  target: Target;
  db: TestEngine;
  /** The Node.js that ran the app (`process.version` form). */
  node: string | null;
  zipBytes: number | null;
  healthOk: boolean;
  budgetsAsserted: boolean;
  /** With `--scenario`: its name, whether it passed, and what it saw (no secret: no token, password or cookie). */
  scenario?: AnyScenario;
  scenarioOk?: boolean;
  scenarioDetail?: Record<string, unknown>;
}

/** The report as one JSON line, keys in a fixed order (the scenario's three last, only when one ran). */
export function formatReport(r: SmokeReport): string {
  const ordered: Record<string, unknown> = {
    target: r.target,
    db: r.db,
    node: r.node,
    zipBytes: r.zipBytes,
    coldStartMs: r.coldStartMs,
    rssIdleMb: r.rssIdleMb,
    healthOk: r.healthOk,
    budgetsAsserted: r.budgetsAsserted,
  };
  if (r.scenario !== undefined) {
    ordered['scenario'] = r.scenario;
    ordered['scenarioOk'] = r.scenarioOk === true;
    ordered['scenarioDetail'] = r.scenarioDetail ?? {};
  }
  return `${JSON.stringify(ordered)}\n`;
}

// ---------------------------------------------------------------------------------------------------------------
// ps

/** `ps -A -o pid=,ppid=,rss=` → pid → {ppid, rssKb}; anything that is not three integers is skipped. */
export function parsePsTable(text: string): Map<number, { ppid: number; rssKb: number }> {
  const table = new Map<number, { ppid: number; rssKb: number }>();
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (match !== null) table.set(Number(match[1]), { ppid: Number(match[2]), rssKb: Number(match[3]) });
  }
  return table;
}

/** Every descendant of `pid` (children, grandchildren, …), not `pid` itself. */
export function descendantsOf(table: ReadonlyMap<number, { ppid: number }>, pid: number): number[] {
  const found: number[] = [];
  const queue = [pid];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const [child, row] of table) {
      if (row.ppid === parent && child !== pid && !found.includes(child)) {
        found.push(child);
        queue.push(child);
      }
    }
  }
  return found;
}

export const toMb = (kib: number): number => Math.round((kib / 1024) * 10) / 10;

// ---------------------------------------------------------------------------------------------------------------
// Layout and plan

export interface SmokeLayout {
  /** The temp folder of the run; everything below is removed at the end. */
  root: string;
  /** The unzipped release (also the Docker `release` build context). */
  appRoot: string;
  /** DATA_DIR, the appRoot's sibling. */
  dataDir: string;
  /** The install input (host targets). */
  installFile: string;
  logDir: string;
  pm2Home: string;
  /** Docker: the generated .env (mode 0600) and the engine override. */
  envFile: string;
  overrideFile: string;
  /** The public port: app.js (standalone, pm2), the sim's front, or the container's published port. */
  port: number;
  /** Docker: compose project and image tag, unique per run. */
  project: string;
  image: string;
}

export function smokeLayout(root: string, port: number, id: string): SmokeLayout {
  return {
    root,
    appRoot: path.join(root, 'app'),
    dataDir: path.join(root, 'altis-data'),
    installFile: path.join(root, 'install.json'),
    logDir: path.join(root, 'logs'),
    pm2Home: path.join(root, 'pm2'),
    envFile: path.join(root, 'docker.env'),
    overrideFile: path.join(root, 'compose.override.yml'),
    port,
    project: `altis-smoke-${id}`,
    image: `altis-smoke:${id}`,
  };
}

/** One command of a plan. */
export interface Command {
  label: string;
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /** Written to the command's stdin. */
  stdin?: string;
}

export interface InstallInput {
  baseUrl: string;
  db: DbConfig;
  /** The first super admin the install requires (Task 24); the password is random per run and never printed. */
  admin: { username: string; name: string; password: string };
}

/** The smoke's first super admin: a new random password (128 bits, hex) per run. */
export function newSmokeAdmin(): InstallInput['admin'] {
  return { username: 'admin', name: 'Admin', password: randomBytes(16).toString('hex') };
}

export interface SmokePlan {
  installInput: InstallInput;
  /** Before the install, not timed (Docker: image build, database up, install.json into the volume). */
  setup: Command[];
  install: Command;
  /** Starts the server; the measurement runs from here. */
  start: Command;
  /** After the run, whatever happened (best effort). */
  teardown: Command[];
}

/** What the child processes inherit from this one: enough to run node, npx and docker, nothing of ALTIS_*. */
const PASS_ENV = [
  'PATH',
  'Path',
  'HOME',
  'USERPROFILE',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SystemRoot',
  'SYSTEMROOT',
  'ComSpec',
  'PATHEXT',
  'APPDATA',
  'LOCALAPPDATA',
  'LANG',
  'LC_ALL',
  'DOCKER_HOST',
  'DOCKER_CONTEXT',
  'DOCKER_CONFIG',
  'XDG_RUNTIME_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'npm_config_cache',
  'npm_config_registry',
];

/** The environment of every command: PASS_ENV, with this Node's folder first on PATH (pm2 runs the app with it). */
export function baseEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  // Windows: names are case-insensitive (PATH and Path are one variable); pass each one once.
  const seen = new Set<string>();
  for (const name of PASS_ENV) {
    const key = IS_WINDOWS ? name.toUpperCase() : name;
    if (env[name] === undefined || seen.has(key)) continue;
    seen.add(key);
    out[name] = env[name]!;
  }
  const pathKey = out['PATH'] === undefined && out['Path'] !== undefined ? 'Path' : 'PATH';
  out[pathKey] = [path.dirname(process.execPath), out[pathKey]].filter((p) => p !== undefined && p !== '').join(path.delimiter);
  return out;
}

/** The database settings install.json gets inside docker/compose.yml (the password comes from ALTIS_DB_PASSWORD). */
export function dockerDb(engine: TestEngine): DbConfig {
  const { dialect } = ENGINE_SPECS[engine];
  if (dialect === 'sqlite') return { dialect };
  return { dialect, host: 'db', port: dialect === 'postgres' ? 5432 : 3306, user: DOCKER_DB_NAME, database: DOCKER_DB_NAME };
}

export function composeCommand(layout: SmokeLayout, engine: TestEngine, env: Record<string, string>, label: string, args: string[], stdin?: string): Command {
  const files = ['-f', COMPOSE_FILE, ...(dockerOverrideText(engine) === null ? [] : ['-f', layout.overrideFile])];
  return {
    label,
    file: 'docker',
    args: ['compose', '--project-name', layout.project, '--env-file', layout.envFile, ...files, ...args],
    cwd: DOCKER_DIR,
    env,
    ...(stdin === undefined ? {} : { stdin }),
  };
}

const NPX = IS_WINDOWS ? 'npx.cmd' : 'npx';

export function pm2Command(layout: SmokeLayout, env: Record<string, string>, label: string, args: string[]): Command {
  return { label, file: NPX, args: ['--yes', `pm2@${PM2_VERSION}`, ...args], cwd: layout.appRoot, env: { ...env, PM2_HOME: layout.pm2Home } };
}

/** The commands of a run (see the top of this file). `db` is what the install input names. */
export function planSmoke(o: SmokeOptions, layout: SmokeLayout, db: DbConfig, env: Record<string, string> = baseEnv()): SmokePlan {
  const installInput: InstallInput = { baseUrl: `http://127.0.0.1:${layout.port}`, db, admin: newSmokeAdmin() };
  const node = process.execPath;
  const port = String(layout.port);

  if (o.target === 'docker') {
    const compose = (label: string, args: string[], stdin?: string): Command => composeCommand(layout, o.db, env, label, args, stdin);
    const run = ['run', '--rm', '-T', '--no-deps', 'app'];
    return {
      installInput,
      setup: [
        compose('docker-build', ['build', 'app']),
        ...(o.db === 'sqlite' ? [] : [compose('docker-db', ['up', '--detach', '--wait', 'db'])]),
        compose('docker-install-input', [...run, 'sh', '-c', 'cat > /data/install.json'], `${JSON.stringify(installInput)}\n`),
      ],
      install: compose('install', [...run, 'node', '/app/app.js', 'install', '--config', '/data/install.json']),
      start: compose('start', ['up', '--detach', '--no-deps', 'app']),
      teardown: [
        compose('docker-down', ['down', '--volumes', '--remove-orphans', '--timeout', '20']),
        { label: 'docker-image-rm', file: 'docker', args: ['image', 'rm', '--force', layout.image], cwd: DOCKER_DIR, env },
      ],
    };
  }

  const withData = { ...env, ALTIS_DATA_DIR: layout.dataDir };
  // The install runs under the target's runtime (P15 proxy hops, P20 SQLite); the server detects its own.
  const installRuntime: Record<string, string> =
    o.target === 'passenger-sim' ? { ALTIS_RUNTIME: 'passenger' } : o.target === 'pm2' ? { ALTIS_RUNTIME: 'pm2' } : {};
  const install: Command = {
    label: 'install',
    file: node,
    args: ['app.js', 'install', '--config', layout.installFile],
    cwd: layout.appRoot,
    env: { ...withData, ...installRuntime },
  };

  switch (o.target) {
    case 'standalone':
      return {
        installInput,
        setup: [],
        install,
        start: { label: 'start', file: node, args: ['app.js'], cwd: layout.appRoot, env: { ...withData, ALTIS_PORT: port } },
        teardown: [],
      };
    case 'pm2': {
      const pm2Env = { ...withData, ALTIS_PORT: port };
      return {
        installInput,
        setup: [],
        install,
        start: pm2Command(layout, pm2Env, 'start', ['start', 'ecosystem.config.cjs']),
        teardown: [pm2Command(layout, pm2Env, 'pm2-kill', ['kill'])],
      };
    }
    case 'passenger-sim':
      return {
        installInput,
        setup: [],
        install,
        start: {
          label: 'start',
          file: node,
          args: ['--import', 'tsx', SIM_TS, '--app', layout.appRoot, '--port', port, '--idle-ms', String(PASSENGER_IDLE_MS), '--max-pool', String(o.maxPool)],
          cwd: REPO_ROOT,
          env: withData,
        },
        teardown: [],
      };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Docker files

export interface DockerSecrets {
  dbPassword: string;
  rootPassword: string;
}

export function newDockerSecrets(): DockerSecrets {
  return { dbPassword: randomBytes(24).toString('hex'), rootPassword: randomBytes(24).toString('hex') };
}

/**
 * The .env of a Docker run (compose interpolation). Holds secrets: written with mode 0600, never printed.
 *
 * It also names `engine`'s database (dockerDb) for the app's environment, where docker/compose.yml defaults to its
 * MariaDB (`${ALTIS_DB_DIALECT-mariadb}` and the others; spec §7.7's lost-volume gate reads them): the same values the
 * install input names, and blank where it names none (SQLite: no host, port, user or schema), so the environment's
 * overrides never turn the install into another database.
 */
export function dockerEnvText(layout: SmokeLayout, secrets: DockerSecrets, engine: TestEngine): string {
  const db = dockerDb(engine);
  return [
    '# Generated by tools/release/smoke/run.ts for one smoke run; removed with its temp folder.',
    `ALTIS_RELEASE_DIR='${layout.appRoot}'`,
    `ALTIS_IMAGE=${layout.image}`,
    `ALTIS_HTTP_PORT=${layout.port}`,
    `ALTIS_DB_DIALECT=${db.dialect}`,
    `ALTIS_DB_HOST=${db.host ?? ''}`,
    `ALTIS_DB_PORT=${db.port ?? ''}`,
    `ALTIS_DB_USER=${db.user ?? ''}`,
    `ALTIS_DB_NAME=${db.database ?? ''}`,
    `ALTIS_DB_PASSWORD=${secrets.dbPassword}`,
    `ALTIS_DB_ROOT_PASSWORD=${secrets.rootPassword}`,
    '',
  ].join('\n');
}

/** Creates `file` with mode 0600 (owner only) and `text`; refuses to overwrite. */
export function writePrivateFile(file: string, text: string): void {
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, text);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(file, 0o600); // the umask may have taken bits away, never added: this is for platforms that ignore the mode
}

const HEALTH_TIMING = ['      interval: 2s', '      timeout: 5s', '      retries: 90', '      start_period: 5s'];
const REQUIRED = (name: string): string => `\${${name}:?generated by the smoke run}`;

/**
 * The compose override that replaces docker/compose.yml's MariaDB 10.6 with `engine`'s image (Docker smoke on the
 * other engines). Null for mariadb106 (the file's own) and sqlite (no database service). Never publishes a port.
 */
export function dockerOverrideText(engine: TestEngine): string | null {
  if (engine === 'sqlite' || engine === 'mariadb106') return null;
  const image = DOCKER_DB_IMAGES[engine];
  const head = [`# Generated by tools/release/smoke/run.ts: the db service on ${image} instead of mariadb:10.6.`, 'services:', '  db:', `    image: ${image}`];
  if (engine === 'mariadb114') return [...head, ''].join('\n');
  if (engine === 'mysql80' || engine === 'mysql84') {
    return [
      ...head,
      '    environment: !override',
      `      MYSQL_DATABASE: ${DOCKER_DB_NAME}`,
      `      MYSQL_USER: ${DOCKER_DB_NAME}`,
      `      MYSQL_PASSWORD: ${REQUIRED('ALTIS_DB_PASSWORD')}`,
      `      MYSQL_ROOT_PASSWORD: ${REQUIRED('ALTIS_DB_ROOT_PASSWORD')}`,
      '    healthcheck: !override',
      // TCP, not the socket: the image's init server runs with networking off, so this passes once the real one is up.
      `      test: [CMD-SHELL, 'MYSQL_PWD="$$MYSQL_PASSWORD" mysqladmin ping -h 127.0.0.1 -u ${DOCKER_DB_NAME} --silent']`,
      ...HEALTH_TIMING,
      '',
    ].join('\n');
  }
  return [
    ...head,
    '    command: !reset []',
    '    environment: !override',
    `      POSTGRES_DB: ${DOCKER_DB_NAME}`,
    `      POSTGRES_USER: ${DOCKER_DB_NAME}`,
    `      POSTGRES_PASSWORD: ${REQUIRED('ALTIS_DB_PASSWORD')}`,
    '    volumes: !override',
    '      - db:/var/lib/postgresql/data',
    '    healthcheck: !override',
    `      test: [CMD-SHELL, 'pg_isready -h 127.0.0.1 -U ${DOCKER_DB_NAME} -d ${DOCKER_DB_NAME}']`,
    ...HEALTH_TIMING,
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// Processes

export const say = (line: string): void => void process.stderr.write(`smoke: ${line}\n`);

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface Finished {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Windows runs .cmd files through the shell only (CVE-2024-27980). */
const needsShell = (file: string): boolean => IS_WINDOWS && /\.(cmd|bat)$/i.test(file);

/** Runs `c` to completion; its output is kept (and appended to `<logDir>/<label>.log`). Never rejects on an exit code. */
export async function execCommand(c: Command, logDir: string, timeoutMs = COMMAND_TIMEOUT_MS): Promise<Finished> {
  const log = fs.createWriteStream(path.join(logDir, `${c.label}.log`), { flags: 'a' });
  log.write(`$ ${[c.file, ...c.args].join(' ')}\n`);
  try {
    return await new Promise<Finished>((resolve, reject) => {
      const child = spawn(c.file, c.args, { cwd: c.cwd, env: c.env, stdio: ['pipe', 'pipe', 'pipe'], shell: needsShell(c.file), windowsHide: true });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
        log.write(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
        log.write(chunk);
      });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new SmokeError(`${c.label}: no result after ${timeoutMs} ms`));
      }, timeoutMs);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(new SmokeError(`${c.label}: ${c.file} could not be started: ${messageOf(error)}`));
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
      child.stdin.on('error', () => {}); // a command that does not read its stdin
      child.stdin.end(c.stdin ?? '');
    });
  } finally {
    await new Promise<void>((resolve) => log.end(resolve));
  }
}

/** Runs `c` and requires exit code 0. */
export async function mustRun(c: Command, logDir: string): Promise<Finished> {
  const result = await execCommand(c, logDir);
  if (result.code !== 0) throw new SmokeError(`${c.label} failed with exit code ${String(result.code)} (log: ${c.label}.log)`);
  return result;
}

/** A long-running child of the run, whose 'error' event can no longer crash the run (see {@link spawnTracked}). */
export interface TrackedProcess {
  child: ChildProcess;
  /** What the child's 'error' event said; null while there was none. */
  failure(): string | null;
  /**
   * Whether the child still runs.
   *
   * @throws SmokeError when the child reported an error (it could not be started: a missing npx or docker): the wait
   * loop that asked ends the run with that message, and the cleanups still run.
   */
  alive(): boolean;
}

/**
 * `spawn` with an 'error' listener. An unhandled 'error' event (ENOENT for a missing executable, EACCES, a failed
 * kill) would crash this process before its cleanups ran and leave containers, pm2 daemons and the smoke database
 * behind; here it is kept, reported on stderr, and raised from `alive()` into the wait loops.
 */
export function spawnTracked(label: string, file: string, args: readonly string[], options: SpawnOptions, report: (line: string) => void = say): TrackedProcess {
  const child = spawn(file, [...args], options);
  let failure: string | null = null;
  child.on('error', (error: Error) => {
    failure ??= `${label}: ${file} ${child.pid === undefined ? 'could not be started' : 'reported an error'}: ${messageOf(error)}`;
    report(failure);
  });
  return {
    child,
    failure: () => failure,
    alive: () => {
      if (failure !== null) throw new SmokeError(failure);
      return child.exitCode === null && child.signalCode === null;
    },
  };
}

/** Starts a long-running `c` with its output going to `<logDir>/<label>.log`. */
export function startProcess(c: Command, logDir: string): TrackedProcess {
  const fd = fs.openSync(path.join(logDir, `${c.label}.log`), 'a');
  try {
    return spawnTracked(c.label, c.file, c.args, { cwd: c.cwd, env: c.env, stdio: ['ignore', fd, fd], shell: needsShell(c.file), windowsHide: true });
  } finally {
    fs.closeSync(fd); // the child has its own copy
  }
}

/** SIGTERM, then SIGKILL after STOP_GRACE_MS; also SIGKILLs `extra` pids still alive afterwards. A child that never started has nothing to stop. */
export async function stopTracked(tracked: TrackedProcess, extra: number[] = []): Promise<void> {
  const { child } = tracked;
  if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), STOP_GRACE_MS);
    await exited;
    clearTimeout(timer);
  }
  for (const pid of extra) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

/** A port that was free a moment ago on 127.0.0.1. */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

function probePort(host: string, port: number): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (result: string | null): void => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => done('ETIMEDOUT'));
    socket.once('connect', () => done(null));
    socket.once('error', (e: NodeJS.ErrnoException) => done(e.code ?? 'ECONNREFUSED'));
  });
}

// ---------------------------------------------------------------------------------------------------------------
// HTTP (node:http: global fetch is not used in this repository, P18)

interface Reply {
  status: number;
  body: string;
}

function httpRequest(port: number, method: string, pathname: string, timeoutMs: number): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, agent: false, headers: { connection: 'close' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`no answer within ${timeoutMs} ms`)));
    req.once('error', reject);
    req.end();
  });
}

export interface Healthy {
  /** performance.now() and Date.now() of the first healthy answer. */
  at: number;
  epochMs: number;
  version: string | undefined;
}

/**
 * Asks /_health until it answers 200 with `{"status":"ok"}`, every POLL_MS (refused connections, 503 "starting" and
 * the like are retried). Fails when `alive()` says the process is gone, or after `timeoutMs`.
 */
export async function waitHealthy(port: number, timeoutMs: number, alive: () => boolean = () => true): Promise<Healthy> {
  const deadline = performance.now() + timeoutMs;
  let last = 'no answer';
  for (;;) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new SmokeError(`/_health did not answer 200 within ${timeoutMs} ms (last: ${last})`);
    try {
      const reply = await httpRequest(port, 'GET', '/_health', Math.max(1, Math.min(remaining, 30_000)));
      if (reply.status === 200) {
        const at = performance.now();
        const epochMs = Date.now();
        let body: { status?: unknown; version?: unknown } = {};
        try {
          body = JSON.parse(reply.body) as typeof body;
        } catch {
          // reported below
        }
        if (body.status === 'ok') return { at, epochMs, version: typeof body.version === 'string' ? body.version : undefined };
        last = `200 without status ok: ${reply.body.slice(0, 200)}`;
      } else {
        last = `${reply.status} ${reply.body.slice(0, 200)}`;
      }
    } catch (error) {
      last = messageOf(error);
    }
    if (!alive()) throw new SmokeError(`the server process exited before /_health answered 200 (last: ${last})`);
    await sleep(POLL_MS);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Memory

export async function psTable(logDir: string): Promise<Map<number, { ppid: number; rssKb: number }>> {
  const result = await mustRun({ label: 'ps', file: 'ps', args: ['-A', '-o', 'pid=,ppid=,rss='], cwd: logDir, env: baseEnv() }, logDir);
  return parsePsTable(result.stdout);
}

/** RSS (MB) of `pids` together, or null where `ps` is not available (Windows). */
export async function rssOf(pids: number[], logDir: string): Promise<number | null> {
  if (IS_WINDOWS) return null;
  const table = await psTable(logDir);
  let kib = 0;
  for (const pid of pids) {
    const row = table.get(pid);
    if (row === undefined) throw new SmokeError(`process ${pid} is gone: no RSS to sample`);
    kib += row.rssKb;
  }
  return toMb(kib);
}

// ---------------------------------------------------------------------------------------------------------------
// Databases

/** An administrative connection to a server engine (the superuser: it creates and drops the smoke databases). */
export interface Admin {
  run(statement: string, values?: unknown[]): Promise<void>;
  close(): Promise<void>;
}

type ServerDialect = Exclude<DbConfig['dialect'], 'sqlite'>;

async function mysqlAdmin(port: number): Promise<Admin> {
  const conn = mysql.createConnection({ host: testDbHost(), port, user: 'root', password: TEST_DB_ROOT_PASSWORD, connectTimeout: CONNECT_TIMEOUT_MS });
  conn.on('error', () => {}); // a server going away is reported by the next query
  await new Promise<void>((resolve, reject) => conn.connect((e) => (e ? reject(e) : resolve())));
  return {
    run: (statement, values = []) => new Promise<void>((resolve, reject) => conn.query(statement, values, (e) => (e ? reject(e) : resolve()))),
    close: () => new Promise<void>((resolve) => conn.end(() => resolve())),
  };
}

async function pgAdmin(port: number): Promise<Admin> {
  const client = new pg.Client({
    host: testDbHost(),
    port,
    user: 'postgres',
    password: TEST_DB_ROOT_PASSWORD,
    database: 'postgres',
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });
  client.on('error', () => {});
  await client.connect();
  return {
    run: async (statement, values = []) => void (await client.query(statement, values)),
    close: () => client.end(),
  };
}

/**
 * Creates the smoke database `name` (and, on PostgreSQL, the application role) through `open`'s administrative
 * connection. `registerDrop` receives the drop as soon as the connection is open and before the first statement, so
 * a failure after CREATE DATABASE (the GRANT, say), or a reply lost after the server had created it, never leaks the
 * database: DROP DATABASE IF EXISTS is harmless when it does not exist.
 */
export async function createSmokeDatabase(dialect: ServerDialect, name: string, open: () => Promise<Admin>, registerDrop: (drop: () => Promise<void>) => void): Promise<void> {
  const admin = await open();
  try {
    registerDrop(async () => {
      const again = await open();
      try {
        if (dialect === 'postgres') await again.run(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(name)} WITH (FORCE)`);
        else await again.run('DROP DATABASE IF EXISTS ??', [name]);
      } finally {
        await again.close();
      }
    });
    if (dialect === 'postgres') {
      // The images only create the superuser; the application role is created once per container (as global-setup).
      const user = pg.escapeIdentifier(TEST_DB_USER);
      try {
        await admin.run(`CREATE ROLE ${user} LOGIN PASSWORD ${pg.escapeLiteral(TEST_DB_PASSWORD)}`);
      } catch (error) {
        if ((error as { code?: unknown }).code !== '42710') throw error; // duplicate_object: it exists
      }
      await admin.run(`CREATE DATABASE ${pg.escapeIdentifier(name)} OWNER ${user} ENCODING 'UTF8' TEMPLATE template0`);
    } else {
      await admin.run('CREATE DATABASE ?? CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci', [name]);
      await admin.run(`GRANT ALL PRIVILEGES ON ??.* TO ?@'%'`, [name, TEST_DB_USER]);
    }
  } finally {
    await admin.close();
  }
}

/**
 * A fresh database for the run on a tools/test/compose.yml engine, or SQLite in DATA_DIR. The drop of a server
 * database goes to `registerDrop` before the database is touched (see {@link createSmokeDatabase}).
 */
export async function provisionDb(engine: TestEngine, id: string, registerDrop: (drop: () => Promise<void>) => void): Promise<DbConfig> {
  const { dialect, port } = ENGINE_SPECS[engine];
  if (dialect === 'sqlite' || port === null) return { dialect: 'sqlite' };
  const host = testDbHost();
  const unreachable = await probePort(host, port);
  if (unreachable !== null) {
    throw new SmokeError(`${engine} is not reachable on ${host}:${port} (${unreachable}); start it with: docker compose -f tools/test/compose.yml up -d --wait ${engine}`);
  }
  const name = `altis_smoke_${id}`;
  await createSmokeDatabase(dialect, name, () => (dialect === 'postgres' ? pgAdmin(port) : mysqlAdmin(port)), registerDrop);
  return { dialect, host, port, user: TEST_DB_USER, password: TEST_DB_PASSWORD, database: name };
}

// ---------------------------------------------------------------------------------------------------------------
// Targets

interface Measured extends Measurements {
  node: string | null;
}

export interface RunContext {
  o: SmokeOptions;
  layout: SmokeLayout;
  plan: SmokePlan;
  version: string;
  /** Registers a cleanup that runs (in reverse order) whatever happens. */
  onCleanup(fn: () => Promise<void>): void;
  /** passenger-sim: stops the sim of the measurement (and its workers), for a scenario's own. */
  stopSim?: () => Promise<void>;
  /**
   * 1d Task 35, standalone: stops the `node app.js` of the measurement (and the server it supervises), so an update
   * scenario can start it again with a test fault in its environment.
   */
  stopServer?: () => Promise<void>;
}

export function checkVersion(ctx: RunContext, healthy: Healthy): void {
  if (healthy.version !== ctx.version) throw new SmokeError(`/_health reports version ${String(healthy.version)}, the zip is ${ctx.version}`);
}

async function runStandalone(ctx: RunContext): Promise<Measured> {
  const t0 = performance.now();
  const proc = startProcess(ctx.plan.start, ctx.layout.logDir);
  const child = proc.child;
  let served: number[] = [];
  ctx.onCleanup(() => stopTracked(proc, served));
  ctx.stopServer = () => stopTracked(proc, served);
  const healthy = await waitHealthy(ctx.layout.port, HEALTH_TIMEOUT_MS, proc.alive);
  const coldStartMs = Math.round(healthy.at - t0);
  checkVersion(ctx, healthy);
  say(`healthy after ${coldStartMs} ms; sampling RSS in ${RSS_SAMPLE_DELAY_MS / 1000} s`);
  await sleep(RSS_SAMPLE_DELAY_MS);
  let rssIdleMb: number | null = null;
  if (!IS_WINDOWS && child.pid !== undefined) {
    const table = await psTable(ctx.layout.logDir);
    served = descendantsOf(table, child.pid);
    if (served.length === 0) throw new SmokeError('app.js has no server process (expected the supervised child of runtime standalone)');
    rssIdleMb = await rssOf(served, ctx.layout.logDir);
    say(`supervisor (pid ${child.pid}) RSS ${String(toMb(table.get(child.pid)?.rssKb ?? 0))} MB, not counted; server process RSS ${String(rssIdleMb)} MB`);
  }
  return { coldStartMs, rssIdleMb, node: process.version };
}

interface Pm2Process {
  name?: unknown;
  pid?: unknown;
  pm2_env?: { pm_uptime?: unknown; restart_time?: unknown; status?: unknown };
}

async function pm2Altis(ctx: RunContext): Promise<{ pid: number; startedAt: number | null; restarts: number }> {
  const env = ctx.plan.start.env;
  const result = await mustRun(pm2Command(ctx.layout, env, 'pm2-jlist', ['jlist']), ctx.layout.logDir);
  const start = result.stdout.indexOf('[');
  let list: Pm2Process[];
  try {
    list = JSON.parse(start === -1 ? '' : result.stdout.slice(start)) as Pm2Process[];
  } catch {
    throw new SmokeError('pm2 jlist did not print a JSON list');
  }
  const app = list.find((p) => p.name === 'altis');
  if (app === undefined || typeof app.pid !== 'number' || app.pid <= 0) throw new SmokeError('pm2 does not list a running `altis` process');
  const uptime = app.pm2_env?.pm_uptime;
  const restarts = app.pm2_env?.restart_time;
  return { pid: app.pid, startedAt: typeof uptime === 'number' ? uptime : null, restarts: typeof restarts === 'number' ? restarts : 0 };
}

async function runPm2(ctx: RunContext): Promise<Measured> {
  ctx.onCleanup(async () => void (await execCommand(ctx.plan.teardown[0]!, ctx.layout.logDir, 60_000)));
  const commandEpoch = Date.now();
  const started = execCommand(ctx.plan.start, ctx.layout.logDir);
  let startFailed = false;
  void started.then((r) => (startFailed = r.code !== 0), () => (startFailed = true));
  const healthy = await waitHealthy(ctx.layout.port, HEALTH_TIMEOUT_MS, () => !startFailed);
  const startResult = await started;
  if (startResult.code !== 0) throw new SmokeError(`pm2 start failed with exit code ${String(startResult.code)} (log: start.log)`);
  checkVersion(ctx, healthy);
  const app = await pm2Altis(ctx);
  if (app.restarts > 0) throw new SmokeError(`pm2 restarted the app ${app.restarts} time(s) before it was healthy`);
  // pm_uptime is when pm2 spawned the process; without it, from the `pm2 start` command (pm2's own start included).
  const from = app.startedAt !== null && app.startedAt >= commandEpoch - 1000 && app.startedAt <= healthy.epochMs ? app.startedAt : commandEpoch;
  const coldStartMs = Math.round(healthy.epochMs - from);
  say(`healthy after ${coldStartMs} ms (from ${from === commandEpoch ? '`pm2 start`' : 'the process start'}); sampling RSS in ${RSS_SAMPLE_DELAY_MS / 1000} s`);
  await sleep(RSS_SAMPLE_DELAY_MS);
  const later = await pm2Altis(ctx);
  if (later.pid !== app.pid) throw new SmokeError(`the app process changed (pid ${app.pid} → ${later.pid}) while idle`);
  const rssIdleMb = await rssOf([app.pid], ctx.layout.logDir);
  return { coldStartMs, rssIdleMb, node: process.version };
}

export async function simWorkers(port: number): Promise<number[]> {
  const reply = await httpRequest(port, 'GET', '/__sim/stats', 5000);
  const stats = JSON.parse(reply.body) as { workers: { pid: number }[] };
  return stats.workers.map((w) => w.pid);
}

async function runPassengerSim(ctx: RunContext): Promise<Measured> {
  const { port, logDir } = ctx.layout;
  // The log is ended after the sim has stopped (cleanups run in reverse order).
  const log = fs.createWriteStream(path.join(logDir, 'start.log'), { flags: 'a' });
  ctx.onCleanup(() => new Promise<void>((resolve) => log.end(resolve)));
  const toLog = (chunk: Buffer): void => {
    if (!log.writableEnded) log.write(chunk);
  };
  const { start } = ctx.plan;
  const proc = spawnTracked(start.label, start.file, start.args, { cwd: start.cwd, env: start.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let workers: number[] = [];
  ctx.onCleanup(() => stopTracked(proc, workers));
  ctx.stopSim = () => stopTracked(proc, workers);
  let stdout = '';
  proc.child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
    toLog(chunk);
  });
  proc.child.stderr?.on('data', toLog);
  const alive = proc.alive;

  const listenDeadline = performance.now() + SIM_LISTEN_TIMEOUT_MS;
  while (!stdout.includes('passenger-sim: listening on')) {
    if (!alive()) throw new SmokeError('passenger-sim exited before it listened (log: start.log)');
    if (performance.now() > listenDeadline) throw new SmokeError(`passenger-sim did not listen within ${SIM_LISTEN_TIMEOUT_MS} ms`);
    await sleep(POLL_MS);
  }

  // A first request boots a worker (first boot of the install); then wait until idle-ms has stopped it.
  const first = await waitHealthy(port, HEALTH_TIMEOUT_MS, alive);
  checkVersion(ctx, first);
  const idleDeadline = performance.now() + PASSENGER_IDLE_MS + 15_000;
  say(`first worker healthy; waiting for idle-ms (${PASSENGER_IDLE_MS} ms) to stop it`);
  while ((await simWorkers(port)).length > 0) {
    if (performance.now() > idleDeadline) throw new SmokeError('passenger-sim kept its worker past idle-ms');
    await sleep(250);
  }

  // The measured cold start: the first request after idle spawns a worker and waits for its answer.
  const t0 = performance.now();
  const healthy = await waitHealthy(port, HEALTH_TIMEOUT_MS, alive);
  const coldStartMs = Math.round(healthy.at - t0);
  workers = await simWorkers(port);
  if (workers.length !== 1) throw new SmokeError(`expected one worker after one request, found ${workers.length}`);
  say(`healthy after ${coldStartMs} ms (worker ${workers[0]!}); sampling RSS in ${RSS_SAMPLE_DELAY_MS / 1000} s`);
  await sleep(RSS_SAMPLE_DELAY_MS);
  const rssIdleMb = await rssOf(workers, logDir);
  return { coldStartMs, rssIdleMb, node: process.version };
}

/** What the image's /app must never hold (spec §9.11): a `.env` file, anything of `.git`, a source map. */
const FORBIDDEN_IMAGE_FILES: readonly RegExp[] = [/(^|\/)\.env(\..*)?$/, /(^|\/)\.git(\/|$)/, /\.map$/i];

/** The paths (POSIX, relative to /app) among `files` that must never be in the Docker image: `.env*`, `.git`, `*.map`. */
export function forbiddenImageFiles(files: readonly string[]): string[] {
  return files.filter((file) => FORBIDDEN_IMAGE_FILES.some((pattern) => pattern.test(file)));
}

/** `docker top` rows `PID RSS COMMAND…` → RSS (KiB) of the node process. */
function nodeRssFromDockerTop(text: string): number | null {
  for (const line of text.split('\n')) {
    const match = /^\s*\d+\s+(\d+)\s+(\S+)/.exec(line);
    if (match !== null && /(^|\/)node$/.test(match[2]!)) return Number(match[1]);
  }
  return null;
}

async function runDocker(ctx: RunContext): Promise<Measured> {
  const { layout, plan, o } = ctx;
  const logDir = layout.logDir;
  const compose = (label: string, args: string[]): Command => composeCommand(layout, o.db, plan.start.env, label, args);

  // The image holds exactly the zip's files (no .env, .git, source maps: spec §9.11), its Node, and the entrypoint
  // has copied the bundled release to the volume (spec §9.3).
  const inspect = await mustRun(
    compose('docker-inspect-image', [
      ...['run', '--rm', '-T', '--no-deps', '--entrypoint', 'sh', 'app', '-c'],
      `node --version && echo --- && cd /app && find . -type f && echo --- && { ls -a /data/releases/${ctx.version} || true; }`,
    ]),
    logDir,
  );
  const [nodeText = '', filesText = '', releaseText = ''] = inspect.stdout.split('---\n');
  const node = nodeText.trim();
  const imageFiles = filesText
    .split('\n')
    .filter(Boolean)
    .map((f) => f.replace(/^\.\//, ''))
    .sort(byText);
  // Explicit, apart from the comparison below: spec §9.11 "CI memastikan image tidak memuat .env, .git, maupun source map".
  const forbidden = forbiddenImageFiles(imageFiles);
  if (forbidden.length > 0) throw new SmokeError(`/app in the image holds files that must never ship (spec §9.11: no .env, .git or source map): ${forbidden.join(', ')}`);
  const zipFiles = await listFiles(layout.appRoot);
  if (JSON.stringify(imageFiles) !== JSON.stringify(zipFiles)) {
    const extra = imageFiles.filter((f) => !zipFiles.includes(f));
    const missing = zipFiles.filter((f) => !imageFiles.includes(f));
    throw new SmokeError(`/app in the image differs from the zip (extra: ${extra.join(', ') || '-'}; missing: ${missing.join(', ') || '-'})`);
  }
  if (!releaseText.split('\n').includes('.complete')) throw new SmokeError(`the entrypoint did not copy the bundled release to /data/releases/${ctx.version}`);

  const t0Epoch = Date.now();
  await mustRun(plan.start, logDir);
  const id = (await mustRun(compose('docker-ps', ['ps', '--quiet', 'app']), logDir)).stdout.trim();
  if (id === '') throw new SmokeError('docker compose lists no app container');
  const running = async (): Promise<boolean> => {
    const state = await execCommand({ label: 'docker-state', file: 'docker', args: ['inspect', '--format', '{{.State.Running}}', id], cwd: DOCKER_DIR, env: plan.start.env }, logDir);
    return state.stdout.trim() === 'true';
  };
  let alive = true;
  const watcher = setInterval(() => void running().then((r) => (alive = r), () => (alive = false)), 1000);
  let healthy: Healthy;
  try {
    healthy = await waitHealthy(layout.port, HEALTH_TIMEOUT_MS, () => alive);
  } finally {
    clearInterval(watcher);
  }
  checkVersion(ctx, healthy);
  // From the container's start (Docker's StartedAt); from `up` when that is not usable (clock skew of a VM).
  const startedText = (await mustRun({ label: 'docker-started', file: 'docker', args: ['inspect', '--format', '{{.State.StartedAt}}', id], cwd: DOCKER_DIR, env: plan.start.env }, logDir)).stdout.trim();
  const startedAt = Date.parse(startedText.replace(/(\.\d{3})\d*/, '$1'));
  const from = Number.isFinite(startedAt) && startedAt >= t0Epoch - 1000 && startedAt <= healthy.epochMs ? startedAt : t0Epoch;
  const coldStartMs = Math.round(healthy.epochMs - from);
  say(`healthy after ${coldStartMs} ms (from ${from === t0Epoch ? '`up`' : 'the container start'}); sampling RSS in ${RSS_SAMPLE_DELAY_MS / 1000} s`);
  await sleep(RSS_SAMPLE_DELAY_MS);
  const top = await mustRun({ label: 'docker-top', file: 'docker', args: ['top', id, '-o', 'pid,rss,args'], cwd: DOCKER_DIR, env: plan.start.env }, logDir);
  const kib = nodeRssFromDockerTop(top.stdout);
  if (kib === null) throw new SmokeError('docker top shows no node process in the app container');
  return { coldStartMs, rssIdleMb: toMb(kib), node };
}

/** Files under `dir` as sorted POSIX paths. */
export async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(at: string, rel: string): Promise<void> {
    for (const entry of await fsp.readdir(at, { withFileTypes: true })) {
      const child = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) await walk(path.join(at, entry.name), child);
      else out.push(child);
    }
  }
  await walk(dir, '');
  return out.sort(byText);
}

// ---------------------------------------------------------------------------------------------------------------
// Scenarios (1c Task 34; see the top of this file)

/** A /_cron call this long after the previous one: the single-flight lease is 30 s (§10.3, C39). */
export const CRON_CALL_INTERVAL_MS = 31_000;
/** The forged X-Forwarded-For entry of the XFF test (TEST-NET-3). */
export const XFF_FORGED = XFF_PROBE_FORGED;
/** The peer passenger-sim's shim forces on every worker request, and the client it appends (we run on loopback). */
const SIM_PEER = '127.0.0.1';
/** How long a scenario may take, at most (a CI job has 20 minutes for everything). */
const SCENARIO_TIMEOUT_MS = 8 * 60_000;
/** The page views of the piggyback scenario: one every this long (a worker piggybacks at most every 30 s, C36). */
const PAGE_VIEW_INTERVAL_MS = 5000;
/** How often the progress scenarios poll `GET events` (a busy tab polls every 2.5 s, §10.8). */
const EVENTS_POLL_MS = 1000;
/** After the backup's runner ended, events are read this much longer (a reader returns events ≥ 2 s old, C5). */
const EVENTS_SETTLE_MS = 6000;
/** A config:set reaches every worker within its config fence (≤ 2 s, D34); asked again for this long. */
const FENCE_WAIT_MS = 20_000;
/** The SSE probe's deadline for its ticks (lib/probes.ts PROBE_SSE_TIMEOUT_MS). */
const PROBE_SSE_TIMEOUT_MS = 6000;

/**
 * What the cron line of a hosting panel sends: `curl -fsS -X POST -H "Authorization: Bearer <token>" <url>/_cron`.
 * curl's own headers and the bearer token; nothing a browser adds (no Origin, no cookie, no CSRF token, no body).
 */
export function cronHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'user-agent': 'curl/8.5.0', accept: '*/*', 'content-length': '0' };
}

/** The cookies the install sets (all `Path=/`), kept by name like a browser of one site. */
export class CookieJar {
  readonly #cookies = new Map<string, string>();

  /** Takes the `Set-Cookie` lines of a response; a cookie set empty or with `Max-Age` ≤ 0 is forgotten. */
  store(setCookie: string | readonly string[] | undefined): void {
    if (setCookie === undefined) return;
    for (const line of typeof setCookie === 'string' ? [setCookie] : setCookie) {
      const [pair = '', ...attributes] = line.split(';');
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expired = attributes.some((a) => {
        const m = /^\s*max-age\s*=\s*(-?\d+)\s*$/i.exec(a);
        return m !== null && Number(m[1]) <= 0;
      });
      if (value === '' || expired) this.#cookies.delete(name);
      else this.#cookies.set(name, value);
    }
  }

  get(name: string): string | undefined {
    return this.#cookies.get(name);
  }

  /** The `Cookie` header ('' without cookies). */
  header(): string {
    return [...this.#cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }
}

/** One event of a text/event-stream: `event` is `message` when the block named none. */
export interface SseEvent {
  id: string;
  event: string;
  data: string;
}

/**
 * A text/event-stream reader fed with chunks cut anywhere (HTML Living Standard §9.2.6, as an EventSource reads it).
 * A block with an `id`, `event` or `data` field is an event; a block with only an `id` is reported too (an empty
 * `message`: the stream's cursor moved); comments (`: hb`) and `retry` are not. The last id stays until replaced.
 */
export class SseParser {
  #buffer = '';
  #lastEventId = '';
  #event = '';
  #data: string[] = [];
  #fields = false;

  get lastEventId(): string {
    return this.#lastEventId;
  }

  push(chunk: string): SseEvent[] {
    this.#buffer += chunk;
    const out: SseEvent[] = [];
    for (;;) {
      const at = this.#buffer.search(/[\r\n]/);
      if (at === -1) break;
      // A CR at the very end may be the first half of a CRLF: wait for the next chunk.
      if (this.#buffer[at] === '\r' && at === this.#buffer.length - 1) break;
      const line = this.#buffer.slice(0, at);
      this.#buffer = this.#buffer.slice(this.#buffer.startsWith('\r\n', at) ? at + 2 : at + 1);
      if (line === '') {
        if (this.#fields) out.push({ id: this.#lastEventId, event: this.#event === '' ? 'message' : this.#event, data: this.#data.join('\n') });
        this.#event = '';
        this.#data = [];
        this.#fields = false;
        continue;
      }
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const name = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (name === 'id' && !value.includes('\0')) {
        this.#lastEventId = value;
        this.#fields = true;
      } else if (name === 'event') {
        this.#event = value;
        this.#fields = true;
      } else if (name === 'data') {
        this.#data.push(value);
        this.#fields = true;
      }
    }
    return out;
  }
}

/**
 * The browser test's verdict on SSE (apps/admin lib/probes.ts): the stream ended with its `done` event, and its first
 * {@link PROBE_SSE_TICKS} ticks arrived spread over at least half their nominal spacing (a proxy that buffers delivers
 * them at once).
 */
export function probeSseWorks(tickTimesMs: readonly number[], done: boolean): boolean {
  if (!done || tickTimesMs.length < PROBE_SSE_TICKS) return false;
  return tickTimesMs[PROBE_SSE_TICKS - 1]! - tickTimesMs[0]! >= (PROBE_SSE_INTERVAL_MS * (PROBE_SSE_TICKS - 1)) / 2;
}

/** The `backup.progress` values of backup `backupId` (in seq order, each seq once) and whether its `backup.done` came. */
export function progressHints(events: readonly EventItem[], backupId: string): { progress: number[]; done: boolean } {
  const seen = new Set<number>();
  const progress: number[] = [];
  let done = false;
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    if (seen.has(e.seq)) continue;
    seen.add(e.seq);
    if (e.payload['backupId'] !== backupId) continue;
    const value = e.payload['progress'];
    if (e.type === 'backup.progress' && typeof value === 'number') progress.push(value);
    if (e.type === 'backup.done') done = true;
  }
  return { progress, done };
}

/** The client IP `hops` derives from the X-Forwarded-For entries `xff` and the peer (P15; a short chain: the peer). */
export function derivedIp(xff: readonly string[], peer: string, hops: number): string {
  const chain = [...xff, peer];
  const index = chain.length - 1 - hops;
  return index < 0 ? peer : chain[index]!;
}

/** `node app.js <args>` in the appRoot, as the install ran (its DATA_DIR, runtime passenger). */
export function appCommand(layout: SmokeLayout, label: string, args: readonly string[], env: Record<string, string> = baseEnv()): Command {
  return {
    label,
    file: process.execPath,
    args: ['app.js', ...args],
    cwd: layout.appRoot,
    env: { ...env, ALTIS_DATA_DIR: layout.dataDir, ALTIS_RUNTIME: 'passenger' },
  };
}

export interface HttpReply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** One request to 127.0.0.1:`port` (node:http, a fresh connection), its whole answer. */
export function httpSend(port: number, method: string, pathname: string, headers: Record<string, string>, body: string | Buffer | undefined, timeoutMs: number): Promise<HttpReply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, agent: false, headers: { connection: 'close', ...headers } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`${method} ${pathname}: no answer within ${timeoutMs} ms`)));
    req.once('error', reject);
    req.end(body);
  });
}

/** The problem+json code of an answer ('' when it has none). */
export function problemCode(body: string): string {
  try {
    const code = (JSON.parse(body) as { code?: unknown }).code;
    return typeof code === 'string' ? code : '';
  } catch {
    return '';
  }
}

/** How long a request is sent again while app.js answers its "starting" page (a worker still loading the release). */
const STARTING_RETRY_MS = 15_000;

/**
 * Whether `reply` is app.js's own "starting" answer (packages/bootloader front.ts): 503 with its bilingual page (or
 * `{"status":"starting"}` on /_health) while a worker that passenger-sim has just spawned still loads the release. The
 * release never saw the request, so sending it again is safe; the page itself reloads after 5 s.
 */
export function isStartingPage(reply: { status: number; headers: http.IncomingHttpHeaders; body: string }): boolean {
  if (reply.status !== 503) return false;
  const type = String(reply.headers['content-type'] ?? '');
  return (type.startsWith('text/html') && reply.body.includes('ALTIS is starting')) || reply.body === '{"status":"starting"}';
}

/**
 * The staff API as the admin SPA speaks it, over node:http: a cookie jar, the CSRF token of `GET auth/me` (and of the
 * `X-CSRF-Token` header a rotation sends) and the install's origin on every write (§7.4).
 */
export class SmokeSession {
  readonly jar = new CookieJar();
  #csrf = '';

  constructor(readonly port: number) {}

  get origin(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** The headers a request of this session carries (`write`: the CSRF token and Origin too). */
  headers(write: boolean, extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = { accept: 'application/json', ...extra };
    const cookie = this.jar.header();
    if (cookie !== '') headers['cookie'] = cookie;
    if (write) {
      headers['x-csrf-token'] = this.#csrf;
      headers['origin'] = this.origin;
    }
    return headers;
  }

  /** Takes what an answer sets: cookies and a rotated CSRF token. */
  take(headers: http.IncomingHttpHeaders): void {
    this.jar.store(headers['set-cookie']);
    const token = headers['x-csrf-token'];
    if (typeof token === 'string' && token !== '') this.#csrf = token;
  }

  async request(method: string, pathname: string, o: { json?: unknown; headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<HttpReply> {
    const write = method !== 'GET' && method !== 'HEAD';
    const headers = this.headers(write, o.headers);
    let body: string | undefined;
    if (o.json !== undefined) {
      body = JSON.stringify(o.json);
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(body));
    } else if (write) {
      headers['content-length'] = '0';
    }
    const t0 = performance.now();
    for (;;) {
      const reply = await httpSend(this.port, method, pathname, headers, body, o.timeoutMs ?? 30_000);
      this.take(reply.headers);
      if (!isStartingPage(reply) || performance.now() - t0 > STARTING_RETRY_MS) return reply;
      await sleep(250);
    }
  }

  /** `<method> /api/v1/<path>`: the parsed answer, or SmokeError naming the status and the problem code. */
  async call<T>(method: string, apiPath: string, json?: unknown, headers?: Record<string, string>): Promise<T> {
    const reply = await this.request(method, `/api/v1/${apiPath}`, { ...(json === undefined ? {} : { json }), ...(headers === undefined ? {} : { headers }) });
    if (reply.status < 200 || reply.status > 299) throw new SmokeError(`${method} ${apiPath} → ${reply.status} ${problemCode(reply.body)}`.trimEnd());
    return (reply.body === '' ? undefined : JSON.parse(reply.body)) as T;
  }

  /** `GET auth/me`: the CSRF token of whatever session the jar holds. */
  async me(): Promise<MeResponse> {
    const me = await this.call<MeResponse>('GET', 'auth/me');
    this.#csrf = me.csrfToken;
    return me;
  }

  /** Signs in (no 2FA: the smoke's super admin has none) and takes the session's own CSRF token. */
  async signIn(username: string, password: string): Promise<void> {
    await this.me();
    const res = await this.call<LoginResponse>('POST', 'auth/login', { username, password });
    if (res.stage !== 'full') throw new SmokeError(`auth/login: stage ${res.stage}, expected full`);
    await this.me();
  }
}

/** What a scenario has at hand. */
interface ScenarioRun {
  layout: SmokeLayout;
  port: number;
  session: SmokeSession;
  /** What the report shows of the scenario (filled as it goes; kept when it fails). */
  detail: Record<string, unknown>;
  /** Fails with SmokeError once the scenario ran past its time. */
  checkTime(what: string): void;
}

/** config.json's `secrets.cronToken` (read, never printed). */
export async function readCronToken(dataDir: string): Promise<string> {
  const config = JSON.parse(await fsp.readFile(path.join(dataDir, 'config.json'), 'utf8')) as { secrets?: { cronToken?: unknown } };
  const token = config.secrets?.cronToken;
  if (typeof token !== 'string' || token === '') throw new SmokeError('config.json holds no secrets.cronToken');
  return token;
}

/** What `POST /_cron` reports of the op it stepped (apps/server api/cron.ts CronOpSummary). */
interface CronOp {
  opId: string | null;
  kind: string | null;
  state: string;
  terminal: boolean;
  needsAttention: boolean;
  progress: number;
}

/** One cron line call: 200 `{op, scheduled, slices}` or 202 `{skipped: 'busy'}`; anything else fails. */
async function cronCall(port: number, token: string): Promise<{ status: number; op: CronOp | null; slices: number }> {
  const reply = await httpSend(port, 'POST', '/_cron', cronHeaders(token), undefined, 60_000);
  if (reply.status === 202) return { status: 202, op: null, slices: 0 };
  // `curl -fsS` fails on it and the panel's cron logs the error; the next run tries again.
  if (isStartingPage(reply)) return { status: 503, op: null, slices: 0 };
  if (reply.status !== 200) throw new SmokeError(`POST /_cron → ${reply.status} ${problemCode(reply.body)}`.trimEnd());
  const body = JSON.parse(reply.body) as { op?: CronOp | null; slices?: number };
  return { status: 200, op: body.op ?? null, slices: body.slices ?? 0 };
}

/** `node app.js <args>` to its end (exit 0 required); its output is in `<label>.log`. */
async function runApp(s: ScenarioRun, label: string, args: readonly string[]): Promise<string> {
  say(`node app.js ${args.join(' ')}…`);
  const result = await mustRun(appCommand(s.layout, label, args), s.layout.logDir);
  return result.stdout.trim();
}

export const exists = (file: string): Promise<boolean> =>
  fsp.stat(file).then(
    () => true,
    () => false,
  );

async function enqueueTestSlices(s: ScenarioRun, slices: number): Promise<string> {
  const queued = await s.session.call<{ id: string }>('POST', '_test/jobs', { type: 'test.slices', payload: { slices, k: 1 } });
  s.detail['jobId'] = queued.id;
  return queued.id;
}

const job = (s: ScenarioRun, id: string): Promise<JobView> => s.session.call<JobView>('GET', `jobs/${encodeURIComponent(id)}`);

/** A plain page view of a visitor (no cookie): HTML, never the API. */
async function pageView(port: number, pathname: string): Promise<number> {
  const reply = await httpSend(port, 'GET', pathname, { accept: 'text/html' }, undefined, 30_000);
  if (reply.status >= 500 && !isStartingPage(reply)) throw new SmokeError(`GET ${pathname} → ${reply.status}`);
  return reply.status;
}

/** `read()`, asked again while it is refused 503 MAINTENANCE, for at most {@link FENCE_WAIT_MS}. */
async function untilOutOfMaintenance<T>(read: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  for (;;) {
    try {
      return await read();
    } catch (error) {
      if (!(error instanceof SmokeError && / → 503 MAINTENANCE$/.test(error.message)) || performance.now() - t0 > FENCE_WAIT_MS) throw error;
    }
    await sleep(500);
  }
}

/** A6: a frozen backup driven by the cron line alone. */
async function scenarioCronBackup(s: ScenarioRun): Promise<void> {
  const started = await s.session.call<BackupCreateResponse>('POST', 'backups', {});
  if (started.consistency !== 'frozen') {
    throw new SmokeError(`POST backups chose ${started.consistency}: with no worker or jobs:run recorded it must be frozen (§9.9)`);
  }
  s.detail['opId'] = started.opId;
  const maintenance = path.join(s.layout.dataDir, 'ops', 'maintenance.json');
  s.detail['maintenanceOn'] = await exists(maintenance);
  if (s.detail['maintenanceOn'] !== true) throw new SmokeError('a frozen backup began without DATA_DIR/ops/maintenance.json');
  const token = await readCronToken(s.layout.dataDir);
  const t0 = performance.now();
  let calls = 0;
  let last: CronOp | null;
  for (;;) {
    const reply = await cronCall(s.port, token);
    calls += 1;
    s.detail['cronCalls'] = calls;
    last = reply.op;
    if (reply.status === 202) say(`/_cron ${calls}: 202 busy`);
    else if (reply.status === 503) {
      s.detail['cronLost'] = Number(s.detail['cronLost'] ?? 0) + 1;
      say(`/_cron ${calls}: 503 starting (a worker still loading the release; this cron run did nothing)`);
    } else {
      say(`/_cron ${calls}: op ${last === null ? 'none' : `${String(last.kind)} ${last.state} ${last.progress}%`}, ${reply.slices} slice(s)`);
      if (last !== null && last.opId === started.opId && last.terminal) break;
      if (last === null && calls > 1) break; // the op was archived meanwhile: what it left is checked below
    }
    s.checkTime('the frozen backup driven by /_cron');
    await sleep(CRON_CALL_INTERVAL_MS);
  }
  s.detail['seconds'] = Math.round((performance.now() - t0) / 1000);
  s.detail['state'] = last?.state ?? null;
  if (last !== null && last.state !== 'done') throw new SmokeError(`the frozen backup ended ${last.state}, not done`);
  if (await exists(maintenance)) throw new SmokeError('the backup ended but DATA_DIR/ops/maintenance.json is still there');
  // A worker sees the flag gone at its next ops fence (request-driven, at most every 2 s): 503 MAINTENANCE until then.
  const list = await untilOutOfMaintenance(() => s.session.call<BackupListResponse>('GET', 'backups'));
  const item = list.items.find((i) => i.consistency === 'frozen' && i.kind === 'manual');
  s.detail['backup'] = item === undefined ? null : { status: item.status, consistency: item.consistency, size: item.size };
  if (item?.status !== 'ok') throw new SmokeError(`the frozen backup is listed ${item === undefined ? 'nowhere' : item.status}, expected ok`);
}

/** A5: a 3-slice job moved by ordinary page views alone. */
async function scenarioPiggyback(s: ScenarioRun): Promise<void> {
  const id = await enqueueTestSlices(s, 3);
  const t0 = performance.now();
  const pages = ['/', '/admin/login'];
  let views = 0;
  for (;;) {
    await pageView(s.port, pages[views % pages.length]!);
    views += 1;
    const j = await job(s, id);
    s.detail['pageViews'] = views;
    s.detail['status'] = j.status;
    s.detail['progress'] = j.progress;
    if (j.status === 'succeeded') break;
    if (j.status !== 'queued' && j.status !== 'running') throw new SmokeError(`the job ended ${j.status}: ${String(j.lastError)}`);
    s.checkTime('the job moved by page views');
    await sleep(PAGE_VIEW_INTERVAL_MS);
  }
  s.detail['seconds'] = Math.round((performance.now() - t0) / 1000);
  say(`the job succeeded after ${views} page view(s), ${String(s.detail['seconds'])} s`);
}

/** A5: a 3-slice job run by one `node app.js jobs:run`. */
async function scenarioCronCli(s: ScenarioRun): Promise<void> {
  const id = await enqueueTestSlices(s, 3);
  s.detail['jobsRun'] = await runApp(s, 'jobs-run', ['jobs:run']);
  const j = await job(s, id);
  s.detail['status'] = j.status;
  if (j.status !== 'succeeded') throw new SmokeError(`after one jobs:run the job is ${j.status}, expected succeeded`);
}

/** `POST backups` after a recorded cron_cli run: a snapshot job (its backup has the job's id). */
async function startSnapshotBackup(s: ScenarioRun): Promise<string> {
  // A jobs:run that records cron_cli: the manual backup is then a snapshot (§9.9: a cron line runs it).
  await runApp(s, 'jobs-run-record', ['jobs:run', '--budget', '1']);
  const started = await s.session.call<BackupCreateResponse>('POST', 'backups', {});
  if (started.consistency !== 'snapshot') {
    throw new SmokeError(`POST backups chose ${started.consistency}: after a jobs:run it must be a snapshot (§9.9)`);
  }
  s.detail['jobId'] = started.jobId;
  return started.jobId;
}

/** Waits for `run` (the backup's runner) while `read` collects events, then reads on for the settle window. */
async function collectWhile(s: ScenarioRun, run: Promise<Finished>, backupId: string, events: EventItem[], read: () => Promise<void>): Promise<void> {
  let ended: number | null = null;
  let outcome: Finished | Error | null = null;
  void run.then(
    (r) => {
      outcome = r;
      ended = performance.now();
    },
    (error: unknown) => {
      outcome = error instanceof Error ? error : new Error(String(error));
      ended = performance.now();
    },
  );
  for (;;) {
    await read();
    const hints = progressHints(events, backupId);
    if (ended !== null && ((hints.done && hints.progress.length > 0) || performance.now() - ended > EVENTS_SETTLE_MS)) break;
    s.checkTime('the backup and its hints');
    await sleep(EVENTS_POLL_MS);
  }
  const result = outcome as Finished | Error | null;
  if (result instanceof Error) throw result;
  if (result !== null && result.code !== 0) throw new SmokeError(`jobs:run (the backup) failed with exit code ${String(result.code)} (log: jobs-run-backup.log)`);
}

/** The hints seen, checked and reported: at least one `backup.progress` and the `backup.done` of `backupId`. */
async function checkHints(s: ScenarioRun, events: readonly EventItem[], backupId: string): Promise<void> {
  const hints = progressHints(events, backupId);
  s.detail['events'] = events.length;
  s.detail['progressHints'] = hints.progress;
  s.detail['done'] = hints.done;
  if (hints.progress.length === 0) throw new SmokeError(`no backup.progress hint of backup ${backupId} on system.backup (seen: ${[...new Set(events.map((e) => e.type))].join(', ') || 'nothing'})`);
  if (!hints.done) throw new SmokeError(`no backup.done of backup ${backupId} on system.backup`);
  const list = await s.session.call<BackupListResponse>('GET', 'backups');
  const item = list.items.find((i) => i.id === backupId);
  if (item?.status !== 'ok' || item.consistency !== 'snapshot') throw new SmokeError(`backup ${backupId} is ${item === undefined ? 'not listed' : `${item.status}/${item.consistency}`}, expected ok/snapshot`);
}

const BACKUP_CHANNEL = 'system.backup';

/** A9: the progress hints of a backup, read by polling `GET events` through passenger-sim. */
async function scenarioPollingProgress(s: ScenarioRun): Promise<void> {
  const poll = (cursor: string | null): Promise<EventsResponse> =>
    s.session.call<EventsResponse>('GET', `events?channels=${BACKUP_CHANNEL}${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`, undefined, {
      'x-altis-background': '1',
    });
  let cursor = (await poll(null)).cursor;
  const backupId = await startSnapshotBackup(s);
  const events: EventItem[] = [];
  let polls = 0;
  const run = execCommand(appCommand(s.layout, 'jobs-run-backup', ['jobs:run', '--budget', '1']), s.layout.logDir);
  await collectWhile(s, run, backupId, events, async () => {
    const answer = await poll(cursor);
    polls += 1;
    cursor = answer.cursor;
    events.push(...answer.events);
  });
  s.detail['polls'] = polls;
  await checkHints(s, events, backupId);
}

/**
 * One `GET <pathname>` text/event-stream to its end, or until `onEvent` returns true or `signal` aborts (a stream that
 * only sends heartbeat comments would not call `onEvent` for up to 25 s); events as they come.
 */
function readStream(
  s: ScenarioRun,
  pathname: string,
  extra: Record<string, string>,
  o: { onEvent(e: SseEvent, atMs: number): boolean | void; timeoutMs: number; signal?: AbortSignal },
): Promise<{ lastEventId: string; stopped: boolean; starting: boolean }> {
  const what = `GET ${pathname.split('?')[0]!}`;
  return new Promise((resolve, reject) => {
    const parser = new SseParser();
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      o.signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const req = http.request(
      { host: '127.0.0.1', port: s.port, method: 'GET', path: pathname, agent: false, headers: { connection: 'close', ...s.session.headers(false, { accept: 'text/event-stream', ...extra }) } },
      (res) => {
        s.session.take(res.headers);
        res.setEncoding('utf8');
        if (res.statusCode !== 200) {
          let text = '';
          res.on('data', (chunk: string) => (text += chunk));
          res.on('end', () =>
            settle(() => {
              // A worker passenger-sim has just spawned, still loading the release: the caller connects again.
              if (isStartingPage({ status: res.statusCode ?? 0, headers: res.headers, body: text })) resolve({ lastEventId: parser.lastEventId, stopped: false, starting: true });
              else reject(new SmokeError(`${what} → ${String(res.statusCode)} ${problemCode(text)}`.trimEnd()));
            }),
          );
          return;
        }
        res.on('data', (chunk: string) => {
          const at = performance.now();
          for (const e of parser.push(chunk)) {
            if (settled) return;
            let stop: boolean | void;
            try {
              stop = o.onEvent(e, at);
            } catch (error) {
              req.destroy();
              settle(() => reject(error instanceof Error ? error : new Error(String(error))));
              return;
            }
            if (stop === true) {
              req.destroy();
              settle(() => resolve({ lastEventId: parser.lastEventId, stopped: true, starting: false }));
              return;
            }
          }
        });
        res.on('end', () => settle(() => resolve({ lastEventId: parser.lastEventId, stopped: false, starting: false })));
        res.on('error', (error) => settle(() => reject(error)));
      },
    );
    function onAbort(): void {
      req.destroy();
      settle(() => resolve({ lastEventId: parser.lastEventId, stopped: true, starting: false }));
    }
    if (o.signal?.aborted === true) {
      onAbort();
      return;
    }
    o.signal?.addEventListener('abort', onAbort, { once: true });
    req.setTimeout(o.timeoutMs, () => req.destroy(new Error(`${what}: the stream went past ${o.timeoutMs} ms`)));
    req.once('error', (error) => settle(() => reject(error)));
    req.end();
  });
}

/** The browser test of SSE through passenger-sim (`GET diagnostics/probe/sse`). */
async function probeSse(s: ScenarioRun): Promise<{ times: number[]; done: boolean }> {
  const times: number[] = [];
  let done = false;
  for (const t0 = performance.now(); ; ) {
    const r = await readStream(s, '/api/v1/diagnostics/probe/sse', {}, {
      timeoutMs: PROBE_SSE_TIMEOUT_MS + 5000,
      onEvent: (e, at) => {
        if (e.event === 'tick') times.push(at);
        if (e.event === 'done') done = true;
      },
    });
    if (!r.starting || performance.now() - t0 > STARTING_RETRY_MS) break;
    await sleep(250);
  }
  return { times, done };
}

/** The XFF test's two polls: clean, and with the forged entry (passenger-sim appends the peer to both). */
async function xffPolls(s: ScenarioRun): Promise<{ clean: ProbePollResponse; forged: ProbePollResponse }> {
  const clean = await s.session.call<ProbePollResponse>('GET', 'diagnostics/probe/poll');
  const forged = await s.session.call<ProbePollResponse>('GET', 'diagnostics/probe/poll', undefined, { 'x-forwarded-for': XFF_FORGED });
  return { clean, forged };
}

/** A9: the hints of a backup received through `GET events/stream` once SSE is on. */
async function scenarioSseProgress(s: ScenarioRun): Promise<void> {
  // 1. The browser test, as Diagnostik runs it: SSE, the methods, the XFF polls; its result posted.
  const probe = await probeSse(s);
  const sse = probeSseWorks(probe.times, probe.done);
  s.detail['probeSse'] = { ticks: probe.times.length, spreadMs: probe.times.length > 1 ? Math.round(probe.times.at(-1)! - probe.times[0]!) : 0, sse };
  if (!sse) throw new SmokeError('the SSE probe through passenger-sim did not deliver its ticks spread out (a buffering proxy)');
  const methods = { put: false, patch: false, delete: false };
  for (const m of ['PUT', 'PATCH', 'DELETE'] as const) {
    methods[m.toLowerCase() as keyof typeof methods] = (await s.session.request(m, '/api/v1/diagnostics/probe/methods')).status === 200;
  }
  const { clean, forged } = await xffPolls(s);
  const result: ProbeResultBody = {
    polling: true,
    sse,
    methods,
    chunkBytes: null,
    xff: { cleanXff: clean.xff, forgedXff: forged.xff, forgedDerived: forged.ip ?? '' },
  };
  await s.session.call<ProbeResultResponse>('POST', 'diagnostics/probe-result', result);
  // 2. SSE on (off by default on Passenger, §10.8).
  const realtime = await s.session.call<RealtimeResponse>('PUT', 'diagnostics/realtime', { sse: true });
  s.detail['transport'] = realtime.transport;
  if (realtime.transport !== 'sse') throw new SmokeError(`PUT diagnostics/realtime {sse: true} gave transport ${realtime.transport}`);

  // 3. A stream open on system.backup, one after the other (each ends within 25 s), resumed from its last id.
  const events: EventItem[] = [];
  const stop = new AbortController();
  let lastEventId = '';
  let connections = 0;
  let open = false;
  let failure: Error | null = null;
  const streaming = (async () => {
    while (!stop.signal.aborted) {
      connections += 1;
      const r = await readStream(s, `/api/v1/events/stream?channels=${BACKUP_CHANNEL}`, lastEventId === '' ? {} : { 'last-event-id': lastEventId }, {
        timeoutMs: 60_000,
        signal: stop.signal,
        onEvent: (e) => {
          open = true;
          if (e.event === 'expired') throw new SmokeError('the event stream said its cursor expired');
          const seq = Number(e.id.split('.')[1]);
          if (e.event !== 'message' && e.data !== '' && Number.isSafeInteger(seq)) {
            const data = JSON.parse(e.data) as { channel: string; payload: Record<string, unknown>; at: number };
            events.push({ seq, channel: data.channel, type: e.event, payload: data.payload, at: data.at });
          }
        },
      });
      if (r.lastEventId !== '') lastEventId = r.lastEventId;
      if (!stop.signal.aborted) await sleep(1000); // the stream's `retry: 1000`
    }
  })().catch((error: unknown) => {
    failure = error instanceof Error ? error : new Error(String(error));
  });
  const failed = (): Error | null => failure;
  try {
    for (const t0 = performance.now(); !open; ) {
      const f = failed();
      if (f !== null) throw f;
      if (performance.now() - t0 > 10_000) throw new SmokeError('GET events/stream sent nothing within 10 s');
      await sleep(100);
    }
    const backupId = await startSnapshotBackup(s);
    const run = execCommand(appCommand(s.layout, 'jobs-run-backup', ['jobs:run', '--budget', '1']), s.layout.logDir);
    await collectWhile(s, run, backupId, events, async () => {
      const f = failed();
      if (f !== null) throw f;
    });
    s.detail['streams'] = connections;
    await checkHints(s, events, backupId);
  } finally {
    stop.abort();
    await streaming;
  }
}

/** A9, P15: the forged X-Forwarded-For entry through passenger-sim with hops 1, 2 and 0. */
async function scenarioXff(s: ScenarioRun): Promise<void> {
  const setHops = (hops: number): Promise<string> => runApp(s, `config-set-hops-${hops}`, ['config:set', 'trustProxy.hops', String(hops)]);
  /** The polls once every worker uses `hops` (its config fence), as `ready` says. */
  const pollsWith = async (hops: number, ready: (p: { clean: ProbePollResponse; forged: ProbePollResponse }) => boolean) => {
    const t0 = performance.now();
    for (;;) {
      const polls = await xffPolls(s);
      if (ready(polls)) return polls;
      if (performance.now() - t0 > FENCE_WAIT_MS) throw new SmokeError(`hops ${hops} did not take effect within ${FENCE_WAIT_MS} ms (forged poll: ip ${String(polls.forged.ip)}, trust ${polls.forged.ipTrust})`);
      await sleep(500);
    }
  };
  const verdict = (polls: { clean: ProbePollResponse; forged: ProbePollResponse }): Promise<ProbeResultResponse> =>
    s.session.call<ProbeResultResponse>('POST', 'diagnostics/probe-result', {
      polling: true,
      sse: false,
      methods: { put: true, patch: true, delete: true },
      chunkBytes: null,
      xff: { cleanXff: polls.clean.xff, forgedXff: polls.forged.xff, forgedDerived: polls.forged.ip ?? '' },
    } satisfies ProbeResultBody);
  const seen = (p: ProbePollResponse) => ({ xff: p.xff, ip: p.ip, ipTrust: p.ipTrust });

  try {
    // hops 1: the entry passenger-sim appended is the client; the forged one is not.
    await setHops(1);
    const one = await pollsWith(1, (p) => p.forged.ip === derivedIp(p.forged.xff, SIM_PEER, 1) && p.forged.ip !== XFF_FORGED);
    if (one.forged.xff.join(', ') !== `${XFF_FORGED}, ${SIM_PEER}`) throw new SmokeError(`passenger-sim did not append the peer: X-Forwarded-For ${one.forged.xff.join(', ')}`);
    const r1 = await verdict(one);
    s.detail['hops1'] = { forged: seen(one.forged), spoofable: r1.spoofable, ipTrust: r1.ipTrust, suggestedHops: r1.suggestedHops };
    if (r1.spoofable) throw new SmokeError('with hops 1 the probe result says spoofable');

    // hops 2: one hop more than there is: the forged entry becomes the client IP.
    await setHops(2);
    const two = await pollsWith(2, (p) => p.forged.ip === XFF_FORGED);
    const r2 = await verdict(two);
    s.detail['hops2'] = { forged: seen(two.forged), spoofable: r2.spoofable, ipTrust: r2.ipTrust };
    if (!r2.spoofable || r2.ipTrust !== 'spoofable') throw new SmokeError(`with hops 2 the probe result says spoofable ${String(r2.spoofable)}, ipTrust ${r2.ipTrust}`);

    // hops 0: the proxy itself would be every visitor's address.
    await setHops(0);
    const zero = await pollsWith(0, (p) => p.clean.ipTrust === 'collapsed');
    s.detail['hops0'] = { clean: seen(zero.clean) };
  } finally {
    await setHops(1).catch((error: unknown) => say(`config:set trustProxy.hops 1 failed: ${messageOf(error)}`));
  }
  // Back on hops 1 (the next result posted clears `spoofable`).
  const back = await pollsWith(1, (p) => p.forged.ip === SIM_PEER);
  const after = await verdict(back);
  s.detail['hops1Again'] = { spoofable: after.spoofable, ipTrust: after.ipTrust };
  if (after.spoofable) throw new SmokeError('back on hops 1 the probe result still says spoofable');
}

const SCENARIO_RUNNERS: Readonly<Record<Scenario, (s: ScenarioRun) => Promise<void>>> = {
  'cron-backup': scenarioCronBackup,
  piggyback: scenarioPiggyback,
  'cron-cli': scenarioCronCli,
  'polling-progress': scenarioPollingProgress,
  'sse-progress': scenarioSseProgress,
  xff: scenarioXff,
};

/**
 * The sim of a scenario: the measurement's command with Passenger's default pool idle time (and a log of its own), or
 * with `idleMs` (the update scenarios: {@link UPDATE_SIM_IDLE_MS}).
 */
export function scenarioSimCommand(start: Command, idleMs: number = PASSENGER_SCENARIO_IDLE_MS): Command {
  const args = [...start.args];
  const at = args.indexOf('--idle-ms');
  if (at === -1 || at + 1 >= args.length) throw new TypeError('scenarioSimCommand: the passenger-sim command has no --idle-ms');
  args[at + 1] = String(idleMs);
  return { ...start, label: 'start-scenario', args };
}

/**
 * Replaces the measurement's sim by one with `idleMs` ({@link PASSENGER_SCENARIO_IDLE_MS} by default) on the same port,
 * healthy. Returns a stop of that sim (1d Task 35: an update scenario restarts it).
 */
export async function startScenarioSim(ctx: RunContext, idleMs: number = PASSENGER_SCENARIO_IDLE_MS): Promise<() => Promise<void>> {
  if (ctx.stopSim === undefined) throw new SmokeError('a scenario needs the passenger-sim of the measurement');
  await ctx.stopSim();
  const command = scenarioSimCommand(ctx.plan.start, idleMs);
  const proc = startProcess(command, ctx.layout.logDir);
  const stop = async (): Promise<void> => stopTracked(proc, await simWorkers(ctx.layout.port).catch(() => []));
  ctx.onCleanup(stop);
  ctx.stopSim = stop;
  const healthy = await waitHealthy(ctx.layout.port, HEALTH_TIMEOUT_MS, proc.alive);
  checkVersion(ctx, healthy);
  say(`passenger-sim restarted for the scenario: idle-ms ${idleMs}${idleMs === PASSENGER_SCENARIO_IDLE_MS ? " (Passenger's default pool idle time)" : ''}`);
  return stop;
}

/** Runs `scenario` against the healthy install of `ctx`, signed in as its first super admin; fills `detail`. */
async function runScenario(ctx: RunContext, scenario: AnyScenario, detail: Record<string, unknown>): Promise<void> {
  if (isUpdateScenario(scenario)) {
    // 1d Task 35: loaded only for an update scenario (update-scenarios.ts imports this module; no import cycle).
    const { runUpdateScenario } = await import('./update-scenarios.js');
    await runUpdateScenario(ctx, scenario, detail);
    return;
  }
  await startScenarioSim(ctx);
  detail['simIdleMs'] = PASSENGER_SCENARIO_IDLE_MS;
  const t0 = performance.now();
  const session = new SmokeSession(ctx.layout.port);
  const s: ScenarioRun = {
    layout: ctx.layout,
    port: ctx.layout.port,
    session,
    detail,
    checkTime: (what) => {
      if (performance.now() - t0 > SCENARIO_TIMEOUT_MS) throw new SmokeError(`${scenario}: ${what} took more than ${SCENARIO_TIMEOUT_MS / 60_000} minutes`);
    },
  };
  const { admin } = ctx.plan.installInput;
  await session.signIn(admin.username, admin.password);
  await SCENARIO_RUNNERS[scenario](s);
  detail['totalSeconds'] = Math.round((performance.now() - t0) / 1000);
}

// ---------------------------------------------------------------------------------------------------------------
// The run

/** The last `lines` lines of each log of the run, to stderr (they never hold the Docker secrets: see dockerEnvText). */
async function showLogs(logDir: string, lines = 40): Promise<void> {
  let names: string[];
  try {
    names = (await fsp.readdir(logDir)).sort();
  } catch {
    return;
  }
  for (const name of names) {
    const text = await fsp.readFile(path.join(logDir, name), 'utf8').catch(() => '');
    const tail = text.trimEnd().split('\n').slice(-lines).join('\n');
    if (tail !== '') process.stderr.write(`----- ${name} (last ${lines} lines)\n${tail}\n`);
  }
}

async function dockerLogs(ctx: RunContext): Promise<void> {
  const result = await execCommand(composeCommand(ctx.layout, ctx.o.db, ctx.plan.start.env, 'docker-logs', ['logs', '--no-color', '--tail', '80', 'app']), ctx.layout.logDir, 60_000).catch(
    () => null,
  );
  if (result !== null && result.stdout.trim() !== '') process.stderr.write(`----- docker compose logs app\n${result.stdout}`);
}

export interface SmokeResult {
  report: SmokeReport;
  failures: string[];
}

/** One smoke run (see the top of this file). Never throws for a failure of the run: it is in `failures`. */
export async function runSmoke(o: SmokeOptions): Promise<SmokeResult> {
  const report: SmokeReport = {
    target: o.target,
    db: o.db,
    node: null,
    zipBytes: null,
    coldStartMs: null,
    rssIdleMb: null,
    healthOk: false,
    budgetsAsserted: budgetsApply(),
  };
  const failures: string[] = [];
  const cleanups: (() => Promise<void>)[] = [];
  const cleanUp = async (): Promise<void> => {
    for (const fn of cleanups.splice(0).reverse()) {
      try {
        await fn();
      } catch (error) {
        say(`cleanup: ${messageOf(error)}`);
      }
    }
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    say(`${signal}: cleaning up`);
    void cleanUp().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  let root: string | undefined;
  let ctx: RunContext | undefined;
  try {
    const zip = await fsp.readFile(o.zip).catch((error: unknown) => {
      throw new SmokeError(`cannot read the zip ${o.zip}: ${messageOf(error)}`);
    });
    report.zipBytes = zip.length;
    const id = randomBytes(4).toString('hex');
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-smoke-')));
    const tempRoot = root;
    cleanups.push(() => fsp.rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
    const layout = smokeLayout(root, await freePort(), id);
    await fsp.mkdir(layout.logDir);
    await extractZip(zip, layout.appRoot);
    const version = (JSON.parse(await fsp.readFile(path.join(layout.appRoot, 'package.json'), 'utf8')) as { version: string }).version;
    say(`${path.basename(o.zip)} (${version}, ${zip.length} bytes) → ${layout.appRoot}; target ${o.target}, db ${o.db}, port ${layout.port}`);

    let db: DbConfig;
    if (o.target === 'docker') {
      db = dockerDb(o.db);
      writePrivateFile(layout.envFile, dockerEnvText(layout, newDockerSecrets(), o.db));
      const override = dockerOverrideText(o.db);
      if (override !== null) await fsp.writeFile(layout.overrideFile, override);
    } else {
      // The drop is registered by provisionDb itself before the database is touched, so no failure leaks it.
      db = await provisionDb(o.db, id, (drop) => void cleanups.push(drop));
      await fsp.mkdir(layout.dataDir, { mode: 0o700 });
    }
    const plan = planSmoke(o, layout, db);
    ctx = { o, layout, plan, version, onCleanup: (fn) => void cleanups.push(fn) };
    if (o.target === 'docker') {
      cleanups.push(async () => {
        for (const c of plan.teardown) await execCommand(c, layout.logDir, 120_000);
      });
    } else {
      writePrivateFile(layout.installFile, `${JSON.stringify(plan.installInput)}\n`);
    }

    for (const c of plan.setup) {
      say(`${c.label}…`);
      await mustRun(c, layout.logDir);
    }
    say('install…');
    await mustRun(plan.install, layout.logDir);
    say(`start (${o.target})…`);
    const measured =
      o.target === 'standalone'
        ? await runStandalone(ctx)
        : o.target === 'pm2'
          ? await runPm2(ctx)
          : o.target === 'passenger-sim'
            ? await runPassengerSim(ctx)
            : await runDocker(ctx);
    report.node = measured.node;
    report.coldStartMs = measured.coldStartMs;
    report.rssIdleMb = measured.rssIdleMb;
    report.healthOk = true;
    if (o.scenario !== null) {
      const detail: Record<string, unknown> = {};
      report.scenario = o.scenario;
      report.scenarioOk = false;
      report.scenarioDetail = detail;
      say(`scenario ${o.scenario}…`);
      await runScenario(ctx, o.scenario, detail);
      report.scenarioOk = true;
      say(`scenario ${o.scenario}: passed (${JSON.stringify(detail)})`);
    }
  } catch (error) {
    failures.push(messageOf(error));
    if (!(error instanceof SmokeError)) process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    if (root !== undefined) await showLogs(path.join(root, 'logs'));
    if (ctx?.o.target === 'docker') await dockerLogs(ctx);
  } finally {
    say('cleaning up…');
    await cleanUp();
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }

  if (report.healthOk) {
    const budget = evaluateBudget(report);
    if (report.budgetsAsserted) failures.push(...budget.failures);
    else {
      say(
        `budgets not asserted on ${process.platform}-${process.arch} (Linux x64 only): coldStartMs ${String(report.coldStartMs)} ` +
          `(budget < ${BUDGETS.coldStartMs}), rssIdleMb ${String(report.rssIdleMb)} (budget < ${BUDGETS.rssIdleMb})` +
          (budget.ok ? '' : ` — would fail: ${budget.failures.join('; ')}`),
      );
    }
  }
  return { report, failures };
}

async function main(argv: string[]): Promise<number> {
  let options: SmokeOptions;
  try {
    options = parseSmokeArgs(argv);
  } catch (error) {
    process.stderr.write(`smoke: ${messageOf(error)}\n`);
    process.stderr.write(
      'usage: pnpm smoke --zip <altis-x.y.z.zip> --target passenger-sim|pm2|docker|standalone --db <engine> [--max-pool <n>] ' +
        `[--scenario ${SCENARIOS.join('|')}]\n` +
        `       pnpm smoke --zip <N-1 zip> --to-zip <N zip> [--to-zip <N+1 zip>] [--feed <dir>] --target <t> --db <engine> --scenario ${UPDATE_SCENARIOS.join('|')}\n`,
    );
    return 2;
  }
  const { report, failures } = await runSmoke(options);
  for (const failure of failures) say(`FAILED: ${failure}`);
  await new Promise<void>((resolve) => process.stdout.write(formatReport(report), () => resolve()));
  return failures.length === 0 && report.healthOk ? 0 : 1;
}

/** Exits once stderr has taken everything written to it (a pipe may still be draining). */
function exitAfterFlush(code: number): void {
  process.stderr.write('', () => process.exit(code));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(exitAfterFlush, (error: unknown) => {
    process.stderr.write(`smoke: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    exitAfterFlush(1);
  });
}
