import type { FileHandle } from 'node:fs/promises';
import { can, readOpFile, runnerMode, type OpStatus } from '@altis/core';
import { dataPath, openRead } from '@altis/platform';
import { DomainError, isDomainError, isLocale, resolveLocale, type Locale } from '@altis/shared';
import { OpsDriveBody, type OpStatusView, type OpUpdateView, type OpView } from '@altis/shared/api/ops';
import { SERVING_HEADER } from '@altis/shared/api/updates';
import type { Context } from 'hono';
import { cspHeader, cspNonce } from '../http/csp.js';
import { csrfKey, opsCsrfToken, sessionCsrfToken } from '../http/csrf.js';
import { issueOpsCookie } from '../http/ops-auth.js';
import { problemResponse } from '../http/problem.js';
import type { AppEnv } from '../http/request-id.js';
import { route, type RouteContext, type RouteDecl } from '../http/route.js';
import { OPS_PAGE_PATH, OPS_SIGN_IN_HREF, renderOpsBrowserOnly, renderUpdatePage } from '../ops/update-page.js';
import { sseEnabled } from '../realtime/streams.js';
import { bundledBlockedOf } from './updates.js';

// The ops routes (spec §9.4, §13.5 "Ops"; plan Task 15, route catalog `ops.*`), all `opsAuth` (http/ops-auth.ts: the
// `altis_ops` cookie, or a session holding the op kind's permission), `mode: system` (they keep working in read-only),
// `maintenance: restore-allow` (they are how an op is followed while everything else is closed), no idempotency:
//
//   GET  ops/current    the current op (OpView); 404 OPS_NONE without one. 1d Task 28 (preflight S20): both answers
//                       carry `X-Altis-Serving: server`, so app.js's `/admin/_update`, which polls this route while a
//                       pending release boots, reloads into the server's page as soon as the server answers
//   POST ops/drive      {resume?}: resume an op in needs_attention, then (external mode) step it for what is left
//                       of 20 s (P9)
//   POST ops/cancel     reauth: the op cancelled (409 OPS_POINT_OF_NO_RETURN past it); audit `ops.cancel`. It and
//                       takeover go ahead of the steppers (OpsMachine control requests, ≤ 20 s); a step lock still
//                       held after 15 s is 409 OPS_IN_PROGRESS, and the retry finds it free
//   POST ops/takeover   reauth: the op bound to the caller, a new `altis_ops`; audit `ops.takeover` {opId, from}
//   GET  ops/report     ops/<opId>/report.json as an application/json attachment; 404 NOT_FOUND without one
//   GET  /admin/_update the operations page (1c Task 19, ops/update-page.tsx), mounted before admin.index (M3);
//                       without a cookie or a session, updatePageRefusal below answers for it (app.ts's failure path).
//                       1d Task 29: SSE when available (pageSse), a blocked bundled release while no op runs
//
// 1d Task 29: the OpView of an `update` op carries `update` (its target and "pemulihan DB diperlukan bila gagal"),
// read from op.json's params.
//
// None of them reads a table on the cookie's path (a restore past its point of no return may have dropped them all):
// the op lives in DATA_DIR/ops (1d Task 29: the page's settings reads, SSE and the blocked release, never run during a
// restore). The writes are `tx: 'self'`: they talk to the ops machine and its files, which must
// never sit inside a re-runnable transaction (R37, D3); their audit entry is a transaction of its own after the change.

const OPS = '/api/v1/ops';

/** One drive call's budget (P9: a slice of work ≤ 20 s). */
export const OPS_DRIVE_BUDGET_MS = 20_000;
/** A drive whose resume left less than this of its budget does not step. */
const MIN_STEP_MS = 1000;

const NO_STORE = { 'Cache-Control': 'no-store' };
/** 1d Task 28 (S20): what `ops/current` answers with besides NO_STORE: the server, not app.js, answered. */
const SERVED = { ...NO_STORE, [SERVING_HEADER]: 'server' };

// Core's OpStatus is what the shared view describes (a compile-time check that the two stay one shape).
const _statusIsView: (s: OpStatus) => OpStatusView = (s) => s;
void _statusIsView;

/** How this process runs its work: the job runtime's mode, else (no runtime yet: `ops_wait`) the runtime's rule. */
function modeOf(rc: RouteContext): OpView['mode'] {
  return rc.services.jobs?.mode ?? runnerMode(rc.services.runtime, rc.services.configWriter.env);
}

