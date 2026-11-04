import { expect } from 'vitest';
import type { AgentReply } from '../agent.js';
import type { AreaAuditScript } from './catalog.js';

// The A10 audit script of the catalog area `authorities` (Phase 2 plan, Task 2 scaffold; filled by Task 13, Authorities
// API): a super admin creates names, subjects and a publisher, renames one, relates two subjects, merges a name into
// another, archives one and bulk-archives the orphan publisher, through the API as the admin SPA does. Each audited
// route appends exactly one entry of its action.

const API = '/api/v1/catalog';

/** The `{id, version}` of a store route's answer, after checking its status. */
function stored(res: AgentReply, status = 200): { id: string; version: number } {
  expect(res.status, res.text).toBe(status);
  return res.json as { id: string; version: number };
}

export const AUDIT: AreaAuditScript = {
  actions: ['catalog.authority.create', 'catalog.authority.update', 'catalog.authority.archive', 'catalog.authority.merge'],
  run: async (s) => {
    const variant = stored(await s.admin.send('post', `${API}/agents`, { type: 'person', name: 'Pramoedya' }), 201);
    const preferred = stored(await s.admin.send('post', `${API}/agents`, { type: 'person', name: 'Toer, Pramoedya Ananta', dates: '1925-2006' }), 201);
    const renamed = stored(await s.admin.send('patch', `${API}/agents/${preferred.id}`, { version: preferred.version, note: 'Sastrawan' }));
    stored(await s.admin.send('post', `${API}/agents/${variant.id}/merge`, { intoId: preferred.id, version: variant.version }));
    const merged = await s.db.db.selectFrom('agents').select('merged_into').where('id', '=', variant.id).executeTakeFirstOrThrow();
    expect(merged.merged_into).toBe(preferred.id);
    expect(renamed.version).toBe(preferred.version + 1);

    const narrower = stored(await s.admin.send('post', `${API}/subjects`, { type: 'topic', term: 'Novel Sejarah' }), 201);
    const broader = stored(await s.admin.send('post', `${API}/subjects`, { type: 'topic', term: 'Fiksi' }), 201);
    stored(await s.admin.send('put', `${API}/subjects/${narrower.id}/relations`, { relations: [{ rel: 'bt', subjectId: broader.id }], version: narrower.version }));
    const unused = stored(await s.admin.send('post', `${API}/subjects`, { type: 'geographic', term: 'Blora' }), 201);
    stored(await s.admin.send('delete', `${API}/subjects/${unused.id}`, { version: unused.version }));

    const orphan = stored(await s.admin.send('post', `${API}/publishers`, { name: 'Hasta Mitra', place: 'Jakarta' }), 201);
    const bulk = await s.admin.send('post', `${API}/orphans/archive`, { kind: 'publishers', ids: [orphan.id] });
    expect(bulk.status, bulk.text).toBe(200);
    expect(bulk.json).toEqual({ archived: 1, skipped: 0 });
  },
};
