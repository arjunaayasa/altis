// Child process for the job runtime's tests (cli-jobs-run.test.ts), started through `node --import tsx` with fork(): a
// server process of its own booted by start(ctx) (src/index.ts), as app.js boots it, so that its clock
// (ALTIS_TEST_CLOCK_OFFSET_MS in its environment, M23), its worker loop and its database handle are another process's.
//
// Usage: runtime-child.mjs <optionsJson>, options {dataDir, appRoot, runtime, version?}. The child listens on
// 127.0.0.1 (a random port) and, once start() has settled, sends {port} over IPC. When its parent's IPC channel closes
// it closes the server, which retires the handler (the runtime drains, the database closes), and exits.
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
  release: { version: o.version ?? '0.1.0', dir: path.join(o.appRoot, 'release'), source: 'bundled' },
  runtime: o.runtime,
  port: 0,
  markHealthy: async () => {},
  requestRestart: async () => {},
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
await start(ctx);
process.send({ port });
