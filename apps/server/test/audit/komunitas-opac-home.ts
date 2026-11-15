import type { OpacHomeView } from '@altis/shared/api/opac-home';
import { expect } from 'vitest';
import { createAgent, type AgentReply } from '../agent.js';
import { sizedJpeg } from '../../../../packages/core/test/fixtures/sized-jpeg.js';
import type { AreaAuditScript } from './catalog.js';

// The audit script of the OPAC home page: a super admin, through the API as the screen OPAC › Halaman awal does, uploads
// a hero photo (`opac.home_photo`, a 1600 × 900 JPEG), reads the page, saves it with the photo, a heading and the
// welcome text (`opac.home.update`, the changed settings by name), and sees the photo served to a visitor as a public
// file. A save at the old revision is then refused (409, nothing audited).

const API = '/api/v1/opac/home';

function ok<T>(res: AgentReply, status = 200): T {
  expect(res.status, res.text).toBe(status);
  return res.json as T;
}

export const AUDIT: AreaAuditScript = {
  actions: ['opac.home.update'],
  run: async (s) => {
    const uploaded = await s.admin.upload('opac.home_photo', sizedJpeg(1600, 900), 'gedung.jpg');
    expect('fileId' in uploaded).toBe(true);
    const fileId = (uploaded as { fileId: string }).fileId;

    const view = ok<OpacHomeView>(await s.admin.send('get', API));
    const body = {
      revision: view.revision,
      home: { ...view.home, title: 'Ruang baca untuk semua', hero: { fileId, alt: 'Gedung perpustakaan', position: 40 } },
      welcome: { id: 'Selamat datang di perpustakaan.', en: view.welcome.en },
    };
    const saved = ok<{ revision: string; changed: string[] }>(await s.admin.send('put', API, body));
    expect(saved.changed).toEqual(['opac.welcome.id', 'opac.home']);
    expect(saved.revision).not.toBe(view.revision);

    const entries = await s.db.db.selectFrom('audit_log').select(['actor_type', 'meta']).where('action', '=', 'opac.home.update').execute();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.actor_type).toBe('staff');
    expect(JSON.parse(String(entries[0]!.meta))).toEqual({ keys: ['opac.welcome.id', 'opac.home'] });

    const photo = await createAgent(s.app, { peer: '198.51.100.240' }).get(`/files/${fileId}`);
    expect(photo.status).toBe(200);
    expect(photo.headers.get('cache-control')).toBe('public, max-age=86400');

    const stale = await s.admin.send('put', API, body);
    expect(stale.status, stale.text).toBe(409);
    expect((stale.json as { code: string }).code).toBe('CONFLICT_STALE');
  },
};
