#!/usr/bin/env tsx
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { MIGRATOR_TABLES, connect, migrationsForLevel, runMigrations, type AltisMigration, type DbConfig, type DbHandle, type TestFixtureLevel } from '@altis/db';
import { updateCurrentState } from '@altis/platform';
import { compareSemver, isSemver } from '@altis/shared';
import { ENGINE_SPECS, TEST_DB_PASSWORD, TEST_DB_ROOT_PASSWORD, TEST_DB_USER, TEST_ENGINES, testDbHost, type TestEngine } from '@altis/test-tools';
import mysql from 'mysql2';
import pg from 'pg';
import { SmokeSession, baseEnv, createSmokeDatabase, newSmokeAdmin, type Admin } from '../smoke/run.js';
import { fixtureLevelOf, schemaFacts } from '../src/build.js';
import { extractZip, readZip } from '../src/zip.js';

// The N−1 test (spec §12.4; plan Task 34):
//
//   pnpm n-1 --from <altis-N−1.zip> --to <altis-N.zip> --db <engine> [--keep] [--ddl-faults]
//
// <engine> is one of the test engines of tools/test/compose.yml (sqlite, mysql80, mysql84, mariadb106, mariadb114,
// pg15, pg17). The zip paths are taken from where pnpm was run (INIT_CWD). --keep keeps the temp folder and the
// database of the last run; --ddl-faults injects the DDL faults on any engine (a local check of the fault runs on
// SQLite or MariaDB; mysql80/mysql84 always get them). §12.4 asks: download the previous release;
// migrate a database that holds data with N; run N−1's `doctor --smoke`; repeat for every prefix of N's migrations, on
// MySQL with a fault injected after every DDL statement. Phase 1 runs it between 0.1.0-test, 0.2.0-test and 0.3.0-test
// (nightly: 0.1→0.2 and 0.2→0.3 on mysql80 and mariadb106).
//
// The plan (planN1, no database, no zip: what the unit test checks):
//   - N's migrations are this checkout's (`migrationsForLevel` of N's fixture level), which must state exactly N's
//     manifest (`schemaLatest`, `minCodeVersionAfter`; N1_MISMATCH otherwise: run the runner from N's commit). N−1's
//     schema is its manifest's `schemaLatest`; N's new migrations are the ones after it, in order.
//   - Each prefix (N's new migrations up to and including one of them) has its DDL count: the DDL statements N runs to
//     migrate N−1's schema to that prefix, counted by running those migrations on a scratch SQLite database built at
//     N−1's schema (CREATE TABLE/INDEX, ALTER TABLE, DROP: every statement the `migrate-ddl` fault counts). The same
//     count holds on MySQL/MariaDB: each ensureTable/ensureIndex/ensureColumn is one statement on every dialect, and
//     the only dialect-specific DDL (ensureByteOrder) runs on PostgreSQL alone. A count above what N runs on the engine
//     fails the run (a `migrate-ddl:<j>` that never fires).
//   - The runner's own tables count first: a runner makes MIGRATOR_TABLES on every run, before any migration, so N
//     creates those N−1's runner did not make (`runner`, RUNNER_TABLE_FIRST_SCHEMA) before its first migration, and
//     the fault counts them like a migration's DDL. The scratch database lacks them as N−1's does, and every prefix's
//     count starts with N's runner making them; each run checks that its seed lacks exactly those tables.
//   - Its runs: one plain migrate; on mysql80/mysql84 (DDL is not transactional there, a migration can stop halfway)
//     also one per DDL statement j, with ALTIS_TEST_FAULT=migrate-ddl:<j> first and then again without the fault.
//   - Its stop: a prefix before the last is reached with ALTIS_TEST_FAULT=migrate:<next> (the migrator throws before
//     the next migration), since `migrate` has no target; the last prefix with a plain migrate.
//   - Its expectation: `SCHEMA_TOO_NEW` when a contract migration in the prefix raises the floor above N−1 (spec §6.4),
//     otherwise `ok`.
//
// Each run (runN1):
//   1. a fresh database (a server engine: a new `altis_n1_<id>` on the compose service, created as root like the
//      smoke run; SQLite: in DATA_DIR) and a fresh DATA_DIR; N−1 installed with `node app.js install --config`, started
//      (standalone, on 127.0.0.1) and seeded through its API as its first super admin: the library settings, two
//      branches, a role, two staff users and their role assignments. That is the seeded snapshot: every run starts
//      from the same seed, made the same way (no engine has a portable database copy, so the seed is made again
//      rather than copied; it is what N−1's own code wrote, on the engine under test).
//   2. the seed's checksums: SHA-256 of the rows of every `data`/`config` table that `schema_tables` lists (`settings`:
//      its `data` rows; instance settings are the installation's, not its data), over the columns N−1 created;
//   3. N's `migrate` (current.json's `active` pointed at N's bundled release, as a zip uploaded again would), with the
//      run's fault, then again with the prefix's stop; schema_migrations must then hold N−1's migrations plus exactly the
//      prefix, and the seed's rows must be unchanged;
//   4. N−1 (`active` pointed back at it): `doctor --smoke --json` and `migrate --json`. `ok`: doctor exit 0, every
//      check ok (the newer schema is supported), and migrate `schema-ahead` (nothing run). `SCHEMA_TOO_NEW`: doctor
//      reports the database as needing a newer ALTIS (the migrations check fails naming the contract floor, the smoke's
//      /_health 503 `schema_too_new`, the database itself reachable; doctor's own exit code stays 1, as 1a pinned it),
//      and N−1's `migrate` refuses with exit 3, SCHEMA_TOO_NEW. Either way N−1 changes no row (never corrupt).
//
// Output: one JSON line per prefix on stdout {from, to, db, prefix, migrations, ddl, contract, expect, ok, runs: [...]};
// progress on stderr; the commands' output under <tmp>/logs (kept with --keep, or printed on failure). Exit 0 when every
// prefix is as expected, 1 otherwise, 2 for a usage error (USAGE, NOT_NEWER, NO_NEW_MIGRATIONS, N1_MISMATCH).

