import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  PASSENGER_MAX_POOL,
  TARGETS,
  baseEnv,
  composeCommand,
  dockerDb,
  dockerEnvText,
  dockerOverrideText,
  execCommand,
  isTestEngine,
  mustRun,
  newDockerSecrets,
  planSmoke,
  provisionDb,
  simWorkers,
  smokeLayout,
  startProcess,
  stopTracked,
  writePrivateFile,
  type Target,
} from '../../release/smoke/run.js';
import { extractZip } from '../../release/src/zip.js';
import { RUN_DIR, freePort } from './server.js';

// 1d Task 35 (acceptance A1, "keempat lingkungan"): where wizard.spec.ts installs, picked per run by
//
//   ALTIS_E2E_TARGET   standalone (default) | passenger-sim | pm2 | docker
//   ALTIS_E2E_DB       a tools/test/compose.yml engine: sqlite (the default, standalone only), mysql80, mariadb106, pg15, …
//
// The A1 rows: passenger-sim + MariaDB 10.6 (cPanel), pm2 + MySQL 8.0 (aaPanel), docker + MariaDB 10.6 and PostgreSQL
// 15 (compose, after altis-init's equivalent: the smoke run's .env), standalone + SQLite. A target app is the suite's
// release unzipped afresh and started the way the smoke run starts that target (tools/release/smoke/run.ts planSmoke,
// never installed: the wizard installs it): passenger-sim with its workers spawned on demand, `pm2 start
// ecosystem.config.cjs` (the pinned PM2 the smoke run uses, which CI fetches), or `docker compose up` of the image built
// from the release with the compose file's database. The wizard is given a fresh database of the engine (host targets:
// the compose engine on 127.0.0.1; Docker: the compose file's `db` service). On a target whose runtime needs a
// scheduler (Passenger) the spec plays the cron line: `POST /_cron` with the install's cron token.

/** A database as the smoke run provisions it (@altis/db's DbConfig: tools/e2e does not depend on @altis/db). */
export type DbConfig = Awaited<ReturnType<typeof provisionDb>>;

export interface E2ETarget {
  target: Target;
  db: string;
}

/**
 * The target of this run (see the top of this file).
 *
 * @throws Error for an unknown target or engine, or SQLite where the target never runs it (Passenger, P20; Docker's
 *   compose file brings a server database)
 */
export function e2eTarget(env: NodeJS.ProcessEnv = process.env): E2ETarget {
  const target = env['ALTIS_E2E_TARGET']?.trim() || 'standalone';
  if (!(TARGETS as readonly string[]).includes(target)) throw new Error(`ALTIS_E2E_TARGET must be one of ${TARGETS.join(', ')}, got ${JSON.stringify(target)}`);
  const db = env['ALTIS_E2E_DB']?.trim() || (target === 'standalone' ? 'sqlite' : '');
  if (db === '') throw new Error(`ALTIS_E2E_TARGET=${target} needs ALTIS_E2E_DB (a tools/test/compose.yml engine such as mariadb106)`);
  if (!isTestEngine(db)) throw new Error(`ALTIS_E2E_DB must name a tools/test/compose.yml engine, got ${JSON.stringify(db)}`);
  if (db === 'sqlite' && (target === 'passenger-sim' || target === 'docker')) throw new Error(`SQLITE_NOT_ALLOWED: ALTIS_E2E_TARGET=${target} runs a server database`);
  return { target: target as Target, db };
}

export interface TargetApp {
  readonly target: Target;
  /** `http://127.0.0.1:<port>`: the browser's address and the base URL the wizard proposes. */
  readonly baseUrl: string;
  /** What the wizard's database step is given (SQLite: `{dialect: 'sqlite'}`). */
  readonly db: DbConfig;
  /** Whether this target's runtime needs a scheduler before `finish` (Passenger: no worker). */
  readonly needsCron: boolean;
  /** DATA_DIR on this host; null for Docker (a volume). */
  readonly dataDir: string | null;
  /** Starts the uninstalled app; resolves once `/_health` answers `not_installed`. */
  start(): Promise<void>;
  /** The install code the server wrote (DATA_DIR/install-code.txt). */
  installCode(): Promise<string>;
  /** config.json's `secrets.cronToken` (written by the database step). */
  cronToken(): Promise<string>;
  /** Stops everything and removes the folder (ALTIS_E2E_KEEP=1 keeps it), the database dropped. */
  dispose(): Promise<void>;
}

