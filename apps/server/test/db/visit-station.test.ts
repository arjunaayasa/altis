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

// The guestbook station through HTTP, on the engine picked by ALTIS_TEST_DB: staff create a station and get its code;
// a device without a station is sent to the activation page; the activation form refuses a post without its CSRF
// token or from another origin, takes the code once (a second use is refused), and sets the `altis_vs` cookie
// (`HttpOnly`, `SameSite=Strict`); the check-in page carries its CSP nonce and no inline script, records a member by
// number (a repeat within the window is greeted, not counted) and a guest, never shows the member's full name or
// photo; the staff session cookie is never read on these pages; a revoked station is sent back to the activation.

const ctx = testDbContext();

const NOW = Date.UTC(2026, 9, 22, 2, 0, 0);
const CONFIG = sampleConfig();
const SID = '__Host-altis_sid';
const VS = '__Host-altis_vs';
const CSRF = '__Host-altis_csrf';

/** The `_csrf` value of the first form of `html`. */
function formToken(html: string): string {
  const m = /name="_csrf" value="([^"]+)"/.exec(html);
  if (m === null) throw new Error('no _csrf field in the page');
  return m[1]!;
}

const form = (fields: Record<string, string>): string => new URLSearchParams(fields).toString();
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

describe.skipIf(!ctx.available)(`the guestbook station [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let dataDir: string;
  let app: ReturnType<typeof createApp>;
  let branchId: string;
  let staff: { post(p: string, body?: unknown): Promise<AgentReply>; del(p: string): Promise<AgentReply> };

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-station-')));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(dataDir, 'migrations'), migrations: PHASE1_MIGRATIONS });
    branchId = newId();
    await h.db
      .insertInto('branches')
      .values({ id: branchId, code_key: 'PUSAT', code_display: 'Pusat', name: 'Perpustakaan Pusat', address: null, timezone: 'Asia/Jakarta', created_at: NOW, created_by: null, updated_at: NOW, updated_by: null })
      .execute();
    app = createApp({ state: { phase: 'ready', db: h, config: CONFIG }, version: '0.1.0', buildId: 'b', log: recordingLogger(), clock: () => NOW, dataDir });
    const user = await seedStaff(h, { username: 'petugas_tamu', now: NOW, roles: [{ permissions: ['visits.stations.manage', 'visits.records.manage', 'members.records.manage'] as never }] });
    const token = await sessionCookieFor(h, user.id, { now: NOW });
    const agent = createAgent(app, { headers: { origin: CONFIG.baseUrl } });
    agent.setCookie(SID, token);
    const csrf = { 'x-csrf-token': sessionCsrfFor(CONFIG, token) };
    staff = { post: (p, body) => agent.post(p, body ?? {}, csrf), del: (p) => agent.delete(p, undefined, csrf) };
    const siswa = (await h.db.selectFrom('member_types').select('id').where('code_key', '=', 'SISWA').executeTakeFirstOrThrow()).id;
    const made = await staff.post('/api/v1/members', { memberNo: 'TAMU 01', memberTypeId: siswa, name: 'Ratna Kumala Sari', className: '8C' });
    expect(made.status, made.text).toBe(201);
  });

  afterAll(async () => {
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  it('activation, check-ins, CSRF, the cookie, the CSP, revocation', async () => {
    const created = await staff.post(`/api/v1/branches/${branchId}/visits/stations`, { name: 'Pintu depan' });
    expect(created.status, created.text).toBe(201);
    const { id: stationId, code } = created.json as { id: string; code: string };

    const device = createAgent(app, { peer: '203.0.113.77', headers: { origin: CONFIG.baseUrl } });
    // A staff session in the same browser is never read by the station's pages.
    device.setCookie(SID, 'not-a-session-the-station-ever-reads');
    const away = await device.get('/kunjungan', undefined, { accept: 'text/html' });
    expect([away.status, away.headers.get('location')]).toEqual([303, '/kunjungan/aktifkan']);

    const page = await device.get('/kunjungan/aktifkan', undefined, { accept: 'text/html' });
    expect(page.status).toBe(200);
    const csp = page.headers.get('content-security-policy') ?? '';
    expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9_-]+'/);
    expect(page.text).not.toMatch(/<script(?![^>]*nonce=)/);
    expect(page.text).not.toMatch(/ style="/);
    const token = formToken(page.text);
    expect(device.cookies.has(CSRF)).toBe(true);

    // Without the token, or from another origin: refused, nothing paired.
    expect((await device.post('/kunjungan/aktifkan', form({ code }), FORM)).status).toBe(403);
    expect((await device.post('/kunjungan/aktifkan', form({ code, _csrf: token }), { ...FORM, origin: 'https://evil.example' })).status).toBe(403);
    // A JSON body is not a form; a repeated field is refused.
    expect((await device.post('/kunjungan/aktifkan', JSON.stringify({ code, _csrf: token }))).status).toBe(415);
    expect((await device.post('/kunjungan/aktifkan', `${form({ code, _csrf: token })}&code=X`, FORM)).status).toBe(422);
    const wrong = await device.post('/kunjungan/aktifkan', form({ code: 'AAAAAAAA', _csrf: token }), FORM);
    expect(wrong.status).toBe(422);
    expect(wrong.text).toContain('Kode aktivasi salah');

    const ok = await device.post('/kunjungan/aktifkan', form({ code: code.toLowerCase(), _csrf: token }), FORM);
    expect([ok.status, ok.headers.get('location')]).toEqual([303, '/kunjungan']);
    const cookie = ok.headers.getSetCookie().find((c) => c.startsWith(`${VS}=`)) ?? '';
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Secure/i);
    // The code works once.
    const other = createAgent(app, { peer: '203.0.113.78', headers: { origin: CONFIG.baseUrl } });
    const otherPage = await other.get('/kunjungan/aktifkan', undefined, { accept: 'text/html' });
    expect((await other.post('/kunjungan/aktifkan', form({ code, _csrf: formToken(otherPage.text) }), FORM)).status).toBe(422);
    const audit = await h.db.selectFrom('audit_log').select(['actor_type', 'actor_id']).where('action', '=', 'visits.station.activated').execute();
    expect(audit).toEqual([{ actor_type: 'visit_station', actor_id: stationId }]);

    const station = await device.get('/kunjungan', undefined, { accept: 'text/html' });
    expect(station.status).toBe(200);
    const stationToken = formToken(station.text);
    expect(stationToken).not.toBe(token);
    // The pre-session token is not the station's. (The clock stands still here: the rows are read by group.)
    expect((await device.post('/kunjungan', form({ memberNo: 'TAMU 01', _csrf: token }), FORM)).status).toBe(403);
    const first = await device.post('/kunjungan', form({ memberNo: 'tamu01', _csrf: stationToken }), FORM);
    expect(first.status).toBe(200);
    expect(first.text).toContain('Selamat datang, Ratna!');
    expect(first.text).not.toContain('Kumala');
    expect(first.text).not.toContain('/files/');
    expect(first.text).toContain('content="4;url=/kunjungan"');
    const again = await device.post('/kunjungan', form({ memberNo: 'TAMU 01', _csrf: stationToken }), FORM);
    expect(again.text).toContain('sudah tercatat');
    const unknown = await device.post('/kunjungan', form({ memberNo: 'NOPE', _csrf: stationToken }), FORM);
    expect(unknown.text).toContain('Nomor tidak dikenal');
    const guest = await device.post('/kunjungan', form({ guest: '1', guestName: 'Pak Harun', guestInstitution: 'Dinas Pendidikan', _csrf: stationToken }), FORM);
    expect(guest.text).toContain('Selamat datang, Pak!');
    const rows = await h.db.selectFrom('visits').select(['source', 'accred_group', 'class_name', 'station_id']).where('branch_id', '=', branchId).orderBy('accred_group', 'desc').execute();
    expect(rows).toEqual([
      { source: 'station', accred_group: 'student', class_name: '8C', station_id: stationId },
      { source: 'station', accred_group: 'guest', class_name: null, station_id: stationId },
    ]);

    // Revoked: the device is sent back to the activation, and its posts are refused.
    expect((await staff.del(`/api/v1/branches/${branchId}/visits/stations/${stationId}`)).status).toBe(204);
    const gone = await device.get('/kunjungan', undefined, { accept: 'text/html' });
    expect([gone.status, gone.headers.get('location')]).toEqual([303, '/kunjungan/aktifkan']);
    expect((await device.post('/kunjungan', form({ memberNo: 'TAMU 01', _csrf: stationToken }), FORM)).status).toBe(403);
  });
});
