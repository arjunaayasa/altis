import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPasswordHasher, localStorageDriver, recordUrlPath, sha256hex, startMemberReset } from '@altis/core';
import { PHASE1_MIGRATIONS, runMigrations, withTx } from '@altis/db';
import { newId } from '@altis/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { createApp } from '../../src/app.js';
import { createAgent, type Agent, type AgentReply } from '../agent.js';
import { recordingLogger, sampleConfig } from '../support.js';
import { seedStaff, sessionCookieFor, sessionCsrfFor } from '../support-auth.js';

// The OPAC member area (`/akun`) through HTTP, on the engine picked by ALTIS_TEST_DB: member sign-in apart from staff
// sessions, one failure text for an unknown number and a wrong password, the sign-in bucket and its one audit entry,
// CSRF and Origin on every form, the form body rules, `lanjut`, a SLiMS bcrypt hash rehashed at sign-in, the password
// change and the reset ending the member's sessions, ownership (another member's loan, hold or bookmark is the OPAC 404),
// online renewal per member type, holds and bookmarks, the members' attachments and the download of the member's data.

const ctx = testDbContext();

const NOW = Date.UTC(2026, 9, 22, 2, 0, 0);
const CONFIG = sampleConfig();
const ORIGIN = new URL(CONFIG.baseUrl).origin;
const SID = '__Host-altis_sid';
const MSID = '__Host-altis_msid';
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const PASSWORD = 'buku-perpus-77';
/** `htpasswd -nbBC 5 u 'Perpustakaan@2024'` (PHP's `$2y$` form, as SLiMS stores it). */
const SLIMS_HASH = '$2y$05$oabie/M.2XPAmvTGEw1lJOwwTmKlYehbFqzlmvM2QPUE8Sozlwb3G';

const form = (fields: Record<string, string>): string => new URLSearchParams(fields).toString();

/** The `_csrf` value of the first form of a page. */
function csrfOf(html: string): string {
  const m = /name="_csrf" value="([^"]+)"/.exec(html);
  if (m === null) throw new Error('no _csrf field on the page');
  return m[1]!;
}

