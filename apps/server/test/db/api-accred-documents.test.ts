import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations } from '@altis/db';
import { newId } from '@altis/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { createApp } from '../../src/app.js';
import { createAgent, type AgentReply } from '../agent.js';
import { recordingLogger, sampleConfig } from '../support.js';
import { seedStaff, sessionCookieFor, sessionCsrfFor } from '../support-auth.js';

// The routes of a period's accreditation documents on the engine picked by ALTIS_TEST_DB:
// - the evidence file and the simulation print the staff's names: without a fresh re-authentication they answer 401;
//   the statement of 1 000 titles names no one and starts without one;
// - each start writes one run (always stored in Indonesian, whatever the requester reads) and one `reports.run.start`
//   with the run, the report and the format, never a parameter value;
// - a user without `accreditation.workspace.read` gets 403, an unknown period 404;
// - a ZIP over 5 000 entries is refused 422 REPORT_TOO_LARGE before anything is written; the request letter as a ZIP
//   is refused 422.

const ctx = testDbContext();
let h: TestDbHandle;

/** In the past: an audit entry may not be dated ahead of the real clock. */
const NOW = Date.UTC(2026, 10, 13, 9, 0, 5);
const CONFIG = sampleConfig();
const SID = '__Host-altis_sid';
const PERIODS = '/api/v1/accreditation/periods';

interface Client {
  userId: string;
  post(p: string, body?: unknown): Promise<AgentReply>;
}

const code = (res: AgentReply): string | undefined => (res.json as { code?: string } | undefined)?.code;

