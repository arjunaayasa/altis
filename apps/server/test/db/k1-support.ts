import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSettingsCache, type Mailer } from '@altis/core';
import { PHASE1_MIGRATIONS, runMigrations } from '@altis/db';
import type { Permission } from '@altis/shared';
import { expect } from 'vitest';
import { testDbFor, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { createApp, type AppState } from '../../src/app.js';
import { writeConfig, type Config } from '../../src/config.js';
import { cookieName, isSecureBase } from '../../src/http/cookies.js';
import { createJobRuntime, jobHandlers, type JobRuntime } from '../../src/jobs/runtime.js';
import type { Logger } from '../../src/logger.js';
import { createAppOps } from '../../src/services.js';
import { createAgent, type AgentReply } from '../agent.js';
import { PERSONA_PASSWORD } from '../matrix-fixtures.js';
import { seedStaff, sessionCookieFor, sessionCsrfFor } from '../support-auth.js';
import { sampleConfig } from '../support.js';

// What the community integration tests share (k1-integration, k1-public-output): one installation on the engine picked
// by ALTIS_TEST_DB with the app, its job runtime (external mode: a job runs when a test drives it, slice by slice, as
// `POST jobs/:id/drive` would) and a clock the tests move; staff users through the real roles; browsers that drive the
// API as the admin SPA does (the session cookie, its CSRF token, the base address's Origin), with downloads read as
// bytes and uploads made through the upload API.

const API = '/api/v1';
const silentMailer: Mailer = { send: async () => {} };

/** A response read whole as bytes. */
export interface ByteReply {
  status: number;
  body: Buffer;
  headers: Headers;
}

/** A browser of one staff user's session. */
export interface K1Browser {
  readonly userId: string;
  send(method: 'get' | 'post' | 'put' | 'patch' | 'delete', url: string, body?: unknown, headers?: Record<string, string>): Promise<AgentReply>;
  /** `GET url`, the body as bytes (a download). */
  bytes(url: string): Promise<ByteReply>;
  /** Uploads `data` into upload context `context` (declare, chunks, complete): what `complete` answered. */
  upload(context: string, data: Uint8Array, name: string): Promise<{ uploadId?: string; fileId?: string }>;
}

export interface K1Installation {
  h: TestDbHandle;
  root: string;
  dataDir: string;
  config: Config;
  app: ReturnType<typeof createApp>;
  runtime: JobRuntime;
  /** The app's and the runtime's clock, which a test moves on; six hours behind the real one (audit entries never lie ahead). */
  clock: { now: number };
  /**
   * A staff user holding `permissions` through a role of their own, or the super admin role; the password is
   * PERSONA_PASSWORD.
   */
  staff(username: string, permissions: readonly Permission[] | 'super_admin'): Promise<string>;
  /** A browser of a new session of `userId`; `reauthAt` a moment of its last re-authentication (null: none). */
  browser(userId: string, o?: { reauthAt?: number | null }): Promise<K1Browser>;
  /** Drives job `jobId` slice by slice until it stops continuing; its last outcome. */
  drive(jobId: string): Promise<string>;
  close(): Promise<void>;
}

/** An installed, migrated installation with the app and its job runtime; `log` is the app's and the runtime's logger. */
export async function openK1Installation(o: { prefix: string; baseUrl: string; log: Logger | ((dataDir: string) => Logger) }): Promise<K1Installation> {
  const ctx = testDbContext();
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), `altis-${o.prefix}-`)));
  const dataDir = path.join(root, 'data');
  await fsp.mkdir(path.join(dataDir, 'tmp'), { recursive: true });
  const h = await testDbFor(ctx.engine, { dataDir });
  await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(root, 'migrations'), migrations: PHASE1_MIGRATIONS });
  const config = sampleConfig({ db: h.config, baseUrl: o.baseUrl });
  await writeConfig(dataDir, config);
  const log = typeof o.log === 'function' ? o.log(dataDir) : o.log;
  const clock = { now: Date.now() - 6 * 3_600_000 };
  const state: AppState = { phase: 'ready', db: h, config };
  const runtime = createJobRuntime({
    state,
    runtime: 'passenger',
    env: {},
    dataDir,
    log,
    clock: () => clock.now,
    ops: createAppOps(state, { dataDir, version: '0.1.0', log, clock: () => clock.now }),
    handlers: jobHandlers({ housekeeping: { dataDir, mailer: silentMailer, baseUrl: () => config.baseUrl, settings: createSettingsCache({ ttlMs: 0 }) } }),
    requestRestart: async () => {},
    installId: config.install.id,
    appVersion: '0.1.0',
  });
  state.jobs = runtime;
  const app = createApp({
    state,
    version: '0.1.0',
    buildId: o.prefix,
    log,
    clock: () => clock.now,
    env: {},
    dataDir,
    services: { mailer: silentMailer, emailTestMailer: silentMailer, settings: createSettingsCache({ ttlMs: 0 }) },
  });
  let peer = 0;

  async function browser(userId: string, b: { reauthAt?: number | null } = {}): Promise<K1Browser> {
    const token = await sessionCookieFor(h, userId, { now: clock.now, reauthAt: b.reauthAt === undefined ? clock.now : b.reauthAt });
    const origin = new URL(config.baseUrl).origin;
    peer += 1;
    const remote = `198.51.100.${10 + (peer % 200)}`;
    const agent = createAgent(app, { peer: remote, headers: { origin } });
    agent.setCookie(cookieName('altis_sid', isSecureBase(config.baseUrl)), token);
    let csrf = sessionCsrfFor(config, token);
    const cookie = (): string => [...agent.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const send: K1Browser['send'] = async (method, url, body, headers = {}) => {
      const res = await agent[method](url, body, { 'x-csrf-token': csrf, ...headers });
      csrf = res.headers.get('x-csrf-token') ?? csrf;
      return res;
    };
    const bytes: K1Browser['bytes'] = async (url) => {
      const res = await app.request(url, { method: 'GET', headers: { origin, cookie: cookie(), 'x-csrf-token': csrf } }, { incoming: { socket: { remoteAddress: remote } } });
      csrf = res.headers.get('x-csrf-token') ?? csrf;
      return { status: res.status, body: Buffer.from(await res.arrayBuffer()), headers: res.headers };
    };
    const upload: K1Browser['upload'] = async (context, data, name) => {
      const sha256 = createHash('sha256').update(data).digest('hex');
      const declared = await send('post', `${API}/files/uploads`, { context, size: data.byteLength, sha256, chunkBytes: 256 * 1024 });
      expect(declared.status, declared.text).toBe(201);
      const s = declared.json as { id: string; chunkSize: number };
      for (let n = 0; n * s.chunkSize < data.byteLength; n += 1) {
        const form = new FormData();
        form.append('chunk', new Blob([data.subarray(n * s.chunkSize, (n + 1) * s.chunkSize)]), 'blob');
        const res = await app.request(
          `${API}/files/uploads/${s.id}/chunks/${n}`,
          { method: 'POST', headers: { origin, cookie: cookie(), 'x-csrf-token': csrf }, body: form },
          { incoming: { socket: { remoteAddress: remote } } },
        );
        csrf = res.headers.get('x-csrf-token') ?? csrf;
        expect(res.status, await res.text()).toBe(200);
      }
      const done = await send('post', `${API}/files/uploads/${s.id}/complete`, { originalName: name });
      expect(done.status, done.text).toBe(200);
      return done.json as { uploadId?: string; fileId?: string };
    };
    return { userId, send, bytes, upload };
  }

  return {
    h,
    root,
    dataDir,
    config,
    app,
    runtime,
    clock,
    async staff(username, permissions) {
      const roles = permissions === 'super_admin' ? [{ key: 'super_admin' as const }] : [{ permissions: [...permissions] }];
      const user = await seedStaff(h, { username, password: PERSONA_PASSWORD, now: clock.now, roles, keyring: config.keyring });
      return user.id;
    },
    browser,
    async drive(jobId) {
      for (let tries = 0; tries < 4_000; tries += 1) {
        const r = await runtime.drive(jobId, { budgetMs: 20_000 });
        if (r !== null) {
          if (r.outcome !== 'continued') return r.outcome;
          continue;
        }
        // Not claimable now: the slice the app runs after a response (piggyback) has it, or it already ended.
        const job = await h.db.selectFrom('jobs').select('status').where('id', '=', jobId).executeTakeFirstOrThrow();
        if (job.status !== 'queued' && job.status !== 'running') return job.status;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`job ${jobId} did not end`);
    },
    async close() {
      await runtime.stop();
      await h.close();
      await fsp.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}
