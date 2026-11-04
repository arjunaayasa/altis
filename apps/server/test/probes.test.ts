import fsp from 'node:fs/promises';
import { ensureInstallCode, probeHmac, readInstallSession } from '@altis/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { defineRoutes } from '../src/http/route.js';
import { probeRoutes } from '../src/probes/routes.js';
import { ALL_ROUTES } from '../src/routes.js';
import { recordingLogger, useDataDir } from './support.js';

// The probe routes in their wizard form (plan Task 23 `probeRoutes`, mounted by Task 27 in ALL_ROUTES under
// /install/api/probe with `install: 'claimed'`; spec §13.5 `GET install/api/probe/:nonce`): the declarations are valid wizard routes, the
// nonce route answers the claim's probe HMAC (the same from every process, §9.5 step 1), and `poll`/`sse` are not
// taken for a nonce.

const ORIGIN = 'http://localhost:3000';
const dirs = useDataDir();

const INSTALL_PROBES = probeRoutes({ prefix: '/install/api/probe', access: { install: 'claimed' }, idPrefix: 'install.probe' });

beforeEach(() => {
  // The claim prints nothing, but a new install code would be printed by the page: keep stdout clean.
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('probeRoutes for the wizard', () => {
  it('are valid declarations: claimed wizard routes, `mode: system`, maintenance allowed, ids under install.probe', () => {
    expect(() => defineRoutes(ALL_ROUTES)).not.toThrow();
    // Task 27 mounts them in ALL_ROUTES, after `install.exposure`.
    const mounted = ALL_ROUTES.filter((d) => d.id.startsWith('install.probe.'));
    expect(mounted.map((d) => `${d.id} ${d.method} ${d.path}`)).toEqual(INSTALL_PROBES.map((d) => `${d.id} ${d.method} ${d.path}`));
    expect(INSTALL_PROBES.map((d) => `${d.id} ${d.method} ${d.path}`)).toEqual([
      'install.probe.poll GET /install/api/probe/poll',
      'install.probe.sse GET /install/api/probe/sse',
      'install.probe.hmac GET /install/api/probe/:nonce{[A-Za-z0-9_-]{16,64}}',
      'install.probe.methods.post POST /install/api/probe/methods',
      'install.probe.methods.put PUT /install/api/probe/methods',
      'install.probe.methods.patch PATCH /install/api/probe/methods',
      'install.probe.methods.delete DELETE /install/api/probe/methods',
      'install.probe.chunk POST /install/api/probe/chunk',
    ]);
    for (const d of INSTALL_PROBES) {
      expect(d, d.id).toMatchObject({ public: true, session: 'none', install: 'claimed', mode: 'system', maintenance: 'allow', audit: null });
    }
  });

  it('GET /install/api/probe/<nonce> with the claim → probeHmac of the install session; poll is not a nonce', async () => {
    await fsp.mkdir(dirs.dataDir);
    const app = createApp({
      state: { phase: 'not_installed' },
      version: '0.1.0',
      buildId: '0.1.0',
      log: recordingLogger(),
      dataDir: dirs.dataDir,
      runtime: 'standalone',
      env: {},
    });
    const env = { incoming: { socket: { remoteAddress: '127.0.0.1' } } };
    const installCode = (await ensureInstallCode(dirs.dataDir, { now: Date.now(), env: {} })).code;
    const claim = await app.request(
      '/install/api/claim',
      { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify({ code: installCode }) },
      env,
    );
    expect(claim.status).toBe(200);
    const pair = claim.headers.getSetCookie().find((c) => /^(__Host-)?altis_install=/.test(c))!.split(';')[0]!;
    const token = pair.slice(pair.indexOf('=') + 1);
    const session = await readInstallSession(dirs.dataDir, token, Date.now());
    expect(session).not.toBeNull();

    const nonce = 'Wizard_nonce-0123456789';
    const res = await app.request(`/install/api/probe/${nonce}`, { headers: { cookie: pair } }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hmac: probeHmac(session!, nonce) });

    const poll = await app.request('/install/api/probe/poll', { headers: { cookie: pair, 'x-forwarded-for': '198.51.100.7' } }, env);
    expect(poll.status).toBe(200);
    expect(await poll.json()).toMatchObject({ xff: ['198.51.100.7'], peerPrivate: true, suggestedHops: 1, ipAtSuggested: '198.51.100.7' });

    // Without the claim: the wizard's own refusal.
    const anonymous = await app.request(`/install/api/probe/${nonce}`, {}, env);
    expect(anonymous.status).toBe(403);
    // A nonce of the wrong shape is no route at all.
    expect((await app.request('/install/api/probe/short', { headers: { cookie: pair } }, env)).status).toBe(404);
  });

  it('the write probes are `tx: self` under both prefixes: their handlers touch no database', () => {
    const diagnostics = probeRoutes({
      prefix: '/api/v1/diagnostics/probe',
      access: { permission: 'system.diagnostics.read' },
      idPrefix: 'diagnostics.probe',
    });
    for (const d of [...INSTALL_PROBES, ...diagnostics].filter((r) => r.method !== 'GET')) expect(d.tx, d.id).toBe('self');
  });

  it('before `POST config` (no database yet) the claim holder gets an answer from every methods probe and the chunk probe', async () => {
    await fsp.mkdir(dirs.dataDir);
    const log = recordingLogger();
    const app = createApp({
      state: { phase: 'not_installed' },
      version: '0.1.0',
      buildId: '0.1.0',
      log,
      dataDir: dirs.dataDir,
      runtime: 'standalone',
      env: {},
    });
    const env = { incoming: { socket: { remoteAddress: '127.0.0.1' } } };
    const installCode = (await ensureInstallCode(dirs.dataDir, { now: Date.now(), env: {} })).code;
    const claim = await app.request(
      '/install/api/claim',
      { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify({ code: installCode }) },
      env,
    );
    expect(claim.status).toBe(200);
    const { csrfToken } = (await claim.json()) as { csrfToken: string };
    const pair = claim.headers.getSetCookie().find((c) => /^(__Host-)?altis_install=/.test(c))!.split(';')[0]!;
    const headers = { cookie: pair, origin: ORIGIN, 'x-csrf-token': csrfToken };

    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await app.request('/install/api/probe/methods', { method, headers }, env);
      expect(res.status, method).toBe(200);
      expect(await res.json()).toEqual({ method });
    }
    const form = new FormData();
    form.append('chunk', new Blob([new Uint8Array(4096)], { type: 'application/octet-stream' }), 'probe.bin');
    const chunk = await app.request('/install/api/probe/chunk', { method: 'POST', headers, body: form }, env);
    expect(chunk.status).toBe(200);
    expect(await chunk.json()).toEqual({ bytes: 4096 });
    expect(log.lines.filter((l) => l.level === 'error' || l.level === 'warn')).toEqual([]);
  });
});
