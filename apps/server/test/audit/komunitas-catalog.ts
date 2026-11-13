import { expect } from 'vitest';
import type { AreaAuditScript } from './catalog.js';

// The audit script of the bulk change of the records' accreditation fields: a super admin creates two records through
// the API, then marks both as local works by students in one bulk change, as the admin SPA's Bibliografi list does. The
// bulk route appends exactly one `catalog.record.bulk_update` entry (the creates belong to the records area's script).

const RECORDS = '/api/v1/catalog/records';

export const AUDIT: AreaAuditScript = {
  actions: ['catalog.record.bulk_update'],
  run: async (s) => {
    const buku = (await s.db.db.selectFrom('material_types').select('id').where('code_key', '=', 'BUKU').executeTakeFirstOrThrow()).id;
    const ids: string[] = [];
    for (const title of ['Kliping Hari Pahlawan', 'Kumpulan Resensi Kelas VIII']) {
      const res = await s.admin.send('post', RECORDS, { materialTypeId: buku, title });
      expect(res.status, res.text).toBe(201);
      ids.push((res.json as { id: string }).id);
    }
    const res = await s.admin.send('post', `${RECORDS}/bulk`, { ids, set: { localWork: 'student', localWorkKind: 'clipping' } });
    expect(res.status, res.text).toBe(200);
    expect(res.json).toEqual({ updated: 2, refused: [] });
    const rows = await s.db.db.selectFrom('records').select(['local_work', 'local_work_kind']).where('id', 'in', ids).execute();
    expect(rows).toEqual([
      { local_work: 'student', local_work_kind: 'clipping' },
      { local_work: 'student', local_work_kind: 'clipping' },
    ]);
  },
};
