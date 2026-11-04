import { fork } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SCHEDULES, createJobRegistry, enqueue, insertReleaseLog, readMaintenance, seedSchedules } from '@altis/core';
import { withTx, type DbHandle } from '@altis/db';
import { readCurrentState, updateCurrentState } from '@altis/platform';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli/index.js';
import { jobHandlers } from '../src/jobs/runtime.js';
import { captureIo, openInstalled, runCliChild, writeInput } from './cli-support.js';
import { flagOf, readOpJson, writeFlag, writeOp } from './ops-support.js';
import { bootContext, httpRequest, serverLog } from './support.js';

// `node app.js jobs:run [--budget <seconds>]` (spec §10.2, §10.3, §13.6; acceptance A5) on SQLite in a temp DATA_DIR
// installed once: passes until the budget is spent or nothing is left (a longRunning job to its end, with one
// session), the run record `system.run.cron_cli`, `--json`; before the install only `tmp/cron-seen.json`; and the
// exactly-once and dead-after-max-attempts cases across processes killed mid-slice, whose successors stand past the
// lease through ALTIS_TEST_CLOCK_OFFSET_MS (M23), a server child (fixtures/runtime-child.mjs) included.

const ADMIN = { username: 'admin', name: 'Admin', password: 'kuda-lumping-biru' };
/** Past the 50 s lease and the longest backoff (retryDelayMs(4) = 160 s). */
const STEP_MS = 10 * 60_000;

let root: string;
let dataDir: string;
let appRoot: string;
let home: string;
let h: DbHandle;
const registry = createJobRegistry(jobHandlers());

beforeAll(async () => {
  root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-jobs-run-')));
  dataDir = path.join(root, 'altis-data');
  appRoot = path.join(root, 'app');
  home = path.join(root, 'home');
  await fsp.mkdir(home);
  const input = await writeInput(path.join(root, 'input'), { baseUrl: 'https://perpus.example.sch.id', db: { dialect: 'sqlite' }, admin: ADMIN });
  const io = captureIo({ HOME: home }, { hostPanels: () => [] });
  const code = await runCli(['install', '--config', input], bootContext(dataDir), io);
  if (code !== 0) throw new Error(`install failed: ${io.err}`);
  h = await openInstalled(dataDir);
  // 1c Task 18: jobs:run runs the housekeeping schedules too. They are seeded here and disabled (seeding keeps
  // `enabled`), so that the slices these cases count are their own jobs' alone: a schedule falling due between two
  // runs (a child stands 10 minutes ahead) would add one.
  await withTx(h, (trx) => seedSchedules(trx, Date.now(), 'Asia/Jakarta', SCHEDULES));
  await h.db.updateTable('schedules').set({ enabled: 0 }).execute();
}, 60_000);

afterAll(async () => {
  await h?.close();
  if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  for (const table of ['jobs', 'locks', 'settings', 'events', 'notifications'] as const) {
    if (table === 'settings') await h.db.deleteFrom('settings').where('key', 'like', 'system.run.%').execute();
    else await h.db.deleteFrom(table).execute();
  }
});

async function jobsRun(argv: string[], env: Record<string, string> = {}, dir = dataDir) {
  const io = captureIo({ HOME: home, ...env });
  const code = await runCli(['jobs:run', ...argv], bootContext(dir), io);
  return { code, io };
}

const put = (type: string, payload: unknown) =>
  withTx(h, (trx) => enqueue(trx, registry, { type, payload }, { now: Date.now(), keyring: [] })).then((r) => r.id);
const job = (id: string) => h.db.selectFrom('jobs').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
const effects = (id: string) =>
  h.db.selectFrom('locks').select(['name', 'owner']).where('name', 'like', `test-slice:${id}:%`).execute().then((rows) => rows.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true })));
const child = (env: Record<string, string>) => runCliChild({ argv: ['jobs:run', '--json'], dataDir, appRoot, env: { HOME: home, ...env } }, 40_000);

