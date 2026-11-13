import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SCHEDULES, createJobRegistry, hmacB64u, notify, readSettings, searchHealth, seedSchedules, tickSchedules, writeSettings } from '@altis/core';
import { PHASE1_MIGRATIONS, runMigrations, withTx } from '@altis/db';
import type { Runtime } from '@altis/platform';
import type { DiagnosticsReport, ProbePollResponse, ProbeResultBody } from '@altis/shared/api/diagnostics';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { createApp } from '../../src/app.js';
import { writeConfig } from '../../src/config.js';
import { csrfKey } from '../../src/http/csrf.js';
import { jobHandlers } from '../../src/jobs/runtime.js';
import { createAgent, type Agent, type AgentReply } from '../agent.js';
import { seedStaff, sessionCookieFor, sessionCsrfFor } from '../support-auth.js';
import { recordingLogger, sampleConfig } from '../support.js';

// The Diagnostik API of Task 23 (spec §11, §2.4, P10, P15; acceptance A9; route catalog `diagnostics.*`) on the engine
// picked by ALTIS_TEST_DB: the report holds every §11 item (and the edition); the browser test's result sets
// `system.ip_trust` (A9: "uji XFF mendeteksi spoofable"); SSE can be turned on on Passenger only after the browser
// test saw it work; the clock confirmation needs a fresh re-authentication; the probe routes answer what the browser
// test measures; the scheduler's payloads are what the three Diagnostik jobs take (S16).

const ctx = testDbContext();
/** In the past: an audit row may not be dated ahead of the real clock. */
const NOW = Date.UTC(2026, 9, 27, 9, 0, 5);
const HOUR = 3_600_000;
const MIB = 1024 * 1024;
const CONFIG = sampleConfig({ db: { dialect: 'sqlite' } });
/** baseUrl is https: the session cookie carries the `__Host-` prefix. */
const SID = '__Host-altis_sid';
const DIAG = '/api/v1/diagnostics';
const PROBE = `${DIAG}/probe`;

const code = (res: AgentReply): string | undefined => (res.json as { code?: string } | undefined)?.code;

/** The report's keys, literally (A9: every §11 item). */
const REPORT_KEYS = [
  'audit',
  'backup',
  'clock',
  'database',
  'dataDir',
  'disk',
  'edition',
  'exposure',
  'http',
  'memory',
  'network',
  'queue',
  'release',
  'runtime',
  'wasm',
  // ---- Phase 2 (catalog): Task 3 (B2), filled by Task 15 ----
  'search',
  'oai',
  // ---- Komunitas K1 (edition lane) ----
  'editionLane',
].sort();

