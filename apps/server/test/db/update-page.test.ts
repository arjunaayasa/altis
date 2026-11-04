import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeSettings, type OpsMachine } from '@altis/core';
import { PHASE1_MIGRATIONS, runMigrations, withTx, type DbHandle } from '@altis/db';
import { MESSAGES, newId, t, type MessageKey } from '@altis/shared';
import type { Banner, MeResponse } from '@altis/shared/api/auth';
import type { OpView } from '@altis/shared/api/ops';
import { PRECHECK_FAILURE_VIEWS, type UpdateStatusView } from '@altis/shared/api/updates';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { createApp, type AppPhase, type AppState } from '../../src/app.js';
import { cspHeader } from '../../src/http/csp.js';
import { csrfKey, opsCsrfToken } from '../../src/http/csrf.js';
import { createOpsFence } from '../../src/http/ops-fence.js';
import { OPS_SIGN_IN_HREF, UPDATE_PAGE_ERROR_CODES } from '../../src/ops/update-page.js';
import { UPDATE_PAGE_SCRIPT } from '../../src/ops/update-script.js';
import { ALL_ROUTES } from '../../src/routes.js';
import { createAppOps } from '../../src/services.js';
import { createAgent, type Agent, type AgentReply } from '../agent.js';
import { flagOf, readOpJson, writeFlag, writeOp, type WrittenOp } from '../ops-support.js';
import { seedStaff, sessionCookieFor, sessionCsrfFor } from '../support-auth.js';
import { recordingLogger, sampleConfig } from '../support.js';

// The operations page `/admin/_update` (spec §9.4, §7.4; plan Task 19, decision C20) on the engine picked by
// ALTIS_TEST_DB: a self-contained server page whose inline script and style carry the CSP nonce, which follows and
// drives the op with the op's CSRF token, and which reads no table during a restore; without a cookie or a session it
// sends the browser to the sign-in page (outside a restore) or says the op can be followed only from the browser that
// started it (during one). Also the `maintenance` banner of `GET auth/me` and the maintenance page of step 5.

const ctx = testDbContext();
/** In the past: an audit row may not be dated ahead of the real clock. */
const NOW = Date.UTC(2026, 9, 20, 9, 0, 5);
const CONFIG = sampleConfig({ db: { dialect: 'sqlite' } });
const OPS_COOKIE = '__Host-altis_ops'; // sampleConfig's baseUrl is https
const SID_COOKIE = '__Host-altis_sid';
const PAGE = '/admin/_update';
const HTML = { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };
const MAINTENANCE_BANNER: Banner = { kind: 'maintenance', severity: 'warning', messageKey: 'banner.maintenance', link: PAGE };
const SUPER_PASSWORD = 'kata-sandi-kepala-2026';
/** The SPA's index.html as the release ships it (services.adminAssets below). */
const SPA_INDEX = '<!doctype html><html lang="id"><head><meta name="csp-nonce" content="__CSP_NONCE__"></head><body><div id="root"></div></body></html>';

const code = (res: AgentReply): string | undefined => (res.json as { code?: string } | undefined)?.code;

/** The nonce the response's Content-Security-Policy names. */
function policyNonce(res: AgentReply): string {
  const policy = res.headers.get('content-security-policy') ?? '';
  const nonce = /'nonce-([A-Za-z0-9_-]+)'/.exec(policy)?.[1];
  expect(nonce, policy).toBeDefined();
  expect(policy).toBe(cspHeader(nonce!));
  return nonce!;
}

/** Every `<tag ...>` opening tag of `html` named `name`. */
function openingTags(html: string, name: string): string[] {
  return [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'gi'))].map((m) => m[0]);
}

/** The text of the `<script type="application/json" id="<id>">` element, parsed. */
function jsonBlock<T>(html: string, id: string): T {
  const match = new RegExp(`<script[^>]*\\bid="${id}"[^>]*>([\\s\\S]*?)</script>`).exec(html);
  expect(match, id).not.toBeNull();
  return JSON.parse(match![1]!) as T;
}

/** The markup with the contents of every script and style element left out: only tags and text remain. */
function markupOnly(html: string): string {
  return html.replace(/<(script|style)\b([^>]*)>[\s\S]*?<\/\1>/gi, '<$1$2></$1>');
}

/** The opening tag of the element whose id is `id`, or undefined. */
function tagWithId(html: string, id: string): string | undefined {
  return new RegExp(`<[a-z]+\\b[^>]*\\bid="${id}"[^>]*>`, 'i').exec(markupOnly(html))?.[0];
}

const isHidden = (tag: string | undefined): boolean => tag !== undefined && /\shidden(?:[\s=>]|$)/.test(tag);

