// Child process for stocktake-concurrency.test.ts, started through `node --import tsx` (one process, one connection
// pool: its transactions run truly in parallel with its siblings', on every engine; SQLite through its own connection).
//
// Usage: stocktake-child.mjs <optionsJson>, options {config, dataDir, branchId, stocktakeId, actorId, now, mode, ...}:
// - `scan` {codes, rounds}: scans each code of `codes`, `rounds` times over, each scan in a transaction of its own;
//   sends {outcomes}.
// - `lend` {pairs}: lends each copy `code` of `pairs` to its `memberId`, each in a transaction of its own; sends {lent,
//   refused} (refused: code → error code).
// - `finish`: runs the finish's batches of the session until none is left; sends {batches}.
// Sends 'ready' over IPC and waits for 'go'. Exits 0 with its report, or 1 with {error}. It exits 2 when its parent's
// IPC channel closes, so it never outlives its test.
import { connect, withTx } from '@altis/db';
import { isDomainError } from '@altis/shared';
import { lendItem } from '../../src/circulation/desk.ts';
import { txCtx } from '../../src/context.ts';
import { finishBatch, scanStocktake } from '../../src/stocktake/index.ts';

// The sources are run unbundled: give their test hooks the test profile that Vitest defines for the parent.
globalThis.__BUILD_PROFILE__ = 'test';

const o = JSON.parse(process.argv[2]);
process.on('disconnect', () => process.exit(2));
const actor = { type: 'staff', id: o.actorId, ip: null };

async function run(h) {
  if (o.mode === 'scan') {
    const outcomes = [];
    for (let round = 0; round < o.rounds; round += 1) {
      for (const code of o.codes) {
        const r = await withTx(h, (trx) => scanStocktake(txCtx(trx, o.now, actor), { branchId: o.branchId, id: o.stocktakeId, barcode: code }));
        outcomes.push(r.outcome);
      }
    }
    return { outcomes };
  }
  if (o.mode === 'lend') {
    const lent = [];
    const refused = {};
    for (const { code, memberId } of o.pairs) {
      try {
        await withTx(h, (trx) => lendItem(txCtx(trx, o.now, actor), { branchId: o.branchId, memberId, barcode: code }));
        lent.push(code);
      } catch (error) {
        if (!isDomainError(error)) throw error;
        refused[code] = error.code;
      }
    }
    return { lent, refused };
  }
  if (o.mode === 'finish') {
    let batches = 0;
    while (await withTx(h, (trx) => finishBatch(txCtx(trx, o.now, actor), o.branchId, o.stocktakeId, { markMissing: true, restoreFound: true }))) batches += 1;
    return { batches };
  }
  throw new Error(`unknown mode ${o.mode}`);
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