describe.skipIf(!ctx.available)(`Diagnostik API [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;
  let dataDir: string;
  let superAdmin: string;
  let reader: string;

  /** The app on `runtime`, peer `peer`. */
  function build(runtime: Runtime = 'passenger') {
    return createApp({
      state: { phase: 'ready', db: h, config: CONFIG },
      version: '0.1.0',
      buildId: 'b',
      log: recordingLogger(),
      clock: () => NOW,
      env: {},
      dataDir,
      runtime,
      appJsVersion: '0.1.0',
    });
  }

  /** A browser signed in as `userId` (re-authenticated now with `reauth`), sending the session's CSRF token. */
  async function browser(userId: string, o: { runtime?: Runtime; reauth?: boolean; peer?: string } = {}): Promise<Agent & { csrf: string }> {
    const token = await sessionCookieFor(h, userId, { now: NOW, reauthAt: o.reauth === true ? NOW : null });
    const csrf = sessionCsrfFor(CONFIG, token);
    const agent = createAgent(build(o.runtime), { headers: { 'x-csrf-token': csrf }, ...(o.peer === undefined ? {} : { peer: o.peer }) });
    agent.setCookie(SID, token);
    return Object.assign(agent, { csrf });
  }

  const auditCount = async (action: string): Promise<number> =>
    (await h.db.selectFrom('audit_log').select('seq').where('action', '=', action).execute()).length;
  const setting = async (key: Parameters<typeof readSettings>[1][number]) => (await readSettings(h.db, [key], []))[key];
  const set = (values: Parameters<typeof writeSettings>[1]) =>
    withTx(h, (trx) => writeSettings(trx, values, { keyring: [], now: NOW, actorId: null }));

  const probeResult = (forgedDerived: string): ProbeResultBody => ({
    polling: true,
    sse: true,
    methods: { put: true, patch: true, delete: true },
    chunkBytes: 5 * MIB,
    xff: { cleanXff: ['198.51.100.7'], forgedXff: ['203.0.113.77', '198.51.100.7'], forgedDerived },
  });

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-diagnostics-api-')));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(root, 'mig'), migrations: PHASE1_MIGRATIONS });
    dataDir = path.join(root, 'data');
    await writeConfig(dataDir, CONFIG);
    superAdmin = (await seedStaff(h, { username: 'kepala', roles: [{ key: 'super_admin' }], now: NOW })).id;
    reader = (await seedStaff(h, { username: 'pembaca', roles: [{ permissions: ['system.diagnostics.read'] }], now: NOW })).id;
  });

  afterAll(async () => {
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await h.db.deleteFrom('settings').execute();
    await h.db.deleteFrom('notifications').execute();
  });

  describe('GET diagnostics', () => {
    it('the exact key set of DiagnosticsReport, the edition, the versions of the release and of app.js', async () => {
      const res = await (await browser(reader)).get(DIAG);
      expect(res.status, res.text).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const report = res.json as DiagnosticsReport;
      expect(Object.keys(report).sort()).toEqual(REPORT_KEYS);
      // The app's edition (rulings R1, R9): the community edition, active.
      expect(report.edition).toEqual({ edition: 'community', status: 'active' });
      expect(report).not.toHaveProperty('license');
      // Phase 2 (B2, Task 15): the search index's health, and OAI on without an admin e-mail (the spec's defaults).
      expect(report.search).toEqual(await searchHealth(h.db));
      expect(report.oai).toEqual({ enabled: true, adminEmailSet: false });
      // No migration of another lane on a community install.
      expect(report.editionLane).toEqual({ applied: 0 });
      expect(report.release).toMatchObject({ version: '0.1.0', appJsVersion: '0.1.0', bootProtocol: 1, pending: null, pinned: null, bundled: null });
      expect(report.release.keyset).toEqual({ docs: 0, maxSeq: 0, full: false });
      expect(report.runtime).toMatchObject({ runtime: 'passenger', transport: 'polling', runner: { mode: 'external' } });
      expect(report.network).toEqual({ ipTrust: 'ok', hops: 1, suggestedHops: null });
      expect(report.database.dialect).toBe(h.dialect);
    });

    it('S25: after a disk_low notification, disk.lowAt is its time', async () => {
      await withTx(h, (trx) =>
        notify(trx, { audience: { permission: 'system.diagnostics.read' }, type: 'disk.low', titleKey: 'notification.disk_low.title' }, NOW - HOUR),
      );
      const report = (await (await browser(reader)).get(DIAG)).json as DiagnosticsReport;
      expect(report.disk).toEqual({ lowAt: NOW - HOUR });
    });

    it('without system.diagnostics.read → 403; anonymous → 401', async () => {
      const nobody = (await seedStaff(h, { username: 'tanpa_peran', now: NOW })).id;
      expect((await (await browser(nobody)).get(DIAG)).status).toBe(403);
      expect((await createAgent(build()).get(DIAG)).status).toBe(401);
    });
  });

  describe('POST diagnostics/probe-result (A9: the XFF test detects spoofable)', () => {
    it('a spoofable XFF result → system.ip_trust spoofable and one diagnostics.probe_result entry; a clean one → ok', async () => {
      const admin = await browser(superAdmin);
      const before = await auditCount('diagnostics.probe_result');
      const res = await admin.post(`${DIAG}/probe-result`, probeResult('203.0.113.77'));
      expect(res.status, res.text).toBe(200);
      expect(res.json).toEqual({ ipTrust: 'spoofable', spoofable: true, suggestedHops: 1 });
      expect(await setting('system.ip_trust')).toBe('spoofable');
      expect(await auditCount('diagnostics.probe_result')).toBe(before + 1);
      const row = await h.db
        .selectFrom('audit_log')
        .select('meta')
        .where('action', '=', 'diagnostics.probe_result')
        .orderBy('seq', 'desc')
        .executeTakeFirstOrThrow();
      expect(JSON.parse(row.meta)).toEqual({ spoofable: true, suggestedHops: 1, methodsBlocked: [] });
      expect(await setting('system.probe')).toMatchObject({ at: NOW, sse: true, chunkBytes: 5 * MIB, xff: { spoofable: true, suggestedHops: 1 } });

      const clean = await admin.post(`${DIAG}/probe-result`, probeResult('198.51.100.7'));
      expect(clean.json).toEqual({ ipTrust: 'ok', spoofable: false, suggestedHops: 1 });
      expect(await setting('system.ip_trust')).toBe('ok');
      // The report shows what the test found.
      const report = (await admin.get(DIAG)).json as DiagnosticsReport;
      expect(report.network).toEqual({ ipTrust: 'ok', hops: 1, suggestedHops: 1 });
      expect(report.http).toEqual({ methods: { put: true, patch: true, delete: true }, methodOverride: false, chunkBytes: 5 * MIB, probedAt: NOW });
    });

    it('needs system.diagnostics.manage; a malformed result → 422', async () => {
      expect((await (await browser(reader)).post(`${DIAG}/probe-result`, probeResult('198.51.100.7'))).status).toBe(403);
      const admin = await browser(superAdmin);
      const res = await admin.post(`${DIAG}/probe-result`, { ...probeResult('x'), extra: true });
      expect(res.status).toBe(422);
      const tooMany = { ...probeResult('x'), xff: { cleanXff: Array(11).fill('198.51.100.7'), forgedXff: [], forgedDerived: 'x' } };
      expect((await admin.post(`${DIAG}/probe-result`, tooMany)).status).toBe(422);
    });
  });

  describe('PUT diagnostics/realtime (§2.4)', () => {
    it('sse: true on passenger without a probe → 409 REALTIME_PROBE_REQUIRED, nothing written', async () => {
      const before = await auditCount('diagnostics.realtime');
      const res = await (await browser(superAdmin)).put(`${DIAG}/realtime`, { sse: true });
      expect(res.status, res.text).toBe(409);
      expect(code(res)).toBe('REALTIME_PROBE_REQUIRED');
      expect(await setting('realtime.sse')).toBeNull();
      expect(await auditCount('diagnostics.realtime')).toBe(before);
    });

    it('with system.probe.sse = true an hour old → 200 and one diagnostics.realtime entry; a probe older than 24 h is not enough', async () => {
      await set({
        'system.probe': {
          at: NOW - HOUR,
          polling: true,
          sse: true,
          methods: { put: true, patch: true, delete: true },
          chunkBytes: null,
          xff: { spoofable: false, suggestedHops: 1 },
        },
      });
      const admin = await browser(superAdmin);
      const before = await auditCount('diagnostics.realtime');
      const res = await admin.put(`${DIAG}/realtime`, { sse: true });
      expect(res.status, res.text).toBe(200);
      expect(res.json).toEqual({ sse: true, transport: 'sse' });
      expect(await setting('realtime.sse')).toBe(true);
      expect(await auditCount('diagnostics.realtime')).toBe(before + 1);
      // The SSE test failed: refused again.
      await set({
        'realtime.sse': null,
        'system.probe': {
          at: NOW - 25 * HOUR,
          polling: true,
          sse: true,
          methods: { put: true, patch: true, delete: true },
          chunkBytes: null,
          xff: { spoofable: false, suggestedHops: 1 },
        },
      });
      expect(code(await admin.put(`${DIAG}/realtime`, { sse: true }))).toBe('REALTIME_PROBE_REQUIRED');
      // Off and automatic need no probe.
      expect((await admin.put(`${DIAG}/realtime`, { sse: false })).json).toEqual({ sse: false, transport: 'polling' });
      expect((await admin.put(`${DIAG}/realtime`, { sse: null })).json).toEqual({ sse: null, transport: 'polling' });
    });

    it('on pm2 → 200 without a probe', async () => {
      const res = await (await browser(superAdmin, { runtime: 'pm2' })).put(`${DIAG}/realtime`, { sse: true });
      expect(res.status, res.text).toBe(200);
      expect(res.json).toEqual({ sse: true, transport: 'sse' });
    });
  });

  describe('POST diagnostics/clock-confirm (§10.4, §7.3)', () => {
    it('without a re-authentication → 401; with one → 200 and exactly one diagnostics.clock_confirm entry', async () => {
      await set({ 'system.clock_anomaly': { detectedAt: NOW - HOUR, maxSeen: NOW + 2 * HOUR } });
      const stale = await (await browser(superAdmin)).post(`${DIAG}/clock-confirm`);
      expect(stale.status, stale.text).toBe(401);
      const before = await auditCount('diagnostics.clock_confirm');
      const res = await (await browser(superAdmin, { reauth: true })).post(`${DIAG}/clock-confirm`);
      expect(res.status, res.text).toBe(200);
      expect(res.json).toEqual({ confirmedAt: NOW });
      expect(await auditCount('diagnostics.clock_confirm')).toBe(before + 1);
      expect(await setting('system.clock_anomaly')).toBeNull();
      expect(await setting('system.clock_confirmed')).toMatchObject({ at: NOW });
    });
  });

  describe('the probe routes (the browser test)', () => {
    it('GET probe/hmac/<nonce> = hmacB64u(sessionKey, "probe:" + nonce); a malformed nonce → 422', async () => {
      const agent = await browser(reader);
      const nonce = 'AbCdEfGh_ijkl-mnop1234';
      const res = await agent.get(`${PROBE}/hmac/${nonce}`);
      expect(res.status, res.text).toBe(200);
      expect(res.json).toEqual({ hmac: hmacB64u(csrfKey(CONFIG), `probe:${nonce}`) });
      expect((await agent.get(`${PROBE}/hmac/short`)).status).toBe(422);
    });

    it('the four methods answer {method}; the same through method override → 403 METHOD_OVERRIDE_DENIED', async () => {
      const agent = await browser(reader);
      expect((await agent.post(`${PROBE}/methods`)).json).toEqual({ method: 'POST' });
      expect((await agent.put(`${PROBE}/methods`)).json).toEqual({ method: 'PUT' });
      expect((await agent.patch(`${PROBE}/methods`)).json).toEqual({ method: 'PATCH' });
      expect((await agent.delete(`${PROBE}/methods`)).json).toEqual({ method: 'DELETE' });
      for (const method of ['PUT', 'PATCH', 'DELETE']) {
        const res = await agent.post(`${PROBE}/methods`, undefined, { 'x-http-method-override': method });
        expect(res.status, method).toBe(403);
        expect(code(res), method).toBe('METHOD_OVERRIDE_DENIED');
      }
    });

    it('POST probe/chunk: a 5 MiB chunk → {bytes: 5242880}; 7 MiB → 413', async () => {
      const agent = await browser(reader);
      const app = build();
      const send = (bytes: number) => {
        const form = new FormData();
        form.append('chunk', new Blob([new Uint8Array(bytes)]), 'chunk.bin');
        return app.request(
          `${PROBE}/chunk`,
          { method: 'POST', body: form, headers: { cookie: `${SID}=${agent.cookies.get(SID)!}`, 'x-csrf-token': agent.csrf } },
          { incoming: { socket: { remoteAddress: '203.0.113.10' } } },
        );
      };
      const five = await send(5 * MIB);
      expect(five.status).toBe(200);
      expect(await five.json()).toEqual({ bytes: 5_242_880 });
      const seven = await send(7 * MIB);
      expect(seven.status).toBe(413);
    });

    it('GET probe/sse: three ticks about a second apart, then done (on passenger, where SSE is off)', async () => {
      const agent = await browser(reader);
      const started = performance.now();
      const res = await agent.get(`${PROBE}/sse`);
      const took = performance.now() - started;
      expect(res.status, res.text).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const events = res.text
        .split('\n\n')
        .map((block) => block.split('\n').find((line) => line.startsWith('event: '))?.slice('event: '.length))
        .filter((e) => e !== undefined);
      expect(events).toEqual(['tick', 'tick', 'tick', 'done']);
      expect(res.text).toContain('data: {"n":3}');
      expect(took).toBeGreaterThanOrEqual(1900);
    });

    it('GET probe/poll with X-Forwarded-For: 203.0.113.77 from peer 127.0.0.1 → its chain as received', async () => {
      const agent = await browser(reader, { peer: '127.0.0.1' });
      const res = await agent.get(`${PROBE}/poll`, undefined, { 'x-forwarded-for': '203.0.113.77' });
      expect(res.status, res.text).toBe(200);
      const poll = res.json as ProbePollResponse;
      expect(poll).toEqual({
        now: NOW,
        ip: '203.0.113.77',
        ipTrust: 'ok',
        xff: ['203.0.113.77'],
        peerPrivate: true,
        suggestedHops: 1,
        ipAtSuggested: '203.0.113.77',
      });
      // A clean poll from a public peer: nothing to trust, hops 0.
      const clean = (await (await browser(reader)).get(`${PROBE}/poll`)).json as ProbePollResponse;
      expect(clean).toMatchObject({ xff: [], peerPrivate: false, suggestedHops: 0, ipAtSuggested: '203.0.113.10' });
    });
  });

  it('S16: tickSchedules enqueues, for the three Diagnostik schedules, payloads their handlers accept', async () => {
    await h.db.deleteFrom('jobs').execute();
    await h.db.deleteFrom('schedules').execute();
    const reg = createJobRegistry(jobHandlers({ diagnostics: { dataDir, appRoot: root, baseUrl: () => null } }));
    const tz = 'Asia/Jakarta';
    const t0 = Date.UTC(2026, 9, 20, 0, 0, 0);
    await withTx(h, (trx) => seedSchedules(trx, t0, tz, SCHEDULES));
    await tickSchedules(h, reg, { now: t0 + 2 * 86_400_000, tz, defs: SCHEDULES, keyring: CONFIG.keyring, anomaly: false });
    const jobs = await h.db.selectFrom('jobs').select(['type', 'payload']).where('type', 'like', 'diagnostics.%').orderBy('type').execute();
    expect(jobs.map((j) => j.type)).toEqual(['diagnostics.exposure', 'diagnostics.ip_trust', 'diagnostics.usage']);
    for (const job of jobs) {
      const handler = reg.get(job.type);
      expect(handler, job.type).toBeDefined();
      expect(handler!.payload.safeParse(JSON.parse(job.payload)).success, job.type).toBe(true);
    }
  });
});
