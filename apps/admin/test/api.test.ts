import { t } from '@altis/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The API client (spec §4.8, §7.4; Task 27, ruling R1b-1): every request goes to /api/v1 with the latest CSRF token,
// every response feeds the build check and may carry a new token, problem+json becomes ApiError, and the auth
// problems the server answers with lead to reauth, a retry, or the matching sign-in page. `fetch` is faked.

type Modules = {
  api: typeof import('@/lib/api');
  page: typeof import('@/lib/page');
  buildSync: typeof import('@/lib/build-sync');
  dirtyForms: typeof import('@/lib/dirty-forms');
};

const fetchMock = vi.fn<typeof fetch>();

/** Fresh modules for each test: the client keeps its token and the build check its state per page load. */
async function load(): Promise<Modules> {
  vi.resetModules();
  return {
    api: await import('@/lib/api'),
    page: await import('@/lib/page'),
    buildSync: await import('@/lib/build-sync'),
    dirtyForms: await import('@/lib/dirty-forms'),
  };
}

function json(body: unknown, headers: Record<string, string> = {}, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function problem(status: number, code: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}): Response {
  const body = { type: 'about:blank', title: code, status, code, traceId: '01JTRACE', ...extra };
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/problem+json', ...headers } });
}

/** The headers of the n-th fetch call, as a plain lower-cased record. */
function sentHeaders(n: number): Record<string, string> {
  const init = fetchMock.mock.calls[n]?.[1];
  return Object.fromEntries(new Headers(init?.headers).entries());
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  sessionStorage.clear();
  window.history.replaceState(null, '', '/admin/users?q=ani');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('api: requests', () => {
  it('sends JSON to /api/v1/<path> with the background and idempotency headers when asked', async () => {
    const { api } = await load();
    fetchMock.mockResolvedValueOnce(json({ id: 'u1' }, {}, 201));
    const created = await api.api<{ id: string }>('POST', 'users', { username: 'ani' }, { idempotencyKey: 'k-1', background: true });
    expect(created).toEqual({ id: 'u1' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/v1/users');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ username: 'ani' }));
    expect(init?.credentials).toBe('same-origin');
    expect(sentHeaders(0)).toMatchObject({
      'content-type': 'application/json',
      'idempotency-key': 'k-1',
      'x-altis-background': '1',
    });
  });

  it('a GET carries no body, no background header and no idempotency key; a 204 resolves to undefined', async () => {
    const { api } = await load();
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(api.api('DELETE', '/auth/sessions/s1')).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/v1/auth/sessions/s1');
    fetchMock.mockResolvedValueOnce(json([]));
    await api.api('GET', 'branches');
    expect(fetchMock.mock.calls[1]![1]?.body).toBeUndefined();
    expect(Object.keys(sentHeaders(1))).not.toContain('x-altis-background');
    expect(Object.keys(sentHeaders(1))).not.toContain('idempotency-key');
  });

  it('an X-CSRF-Token response header is sent with the next POST', async () => {
    const { api } = await load();
    api.setCsrfToken('tok-1');
    fetchMock.mockResolvedValueOnce(json({ stage: 'full' }, { 'X-CSRF-Token': 'tok-2' }));
    await api.api('POST', 'auth/2fa/verify', { code: '123456' });
    expect(sentHeaders(0)['x-csrf-token']).toBe('tok-1');
    fetchMock.mockResolvedValueOnce(json({}));
    await api.api('POST', 'auth/logout');
    expect(sentHeaders(1)['x-csrf-token']).toBe('tok-2');
  });
});

describe('api: build check (X-Altis-Build)', () => {
  it('a response from build 0.2.0 while the SPA is 0.1.0 reloads the page when no form is dirty', async () => {
    const { api, page, buildSync } = await load();
    const reload = vi.spyOn(page.page, 'reload').mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(json([], { 'X-Altis-Build': '0.2.0' }));
    await api.api('GET', 'branches');
    expect(reload).toHaveBeenCalledTimes(1);
    expect(buildSync.buildSync.mismatch).toBe(true);
  });

  it('with one dirty form it does not reload, and the mismatch is flagged for the banner', async () => {
    const { api, page, buildSync, dirtyForms } = await load();
    const reload = vi.spyOn(page.page, 'reload').mockImplementation(() => {});
    dirtyForms.dirtyForms.add(Symbol('form'));
    fetchMock.mockResolvedValueOnce(json([], { 'X-Altis-Build': '0.2.0' }));
    await api.api('GET', 'branches');
    expect(reload).not.toHaveBeenCalled();
    expect(buildSync.buildSync.mismatch).toBe(true);
  });

  it('the same build changes nothing', async () => {
    const { api, page, buildSync } = await load();
    const reload = vi.spyOn(page.page, 'reload').mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(json([], { 'X-Altis-Build': '0.1.0' }));
    await api.api('GET', 'branches');
    expect(reload).not.toHaveBeenCalled();
    expect(buildSync.buildSync.mismatch).toBe(false);
  });

  it('error responses feed the build check too', async () => {
    const { api, page, buildSync } = await load();
    vi.spyOn(page.page, 'reload').mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(problem(404, 'NOT_FOUND', {}, { 'X-Altis-Build': '0.3.0' }));
    await expect(api.api('GET', 'users/x')).rejects.toBeInstanceOf(api.ApiError);
    expect(buildSync.buildSync.mismatch).toBe(true);
  });
});

describe('api: problems', () => {
  it('a problem body becomes an ApiError with status, code, detail and errors', async () => {
    const { api } = await load();
    fetchMock.mockResolvedValueOnce(
      problem(422, 'VALIDATION_FAILED', { detail: 'Isian belum benar.', errors: [{ path: 'username', code: 'taken' }] }),
    );
    const error = await api.api('POST', 'users', { username: 'ani' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(api.ApiError);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      status: 422,
      code: 'VALIDATION_FAILED',
      detail: 'Isian belum benar.',
      errors: [{ path: 'username', code: 'taken' }],
      traceId: '01JTRACE',
    });
  });

  it('a 429 sets retryAfterS from Retry-After', async () => {
    const { api } = await load();
    fetchMock.mockResolvedValueOnce(problem(429, 'AUTH_TOO_MANY_ATTEMPTS', {}, { 'Retry-After': '42' }));
    await expect(api.api('POST', 'auth/login', { username: 'a', password: 'b' })).rejects.toMatchObject({
      status: 429,
      code: 'AUTH_TOO_MANY_ATTEMPTS',
      retryAfterS: 42,
    });
  });

  it('keeps the registered reason of a problem (S30)', async () => {
    const { api } = await load();
    fetchMock.mockResolvedValueOnce(problem(422, 'INVALID_BASE_URL', { reason: 'origin_mismatch' }));
    await expect(api.api('PUT', 'system/config', {})).rejects.toMatchObject({ code: 'INVALID_BASE_URL', reason: 'origin_mismatch' });
  });

  it('a response that is not problem+json (a proxy page) is an ApiError INTERNAL with its status', async () => {
    const { api } = await load();
    fetchMock.mockResolvedValueOnce(new Response('<html>Bad gateway</html>', { status: 502, headers: { 'Content-Type': 'text/html' } }));
    await expect(api.api('GET', 'branches')).rejects.toMatchObject({ status: 502, code: 'INTERNAL' });
  });

  it('an unknown code in a problem body is read as INTERNAL', async () => {
    const { api } = await load();
    fetchMock.mockResolvedValueOnce(problem(400, 'SOMETHING_NEW'));
    await expect(api.api('GET', 'branches')).rejects.toMatchObject({ status: 400, code: 'INTERNAL' });
  });
});

describe('api: auth problems', () => {
  it('401 AUTH_REAUTH_REQUIRED, then a resolved reauth.request() → the request is sent twice and resolves', async () => {
    const { api } = await load();
    const request = vi.spyOn(api.reauth, 'request').mockResolvedValue(undefined);
    fetchMock.mockResolvedValueOnce(problem(401, 'AUTH_REAUTH_REQUIRED')).mockResolvedValueOnce(json({ ok: true }));
    await expect(api.api('POST', 'users/u1/disable', {})).resolves.toEqual({ ok: true });
    expect(request).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]![0]).toBe('/api/v1/users/u1/disable');
    expect(fetchMock.mock.calls[1]![1]?.body).toBe('{}');
  });

  it('a cancelled reauth rejects with the original problem and sends nothing more', async () => {
    const { api } = await load();
    vi.spyOn(api.reauth, 'request').mockRejectedValue(new Error('cancelled'));
    fetchMock.mockResolvedValueOnce(problem(401, 'AUTH_REAUTH_REQUIRED'));
    await expect(api.api('POST', 'users/u1/disable', {})).rejects.toMatchObject({ code: 'AUTH_REAUTH_REQUIRED' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('only one retry: a second AUTH_REAUTH_REQUIRED is the answer', async () => {
    const { api } = await load();
    const request = vi.spyOn(api.reauth, 'request').mockResolvedValue(undefined);
    fetchMock.mockImplementation(async () => problem(401, 'AUTH_REAUTH_REQUIRED'));
    await expect(api.api('POST', 'roles', {})).rejects.toMatchObject({ code: 'AUTH_REAUTH_REQUIRED' });
    expect(request).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('403 CSRF_INVALID → GET auth/me for a fresh csrfToken, then one retry with it (ruling R1b-1)', async () => {
    const { api } = await load();
    api.setCsrfToken('stale');
    api.setSessionUser('u1');
    fetchMock
      .mockResolvedValueOnce(problem(403, 'CSRF_INVALID'))
      .mockResolvedValueOnce(json({ authenticated: true, csrfToken: 'fresh', user: { id: 'u1' } }))
      .mockResolvedValueOnce(json({ id: 'b1' }, {}, 201));
    await expect(api.api('POST', 'branches', { code: 'PST' })).resolves.toEqual({ id: 'b1' });
    expect(fetchMock.mock.calls.map((c) => [c[1]?.method, c[0]])).toEqual([
      ['POST', '/api/v1/branches'],
      ['GET', '/api/v1/auth/me'],
      ['POST', '/api/v1/branches'],
    ]);
    expect(sentHeaders(0)['x-csrf-token']).toBe('stale');
    expect(sentHeaders(2)['x-csrf-token']).toBe('fresh');
  });

  it('403 CSRF_INVALID while auth/me now names another user (a shared PC): no retry under that identity; the sign-in page opens', async () => {
    const { api, page } = await load();
    const navigate = vi.spyOn(page.page, 'navigate').mockImplementation(() => {});
    const lost = vi.fn();
    api.onAuthLost(lost);
    api.setCsrfToken('token-of-ani');
    api.setSessionUser('u1');
    fetchMock
      .mockResolvedValueOnce(problem(403, 'CSRF_INVALID'))
      .mockResolvedValueOnce(json({ authenticated: true, csrfToken: 'token-of-budi', user: { id: 'u2' } }));
    await expect(api.api('PATCH', 'users/U3', { version: 2, name: 'Citra' })).rejects.toMatchObject({ code: 'CSRF_INVALID' });
    expect(fetchMock.mock.calls.map((c) => [c[1]?.method, c[0]])).toEqual([
      ['PATCH', '/api/v1/users/U3'],
      ['GET', '/api/v1/auth/me'],
    ]);
    expect(lost).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(`/admin/login?next=${encodeURIComponent('/admin/users?q=ani')}&notice=session_ended`);
    // The other user's token is not taken over: a write sent from this page now still fails.
    expect(api.csrfToken()).toBe('token-of-ani');
  });

  it('403 CSRF_INVALID while auth/me now says signed out: no retry; the sign-in page opens', async () => {
    const { api, page } = await load();
    const navigate = vi.spyOn(page.page, 'navigate').mockImplementation(() => {});
    api.setSessionUser('u1');
    fetchMock
      .mockResolvedValueOnce(problem(403, 'CSRF_INVALID'))
      .mockResolvedValueOnce(json({ authenticated: false, csrfToken: 'pre' }));
    await expect(api.api('POST', 'branches', { code: 'PST' })).rejects.toMatchObject({ code: 'CSRF_INVALID' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(navigate).toHaveBeenCalledWith(`/admin/login?next=${encodeURIComponent('/admin/users?q=ani')}&notice=session_ended`);
  });

  it('a second CSRF_INVALID is the answer (no loop)', async () => {
    const { api } = await load();
    fetchMock
      .mockResolvedValueOnce(problem(403, 'CSRF_INVALID'))
      .mockResolvedValueOnce(json({ authenticated: true, csrfToken: 'fresh' }))
      .mockResolvedValueOnce(problem(403, 'CSRF_INVALID'));
    await expect(api.api('POST', 'branches', {})).rejects.toMatchObject({ code: 'CSRF_INVALID' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('401 AUTH_REQUIRED → /admin/login?next=<current path>, saying the session ended', async () => {
    const { api, page } = await load();
    const navigate = vi.spyOn(page.page, 'navigate').mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(problem(401, 'AUTH_REQUIRED'));
    await expect(api.api('GET', 'users')).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(navigate).toHaveBeenCalledWith(`/admin/login?next=${encodeURIComponent('/admin/users?q=ani')}&notice=session_ended`);
  });

  it('401 AUTH_REQUIRED on Beranda → /admin/login?notice=session_ended (no next to come back to)', async () => {
    const { api, page } = await load();
    window.history.replaceState(null, '', '/admin');
    const navigate = vi.spyOn(page.page, 'navigate').mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(problem(401, 'AUTH_REQUIRED'));
    await expect(api.api('GET', 'users')).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(navigate).toHaveBeenCalledWith('/admin/login?notice=session_ended');
  });

  it('401 AUTH_REQUIRED while a form is dirty: the session-lost listeners hear it, but the page stays (the shell warns)', async () => {
    const { api, page, dirtyForms } = await load();
    const navigate = vi.spyOn(page.page, 'navigate').mockImplementation(() => {});
    const lost = vi.fn();
    api.onAuthLost(lost);
    const form = Symbol('form');
    dirtyForms.dirtyForms.add(form);
    fetchMock.mockResolvedValueOnce(problem(401, 'AUTH_REQUIRED'));
    await expect(api.api('PATCH', 'users/U2', { version: 1, name: 'Budi' })).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(lost).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
    dirtyForms.dirtyForms.remove(form);
  });

  it('401 AUTH_REQUIRED on the sign-in page itself does not navigate', async () => {
    const { api, page } = await load();
    window.history.replaceState(null, '', '/admin/login');
    const navigate = vi.spyOn(page.page, 'navigate').mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(problem(401, 'AUTH_REQUIRED'));
    await expect(api.api('POST', 'auth/logout')).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(navigate).not.toHaveBeenCalled();
  });

  it('401 AUTH_MFA_REQUIRED → /admin/login/2fa; 403 AUTH_PASSWORD_CHANGE_REQUIRED → /admin/profile/password', async () => {
    const { api, page } = await load();
    const navigate = vi.spyOn(page.page, 'navigate').mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(problem(401, 'AUTH_MFA_REQUIRED'));
    await expect(api.api('GET', 'users')).rejects.toMatchObject({ code: 'AUTH_MFA_REQUIRED' });
    expect(navigate).toHaveBeenLastCalledWith('/admin/login/2fa');
    fetchMock.mockResolvedValueOnce(problem(403, 'AUTH_PASSWORD_CHANGE_REQUIRED'));
    await expect(api.api('GET', 'users')).rejects.toMatchObject({ code: 'AUTH_PASSWORD_CHANGE_REQUIRED' });
    expect(navigate).toHaveBeenLastCalledWith('/admin/profile/password');
  });
});

describe('safeNext (no open redirect, M11)', () => {
  it('keeps a same-origin path under /admin/', async () => {
    const { api } = await load();
    expect(api.safeNext('/admin/users')).toBe('/admin/users');
    expect(api.safeNext('/admin/users/01JABC?tab=roles')).toBe('/admin/users/01JABC?tab=roles');
    expect(api.safeNext('/admin')).toBe('/admin');
  });

  it.each([
    '//evil.example',
    'https://evil.example',
    '/admin\\..',
    '/opac',
    null,
    '',
    'admin/users',
    '/administrator',
    '/admin//evil.example',
    '/admin/../opac',
    '/admin/%2e%2e/opac',
    'javascript:alert(1)',
    '/admin/\tx',
    ' /admin/users',
  ])('refuses %j → /admin', async (next) => {
    const { api } = await load();
    expect(api.safeNext(next)).toBe('/admin');
  });
});

describe('api: method override behind a WAF (Task 16, P10, Review Focus 5)', () => {
  const OVERRIDE = 'x-http-method-override';

  /** A WAF page: what ModSecurity or Imunify360 answer instead of the server. */
  const wafPage = (status = 403): Response =>
    new Response('<html><body>Request Rejected</body></html>', { status, headers: { 'Content-Type': 'text/html' } });

  /**
   * A host whose WAF answers PUT, PATCH and DELETE with an HTML 403 page; `POST` + override reaches `server`, which
   * sees the method the header names.
   */
  function behindWaf(server: (method: string, path: string, body: unknown) => Response): void {
    fetchMock.mockImplementation(async (input, init) => {
      const method = init?.method ?? 'GET';
      if (method === 'PUT' || method === 'PATCH' || method === 'DELETE') return wafPage();
      const override = new Headers(init?.headers).get(OVERRIDE);
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      return server(method === 'POST' && override !== null ? override : method, String(input).replace('/api/v1/', ''), body);
    });
  }

  /** [method, url, override header] of every fetch call. */
  const sent = (): [string | undefined, unknown, string | undefined][] =>
    fetchMock.mock.calls.map((c, i) => [c[1]?.method, c[0], sentHeaders(i)[OVERRIDE]]);

  it("PUT settings/library → the WAF's 403 page → sent again as POST + override and resolved; the next PUT goes straight to the override", async () => {
    const { api } = await load();
    api.setCsrfToken('tok');
    behindWaf((method, path, body) => json({ method, path, body }));
    await expect(api.api('PUT', 'settings/library', { 'library.name': 'Perpustakaan Arsya' })).resolves.toEqual({
      method: 'PUT',
      path: 'settings/library',
      body: { 'library.name': 'Perpustakaan Arsya' },
    });
    expect(sent()).toEqual([
      ['PUT', '/api/v1/settings/library', undefined],
      ['POST', '/api/v1/settings/library', 'PUT'],
    ]);
    // The retry is the same request: body, CSRF token and content type.
    expect(fetchMock.mock.calls[1]![1]?.body).toBe(JSON.stringify({ 'library.name': 'Perpustakaan Arsya' }));
    expect(sentHeaders(1)).toMatchObject({ 'x-csrf-token': 'tok', 'content-type': 'application/json' });
    expect(sessionStorage.getItem('altis.method-override')).toBe('1');

    fetchMock.mockClear();
    await api.api('PUT', 'settings/library', {});
    await api.api('PATCH', 'users/U1', { version: 1 });
    await api.api('DELETE', 'auth/sessions/s1');
    expect(sent()).toEqual([
      ['POST', '/api/v1/settings/library', 'PUT'],
      ['POST', '/api/v1/users/U1', 'PATCH'],
      ['POST', '/api/v1/auth/sessions/s1', 'DELETE'],
    ]);
    expect(fetchMock.mock.calls[2]![1]?.body).toBeUndefined();
  });

  it('a 405 page is a WAF too', async () => {
    const { api } = await load();
    fetchMock.mockResolvedValueOnce(wafPage(405)).mockResolvedValueOnce(json({ ok: true }));
    await expect(api.api('DELETE', 'roles/R1')).resolves.toEqual({ ok: true });
    expect(sent()).toEqual([
      ['DELETE', '/api/v1/roles/R1', undefined],
      ['POST', '/api/v1/roles/R1', 'DELETE'],
    ]);
  });

  it('a new page of the tab (sessionStorage says so) overrides from its first PUT', async () => {
    sessionStorage.setItem('altis.method-override', '1');
    const { api } = await load();
    fetchMock.mockResolvedValueOnce(json({ ok: true }));
    await api.api('PUT', 'settings/library', {});
    expect(sent()).toEqual([['POST', '/api/v1/settings/library', 'PUT']]);
  });

  it("auth/me's client.methodOverride (the browser test saw the WAF) overrides from the first PUT; GET and POST never", async () => {
    const { api } = await load();
    fetchMock.mockResolvedValueOnce(
      json({
        authenticated: true,
        csrfToken: 'tok',
        user: { id: 'u1' },
        client: { realtime: 'polling', methodOverride: true, chunkBytes: 1048576, probedAt: 1_800_000_400_000 },
      }),
    );
    await api.api('GET', 'auth/me');
    expect(api.clientHints()).toEqual({ realtime: 'polling', methodOverride: true, chunkBytes: 1048576, probedAt: 1_800_000_400_000 });
    fetchMock.mockImplementation(async () => json({ ok: true }));
    await api.api('PUT', 'settings/library', {});
    await api.api('GET', 'branches');
    await api.api('POST', 'branches', {});
    expect(sent().slice(1)).toEqual([
      ['POST', '/api/v1/settings/library', 'PUT'],
      ['GET', '/api/v1/branches', undefined],
      ['POST', '/api/v1/branches', undefined],
    ]);
    // Not remembered for the tab: the hint comes with every auth/me.
    expect(sessionStorage.getItem('altis.method-override')).toBeNull();
    fetchMock.mockResolvedValueOnce(json({ authenticated: false, csrfToken: 'pre' }));
    await api.api('GET', 'auth/me');
    expect(api.clientHints()).toBeNull();
    // A hint without probedAt (no browser test yet, said by leaving it out) reads as null; the other hints still count.
    fetchMock.mockResolvedValueOnce(
      json({ authenticated: true, csrfToken: 'tok', user: { id: 'u1' }, client: { realtime: 'sse', methodOverride: false, chunkBytes: 262144 } }),
    );
    await api.api('GET', 'auth/me');
    expect(api.clientHints()).toEqual({ realtime: 'sse', methodOverride: false, chunkBytes: 262144, probedAt: null });
  });

  it("the server's own 403 (problem+json) is the answer: no override, nothing remembered", async () => {
    const { api } = await load();
    fetchMock.mockResolvedValueOnce(problem(403, 'AUTHZ_DENIED'));
    await expect(api.api('PUT', 'settings/library', {})).rejects.toMatchObject({ status: 403, code: 'AUTHZ_DENIED', problemJson: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem('altis.method-override')).toBeNull();
  });

  it('a WAF page on a GET or a POST is the answer (nothing to override)', async () => {
    const { api } = await load();
    fetchMock.mockImplementation(async () => wafPage());
    await expect(api.api('GET', 'branches')).rejects.toMatchObject({ status: 403, code: 'INTERNAL', problemJson: false });
    await expect(api.api('POST', 'branches', {})).rejects.toMatchObject({ status: 403, code: 'INTERNAL', problemJson: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a WAF that blocks the override too: one retry, the page is the answer, nothing remembered', async () => {
    const { api } = await load();
    fetchMock.mockImplementation(async () => wafPage());
    await expect(api.api('PUT', 'settings/library', {})).rejects.toMatchObject({ status: 403, code: 'INTERNAL', problemJson: false });
    expect(sent()).toEqual([
      ['PUT', '/api/v1/settings/library', undefined],
      ['POST', '/api/v1/settings/library', 'PUT'],
    ]);
    expect(sessionStorage.getItem('altis.method-override')).toBeNull();
  });

  it('an overridden request still gets the CSRF retry (the override is kept)', async () => {
    const { api } = await load();
    api.setCsrfToken('stale');
    api.setSessionUser('u1');
    fetchMock
      .mockResolvedValueOnce(wafPage())
      .mockResolvedValueOnce(problem(403, 'CSRF_INVALID'))
      .mockResolvedValueOnce(json({ authenticated: true, csrfToken: 'fresh', user: { id: 'u1' } }))
      .mockResolvedValueOnce(json({ ok: true }));
    await expect(api.api('PUT', 'settings/library', {})).resolves.toEqual({ ok: true });
    expect(sent()).toEqual([
      ['PUT', '/api/v1/settings/library', undefined],
      ['POST', '/api/v1/settings/library', 'PUT'],
      ['GET', '/api/v1/auth/me', undefined],
      ['POST', '/api/v1/settings/library', 'PUT'],
    ]);
    expect(sentHeaders(3)['x-csrf-token']).toBe('fresh');
    expect(sessionStorage.getItem('altis.method-override')).toBe('1');
  });

  it('an overridden write refused with 403 METHOD_OVERRIDE_DENIED while auth/me says signed out: the session-ended flow, as for 401 AUTH_REQUIRED', async () => {
    sessionStorage.setItem('altis.method-override', '1');
    const { api, page } = await load();
    const navigate = vi.spyOn(page.page, 'navigate').mockImplementation(() => {});
    const lost = vi.fn();
    api.onAuthLost(lost);
    api.setCsrfToken('tok');
    api.setSessionUser('u1');
    fetchMock
      .mockResolvedValueOnce(problem(403, 'METHOD_OVERRIDE_DENIED'))
      .mockResolvedValueOnce(json({ authenticated: false, csrfToken: 'pre' }));
    await expect(api.api('PUT', 'settings/library', {})).rejects.toMatchObject({ status: 403, code: 'METHOD_OVERRIDE_DENIED' });
    expect(sent()).toEqual([
      ['POST', '/api/v1/settings/library', 'PUT'],
      ['GET', '/api/v1/auth/me', undefined],
    ]);
    expect(lost).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(`/admin/login?next=${encodeURIComponent('/admin/users?q=ani')}&notice=session_ended`);
  });

  it('METHOD_OVERRIDE_DENIED before the page knew its user (no auth/me answer yet), auth/me signed out: the session-ended flow too', async () => {
    const { api, page } = await load();
    const navigate = vi.spyOn(page.page, 'navigate').mockImplementation(() => {});
    fetchMock
      .mockResolvedValueOnce(wafPage())
      .mockResolvedValueOnce(problem(403, 'METHOD_OVERRIDE_DENIED'))
      .mockResolvedValueOnce(json({ authenticated: false, csrfToken: 'pre' }));
    await expect(api.api('DELETE', 'roles/R1')).rejects.toMatchObject({ code: 'METHOD_OVERRIDE_DENIED' });
    expect(sent()).toEqual([
      ['DELETE', '/api/v1/roles/R1', undefined],
      ['POST', '/api/v1/roles/R1', 'DELETE'],
      ['GET', '/api/v1/auth/me', undefined],
    ]);
    expect(navigate).toHaveBeenCalledWith(`/admin/login?next=${encodeURIComponent('/admin/users?q=ani')}&notice=session_ended`);
  });

  it('METHOD_OVERRIDE_DENIED while the session is still this page\'s: the refusal is the answer; no sign-in page, no retry', async () => {
    sessionStorage.setItem('altis.method-override', '1');
    const { api, page } = await load();
    const navigate = vi.spyOn(page.page, 'navigate').mockImplementation(() => {});
    const lost = vi.fn();
    api.onAuthLost(lost);
    api.setSessionUser('u1');
    fetchMock
      .mockResolvedValueOnce(problem(403, 'METHOD_OVERRIDE_DENIED'))
      .mockResolvedValueOnce(json({ authenticated: true, csrfToken: 'tok', user: { id: 'u1' } }));
    await expect(api.api('PUT', 'settings/library', {})).rejects.toMatchObject({ code: 'METHOD_OVERRIDE_DENIED' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(lost).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('METHOD_OVERRIDE_DENIED when auth/me cannot answer: the refusal is the answer, nowhere to go', async () => {
    sessionStorage.setItem('altis.method-override', '1');
    const { api, page } = await load();
    const navigate = vi.spyOn(page.page, 'navigate').mockImplementation(() => {});
    api.setSessionUser('u1');
    fetchMock.mockResolvedValueOnce(problem(403, 'METHOD_OVERRIDE_DENIED')).mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(api.api('PATCH', 'users/U1', { version: 1 })).rejects.toMatchObject({ code: 'METHOD_OVERRIDE_DENIED' });
    expect(navigate).not.toHaveBeenCalled();
  });

  it('methodOverride: false sends the real method: no override from the hint or the tab, no fallback after a WAF page (the methods probe)', async () => {
    sessionStorage.setItem('altis.method-override', '1');
    const { api } = await load();
    fetchMock.mockResolvedValueOnce(
      json({ authenticated: true, csrfToken: 'tok', user: { id: 'u1' }, client: { realtime: 'polling', methodOverride: true, chunkBytes: 1048576 } }),
    );
    await api.api('GET', 'auth/me');
    fetchMock.mockClear();

    // The WAF rule is gone: the real PUT passes.
    fetchMock.mockResolvedValueOnce(json({ method: 'PUT' }));
    await expect(api.api('PUT', 'diagnostics/probe/methods', {}, { methodOverride: false })).resolves.toEqual({ method: 'PUT' });
    // The WAF is still there: its page is the answer, with nothing sent again and nothing remembered.
    sessionStorage.clear();
    fetchMock.mockResolvedValueOnce(wafPage()).mockResolvedValueOnce(wafPage(405));
    await expect(api.api('PATCH', 'diagnostics/probe/methods', {}, { methodOverride: false })).rejects.toMatchObject({
      status: 403,
      code: 'INTERNAL',
      problemJson: false,
    });
    await expect(api.api('DELETE', 'diagnostics/probe/methods', undefined, { methodOverride: false })).rejects.toMatchObject({
      status: 405,
      problemJson: false,
    });
    expect(sent()).toEqual([
      ['PUT', '/api/v1/diagnostics/probe/methods', undefined],
      ['PATCH', '/api/v1/diagnostics/probe/methods', undefined],
      ['DELETE', '/api/v1/diagnostics/probe/methods', undefined],
    ]);
    expect(sessionStorage.getItem('altis.method-override')).toBeNull();
  });

  it('a FormData body goes out as it is (the browser sets the multipart boundary), with the CSRF token', async () => {
    const { api } = await load();
    api.setCsrfToken('tok');
    const form = new FormData();
    form.append('chunk', new Blob([new Uint8Array([1, 2, 3])]), 'chunk');
    fetchMock.mockResolvedValueOnce(json({ received: 3, complete: true }));
    await expect(api.api('POST', 'files/uploads/U/chunks/0', form)).resolves.toEqual({ received: 3, complete: true });
    expect(fetchMock.mock.calls[0]![1]?.body).toBe(form);
    expect(sentHeaders(0)['content-type']).toBeUndefined();
    expect(sentHeaders(0)['x-csrf-token']).toBe('tok');
  });

  it('a signal reaches fetch', async () => {
    const { api } = await load();
    const controller = new AbortController();
    fetchMock.mockResolvedValueOnce(json({}));
    await api.api('GET', 'branches', undefined, { signal: controller.signal });
    expect(fetchMock.mock.calls[0]![1]?.signal).toBe(controller.signal);
  });
});

describe('api: maintenance (1c Task 19, decision C20)', () => {
  const SCREEN = '[data-maintenance-screen]';
  const MAINTENANCE_BANNER = { kind: 'maintenance', severity: 'warning', messageKey: 'banner.maintenance' };

  /** `GET auth/me` of a fully signed-in user holding `permissions`. */
  const meOf = (permissions: string[], o: { banners?: unknown[]; locale?: string | null } = {}) => ({
    authenticated: true,
    csrfToken: 'tok',
    stage: 'full',
    mustChangePassword: false,
    user: { id: 'u1', username: 'ani', name: 'Ani', email: null, locale: o.locale ?? null, totpEnabled: false, mfaRequired: false },
    permissions,
    branchPermissions: {},
    superAdmin: false,
    reauthUntil: null,
    library: { name: 'Perpustakaan', locale: 'id' },
    build: '0.1.0',
    banners: o.banners ?? [],
  });

  /** What the server answers a request the maintenance refuses (problem+json with `reason`, Retry-After: 30). */
  const refused = (reason: string): Response => problem(503, 'MAINTENANCE', { reason }, { 'Retry-After': '30' });

  /** The page has seen `GET auth/me` answer `me`. */
  async function signedIn(api: Modules['api'], me: unknown): Promise<void> {
    fetchMock.mockResolvedValueOnce(json(me));
    await api.api('GET', 'auth/me');
    fetchMock.mockReset();
  }

  beforeEach(() => {
    const root = document.createElement('div');
    root.id = 'root';
    document.body.append(root);
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it('503 MAINTENANCE reason backup for a holder of system.backup.create → location.assign(/admin/_update) once, no screen', async () => {
    const { api, page } = await load();
    const assign = vi.spyOn(page.page, 'assign').mockImplementation(() => {});
    const navigate = vi.spyOn(page.page, 'navigate').mockImplementation(() => {});
    await signedIn(api, meOf(['system.backup.read', 'system.backup.create']));
    fetchMock.mockImplementation(async () => refused('backup'));
    await expect(api.api('POST', 'branches', { code: 'PST' })).rejects.toMatchObject({ status: 503, code: 'MAINTENANCE', reason: 'backup' });
    // A second refused request (another query of the screen) does not navigate again.
    await expect(api.api('GET', 'users')).rejects.toMatchObject({ code: 'MAINTENANCE' });
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith('/admin/_update');
    expect(navigate).not.toHaveBeenCalled();
    expect(document.querySelector(SCREEN)).toBeNull();
  });

  it('each reason needs its own permission: restore → system.backup.restore, update → system.update.run', async () => {
    for (const [reason, permission] of [
      ['restore', 'system.backup.restore'],
      ['update', 'system.update.run'],
    ] as const) {
      const { api, page } = await load();
      const assign = vi.spyOn(page.page, 'assign').mockImplementation(() => {});
      await signedIn(api, meOf([permission]));
      fetchMock.mockImplementation(async () => refused(reason));
      await expect(api.api('GET', 'users')).rejects.toMatchObject({ code: 'MAINTENANCE' });
      expect(assign, reason).toHaveBeenCalledWith('/admin/_update');
      expect(document.querySelector(SCREEN), reason).toBeNull();
    }
  });

  it('a staff user without the permission of the reason: no navigation; a blocking screen that retries GET auth/me every 15 s and lifts itself once the flag is gone', async () => {
    vi.useFakeTimers();
    const { api, page } = await load();
    const assign = vi.spyOn(page.page, 'assign').mockImplementation(() => {});
    const navigate = vi.spyOn(page.page, 'navigate').mockImplementation(() => {});
    // system.backup.create would open the page for a backup, not for this restore.
    await signedIn(api, meOf(['system.users.read', 'system.backup.create']));
    fetchMock.mockImplementation(async () => refused('restore'));
    await expect(api.api('GET', 'users')).rejects.toMatchObject({ code: 'MAINTENANCE', reason: 'restore' });
    await expect(api.api('GET', 'branches')).rejects.toMatchObject({ code: 'MAINTENANCE' });
    expect(assign).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();

    // One screen, however many requests were refused; it covers the app, which is inert meanwhile.
    const screens = document.querySelectorAll(SCREEN);
    expect(screens).toHaveLength(1);
    const screen = screens[0]!;
    expect(screen.getAttribute('role')).toBe('alertdialog');
    expect(screen.getAttribute('aria-modal')).toBe('true');
    expect(screen.textContent).toContain(t('id', 'maintenance.screen.title'));
    expect(screen.textContent).toContain(t('id', 'maintenance.screen.body'));
    expect(document.getElementById('root')!.hasAttribute('inert')).toBe(true);

    // 15 s later: auth/me is still refused (a restore closes it too) → the screen stays.
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => refused('restore'));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetchMock.mock.calls.map((c) => [c[1]?.method, c[0]])).toEqual([['GET', '/api/v1/auth/me']]);
    expect(sentHeaders(0)['x-altis-background']).toBe('1');
    expect(document.querySelector(SCREEN)).not.toBeNull();

    // Then a maintenance that is not a restore: auth/me answers, but with the maintenance banner → it stays.
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(json(meOf(['system.users.read'], { banners: [MAINTENANCE_BANNER] })));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(document.querySelector(SCREEN)).not.toBeNull();

    // The flag is gone: auth/me answers without the banner → the screen lifts itself, the app is usable again.
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(json(meOf(['system.users.read'])));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(document.querySelector(SCREEN)).toBeNull();
    expect(document.getElementById('root')!.hasAttribute('inert')).toBe(false);
    // No more retries once it lifted.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(assign).not.toHaveBeenCalled();
  });

  // auth/me lists banners only for a `full` session, and a banner provider may fail: its `maintenance: true` says the
  // flag is up whoever asks, so the screen never lifts (and comes back) while the flag stays.
  it('the screen stays while auth/me says maintenance: true, signed out or without the banner; it lifts once that is gone', async () => {
    vi.useFakeTimers();
    const { api, page } = await load();
    vi.spyOn(page.page, 'assign').mockImplementation(() => {});
    vi.spyOn(page.page, 'navigate').mockImplementation(() => {});
    await signedIn(api, meOf(['system.users.read']));
    fetchMock.mockImplementation(async () => refused('manual'));
    await expect(api.api('GET', 'users')).rejects.toMatchObject({ code: 'MAINTENANCE' });
    expect(document.querySelector(SCREEN)).not.toBeNull();

    // The session went meanwhile (idle expiry): auth/me answers signed out, with the flag still up → it stays.
    const anonymous = { authenticated: false, csrfToken: 'pre', library: { name: 'Perpustakaan', locale: 'id' }, build: '0.1.0' };
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(json({ ...anonymous, maintenance: true }));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(document.querySelector(SCREEN)).not.toBeNull();

    // A full session whose banner provider failed (no banner), the flag still up → it stays.
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(json({ ...meOf(['system.users.read']), maintenance: true }));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(document.querySelector(SCREEN)).not.toBeNull();

    // The flag is gone → the screen lifts.
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(json(anonymous));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(document.querySelector(SCREEN)).toBeNull();
  });

  // Ruling R1c-9: the screen links the operations page for whoever may open it (during a manual maintenance, any op
  // permission); a plain link, so the browser loads the server page.
  it('the screen links /admin/_update for a holder of an op permission, not for anyone else', async () => {
    const { api, page } = await load();
    vi.spyOn(page.page, 'assign').mockImplementation(() => {});
    await signedIn(api, meOf(['system.backup.create']));
    fetchMock.mockImplementation(async () => refused('manual'));
    await expect(api.api('GET', 'users')).rejects.toMatchObject({ code: 'MAINTENANCE' });
    const link = document.querySelector<HTMLAnchorElement>(`${SCREEN} a`);
    expect(link?.getAttribute('href')).toBe('/admin/_update');
    expect(link?.textContent).toBe(t('id', 'maintenance.screen.link'));
    // A new page load (fresh modules) without that screen.
    document.querySelector(SCREEN)?.remove();
    document.getElementById('root')?.removeAttribute('inert');

    const other = await load();
    await signedIn(other.api, meOf(['system.users.read']));
    fetchMock.mockImplementation(async () => refused('manual'));
    await expect(other.api.api('GET', 'users')).rejects.toMatchObject({ code: 'MAINTENANCE' });
    expect(document.querySelector(SCREEN)).not.toBeNull();
    expect(document.querySelector(`${SCREEN} a`)).toBeNull();
  });

  // The page opens only for the permission of the op's kind (server http/ops-auth.ts; any op permission when no op runs,
  // a manual maintenance): anyone else would get 403 AUTHZ_DENIED there, as a bare problem document.
  it('the screen links /admin/_update only to whoever the page opens for during that reason', async () => {
    const cases: [reason: string | undefined, permissions: string[], linked: boolean][] = [
      ['restore', ['system.backup.create'], false],
      ['restore', ['system.update.run'], false],
      ['backup', ['system.backup.restore'], false],
      ['update', ['system.backup.create', 'system.backup.restore'], false],
      ['migrate', ['system.backup.create'], false],
      ['migrate', ['system.config.manage'], true],
      ['reset', ['system.config.manage'], true],
      ['manual', ['system.update.run'], true],
      ['manual', ['system.config.manage'], false],
      [undefined, ['system.backup.create'], false],
    ];
    for (const [reason, permissions, linked] of cases) {
      const label = `${reason ?? '(none)'} with ${permissions.join(', ')}`;
      const { api, page } = await load();
      const assign = vi.spyOn(page.page, 'assign').mockImplementation(() => {});
      await signedIn(api, meOf(permissions));
      fetchMock.mockImplementation(async () =>
        reason === undefined ? problem(503, 'MAINTENANCE', {}, { 'Retry-After': '30' }) : refused(reason),
      );
      await expect(api.api('GET', 'users')).rejects.toMatchObject({ code: 'MAINTENANCE' });
      expect(assign, label).not.toHaveBeenCalled();
      expect(document.querySelector(SCREEN), label).not.toBeNull();
      expect(document.querySelector(`${SCREEN} a`)?.getAttribute('href') ?? null, label).toBe(linked ? '/admin/_update' : null);
      // A new page load (fresh modules) without that screen.
      document.querySelector(SCREEN)?.remove();
      document.getElementById('root')?.removeAttribute('inert');
      fetchMock.mockReset();
    }
  });

  it("the screen speaks the user's language; a reason without a page permission (manual) shows it even to an op permission holder", async () => {
    const { api, page } = await load();
    const assign = vi.spyOn(page.page, 'assign').mockImplementation(() => {});
    await signedIn(api, meOf(['system.update.run', 'system.backup.restore', 'system.backup.create'], { locale: 'en' }));
    fetchMock.mockImplementation(async () => refused('manual'));
    await expect(api.api('GET', 'users')).rejects.toMatchObject({ code: 'MAINTENANCE', reason: 'manual' });
    expect(assign).not.toHaveBeenCalled();
    expect(document.querySelector(SCREEN)?.textContent).toContain(t('en', 'maintenance.screen.title'));
  });

  it('no navigation when the page is /admin/_update already', async () => {
    const { api, page } = await load();
    window.history.replaceState(null, '', '/admin/_update');
    const assign = vi.spyOn(page.page, 'assign').mockImplementation(() => {});
    await signedIn(api, meOf(['system.backup.create']));
    fetchMock.mockImplementation(async () => refused('backup'));
    await expect(api.api('GET', 'users')).rejects.toMatchObject({ code: 'MAINTENANCE' });
    expect(assign).not.toHaveBeenCalled();
  });
});
