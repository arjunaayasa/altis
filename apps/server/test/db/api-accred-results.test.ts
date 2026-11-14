import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { localStorageDriver } from '@altis/core';
import { PHASE1_MIGRATIONS, runMigrations } from '@altis/db';
import { reportExportPath } from '@altis/platform';
import { newId } from '@altis/shared';
import type { ResultsView, SnapshotListResponse, SnapshotView } from '@altis/shared/api/accreditation';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { createApp } from '../../src/app.js';
import { createAgent, type AgentReply } from '../agent.js';
import { recordingLogger, sampleConfig } from '../support.js';
import { seedStaff, sessionCookieFor, sessionCsrfFor } from '../support-auth.js';

// The results, evaluation, freeze and snapshot routes on the engine picked by ALTIS_TEST_DB:
// - a reader of the accreditation workspace reads the results and queues an evaluation (one live evaluation per
//   period, joined); a user without the permission gets 403;
// - a manager freezes fresh results (a stale or a frozen period answers 409), and unfreezes a frozen period only after
//   a fresh re-authentication (an open one answers 409);
// - the newest whole evidence file PDF finished after the results were computed is copied for the snapshot; the copy is
//   never served by `/files/:id`, only through the snapshot after a fresh re-authentication, audited once before the
//   first byte, Range included;
// - an accreditation evidence file is served by `/files/:id` to a reader of the workspace only.

const ctx = testDbContext();
let h: TestDbHandle;

/** In the past: an audit entry may not be dated ahead of the real clock. */
const NOW = Date.UTC(2026, 10, 12, 9, 0, 5);
const MIN = 60_000;
const CONFIG = sampleConfig();
const SID = '__Host-altis_sid';
const API = '/api/v1/accreditation';
const PERIODS = `${API}/periods`;
const PDF = '%PDF-1.4 berkas bukti lengkap untuk asesor';

interface Client {
  userId: string;
  get(p: string, headers?: Record<string, string>): Promise<AgentReply>;
  post(p: string, body?: unknown): Promise<AgentReply>;
}

const code = (res: AgentReply): string | undefined => (res.json as { code?: string } | undefined)?.code;