function noOp(): DomainError {
  return new DomainError('OPS_NONE', { detail: 'Tidak ada operasi yang sedang berjalan / No operation is in progress' });
}

/**
 * 1d Task 29: what the operations page shows of an `update` op besides its status, from op.json's params (a file, never
 * a table): the target and its precheck's "pemulihan DB diperlukan bila gagal" (§9.6). Undefined for another kind, and
 * when op.json no longer holds that op (it changed between the two reads; the next poll shows it).
 */
async function updateFactsOf(rc: RouteContext, status: OpStatus): Promise<OpUpdateView | undefined> {
  if (status.kind !== 'update' || status.opId === null) return undefined;
  let op: Awaited<ReturnType<typeof readOpFile>>;
  try {
    op = await readOpFile(rc.services.dataDir);
  } catch {
    return undefined;
  }
  if (op === null || op === 'corrupt' || op.opId !== status.opId) return undefined;
  const target = op.params['target'];
  const precheck = op.params['precheck'];
  const dbRestoreNeeded =
    typeof precheck === 'object' && precheck !== null && (precheck as Record<string, unknown>)['dbRestoreNeeded'] === true;
  return { target: typeof target === 'string' ? target : null, dbRestoreNeeded };
}

/**
 * What the ops routes answer for `status`. `csrfToken`: the op's CSRF token for a caller authenticated by its
 * `altis_ops` cookie (or who just received one, `withOpsToken`), null with a session (the SPA has the session's).
 * 1d Task 29: `update` for an update op (updateFactsOf).
 */
async function viewOf(rc: RouteContext, status: OpStatus, o: { withOpsToken?: boolean } = {}): Promise<OpView> {
  const cookieOp = rc.opsAuth?.via === 'cookie' ? rc.opsAuth.opId : o.withOpsToken === true ? status.opId : null;
  const update = await updateFactsOf(rc, status);
  return {
    ...status,
    mode: modeOf(rc),
    csrfToken: cookieOp === null ? null : opsCsrfToken(csrfKey(rc.config), cookieOp),
    driveable: !status.terminal && !status.needsAttention && status.kind !== null,
    ...(update === undefined ? {} : { update }),
  };
}

/** The staff actor of a session caller (`ops/cancel`, `ops/takeover` need one). */
function staffActor(rc: RouteContext): { type: 'staff'; id: string } {
  if (rc.auth === null) throw new DomainError('OPS_AUTH_REQUIRED');
  return { type: 'staff', id: rc.auth.subjectId };
}

const current = route({
  id: 'ops.current',
  method: 'GET',
  path: `${OPS}/current`,
  opsAuth: true,
  mode: 'system',
  maintenance: 'restore-allow',
  idempotency: 'none',
  audit: null,
  async handler(rc) {
    const status = await rc.services.ops.current();
    if (status === null) {
      // The 404 itself, not a throw: a thrown error's answer drops the headers the handler set (ruling R1b-1 d).
      const none = problemResponse(noOp(), rc.requestId);
      for (const [name, value] of Object.entries(SERVED)) none.headers.set(name, value);
      return none;
    }
    return { body: await viewOf(rc, status), headers: SERVED };
  },
});

const drive = route<OpsDriveBody>({
  id: 'ops.drive',
  method: 'POST',
  path: `${OPS}/drive`,
  opsAuth: true,
  mode: 'system',
  maintenance: 'restore-allow',
  idempotency: 'none',
  audit: null,
  tx: 'self',
  body: OpsDriveBody,
  async handler(rc) {
    const ops = rc.services.ops;
    let left = OPS_DRIVE_BUDGET_MS;
    if (rc.body.resume === true) {
      const began = performance.now();
      const before = await ops.current();
      // An unreadable op.json (no `startedAt`) has no state to go back to: Diagnostik and the CLI are its way out.
      if (before !== null && before.needsAttention && before.startedAt !== null) await ops.resume();
      // P9 (final review): one request, one 20 s budget; the step gets what the resume (which may wait for the step
      // lock) left of it, and none when under a second is left (the next drive steps the op).
      left = Math.floor(OPS_DRIVE_BUDGET_MS - (performance.now() - began));
    }
    // Spec §10.2: in worker mode the process's worker steps the op; a page only follows it. A retired handler's
    // machine is being closed: the handler serving next steps it.
    const status =
      modeOf(rc) === 'worker' || rc.services.retired || left < MIN_STEP_MS ? await ops.current() : await ops.step(left);
    if (status === null) throw noOp();
    return { body: await viewOf(rc, status), headers: NO_STORE };
  },
});

