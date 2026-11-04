// Child process for audit.test.ts, started through `node --import tsx` (see children.ts).
//
// Usage: audit-child.mjs <optionsJson>, options {config, dataDir, count, tag, branchId}. Opens the test database
// (dataDir holds the SQLite file), sends 'ready' over IPC, waits for 'go', then starts `count` auditAppend calls at
// once, each in a transaction of its own (withTx), and sends {results: [{id, seq, hash}, ...]} before it exits 0. It
// exits 2 when its parent's IPC channel closes, so it never outlives its test.
import { auditAppend } from '../../src/audit.ts';
import { connect } from '../../src/connect.ts';
import { withTx } from '../../src/tx.ts';

// The sources are run unbundled: give their test hooks the test profile that Vitest defines for the parent.
globalThis.__BUILD_PROFILE__ = 'test';

const o = JSON.parse(process.argv[2]);
process.on('disconnect', () => process.exit(2));

function append(h, i) {
  return withTx(h, (trx) =>
    auditAppend(trx, {
      at: Date.now(),
      actorType: 'system',
      actorId: null,
      action: 'test.append',
      entity: 'child',
      entityId: `${o.tag}-${i}`,
      branchId: o.branchId,
      ip: '127.0.0.1',
      meta: { tag: o.tag, i, pid: process.pid },
    }),
  );
}

// The production shape on a server engine: Passenger workers, each with its small pool (3 connections, P17).
// SQLite is refused on Passenger, so it runs standalone.
const runtime = o.config.dialect === 'sqlite' ? 'standalone' : 'passenger';
const h = await connect(o.config, { runtime, purpose: 'server', dataDir: o.dataDir });
process.on('message', (message) => {
  if (message !== 'go') return;
  Promise.all(Array.from({ length: o.count }, (_, i) => append(h, i)))
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