describe.skipIf(!ctx.available)(`accreditation results, freeze and snapshots API [${engineLabel()}]`, () => {
  let dataDir: string;
  let app: ReturnType<typeof createApp>;
  let reader: Client;
  let freshReader: Client;
  let manager: Client;
  let freshManager: Client;
  let outsider: Client;

  async function signedIn(username: string, permissions: string[], reauthAt: number | null): Promise<Client> {
    const user = await seedStaff(h, { username, now: NOW, roles: [{ permissions: permissions as never }] });
    const token = await sessionCookieFor(h, user.id, { now: NOW, reauthAt });
    const agent = createAgent(app, { headers: { origin: CONFIG.baseUrl } });
    agent.setCookie(SID, token);
    const csrf = { 'x-csrf-token': sessionCsrfFor(CONFIG, token) };
    return { userId: user.id, get: (p, headers) => agent.get(p, undefined, headers), post: (p, body) => agent.post(p, body ?? {}, csrf) };
  }

  /** An open period of the test instrument written an hour before NOW; its id. */
  async function period(status: 'open' | 'frozen' = 'open'): Promise<string> {
    const at = NOW - 60 * MIN;
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
        status,
        frozen_at: status === 'frozen' ? at : null,
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

  /** The results of `periodId` as an evaluation that started at `computedAt` leaves them (the prerequisites met). */
  async function computed(periodId: string, computedAt: number): Promise<void> {
    const prerequisites = { titles: { pass: true, count: 1600, asOf: '2026-06-30' }, npp: { pass: true }, foundingDecree: { pass: true }, met: true };
    const rows: [string, unknown][] = [
      ['_meta', { status: 'ready', startedAt: computedAt, jobId: newId(computedAt), computedAt, durationMs: 40, prerequisites }],
      ['SCH-PRASYARAT', { kind: 'prerequisites', prerequisites, titles: { value: 1600, unit: 'count', basis: 'live', notes: [] } }],
      ['SCH-K1', { kind: 'indicator', metric: 'collection.titles', value: { value: 1600, unit: 'count', basis: 'live', notes: [] }, size: null, suggestion: 'a', notes: [] }],
    ];
    for (const [code, payload] of rows) {
      await h.db.insertInto('accred_results').values({ period_id: periodId, indicator_code: code, payload: JSON.stringify(payload), computed_at: computedAt }).execute();
    }
  }

  /** A finished evidence file run of `periodId` (`part` absent: the whole dossier), its PDF `content`; its id. */
  async function dossierRun(periodId: string, o: { finishedAt: number; content: string; part?: 'request_letter' }): Promise<string> {
    const id = newId(o.finishedAt);
    await h.db
      .insertInto('report_runs')
      .values({
        id,
        report_id: 'accreditation.dossier',
        format: 'pdf',
        locale: 'id',
        params: JSON.stringify({ def: { periodId, part: o.part ?? 'all', zipMode: 'combined' } }),
        personal: 1,
        status: 'succeeded',
        row_count: 0,
        non_latin_rows: 0,
        output_name: `${id}.pdf`,
        output_size: Buffer.byteLength(o.content),
        error_code: null,
        job_id: null,
        expires_at: NOW + 7 * 24 * 60 * MIN,
        created_at: o.finishedAt - MIN,
        created_by: null,
        finished_at: o.finishedAt,
      })
      .execute();
    const file = reportExportPath(dataDir, id, 'pdf');
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, o.content);
    return id;
  }

  const entries = async (action: string, entityId: string) =>
    (
      await h.db.selectFrom('audit_log').select(['actor_id', 'entity', 'meta']).where('action', '=', action as never).where('entity_id', '=', entityId).orderBy('seq').execute()
    ).map((r) => ({ actor: r.actor_id, entity: r.entity, meta: JSON.parse(r.meta ?? 'null') as unknown }));

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-api-accred-results-')));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(dataDir, 'migrations'), migrations: PHASE1_MIGRATIONS });
    app = createApp({ state: { phase: 'ready', db: h, config: CONFIG }, version: '0.1.0', buildId: 'b', log: recordingLogger(), clock: () => NOW, dataDir });
    reader = await signedIn('baca_akreditasi', ['accreditation.workspace.read'], null);
    freshReader = await signedIn('baca_akreditasi_segar', ['accreditation.workspace.read'], NOW);
    manager = await signedIn('kelola_akreditasi', ['accreditation.workspace.manage', 'accreditation.workspace.read'], null);
    freshManager = await signedIn('kelola_akreditasi_segar', ['accreditation.workspace.manage', 'accreditation.workspace.read'], NOW);
    outsider = await signedIn('baca_katalog', ['catalog.records.read'], NOW);
  });

  afterAll(async () => {
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  it('a reader reads the results and queues one evaluation per period; others get 403, an unknown period 404', async () => {
    const id = await period();
    const empty = await reader.get(`${PERIODS}/${id}/results`);
    expect(empty.status, empty.text).toBe(200);
    expect(empty.json).toMatchObject({ status: 'missing', computedAt: null, stale: true, jobId: null, prerequisites: null, score: { answered: 0, total: 4 } });
    expect((empty.json as ResultsView).indicators.map((i) => i.code)).toEqual(['SCH-K1', 'SCH-K2', 'SCH-K3', 'SCH-SP1']);

    const first = await reader.post(`${PERIODS}/${id}/evaluate`);
    expect(first.status, first.text).toBe(202);
    const { jobId } = first.json as { jobId: string };
    expect(first.json).toEqual({ jobId, existing: false });
    const again = await manager.post(`${PERIODS}/${id}/evaluate`);
    expect([again.status, again.json]).toEqual([202, { jobId, existing: true }]);
    expect((await reader.get(`${PERIODS}/${id}/results`)).json).toMatchObject({ status: 'queued', jobId });

    expect([(await outsider.get(`${PERIODS}/${id}/results`)).status, (await outsider.post(`${PERIODS}/${id}/evaluate`)).status]).toEqual([403, 403]);
    const unknown = newId();
    expect([(await reader.get(`${PERIODS}/${unknown}/results`)).status, (await reader.post(`${PERIODS}/${unknown}/evaluate`)).status]).toEqual([404, 404]);
  });

  it('a manager freezes fresh results; stale results, a frozen period and a reader are refused', async () => {
    const id = await period();
    const stale = await manager.post(`${PERIODS}/${id}/freeze`, {});
    expect([stale.status, code(stale)]).toEqual([409, 'ACCRED_RESULTS_STALE']);

    await computed(id, NOW - 30 * MIN);
    expect((await reader.get(`${PERIODS}/${id}/results`)).json).toMatchObject({ status: 'ready', stale: false, computedAt: NOW - 30 * MIN, prerequisites: { met: true } });
    expect((await reader.post(`${PERIODS}/${id}/freeze`, {})).status).toBe(403);
    const frozen = await manager.post(`${PERIODS}/${id}/freeze`, { note: 'Diserahkan' });
    expect(frozen.status, frozen.text).toBe(201);
    const snapshotId = (frozen.json as { id: string }).id;
    expect(frozen.json).toEqual({ id: snapshotId, version: 1 });
    expect(await entries('accreditation.period.freeze', id)).toEqual([{ actor: manager.userId, entity: 'accred_periods', meta: { snapshotId, hasNote: true } }]);

    const list = await reader.get(`${PERIODS}/${id}/snapshots`);
    expect(list.status, list.text).toBe(200);
    expect((list.json as SnapshotListResponse).snapshots).toEqual([
      expect.objectContaining({ id: snapshotId, periodId: id, instrumentId: 'test-sch', na: null, prerequisitesMet: true, dossierFileId: null, note: 'Diserahkan', createdBy: manager.userId }),
    ]);
    const one = await reader.get(`${API}/snapshots/${snapshotId}`);
    expect(one.status, one.text).toBe(200);
    expect((one.json as SnapshotView).values.i['SCH-K1']).toEqual({ v: 1600, n: null, d: null, a: 'a', m: 'computed', b: 'live', k: [] });
    expect((await reader.get(`${API}/snapshots/${newId()}`)).status).toBe(404);

    const twice = await manager.post(`${PERIODS}/${id}/freeze`, {});
    expect([twice.status, code(twice)]).toEqual([409, 'ACCRED_PERIOD_FROZEN']);
  });

  it('the snapshot keeps the whole evidence file; /files never serves it; the snapshot serves it after a re-authentication', async () => {
    const id = await period();
    const computedAt = NOW - 30 * MIN;
    await computed(id, computedAt);
    await dossierRun(id, { finishedAt: computedAt - MIN, content: '%PDF-1.4 sebelum perhitungan' });
    await dossierRun(id, { finishedAt: computedAt + 5 * MIN, content: PDF });
    await dossierRun(id, { finishedAt: computedAt + 10 * MIN, content: '%PDF-1.4 surat permohonan', part: 'request_letter' });
    const frozen = await manager.post(`${PERIODS}/${id}/freeze`, {});
    expect(frozen.status, frozen.text).toBe(201);
    const snapshotId = (frozen.json as { id: string }).id;

    const snapshot = (await reader.get(`${API}/snapshots/${snapshotId}`)).json as SnapshotView;
    expect(snapshot.dossierFileId).not.toBeNull();
    const file = await h.db.selectFrom('files').selectAll().where('id', '=', snapshot.dossierFileId!).executeTakeFirstOrThrow();
    expect(file).toMatchObject({ context: 'accreditation.dossier', owner_type: 'accred_snapshots', owner_id: snapshotId, size: Buffer.byteLength(PDF), sha256: createHash('sha256').update(PDF).digest('hex') });

    // Never through /files/:id, a fresh reader included.
    expect((await freshReader.get(`/files/${file.id}`)).status).toBe(404);
    expect((await freshManager.get(`/files/${file.id}`)).status).toBe(404);

    const url = `${API}/snapshots/${snapshotId}/dossier`;
    const stale = await reader.get(url);
    expect([stale.status, code(stale)]).toEqual([401, 'AUTH_REAUTH_REQUIRED']);
    expect(await entries('reports.run.download', snapshotId)).toEqual([]);
    const res = await freshReader.get(url);
    expect(res.status, res.text).toBe(200);
    expect(res.text).toBe(PDF);
    expect(res.headers.get('content-type')).toContain('application/pdf');
    expect(res.headers.get('content-disposition')).toContain('attachment');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(await entries('reports.run.download', snapshotId)).toEqual([{ actor: freshReader.userId, entity: 'accred_snapshots', meta: { snapshotId } }]);
    const part = await freshReader.get(url, { range: 'bytes=0-7' });
    expect([part.status, part.text, part.headers.get('content-range')]).toEqual([206, '%PDF-1.4', `bytes 0-7/${Buffer.byteLength(PDF)}`]);
    expect(await entries('reports.run.download', snapshotId)).toHaveLength(2);
    expect((await outsider.get(url)).status).toBe(403);

    // A snapshot without a copy has nothing to download.
    const other = await period();
    await computed(other, computedAt);
    const bare = (await manager.post(`${PERIODS}/${other}/freeze`, {})).json as { id: string };
    expect((await freshReader.get(`${API}/snapshots/${bare.id}/dossier`)).status).toBe(404);
  });

  it('unfreeze needs a fresh re-authentication; an open period cannot be unfrozen', async () => {
    const id = await period();
    await computed(id, NOW - 30 * MIN);
    expect((await manager.post(`${PERIODS}/${id}/freeze`, {})).status).toBe(201);
    const stale = await manager.post(`${PERIODS}/${id}/unfreeze`, {});
    expect([stale.status, code(stale)]).toEqual([401, 'AUTH_REAUTH_REQUIRED']);
    const opened = await freshManager.post(`${PERIODS}/${id}/unfreeze`, {});
    expect([opened.status, opened.json]).toEqual([200, { id, version: 2 }]);
    expect(await entries('accreditation.period.unfreeze', id)).toEqual([{ actor: freshManager.userId, entity: 'accred_periods', meta: {} }]);
    const again = await freshManager.post(`${PERIODS}/${id}/unfreeze`, {});
    expect([again.status, code(again)]).toEqual([409, 'CONFLICT_STALE']);
    expect((await reader.get(`${PERIODS}/${id}/snapshots`)).json).toMatchObject({ snapshots: [expect.objectContaining({ periodId: id })] });
  });

  it('an accreditation evidence file is served to a reader of the workspace and not found for other staff', async () => {
    const content = new TextEncoder().encode('%PDF-1.4 kebijakan pengembangan koleksi');
    const id = newId();
    await localStorageDriver(dataDir).put(id, content, { size: content.byteLength, sha256: createHash('sha256').update(content).digest('hex') });
    await h.db
      .insertInto('files')
      .values({ id, original_name: 'kebijakan.pdf', mime: 'application/pdf', size: content.byteLength, sha256: createHash('sha256').update(content).digest('hex'), context: 'accreditation.evidence', owner_type: 'accred_evidence', owner_id: newId(), access: 'staff', status: 'ok', created_at: NOW, created_by: null })
      .execute();
    const ok = await reader.get(`/files/${id}`);
    expect([ok.status, ok.text]).toEqual([200, '%PDF-1.4 kebijakan pengembangan koleksi']);
    const hidden = await outsider.get(`/files/${id}`);
    expect([hidden.status, code(hidden)]).toEqual([404, 'NOT_FOUND']);
  });
});
