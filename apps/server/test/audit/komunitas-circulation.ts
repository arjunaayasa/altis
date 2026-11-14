import { addDays, localDate, newId } from '@altis/shared';
import { expect } from 'vitest';
import type { AgentReply } from '../agent.js';
import type { AreaAuditScript, AuditScriptContext } from './catalog.js';

// The audit script of the circulation desk (lend, return, renew) and the loan rules: a super admin, through the API as
// the admin does, creates a loan rule for a member type, edits and archives it; at the desk of a new branch lends an
// item to a member, renews a loan made three days before and returns the first item. The branch, the records, the
// items, the member and the older loan are seeded straight into the tables (their own actions belong to other areas).
// Each audited route appends exactly one entry of its action.

const API = '/api/v1';
const DAY = 86_400_000;

/** The JSON of a reply, after checking its status. */
function ok<T>(res: AgentReply, status = 200): T {
  expect(res.status, res.text).toBe(status);
  return res.json as T;
}

const trail = (now: number) => ({ created_at: now, created_by: null, updated_at: now, updated_by: null });

/** An available item of a new record in `branchId`; its id, record id and barcode. */
async function seedItem(s: AuditScriptContext, branchId: string, title: string): Promise<{ id: string; recordId: string; barcode: string }> {
  const now = s.clock.now;
  const buku = (await s.db.db.selectFrom('material_types').select('id').where('code_key', '=', 'BUKU').executeTakeFirstOrThrow()).id;
  const umum = (await s.db.db.selectFrom('collection_types').select('id').where('code_key', '=', 'UMUM').executeTakeFirstOrThrow()).id;
  const recordId = newId();
  await s.db.db
    .insertInto('records')
    .values({
      id: recordId,
      material_type_id: buku,
      title,
      subtitle: null,
      responsibility: null,
      title_key: title.toLowerCase(),
      edition: null,
      material_detail: null,
      publisher_id: null,
      publication_place: null,
      publication_year: null,
      publication_date_text: null,
      physical_desc: null,
      series: null,
      classification: '899.221',
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
      changed_at: now,
      archived_at: null,
      ...trail(now),
    })
    .execute();
  const id = newId();
  const barcode = `SIRK-${id.slice(-10)}`;
  await s.db.db
    .insertInto('items')
    .values({
      id,
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
      ...trail(now),
    })
    .execute();
  return { id, recordId, barcode };
}

export const AUDIT: AreaAuditScript = {
  actions: [
    'circulation.loan.create',
    'circulation.loan.return',
    'circulation.loan.renew',
    'circulation.policy.create',
    'circulation.policy.update',
    'circulation.policy.archive',
  ],
  run: async (s) => {
    const now = s.clock.now;
    const umumType = (await s.db.db.selectFrom('member_types').select('id').where('code_key', '=', 'UMUM').executeTakeFirstOrThrow()).id;
    const rule = ok<{ id: string; version: number }>(
      await s.admin.send('post', `${API}/circulation/policies`, { code: 'AUDIT-UMUM', name: 'Aturan Umum Audit', memberTypeId: umumType, loanDays: 14, loanLimit: null, renewLimit: 2 }),
      201,
    );
    const ruleV = ok<{ version: number }>(await s.admin.send('patch', `${API}/circulation/policies/${rule.id}`, { version: rule.version, loanDays: 10 }));
    ok(await s.admin.send('delete', `${API}/circulation/policies/${rule.id}`, { version: ruleV.version }));

    const branchId = newId();
    const code = `SIRK-${branchId.slice(-8)}`;
    await s.db.db
      .insertInto('branches')
      .values({ id: branchId, code_key: code, code_display: code, name: 'Cabang Sirkulasi', timezone: 'Asia/Jakarta', created_at: now, updated_at: now })
      .execute();
    const siswa = (await s.db.db.selectFrom('member_types').select('id').where('code_key', '=', 'SISWA').executeTakeFirstOrThrow()).id;
    const memberId = newId();
    const today = localDate('Asia/Jakarta', now);
    await s.db.db
      .insertInto('members')
      .values({
        id: memberId,
        member_no_display: 'AUDIT-SIRK-1',
        member_no_key: 'AUDIT-SIRK-1',
        member_type_id: siswa,
        home_branch_id: null,
        status: 'active',
        status_note: null,
        name: 'Peminjam Audit',
        name_key: 'peminjam audit',
        gender: null,
        birth_date: null,
        identity_no: null,
        institution: null,
        class_name: '9A',
        email: null,
        phone: null,
        address: null,
        postal_code: null,
        mailing_address: null,
        notes: null,
        photo_file_id: null,
        locale: 'id',
        joined_on: addDays(today, -30),
        valid_from: addDays(today, -30),
        expires_on: addDays(today, 335),
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
    const lent = await seedItem(s, branchId, 'Laskar Pelangi');
    const older = await seedItem(s, branchId, 'Ronggeng Dukuh Paruk');
    const olderLoan = newId();
    const policy = (await s.db.db.selectFrom('policies').select('id').where('code_key', '=', 'DEFAULT').executeTakeFirstOrThrow()).id;
    await s.db.db
      .insertInto('loans')
      .values({
        id: olderLoan,
        item_id: older.id,
        open_item_id: older.id,
        record_id: older.recordId,
        member_id: memberId,
        branch_id: branchId,
        policy_id: policy,
        loaned_on: addDays(today, -3),
        loaned_at: now - 3 * DAY,
        due_on: addDays(today, 4),
        renewals: 0,
        last_renewed_on: null,
        returned_on: null,
        returned_at: null,
        return_branch_id: null,
        outcome: null,
        loan_days: 7,
        renew_limit: 1,
        grace_days: 0,
        fine_per_day_minor: 0,
        fine_cap_minor: null,
        currency: 'IDR',
        overrides: null,
        override_note: null,
        loaned_by: null,
        returned_by: null,
        source: 'desk',
        stat_ddc: null,
        stat_material_type_id: null,
        stat_collection_type_id: null,
        stat_location_id: null,
        stat_member_type_id: siswa,
        stat_accred_group: 'student',
        stat_class_name: '9A',
        version: 0,
        ...trail(now - 3 * DAY),
      })
      .execute();

    const desk = `${API}/branches/${branchId}/circulation`;
    const loan = ok<{ id: string; dueOn: string }>(await s.admin.send('post', `${desk}/loans`, { memberId, barcode: lent.barcode.toLowerCase() }), 201);
    expect(loan.dueOn).toBe(addDays(today, 7));
    const renewed = ok<{ dueOn: string; renewals: number }>(await s.admin.send('post', `${desk}/loans/${olderLoan}/renew`));
    expect([renewed.dueOn, renewed.renewals]).toEqual([addDays(today, 7), 1]);
    const back = ok<{ id: string; daysLate: number }>(await s.admin.send('post', `${desk}/returns`, { barcode: lent.barcode }));
    expect([back.id, back.daysLate]).toEqual([loan.id, 0]);

    const entries = await s.db.db
      .selectFrom('audit_log')
      .select(['action', 'entity_id'])
      .where('entity_id', 'in', [rule.id, loan.id, olderLoan])
      .orderBy('seq')
      .execute();
    expect(entries.map((e) => [e.action, e.entity_id])).toEqual([
      ['circulation.policy.create', rule.id],
      ['circulation.policy.update', rule.id],
      ['circulation.policy.archive', rule.id],
      ['circulation.loan.create', loan.id],
      ['circulation.loan.renew', olderLoan],
      ['circulation.loan.return', loan.id],
    ]);
  },
};
