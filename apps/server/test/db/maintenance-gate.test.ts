import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSettingsCache, type MaintenanceFlag, type SettingsCache } from '@altis/core';
import { PHASE1_MIGRATIONS, runMigrations } from '@altis/db';
import type { OpKind } from '@altis/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { createApp } from '../../src/app.js';
import { createOpsFence } from '../../src/http/ops-fence.js';
import { route, type RouteDecl } from '../../src/http/route.js';
import { ALL_ROUTES } from '../../src/routes.js';
import { createAgent, type AgentReply } from '../agent.js';
import { flagOf, removeOp, writeFlag, writeOp } from '../ops-support.js';
import { recordingLogger, sampleConfig } from '../support.js';

// Step 5, the maintenance gate (spec §9.4; plan Task 15, decision C20, S2) on the engine picked by ALTIS_TEST_DB:
// test routes with each `maintenance` value against no flag, a frozen backup's flag and a restore's; /_health; the
// wizard's routes during `install-migrate`; and no `system.ip_trust` read while a restore runs (its tables may be gone).

const ctx = testDbContext();
const CONFIG = sampleConfig({ db: { dialect: 'sqlite' } });

/** A test route (GET, public with an optional session, so that step 3's persisted part runs for it). */
function gateRoute(id: string, urlPath: string, maintenance: RouteDecl['maintenance']): RouteDecl {
  return route({
    id,
    method: 'GET',
    path: urlPath,
    public: true,
    ...(maintenance === undefined ? {} : { maintenance }),
    idempotency: 'none',
    audit: null,
    handler: async () => ({ body: { ok: true } }),
  });
}

const ROUTES: RouteDecl[] = [
  ALL_ROUTES.find((d) => d.id === 'health')!,
  gateRoute('gate.deny', '/api/v1/_gate/deny', 'deny'),
  gateRoute('gate.allow', '/api/v1/_gate/allow', 'allow'),
  gateRoute('gate.restore_allow', '/api/v1/_gate/restore-allow', 'restore-allow'),
  // A wizard route that maintenance would refuse but for `install-migrate`.
  route({
    id: 'gate.install',
    method: 'GET',
    path: '/install/api/_gate',
    public: true,
    session: 'none',
    install: 'claimed',
    maintenance: 'deny',
    idempotency: 'none',
    audit: null,
    handler: async () => ({ body: { ok: true } }),
  }),
];

const PATHS = { deny: '/api/v1/_gate/deny', allow: '/api/v1/_gate/allow', 'restore-allow': '/api/v1/_gate/restore-allow' } as const;

const code = (res: AgentReply): string | undefined => (res.json as { code?: string } | undefined)?.code;
const reason = (res: AgentReply): string | undefined => (res.json as { reason?: string } | undefined)?.reason;

