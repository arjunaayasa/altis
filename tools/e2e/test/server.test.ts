import http from 'node:http';
import type net from 'node:net';
import { checkPasswordPolicy } from '@altis/core';
import { emailField, usernameField } from '@altis/shared/api/common';
import { afterEach, describe, expect, it } from 'vitest';
import { E2E_VERSION, childEnv, freePort, installInput, readAdminFixture, waitHealthy } from '../lib/server.js';

describe('the test install', () => {
  it('runs the test-profile release', () => {
    expect(E2E_VERSION).toBe('0.1.0-test');
  });

  it('signs the first super admin in with the test-only credentials of fixtures/admin.json', () => {
    const admin = readAdminFixture();
    expect(usernameField.parse(admin.username)).toBe(admin.username);
    expect(emailField.safeParse(admin.email).success).toBe(true);
    // The install refuses a password the policy refuses (PASSWORD_TOO_WEAK); the fixture must pass it.
    expect(() => checkPasswordPolicy(admin.password, { minLength: 10 })).not.toThrow();
  });

  it('installs standalone on SQLite at the address the browser uses, with that super admin', () => {
    const admin = readAdminFixture();
    expect(installInput({ baseUrl: 'http://127.0.0.1:4100', admin })).toEqual({
      baseUrl: 'http://127.0.0.1:4100',
      db: { dialect: 'sqlite' },
      library: { name: 'Perpustakaan E2E', timezone: 'Asia/Jakarta', locale: 'id' },
      admin: { username: admin.username, name: admin.name, password: admin.password, email: admin.email },
    });
  });
});

describe('childEnv (the environment of `node app.js`)', () => {
  it("passes what Node needs and nothing of this run's ALTIS_* or NODE_OPTIONS (Playwright's loader stays out of the app)", () => {
    const env = childEnv({
      PATH: '/usr/bin',
      HOME: '/home/ci',
      TMPDIR: '/tmp',
      LANG: 'C.UTF-8',
      ALTIS_DB_PASSWORD: 'secret',
      ALTIS_TEST_FAULT: 'boot',
      ALTIS_E2E_BASE_URL: 'http://127.0.0.1:1',
      NODE_OPTIONS: '--import playwright-loader',
      GITHUB_TOKEN: 'ghs_x',
    });
    expect(env).toEqual({ PATH: expect.stringContaining('/usr/bin'), HOME: '/home/ci', TMPDIR: '/tmp', LANG: 'C.UTF-8' });
    // This Node first, so the app runs on the Node of the test run.
    expect(env['PATH']!.split(process.platform === 'win32' ? ';' : ':')[0]).toBe(process.execPath.replace(/[\\/][^\\/]+$/, ''));
  });
});

describe('waitHealthy', () => {
  let server: http.Server | undefined;
  afterEach(async () => {
    await new Promise<void>((resolve) => (server === undefined ? resolve() : server.close(() => resolve())));
    server = undefined;
  });

  async function serve(handler: http.RequestListener): Promise<string> {
    server = http.createServer(handler);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  }

  it('waits through "starting" answers until /_health is 200 {"status":"ok"}', async () => {
    let calls = 0;
    const base = await serve((req, res) => {
      expect(req.url).toBe('/_health');
      calls += 1;
      if (calls < 3) {
        res.writeHead(503, { 'content-type': 'application/json' }).end('{"status":"starting"}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'ok', version: E2E_VERSION }));
    });
    await expect(waitHealthy(base, { timeoutMs: 5000, pollMs: 10 })).resolves.toEqual({ version: E2E_VERSION });
    expect(calls).toBe(3);
  });

  it('gives up when the process is gone, or after the timeout, saying what it last saw', async () => {
    const base = await serve((_req, res) => void res.writeHead(503).end('{"status":"starting"}'));
    await expect(waitHealthy(base, { timeoutMs: 5000, pollMs: 10, alive: () => false })).rejects.toThrow(/exited before \/_health answered 200 \(last: 503/);
    // A deadline long enough for the first 503 to arrive under a loaded full suite (100 ms was not: the first request
    // could still be waiting when it ran out, and `last` was then its timeout, not the 503).
    await expect(waitHealthy(base, { timeoutMs: 2000, pollMs: 10 })).rejects.toThrow(/did not answer 200 within 2000 ms \(last: 503/);
  });

  it('names the last answer, not the request the deadline cut short', async () => {
    let calls = 0;
    // The first request gets 503; every later one is never answered, so the last request runs into the deadline.
    const base = await serve((_req, res) => {
      calls += 1;
      if (calls === 1) res.writeHead(503).end('{"status":"starting"}');
    });
    await expect(waitHealthy(base, { timeoutMs: 300, pollMs: 10 })).rejects.toThrow(/did not answer 200 within 300 ms \(last: 503/);
  });

  it('retries a refused connection', async () => {
    const port = await freePort();
    await expect(waitHealthy(`http://127.0.0.1:${port}`, { timeoutMs: 150, pollMs: 10 })).rejects.toThrow(/ECONNREFUSED/);
  });
});
