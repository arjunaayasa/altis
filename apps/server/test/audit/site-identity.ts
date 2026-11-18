import type { SiteIdentityView } from '@altis/shared/api/site-identity';
import { expect } from 'vitest';
import { solidPng } from '../../../../packages/core/test/fixtures/png.js';
import { createAgent, type AgentReply } from '../agent.js';
import type { AreaAuditScript } from './catalog.js';

// The audit script of the site identity: a super admin, through the API as the screen OPAC › Identitas situs does,
// uploads a logo (`site.logo`, a PNG), reads the identity, saves it with the logo and a name (`site.identity.update`,
// the changed fields by name), and sees the logo served to a visitor as a public PNG. A save at the old revision is
// then refused (409, nothing audited).

const API = '/api/v1/site/identity';

function ok<T>(res: AgentReply, status = 200): T {
  expect(res.status, res.text).toBe(status);
  return res.json as T;
}

export const AUDIT: AreaAuditScript = {
  actions: ['site.identity.update'],
  run: async (s) => {
    const uploaded = await s.admin.upload('site.logo', solidPng(400, 120), 'logo.png');
    expect('fileId' in uploaded).toBe(true);
    const fileId = (uploaded as { fileId: string }).fileId;

    const view = ok<SiteIdentityView>(await s.admin.send('get', API));
    const body = { revision: view.revision, identity: { ...view.identity, logo: { fileId, alt: 'Logo perpustakaan' }, name: 'Pustaka Audit' } };
    const saved = ok<{ revision: string; changed: string[] }>(await s.admin.send('put', API, body));
    expect(saved.changed).toEqual(['logo', 'name']);
    expect(saved.revision).not.toBe(view.revision);

    const entries = await s.db.db.selectFrom('audit_log').select(['actor_type', 'meta']).where('action', '=', 'site.identity.update').execute();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.actor_type).toBe('staff');
    expect(JSON.parse(String(entries[0]!.meta))).toEqual({ fields: ['logo', 'name'], first: !view.saved });

    const logo = await createAgent(s.app, { peer: '198.51.100.241' }).get(`/files/${fileId}`);
    expect(logo.status).toBe(200);
    expect(logo.headers.get('content-type')).toBe('image/png');
    expect(logo.headers.get('x-content-type-options')).toBe('nosniff');
    expect(logo.headers.get('cache-control')).toBe('public, max-age=86400');

    const stale = await s.admin.send('put', API, body);
    expect(stale.status, stale.text).toBe(409);
    expect((stale.json as { code: string }).code).toBe('CONFLICT_STALE');
  },
};
