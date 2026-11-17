import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations } from '@altis/db';
import { newId, type Permission } from '@altis/shared';
import type { DeskDashboard, LibraryDashboard } from '@altis/shared/api/dashboard-home';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { createApp } from '../../src/app.js';
import { createAgent, type AgentReply } from '../agent.js';
import { recordingLogger, sampleConfig } from '../support.js';
import { seedStaff, sessionCookieFor } from '../support-auth.js';

// Beranda's library figures through the HTTP API, on the engine picked by ALTIS_TEST_DB: today at a desk's branch for
// a holder of the desk permission there (403 at another branch, and for anyone else), not stored by the browser; the
// library sections for any signed-in staff user, each present only for a holder of its data's permission.

const ctx = testDbContext();

const NOW = Date.UTC(2026, 2, 15, 5, 0, 0);
const CONFIG = sampleConfig();
const SID = '__Host-altis_sid';

describe.skipIf(!ctx.available)(`Beranda's library figures through the API [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let dataDir: string;
  let app: ReturnType<typeof createApp>;
  let ut: string;
  let cb: string;

  async function getter(username: string, roles: { permissions: Permission[]; branchId?: string }[]): Promise<(p: string) => Promise<AgentReply>> {
    const user = await seedStaff(h, { username, now: NOW, roles });
    const token = await sessionCookieFor(h, user.id, { now: NOW });
    const agent = createAgent(app, { headers: { origin: CONFIG.baseUrl } });
    agent.setCookie(SID, token);
    return (p) => agent.get(p);
  }

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-api-dashboard-home-')));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(dataDir, 'migrations'), migrations: PHASE1_MIGRATIONS });
    app = createApp({ state: { phase: 'ready', db: h, config: CONFIG }, version: '0.1.0', buildId: 'b', log: recordingLogger(), clock: () => NOW, dataDir });
    const branch = async (code: string): Promise<string> => {
      const id = newId();
      await h.db.insertInto('branches').values({ id, code_key: code, code_display: code, name: `Cabang ${code}`, timezone: 'Asia/Jakarta', created_at: NOW, updated_at: NOW }).execute();
      return id;
    };
    ut = await branch('UT');
    cb = await branch('CB');
  });

  afterAll(async () => {
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  it('today at a desk: its branch’s holders only, 24 hours, no-store', async () => {
    const desk = await getter('meja_ut', [{ permissions: ['circulation.desk.use'], branchId: ut }]);
    const res = await desk(`/api/v1/branches/${ut}/dashboard`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = res.json as DeskDashboard;
    expect(body).toMatchObject({ branchId: ut, on: '2026-03-15', weekAgo: '2026-03-08', timeZone: 'Asia/Jakarta', loaned: 0, returned: 0, holdsToClear: 0 });
    expect(body.hours.map((x) => x.hour)).toEqual(Array.from({ length: 24 }, (_, k) => k));
    expect((await desk(`/api/v1/branches/${cb}/dashboard`)).status).toBe(403);
    const reader = await getter('pembaca', [{ permissions: ['circulation.records.read', 'members.records.read'] }]);
    expect((await reader(`/api/v1/branches/${ut}/dashboard`)).status).toBe(403);
  });

  it('the library sections: each only for a holder of its permission', async () => {
    const none = await getter('tanpa_izin', [{ permissions: ['catalog.records.read'] }]);
    const res = await none('/api/v1/dashboard/library');
    expect([res.status, res.headers.get('cache-control'), res.json]).toEqual([200, 'no-store', { today: '2026-03-15', members: null, loans: null, usage: null, openToday: null }]);
    const members = await getter('anggota', [{ permissions: ['members.records.read'] }]);
    expect((await members('/api/v1/dashboard/library')).json).toEqual({
      today: '2026-03-15',
      members: { active: 0, joinedThisMonth: 0, expiringSoon: 0 },
      loans: null,
      usage: null,
      openToday: null,
    } satisfies LibraryDashboard);
    const stats = await getter('statistik', [{ permissions: ['reports.statistics.read', 'circulation.records.read'] }]);
    expect((await stats('/api/v1/dashboard/library')).json).toEqual({
      today: '2026-03-15',
      members: null,
      loans: { longOverdue: 0, dueSoon: 0 },
      usage: { from: '2026-02-14', to: '2026-03-15', bySubject: [], topTitles: [] },
      openToday: null,
    } satisfies LibraryDashboard);
  });
});
