// Child process for rate-limit.test.ts, started through `node --import tsx` (as packages/db's audit-child.mjs).
//
// Usage: limit-child.mjs <optionsJson>, options {config, dataDir, count, name, subject, now}. Opens the test
// database (dataDir holds the SQLite file), sends 'ready' over IPC, waits for 'go', then starts `count` hit() calls
// at once on bucket `name` + `subject`, each in a transaction of its own (withTx), all at the one fixed `now` the
// parent chose (so no window boundary can split the run, M26), and sends {results: [{allowed, count}, ...]} before it
// exits 0. It exits 2 when its parent's IPC channel closes, so it never outlives its test.
import { connect, withTx } from '@altis/db';
import { hit } from '../../src/auth/rate-limit.ts';

// The sources are run unbundled: give their test hooks the test profile that Vitest defines for the parent.
globalThis.__BUILD_PROFILE__ = 'test';

const o = JSON.parse(process.argv[2]);
process.on('disconnect', () => process.exit(2));

function one(h) {
  return withTx(h, async (trx) => {
    const r = await hit(trx, o.name, o.subject, o.now);
    return { allowed: r.allowed, count: r.count };
  });
}

// The production shape on a server engine: Passenger workers, each with its small pool (3 connections, P17).
// SQLite is refused on Passenger, so it runs standalone.
const runtime = o.config.dialect === 'sqlite' ? 'standalone' : 'passenger';
const h = await connect(o.config, { runtime, purpose: 'server', dataDir: o.dataDir });
process.on('message', (message) => {
  if (message !== 'go') return;
  Promise.all(Array.from({ length: o.count }, () => one(h)))
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
