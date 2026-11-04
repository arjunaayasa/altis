// Child process for update-boot.test.ts (plan Task 25, Review Focus 1), started through `node --import tsx` with fork():
// the pending boot of an update's target, booted by start(ctx) (src/index.ts) with a fake bootloader context as app.js
// boots a pending release (`pendingBoot: true`, markHealthy promoting current.json), on the parent's DATA_DIR and
// database. The parent kills it (SIGKILL) while the update op migrates.
//
// Usage: update-boot-child.mjs <optionsJson>, options {dataDir, appRoot, version}. The child listens on 127.0.0.1 (a
// random port) and sends {port} over IPC once it listens, {phase} for every boot marker phase, then {started: true} once
// start() has settled ({failed: message} when it rejected).
import http from 'node:http';
import path from 'node:path';

// The sources run unbundled: their test hooks need the test profile that Vitest defines for the parent.
globalThis.__BUILD_PROFILE__ = 'test';
const { start } = await import('../../src/index.ts');
const { updateCurrentState } = await import('../../../../packages/platform/src/index.ts');

const o = JSON.parse(process.argv[2]);
const silent = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };
const send = (m) => {
  if (process.connected) process.send(m);
};

let server;
const listening = new Promise((resolve, reject) => {
  server = http.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});

const ctx = {
  bootProtocol: 1,
  appRoot: o.appRoot,
  dataDir: o.dataDir,
  release: { version: o.version, dir: path.join(o.appRoot, 'release'), source: 'data' },
  runtime: 'standalone',
  port: 0,
  pendingBoot: true,
  // app.js's promotion (current.ts promote).
  markHealthy: async () => {
    await updateCurrentState(o.dataDir, (s) =>
      s.pending !== null && s.pending.version === o.version ? { ...s, previous: s.active, active: s.pending, pending: null, pendingSince: null } : null,
    );
  },
  requestRestart: async (reason) => send({ restart: reason }),
  bootMarker: {
    phase: (p) => send({ phase: p }),
    progress() {},
    waiting: (reason) => send({ waiting: reason }),
  },
  log: silent,
  serve(handler) {
    server.on('request', handler);
    return new Promise((resolve) => server.once('close', resolve));
  },
};

process.on('disconnect', () => {
  server.close();
  server.closeAllConnections();
  setTimeout(() => process.exit(0), 25_000).unref();
});

const port = await listening;
send({ port });
start(ctx).then(
  () => send({ started: true }),
  (error) => send({ failed: String(error && error.message) }),
);