describe.skipIf(!ctx.available)(`the operations page /admin/_update [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;
  let dataDir: string;
  let now: number;
  let statements: number;
  let counted: DbHandle;
  let ops: OpsMachine;
  let app: ReturnType<typeof createApp>;
  let superAdmin: string;
  let admin: string;
  let librarian: string;
  let twoFactor: string;

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-update-page-')));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(root, 'mig'), migrations: PHASE1_MIGRATIONS });
    superAdmin = (await seedStaff(h, { username: 'kepala', password: SUPER_PASSWORD, roles: [{ key: 'super_admin' }], now: NOW })).id;
    admin = (await seedStaff(h, { username: 'admin', roles: [{ key: 'admin' }], now: NOW })).id;
    // A staff member without any op permission (system.update.run, system.backup.restore, system.backup.create).
    librarian = (await seedStaff(h, { username: 'pustakawan', roles: [{ permissions: ['system.audit.read'] }], now: NOW })).id;
    twoFactor = (await seedStaff(h, { username: 'kepala2', roles: [{ key: 'super_admin' }], totp: true, now: NOW })).id;
    // Every statement the app runs goes through this handle's plugin.
    const counter: Parameters<DbHandle['db']['withPlugin']>[0] = {
      transformQuery: ({ node }) => {
        statements += 1;
        return node;
      },
      transformResult: async ({ result }) => result,
    };
    counted = { ...h, db: h.db.withPlugin(counter) };
  });

  afterAll(async () => {
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    dataDir = await fsp.mkdtemp(path.join(root, 'data-'));
    now = NOW;
    statements = 0;
    await h.db.deleteFrom('sessions').execute();
    build();
  });

  afterEach(async () => {
    await ops?.close();
    vi.restoreAllMocks();
  });

  /** What the app serves from (1d review C16: a test may put it in phase `updating`, or take its database away). */
  let appState: AppState;

  /** The app over the counted handle, with a fence that looks on every request; `phase` (default `ready`). */
  function build(phase: AppPhase = 'ready'): void {
    const log = recordingLogger();
    const state: AppState = { phase, db: counted, config: CONFIG };
    appState = state;
    ops = createAppOps(state, { dataDir, version: '0.1.0', log, clock: () => now });
    const opsFence = createOpsFence({ dataDir, intervalMs: 0, clock: () => now, onEpoch() {}, onOpEnded() {} });
    const adminAssets = { indexHtml: async () => SPA_INDEX, asset: async () => null, notices: async () => null };
    app = createApp({ state, version: '0.1.0', buildId: 'b', log, clock: () => now, env: {}, dataDir, services: { ops, opsFence, adminAssets } });
  }

  /** A browser holding `cookies` (`ops`: the op's token; `sid`: a session token). */
  function browser(cookies: { ops?: string; sid?: string } = {}): Agent {
    const agent = createAgent(app);
    if (cookies.ops !== undefined) agent.setCookie(OPS_COOKIE, cookies.ops);
    if (cookies.sid !== undefined) agent.setCookie(SID_COOKIE, cookies.sid);
    return agent;
  }

  const session = (userId: string): Promise<string> => sessionCookieFor(h, userId, { now });
  const opsToken = (opId: string): string => opsCsrfToken(csrfKey(CONFIG), opId);

  /** A restore op in `state` with its flag; past its point of no return from `loading` on. */
  async function restoreOp(state: string, pointOfNoReturn = state === 'loading'): Promise<WrittenOp> {
    const written = await writeOp(dataDir, { kind: 'restore', state, pointOfNoReturn, at: now });
    await writeFlag(dataDir, flagOf('restore', written.op.opId, now));
    return written;
  }

  /** A frozen backup op in `state` with its flag. */
  async function backupOp(state = 'exporting'): Promise<WrittenOp> {
    const written = await writeOp(dataDir, { kind: 'backup', state, progress: 40, message: 'tables/branches', at: now });
    await writeFlag(dataDir, flagOf('backup', written.op.opId, now));
    return written;
  }

  describe('the page', () => {
    it('an active op and its cookie → 200 HTML: script and style carry the policy nonce, the op CSRF token, no handler attribute, no eval', async () => {
      const { op, token } = await backupOp();
      const res = await browser({ ops: token }).get(PAGE, undefined, HTML);
      expect(res.status, res.text).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(res.headers.get('cache-control')).toBe('no-store');
      const html = res.text;
      expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
      const nonce = policyNonce(res);
      const scripts = openingTags(html, 'script');
      const styles = openingTags(html, 'style');
      expect(scripts.length).toBeGreaterThanOrEqual(1);
      expect(styles).toHaveLength(1);
      for (const tag of [...scripts, ...styles]) expect(tag).toContain(`nonce="${nonce}"`);
      // Self-contained: no script or stylesheet loaded from anywhere (the restore closes every other route).
      expect(scripts.some((tag) => /\ssrc=/.test(tag))).toBe(false);
      expect(openingTags(html, 'link').filter((tag) => /stylesheet/.test(tag))).toEqual([]);

      const state = jsonBlock<{ op: OpView; csrfToken: string; session: boolean }>(html, 'state');
      expect(state.csrfToken).toBe(opsToken(op.opId));
      expect(state.op).toMatchObject({ opId: op.opId, kind: 'backup', state: 'exporting', progress: 40, mode: 'worker' });
      expect(state.session).toBe(false);
      expect(html).toContain(opsToken(op.opId));

      // No inline event handler anywhere (the CSP would refuse it), no eval in the script.
      expect(markupOnly(html)).not.toMatch(/<[a-z][^>]*\son[a-z]+\s*=/i);
      expect(UPDATE_PAGE_SCRIPT).not.toContain('eval(');
      expect(UPDATE_PAGE_SCRIPT).not.toMatch(/new\s+Function/);
      expect(html).toContain(UPDATE_PAGE_SCRIPT);

      // The texts the script needs, as one JSON block: ops.kind.*, ops.state.*, ops.page.* of the page's language, and
      // the error.<CODE> texts of what the page's own requests may be refused with (the reauth form included); 1d Task 29:
      // the update.precheck.<failure> names of a blocked bundled release.
      const texts = jsonBlock<Record<string, string>>(html, 'i18n');
      const wanted = [
        ...Object.keys(MESSAGES.id).filter((k) => /^ops\.(kind|state|page)\./.test(k)),
        ...UPDATE_PAGE_ERROR_CODES.map((c) => `error.${c}`),
        ...PRECHECK_FAILURE_VIEWS.map((f) => `update.precheck.${f}`),
      ];
      expect(Object.keys(texts).sort()).toEqual(wanted.sort());
      expect(texts['error.OPS_POINT_OF_NO_RETURN']).toBe(t('id', 'error.OPS_POINT_OF_NO_RETURN'));
      expect(texts['ops.state.exporting']).toBe(t('id', 'ops.state.exporting'));
      // What the server shows before the script runs: the kind, the state, the progress and the message.
      expect(html).toContain(t('id', 'ops.kind.backup'));
      expect(html).toContain(t('id', 'ops.state.exporting'));
      expect(html).toContain('tables/branches');
      expect(tagWithId(html, 'op-progress')).toMatch(/value="40"/);
    });

    it('?lang=en: the English page and texts', async () => {
      const { token } = await backupOp();
      const res = await browser({ ops: token }).get(`${PAGE}?lang=en`, undefined, HTML);
      expect(res.status).toBe(200);
      expect(res.text).toContain('<html lang="en"');
      expect(jsonBlock<Record<string, string>>(res.text, 'i18n')['ops.page.title']).toBe(t('en', 'ops.page.title'));
      expect(res.text).toContain(t('en', 'ops.state.exporting'));
    });

    it('the script is plain ES2017: nothing in it needs a newer syntax than ES2017', async () => {
      const ts = await import('typescript');
      const emit = (target: number): string =>
        ts.transpileModule(UPDATE_PAGE_SCRIPT, { compilerOptions: { target, module: ts.ModuleKind.None, removeComments: true } }).outputText;
      // A downlevel to ES2017 changes nothing that the newest target keeps: no syntax above ES2017 is used.
      expect(emit(ts.ScriptTarget.ES2017)).toBe(emit(ts.ScriptTarget.ESNext));
      // Safe to inline: it cannot close its own element.
      expect(UPDATE_PAGE_SCRIPT).not.toMatch(/<\/script/i);
      expect(UPDATE_PAGE_SCRIPT).not.toMatch(/<!--/);
    });

    it('during a restore past its point of no return: the cookie alone → 200, and no SQL statement runs', async () => {
      const { op, token } = await restoreOp('loading');
      statements = 0;
      const res = await browser({ ops: token }).get(PAGE, undefined, HTML);
      expect(res.status, res.text).toBe(200);
      expect(jsonBlock<{ op: OpView; csrfToken: string }>(res.text, 'state')).toMatchObject({
        op: { opId: op.opId, kind: 'restore', state: 'loading', pointOfNoReturn: true },
        csrfToken: opsToken(op.opId),
      });
      // Past the point of no return no cancel is offered.
      expect(isHidden(tagWithId(res.text, 'cancel'))).toBe(true);
      expect(statements).toBe(0);
    });

    // Ruling R1c-9: the page re-authenticates a session itself; /admin?reauth=1 (closed during maintenance) is gone.
    it('a cookie-only page offers a sign-in link (back to the page) instead of cancel; no takeover, no reauth form', async () => {
      const { token } = await backupOp();
      const res = await browser({ ops: token }).get(PAGE, undefined, HTML);
      const link = tagWithId(res.text, 'cancel');
      expect(link).toMatch(/^<a\b/);
      expect(link).toContain('href="/admin/login?next=/admin/_update"');
      expect(OPS_SIGN_IN_HREF).toBe('/admin/login?next=/admin/_update');
      expect(isHidden(link)).toBe(false);
      expect(res.text).toContain(t('id', 'ops.page.sign_in'));
      expect(res.text).not.toContain('reauth=1');
      expect(tagWithId(res.text, 'takeover')).toBeUndefined();
      expect(tagWithId(res.text, 'reauth')).toBeUndefined();
      expect(jsonBlock<{ session: boolean; sessionCsrfToken: string | null }>(res.text, 'state')).toMatchObject({
        session: false,
        sessionCsrfToken: null,
      });
    });

    it('a cookie-only page during a restore (sign-in closed): the sign-in link is hidden', async () => {
      const { token } = await restoreOp('prechecked');
      const res = await browser({ ops: token }).get(PAGE, undefined, HTML);
      expect(res.status, res.text).toBe(200);
      expect(isHidden(tagWithId(res.text, 'cancel'))).toBe(true);
    });

    it('a session page: cancel and takeover buttons, a hidden reauth form (password only), the session CSRF token', async () => {
      await backupOp();
      const sid = await session(admin); // admin holds system.backup.create
      const res = await browser({ sid }).get(PAGE, undefined, HTML);
      expect(res.status, res.text).toBe(200);
      expect(tagWithId(res.text, 'cancel')).toMatch(/^<button\b/);
      expect(isHidden(tagWithId(res.text, 'cancel'))).toBe(false);
      const takeover = tagWithId(res.text, 'takeover');
      expect(takeover).toMatch(/^<button\b/);
      expect(isHidden(takeover)).toBe(false);
      const form = tagWithId(res.text, 'reauth');
      expect(form).toMatch(/^<form\b/);
      expect(isHidden(form)).toBe(true);
      expect(tagWithId(res.text, 'reauth-password')).toMatch(/type="password"/);
      expect(tagWithId(res.text, 'reauth-code')).toBeUndefined();
      const state = jsonBlock<{ csrfToken: string; session: boolean; sessionCsrfToken: string; totp: boolean; op: OpView }>(res.text, 'state');
      // A session caller drives with the session's own CSRF token, and re-authenticates with it.
      expect(state).toMatchObject({ session: true, csrfToken: sessionCsrfFor(CONFIG, sid), sessionCsrfToken: sessionCsrfFor(CONFIG, sid), totp: false });
      expect(state.op.csrfToken).toBeNull();
    });

    it('a session page of a user with 2FA: the reauth form asks for the authenticator code too', async () => {
      await backupOp();
      const res = await browser({ sid: await session(twoFactor) }).get(PAGE, undefined, HTML);
      expect(res.status, res.text).toBe(200);
      expect(tagWithId(res.text, 'reauth-code')).toMatch(/inputmode="numeric"/);
      expect(jsonBlock<{ totp: boolean }>(res.text, 'state').totp).toBe(true);
    });

    it('a page holding both the cookie and a session: the op token for the ops calls, the session token for reauth, no takeover', async () => {
      const { op, token } = await backupOp();
      const sid = await session(admin);
      const res = await browser({ ops: token, sid }).get(PAGE, undefined, HTML);
      const state = jsonBlock<{ csrfToken: string; sessionCsrfToken: string }>(res.text, 'state');
      expect(state).toMatchObject({ csrfToken: opsToken(op.opId), sessionCsrfToken: sessionCsrfFor(CONFIG, sid) });
      expect(isHidden(tagWithId(res.text, 'takeover'))).toBe(true);
    });

    it('needs_attention: the resume button and the CLI way out, ops:resume and ops:cancel (OPS-ATTN-EXIT)', async () => {
      const backupId = newId(now);
      const { op, token } = await writeOp(dataDir, { kind: 'restore', state: 'needs_attention', stateBefore: 'preserving', backupId, at: now });
      await writeFlag(dataDir, flagOf('restore', op.opId, now));
      const res = await browser({ ops: token }).get(PAGE, undefined, HTML);
      expect(res.status, res.text).toBe(200);
      expect(isHidden(tagWithId(res.text, 'resume'))).toBe(false);
      expect(isHidden(tagWithId(res.text, 'cli'))).toBe(false);
      // Neither a forced maintenance:off (the op would still hold the ops lock) nor a restore of the op's own backup.
      expect(res.text).toContain('<code id="cli-lines">node app.js ops:resume\nnode app.js ops:cancel</code>');
    });

    it('needs_attention past the point of no return: ops:resume only (cancel is refused there)', async () => {
      const { op, token } = await writeOp(dataDir, { kind: 'restore', state: 'needs_attention', stateBefore: 'loading', pointOfNoReturn: true, at: now });
      await writeFlag(dataDir, flagOf('restore', op.opId, now));
      const res = await browser({ ops: token }).get(PAGE, undefined, HTML);
      expect(res.status, res.text).toBe(200);
      expect(res.text).toContain('<code id="cli-lines">node app.js ops:resume</code>');
    });

    it('a running op shows neither the resume button nor the CLI lines', async () => {
      const { token } = await backupOp();
      const res = await browser({ ops: token }).get(PAGE, undefined, HTML);
      expect(isHidden(tagWithId(res.text, 'resume'))).toBe(true);
      expect(isHidden(tagWithId(res.text, 'cli'))).toBe(true);
    });

    it('a restore that failed after going back to pre_restore (failed, past its point of no return) shows the CLI lines', async () => {
      const { token } = await writeOp(dataDir, { kind: 'restore', state: 'failed', pointOfNoReturn: true, at: now });
      const res = await browser({ ops: token }).get(PAGE, undefined, HTML);
      expect(res.status, res.text).toBe(200);
      expect(isHidden(tagWithId(res.text, 'cli'))).toBe(false);
      expect(res.text).toContain('node app.js backup:restore &lt;backupId&gt;');
    });

    it('is mounted before admin.index (M3): /admin/_update is never the SPA', () => {
      const ids = ALL_ROUTES.map((d) => d.id);
      expect(ids.indexOf('ops.update_page')).toBeGreaterThanOrEqual(0);
      expect(ids.indexOf('ops.update_page')).toBeLessThan(ids.indexOf('admin.index'));
      expect(ALL_ROUTES.find((d) => d.id === 'ops.update_page')).toMatchObject({
        method: 'GET',
        path: PAGE,
        opsAuth: true,
        mode: 'system',
        maintenance: 'restore-allow',
        idempotency: 'none',
        audit: null,
      });
    });
  });

  describe('without a cookie or a session', () => {
    it('outside an op → 302 to the sign-in page, back to /admin/_update afterwards', async () => {
      const res = await browser().get(PAGE, undefined, HTML);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/admin/login?next=/admin/_update');
    });

    it('during a frozen backup (not a restore) → 302 to the sign-in page too', async () => {
      await backupOp();
      const res = await browser().get(PAGE, undefined, HTML);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/admin/login?next=/admin/_update');
    });

    it('during a restore → 401 HTML in both languages: only the browser that started it can follow it', async () => {
      await restoreOp('loading');
      statements = 0;
      const res = await browser().get(PAGE, undefined, HTML);
      expect(res.status).toBe(401);
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(res.headers.get('cache-control')).toBe('no-store');
      const nonce = policyNonce(res);
      for (const tag of openingTags(res.text, 'style')) expect(tag).toContain(`nonce="${nonce}"`);
      for (const locale of ['id', 'en'] as const) {
        expect(res.text).toContain(t(locale, 'ops.page.browser_only.title'));
        expect(res.text).toContain(t(locale, 'ops.page.browser_only.body'));
      }
      expect(statements).toBe(0);
    });

    it('during a restore before its point of no return, a wrong cookie → the same 401 page', async () => {
      await restoreOp('prechecked');
      const res = await browser({ ops: 'x'.repeat(43) }).get(PAGE, undefined, HTML);
      expect(res.status).toBe(401);
      expect(res.text).toContain(t('en', 'ops.page.browser_only.title'));
    });

    it('a session without an op permission → 403 AUTHZ_DENIED (the page is not for everyone)', async () => {
      await backupOp();
      const res = await browser({ sid: await session(librarian) }).get(PAGE);
      expect(res.status).toBe(403);
      expect(code(res)).toBe('AUTHZ_DENIED');
    });
  });

  describe('resume', () => {
    it('a needs_attention op and POST ops/drive {resume: true} with the page token → back to its stateBefore', async () => {
      const { op, token } = await writeOp(dataDir, { kind: 'backup', state: 'needs_attention', stateBefore: 'exporting', at: now });
      await writeFlag(dataDir, flagOf('backup', op.opId, now));
      const agent = browser({ ops: token });
      const page = await agent.get(PAGE, undefined, HTML);
      const { csrfToken } = jsonBlock<{ csrfToken: string }>(page.text, 'state');
      const res = await agent.post('/api/v1/ops/drive', { resume: true }, { 'x-csrf-token': csrfToken });
      expect(res.status, res.text).toBe(200);
      expect(res.json).toMatchObject({ opId: op.opId, state: 'exporting', needsAttention: false });
      expect((await readOpJson(dataDir)).state).toBe('exporting');
    });
  });

  describe('the maintenance banner of GET auth/me', () => {
    const me = async (userId: string): Promise<Extract<MeResponse, { authenticated: true }>> => {
      const res = await browser({ sid: await session(userId) }).get('/api/v1/auth/me');
      expect(res.status, res.text).toBe(200);
      return res.json as Extract<MeResponse, { authenticated: true }>;
    };

    it('a manual maintenance flag → a maintenance banner, linking to the operations page for those who may open it', async () => {
      await writeFlag(dataDir, flagOf('manual', null, now));
      expect((await me(superAdmin)).banners).toContainEqual(MAINTENANCE_BANNER);
      // Everyone sees it; the link only for a holder of an op permission (the page would refuse the others).
      const plain = (await me(librarian)).banners.find((b) => b.kind === 'maintenance');
      expect(plain).toEqual({ kind: 'maintenance', severity: 'warning', messageKey: 'banner.maintenance' });
    });

    it('a frozen backup → the banner, linked for a holder of system.backup.create', async () => {
      await backupOp();
      expect((await me(admin)).banners).toContainEqual(MAINTENANCE_BANNER);
    });

    it('no flag → no maintenance banner', async () => {
      expect((await me(superAdmin)).banners.filter((b) => b.kind === 'maintenance')).toEqual([]);
    });

    // The admin's maintenance screen lifts on this field, which does not depend on a session or a banner provider.
    it('auth/me says maintenance: true while a flag is up, signed in or not; nothing without one', async () => {
      expect((await browser().get('/api/v1/auth/me')).json).not.toHaveProperty('maintenance');
      expect(await me(superAdmin)).not.toHaveProperty('maintenance');
      await backupOp();
      const anonymous = await browser().get('/api/v1/auth/me');
      expect(anonymous.status, anonymous.text).toBe(200);
      expect(anonymous.json).toMatchObject({ authenticated: false, maintenance: true });
      expect(await me(librarian)).toMatchObject({ authenticated: true, maintenance: true });
    });
  });

  describe('the maintenance page for a browser (step 5)', () => {
    it('GET /admin during a restore → 503 HTML, Retry-After: 30, with a link to /admin/_update', async () => {
      await restoreOp('prechecked');
      const res = await browser().get('/admin', undefined, HTML);
      expect(res.status).toBe(503);
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(res.headers.get('retry-after')).toBe('30');
      expect(res.text).toContain(t('id', 'opac.maintenance.title'));
      expect(res.text).toContain(`href="${PAGE}"`);
      policyNonce(res);
    });

    it('a JSON request to the same route keeps the problem+json 503 MAINTENANCE', async () => {
      await restoreOp('prechecked');
      const res = await browser().get('/admin/users');
      expect(res.status).toBe(503);
      expect(res.headers.get('content-type')).toBe('application/problem+json');
      expect(code(res)).toBe('MAINTENANCE');
    });

    it('a data route the maintenance closes still gets the page for a browser during a frozen backup', async () => {
      await backupOp();
      // Phase 2 (review L10) opened `GET /files/:id` during a maintenance (it serves what the OPAC pages embed), so the
      // closed data route here is the notices file, the one page outside /api the maintenance still closes.
      const res = await browser().get('/legal/third-party-notices.txt', undefined, HTML);
      expect(res.status).toBe(503);
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    });
  });

  // Ruling R1c-9 (§9.4 allowlists): a normal maintenance serves the SPA shell, so a signed-out admin can sign in (the
  // shell then shows its maintenance screen or the operations page); a restore keeps it closed.
  describe('the SPA shell during maintenance (R1c-9)', () => {
    it.each(['/admin', '/admin/login', '/admin/users'])('GET %s during a frozen backup → the SPA document (admin.root / admin.index allow)', async (url) => {
      await backupOp();
      const res = await browser().get(url, undefined, HTML);
      expect(res.status, res.text).toBe(200);
      expect(res.text).toContain('<div id="root"></div>');
      const nonce = policyNonce(res);
      expect(res.text).toContain(`content="${nonce}"`);
    });

    it('a manual maintenance flag → the SPA document too', async () => {
      await writeFlag(dataDir, flagOf('manual', null, now));
      const res = await browser().get('/admin/login?next=/admin/_update', undefined, HTML);
      expect(res.status, res.text).toBe(200);
      expect(res.text).toContain('<div id="root"></div>');
    });

    it('during a restore the shell stays closed: /admin/login → the 503 maintenance page', async () => {
      await restoreOp('prechecked');
      const res = await browser().get('/admin/login', undefined, HTML);
      expect(res.status).toBe(503);
      expect(res.text).not.toContain('<div id="root"></div>');
    });

    it('the declarations: admin.root and admin.index allow, auth.reauth restore-allow', () => {
      const byId = (id: string) => ALL_ROUTES.find((d) => d.id === id);
      expect(byId('admin.root')?.maintenance).toBe('allow');
      expect(byId('admin.index')?.maintenance).toBe('allow');
      expect(byId('auth.reauth')?.maintenance).toBe('restore-allow');
    });
  });

  // Ruling R1c-9: `auth.reauth` is `restore-allow` (a session already open can re-authenticate on the operations page
  // and cancel or take over a restore), but past the restore's point of no return it answers 409 OPS_POINT_OF_NO_RETURN
  // before reading anything (staff_users may be half loaded).
  describe('auth/reauth during a restore (R1c-9)', () => {
    const REAUTH = '/api/v1/auth/reauth';

    it('before its point of no return: a session re-authenticates, then cancels the restore', async () => {
      const { op } = await restoreOp('prechecked');
      const sid = await session(superAdmin);
      const agent = browser({ sid });
      const csrf = sessionCsrfFor(CONFIG, sid);
      const refused = await agent.post('/api/v1/ops/cancel', {}, { 'x-csrf-token': csrf });
      expect(refused.status, refused.text).toBe(401);
      expect(code(refused)).toBe('AUTH_REAUTH_REQUIRED');
      const reauth = await agent.post(REAUTH, { password: SUPER_PASSWORD }, { 'x-csrf-token': csrf });
      expect(reauth.status, reauth.text).toBe(200);
      expect(reauth.json).toMatchObject({ reauthUntil: expect.any(Number) as number });
      const cancelled = await agent.post('/api/v1/ops/cancel', {}, { 'x-csrf-token': csrf });
      expect(cancelled.status, cancelled.text).toBe(200);
      expect(cancelled.json).toMatchObject({ opId: op.opId, terminal: true });
    });

    it('past its point of no return → 409 OPS_POINT_OF_NO_RETURN, and no SQL statement runs', async () => {
      await restoreOp('loading');
      const sid = await session(superAdmin);
      statements = 0;
      const res = await browser({ sid }).post(REAUTH, { password: SUPER_PASSWORD }, { 'x-csrf-token': sessionCsrfFor(CONFIG, sid) });
      expect(res.status, res.text).toBe(409);
      expect(code(res)).toBe('OPS_POINT_OF_NO_RETURN');
      expect(statements).toBe(0);
    });

    it('during a frozen backup (not a restore) it stays open', async () => {
      await backupOp();
      const sid = await session(superAdmin);
      const res = await browser({ sid }).post(REAUTH, { password: SUPER_PASSWORD }, { 'x-csrf-token': sessionCsrfFor(CONFIG, sid) });
      expect(res.status, res.text).toBe(200);
    });
  });

  // ---- 1d Task 29 (spec §9.6, §9.7, §9.8; preflight 1D-27): the update states on the page ---------------------------
  describe('1d Task 29: an update op on the page', () => {
    const BACKUP = '01JB00000000000000000000BK';

    /** An `update` op in `state` (maintenance from `verified` on) with its flag; `precheck` as its `checking` step keeps it. */
    async function updateOp(state: string, over: Partial<WrittenOp['op']> = {}, dbRestoreNeeded = false): Promise<WrittenOp> {
      const precheck = {
        ok: true,
        failures: [],
        dbRestoreNeeded,
        estimateMs: 60_000,
        headroomBytes: 1024,
        steppingStone: false,
        candidate: { version: '0.2.0', bootProtocol: 1, minUpgradeFrom: '0.0.0' },
        notEntitled: null,
      };
      const params = { source: 'feed', target: '0.2.0', from: '0.1.0', entry: null, staging: null, needsBackup: true, precheck };
      const written = await writeOp(dataDir, { kind: 'update', state, version: '0.2.0', params, at: now, ...over });
      await writeFlag(dataDir, flagOf('update', written.op.opId, now));
      return written;
    }

    afterEach(async () => {
      await h.db.deleteFrom('settings').where('key', 'in', ['update.bundled_blocked', 'realtime.sse']).execute();
    });

    it('an update op in restore_failed → the three CLI lines: maintenance:off --force, backup:restore <id>, release:rollback', async () => {
      const { token } = await updateOp('restore_failed', {
        pointOfNoReturn: true,
        backupId: BACKUP,
        error: { code: 'UPDATE_BOOT_FAILED', detail: 'migration' },
      });
      const res = await browser({ ops: token }).get(PAGE, undefined, HTML);
      expect(res.status, res.text).toBe(200);
      expect(isHidden(tagWithId(res.text, 'cli'))).toBe(false);
      expect(res.text).toContain(
        `<code id="cli-lines">node app.js maintenance:off --force\nnode app.js backup:restore ${BACKUP}\nnode app.js release:rollback</code>`,
      );
      // Not a schemaHold failure: no schemaHold instruction.
      expect(isHidden(tagWithId(res.text, 'schema-hold'))).toBe(true);
    });

    it('params.precheck.dbRestoreNeeded → the label "pemulihan DB diperlukan bila gagal", and the op view carries it', async () => {
      const { token } = await updateOp('downloading', {}, true);
      const res = await browser({ ops: token }).get(PAGE, undefined, HTML);
      expect(res.status, res.text).toBe(200);
      const label = tagWithId(res.text, 'db-restore');
      expect(label).toBeDefined();
      expect(isHidden(label)).toBe(false);
      expect(res.text).toContain(t('id', 'ops.page.db_restore_needed'));
      expect(jsonBlock<{ op: OpView }>(res.text, 'state').op.update).toEqual({ target: '0.2.0', dbRestoreNeeded: true });
      // ops/current carries it too (the script keeps the label in step with the op).
      const current = await browser({ ops: token }).get('/api/v1/ops/current');
      expect((current.json as OpView).update).toEqual({ target: '0.2.0', dbRestoreNeeded: true });
    });

    it('without dbRestoreNeeded the label is hidden; an op of another kind has no update view', async () => {
      const { token } = await updateOp('downloading');
      const res = await browser({ ops: token }).get(PAGE, undefined, HTML);
      expect(isHidden(tagWithId(res.text, 'db-restore'))).toBe(true);
      expect(jsonBlock<{ op: OpView }>(res.text, 'state').op.update).toEqual({ target: '0.2.0', dbRestoreNeeded: false });
      const backup = await backupOp();
      const page = await browser({ ops: backup.token }).get(PAGE, undefined, HTML);
      expect(jsonBlock<{ op: OpView }>(page.text, 'state').op).not.toHaveProperty('update');
    });

    it('UPDATE_SCHEMA_HOLD_FAILED → the schemaHold instruction naming the backup id; the CLI lines without release:rollback', async () => {
      const { token } = await updateOp('restore_failed', {
        pointOfNoReturn: true,
        backupId: BACKUP,
        error: { code: 'UPDATE_SCHEMA_HOLD_FAILED', detail: 'Pembaruan database ke versi 0.2.0 gagal …' },
      });
      for (const locale of ['id', 'en'] as const) {
        const res = await browser({ ops: token }).get(`${PAGE}?lang=${locale}`, undefined, HTML);
        expect(res.status, res.text).toBe(200);
        expect(isHidden(tagWithId(res.text, 'schema-hold'))).toBe(false);
        expect(res.text).toContain(t(locale, 'ops.page.schema_hold', { backupId: BACKUP }));
        expect(res.text).toContain(`<code id="cli-lines">node app.js maintenance:off --force\nnode app.js backup:restore ${BACKUP}</code>`);
      }
    });

    it('no inline handler, and every script and style of an update page carries the response nonce', async () => {
      const { token } = await updateOp('restore_failed', { pointOfNoReturn: true, backupId: BACKUP, error: { code: 'UPDATE_SCHEMA_HOLD_FAILED' } }, true);
      const res = await browser({ ops: token }).get(PAGE, undefined, HTML);
      const nonce = policyNonce(res);
      for (const tag of [...openingTags(res.text, 'script'), ...openingTags(res.text, 'style')]) expect(tag).toContain(`nonce="${nonce}"`);
      expect(markupOnly(res.text)).not.toMatch(/<[a-z][^>]*\son[a-z]+\s*=/i);
      expect(UPDATE_PAGE_SCRIPT).not.toMatch(/\.innerHTML\s*=/);
    });

    it('no op runs and a bundled release was blocked (§9.8 row 2) → its version and failures; GET updates/status carries them', async () => {
      await withTx(h, (trx) =>
        writeSettings(trx, { 'update.bundled_blocked': { version: '0.2.0', at: now, failures: ['min_node', 'entitlement'] } }, { keyring: [], now, actorId: null }),
      );
      const sid = await session(superAdmin);
      const res = await browser({ sid }).get(PAGE, undefined, HTML);
      expect(res.status, res.text).toBe(200);
      expect(isHidden(tagWithId(res.text, 'bundled'))).toBe(false);
      expect(res.text).toContain(t('id', 'ops.page.bundled_blocked', { version: '0.2.0' }));
      expect(res.text).toContain(t('id', 'update.precheck.min_node'));
      expect(res.text).toContain(t('id', 'update.precheck.entitlement'));
      expect(jsonBlock<{ bundledBlocked: unknown }>(res.text, 'state').bundledBlocked).toEqual({ version: '0.2.0', failures: ['min_node', 'entitlement'] });
      const status = await browser({ sid }).get('/api/v1/updates/status');
      expect(status.status, status.text).toBe(200);
      expect((status.json as UpdateStatusView).bundledBlocked).toEqual({ version: '0.2.0', failures: ['min_node', 'entitlement'] });
      // While an op runs it is not the page's subject: neither shown nor answered.
      const { token } = await updateOp('downloading');
      const busy = await browser({ ops: token }).get(PAGE, undefined, HTML);
      expect(isHidden(tagWithId(busy.text, 'bundled'))).toBe(true);
      expect(((await browser({ ops: token }).get('/api/v1/updates/status')).json as UpdateStatusView).bundledBlocked).toBeNull();
    });

    it('a blocked release that is not newer than the running one (installed meanwhile) is not shown', async () => {
      await withTx(h, (trx) =>
        writeSettings(trx, { 'update.bundled_blocked': { version: '0.1.0', at: now, failures: ['min_node'] } }, { keyring: [], now, actorId: null }),
      );
      const sid = await session(superAdmin);
      const res = await browser({ sid }).get(PAGE, undefined, HTML);
      expect(isHidden(tagWithId(res.text, 'bundled'))).toBe(true);
      expect(((await browser({ sid }).get('/api/v1/updates/status')).json as UpdateStatusView).bundledBlocked).toBeNull();
    });

    it('SSE (system.update) when available: a session that may read it, SSE on (realtime.sse, the runtime); else polling', async () => {
      const { token } = await updateOp('downloading');
      const sid = await session(superAdmin);
      expect(jsonBlock<{ sse: boolean }>((await browser({ sid }).get(PAGE, undefined, HTML)).text, 'state').sse).toBe(true);
      // The cookie alone reads no event stream (GET events/stream needs a session).
      expect(jsonBlock<{ sse: boolean }>((await browser({ ops: token }).get(PAGE, undefined, HTML)).text, 'state').sse).toBe(false);
      // SSE switched off (realtime.sse false, §10.8): the page polls.
      await withTx(h, (trx) => writeSettings(trx, { 'realtime.sse': false }, { keyring: [], now, actorId: null }));
      build();
      expect(jsonBlock<{ sse: boolean }>((await browser({ sid }).get(PAGE, undefined, HTML)).text, 'state').sse).toBe(false);
      // A session that may not read system.update: a backup creator following a backup op.
      await withTx(h, (trx) => writeSettings(trx, { 'realtime.sse': null }, { keyring: [], now, actorId: null }));
      build();
      await writeOp(dataDir, { kind: 'backup', state: 'exporting', at: now });
      const creator = (await seedStaff(h, { username: `pencadang${newId(now).slice(-6).toLowerCase()}`, roles: [{ permissions: ['system.backup.create'] }], now })).id;
      const creatorPage = await browser({ sid: await session(creator) }).get(PAGE, undefined, HTML);
      expect(creatorPage.status, creatorPage.text).toBe(200);
      expect(jsonBlock<{ sse: boolean }>(creatorPage.text, 'state').sse).toBe(false);
    });

    it('during a restore the page reads no table for any of it (bundled release, SSE): still no SQL statement', async () => {
      const { token } = await restoreOp('loading');
      statements = 0;
      const res = await browser({ ops: token }).get(PAGE, undefined, HTML);
      expect(res.status, res.text).toBe(200);
      expect(jsonBlock<{ sse: boolean; bundledBlocked: unknown }>(res.text, 'state')).toMatchObject({ sse: false, bundledBlocked: null });
      expect(statements).toBe(0);
    });

    it('every string the page adds exists in id and en, and the script gets them', async () => {
      const keys = ['ops.page.db_restore_needed', 'ops.page.schema_hold', 'ops.page.bundled_blocked', ...PRECHECK_FAILURE_VIEWS.map((f) => `update.precheck.${f}`)];
      for (const locale of ['id', 'en'] as const) {
        for (const key of keys) expect((MESSAGES[locale] as Record<string, string>)[key], `${locale}:${key}`).toBeTruthy();
      }
      const { token } = await updateOp('downloading');
      const texts = jsonBlock<Record<string, string>>((await browser({ ops: token }).get(`${PAGE}?lang=en`, undefined, HTML)).text, 'i18n');
      for (const key of keys) expect(texts[key], key).toBe(t('en', key as MessageKey));
    });
  });

  // ---- 1d review C16 (spec §9.4 "sesi berizin jenis operasi atau altis_ops"; §9.8 rows 1 and 3) -------------------
  // Phase `updating`: the process boots an update's target, steps its revert, or holds the maintenance of a schemaHold
  // release, and the update §9.8 begins belongs to the system actor (no browser holds its `altis_ops`). A session
  // holding the op kind's permission opens the ops routes there, may sign in and re-authenticate (§9.4's allowlist of a
  // normal maintenance) and takes the op over for its `altis_ops`, which then opens the routes on every process and
  // while the schema moves. While the op migrates or restores its pre_update backup no session is read, as past a
  // restore's point of no return.
  describe('phase updating (1d review C16)', () => {
    const SYSTEM = { type: 'system', id: null } as const;
    const API = '/api/v1';

    /** A `self` update begun by the system (§9.8 row 3) in `state`, past its point of no return, with its flag. */
    async function systemUpdate(state: string, over: Partial<WrittenOp['op']> = {}): Promise<WrittenOp> {
      const params = { source: 'self', target: '0.2.0', from: '0.1.0', entry: null, staging: null, needsBackup: null };
      const written = await writeOp(dataDir, { kind: 'update', state, version: '0.2.0', actor: SYSTEM, params, pointOfNoReturn: true, at: now, ...over });
      await writeFlag(dataDir, flagOf('update', written.op.opId, now));
      return written;
    }

    afterEach(async () => {
      await h.db.deleteFrom('settings').where('key', '=', 'update.bundled_blocked').execute();
    });

    it('a system update that needs attention: a session holding system.update.run opens the page (resume, takeover) and resumes the op', async () => {
      build('updating');
      const { op } = await systemUpdate('needs_attention', { stateBefore: 'verifying', error: { code: 'UPDATE_BOOT_FAILED', detail: 'stalled' } });
      const sid = await session(superAdmin);
      const agent = browser({ sid });
      const page = await agent.get(PAGE, undefined, HTML);
      expect(page.status, page.text).toBe(200);
      const state = jsonBlock<{ op: OpView; session: boolean; csrfToken: string }>(page.text, 'state');
      expect(state).toMatchObject({ session: true, csrfToken: sessionCsrfFor(CONFIG, sid), op: { opId: op.opId, needsAttention: true } });
      expect(isHidden(tagWithId(page.text, 'resume'))).toBe(false);
      expect(isHidden(tagWithId(page.text, 'takeover'))).toBe(false);
      expect((await agent.get(`${API}/updates/status`)).status).toBe(200);
      const resumed = await agent.post(`${API}/ops/drive`, { resume: true }, { 'x-csrf-token': state.csrfToken });
      expect(resumed.status, resumed.text).toBe(200);
      expect(resumed.json).toMatchObject({ opId: op.opId, state: 'verifying', needsAttention: false });
      expect((await readOpJson(dataDir)).state).toBe('verifying');
    });

    it('re-authenticated, the session takes the op over: a new altis_ops bound to the admin, which follows the op through its migrations', async () => {
      build('updating');
      const { op } = await systemUpdate('verifying');
      const sid = await session(superAdmin);
      const agent = browser({ sid });
      const csrf = sessionCsrfFor(CONFIG, sid);
      expect(code(await agent.post(`${API}/ops/takeover`, {}, { 'x-csrf-token': csrf }))).toBe('AUTH_REAUTH_REQUIRED');
      const reauth = await agent.post(`${API}/auth/reauth`, { password: SUPER_PASSWORD }, { 'x-csrf-token': csrf });
      expect(reauth.status, reauth.text).toBe(200);
      const taken = await agent.post(`${API}/ops/takeover`, {}, { 'x-csrf-token': csrf });
      expect(taken.status, taken.text).toBe(200);
      expect((taken.json as OpView).csrfToken).toBe(opsToken(op.opId));
      const cookie = agent.cookies.get(OPS_COOKIE);
      expect(cookie).toBeDefined();
      const bound = await readOpJson(dataDir);
      expect(bound.actor).toEqual({ type: 'staff', id: superAdmin });
      // The op moves on to its migrations: no session is read now, the cookie alone opens the routes.
      await writeOp(dataDir, { ...bound, state: 'migrating' });
      const followed = await browser({ ops: cookie! }).get(PAGE, undefined, HTML);
      expect(followed.status, followed.text).toBe(200);
      expect(jsonBlock<{ op: OpView }>(followed.text, 'state').op).toMatchObject({ opId: op.opId, state: 'migrating' });
      expect((await browser({ sid }).get(PAGE, undefined, HTML)).status).toBe(401);
    });

    it.each([
      ['migrating', {}],
      ['restoring', {}],
      ['needs_attention', { stateBefore: 'restoring' }],
    ] as const)('while the op moves the schema (%s %o) no session is read: the 401 page names no restore; sign-in stays closed', async (state, over) => {
      build('updating');
      await systemUpdate(state, over);
      const sid = await session(superAdmin);
      const res = await browser({ sid }).get(PAGE, undefined, HTML);
      expect(res.status, res.text).toBe(401);
      for (const locale of ['id', 'en'] as const) {
        expect(res.text).toContain(t(locale, 'ops.page.browser_only.title'));
        expect(res.text).toContain(t(locale, 'ops.page.browser_only.body'));
      }
      expect(res.text).not.toMatch(/started the restore|memulai pemulihan/);
      expect(res.text).toContain('node app.js ops:resume');
      expect(code(await browser({ sid }).get(`${API}/ops/current`))).toBe('OPS_AUTH_REQUIRED');
      expect(code(await browser().post(`${API}/auth/login`, { username: 'kepala', password: SUPER_PASSWORD }))).toBe('MAINTENANCE');
      expect((await browser().get('/admin/login', undefined, HTML)).status).toBe(503);
    });

    it('an unreadable op.json under an update flag: nothing may assume the tables are there, no session is read', async () => {
      build('updating');
      await writeFlag(dataDir, flagOf('update', newId(now), now));
      await fsp.writeFile(path.join(dataDir, 'ops', 'op.json'), '{"opSchema":');
      const res = await browser({ sid: await session(superAdmin) }).get(PAGE, undefined, HTML);
      expect(res.status, res.text).toBe(401);
    });

    it('sign-in passes the phase gate while sessions are read: the SPA shell, auth/me, auth/login; then the page with that session', async () => {
      build('updating');
      await systemUpdate('needs_attention', { stateBefore: 'verifying' });
      const agent = browser();
      const out = await agent.get(PAGE, undefined, HTML);
      expect(out.status).toBe(302);
      expect(out.headers.get('location')).toBe(OPS_SIGN_IN_HREF);
      const shell = await agent.get(OPS_SIGN_IN_HREF, undefined, HTML);
      expect(shell.status, shell.text).toBe(200);
      expect(shell.text).toContain('<div id="root"></div>');
      const me = await agent.get(`${API}/auth/me`);
      expect(me.status, me.text).toBe(200);
      expect(me.json).toMatchObject({ authenticated: false, maintenance: true });
      const csrf = (me.json as { csrfToken: string }).csrfToken;
      const login = await agent.post(`${API}/auth/login`, { username: 'kepala', password: SUPER_PASSWORD }, { 'x-csrf-token': csrf });
      expect(login.status, login.text).toBe(200);
      expect(login.json).toMatchObject({ stage: 'full' });
      const page = await agent.get(PAGE, undefined, HTML);
      expect(page.status, page.text).toBe(200);
      expect(jsonBlock<{ session: boolean }>(page.text, 'state').session).toBe(true);
      // Nothing else opens: the rest of the admin's API still answers MAINTENANCE.
      expect(code(await agent.get(`${API}/users`))).toBe('MAINTENANCE');
    });

    it('no op runs (schemaHold prechecks failed, a manual update flag): a session sees the blocked release on the page and in GET updates/status', async () => {
      build('updating');
      await writeFlag(dataDir, flagOf('update', null, now));
      await withTx(h, (trx) =>
        writeSettings(trx, { 'update.bundled_blocked': { version: '0.2.0', at: now, failures: ['min_node'] } }, { keyring: [], now, actorId: null }),
      );
      const sid = await session(superAdmin);
      const res = await browser({ sid }).get(PAGE, undefined, HTML);
      expect(res.status, res.text).toBe(200);
      expect(isHidden(tagWithId(res.text, 'bundled'))).toBe(false);
      expect(res.text).toContain(t('id', 'update.precheck.min_node'));
      const status = await browser({ sid }).get(`${API}/updates/status`);
      expect(status.status, status.text).toBe(200);
      expect((status.json as UpdateStatusView).bundledBlocked).toEqual({ version: '0.2.0', failures: ['min_node'] });
    });

    it('a session that cannot be read in phase updating counts as none: the cookie still opens the routes, never a 500', async () => {
      build('updating');
      const { token } = await systemUpdate('verifying');
      const sid = await session(superAdmin);
      // The running release cannot read this database's sessions (a schema it does not know yet).
      const broken: Parameters<DbHandle['db']['withPlugin']>[0] = {
        transformQuery: ({ node }) => {
          if (JSON.stringify(node).includes('"sessions"')) throw new Error('no such column: sessions.not_yet');
          return node;
        },
        transformResult: async ({ result }) => result,
      };
      appState.db = { ...counted, db: counted.db.withPlugin(broken) };
      const both = await browser({ ops: token, sid }).get(`${API}/ops/current`);
      expect(both.status, both.text).toBe(200);
      const sessionOnly = await browser({ sid }).get(`${API}/ops/current`);
      expect(sessionOnly.status, sessionOnly.text).toBe(401);
      expect(code(sessionOnly)).toBe('OPS_AUTH_REQUIRED');
      // No database at all (it could not be opened): the cookie still works, and the page without it is the 401 page
      // (nobody can sign in without a database), not a sign-in redirect.
      appState.db = undefined;
      expect((await browser({ ops: token, sid }).get(`${API}/ops/current`)).status).toBe(200);
      const page = await browser({ sid }).get(PAGE, undefined, HTML);
      expect(page.status, page.text).toBe(401);
      expect(page.text).toContain(t('en', 'ops.page.browser_only.title'));
    });

    // Spec §9.7 (`restore_failed`: "/admin/_update menampilkan langkah CLI"), §9.8 row 3 ("tetap dalam pemeliharaan,
    // dengan instruksi"): an update that ended `restore_failed` holds its maintenance for as long as nobody lowers it,
    // and stays the subject of the ops views that long, not only for the hour its `altis_ops` lasts.
    const TWO_HOURS = 2 * 3_600_000;
    const BACKUP = '01JB00000000000000000000BK';

    it('a schemaHold update that ended restore_failed two hours ago, under a manual update flag: the page shows its instruction; ops/current answers it', async () => {
      build('updating');
      const { op, token } = await systemUpdate('restore_failed', {
        backupId: BACKUP,
        finishedAt: now - TWO_HOURS,
        heartbeatAt: now - TWO_HOURS,
        error: { code: 'UPDATE_SCHEMA_HOLD_FAILED', detail: 'Pembaruan database ke versi 0.2.0 gagal …' },
      });
      // A restart of the same image: failedBefore, then holdMaintenance's manual update flag.
      await writeFlag(dataDir, flagOf('update', null, now));
      const sid = await session(superAdmin);
      const res = await browser({ sid }).get(`${PAGE}?lang=en`, undefined, HTML);
      expect(res.status, res.text).toBe(200);
      expect(jsonBlock<{ op: OpView | null }>(res.text, 'state').op).toMatchObject({ opId: op.opId, state: 'restore_failed', backupId: BACKUP });
      expect(isHidden(tagWithId(res.text, 'schema-hold'))).toBe(false);
      expect(res.text).toContain(t('en', 'ops.page.schema_hold', { backupId: BACKUP }));
      expect(res.text).toContain(`<code id="cli-lines">node app.js maintenance:off --force\nnode app.js backup:restore ${BACKUP}</code>`);
      const current = await browser({ sid }).get(`${API}/ops/current`);
      expect(current.status, current.text).toBe(200);
      expect(current.json).toMatchObject({ opId: op.opId, kind: 'update', state: 'restore_failed', terminal: true, backupId: BACKUP });
      const status = await browser({ sid }).get(`${API}/updates/status`);
      expect(status.status, status.text).toBe(200);
      expect((status.json as UpdateStatusView).op).toMatchObject({ opId: op.opId, state: 'restore_failed' });
      // Its `altis_ops` still lasts one hour after the end: the cookie alone opens nothing now.
      expect(code(await browser({ ops: token }).get(`${API}/ops/current`))).toBe('OPS_AUTH_REQUIRED');
      // Once maintenance is lowered (`maintenance:off --force`), the op is past its hour like any other.
      await writeFlag(dataDir, null);
      expect(code(await browser({ sid }).get(`${API}/ops/current`))).toBe('OPS_NONE');
    });

    it('a §9.8 row-1 revert that ended restore_failed (SCHEMA_TOO_NEW, no pre_update backup) two hours ago: the page shows its CLI steps', async () => {
      build('updating');
      const detail =
        'Database memerlukan rilis yang lebih baru dari 0.1.0 dan tidak ada backup pre_update untuk dipulihkan; ' +
        'pulihkan backup lewat terminal: node app.js backup:restore <backupId>, node app.js release:rollback / ' +
        'The database needs a newer release than 0.1.0 and there is no pre_update backup to restore; ' +
        'restore a backup from a terminal: node app.js backup:restore <backupId>, node app.js release:rollback';
      const { op } = await systemUpdate('restore_failed', {
        params: { source: 'bundled', target: '0.2.0', from: '0.1.0', entry: null, staging: null, needsBackup: null },
        finishedAt: now - TWO_HOURS,
        heartbeatAt: now - TWO_HOURS,
        error: { code: 'SCHEMA_TOO_NEW', detail },
      });
      const sid = await session(superAdmin);
      const res = await browser({ sid }).get(PAGE, undefined, HTML);
      expect(res.status, res.text).toBe(200);
      expect(jsonBlock<{ op: OpView | null }>(res.text, 'state').op).toMatchObject({
        opId: op.opId,
        state: 'restore_failed',
        error: { code: 'SCHEMA_TOO_NEW', detail },
      });
      expect(isHidden(tagWithId(res.text, 'op-error'))).toBe(false);
      expect(isHidden(tagWithId(res.text, 'cli'))).toBe(false);
      expect(res.text).toContain(
        '<code id="cli-lines">node app.js maintenance:off --force\nnode app.js backup:restore &lt;backupId&gt;\nnode app.js release:rollback</code>',
      );
      const current = await browser({ sid }).get(`${API}/ops/current`);
      expect(current.status, current.text).toBe(200);
      expect(current.json).toMatchObject({ opId: op.opId, state: 'restore_failed', error: { code: 'SCHEMA_TOO_NEW', detail } });
    });
  });
});
