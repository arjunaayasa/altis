import { expect } from 'vitest';
import type { AgentReply } from '../agent.js';
import type { AreaAuditScript } from './catalog.js';

// The A10 audit script of the catalog area `records` (Phase 2 plan, Task 2 scaffold; filled by Task 16, Records API):
// a super admin creates two records, edits one, archives and restores it, then merges the other into it, through the
// API as the admin SPA does. Each audited route appends exactly one entry of its action.

const RECORDS = '/api/v1/catalog/records';

/** The `{id, version}` of a store route's answer, after checking its status. */
function stored(res: AgentReply, status = 200): { id: string; version: number } {
  expect(res.status, res.text).toBe(status);
  return res.json as { id: string; version: number };
}

export const AUDIT: AreaAuditScript = {
  actions: ['catalog.record.create', 'catalog.record.update', 'catalog.record.archive', 'catalog.record.restore', 'catalog.record.merge'],
  run: async (s) => {
    const buku = (await s.db.db.selectFrom('material_types').select('id').where('code_key', '=', 'BUKU').executeTakeFirstOrThrow()).id;
    const target = stored(
      await s.admin.send('post', RECORDS, {
        materialTypeId: buku,
        title: 'Cantik Itu Luka',
        agents: [{ ref: { type: 'person', name: 'Kurniawan, Eka' }, role: 'aut', isMain: true }],
        identifiers: [{ type: 'isbn', value: '978-979-22-9157-5' }],
      }),
      201,
    );
    const source = stored(await s.admin.send('post', RECORDS, { materialTypeId: buku, title: 'Cantik Itu Luka (cetak ulang)' }), 201);
    const edited = stored(await s.admin.send('patch', `${RECORDS}/${target.id}`, { version: target.version, edition: 'Cet. 3' }));
    const archived = stored(await s.admin.send('delete', `${RECORDS}/${target.id}`, { version: edited.version }));
    const restored = stored(await s.admin.send('post', `${RECORDS}/${target.id}/restore`, { version: archived.version }));
    stored(await s.admin.send('post', `${RECORDS}/${target.id}/merge`, { sourceId: source.id, version: restored.version }));
    const merged = await s.db.db.selectFrom('records').select('merged_into').where('id', '=', source.id).executeTakeFirstOrThrow();
    expect(merged.merged_into).toBe(target.id);
  },
};
