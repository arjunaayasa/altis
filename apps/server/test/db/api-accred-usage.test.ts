import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeSettings } from '@altis/core';
import { PHASE1_MIGRATIONS, runMigrations, withTx } from '@altis/db';
import { newId } from '@altis/shared';
import type { UsageGridView, UsageGroupsView } from '@altis/shared/api/accreditation';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { createApp } from '../../src/app.js';
import { createAgent, type AgentReply } from '../agent.js';
import { recordingLogger, sampleConfig } from '../support.js';
import { seedStaff, sessionCookieFor, sessionCsrfFor } from '../support-auth.js';

// The monthly usage API on the engine picked by ALTIS_TEST_DB: a reader of the accreditation workspace sees a period's
// grid and the member-type mapping; only a manager writes manual cells (at most 500 at once, refused with 409 once the
// period is frozen) or changes the mapping (which belongs to the whole installation, so a frozen period does not stop
// it). Each write answers a compact body and is stored for a replay.

const ctx = testDbContext();
let h: TestDbHandle;

/** In the past: an audit entry may not be dated ahead of the real clock. */
const NOW = Date.UTC(2026, 10, 3, 9, 0, 5);
const CONFIG = sampleConfig();
const SID = '__Host-altis_sid';
const API = '/api/v1/accreditation';
const PERIODS = `${API}/periods`;
const GROUPS = `${API}/usage-groups`;

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

interface Client {
  send(method: Method, p: string, body?: unknown, key?: string): Promise<AgentReply>;
}

const code = (res: AgentReply): string | undefined => (res.json as { code?: string } | undefined)?.code;
const errors = (res: AgentReply): { path: string; code: string }[] => (res.json as { errors?: { path: string; code: string }[] }).errors ?? [];

