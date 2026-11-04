// Child process for auth-login.test.ts and audit-coverage.test.ts, started through `node --import tsx` (as
// packages/core's limit-child.mjs).
//
// Usage: login-child.mjs <optionsJson>, options {db, dataDir, config, count, username, password, peer, now, mode}.
// Opens the test database (`db` is its DbConfig; dataDir holds the SQLite file), builds the HTTP app on it with
// config.json `config` and the fixed clock `now` (M26), sends 'ready' over IPC and waits for 'go'. Then it sends `count`
// `POST /api/v1/auth/login` requests, each as a fresh browser at the peer address `peer` (a pre-session CSRF cookie of
// its own and its token), and sends {results: [{status, code, stage}, ...]} before it exits 0:
// - mode `burst` (the default): all `count` at once (parallel failures against the limits, auth-login.test.ts);
// - mode `until-stop`: one after another, each waiting for the previous answer, as a user signing in again and again
//   with the right password while other processes write (S26: Task 31's audit coverage), until the parent sends
//   'stop' (`count` is ignored); 'first' goes to the parent once the first login has answered, so the parent can start
//   its own writes knowing this child is writing too. One at a time stays inside the process's password-hash queue,
//   so every login is meant to complete; the parent checks it.
// It exits 2 when its parent's IPC channel closes, so it never outlives its test.
import { randomToken } from '@altis/core';
import { connect } from '@altis/db';
import { createApp } from '../../src/app.ts';
import { cookieName, isSecureBase } from '../../src/http/cookies.ts';
import { csrfKey, preSessionCsrfToken } from '../../src/http/csrf.ts';

// The sources are run unbundled: give their test hooks the test profile that Vitest defines for the parent.
globalThis.__BUILD_PROFILE__ = 'test';

const o = JSON.parse(process.argv[2]);
process.on('disconnect', () => process.exit(2));

const silent = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

// The production shape on a server engine: a Passenger worker with its small pool. SQLite is refused on Passenger,
// so it runs standalone.
const runtime = o.db.dialect === 'sqlite' ? 'standalone' : 'passenger';
const h = await connect(o.db, { runtime, purpose: 'server', dataDir: o.dataDir });
const app = createApp({
  state: { phase: 'ready', db: h, config: o.config },
  version: '0.1.0',
  buildId: 'child',
  log: silent,
  clock: () => o.now,
  services: { sweeper: { maybeSweep() {} } },
});
const csrfCookie = cookieName('altis_csrf', isSecureBase(o.config.baseUrl));

async function one() {
  const value = randomToken(32);
  const res = await app.request(
    '/api/v1/auth/login',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `${csrfCookie}=${value}`,
        'x-csrf-token': preSessionCsrfToken(csrfKey(o.config), value),
      },
      body: JSON.stringify({ username: o.username, password: o.password }),
    },
    { incoming: { socket: { remoteAddress: o.peer } } },
  );
  const body = await res.json();
  return { status: res.status, code: body.code ?? null, stage: body.stage ?? null };
}

let stopping = false;

/** The logins: `count` at once (`burst`), or one after another until 'stop' (`until-stop`). */
async function all() {
  if (o.mode === 'until-stop') {
    const results = [];
    while (!stopping) {
      results.push(await one());
      if (results.length === 1) process.send('first');
    }
    return results;
  }
  if (o.mode !== undefined && o.mode !== 'burst') throw new TypeError(`login-child: unknown mode ${JSON.stringify(o.mode)}`);
  return Promise.all(Array.from({ length: o.count }, () => one()));
}

process.on('message', (message) => {
  if (message === 'stop') stopping = true;
  if (message !== 'go') return;
  all()
    .then((results) => new Promise((resolve) => process.send({ results }, resolve)))
    .finally(() => h.close())
    .then(
      () => process.exit(0),
      (error) => {
        console.error(error);
        process.exit(1);
      },
    );
});
process.send('ready');