describe.skipIf(!ctx.available)(`the OPAC member area [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let dataDir: string;
  let app: ReturnType<typeof createApp>;
  let branchId: string;
  let recordId: string;
  let itemId: string;
  let siswa: string;
  let guru: string;
  let hash: string;
  let peer = 0;
  const title = 'Laskar Pelangi';

  const agent = (): Agent => createAgent(app, { peer: `198.51.100.${(peer += 1)}`, headers: { origin: ORIGIN } });

  async function seedMember(no: string, o: { typeId?: string; hash?: string | null; email?: string | null } = {}): Promise<string> {
    const id = newId();
    await h.db
      .insertInto('members')
      .values({
        id,
        member_no_display: no,
        member_no_key: no.replace(/ /g, '').toUpperCase(),
        member_type_id: o.typeId ?? siswa,
        home_branch_id: branchId,
        status: 'active',
        status_note: null,
        name: `Nama ${no}`,
        name_key: `nama ${no.toLowerCase()}`,
        gender: null,
        birth_date: null,
        identity_no: null,
        institution: null,
        class_name: '9A',
        email: o.email ?? null,
        phone: null,
        address: null,
        postal_code: null,
        mailing_address: null,
        notes: null,
        photo_file_id: null,
        locale: 'id',
        joined_on: '2026-01-01',
        valid_from: '2026-01-01',
        expires_on: '2027-01-01',
        password_hash: o.hash === undefined ? hash : o.hash,
        must_reset_password: 0,
        session_version: 0,
        last_login_at: null,
        anonymized_at: null,
        source: 'manual',
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

  /** Signs `no` in through the form; the agent then holds the member cookie. */
  async function signIn(no: string, password = PASSWORD, a = agent()): Promise<{ a: Agent; res: AgentReply }> {
    const page = await a.get('/akun/masuk');
    expect(page.status).toBe(200);
    const res = await a.post('/akun/masuk', form({ _csrf: csrfOf(page.text), memberNo: no, password }), FORM);
    return { a, res };
  }

  /** A signed-in member's agent and the CSRF token of the account pages. */
  async function member(no: string): Promise<{ a: Agent; csrf: string }> {
    const { a, res } = await signIn(no);
    expect(res.status, res.text).toBe(303);
    const home = await a.get('/akun');
    expect(home.status, home.text).toBe(200);
    return { a, csrf: csrfOf(home.text) };
  }

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-akun-')));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(dataDir, 'migrations'), migrations: PHASE1_MIGRATIONS });
    hash = await createPasswordHasher().hash(PASSWORD);
    siswa = (await h.db.selectFrom('member_types').select('id').where('code_key', '=', 'SISWA').executeTakeFirstOrThrow()).id;
    guru = (await h.db.selectFrom('member_types').select('id').where('code_key', '=', 'GURU').executeTakeFirstOrThrow()).id;
    const buku = (await h.db.selectFrom('material_types').select('id').where('code_key', '=', 'BUKU').executeTakeFirstOrThrow()).id;
    const umum = (await h.db.selectFrom('collection_types').select('id').where('code_key', '=', 'UMUM').executeTakeFirstOrThrow()).id;
    const trail = { created_at: NOW, created_by: null, updated_at: NOW, updated_by: null };
    branchId = newId();
    await h.db
      .insertInto('branches')
      .values({ id: branchId, code_key: 'PUSAT', code_display: 'Pusat', name: 'Perpustakaan Pusat', address: null, timezone: 'Asia/Jakarta', ...trail })
      .execute();
    recordId = newId();
    await h.db
      .insertInto('records')
      .values({
        id: recordId,
        material_type_id: buku,
        title,
        subtitle: null,
        responsibility: null,
        title_key: 'laskar pelangi',
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
    itemId = newId();
    await h.db
      .insertInto('items')
      .values({
        id: itemId,
        record_id: recordId,
        branch_id: branchId,
        barcode_display: 'LP-01',
        barcode_key: 'LP-01',
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
  });

  afterAll(async () => {
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  it('sign-in: one failure text for an unknown number and a wrong password; a member session is never a staff one', async () => {
    await seedMember('A-001');
    const unknown = await signIn('Z-404', PASSWORD);
    const wrong = await signIn('A-001', 'salah-sandi-123');
    expect([unknown.res.status, wrong.res.status]).toEqual([401, 401]);
    const failure = (html: string) => /<p class="akun-flash akun-flash-error"[^>]*>([^<]*)</.exec(html)?.[1];
    expect(failure(unknown.res.text)).toBe('Nomor anggota atau kata sandi salah.');
    expect(failure(wrong.res.text)).toBe(failure(unknown.res.text));

    const { a, res } = await signIn(' a-001 ');
    expect([res.status, res.headers.get('location')]).toEqual([303, '/akun']);
    expect(a.cookies.get(MSID)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const home = await a.get('/akun');
    expect(home.status).toBe(200);
    expect(home.text).toContain('Halo, Nama A-001');
    expect(home.headers.get('cache-control')).toBe('private, no-store');
    // The member cookie opens nothing of the staff API, and a staff session opens nothing of the member area.
    const me = await a.get('/api/v1/auth/me');
    expect((me.json as { authenticated: boolean }).authenticated).toBe(false);
    const staff = await seedStaff(h, { username: 'pustakawan', now: NOW, roles: [{ permissions: ['members.records.read'] as never }] });
    const s = agent();
    s.setCookie(SID, await sessionCookieFor(h, staff.id, { now: NOW }));
    const asStaff = await s.get('/akun');
    expect([asStaff.status, asStaff.headers.get('location')]).toEqual([303, '/akun/masuk']);
    // A member token in the staff cookie is no session either.
    const swapped = agent();
    swapped.setCookie(SID, a.cookies.get(MSID)!);
    expect(((await swapped.get('/api/v1/auth/me')).json as { authenticated: boolean }).authenticated).toBe(false);
  });

  it('lanjut: only a path an OPAC page serves; //host, /\\host and unknown paths land on /akun', async () => {
    await seedMember('A-002');
    const go = async (lanjut: string): Promise<string | null> => {
      const a = agent();
      const page = await a.get(`/akun/masuk?lanjut=${encodeURIComponent(lanjut)}`);
      const res = await a.post('/akun/masuk', form({ _csrf: csrfOf(page.text), memberNo: 'A-002', password: PASSWORD, lanjut }), FORM);
      return res.headers.get('location');
    };
    const detail = recordUrlPath(recordId, title);
    expect(await go(detail)).toBe(detail);
    expect(await go(`/akun/reservasi/baru?cantuman=${recordId}`)).toBe(`/akun/reservasi/baru?cantuman=${recordId}`);
    expect(await go('//evil.example/akun')).toBe('/akun');
    expect(await go('/\\evil.example')).toBe('/akun');
    expect(await go('https://evil.example/')).toBe('/akun');
    expect(await go('/admin/login')).toBe('/akun');
  });

  it('CSRF and Origin on every form; the form rules (no _csrf in the schema, no field twice, at most 16 KB)', async () => {
    await seedMember('A-003');
    const { a, csrf } = await member('A-003');
    const post = (body: string, headers: Record<string, string> = {}) => a.post('/akun/penanda', body, { ...FORM, ...headers });
    const code = (r: AgentReply) => (r.json as { code?: string } | undefined)?.code;
    const none = await post(form({ recordId }));
    expect([none.status, code(none)]).toEqual([403, 'CSRF_INVALID']);
    const foreign = await post(form({ _csrf: csrf, recordId }), { origin: 'https://evil.example' });
    expect([foreign.status, code(foreign)]).toEqual([403, 'ORIGIN_DENIED']);
    const page = await post(form({ recordId }), { accept: 'text/html' });
    expect([page.status, page.text.includes('Permintaan tidak dapat diproses')]).toEqual([403, true]);
    const twice = await post(`_csrf=${encodeURIComponent(csrf)}&recordId=${recordId}&recordId=${recordId}`);
    expect([twice.status, (twice.json as { errors?: unknown }).errors]).toEqual([422, [{ path: 'recordId', code: 'duplicate_field' }]]);
    const big = await post(form({ _csrf: csrf, recordId, pad: 'x'.repeat(17_000) }));
    expect(big.status).toBe(413);
    const json = await a.post('/akun/penanda', { _csrf: csrf, recordId });
    expect(json.status).toBe(415);
    // The header works as well as the field; `_csrf` never reaches the strict schema.
    const viaHeader = await post(form({ recordId }), { 'x-csrf-token': csrf });
    expect([viaHeader.status, viaHeader.headers.get('location')]).toEqual([303, '/akun/penanda?pesan=bookmark_added']);
    const viaField = await post(form({ _csrf: csrf, recordId }));
    expect([viaField.status, viaField.headers.get('location')]).toEqual([303, '/akun/penanda?pesan=bookmark_already']);
    expect((await a.get('/akun/penanda')).text).toContain(title);
  });

  it('the sign-in bucket per number and IP holds after 5 failures and audits login_locked once', async () => {
    await seedMember('A-004');
    const a = agent();
    const statuses: number[] = [];
    for (let i = 0; i < 7; i += 1) statuses.push((await signIn('A-004', `salah-${i}-sandi`, a)).res.status);
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429, 429]);
    const locked = await h.db.selectFrom('audit_log').select(['meta']).where('action', '=', 'members.self.login_locked').execute();
    expect(locked).toHaveLength(1);
    expect(JSON.parse(locked[0]!.meta)).toEqual({ bucket: 'member_login:user-ip', count: 6 });
    // The right password is held back too while the bucket is full.
    expect((await signIn('A-004', PASSWORD, a)).res.status).toBe(429);
  });

  it('a SLiMS bcrypt hash signs in once and is stored again as scrypt', async () => {
    const id = await seedMember('S-0001', { hash: SLIMS_HASH });
    expect((await signIn('S-0001', 'Perpustakaan@2024x')).res.status).toBe(401);
    const { res } = await signIn('S-0001', 'Perpustakaan@2024');
    expect(res.status).toBe(303);
    const row = await h.db.selectFrom('members').select(['password_hash', 'last_login_at']).where('id', '=', id).executeTakeFirstOrThrow();
    expect(row.password_hash).toMatch(/^\$scrypt\$ln=15,/);
    expect(Number(row.last_login_at)).toBe(NOW);
    expect((await signIn('S-0001', 'Perpustakaan@2024')).res.status).toBe(303);
  });

  it('a password change ends the other sessions; a reset link sets a new password once and ends every session', async () => {
    const id = await seedMember('A-005', { email: 'a005@contoh.test' });
    const first = await member('A-005');
    const second = await member('A-005');
    const page = await first.a.get('/akun/sandi');
    const wrong = await first.a.post('/akun/sandi', form({ _csrf: csrfOf(page.text), current: 'bukan-ini-123', next: 'sandi-baru-2026', repeat: 'sandi-baru-2026' }), FORM);
    expect([wrong.status, wrong.text.includes('Kata sandi saat ini salah.')]).toEqual([422, true]);
    const weak = await first.a.post('/akun/sandi', form({ _csrf: csrfOf(page.text), current: PASSWORD, next: 'abc', repeat: 'abc' }), FORM);
    expect([weak.status, weak.text.includes('minimal 8 karakter')]).toEqual([422, true]);
    const done = await first.a.post('/akun/sandi', form({ _csrf: csrfOf(page.text), current: PASSWORD, next: 'sandi-baru-2026', repeat: 'sandi-baru-2026' }), FORM);
    expect([done.status, done.headers.get('location')]).toEqual([303, '/akun/sandi?pesan=password_saved']);
    expect((await first.a.get('/akun')).status).toBe(200);
    expect((await second.a.get('/akun')).headers.get('location')).toBe('/akun/masuk');
    expect((await signIn('A-005', 'sandi-baru-2026')).res.status).toBe(303);

    const started = await withTx(h, (trx) => startMemberReset(trx, { memberNo: 'a-005', now: NOW }));
    expect(started?.memberId).toBe(id);
    const token = started!.token;
    const r = agent();
    const resetPage = await r.get(`/akun/atur-sandi/${token}`);
    expect(resetPage.status).toBe(200);
    const set = await r.post(`/akun/atur-sandi/${token}`, form({ _csrf: csrfOf(resetPage.text), next: 'sandi-reset-2026', repeat: 'sandi-reset-2026' }), FORM);
    expect([set.status, set.headers.get('location')]).toEqual([303, '/akun/masuk?pesan=reset_done']);
    expect((await first.a.get('/akun')).headers.get('location')).toBe('/akun/masuk');
    const again = await r.post(`/akun/atur-sandi/${token}`, form({ _csrf: csrfOf(resetPage.text), next: 'sandi-lain-2026', repeat: 'sandi-lain-2026' }), FORM);
    expect(again.status).toBe(410);
    expect((await signIn('A-005', 'sandi-reset-2026')).res.status).toBe(303);
    const audits = await h.db.selectFrom('audit_log').select(['action', 'actor_type', 'actor_id']).where('entity_id', '=', id).orderBy('seq').execute();
    expect(audits.map((x) => [x.action, x.actor_type, x.actor_id])).toEqual([
      ['members.self.password_change', 'member', id],
      ['members.self.password_reset', 'member', id],
    ]);
    expect(await h.db.selectFrom('password_resets').select('token_hash').where('token_hash', '=', sha256hex(token)).where('used_at', 'is', null).execute()).toEqual([]);
  });

  it("ownership: another member's loan, hold or bookmark is the OPAC 404; online renewal follows the member type", async () => {
    const owner = await seedMember('B-001');
    await seedMember('B-002');
    const teacher = await seedMember('G-001', { typeId: guru });
    const staff = await seedStaff(h, { username: 'petugas', now: NOW, roles: [{ permissions: ['circulation.desk.use'] as never }] });
    const desk = agent();
    const token = await sessionCookieFor(h, staff.id, { now: NOW });
    desk.setCookie(SID, token);
    const lent = await desk.post(`/api/v1/branches/${branchId}/circulation/loans`, { memberId: owner, barcode: 'LP-01' }, { 'x-csrf-token': sessionCsrfFor(CONFIG, token) });
    expect(lent.status, lent.text).toBe(201);
    const loanId = (lent.json as { id: string }).id;
    // Lent two days ago: a renewal today is not a same-day one.
    await h.db.updateTable('loans').set({ loaned_on: '2026-10-20', due_on: '2026-10-27' }).where('id', '=', loanId).execute();

    const other = await member('B-002');
    const theirs = await other.a.post(`/akun/pinjaman/${loanId}/perpanjang`, form({ _csrf: other.csrf }), { ...FORM, accept: 'text/html' });
    expect(theirs.status).toBe(404);
    expect(theirs.text).toContain('<html');

    const mine = await member('B-001');
    expect((await mine.a.get('/akun')).text).toContain('LP-01');
    const renewed = await mine.a.post(`/akun/pinjaman/${loanId}/perpanjang`, form({ _csrf: mine.csrf }), FORM);
    expect(renewed.headers.get('location')).toBe('/akun?pesan=renewed&sampai=2026-10-29');
    const audit = await h.db.selectFrom('audit_log').select(['actor_type', 'actor_id']).where('action', '=', 'circulation.loan.renew').executeTakeFirstOrThrow();
    expect([audit.actor_type, audit.actor_id]).toEqual(['member', owner]);
    const loan = await h.db.selectFrom('loans').select(['renewals', 'updated_by']).where('id', '=', loanId).executeTakeFirstOrThrow();
    expect([Number(loan.renewals), loan.updated_by]).toEqual([1, null]);

    // A type without online renewal: refused `not_online` (the button is not offered either).
    await h.db.updateTable('member_types').set({ online_renewal: 0 }).where('id', '=', siswa).execute();
    await h.db.updateTable('loans').set({ last_renewed_on: '2026-10-21' }).where('id', '=', loanId).execute();
    const closed = await mine.a.post(`/akun/pinjaman/${loanId}/perpanjang`, form({ _csrf: mine.csrf }), FORM);
    expect(closed.headers.get('location')).toBe('/akun?pesan=renew_refused&alasan=not_online');
    expect((await mine.a.get('/akun')).text).not.toContain('/perpanjang');
    await h.db.updateTable('member_types').set({ online_renewal: 1 }).where('id', '=', siswa).execute();

    // Holds: the teacher holds the title (its one copy is out), the owner of the loan cannot cancel it.
    const t = await member('G-001');
    const confirm = await t.a.get(`/akun/reservasi/baru?cantuman=${recordId}`);
    expect(confirm.text).toContain('Perpustakaan Pusat');
    const placed = await t.a.post('/akun/reservasi', form({ _csrf: csrfOf(confirm.text), recordId }), FORM);
    expect(placed.headers.get('location')).toBe('/akun/reservasi?pesan=hold_placed&antrean=1');
    const hold = await h.db.selectFrom('holds').select(['id', 'source', 'placed_by']).where('member_id', '=', teacher).executeTakeFirstOrThrow();
    expect([hold.source, hold.placed_by]).toEqual(['opac', null]);
    expect((await mine.a.post(`/akun/reservasi/${hold.id}/batal`, form({ _csrf: mine.csrf }), FORM)).status).toBe(404);
    const twice = await t.a.post('/akun/reservasi', form({ _csrf: t.csrf, recordId }), FORM);
    expect([twice.status, twice.text.includes('Judul ini tidak dapat dipesan')]).toEqual([409, true]);
    expect((await t.a.post(`/akun/reservasi/${hold.id}/batal`, form({ _csrf: t.csrf }), FORM)).headers.get('location')).toBe('/akun/reservasi?pesan=hold_cancelled');

    // Bookmarks are keyed by the member: removing one the member does not have is the 404.
    expect((await other.a.post('/akun/penanda', form({ _csrf: other.csrf, recordId }), FORM)).status).toBe(303);
    expect((await mine.a.post(`/akun/penanda/${recordId}/hapus`, form({ _csrf: mine.csrf }), FORM)).status).toBe(404);
    expect((await other.a.post(`/akun/penanda/${recordId}/hapus`, form({ _csrf: other.csrf }), FORM)).status).toBe(303);
    // A record the OPAC does not show cannot be held or bookmarked.
    expect((await mine.a.get(`/akun/penanda/baru?cantuman=${newId()}`)).status).toBe(404);
  });

  it("members' attachments open to the listed member types; the download of the member's own data needs the password", async () => {
    const pupil = await seedMember('C-001');
    await seedMember('C-002', { typeId: guru });
    const fileId = newId();
    const attachmentId = newId();
    const body = Buffer.from('%PDF-1.4 materi kelas');
    const digest = createHash('sha256').update(body).digest('hex');
    await localStorageDriver(dataDir).put(fileId, body, { size: body.length, sha256: digest });
    await h.db
      .insertInto('files')
      .values({
        id: fileId,
        context: 'catalog.attachment',
        owner_type: 'attachments',
        owner_id: attachmentId,
        original_name: 'materi.pdf',
        mime: 'application/pdf',
        size: body.length,
        sha256: digest,
        access: 'members',
        status: 'ok',
        created_at: NOW,
        created_by: null,
      })
      .execute();
    await h.db
      .insertInto('attachments')
      .values({
        id: attachmentId,
        record_id: recordId,
        kind: 'file',
        file_id: fileId,
        url: null,
        title: 'Materi kelas',
        description: null,
        access: 'members',
        legacy_access_limit: null,
        read_count: 0,
        sort_order: 0,
        archived_at: null,
        version: 0,
        created_at: NOW,
        created_by: null,
        updated_at: NOW,
        updated_by: null,
      })
      .execute();
    await h.db.insertInto('attachment_member_types').values({ attachment_id: attachmentId, member_type_id: siswa }).execute();

    const detail = await agent().get(recordUrlPath(recordId, title));
    expect(detail.text).toContain('Masuk untuk membuka');
    expect(detail.text).toContain(`/akun/penanda/baru?cantuman=${recordId}`);
    expect((await agent().get(`/files/${fileId}`)).status).toBe(404);

    const p = await member('C-001');
    const open = await p.a.get(`/akun/lampiran/${attachmentId}`);
    expect([open.status, open.headers.get('location')]).toEqual([303, `/files/${fileId}`]);
    const file = await p.a.get(`/files/${fileId}`);
    expect([file.status, file.text]).toEqual([200, body.toString()]);
    const t = await member('C-002');
    expect((await t.a.get(`/akun/lampiran/${attachmentId}`)).status).toBe(403);
    expect((await t.a.get(`/files/${fileId}`)).status).toBe(404);

    const dataPage = await p.a.get('/akun/data-saya');
    const refused = await p.a.post('/akun/data-saya', form({ _csrf: csrfOf(dataPage.text), password: 'bukan-sandinya' }), FORM);
    expect(refused.status).toBe(422);
    const data = await p.a.post('/akun/data-saya', form({ _csrf: csrfOf(dataPage.text), password: PASSWORD }), FORM);
    expect(data.status).toBe(200);
    expect(data.headers.get('content-disposition')).toBe('attachment; filename="data-anggota.json"');
    expect(data.json).toMatchObject({ profile: { member_no_display: 'C-001', name: 'Nama C-001', class_name: '9A' }, loans: [], bookmarks: [] });
    expect(data.text).not.toContain('scrypt');
    const audit = await h.db.selectFrom('audit_log').select(['actor_type', 'actor_id']).where('action', '=', 'members.self.data_export').execute();
    expect(audit.map((x) => [x.actor_type, x.actor_id])).toEqual([['member', pupil]]);
  });

  it('staff set a member password (re-authenticated): every session of the member ends', async () => {
    const id = await seedMember('D-001', { hash: null });
    expect((await signIn('D-001', PASSWORD)).res.status).toBe(401);
    const staff = await seedStaff(h, { username: 'kepala', now: NOW, roles: [{ permissions: ['members.records.manage'] as never }] });
    const s = agent();
    const token = await sessionCookieFor(h, staff.id, { now: NOW, reauthAt: NOW });
    s.setCookie(SID, token);
    const csrf = { 'x-csrf-token': sessionCsrfFor(CONFIG, token) };
    const weak = await s.put(`/api/v1/members/${id}/password`, { password: 'abc', mustReset: false }, csrf);
    expect([weak.status, (weak.json as { code: string }).code]).toEqual([422, 'PASSWORD_TOO_WEAK']);
    const set = await s.put(`/api/v1/members/${id}/password`, { password: 'sandi-awal-2026', mustReset: true }, csrf);
    expect(set.status, set.text).toBe(200);
    const signed = await signIn('D-001', 'sandi-awal-2026');
    expect(signed.res.headers.get('location')).toBe('/akun/sandi');
    // A member who must set a new password reaches the password page only.
    expect((await signed.a.get('/akun')).headers.get('location')).toBe('/akun/sandi');
    await s.put(`/api/v1/members/${id}/password`, { password: null, mustReset: false }, csrf);
    expect((await signed.a.get('/akun/sandi')).headers.get('location')).toBe('/akun/masuk?lanjut=%2Fakun%2Fsandi');
    const audit = await h.db.selectFrom('audit_log').select('meta').where('action', '=', 'members.member.password_set').where('entity_id', '=', id).orderBy('seq').execute();
    expect(audit.map((x) => JSON.parse(x.meta))).toEqual([
      { cleared: false, mustReset: true },
      { cleared: true, mustReset: false },
    ]);
  });
});