describe.skipIf(!ctx.available)(`accreditation monthly usage API [${engineLabel()}]`, () => {
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

  /** An open school-year period 2025/2026 of the test profile's school instrument, seeded straight into the table. */
  async function period(status: 'open' | 'frozen' = 'open'): Promise<string> {
    const id = newId(NOW);
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
        frozen_at: status === 'frozen' ? NOW : null,
        frozen_by: null,
        profile: '{"schoolLevel":"sma_smk_ma"}',
        students: 100,
        teachers: 20,
        edu_staff: 5,
        all_registered_confirmed: 0,
        archived_at: null,
        version: 0,
        created_at: NOW,
        created_by: null,
        updated_at: NOW,
        updated_by: null,
      })
      .execute();
    return id;
  }

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-api-accred-usage-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
    await withTx(h, (trx) => writeSettings(trx, { 'library.type': 'sekolah' }, { keyring: [], now: NOW, actorId: null }));
    app = createApp({ state: { phase: 'ready', db: h, config: CONFIG }, version: '0.1.0', buildId: 'b', log: recordingLogger(), clock: () => NOW });
    reader = await signedIn('baca_penggunaan', ['accreditation.workspace.read']);
    manager = await signedIn('kelola_penggunaan', ['accreditation.workspace.manage', 'accreditation.workspace.read']);
    outsider = await signedIn('baca_katalog', ['catalog.records.read']);
  });

  afterAll(async () => {
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  it('PUT usage writes manual cells, answers {id, version} and is stored for a replay; GET shows them with their source', async () => {
    const id = await period();
    await h.db
      .insertInto('usage_stats')
      .values({ source: 'slims', metric: 'loans', span_from: '2025-08-01', span_to: '2025-08-31', branch_key: '', group_key: '', value: 21, run_id: null, updated_at: NOW, updated_by: null })
      .execute();
    const body = {
      cells: [
        { metric: 'visits', month: '2025-08', groupKey: 'grp:student', value: 45 },
        { metric: 'titles_used', month: null, groupKey: '', value: 300 },
      ],
    };
    const key = `penggunaan-${newId()}`;
    const res = await manager.send('put', `${PERIODS}/${id}/usage`, body, key);
    expect([res.status, res.json]).toEqual([200, { id, version: 0 }]);
    const again = await manager.send('put', `${PERIODS}/${id}/usage`, body, key);
    expect([again.status, again.json]).toEqual([200, res.json]);

    const grid = await reader.send('get', `${PERIODS}/${id}/usage`);
    expect(grid.status, grid.text).toBe(200);
    const view = grid.json as UsageGridView;
    const cell = (metric: string, month: string | null, groupKey: string) => view.cells.find((c) => c.metric === metric && c.month === month && c.groupKey === groupKey);
    expect(cell('visits', '2025-08', 'grp:student')).toMatchObject({ value: 45, source: 'manual' });
    expect(cell('titles_used', null, '')).toMatchObject({ value: 300, source: 'manual', spanTo: '2026-06-30' });
    expect(cell('loans', '2025-08', '')).toMatchObject({ value: 21, source: 'slims' });
    expect(view.months).toHaveLength(12);
  });

  it('PUT usage refusals: a frozen period 409, more than 500 cells 422, a month outside the period 422, an unknown period 404', async () => {
    const frozen = await period('frozen');
    const one = { cells: [{ metric: 'visits', month: '2025-08', groupKey: '', value: 1 }] };
    const res = await manager.send('put', `${PERIODS}/${frozen}/usage`, one);
    expect([res.status, code(res)]).toEqual([409, 'ACCRED_PERIOD_FROZEN']);

    const id = await period();
    const cells = Array.from({ length: 501 }, (_, i) => ({ metric: 'visits', month: '2025-08', groupKey: '', value: i }));
    const many = await manager.send('put', `${PERIODS}/${id}/usage`, { cells });
    expect([many.status, code(many), errors(many)]).toEqual([422, 'VALIDATION_FAILED', [{ path: 'cells', code: 'too_big' }]]);

    const outside = await manager.send('put', `${PERIODS}/${id}/usage`, { cells: [{ metric: 'visits', month: '2026-07', groupKey: '', value: 1 }] });
    expect([outside.status, code(outside), errors(outside)]).toEqual([422, 'VALIDATION_FAILED', [{ path: 'cells.0.month', code: 'out_of_period' }]]);

    const missing = await manager.send('put', `${PERIODS}/${newId()}/usage`, one);
    expect([missing.status, code(missing)]).toEqual([404, 'NOT_FOUND']);
    const missingGrid = await reader.send('get', `${PERIODS}/${newId()}/usage`);
    expect([missingGrid.status, code(missingGrid)]).toEqual([404, 'NOT_FOUND']);
    expect(await h.db.selectFrom('usage_stats').select('metric').where('source', '=', 'manual').where('span_from', '=', '2026-07-01').execute()).toEqual([]);
  });

  it('the member-type mapping: a reader sees it, a manager changes it while a period is frozen, an unknown type 422', async () => {
    await period('frozen');
    await h.db.insertInto('usage_group_map').values({ group_key: 'slims_type:2', label: 'Guru', accred_group: 'teacher', updated_at: NOW, updated_by: null }).execute();
    const res = await manager.send('put', GROUPS, { groups: [{ groupKey: 'slims_type:2', accredGroup: 'public' }, { groupKey: 'member_unknown', accredGroup: 'student' }] });
    expect([res.status, res.json]).toEqual([200, { count: 2 }]);
    const view = await reader.send('get', GROUPS);
    expect(view.status, view.text).toBe(200);
    expect((view.json as UsageGroupsView).groups).toEqual([
      { groupKey: 'slims_type:2', label: 'Guru', accredGroup: 'public', updatedAt: NOW },
      { groupKey: 'member_unknown', label: null, accredGroup: 'student', updatedAt: NOW },
    ]);
    const unknown = await manager.send('put', GROUPS, { groups: [{ groupKey: 'slims_type:77', accredGroup: 'student' }] });
    expect([unknown.status, code(unknown), errors(unknown)]).toEqual([422, 'VALIDATION_FAILED', [{ path: 'groups.0.groupKey', code: 'not_found' }]]);
  });

  it('a reader may not write; a user without the accreditation permissions may not read', async () => {
    const id = await period();
    const put = await reader.send('put', `${PERIODS}/${id}/usage`, { cells: [{ metric: 'visits', month: '2025-08', groupKey: '', value: 1 }] });
    expect([put.status, code(put)]).toEqual([403, 'AUTHZ_DENIED']);
    const groups = await reader.send('put', GROUPS, { groups: [{ groupKey: 'member_unknown', accredGroup: null }] });
    expect([groups.status, code(groups)]).toEqual([403, 'AUTHZ_DENIED']);
    for (const p of [`${PERIODS}/${id}/usage`, GROUPS]) {
      const res = await outsider.send('get', p);
      expect([res.status, code(res)], p).toEqual([403, 'AUTHZ_DENIED']);
    }
  });
});
