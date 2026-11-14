import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { recordUrlPath } from '@altis/core';
import { PHASE1_MIGRATIONS, runMigrations } from '@altis/db';
import { newId } from '@altis/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { createApp } from '../../src/app.js';
import { createAgent, type AgentReply } from '../agent.js';
import { recordingLogger, sampleConfig } from '../support.js';
import { seedStaff, sessionCookieFor, sessionCsrfFor } from '../support-auth.js';

// Members and the circulation desk through the HTTP API, on the engine picked by ALTIS_TEST_DB: a member is created and
// found by a POST search, an item is lent at the desk (a second loan of it answers 409 with the `reason` the desk shows),
// the OPAC detail shows the item on loan with its due date and no borrower, the loan list holds it, and the return
// makes the item available again.

const ctx = testDbContext();

/** In the past: an audit entry may not be dated ahead of the real clock. */
const NOW = Date.UTC(2026, 9, 22, 2, 0, 0);
const CONFIG = sampleConfig();
const SID = '__Host-altis_sid';

interface Client {
  get(p: string): Promise<AgentReply>;
  send(method: 'post' | 'patch' | 'delete', p: string, body?: unknown): Promise<AgentReply>;
}

describe.skipIf(!ctx.available)(`members and circulation API [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let dataDir: string;
  let app: ReturnType<typeof createApp>;
  let desk: Client;
  let branchId: string;
  let recordId: string;
  const title = 'Bumi Manusia';
  const barcode = 'B-0001';

  async function signedIn(username: string, permissions: string[]): Promise<Client> {
    const user = await seedStaff(h, { username, now: NOW, roles: [{ permissions: permissions as never }] });
    const token = await sessionCookieFor(h, user.id, { now: NOW });
    const agent = createAgent(app, { headers: { origin: CONFIG.baseUrl } });
    agent.setCookie(SID, token);
    const csrf = { 'x-csrf-token': sessionCsrfFor(CONFIG, token) };
    return {
      get: (p) => agent.get(p),
      send: (method, p, body) => (method === 'post' ? agent.post(p, body ?? {}, csrf) : method === 'patch' ? agent.patch(p, body ?? {}, csrf) : agent.delete(p, body ?? {}, csrf)),
    };
  }

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-api-circ-')));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(dataDir, 'migrations'), migrations: PHASE1_MIGRATIONS });
    const buku = (await h.db.selectFrom('material_types').select('id').where('code_key', '=', 'BUKU').executeTakeFirstOrThrow()).id;
    const umum = (await h.db.selectFrom('collection_types').select('id').where('code_key', '=', 'UMUM').executeTakeFirstOrThrow()).id;
    branchId = newId();
    await h.db
      .insertInto('branches')
      .values({ id: branchId, code_key: 'PUSAT', code_display: 'Pusat', name: 'Perpustakaan Pusat', address: null, timezone: 'Asia/Jakarta', created_at: NOW, created_by: null, updated_at: NOW, updated_by: null })
      .execute();
    recordId = newId();
    const trail = { created_at: NOW, created_by: null, updated_at: NOW, updated_by: null };
    await h.db
      .insertInto('records')
      .values({
        id: recordId,
        material_type_id: buku,
        title,
        subtitle: null,
        responsibility: null,
        title_key: 'bumi manusia',
        edition: null,
        material_detail: null,
        publisher_id: null,
        publication_place: null,
        publication_year: null,
        publication_date_text: null,
        physical_desc: null,
        series: null,
        classification: null,
        call_number: null,
        language_id: null,
        content_type: null,
        media_type: null,
        carrier_type: null,
        summary: null,
        notes: null,
        cover_file_id: null,
        source: 'manual',
        merged_into: null,
        changed_at: NOW,
        archived_at: null,
        ...trail,
      })
      .execute();
    await h.db
      .insertInto('items')
      .values({
        id: newId(),
        record_id: recordId,
        branch_id: branchId,
        barcode_display: barcode,
        barcode_key: barcode,
        inventory_no: null,
        call_number: null,
        location_id: null,
        collection_type_id: umum,
        status: 'available',
        status_note: null,
        acq_source: null,
        order_no: null,
        order_date: null,
        received_date: null,
        invoice_date: null,
        supplier_id: null,
        invoice_no: null,
        price: null,
        currency: null,
        note: null,
        archived_at: null,
        ...trail,
      })
      .execute();
    app = createApp({ state: { phase: 'ready', db: h, config: CONFIG }, version: '0.1.0', buildId: 'b', log: recordingLogger(), clock: () => NOW, dataDir });
    desk = await signedIn('petugas_layanan', ['circulation.desk.use', 'circulation.records.read', 'members.records.read', 'members.records.manage']);
  });

  afterAll(async () => {
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  it('create, find, lend (a second loan is 409 with its reason), the OPAC shows it on loan, the list holds it, return', async () => {
    const siswa = (await h.db.selectFrom('member_types').select('id').where('code_key', '=', 'SISWA').executeTakeFirstOrThrow()).id;
    const made = await desk.send('post', '/api/v1/members', { memberNo: 'sis 042', memberTypeId: siswa, name: 'Minke Pribumi', className: '9A' });
    expect(made.status, made.text).toBe(201);
    const memberId = (made.json as { id: string }).id;
    const other = (await desk.send('post', '/api/v1/members', { memberNo: 'SIS-043', memberTypeId: siswa, name: 'Annelies' })).json as { id: string };
    const taken = await desk.send('post', '/api/v1/members', { memberNo: ' SIS  042', memberTypeId: siswa, name: 'Kembar' });
    expect([taken.status, (taken.json as { errors: unknown }).errors]).toEqual([422, [{ path: 'memberNo', code: 'taken' }]]);

    const found = await desk.send('post', '/api/v1/members/search', { q: 'minke' });
    expect((found.json as { items: { id: string; memberNo: string }[] }).items.map((m) => [m.id, m.memberNo])).toEqual([[memberId, 'SIS 042']]);
    const panel = await desk.send('post', `/api/v1/branches/${branchId}/circulation/members/lookup`, { no: 'sis 042' });
    expect(panel.json).toMatchObject({ id: memberId, canBorrow: true, loans: [] });

    const desk1 = `/api/v1/branches/${branchId}/circulation`;
    const lent = await desk.send('post', `${desk1}/loans`, { memberId, barcode: 'b-0001' });
    expect(lent.status, lent.text).toBe(201);
    expect(lent.json).toMatchObject({ dueOn: '2026-10-29', item: { barcode }, record: { id: recordId, title } });
    const again = await desk.send('post', `${desk1}/loans`, { memberId: other.id, barcode });
    expect([again.status, (again.json as { code: string; reason?: string }).code, (again.json as { reason?: string }).reason]).toEqual([409, 'CIRC_ITEM_ON_LOAN', 'other_member']);

    const page = await desk.get(recordUrlPath(recordId, title));
    expect(page.status).toBe(200);
    expect(page.text).toContain('Dipinjam, kembali 29 Oktober 2026');
    expect(page.text).toContain('1 eksemplar, 0 tersedia');
    expect(page.text).not.toContain('Minke');

    const open = await desk.get(`/api/v1/circulation/loans?state=open&memberId=${memberId}`);
    expect((open.json as { items: { member: { name: string } }[] }).items.map((l) => l.member.name)).toEqual(['Minke Pribumi']);

    const back = await desk.send('post', `${desk1}/returns`, { barcode });
    expect(back.status, back.text).toBe(200);
    expect(back.json).toMatchObject({ memberId, memberNo: 'SIS 042', daysLate: 0, returnedOn: '2026-10-22' });
    expect((await desk.get(recordUrlPath(recordId, title))).text).toContain('1 eksemplar, 1 tersedia');
    const closed = await desk.get(`/api/v1/circulation/loans?state=closed&memberId=${memberId}`);
    expect((closed.json as { items: { outcome: string }[] }).items.map((l) => l.outcome)).toEqual(['returned']);
  });
});