const cancel = route({
  id: 'ops.cancel',
  method: 'POST',
  path: `${OPS}/cancel`,
  opsAuth: true,
  reauth: true,
  mode: 'system',
  maintenance: 'restore-allow',
  idempotency: 'none',
  audit: 'ops.cancel',
  tx: 'self',
  async handler(rc) {
    const status = await rc.services.ops.cancel(staffActor(rc));
    await rc.audit({ entity: 'op', entityId: status.opId, meta: { opId: status.opId, kind: status.kind } });
    return { body: await viewOf(rc, status), headers: NO_STORE };
  },
});

const takeover = route({
  id: 'ops.takeover',
  method: 'POST',
  path: `${OPS}/takeover`,
  opsAuth: true,
  reauth: true,
  mode: 'system',
  maintenance: 'restore-allow',
  idempotency: 'none',
  audit: 'ops.takeover',
  tx: 'self',
  async handler(rc) {
    const ops = rc.services.ops;
    const actor = staffActor(rc);
    const before = await ops.current();
    const handle = await ops.takeover(actor);
    issueOpsCookie(rc.c, handle);
    await rc.audit({ entity: 'op', entityId: handle.opId, meta: { opId: handle.opId, from: before?.actor ?? null } });
    const status = await ops.current();
    if (status === null) throw noOp();
    return { body: await viewOf(rc, status, { withOpsToken: true }), headers: NO_STORE };
  },
});

/** A report is read in pieces of this size. */
const REPORT_CHUNK_BYTES = 65_536;

/** The bytes of `handle` from its start, piece by piece; the handle is closed at the end (or when the reader stops). */
function fileStream(handle: FileHandle): ReadableStream<Uint8Array> {
  let position = 0;
  const close = (): Promise<void> => handle.close().catch(() => undefined);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const buffer = new Uint8Array(REPORT_CHUNK_BYTES);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        if (bytesRead === 0) {
          await close();
          controller.close();
          return;
        }
        position += bytesRead;
        controller.enqueue(buffer.subarray(0, bytesRead));
      } catch (error) {
        await close();
        controller.error(error);
      }
    },
    cancel: close,
  });
}

function isMissing(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

const report = route({
  id: 'ops.report',
  method: 'GET',
  path: `${OPS}/report`,
  opsAuth: true,
  mode: 'system',
  maintenance: 'restore-allow',
  idempotency: 'none',
  audit: null,
  async handler(rc) {
    const status = await rc.services.ops.current();
    if (status === null || status.opId === null) throw noOp();
    let handle: FileHandle;
    try {
      handle = await openRead(dataPath(rc.services.dataDir, 'ops', status.opId, 'report.json'));
    } catch (error) {
      if (isMissing(error)) throw new DomainError('NOT_FOUND');
      throw error;
    }
    let size: number;
    try {
      size = (await handle.stat()).size;
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
    const name = `altis-${status.kind ?? 'ops'}-${status.opId}-report.json`;
    return new Response(fileStream(handle), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': String(size),
        'Content-Disposition': `attachment; filename="${name}"`,
        ...NO_STORE,
      },
    });
  },
});

// ---- 1c Task 19: the operations page ---------------------------------------------------------------------------

