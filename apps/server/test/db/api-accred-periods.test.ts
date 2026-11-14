import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeSettings } from '@altis/core';
import { PHASE1_MIGRATIONS, runMigrations, withTx } from '@altis/db';
import { newId } from '@altis/shared';
import type { InstrumentsResponse, PeriodListResponse, PeriodView } from '@altis/shared/api/accreditation';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { createApp } from '../../src/app.js';
import { createAgent, type AgentReply } from '../agent.js';
import { recordingLogger, sampleConfig } from '../support.js';
import { seedStaff, sessionCookieFor, sessionCsrfFor } from '../support-auth.js';

// The instruments, periods and answers API on the engine picked by ALTIS_TEST_DB: a reader of the accreditation
// workspace sees the instruments with the settings the workspace needs and the periods; only a manager creates,
// changes and archives a period or answers an indicator. A frozen period refuses every write of its data with 409, an
// old version 409 CONFLICT_STALE, an instrument that does not fit the library or a span it does not take 422, a branch
// 422 (accreditation is library-wide here). Each write answers the compact `{id, version}` and is stored for a replay.

const ctx = testDbContext();
let h: TestDbHandle;

/** In the past: an audit entry may not be dated ahead of the real clock. */
const NOW = Date.UTC(2026, 10, 3, 9, 0, 5);
const CONFIG = sampleConfig();
const SID = '__Host-altis_sid';
const API = '/api/v1/accreditation';
const PERIODS = `${API}/periods`;

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

interface Client {
  send(method: Method, p: string, body?: unknown, key?: string): Promise<AgentReply>;
}

const code = (res: AgentReply): string | undefined => (res.json as { code?: string } | undefined)?.code;
const errors = (res: AgentReply): { path: string; code: string }[] => (res.json as { errors?: { path: string; code: string }[] }).errors ?? [];

