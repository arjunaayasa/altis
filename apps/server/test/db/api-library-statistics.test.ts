import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations } from '@altis/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { createApp } from '../../src/app.js';
import { createAgent, type AgentReply } from '../agent.js';
import { recordingLogger, sampleConfig } from '../support.js';
import { seedStaff, sessionCookieFor } from '../support-auth.js';

// The dashboard's library figures through the HTTP API, on the engine picked by ALTIS_TEST_DB: each module's endpoint
// answers its counts to a holder of that module's read permission and 403 to anyone else; `members/statistics` is its
// own route, never taken by `members/:id`.

const ctx = testDbContext();

const NOW = Date.UTC(2026, 2, 15, 5, 0, 0);
const CONFIG = sampleConfig();
const SID = '__Host-altis_sid';

describe.skipIf(!ctx.available)(`the library figures of the dashboard [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let dataDir: string;
  let app: ReturnType<typeof createApp>;

  async function getter(username: string, permissions: string[]): Promise<(p: string) => Promise<AgentReply>> {
    const user = await seedStaff(h, { username, now: NOW, roles: [{ permissions: permissions as never }] });
    const token = await sessionCookieFor(h, user.id, { now: NOW });
    const agent = createAgent(app, { headers: { origin: CONFIG.baseUrl } });
    agent.setCookie(SID, token);
    return (p) => agent.get(p);
  }

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-api-library-statistics-')));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(dataDir, 'migrations'), migrations: PHASE1_MIGRATIONS });
    app = createApp({ state: { phase: 'ready', db: h, config: CONFIG }, version: '0.1.0', buildId: 'b', log: recordingLogger(), clock: () => NOW, dataDir });
  });

  afterAll(async () => {
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  it('each module answers its holders, and refuses the others', async () => {
    const zeros = Array.from({ length: 12 }, () => 0);
    const cases = [
      ['/api/v1/catalog/statistics', 'catalog.records.read', { today: '2026-03-15', year: 2026, titles: 0, items: 0, receivedThisYear: 0 }],
      ['/api/v1/members/statistics', 'members.records.read', { today: '2026-03-15', year: 2026, registered: 0, valid: 0, joinedThisYear: 0 }],
      ['/api/v1/visits/statistics', 'visits.records.read', { today: '2026-03-15', year: 2026, thisMonth: 0, thisYear: 0, byMonth: zeros }],
      ['/api/v1/circulation/statistics', 'circulation.records.read', { today: '2026-03-15', year: 2026, thisMonth: 0, thisYear: 0, byMonth: zeros, open: 0, overdue: 0 }],
    ] as const;
    const none = await getter('tanpa_izin', ['reports.statistics.read']);
    for (const [p, permission, body] of cases) {
      const holder = await getter(`pemegang_${permission.split('.')[0]}`, [permission]);
      const res = await holder(p);
      expect([p, res.status, res.json]).toEqual([p, 200, body]);
      expect((await none(p)).status, p).toBe(403);
    }
  });
});
