import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import net from 'node:net';
import mysql from 'mysql2';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import {
  ENGINE_SPECS,
  TEST_DB_PASSWORD,
  TEST_DB_ROOT_PASSWORD,
  TEST_DB_USER,
  parseSourceEngine,
  parseTestEngine,
  testDbHost,
  testDbName,
  testRunDir,
  type TestDbContext,
  type TestEngine,
} from './test-db.js';

// Global setup of the `db` Vitest project (vitest.config.ts).
//
// - ALTIS_TEST_DB picks the engine (unset: sqlite).
// - For a server engine it connects as root/superuser and creates one database per worker,
//   `altis_t_<runId>_<1..maxWorkers>`, owned by / granted to the test user `altis`; teardown drops them.
// - An engine whose port does not answer is reported as not available: the suites skip with the reason in their
//   title, so `pnpm test:db` passes without Docker. With ALTIS_TEST_DB_REQUIRED=1 (CI) the run fails instead.
// - 1c Task 29 (preflight M37): ALTIS_TEST_DB_SOURCE names a second engine (the source of the restore matrix); when it
//   is another server engine, the same per-worker databases are created (and dropped) on its server too, under the
//   same rules (not reachable: `sourceAvailable: false`, or a failed run with ALTIS_TEST_DB_REQUIRED=1).
//
// Vitest 5.0.5 / Vite 8.3.5 crash ("code.charCodeAt is not a function") when they format the stack of an error
// that has a frame in this file, which Vite's module runner evaluates in the main process. So: the reachability
// probe uses node:net (its errors carry only Node-internal frames), mysql2 is used through its callback API (its
// promise wrapper re-captures stacks from our frames), and every failure leaves this file as an error without a
// stack trace, after its message has been written to stderr.

const CONNECT_TIMEOUT_MS = 5000;

/** An Error without stack frames (see above), also written to stderr so that CI logs show it whatever happens. */
function setupError(message: string): Error {
  console.error(`[tools/test/global-setup] ${message}`);
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 0;
  try {
    return new Error(message);
  } finally {
    Error.stackTraceLimit = limit;
  }
}

/** `code: message` of a driver error, without touching its stack. */
function describeError(e: unknown): string {
  if (typeof e !== 'object' || e === null) return String(e);
  const { code, message } = e as { code?: unknown; message?: unknown };
  const text = typeof message === 'string' && message !== '' ? message : 'unknown error';
  return typeof code === 'string' || typeof code === 'number' ? `${code}: ${text}` : text;
}

/** Null when something accepts a TCP connection on host:port, otherwise the error code. */
function probePort(host: string, port: number): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (result: string | null) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => done('ETIMEDOUT'));
    socket.once('connect', () => done(null));
    socket.once('error', (e: NodeJS.ErrnoException) => done(e.code ?? 'ECONNREFUSED'));
  });
}

/** Root/superuser operations on one engine. Names are generated here (`altis_t_<base36>_<n>`), never user input. */
interface Admin {
  createDatabase(name: string): Promise<void>;
  dropDatabase(name: string): Promise<void>;
  close(): Promise<void>;
}