/** The engines whose DDL is not transactional enough to stop a migration halfway (spec §12.4 "di MySQL"). */
export const DDL_FAULT_ENGINES: readonly TestEngine[] = Object.freeze(['mysql80', 'mysql84'] as const);

/** A usage error (exit 2). */
export class N1UsageError extends Error {
  override name = 'N1UsageError';
}

/** A failure of the run (exit 1). */
class N1Error extends Error {
  override name = 'N1Error';
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const say = (line: string): void => void process.stderr.write(`n-1: ${line}\n`);
const isEngine = (value: string): value is TestEngine => (TEST_ENGINES as readonly string[]).includes(value);

// ---------------------------------------------------------------------------------------------------------------
// Command line

export interface N1Options {
  /** Absolute path of N−1's zip. */
  from: string;
  /** Absolute path of N's zip. */
  to: string;
  db: TestEngine;
  /** Keep the temp folder (apps, DATA_DIR, logs) and the database of the last run. */
  keep: boolean;
  /** Inject the DDL faults whatever the engine (DDL_FAULT_ENGINES always get them). */
  ddlFaults: boolean;
}

/**
 * The options of `pnpm n-1 …` (see the top of this file).
 *
 * @throws N1UsageError `USAGE: …`
 */
export function parseN1Args(argv: readonly string[], env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): N1Options {
  const args = argv[0] === '--' ? argv.slice(1) : [...argv];
  let values: Record<string, string | boolean | undefined>;
  try {
    values = parseArgs({
      args,
      strict: true,
      allowPositionals: false,
      options: { from: { type: 'string' }, to: { type: 'string' }, db: { type: 'string' }, keep: { type: 'boolean' }, 'ddl-faults': { type: 'boolean' } },
    }).values;
  } catch (error) {
    throw new N1UsageError(`USAGE: ${messageOf(error)}`, { cause: error });
  }
  const from = values['from'];
  if (typeof from !== 'string' || from === '') throw new N1UsageError('USAGE: --from <altis-N−1.zip> is required');
  const to = values['to'];
  if (typeof to !== 'string' || to === '') throw new N1UsageError('USAGE: --to <altis-N.zip> is required');
  const db = values['db'];
  if (typeof db !== 'string' || !isEngine(db)) throw new N1UsageError(`USAGE: --db must be one of ${TEST_ENGINES.join(', ')}`);
  const base = env['INIT_CWD'] !== undefined && env['INIT_CWD'] !== '' ? env['INIT_CWD'] : cwd;
  return { from: path.resolve(base, from), to: path.resolve(base, to), db, keep: values['keep'] === true, ddlFaults: values['ddl-faults'] === true };
}

// ---------------------------------------------------------------------------------------------------------------
// The plan

/** What the plan needs of a release: its signed manifest's facts. */
export interface ReleaseFacts {
  version: string;
  /** NNNN of its last migration. */
  schemaLatest: string;
  /** The highest contract floor of its migrations, else 0.0.0. */
  minCodeVersionAfter: string;
}

/** One prefix of N's new migrations. */
export interface N1Prefix {
  /** The last migration of the prefix. */
  migration: string;
  /** N's new migrations up to and including `migration`, in order. */
  migrations: string[];
  /** DDL statements N runs from N−1's schema to the end of the prefix. */
  ddl: number;
  /** The highest contract floor in the prefix (`minCodeVersion`), or null for an expand-only prefix. */
  contract: string | null;
  /** The fault of each run: null for the plain migrate, else `migrate-ddl:<j>` (DDL_FAULT_ENGINES only). */
  runs: (string | null)[];
  /** The fault that stops N at this prefix (`migrate:<next>`), or null for the last prefix. */
  stop: string | null;
  /** What N−1 must make of the database afterwards. */
  expect: 'ok' | 'SCHEMA_TOO_NEW';
}

export interface N1Plan {
  from: ReleaseFacts;
  to: ReleaseFacts;
  db: TestEngine;
  /** N's migrations N−1's schema already holds (the seed's), in order. */
  base: string[];
  /**
   * The runner's own tables N−1's database lacks (its runner did not make them), which N's runner creates before its
   * first migration: the first DDL statements of every prefix, in this order.
   */
  runner: string[];
  prefixes: N1Prefix[];
}

/** One of the runner's own tables. */
type RunnerTable = (typeof MIGRATOR_TABLES)[number];

/**
 * The schema (the NNNN of its last migration) of the first release whose runner made each of the runner's own tables
 * (MIGRATOR_TABLES). A runner makes its tables on every run, before any migration; a database installed by an older
 * release lacks the newer ones until N's runner creates them. The other lane's two tables came with the release whose
 * migrations reached 0030. A table added to MIGRATOR_TABLES needs its entry here (the unit test checks).
 */
export const RUNNER_TABLE_FIRST_SCHEMA: Readonly<Record<RunnerTable, string>> = Object.freeze({
  schema_migrations: '0001',
  schema_migrations_lock: '0001',
  schema_migrations_edition: '0030',
  schema_migrations_edition_lock: '0030',
});

/** The runner's own tables a database installed by a release at schema `schemaLatest` lacks, in MIGRATOR_TABLES order. */
export function runnerTablesMissingAt(schemaLatest: string): string[] {
  return MIGRATOR_TABLES.filter((t) => RUNNER_TABLE_FIRST_SCHEMA[t] > schemaLatest);
}

const isTestVersion = (version: string): boolean => {
  const core = version.split('+')[0]!;
  const dash = core.indexOf('-');
  return dash !== -1 && /test/i.test(core.slice(dash + 1));
};

/** The fixture level of a release as the release build gives it (fixtureLevelOf: test versions carry `test`). */
export function levelOfVersion(version: string): TestFixtureLevel {
  return fixtureLevelOf(isTestVersion(version) ? 'test' : 'production', version);
}

/** The NNNN of a migration name. */
const numberOf = (name: string): string => name.slice(0, 4);

/** The plugin argument of Kysely's withPlugin, as @altis/db's handle types it (tools/release has no kysely of its own). */
type KyselyPlugin = Parameters<DbHandle['db']['withPlugin']>[0];

/** The DDL a node is: a schema builder statement, or a raw statement that starts with CREATE, ALTER or DROP. */
function isDdlNode(node: { kind: string; sqlFragments?: readonly string[] }): boolean {
  if (/^(Create|Alter|Drop)[A-Za-z]*Node$/.test(node.kind)) return true;
  return node.kind === 'RawNode' && /^\s*(CREATE|ALTER|DROP)\b/i.test((node.sqlFragments ?? []).join(''));
}

/**
 * What the `migrate-ddl` fault counts when N migrates N−1's schema, on a scratch SQLite database (in `scratchDir`)
 * migrated with `base` first and then made to lack `runner` (the runner's own tables N−1's runner did not make, and
 * their registry rows), as N−1's database does: `runner`, the DDL statements N's runner executes before any migration
 * (it makes those tables again); `migrations`, the DDL statements each of `added` runs, in order. The schema builder's
 * statements are one per object on every dialect (ensureTable, ensureIndex, ensureColumn); PostgreSQL's collation
 * fix-up (ensureByteOrder) never runs on the engines that get the DDL faults.
 */
export async function countDdl(
  base: Readonly<Record<string, AltisMigration>>,
  added: readonly [string, AltisMigration][],
  o: { appVersion: string; scratchDir: string; runner?: readonly string[] },
): Promise<{ runner: number; migrations: number[] }> {
  const h = await connect({ dialect: 'sqlite' }, { runtime: 'standalone', purpose: 'cli', dataDir: o.scratchDir });
  try {
    await runMigrations(h, { appVersion: o.appVersion, dataDir: o.scratchDir, migrations: { ...base } });
    for (const table of o.runner ?? []) {
      await h.db.schema.dropTable(table).execute();
      await h.db.deleteFrom('schema_tables').where('name', '=', table).execute();
    }
    let count = 0;
    const counter: KyselyPlugin = {
      transformQuery(args) {
        if (isDdlNode(args.node as unknown as { kind: string; sqlFragments?: readonly string[] })) count += 1;
        return args.node;
      },
      transformResult: async (args) => args.result,
    };
    // N's runner on N−1's schema with nothing to apply: only its own tables' DDL.
    await runMigrations({ db: h.db.withPlugin(counter), dialect: h.dialect }, { appVersion: o.appVersion, dataDir: o.scratchDir, migrations: { ...base } });
    const runner = count;
    const migrations: number[] = [];
    for (const [, migration] of added) {
      count = 0;
      await migration.up(h.db.withPlugin(counter), 'sqlite');
      migrations.push(count);
    }
    return { runner, migrations };
  } finally {
    await h.close();
  }
}

/**
 * The plan of `--from` → `--to` on `db` (see the top of this file).
 *
 * @throws N1UsageError `NOT_NEWER` (N is not newer than N−1), `N1_MISMATCH` (this checkout's migrations are not N's, or
 *   do not hold N−1's schema), `NO_NEW_MIGRATIONS` (N adds none: nothing to test)
 */
export async function planN1(
  from: ReleaseFacts,
  to: ReleaseFacts,
  db: TestEngine,
  o: { scratchDir?: string; ddlFaults?: boolean } = {},
): Promise<N1Plan> {
  for (const r of [from, to]) {
    if (!isSemver(r.version) || !/^\d{4}$/.test(r.schemaLatest) || !isSemver(r.minCodeVersionAfter)) {
      throw new N1UsageError(`N1_MISMATCH: the manifest of ${JSON.stringify(r.version)} is not a release manifest`);
    }
  }
  if (compareSemver(to.version, from.version) <= 0) throw new N1UsageError(`NOT_NEWER: ${to.version} is not newer than ${from.version}`);
  const level = levelOfVersion(to.version);
  const facts = schemaFacts(level);
  if (facts.schemaLatest !== to.schemaLatest || facts.minCodeVersionAfter !== to.minCodeVersionAfter) {
    throw new N1UsageError(
      `N1_MISMATCH: ${to.version} states schema ${to.schemaLatest} (floor ${to.minCodeVersionAfter}), this checkout's migrations ` +
        `${facts.schemaLatest} (floor ${facts.minCodeVersionAfter}); run the runner from the commit that built ${to.version}`,
    );
  }
  const all = migrationsForLevel(level);
  const names = Object.keys(all).sort(byText);
  const base = names.filter((n) => numberOf(n) <= from.schemaLatest);
  if (base.length === 0 || numberOf(base.at(-1)!) !== from.schemaLatest) {
    throw new N1UsageError(`N1_MISMATCH: ${to.version}'s migrations do not hold ${from.version}'s schema ${from.schemaLatest}`);
  }
  const added = names.filter((n) => numberOf(n) > from.schemaLatest);
  if (added.length === 0) throw new N1UsageError(`NO_NEW_MIGRATIONS: ${to.version} adds no migration to ${from.version}'s schema ${from.schemaLatest}`);

  const runner = runnerTablesMissingAt(from.schemaLatest);
  const own = o.scratchDir === undefined;
  const scratchDir = o.scratchDir ?? (await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-n1-ddl-')));
  let counts: { runner: number; migrations: number[] };
  try {
    counts = await countDdl(Object.fromEntries(base.map((n) => [n, all[n]!])), added.map((n) => [n, all[n]!] as [string, AltisMigration]), {
      appVersion: from.version,
      scratchDir,
      runner,
    });
  } finally {
    if (own) await fsp.rm(scratchDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  const faults = o.ddlFaults === true || DDL_FAULT_ENGINES.includes(db);
  const prefixes: N1Prefix[] = [];
  // N's runner makes the tables N−1's runner did not before its first migration: the first DDL of every prefix.
  let ddl = counts.runner;
  let contract: string | null = null;
  added.forEach((name, i) => {
    ddl += counts.migrations[i]!;
    const floor = all[name]!.contract?.minCodeVersion;
    if (floor !== undefined && (contract === null || compareSemver(floor, contract) > 0)) contract = floor;
    const next = added[i + 1];
    const runs: (string | null)[] = [null];
    if (faults) for (let j = 1; j <= ddl; j += 1) runs.push(`migrate-ddl:${j}`);
    prefixes.push({
      migration: name,
      migrations: added.slice(0, i + 1),
      ddl,
      contract,
      runs,
      stop: next === undefined ? null : `migrate:${next}`,
      expect: contract !== null && compareSemver(contract, from.version) > 0 ? 'SCHEMA_TOO_NEW' : 'ok',
    });
  });
  return { from, to, db, base, runner, prefixes };
}

/** The facts of the release a zip holds: its `bundled-release/<v>/manifest.json`. */
export function releaseFactsOf(zip: Uint8Array): ReleaseFacts {
  const manifests = readZip(zip).filter((e) => /^bundled-release\/[^/]+\/manifest\.json$/.test(e.path));
  if (manifests.length !== 1) throw new N1UsageError('USAGE: not an ALTIS release zip (one bundled-release/<v>/manifest.json expected)');
  const m = JSON.parse(manifests[0]!.data.toString('utf8')) as Partial<ReleaseFacts>;
  return { version: String(m.version), schemaLatest: String(m.schemaLatest), minCodeVersionAfter: String(m.minCodeVersionAfter) };
}

// ---------------------------------------------------------------------------------------------------------------
// Processes and HTTP (node:http: global fetch is not used in this repository, P18)

interface Finished {
  code: number | null;
  stdout: string;
  stderr: string;
}

const COMMAND_TIMEOUT_MS = 5 * 60_000;
const HEALTH_TIMEOUT_MS = 90_000;
const STOP_GRACE_MS = 15_000;

/** Runs `node app.js <args>` in `appRoot` to completion; its output kept and appended to `<logDir>/<label>.log`. */
async function runApp(appRoot: string, args: readonly string[], env: Record<string, string>, logDir: string, label: string): Promise<Finished> {
  const log = fs.createWriteStream(path.join(logDir, `${label}.log`), { flags: 'a' });
  log.write(`$ node app.js ${args.join(' ')}  (${Object.keys(env).filter((k) => k.startsWith('ALTIS_')).map((k) => `${k}=${env[k]}`).join(' ')})\n`);
  try {
    return await new Promise<Finished>((resolve, reject) => {
      const child = spawn(process.execPath, ['app.js', ...args], { cwd: appRoot, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
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
        reject(new N1Error(`${label}: no result after ${COMMAND_TIMEOUT_MS} ms`));
      }, COMMAND_TIMEOUT_MS);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(new N1Error(`${label}: node could not be started: ${messageOf(error)}`));
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
  } finally {
    await new Promise<void>((resolve) => log.end(resolve));
  }
}

/** The last JSON line a `--json` command printed, or null. */
export function lastJsonLine(stdout: string): Record<string, unknown> | null {
  const lines = stdout.split('\n').filter((l) => l.trim().startsWith('{'));
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const value: unknown = JSON.parse(lines[i]!);
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch {
      // not JSON
    }
  }
  return null;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

function getHealth(port: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/_health', agent: false, headers: { connection: 'close' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      res.on('error', reject);
    });
    req.setTimeout(10_000, () => req.destroy(new Error('no answer within 10 s')));
    req.once('error', reject);
    req.end();
  });
}

/** A running `node app.js` (standalone: app.js supervises the server process it forks). */
interface Server {
  stop(): Promise<void>;
}

/** Starts `node app.js` in `appRoot` on `port` and waits for /_health 200 `ok` of `version`. */
async function startServer(appRoot: string, env: Record<string, string>, port: number, version: string, logDir: string, label: string): Promise<Server> {
  const fd = fs.openSync(path.join(logDir, `${label}.log`), 'a');
  const child = spawn(process.execPath, ['app.js'], { cwd: appRoot, env: { ...env, ALTIS_PORT: String(port) }, stdio: ['ignore', fd, fd], windowsHide: true });
  fs.closeSync(fd);
  let failure: string | null = null;
  child.on('error', (error) => void (failure ??= messageOf(error)));
  const server: Server = {
    async stop() {
      if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      // The supervisor forwards SIGTERM to the server process and exits with it; the child never outlives it.
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), STOP_GRACE_MS);
      await exited;
      clearTimeout(timer);
    },
  };
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let last = 'no answer';
  try {
    for (;;) {
      if (failure !== null) throw new N1Error(`${label}: ${failure}`);
      if (child.exitCode !== null || child.signalCode !== null) throw new N1Error(`${label}: app.js exited before /_health answered 200 (last: ${last})`);
      if (Date.now() > deadline) throw new N1Error(`${label}: /_health did not answer 200 within ${HEALTH_TIMEOUT_MS} ms (last: ${last})`);
      try {
        const reply = await getHealth(port);
        last = `${reply.status} ${reply.body.slice(0, 200)}`;
        if (reply.status === 200) {
          const body = JSON.parse(reply.body) as { status?: unknown; version?: unknown };
          if (body.status === 'ok') {
            if (body.version !== version) throw new N1Error(`${label}: /_health reports ${String(body.version)}, expected ${version}`);
            return server;
          }
        }
      } catch (error) {
        if (error instanceof N1Error) throw error;
        last = messageOf(error);
      }
      await sleep(100);
    }
  } catch (error) {
    await server.stop();
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Databases

type ServerDialect = Exclude<DbConfig['dialect'], 'sqlite'>;

async function mysqlAdmin(port: number): Promise<Admin> {
  const conn = mysql.createConnection({ host: testDbHost(), port, user: 'root', password: TEST_DB_ROOT_PASSWORD, connectTimeout: 5000 });
  conn.on('error', () => {});
  await new Promise<void>((resolve, reject) => conn.connect((e) => (e ? reject(e) : resolve())));
  return {
    run: (statement, values = []) => new Promise<void>((resolve, reject) => conn.query(statement, values, (e) => (e ? reject(e) : resolve()))),
    close: () => new Promise<void>((resolve) => conn.end(() => resolve())),
  };
}

async function pgAdmin(port: number): Promise<Admin> {
  const client = new pg.Client({ host: testDbHost(), port, user: 'postgres', password: TEST_DB_ROOT_PASSWORD, database: 'postgres', connectionTimeoutMillis: 5000 });
  client.on('error', () => {});
  await client.connect();
  return { run: async (statement, values = []) => void (await client.query(statement, values)), close: () => client.end() };
}

function probePort(host: string, port: number): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (result: string | null): void => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(5000, () => done('ETIMEDOUT'));
    socket.once('connect', () => done(null));
    socket.once('error', (e: NodeJS.ErrnoException) => done(e.code ?? 'ECONNREFUSED'));
  });
}

