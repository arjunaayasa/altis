import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SCHEDULES, createOpsMachine, seedSchedules, snapshotBackupRunning, type OpsMachine } from '@altis/core';
import { PHASE1_MIGRATIONS, connect, runMigrations, withTx } from '@altis/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { createApp, type AppState } from '../../src/app.js';
import type { Config } from '../../src/config.js';
import { createOpsFence } from '../../src/http/ops-fence.js';
import { createJobRuntime, jobHandlers, opKinds, type JobRuntime } from '../../src/jobs/runtime.js';
import { createAgent, type AgentReply } from '../agent.js';
import { recordingLogger, sampleConfig } from '../support.js';

// The daily backup on a host whose only scheduler is the cron URL (spec §9.9, §10.3; decision C41; preflight B5;
// Review Focus 1) on the engine picked by ALTIS_TEST_DB: runtime passenger, no runner record, `backup.daily` due, and
// nothing but `POST /_cron` calls 31 s apart. The light `backup.schedule` job begins the frozen op (DB-only), the op
// reaches `done`, the maintenance flag is gone, and one scheduled backup is `ok`.

vi.mock('@altis/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@altis/platform')>();
  return { ...actual, ensureHeadroom: async () => {} };
});

const ctx = testDbContext();
/** In the past: an audit or event row may not be dated ahead of the real clock. */
const NOW = Date.UTC(2026, 9, 20, 18, 30, 0); // 01:30 in Jakarta: today's 01:00 run is due
const DAY = 86_400_000;

describe.skipIf(!ctx.available)(`the daily backup over POST /_cron [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;
  let dataDir: string;
  let now: number;
  let config: Config;
  let state: AppState;
  let ops: OpsMachine;
  let runtime: JobRuntime;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    h = await testDb();
    config = sampleConfig({ db: h.config });
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-backup-cron-')));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(root, 'mig'), migrations: PHASE1_MIGRATIONS });
  });

  afterAll(async () => {
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    for (const table of ['jobs', 'locks', 'backups', 'events', 'notifications', 'schedules'] as const) await h.db.deleteFrom(table).execute();
    await h.db.deleteFrom('settings').where('key', 'like', 'system.run.%').execute();
    dataDir = await fsp.mkdtemp(path.join(root, 'data-'));
    now = NOW;
    const log = recordingLogger();
    state = { phase: 'ready', db: h, config };
    ops = createOpsMachine({
      dataDir,
      kinds: opKinds({ appVersion: '0.1.0', config: () => state.config }),
      db: () => h,
      connect: () => connect(h.config, { runtime: 'standalone', purpose: 'cli', dataDir: h.dataDir }),
      keyring: () => config.keyring,
      clock: () => now,
      log,
      snapshotBackupRunning: () => snapshotBackupRunning(h, Date.now()),
      appVersion: '0.1.0',
    });
    runtime = createJobRuntime({
      state,
      runtime: 'passenger',
      env: {},
      dataDir,
      log,
      clock: () => now,
      ops,
      handlers: jobHandlers(),
      requestRestart: async () => {},
      installId: config.install.id,
      appVersion: '0.1.0',
    });
    state.jobs = runtime;
    const opsFence = createOpsFence({ dataDir, intervalMs: 0, clock: () => now, onEpoch() {}, onOpEnded() {} });
    app = createApp({ state, version: '0.1.0', buildId: 'b', log, clock: () => now, env: {}, dataDir, runtime: 'passenger', services: { ops, opsFence } });
  });

  afterEach(async () => {
    await runtime.stop();
    await ops.close();
  });

  const cron = (): Promise<AgentReply> => createAgent(app).post('/_cron', undefined, { authorization: `Bearer ${config.secrets.cronToken}` });
  const flagExists = () =>
    fsp.stat(path.join(dataDir, 'ops', 'maintenance.json')).then(
      () => true,
      () => false,
    );

  it('backup.daily due; POST /_cron alone, 31 s apart → backup.schedule begins the frozen op → done, flag gone, one scheduled backup ok', async () => {
    // Seeded the day before: today's 01:00 run is due.
    await withTx(h, (trx) => seedSchedules(trx, NOW - DAY, 'Asia/Jakarta', SCHEDULES));
    const states: string[] = [];
    let opId: string | null = null;
    for (let call = 1; call <= 20; call += 1) {
      now = NOW + call * 31_000;
      const res = await cron();
      expect(res.status, res.text).toBe(200);
      const op = (res.json as { op: { opId: string; kind: string; state: string; terminal: boolean } | null }).op;
      if (op !== null) {
        opId = op.opId;
        states.push(op.state);
        if (op.terminal) break;
      }
    }
    expect(states.at(-1)).toBe('done');
    expect(await flagExists()).toBe(false);
    const schedule = await h.db.selectFrom('jobs').select(['status', 'type']).where('type', '=', 'backup.schedule').execute();
    expect(schedule).toEqual([{ status: 'succeeded', type: 'backup.schedule' }]);
    const backups = await h.db.selectFrom('backups').select(['id', 'kind', 'status', 'consistency']).execute();
    expect(backups).toEqual([{ id: opId, kind: 'scheduled', status: 'ok', consistency: 'frozen' }]);
    // DB-only (spec §9.9: scheduled backups hold no uploads by default).
    const manifest = JSON.parse(await fsp.readFile(path.join(dataDir, 'backups', opId!, 'manifest.json'), 'utf8')) as { includesFiles: boolean };
    expect(manifest.includesFiles).toBe(false);
  });
});
