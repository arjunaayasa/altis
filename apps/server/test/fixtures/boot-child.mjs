// Child process for restore-boot.test.ts, started through `node --import tsx` with fork(): a server process of its own
// booted by start(ctx) (src/index.ts) with a fake bootloader context, as app.js boots it, on the parent's DATA_DIR and
// database, while a restore runs there (preflight B4).
//
// Usage: boot-child.mjs <optionsJson>, options {dataDir, appRoot, runtime}. The child listens on 127.0.0.1 (a random
// port) and sends {port} over IPC as soon as it listens, before start() settles (start() waits in `ops_wait` while the
// op runs); then {started: true} once start() has settled, and {restart: reason} for each ctx.requestRestart. When its
// parent's IPC channel closes it closes the server, which retires the handler, and exits.
import http from 'node:http';
import path from 'node:path';

// The sources run unbundled: their test hooks need the test profile that Vitest defines for the parent, before any of
// them is evaluated (routes.ts builds its list at import time).
globalThis.__BUILD_PROFILE__ = 'test';
const { start } = await import('../../src/index.ts');

const o = JSON.parse(process.argv[2]);
const silent = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

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
  release: { version: '0.1.0', dir: path.join(o.appRoot, 'release'), source: 'bundled' },
  runtime: o.runtime,
  port: 0,
  markHealthy: async () => {},
  requestRestart: async (reason) => {
    if (process.connected) process.send({ restart: reason });
  },
  bootMarker: { phase() {}, progress() {} },
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
process.send({ port });
start(ctx).then(
  () => {
    if (process.connected) process.send({ started: true });
  },
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
