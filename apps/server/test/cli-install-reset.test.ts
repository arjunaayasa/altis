import fsp from 'node:fs/promises';
import path from 'node:path';
import { readDataEpoch, readMaintenance, readOpFile } from '@altis/core';
import { listCatalogTables } from '@altis/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli, type CliIo } from '../src/cli/index.js';
import { CLI_OP_ACTOR, runOpToEnd } from '../src/cli/migrate.js';
import { loadConfig } from '../src/config.js';
import { start } from '../src/index.js';
import { createLogger } from '../src/logger.js';
import { createAppOps } from '../src/services.js';
import { captureIo, openInstalled, writeInput } from './cli-support.js';
import { bootContext, closeTestServers, httpRequest, useDataDir } from './support.js';

// `node app.js install:reset [--wipe-db] [--confirm-db <name>]` (spec §13.6, §7.7; ruling R1c-5; 1c Task 24) on SQLite:
// under the ops lock (op kind `reset`, maintenance `reset`) it removes install.lock, renames config.json to
// config.json.bak-<epoch ms>, removes the install marker <appRoot>/.altis/installed.json and, with --wipe-db and the
// database's name typed at a TTY prompt or given as --confirm-db, drops every registered table; `install.reset` is
// audited before the wipe when the database answers.

const ADMIN = { username: 'admin', name: 'Admin', password: 'kuda-lumping-biru' };
const BACKUP_NAME = /^config\.json\.bak-\d{13}$/;

const dirs = useDataDir();
let appRoot: string;
let home: string;

beforeEach(async () => {
  appRoot = path.join(dirs.root, 'app');
  home = path.join(dirs.root, 'home');
  await fsp.mkdir(home, { recursive: true });
});

async function cli(argv: string[], extra: Partial<Pick<CliIo, 'prompt'>> = {}) {
  const io = Object.assign(captureIo({ HOME: home }, { hostPanels: () => [] }), extra);
  const code = await runCli(argv, bootContext(dirs.dataDir), io);
  return { code, io };
}

async function install(): Promise<void> {
  const input = await writeInput(path.join(dirs.root, 'input'), { baseUrl: 'https://perpus.example.sch.id', db: { dialect: 'sqlite' }, admin: ADMIN });
  const { code, io } = await cli(['install', '--config', input]);
  if (code !== 0) throw new Error(`install failed: ${io.err}`);
}

const markerFile = () => path.join(appRoot, '.altis', 'installed.json');

/** The install marker as the installer writes it (spec §7.7): the DATA_DIR this app was installed into. */
async function writeMarker(): Promise<void> {
  await fsp.mkdir(path.dirname(markerFile()), { recursive: true });
  await fsp.writeFile(markerFile(), JSON.stringify({ dataDir: dirs.dataDir, installedAt: new Date().toISOString() }));
}

const exists = (file: string) =>
  fsp.stat(file).then(
    () => true,
    () => false,
  );

async function rootNames(): Promise<string[]> {
  return (await fsp.readdir(dirs.dataDir)).sort();
}

async function tables(): Promise<string[]> {
  const h = await openInstalled(dirs.dataDir);
  try {
    return await listCatalogTables(h);
  } finally {
    await h.close();
  }
}

async function resetAudits(): Promise<Record<string, unknown>[]> {
  const h = await openInstalled(dirs.dataDir);
  try {
    const rows = await h.db.selectFrom('audit_log').select(['actor_type', 'actor_id', 'meta']).where('action', '=', 'install.reset').execute();
    return rows.map((r) => ({ ...r, meta: JSON.parse(r.meta) as Record<string, unknown> }));
  } finally {
    await h.close();
  }
}

