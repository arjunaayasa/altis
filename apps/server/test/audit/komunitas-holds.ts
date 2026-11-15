import { enqueue } from '@altis/core';
import { withTx } from '@altis/db';
import { addDays, localDate, newId } from '@altis/shared';
import { expect } from 'vitest';
import type { AgentReply } from '../agent.js';
import type { AreaAuditScript, AuditScriptContext } from './catalog.js';

// The audit script of holds and the hold shelf: a super admin, at the desk of a new branch, places a hold for a member
// on a title whose only copy is out, takes the copy back (it is kept for the member), cancels that hold (the copy is
// listed to go back to the shelf) and clears it from the hold shelf; marks another member's waiting hold ready by
// scanning a copy on the shelf; then that hold's pickup deadline passes and the scheduled job expires it. The branch,
// records, items, members, the loan and the second hold are seeded straight into the tables.

const API = '/api/v1';
const DAY = 86_400_000;

function ok<T>(res: AgentReply, status = 200): T {
  expect(res.status, res.text).toBe(status);
  return res.json as T;
}

const trail = (now: number) => ({ created_at: now, created_by: null, updated_at: now, updated_by: null });

/** An available copy of a new record in `branchId`. */
async function seedCopy(s: AuditScriptContext, branchId: string, title: string): Promise<{ id: string; recordId: string; barcode: string }> {
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
  const barcode = `RSV-${id.slice(-10)}`;
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

/** An active member of type SISWA; its id. */
async function seedMember(s: AuditScriptContext, no: string, today: string): Promise<string> {
  const id = newId();
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
      name: `Pemesan ${no}`,
      name_key: `pemesan ${no.toLowerCase()}`,
      gender: null,
      birth_date: null,
      identity_no: null,
      institution: null,
      class_name: '9B',
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
      ...trail(s.clock.now),
    })
    .execute();
  return id;
}

export const AUDIT: AreaAuditScript = {
  actions: ['circulation.hold.create', 'circulation.hold.cancel', 'circulation.hold.ready', 'circulation.hold.shelf_clear', 'circulation.holds.run'],
  run: async (s) => {
    const now = s.clock.now;
    const today = localDate('Asia/Jakarta', now);
    const branchId = newId();
    const code = `RSV-${branchId.slice(-8)}`;
    await s.db.db
      .insertInto('branches')
      .values({ id: branchId, code_key: code, code_display: code, name: 'Cabang Reservasi', timezone: 'Asia/Jakarta', created_at: now, updated_at: now })
      .execute();
    const holder = await seedMember(s, 'AUDIT-RSV-1', today);
    const borrower = await seedMember(s, 'AUDIT-RSV-2', today);
    const out = await seedCopy(s, branchId, 'Bumi Manusia');
    const shelf = await seedCopy(s, branchId, 'Anak Semua Bangsa');
    const policy = (await s.db.db.selectFrom('policies').select('id').where('code_key', '=', 'DEFAULT').executeTakeFirstOrThrow()).id;
    await s.db.db
      .insertInto('loans')
      .values({
        id: newId(),
        item_id: out.id,
        open_item_id: out.id,
        record_id: out.recordId,
        member_id: borrower,
        branch_id: branchId,
        policy_id: policy,
        loaned_on: addDays(today, -3),
        loaned_at: now - 3 * DAY,
        due_on: addDays(today, 4),
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
        ...trail(now - 3 * DAY),
      })
      .execute();
    const waitingId = newId();
    await s.db.db
      .insertInto('holds')
      .values({
        id: waitingId,
        record_id: shelf.recordId,
        item_id: null,
        member_id: borrower,
        pickup_branch_id: branchId,
        status: 'waiting',
        active_key: `${borrower}:${shelf.recordId}`,
        trap_item_id: null,
        placed_on: addDays(today, -1),
        placed_at: now - DAY,
        placed_by: null,
        source: 'desk',
        expires_on: null,
        ready_at: null,
        pickup_until: null,
        closed_at: null,
        close_reason: null,
        shelf_cleared_at: null,
        loan_id: null,
        ...trail(now - DAY),
      })
      .execute();

    const desk = `${API}/branches/${branchId}/circulation`;
    const placed = ok<{ id: string; status: string; position: number }>(await s.admin.send('post', `${desk}/holds`, { memberId: holder, recordId: out.recordId }), 201);
    expect([placed.status, placed.position]).toEqual(['waiting', 1]);
    const back = ok<{ hold?: { holdId: string; memberNo: string } }>(await s.admin.send('post', `${desk}/returns`, { barcode: out.barcode }));
    expect([back.hold?.holdId, back.hold?.memberNo]).toEqual([placed.id, 'AUDIT-RSV-1']);
    ok(await s.admin.send('post', `${desk}/holds/${placed.id}/cancel`));
    ok(await s.admin.send('post', `${desk}/hold-shelf/${placed.id}/clear`));
    const ready = ok<{ status: string; pickupUntil: string }>(await s.admin.send('post', `${desk}/holds/${waitingId}/ready`, { barcode: shelf.barcode }));
    expect(ready.status).toBe('ready');

    // The pickup deadline passes: the scheduled job expires the hold and writes one entry for its run.
    await s.db.db.updateTable('holds').set({ pickup_until: addDays(today, -1) }).where('id', '=', waitingId).execute();
    const seq = Number((await s.db.db.selectFrom('audit_head').select('last_seq').where('id', '=', 1).executeTakeFirstOrThrow()).last_seq);
    const job = await withTx(s.db, (trx) =>
      enqueue(trx, s.jobs.registry, { type: 'circulation.holds', payload: { windowStart: now - DAY, windowEnd: now } }, { now: s.clock.now, keyring: s.config.keyring }),
    );
    for (let n = 0; n < 10; n += 1) {
      const slice = await s.jobs.drive(job.id, { budgetMs: 20_000 });
      if (slice === null || slice.outcome !== 'continued') break;
    }
    expect((await s.db.db.selectFrom('holds').select('status').where('id', '=', waitingId).executeTakeFirstOrThrow()).status).toBe('expired');

    const entries = await s.db.db.selectFrom('audit_log').select(['action', 'entity_id']).where('entity_id', 'in', [placed.id, waitingId]).orderBy('seq').execute();
    expect(entries.map((e) => [e.action, e.entity_id])).toEqual([
      ['circulation.hold.create', placed.id],
      ['circulation.hold.cancel', placed.id],
      ['circulation.hold.shelf_clear', placed.id],
      ['circulation.hold.ready', waitingId],
    ]);
    const run = await s.db.db.selectFrom('audit_log').select(['action', 'meta']).where('seq', '>', seq).where('action', '=', 'circulation.holds.run').execute();
    expect(run).toHaveLength(1);
  },
};
