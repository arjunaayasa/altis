import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { REPORTS } from '@altis/core';
import { PHASE1_MIGRATIONS, runMigrations } from '@altis/db';
import { reportExportPath } from '@altis/platform';
import { MESSAGES, newId, type MessageKey } from '@altis/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { createApp } from '../../src/app.js';
import { createAgent, type AgentReply } from '../agent.js';
import { recordingLogger, sampleConfig } from '../support.js';
import { seedStaff, sessionCookieFor, sessionCsrfFor } from '../support-auth.js';

// The reports API (spec §4.15, §5.2, §13 "Ekspor") per persona, on the engine picked by ALTIS_TEST_DB. The permission
// matrix only sees the declarations, and these routes take any signed-in staff member and check the definition's own
// permission themselves, so the per-definition rules are tested here:
// - the catalogue lists the definitions whose permission the user holds;
// - the preview pages a table report, refuses a document and a parameter the definition refuses, and writes no audit;
//   an accreditation annex is previewed in Indonesian whatever the requester reads, as it is exported;
// - a run starts on the route that fits its definition (a personal report behind a fresh re-authentication, a document
//   on neither), refuses an export over its format's row limit and parameters too big to store, stores an
//   accreditation annex in Indonesian whatever the requester reads, and audits its start without parameter values;
// - the creator sees their run in full, a holder of the jobs permission others' runs without their parameters;
// - only the creator downloads, while holding the export permission, a personal run with a fresh re-authentication,
//   Range included; an expired run answers 410; a refusal writes no audit entry.

const ctx = testDbContext();
let h: TestDbHandle;

/** In the past: an audit entry may not be dated ahead of the real clock. */
const NOW = Date.UTC(2026, 10, 10, 9, 0, 5);
const MIN = 60_000;
const DAY = 86_400_000;
const CONFIG = sampleConfig();
const SID = '__Host-altis_sid';
const REPORTS_API = '/api/v1/reports';
const CONTENT = 'n,text,amount\r\n1,baris 1,1500\r\n2,baris 2,3000\r\n';

interface Client {
  userId: string;
  get(p: string, headers?: Record<string, string>): Promise<AgentReply>;
  post(p: string, body?: unknown): Promise<AgentReply>;
}

const code = (res: AgentReply): string | undefined => (res.json as { code?: string } | undefined)?.code;
const errors = (res: AgentReply): { path: string; code: string }[] => (res.json as { errors?: { path: string; code: string }[] }).errors ?? [];

/** `texts` of `test.rows` whose stored parameters `{"def":{"rows":5,"texts":[…]}}` are exactly `bytes` bytes of JSON. */
function textsOfStoredBytes(bytes: number): string[] {
  const size = (texts: string[]) => Buffer.byteLength(JSON.stringify({ def: { rows: 5, texts } }));
  const wide = '字'.repeat(200);
  const narrow = 'a'.repeat(200);
  const texts: string[] = [];
  while (size([...texts, wide, '']) <= bytes) texts.push(wide);
  while (size([...texts, narrow, '']) <= bytes) texts.push(narrow);
  const rest = bytes - size([...texts, '']);
  texts.push(rest > 200 ? `字${'a'.repeat(rest - 3)}` : 'a'.repeat(rest));
  expect(size(texts)).toBe(bytes);
  return texts;
}