/**
 * A fresh, empty database of the run on `engine` (SQLite: in DATA_DIR, nothing to make). A server database is dropped
 * first when a previous run left it, and its drop is handed to `registerDrop` before it is touched.
 */
async function freshDatabase(engine: TestEngine, name: string, registerDrop: (drop: () => Promise<void>) => void): Promise<DbConfig> {
  const { dialect, port } = ENGINE_SPECS[engine];
  if (dialect === 'sqlite' || port === null) return { dialect: 'sqlite' };
  const host = testDbHost();
  const unreachable = await probePort(host, port);
  if (unreachable !== null) {
    throw new N1Error(`${engine} is not reachable on ${host}:${port} (${unreachable}); start it with: docker compose -f tools/test/compose.yml up -d --wait ${engine}`);
  }
  const open = (): Promise<Admin> => (dialect === 'postgres' ? pgAdmin(port) : mysqlAdmin(port));
  const admin = await open();
  try {
    if (dialect === 'postgres') await admin.run(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(name)} WITH (FORCE)`);
    else await admin.run('DROP DATABASE IF EXISTS ??', [name]);
  } finally {
    await admin.close();
  }
  await createSmokeDatabase(dialect as ServerDialect, name, open, registerDrop);
  return { dialect, host, port, user: TEST_DB_USER, password: TEST_DB_PASSWORD, database: name };
}

/** A value as the checksum writes it: the same text for the same stored value, whatever the driver gave. */
function canonicalValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Uint8Array) return `hex:${Buffer.from(value).toString('hex')}`;
  if (value instanceof Date) return `date:${value.toISOString()}`;
  if (typeof value === 'bigint' || typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  return value;
}

/** The tables and columns a checksum covers. */
export type ChecksumScope = Record<string, string[]>;

/** The `data` and `config` tables `schema_tables` lists, with the columns each has now (sorted). */
async function dataScope(h: DbHandle): Promise<ChecksumScope> {
  const listed = await h.db.selectFrom('schema_tables').select(['name', 'class']).execute();
  const wanted = new Set(listed.filter((r) => r.class === 'data' || r.class === 'config').map((r) => r.name));
  const scope: ChecksumScope = {};
  for (const t of await h.db.introspection.getTables()) {
    if (!wanted.has(t.name)) continue;
    scope[t.name] = t.columns.map((c) => c.name).sort(byText);
  }
  return scope;
}

/** SHA-256 per table of `scope`: its rows (only `scope = 'data'` of `settings`), each a JSON array of its columns, sorted. */
async function checksums(h: DbHandle, scope: ChecksumScope): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const table of Object.keys(scope).sort(byText)) {
    const columns = scope[table]!;
    // The table and its columns come from the database's own catalog; Kysely quotes them as identifiers.
    let query = h.db.selectFrom(table as never).select(columns as never);
    if (table === 'settings') query = query.where('scope' as never, '=', 'data' as never);
    const rows = (await query.execute()) as Record<string, unknown>[];
    const lines = rows.map((row) => JSON.stringify(columns.map((c) => canonicalValue(row[c])))).sort(byText);
    out[table] = createHash('sha256').update(lines.join('\n')).digest('hex');
  }
  return out;
}

async function withDb<T>(db: DbConfig, dataDir: string, fn: (h: DbHandle) => Promise<T>): Promise<T> {
  const h = await connect(db, { runtime: 'standalone', purpose: 'cli', dataDir });
  try {
    return await fn(h);
  } finally {
    await h.close();
  }
}

/** The runner's own tables (MIGRATOR_TABLES) the database lacks, in MIGRATOR_TABLES order. */
async function missingRunnerTables(h: DbHandle): Promise<string[]> {
  const present = new Set((await h.db.introspection.getTables()).map((t) => t.name));
  return MIGRATOR_TABLES.filter((t) => !present.has(t));
}

/** The names in schema_migrations, sorted. */
async function appliedMigrations(h: DbHandle): Promise<string[]> {
  return (await h.db.selectFrom('schema_migrations').select('name').execute()).map((r) => r.name).sort(byText);
}

/** The tables whose checksums differ (or are missing on one side). */
function changedTables(a: Record<string, string>, b: Record<string, string>): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((t) => a[t] !== b[t]).sort(byText);
}

// ---------------------------------------------------------------------------------------------------------------
// A run

/** What one run of a prefix saw. */
export interface N1Run {
  fault: string | null;
  /** The faulted migrate: its exit code and failure code (null without a fault). */
  faulted: { exit: number | null; code: string | null; detail: string | null } | null;
  /** N's migrate to the prefix (with the stop fault for a prefix before the last). */
  migrate: { exit: number | null; code: string | null; mode: string | null; detail: string | null };
  /** schema_migrations afterwards: N−1's plus exactly the prefix. */
  schemaOk: boolean;
  /** The seed's rows unchanged by N. */
  seedIntact: boolean;
  doctor: { exit: number | null; ok: boolean | null; migrations: string | null; smoke: string | null; db: boolean | null };
  /** N−1's own migrate: exit 0 `schema-ahead`, or exit 3 SCHEMA_TOO_NEW. */
  n1Migrate: { exit: number | null; code: string | null; mode: string | null };
  /** No row changed by N−1's commands. */
  n1Intact: boolean;
  verdict: 'ok' | 'SCHEMA_TOO_NEW' | 'unexpected';
  ok: boolean;
  problems: string[];
}

export interface N1Line {
  from: string;
  to: string;
  db: TestEngine;
  prefix: string;
  migrations: string[];
  ddl: number;
  contract: string | null;
  expect: N1Prefix['expect'];
  ok: boolean;
  runs: N1Run[];
}

interface RunContext {
  plan: N1Plan;
  root: string;
  fromApp: string;
  toApp: string;
  dataDir: string;
  logDir: string;
  port: number;
  dbName: string;
  registerDrop(drop: () => Promise<void>): void;
}

/** Points current.json's `active` at `version`, the bundled release of the app folder about to run (a zip uploaded again). */
async function activate(dataDir: string, version: string): Promise<void> {
  await updateCurrentState(dataDir, (s) => ({ ...s, active: { version, source: 'bundled' }, previous: null, pending: null, pendingSince: null, pinned: null }));
}

/** N−1 installed on a fresh database and DATA_DIR, started, seeded through its API, stopped. */
async function seed(ctx: RunContext, label: string): Promise<DbConfig> {
  await fsp.rm(ctx.dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  const db = await freshDatabase(ctx.plan.db, ctx.dbName, ctx.registerDrop);
  const env = { ...baseEnv(), ALTIS_DATA_DIR: ctx.dataDir };
  const admin = newSmokeAdmin();
  const input = path.join(ctx.root, 'install.json');
  await fsp.writeFile(input, `${JSON.stringify({ baseUrl: `http://127.0.0.1:${ctx.port}`, db, admin })}\n`, { mode: 0o600 });
  try {
    const install = await runApp(ctx.fromApp, ['install', '--config', input, '--json'], env, ctx.logDir, `${label}-install`);
    if (install.code !== 0) throw new N1Error(`${label}: install of ${ctx.plan.from.version} failed with exit code ${String(install.code)}`);
  } finally {
    await fsp.rm(input, { force: true });
  }
  const server = await startServer(ctx.fromApp, env, ctx.port, ctx.plan.from.version, ctx.logDir, `${label}-server`);
  try {
    const s = new SmokeSession(ctx.port);
    await s.signIn(admin.username, admin.password);
    await s.call('POST', 'auth/reauth', { password: admin.password });
    await s.call('PUT', 'settings/library', { name: 'Perpustakaan Uji N−1', address: 'Jalan Rilis Lama 1' });
    for (const [code, name] of [
      ['UTARA', 'Cabang Utara'],
      ['SELATAN', 'Cabang Selatan ✓'],
    ] as const) {
      await s.call('POST', 'branches', { code, name, address: `Jalan ${name}`, timezone: 'Asia/Jakarta' });
    }
    const role = await s.call<{ id: string }>('POST', 'roles', { name: 'Petugas Uji N−1', description: 'Peran uji N−1', permissions: ['system.users.read'] });
    for (const i of [1, 2]) {
      const user = await s.call<{ id: string }>('POST', 'users', {
        username: `staf_n1_${i}`,
        name: `Staf Uji ${i}`,
        email: `staf${i}@n1.test`,
        password: `${randomBytes(12).toString('hex')}-Uji`,
      });
      // Global: Phase 1 has only system permissions, which a branch-scoped assignment refuses (ROLE_SCOPE_INVALID).
      await s.call('PUT', `users/${user.id}/roles`, { assignments: [{ roleId: role.id, branchId: null }] });
    }
  } finally {
    await server.stop();
  }
  return db;
}

function jsonField(json: Record<string, unknown> | null, key: string): string | null {
  const value = json?.[key];
  return typeof value === 'string' ? value : null;
}

/** One run of `prefix` with `fault` (see the top of this file). */
async function runOnce(ctx: RunContext, prefix: N1Prefix, fault: string | null, label: string): Promise<N1Run> {
  const { plan } = ctx;
  const problems: string[] = [];
  const db = await seed(ctx, label);
  const env = { ...baseEnv(), ALTIS_DATA_DIR: ctx.dataDir };

  const seedScope = await withDb(db, ctx.dataDir, (h) => dataScope(h));
  const seedSums = await withDb(db, ctx.dataDir, (h) => checksums(h, seedScope));
  const seedApplied = await withDb(db, ctx.dataDir, (h) => appliedMigrations(h));
  if (seedApplied.join() !== plan.base.join()) problems.push(`the seed holds ${seedApplied.join(', ')}, not ${plan.base.join(', ')}`);
  // The plan counted N's runner making these tables first; any other set moves every `migrate-ddl` fault off its statement.
  const seedLacks = await withDb(db, ctx.dataDir, (h) => missingRunnerTables(h));
  if (seedLacks.join() !== plan.runner.join()) {
    problems.push(`the seed lacks the runner's tables [${seedLacks.join(', ')}], the plan counted [${plan.runner.join(', ')}]: its DDL faults would hit other statements`);
  }

  // N migrates: the faulted run first, then the run to the prefix.
  await activate(ctx.dataDir, plan.to.version);
  let faulted: N1Run['faulted'] = null;
  if (fault !== null) {
    const r = await runApp(ctx.toApp, ['migrate', '--json'], { ...env, ALTIS_TEST_FAULT: fault }, ctx.logDir, `${label}-n-migrate-faulted`);
    const json = lastJsonLine(r.stdout);
    faulted = { exit: r.code, code: jsonField(json, 'code'), detail: jsonField(json, 'detail') };
    if (r.code === 0) problems.push(`${fault} never fired: N ran fewer DDL statements than the plan's ${prefix.ddl}`);
  }
  const m = await runApp(ctx.toApp, ['migrate', '--json'], prefix.stop === null ? env : { ...env, ALTIS_TEST_FAULT: prefix.stop }, ctx.logDir, `${label}-n-migrate`);
  const mj = lastJsonLine(m.stdout);
  const migrate = { exit: m.code, code: jsonField(mj, 'code'), mode: jsonField(mj, 'mode'), detail: jsonField(mj, 'detail') };
  if (prefix.stop === null) {
    if (m.code !== 0) problems.push(`N's migrate failed: exit ${String(m.code)} ${migrate.code ?? ''}`.trimEnd());
  } else {
    const next = prefix.stop.slice('migrate:'.length);
    if (m.code === 0 || !(migrate.detail ?? '').includes(next)) problems.push(`N's migrate did not stop before ${next}: exit ${String(m.code)} ${migrate.detail ?? ''}`.trimEnd());
  }
  const applied = await withDb(db, ctx.dataDir, (h) => appliedMigrations(h));
  const expected = [...plan.base, ...prefix.migrations].sort(byText);
  const schemaOk = applied.join() === expected.join();
  if (!schemaOk) problems.push(`schema_migrations holds ${applied.join(', ')}, expected ${expected.join(', ')}`);
  const afterN = await withDb(db, ctx.dataDir, (h) => checksums(h, seedScope));
  const changedByN = changedTables(seedSums, afterN);
  const seedIntact = changedByN.length === 0;
  if (!seedIntact) problems.push(`N changed the seed's rows of ${changedByN.join(', ')}`);
  const fullScope = await withDb(db, ctx.dataDir, (h) => dataScope(h));
  const beforeN1 = await withDb(db, ctx.dataDir, (h) => checksums(h, fullScope));

  // N−1 looks at the database N left.
  await activate(ctx.dataDir, plan.from.version);
  const d = await runApp(ctx.fromApp, ['doctor', '--smoke', '--json'], env, ctx.logDir, `${label}-n1-doctor`);
  const dj = lastJsonLine(d.stdout);
  const checks = (dj?.['checks'] ?? {}) as Record<string, { ok?: unknown; detail?: unknown } | undefined>;
  const smoke = dj?.['smoke'] as { ok?: unknown; detail?: unknown } | undefined;
  const doctor = {
    exit: d.code,
    ok: typeof dj?.['ok'] === 'boolean' ? dj['ok'] : null,
    migrations: typeof checks['migrations']?.detail === 'string' ? checks['migrations'].detail : null,
    smoke: typeof smoke?.detail === 'string' ? smoke.detail : null,
    db: typeof checks['db']?.ok === 'boolean' ? checks['db'].ok : null,
  };
  const nm = await runApp(ctx.fromApp, ['migrate', '--json'], env, ctx.logDir, `${label}-n1-migrate`);
  const nmj = lastJsonLine(nm.stdout);
  const n1Migrate = { exit: nm.code, code: jsonField(nmj, 'code'), mode: jsonField(nmj, 'mode') };
  const afterN1 = await withDb(db, ctx.dataDir, (h) => checksums(h, fullScope));
  const changedByN1 = changedTables(beforeN1, afterN1);
  const n1Intact = changedByN1.length === 0;
  if (!n1Intact) problems.push(`N−1 changed the rows of ${changedByN1.join(', ')}`);

  let verdict: N1Run['verdict'] = 'unexpected';
  const migrationsOk = checks['migrations']?.ok === true;
  if (d.code === 0 && doctor.ok === true && migrationsOk && smoke?.ok === true && nm.code === 0 && n1Migrate.mode === 'schema-ahead') {
    verdict = 'ok';
  } else if (
    d.code === 1 &&
    checks['migrations']?.ok === false &&
    prefix.contract !== null &&
    (doctor.migrations ?? '').includes(prefix.contract) &&
    doctor.db === true &&
    /\b503\b/.test(doctor.smoke ?? '') &&
    /schema_too_new/.test(doctor.smoke ?? '') &&
    nm.code === 3 &&
    n1Migrate.code === 'SCHEMA_TOO_NEW'
  ) {
    verdict = 'SCHEMA_TOO_NEW';
  }
  if (verdict !== prefix.expect) {
    problems.push(
      `N−1 made ${verdict} of it, expected ${prefix.expect}: doctor exit ${String(d.code)} (migrations: ${doctor.migrations ?? '?'}; ` +
        `smoke: ${doctor.smoke ?? '?'}), migrate exit ${String(nm.code)} ${n1Migrate.code ?? n1Migrate.mode ?? ''}`.trimEnd(),
    );
  }
  return { fault, faulted, migrate, schemaOk, seedIntact, doctor, n1Migrate, n1Intact, verdict, ok: problems.length === 0, problems };
}

