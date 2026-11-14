import { addDays, localDate, newId } from '@altis/shared';
import { expect } from 'vitest';
import type { AgentReply } from '../agent.js';
import type { AreaAuditScript, AuditScriptContext } from './catalog.js';

// The audit script of charges and payments: a super admin, through the API as the admin does, at the desk of a new
// branch books a charge by hand for a member, waives part of it, takes a payment (its receipt prints), then voids the
// payment. The branch and the member are seeded straight into the tables (their own actions belong to other areas).
// Each audited route appends exactly one entry of its action.

const API = '/api/v1';

/** The JSON of a reply, after checking its status. */
function ok<T>(res: AgentReply, status = 200): T {
  expect(res.status, res.text).toBe(status);
  return res.json as T;
}

const trail = (now: number) => ({ created_at: now, created_by: null, updated_at: now, updated_by: null });

/** A live member of type SISWA; its id. */
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
      class_name: '12A',
      email: null,
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
  actions: ['circulation.charge.create', 'circulation.charge.waive', 'circulation.payment.create', 'circulation.payment.void'],
  run: async (s) => {
    const now = s.clock.now;
    const branchId = newId();
    const code = `BIAYA-${branchId.slice(-8)}`;
    await s.db.db
      .insertInto('branches')
      .values({ id: branchId, code_key: code, code_display: code, name: 'Cabang Biaya', timezone: 'Asia/Jakarta', created_at: now, updated_at: now })
      .execute();
    const reader = await seedMember(s, 'AUDIT-BIAYA-1');
    const desk = `${API}/branches/${branchId}/circulation`;

    const charge = ok<{ id: string; balance: string }>(
      await s.admin.send('post', `${desk}/members/${reader}/charges`, { kind: 'damage', amount: '15000', description: 'Sampul rusak' }),
      201,
    );
    expect(charge.balance).toBe('15000.00');
    const waived = ok<{ balance: string }>(await s.admin.send('post', `${desk}/charges/${charge.id}/waive`, { amount: '5000', reason: 'Siswa kurang mampu' }));
    expect(waived.balance).toBe('10000.00');
    const payment = ok<{ id: string; receiptNo: string }>(await s.admin.send('post', `${desk}/members/${reader}/payments`, { amount: '10000', method: 'cash' }), 201);
    expect(payment.receiptNo).toBe(`${code}/${localDate('Asia/Jakarta', Date.now()).slice(0, 4)}/000001`);
    const receipt = await s.admin.send('get', `${desk}/payments/${payment.id}/receipt?paper=58`);
    expect(receipt.status, receipt.text).toBe(200);
    ok(await s.admin.send('post', `${desk}/payments/${payment.id}/void`, { reason: 'Salah nominal' }));

    const entries = await s.db.db
      .selectFrom('audit_log')
      .select(['action', 'entity_id'])
      .where('entity_id', 'in', [charge.id, payment.id])
      .orderBy('seq')
      .execute();
    expect(entries.map((e) => [e.action, e.entity_id])).toEqual([
      ['circulation.charge.create', charge.id],
      ['circulation.charge.waive', charge.id],
      ['circulation.payment.create', payment.id],
      ['circulation.payment.void', payment.id],
    ]);
  },
};
