import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { localStorageDriver } from '@altis/core';
import { PHASE1_MIGRATIONS, runMigrations } from '@altis/db';
import { newId } from '@altis/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { createApp } from '../../src/app.js';
import { createAgent, type AgentReply } from '../agent.js';
import { recordingLogger, sampleConfig } from '../support.js';
import { seedStaff, sessionCookieFor, sessionCsrfFor } from '../support-auth.js';

// The stored files of stocktake sessions, on the engine picked by ALTIS_TEST_DB:
// - the report file SLiMS wrote for a migrated session is downloaded at the session's branch only, as an opaque,
//   sandboxed, never-sniffed attachment, and `/files/:id` never serves it (a global holder of every permission here
//   included);
// - the minutes a finished session stored are linked as evidence of an indicator that takes them: the picker lists the
//   sessions of the branches whose stocktake the caller may read, the link refuses a session of another branch, an
//   indicator without the minutes item and a second link of the same minutes to the same item; while linked, the file
//   (still the session's) is served by `/files/:id` to the readers of the accreditation workspace only, and removing the
//   evidence leaves the session's file in place and closes that way out again.

const ctx = testDbContext();
let h: TestDbHandle;

const NOW = Date.UTC(2026, 10, 12, 9, 0, 5);
const DAY = 86_400_000;
const CONFIG = sampleConfig();
const SID = '__Host-altis_sid';
const API = '/api/v1';
const HTML = Buffer.from('<html><body><script>alert(1)</script><h1>Laporan SLiMS uji</h1></body></html>', 'utf8');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n', 'utf8');

interface Client {
  get(p: string): Promise<AgentReply>;
  post(p: string, body?: unknown): Promise<AgentReply>;
  delete(p: string): Promise<AgentReply>;
}

const code = (res: AgentReply): string | undefined => (res.json as { code?: string } | undefined)?.code;
const fieldErrors = (res: AgentReply): unknown => (res.json as { errors?: unknown } | undefined)?.errors;

