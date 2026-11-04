import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { utimesSync } from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { lockHostIdentity } from '@altis/platform';
import { newId } from '@altis/shared';
import { describe, expect, it, vi } from 'vitest';
import type { BootLog } from '../src/log.js';
import { BOOT_REFRESH_MS, BOOT_RETRY_MS, REVERT_STALL_MS, type BootMarker } from '../src/markers.js';
import { createLiveMarker, startRefresher } from '../src/pending.js';
import { installedKeysets } from '../src/release.js';
import { RESTART_EXIT_CODE } from '../src/restart.js';
import {
  BUNDLED_VERSION,
  healthJson,
  httpGet,
  logLines,
  releasesPath,
  rescueReason,
  useHarness,
  waitFor,
  waitForHttp,
  type AppProcess,
  type HttpReply,
  type Sandbox,
} from './helpers/harness.js';
import { fixtureImports, makeRelease, type StartBehaviour } from './helpers/make-release.js';

// The pending boot protocol of app.js (spec §9.2 step 3, §9.3, §9.8; 1d Task 16; Review Focus 1; preflight B8, S3, S14,
// S15, 1D-02, 1D-03), end to end: app.js runs as a child process with ALTIS_RUNTIME=service, current.json names
// 0.2.0-test as `pending` (a fixture release in DATA_DIR/releases) over the bundled 0.1.0-test, and what happened is read
// back from DATA_DIR: current.json, op.json, releases/boot.lock, the markers in releases/boot/0.2.0-test/, and the
// fixture's import spy (fixture-imports.txt). Dead holders are child processes that have exited.

const h = useHarness();

const PENDING = '0.2.0-test';
const ACTIVE = { version: BUNDLED_VERSION, source: 'bundled' } as const;
/** A lock host identity that is not this host's (another container, another machine). */
const OTHER_HOST = 'another-box/0d6c9f6e-1b6f-4f5e-9d1e-8c2c3b4a5d6e/pid:[4026532999]';

/** What app.js logs (see src/pending.ts). */
const REVERTED = 'pending release reverted';
const KEPT_BUSY = 'pending release kept: ops/step.lock is busy; the revert is tried again';
const WAITING = 'another process holds releases/boot.lock; waiting';

/** `/_health` of a process that waits for boot.lock (waiting.ts, §9.2 step 6). */
const WAITING_HEALTH = { status: 'maintenance', version: null };

/** A GET with a Cookie header (the harness's httpGet sends none). */
function getWithCookie(port: number, urlPath: string, cookie: string): Promise<HttpReply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, headers: { Cookie: cookie }, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

const silent: BootLog = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silent;
  },
};

async function writeJson(file: string, value: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fsp.readFile(file, 'utf8')) as Record<string, unknown>;
}

async function exists(file: string): Promise<boolean> {
  return fsp.stat(file).then(
    () => true,
    () => false,
  );
}

function pendingState(): Record<string, unknown> {
  return { schema: 1, active: ACTIVE, previous: null, pending: { version: PENDING, source: 'data' }, pendingSince: Date.now() - 1000, pinned: null };
}

function opPath(sb: Sandbox): string {
  return path.join(sb.dataDir, 'ops', 'op.json');
}

/** An `update` op of the server targeting 0.2.0-test, with fields app.js does not know. */
function updateOp(state: string, o: { stateBefore?: string; error?: unknown } = {}): Record<string, unknown> {
  const now = Date.now();
  const op: Record<string, unknown> = {
    opSchema: 1,
    opId: newId(),
    kind: 'update',
    actor: { type: 'staff', id: newId() },
    state,
    version: PENDING,
    backupId: null,
    heartbeatAt: now - 1000,
    startedAt: now - 60_000,
    finishedAt: null,
    error: o.error ?? null,
    opsTokenHash: 'b'.repeat(64),
    pointOfNoReturn: true,
    params: { target: PENDING, source: 'feed', from: BUNDLED_VERSION, pendingWritten: true },
    progress: 60,
    message: null,
    futureField: 'kept',
  };
  if (o.stateBefore !== undefined) op['stateBefore'] = o.stateBefore;
  return op;
}

