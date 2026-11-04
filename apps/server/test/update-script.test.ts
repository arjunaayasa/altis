// @vitest-environment jsdom
import { t } from '@altis/shared';
import type { OpView } from '@altis/shared/api/ops';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderUpdatePage, type UpdatePageOptions } from '../src/ops/update-page.js';
import { UPDATE_PAGE_SCRIPT } from '../src/ops/update-script.js';

// The script of the operations page (ops/update-script.ts; plan Task 19) at work in a DOM: the page renderUpdatePage
// makes, its script run against a fake `fetch`, fake timers and a fake `window.location` (jsdom implements no
// navigation). The page is the only UI that drives an op in `external` mode, so what it sends, how often, and when it
// stops are checked here: the drive loop is paced (a call that came back at once or found nothing to do waits), drive
// POSTs carry the page's token, a 401 stops the page, `done` returns to /admin after 3 s, and a restore that failed after
// `failed_restoring_pre` shows the CLI lines. Ruling R1c-9: cancel and takeover re-authenticate on the page itself
// (password, plus the code with 2FA, `POST auth/reauth` with the session's token), then repeat the action.

/** The few DOM members these tests use (the server's TypeScript project has no DOM library). */
interface El {
  hidden: boolean;
  textContent: string | null;
  tagName: string;
  value: string;
  disabled: boolean;
  click(): void;
}
interface Doc {
  body: { innerHTML: string };
  getElementById(id: string): El | null;
}
const doc = (): Doc => (globalThis as unknown as { document: Doc }).document;

const OP_TOKEN = 'op-token-'.padEnd(43, 'x');
const SESSION_TOKEN = 'session-token-'.padEnd(43, 'y');

/** A driveable frozen backup in external mode, held by the op's cookie (its token on the view). */
function opView(over: Partial<OpView> = {}): OpView {
  return {
    opId: '01JB0000000000000000000000',
    kind: 'backup',
    state: 'exporting',
    terminal: false,
    needsAttention: false,
    startedAt: 1_000,
    heartbeatAt: 1_000,
    finishedAt: null,
    progress: 10,
    message: null,
    error: null,
    pointOfNoReturn: false,
    backupId: null,
    actor: { type: 'staff', id: '01JB0000000000000000000001' },
    mode: 'external',
    csrfToken: OP_TOKEN,
    driveable: true,
    ...over,
  };
}

interface Call {
  at: number;
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

interface FakeReply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Answer after this many ms (fake time) instead of at once. */
  delayMs?: number;
}

type Handler = (call: Call) => FakeReply;

const ok = (body: unknown): FakeReply => ({ status: 200, body });
const problem = (status: number, code: string): FakeReply => ({ status, body: { status, code } });

let calls: Call[];
let routes: Map<string, Handler>;
let assign: ReturnType<typeof vi.fn<(href: string) => void>>;
let confirm: ReturnType<typeof vi.fn<(text: string) => boolean>>;