describe.skipIf(!ctx.available)(`stocktake files [${engineLabel()}]`, () => {
  let dataDir: string;
  let app: ReturnType<typeof createApp>;
  let branchA: string;
  let branchB: string;
  let periodId: string;
  /** A finished session of A with stored minutes and a SLiMS report; one of A without either; one of B with minutes. */
  let sessionA: { id: string; minutes: string; report: string };
  let bareA: string;
  let sessionB: { id: string; minutes: string };
  let atA: Client;
  let everything: Client;
  let reader: Client;
  let scanner: Client;

  async function branch(codeKey: string): Promise<string> {
    const id = newId();
    await h.db
      .insertInto('branches')
      .values({ id, code_key: codeKey, code_display: codeKey, name: `Cabang ${codeKey}`, address: null, timezone: 'Asia/Jakarta', created_at: NOW, created_by: null, updated_at: NOW, updated_by: null })
      .execute();
    return id;
  }

  /** A stored file of session `owner` in `context`; its id. */
  async function stored(owner: string, context: string, name: string, mime: string, bytes: Buffer, id = newId()): Promise<string> {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    await localStorageDriver(dataDir).put(id, bytes, { size: bytes.byteLength, sha256 });
    await h.db
      .insertInto('files')
      .values({ id, original_name: name, mime, size: bytes.byteLength, sha256, context, owner_type: 'stocktakes', owner_id: owner, access: 'staff', status: 'ok', created_at: NOW, created_by: null })
      .execute();
    return id;
  }

  async function session(branchId: string, name: string, o: { minutes?: boolean; report?: boolean; source?: string } = {}): Promise<{ id: string; minutes: string; report: string }> {
    const id = newId();
    await h.db
      .insertInto('stocktakes')
      .values({
        id,
        branch_id: branchId,
        name,
        scope: '{}',
        status: 'finished',
        active_key: null,
        options: null,
        started_at: NOW - DAY,
        started_by: null,
        finished_at: NOW - DAY / 2,
        finished_by: null,
        minutes_file_id: null,
        report_file_id: null,
        source: o.source ?? 'altis',
        created_at: NOW,
        created_by: null,
        updated_at: NOW,
        updated_by: null,
      })
      .execute();
    const minutes = o.minutes === true ? await stored(id, 'stocktake.minutes', 'berita-acara-inventarisasi.pdf', 'application/pdf', PDF) : '';
    const report = o.report === true ? await stored(id, 'stocktake.slims_report', 'stock_take_2023_report.html', 'application/octet-stream', HTML) : '';
    await h.db
      .updateTable('stocktakes')
      .set({ minutes_file_id: minutes === '' ? null : minutes, report_file_id: report === '' ? null : report })
      .where('id', '=', id)
      .execute();
    return { id, minutes, report };
  }

  async function signedIn(username: string, roles: { permissions: string[]; branchId?: string }[]): Promise<Client> {
    const user = await seedStaff(h, { username, now: NOW, roles: roles as never });
    const token = await sessionCookieFor(h, user.id, { now: NOW, reauthAt: NOW });
    const agent = createAgent(app, { headers: { origin: CONFIG.baseUrl } });
    agent.setCookie(SID, token);
    const csrf = { 'x-csrf-token': sessionCsrfFor(CONFIG, token) };
    return { get: (p) => agent.get(p), post: (p, body) => agent.post(p, body ?? {}, csrf), delete: (p) => agent.delete(p, undefined, csrf) };
  }

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-api-stocktake-files-')));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(dataDir, 'migrations'), migrations: PHASE1_MIGRATIONS });
    app = createApp({ state: { phase: 'ready', db: h, config: CONFIG }, version: '0.1.0', buildId: 'b', log: recordingLogger(), clock: () => NOW, dataDir });
    branchA = await branch('BERKAS-A');
    branchB = await branch('BERKAS-B');
    sessionA = await session(branchA, 'Inventarisasi 2023', { minutes: true, report: true, source: 'migrated' });
    bareA = (await session(branchA, 'Inventarisasi Tanpa Berkas')).id;
    sessionB = await session(branchB, 'Inventarisasi Cabang B', { minutes: true });
    periodId = newId();
    await h.db
      .insertInto('accred_periods')
      .values({
        id: periodId,
        name: 'Tahun ajaran 2025/2026',
        instrument_id: 'sch-sma-2025',
        kind: 'school_year',
        starts_on: '2025-07-01',
        ends_on: '2026-06-30',
        branch_id: null,
        profile: '{}',
        all_registered_confirmed: 0,
        status: 'open',
        frozen_at: null,
        frozen_by: null,
        archived_at: null,
        version: 0,
        created_at: NOW,
        created_by: null,
        updated_at: NOW,
        updated_by: null,
      })
      .execute();
    atA = await signedIn('pustakawan_a', [
      { permissions: ['accreditation.workspace.read', 'accreditation.workspace.manage'] },
      { permissions: ['stocktake.scan.use'], branchId: branchA },
    ]);
    everything = await signedIn('semua_izin', [{ permissions: ['stocktake.scan.use', 'stocktake.sessions.manage', 'accreditation.workspace.read', 'accreditation.workspace.manage'] }]);
    reader = await signedIn('pembaca_akreditasi', [{ permissions: ['accreditation.workspace.read'] }]);
    scanner = await signedIn('petugas_inventarisasi', [{ permissions: ['stocktake.scan.use'] }]);
  });

  afterAll(async () => {
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  it('the SLiMS report of a migrated session: a sandboxed attachment of an opaque type, at its branch only; never through /files/:id', async () => {
    const res = await atA.get(`${API}/branches/${branchA}/stocktakes/${sessionA.id}/slims-report`);
    expect(res.status, res.text).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="stock_take_2023_report\.html"/);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.text).toBe(HTML.toString('utf8'));
    // The session view says it has one; a session without one says so, and its download is 404.
    const view = await atA.get(`${API}/branches/${branchA}/stocktakes/${sessionA.id}`);
    expect((view.json as { migratedReport: unknown }).migratedReport).toEqual({ name: 'stock_take_2023_report.html', size: HTML.byteLength });
    const bare = await atA.get(`${API}/branches/${branchA}/stocktakes/${bareA}/slims-report`);
    expect([bare.status, code(bare)]).toEqual([404, 'NOT_FOUND']);
    expect(((await atA.get(`${API}/branches/${branchA}/stocktakes/${bareA}`)).json as { migratedReport: unknown }).migratedReport).toBeNull();
    // Another branch: refused there; a session named under a branch it is not of does not exist.
    expect((await atA.get(`${API}/branches/${branchB}/stocktakes/${sessionA.id}/slims-report`)).status).toBe(403);
    expect((await everything.get(`${API}/branches/${branchB}/stocktakes/${sessionA.id}/slims-report`)).status).toBe(404);
    for (const client of [everything, atA, reader]) {
      const direct = await client.get(`/files/${sessionA.report}`);
      expect([direct.status, code(direct)]).toEqual([404, 'NOT_FOUND']);
    }
  });

  it('the minutes as evidence: the picker lists the sessions of the caller’s branches; the link refuses another branch, a wrong indicator and a second link', async () => {
    const list = await atA.get(`${API}/accreditation/evidence/stocktake-minutes`);
    expect(list.status, list.text).toBe(200);
    expect((list.json as { items: { stocktakeId: string; fileId: string; branch: { id: string } }[] }).items).toEqual([
      expect.objectContaining({ stocktakeId: sessionA.id, fileId: sessionA.minutes, branch: expect.objectContaining({ id: branchA }) }),
    ]);
    const all = (await everything.get(`${API}/accreditation/evidence/stocktake-minutes`)).json as { items: { stocktakeId: string }[] };
    expect(all.items.map((s) => s.stocktakeId).sort()).toEqual([sessionA.id, sessionB.id].sort());
    expect((await reader.get(`${API}/accreditation/evidence/stocktake-minutes`)).status).toBe(403);

    const attach = (client: Client, body: Record<string, unknown>) => client.post(`${API}/accreditation/evidence/stocktake-minutes`, { periodId, indicatorCode: 'SCH-K7', ...body });
    const other = await attach(atA, { stocktakeId: sessionB.id });
    expect([other.status, code(other), fieldErrors(other)]).toEqual([422, 'VALIDATION_FAILED', [{ path: 'stocktakeId', code: 'not_found' }]]);
    const bare = await attach(everything, { stocktakeId: bareA });
    expect(fieldErrors(bare)).toEqual([{ path: 'stocktakeId', code: 'not_found' }]);
    const wrong = await attach(atA, { stocktakeId: sessionA.id, indicatorCode: 'SCH-K1' });
    expect(fieldErrors(wrong)).toEqual([{ path: 'indicatorCode', code: 'invalid' }]);

    const made = await attach(atA, { stocktakeId: sessionA.id });
    expect(made.status, made.text).toBe(201);
    const evidenceId = (made.json as { id: string }).id;
    const again = await attach(atA, { stocktakeId: sessionA.id, caption: 'Lagi' });
    expect(fieldErrors(again)).toEqual([{ path: 'stocktakeId', code: 'duplicate' }]);
    // The same minutes under the other indicator that takes them.
    expect((await attach(atA, { stocktakeId: sessionA.id, indicatorCode: 'SCH-K8' })).status).toBe(201);

    const evidence = (await atA.get(`${API}/accreditation/evidence?periodId=${periodId}&indicatorCode=SCH-K7`)).json as {
      evidence: { id: string; fileId: string; evidenceCode: string; caption: string; mime: string }[];
    };
    expect(evidence.evidence).toEqual([expect.objectContaining({ id: evidenceId, fileId: sessionA.minutes, evidenceCode: 'stocktake_minutes', caption: 'Inventarisasi 2023', mime: 'application/pdf' })]);
    // The file is still the session's: nothing claimed it, nothing copied it.
    expect(await h.db.selectFrom('files').select(['owner_type', 'owner_id', 'context']).where('id', '=', sessionA.minutes).executeTakeFirstOrThrow()).toEqual({
      owner_type: 'stocktakes',
      owner_id: sessionA.id,
      context: 'stocktake.minutes',
    });
    expect(await h.db.selectFrom('files').select('id').where('context', '=', 'stocktake.minutes').execute()).toHaveLength(2);
    // Audited once, as an evidence link, without the caption.
    const audit = await h.db.selectFrom('audit_log').select(['action', 'meta']).where('entity_id', '=', evidenceId).execute();
    expect(audit.map((a) => a.action)).toEqual(['accreditation.evidence.create']);
    expect(JSON.parse(audit[0]!.meta)).toMatchObject({ periodId, indicatorCode: 'SCH-K7', evidenceCode: 'stocktake_minutes', stocktakeId: sessionA.id });
    expect(audit[0]!.meta).not.toContain('Inventarisasi 2023');

    // While linked, the readers of the workspace open it through /files/:id; other staff do not; the unlinked minutes stay closed.
    const opened = await reader.get(`/files/${sessionA.minutes}`);
    expect([opened.status, opened.headers.get('content-type')]).toEqual([200, 'application/pdf']);
    expect((await scanner.get(`/files/${sessionA.minutes}`)).status).toBe(404);
    expect((await reader.get(`/files/${sessionB.minutes}`)).status).toBe(404);

    // Removing both links leaves the session's file, and closes that way out again.
    const linked = await h.db.selectFrom('accred_evidence').select('id').where('file_id', '=', sessionA.minutes).execute();
    for (const e of linked) expect((await atA.delete(`${API}/accreditation/evidence/${e.id}`)).status).toBe(200);
    expect(await h.db.selectFrom('files').select(['owner_type', 'owner_id']).where('id', '=', sessionA.minutes).executeTakeFirstOrThrow()).toEqual({ owner_type: 'stocktakes', owner_id: sessionA.id });
    expect((await reader.get(`/files/${sessionA.minutes}`)).status).toBe(404);
  });
});