/** A sandbox whose current.json names 0.2.0-test pending (behaving as `startBehaviour`), with op.json `op` if given. */
async function pendingSandbox(o: { startBehaviour?: StartBehaviour; op?: Record<string, unknown> } = {}): Promise<Sandbox> {
  const sb = await h.sandbox();
  await makeRelease(releasesPath(sb, PENDING), { version: PENDING, startBehaviour: o.startBehaviour ?? 'ok' });
  await writeJson(releasesPath(sb, 'current.json'), pendingState());
  if (o.op !== undefined) await writeJson(opPath(sb), o.op);
  return sb;
}

const current = (sb: Sandbox): Promise<Record<string, unknown>> => readJson(releasesPath(sb, 'current.json'));
const op = (sb: Sandbox): Promise<Record<string, unknown>> => readJson(opPath(sb));

/** The marker files of 0.2.0-test. */
async function markerFiles(sb: Sandbox): Promise<string[]> {
  return fsp.readdir(releasesPath(sb, 'boot', PENDING)).then(
    (names) => names.filter((name) => /^\d+-\d+$/.test(name)),
    () => [],
  );
}

/** The pid of a process that has exited: a dead holder. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise<void>((resolve) => child.on('exit', () => resolve()));
  return child.pid as number;
}

/** A process that lives until the test ends (a live lock holder). */
function liveProcess(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });
  h.track(child.pid as number);
  return child;
}

/** The marker a holder that died left behind. */
async function leaveMarker(sb: Sandbox, pid: number, m: Partial<BootMarker> = {}, startMs = 1000): Promise<void> {
  const now = Date.now();
  const marker: BootMarker = { phase: 'importing', lastProgressAt: now - 5000, refreshedAt: now - 5000, host: lockHostIdentity(), waiting: null, error: null, ...m };
  await writeJson(releasesPath(sb, 'boot', PENDING, `${pid}-${startMs}`), marker);
}

/** Waits until `/_health` answers 200 from release `version`. */
function servedBy(sb: Sandbox, version: string): Promise<HttpReply> {
  return waitForHttp(sb.port, '/_health', (r) => r.status === 200 && healthJson(r)['version'] === version, 20_000);
}

async function ctxOf(sb: Sandbox): Promise<Record<string, unknown>> {
  return healthJson(await httpGet(sb.port, '/__ctx'));
}

function logLine(app: AppProcess, msg: string): Record<string, unknown> | undefined {
  return logLines(app.stderr()).find((line) => line['msg'] === msg);
}

/** Waits until 0.2.0-test was promoted and its markers and boot.lock are gone. */
async function promoted(sb: Sandbox): Promise<void> {
  await waitFor(
    async () => (await current(sb))['pending'] === null && !(await exists(releasesPath(sb, 'boot.lock'))) && !(await exists(releasesPath(sb, 'boot', PENDING))),
    'the promotion of 0.2.0-test',
  );
  expect(await current(sb)).toEqual({ schema: 1, active: { version: PENDING, source: 'data' }, previous: ACTIVE, pending: null, pendingSince: null, pinned: null });
}

/** Expects the revert of 0.2.0-test: pending cleared, markers and boot.lock gone, the active 0.1 serving. */
async function expectReverted(sb: Sandbox, app: AppProcess): Promise<void> {
  const health = await servedBy(sb, BUNDLED_VERSION);
  expect(healthJson(health)).toMatchObject({ source: 'bundled', pid: app.pid });
  expect(await current(sb)).toMatchObject({ active: ACTIVE, pending: null, pendingSince: null });
  expect(await exists(releasesPath(sb, 'boot', PENDING))).toBe(false);
  expect(await exists(releasesPath(sb, 'boot.lock'))).toBe(false);
}

describe('a pending release that boots (spec §9.3)', { timeout: 30_000 }, () => {
  it('this process holds boot.lock and its marker while it imports 0.2, serves it with pendingBoot, and markHealthy promotes', async () => {
    const sb = await pendingSandbox({ startBehaviour: 'slow' }); // the import takes 1.5 s
    const app = h.spawn(sb);
    await waitFor(async () => (await markerFiles(sb)).length === 1, 'the marker of the holder');
    expect(await readJson(releasesPath(sb, 'boot.lock'))).toMatchObject({ pid: app.pid, host: lockHostIdentity() });
    const [name] = await markerFiles(sb);
    expect(name).toMatch(new RegExp(`^${app.pid}-\\d+$`));
    expect(await readJson(releasesPath(sb, 'boot', PENDING, name as string))).toMatchObject({ phase: 'importing', waiting: null, error: null, host: lockHostIdentity() });

    const health = await servedBy(sb, PENDING);
    expect(healthJson(health)).toMatchObject({ source: 'data', pid: app.pid });
    expect(await ctxOf(sb)).toMatchObject({
      pendingBoot: true,
      release: { version: PENDING, source: 'data', dir: releasesPath(sb, PENDING) },
      bootMarker: ['phase', 'progress', 'waiting'],
    });
    await promoted(sb);
    expect(await fixtureImports(sb.dataDir)).toEqual([PENDING]);
  });
});