describe.skipIf(!ctx.available)(`accreditation periods API [${engineLabel()}]`, () => {
  let dataDir: string;
  let app: ReturnType<typeof createApp>;
  let reader: Client;
  let manager: Client;
  let outsider: Client;

  async function signedIn(username: string, permissions: string[]): Promise<Client> {
    const user = await seedStaff(h, { username, now: NOW, roles: [{ permissions: permissions as never }] });
    const token = await sessionCookieFor(h, user.id, { now: NOW });
    const agent = createAgent(app);
    agent.setCookie(SID, token);
    const csrf = { 'x-csrf-token': sessionCsrfFor(CONFIG, token) };
    return { send: (method, p, body, key) => agent[method](p, body, key === undefined ? csrf : { ...csrf, 'idempotency-key': key }) };
  }

  async function settings(patch: Record<string, unknown>): Promise<void> {
    await withTx(h, (trx) => writeSettings(trx, patch, { keyring: [], now: NOW, actorId: null }));
  }

  /** A new `test-sch` period of school year `year` through the API; its id. */
  async function schoolPeriod(year = 2025): Promise<string> {
    await settings({ 'library.type': 'sekolah' });
    const res = await manager.send('post', PERIODS, {
      name: `Tahun pelajaran ${year}/${year + 1}`,
      instrumentId: 'test-sch',
      kind: 'school_year',
      startYear: year,
      profile: { schoolLevel: 'sma_smk_ma' },
    });
    expect(res.status, res.text).toBe(201);
    return (res.json as { id: string }).id;
  }

  const view = async (id: string): Promise<PeriodView> => {
    const res = await reader.send('get', `${PERIODS}/${id}`);
    expect(res.status, res.text).toBe(200);
    return res.json as PeriodView;
  };

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-api-accred-periods-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
    await h.db
      .insertInto('branches')
      .values({ id: newId(), code_key: 'PUSAT', code_display: 'PUSAT', name: 'Perpustakaan Pusat', timezone: 'Asia/Jakarta', is_default: 1, created_at: NOW, updated_at: NOW })
      .execute();
    app = createApp({ state: { phase: 'ready', db: h, config: CONFIG }, version: '0.1.0', buildId: 'b', log: recordingLogger(), clock: () => NOW });
    reader = await signedIn('baca_akreditasi', ['accreditation.workspace.read']);
    manager = await signedIn('kelola_akreditasi', ['accreditation.workspace.manage', 'accreditation.workspace.read']);
    outsider = await signedIn('baca_katalog', ['catalog.records.read']);
  });

  afterAll(async () => {
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  it('GET instruments: the four instruments and the test one, labels as keys, and the workspace settings of a school', async () => {
    await settings({ 'library.type': 'sekolah' });
    const res = await reader.send('get', `${API}/instruments`);
    expect(res.status, res.text).toBe(200);
    const body = res.json as InstrumentsResponse;
    expect(body.instruments.map((i) => i.id)).toEqual(['sch-sd-2025', 'sch-smp-2025', 'sch-sma-2025', 'general-stats', 'test-sch']);
    expect(body.config).toMatchObject({ libraryType: 'sekolah', schoolYearStartMonth: 7, unknownMemberGroupDefault: 'student', dedupeMinutes: 60 });
    const general = body.instruments.find((i) => i.id === 'general-stats')!;
    expect(general).toMatchObject({ scored: false, defaultPeriodKind: 'school_year', periodKinds: ['school_year', 'calendar_year', 'rolling_12', 'custom'] });
    const test = body.instruments.find((i) => i.id === 'test-sch')!;
    expect(test).toMatchObject({ scored: true, libraryTypes: ['sekolah'], schoolLevels: ['sma_smk_ma'], periodKinds: ['school_year', 'rolling_12'] });
    expect(test.components.map((c) => [c.code, c.weight, c.indicators.map((i) => i.code)])).toEqual([
      ['K', 60, ['SCH-K1', 'SCH-K2', 'SCH-K3']],
      ['SP', 40, ['SCH-SP1']],
    ]);
    const [k1] = test.components[0]!.indicators;
    expect(k1).toMatchObject({ officialNo: 'K1', labelKey: 'accred.ik.K1', manual: false, window: 'snapshot', optionKeys: null });
    expect(k1!.evidence[0]).toEqual({
      code: 'title_list',
      labelKey: 'accred.evidence.K1.title_list',
      kind: 'generated',
      primary: true,
      reportId: 'collection.title_list',
      screen: null,
    });
    expect(test.components[1]!.indicators[0]).toMatchObject({ code: 'SCH-SP1', manual: true, optionKeys: ['accred.ik.SP1.option.a', 'accred.ik.SP1.option.b', 'accred.ik.SP1.option.c', 'accred.ik.SP1.option.d'] });

    await settings({ 'library.type': 'umum' });
    const other = (await reader.send('get', `${API}/instruments`)).json as InstrumentsResponse;
    expect(other.config.unknownMemberGroupDefault).toBeNull();
    expect(other.instruments.find((i) => i.id === 'general-stats')!.defaultPeriodKind).toBe('calendar_year');
  });

  it('a user without the accreditation permissions → 403 on reading and writing', async () => {
    for (const [method, p] of [
      ['get', `${API}/instruments`],
      ['get', PERIODS],
      ['post', PERIODS],
    ] as const) {
      const res = await outsider.send(method, p, method === 'post' ? { name: 'x', instrumentId: 'general-stats', kind: 'calendar_year', startYear: 2025 } : undefined);
      expect([res.status, code(res)], `${method} ${p}`).toEqual([403, 'AUTHZ_DENIED']);
    }
  });

  it('a reader may not create, change, archive or answer', async () => {
    const id = await schoolPeriod();
    const calls: [Method, string, unknown][] = [
      ['post', PERIODS, { name: 'x', instrumentId: 'general-stats', kind: 'calendar_year', startYear: 2025 }],
      ['patch', `${PERIODS}/${id}`, { version: 0, students: 1 }],
      ['delete', `${PERIODS}/${id}`, undefined],
      ['put', `${PERIODS}/${id}/answers/SCH-SP1`, { answer: 'b', mode: 'manual', note: null }],
    ];
    for (const [method, p, body] of calls) {
      const res = await reader.send(method, p, body);
      expect([res.status, code(res)], `${method} ${p}`).toEqual([403, 'AUTHZ_DENIED']);
    }
  });

  it('create → 201 {id, version 0}, stored for a replay; GET and the list show it', async () => {
    await settings({ 'library.type': 'umum' });
    const body = { name: 'Statistik 2025', instrumentId: 'general-stats', kind: 'custom', startsOn: '2025-01-01', endsOn: '2026-06-30' };
    const key = `periode-${newId()}`;
    const res = await manager.send('post', PERIODS, body, key);
    expect(res.status, res.text).toBe(201);
    const { id } = res.json as { id: string };
    expect(res.json).toEqual({ id, version: 0 });
    const again = await manager.send('post', PERIODS, body, key);
    expect([again.status, again.json]).toEqual([201, res.json]);
    expect(await h.db.selectFrom('accred_periods').select('id').where('name', '=', 'Statistik 2025').execute()).toEqual([{ id }]);

    expect(await view(id)).toMatchObject({
      id,
      name: 'Statistik 2025',
      instrumentId: 'general-stats',
      kind: 'custom',
      startsOn: '2025-01-01',
      endsOn: '2026-06-30',
      branchId: null,
      status: 'open',
      version: 0,
      computedAt: null,
      stale: true,
      catalogSyncedAt: null,
      lastUsageImport: null,
    });
    const list = (await reader.send('get', PERIODS)).json as PeriodListResponse;
    expect(list.periods.find((p) => p.id === id)).toEqual({
      id,
      name: 'Statistik 2025',
      instrumentId: 'general-stats',
      kind: 'custom',
      startsOn: '2025-01-01',
      endsOn: '2026-06-30',
      status: 'open',
      computedAt: null,
      stale: true,
    });
  });

  it('create refusals: an instrument for another library, a kind it does not take, a branch, an unknown period', async () => {
    await settings({ 'library.type': 'umum' });
    const sma = await manager.send('post', PERIODS, { name: 'SMA', instrumentId: 'sch-sma-2025', kind: 'school_year', startYear: 2025 });
    expect([sma.status, code(sma)]).toEqual([422, 'ACCRED_INSTRUMENT_MISMATCH']);

    await settings({ 'library.type': 'sekolah' });
    const sd = await manager.send('post', PERIODS, { name: 'SD', instrumentId: 'sch-sd-2025', kind: 'calendar_year', startYear: 2025, profile: { schoolLevel: 'sd_mi' } });
    expect([sd.status, code(sd)]).toEqual([422, 'ACCRED_PERIOD_SPAN']);

    const branch = await manager.send('post', PERIODS, { name: 'Cabang', instrumentId: 'general-stats', kind: 'calendar_year', startYear: 2025, branchId: newId() });
    expect([branch.status, code(branch), errors(branch)]).toEqual([422, 'VALIDATION_FAILED', [{ path: 'branchId', code: 'branch_scope_not_available' }]]);

    const missing = await manager.send('get', `${PERIODS}/${newId()}`);
    expect([missing.status, code(missing)]).toEqual([404, 'NOT_FOUND']);
  });

  it('PATCH changes a period; an old version → 409 CONFLICT_STALE', async () => {
    const id = await schoolPeriod();
    const res = await manager.send('patch', `${PERIODS}/${id}`, { version: 0, students: 410, teachers: 32, profile: { npp: '3201010D1000003' } });
    expect([res.status, res.json]).toEqual([200, { id, version: 1 }]);
    expect(await view(id)).toMatchObject({ students: 410, teachers: 32, version: 1, profile: { schoolLevel: 'sma_smk_ma', npp: '3201010D1000003' } });
    const stale = await manager.send('patch', `${PERIODS}/${id}`, { version: 0, students: 1 });
    expect([stale.status, code(stale)]).toEqual([409, 'CONFLICT_STALE']);
  });

  it('answers: an override needs a note, the code must be one of the instrument, a manual answer is stored and removed', async () => {
    const id = await schoolPeriod();
    const put = (c: string, body: unknown) => manager.send('put', `${PERIODS}/${id}/answers/${c}`, body);
    const override = await put('SCH-K1', { answer: 'b', mode: 'override', note: null });
    expect([override.status, code(override), errors(override)]).toEqual([422, 'VALIDATION_FAILED', [{ path: 'note', code: 'required' }]]);
    const outside = await put('SCH-L7', { answer: 'b', mode: 'manual', note: null });
    expect([outside.status, code(outside), errors(outside)]).toEqual([422, 'VALIDATION_FAILED', [{ path: 'code', code: 'invalid' }]]);

    const stored = await put('SCH-SP1', { answer: 'b', mode: 'manual', note: null });
    expect([stored.status, stored.json]).toEqual([200, { id, version: 0 }]);
    const rows = () => h.db.selectFrom('accred_answers').select(['indicator_code', 'answer', 'mode']).where('period_id', '=', id).execute();
    expect(await rows()).toEqual([{ indicator_code: 'SCH-SP1', answer: 'b', mode: 'manual' }]);
    const removed = await put('SCH-SP1', { answer: null, mode: 'manual', note: null });
    expect(removed.status, removed.text).toBe(200);
    expect(await rows()).toEqual([]);
  });

  it('a frozen period: PATCH, DELETE and an answer → 409 ACCRED_PERIOD_FROZEN', async () => {
    const id = await schoolPeriod();
    await h.db.updateTable('accred_periods').set({ status: 'frozen', frozen_at: NOW }).where('id', '=', id).execute();
    const calls: [Method, string, unknown][] = [
      ['patch', `${PERIODS}/${id}`, { version: 0, students: 1 }],
      ['delete', `${PERIODS}/${id}`, undefined],
      ['put', `${PERIODS}/${id}/answers/SCH-SP1`, { answer: 'b', mode: 'manual', note: null }],
    ];
    for (const [method, p, body] of calls) {
      const res = await manager.send(method, p, body);
      expect([res.status, code(res)], `${method} ${p}`).toEqual([409, 'ACCRED_PERIOD_FROZEN']);
    }
    expect(await view(id)).toMatchObject({ status: 'frozen', version: 0 });
  });

  it('DELETE archives the period: 200 {id, version}, then 404 and gone from the list', async () => {
    const id = await schoolPeriod(2027);
    const res = await manager.send('delete', `${PERIODS}/${id}`);
    expect([res.status, res.json]).toEqual([200, { id, version: 1 }]);
    const gone = await reader.send('get', `${PERIODS}/${id}`);
    expect([gone.status, code(gone)]).toEqual([404, 'NOT_FOUND']);
    const list = (await reader.send('get', PERIODS)).json as PeriodListResponse;
    expect(list.periods.map((p) => p.id)).not.toContain(id);
  });
});