describe('install:reset', () => {
  it('after an install: install.lock gone, config.json.bak-<ms> holds the config, the marker gone, audited; tables kept', async () => {
    await install();
    await writeMarker();
    const config = await fsp.readFile(path.join(dirs.dataDir, 'config.json'), 'utf8');
    const before = await tables();

    const { code, io } = await cli(['install:reset']);
    expect(io.err).toBe('');
    expect(code).toBe(0);
    expect(io.out).toMatch(/^install:reset: /);

    const names = await rootNames();
    expect(names).not.toContain('install.lock');
    expect(names).not.toContain('install.lock.bak');
    expect(names).not.toContain('config.json');
    expect(names).not.toContain('config.json.bak');
    const backups = names.filter((n) => BACKUP_NAME.test(n));
    expect(backups).toHaveLength(1);
    expect(await fsp.readFile(path.join(dirs.dataDir, backups[0]!), 'utf8')).toBe(config);
    expect(io.out).toContain(backups[0]);
    expect(await exists(markerFile())).toBe(false);
    expect(await loadConfig(dirs.dataDir, {})).toBeNull();

    // The database is untouched, and holds the audit entry (written before anything else).
    expect(await tables()).toEqual(before);
    expect(await resetAudits()).toEqual([{ actor_type: 'cli', actor_id: null, meta: { opId: expect.any(String), wipeDb: false } }]);

    // The op ended `done` and lowered its maintenance flag.
    expect(await readOpFile(dirs.dataDir)).toMatchObject({ kind: 'reset', state: 'done', actor: { type: 'cli', id: null } });
    expect(await readMaintenance(dirs.dataDir)).toBeNull();
  }, 60_000);

  it('--json reports the config backup, the wipe and the marker', async () => {
    await install();
    await writeMarker();
    const { code, io } = await cli(['install:reset', '--json']);
    expect(code).toBe(0);
    const out = JSON.parse(io.out) as Record<string, unknown>;
    expect(out).toEqual({ ok: true, command: 'install:reset', configBackup: expect.stringMatching(BACKUP_NAME), wipedDb: false, markerRemoved: true });
  }, 60_000);

  it('--wipe-db --confirm-db wrong → exit 1 and nothing is touched: every table, install.lock, config.json, no op', async () => {
    await install();
    await writeMarker();
    const before = await tables();
    const { code, io } = await cli(['install:reset', '--wipe-db', '--confirm-db', 'wrong']);
    expect(code).toBe(1);
    expect(io.err).toMatch(/CONFIRM_MISMATCH/);
    expect(io.err).toContain('altis.sqlite');
    expect(await tables()).toEqual(before);
    expect(await rootNames()).toEqual(expect.arrayContaining(['config.json', 'install.lock']));
    expect(await exists(markerFile())).toBe(true);
    expect(await readOpFile(dirs.dataDir)).toBeNull();
    expect(await resetAudits()).toEqual([]);
  }, 60_000);

  it('--wipe-db without --confirm-db and without a TTY → exit 1, nothing dropped', async () => {
    await install();
    const before = await tables();
    const { code, io } = await cli(['install:reset', '--wipe-db'], { prompt: async () => null });
    expect(code).toBe(1);
    expect(io.err).toMatch(/CONFIRM_REQUIRED/);
    expect(await tables()).toEqual(before);
    expect(await rootNames()).toEqual(expect.arrayContaining(['config.json', 'install.lock']));
  }, 60_000);

  it('--wipe-db with the right name typed at the prompt → every registered table dropped; a new install then succeeds', async () => {
    await install();
    const asked: string[] = [];
    const { code, io } = await cli(['install:reset', '--wipe-db', '--json'], {
      prompt: async (question) => {
        asked.push(question);
        return 'altis.sqlite';
      },
    });
    expect(io.err).toBe('');
    expect(code).toBe(0);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('altis.sqlite');
    expect(JSON.parse(io.out)).toMatchObject({ ok: true, command: 'install:reset', wipedDb: true });
    // schema_tables lists nothing: it is gone with every table it listed.
    expect(await tables()).toEqual([]);

    // The way back: a fresh install into the same DATA_DIR.
    await install();
    expect(await tables()).toContain('staff_users');
  }, 60_000);

  it('--wipe-db --confirm-db <the name> drops the tables without asking', async () => {
    await install();
    const { code } = await cli(['install:reset', '--wipe-db', '--confirm-db', 'altis.sqlite'], {
      prompt: async () => {
        throw new Error('asked');
      },
    });
    expect(code).toBe(0);
    expect(await tables()).toEqual([]);
  }, 60_000);

  it('a second reset while one is active → exit 1 OPS_IN_PROGRESS, nothing touched', async () => {
    await install();
    // A reset that another process began and has not finished.
    const ops = createAppOps(
      { phase: 'not_installed' },
      { dataDir: dirs.dataDir, version: '0.1.0', log: createLogger({ dataDir: dirs.dataDir, level: 'error' }), clock: () => Date.now() },
    );
    const handle = await ops.begin('reset', { type: 'cli', id: null }, { wipeDb: false, appRoot });

    const { code, io } = await cli(['install:reset']);
    expect(code).toBe(1);
    expect(io.err).toMatch(/OPS_IN_PROGRESS/);
    expect(await rootNames()).toEqual(expect.arrayContaining(['config.json', 'install.lock']));
    expect(await readOpFile(dirs.dataDir)).toMatchObject({ opId: handle.opId, state: 'running' });

    await ops.cancel({ type: 'cli', id: null });
    await ops.close();
  }, 60_000);

  it('R1c-5: a DATA_DIR holding nothing but the marker points at → the marker is removed (DATA_DIR_MISMATCH way back)', async () => {
    await fsp.mkdir(dirs.dataDir, { recursive: true });
    await writeMarker();
    const { code, io } = await cli(['install:reset', '--json']);
    expect(io.err).toBe('');
    expect(code).toBe(0);
    expect(JSON.parse(io.out)).toEqual({ ok: true, command: 'install:reset', configBackup: null, wipedDb: false, markerRemoved: true });
    expect(await exists(markerFile())).toBe(false);
  });

  it('--wipe-db without config.json → exit 1 (the database is unknown)', async () => {
    await fsp.mkdir(dirs.dataDir, { recursive: true });
    await writeMarker();
    const { code, io } = await cli(['install:reset', '--wipe-db', '--confirm-db', 'altis.sqlite']);
    expect(code).toBe(1);
    expect(io.err).toMatch(/NOT_INSTALLED/);
    expect(await exists(markerFile())).toBe(true);
  });

  it('refuses --confirm-db without --wipe-db, and an empty name', async () => {
    for (const argv of [
      ['install:reset', '--confirm-db', 'altis.sqlite'],
      ['install:reset', '--wipe-db', '--confirm-db', ''],
      ['install:reset', '--wipe-db=1'],
    ]) {
      const { code, io } = await cli(argv);
      expect(code, argv.join(' ')).toBe(1);
      expect(io.err).toMatch(/USAGE/);
    }
  });
});