describe('a pending release that fails: revert in the same process (spec §9.2 step 3)', { timeout: 30_000 }, () => {
  it("start() rejects: 0.1 serves in the same process, op.json → reverting with detail start, markers and lock gone", async () => {
    const before = updateOp('switched');
    const sb = await pendingSandbox({ startBehaviour: 'reject', op: before });
    const app = h.spawn(sb);
    await expectReverted(sb, app);
    expect(await op(sb)).toEqual({ ...before, state: 'reverting', stateBefore: 'switched', error: { code: 'UPDATE_BOOT_FAILED', detail: 'start' }, heartbeatAt: expect.any(Number) });
    expect(logLine(app, REVERTED)).toMatchObject({ release: PENDING, detail: 'start', opRecord: 'written' });
    expect(await fixtureImports(sb.dataDir)).toEqual([PENDING, BUNDLED_VERSION]);
    expect(await ctxOf(sb)).toMatchObject({ release: { version: BUNDLED_VERSION, source: 'bundled' } });
    expect((await ctxOf(sb))['pendingBoot']).toBeUndefined();
  });

  it('verification fails (server.mjs changed): reverted with detail verify, 0.2 never imported', async () => {
    const sb = await pendingSandbox({ op: updateOp('switched') });
    await fsp.appendFile(releasesPath(sb, PENDING, 'server.mjs'), '\n// changed\n');
    const app = h.spawn(sb);
    await expectReverted(sb, app);
    expect(await op(sb)).toMatchObject({ state: 'reverting', error: { code: 'UPDATE_BOOT_FAILED', detail: 'verify' } });
    expect(await fixtureImports(sb.dataDir)).toEqual([BUNDLED_VERSION]);
  });

  it('the import throws: reverted with detail import', async () => {
    const sb = await pendingSandbox({ startBehaviour: 'throw-on-import', op: updateOp('switched') });
    const app = h.spawn(sb);
    await expectReverted(sb, app);
    expect(await op(sb)).toMatchObject({ state: 'reverting', error: { code: 'UPDATE_BOOT_FAILED', detail: 'import' } });
  });

  it('op.json cannot be read at all (a folder): the STATE_CORRUPT rescue page, boot.lock let go, pending kept', async () => {
    const sb = await pendingSandbox();
    await fsp.mkdir(opPath(sb), { recursive: true });
    h.spawn(sb);
    expect(await rescueReason(sb)).toBe('STATE_CORRUPT');
    expect(await exists(releasesPath(sb, 'boot.lock'))).toBe(false); // another process may try
    expect((await current(sb))['pending']).toEqual({ version: PENDING, source: 'data' });
    expect(await fixtureImports(sb.dataDir)).toEqual([]);
  });

  it('without an op.json (none): pending is still cleared', async () => {
    const sb = await pendingSandbox({ startBehaviour: 'reject' });
    const app = h.spawn(sb);
    await expectReverted(sb, app);
    expect(logLine(app, REVERTED)).toMatchObject({ opRecord: 'none' });
    expect(await exists(opPath(sb))).toBe(false);
  });
});

