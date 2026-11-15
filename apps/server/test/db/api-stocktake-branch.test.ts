import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations } from '@altis/db';
import { reportExportPath } from '@altis/platform';
import { newId } from '@altis/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { createApp } from '../../src/app.js';
import { createAgent, type AgentReply } from '../agent.js';
import { recordingLogger, sampleConfig } from '../support.js';
import { seedStaff, sessionCookieFor, sessionCsrfFor } from '../support-auth.js';

// Stocktake at one branch only, on the engine picked by ALTIS_TEST_DB. Scanning is a branch permission: a role granted
// at branch A sees the stocktake reports in the catalogue, previews, exports and downloads a session report of a
// session of A (the history of A too), and is refused for a session of B and for the history of every branch; it
// declares a code list upload for A, and not for B nor without a branch. A global holder needs no branch.

const ctx = testDbContext();
let h: TestDbHandle;

const NOW = Date.UTC(2026, 10, 10, 9, 0, 5);
const DAY = 86_400_000;
const CONFIG = sampleConfig();
const SID = '__Host-altis_sid';
const REPORTS_API = '/api/v1/reports';

interface Client {
  get(p: string): Promise<AgentReply>;
  post(p: string, body?: unknown): Promise<AgentReply>;
}

const code = (res: AgentReply): string | undefined => (res.json as { code?: string } | undefined)?.code;