describe.skipIf(!ctx.available)(`reports API [${engineLabel()}]`, () => {
  let dataDir: string;
  let app: ReturnType<typeof createApp>;
  const clock = { now: NOW };
  let stats: Client;
  let accred: Client;
  let superAdmin: Client;
  let outsider: Client;
  let jobsReader: Client;

  async function signedIn(username: string, o: { permissions?: string[]; superAdmin?: boolean; reauthAt?: number | null; locale?: 'id' | 'en' }): Promise<Client> {
    const roles = o.superAdmin === true ? [{ key: 'super_admin' as const }] : [{ permissions: (o.permissions ?? []) as never }];
    const user = await seedStaff(h, { username, now: NOW, roles });
    if (o.locale !== undefined) await h.db.updateTable('staff_users').set({ locale: o.locale }).where('id', '=', user.id).execute();
    return sessionOf(user.id, o.reauthAt ?? null);
  }

  /** A new session of user `userId` (re-authenticated at `reauthAt`). */
  async function sessionOf(userId: string, reauthAt: number | null): Promise<Client> {
    const token = await sessionCookieFor(h, userId, { now: NOW, reauthAt });
    const agent = createAgent(app, { headers: { origin: CONFIG.baseUrl } });
    agent.setCookie(SID, token);
    const csrf = { 'x-csrf-token': sessionCsrfFor(CONFIG, token) };
    return {
      userId,
      get: (p, headers) => agent.get(p, undefined, headers),
      post: (p, body) => agent.post(p, body ?? {}, csrf),
    };
  }

  const auditCount = async (): Promise<number> => (await h.db.selectFrom('audit_log').select('seq').execute()).length;

  /** The entries of `action` on run `id`: actor and meta. */
  const entries = async (action: string, id: string) =>
    (
      await h.db
        .selectFrom('audit_log')
        .select(['actor_id', 'entity', 'meta'])
        .where('action', '=', action as never)
        .where('entity_id', '=', id)
        .orderBy('seq')
        .execute()
    ).map((r) => ({ actor: r.actor_id, entity: r.entity, meta: JSON.parse(r.meta ?? 'null') as unknown }));

  const runRow = (id: string) => h.db.selectFrom('report_runs').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
  const runCount = async () => (await h.db.selectFrom('report_runs').select('id').execute()).length;

  /** The run `id` as its export job leaves it: succeeded, expiring 7 days on, its file `content` in place. */
  async function finish(id: string, content = CONTENT): Promise<void> {
    const run = await runRow(id);
    await h.db
      .updateTable('report_runs')
      .set({ status: 'succeeded', row_count: 2, output_name: `${id}.${run.format}`, output_size: Buffer.byteLength(content), expires_at: NOW + 7 * DAY, finished_at: NOW })
      .where('id', '=', id)
      .execute();
    const file = reportExportPath(dataDir, id, run.format as 'csv');
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, content);
  }

  /** Starts a run of `body` as `client` on `/runs` (or `/runs/personal`); its id. */
  async function started(client: Client, body: unknown, personal = false): Promise<string> {
    const res = await client.post(`${REPORTS_API}/runs${personal ? '/personal' : ''}`, body);
    expect(res.status, res.text).toBe(200);
    return (res.json as { id: string }).id;
  }

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-api-reports-')));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(dataDir, 'migrations'), migrations: PHASE1_MIGRATIONS });
    app = createApp({ state: { phase: 'ready', db: h, config: CONFIG }, version: '0.1.0', buildId: 'b', log: recordingLogger(), clock: () => clock.now, dataDir });
    stats = await signedIn('statistik', { permissions: ['reports.statistics.read'], reauthAt: NOW });
    accred = await signedIn('akreditasi', { permissions: ['accreditation.workspace.read'] });
    superAdmin = await signedIn('super_laporan', { superAdmin: true });
    outsider = await signedIn('katalog_saja', { permissions: ['catalog.records.read'] });
    jobsReader = await signedIn('pemantau_tugas', { permissions: ['system.jobs.read', 'reports.statistics.read'] });
  });

  afterAll(async () => {
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    clock.now = NOW;
  });

  describe('GET reports/catalog', () => {
    const idsOf = async (client: Client) => {
      const res = await client.get(`${REPORTS_API}/catalog`);
      expect(res.status, res.text).toBe(200);
      return (res.json as { reports: { id: string; kind: string; module: string; canExport: boolean }[] }).reports;
    };

    it('the statistics permission sees the eight collection reports and no accreditation one; the test ones only in the test profile', async () => {
      const reports = await idsOf(stats);
      expect(reports.filter((r) => r.module === 'collection' && r.id.startsWith('collection.'))).toHaveLength(8);
      expect(reports.filter((r) => r.module === 'accreditation')).toEqual([]);
      expect(reports.filter((r) => r.id.startsWith('test.')).map((r) => r.id)).toEqual(['test.rows', 'test.personal', 'test.document']);
    });

    it('the accreditation workspace sees the ten annexes and the three documents, no collection report', async () => {
      const reports = await idsOf(accred);
      expect(reports.filter((r) => r.kind === 'table' && r.id.startsWith('accreditation.annex.'))).toHaveLength(10);
      expect(reports.filter((r) => r.kind === 'document').map((r) => r.id)).toEqual(['accreditation.dossier', 'accreditation.self_assessment', 'accreditation.statement_1000']);
      expect(reports.filter((r) => r.module === 'collection')).toEqual([]);
    });

    it('a super admin sees every definition; a document is never exported through the run routes', async () => {
      const reports = await idsOf(superAdmin);
      expect(reports.map((r) => r.id)).toEqual(REPORTS.map((d) => d.id));
      expect(reports.find((r) => r.id === 'test.document')).toMatchObject({ kind: 'document', canExport: false });
      expect(reports.find((r) => r.id === 'test.rows')).toMatchObject({ kind: 'table', canExport: true });
    });

    it('a user holding neither permission sees nothing', async () => {
      expect(await idsOf(outsider)).toEqual([]);
    });
  });

  describe('POST reports/:reportId/preview', () => {
    const preview = (client: Client, id: string, body: unknown) => client.post(`${REPORTS_API}/${id}/preview`, body);

    it('pages test.rows by 200: three pages, 450 rows, the last without a cursor; no audit entry', async () => {
      const before = await auditCount();
      const seen: number[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 3; page += 1) {
        const res = await preview(stats, 'test.rows', { params: { rows: 450 }, limit: 200, ...(cursor === null ? {} : { cursor }) });
        expect(res.status, res.text).toBe(200);
        const body = res.json as { rows: [number, string, number][]; nextCursor: string | null; columns: { key: string }[]; totals: unknown };
        if (page === 0) {
          expect(body.rows).toHaveLength(200);
          expect(body.nextCursor).not.toBeNull();
          expect(body.columns.map((c) => c.key)).toEqual(['n', 'text', 'amount']);
          expect(body.totals).toBeNull();
        }
        seen.push(...body.rows.map((r) => r[0]));
        cursor = body.nextCursor;
      }
      expect(cursor).toBeNull();
      expect(seen).toEqual(Array.from({ length: 450 }, (_, i) => i + 1));
      expect(await auditCount()).toBe(before);
    });

    it('an accreditation annex is previewed in Indonesian for a user reading English, as its export is written', async () => {
      const english = await signedIn('english_preview', { permissions: ['accreditation.workspace.read'], locale: 'en' });
      const periodId = newId();
      const trail = { created_at: NOW, created_by: null, updated_at: NOW, updated_by: null, archived_at: null };
      await h.db
        .insertInto('accred_periods')
        .values({
          id: periodId,
          branch_id: null,
          name: 'Periode pratinjau',
          kind: 'school_year',
          starts_on: '2025-07-01',
          ends_on: '2026-06-30',
          instrument_id: 'test-sch',
          status: 'open',
          frozen_at: null,
          frozen_by: null,
          profile: '{}',
          students: null,
          teachers: null,
          edu_staff: null,
          classes: null,
          population_served: null,
          teachers_using: null,
          user_pcs: null,
          staff_pcs: null,
          ict_devices: null,
          scanners: null,
          floor_m2: null,
          bandwidth_mbps: null,
          hours_per_week: null,
          services: null,
          external_website_url: null,
          ...trail,
        })
        .execute();
      await h.db
        .insertInto('library_activities')
        .values({
          id: newId(),
          branch_id: null,
          kind: 'promotion',
          title: 'Pekan literasi',
          held_on: '2026-01-10',
          ended_on: null,
          participants: 40,
          partner: null,
          uses_library_facility: 0,
          external_speaker: 0,
          description: null,
          version: 0,
          ...trail,
        })
        .execute();

      const res = await preview(english, 'accreditation.annex.activities', { params: { periodId } });
      expect(res.status, res.text).toBe(200);
      const body = res.json as { rows: unknown[][] };
      expect(body.rows).toEqual([[MESSAGES.id['vocab.activity_kind.promotion'], 'Pekan literasi', '2026-01-10', 40, null]]);
      expect(MESSAGES.id['vocab.activity_kind.promotion']).not.toBe(MESSAGES.en['vocab.activity_kind.promotion']);
    });

    it('refuses a user without the report’s permission (403), an unknown report (404), a bad parameter and a document (422)', async () => {
      expect((await preview(outsider, 'test.rows', { params: { rows: 1 } })).status).toBe(403);
      expect((await preview(accred, 'test.rows', { params: { rows: 1 } })).status).toBe(403);
      const unknown = await preview(stats, 'collection.tidak_ada', { params: {} });
      expect([unknown.status, code(unknown)]).toEqual([404, 'NOT_FOUND']);
      const bad = await preview(stats, 'test.rows', { params: { rows: -1 } });
      expect([bad.status, code(bad), errors(bad).map((e) => e.path)]).toEqual([422, 'VALIDATION_FAILED', ['params.rows']]);
      const doc = await preview(stats, 'test.document', { params: {} });
      expect([doc.status, errors(doc)]).toEqual([422, [{ path: 'reportId', code: 'not_previewable' }]]);
    });

    // ---- Komunitas (member, visit and circulation reports) ----
    it('the copies of the reprint list need the catalogue permission besides the members one, in a preview and an export', async () => {
      const members = await signedIn('anggota-saja', { permissions: ['members.records.read', 'members.export.run'], reauthAt: NOW });
      const both = await signedIn('anggota-katalog', { permissions: ['members.records.read', 'catalog.records.read'] });
      expect((await preview(members, 'members.reprint_list', { params: { kind: 'members' } })).status).toBe(200);
      const refused = await preview(members, 'members.reprint_list', { params: { kind: 'items' } });
      expect([refused.status, code(refused)]).toEqual([403, 'AUTHZ_DENIED']);
      const run = await members.post(`${REPORTS_API}/runs/personal`, { reportId: 'members.reprint_list', format: 'csv', params: { kind: 'items' } });
      expect([run.status, code(run)]).toEqual([403, 'AUTHZ_DENIED']);
      expect((await preview(both, 'members.reprint_list', { params: { kind: 'items' } })).status).toBe(200);
    });
  });

  describe('POST reports/runs and reports/runs/personal', () => {
    it('starts a run for the export permission holder: {id, jobId}, the stored {def, pdf}, one reports.run.start without parameter values', async () => {
      const before = await runCount();
      const res = await stats.post(`${REPORTS_API}/runs`, { reportId: 'test.rows', format: 'pdf', params: { rows: 5 }, pdf: { paper: 'F4' } });
      expect(res.status, res.text).toBe(200);
      const body = res.json as { id: string; jobId: string };
      expect(Object.keys(body).sort()).toEqual(['id', 'jobId']);
      const run = await runRow(body.id);
      expect(JSON.parse(run.params)).toEqual({ def: { rows: 5 }, pdf: { paper: 'F4' } });
      expect(run).toMatchObject({ report_id: 'test.rows', format: 'pdf', status: 'queued', personal: 0, locale: 'id', job_id: body.jobId, created_by: stats.userId });
      expect(await entries('reports.run.start', body.id)).toEqual([
        { actor: stats.userId, entity: 'report_runs', meta: { runId: body.id, reportId: 'test.rows', format: 'pdf' } },
      ]);
      expect(await runCount()).toBe(before + 1);
    });

    it('a personal report is refused on /runs and needs a fresh re-authentication on /runs/personal', async () => {
      const wrong = await stats.post(`${REPORTS_API}/runs`, { reportId: 'test.personal', format: 'csv', params: {} });
      expect([wrong.status, errors(wrong)]).toEqual([422, [{ path: 'reportId', code: 'personal_report' }]]);
      const stale = await signedIn('statistik_lama', { permissions: ['reports.statistics.read'] });
      const refused = await stale.post(`${REPORTS_API}/runs/personal`, { reportId: 'test.personal', format: 'csv', params: {} });
      expect([refused.status, code(refused)]).toEqual([401, 'AUTH_REAUTH_REQUIRED']);
      const id = await started(stats, { reportId: 'test.personal', format: 'csv', params: {} }, true);
      expect(await runRow(id)).toMatchObject({ personal: 1, report_id: 'test.personal' });
      const notPersonal = await stats.post(`${REPORTS_API}/runs/personal`, { reportId: 'test.rows', format: 'csv', params: { rows: 1 } });
      expect([notPersonal.status, errors(notPersonal)]).toEqual([422, [{ path: 'reportId', code: 'not_personal' }]]);
    });

    it('a document report is refused on both routes', async () => {
      for (const route of ['runs', 'runs/personal']) {
        const res = await stats.post(`${REPORTS_API}/${route}`, { reportId: 'test.document', format: 'csv', params: {} });
        expect([route, res.status, errors(res)]).toEqual([route, 422, [{ path: 'reportId', code: 'document_report' }]]);
      }
    });

    it('refuses an export over its format’s row limit and parameters over 8 000 bytes, writing no run', async () => {
      const before = await runCount();
      const big = await stats.post(`${REPORTS_API}/runs`, { reportId: 'test.rows', format: 'pdf', params: { rows: 10_001 } });
      expect([big.status, code(big)]).toEqual([422, 'REPORT_TOO_LARGE']);
      const tooBig = await stats.post(`${REPORTS_API}/runs`, { reportId: 'test.rows', format: 'csv', params: { rows: 5, texts: textsOfStoredBytes(8_001) } });
      expect([tooBig.status, errors(tooBig)]).toEqual([422, [{ path: 'params', code: 'too_big' }]]);
      expect(await runCount()).toBe(before);
    });

    it('refuses a user without the export permission (403) and an unknown report (404)', async () => {
      expect((await outsider.post(`${REPORTS_API}/runs`, { reportId: 'test.rows', format: 'csv', params: { rows: 1 } })).status).toBe(403);
      expect((await accred.post(`${REPORTS_API}/runs`, { reportId: 'test.rows', format: 'csv', params: { rows: 1 } })).status).toBe(403);
      const unknown = await stats.post(`${REPORTS_API}/runs`, { reportId: 'collection.tidak_ada', format: 'csv', params: {} });
      expect([unknown.status, code(unknown)]).toEqual([404, 'NOT_FOUND']);
    });

    it('a user reading English gets English files, but an accreditation annex is stored Indonesian', async () => {
      const english = await signedIn('english_reader', { permissions: ['accreditation.workspace.read', 'reports.statistics.read'], locale: 'en' });
      const annex = await started(english, { reportId: 'accreditation.annex.budgets', format: 'xlsx', params: { periodId: newId() } });
      expect((await runRow(annex)).locale).toBe('id');
      const rows = await started(english, { reportId: 'test.rows', format: 'csv', params: { rows: 1 } });
      expect((await runRow(rows)).locale).toBe('en');
    });
  });

  describe('GET reports/runs and reports/runs/:id', () => {
    it('the creator sees the parameters; a holder of the jobs permission sees the run without them; anyone else sees nothing', async () => {
      const creator = await signedIn('pembuat_daftar', { permissions: ['reports.statistics.read'] });
      const id = await started(creator, { reportId: 'test.rows', format: 'csv', params: { rows: 7 } });
      await finish(id);

      const own = await creator.get(`${REPORTS_API}/runs/${id}`);
      expect(own.status, own.text).toBe(200);
      expect(own.json).toMatchObject({ id, mine: true, params: { rows: 7 }, downloadable: true, status: 'succeeded' });
      const ownList = await creator.get(`${REPORTS_API}/runs`);
      expect((ownList.json as { runs: { id: string }[] }).runs.map((r) => r.id)).toEqual([id]);

      const seen = await jobsReader.get(`${REPORTS_API}/runs/${id}`);
      expect(seen.status, seen.text).toBe(200);
      expect(seen.json).toMatchObject({ id, mine: false, params: null, warnings: [], downloadable: false });
      const all = await jobsReader.get(`${REPORTS_API}/runs?scope=all`);
      expect((all.json as { runs: { id: string; params: unknown }[] }).runs.find((r) => r.id === id)).toMatchObject({ params: null });

      const stranger = await signedIn('bukan_pemantau', { permissions: ['reports.statistics.read'] });
      expect((await stranger.get(`${REPORTS_API}/runs/${id}`)).status).toBe(404);
      const strangerList = await stranger.get(`${REPORTS_API}/runs?scope=all`);
      expect((strangerList.json as { runs: unknown[] }).runs).toEqual([]);

      // Expired (its file is about to be swept), or the export permission gone: no longer downloadable.
      await h.db.updateTable('report_runs').set({ expires_at: NOW }).where('id', '=', id).execute();
      expect((await creator.get(`${REPORTS_API}/runs/${id}`)).json).toMatchObject({ mine: true, downloadable: false });
    });
  });

  describe('GET reports/runs/:id/download', () => {
    it('serves the creator the file as an attachment, Range included; one reports.run.download per download', async () => {
      const id = await started(stats, { reportId: 'test.rows', format: 'csv', params: { rows: 2 } });
      await finish(id);
      const full = await stats.get(`${REPORTS_API}/runs/${id}/download`);
      expect(full.status, full.text).toBe(200);
      expect(full.text).toBe(CONTENT);
      expect(full.headers.get('content-type')).toBe('text/csv; charset=utf-8');
      const title = MESSAGES.id['report.test.rows.title' as MessageKey];
      expect(full.headers.get('content-disposition')).toMatch(new RegExp(`^attachment; filename="${title}-2026-11-10\\.csv"`));
      const part = await stats.get(`${REPORTS_API}/runs/${id}/download`, { range: 'bytes=0-9' });
      expect([part.status, part.text, part.headers.get('content-range')]).toEqual([206, CONTENT.slice(0, 10), `bytes 0-9/${CONTENT.length}`]);
      expect(await entries('reports.run.download', id)).toEqual([
        { actor: stats.userId, entity: 'report_runs', meta: { runId: id, reportId: 'test.rows', format: 'csv' } },
        { actor: stats.userId, entity: 'report_runs', meta: { runId: id, reportId: 'test.rows', format: 'csv' } },
      ]);
    });

    it('refuses another staff member with the jobs permission, the creator without the export permission, a stale personal run and an expired one, without an audit entry', async () => {
      const id = await started(stats, { reportId: 'test.rows', format: 'csv', params: { rows: 2 } });
      await finish(id);
      const before = await auditCount();

      expect((await jobsReader.get(`${REPORTS_API}/runs/${id}/download`)).status).toBe(403);

      const losing = await signedIn('kehilangan_izin', { permissions: ['reports.statistics.read'] });
      const lost = await started(losing, { reportId: 'test.rows', format: 'csv', params: { rows: 2 } });
      await finish(lost);
      const roleIds = (await h.db.selectFrom('user_roles').select('role_id').where('user_id', '=', losing.userId).execute()).map((r) => r.role_id);
      await h.db.deleteFrom('role_permissions').where('role_id', 'in', roleIds).execute();
      await h.db.updateTable('staff_users').set({ authz_version: 99 }).where('id', '=', losing.userId).execute();
      const afterLoss = await sessionOf(losing.userId, null);
      expect((await afterLoss.get(`${REPORTS_API}/runs/${lost}/download`)).status).toBe(403);

      const personal = await started(stats, { reportId: 'test.personal', format: 'csv', params: {} }, true);
      await finish(personal, 'nama\r\nNama 1\r\n');
      clock.now = NOW + 6 * MIN;
      const stale = await stats.get(`${REPORTS_API}/runs/${personal}/download`);
      expect([stale.status, code(stale)]).toEqual([401, 'AUTH_REAUTH_REQUIRED']);

      clock.now = NOW;
      await h.db.updateTable('report_runs').set({ expires_at: NOW }).where('id', '=', id).execute();
      const expired = await stats.get(`${REPORTS_API}/runs/${id}/download`);
      expect([expired.status, code(expired)]).toEqual([410, 'REPORT_RUN_EXPIRED']);

      const before2 = await auditCount();
      expect(before2 - before).toBe(2); // the two run starts of this test, nothing for the refusals
      expect(await entries('reports.run.download', id)).toEqual([]);
      expect(await entries('reports.run.download', lost)).toEqual([]);
      expect(await entries('reports.run.download', personal)).toEqual([]);
    });

    it('a personal run within the re-authentication window downloads', async () => {
      const fresh = await signedIn('statistik_segar', { permissions: ['reports.statistics.read'], reauthAt: NOW });
      const id = await started(fresh, { reportId: 'test.personal', format: 'csv', params: {} }, true);
      await finish(id, 'nama\r\nNama 1\r\n');
      clock.now = NOW + 4 * MIN;
      const res = await fresh.get(`${REPORTS_API}/runs/${id}/download`);
      expect([res.status, res.text]).toEqual([200, 'nama\r\nNama 1\r\n']);
      expect(await entries('reports.run.download', id)).toHaveLength(1);
    });
  });
});