/** The fake `fetch` the script gets: answers by `METHOD path`, records every call. */
async function fakeFetch(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  const method = init.method ?? 'GET';
  const call: Call = {
    at: Date.now(),
    method,
    url,
    headers: { ...init.headers },
    body: init.body === undefined ? undefined : (JSON.parse(init.body) as unknown),
  };
  calls.push(call);
  const handler = routes.get(`${method} ${url}`);
  const reply: FakeReply = handler === undefined ? problem(404, 'NOT_FOUND') : handler(call);
  if (reply.delayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
  const headers = Object.fromEntries(Object.entries(reply.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status: reply.status,
    ok: reply.status >= 200 && reply.status < 300,
    headers: { get: (name: string): string | null => headers[name.toLowerCase()] ?? null },
    body: null,
    text: async (): Promise<string> => (reply.body === undefined ? '' : JSON.stringify(reply.body)),
  };
}

/** Renders the page into the document and runs its script with the fakes above (as a browser would, once). */
function openPage(o: Partial<UpdatePageOptions> & { op: OpView | null }): void {
  const html = renderUpdatePage({ locale: 'id', nonce: 'n0nce', csrfToken: o.op?.csrfToken ?? null, ...o });
  const body = /<body>([\s\S]*)<\/body>/.exec(html)?.[1] ?? '';
  // innerHTML never runs a script: the JSON blocks are there to read, the page script runs below.
  doc().body.innerHTML = body;
  const window = { location: { assign }, confirm };
  // The page's own script, run as the browser runs it: once, with `window` and `fetch` replaced.
  const run = new Function('window', 'fetch', UPDATE_PAGE_SCRIPT) as (w: typeof window, f: typeof fakeFetch) => void;
  run(window, fakeFetch);
}

const el = (id: string): El => {
  const found = doc().getElementById(id);
  if (found === null) throw new Error(`no #${id}`);
  return found;
};
const callsTo = (method: string, path: string): Call[] => calls.filter((c) => c.method === method && c.url === path);

beforeEach(() => {
  vi.useFakeTimers({ now: 0 });
  calls = [];
  routes = new Map();
  assign = vi.fn<(href: string) => void>();
  confirm = vi.fn<(text: string) => boolean>(() => true);
});

afterEach(() => {
  vi.useRealTimers();
  doc().body.innerHTML = '';
});

describe('the drive loop (external mode)', () => {
  it('an instant answer that changes nothing → at most one drive call per ~1.5 s, never a flood', async () => {
    const op = opView();
    let drives = 0;
    routes.set('POST /api/v1/ops/drive', () => {
      drives += 1;
      // A safety stop for a loop without any pacing: after 40 calls the op waits for a person.
      return ok(drives >= 40 ? opView({ needsAttention: true, driveable: false, state: 'needs_attention' }) : op);
    });
    routes.set('GET /api/v1/ops/current', () => ok(op));
    openPage({ op });
    await vi.advanceTimersByTimeAsync(10_000);
    const n = callsTo('POST', '/api/v1/ops/drive').length;
    expect(n).toBeGreaterThanOrEqual(5);
    expect(n).toBeLessThanOrEqual(8);
  });

  it('a call that used its slice and moved the op → the next one at once (back to back)', async () => {
    let progress = 10;
    routes.set('POST /api/v1/ops/drive', () => {
      progress += 10;
      return { ...ok(opView({ progress, heartbeatAt: progress })), delayMs: 5_000 };
    });
    routes.set('GET /api/v1/ops/current', () => ok(opView({ progress })));
    openPage({ op: opView() });
    await vi.advanceTimersByTimeAsync(15_001);
    expect(callsTo('POST', '/api/v1/ops/drive').map((c) => c.at)).toEqual([0, 5_000, 10_000, 15_000]);
  });

  it('a slow call that moved nothing (another process holds the step lock) → it waits before the next', async () => {
    routes.set('POST /api/v1/ops/drive', () => ({ ...ok(opView()), delayMs: 1_200 }));
    routes.set('GET /api/v1/ops/current', () => ok(opView()));
    openPage({ op: opView() });
    await vi.advanceTimersByTimeAsync(6_000);
    const at = callsTo('POST', '/api/v1/ops/drive').map((c) => c.at);
    for (let i = 1; i < at.length; i += 1) expect(at[i]! - at[i - 1]!).toBeGreaterThanOrEqual(2_500);
  });

  it('every drive POST carries the op token as X-CSRF-Token and a JSON body', async () => {
    let drives = 0;
    routes.set('POST /api/v1/ops/drive', () => {
      drives += 1;
      return ok(drives >= 3 ? opView({ state: 'done', terminal: true, driveable: false, progress: 100 }) : opView());
    });
    routes.set('GET /api/v1/ops/current', () => ok(opView()));
    openPage({ op: opView() });
    await vi.advanceTimersByTimeAsync(10_000);
    const posts = callsTo('POST', '/api/v1/ops/drive');
    expect(posts.length).toBeGreaterThanOrEqual(3);
    for (const post of posts) {
      expect(post.headers['X-CSRF-Token']).toBe(OP_TOKEN);
      expect(post.headers['Content-Type']).toBe('application/json');
      expect(post.body).toEqual({});
    }
  });

  it('worker mode: the page never drives, it only polls (with X-Altis-Background)', async () => {
    const op = opView({ mode: 'worker' });
    routes.set('GET /api/v1/ops/current', () => ok(op));
    openPage({ op });
    await vi.advanceTimersByTimeAsync(6_500);
    expect(callsTo('POST', '/api/v1/ops/drive')).toEqual([]);
    const polls = callsTo('GET', '/api/v1/ops/current');
    expect(polls).toHaveLength(3);
    for (const poll of polls) expect(poll.headers['X-Altis-Background']).toBe('1');
  });
});

describe('stopping, returning, the CLI lines', () => {
  it('a 401 stops the page: no more polls, the "lost" text shows', async () => {
    const op = opView({ mode: 'worker' });
    routes.set('GET /api/v1/ops/current', () => problem(401, 'OPS_AUTH_REQUIRED'));
    openPage({ op });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(callsTo('GET', '/api/v1/ops/current')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(callsTo('GET', '/api/v1/ops/current')).toHaveLength(1);
    expect(el('status').hidden).toBe(false);
    expect(el('status').textContent).toMatch(/tidak dapat lagi mengikuti operasi/);
  });

  it('a 401 on a drive call stops the drive loop and the polls', async () => {
    routes.set('POST /api/v1/ops/drive', () => problem(401, 'OPS_AUTH_REQUIRED'));
    routes.set('GET /api/v1/ops/current', () => ok(opView()));
    openPage({ op: opView() });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls.filter((c) => c.url !== '/api/v1/ops/report')).toHaveLength(1);
  });

  it('done → back to /admin after 3 s, not before', async () => {
    const op = opView({ mode: 'worker', driveable: true });
    const done = opView({ mode: 'worker', state: 'done', terminal: true, driveable: false, progress: 100 });
    routes.set('GET /api/v1/ops/current', () => ok(done));
    openPage({ op });
    await vi.advanceTimersByTimeAsync(2_000); // the first poll sees `done`
    expect(el('done').hidden).toBe(false);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(assign).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(assign).toHaveBeenCalledExactlyOnceWith('/admin');
  });

  it('a restore seen in failed_restoring_pre that then failed → the CLI lines show', async () => {
    const restore = (state: string): OpView =>
      opView({ kind: 'restore', mode: 'worker', state, backupId: '01JB00000000000000000000BK', terminal: state === 'failed' });
    let state = 'failed_restoring_pre';
    routes.set('GET /api/v1/ops/current', () => ok(restore(state)));
    openPage({ op: restore('loading') });
    expect(el('cli').hidden).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(el('cli').hidden).toBe(true);
    state = 'failed';
    await vi.advanceTimersByTimeAsync(2_000);
    expect(el('cli').hidden).toBe(false);
    expect(el('cli-lines').textContent).toBe('node app.js maintenance:off --force\nnode app.js backup:restore 01JB00000000000000000000BK');
  });

  it('needs_attention → the CLI way out: ops:resume, and ops:cancel before the point of no return (OPS-ATTN-EXIT)', async () => {
    const stuck = (over: Partial<OpView>): OpView =>
      opView({ mode: 'worker', state: 'needs_attention', needsAttention: true, driveable: false, backupId: '01JB00000000000000000000BK', ...over });
    let view = stuck({});
    routes.set('GET /api/v1/ops/current', () => ok(view));
    openPage({ op: view });
    expect(el('cli').hidden).toBe(false);
    expect(el('cli-lines').textContent).toBe('node app.js ops:resume\nnode app.js ops:cancel');
    view = stuck({ pointOfNoReturn: true });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(el('cli-lines').textContent).toBe('node app.js ops:resume');
    // An op.json nobody can read (no startedAt): set it aside, then maintenance off or the last backup restored.
    view = stuck({ pointOfNoReturn: true, startedAt: null, heartbeatAt: null, actor: null });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(el('cli-lines').textContent).toBe(
      'node app.js ops:cancel\nnode app.js maintenance:off\nnode app.js backup:restore 01JB00000000000000000000BK',
    );
  });
});


describe('cancel and takeover: the page re-authenticates itself (R1c-9)', () => {
  /** A worker-mode op seen through a session (no op token on the view). */
  const sessionOp = (over: Partial<OpView> = {}): OpView => opView({ mode: 'worker', csrfToken: null, ...over });
  /** What a cancel ends in (OpsMachine.cancel: the kind's failure state). */
  const cancelled = (): OpView => sessionOp({ state: 'failed', terminal: true, driveable: false });
  const sessionPage = (op: OpView, totp = false): void =>
    openPage({ op, csrfToken: SESSION_TOKEN, session: true, sessionCsrfToken: SESSION_TOKEN, totp });

  beforeEach(() => {
    routes.set('GET /api/v1/ops/current', () => ok(sessionOp()));
  });

  it('cancel → 401 AUTH_REAUTH_REQUIRED → the form (no navigation); the password → auth/reauth with the session token → cancel again', async () => {
    let reauthed = false;
    routes.set('POST /api/v1/ops/cancel', () => (reauthed ? ok(cancelled()) : problem(401, 'AUTH_REAUTH_REQUIRED')));
    routes.set('POST /api/v1/auth/reauth', () => {
      reauthed = true;
      return ok({ reauthUntil: 300_000 });
    });
    sessionPage(sessionOp());
    expect(el('reauth').hidden).toBe(true);
    el('cancel').click();
    await vi.advanceTimersByTimeAsync(0);
    expect(confirm).toHaveBeenCalledOnce();
    expect(el('reauth').hidden).toBe(false);
    expect(doc().getElementById('reauth-code')).toBeNull(); // no 2FA: the password alone
    expect(assign).not.toHaveBeenCalled();

    el('reauth-password').value = 'rahasia-kepala';
    el('reauth-submit').click();
    await vi.advanceTimersByTimeAsync(0);
    const reauth = callsTo('POST', '/api/v1/auth/reauth');
    expect(reauth).toHaveLength(1);
    expect(reauth[0]!.headers['X-CSRF-Token']).toBe(SESSION_TOKEN);
    expect(reauth[0]!.body).toEqual({ password: 'rahasia-kepala' });
    const cancels = callsTo('POST', '/api/v1/ops/cancel');
    expect(cancels).toHaveLength(2);
    for (const call of cancels) expect(call.headers['X-CSRF-Token']).toBe(SESSION_TOKEN);
    expect(confirm).toHaveBeenCalledOnce(); // the repeat asks nothing again
    expect(el('reauth').hidden).toBe(true);
    expect(el('reauth-password').value).toBe('');
    expect(el('op-state').textContent).toBe(t('id', 'ops.state.failed'));
    expect(el('cancel').hidden).toBe(true);
    expect(assign).not.toHaveBeenCalled();
  });

  it('with 2FA: the code field shows, a code that is not six digits is refused on the page, six digits go along', async () => {
    let reauthed = false;
    routes.set('POST /api/v1/ops/cancel', () => (reauthed ? ok(cancelled()) : problem(401, 'AUTH_REAUTH_REQUIRED')));
    routes.set('POST /api/v1/auth/reauth', () => {
      reauthed = true;
      return ok({ reauthUntil: 300_000 });
    });
    sessionPage(sessionOp(), true);
    el('cancel').click();
    await vi.advanceTimersByTimeAsync(0);
    expect(el('reauth-code-field').hidden).toBe(false);
    el('reauth-password').value = 'rahasia-kepala';
    el('reauth-code').value = '12a';
    el('reauth-submit').click();
    await vi.advanceTimersByTimeAsync(0);
    expect(callsTo('POST', '/api/v1/auth/reauth')).toEqual([]);
    expect(el('reauth-error').hidden).toBe(false);
    expect(el('reauth-error').textContent).toBe(t('id', 'ops.page.reauth.code_invalid'));

    el('reauth-code').value = '123456';
    el('reauth-submit').click();
    await vi.advanceTimersByTimeAsync(0);
    expect(callsTo('POST', '/api/v1/auth/reauth')[0]!.body).toEqual({ password: 'rahasia-kepala', code: '123456' });
    expect(callsTo('POST', '/api/v1/ops/cancel')).toHaveLength(2);
  });

  it('an empty password is refused on the page; a wrong one says so and is not followed by another cancel', async () => {
    routes.set('POST /api/v1/ops/cancel', () => problem(401, 'AUTH_REAUTH_REQUIRED'));
    routes.set('POST /api/v1/auth/reauth', () => problem(401, 'AUTH_INVALID_CREDENTIALS'));
    sessionPage(sessionOp());
    el('cancel').click();
    await vi.advanceTimersByTimeAsync(0);
    el('reauth-submit').click();
    await vi.advanceTimersByTimeAsync(0);
    expect(callsTo('POST', '/api/v1/auth/reauth')).toEqual([]);
    expect(el('reauth-error').textContent).toBe(t('id', 'ops.page.reauth.password_missing'));

    el('reauth-password').value = 'salah';
    el('reauth-submit').click();
    await vi.advanceTimersByTimeAsync(0);
    expect(callsTo('POST', '/api/v1/auth/reauth')).toHaveLength(1);
    expect(el('reauth-error').textContent).toBe(t('id', 'ops.page.reauth.wrong_password'));
    expect(el('reauth').hidden).toBe(false);
    expect(callsTo('POST', '/api/v1/ops/cancel')).toHaveLength(1);
  });

  it('past a restore point of no return auth/reauth answers 409: the page says so', async () => {
    routes.set('POST /api/v1/ops/cancel', () => problem(401, 'AUTH_REAUTH_REQUIRED'));
    routes.set('POST /api/v1/auth/reauth', () => problem(409, 'OPS_POINT_OF_NO_RETURN'));
    sessionPage(sessionOp({ kind: 'restore', state: 'prechecked' }));
    el('cancel').click();
    await vi.advanceTimersByTimeAsync(0);
    el('reauth-password').value = 'rahasia-kepala';
    el('reauth-submit').click();
    await vi.advanceTimersByTimeAsync(0);
    expect(el('reauth-error').textContent).toBe(t('id', 'error.OPS_POINT_OF_NO_RETURN'));
    expect(callsTo('POST', '/api/v1/ops/cancel')).toHaveLength(1);
  });

  it('Tutup closes the form and sends nothing more', async () => {
    routes.set('POST /api/v1/ops/cancel', () => problem(401, 'AUTH_REAUTH_REQUIRED'));
    sessionPage(sessionOp());
    el('cancel').click();
    await vi.advanceTimersByTimeAsync(0);
    el('reauth-password').value = 'setengah';
    el('reauth-dismiss').click();
    await vi.advanceTimersByTimeAsync(0);
    expect(el('reauth').hidden).toBe(true);
    expect(el('reauth-password').value).toBe('');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('takeover → reauth → takeover again: the page then holds the op token for its ops calls', async () => {
    const attention = (token: string | null): OpView =>
      opView({ mode: 'external', state: 'needs_attention', needsAttention: true, driveable: false, csrfToken: token });
    let reauthed = false;
    routes.set('GET /api/v1/ops/current', () => ok(attention(null)));
    routes.set('POST /api/v1/ops/takeover', () => (reauthed ? ok(attention(OP_TOKEN)) : problem(401, 'AUTH_REAUTH_REQUIRED')));
    routes.set('POST /api/v1/auth/reauth', () => {
      reauthed = true;
      return ok({ reauthUntil: 300_000 });
    });
    routes.set('POST /api/v1/ops/drive', () => ok(attention(OP_TOKEN)));
    sessionPage(attention(null));
    expect(el('takeover').hidden).toBe(false);
    el('takeover').click();
    await vi.advanceTimersByTimeAsync(0);
    expect(el('reauth').hidden).toBe(false);
    el('reauth-password').value = 'rahasia-kepala';
    el('reauth-submit').click();
    await vi.advanceTimersByTimeAsync(0);
    expect(callsTo('POST', '/api/v1/ops/takeover')).toHaveLength(2);
    expect(el('takeover').hidden).toBe(true);
    el('resume').click();
    await vi.advanceTimersByTimeAsync(0);
    const [resume] = callsTo('POST', '/api/v1/ops/drive');
    expect(resume!.body).toEqual({ resume: true });
    expect(resume!.headers['X-CSRF-Token']).toBe(OP_TOKEN);
  });

  it('a refused cancel (403 AUTHZ_DENIED) says why and the page keeps following the op', async () => {
    routes.set('POST /api/v1/ops/cancel', () => problem(403, 'AUTHZ_DENIED'));
    sessionPage(sessionOp());
    el('cancel').click();
    await vi.advanceTimersByTimeAsync(0);
    expect(el('status').textContent).toBe(t('id', 'error.AUTHZ_DENIED'));
    await vi.advanceTimersByTimeAsync(4_000);
    expect(callsTo('GET', '/api/v1/ops/current')).toHaveLength(2);
  });

  it('the session ended meanwhile: a cancel or a reauth refused with OPS_AUTH_REQUIRED says so in words, not as a code', async () => {
    routes.set('POST /api/v1/ops/cancel', () => problem(401, 'OPS_AUTH_REQUIRED'));
    sessionPage(sessionOp());
    el('cancel').click();
    await vi.advanceTimersByTimeAsync(0);
    expect(el('status').textContent).toBe(t('id', 'error.OPS_AUTH_REQUIRED'));

    // The form was open when the session went (idle expiry): auth/reauth refuses, the repeated cancel never goes out.
    let cancels = 0;
    routes.set('POST /api/v1/ops/cancel', () => (++cancels === 1 ? problem(401, 'AUTH_REAUTH_REQUIRED') : problem(401, 'OPS_AUTH_REQUIRED')));
    routes.set('POST /api/v1/auth/reauth', () => problem(401, 'OPS_AUTH_REQUIRED'));
    el('cancel').click();
    await vi.advanceTimersByTimeAsync(0);
    el('reauth-password').value = 'rahasia-kepala';
    el('reauth-submit').click();
    await vi.advanceTimersByTimeAsync(0);
    expect(el('reauth-error').textContent).toBe(t('id', 'error.OPS_AUTH_REQUIRED'));
    expect(cancels).toBe(1);

    // The texts of both refusals a cancel or takeover may meet ride along in the page's #i18n block.
    const texts = JSON.parse(el('i18n').textContent ?? '{}') as Record<string, string>;
    expect(texts['error.OPS_AUTH_REQUIRED']).toBe(t('id', 'error.OPS_AUTH_REQUIRED'));
    expect(texts['error.AUTH_REAUTH_REQUIRED']).toBe(t('id', 'error.AUTH_REAUTH_REQUIRED'));
  });

  it('a session token the server rotated is the one the next reauth carries', async () => {
    const rotated = 'rotated-token-'.padEnd(43, 'z');
    routes.set('POST /api/v1/ops/cancel', () => ({ ...problem(401, 'AUTH_REAUTH_REQUIRED'), headers: { 'X-CSRF-Token': rotated } }));
    routes.set('POST /api/v1/auth/reauth', () => problem(401, 'AUTH_INVALID_CREDENTIALS'));
    sessionPage(sessionOp());
    el('cancel').click();
    await vi.advanceTimersByTimeAsync(0);
    el('reauth-password').value = 'rahasia-kepala';
    el('reauth-submit').click();
    await vi.advanceTimersByTimeAsync(0);
    expect(callsTo('POST', '/api/v1/auth/reauth')[0]!.headers['X-CSRF-Token']).toBe(rotated);
  });
});

describe('cancel and takeover go first (final review: starved behind back-to-back drives)', () => {
  /** An external-mode op seen through a session: this page drives it itself. */
  const drivenOp = (over: Partial<OpView> = {}): OpView => opView({ csrfToken: null, ...over });
  const sessionPage = (op: OpView): void =>
    openPage({ op, csrfToken: SESSION_TOKEN, session: true, sessionCsrfToken: SESSION_TOKEN, totp: false });

  const failed = (): OpView => drivenOp({ state: 'failed', terminal: true, driveable: false });

  /** Drives that each use their 5 s slice and move the op (back to back), until `ended()` says the op was cancelled. */
  function busyDrives(ended: () => boolean = () => false): void {
    let progress = 10;
    routes.set('POST /api/v1/ops/drive', () => {
      progress += 1;
      return { ...ok(ended() ? failed() : drivenOp({ progress, heartbeatAt: progress })), delayMs: 5_000 };
    });
    routes.set('GET /api/v1/ops/current', () => ok(ended() ? failed() : drivenOp({ progress })));
  }

  it('while a cancel waits for its answer the page starts no drive', async () => {
    let cancelled = false;
    busyDrives(() => cancelled);
    routes.set('POST /api/v1/ops/cancel', () => {
      cancelled = true;
      return { ...ok(failed()), delayMs: 12_000 };
    });
    sessionPage(drivenOp());
    await vi.advanceTimersByTimeAsync(1_000); // the first drive is under way
    el('cancel').click();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(callsTo('POST', '/api/v1/ops/cancel')).toHaveLength(1);
    // The drive under way at the click ends at 5 s; none follows it while the cancel waits (answered at 13 s).
    expect(callsTo('POST', '/api/v1/ops/drive').map((c) => c.at)).toEqual([0]);
    expect(el('op-state').textContent).toBe(t('id', 'ops.state.failed'));
  });

  it('while the reauth form is open the page starts no drive; closing it lets the drive go on', async () => {
    busyDrives();
    routes.set('POST /api/v1/ops/cancel', () => problem(401, 'AUTH_REAUTH_REQUIRED'));
    sessionPage(drivenOp());
    el('cancel').click();
    await vi.advanceTimersByTimeAsync(0);
    expect(el('reauth').hidden).toBe(false);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(callsTo('POST', '/api/v1/ops/drive').map((c) => c.at)).toEqual([0]);
    el('reauth-dismiss').click();
    await vi.advanceTimersByTimeAsync(3_000); // the next poll renders the op and drives again
    expect(callsTo('POST', '/api/v1/ops/drive').length).toBeGreaterThan(1);
  });

  it('a reauth form left open holds the drive for 60 s at most: the page, perhaps the only driver, drives again (final review G2)', async () => {
    busyDrives();
    routes.set('POST /api/v1/ops/cancel', () => problem(401, 'AUTH_REAUTH_REQUIRED'));
    sessionPage(drivenOp());
    el('cancel').click();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(55_000);
    expect(callsTo('POST', '/api/v1/ops/drive').map((c) => c.at)).toEqual([0]);
    await vi.advanceTimersByTimeAsync(10_000); // past 60 s: the next poll drives again, the form still open
    expect(el('reauth').hidden).toBe(false);
    const drives = callsTo('POST', '/api/v1/ops/drive').map((c) => c.at);
    expect(drives.length).toBeGreaterThan(1);
    expect(drives[1]).toBeGreaterThanOrEqual(60_000);
  });

  it('a cancel answered 409 OPS_IN_PROGRESS (a step kept the lock) is sent again, and lands', async () => {
    let cancels = 0;
    busyDrives(() => cancels > 1);
    routes.set('POST /api/v1/ops/cancel', () => {
      cancels += 1;
      // The first waited out the server's lock wait behind the drive under way.
      return cancels === 1 ? { ...problem(409, 'OPS_IN_PROGRESS'), delayMs: 6_000 } : ok(failed());
    });
    sessionPage(drivenOp());
    el('cancel').click();
    await vi.advanceTimersByTimeAsync(8_000);
    expect(callsTo('POST', '/api/v1/ops/cancel')).toHaveLength(2);
    expect(el('op-state').textContent).toBe(t('id', 'ops.state.failed'));
    expect(el('status').hidden).toBe(true);
  });
});

describe('a page held by a session alone, on several processes (final review, ops minor)', () => {
  const sessionOp = (): OpView => opView({ mode: 'worker', csrfToken: null });
  const sessionPage = (): void =>
    openPage({ op: sessionOp(), csrfToken: SESSION_TOKEN, session: true, sessionCsrfToken: SESSION_TOKEN, totp: false });

  it('a 401 OPS_AUTH_REQUIRED from a process waiting in ops_wait (it reads no session) does not stop the page', async () => {
    let polls = 0;
    routes.set('GET /api/v1/ops/current', () => {
      polls += 1;
      return polls <= 2 ? problem(401, 'OPS_AUTH_REQUIRED') : ok(sessionOp());
    });
    sessionPage();
    await vi.advanceTimersByTimeAsync(8_000);
    expect(callsTo('GET', '/api/v1/ops/current').length).toBeGreaterThanOrEqual(4);
    expect(el('status').hidden).toBe(true);
  });

  it('five refusals in a row stop it: the session is gone', async () => {
    routes.set('GET /api/v1/ops/current', () => problem(401, 'OPS_AUTH_REQUIRED'));
    sessionPage();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(callsTo('GET', '/api/v1/ops/current')).toHaveLength(5);
    expect(el('status').textContent).toMatch(/tidak dapat lagi mengikuti operasi/);
  });
});

describe('a page held by the op cookie alone', () => {
  it('cancel is a link to the sign-in (no handler, no request); there is no takeover and no reauth form', async () => {
    routes.set('GET /api/v1/ops/current', () => ok(opView({ mode: 'worker' })));
    openPage({ op: opView({ mode: 'worker' }) });
    expect(el('cancel').tagName).toBe('A');
    expect(el('cancel').hidden).toBe(false);
    expect(doc().getElementById('takeover')).toBeNull();
    expect(doc().getElementById('reauth')).toBeNull();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  it('during a restore the sign-in link stays hidden (sign-in is closed until the restore ends)', async () => {
    const restore = opView({ kind: 'restore', state: 'prechecked', mode: 'worker' });
    routes.set('GET /api/v1/ops/current', () => ok(restore));
    openPage({ op: restore });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(el('cancel').hidden).toBe(true);
  });
});

// ---- 1d Task 29 (spec §9.6-9.8; preflight 1D-27): update states on the page, SSE when available -------------------
describe('1d Task 29: an update op, a blocked bundled release, SSE', () => {
  const BACKUP = '01JB00000000000000000000BK';
  /** A worker-mode update op seen through a session. */
  const updateOp = (over: Partial<OpView> = {}): OpView =>
    opView({ kind: 'update', state: 'downloading', mode: 'worker', csrfToken: null, update: { target: '0.2.0', dbRestoreNeeded: false }, ...over });

  /** A fake EventSource: its listeners, what it was opened on, closed or not. */
  class FakeEventSource {
    static made: FakeEventSource[] = [];
    readyState = 0;
    closed = false;
    readonly listeners = new Map<string, (() => void)[]>();
    constructor(readonly url: string) {
      FakeEventSource.made.push(this);
    }
    addEventListener(type: string, fn: () => void): void {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
    }
    close(): void {
      this.closed = true;
      this.readyState = 2;
    }
    emit(type: string): void {
      if (type === 'open') this.readyState = 1;
      for (const fn of this.listeners.get(type) ?? []) fn();
    }
  }

  /** The page with `EventSource` (the fake) in scope, as a browser has it. */
  function openWithSse(o: Partial<UpdatePageOptions> & { op: OpView | null }): void {
    FakeEventSource.made = [];
    const html = renderUpdatePage({ locale: 'id', nonce: 'n0nce', csrfToken: SESSION_TOKEN, session: true, sessionCsrfToken: SESSION_TOKEN, ...o });
    doc().body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(html)?.[1] ?? '';
    const window = { location: { assign }, confirm };
    const run = new Function('window', 'fetch', 'EventSource', UPDATE_PAGE_SCRIPT) as (w: typeof window, f: typeof fakeFetch, e: typeof FakeEventSource) => void;
    run(window, fakeFetch, FakeEventSource);
  }

  it('an update in restore_failed → maintenance:off --force, backup:restore <id>, release:rollback; a schemaHold failure → its instruction, no release:rollback', async () => {
    const failed = (code: string): OpView =>
      updateOp({ state: 'restore_failed', terminal: true, driveable: false, pointOfNoReturn: true, backupId: BACKUP, error: { code } });
    let view = updateOp();
    routes.set('GET /api/v1/ops/current', () => ok(view));
    openPage({ op: view });
    expect(el('cli').hidden).toBe(true);
    expect(el('schema-hold').hidden).toBe(true);
    view = failed('UPDATE_BOOT_FAILED');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(el('cli-lines').textContent).toBe(`node app.js maintenance:off --force\nnode app.js backup:restore ${BACKUP}\nnode app.js release:rollback`);
    expect(el('schema-hold').hidden).toBe(true);
    view = failed('UPDATE_SCHEMA_HOLD_FAILED');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(el('cli-lines').textContent).toBe(`node app.js maintenance:off --force\nnode app.js backup:restore ${BACKUP}`);
    expect(el('schema-hold').hidden).toBe(false);
    expect(el('schema-hold').textContent).toBe(t('id', 'ops.page.schema_hold', { backupId: BACKUP }));
  });

  it('the db-restore label follows the op view (update.dbRestoreNeeded)', async () => {
    let view = updateOp({ update: { target: '0.3.0', dbRestoreNeeded: true } });
    routes.set('GET /api/v1/ops/current', () => ok(view));
    openPage({ op: view });
    expect(el('db-restore').hidden).toBe(false);
    expect(el('db-restore').textContent).toBe(t('id', 'ops.page.db_restore_needed'));
    view = updateOp();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(el('db-restore').hidden).toBe(true);
  });

  it('no op any more → GET updates/status once, its blocked bundled release named with each failure (as text, never HTML)', async () => {
    let none = false;
    routes.set('GET /api/v1/ops/current', () => (none ? problem(404, 'OPS_NONE') : ok(updateOp())));
    routes.set('GET /api/v1/updates/status', () =>
      ok({
        op: null,
        releases: { active: '0.1.0', previous: null, pending: null, pinned: null },
        serving: 'server',
        bundledBlocked: { version: '0.2.0', failures: ['min_node', '<b>x</b>'] },
      }),
    );
    openPage({ op: updateOp() });
    expect(el('bundled').hidden).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(callsTo('GET', '/api/v1/updates/status')).toEqual([]); // an op runs: not the page's subject
    none = true;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(el('bundled').hidden).toBe(false);
    expect(el('bundled-text').textContent).toBe(t('id', 'ops.page.bundled_blocked', { version: '0.2.0' }));
    const items = (el('bundled-failures') as unknown as { children: ArrayLike<{ textContent: string | null }> }).children;
    expect(Array.from(items, (i) => i.textContent)).toEqual([t('id', 'update.precheck.min_node'), '<b>x</b>']);
    await vi.advanceTimersByTimeAsync(6_000);
    const asked = callsTo('GET', '/api/v1/updates/status');
    expect(asked).toHaveLength(1); // once per change of state, not every poll
    expect(asked[0]!.headers['X-Altis-Background']).toBe('1');
  });

  it('SSE: an open stream on system.update slows the polls of an update op to 10 s; each op.progress hint polls at once', async () => {
    routes.set('GET /api/v1/ops/current', () => ok(updateOp()));
    openWithSse({ op: updateOp(), sse: true });
    expect(FakeEventSource.made.map((s) => s.url)).toEqual(['/api/v1/events/stream?channels=system.update']);
    const stream = FakeEventSource.made[0]!;
    stream.emit('open');
    await vi.advanceTimersByTimeAsync(9_000);
    expect(callsTo('GET', '/api/v1/ops/current')).toEqual([]);
    stream.emit('op.progress');
    await vi.advanceTimersByTimeAsync(0);
    expect(callsTo('GET', '/api/v1/ops/current')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(callsTo('GET', '/api/v1/ops/current')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(callsTo('GET', '/api/v1/ops/current')).toHaveLength(2);
  });

  it('SSE refused (SSE off, no free slot, app.js answering 503): the stream closes and the page polls every 2 s', async () => {
    routes.set('GET /api/v1/ops/current', () => ok(updateOp()));
    openWithSse({ op: updateOp(), sse: true });
    const stream = FakeEventSource.made[0]!;
    stream.readyState = 2;
    stream.emit('error');
    expect(stream.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(6_500);
    expect(callsTo('GET', '/api/v1/ops/current')).toHaveLength(3);
  });

  it('without SSE (state.sse false), or on a page held by the op cookie alone: no stream, polling every 2 s', async () => {
    routes.set('GET /api/v1/ops/current', () => ok(updateOp()));
    openWithSse({ op: updateOp(), sse: false });
    expect(FakeEventSource.made).toEqual([]);
    await vi.advanceTimersByTimeAsync(4_500);
    expect(callsTo('GET', '/api/v1/ops/current')).toHaveLength(2);
    openWithSse({ op: updateOp(), sse: true, session: false });
    expect(FakeEventSource.made).toEqual([]);
  });

  it('a refusal (401/403) stops the page and closes the stream', async () => {
    routes.set('GET /api/v1/ops/current', () => problem(403, 'AUTHZ_DENIED'));
    openWithSse({ op: updateOp(), sse: true });
    const stream = FakeEventSource.made[0]!;
    stream.emit('op.progress');
    await vi.advanceTimersByTimeAsync(0);
    expect(stream.closed).toBe(true);
    expect(el('status').textContent).toMatch(/tidak dapat lagi mengikuti operasi/);
  });
});