describe('counting earlier attempts (Review Focus 1)', { timeout: 30_000 }, () => {
  it('three dead holders in importing: the next boot reverts without importing 0.2, detail repeated', async () => {
    const sb = await pendingSandbox({ op: updateOp('switched') });
    for (const pid of [await deadPid(), await deadPid(), await deadPid()]) await leaveMarker(sb, pid);
    const app = h.spawn(sb);
    await expectReverted(sb, app);
    expect(await fixtureImports(sb.dataDir)).toEqual([BUNDLED_VERSION]);
    expect(await op(sb)).toMatchObject({ state: 'reverting', error: { code: 'UPDATE_BOOT_FAILED', detail: 'repeated' } });
  });

  it('a dead holder in migrating with progress 30 s before its last refresh is interrupted: 0.2 boots; 90 s: failed', async () => {
    const now = Date.now();
    const interrupted = await pendingSandbox();
    for (const pid of [await deadPid(), await deadPid()]) await leaveMarker(interrupted, pid);
    await leaveMarker(interrupted, await deadPid(), { phase: 'migrating', refreshedAt: now - 5000, lastProgressAt: now - 35_000 });
    h.spawn(interrupted);
    await servedBy(interrupted, PENDING);
    await promoted(interrupted);

    const failed = await pendingSandbox();
    for (const pid of [await deadPid(), await deadPid()]) await leaveMarker(failed, pid);
    await leaveMarker(failed, await deadPid(), { phase: 'migrating', refreshedAt: now - 5000, lastProgressAt: now - 95_000 });
    const app = h.spawn(failed);
    await expectReverted(failed, app);
    expect(await fixtureImports(failed.dataDir)).toEqual([BUNDLED_VERSION]);
  });

  it("a dead holder that waited for the database is not counted: 0.2 boots", async () => {
    const sb = await pendingSandbox();
    for (const pid of [await deadPid(), await deadPid()]) await leaveMarker(sb, pid);
    await leaveMarker(sb, await deadPid(), { phase: 'listening', waiting: 'db_unavailable' });
    h.spawn(sb);
    await servedBy(sb, PENDING);
    await promoted(sb);
  });

  it("S15: markers of another host count once they are 61 s old (revert), not while they are fresher (0.2 boots)", async () => {
    const now = Date.now();
    const old = await pendingSandbox();
    for (let i = 1; i <= 3; i += 1) await leaveMarker(old, 1, { host: OTHER_HOST, refreshedAt: now - 61_000, lastProgressAt: now - 61_000 }, i);
    const app = h.spawn(old);
    await expectReverted(old, app);
    expect(await fixtureImports(old.dataDir)).toEqual([BUNDLED_VERSION]);

    const fresh = await pendingSandbox();
    const later = Date.now(); // the first part took a while: 50 s from now, well inside the 60 s window
    for (let i = 1; i <= 3; i += 1) await leaveMarker(fresh, 1, { host: OTHER_HOST, refreshedAt: later - 50_000, lastProgressAt: later - 50_000 }, i);
    h.spawn(fresh);
    await servedBy(fresh, PENDING);
    await promoted(fresh);
  });
});