describe('jobs:run', () => {
  it('--budget 5 with a 3-slice job → exit 0, the job succeeded, system.run.cron_cli set; --json → {ok, passes, slices}', async () => {
    const id = await put('test.slices', { slices: 3, k: 1 });
    const before = Date.now();
    const { code, io } = await jobsRun(['--budget', '5', '--json']);
    expect(io.err).toBe('');
    expect(code).toBe(0);
    const out = JSON.parse(io.out) as { ok: boolean; command: string; passes: number; slices: number };
    expect(out).toMatchObject({ ok: true, command: 'jobs:run', slices: 3 });
    expect(out.passes).toBeGreaterThanOrEqual(1);
    expect((await job(id)).status).toBe('succeeded');
    expect(await effects(id)).toHaveLength(3);
    const record = await h.db.selectFrom('settings').select('value').where('key', '=', 'system.run.cron_cli').executeTakeFirstOrThrow();
    expect(Number(record.value)).toBeGreaterThanOrEqual(before);
  });

  it('runs a longRunning job to its end with one session, and prints a human line without --json', async () => {
    const id = await put('test.long', { slices: 5, k: 1 });
    const { code, io } = await jobsRun(['--budget=1']);
    expect(code).toBe(0);
    expect(io.out).toMatch(/^jobs:run: \d+ lintasan, 5 potongan \/ \d+ pass\(es\), 5 slice\(s\)\n$/);
    expect((await job(id)).status).toBe('succeeded');
    expect((await effects(id)).map((e) => e.owner)).toEqual(['s1', 's2', 's3', 's4', 's5']);
  });

  it('refuses a malformed budget', async () => {
    for (const budget of ['0', '-1', 'x', '1.5', '86401']) {
      const { code, io } = await jobsRun(['--budget', budget]);
      expect(code, budget).toBe(1);
      expect(io.err, budget).toMatch(/USAGE/);
    }
  });

  it('before the install completes: exit 0, "not installed yet", and tmp/cron-seen.json', async () => {
    const fresh = path.join(root, 'fresh-data');
    await fsp.mkdir(fresh);
    const plain = await jobsRun([], {}, fresh);
    expect(plain.code).toBe(0);
    expect(plain.io.out).toMatch(/ALTIS belum terpasang \/ not installed yet/);
    const seen = JSON.parse(await fsp.readFile(path.join(fresh, 'tmp', 'cron-seen.json'), 'utf8')) as { mode: string; at: number };
    expect(seen.mode).toBe('cron_cli');

    // A config whose install has not finished counts as not installed too.
    const halfway = path.join(root, 'halfway-data');
    await fsp.mkdir(halfway);
    const config = JSON.parse(await fsp.readFile(path.join(dataDir, 'config.json'), 'utf8')) as Record<string, unknown>;
    await fsp.writeFile(path.join(halfway, 'config.json'), JSON.stringify({ ...config, installState: 'migrate' }), { mode: 0o600 });
    const json = await jobsRun(['--json'], {}, halfway);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.io.out)).toEqual({ ok: true, command: 'jobs:run', installed: false });
    expect(JSON.parse(await fsp.readFile(path.join(halfway, 'tmp', 'cron-seen.json'), 'utf8'))).toMatchObject({ mode: 'cron_cli' });
  });

  it('A5: a child SIGKILLed mid-slice (kill-mid-slice:4), then a later jobs:run → succeeded with exactly 10 effects', async () => {
    const id = await put('test.slices', { slices: 10, k: 1 });
    const killed = await child({ ALTIS_TEST_FAULT: 'kill-mid-slice:4' });
    expect(killed.signal).toBe('SIGKILL');
    expect(await effects(id)).toHaveLength(4);
    expect((await job(id)).status).toBe('running');

    // Within the lease the job is someone else's.
    const early = await child({});
    expect(early.code, early.stderr).toBe(0);
    expect(JSON.parse(early.stdout)).toMatchObject({ ok: true, slices: 0 });

    const later = await child({ ALTIS_TEST_CLOCK_OFFSET_MS: String(STEP_MS) });
    expect(later.code, later.stderr).toBe(0);
    expect(JSON.parse(later.stdout)).toMatchObject({ ok: true, slices: 7 });
    const row = await job(id);
    expect(row.status).toBe('succeeded');
    expect(Number(row.attempts)).toBe(0);
    expect((await effects(id)).map((e) => e.name)).toEqual(Array.from({ length: 10 }, (_, i) => `test-slice:${id}:${i + 1}`));
  }, 90_000);

  it('A5: process.exit in slice 3 of every run → dead with LEASE_EXPIRED_MAX_ATTEMPTS after max_attempts', async () => {
    const id = await put('test.slices', { slices: 5, k: 1, exitAt: 3 });
    for (let run = 0; run < 5; run += 1) {
      const r = await child({ ALTIS_TEST_CLOCK_OFFSET_MS: String(run * STEP_MS) });
      expect(r.code, `run ${run}: ${r.stderr}`).toBe(1);
      const row = await job(id);
      expect(row.status).toBe('running');
      expect(Number(row.attempts)).toBe(run);
    }
    const last = await child({ ALTIS_TEST_CLOCK_OFFSET_MS: String(5 * STEP_MS) });
    expect(last.code, last.stderr).toBe(0);
    const row = await job(id);
    expect(row).toMatchObject({ status: 'dead', last_error: 'LEASE_EXPIRED_MAX_ATTEMPTS', unique_key: null, lock_token: null });
    expect(Number(row.max_attempts)).toBe(5);
    expect(await effects(id)).toHaveLength(2);
  }, 120_000);

  it('M23: a server child (start(), worker mode) past the lease through ALTIS_TEST_CLOCK_OFFSET_MS finishes a job a killed jobs:run left', async () => {
    const id = await put('test.slices', { slices: 6, k: 1 });
    const killed = await child({ ALTIS_TEST_FAULT: 'kill-mid-slice:2' });
    expect(killed.signal).toBe('SIGKILL');
    const server = fork(path.join(import.meta.dirname, 'fixtures', 'runtime-child.mjs'), [JSON.stringify({ dataDir, appRoot, runtime: 'standalone' })], {
      cwd: path.resolve(import.meta.dirname, '../../..'),
      env: { PATH: process.env['PATH'] ?? '', HOME: home, ALTIS_TEST_CLOCK_OFFSET_MS: String(STEP_MS) },
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    try {
      const port = await new Promise<number>((resolve, reject) => {
        server.once('message', (m) => resolve((m as { port: number }).port));
        server.once('exit', (c, s) => reject(new Error(`server child exited (${String(c ?? s)})`)));
      });
      const health = await httpRequest(port, '/_health');
      expect(health.status).toBe(200);
      for (let i = 0; i < 100 && (await job(id)).status !== 'succeeded'; i += 1) await new Promise((r) => setTimeout(r, 100));
      expect((await job(id)).status).toBe('succeeded');
      expect(await effects(id)).toHaveLength(6);
    } finally {
      const exited = new Promise((resolve) => server.once('exit', resolve));
      server.disconnect();
      await exited;
    }
  }, 90_000);
});

