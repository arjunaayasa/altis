import { expect } from 'vitest';
import type { AgentReply } from '../agent.js';
import type { AreaAuditScript } from './catalog.js';

// The A10 audit script of the area `pages` (Phase 2 plan, Task 2 scaffold; filled by Task 20, Halaman & Berita). A super
// admin, through the API as the page editor does: uploads a page image through the chunked upload API, creates a news
// post whose Markdown body shows it, edits the post (an English translation), then archives it. Each audited route
// appends exactly one entry of its action (entity `pages`); the image becomes the page's, public.

const PAGES = '/api/v1/opac/pages';

/** The `{id, version}` of a store route's answer, after checking its status. */
function stored(res: AgentReply, status = 200): { id: string; version: number } {
  expect(res.status, res.text).toBe(status);
  return res.json as { id: string; version: number };
}

/** A transparent 1×1 GIF (a GIF page image is stored as it came). */
const GIF = new Uint8Array([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0x21, 0xf9, 0x04, 0x01, 0x00,
  0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b,
]);

export const AUDIT: AreaAuditScript = {
  actions: ['opac.page.create', 'opac.page.update', 'opac.page.archive'],
  run: async (s) => {
    const uploaded = await s.admin.upload('opac.page_image', GIF, 'gedung.gif');
    expect('fileId' in uploaded).toBe(true);
    const fileId = (uploaded as { fileId: string }).fileId;

    const created = stored(
      await s.admin.send('post', PAGES, {
        kind: 'news',
        slug: 'perpustakaan-pindah-gedung',
        status: 'published',
        showInNav: false,
        sortOrder: 0,
        translations: { id: { title: 'Perpustakaan pindah gedung', bodyFormat: 'markdown', body: `Mulai Senin kami melayani di gedung baru.\n\n![Gedung baru](/files/${fileId})` } },
      }),
      201,
    );
    const file = await s.db.db.selectFrom('files').select(['owner_type', 'owner_id', 'access']).where('id', '=', fileId).executeTakeFirstOrThrow();
    expect(file).toEqual({ owner_type: 'pages', owner_id: created.id, access: 'public' });

    const updated = stored(
      await s.admin.send('patch', `${PAGES}/${created.id}`, {
        version: created.version,
        translations: { en: { title: 'The library moves', bodyFormat: 'markdown', body: 'From Monday we serve you in the new building.' } },
      }),
    );
    stored(await s.admin.send('delete', `${PAGES}/${created.id}`, { version: updated.version }));

    const entries = await s.db.db.selectFrom('audit_log').select(['action', 'entity']).where('entity_id', '=', created.id).orderBy('seq').execute();
    expect(entries).toEqual([
      { action: 'opac.page.create', entity: 'pages' },
      { action: 'opac.page.update', entity: 'pages' },
      { action: 'opac.page.archive', entity: 'pages' },
    ]);
  },
};