describe('boot.lock held by another process (spec §9.3)', { timeout: 40_000 }, () => {
  it('a live holder: this process waits (§9.2 step 6) without importing; its first request ≥ 5 s after the promotion boots 0.2 as active', async () => {
    const op: Record<string, unknown> = { ...updateOp('migrating'), opsTokenHash: createHash('sha256').update('the-ops-token').digest('hex') };
    const sb = await pendingSandbox({ op });
    const holder = liveProcess();
    await writeJson(releasesPath(sb, 'boot.lock'), { pid: holder.pid, startMs: Date.now(), token: 'the-holder', host: lockHostIdentity() });
    const app = h.spawn(sb);
    await waitFor(() => logLine(app, WAITING) !== undefined, 'the waiting process');
    const waitingSince = performance.now();
    const reply = await httpGet(sb.port, '/_health');
    expect(reply.status).toBe(503);
    expect(healthJson(reply)).toEqual(WAITING_HEALTH);
    // Task 22 (Review Focus 4): the op is followed from op.json by its altis_ops cookie, and /admin/_update answers.
    const followed = await getWithCookie(sb.port, '/api/v1/ops/current', 'altis_ops=the-ops-token');
    expect(followed.status).toBe(200);
    expect(followed.headers['x-altis-serving']).toBe('app');
    expect(JSON.parse(followed.body)).toMatchObject({ opId: op['opId'], kind: 'update', state: 'migrating', progress: 60, driveable: false });
    expect((await getWithCookie(sb.port, '/admin/_update', 'altis_ops=the-ops-token')).status).toBe(200);
    expect((await getWithCookie(sb.port, '/api/v1/ops/current', 'altis_ops=another-token')).status).toBe(401);
    expect(await fixtureImports(sb.dataDir)).toEqual([]);
    expect(await markerFiles(sb)).toEqual([]);

    // The holder promotes 0.2 and lets boot.lock go.
    await writeJson(releasesPath(sb, 'current.json'), { schema: 1, active: { version: PENDING, source: 'data' }, previous: ACTIVE, pending: null, pendingSince: null, pinned: null });
    await fsp.rm(releasesPath(sb, 'boot.lock'));
    holder.kill('SIGKILL');

    const health = await servedBy(sb, PENDING);
    expect(performance.now() - waitingSince).toBeGreaterThanOrEqual(BOOT_RETRY_MS - 1000);
    expect(healthJson(health)).toMatchObject({ pid: app.pid, source: 'data' });
    const ctx = await ctxOf(sb);
    expect(ctx['pendingBoot']).toBeUndefined(); // booted as `active`
    expect(await fixtureImports(sb.dataDir)).toEqual([PENDING]);
    expect(await exists(releasesPath(sb, 'boot.lock'))).toBe(false);
  });

  it('a holder on another host whose lock is 61 s old: the lock is taken and 0.2 boots; 45 s old: waiting', async () => {
    const stale = await pendingSandbox();
    await writeJson(releasesPath(stale, 'boot.lock'), { pid: 1, startMs: 0, token: 'elsewhere', host: OTHER_HOST });
    const longAgo = new Date(Date.now() - 61_000);
    await fsp.utimes(releasesPath(stale, 'boot.lock'), longAgo, longAgo);
    h.spawn(stale);
    await servedBy(stale, PENDING);
    await promoted(stale);

    const fresh = await pendingSandbox();
    await writeJson(releasesPath(fresh, 'boot.lock'), { pid: 1, startMs: 0, token: 'elsewhere', host: OTHER_HOST });
    const recently = new Date(Date.now() - 45_000);
    await fsp.utimes(releasesPath(fresh, 'boot.lock'), recently, recently);
    const app = h.spawn(fresh);
    await waitFor(() => logLine(app, WAITING) !== undefined, 'the waiting process');
    expect(await fixtureImports(fresh.dataDir)).toEqual([]);
    expect(await readJson(releasesPath(fresh, 'boot.lock'))).toMatchObject({ token: 'elsewhere' });
  });
});

describe('kill points (preflight B8, 1D-02)', { timeout: 30_000 }, () => {
  it('op.json already reverting for 0.2 while pending is still 0.2: reverted without importing 0.2; the op record answers already', async () => {
    const before = updateOp('reverting', { error: { code: 'UPDATE_BOOT_FAILED', detail: 'migration' } });
    const sb = await pendingSandbox({ op: before });
    const app = h.spawn(sb);
    await expectReverted(sb, app);
    expect(await fixtureImports(sb.dataDir)).toEqual([BUNDLED_VERSION]);
    expect(logLine(app, REVERTED)).toMatchObject({ release: PENDING, opRecord: 'already' });
    expect(await op(sb)).toEqual(before); // untouched: the release that steps the revert owns it now
  });

  it('op.json in needs_attention (stateBefore migrating): reverted the same way, and the op is reverting', async () => {
    const before = updateOp('needs_attention', { stateBefore: 'migrating', error: { code: 'STATE_CORRUPT' } });
    const sb = await pendingSandbox({ op: before });
    const app = h.spawn(sb);
    await expectReverted(sb, app);
    expect(await fixtureImports(sb.dataDir)).toEqual([BUNDLED_VERSION]);
    expect(logLine(app, REVERTED)).toMatchObject({ release: PENDING, opRecord: 'written' });
    expect(await op(sb)).toMatchObject({ state: 'reverting', stateBefore: 'migrating', error: { code: 'UPDATE_BOOT_FAILED' }, futureField: 'kept' });
  });
});