describe.skipIf(!ctx.available)(`accreditation documents API [${engineLabel()}]`, () => {
  let dataDir: string;
  let app: ReturnType<typeof createApp>;
  let reader: Client;
  let freshReader: Client;
  let english: Client;
  let outsider: Client;

  async function signedIn(username: string, permissions: string[], reauthAt: number | null, locale?: 'en'): Promise<Client> {
    const user = await seedStaff(h, { username, now: NOW, roles: [{ permissions: permissions as never }] });
    if (locale !== undefined) await h.db.updateTable('staff_users').set({ locale }).where('id', '=', user.id).execute();
    const token = await sessionCookieFor(h, user.id, { now: NOW, reauthAt });
    const agent = createAgent(app, { headers: { origin: CONFIG.baseUrl } });
    agent.setCookie(SID, token);
    const csrf = { 'x-csrf-token': sessionCsrfFor(CONFIG, token) };
    return { userId: user.id, post: (p, body) => agent.post(p, body ?? {}, csrf) };
  }

  /** An open period of the test instrument; its id. */
  async function period(): Promise<string> {
    const at = NOW - 3_600_000;
    const id = newId(at);
    await h.db
      .insertInto('accred_periods')
      .values({
        id,
        branch_id: null,
        name: 'Tahun pelajaran 2025/2026',
        kind: 'school_year',
        starts_on: '2025-07-01',
        ends_on: '2026-06-30',
        instrument_id: 'test-sch',
        status: 'open',
        frozen_at: null,
        frozen_by: null,
        profile: '{"schoolLevel":"sma_smk_ma","npp":"3201010D1000004"}',
        all_registered_confirmed: 0,
        archived_at: null,
        version: 0,
        created_at: at,
        created_by: null,
        updated_at: at,
        updated_by: null,
      })
      .execute();
    return id;
  }

  /** The `reports.run.start` entries of run `runId`: actor and meta. */
  const starts = async (runId: string) =>
    (
      await h.db.selectFrom('audit_log').select(['actor_id', 'entity', 'meta']).where('action', '=', 'reports.run.start').where('entity_id', '=', runId).orderBy('seq').execute()
    ).map((r) => ({ actor: r.actor_id, entity: r.entity, meta: JSON.parse(r.meta ?? 'null') as unknown }));
  const runCount = async (): Promise<number> => (await h.db.selectFrom('report_runs').select('id').execute()).length;
  const auditCount = async (): Promise<number> => (await h.db.selectFrom('audit_log').select('seq').execute()).length;
  const runOf = (id: string) => h.db.selectFrom('report_runs').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-api-accred-documents-')));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(dataDir, 'migrations'), migrations: PHASE1_MIGRATIONS });
    app = createApp({ state: { phase: 'ready', db: h, config: CONFIG }, version: '0.1.0', buildId: 'b', log: recordingLogger(), clock: () => NOW, dataDir });
    reader = await signedIn('baca_dokumen', ['accreditation.workspace.read'], null);
    freshReader = await signedIn('baca_dokumen_segar', ['accreditation.workspace.read'], NOW);
    english = await signedIn('english_reader', ['accreditation.workspace.read'], NOW, 'en');
    outsider = await signedIn('baca_katalog', ['catalog.records.read'], NOW);
  });

  afterAll(async () => {
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  it('starts the evidence file and the simulation only after a fresh re-authentication, each with one audit entry', async () => {
    const id = await period();
    for (const [route, body] of [
      ['dossier', { format: 'pdf' }],
      ['self-assessment', {}],
    ] as const) {
      const audits = await auditCount();
      const refused = await reader.post(`${PERIODS}/${id}/${route}`, body);
      expect([refused.status, code(refused)], route).toEqual([401, 'AUTH_REAUTH_REQUIRED']);
      expect(await auditCount()).toBe(audits);

      const started = await freshReader.post(`${PERIODS}/${id}/${route}`, body);
      expect(started.status, started.text).toBe(200);
      const run = started.json as { id: string; jobId: string };
      expect(started.json).toEqual({ id: run.id, jobId: run.jobId });
      const reportId = route === 'dossier' ? 'accreditation.dossier' : 'accreditation.self_assessment';
      expect(await starts(run.id)).toEqual([{ actor: freshReader.userId, entity: 'report_runs', meta: { runId: run.id, reportId, format: 'pdf' } }]);
      expect(await runOf(run.id)).toMatchObject({ report_id: reportId, format: 'pdf', status: 'queued', personal: 1, locale: 'id', created_by: freshReader.userId });
    }
  });

  it('starts the statement without a re-authentication; a ZIP is stored as zip with its mode', async () => {
    const id = await period();
    const started = await reader.post(`${PERIODS}/${id}/statement-1000`, {});
    expect(started.status, started.text).toBe(200);
    const run = started.json as { id: string };
    expect(await starts(run.id)).toEqual([{ actor: reader.userId, entity: 'report_runs', meta: { runId: run.id, reportId: 'accreditation.statement_1000', format: 'pdf' } }]);
    expect(await runOf(run.id)).toMatchObject({ report_id: 'accreditation.statement_1000', personal: 0, locale: 'id' });

    const zip = await freshReader.post(`${PERIODS}/${id}/dossier`, { format: 'zip_components' });
    expect(zip.status, zip.text).toBe(200);
    const zipRun = await runOf((zip.json as { id: string }).id);
    expect(zipRun).toMatchObject({ format: 'zip', personal: 1 });
    expect(JSON.parse(zipRun.params)).toEqual({ def: { periodId: id, part: 'all', zipMode: 'components' } });
    expect(await starts(zipRun.id)).toEqual([{ actor: freshReader.userId, entity: 'report_runs', meta: { runId: zipRun.id, reportId: 'accreditation.dossier', format: 'zip' } }]);
  });

  it('stores the run in Indonesian for a requester who reads English', async () => {
    const id = await period();
    for (const [route, body] of [
      ['dossier', { format: 'pdf' }],
      ['self-assessment', {}],
      ['statement-1000', {}],
    ] as const) {
      const res = await english.post(`${PERIODS}/${id}/${route}`, body);
      expect(res.status, res.text).toBe(200);
      expect((await runOf((res.json as { id: string }).id)).locale, route).toBe('id');
    }
  });

  it('refuses an outsider (403), an unknown period (404), the request letter as a ZIP and an oversized ZIP (422)', async () => {
    const id = await period();
    for (const route of ['dossier', 'self-assessment', 'statement-1000']) {
      const res = await outsider.post(`${PERIODS}/${id}/${route}`, route === 'dossier' ? { format: 'pdf' } : {});
      expect(res.status, route).toBe(403);
    }
    expect((await freshReader.post(`${PERIODS}/${newId()}/statement-1000`, {})).status).toBe(404);

    const runs = await runCount();
    const audits = await auditCount();
    const letter = await freshReader.post(`${PERIODS}/${id}/dossier`, { format: 'zip', part: 'request_letter' });
    expect([letter.status, code(letter)]).toEqual([422, 'VALIDATION_FAILED']);

    // 5 001 evidence rows of one tiny file: the estimate already passes 5 000 entries.
    const fileId = newId(NOW);
    await h.db
      .insertInto('files')
      .values({ id: fileId, original_name: 'survei.pdf', mime: 'application/pdf', size: 10, sha256: 'x', context: 'accreditation.evidence', owner_type: null, owner_id: null, access: 'staff', status: 'ok', created_at: NOW, created_by: null })
      .execute();
    const rows = Array.from({ length: 5_001 }, () => ({
      id: newId(NOW),
      period_id: id,
      indicator_code: 'SCH-K1',
      evidence_code: 'catalogue_screenshot',
      entity: null,
      entity_id: null,
      file_id: fileId,
      caption: 'Layar',
      created_at: NOW,
      created_by: null,
    }));
    for (let i = 0; i < rows.length; i += 500) await h.db.insertInto('accred_evidence').values(rows.slice(i, i + 500)).execute();
    for (const format of ['zip', 'zip_components']) {
      const big = await freshReader.post(`${PERIODS}/${id}/dossier`, { format });
      expect([big.status, code(big)], format).toEqual([422, 'REPORT_TOO_LARGE']);
    }
    expect(await runCount()).toBe(runs);
    expect(await auditCount()).toBe(audits);
    // The PDF holds no evidence file and starts.
    expect((await freshReader.post(`${PERIODS}/${id}/dossier`, { format: 'pdf' })).status).toBe(200);
  });
});
