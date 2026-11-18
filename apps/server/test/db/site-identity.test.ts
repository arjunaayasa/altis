import { createHash } from 'node:crypto';
import { defaultSiteIcon, readOpacHome, writeSettings } from '@altis/core';
import { withTx } from '@altis/db';
import type { SiteIdentityPublic, SiteIdentityView } from '@altis/shared/api/site-identity';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodePng } from '../../../../packages/core/src/files/png.js';
import { gradientPng, solidPng } from '../../../../packages/core/test/fixtures/png.js';
import { sizedJpeg } from '../../../../packages/core/test/fixtures/sized-jpeg.js';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import { createAgent, type AgentReply } from '../agent.js';
import { recordingLogger } from '../support.js';
import { openK1Installation, type K1Browser, type K1Installation } from './k1-support.js';

// The site identity through the app on the engine picked by ALTIS_TEST_DB: the admin screen's API (permission, the
// defaults read from the home page's old logo, a save with its revision, validation, audit), the uploads of the logo
// and the icon, what a visitor without a session may read, the site icon in each size (the built-in one until the
// library sets its own), and the OPAC page showing the identity's logo and linking the icon.

const ctx = testDbContext();
const API = '/api/v1/site/identity';
const HTML = { Accept: 'text/html' };

describe.skipIf(!ctx.available)(`the site identity API [${engineLabel()}]`, () => {
  let k: K1Installation;
  let admin: K1Browser;
  let editor: K1Browser;
  let outsider: K1Browser;
  let peer = 0;
  const visitor = (): ReturnType<typeof createAgent> => {
    peer += 1;
    return createAgent(k.app, { peer: `198.18.41.${(peer % 250) + 1}` });
  };
  const ok = <T>(res: AgentReply, status = 200): T => {
    expect(res.status, res.text).toBe(status);
    return res.json as T;
  };
  /** `GET url` as a visitor, the body as bytes. */
  async function bytes(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: Buffer; headers: Headers }> {
    const res = await k.app.request(url, { method: 'GET', headers }, { incoming: { socket: { remoteAddress: '198.18.42.7' } } });
    return { status: res.status, body: Buffer.from(await res.arrayBuffer()), headers: res.headers };
  }
  let oldLogo = '';

  beforeAll(async () => {
    k = await openK1Installation({ prefix: 'site-identity', baseUrl: 'https://pustaka.contoh.example', log: recordingLogger() });
    await withTx(k.h, (trx) => writeSettings(trx, { 'library.name': 'Perpustakaan Kenari' }, { keyring: k.config.keyring, now: k.clock.now, actorId: null }).then(() => undefined));
    admin = await k.browser(await k.staff('kepala', 'super_admin'));
    editor = await k.browser(await k.staff('penyunting', ['opac.pages.manage']));
    outsider = await k.browser(await k.staff('sirkulasi', ['catalog.records.manage']));
    // The home page holds a logo, as a site saved before the identity existed.
    oldLogo = (await admin.upload('opac.home_photo', sizedJpeg(480, 240), 'logo.jpg')).fileId!;
    const home = await readOpacHome(k.h.db);
    ok(await admin.send('put', '/api/v1/opac/home', { revision: home.revision, home: { ...home.home, logo: { fileId: oldLogo, alt: 'Logo lama' } }, welcome: home.welcome }));
  });

  afterAll(async () => {
    await k?.close();
  });

  it('needs a session and `opac.pages.manage`: 401 without a session, 403 without the permission, for reading, saving and uploading', async () => {
    expect((await visitor().get(API)).status).toBe(401);
    expect((await outsider.send('get', API)).status).toBe(403);
    const state = ok<SiteIdentityView>(await editor.send('get', API));
    const put = await outsider.send('put', API, { revision: state.revision, identity: state.identity });
    expect(put.status, put.text).toBe(403);
    for (const context of ['site.logo', 'site.icon']) {
      const declared = await outsider.send('post', '/api/v1/files/uploads', { context, size: 100, sha256: '0'.repeat(64) });
      expect(declared.status, declared.text).toBe(403);
    }
    expect((await readOpacHome(k.h.db)).home.logo).toEqual({ fileId: oldLogo, alt: 'Logo lama' });
  });

  it('before the first save: the old logo of the home page, the library\'s name, the built-in icon; the OPAC shows the same', async () => {
    const view = ok<SiteIdentityView>(await editor.send('get', API));
    expect(view).toEqual({
      identity: { logo: { fileId: oldLogo, alt: 'Logo lama' }, logoDark: null, icon: null, name: null, tagline: { id: null, en: null }, showNameBesideLogo: true },
      saved: false,
      revision: expect.stringMatching(/^[0-9a-f]{16}$/) as string,
      libraryName: 'Perpustakaan Kenari',
      urls: { logo: `/files/${oldLogo}`, logoDark: null, icon: { 32: '/site-icon/32.png', 180: '/site-icon/180.png', 192: '/site-icon/192.png' } },
    });
    const html = (await visitor().get('/', undefined, HTML)).text;
    expect(html).toContain(`src="/files/${oldLogo}" alt="Logo lama"`);
    expect(html).toContain('<link rel="icon" type="image/png" sizes="32x32" href="/site-icon/32.png"/>');
    expect(html).toContain('<link rel="apple-touch-icon" href="/site-icon/180.png"/>');
    expect(html).not.toContain('href="data:,"');
  });

  it('a visitor without a session reads the public identity, and nothing else', async () => {
    const res = await visitor().get(`${API}/public`);
    const body = ok<SiteIdentityPublic>(res);
    expect(body).toEqual({
      name: 'Perpustakaan Kenari',
      tagline: { id: null, en: null },
      showNameBesideLogo: true,
      logo: { url: `/files/${oldLogo}`, alt: 'Logo lama' },
      logoDark: null,
      hasIcon: false,
      icon: { 32: '/site-icon/32.png', 180: '/site-icon/180.png', 192: '/site-icon/192.png' },
    });
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.text).not.toMatch(/revision|fileId|libraryName/);
  });

  it('the site icon answers the built-in PNG in each size until the library sets one: typed, not sniffed, revalidated by its ETag', async () => {
    for (const size of [32, 180, 192] as const) {
      const res = await bytes(`/site-icon/${size}.png`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('cache-control')).toBe('public, max-age=300');
      expect(res.body.equals(Buffer.from(defaultSiteIcon(size)))).toBe(true);
      expect(decodePng(res.body, { maxSide: 4000 })).toMatchObject({ width: size, height: size });
      const etag = res.headers.get('etag')!;
      expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
      const again = await bytes(`/site-icon/${size}.png`, { 'If-None-Match': etag });
      expect(again.status).toBe(304);
      expect(again.body.byteLength).toBe(0);
    }
    for (const file of ['64.png', '32.svg', '32', 'favicon.ico']) expect((await bytes(`/site-icon/${file}`)).status, file).toBe(404);
  });

  it('an upload above 1 MiB is refused when it is declared; an SVG never becomes a file', async () => {
    const big = await editor.send('post', '/api/v1/files/uploads', { context: 'site.logo', size: 1024 * 1024 + 1, sha256: '0'.repeat(64) });
    expect(big.status, big.text).toBe(413);
    expect((big.json as { code: string }).code).toBe('UPLOAD_TOO_LARGE');

    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const declared = ok<{ id: string }>(await editor.send('post', '/api/v1/files/uploads', { context: 'site.logo', size: svg.byteLength, sha256: createHash('sha256').update(svg).digest('hex') }), 201);
    // Whatever the upload is called, the type is read from its bytes at completion (the chunk is sent by the helper below).
    await expect(editor.upload('site.logo', svg, 'logo.png')).rejects.toThrow(/UPLOAD_TYPE_REFUSED/);
    ok(await editor.send('delete', `/api/v1/files/uploads/${declared.id}`), 204);
  });

  it('a save stores the identity, claims its images, is audited once with the changed fields, and shows at once everywhere', async () => {
    const logo = (await editor.upload('site.logo', gradientPng(1200, 600), 'logo.png')).fileId!;
    const dark = (await editor.upload('site.logo', solidPng(300, 80, [255, 255, 255, 220]), 'logo-gelap.png')).fileId!;
    const icon = (await editor.upload('site.icon', gradientPng(400, 300), 'ikon.png')).fileId!;
    // Not public before the identity names them.
    expect((await bytes(`/files/${logo}`)).status).not.toBe(200);

    const view = ok<SiteIdentityView>(await editor.send('get', API));
    const identity = { logo: { fileId: logo, alt: '' }, logoDark: { fileId: dark }, icon: { fileId: icon }, name: 'Pustaka Kenari', tagline: { id: 'Membaca untuk semua', en: 'Reading for all' }, showNameBesideLogo: false };
    const saved = ok<{ revision: string; changed: string[] }>(await editor.send('put', API, { revision: view.revision, identity }));
    expect(saved.changed).toEqual(['logo', 'logoDark', 'icon', 'name', 'tagline', 'showNameBesideLogo']);

    const audit = await k.h.db.selectFrom('audit_log').select(['actor_id', 'meta']).where('action', '=', 'site.identity.update').execute();
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actor_id).toBe(editor.userId);
    expect(JSON.parse(String(audit[0]!.meta))).toEqual({ fields: saved.changed, first: true });

    const after = ok<SiteIdentityView>(await editor.send('get', API));
    expect(after).toMatchObject({ identity, saved: true, revision: saved.revision, urls: { logo: `/files/${logo}`, logoDark: `/files/${dark}`, icon: { 32: `/site-icon/32.png?v=${icon}` } } });

    expect(ok<SiteIdentityPublic>(await visitor().get(`${API}/public`))).toEqual({
      name: 'Pustaka Kenari',
      tagline: { id: 'Membaca untuk semua', en: 'Reading for all' },
      showNameBesideLogo: false,
      logo: { url: `/files/${logo}`, alt: 'Pustaka Kenari' },
      logoDark: { url: `/files/${dark}` },
      hasIcon: true,
      icon: { 32: `/site-icon/32.png?v=${icon}`, 180: `/site-icon/180.png?v=${icon}`, 192: `/site-icon/192.png?v=${icon}` },
    });

    // The logo is a public PNG the server made: 480 x 240, served typed and not sniffed.
    const served = await bytes(`/files/${logo}`);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
    expect(served.headers.get('x-content-type-options')).toBe('nosniff');
    expect(served.headers.get('cache-control')).toBe('public, max-age=86400');
    expect(decodePng(served.body, { maxSide: 4000 })).toMatchObject({ width: 480, height: 240 });

    // The icon route answers the library's icon now, in each size; a URL that names the file may be kept a day.
    for (const size of [32, 180, 192] as const) {
      const res = await bytes(`/site-icon/${size}.png?v=${icon}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('public, max-age=86400');
      expect(res.body.equals(Buffer.from(defaultSiteIcon(size)))).toBe(false);
      expect(decodePng(res.body, { maxSide: 4000 })).toMatchObject({ width: size, height: size });
      expect((await bytes(`/site-icon/${size}.png`)).body.equals(res.body)).toBe(true);
    }

    // The OPAC shows the identity's logo (its alternative text the site's name), not the home page's old one.
    const html = (await visitor().get('/', undefined, HTML)).text;
    expect(html).toContain(`src="/files/${logo}" alt="Pustaka Kenari"`);
    expect(html).not.toContain(oldLogo);
  });

  it('refuses a stale revision (409), a value out of bounds or an unknown field (422), and an image of another context at its place (422); nothing is audited', async () => {
    const view = ok<SiteIdentityView>(await editor.send('get', API));
    const stale = await editor.send('put', API, { revision: '0'.repeat(16), identity: view.identity });
    expect(stale.status, stale.text).toBe(409);
    expect((stale.json as { code: string }).code).toBe('CONFLICT_STALE');

    for (const identity of [
      { ...view.identity, name: 'n'.repeat(121) },
      { ...view.identity, tagline: { id: 't'.repeat(161), en: null } },
      { ...view.identity, logo: { fileId: view.identity.logo!.fileId, alt: 'a'.repeat(161) } },
      { ...view.identity, logo: { fileId: 'bukan-ulid', alt: '' } },
      { ...view.identity, favicon: 'https://evil.example/x.svg' },
      { ...view.identity, showNameBesideLogo: 'ya' },
    ]) {
      const res = await editor.send('put', API, { revision: view.revision, identity });
      expect(res.status, res.text).toBe(422);
    }

    const photo = (await editor.upload('opac.home_photo', sizedJpeg(1200, 900), 'foto.jpg')).fileId!;
    const wrong = await editor.send('put', API, { revision: view.revision, identity: { ...view.identity, logoDark: { fileId: photo }, icon: { fileId: view.identity.logo!.fileId } } });
    expect(wrong.status, wrong.text).toBe(422);
    expect((wrong.json as { errors?: unknown; meta?: { errors?: unknown } }).errors ?? (wrong.json as { meta?: { errors?: unknown } }).meta?.errors).toEqual([
      { path: 'identity.logoDark.fileId', code: 'invalid' },
      { path: 'identity.icon.fileId', code: 'invalid' },
    ]);

    expect(ok<SiteIdentityView>(await editor.send('get', API)).revision).toBe(view.revision);
    expect(await k.h.db.selectFrom('audit_log').select('id').where('action', '=', 'site.identity.update').execute()).toHaveLength(1);
  });
});