// Review C11 (spec §9.4 "oleh siapa saja dan kapan saja: drive, worker, cron (URL/CLI)", §9.6 step 5, §9.5 step 6):
// the cron line steps an update or rollback op as the server does, and a run that cannot move its op ends at once.
describe('jobs:run and the ops of the update kinds', () => {
  /** An update to 0.1.0, the installed release (bootContext): its prechecks refuse it (`not_newer`). */
  const entry = {
    version: '0.1.0',
    channel: 'stable',
    releasedAt: '2026-10-20',
    bootProtocol: 1,
    minUpgradeFrom: '0.0.0',
    minCodeVersionAfter: '0.0.0',
    minNode: '22.16.0',
    minDb: { mysql: '8.0.0', mariadb: '10.6.0', postgres: '15.0.0' },
    size: 1,
    sha256: 'c'.repeat(64),
    url: 'https://updates.example.test/stable/altis-0.1.0.zip',
    notesUrl: null,
  };
  const updateParams = { source: 'feed', target: '0.1.0', from: '0.1.0', entry, staging: null, needsBackup: null };
  const unknownKindWarnings = async () =>
    (await serverLog(dataDir)).filter((l) => typeof l['msg'] === 'string' && (l['msg'] as string).includes('unknown kind')).length;
  const run = async (argv: string[], env: Record<string, string> = {}) => {
    const r = await jobsRun(argv, env);
    expect(r.io.err).toBe('');
    expect(r.code).toBe(0);
    return JSON.parse(r.io.out) as { passes: number; slices: number };
  };

  beforeEach(async () => {
    for (const dir of ['ops', 'releases']) await fsp.rm(path.join(dataDir, dir), { recursive: true, force: true });
    await h.db.deleteFrom('releases_log').execute();
  });

  it('steps an update op in checking: its prechecks refuse it, the op ends aborted (no warning that it cannot)', async () => {
    const { op } = await writeOp(dataDir, { kind: 'update', state: 'checking', params: updateParams });
    const warned = await unknownKindWarnings();
    const out = await run(['--budget', '5', '--json']);
    expect(await readOpJson(dataDir)).toMatchObject({ opId: op.opId, state: 'aborted', error: { code: 'UPDATE_PRECHECK_FAILED', reason: 'not_newer' } });
    expect(await h.db.selectFrom('releases_log').select(['id', 'status']).where('id', '=', op.opId).execute()).toEqual([{ id: op.opId, status: 'aborted' }]);
    expect(await readMaintenance(dataDir)).toBeNull();
    expect(out.passes).toBeLessThanOrEqual(2);
    expect(await unknownKindWarnings()).toBe(warned);
  }, 30_000);

  it('finishes a rollback op left at its checkpoint (running, past its point of no return): previous active, the version left pinned', async () => {
    await readCurrentState(dataDir, '0.1.0');
    await fsp.mkdir(path.join(dataDir, 'releases', '0.0.9'), { recursive: true });
    await fsp.writeFile(path.join(dataDir, 'releases', '0.0.9', '.complete'), '');
    await updateCurrentState(dataDir, (s) => ({ ...s, previous: { version: '0.0.9', source: 'data' } }));
    const { op } = await writeOp(dataDir, {
      kind: 'rollback',
      state: 'running',
      pointOfNoReturn: true,
      params: { target: '0.0.9', from: '0.1.0', flipping: true },
    });
    await withTx(h, (trx) => insertReleaseLog(trx, { id: op.opId, version: '0.0.9', action: 'rollback', fromVersion: '0.1.0', startedAt: op.startedAt, backupId: null }));
    const out = await run(['--budget', '5', '--json']);
    expect(await readOpJson(dataDir)).toMatchObject({ opId: op.opId, state: 'done' });
    expect(await readCurrentState(dataDir, '0.1.0')).toMatchObject({ active: { version: '0.0.9' }, previous: null, pinned: '0.1.0' });
    expect(await h.db.selectFrom('releases_log').select(['id', 'status']).where('id', '=', op.opId).execute()).toEqual([{ id: op.opId, status: 'done' }]);
    expect(out.passes).toBeLessThanOrEqual(2);
  }, 30_000);

  it('an update op stalled for 20 minutes (frozen, its flag up) goes to needs_attention, and the run ends there', async () => {
    const at = Date.now() - 20 * 60_000;
    const { op } = await writeOp(dataDir, { kind: 'update', state: 'frozen', at, params: { ...updateParams, frozenAt: at } });
    await writeFlag(dataDir, flagOf('update', op.opId, at));
    const out = await run(['--budget', '5', '--json']);
    expect(await readOpJson(dataDir)).toMatchObject({ opId: op.opId, state: 'needs_attention', stateBefore: 'frozen' });
    expect(out.passes).toBeLessThanOrEqual(2);
  }, 30_000);

  it('an op of a kind this release cannot step (a later release began it) is left alone: one pass, one warning', async () => {
    const { op } = await writeOp(dataDir, { kind: 'update', state: 'checking', params: updateParams });
    const warned = await unknownKindWarnings();
    const out = await run(['--budget', '5', '--json'], { ALTIS_TEST_CLI_OP_KINDS_WITHOUT: 'update' });
    expect(out.passes).toBe(1);
    expect(await readOpJson(dataDir)).toMatchObject({ opId: op.opId, state: 'checking' });
    expect(await unknownKindWarnings()).toBe(warned + 1);
  }, 30_000);
});
