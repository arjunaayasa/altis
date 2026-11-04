// Child process for concurrency.test.ts, started through `node --import tsx` (see children.ts).
//
// Usage: concurrency-child.mjs <optionsJson>, options {config, dataDir, op, count, tag, ...}. Opens the test
// database (dataDir holds the SQLite file), sends 'ready' over IPC, waits for 'go', then starts `count` operations
// at once and sends {results, attempts} (one result per operation, in order; attempts: transactions started, retries
// included) before it exits 0. Any failure (a TX_CONFLICT among them) makes it exit 1. It exits 2 when its parent's
// IPC channel closes (the parent died or gave up), so it never outlives its test:
// - op 'upsert' {key}: withTx + upsert of settings row `key` with value JSON "<tag>-<i>" -> 'inserted'|'updated';
// - op 'increment' {bucket, windowStart}: withTx + increment of rate_limits.count -> the value read back;
// - op 'claim' {name, ttlMs}: claimLock(name, owner "<tag>-<i>") -> boolean.
import { claimLock, increment, upsert } from '../../src/concurrency.ts';
import { connect } from '../../src/connect.ts';
import { withTx } from '../../src/tx.ts';

// The sources are run unbundled: give their test hooks the test profile that Vitest defines for the parent.
globalThis.__BUILD_PROFILE__ = 'test';

const o = JSON.parse(process.argv[2]);
let attempts = 0;
process.on('disconnect', () => process.exit(2));

function one(h, i) {
  const own = `${o.tag}-${i}`;
  switch (o.op) {
    case 'upsert': {
      const value = JSON.stringify(own);
      return withTx(h, (trx) => {
        attempts += 1;
        return upsert(trx, 'settings', { key: o.key }, { value, scope: 'data', updated_at: Date.now() }, { value, updated_at: Date.now() });
      });
    }
    case 'increment':
      return withTx(h, (trx) => {
        attempts += 1;
        return increment(trx, 'rate_limits', { bucket: o.bucket, window_start: o.windowStart }, 'count', { bucket_name: o.bucket });
      });
    case 'claim':
      return claimLock(h, o.name, own, o.ttlMs);
    default:
      throw new Error(`unknown op ${o.op}`);
  }
}

// The production shape on a server engine: Passenger workers, each with its small pool (3 connections, P17).
// SQLite is refused on Passenger, so it runs standalone.
const runtime = o.config.dialect === 'sqlite' ? 'standalone' : 'passenger';
const h = await connect(o.config, { runtime, purpose: 'server', dataDir: o.dataDir });
process.on('message', (message) => {
  if (message !== 'go') return;
  Promise.all(Array.from({ length: o.count }, (_, i) => one(h, i)))
    .then((results) => new Promise((resolve) => process.send({ results, attempts }, resolve)))
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