/** Runs `plan` with the zips `o.from` and `o.to`: one line per prefix, in order. */
export async function runN1(plan: N1Plan, o: N1Options, emit: (line: N1Line) => void = () => {}): Promise<N1Line[]> {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-n1-')));
  const drops: (() => Promise<void>)[] = [];
  const id = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
  const ctx: RunContext = {
    plan,
    root,
    fromApp: path.join(root, 'from-app'),
    toApp: path.join(root, 'to-app'),
    dataDir: path.join(root, 'altis-data'),
    logDir: path.join(root, 'logs'),
    port: await freePort(),
    dbName: `altis_n1_${id}`,
    registerDrop: (drop) => void drops.push(drop),
  };
  const lines: N1Line[] = [];
  let failed = false;
  try {
    await fsp.mkdir(ctx.logDir, { recursive: true });
    await extractZip(await fsp.readFile(o.from), ctx.fromApp);
    await extractZip(await fsp.readFile(o.to), ctx.toApp);
    for (const prefix of plan.prefixes) {
      const runs: N1Run[] = [];
      for (const fault of prefix.runs) {
        const label = `${prefix.migration}${fault === null ? '' : `-${fault.replace(':', '-')}`}`;
        say(`${plan.from.version} → ${plan.to.version} on ${plan.db}: prefix ${prefix.migration}${fault === null ? '' : ` with ${fault}`}`);
        try {
          runs.push(await runOnce(ctx, prefix, fault, label));
        } catch (error) {
          runs.push({
            fault,
            faulted: null,
            migrate: { exit: null, code: null, mode: null, detail: null },
            schemaOk: false,
            seedIntact: false,
            doctor: { exit: null, ok: null, migrations: null, smoke: null, db: null },
            n1Migrate: { exit: null, code: null, mode: null },
            n1Intact: false,
            verdict: 'unexpected',
            ok: false,
            problems: [messageOf(error)],
          });
        }
      }
      const line: N1Line = {
        from: plan.from.version,
        to: plan.to.version,
        db: plan.db,
        prefix: prefix.migration,
        migrations: prefix.migrations,
        ddl: prefix.ddl,
        contract: prefix.contract,
        expect: prefix.expect,
        ok: runs.every((r) => r.ok),
        runs,
      };
      if (!line.ok) failed = true;
      lines.push(line);
      emit(line);
    }
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    if (failed) await showLogs(ctx.logDir);
    for (const drop of drops.reverse()) {
      if (o.keep) break;
      try {
        await drop();
      } catch (error) {
        say(`could not drop the run's database: ${messageOf(error)}`);
      }
    }
    if (o.keep) say(`kept: ${root} (database ${plan.db === 'sqlite' ? 'in DATA_DIR' : ctx.dbName})`);
    else await fsp.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  return lines;
}

/** The tail of every command log of a failed run, on stderr. */
async function showLogs(logDir: string, lines = 30): Promise<void> {
  let names: string[];
  try {
    names = (await fsp.readdir(logDir)).sort(byText);
  } catch {
    return;
  }
  for (const name of names) {
    const text = await fsp.readFile(path.join(logDir, name), 'utf8').catch(() => '');
    process.stderr.write(`----- ${name} (last ${lines} lines) -----\n${text.split('\n').slice(-lines).join('\n')}\n`);
  }
}

async function main(argv: string[]): Promise<number> {
  let options: N1Options;
  let plan: N1Plan;
  try {
    options = parseN1Args(argv);
    plan = await planN1(releaseFactsOf(await fsp.readFile(options.from)), releaseFactsOf(await fsp.readFile(options.to)), options.db, {
      ddlFaults: options.ddlFaults,
    });
  } catch (error) {
    if (!(error instanceof N1UsageError)) throw error;
    say(messageOf(error));
    process.stderr.write('usage: pnpm n-1 --from <altis-N−1.zip> --to <altis-N.zip> --db <engine> [--keep] [--ddl-faults]\n');
    return 2;
  }
  say(`plan: runner tables first ${JSON.stringify(plan.runner)}; ${JSON.stringify(plan.prefixes.map((p) => ({ prefix: p.migration, ddl: p.ddl, runs: p.runs, stop: p.stop, expect: p.expect })))}`);
  const lines = await runN1(plan, options, (line) => void process.stdout.write(`${JSON.stringify(line)}\n`));
  for (const line of lines) {
    for (const run of line.runs) for (const problem of run.problems) say(`FAILED ${line.prefix}${run.fault === null ? '' : ` (${run.fault})`}: ${problem}`);
  }
  return lines.every((l) => l.ok) ? 0 : 1;
}

/** Exits once stderr has taken everything written to it (a pipe may still be draining). */
function exitAfterFlush(code: number): void {
  process.stderr.write('', () => process.exit(code));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(exitAfterFlush, (error: unknown) => {
    process.stderr.write(`n-1: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    exitAfterFlush(1);
  });
}