describe('ops/step.lock busy while a revert is recorded (S3)', () => {
  it('busy: pending stays, the marker keeps its error, boot.lock is let go, the minimal pages are served; ≥ 5 s later a request reverts', { timeout: 120_000 }, async () => {
    const sb = await pendingSandbox({ startBehaviour: 'reject', op: updateOp('migrating') });
    const stepper = liveProcess();
    const stepLock = path.join(sb.dataDir, 'ops', 'step.lock');
    await writeJson(stepLock, { pid: stepper.pid, startMs: Date.now(), token: 'the-stepper', host: lockHostIdentity() });
    // The stepper's heartbeat: the lock stays fresh for as long as it is held.
    const heartbeat = setInterval(() => {
      const now = new Date();
      try {
        utimesSync(stepLock, now, now);
      } catch {
        // released
      }
    }, 2000);
    let app: AppProcess;
    try {
      app = h.spawn(sb);
      await waitFor(() => logLine(app, KEPT_BUSY) !== undefined, 'the busy step lock', 60_000);
      expect(logLine(app, KEPT_BUSY)).toMatchObject({ release: PENDING, detail: 'start' });
      expect((await current(sb))['pending']).toEqual({ version: PENDING, source: 'data' });
      const [name] = await markerFiles(sb);
      expect(await readJson(releasesPath(sb, 'boot', PENDING, name as string))).toMatchObject({ error: { detail: 'start', reason: 'START_FAILED' } });
      expect(await exists(releasesPath(sb, 'boot.lock'))).toBe(false);
      const reply = await httpGet(sb.port, '/_health');
      expect(reply.status).toBe(503);
      expect(healthJson(reply)).toEqual(WAITING_HEALTH);
      expect(await op(sb)).toMatchObject({ state: 'migrating', error: null });
    } finally {
      clearInterval(heartbeat);
    }
    await fsp.rm(stepLock);
    stepper.kill('SIGKILL');
    await expectReverted(sb, app);
    expect(await op(sb)).toMatchObject({ state: 'reverting', stateBefore: 'migrating', error: { code: 'UPDATE_BOOT_FAILED', detail: 'start' } });
    expect(await fixtureImports(sb.dataDir)).toEqual([PENDING, BUNDLED_VERSION]); // 0.2 was not imported again
  });
});

describe('the bundled copy of the same version is the fallback, never a newer one (S14)', { timeout: 30_000 }, () => {
  it('releases/0.1.0-test fails verification and bundled-release/0.1.0-test is beside app.js: the bundled copy serves', async () => {
    const sb = await h.sandbox();
    await makeRelease(releasesPath(sb, BUNDLED_VERSION), { version: BUNDLED_VERSION });
    await fsp.appendFile(releasesPath(sb, BUNDLED_VERSION, 'server.mjs'), '\n// changed\n');
    await writeJson(releasesPath(sb, 'current.json'), { schema: 1, active: { version: BUNDLED_VERSION, source: 'data' }, previous: null, pending: null, pendingSince: null, pinned: null });
    const app = h.spawn(sb);
    const health = await servedBy(sb, BUNDLED_VERSION);
    expect(healthJson(health)).toMatchObject({ source: 'bundled', pid: app.pid });
    expect(await ctxOf(sb)).toMatchObject({ release: { version: BUNDLED_VERSION, source: 'bundled', dir: sb.bundledDir } });
  });

  it('previous in DATA_DIR fails too: its bundled copy of the same version serves', async () => {
    const sb = await h.sandbox();
    await makeRelease(releasesPath(sb, PENDING), { version: PENDING, startBehaviour: 'reject' });
    await makeRelease(releasesPath(sb, BUNDLED_VERSION), { version: BUNDLED_VERSION });
    await fsp.appendFile(releasesPath(sb, BUNDLED_VERSION, 'server.mjs'), '\n// changed\n');
    await writeJson(releasesPath(sb, 'current.json'), {
      schema: 1,
      active: { version: PENDING, source: 'data' },
      previous: { version: BUNDLED_VERSION, source: 'data' },
      pending: null,
      pendingSince: null,
      pinned: null,
    });
    await writeJson(releasesPath(sb, 'schema-meta.json'), { schemaVersion: '0003', minCodeVersion: BUNDLED_VERSION });
    const app = h.spawn(sb);
    const health = await servedBy(sb, BUNDLED_VERSION);
    expect(healthJson(health)).toMatchObject({ source: 'bundled', pid: app.pid });
  });

  it('only a newer bundled-release/0.2.0-test beside app.js: it is not a fallback, the 1a rescue page shows', async () => {
    const sb = await h.sandbox({ appJsVersion: PENDING });
    await makeRelease(releasesPath(sb, BUNDLED_VERSION), { version: BUNDLED_VERSION });
    await fsp.appendFile(releasesPath(sb, BUNDLED_VERSION, 'server.mjs'), '\n// changed\n');
    await writeJson(releasesPath(sb, 'current.json'), { schema: 1, active: { version: BUNDLED_VERSION, source: 'data' }, previous: null, pending: null, pendingSince: null, pinned: null });
    h.spawn(sb);
    expect(await rescueReason(sb)).toBe('RELEASE_INVALID');
    expect(await fixtureImports(sb.dataDir)).toEqual([]);
  });
});

