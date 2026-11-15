import { newId } from '@altis/shared';
import { expect } from 'vitest';
import type { AgentReply } from '../agent.js';
import type { AreaAuditScript, AuditScriptContext } from './catalog.js';

// The audit script of stocktake: on a branch of its own with two copies, a super admin creates a session (its
// preparation job is driven to the end), another officer scans one copy and the super admin undoes that scan (another
// officer's scan), uploads a code list, cancels nothing, finishes the session (re-authenticated), then creates and
// cancels a second one. Every action once, in that order.

const API = '/api/v1';

function ok<T>(res: AgentReply, status = 200): T {
  expect(res.status, res.text).toBe(status);
  return res.json as T;
}

/** A branch with a record and two available copies; the branch id and the copies' barcodes. */
async function seedBranch(s: AuditScriptContext): Promise<{ branchId: string; barcodes: string[] }> {
  const now = s.clock.now;
  const db = s.db.db;
  const branchId = newId();
  const code = `INV-${branchId.slice(-8)}`;
  await db.insertInto('branches').values({ id: branchId, code_key: code, code_display: code, name: 'Cabang Inventarisasi', timezone: 'Asia/Jakarta', created_at: now, updated_at: now }).execute();
  const buku = (await db.selectFrom('material_types').select('id').where('code_key', '=', 'BUKU').executeTakeFirstOrThrow()).id;
  const umum = (await db.selectFrom('collection_types').select('id').where('code_key', '=', 'UMUM').executeTakeFirstOrThrow()).id;
  const recordId = newId();
  await db
    .insertInto('records')
    .values({
      id: recordId,
      material_type_id: buku,
      title: 'Cantuman Inventarisasi',
      subtitle: null,
      responsibility: null,
      title_key: 'cantuman inventarisasi',
      edition: null,
      material_detail: null,
      publisher_id: null,
      publication_place: null,
      publication_year: null,
      publication_date_text: null,
      physical_desc: null,
      series: null,
      classification: '500',
      call_number: '500 INV',
      language_id: null,
      content_type: null,
      media_type: null,
      carrier_type: null,
      summary: null,
      notes: null,
      cover_file_id: null,
      opac_visible: 1,
      promoted: 0,
      source: 'manual',
      merged_into: null,
      changed_at: now,
      audience: null,
      local_work: null,
      local_work_kind: null,
      reference_kind: null,
      archived_at: null,
      version: 0,
      created_at: now,
      created_by: null,
      updated_at: now,
      updated_by: null,
    })
    .execute();
  const barcodes: string[] = [];
  for (let n = 1; n <= 2; n += 1) {
    const barcode = `INV${branchId.slice(-6)}${n}`;
    barcodes.push(barcode);
    await db
      .insertInto('items')
      .values({
        id: newId(),
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
        parts_total: 1,
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
        input_on: null,
        archived_at: null,
        version: 0,
        created_at: now,
        created_by: null,
        updated_at: now,
        updated_by: null,
      })
      .execute();
  }
  return { branchId, barcodes };
}

/** Drives the job `jobId` to its end. */
async function drive(s: AuditScriptContext, jobId: string): Promise<void> {
  for (let n = 0; n < 20; n += 1) {
    const slice = await s.jobs.drive(jobId, { budgetMs: 20_000 });
    if (slice === null || slice.outcome !== 'continued') break;
  }
}

export const AUDIT: AreaAuditScript = {
  actions: ['stocktake.session.create', 'stocktake.session.finish', 'stocktake.session.cancel', 'stocktake.upload', 'stocktake.scan.cancel_other'],
  run: async (s) => {
    const { branchId, barcodes } = await seedBranch(s);
    const base = `${API}/branches/${branchId}/stocktakes`;
    const seq = Number((await s.db.db.selectFrom('audit_head').select('last_seq').where('id', '=', 1).executeTakeFirstOrThrow()).last_seq);

    const created = ok<{ id: string; jobId: string }>(await s.admin.send('post', base, { name: 'Audit Inventarisasi', scope: {} }), 201);
    await drive(s, created.jobId);
    expect(ok<{ status: string; counts: { total: number } }>(await s.admin.send('get', `${base}/${created.id}`))).toMatchObject({ status: 'active', counts: { total: 2 } });

    const officer = await s.signIn(['stocktake.scan.use']);
    const scanned = ok<{ outcome: string; item: { id: string } }>(await officer.send('post', `${base}/${created.id}/scans`, { barcode: barcodes[0] }));
    expect(scanned.outcome).toBe('found');
    expect(ok<{ undone: boolean }>(await s.admin.send('delete', `${base}/${created.id}/scans/${scanned.item.id}`))).toMatchObject({ undone: true });

    const staged = await s.admin.upload('stocktake.codes', new TextEncoder().encode(`${barcodes[1]}\nTIDAK-ADA\n`), 'kode.txt');
    expect('uploadId' in staged).toBe(true);
    const upload = ok<{ jobId: string }>(await s.admin.send('post', `${base}/${created.id}/uploads`, { uploadId: (staged as { uploadId: string }).uploadId }), 202);
    await drive(s, upload.jobId);

    const reauth = await s.admin.send('post', `${API}/auth/reauth`, { password: s.admin.password });
    expect(reauth.status, reauth.text).toBeLessThan(300);
    const finish = ok<{ jobId: string }>(await s.admin.send('post', `${base}/${created.id}/finish`, { confirmName: 'Audit Inventarisasi', markMissing: true, restoreFound: true }), 202);
    await drive(s, finish.jobId);
    expect(ok<{ status: string; counts: { found: number; unknownCodes: number } }>(await s.admin.send('get', `${base}/${created.id}`))).toMatchObject({
      status: 'finished',
      counts: { found: 1, unknownCodes: 1 },
    });

    const second = ok<{ id: string }>(await s.admin.send('post', base, { name: 'Audit Batal', scope: {} }), 201);
    ok(await s.admin.send('post', `${base}/${second.id}/cancel`));

    const entries = await s.db.db
      .selectFrom('audit_log')
      .select(['action', 'branch_id'])
      .where('seq', '>', seq)
      .where('action', 'like', 'stocktake.%')
      .orderBy('seq')
      .execute();
    expect(entries.map((e) => e.action)).toEqual([
      'stocktake.session.create',
      'stocktake.scan.cancel_other',
      'stocktake.upload',
      'stocktake.session.finish',
      'stocktake.session.create',
      'stocktake.session.cancel',
    ]);
    expect(entries.every((e) => e.branch_id === branchId)).toBe(true);
  },
};
