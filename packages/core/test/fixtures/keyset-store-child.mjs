// Child process for keyset-store.test.ts, started through `node --import tsx`: two of them append different keyset
// documents to one DATA_DIR/releases/keyset.json at the same moment (spec §8.3: the writer serialises on
// releases/keyset.lock, so no document is lost).
//
// Usage: keyset-store-child.mjs <optionsJson>, options {dataDir, roots, docs}. Sends 'ready' over IPC and waits for
// 'go', then appends the documents one call each (so the two writers interleave), sends the summed counts and exits 0
// (1 on any failure). It exits 2 when its parent's IPC channel closes, so it never outlives its test.
import { appendKeysetDocs } from '../../src/updates/keyset-store.ts';

// The sources are run unbundled: give their test hooks the test profile that Vitest defines for the parent.
globalThis.__BUILD_PROFILE__ = 'test';

const o = JSON.parse(process.argv[2]);
const silent = { info() {}, warn() {}, error() {} };
process.on('disconnect', () => process.exit(2));

async function run() {
  const total = { added: 0, present: 0, rejected: 0, full: false };
  for (const doc of o.docs) {
    const r = await appendKeysetDocs({ dataDir: o.dataDir, roots: o.roots, docs: [doc], refuseDevKids: false, log: silent });
    total.added += r.added;
    total.present += r.present;
    total.rejected += r.rejected;
    total.full = total.full || r.full;
  }
  return total;
}

process.on('message', (message) => {
  if (message !== 'go') return;
  run()
    .then((total) => new Promise((resolve) => process.send(total, resolve)))
    .then(
      () => process.exit(0),
      (error) => {
        process.stderr.write(`keyset-store-child: ${String(error?.stack ?? error)}\n`);
        process.exit(1);
      },
    );
});
process.send('ready');
