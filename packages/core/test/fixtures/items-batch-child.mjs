// Child process for catalog-items-concurrency.test.ts, started through `node --import tsx` (K4: two processes, two
// connections, SQLite included).
//
// Usage: items-batch-child.mjs <optionsJson>, options {config, dataDir, branchId, recordId, collectionTypeId,
// patternId, count, actorId, now}. Opens the test database (dataDir holds the SQLite file), sends 'ready' over IPC and
// waits for 'go'. Then it does what the batch route does: ensureBarcodeLockRow outside any transaction (the route's
// `prepare`, M8), then one batchCreateItems in a transaction of its own. It sends {created, skipped, attempts} and
// exits 0, or {error: code} and exits 1. It exits 2 when its parent's IPC channel closes, so it never outlives its test.
import { connect, withTx } from '@altis/db';
import { isDomainError } from '@altis/shared';
import { batchCreateItems, ensureBarcodeLockRow } from '../../src/catalog/items/index.ts';
import { txCtx } from '../../src/context.ts';

// The sources are run unbundled: give their test hooks the test profile that Vitest defines for the parent.
globalThis.__BUILD_PROFILE__ = 'test';

const o = JSON.parse(process.argv[2]);
process.on('disconnect', () => process.exit(2));

async function run(h) {
  let attempts = 0;
  await ensureBarcodeLockRow(h, o.patternId);
  const r = await withTx(h, (trx) => {
    attempts += 1;
    return batchCreateItems(txCtx(trx, o.now, { type: 'staff', id: o.actorId, ip: null }), o.branchId, {
      recordId: o.recordId,
      count: o.count,
      patternId: o.patternId,
      template: { collectionTypeId: o.collectionTypeId, status: 'available', partsTotal: 1 },
    });
  });
  return { created: r.created.map((c) => c.barcode), skipped: r.skipped.map((s) => s.barcode), attempts };
}

const runtime = o.config.dialect === 'sqlite' ? 'standalone' : 'passenger';
const h = await connect(o.config, { runtime, purpose: 'server', dataDir: o.dataDir });
process.on('message', (message) => {
  if (message !== 'go') return;
  run(h)
    .then(
      (report) => new Promise((resolve) => process.send(report, () => resolve(0))),
      (error) => {
        if (!isDomainError(error)) console.error(error);
        return new Promise((resolve) => process.send({ error: isDomainError(error) ? error.code : String(error?.name) }, () => resolve(1)));
      },
    )
    .then(async (code) => {
      await h.close();
      process.exit(code);
    });
});
process.send('ready');
