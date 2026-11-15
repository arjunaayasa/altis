import { expect } from 'vitest';
import type { AreaAuditScript } from './catalog.js';

// The audit script of the SLiMS migration's cut-over checklist (Komunitas, SLiMS members and circulation). A super
// admin, through the API as the Migrasi SLiMS screen does: reads the checklist, marks the reprint list opened
// (`catalog.migration.cutover {step: reprint_opened}`), and is refused "Mulai melayani" (422, nothing audited) while a
// required item does not hold: this installation has no desk staff of its own and no guestbook station.

const API = '/api/v1/catalog/migrations/slims/cutover';

export const AUDIT: AreaAuditScript = {
  actions: ['catalog.migration.cutover'],
  run: async (s) => {
    const view = await s.admin.send('get', API);
    expect(view.status, view.text).toBe(200);
    expect(view.json).toMatchObject({ ready: false, stocktakeAvailable: false });
    const reauth = await s.admin.send('post', '/api/v1/auth/reauth', { password: s.admin.password });
    expect(reauth.status, reauth.text).toBeLessThan(300);
    const reprint = await s.admin.send('post', `${API}/steps`, { step: 'reprint_opened' });
    expect(reprint.status, reprint.text).toBe(200);
    expect((reprint.json as { reprintOpenedAt: number | null }).reprintOpenedAt).not.toBeNull();
    const serve = await s.admin.send('post', `${API}/steps`, { step: 'serve' });
    expect(serve.status, serve.text).toBe(422);
    const entries = await s.db.db.selectFrom('audit_log').select(['entity_id', 'actor_type']).where('action', '=', 'catalog.migration.cutover').execute();
    expect(entries).toEqual([{ entity_id: 'reprint_opened', actor_type: 'staff' }]);
  },
};
