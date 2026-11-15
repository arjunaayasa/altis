import { enqueue } from '@altis/core';
import { withTx } from '@altis/db';
import { addDays, localDate, newId } from '@altis/shared';
import { expect } from 'vitest';
import type { AgentReply } from '../agent.js';
import type { AreaAuditScript, AuditScriptContext } from './catalog.js';

// The audit script of the member notices: a super admin, at the desk of a new branch, sends a member an overdue
// reminder by hand (one entry, whatever it queued); then the daily notices job runs and writes one entry for its run.
// The branch and the member are seeded straight into the tables.

const API = '/api/v1';
const DAY = 86_400_000;

function ok<T>(res: AgentReply, status = 200): T {
  expect(res.status, res.text).toBe(status);
  return res.json as T;
}

const trail = (now: number) => ({ created_at: now, created_by: null, updated_at: now, updated_by: null });

/** A live member of type SISWA with an e-mail address; its id. */
async function seedMember(s: AuditScriptContext, no: string): Promise<string> {
  const now = s.clock.now;
  const today = localDate('Asia/Jakarta', now);
  const siswa = (await s.db.db.selectFrom('member_types').select('id').where('code_key', '=', 'SISWA').executeTakeFirstOrThrow()).id;
  const id = newId();
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
      name: `Anggota ${no}`,
      name_key: `anggota ${no.toLowerCase()}`,
      gender: null,
      birth_date: null,
      identity_no: null,
      institution: null,
      class_name: '9A',
      email: 'anggota@example.test',
      phone: null,
      address: null,
      postal_code: null,
      mailing_address: null,
      notes: null,
      photo_file_id: null,
      locale: 'id',
      joined_on: addDays(today, -300),
      valid_from: addDays(today, -300),
      expires_on: addDays(today, 60),
      password_hash: null,
      must_reset_password: 0,
      session_version: 0,
      last_login_at: null,
      anonymized_at: null,
      source: 'manual',
      archived_at: null,
      version: 0,
      ...trail(now),
    })
    .execute();
  return id;
}

export const AUDIT: AreaAuditScript = {
  actions: ['circulation.notice.send', 'circulation.notices.run'],
  run: async (s) => {
    const now = s.clock.now;
    const branchId = newId();
    const code = `PNG-${branchId.slice(-8)}`;
    await s.db.db
      .insertInto('branches')
      .values({ id: branchId, code_key: code, code_display: code, name: 'Cabang Pengingat', timezone: 'Asia/Jakarta', created_at: now, updated_at: now })
      .execute();
    const reader = await seedMember(s, 'AUDIT-PNG-1');
    const seq = Number((await s.db.db.selectFrom('audit_head').select('last_seq').where('id', '=', 1).executeTakeFirstOrThrow()).last_seq);

    const sent = ok<{ queued: number; nothing: number }>(await s.admin.send('post', `${API}/branches/${branchId}/circulation/notices`, { memberIds: [reader], kind: 'overdue' }));
    expect(sent).toMatchObject({ queued: 0, nothing: 1 });

    const job = await withTx(s.db, (trx) =>
      enqueue(trx, s.jobs.registry, { type: 'circulation.notices', payload: { windowStart: now - DAY, windowEnd: now } }, { now: s.clock.now, keyring: s.config.keyring }),
    );
    for (let n = 0; n < 10; n += 1) {
      const slice = await s.jobs.drive(job.id, { budgetMs: 20_000 });
      if (slice === null || slice.outcome !== 'continued') break;
    }

    const entries = await s.db.db
      .selectFrom('audit_log')
      .select(['action', 'branch_id'])
      .where('seq', '>', seq)
      .where('action', 'in', ['circulation.notice.send', 'circulation.notices.run'])
      .orderBy('seq')
      .execute();
    expect(entries.map((e) => e.action)).toEqual(['circulation.notice.send', 'circulation.notices.run']);
    expect(entries[0]!.branch_id).toBe(branchId);
  },
};