describe('the bundled release against the active one (§9.8)', { timeout: 30_000 }, () => {
  it('bundled 0.2 is newer and releases/0.1.0-test is there: 0.1 boots with ctx.bundledRelease newer', async () => {
    const sb = await h.sandbox({ appJsVersion: PENDING });
    await makeRelease(releasesPath(sb, BUNDLED_VERSION), { version: BUNDLED_VERSION });
    await writeJson(releasesPath(sb, 'current.json'), { schema: 1, active: { version: BUNDLED_VERSION, source: 'data' }, previous: null, pending: null, pendingSince: null, pinned: null });
    h.spawn(sb);
    await servedBy(sb, BUNDLED_VERSION);
    const ctx = await ctxOf(sb);
    expect(ctx).toMatchObject({ release: { version: BUNDLED_VERSION, source: 'data' }, bundledRelease: { version: PENDING, dir: sb.bundledDir, relation: 'newer' } });
    expect(ctx['bootMode']).toBeUndefined();
    expect(ctx['pendingBoot']).toBeUndefined();
  });

  it('the active folder is missing: the bundled release boots with bootMode schemaHold; app.js moves no pointer', async () => {
    const sb = await h.sandbox({ appJsVersion: PENDING });
    const state = { schema: 1, active: { version: BUNDLED_VERSION, source: 'data' }, previous: null, pending: null, pendingSince: null, pinned: null };
    await writeJson(releasesPath(sb, 'current.json'), state);
    h.spawn(sb);
    await servedBy(sb, PENDING);
    expect(await ctxOf(sb)).toMatchObject({ bootMode: 'schemaHold', release: { version: PENDING, source: 'bundled', dir: sb.bundledDir } });
    expect(await current(sb)).toEqual(state);
  });

  it('bundled equal to active: relation same; bundled older than active: relation older', async () => {
    const same = await h.sandbox();
    h.spawn(same);
    await servedBy(same, BUNDLED_VERSION);
    expect((await ctxOf(same))['bundledRelease']).toEqual({ version: BUNDLED_VERSION, dir: same.bundledDir, relation: 'same' });

    const older = await h.sandbox();
    await makeRelease(releasesPath(older, PENDING), { version: PENDING });
    await writeJson(releasesPath(older, 'current.json'), { schema: 1, active: { version: PENDING, source: 'data' }, previous: ACTIVE, pending: null, pendingSince: null, pinned: null });
    h.spawn(older);
    await servedBy(older, PENDING);
    expect((await ctxOf(older))['bundledRelease']).toEqual({ version: BUNDLED_VERSION, dir: older.bundledDir, relation: 'older' });
  });
});

describe('the standalone supervisor checks what its child will boot', { timeout: 120_000 }, () => {
  /** No ALTIS_RUNTIME: detectRuntime says `standalone`, and app.js supervises a child that serves. */
  const STANDALONE = { ALTIS_RUNTIME: undefined };

  /** /_health 200 from the child (not the supervisor) serving `version`. */
  async function childServes(sb: Sandbox, app: AppProcess, version: string): Promise<number> {
    const reply = await waitForHttp(sb.port, '/_health', (r) => r.status === 200 && healthJson(r)['version'] === version, 45_000);
    const pid = healthJson(reply)['pid'] as number;
    h.track(pid);
    expect(pid).not.toBe(app.pid);
    return pid;
  }

  it('§9.8 row 3: the active folder is missing and the bundled release is newer: the child boots it in schemaHold', async () => {
    const sb = await h.sandbox({ appJsVersion: PENDING });
    await writeJson(releasesPath(sb, 'current.json'), { schema: 1, active: { version: BUNDLED_VERSION, source: 'data' }, previous: null, pending: null, pendingSince: null, pinned: null });
    const app = h.spawn(sb, { env: STANDALONE });
    await childServes(sb, app, PENDING);
    expect(await ctxOf(sb)).toMatchObject({ bootMode: 'schemaHold', runtime: 'standalone' });
  });

  it('a pending release over a broken active one: the child boots the pending release', async () => {
    const sb = await pendingSandbox();
    await fsp.appendFile(path.join(sb.bundledDir, 'server.mjs'), '\n// changed\n'); // active (bundled) fails verification
    const app = h.spawn(sb, { env: STANDALONE });
    await childServes(sb, app, PENDING);
    await promoted(sb);
  });
});

