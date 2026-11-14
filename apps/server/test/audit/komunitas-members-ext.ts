import { enqueue, createJobRegistry } from '@altis/core';
import { withTx } from '@altis/db';
import { newId, normalizeKey } from '@altis/shared';
import { expect } from 'vitest';
import { jobHandlers } from '../../src/jobs/runtime.js';
import { createAgent, type AgentReply } from '../agent.js';
import type { AreaAuditScript, AuditScriptContext } from './catalog.js';

// The audit script of the member tools, visits and guestbook stations: a super admin, through the API as the admin
// does, creates a member, edits it in bulk, sets and removes its photo, prints its card, archives and restores it,
// exports its data and anonymises it; records a guest visit and voids it; creates a station, asks for a new code,
// activates the station from a device of its own (the station is the actor), and revokes it; then the daily
// anonymisation job runs once. Each audited request appends exactly one entry of its action.

const API = '/api/v1/members';

function ok<T>(res: AgentReply, status = 200): T {
  expect(res.status, res.text).toBe(status);
  return res.json as T;
}

/** A live branch of its own, written straight into its table; its id. */
async function seedBranch(s: AuditScriptContext): Promise<string> {
  const id = newId(s.clock.now);
  const code = `AUD${id.slice(-6)}`;
  await s.db.db
    .insertInto('branches')
    .values({ id, code_key: normalizeKey(code), code_display: code, name: 'Cabang Audit Kunjungan', timezone: 'Asia/Jakarta', created_at: s.clock.now, updated_at: s.clock.now })
    .execute();
  return id;
}

export const AUDIT: AreaAuditScript = {
  actions: [
    'members.member.restore',
    'members.member.bulk_update',
    'members.member.photo_set',
    'members.card.print',
    'members.privacy.export',
    'members.privacy.anonymize',
    'privacy.anonymize.run',
    'visits.visit.create',
    'visits.visit.void',
    'visits.station.create',
    'visits.station.activation_code',
    'visits.station.revoke',
    'visits.station.activated',
  ],
  run: async (s) => {
    const types = ok<{ items: { id: string; code: string }[] }>(await s.admin.send('get', `${API}/types`));
    const typeId = types.items.find((t) => t.code === 'SISWA')!.id;
    const member = ok<{ id: string; version: number }>(await s.admin.send('post', API, { memberNo: 'AUDIT-EXT-1', memberTypeId: typeId, name: 'Anggota Ekstra' }), 201);
    ok(await s.admin.send('post', `${API}/bulk`, { action: 'set', ids: [member.id], set: { className: '9C' } }));
    let version = member.version + 1;
    version = ok<{ version: number }>(await s.admin.send('put', `${API}/${member.id}/photo`, { version, fileId: null })).version;
    const cards = await s.admin.send('post', `${API}/cards`, { memberIds: [member.id] });
    expect(cards.status, cards.text).toBe(200);
    version = ok<{ version: number }>(await s.admin.send('delete', `${API}/${member.id}`, { version })).version;
    version = ok<{ version: number }>(await s.admin.send('post', `${API}/${member.id}/restore`, { version })).version;
    const reauth = await s.admin.send('post', '/api/v1/auth/reauth', { password: s.admin.password });
    expect(reauth.status, reauth.text).toBeLessThan(300);
    const exported = await s.admin.send('post', `${API}/${member.id}/privacy/export`);
    expect(exported.status, exported.text).toBe(200);
    ok(await s.admin.send('post', `${API}/${member.id}/privacy/anonymize`, { version, confirmMemberNo: 'audit-ext-1' }));

    const branchId = await seedBranch(s);
    const visit = ok<{ id: string }>(await s.admin.send('post', `/api/v1/branches/${branchId}/visits`, { guest: { name: 'Tamu Audit', institution: 'Dinas' } }), 201);
    const voided = await s.admin.send('post', `/api/v1/branches/${branchId}/visits/${visit.id}/void`);
    expect(voided.status, voided.text).toBe(204);
    const station = ok<{ id: string; code: string }>(await s.admin.send('post', `/api/v1/branches/${branchId}/visits/stations`, { name: 'Buku tamu audit' }), 201);
    const fresh = ok<{ code: string }>(await s.admin.send('post', `/api/v1/branches/${branchId}/visits/stations/${station.id}/activation-code`));

    // The device: the activation form gives the pre-session token, the code pairs it.
    const origin = new URL(s.config.baseUrl).origin;
    const device = createAgent(s.app, { peer: '198.51.100.250', headers: { origin } });
    const form = await device.get('/kunjungan/aktifkan', undefined, { accept: 'text/html' });
    expect(form.status, form.text).toBe(200);
    const csrf = /name="_csrf" value="([^"]+)"/.exec(form.text)?.[1];
    expect(csrf).toBeDefined();
    const activated = await device.post('/kunjungan/aktifkan', new URLSearchParams({ _csrf: csrf!, code: fresh.code }).toString(), {
      'content-type': 'application/x-www-form-urlencoded',
    });
    expect(activated.status, activated.text).toBe(303);
    const revoked = await s.admin.send('delete', `/api/v1/branches/${branchId}/visits/stations/${station.id}`);
    expect(revoked.status, revoked.text).toBe(204);

    const reg = createJobRegistry(jobHandlers());
    const now = s.clock.now;
    const { id: jobId } = await withTx(s.db, (trx) =>
      enqueue(trx, reg, { type: 'privacy.anonymize', payload: { windowStart: now, windowEnd: now + 60_000 } }, { now, keyring: s.config.keyring }),
    );
    for (let slices = 0; slices < 50; slices += 1) {
      const r = await s.jobs.drive(jobId, { budgetMs: 20_000 });
      if (r === null || r.outcome !== 'continued') break;
    }

    const entries = await s.db.db
      .selectFrom('audit_log')
      .select(['action', 'actor_type'])
      .where('entity_id', 'in', [member.id, visit.id, station.id])
      .orderBy('seq')
      .execute();
    expect(entries.map((e) => e.action)).toEqual([
      'members.member.create',
      'members.member.photo_set',
      'members.member.archive',
      'members.member.restore',
      'members.privacy.export',
      'members.privacy.anonymize',
      'visits.visit.create',
      'visits.visit.void',
      'visits.station.create',
      'visits.station.activation_code',
      'visits.station.activated',
      'visits.station.revoke',
    ]);
    expect(entries.find((e) => e.action === 'visits.station.activated')?.actor_type).toBe('visit_station');
    const run = await s.db.db.selectFrom('audit_log').select('action').where('action', '=', 'privacy.anonymize.run').execute();
    expect(run).toHaveLength(1);
  },
};
