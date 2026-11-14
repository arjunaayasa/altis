import { startMemberReset } from '@altis/core';
import { withTx } from '@altis/db';
import { newId } from '@altis/shared';
import { expect } from 'vitest';
import { createAgent, type Agent, type AgentReply } from '../agent.js';
import type { AreaAuditScript, AuditScriptContext } from './catalog.js';

// The audit script of the member area: a super admin sets a member's OPAC password (re-authenticated first); the
// member signs in to the OPAC, changes the password, sets a new one from a reset link and downloads the own data; then
// six wrong sign-ins from one address fill the sign-in bucket, which writes its one entry. The member is seeded straight
// into the table.

const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const form = (fields: Record<string, string>): string => new URLSearchParams(fields).toString();

function csrfOf(res: AgentReply): string {
  const m = /name="_csrf" value="([^"]+)"/.exec(res.text);
  if (m === null) throw new Error(`no _csrf field (${res.status})`);
  return m[1]!;
}

async function signIn(a: Agent, no: string, password: string): Promise<AgentReply> {
  const page = await a.get('/akun/masuk');
  return a.post('/akun/masuk', form({ _csrf: csrfOf(page), memberNo: no, password }), FORM);
}

export const AUDIT: AreaAuditScript = {
  actions: ['members.member.password_set', 'members.self.password_change', 'members.self.password_reset', 'members.self.data_export', 'members.self.login_locked'],
  run: async (s: AuditScriptContext) => {
    const now = s.clock.now;
    const id = newId();
    const no = `AUD-${id.slice(-8)}`;
    const siswa = (await s.db.db.selectFrom('member_types').select('id').where('code_key', '=', 'SISWA').executeTakeFirstOrThrow()).id;
    await s.db.db
      .insertInto('members')
      .values({
        id,
        member_no_display: no,
        member_no_key: no,
        member_type_id: siswa,
        home_branch_id: null,
        status: 'active',
        status_note: null,
        name: 'Anggota Audit',
        name_key: 'anggota audit',
        gender: null,
        birth_date: null,
        identity_no: null,
        institution: null,
        class_name: null,
        email: 'anggota.audit@contoh.test',
        phone: null,
        address: null,
        postal_code: null,
        mailing_address: null,
        notes: null,
        photo_file_id: null,
        locale: 'id',
        joined_on: '2026-01-01',
        valid_from: '2026-01-01',
        expires_on: '2099-12-31',
        password_hash: null,
        must_reset_password: 0,
        session_version: 0,
        last_login_at: null,
        anonymized_at: null,
        source: 'manual',
        archived_at: null,
        version: 0,
        created_at: now,
        created_by: null,
        updated_at: now,
        updated_by: null,
      })
      .execute();

    expect((await s.admin.send('post', '/api/v1/auth/reauth', { password: s.admin.password })).status).toBe(200);
    const set = await s.admin.send('put', `/api/v1/members/${id}/password`, { password: 'sandi-audit-2026', mustReset: false });
    expect(set.status, set.text).toBe(200);

    const origin = new URL(s.config.baseUrl).origin;
    const a = createAgent(s.app, { peer: '198.51.100.250', headers: { origin } });
    expect((await signIn(a, no, 'sandi-audit-2026')).status).toBe(303);
    const page = await a.get('/akun/sandi');
    const changed = await a.post('/akun/sandi', form({ _csrf: csrfOf(page), current: 'sandi-audit-2026', next: 'sandi-audit-baru', repeat: 'sandi-audit-baru' }), FORM);
    expect(changed.status, changed.text).toBe(303);

    const started = await withTx(s.db, (trx) => startMemberReset(trx, { memberNo: no, now: s.clock.now }));
    const reset = createAgent(s.app, { peer: '198.51.100.251', headers: { origin } });
    const resetPage = await reset.get(`/akun/atur-sandi/${started!.token}`);
    const done = await reset.post(`/akun/atur-sandi/${started!.token}`, form({ _csrf: csrfOf(resetPage), next: 'sandi-audit-reset', repeat: 'sandi-audit-reset' }), FORM);
    expect(done.status, done.text).toBe(303);

    const b = createAgent(s.app, { peer: '198.51.100.252', headers: { origin } });
    expect((await signIn(b, no, 'sandi-audit-reset')).status).toBe(303);
    const dataPage = await b.get('/akun/data-saya');
    const data = await b.post('/akun/data-saya', form({ _csrf: csrfOf(dataPage), password: 'sandi-audit-reset' }), FORM);
    expect(data.status, data.text).toBe(200);

    const c = createAgent(s.app, { peer: '198.51.100.253', headers: { origin } });
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) statuses.push((await signIn(c, no, `salah-${i}-sandi`)).status);
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);

    const entries = await s.db.db.selectFrom('audit_log').select(['action', 'actor_type']).where('action', 'like', 'members.%').where('at', '>=', now).orderBy('seq').execute();
    expect(entries.filter((e) => e.action.startsWith('members.self.') || e.action === 'members.member.password_set').map((e) => [e.action, e.actor_type])).toEqual([
      ['members.member.password_set', 'staff'],
      ['members.self.password_change', 'member'],
      ['members.self.password_reset', 'member'],
      ['members.self.data_export', 'member'],
      ['members.self.login_locked', 'anonymous'],
    ]);
  },
};