describe('keysets with a pending release (R65a, preflight M5: a regression test)', () => {
  it("installedKeysets reads the pending release's keyset.json", async () => {
    const sb = await h.sandbox();
    await makeRelease(releasesPath(sb, PENDING), { version: PENDING });
    const sources = await installedKeysets(
      sb.appRoot,
      sb.dataDir,
      { schema: 1, active: ACTIVE, previous: null, pending: { version: PENDING, source: 'data' }, pendingSince: 1, pinned: null },
      silent,
    );
    expect(sources.map((source) => source.name)).toContain(`DATA_DIR/releases/${PENDING}/keyset.json`);
  });
});

describe('the refresher of the holder (fake timers; preflight 1D-03)', () => {
  it('refreshes the marker and op.json every 10 s; a migration stalled for 15 min writes stalled and exits keeping boot.lock; the next process reverts', { timeout: 60_000 }, async () => {
    const sb = await pendingSandbox({ op: updateOp('migrating') });
    // The holder: a process that is gone by the time the next one starts (it exits through the spy below).
    const pid = await deadPid();
    const startMs = Date.now() - 60_000;
    const lockFile = releasesPath(sb, 'boot.lock');
    const lockRecord = { pid, startMs, token: 'the-holder', host: lockHostIdentity() };
    await writeJson(lockFile, lockRecord);
    const markerFile = releasesPath(sb, 'boot', PENDING, `${pid}-${startMs}`);
    const exit = vi.fn();

    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date', 'performance'] });
    try {
      const marker = createLiveMarker({ dataDir: sb.dataDir, version: PENDING, pid, startMs, log: silent });
      await marker.begin();
      const t0 = Date.now();
      marker.phase('migrating');
      await marker.flush();
      const refresher = startRefresher({ dataDir: sb.dataDir, version: PENDING, marker, lock: { lost: () => false }, log: silent, exit });

      for (const n of [1, 2]) {
        await vi.advanceTimersByTimeAsync(BOOT_REFRESH_MS);
        await refresher.idle();
        expect(await readJson(markerFile)).toMatchObject({ phase: 'migrating', refreshedAt: t0 + n * BOOT_REFRESH_MS, lastProgressAt: t0, error: null });
        expect((await op(sb))['heartbeatAt']).toBe(t0 + n * BOOT_REFRESH_MS);
      }

      // The migration is blocked: no progress. At 15 min it is not yet stalled; by 16 min it is.
      while (Date.now() - t0 < REVERT_STALL_MS) {
        await vi.advanceTimersByTimeAsync(BOOT_REFRESH_MS);
        await refresher.idle();
      }
      expect(exit).not.toHaveBeenCalled();
      while (exit.mock.calls.length === 0 && Date.now() - t0 < 16 * 60_000) {
        await vi.advanceTimersByTimeAsync(BOOT_REFRESH_MS);
        await refresher.idle();
      }
      expect(exit).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(RESTART_EXIT_CODE);
      expect(await readJson(markerFile)).toMatchObject({ phase: 'migrating', error: { detail: 'stalled', reason: 'START_FAILED' } });
      expect(await readJson(lockFile)).toEqual(lockRecord); // boot.lock kept (1D-03)
      // Stopped: nothing more is written.
      const after = await fsp.readFile(markerFile, 'utf8');
      await vi.advanceTimersByTimeAsync(3 * BOOT_REFRESH_MS);
      await refresher.idle();
      expect(await fsp.readFile(markerFile, 'utf8')).toBe(after);
      expect(exit).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }

    // A second process takes the stale lock (its holder is gone), sees the explicit error and reverts.
    const app = h.spawn(sb);
    await expectReverted(sb, app);
    expect(await op(sb)).toMatchObject({ state: 'reverting', stateBefore: 'migrating', error: { code: 'UPDATE_BOOT_FAILED', detail: 'stalled' } });
    expect(await fixtureImports(sb.dataDir)).toEqual([BUNDLED_VERSION]); // 0.2 was not imported again
    expect((await op(sb))['state']).not.toBe('done');
  });
});