async function mysqlAdmin(port: number): Promise<Admin> {
  const conn = mysql.createConnection({
    host: testDbHost(),
    port,
    user: 'root',
    password: TEST_DB_ROOT_PASSWORD,
    connectTimeout: CONNECT_TIMEOUT_MS,
  });
  conn.on('error', () => {}); // a server going away is reported by the next query
  const query = (statement: string, values: unknown[]) =>
    new Promise<void>((resolve, reject) => conn.query(statement, values, (e) => (e ? reject(e) : resolve())));
  await new Promise<void>((resolve, reject) => conn.connect((e) => (e ? reject(e) : resolve())));
  return {
    async createDatabase(name) {
      await query('CREATE DATABASE ?? CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci', [name]);
      await query(`GRANT ALL PRIVILEGES ON ??.* TO ?@'%'`, [name, TEST_DB_USER]);
    },
    async dropDatabase(name) {
      await query('DROP DATABASE IF EXISTS ??', [name]);
    },
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
  client.on('error', () => {}); // a server going away is reported by the next query
  await client.connect();
  // The images only create the superuser; the application role is created here, once per container.
  const role = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [TEST_DB_USER]);
  if (role.rowCount === 0) {
    try {
      await client.query(
        `CREATE ROLE ${pg.escapeIdentifier(TEST_DB_USER)} LOGIN PASSWORD ${pg.escapeLiteral(TEST_DB_PASSWORD)}`,
      );
    } catch (e) {
      if ((e as { code?: unknown }).code !== '42710') throw e; // duplicate_object: a parallel run created it
    }
  }
  return {
    async createDatabase(name) {
      await client.query(
        `CREATE DATABASE ${pg.escapeIdentifier(name)} OWNER ${pg.escapeIdentifier(TEST_DB_USER)} ` +
          `ENCODING 'UTF8' TEMPLATE template0`,
      );
    },
    async dropDatabase(name) {
      await client.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(name)} WITH (FORCE)`);
    },
    close: () => client.end(),
  };
}

/** Opens an admin connection, runs `fn`, closes it; any failure becomes a {@link setupError}. */
async function withAdmin(engine: Exclude<TestEngine, 'sqlite'>, what: string, fn: (a: Admin) => Promise<void>) {
  const { dialect, port } = ENGINE_SPECS[engine];
  let admin: Admin | null = null;
  try {
    if (port === null) throw new Error(`no port for ${engine}`);
    admin = dialect === 'postgres' ? await pgAdmin(port) : await mysqlAdmin(port);
    await fn(admin);
  } catch (e) {
    throw setupError(`${engine}: ${what} failed: ${describeError(e)}`);
  } finally {
    if (admin !== null) await admin.close().catch(() => {});
  }
}

/**
 * Creates the per-worker databases `names` on `engine` (a server engine) and returns whether it could; an engine whose
 * port does not answer is not available (its reason given), or fails the run when `required`.
 */
async function prepareEngine(engine: TestEngine, names: readonly string[], required: boolean): Promise<{ available: boolean; reason: string | null }> {
  if (engine === 'sqlite') return { available: true, reason: null };
  const where = `${testDbHost()}:${ENGINE_SPECS[engine].port}`;
  const unreachable = await probePort(testDbHost(), ENGINE_SPECS[engine].port ?? 0);
  if (unreachable !== null) {
    const reason =
      `${engine} not reachable on ${where} (${unreachable}); ` +
      `start it with: docker compose -f tools/test/compose.yml up -d --wait ${engine}`;
    if (required) throw setupError(`ALTIS_TEST_DB_REQUIRED=1 and ${reason}`);
    return { available: false, reason };
  }
  await withAdmin(engine, 'creating the per-worker databases', async (admin) => {
    for (const name of names) {
      await admin.dropDatabase(name);
      await admin.createDatabase(name);
    }
  });
  return { available: true, reason: null };
}

/** Drops the per-worker databases `names` on `engine` (a server engine whose databases were created). */
async function dropEngine(engine: TestEngine, names: readonly string[]): Promise<void> {
  if (engine === 'sqlite') return;
  await withAdmin(engine, 'dropping the per-worker databases', async (admin) => {
    for (const name of names) await admin.dropDatabase(name);
  });
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  let engine: TestEngine;
  let source: TestEngine | null;
  try {
    engine = parseTestEngine(process.env['ALTIS_TEST_DB']);
    source = parseSourceEngine(process.env['ALTIS_TEST_DB_SOURCE']);
  } catch (e) {
    throw setupError(describeError(e));
  }
  const required = process.env['ALTIS_TEST_DB_REQUIRED'] === '1';
  const runId = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
  // VITEST_POOL_ID runs from 1 to maxWorkers.
  const workers = Math.max(1, project.config.maxWorkers, project.globalConfig.maxWorkers);
  const names = Array.from({ length: workers }, (_, i) => testDbName(runId, i + 1));

  const { available, reason } = await prepareEngine(engine, names, required);
  // 1c Task 29 (M37): the source engine's databases, unless it is the same engine (the same databases).
  const separate = source !== null && source !== engine ? source : null;
  const prepared = separate !== null ? await prepareEngine(separate, names, required) : { available, reason };

  const ctx: TestDbContext = { engine, runId, available, reason, source, sourceAvailable: prepared.available, sourceReason: prepared.reason };
  project.provide('altisTestDb', ctx);

  return async () => {
    if (available) await dropEngine(engine, names);
    if (separate !== null && prepared.available) await dropEngine(separate, names);
    await fsp.rm(testRunDir(runId), { recursive: true, force: true });
  };
}