describe('install:reset reaches the processes already running (final review)', () => {
  afterEach(async () => {
    await closeTestServers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  it('a process that serves the installation restarts: the reset raises the data epoch, its fence asks for a restart', async () => {
    await install();
    const ctx = bootContext(dirs.dataDir);
    await start(ctx);
    const { port } = await ctx.served();
    expect((await httpRequest(port, '/_health')).status).toBe(200);
    const epoch = await readDataEpoch(dirs.dataDir);

    const { code, io } = await cli(['install:reset']);
    expect(io.err).toBe('');
    expect(code).toBe(0);
    expect(await readDataEpoch(dirs.dataDir)).toBe(epoch + 1);
    // The fence looks at most every 2 s, on requests.
    const deadline = Date.now() + 8000;
    while (!ctx.requestRestart.mock.calls.some(([reason]) => reason === 'data-epoch') && Date.now() < deadline) {
      await httpRequest(port, '/_health');
      await sleep(250);
    }
    expect(ctx.requestRestart.mock.calls.filter(([reason]) => reason === 'data-epoch')).toHaveLength(1);
  }, 60_000);

  it('a process that booted during a reset --wipe-db does not migrate the wiped database with the config it had', async () => {
    await install();
    const config = (await loadConfig(dirs.dataDir, {}))!;
    const h = await openInstalled(dirs.dataDir);
    const log = createLogger({ dataDir: dirs.dataDir, level: 'error' });
    const ops = createAppOps({ phase: 'ready', db: h, config }, { dataDir: dirs.dataDir, version: '0.1.0', log, clock: () => Date.now() });
    try {
      const { opId } = await ops.begin('reset', CLI_OP_ACTOR, { wipeDb: true, appRoot });
      vi.stubEnv('ALTIS_RUNNER', 'off'); // no worker loop: only this test steps the op
      const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true); // the install code it prints
      const ctx = bootContext(dirs.dataDir);
      const started = start(ctx);
      const { port } = await ctx.served();
      const status = async (): Promise<string> => (JSON.parse((await httpRequest(port, '/_health')).body) as { status: string }).status;
      for (const until = Date.now() + 5000; (await status()) !== 'maintenance' && Date.now() < until; ) await sleep(50);
      expect(await status()).toBe('maintenance'); // ops_wait

      expect(await runOpToEnd(ops, opId)).toMatchObject({ state: 'done' });
      expect(await tables()).toEqual([]);
      // The next requests let the ops fence see the op end: the process boots again, from config.json as it is now.
      let settled = false;
      void started.finally(() => {
        settled = true;
      });
      const deadline = Date.now() + 8000;
      while (!settled && Date.now() < deadline) {
        await httpRequest(port, '/_health');
        await sleep(250);
      }
      await started;
      expect(await status()).toBe('not_installed');
      expect(await tables()).toEqual([]);
      expect(ctx.markHealthy).not.toHaveBeenCalled();
      // The way back is the wizard: the process printed its install code, as a first boot without config.json does.
      expect(stdout.mock.calls.some(([chunk]) => String(chunk).includes('/install'))).toBe(true);
    } finally {
      await ops.close();
      await h.close();
    }
  }, 60_000);
});
