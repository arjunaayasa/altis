// Child process for restore-sqlite.test.ts, started through `node --import tsx` with fork(): a serving process of its
// own on the parent's SQLite DATA_DIR while the parent restores it (decision C17; S19, S23; plan Task 25). It holds
// what a server process holds and nothing more:
//
// - its own handle on `db/altis.sqlite`, opened by connect() with purpose `server` (runtime `pm2`), which writes
//   `tmp/sqlite-owner.json`;
// - an HTTP listener on 127.0.0.1 (a random port): `GET /name` answers `library.name` read from that handle (503 while
//   the handle is released);
// - the server's ops fence (apps/server/src/http/ops-fence.ts) with this process's SQLite owner side: `release` closes
//   the handle, `reopen` opens it again; `onEpoch` calls the fake bootloader context's requestRestart('data-epoch'),
//   as start() does;
// - no traffic: a worker loop, as runtime.ts's, checks the fence before each pass (every 100 ms; the fence itself looks
//   at most every 2 s).
//
// Usage: sqlite-owner-child.mjs <optionsJson>, options {dataDir}. IPC messages to the parent: {port} once it listens,
// {released: <epoch ms>} and {reopened: <epoch ms>, epoch} for each release and reopen, {restart: reason, at} for each
// requestRestart. When its parent's IPC channel closes it stops, closes its handle and exits.
import http from 'node:http';
import { connect } from '@altis/db';

// The sources run unbundled: their test hooks need the test profile that Vitest defines for the parent.
globalThis.__BUILD_PROFILE__ = 'test';
const { createOpsFence } = await import('../../../../apps/server/src/http/ops-fence.ts');

const o = JSON.parse(process.argv[2]);
const send = (message) => {
  if (process.connected) process.send(message);
};
const open = () => connect({ dialect: 'sqlite' }, { runtime: 'pm2', purpose: 'server', dataDir: o.dataDir });

let handle = await open();
let stopping = false;

/** The fake bootloader context's requestRestart (start() calls it from the fence's onEpoch, S23). */
const ctx = {
  requestRestart: async (reason) => send({ restart: reason, at: Date.now() }),
};

const fence = createOpsFence({
  dataDir: o.dataDir,
  clock: () => Date.now(),
  onEpoch: () => {
    void ctx.requestRestart('data-epoch');
  },
  onOpEnded: () => {},
  sqlite: {
    async release() {
      if (handle === undefined) return;
      const h = handle;
      handle = undefined;
      await h.close();
      send({ released: Date.now() });
    },
    async reopen() {
      if (handle !== undefined || stopping) return;
      handle = await open();
      send({ reopened: Date.now(), epoch: fence.epoch() });
    },
  },
});
await fence.check(); // the first look learns the data epoch

const server = http.createServer((req, res) => {
  const h = handle;
  if (req.url !== '/name' || h === undefined) {
    res.writeHead(h === undefined ? 503 : 404).end();
    return;
  }
  h.db
    .selectFrom('settings')
    .select('value')
    .where('key', '=', 'library.name')
    .executeTakeFirst()
    .then(
      (row) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ name: row ? JSON.parse(row.value) : null })),
      () => res.writeHead(503).end(),
    );
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

/** The worker loop: the fences before each pass (S19); this process has no jobs to run. */
const loop = (async () => {
  while (!stopping) {
    await fence.check();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
})();

process.on('disconnect', () => {
  stopping = true;
  server.close();
  server.closeAllConnections();
  void loop
    .then(() => handle?.close())
    .finally(() => process.exit(0));
});

send({ port: server.address().port });