/** The headers of an HTML answer of the page: its own nonce in the policy, never stored. */
function pageHeaders(nonce: string): Record<string, string> {
  return { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': cspHeader(nonce) };
}

/**
 * The page's language: `?lang=`, then the signed-in user's, then the library's. The library's setting is a table read,
 * which never happens during a restore (its tables may be gone, decision C20) nor without a database (`ops_wait`); the
 * page is then in the default language unless `?lang=` says otherwise.
 */
async function pageLocale(rc: RouteContext): Promise<Locale> {
  const asked = rc.c.req.query('lang');
  const own = rc.auth?.user.locale ?? null;
  if ((asked !== undefined && isLocale(asked)) || own !== null) return resolveLocale(asked, own);
  if (rc.services.opsFence?.restoreInProgress() === true) return resolveLocale();
  try {
    return resolveLocale(await rc.services.settings.get<string>(rc.db.db, 'library.locale'));
  } catch {
    return resolveLocale(); // no database (a process waiting for an op), or it failed: the page still answers
  }
}

const updatePage = route({
  id: 'ops.update_page',
  method: 'GET',
  path: OPS_PAGE_PATH,
  opsAuth: true,
  mode: 'system',
  maintenance: 'restore-allow',
  idempotency: 'none',
  audit: null,
  async handler(rc) {
    const status = await rc.services.ops.current();
    const op = status === null ? null : await viewOf(rc, status);
    // The page drives with the op's token (the `altis_ops` cookie), else with the session's; it re-authenticates a full
    // session with the session's token (ruling R1c-9).
    const session = rc.auth !== null && rc.auth.stage === 'full';
    const ownToken = rc.auth === null ? null : sessionCsrfToken(csrfKey(rc.config), rc.auth.session.id);
    const csrfToken = op?.csrfToken ?? ownToken;
    const totp = session && rc.auth?.user.totpEnabled === true;
    const locale = await pageLocale(rc);
    const nonce = cspNonce();
    // 1d Task 29: SSE when available (preflight 1D-27); a blocked bundled release while no op runs (§9.8 row 2).
    const sse = session && (await pageSse(rc));
    const bundledBlocked = op === null || op.terminal ? await bundledBlockedOf(rc) : null;
    const page = renderUpdatePage({
      locale,
      nonce,
      op,
      csrfToken,
      session,
      sessionCsrfToken: session ? ownToken : null,
      totp,
      sse,
      bundledBlocked,
    });
    return rc.c.body(page, 200, pageHeaders(nonce));
  },
});

/**
 * 1d Task 29 (preflight 1D-27): whether the page follows `system.update` over SSE: a session that may read the channel
 * (`system.update.read`; `GET events/stream` needs a session, the `altis_ops` cookie alone never opens it) and SSE on
 * for this runtime (`realtime.sse`, sseEnabled). Never during a restore (no table is read then), and false when the
 * setting cannot be read; the page polls `ops/current` every 2 s otherwise, as app.js's page always does.
 */
async function pageSse(rc: RouteContext): Promise<boolean> {
  if (rc.auth === null || !can(rc.auth.grants, 'system.update.read')) return false;
  if (rc.services.opsFence?.restoreInProgress() === true) return false;
  try {
    return sseEnabled(await rc.services.settings.get<boolean | null>(rc.db.db, 'realtime.sse'), rc.services.runtime);
  } catch {
    return false;
  }
}

/**
 * What a browser gets for `/admin/_update` when `opsAuth` found neither a valid `altis_ops` cookie nor a session (step
 * 9's 401 OPS_AUTH_REQUIRED, which app.ts's failure path hands here), or null for any other failure or path:
 *
 * - while sessions can open the ops routes (no restore, and not a process waiting for an op): 302 to the sign-in page,
 *   which comes back to the page afterwards;
 * - during a restore (or in `ops_wait`): the 401 page saying the op can be followed only from the browser that started
 *   it (ops/update-page.tsx renderOpsBrowserOnly), since nobody can sign in meanwhile.
 *
 * The headers steps 7 and 9 set on the context (the test gate) stay on the answer.
 */
export function updatePageRefusal(error: unknown, c: Context<AppEnv>, o: { sessionsClosed: boolean }): Response | null {
  const method = c.req.method;
  if (c.req.path !== OPS_PAGE_PATH || (method !== 'GET' && method !== 'HEAD')) return null;
  if (!isDomainError(error) || error.code !== 'OPS_AUTH_REQUIRED') return null;
  if (!o.sessionsClosed) {
    return c.body(null, 302, { Location: OPS_SIGN_IN_HREF, 'Cache-Control': 'no-store' });
  }
  const nonce = cspNonce();
  return c.body(renderOpsBrowserOnly({ nonce }), 401, pageHeaders(nonce));
}

/**
 * The ops routes (route catalog `ops.current|drive|cancel|takeover|report|update_page`); app routes list them before
 * ADMIN_ROUTES (M3: Hono serves the first match, and `/admin/_update` must precede admin.index's `/admin/*`).
 */
export const OPS_ROUTES: RouteDecl[] = [current, drive, cancel, takeover, report, updatePage];