describe.skipIf(!ctx.available)(`step 5, the maintenance gate [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;
  let dataDir: string;
  let settings: SettingsCache;
  let settingsGet: MockInstance<SettingsCache['get']>;
  let app: ReturnType<typeof createApp>;
  let log: ReturnType<typeof recordingLogger>;

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-maint-')));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(root, 'mig'), migrations: PHASE1_MIGRATIONS });
  });

  afterAll(async () => {
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    dataDir = await fsp.mkdtemp(path.join(root, 'data-'));
    settings = createSettingsCache({ clock: () => Date.now() });
    settingsGet = vi.spyOn(settings, 'get');
    // A fence that looks on every request, so that each flag the test writes is seen by the next request.
    const opsFence = createOpsFence({ dataDir, intervalMs: 0, clock: () => Date.now(), onEpoch() {}, onOpEnded() {} });
    log = recordingLogger();
    app = createApp({
      state: { phase: 'ready', db: h, config: CONFIG },
      version: '0.1.0',
      buildId: 'b',
      log,
      env: {},
      dataDir,
      routes: ROUTES,
      services: { opsFence, settings },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** An op of `kind` holding the ops lock with the maintenance flag `reason` (null: no flag). */
  async function opWithFlag(kind: OpKind, state: string, reason: MaintenanceFlag['reason'] | null): Promise<void> {
    const { op } = await writeOp(dataDir, { kind, state });
    await writeFlag(dataDir, reason === null ? null : flagOf(reason, op.opId));
  }

  const get = (urlPath: string): Promise<AgentReply> => createAgent(app).get(urlPath);

  const expectMaintenance = (res: AgentReply, why: string): void => {
    expect(res.status, res.text).toBe(503);
    expect(code(res)).toBe('MAINTENANCE');
    expect(reason(res)).toBe(why);
    expect(res.headers.get('retry-after')).toBe('30');
  };

  it('no flag: deny, allow and restore-allow all pass', async () => {
    for (const urlPath of Object.values(PATHS)) {
      const res = await get(urlPath);
      expect(res.status, `${urlPath}: ${res.text}`).toBe(200);
    }
  });

  it('a frozen backup: deny → 503 MAINTENANCE reason backup with Retry-After: 30; allow and restore-allow → 200', async () => {
    await opWithFlag('backup', 'exporting', 'backup');
    expectMaintenance(await get(PATHS.deny), 'backup');
    expect((await get(PATHS.allow)).status).toBe(200);
    expect((await get(PATHS['restore-allow'])).status).toBe(200);
    // An expected refusal, not a failure: nothing is logged as an error (a busy site would fill its log otherwise).
    expect(log.lines.filter((l) => l.level === 'error')).toEqual([]);
  });

  it('a manual flag (maintenance:on, no op): deny → 503 reason manual; allow → 200', async () => {
    await writeFlag(dataDir, flagOf('manual', null));
    expectMaintenance(await get(PATHS.deny), 'manual');
    expect((await get(PATHS.allow)).status).toBe(200);
  });

  it('a restore: deny and allow → 503 reason restore; only restore-allow → 200', async () => {
    await opWithFlag('restore', 'prechecked', 'restore');
    expectMaintenance(await get(PATHS.deny), 'restore');
    expectMaintenance(await get(PATHS.allow), 'restore');
    expect((await get(PATHS['restore-allow'])).status).toBe(200);
  });

  it('the flag gone: everything passes again (the fence sees it on its next look)', async () => {
    await opWithFlag('backup', 'exporting', 'backup');
    expect((await get(PATHS.deny)).status).toBe(503);
    await writeFlag(dataDir, null);
    await removeOp(dataDir);
    expect((await get(PATHS.deny)).status).toBe(200);
  });

  it('a wizard route passes while the op is install-migrate, and is refused under any other flag', async () => {
    await opWithFlag('install-migrate', 'running', 'install');
    const during = await get('/install/api/_gate');
    expect(code(during), during.text).not.toBe('MAINTENANCE');
    expect(during.status).not.toBe(503);
    await opWithFlag('backup', 'exporting', 'backup');
    expectMaintenance(await get('/install/api/_gate'), 'backup');
  });

  it('GET /_health → 503 {status: maintenance} during a restore, 200 during a frozen backup', async () => {
    await opWithFlag('backup', 'exporting', 'backup');
    const backup = await get('/_health');
    expect(backup.status, backup.text).toBe(200);
    expect(backup.json).toEqual({ status: 'ok', version: '0.1.0' });
    await opWithFlag('restore', 'loading', 'restore');
    const restore = await get('/_health');
    expect(restore.status).toBe(503);
    expect(restore.json).toEqual({ status: 'maintenance', version: '0.1.0' });
  });

  it('during a restore no request reads settings for system.ip_trust (S2); outside one a route does', async () => {
    const ipTrustReads = (): number => settingsGet.mock.calls.filter(([, key]) => key === 'system.ip_trust').length;
    await opWithFlag('restore', 'loading', 'restore');
    for (const urlPath of [...Object.values(PATHS), '/_health']) await get(urlPath);
    expect(ipTrustReads()).toBe(0);

    // The control: the same requests without the restore read it.
    await writeFlag(dataDir, null);
    await removeOp(dataDir);
    expect((await get(PATHS.deny)).status).toBe(200);
    expect(ipTrustReads()).toBeGreaterThan(0);
  });
});