/** A target app of `zip` (see the top of this file), not started. */
export async function createTargetApp(t: E2ETarget, zip: string): Promise<TargetApp> {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), `altis-e2e-${t.target}-`)));
  const id = randomBytes(4).toString('hex');
  const layout = smokeLayout(root, await freePort(), id);
  await fsp.mkdir(layout.logDir, { recursive: true });
  await fsp.mkdir(RUN_DIR, { recursive: true });
  await extractZip(await fsp.readFile(zip), layout.appRoot);
  await fsp.mkdir(layout.dataDir, { mode: 0o700 });
  const drops: (() => Promise<void>)[] = [];
  const cleanups: (() => Promise<void>)[] = [];
  let db: DbConfig;
  if (t.target === 'docker') {
    const secrets = newDockerSecrets();
    writePrivateFile(layout.envFile, dockerEnvText(layout, secrets, t.db as Parameters<typeof dockerEnvText>[2]));
    const override = dockerOverrideText(t.db as Parameters<typeof dockerOverrideText>[0]);
    if (override !== null) await fsp.writeFile(layout.overrideFile, override);
    db = { ...dockerDb(t.db as Parameters<typeof dockerDb>[0]), password: secrets.dbPassword };
  } else {
    db = await provisionDb(t.db as Parameters<typeof provisionDb>[0], `e2e_${id}`, (drop) => void drops.push(drop));
  }
  const options = { zip, target: t.target, db: t.db as Parameters<typeof provisionDb>[0], maxPool: PASSENGER_MAX_POOL, scenario: null, toZips: [], feed: null };
  const plan = planSmoke(options, layout, db, baseEnv());
  const engine = t.db as Parameters<typeof composeCommand>[1];
  const compose = (label: string, args: string[]) => composeCommand(layout, engine, baseEnv(), label, args);
  /** A file of DATA_DIR (Docker: read inside the app container). */
  const readData = async (name: string): Promise<string> => {
    if (t.target !== 'docker') return fsp.readFile(path.join(layout.dataDir, name), 'utf8');
    return (await mustRun(compose(`docker-cat-${name.replace(/\W+/g, '-')}`, ['exec', '-T', 'app', 'cat', `/data/${name}`]), layout.logDir)).stdout;
  };
  const baseUrl = `http://127.0.0.1:${layout.port}`;

  return {
    target: t.target,
    baseUrl,
    db,
    needsCron: t.target === 'passenger-sim',
    dataDir: t.target === 'docker' ? null : layout.dataDir,

    async start() {
      // Docker: the image and the database first; never the install input (the wizard installs).
      for (const c of plan.setup.filter((s) => s.label !== 'docker-install-input')) await mustRun(c, layout.logDir);
      if (t.target === 'docker' || t.target === 'pm2') {
        await mustRun(plan.start, layout.logDir);
        cleanups.push(async () => {
          for (const c of plan.teardown) await execCommand(c, layout.logDir, 120_000);
        });
      } else {
        const proc = startProcess(plan.start, layout.logDir);
        cleanups.push(async () => stopTracked(proc, t.target === 'passenger-sim' ? await simWorkers(layout.port).catch(() => []) : []));
      }
      const deadline = Date.now() + 180_000;
      for (;;) {
        const status = await healthStatus(layout.port);
        if (status === 'not_installed') return;
        if (Date.now() > deadline) throw new Error(`${t.target}: /_health did not answer not_installed within 180 s (last: ${status}; logs: ${layout.logDir})`);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    },

    async installCode() {
      const code = (JSON.parse(await readData('install-code.txt')) as { code?: unknown }).code;
      if (typeof code !== 'string' || code === '') throw new Error('install-code.txt holds no code');
      return code;
    },

    async cronToken() {
      const token = (JSON.parse(await readData('config.json')) as { secrets?: { cronToken?: unknown } }).secrets?.cronToken;
      if (typeof token !== 'string' || token === '') throw new Error('config.json holds no secrets.cronToken');
      return token;
    },

    async dispose() {
      for (const fn of [...cleanups.splice(0).reverse(), ...drops.splice(0)]) await fn().catch(() => undefined);
      // The logs stay for CI's upload of tools/e2e/dist/run/.
      await fsp.cp(layout.logDir, path.join(RUN_DIR, `wizard-${t.target}-${id}`), { recursive: true }).catch(() => undefined);
      if (process.env['ALTIS_E2E_KEEP'] !== '1') await fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
  };
}

/** `/_health`'s `status` on 127.0.0.1:`port` ('' when it does not answer JSON). */
async function healthStatus(port: number): Promise<string> {
  const http = await import('node:http');
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/_health', agent: false, headers: { connection: 'close' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => {
        try {
          const status = (JSON.parse(body) as { status?: unknown }).status;
          resolve(typeof status === 'string' ? status : '');
        } catch {
          resolve('');
        }
      });
    });
    req.setTimeout(5000, () => req.destroy());
    req.once('error', () => resolve(''));
    req.end();
  });
}
