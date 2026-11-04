import { expect } from 'vitest';
import type { AgentReply } from '../agent.js';
import type { AreaAuditScript } from './catalog.js';

// The A10 audit script of the catalog area `attachments` (Phase 2 plan, Task 2 scaffold; filled by Task 18,
// Attachments, covers and /files): a super admin uploads a PDF through the chunked upload API, attaches it to a new
// record, makes it staff-only, then archives it, as the admin's attachments panel does. Each audited route appends
// exactly one entry of its action; the file's access follows the attachment's at every step.

const RECORDS = '/api/v1/catalog/records';
const ATTACHMENTS = '/api/v1/catalog/attachments';

/** The `{id, version}` of a store route's answer, after checking its status. */
function stored(res: AgentReply, status = 200): { id: string; version: number } {
  expect(res.status, res.text).toBe(status);
  return res.json as { id: string; version: number };
}

/** A small PDF (magic `%PDF-`). */
const PDF = new Uint8Array(Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n', 'latin1'));

export const AUDIT: AreaAuditScript = {
  actions: ['catalog.attachment.create', 'catalog.attachment.update', 'catalog.attachment.archive'],
  run: async (s) => {
    const buku = (await s.db.db.selectFrom('material_types').select('id').where('code_key', '=', 'BUKU').executeTakeFirstOrThrow()).id;
    const record = stored(await s.admin.send('post', RECORDS, { materialTypeId: buku, title: 'Bumi Manusia (lampiran)' }), 201);
    const uploaded = await s.admin.upload('catalog.attachment', PDF, 'bab-1.pdf');
    expect('fileId' in uploaded).toBe(true);
    const fileId = (uploaded as { fileId: string }).fileId;
    const fileAccess = async (): Promise<string> => (await s.db.db.selectFrom('files').select('access').where('id', '=', fileId).executeTakeFirstOrThrow()).access;

    const created = stored(
      await s.admin.send('post', `${RECORDS}/${record.id}/attachments`, { kind: 'file', fileId, title: 'Bab 1', access: 'public' }),
      201,
    );
    expect(await fileAccess()).toBe('public');
    const updated = stored(await s.admin.send('patch', `${ATTACHMENTS}/${created.id}`, { version: created.version, access: 'staff' }));
    expect(await fileAccess()).toBe('staff');
    stored(await s.admin.send('delete', `${ATTACHMENTS}/${created.id}`, { version: updated.version }));
    const row = await s.db.db.selectFrom('attachments').select(['archived_at', 'access']).where('id', '=', created.id).executeTakeFirstOrThrow();
    expect([row.archived_at !== null, row.access]).toEqual([true, 'staff']);
  },
};
