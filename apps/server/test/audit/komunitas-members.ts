import { expect } from 'vitest';
import type { AgentReply } from '../agent.js';
import type { AreaAuditScript } from './catalog.js';

// The audit script of members, member types and the CSV member import: a super admin, through the API as the admin
// does, creates a member type and edits it, creates a member, edits, extends and archives it, archives the type (its
// only member is archived), then uploads a two-row CSV and imports it for real (the start and the finish are audited
// in the same request). Each audited route appends exactly one entry of its action.

const API = '/api/v1/members';

/** The JSON of a reply, after checking its status. */
function ok<T>(res: AgentReply, status = 200): T {
  expect(res.status, res.text).toBe(status);
  return res.json as T;
}

const CSV = 'member_no;name;member_type;class_name\r\nAUDIT-IMP-1;Siswa Audit;SISWA;7A\r\nAUDIT-IMP-2;Guru Audit;GURU;\r\n';

export const AUDIT: AreaAuditScript = {
  actions: [
    'members.member.create',
    'members.member.update',
    'members.member.archive',
    'members.member.extend',
    'members.type.create',
    'members.type.update',
    'members.type.archive',
    'members.import.start',
    'members.import.finish',
  ],
  run: async (s) => {
    const type = ok<{ id: string; version: number }>(
      await s.admin.send('post', `${API}/types`, { code: 'AUDIT-T', nameId: 'Tipe Audit', nameEn: 'Audit type', accredGroup: 'public', membershipDays: 365, loanLimit: 2 }),
      201,
    );
    const typeV = ok<{ version: number }>(await s.admin.send('patch', `${API}/types/${type.id}`, { version: type.version, nameId: 'Tipe Audit Baru' }));
    const member = ok<{ id: string; version: number }>(await s.admin.send('post', API, { memberNo: 'audit 001', memberTypeId: type.id, name: 'Anggota Audit' }), 201);
    const edited = ok<{ version: number }>(await s.admin.send('patch', `${API}/${member.id}`, { version: member.version, className: '8B' }));
    const extended = ok<{ version: number }>(await s.admin.send('post', `${API}/${member.id}/extend`, { version: edited.version, from: 'expiry', days: 30 }));
    ok(await s.admin.send('delete', `${API}/${member.id}`, { version: extended.version }));
    ok(await s.admin.send('delete', `${API}/types/${type.id}`, { version: typeV.version }));

    const staged = await s.admin.upload('members.import', Buffer.from(CSV, 'utf8'), 'anggota.csv');
    expect('uploadId' in staged).toBe(true);
    const started = ok<{ id: string; status: string }>(
      await s.admin.send('post', `${API}/imports`, { uploadId: (staged as { uploadId: string }).uploadId, mode: 'create_only', dryRun: false }),
      202,
    );
    const view = ok<{ status: string; counts: { inserted: number; refused: number } }>(await s.admin.send('get', `${API}/imports/${started.id}`));
    expect([view.status, view.counts.inserted, view.counts.refused]).toEqual(['succeeded', 2, 0]);

    const entries = await s.db.db
      .selectFrom('audit_log')
      .select(['action', 'entity_id'])
      .where('entity_id', 'in', [type.id, member.id, started.id])
      .orderBy('seq')
      .execute();
    expect(entries.map((e) => e.action)).toEqual([
      'members.type.create',
      'members.type.update',
      'members.member.create',
      'members.member.update',
      'members.member.extend',
      'members.member.archive',
      'members.type.archive',
      'members.import.start',
      'members.import.finish',
    ]);
  },
};
