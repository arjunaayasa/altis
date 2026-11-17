import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations } from '@altis/db';
import { newId, type Permission } from '@altis/shared';
import type { DeskItemGlance, LoanClassesResponse, LoanListResponse } from '@altis/shared/api/circulation';
import type { MemberClassesResponse, MemberSearchResponse } from '@altis/shared/api/members';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { masterId, seedCopy, seedLoan, seedMember } from '../../../../packages/core/test/support/circulation-seed.js';
import { createApp } from '../../src/app.js';
import { createAgent, type AgentReply } from '../agent.js';
import { recordingLogger, sampleConfig } from '../support.js';
import { seedStaff, sessionCookieFor, sessionCsrfFor } from '../support-auth.js';

// The data the staff screens show beside their lists, through the HTTP API on the engine picked by ALTIS_TEST_DB: the
// overdue search carries a member's phone only for a caller who also reads member records, its class list, the member
// list's loan counts and class list, and the desk's look at a scanned item (no member in it; the desk branch only).

const ctx = testDbContext();

/** In the past: an audit entry may not be dated ahead of the real clock. */
const NOW = Date.UTC(2026, 8, 2, 3, 0, 0);
const CONFIG = sampleConfig();
const SID = '__Host-altis_sid';

interface Client {
  get(p: string): Promise<AgentReply>;
  post(p: string, body: unknown): Promise<AgentReply>;
}

describe.skipIf(!ctx.available)(`the staff screens' data through the API [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let dataDir: string;
  let app: ReturnType<typeof createApp>;
  let branchId: string;
  let otherBranchId: string;

  async function signedIn(username: string, roles: { permissions: Permission[]; branchId?: string }[]): Promise<Client> {
    const user = await seedStaff(h, { username, now: NOW, roles });
    const token = await sessionCookieFor(h, user.id, { now: NOW });
    const agent = createAgent(app, { headers: { origin: CONFIG.baseUrl } });
    agent.setCookie(SID, token);
    const csrf = { 'x-csrf-token': sessionCsrfFor(CONFIG, token) };
    return { get: (p) => agent.get(p), post: (p, body) => agent.post(p, body, csrf) };
  }

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-api-staff-data-')));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(dataDir, 'migrations'), migrations: PHASE1_MIGRATIONS });
    app = createApp({ state: { phase: 'ready', db: h, config: CONFIG }, version: '0.1.0', buildId: 'b', log: recordingLogger(), clock: () => NOW, dataDir });
    const branch = async (code: string): Promise<string> => {
      const id = newId();
      await h.db.insertInto('branches').values({ id, code_key: code, code_display: code, name: `Cabang ${code}`, timezone: 'Asia/Jakarta', created_at: NOW, updated_at: NOW }).execute();
      return id;
    };
    branchId = await branch('UT');
    otherBranchId = await branch('CB');
    const ana = await seedMember(h.db, { no: 'S-001', name: 'Ana Lestari', className: 'X-1', phone: '0811-111' });
    const copy = await seedCopy(h.db, { branchId, title: 'Laskar Pelangi', barcode: 'B-0001' });
    await seedLoan(h.db, { ...copy, memberId: ana, branchId, loanedOn: '2026-08-01', dueOn: '2026-08-20', memberTypeId: await masterId(h.db, 'member_types', 'SISWA') });
  });

  afterAll(async () => {
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  it("the overdue search: the member's phone only for a caller who also reads member records", async () => {
    const loansOnly = await signedIn('sirkulasi', [{ permissions: ['circulation.records.read'] }]);
    const plain = await loansOnly.post('/api/v1/circulation/loans/search', { tab: 'overdue', q: 'ana' });
    expect(plain.status).toBe(200);
    const plainBody = plain.json as LoanListResponse;
    expect(plainBody.items.map((i) => i.item?.barcode)).toEqual(['B-0001']);
    expect(plainBody.items[0]!.member).not.toHaveProperty('phone');
    const both = await signedIn('wali_kelas', [{ permissions: ['circulation.records.read', 'members.records.read'] }]);
    const phoned = (await both.post('/api/v1/circulation/loans/search', { tab: 'overdue', className: 'X-1' })).json as LoanListResponse;
    expect(phoned.items[0]!.member?.phone).toBe('0811-111');
    expect(((await loansOnly.get('/api/v1/circulation/loans/classes')).json as LoanClassesResponse).items).toEqual(['X-1']);
    // A member reader without the loan records: not the loan search.
    const membersOnly = await signedIn('anggota', [{ permissions: ['members.records.read'] }]);
    expect((await membersOnly.post('/api/v1/circulation/loans/search', { tab: 'due_soon' })).status).toBe(403);
    expect((await loansOnly.post('/api/v1/circulation/loans/search', { tab: 'later' })).status).toBe(422);
  });

  it('the member list: open and overdue loans per member, and the class list', async () => {
    const reader = await signedIn('pembaca', [{ permissions: ['members.records.read'] }]);
    const list = (await reader.post('/api/v1/members/search', {})).json as MemberSearchResponse;
    expect(list.items.map((m) => [m.memberNo, m.openLoans, m.overdueLoans])).toEqual([['S-001', 1, 1]]);
    expect(((await reader.get('/api/v1/members/classes')).json as MemberClassesResponse).items).toEqual(['X-1']);
    const loansOnly = await signedIn('sirkulasi_2', [{ permissions: ['circulation.records.read'] }]);
    expect((await loansOnly.get('/api/v1/members/classes')).status).toBe(403);
  });

  it("the desk's look at a scanned item: no member in it, at the desk's own branch only", async () => {
    const desk = await signedIn('meja', [{ permissions: ['circulation.desk.use'], branchId }]);
    const res = await desk.post(`/api/v1/branches/${branchId}/circulation/items/glance`, { barcode: 'b-0001' });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ barcode: 'B-0001', title: 'Laskar Pelangi', status: 'available', branchCode: 'UT', dueOn: '2026-08-20', onHoldShelf: false } satisfies DeskItemGlance);
    expect((await desk.post(`/api/v1/branches/${branchId}/circulation/items/glance`, { barcode: 'B-9999' })).status).toBe(404);
    expect((await desk.post(`/api/v1/branches/${otherBranchId}/circulation/items/glance`, { barcode: 'B-0001' })).status).toBe(403);
  });
});
