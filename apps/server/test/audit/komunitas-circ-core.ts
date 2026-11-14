import { addDays, localDate, newId } from '@altis/shared';
import { expect } from 'vitest';
import type { AgentReply } from '../agent.js';
import type { AreaAuditScript, AuditScriptContext } from './catalog.js';

// The audit script of the circulation core: a super admin, through the API as the admin does, adds closed days to the
// library calendar, edits and removes them; at the desk of a new branch voids a loan made a moment ago, declares a loan
// lost and changes the due date of a third; then issues a clearance letter to a member without loans and voids it. The
// branch, the records, the items, the members and the loans are seeded straight into the tables (their own actions
// belong to other areas). Each audited route appends exactly one entry of its action.

const API = '/api/v1';

/** The JSON of a reply, after checking its status. */
function ok<T>(res: AgentReply, status = 200): T {
  expect(res.status, res.text).toBe(status);
  return res.json as T;
}

const trail = (now: number) => ({ created_at: now, created_by: null, updated_at: now, updated_by: null });

/** An available item of a new record in `branchId`, priced 45 000.00; its id and record id. */
async function seedItem(s: AuditScriptContext, branchId: string, title: string): Promise<{ id: string; recordId: string }> {
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
  const barcode = `INTI-${id.slice(-10)}`;
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
      price: 4_500_000,
      currency: 'IDR',
      note: null,
      archived_at: null,
      ...trail(now),
    })
    .execute();
  return { id, recordId };
}

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

/** An open loan of `item` to `memberId` in `branchId`, made `ago` ms before the clock; its id. */
async function seedLoan(s: AuditScriptContext, i: { branchId: string; memberId: string; item: { id: string; recordId: string }; ago: number }): Promise<string> {
  const now = s.clock.now;
  const today = localDate('Asia/Jakarta', now - i.ago);
  const id = newId();
  await s.db.db
    .insertInto('loans')
    .values({
      id,
      item_id: i.item.id,
      open_item_id: i.item.id,
      record_id: i.item.recordId,
      member_id: i.memberId,
      branch_id: i.branchId,
      policy_id: null,
      loaned_on: today,
      loaned_at: now - i.ago,
      due_on: addDays(today, 7),
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
      stat_member_type_id: null,
      stat_accred_group: null,
      stat_class_name: null,
      version: 0,
      ...trail(now - i.ago),
    })
    .execute();
  return id;
}

export const AUDIT: AreaAuditScript = {
  actions: [
    'circulation.loan.void',
    'circulation.loan.lost',
    'circulation.loan.due_change',
    'circulation.calendar.create',
    'circulation.calendar.update',
    'circulation.calendar.archive',
    'members.clearance.issue',
    'members.clearance.void',
  ],
  run: async (s) => {
    const now = s.clock.now;
    const rule = ok<{ id: string; version: number }>(
      await s.admin.send('post', `${API}/circulation/calendar`, { kind: 'yearly', name: 'Tahun Baru', monthDayFrom: '01-01' }),
      201,
    );
    const ruleV = ok<{ version: number }>(await s.admin.send('patch', `${API}/circulation/calendar/${rule.id}`, { version: rule.version, monthDayTo: '01-02' }));
    ok(await s.admin.send('delete', `${API}/circulation/calendar/${rule.id}`, { version: ruleV.version }));

    const branchId = newId();
    const code = `INTI-${branchId.slice(-8)}`;
    await s.db.db
      .insertInto('branches')
      .values({ id: branchId, code_key: code, code_display: code, name: 'Cabang Inti', timezone: 'Asia/Jakarta', created_at: now, updated_at: now })
      .execute();
    const borrower = await seedMember(s, 'AUDIT-INTI-1');
    const wrongScan = await seedLoan(s, { branchId, memberId: borrower, item: await seedItem(s, branchId, 'Bumi Manusia'), ago: 60_000 });
    const lostLoan = await seedLoan(s, { branchId, memberId: borrower, item: await seedItem(s, branchId, 'Anak Semua Bangsa'), ago: 3 * 86_400_000 });
    const lateLoan = await seedLoan(s, { branchId, memberId: borrower, item: await seedItem(s, branchId, 'Jejak Langkah'), ago: 86_400_000 });

    const desk = `${API}/branches/${branchId}/circulation`;
    ok(await s.admin.send('post', `${desk}/loans/${wrongScan}/void`));
    const lost = ok<{ replacement: string; itemStatus: string }>(await s.admin.send('post', `${desk}/loans/${lostLoan}/lost`, {}));
    expect(lost).toMatchObject({ replacement: '45000.00', itemStatus: 'lost' });
    const due = addDays(localDate('Asia/Jakarta', now), 14);
    ok(await s.admin.send('patch', `${desk}/loans/${lateLoan}/due`, { dueOn: due, note: 'Ujian sekolah' }));

    const graduate = await seedMember(s, 'AUDIT-INTI-2');
    const pdf = await s.admin.send('post', `${API}/members/clearances`, { memberIds: [graduate], purpose: 'graduation' });
    expect(pdf.status, pdf.text).toBe(200);
    const letter = await s.db.db.selectFrom('member_clearances').select(['id', 'number_display']).where('member_id', '=', graduate).executeTakeFirstOrThrow();
    expect(letter.number_display).toMatch(/^BP\/\d{4}\/\d{4,}$/);
    ok(await s.admin.send('post', `${API}/members/${graduate}/clearances/${letter.id}/void`, { reason: 'Salah nama' }));

    const entries = await s.db.db
      .selectFrom('audit_log')
      .select(['action', 'entity_id'])
      .where((eb) =>
        eb.or([
          eb('entity_id', 'in', [rule.id, wrongScan, lostLoan, lateLoan, letter.id]),
          eb.and([eb('action', '=', 'members.clearance.issue'), eb('at', '>=', now)]),
        ]),
      )
      .orderBy('seq')
      .execute();
    expect(entries.map((e) => [e.action, e.entity_id])).toEqual([
      ['circulation.calendar.create', rule.id],
      ['circulation.calendar.update', rule.id],
      ['circulation.calendar.archive', rule.id],
      ['circulation.loan.void', wrongScan],
      ['circulation.loan.lost', lostLoan],
      ['circulation.loan.due_change', lateLoan],
      ['members.clearance.issue', null],
      ['members.clearance.void', letter.id],
    ]);
  },
};
