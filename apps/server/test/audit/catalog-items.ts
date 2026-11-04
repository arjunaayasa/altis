import { newId } from '@altis/shared';
import { expect } from 'vitest';
import type { AgentReply } from '../agent.js';
import type { AreaAuditScript } from './catalog.js';

// The A10 audit script of the catalog area `items` (Phase 2 plan, Task 2 scaffold; filled by Task 17, Items API): a
// super admin adds an item to a record of a new branch, edits it, adds two more by the barcode pattern, changes them in
// bulk and archives the first, through the API as the admin SPA does. Each audited route appends exactly one entry of
// its action. The branch and the record are seeded straight into the tables (their own audit actions belong to other
// areas).

const API = '/api/v1';

/** The JSON of a reply, after checking its status. */
function ok<T>(res: AgentReply, status = 200): T {
  expect(res.status, res.text).toBe(status);
  return res.json as T;
}

export const AUDIT: AreaAuditScript = {
  actions: ['catalog.item.create', 'catalog.item.update', 'catalog.item.archive', 'catalog.item.batch_create', 'catalog.item.bulk_update'],
  run: async (s) => {
    const now = s.clock.now;
    const branchId = newId();
    const code = `EKS-${branchId.slice(-8)}`;
    await s.db.db
      .insertInto('branches')
      .values({ id: branchId, code_key: code, code_display: code, name: 'Cabang Eksemplar', timezone: 'Asia/Jakarta', created_at: now, updated_at: now })
      .execute();
    const buku = (await s.db.db.selectFrom('material_types').select('id').where('code_key', '=', 'BUKU').executeTakeFirstOrThrow()).id;
    const umum = (await s.db.db.selectFrom('collection_types').select('id').where('code_key', '=', 'UMUM').executeTakeFirstOrThrow()).id;
    const recordId = newId();
    await s.db.db
      .insertInto('records')
      .values({
        id: recordId,
        material_type_id: buku,
        title: 'Orang-Orang Bloomington',
        subtitle: null,
        responsibility: null,
        title_key: 'orang orang bloomington',
        edition: null,
        material_detail: null,
        publisher_id: null,
        publication_place: null,
        publication_year: null,
        publication_date_text: null,
        physical_desc: null,
        series: null,
        classification: null,
        call_number: '899.221 DAR o',
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
        created_at: now,
        created_by: null,
        updated_at: now,
        updated_by: null,
      })
      .execute();

    const items = `${API}/branches/${branchId}/items`;
    const first = ok<{ id: string; version: number }>(await s.admin.send('post', items, { recordId, barcode: `A10-${branchId.slice(-10)}`, collectionTypeId: umum, price: '89000' }), 201);
    const edited = ok<{ id: string; version: number }>(await s.admin.send('patch', `${items}/${first.id}`, { version: first.version, inventoryNo: 'INV/A10/1' }));
    const batch = ok<{ created: { id: string; barcode: string }[]; skipped: unknown[] }>(
      await s.admin.send('post', `${items}/batch`, { recordId, count: 2, patternId: 'default', template: { collectionTypeId: umum } }),
      201,
    );
    expect(batch.created).toHaveLength(2);
    const bulk = ok<{ updated: number; refused: unknown[] }>(await s.admin.send('post', `${items}/bulk`, { ids: batch.created.map((c) => c.id), set: { status: 'repair' } }));
    expect(bulk).toEqual({ updated: 2, refused: [] });
    ok(await s.admin.send('delete', `${items}/${first.id}`, { version: edited.version }));
    const row = await s.db.db.selectFrom('items').select(['status', 'archived_at']).where('id', '=', first.id).executeTakeFirstOrThrow();
    expect(row.status).toBe('withdrawn');
    expect(row.archived_at).not.toBeNull();
  },
};