describe.skipIf(!ctx.available)(`stocktake at one branch [${engineLabel()}]`, () => {
  let dataDir: string;
  let app: ReturnType<typeof createApp>;
  let branchA: string;
  let branchB: string;
  let sessionA: string;
  let sessionB: string;
  let atA: Client;
  let global: Client;

  async function branch(codeKey: string): Promise<string> {
    const id = newId();
    await h.db
      .insertInto('branches')
      .values({ id, code_key: codeKey, code_display: codeKey, name: `Cabang ${codeKey}`, address: null, timezone: 'Asia/Jakarta', created_at: NOW, created_by: null, updated_at: NOW, updated_by: null })
      .execute();
    return id;
  }

  async function session(branchId: string): Promise<string> {
    const id = newId();
    await h.db
      .insertInto('stocktakes')
      .values({
        id,
        branch_id: branchId,
        name: 'Sesi Cabang',
        scope: '{}',
        status: 'finished',
        active_key: null,
        options: null,
        started_at: NOW - DAY,
        started_by: null,
        finished_at: NOW,
        finished_by: null,
        minutes_file_id: null,
        report_file_id: null,
        source: 'altis',
        created_at: NOW,
        created_by: null,
        updated_at: NOW,
        updated_by: null,
      })
      .execute();
    return id;
  }

  async function signedIn(username: string, roles: { permissions: string[]; branchId?: string }[]): Promise<Client> {
    const user = await seedStaff(h, { username, now: NOW, roles: roles as never });
    const token = await sessionCookieFor(h, user.id, { now: NOW, reauthAt: NOW });
    const agent = createAgent(app, { headers: { origin: CONFIG.baseUrl } });
    agent.setCookie(SID, token);
    const csrf = { 'x-csrf-token': sessionCsrfFor(CONFIG, token) };
    return { get: (p) => agent.get(p), post: (p, body) => agent.post(p, body ?? {}, csrf) };
  }

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-api-stocktake-')));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(dataDir, 'migrations'), migrations: PHASE1_MIGRATIONS });
    app = createApp({ state: { phase: 'ready', db: h, config: CONFIG }, version: '0.1.0', buildId: 'b', log: recordingLogger(), clock: () => NOW, dataDir });
    branchA = await branch('CAB-A');
    branchB = await branch('CAB-B');
    sessionA = await session(branchA);
    sessionB = await session(branchB);
    atA = await signedIn('petugas_cabang_a', [{ permissions: ['stocktake.scan.use'], branchId: branchA }]);
    global = await signedIn('petugas_semua', [{ permissions: ['stocktake.scan.use'] }]);
  });

  afterAll(async () => {
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  it('the catalogue lists the stocktake reports to a holder at one branch', async () => {
    const res = await atA.get(`${REPORTS_API}/catalog`);
    expect(res.status, res.text).toBe(200);
    const reports = (res.json as { reports: { id: string; canExport: boolean }[] }).reports.filter((r) => r.id.startsWith('stocktake.'));
    expect(reports.map((r) => r.id).sort()).toEqual(['stocktake.by_officer', 'stocktake.history', 'stocktake.misplaced', 'stocktake.missing', 'stocktake.progress']);
    expect(reports.every((r) => r.canExport)).toBe(true);
  });

  it('a session report is previewed at the session’s branch only; the history of that branch, not of every branch', async () => {
    const preview = (client: Client, id: string, params: unknown) => client.post(`${REPORTS_API}/${id}/preview`, { params });
    expect((await preview(atA, 'stocktake.progress', { stocktakeId: sessionA })).status).toBe(200);
    const other = await preview(atA, 'stocktake.progress', { stocktakeId: sessionB });
    expect([other.status, code(other)]).toEqual([403, 'AUTHZ_DENIED']);
    expect((await preview(atA, 'stocktake.missing', { stocktakeId: sessionB })).status).toBe(403);
    expect((await preview(atA, 'stocktake.history', { branchId: branchA })).status).toBe(200);
    expect((await preview(atA, 'stocktake.history', { branchId: branchB })).status).toBe(403);
    expect((await preview(atA, 'stocktake.history', {})).status).toBe(403);
    expect((await preview(global, 'stocktake.history', {})).status).toBe(200);
    expect((await preview(global, 'stocktake.progress', { stocktakeId: sessionB })).status).toBe(200);
  });

  it('a session report is exported and downloaded at the session’s branch only', async () => {
    const run = await atA.post(`${REPORTS_API}/runs`, { reportId: 'stocktake.progress', format: 'csv', params: { stocktakeId: sessionA } });
    expect(run.status, run.text).toBe(200);
    const refused = await atA.post(`${REPORTS_API}/runs`, { reportId: 'stocktake.progress', format: 'csv', params: { stocktakeId: sessionB } });
    expect([refused.status, code(refused)]).toEqual([403, 'AUTHZ_DENIED']);
    const id = (run.json as { id: string }).id;
    const content = 'section,label\r\n';
    await h.db
      .updateTable('report_runs')
      .set({ status: 'succeeded', row_count: 1, output_name: `${id}.csv`, output_size: Buffer.byteLength(content), expires_at: NOW + 7 * DAY, finished_at: NOW })
      .where('id', '=', id)
      .execute();
    const file = reportExportPath(dataDir, id, 'csv');
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, content);
    const view = await atA.get(`${REPORTS_API}/runs/${id}`);
    expect((view.json as { downloadable: boolean }).downloadable).toBe(true);
    const download = await atA.get(`${REPORTS_API}/runs/${id}/download`);
    expect(download.status, download.text).toBe(200);
    // The run's session moves to the other branch: its creator, who holds the permission at A only, is refused.
    await h.db.updateTable('stocktakes').set({ branch_id: branchB }).where('id', '=', sessionA).execute();
    expect((await atA.get(`${REPORTS_API}/runs/${id}/download`)).status).toBe(403);
    await h.db.updateTable('stocktakes').set({ branch_id: branchA }).where('id', '=', sessionA).execute();
  });

  it('a code list upload is declared for a branch where the user scans, never for another one nor without a branch', async () => {
    const bytes = Buffer.from('KODE-1\n', 'utf8');
    const body = { context: 'stocktake.codes', size: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
    const declare = (client: Client, extra: Record<string, unknown>) => client.post('/api/v1/files/uploads', { ...body, ...extra });
    const own = await declare(atA, { branchId: branchA });
    expect(own.status, own.text).toBe(201);
    const other = await declare(atA, { branchId: branchB });
    expect([other.status, code(other)]).toEqual([403, 'AUTHZ_DENIED']);
    expect((await declare(atA, {})).status).toBe(403);
    expect((await declare(global, {})).status).toBe(201);
  });
});
